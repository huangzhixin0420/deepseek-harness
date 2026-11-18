/** Static acceptance for the Windows custom-core build, installation acceptance, and prerelease pipeline. */
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

const APP_ROOT = join(import.meta.dirname, '..')
const REPOSITORY = resolve(APP_ROOT, '..', '..')
const WORKFLOW_PATH = join(REPOSITORY, '.github', 'workflows', 'desktop-custom-core-windows.yml')
const ACCEPTANCE_SCRIPT = join(APP_ROOT, 'scripts', 'accept-custom-core-windows.ps1')
const FIXTURE_ROOT = join(APP_ROOT, 'scripts', 'fixtures', 'unified-own-tool-plugin')
const FIXTURE_MANIFEST = join(FIXTURE_ROOT, 'package.json')
const FIXTURE_ENTRY = join(FIXTURE_ROOT, 'index.mjs')

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
  expect(entry).toContain("const INHERITED_TOOL = 'bash'")
  expect(entry).toContain('includeOwn: true')
  expect(entry).toContain('allow: [INHERITED_TOOL]')
  expect(entry).toContain('createScope')

  const builder = readFileSync(join(APP_ROOT, 'scripts', 'electron-builder-config.mjs'), 'utf8')
  expect(builder).not.toContain('unified-own-tool-plugin')
  expect(readFileSync(WORKFLOW_PATH, 'utf8')).not.toContain('apps/desktop/scripts/fixtures')
})
