/**
 * Prepare the official Desktop checkout as the custom-core baseline build source.
 *
 * The baseline must stay official `0.2.2-rc.3` source, so this script copies only the three
 * packaging scripts from the packaging patch commit and reverts the one module relocation those
 * scripts carry (`desktop-auto-update-environment` moved to the publisher app after the release),
 * which the official tree cannot resolve. The revert is allowed only when the relocated module is
 * the official file byte for byte. Everything else in the checkout stays official, and the command
 * line pins the official commit with no override.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** Official `dsh-v0.2.2-rc.3` source commit the baseline must be prepared from. */
export const OFFICIAL_SOURCE_COMMIT = '38a6a5c965aa99ab525161efb7cc5cf1fe62fced'

/** Packaging scripts the baseline takes from the packaging patch commit, in manifest order. */
export const BASELINE_PACKAGING_FILES = [
  'apps/desktop/scripts/desktop-package-environment.mjs',
  'apps/desktop/scripts/electron-builder-config.mjs',
  'apps/desktop/scripts/package-target.ts',
]

const PUBLISHER_MODULE = '@deepseek-ai/dsh-desktop-publisher/desktop-auto-update-environment.mjs'
const LOCAL_MODULE = './desktop-auto-update-environment.mjs'
const PUBLISHER_MODULE_FILE = 'apps/desktop-publisher/src/desktop-auto-update-environment.mjs'
const LOCAL_MODULE_FILE = 'apps/desktop/scripts/desktop-auto-update-environment.mjs'
const LOCAL_MODULE_SHA256 = '4fc37321febd4979b732a2832af4eb832602b30185e51584c1ddc0b0cb3db29a'
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
 * Read a file blob as raw bytes without altering them.
 * @param {string} directory Working directory for the command.
 * @param {string} revision Commit and path, as `<commit>:<path>`.
 * @returns {Buffer | undefined} Blob bytes, or undefined when the commit does not carry the path.
 */
function blobBytes(directory, revision) {
  try {
    return execFileSync('git', ['cat-file', '-p', revision], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    return undefined
  }
}

/**
 * Verify that the module the packaging patch relocated is the official module byte for byte.
 *
 * The import revert is only safe when the publisher copy is the official file moved elsewhere;
 * comparing both sides against each other and against the pinned digest rejects any drift before
 * the checkout is written.
 * @param {string} directory Official checkout root.
 * @param {string} packagingCommit Packaging patch commit carrying the relocated module.
 */
function verifyRelocatedModule(directory, packagingCommit) {
  const publisher = blobBytes(directory, `${packagingCommit}:${PUBLISHER_MODULE_FILE}`)
  if (publisher === undefined) fail(`${PUBLISHER_MODULE_FILE} is not present in packaging commit ${packagingCommit}`)
  const localPath = join(directory, LOCAL_MODULE_FILE)
  if (!existsSync(localPath)) fail(`${LOCAL_MODULE_FILE} is missing from the official source tree`)
  const publisherDigest = sha256(publisher)
  const localDigest = sha256(readFileSync(localPath))
  if (publisherDigest !== localDigest) {
    fail(`${PUBLISHER_MODULE_FILE} sha256 is ${publisherDigest}; ${LOCAL_MODULE_FILE} sha256 is ${localDigest};`
      + ' the import revert requires the same module bytes')
  }
  if (localDigest !== LOCAL_MODULE_SHA256) {
    fail(`${LOCAL_MODULE_FILE} sha256 is ${localDigest}; expected ${LOCAL_MODULE_SHA256}`)
  }
}

/**
 * Hash bytes with SHA256 for module identity checks.
 * @param {Buffer} content Module bytes.
 * @returns {string} Lowercase hexadecimal digest.
 */
function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Prepare the official checkout by copying the packaging scripts and reverting their module relocation.
 * @param {{ source: string, packagingCommit: string, officialCommit?: string }} options Official checkout
 *   directory, packaging patch commit, and the official commit that checkout must be at.
 * @returns {{ officialCommit: string, packagingCommit: string, changedFiles: string[],
 *   importRewrites: Record<string, number> }} Prepared manifest: the commits used and the files written.
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
  let moduleVerified = false
  for (const path of BASELINE_PACKAGING_FILES) {
    const content = blob(directory, `${packagingCommit}:${path}`)
    if (content === undefined) fail(`${path} is not present in packaging commit ${packagingCommit}`)
    const importRewrites = content.split(`'${PUBLISHER_MODULE}'`).length - 1
    if (importRewrites > 1) {
      fail(`${path} imports ${PUBLISHER_MODULE} ${importRewrites} times; expected at most one revertable import`)
    }
    if (importRewrites === 1 && !moduleVerified) {
      verifyRelocatedModule(directory, packagingCommit)
      moduleVerified = true
    }
    const adapted = content.replaceAll(`'${PUBLISHER_MODULE}'`, `'${LOCAL_MODULE}'`)
    if (adapted.includes(PUBLISHER_MODULE)) {
      fail(`${path} still references ${PUBLISHER_MODULE}; the baseline cannot resolve the publisher app`)
    }
    for (const [, specifier] of adapted.matchAll(RELATIVE_IMPORT)) {
      if (!existsSync(resolve(directory, dirname(path), specifier))) {
        fail(`${path} imports ${specifier}, which the official source tree does not provide`)
      }
    }
    prepared.push({ path, content: adapted, importRewrites })
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
    importRewrites: Object.fromEntries(prepared.map(entry => [entry.path, entry.importRewrites])),
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
