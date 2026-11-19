import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { replaceWindowsCustomCore } from '../scripts/replace-windows-custom-core.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    rmSync: vi.fn(actual.rmSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  }
})

const SOURCE_NAME = 'dsh-tools-0.2.2-rc.5.unified.1.tgz'
const OFFICIAL = 'deepseek-ai-dsh-tools-0.2.2-rc.5.tgz'
const CUSTOM = 'deepseek-ai-dsh-tools-0.2.2-rc.5.unified.1.tgz'
const CORE_BYTES = 133050

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

let fixture: Buffer | undefined

/** A real gzipped package tarball padded to the reviewed core byte count. */
function customCoreBytes(): Buffer {
  fixture ??= (() => {
    const staging = mkdtempSync(join(tmpdir(), 'desktop-custom-core-fixture-'))
    try {
      mkdirSync(join(staging, 'package'))
      writeFileSync(join(staging, 'package', 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-tools', version: '0.2.2-rc.5.unified.1',
      }))
      execFileSync('tar', ['-czf', join(staging, 'core.tgz'), '-C', staging, 'package'])
      const tarball = readFileSync(join(staging, 'core.tgz'))
      return Buffer.concat([tarball, Buffer.alloc(CORE_BYTES - tarball.byteLength)])
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  })()
  return fixture
}

interface Project {
  readonly packedDsh: string
  readonly source: string
  readonly sidecar: string
}

function project(): Project {
  const root = mkdtempSync(join(tmpdir(), 'desktop-custom-core-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const packedDsh = join(root, 'packed', 'dsh')
  mkdirSync(packedDsh, { recursive: true })
  const source = join(root, 'resources', 'custom-core', SOURCE_NAME)
  mkdirSync(join(root, 'resources', 'custom-core'), { recursive: true })
  writeFileSync(source, customCoreBytes())
  const sidecar = `${source}.sha256`
  writeFileSync(sidecar, `${sha256(customCoreBytes())}  ${SOURCE_NAME}\n`)
  return { packedDsh, source, sidecar }
}

function officialTarball(packedDsh: string): string {
  const official = join(packedDsh, OFFICIAL)
  writeFileSync(official, Buffer.from('official core'))
  return official
}

function replace(target: Project) {
  return replaceWindowsCustomCore({
    packedDsh: target.packedDsh, sourceTarball: target.source, checksumFile: target.sidecar,
  })
}

/** Run the replacement once and return the failure it must raise. */
function refusal(target: Project): Error {
  try {
    replace(target)
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('custom core: expected the replacement to refuse')
}

it('replaces the official core tarball with the controlled input', () => {
  const target = project()
  const official = officialTarball(target.packedDsh)
  const untouched = join(target.packedDsh, 'deepseek-ai-dsh-llm-0.2.2-rc.5.tgz')
  writeFileSync(untouched, Buffer.from('other package'))
  const digest = sha256(customCoreBytes())

  expect(replace(target)).toEqual({
    sourceSha256: digest, destinationSha256: digest, destination: join(target.packedDsh, CUSTOM),
  })
  expect(existsSync(official)).toBe(false)
  expect(readFileSync(join(target.packedDsh, CUSTOM))).toEqual(customCoreBytes())
  expect(readdirSync(target.packedDsh).sort()).toEqual(['deepseek-ai-dsh-llm-0.2.2-rc.5.tgz', CUSTOM].sort())
  expect(readFileSync(untouched)).toEqual(Buffer.from('other package'))
  expect(readFileSync(target.source)).toEqual(customCoreBytes())
  expect(readFileSync(target.sidecar, 'utf8')).toBe(`${digest}  ${SOURCE_NAME}\n`)
})

it('refuses a missing controlled tarball', () => {
  const target = project()
  officialTarball(target.packedDsh)
  rmSync(target.source)

  const error = refusal(target)
  expect(error.message).toMatch(/custom core/u)
  expect(error.message).toContain(target.source)
})

it('refuses a controlled tarball that is a directory', () => {
  const target = project()
  officialTarball(target.packedDsh)
  rmSync(target.source)
  mkdirSync(target.source)

  const error = refusal(target)
  expect(error.message).toMatch(/custom core/u)
  expect(error.message).toContain(`${target.source} is not a regular file`)
})

it.skipIf(process.getuid?.() === 0)('refuses an unreadable controlled tarball', () => {
  const target = project()
  officialTarball(target.packedDsh)
  chmodSync(target.source, 0o000)
  onTestFinished(() => { chmodSync(target.source, 0o600) })

  const error = refusal(target)
  expect(error.message).toMatch(/custom core/u)
  expect(error.message).toContain(target.source)
})

it('refuses a controlled tarball whose byte count changed', () => {
  const target = project()
  officialTarball(target.packedDsh)
  writeFileSync(target.source, Buffer.concat([customCoreBytes(), Buffer.from('x')]))

  const error = refusal(target)
  expect(error.message).toMatch(/custom core/u)
  expect(error.message).toContain(`${target.source} is 133051 bytes; expected ${CORE_BYTES}`)
})

it('refuses a missing checksum sidecar', () => {
  const target = project()
  officialTarball(target.packedDsh)
  rmSync(target.sidecar)

  const error = refusal(target)
  expect(error.message).toMatch(/custom core/u)
  expect(error.message).toContain(target.sidecar)
})

it.each([
  ['a single field', () => `${sha256(customCoreBytes())}\n`],
  ['a short digest', () => `8a03ce84  ${SOURCE_NAME}\n`],
  ['a foreign filename', () => `${sha256(customCoreBytes())}  other.tgz\n`],
])('refuses a checksum sidecar that is not a sha256sum record: %s', (_label, record) => {
  const target = project()
  officialTarball(target.packedDsh)
  writeFileSync(target.sidecar, record())

  const error = refusal(target)
  expect(error.message).toMatch(/custom core/u)
  expect(error.message).toMatch(/is not a sha256sum record/u)
  expect(error.message).toContain(target.sidecar)
})

it('refuses a controlled tarball whose digest disagrees with the sidecar', () => {
  const target = project()
  officialTarball(target.packedDsh)
  const expected = sha256(Buffer.from('different bytes'))
  writeFileSync(target.sidecar, `${expected}  ${SOURCE_NAME}\n`)

  const error = refusal(target)
  expect(error.message).toMatch(/custom core/u)
  expect(error.message).toContain(`sha256 is ${sha256(customCoreBytes())}; expected ${expected}`)
})

it('refuses packed inputs that omit the official core tarball', () => {
  const target = project()

  expect(refusal(target).message).toBe(
    `custom core: ${target.packedDsh} contains 0 official ${OFFICIAL} tarball(s); expected exactly 1`,
  )
})

it('refuses packed inputs that repeat the official core tarball', () => {
  const target = project()
  officialTarball(target.packedDsh)
  mkdirSync(join(target.packedDsh, 'stale'))
  writeFileSync(join(target.packedDsh, 'stale', OFFICIAL), Buffer.from('stale official core'))

  const error = refusal(target)
  expect(error.message).toContain(`contains 2 official ${OFFICIAL} tarball(s); expected exactly 1`)
  expect(error.message).toContain(join(target.packedDsh, 'stale', OFFICIAL))
})

it('refuses packed inputs that already carry a custom core tarball', () => {
  const target = project()
  officialTarball(target.packedDsh)
  writeFileSync(join(target.packedDsh, CUSTOM), Buffer.from('repacked core'))

  const error = refusal(target)
  expect(error.message).toContain(`already contains 1 custom ${CUSTOM} tarball(s); expected none before replacement`)
  expect(error.message).toContain(join(target.packedDsh, CUSTOM))
})

it('refuses a replacement whose custom tarball did not land exactly once', () => {
  const target = project()
  officialTarball(target.packedDsh)
  vi.mocked(renameSync).mockImplementationOnce(() => {})

  const error = refusal(target)
  expect(error.message).toContain(`contains 0 custom ${CUSTOM} tarball(s) after replacement; expected exactly 1`)
})

it('refuses a replacement that leaves the official tarball behind', () => {
  const target = project()
  officialTarball(target.packedDsh)
  vi.mocked(rmSync).mockImplementationOnce(() => {})

  const error = refusal(target)
  expect(error.message).toContain(`still contains 1 official ${OFFICIAL} tarball(s) after replacement; expected none`)
})

it('reports a failed write as a custom core failure that keeps the official tarball', () => {
  const target = project()
  const official = officialTarball(target.packedDsh)
  vi.mocked(writeFileSync).mockImplementationOnce(() => {
    throw new Error('ENOSPC: no space left on device')
  })

  const error = refusal(target)
  expect(error.message).toBe(`custom core: cannot write ${join(target.packedDsh, CUSTOM)}: ENOSPC: no space left on device`)
  expect(readFileSync(official)).toEqual(Buffer.from('official core'))
})

it('reports a failed rename as a custom core failure that keeps the official tarball', () => {
  const target = project()
  const official = officialTarball(target.packedDsh)
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw new Error('EPERM: operation not permitted')
  })

  const error = refusal(target)
  expect(error.message).toBe(`custom core: cannot write ${join(target.packedDsh, CUSTOM)}: EPERM: operation not permitted`)
  expect(readFileSync(official)).toEqual(Buffer.from('official core'))
  expect(readdirSync(target.packedDsh)).toEqual([OFFICIAL])
})

it('refuses a written tarball whose digest disagrees with the sidecar', async () => {
  const target = project()
  officialTarball(target.packedDsh)
  const actual = (await vi.importActual<typeof import('node:fs')>('node:fs')).writeFileSync
  vi.mocked(writeFileSync).mockImplementationOnce((path) => { actual(path, Buffer.from('tampered core')) })

  const error = refusal(target)
  expect(error.message).toMatch(/custom core/u)
  expect(error.message).toContain(`sha256 is ${sha256(Buffer.from('tampered core'))}; expected ${sha256(customCoreBytes())}`)
})
