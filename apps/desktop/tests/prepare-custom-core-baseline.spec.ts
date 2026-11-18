import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

const APP_ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(APP_ROOT, 'scripts', 'prepare-custom-core-baseline.mjs')
const PINNED_COMMIT = '38a6a5c965aa99ab525161efb7cc5cf1fe62fced'
const PUBLISHER_IMPORT = '@deepseek-ai/dsh-desktop-publisher/desktop-auto-update-environment.mjs'
const LOCAL_IMPORT = './desktop-auto-update-environment.mjs'
const PACKAGE_ENVIRONMENT = 'apps/desktop/scripts/desktop-package-environment.mjs'
const BUILDER_CONFIG = 'apps/desktop/scripts/electron-builder-config.mjs'
const PACKAGE_TARGET = 'apps/desktop/scripts/package-target.ts'
const PACKAGING_FILES = [PACKAGE_ENVIRONMENT, BUILDER_CONFIG, PACKAGE_TARGET]
const CORE_SOURCE = 'packages/core/src/index.ts'
const PACKAGING_HELPER = 'apps/desktop/scripts/custom-core-helper.ts'

const OFFICIAL_TREE: Readonly<Record<string, string>> = {
  [CORE_SOURCE]: "export const CORE = 'official'\n",
  'package.json': '{"name":"fixture","version":"0.2.2-rc.3"}\n',
  'apps/desktop/scripts/desktop-auto-update-environment.mjs': `export function desktopBuildRecordFilename() {
  return 'desktop-build.json'
}

export function resolveDesktopAutoUpdateConfig() {
  return undefined
}
`,
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
  [PACKAGE_ENVIRONMENT]: `import { resolveDesktopAutoUpdateConfig } from '${PUBLISHER_IMPORT}'

export function localWindowsPackageEnvironment(environment = process.env) {
  return { ...environment, DSH_DESKTOP_APP_ID: 'com.deepseek.dsh', DSH_DESKTOP_UNSIGNED: '1' }
}

export function validateDesktopPackageEnvironment(environment, target, options = {}) {
  if (!options.unsigned) return requirePolicy(environment)
  return environment
}
`,
  [BUILDER_CONFIG]: `import { resolveDesktopAutoUpdateConfig } from '${PUBLISHER_IMPORT}'

export function createElectronBuilderConfig(environment) {
  const policy = environment.DSH_DESKTOP_UNSIGNED === '1' ? undefined : requirePolicy(environment)
  return { policy, update: resolveDesktopAutoUpdateConfig(environment, 'win32', 'x64') }
}
`,
  [PACKAGE_TARGET]: `import { join } from 'node:path'
import { desktopBuildRecordFilename, resolveDesktopAutoUpdateConfig } from '${PUBLISHER_IMPORT}'
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

function preparedContent(path: string, changes: Readonly<Record<string, string | null>> = {}): string {
  const source = changes[path] === undefined ? PACKAGING_TREE[path]! : changes[path]!
  return source.replaceAll(`'${PUBLISHER_IMPORT}'`, `'${LOCAL_IMPORT}'`)
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

function prepare(root: string, ...args: string[]): Prepared {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env: ENVIRONMENT, encoding: 'utf8', timeout: 120_000 })
  expect(run.error).toBeUndefined()
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

function prepareFixture(repository: Repository, packaging: string, ...args: string[]): Prepared {
  return prepare(repository.root, '--source', repository.root, '--packaging-commit', packaging,
    '--official-commit', repository.official, ...args)
}

it('copies only the three packaging scripts onto the official checkout', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    const result = prepareFixture(repository, packaging)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      officialCommit: repository.official,
      packagingCommit: packaging,
      changedFiles: PACKAGING_FILES,
      importRewrites: Object.fromEntries(PACKAGING_FILES.map(path => [path, 1])),
    })
    for (const path of PACKAGING_FILES) expect(readFileSync(join(repository.root, path), 'utf8')).toBe(preparedContent(path))
    expect(readFileSync(join(repository.root, CORE_SOURCE), 'utf8')).toBe(OFFICIAL_TREE[CORE_SOURCE])
    expect(existsSync(join(repository.root, PACKAGING_HELPER))).toBe(false)
    expect(repository.git('diff', '--name-only').split('\n')).toEqual(PACKAGING_FILES)
    expect(repository.git('ls-files', '--others', '--exclude-standard')).toBe('')
  })
})

it('rejects an official checkout that is not the pinned release commit', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    const result = prepare(repository.root, '--source', repository.root, '--packaging-commit', packaging)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`official source commit is ${repository.official}`)
    expect(result.stderr).toContain(`expected ${PINNED_COMMIT}`)
    expect(readFileSync(join(repository.root, PACKAGE_TARGET), 'utf8')).toBe(OFFICIAL_TREE[PACKAGE_TARGET])
  })
})

it('rejects an official commit that does not match the requested one', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    const result = prepare(repository.root, '--source', repository.root, '--packaging-commit', packaging,
      '--official-commit', 'e'.repeat(40))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`official source commit is ${repository.official}`)
    expect(result.stderr).toContain(`expected ${'e'.repeat(40)}`)
  })
})

it.each(['main', '89E1904D55E7F4B9560595ADFECD48A088D88BC', '89e1904d'])('rejects the packaging commit %s', (value) => {
  withRepository((repository) => {
    repository.packaging()
    const result = prepareFixture(repository, value)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('40-character lowercase hexadecimal')
  })
})

it('rejects a packaging commit the checkout does not contain', () => {
  withRepository((repository) => {
    const missing = 'a'.repeat(40)
    const result = prepareFixture(repository, missing)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(missing)
    expect(result.stderr).toContain(repository.root)
  })
})

it('rejects the official commit as its own packaging commit', () => {
  withRepository((repository) => {
    const result = prepareFixture(repository, repository.official)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('is the official source commit')
  })
})

it('rejects a dirty official checkout without writing anything', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    writeFileSync(join(repository.root, CORE_SOURCE), "export const CORE = 'edited'\n")
    const result = prepareFixture(repository, packaging)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('uncommitted changes')
    expect(result.stderr).toContain(CORE_SOURCE)
    for (const path of PACKAGING_FILES) expect(readFileSync(join(repository.root, path), 'utf8')).toBe(OFFICIAL_TREE[path])
  })
})

it('rejects an untracked file in the official checkout', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    writeFileSync(join(repository.root, PACKAGING_HELPER), 'export const leftover = true\n')
    const result = prepareFixture(repository, packaging)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('uncommitted changes')
    expect(result.stderr).toContain(PACKAGING_HELPER)
  })
})

it('rejects a packaging commit that does not carry one of the scripts', () => {
  withRepository((repository) => {
    const packaging = repository.packaging({ [BUILDER_CONFIG]: null })
    const result = prepareFixture(repository, packaging)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(BUILDER_CONFIG)
    expect(result.stderr).toContain(packaging)
  })
})

it('rejects repeated publisher imports instead of guessing which one to revert', () => {
  withRepository((repository) => {
    const repeated = PACKAGING_TREE[PACKAGE_TARGET]!.replace('import { localWindowsPackageEnvironment }',
      `import { desktopBuildRecordFilename as recordName } from '${PUBLISHER_IMPORT}'\nimport { localWindowsPackageEnvironment }`)
    const packaging = repository.packaging({ [PACKAGE_TARGET]: repeated })
    const result = prepareFixture(repository, packaging)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(PACKAGE_TARGET)
    expect(result.stderr).toContain('2')
    expect(readFileSync(join(repository.root, PACKAGE_TARGET), 'utf8')).toBe(OFFICIAL_TREE[PACKAGE_TARGET])
  })
})

it('rejects a relative import the official source tree does not provide', () => {
  withRepository((repository) => {
    const broken = `${PACKAGING_TREE[BUILDER_CONFIG]!}import { missing } from './missing-helper.mjs'\n`
    const packaging = repository.packaging({ [BUILDER_CONFIG]: broken })
    const result = prepareFixture(repository, packaging)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('./missing-helper.mjs')
    expect(result.stderr).toContain(BUILDER_CONFIG)
  })
})

it('rejects a source directory below the work tree root', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    const result = prepare(join(repository.root, 'apps', 'desktop'), '--source', join(repository.root, 'apps', 'desktop'),
      '--packaging-commit', packaging, '--official-commit', repository.official)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(repository.root)
  })
})

it('rejects a source directory outside a git work tree', () => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    const outside = mkdtempSync(join(tmpdir(), 'custom-core-plain-'))
    try {
      const result = prepare(outside, '--source', outside, '--packaging-commit', packaging,
        '--official-commit', repository.official)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(outside)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

it.each(['--source', '--packaging-commit'])('requires %s', (option) => {
  withRepository((repository) => {
    const packaging = repository.packaging()
    const args = option === '--source'
      ? ['--packaging-commit', packaging, '--official-commit', repository.official]
      : ['--source', repository.root, '--official-commit', repository.official]
    const result = prepare(repository.root, ...args)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`${option} is required`)
  })
})
