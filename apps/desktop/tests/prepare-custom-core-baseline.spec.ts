import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import type { PrepareCustomCoreBaselineRecord } from '../scripts/prepare-custom-core-baseline.mjs'
import { prepareCustomCoreBaseline } from '../scripts/prepare-custom-core-baseline.mjs'

const APP_ROOT = join(import.meta.dirname, '..')
const REPOSITORY_ROOT = join(APP_ROOT, '..', '..')
const SCRIPT = join(APP_ROOT, 'scripts', 'prepare-custom-core-baseline.mjs')
const PINNED_COMMIT = '9c2670d3bce5275e0d1610272958121af87787bb'
const PUBLISHER_IMPORT = '@deepseek-ai/dsh-desktop-publisher/desktop-auto-update-environment.mjs'
const LOCAL_IMPORT = './desktop-auto-update-environment.mjs'
const LOCAL_MODULE_FILE = 'apps/desktop/scripts/desktop-auto-update-environment.mjs'
const PACKAGE_ENVIRONMENT = 'apps/desktop/scripts/desktop-package-environment.mjs'
const PACKAGE_ENVIRONMENT_DECLARATION = 'apps/desktop/scripts/desktop-package-environment.d.mts'
const BUILDER_CONFIG = 'apps/desktop/scripts/electron-builder-config.mjs'
const PACKAGE_TARGET = 'apps/desktop/scripts/package-target.ts'
const PACKAGING_FILES = [PACKAGE_ENVIRONMENT, PACKAGE_ENVIRONMENT_DECLARATION, BUILDER_CONFIG, PACKAGE_TARGET]
const CORE_SOURCE = 'packages/core/src/index.ts'
const PACKAGING_HELPER = 'apps/desktop/scripts/custom-core-helper.ts'

/** The official Desktop module every packaging file imports. */
const LOCAL_MODULE = readFileSync(join(REPOSITORY_ROOT, LOCAL_MODULE_FILE), 'utf8')

const OFFICIAL_TREE: Readonly<Record<string, string>> = {
  [CORE_SOURCE]: "export const CORE = 'official'\n",
  'package.json': '{"name":"fixture","version":"0.2.2-rc.5"}\n',
  [LOCAL_MODULE_FILE]: LOCAL_MODULE,
  [PACKAGE_ENVIRONMENT]: `import { resolveDesktopAutoUpdateConfig } from '${LOCAL_IMPORT}'

export function loadDesktopPackageEnvironment(platform, environment) {
  resolveDesktopAutoUpdateConfig(environment, platform, 'x64')
  return { ...environment }
}

export function validateDesktopPackageEnvironment(environment, target, options = {}) {
  if (target.platform !== 'darwin' || !options.unsigned) return requirePolicy(environment)
  return environment
}
`,
  [PACKAGE_ENVIRONMENT_DECLARATION]: `export function localMacOSPackageEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
`,
  [BUILDER_CONFIG]: `import { resolveDesktopAutoUpdateConfig } from '${LOCAL_IMPORT}'

export function createElectronBuilderConfig(environment) {
  return { update: resolveDesktopAutoUpdateConfig(environment, 'win32', 'x64') }
}
`,
  [PACKAGE_TARGET]: `import { join } from 'node:path'
import { desktopBuildRecordFilename, resolveDesktopAutoUpdateConfig } from '${LOCAL_IMPORT}'

export async function main() {
  resolveDesktopAutoUpdateConfig(process.env, 'win32', 'x64')
  console.log(join('desktop', desktopBuildRecordFilename()))
}
`,
}

const PACKAGING_TREE: Readonly<Record<string, string>> = {
  [CORE_SOURCE]: "export const CORE = 'unified'\n",
  [PACKAGING_HELPER]: "export const CUSTOM_CORE = 'controlled tarball'\n",
  [PACKAGE_ENVIRONMENT]: `import { resolveDesktopAutoUpdateConfig } from '${LOCAL_IMPORT}'

export function localWindowsPackageEnvironment(environment = process.env) {
  return { ...environment, DSH_DESKTOP_APP_ID: 'com.deepseek.dsh', DSH_DESKTOP_UNSIGNED: '1' }
}

export function validateDesktopPackageEnvironment(environment, target, options = {}) {
  if (!options.unsigned) return requirePolicy(environment)
  return environment
}
`,
  [PACKAGE_ENVIRONMENT_DECLARATION]: `export function localMacOSPackageEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function localWindowsPackageEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
`,
  [BUILDER_CONFIG]: `import { resolveDesktopAutoUpdateConfig } from '${LOCAL_IMPORT}'

export function createElectronBuilderConfig(environment) {
  const policy = environment.DSH_DESKTOP_UNSIGNED === '1' ? undefined : requirePolicy(environment)
  return { policy, update: resolveDesktopAutoUpdateConfig(environment, 'win32', 'x64') }
}
`,
  [PACKAGE_TARGET]: `import { join } from 'node:path'
import { desktopBuildRecordFilename, resolveDesktopAutoUpdateConfig } from '${LOCAL_IMPORT}'
import { localWindowsPackageEnvironment } from './desktop-package-environment.mjs'

export async function main() {
  resolveDesktopAutoUpdateConfig(process.env, 'win32', 'x64')
  const environment = localWindowsPackageEnvironment()
  console.log(join('desktop', desktopBuildRecordFilename(), environment.DSH_DESKTOP_APP_ID))
}
`,
}

const ENVIRONMENT = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '',
  GIT_CONFIG_PARAMETERS: '',
  GIT_CONFIG_COUNT: '0',
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
}

interface Repository {
  readonly root: string
  readonly official: string
  git: (...args: string[]) => string
  packaging: (changes?: Readonly<Record<string, string | null>>) => string
}

interface Prepared {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function writeTree(root: string, tree: Readonly<Record<string, string | null>>): void {
  for (const [path, content] of Object.entries(tree)) {
    const destination = join(root, path)
    if (content === null) {
      rmSync(destination, { force: true })
      continue
    }
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
  }
}

function withRepository(action: (repository: Repository) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'custom-core-baseline-'))
  try {
    const git = (...args: string[]): string => execFileSync('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args,
    ], { cwd: root, env: ENVIRONMENT, encoding: 'utf8', stdio: 'pipe' }).trim()
    git('init', '--initial-branch=main')
    git('config', 'core.autocrlf', 'false')
    writeTree(root, OFFICIAL_TREE)
    git('add', '.')
    git('commit', '-m', 'official source')
    const official = git('rev-parse', 'HEAD')
    const packaging = (changes: Readonly<Record<string, string | null>> = {}): string => {
      git('checkout', '-B', 'packaging', official)
      writeTree(root, { ...PACKAGING_TREE, ...changes })
      git('add', '-A')
      git('commit', '-m', 'packaging patch')
      const commit = git('rev-parse', 'HEAD')
      git('checkout', '--detach', official)
      git('clean', '-fdq')
      return commit
    }
    action({ root, official, packaging, git })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}

function prepareFixture(repository: Repository, packagingCommit: string, source = repository.root): PrepareCustomCoreBaselineRecord {
  return prepareCustomCoreBaseline({ source, packagingCommit, officialCommit: repository.official })
}

function cli(root: string, ...args: string[]): Prepared {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env: ENVIRONMENT, encoding: 'utf8', timeout: 120_000 })
  expect(run.error).toBeUndefined()
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

it('copies only the four packaging files onto the official checkout', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    expect(prepareCustomCoreBaseline({ source: repository.root, packagingCommit: packaging, officialCommit: repository.official }))
      .toEqual({
        officialCommit: repository.official,
        packagingCommit: packaging,
        changedFiles: PACKAGING_FILES,
      })
    for (const path of PACKAGING_FILES) expect(readFileSync(join(repository.root, path), 'utf8')).toBe(PACKAGING_TREE[path])
    expect(readFileSync(join(repository.root, CORE_SOURCE), 'utf8')).toBe(OFFICIAL_TREE[CORE_SOURCE])
    expect(existsSync(join(repository.root, PACKAGING_HELPER))).toBe(false)
    expect(repository.git('diff', '--name-only').split('\n')).toEqual([...PACKAGING_FILES].sort())
    expect(repository.git('ls-files', '--others', '--exclude-standard')).toBe('')
  })
})

it('rejects a packaging file that imports the publisher app module', () => {
  withRepository((repository) => {
    const relocated = PACKAGING_TREE[BUILDER_CONFIG]!.replace(
      `from '${LOCAL_IMPORT}'`, `from '${PUBLISHER_IMPORT}'`)
    const packaging = repository.packaging({ [BUILDER_CONFIG]: relocated })
    expect(() => prepareFixture(repository, packaging)).toThrow(
      `custom core baseline: ${BUILDER_CONFIG} imports ${PUBLISHER_IMPORT}; the baseline cannot resolve the publisher app`,
    )
    for (const path of PACKAGING_FILES) expect(readFileSync(join(repository.root, path), 'utf8')).toBe(OFFICIAL_TREE[path])
  })
})

it('rejects an official checkout that is not the pinned release commit', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    const result = cli(repository.root, '--source', repository.root, '--packaging-commit', packaging)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`official source commit is ${repository.official}`)
    expect(result.stderr).toContain(`expected ${PINNED_COMMIT}`)
    expect(readFileSync(join(repository.root, PACKAGE_TARGET), 'utf8')).toBe(OFFICIAL_TREE[PACKAGE_TARGET])
  })
})

it('rejects a removed official commit override on the command line', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    const result = cli(repository.root, '--source', repository.root, '--packaging-commit', packaging,
      '--official-commit', repository.official)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--official-commit')
  })
})

it('rejects an official commit that does not match the requested one', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    expect(() => prepareCustomCoreBaseline({ source: repository.root, packagingCommit: packaging, officialCommit: 'e'.repeat(40) }))
      .toThrow(`custom core baseline: official source commit is ${repository.official}; expected ${'e'.repeat(40)};`
        + ' check out the official release first')
  })
})

it.each(['main', 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', '0123abcd'])('rejects the packaging commit %s', (value) => {
  withRepository((repository) => {
    repository.packaging()
    const result = cli(repository.root, '--source', repository.root, '--packaging-commit', value)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('40-character lowercase hexadecimal')
  })
})

it('rejects a packaging commit the checkout does not contain', () => {
  withRepository((repository) => {
    const missing = 'a'.repeat(40)
    expect(() => prepareFixture(repository, missing)).toThrow(`custom core baseline: packaging commit ${missing} is not available in ${repository.root}`)
  })
})

it('rejects the official commit as its own packaging commit', () => {
  withRepository((repository) => {
    expect(() => prepareFixture(repository, repository.official)).toThrow(
      `custom core baseline: packaging commit ${repository.official} is the official source commit`,
    )
  })
})

it('rejects a dirty official checkout without writing anything', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    writeFileSync(join(repository.root, CORE_SOURCE), "export const CORE = 'edited'\n")
    expect(() => prepareFixture(repository, packaging)).toThrow(
      `custom core baseline: ${repository.root} has uncommitted changes; clean it before preparing the baseline:`,
    )
    for (const path of PACKAGING_FILES) expect(readFileSync(join(repository.root, path), 'utf8')).toBe(OFFICIAL_TREE[path])
  })
})

it('rejects an untracked file in the official checkout', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    writeFileSync(join(repository.root, PACKAGING_HELPER), 'export const leftover = true\n')
    expect(() => prepareFixture(repository, packaging)).toThrow('has uncommitted changes;')
  })
})

it('rejects a packaging commit that does not carry one of the scripts', () => {
  withRepository((repository) => {
    const packaging = repository.packaging({ [BUILDER_CONFIG]: null })
    expect(() => prepareFixture(repository, packaging)).toThrow(
      `custom core baseline: ${BUILDER_CONFIG} is not present in packaging commit ${packaging}`,
    )
  })
})

it('rejects a relative import the official source tree does not provide', () => {
  withRepository((repository) => {
    const broken = `${PACKAGING_TREE[BUILDER_CONFIG]!}import { missing } from './missing-helper.mjs'\n`
    const packaging = repository.packaging({ [BUILDER_CONFIG]: broken })
    expect(() => prepareFixture(repository, packaging)).toThrow(
      `custom core baseline: ${BUILDER_CONFIG} imports ./missing-helper.mjs, which the official source tree does not provide`,
    )
  })
})

it('rejects a source directory below the work tree root', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    expect(() => prepareFixture(repository, packaging, join(repository.root, 'apps', 'desktop'))).toThrow(
      `${join(repository.root, 'apps', 'desktop')} is not the work tree root`,
    )
  })
})

it('rejects a source directory outside a git work tree', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    const outside = mkdtempSync(join(tmpdir(), 'custom-core-plain-'))
    try {
      expect(() => prepareFixture(repository, packaging, outside)).toThrow(
        `custom core baseline: ${outside} is not a git work tree`,
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

it.each(['--source', '--packaging-commit'])('requires %s', (option) => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    const args = option === '--source'
      ? ['--packaging-commit', packaging]
      : ['--source', repository.root]
    const result = cli(repository.root, ...args)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${option} is required`)
  })
})
