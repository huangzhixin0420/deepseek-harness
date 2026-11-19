/** Audit one built Windows custom-core package without modifying it. */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { readAsar, type Node as AsarNode } from 'app-builder-lib/out/asar/asar.js'
import { CUSTOM_CORE_DIRECTORY, CUSTOM_CORE_TARBALL } from './replace-windows-custom-core.ts'
import { verifyRuntimeArchive } from './verify-runtime-archive.ts'
import {
  DESKTOP_HOST_PACKAGE,
  parseDesktopCorePackageSet,
  type DesktopCorePackageRecord,
} from '../src/core-package-set.ts'
import { DESKTOP_RUNTIME_FILE, verifyDesktopRuntime, type DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

/** Absolute inputs of one built custom-core package. */
export interface CustomCorePackageAuditOptions {
  /** Absolute path of the package set's `desktop-packages.json`. */
  readonly packages: string
  /** Absolute path of the prepared runtime's `desktop-runtime.json`. */
  readonly runtime: string
  /** Absolute path of the unpacked application directory that holds `resources/app.asar`. */
  readonly app: string
}

/** Facts the audit confirmed about one custom-core package. */
export interface CustomCorePackageAuditSummary {
  /** Desktop, `@deepseek-ai/dsh`, and Desktop Host version the package must ship. */
  readonly release: string
  /** Pinned `@deepseek-ai/dsh-tools` version the package must ship. */
  readonly customCore: string
  readonly desktop: string
  readonly dsh: string
  readonly host: string
  /** Integrity of the controlled tarball, recomputed from its bytes. */
  readonly integrity: string
  /** Byte size of the controlled tarball. */
  readonly bytes: number
  readonly sharedPackages: readonly string[]
  readonly runtimeFiles: number
  /** Number of `dsh/` files the application archive carries. */
  readonly archiveFiles: number
}

const APP_ROOT = resolve(import.meta.dirname, '..')
const ERROR_PREFIX = 'custom core package:'
const RELEASE_VERSION = '0.2.2-rc.5'
const CORE_VERSION = '0.2.2-rc.5.unified.1'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_PACKAGE = '@deepseek-ai/dsh-tools'
const DESKTOP_PACKAGE = '@deepseek-ai/dsh-desktop'
const REGISTRY_PACKAGE = 'dsh-tool-registry'
const UPDATE_CONFIGURATION = 'app-update.yml'
const SHA256SUMS_RECORD = /^([0-9a-f]{64}) {2}(\S+)$/u
const APPLICATION_ARCHIVE = join('resources', 'app.asar')
const ARCHIVE_MANIFEST = 'package.json'
const ARCHIVE_CORE_MANIFEST = join('dsh', 'node_modules', CORE_PACKAGE, 'package.json')

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readBytes(path: string): Buffer {
  try {
    return readFileSync(path)
  } catch (error) {
    throw new Error(`${ERROR_PREFIX} cannot read ${path}: ${errorText(error)}`)
  }
}

function manifest(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${ERROR_PREFIX} ${path} is not a package manifest`)
  }
  return value as Record<string, unknown>
}

function readPackageRecords(path: string): readonly DesktopCorePackageRecord[] {
  const body = readBytes(path)
  let value: unknown
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch (error) {
    throw new Error(`${ERROR_PREFIX} cannot parse ${path}: ${errorText(error)}`)
  }
  return parseDesktopCorePackageSet(value, RELEASE_VERSION).packages
}

function recordNamed(records: readonly DesktopCorePackageRecord[], name: string): DesktopCorePackageRecord {
  const matches = records.filter(record => record.name === name)
  if (matches.length !== 1) throw new Error(`${ERROR_PREFIX} missing ${name} record`)
  return matches[0]!
}

function customCoreRecord(records: readonly DesktopCorePackageRecord[]): DesktopCorePackageRecord {
  const matches = records.filter(record => record.name === CORE_PACKAGE)
  if (matches.length !== 1) {
    throw new Error(`${ERROR_PREFIX} expected exactly one ${CORE_PACKAGE} record; found ${matches.length}`)
  }
  const record = matches[0]!
  if (record.version !== CORE_VERSION) {
    throw new Error(`${ERROR_PREFIX} ${CORE_PACKAGE}@${record.version} does not match ${CORE_VERSION}`)
  }
  return record
}

/** Controlled core tarball and the `sha256sum` record committed beside it. */
export interface ControlledCoreSource {
  /** Absolute path of the controlled tarball. */
  readonly tarball: string
  /** Absolute path of the two-field `sha256sum` record naming that tarball. */
  readonly checksum: string
}

/** Digests of one verified controlled core tarball. */
export interface ControlledCoreDigests {
  readonly bytes: number
  /** npm integrity of the tarball bytes. */
  readonly integrity: string
  /** SHA256 the committed sidecar names. */
  readonly sha256: string
}

/**
 * Verify one controlled tarball against its committed `sha256sum` record and the package-set record.
 * @param record - Package-set record that must describe the same bytes.
 * @param source - Controlled tarball and the sidecar that pins its digest.
 * @returns Verified byte count, npm integrity, and tarball SHA256.
 * @throws Error naming the expected and actual digests; neither input is modified.
 */
export function verifyControlledCore(
  record: DesktopCorePackageRecord,
  source: ControlledCoreSource,
): ControlledCoreDigests {
  const body = readBytes(source.tarball)
  const line = readBytes(source.checksum).toString('utf8').replace(/\r?\n$/u, '')
  const match = SHA256SUMS_RECORD.exec(line)
  if (match === null || match[2] !== basename(source.tarball)) {
    throw new Error(`${ERROR_PREFIX} ${source.checksum} is not a sha256sum record;`
      + ` expected "<64 hex>  ${basename(source.tarball)}"`)
  }
  const sha = createHash('sha256').update(body).digest('hex')
  if (sha !== match[1]) {
    throw new Error(`${ERROR_PREFIX} ${source.tarball} sha256 is ${sha}; expected ${match[1]} from ${source.checksum}`)
  }
  const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`
  if (record.bytes !== body.byteLength) {
    throw new Error(`${ERROR_PREFIX} dsh-tools tarball is ${record.bytes} bytes; expected ${body.byteLength} from ${source.tarball}`)
  }
  if (record.integrity !== integrity) {
    throw new Error(`${ERROR_PREFIX} dsh-tools integrity is ${record.integrity}; expected ${integrity} from ${source.tarball}`)
  }
  return { bytes: body.byteLength, integrity, sha256: sha }
}

function repositoryControlledCore(): ControlledCoreSource {
  const tarball = join(APP_ROOT, 'resources', CUSTOM_CORE_DIRECTORY, CUSTOM_CORE_TARBALL)
  return { tarball, checksum: `${tarball}.sha256` }
}

function checkSharedCore(descriptor: DesktopRuntimeDescriptor): void {
  const shared = descriptor.sharedPackages.filter(entry => entry.name === CORE_PACKAGE)
  if (shared.length !== 1) {
    throw new Error(`${ERROR_PREFIX} expected exactly one ${CORE_PACKAGE} shared package; found ${shared.length}`)
  }
  const version = shared[0]!.version
  if (version !== CORE_VERSION) {
    throw new Error(`${ERROR_PREFIX} shared package ${CORE_PACKAGE}@${version} does not match ${CORE_VERSION}`)
  }
}

/** Return the forbidden-content message for one archive path, if any. */
function forbiddenArchiveEntry(path: string): string | undefined {
  const name = basename(path)
  const at = `app.asar/${path}`
  if (path.split('/').includes(REGISTRY_PACKAGE)) return `forbidden package ${REGISTRY_PACKAGE} at ${at}`
  if (name === CUSTOM_CORE_TARBALL) return `controlled core tarball at ${at}`
  if (name.endsWith('.tgz')) return `tarball input at ${at}`
  if (name === UPDATE_CONFIGURATION) return `update configuration at ${at}`
  return undefined
}

/** Return the forbidden-content message for one file in the application directory, if any. */
function forbiddenApplicationEntry(path: string): string | undefined {
  const name = basename(path)
  if (path.split('/').includes(REGISTRY_PACKAGE)) return `forbidden package ${REGISTRY_PACKAGE} at ${path}`
  if (name === CUSTOM_CORE_TARBALL) return `controlled core tarball at ${path}`
  if (name === UPDATE_CONFIGURATION) return `update configuration at ${path}`
  return undefined
}

interface ArchivedRuntime {
  /** `dsh/`-relative file paths that are not reported as forbidden content. */
  readonly files: Set<string>
  readonly descriptor: boolean
  readonly violations: readonly string[]
}

/** Collect every archived `dsh/` file path and the entries rejected by name. */
function archivedRuntime(header: AsarNode): ArchivedRuntime {
  const files = new Set<string>()
  const violations: string[] = []
  let descriptor = false
  const inspect = (node: AsarNode, path: string): void => {
    if (node.link !== undefined) {
      violations.push(`archive link at app.asar/${path}`)
      return
    }
    if (node.files !== undefined) {
      for (const [name, child] of Object.entries(node.files)) inspect(child, path === '' ? name : `${path}/${name}`)
      return
    }
    const forbidden = forbiddenArchiveEntry(path)
    if (forbidden !== undefined) {
      violations.push(forbidden)
      return
    }
    if (path === `dsh/${DESKTOP_RUNTIME_FILE}`) {
      descriptor = true
      return
    }
    if (path.startsWith('dsh/')) files.add(path.slice('dsh/'.length))
  }
  inspect(header, '')
  return { files, descriptor, violations }
}

function applicationEntries(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, encoding: 'utf8' }).map(entry => entry.split(sep).join('/'))
  } catch (error) {
    throw new Error(`${ERROR_PREFIX} cannot read ${root}: ${errorText(error)}`)
  }
}

/**
 * Audit the package set, the prepared runtime, and the unpacked application of one custom-core build.
 * @param options - Absolute package-set manifest, runtime manifest, and unpacked application paths.
 * @returns Confirmed versions, recomputed integrity, and archive inventory.
 * @throws Error naming every violation; the build artifacts are never modified.
 */
export async function verifyCustomCorePackage(
  options: CustomCorePackageAuditOptions,
): Promise<CustomCorePackageAuditSummary> {
  for (const [name, value] of Object.entries(options)) {
    if (!isAbsolute(value)) throw new Error(`${ERROR_PREFIX} ${name} path must be absolute: ${value}`)
  }
  const records = readPackageRecords(options.packages)
  const coreRecord = customCoreRecord(records)
  const controlled = verifyControlledCore(coreRecord, repositoryControlledCore())
  const descriptor = await verifyDesktopRuntime(
    dirname(options.runtime), RELEASE_VERSION, { platform: 'win32', arch: 'x64' })
  checkSharedCore(descriptor)

  const archivePath = join(options.app, APPLICATION_ARCHIVE)
  let archive
  try {
    archive = await readAsar(archivePath)
  } catch (error) {
    throw new Error(`${ERROR_PREFIX} cannot read ${archivePath}: ${errorText(error)}`)
  }
  const desktop = manifest(await archive.readJson(ARCHIVE_MANIFEST), `app.asar/${ARCHIVE_MANIFEST}`)
  if (desktop.name !== DESKTOP_PACKAGE || desktop.version !== RELEASE_VERSION) {
    throw new Error(`${ERROR_PREFIX} application package is ${String(desktop.name)}@${String(desktop.version)};`
      + ` expected ${DESKTOP_PACKAGE}@${RELEASE_VERSION}`)
  }
  const bundled = manifest(await archive.readJson(ARCHIVE_CORE_MANIFEST),
    `app.asar/${ARCHIVE_CORE_MANIFEST.split(sep).join('/')}`)
  if (bundled.version !== CORE_VERSION) {
    throw new Error(`${ERROR_PREFIX} application bundles ${CORE_PACKAGE}@${String(bundled.version)};`
      + ` expected ${CORE_PACKAGE}@${CORE_VERSION}`)
  }

  const recorded = new Set(descriptor.files.map(file => file.path))
  const archived = archivedRuntime(archive.header)
  const violations = [...archived.violations]
  // The prepared runtime alone binds the plugin inputs: a package set covers the dsh family, while registry
  // dependencies of the installed closure are legitimate, so file-set equality decides what the archive carries.
  for (const path of archived.files) {
    if (!recorded.has(path)) violations.push(`unrecorded runtime entry dsh/${path}`)
  }
  for (const path of recorded) if (!archived.files.has(path)) violations.push(`missing runtime entry dsh/${path}`)
  if (!archived.descriptor) violations.push(`missing runtime descriptor dsh/${DESKTOP_RUNTIME_FILE}`)
  for (const entry of applicationEntries(options.app)) {
    const forbidden = forbiddenApplicationEntry(entry)
    if (forbidden !== undefined) violations.push(forbidden)
  }
  if (violations.length > 0) {
    violations.sort()
    throw new Error(`${ERROR_PREFIX} ${violations.length} violations in ${archivePath}:\n  - ${violations.join('\n  - ')}`)
  }
  try {
    await verifyRuntimeArchive(archivePath, descriptor)
  } catch (error) {
    throw new Error(`${ERROR_PREFIX} ${errorText(error)}`)
  }
  return {
    release: RELEASE_VERSION,
    customCore: CORE_VERSION,
    desktop: `${DESKTOP_PACKAGE}@${String(desktop.version)}`,
    dsh: `${DSH_PACKAGE}@${recordNamed(records, DSH_PACKAGE).version}`,
    host: `${DESKTOP_HOST_PACKAGE}@${recordNamed(records, DESKTOP_HOST_PACKAGE).version}`,
    integrity: controlled.integrity,
    bytes: controlled.bytes,
    sharedPackages: descriptor.sharedPackages.map(entry => `${entry.name}@${entry.version}`),
    runtimeFiles: descriptor.files.length,
    archiveFiles: archived.files.size,
  }
}

function requiredArgument(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name]
  if (typeof value !== 'string') throw new Error(`${ERROR_PREFIX} --${name} is required`)
  return value
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { packages: { type: 'string' }, runtime: { type: 'string' }, app: { type: 'string' } },
    allowPositionals: false,
  })
  const summary = await verifyCustomCorePackage({
    packages: requiredArgument(values, 'packages'),
    runtime: requiredArgument(values, 'runtime'),
    app: requiredArgument(values, 'app'),
  })
  process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    const message = errorText(error)
    process.stderr.write(`${message.startsWith(ERROR_PREFIX) ? message : `${ERROR_PREFIX} ${message}`}\n`)
    process.exitCode = 1
  })
}
