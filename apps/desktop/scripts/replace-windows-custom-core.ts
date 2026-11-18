/** Replace the packed official core tarball with the controlled unified-tools input. */

import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'

/** Directory under `apps/desktop/resources` that holds the controlled core tarball and its sidecar. */
export const CUSTOM_CORE_DIRECTORY = 'custom-core'

/** Reviewed tarball under {@link CUSTOM_CORE_DIRECTORY}; its bytes are the only core source. */
export const CUSTOM_CORE_TARBALL = 'dsh-tools-0.2.2-rc.3.unified.2.tgz'

const OFFICIAL_TARBALL = 'deepseek-ai-dsh-tools-0.2.2-rc.3.tgz'
const PACKED_CUSTOM_TARBALL = 'deepseek-ai-dsh-tools-0.2.2-rc.3.unified.2.tgz'
const CORE_TARBALL_BYTES = 132805
const SHA256SUMS_RECORD = /^([0-9a-f]{64}) {2}(\S+)$/u

/** Packed inputs and the controlled source one Windows unsigned build replaces. */
export interface WindowsCustomCoreRequest {
  /** Directory of tarballs `pnpm pack` produced for the dsh family. */
  readonly packedDsh: string
  /** Controlled tarball holding the unified-tools core. */
  readonly sourceTarball: string
  /** `sha256sum` record naming the expected digest and the source tarball basename. */
  readonly checksumFile: string
}

/** Digests that identify the core bytes before and after the replacement. */
export interface WindowsCustomCoreReplacement {
  readonly sourceSha256: string
  readonly destinationSha256: string
  /** Absolute path of the custom tarball inside the packed inputs. */
  readonly destination: string
}

interface CoreTarballs {
  readonly official: readonly string[]
  readonly custom: readonly string[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readCoreBytes(sourceTarball: string): Buffer {
  let stats
  try {
    stats = statSync(sourceTarball)
  } catch (error) {
    throw new Error(`custom core: cannot read ${sourceTarball}: ${errorText(error)}`)
  }
  if (!stats.isFile()) throw new Error(`custom core: ${sourceTarball} is not a regular file`)
  if (stats.size !== CORE_TARBALL_BYTES) {
    throw new Error(`custom core: ${sourceTarball} is ${stats.size} bytes; expected ${CORE_TARBALL_BYTES}`)
  }
  try {
    return readFileSync(sourceTarball)
  } catch (error) {
    throw new Error(`custom core: cannot read ${sourceTarball}: ${errorText(error)}`)
  }
}

function readExpectedSha256(checksumFile: string, sourceName: string): string {
  let content: string
  try {
    content = readFileSync(checksumFile, 'utf8')
  } catch (error) {
    throw new Error(`custom core: cannot read ${checksumFile}: ${errorText(error)}`)
  }
  const record = SHA256SUMS_RECORD.exec(content.trimEnd())
  if (record === null || record[2] !== sourceName) {
    throw new Error(`custom core: ${checksumFile} is not a sha256sum record; expected "<64 hex>  ${sourceName}"`)
  }
  return record[1]!
}

function findCoreTarballs(packedDsh: string): CoreTarballs {
  const official: string[] = []
  const custom: string[] = []
  for (const relative of readdirSync(packedDsh, { recursive: true, encoding: 'utf8' })) {
    const name = basename(relative)
    if (name !== OFFICIAL_TARBALL && name !== PACKED_CUSTOM_TARBALL) continue
    const path = join(packedDsh, relative)
    if (!statSync(path).isFile()) continue
    ;(name === OFFICIAL_TARBALL ? official : custom).push(path)
  }
  return { official, custom }
}

function paths(matches: readonly string[]): string {
  return matches.length === 0 ? '' : `: ${matches.join(', ')}`
}

/**
 * Swap the official packed core for the controlled tarball, stopping the build on any mismatch.
 *
 * Every precondition fails with an `Error` naming `custom core`, the absolute path, and the count
 * that disagreed. The packed directory is searched recursively so a stale nested copy of either
 * tarball also fails instead of silently surviving into the package set.
 * @param request - Packed tarball directory and the controlled source with its digest sidecar.
 * @returns Digests of the source and the written tarball, plus the written tarball's absolute path.
 */
export function replaceWindowsCustomCore(request: WindowsCustomCoreRequest): WindowsCustomCoreReplacement {
  const { packedDsh, sourceTarball, checksumFile } = request
  const bytes = readCoreBytes(sourceTarball)
  const expected = readExpectedSha256(checksumFile, basename(sourceTarball))
  const sourceSha256 = sha256(bytes)
  if (sourceSha256 !== expected) {
    throw new Error(`custom core: ${sourceTarball} sha256 is ${sourceSha256}; expected ${expected} from ${checksumFile}`)
  }

  const before = findCoreTarballs(packedDsh)
  const officialPath = before.official[0]
  if (before.official.length !== 1 || officialPath === undefined) {
    throw new Error(`custom core: ${packedDsh} contains ${before.official.length} official ${OFFICIAL_TARBALL} tarball(s); expected exactly 1${paths(before.official)}`)
  }
  if (before.custom.length !== 0) {
    throw new Error(`custom core: ${packedDsh} already contains ${before.custom.length} custom ${PACKED_CUSTOM_TARBALL} tarball(s); expected none before replacement${paths(before.custom)}`)
  }

  const destination = join(packedDsh, PACKED_CUSTOM_TARBALL)
  rmSync(officialPath, { force: true })
  const temporary = `${destination}.tmp`
  try {
    writeFileSync(temporary, bytes)
    renameSync(temporary, destination)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  const written = findCoreTarballs(packedDsh).custom
  if (written.length !== 1) {
    throw new Error(`custom core: ${packedDsh} contains ${written.length} custom ${PACKED_CUSTOM_TARBALL} tarball(s) after replacement; expected exactly 1${paths(written)}`)
  }
  let destinationSha256: string
  try {
    destinationSha256 = sha256(readFileSync(destination))
  } catch (error) {
    throw new Error(`custom core: cannot read ${destination}: ${errorText(error)}`)
  }
  if (destinationSha256 !== expected) {
    throw new Error(`custom core: ${destination} sha256 is ${destinationSha256}; expected ${expected} from ${checksumFile}`)
  }

  const remaining = findCoreTarballs(packedDsh).official
  if (remaining.length !== 0) {
    throw new Error(`custom core: ${packedDsh} still contains ${remaining.length} official ${OFFICIAL_TARBALL} tarball(s) after replacement; expected none${paths(remaining)}`)
  }
  return { sourceSha256, destinationSha256, destination }
}
