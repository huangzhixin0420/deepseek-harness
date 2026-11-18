/** Static acceptance for the Windows custom-core build, installation acceptance, and prerelease pipeline. */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const APP_ROOT = join(import.meta.dirname, '..')
const REPOSITORY = resolve(APP_ROOT, '..', '..')
const WORKFLOW_PATH = join(REPOSITORY, '.github', 'workflows', 'desktop-custom-core-windows.yml')
const ACCEPTANCE_SCRIPT = join(APP_ROOT, 'scripts', 'accept-custom-core-windows.ps1')
const DISK_GUARD = join(APP_ROOT, 'scripts', 'assert-custom-core-disk-space.ps1')
const ACCEPTANCE_FUNCTIONS = join(APP_ROOT, 'scripts', 'custom-core-acceptance-functions.ps1')
const FIXTURE_ROOT = join(APP_ROOT, 'scripts', 'fixtures', 'unified-own-tool-plugin')
const FIXTURE_MANIFEST = join(FIXTURE_ROOT, 'package.json')
const FIXTURE_ENTRY = join(FIXTURE_ROOT, 'index.mjs')
const hasPwsh = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0

interface WorkflowStep {
  readonly id?: string
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly if?: string
  readonly shell?: string
  readonly 'working-directory'?: string
  readonly env?: Record<string, string>
  readonly with?: Record<string, unknown>
}

interface WorkflowJob {
  readonly needs?: string | readonly string[]
  readonly if?: string
  readonly permissions?: Record<string, string>
  readonly outputs?: Record<string, string>
  readonly 'runs-on': string | readonly string[]
  readonly 'timeout-minutes'?: number
  readonly defaults?: { readonly run?: { readonly shell?: string } }
  readonly env?: Record<string, string>
  readonly steps: readonly WorkflowStep[]
}
interface WorkflowInput {
  readonly type?: string
  readonly required?: boolean
  readonly default?: boolean | string
  readonly description?: string
}

interface Workflow {
  readonly on: Record<string, { readonly inputs?: Record<string, WorkflowInput> }>
  readonly permissions: Record<string, string>
  readonly concurrency: { readonly group: string; readonly 'cancel-in-progress': boolean }
  readonly jobs: Record<string, WorkflowJob>
}

const workflow = yaml.load(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow
const jobs = workflow.jobs
const packageJob = jobs['package']!
const acceptanceJob = jobs['acceptance']!
const releaseJob = jobs['release']!

/** Concatenate every `run:` script of one job, so a command may be matched anywhere in it. */
function jobScript(job: WorkflowJob): string {
  return job.steps.map(step => step.run ?? '').join('\n')
}

/** Return the `uses:` references of one job in order. */
function uses(job: WorkflowJob): string[] {
  return job.steps.flatMap(step => step.uses === undefined ? [] : [step.uses])
}

/** Normalize `needs` to an array. */
function needs(job: WorkflowJob): string[] {
  const declared = job.needs
  if (declared === undefined) return []
  return typeof declared === 'string' ? [declared] : [...declared]
}

it('runs exactly the three serial jobs and nothing else', () => {
  expect(Object.keys(jobs)).toEqual(['package', 'acceptance', 'release'])
  expect(needs(packageJob)).toEqual([])
  expect(needs(acceptanceJob)).toEqual(['package'])
  expect(needs(releaseJob)).toEqual(['package', 'acceptance'])
  for (const job of [packageJob, acceptanceJob, releaseJob]) {
    expect(job['runs-on']).toBe('windows-2022')
    expect(job.defaults?.run?.shell).toBe('pwsh')
  }
})

it('keeps the manual trigger and its release inputs', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  const inputs = workflow.on['workflow_dispatch']!.inputs!
  expect(Object.keys(inputs).sort()).toEqual(['publish_release', 'release_tag'])
  expect(inputs['publish_release']).toMatchObject({ type: 'boolean', default: false })
  expect(inputs['release_tag']).toMatchObject({ type: 'string', default: '' })
  expect(workflow.concurrency).toEqual({ group: 'desktop-custom-core-windows', 'cancel-in-progress': false })
})

it('grants write access to the release job alone', () => {
  expect(workflow.permissions).toEqual({ contents: 'read' })
  const writers = Object.entries(jobs)
    .filter(([, job]) => (job.permissions?.['contents'] ?? 'read') === 'write')
    .map(([name]) => name)
  expect(writers).toEqual(['release'])
})

it('lets the package job finish instead of refusing a release request', () => {
  const script = jobScript(packageJob)
  expect(script).not.toContain('release publishing is not implemented')
  expect(packageJob.steps.some(step => (step.run ?? '').includes('publish_release'))).toBe(false)
  expect(script).toContain('pnpm run package:desktop:win:x64:unsigned')
  expect(packageJob.outputs).toEqual({
    'custom-artifact': 'custom-core-custom-${{ github.run_id }}-${{ github.run_attempt }}',
    'baseline-artifact': 'custom-core-baseline-${{ github.run_id }}-${{ github.run_attempt }}',
    'custom-installer': '${{ steps.stage.outputs.custom-installer }}',
    'baseline-installer': '${{ steps.stage.outputs.baseline-installer }}',
  })
})

it('runs acceptance on the artifacts of this very run', () => {
  expect(workflow.on['workflow_dispatch']).toBeDefined()
  expect(acceptanceJob['timeout-minutes']).toBeGreaterThan(0)
  expect(uses(acceptanceJob).filter(reference => reference.startsWith('actions/download-artifact@'))).toHaveLength(2)
  const downloads = acceptanceJob.steps.filter(step => step.uses?.startsWith('actions/download-artifact@'))
  expect(downloads.map(step => step.with?.['name'])).toEqual([
    '${{ needs.package.outputs.baseline-artifact }}',
    '${{ needs.package.outputs.custom-artifact }}',
  ])
  expect(acceptanceJob.permissions).toBeUndefined()

  const script = jobScript(acceptanceJob)
  expect(script).toContain('accept-custom-core-windows.ps1')
  expect(script).toContain('-BaselineInstaller')
  expect(script).toContain('-CustomInstaller')
  expect(script).toContain('-Report')
  expect(script).toContain('needs.package.outputs.baseline-installer')
  expect(script).toContain('needs.package.outputs.custom-installer')
  expect(script).toContain('exit $LASTEXITCODE')

  const reportUpload = acceptanceJob.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))
  expect(reportUpload).toBeDefined()
  expect(reportUpload!.if).toContain('always()')
  expect(reportUpload!.with?.['if-no-files-found']).toBe('error')
})

it('publishes only an explicitly tagged, fully accepted run as a prerelease', () => {
  expect(releaseJob.if).toContain('publish_release')
  expect(releaseJob.if).toContain('true')
  expect(releaseJob.permissions).toEqual({ contents: 'write' })

  const script = jobScript(releaseJob)
  expect(script).toContain('release_tag')
  expect(script).toMatch(/\[string\]::IsNullOrWhiteSpace|IsNullOrWhiteSpace/)
  expect(script).toMatch(/\^\[A-Za-z0-9\]/)
  expect(script).toContain('gh release create')
  expect(script).toContain('--prerelease')
  expect(script).toContain('--target')
  expect(script).toContain('sha256')

  const releaseUploads = uses(releaseJob).filter(reference => reference.startsWith('actions/upload-artifact@'))
  expect(releaseUploads).toEqual([])
})

it('writes the unsigned, in-place overwrite notice into the release body', () => {
  const script = jobScript(releaseJob)
  expect(script).toContain('更多信息')
  expect(script).toContain('仍要运行')
  expect(script).toContain('覆盖')
  expect(script).toContain('配置')
  expect(script).toContain('prerelease')
  expect(script).not.toMatch(/github\.com\/[^\s]+\/actions\/runs/)
})

it('touches neither the publication workflows nor object storage', () => {
  const script = jobScript(packageJob) + jobScript(acceptanceJob) + jobScript(releaseJob)
  for (const forbidden of ['desktop-publish', 'desktop-rollout', 'coscli', 'COS_', 'softprops']) {
    expect(script.toLowerCase()).not.toContain(forbidden.toLowerCase())
  }
  expect(uses(packageJob).concat(uses(acceptanceJob), uses(releaseJob)))
    .not.toContain('actions/upload-artifact@v7.0.1#baseline')
})

it('ships an acceptance script with the documented parameters and report fields', () => {
  expect(statSync(ACCEPTANCE_SCRIPT).isFile()).toBe(true)
  const script = readFileSync(ACCEPTANCE_SCRIPT, 'utf8')
  for (const parameter of ['$BaselineInstaller', '$CustomInstaller', '$Report']) {
    expect(script).toContain(parameter)
  }
  for (const field of [
    'installers', 'fixtureSha256', 'ownTool', 'projectionListsOwnTool', 'session', 'host', 'data', 'checks',
  ]) {
    expect(script).toContain(field)
  }
  expect(script).toContain('finally')
  expect(script).toContain('exit 1')
})

it('seeds a non-default desktop preference that the hash snapshot still covers', () => {
  const script = readFileSync(ACCEPTANCE_SCRIPT, 'utf8')
  // `nightly` is the packaged channel and the coordinator default, so it cannot prove anything was set.
  expect(script).toContain("channel = 'stable'")
  expect(script).not.toContain("channel = 'nightly'")
  expect(script).toContain("Get-ChildItem -Force -LiteralPath $desktopJsonDir -Filter '*.json'")
  expect(script).toContain("desktopSettingsFile = Join-Path $desktopJsonDir 'settings.json'")
  expect(script.indexOf("Write-Output '== seeding the isolated configuration'"))
    .toBeLessThan(script.indexOf("Write-Output '== snapshot A"))
})

it('installs both packages with the same verified silent form', () => {
  const script = readFileSync(ACCEPTANCE_SCRIPT, 'utf8')
  expect(script).toContain('$installArguments = "/S /D=$installDir"')
  expect(script).not.toContain('--updated')
  expect(script.match(/-Arguments \$installArguments/gu) ?? []).toHaveLength(2)
  expect(script).toContain('$state.installs.customArguments = $installArguments')
})

it('prints acceptance-proven Session evidence in the release body', () => {
  const acceptance = readFileSync(ACCEPTANCE_SCRIPT, 'utf8')
  expect(acceptance).toContain('session = [ordered]@{ id = $null; seeded = $false; reopened = $false }')
  expect(acceptance).toContain('$state.session.id = [string](Get-JsonField $baselineSession')
  expect(acceptance).toContain('$state.session.seeded = $sessionSeeded')
  expect(acceptance).toContain('$state.session.reopened = $sessionReopened')

  const script = jobScript(releaseJob)
  expect(script).toContain('if (-not $report.session.reopened)')
  expect(script).toContain('$report.session.id')
  expect(script).toContain('$report.session.reopened')
  expect(script).not.toContain('.session.mode')
})

it('isolates the fixture from the product package', () => {
  const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST, 'utf8')) as { name?: string; private?: boolean }
  expect(manifest).toMatchObject({ name: 'dsh-fixture-unified-own-tool', private: true })
  const entry = readFileSync(FIXTURE_ENTRY, 'utf8')
  expect(entry).toContain('fixture_unified_own_tool')
  expect(entry).toContain("const INHERITED_TOOL = 'fixture_unified_inherited_tool'")
  expect(entry).toContain('includeOwn: true')
  expect(entry).toContain('allow: [INHERITED_TOOL]')
  expect(entry).toContain('createScope')

  const builder = readFileSync(join(APP_ROOT, 'scripts', 'electron-builder-config.mjs'), 'utf8')
  expect(builder).not.toContain('unified-own-tool-plugin')
  expect(readFileSync(WORKFLOW_PATH, 'utf8')).not.toContain('apps/desktop/scripts/fixtures')
})

it('registers its inherited tool on the Host plane without any agent preset', () => {
  const root = mkdtempSync(join(tmpdir(), 'custom-core-host-fixture-'))
  const reportPath = join(root, 'observation.json')
  const afterPath = join(root, 'after.json')
  const runnerPath = join(root, 'runner.mjs')
  const fixtureEntry = join(root, 'index.mjs')
  try {
    copyFileSync(FIXTURE_ENTRY, fixtureEntry)
    const scopeNamespace = join(root, 'node_modules', '@deepseek-ai')
    mkdirSync(scopeNamespace, { recursive: true })
    symlinkSync(
      join(REPOSITORY, 'packages', 'core', 'scope'), join(scopeNamespace, 'dsh-scope'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const moduleUrl = (path: string) => pathToFileURL(join(REPOSITORY, path)).href
    writeFileSync(runnerPath, `
import { existsSync, writeFileSync } from 'node:fs'
import { Context } from ${JSON.stringify(moduleUrl('vendor/cordis/lib/index.js'))}
import SystemPrompt from ${JSON.stringify(moduleUrl('packages/core/system-prompt/lib/index.js'))}
import ToolRuntime from ${JSON.stringify(moduleUrl('packages/core/tools/lib/index.js'))}
import * as NativeToolExecutor from ${JSON.stringify(moduleUrl('packages/core/tool-executor-native/lib/index.js'))}
const reportPath = ${JSON.stringify(reportPath)}
const afterPath = ${JSON.stringify(afterPath)}
const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime)
await ctx.plugin(NativeToolExecutor)
const fixture = await import(${JSON.stringify(pathToFileURL(fixtureEntry).href)})
await ctx.plugin(Object.assign(fixture.apply, { inject: ['tools'] }))
const deadline = Date.now() + 5000
while (!existsSync(reportPath) && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 25))
}
if (!existsSync(reportPath)) throw new Error('the fixture did not produce its Host-plane report')
writeFileSync(afterPath, JSON.stringify(ctx.tools.catalog()))
`)
    const run = spawnSync(process.execPath, [runnerPath], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        DSH_FIXTURE_OWN_TOOL_REPORT: reportPath,
        DSH_FIXTURE_OWN_TOOL_MODE: 'observe',
        DSH_FIXTURE_OWN_TOOL_SESSION: '',
      },
    })
    expect(run.error).toBeUndefined()
    expect(run.signal).toBeNull()
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const observation = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      allowedInheritedTool: string
      inheritedToolPresent: boolean
      registered: boolean
      catalog: string[]
      projection: string[]
      projectionListsOwnTool: boolean
      restrictAccepted: boolean
      execution: { isError: boolean; code: string | null }
      error: string | null
    }
    expect(observation).toMatchObject({
      allowedInheritedTool: 'fixture_unified_inherited_tool',
      inheritedToolPresent: true,
      registered: true,
      projectionListsOwnTool: false,
      restrictAccepted: true,
      execution: { isError: true, code: 'UNKNOWN_TOOL' },
      error: null,
    })
    expect(observation.catalog).toEqual(['fixture_unified_inherited_tool', 'fixture_unified_own_tool'])
    expect(observation.projection).toEqual(['fixture_unified_inherited_tool'])
    expect(JSON.parse(readFileSync(afterPath, 'utf8'))).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Position of one named package-job step. */
function packageStep(name: string): number {
  const index = packageJob.steps.findIndex(step => step.name === name)
  expect(index).toBeGreaterThanOrEqual(0)
  return index
}

it('records the pnpm version and lockfile of each checkout before it installs', () => {
  const installs = packageJob.steps.filter(step => (step.name ?? '').startsWith('Install locked dependencies'))
  expect(installs.map(step => step['working-directory'])).toEqual(['baseline', 'custom'])
  for (const step of installs) {
    const script = step.run ?? ''
    const install = script.indexOf('pnpm install --frozen-lockfile')
    expect(script).toContain('pnpm --version')
    expect(script).toContain('lockfileVersion')
    expect(script.indexOf('pnpm --version')).toBeLessThan(install)
    expect(script.indexOf('lockfileVersion')).toBeLessThan(install)
  }
  // Both checkouts pin pnpm 11.28.5 with lockfileVersion 9.0, so one pinned pnpm serves both and no
  // per-checkout corepack shim may switch versions mid-run.
  expect(packageJob.steps.filter(step => step.uses?.startsWith('pnpm/action-setup@'))).toHaveLength(1)
  expect(jobScript(packageJob)).not.toContain('corepack')
})

it('fails closed on free disk space before the first install and after the baseline cleanup', () => {
  const guardSteps = packageJob.steps.filter(step => (step.run ?? '').includes('assert-custom-core-disk-space.ps1'))
  expect(guardSteps.map(step => step.name)).toEqual([
    'Guard free disk space before the baseline install',
    'Guard free disk space after the baseline cleanup',
  ])
  const firstGuard = packageStep('Guard free disk space before the baseline install')
  const secondGuard = packageStep('Guard free disk space after the baseline cleanup')
  expect(firstGuard).toBeLessThan(packageStep('Install locked dependencies for the baseline'))
  expect(secondGuard).toBeGreaterThan(packageStep('Free baseline build intermediates'))
  expect(secondGuard).toBeLessThan(packageStep('Build custom installer'))
  for (const step of guardSteps) {
    expect(step.run).toContain('-Path $env:GITHUB_WORKSPACE, $env:RUNNER_TEMP')
    // A missing guard script must not chain into `exit $null` and pass silently.
    expect(step.run).toContain('if (-not (Test-Path -LiteralPath $guard -PathType Leaf)) { throw')
  }

  const guard = readFileSync(DISK_GUARD, 'utf8')
  expect(guard).toContain('[long]$MinimumBytes = 16106127360')
  expect(guard).toContain('exit 1')
})

it.skipIf(!hasPwsh)('reports free space and fails when a volume cannot hold the minimum', () => {
  const root = mkdtempSync(join(tmpdir(), 'custom-core-disk-'))
  try {
    const run = (minimum: string) => spawnSync('pwsh', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', DISK_GUARD,
      '-Stage', 'fixture stage', '-Path', root, '-MinimumBytes', minimum,
    ], { encoding: 'utf8', timeout: 60_000 })
    const enough = run('1')
    expect(enough.status).toBe(0)
    expect(enough.stdout).toContain('fixture stage')
    expect(enough.stdout).toMatch(/: \d+ bytes free \(minimum 1\) on /u)

    const short = run('2000000000000')
    expect(short.status).toBe(1)
    expect(short.stderr).toContain('need at least 2000000000000')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps both installers and the audit report outside the baseline cleanup', () => {
  const cleanup = packageJob.steps.find(step => step.name === 'Free baseline build intermediates')
  expect(cleanup).toBeDefined()
  const script = cleanup!.run ?? ''
  // The baseline installer sits beside `win-unpacked` and the audit report lives under the runner temp; the
  // acceptance and release jobs consume both after this step.
  expect(script).toContain("'unsigned-artifacts/win-unpacked'")
  expect(script).not.toContain("'unsigned-artifacts'")
  expect(script).not.toContain('.exe')
  expect(script).not.toContain('desktop-package-audit.json')
  expect(script).not.toContain('RUNNER_TEMP')
})

const ACCEPTANCE_PROBE = `param([string]$Functions, [string]$Root)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $Functions
function Write-Manifest([string]$Name, [string]$Body) {
    $path = Join-Path $Root $Name
    Set-Content -LiteralPath $path -Value $Body -Encoding utf8 -NoNewline
    return $path
}
$absent = Join-Path $Root 'absent.json'
$noList = Write-Manifest 'no-list.json' '{ "dsh": { "profile": {} } }'
$nullList = Write-Manifest 'null-list.json' '{ "dsh": { "profile": { "bundles": null } } }'
$emptyString = Write-Manifest 'empty-string.json' '{ "dsh": { "profile": { "bundles": "" } } }'
$emptyList = Write-Manifest 'empty-list.json' '{ "dsh": { "profile": { "bundles": [] } } }'
$two = Write-Manifest 'two.json' '{ "dsh": { "profile": { "bundles": [ "alpha", "beta" ] } } }'
$blankEntry = Write-Manifest 'blank-entry.json' '{ "dsh": { "profile": { "bundles": [ "", "alpha" ] } } }'
$entries = @(
    [pscustomobject]@{ path = '.dsh/.credentials.yaml'; exists = $true; bytes = 12 },
    [pscustomobject]@{ path = '.dsh/profiles/desktop/cordis.patch.yml'; exists = $false; bytes = 0 },
    [pscustomobject]@{ path = 'desktop/settings.json'; exists = $true; bytes = 0 }
)
$required = @(
    '.dsh/.credentials.yaml'
    '.dsh/profiles/desktop/cordis.patch.yml'
    'desktop/settings.json'
    'desktop/keybindings.json'
)
$recorded = @(
    [ordered]@{ path = '.dsh/.credentials.yaml'; exists = $true; bytes = 12 },
    [ordered]@{ path = '.dsh/profiles/desktop/cordis.patch.yml'; exists = $true; bytes = 34 }
)
[ordered]@{
    missingCount = @(Get-ProfileBundles -Path $absent).Count
    noListCount = @(Get-ProfileBundles -Path $noList).Count
    nullListCount = @(Get-ProfileBundles -Path $nullList).Count
    emptyStringCount = @(Get-ProfileBundles -Path $emptyString).Count
    emptyListCount = @(Get-ProfileBundles -Path $emptyList).Count
    two = (@(Get-ProfileBundles -Path $two) -join '|')
    blankEntry = (@(Get-ProfileBundles -Path $blankEntry) -join '|')
    unchanged = (@(Compare-ProfileBundles -Before @('alpha', 'beta') -After @('alpha', 'beta')) -join '|')
    reordered = (@(Compare-ProfileBundles -Before @('alpha', 'beta') -After @('beta', 'alpha')) -join '|')
    shortened = (@(Compare-ProfileBundles -Before @('alpha', 'beta') -After @('alpha')) -join '|')
    emptied = (@(Compare-ProfileBundles -Before @('alpha') -After @()) -join '|')
    gaps = (@(Get-SeedGaps -Entries $entries -Required $required) -join '|')
    recordedGaps = (@(Get-SeedGaps -Entries $recorded -Required @('.dsh/.credentials.yaml')) -join '|')
} | ConvertTo-Json -Depth 6 -Compress
`

it.skipIf(!hasPwsh)('normalizes the profile bundle list and rejects a snapshot without the seeded files', () => {
  const root = mkdtempSync(join(tmpdir(), 'custom-core-acceptance-'))
  try {
    const probe = join(root, 'probe.ps1')
    writeFileSync(probe, ACCEPTANCE_PROBE)
    const run = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', probe, ACCEPTANCE_FUNCTIONS, root], {
      encoding: 'utf8', timeout: 60_000,
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({
      missingCount: 0,
      noListCount: 0,
      nullListCount: 0,
      emptyStringCount: 0,
      emptyListCount: 0,
      two: 'alpha|beta',
      blankEntry: 'alpha',
      unchanged: '',
      reordered: 'index 0: alpha -> beta|index 1: beta -> alpha',
      shortened: 'count 2 -> 1',
      emptied: 'count 1 -> 0',
      gaps: [
        'not present on disk: .dsh/profiles/desktop/cordis.patch.yml',
        'empty on disk: desktop/settings.json',
        'missing from the hash snapshot: desktop/keybindings.json',
      ].join('|'),
      recordedGaps: '',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.skipIf(!hasPwsh)('keeps acceptance logs out of installer and observation return values', () => {
  const root = mkdtempSync(join(tmpdir(), 'custom-core-return-values-'))
  try {
    const probe = join(root, 'probe.ps1')
    writeFileSync(probe, `$ErrorActionPreference = 'Stop'
$InformationPreference = 'SilentlyContinue'
$scriptPath = $args[0]
$root = $args[1]
$tokens = $null
$problems = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$problems)
foreach ($name in @('Install-Product', 'Wait-FixtureObservation')) {
    $definition = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$PassThru, [switch]$Wait, $WindowStyle)
    return [pscustomobject]@{ ExitCode = 0 }
}
$exitCode = Install-Product -Installer 'fixture.exe' -Arguments '/S' -Label 'fixture'
$report = Join-Path $root 'observation.json'
Set-Content -LiteralPath $report -Value 'fixture'
$script:reads = 0
function Get-Content {
    param($LiteralPath, [switch]$Raw)
    $script:reads += 1
    if ($script:reads -eq 1) { return '{' }
    return '{"marker":"ready"}'
}
$TimeoutSeconds = 1
$observation = Wait-FixtureObservation -Path $report -Process ([Diagnostics.Process]::GetCurrentProcess()) -Label 'fixture'
[ordered]@{
    installType = $exitCode.GetType().Name
    installExit = if ($exitCode -is [int]) { $exitCode } else { -1 }
    observationType = $observation.GetType().Name
    observationMarker = if ($observation -is [pscustomobject]) { [string]$observation.marker } else { '' }
    reads = $script:reads
} | ConvertTo-Json -Compress
`)
    const run = spawnSync('pwsh', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', probe, ACCEPTANCE_SCRIPT, root,
    ], { encoding: 'utf8', timeout: 60_000 })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout.trim().split(/\r?\n/u).at(-1)!)).toEqual({
      installType: 'Int32',
      installExit: 0,
      observationType: 'PSCustomObject',
      observationMarker: 'ready',
      reads: 2,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.skipIf(!hasPwsh)('parses the acceptance script, its helpers, and the disk guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'custom-core-parse-'))
  try {
    const probe = join(root, 'parse.ps1')
    writeFileSync(probe, `$ErrorActionPreference = 'Stop'
$failed = $false
foreach ($file in $args) {
    $tokens = $null
    $problems = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$problems)
    foreach ($problem in @($problems)) {
        Write-Output ('{0}: {1}' -f $file, $problem.Message)
        $failed = $true
    }
}
if ($failed) { exit 1 }
Write-Output 'parsed'
`)
    const run = spawnSync('pwsh', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', probe, ACCEPTANCE_SCRIPT, ACCEPTANCE_FUNCTIONS, DISK_GUARD,
    ], { encoding: 'utf8', timeout: 60_000 })
    expect(run.stdout.trim()).toBe('parsed')
    expect(run.status).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('asserts the seeded state on disk before it records the comparison snapshot', () => {
  const script = readFileSync(ACCEPTANCE_SCRIPT, 'utf8')
  expect(script).toContain(". (Join-Path $PSScriptRoot 'custom-core-acceptance-functions.ps1')")
  expect(script).toContain('$requiredSeedFiles = @(')
  for (const path of [
    '.dsh/.credentials.yaml',
    '.dsh/profiles/desktop/package.json',
    '.dsh/profiles/desktop/cordis.patch.yml',
    '%APPDATA%/@deepseek-ai/dsh-desktop/desktop/settings.json',
  ]) {
    expect(script).toContain(path)
  }
  // `~/.dsh/settings.json` is not a product path: harness settings live in the profile patch.
  expect(script).not.toContain('.dsh/settings.json')
  expect(script).toContain('$seedGaps = @(Get-SeedGaps -Entries $state.data.before -Required $requiredSeedFiles)')
  expect(script.indexOf('$seedGaps = @(Get-SeedGaps'))
    .toBeLessThan(script.indexOf('== snapshot B'))
  expect(script).toContain('$state.data.profileBundles = @(Get-ProfileBundles -Path $profileManifest)')
  expect(script).toContain('@(Compare-ProfileBundles -Before ')
  expect(script).not.toContain('function Get-ProfileBundles')
})
