/**
 * Prepare the official Desktop checkout as the custom-core baseline build source.
 *
 * The baseline must stay official `0.2.2-rc.5` source, so this script copies only the four
 * packaging files from the packaging patch commit. Those files import the Desktop app's own
 * `desktop-auto-update-environment.mjs`, which the official tree already carries, and every other
 * relative import must resolve there too. Everything else in the checkout stays official, and the
 * command line pins the official commit with no override.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** Official `dsh-v0.2.2-rc.5` source commit the baseline must be prepared from. */
export const OFFICIAL_SOURCE_COMMIT = '9c2670d3bce5275e0d1610272958121af87787bb'

/** Packaging files the baseline takes from the packaging patch commit, in manifest order. */
export const BASELINE_PACKAGING_FILES = [
  'apps/desktop/scripts/desktop-package-environment.mjs',
  'apps/desktop/scripts/desktop-package-environment.d.mts',
  'apps/desktop/scripts/electron-builder-config.mjs',
  'apps/desktop/scripts/package-target.ts',
]

// Only the publisher app provides this module, and the official Desktop tree does not carry it.
const PUBLISHER_MODULE = '@deepseek-ai/dsh-desktop-publisher/desktop-auto-update-environment.mjs'
const COMMIT = /^[0-9a-f]{40}$/u
const RELATIVE_IMPORT = /\bfrom '(\.{1,2}\/[^']+)'/gu

/**
 * Report a baseline preparation failure.
 * @param {string} detail Failure detail with the offending path or commit.
 */
function fail(detail) {
  throw new Error(`custom core baseline: ${detail}`)
}

/**
 * Run git in a directory.
 * @param {string} directory Working directory for the command.
 * @param {string[]} args Git arguments.
 * @param {boolean} allowFailure Return undefined instead of throwing when git exits non-zero.
 * @returns {string | undefined} Trimmed standard output, or undefined for an allowed failure.
 */
function git(directory, args, allowFailure = false) {
  try {
    return execFileSync('git', args, {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    }).trim()
  } catch (error) {
    if (allowFailure) return undefined
    fail(`git ${args.join(' ')} failed in ${directory}: ${String(error.stderr ?? error.message).trim()}`)
  }
}

/**
 * Run git in a directory and keep the exact standard output.
 * @param {string} directory Working directory for the command.
 * @param {string[]} args Git arguments.
 * @returns {string} Unmodified standard output.
 */
function raw(directory, args) {
  return execFileSync('git', args, {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  })
}

/**
 * Read a file blob without altering its bytes.
 * @param {string} directory Working directory for the command.
 * @param {string} revision Commit and path, as `<commit>:<path>`.
 * @returns {string | undefined} Blob content, or undefined when the commit does not carry the path.
 */
function blob(directory, revision) {
  try {
    return execFileSync('git', ['cat-file', '-p', revision], {
      cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    return undefined
  }
}

/**
 * Prepare the official checkout by copying the packaging scripts onto it.
 * @param {{ source: string, packagingCommit: string, officialCommit?: string }} options Official checkout
 *   directory, packaging patch commit, and the official commit that checkout must be at.
 * @returns {{ officialCommit: string, packagingCommit: string, changedFiles: string[] }}
 *   Prepared manifest: the commits used and the files written.
 */
export function prepareCustomCoreBaseline(options) {
  const { source, packagingCommit, officialCommit = OFFICIAL_SOURCE_COMMIT } = options
  if (!COMMIT.test(officialCommit)) {
    fail(`official commit must be a 40-character lowercase hexadecimal SHA: ${officialCommit}`)
  }
  if (!COMMIT.test(packagingCommit)) {
    fail(`packaging commit must be a 40-character lowercase hexadecimal SHA: ${packagingCommit}`)
  }
  if (packagingCommit === officialCommit) {
    fail(`packaging commit ${packagingCommit} is the official source commit; pass the packaging patch commit`)
  }
  const directory = isAbsolute(source) ? source : resolve(source)
  if (!existsSync(directory) || !statSync(directory).isDirectory()) fail(`${directory} is not a directory`)
  if (git(directory, ['rev-parse', '--is-inside-work-tree'], true) !== 'true') {
    fail(`${directory} is not a git work tree`)
  }
  const root = realpathSync(git(directory, ['rev-parse', '--show-toplevel']))
  if (root !== realpathSync(directory)) fail(`${directory} is not the work tree root; prepare ${root} instead`)
  const head = git(directory, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (head !== officialCommit) {
    fail(`official source commit is ${head}; expected ${officialCommit}; check out the official release first`)
  }
  if (git(directory, ['rev-parse', '--verify', '--quiet', `${packagingCommit}^{commit}`], true) === undefined) {
    fail(`packaging commit ${packagingCommit} is not available in ${directory}; fetch the history that contains it`)
  }
  const dirty = git(directory, ['status', '--porcelain', '--untracked-files=normal'])
  if (dirty !== '') {
    fail(`${directory} has uncommitted changes; clean it before preparing the baseline: ${dirty.split('\n').join(', ')}`)
  }
  const prepared = []
  for (const path of BASELINE_PACKAGING_FILES) {
    const content = blob(directory, `${packagingCommit}:${path}`)
    if (content === undefined) fail(`${path} is not present in packaging commit ${packagingCommit}`)
    if (content.includes(PUBLISHER_MODULE)) {
      fail(`${path} imports ${PUBLISHER_MODULE}; the baseline cannot resolve the publisher app`)
    }
    for (const [, specifier] of content.matchAll(RELATIVE_IMPORT)) {
      if (!existsSync(resolve(directory, dirname(path), specifier))) {
        fail(`${path} imports ${specifier}, which the official source tree does not provide`)
      }
    }
    prepared.push({ path, content })
  }
  for (const entry of prepared) writeFileSync(join(directory, entry.path), entry.content)
  for (const entry of prepared) {
    if (readFileSync(join(directory, entry.path), 'utf8') !== entry.content) {
      fail(`${entry.path} did not keep the prepared content in ${directory}`)
    }
  }
  const changed = raw(directory, ['status', '--porcelain', '--untracked-files=normal'])
    .split('\n').filter(line => line !== '')
    .map(line => (line.startsWith('"') ? line.slice(3, -1) : line.slice(3)))
  const unexpected = changed.filter(path => !BASELINE_PACKAGING_FILES.includes(path))
  if (unexpected.length > 0) {
    fail(`${directory} changed ${unexpected.join(', ')}; expected only ${BASELINE_PACKAGING_FILES.join(', ')}`)
  }
  return {
    officialCommit,
    packagingCommit,
    changedFiles: prepared.map(entry => entry.path),
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const { values } = parseArgs({
      options: {
        source: { type: 'string' },
        'packaging-commit': { type: 'string' },
      },
      allowPositionals: false,
    })
    if (values.source === undefined) fail('--source is required')
    if (values['packaging-commit'] === undefined) fail('--packaging-commit is required')
    const record = prepareCustomCoreBaseline({
      source: values.source,
      packagingCommit: values['packaging-commit'],
    })
    process.stdout.write(`${JSON.stringify(record, undefined, 2)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message.startsWith('custom core baseline: ') ? message : `custom core baseline: ${message}`)
    process.exitCode = 1
  }
}
