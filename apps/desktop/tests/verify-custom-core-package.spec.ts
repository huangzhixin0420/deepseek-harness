import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { writeDesktopRuntime } from '../src/runtime-tree.ts'
import { CUSTOM_CORE_DIRECTORY, CUSTOM_CORE_TARBALL } from '../scripts/replace-windows-custom-core.ts'
import { verifyCustomCorePackage } from '../scripts/verify-custom-core-package.ts'
import { writePackage } from './runtime-fixture.ts'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { createPackage } = builderRequire('@electron/asar') as {
  createPackage: (source: string, destination: string) => Promise<void>
}

const APP_ROOT = join(import.meta.dirname, '..')
const SCRIPT = join(APP_ROOT, 'scripts', 'verify-custom-core-package.ts')
const CONTROLLED_INPUT = join(APP_ROOT, 'resources', CUSTOM_CORE_DIRECTORY, CUSTOM_CORE_TARBALL)
const RELEASE = '0.2.2-rc.3'
const CUSTOM = '0.2.2-rc.3.unified.2'
const DSH = '@deepseek-ai/dsh'
const HOST = '@deepseek-ai/dsh-desktop-host'
const TOOLS = '@deepseek-ai/dsh-tools'
const DESKTOP = '@deepseek-ai/dsh-desktop'

const roots: string[] = []

interface Fixture {
  readonly packages: string
  readonly runtime: string
  readonly app: string
}

interface FixtureOptions {
  readonly releaseVersion?: string
  readonly dshVersion?: string
  readonly hostVersion?: string
  readonly toolsVersion?: string
  readonly toolsRecordVersion?: string
  readonly toolsRecordBytes?: number
  readonly toolsRecordIntegrity?: string
  readonly toolsRecords?: number
  readonly sharedTools?: boolean
  readonly desktopVersion?: string
  readonly archiveToolsVersion?: string
  readonly extraArchive?: Readonly<Record<string, string>>
  readonly extraApplication?: Readonly<Record<string, string>>
}

function integrity(body: Buffer): string {
  return `sha512-${createHash('sha512').update(body).digest('base64')}`
}

function write(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), body)
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-custom-core-audit-'))
  roots.push(root)
  const release = options.releaseVersion ?? RELEASE
  const sharedTools = options.sharedTools !== false
  const runtime = join(root, 'dsh')
  mkdirSync(runtime)
  const shared = [{ name: DSH, version: release }, { name: HOST, version: release }]
  if (sharedTools) shared.push({ name: TOOLS, version: options.toolsVersion ?? CUSTOM })
  for (const entry of shared) writePackage(join(runtime, 'node_modules'), entry.name, { version: entry.version })
  writeDesktopRuntime(runtime, {
    schemaVersion: 1,
    version: release,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: '24.17.0',
    pnpmVersion: '11.7.0',
  }, shared.map(entry => entry.name), { platform: 'win32', arch: 'x64' })

  const controlled = readFileSync(CONTROLLED_INPUT)
  const toolsRecord = {
    name: TOOLS,
    version: options.toolsRecordVersion ?? CUSTOM,
    file: 'deepseek-ai-dsh-tools-0.2.2-rc.3.unified.2.tgz',
    bytes: options.toolsRecordBytes ?? controlled.byteLength,
    integrity: options.toolsRecordIntegrity ?? integrity(controlled),
  }
  const packages = [
    { name: DSH, version: options.dshVersion ?? RELEASE, file: 'deepseek-ai-dsh-0.2.2-rc.3.tgz', bytes: 3, integrity: integrity(Buffer.from('dsh')) },
    ...Array.from({ length: options.toolsRecords ?? 1 }, () => toolsRecord),
    { name: HOST, version: options.hostVersion ?? RELEASE, file: 'deepseek-ai-dsh-desktop-host-0.2.2-rc.3.tgz', bytes: 4, integrity: integrity(Buffer.from('host')) },
  ].sort((left, right) => left.name.localeCompare(right.name))
  const packageSet = join(root, 'package-set')
  mkdirSync(packageSet, { recursive: true })
  writeFileSync(join(packageSet, 'desktop-packages.json'), `${JSON.stringify({ schemaVersion: 1, packages })}\n`)

  const source = join(root, 'app-source')
  mkdirSync(source)
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({
    name: DESKTOP,
    version: options.desktopVersion ?? RELEASE,
    main: 'lib/main.js',
  })}\n`)
  write(source, 'lib/main.js', 'export {}\n')
  cpSync(runtime, join(source, 'dsh'), { recursive: true })
  if (options.archiveToolsVersion !== undefined) {
    writeFileSync(join(source, 'dsh', 'node_modules', TOOLS, 'package.json'), `${JSON.stringify({
      name: TOOLS,
      version: options.archiveToolsVersion,
    })}\n`)
  }
  for (const [path, body] of Object.entries(options.extraArchive ?? {})) write(source, path, body)
  const app = join(root, 'app')
  mkdirSync(join(app, 'resources'), { recursive: true })
  await createPackage(source, join(app, 'resources', 'app.asar'))
  for (const [path, body] of Object.entries(options.extraApplication ?? {})) write(app, path, body)
  return { packages: join(packageSet, 'desktop-packages.json'), runtime: join(runtime, 'desktop-runtime.json'), app }
}

function audit(fixture: Fixture): Promise<unknown> {
  return verifyCustomCorePackage(fixture)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('reports the controlled core, release versions, and archive inventory of a custom-core package', async () => {
  const built = await fixture()
  const summary = await audit(built)
  expect(summary).toMatchObject({
    release: RELEASE,
    customCore: CUSTOM,
    desktop: `${DESKTOP}@${RELEASE}`,
    dsh: `${DSH}@${RELEASE}`,
    host: `${HOST}@${RELEASE}`,
    sharedPackages: [`${DSH}@${RELEASE}`, `${HOST}@${RELEASE}`, `${TOOLS}@${CUSTOM}`],
  })
})

it('rejects a package set without a dsh-tools record', async () => {
  const built = await fixture({ toolsRecords: 0 })
  await expect(audit(built)).rejects.toThrow(`expected exactly one ${TOOLS} record; found 0`)
})

it('rejects a package set with two dsh-tools records', async () => {
  const built = await fixture({ toolsRecords: 2 })
  await expect(audit(built)).rejects.toThrow(/duplicate package name or filename/u)
})

it('rejects a dsh-tools record whose version is not the custom core', async () => {
  const built = await fixture({ toolsRecordVersion: RELEASE })
  await expect(audit(built)).rejects.toThrow(`${TOOLS}@${RELEASE} does not match ${CUSTOM}`)
})

it('rejects a dsh-tools record that no longer matches the controlled bytes', async () => {
  const built = await fixture({ toolsRecordBytes: 132804 })
  await expect(audit(built)).rejects.toThrow('dsh-tools tarball is 132804 bytes; expected 132805')
})

it('rejects a dsh-tools record whose integrity is not the sha512 of the controlled tarball', async () => {
  const built = await fixture({ toolsRecordIntegrity: 'sha512-AAAA' })
  const expected = integrity(readFileSync(CONTROLLED_INPUT))
  await expect(audit(built)).rejects.toThrow(`dsh-tools integrity is sha512-AAAA; expected ${expected}`)
})

it('rejects a packaged application whose Desktop version is not the release', async () => {
  const built = await fixture({ desktopVersion: '0.2.2-rc.4' })
  await expect(audit(built)).rejects.toThrow(`application package is ${DESKTOP}@0.2.2-rc.4; expected ${DESKTOP}@${RELEASE}`)
})

it('rejects a package set whose dsh record is not the release', async () => {
  const built = await fixture({ dshVersion: '0.2.2-rc.4' })
  await expect(audit(built)).rejects.toThrow(`${DSH}@0.2.2-rc.4 does not match Desktop ${RELEASE}`)
})

it('rejects a package set whose desktop host record is not the release', async () => {
  const built = await fixture({ hostVersion: '0.2.2-rc.4' })
  await expect(audit(built)).rejects.toThrow(`${HOST}@0.2.2-rc.4 does not match Desktop ${RELEASE}`)
})

it('rejects a runtime whose release version is not the expected one', async () => {
  const built = await fixture({ releaseVersion: '0.2.2-rc.4' })
  await expect(audit(built)).rejects.toThrow(`bundled 0.2.2-rc.4 is not the expected ${RELEASE}`)
})

it('rejects a runtime that does not declare the custom core as a shared package', async () => {
  const built = await fixture({ sharedTools: false })
  await expect(audit(built)).rejects.toThrow(`expected exactly one ${TOOLS} shared package; found 0`)
})

it('rejects a runtime whose dsh-tools shared package is not the custom core', async () => {
  const built = await fixture({ toolsVersion: RELEASE })
  await expect(audit(built)).rejects.toThrow(`shared package ${TOOLS}@${RELEASE} does not match ${CUSTOM}`)
})

it('rejects an application archive that bundles another core version', async () => {
  const built = await fixture({ archiveToolsVersion: RELEASE })
  await expect(audit(built)).rejects.toThrow(`application bundles ${TOOLS}@${RELEASE}; expected ${TOOLS}@${CUSTOM}`)
})

it('rejects an application archive that bundles the tool registry', async () => {
  const built = await fixture({ extraArchive: { 'dsh/node_modules/dsh-tool-registry/index.js': 'export {}\n' } })
  await expect(audit(built)).rejects
    .toThrow(/forbidden package dsh-tool-registry at app\.asar\/dsh\/node_modules\/dsh-tool-registry\/index\.js/u)
})

it('rejects an application archive that bundles a runtime the prepared manifest does not record', async () => {
  const built = await fixture({ extraArchive: { 'dsh/node_modules/@deepseek-ai/dsh-business-plugin/index.js': 'export {}\n' } })
  await expect(audit(built)).rejects.toThrow(/unrecorded runtime entry dsh\/node_modules\/@deepseek-ai\/dsh-business-plugin\/index\.js/u)
})

it('rejects an application archive that bundles tarball inputs', async () => {
  const built = await fixture({ extraArchive: { [`dsh/${CUSTOM_CORE_TARBALL}`]: 'x' } })
  await expect(audit(built)).rejects.toThrow(new RegExp(`controlled core tarball at app\\.asar/dsh/${CUSTOM_CORE_TARBALL.replaceAll('.', '\\.')}`, 'u'))
})

it('rejects an application that carries an update feed', async () => {
  const built = await fixture({ extraApplication: { 'resources/app-update.yml': 'provider: generic\n' } })
  await expect(audit(built)).rejects.toThrow('update configuration at resources/app-update.yml')
})

it('lists every archive violation in one failure', async () => {
  const built = await fixture({
    extraArchive: {
      'dsh/node_modules/dsh-tool-registry/index.js': 'export {}\n',
      [`dsh/${CUSTOM_CORE_TARBALL}`]: 'x',
      'dsh/node_modules/@deepseek-ai/dsh-business-plugin/index.js': 'export {}\n',
    },
    extraApplication: { 'resources/app-update.yml': 'provider: generic\n' },
  })
  const error = await audit(built).catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toMatch(/^custom core package: 4 violations in .*app\.asar:/u)
  expect(message).toContain('forbidden package dsh-tool-registry at app.asar/dsh/node_modules/dsh-tool-registry/index.js')
  expect(message).toContain('unrecorded runtime entry dsh/node_modules/@deepseek-ai/dsh-business-plugin/index.js')
  expect(message).toContain(`controlled core tarball at app.asar/dsh/${CUSTOM_CORE_TARBALL}`)
  expect(message).toContain('update configuration at resources/app-update.yml')
})

it('rejects relative inputs', async () => {
  const built = await fixture()
  await expect(verifyCustomCorePackage({ ...built, app: 'app' }))
    .rejects.toThrow('app path must be absolute: app')
})

it('prints a JSON summary and exits zero from the command line', async () => {
  const built = await fixture()
  const run = spawnSync(process.execPath, ['--import', 'tsx/esm', SCRIPT,
    '--packages', built.packages, '--runtime', built.runtime, '--app', built.app], {
    cwd: resolve(APP_ROOT, '..', '..'), encoding: 'utf8', timeout: 120_000,
  })
  expect(run.stderr).toBe('')
  expect(run.status).toBe(0)
  expect(JSON.parse(run.stdout)).toMatchObject({ release: RELEASE, customCore: CUSTOM })
})

it('prints every violation and exits non-zero from the command line', async () => {
  const built = await fixture({ extraApplication: { 'resources/app-update.yml': 'provider: generic\n' } })
  const run = spawnSync(process.execPath, ['--import', 'tsx/esm', SCRIPT,
    '--packages', built.packages, '--runtime', built.runtime, '--app', built.app], {
    cwd: resolve(APP_ROOT, '..', '..'), encoding: 'utf8', timeout: 120_000,
  })
  expect(run.status).toBe(1)
  expect(run.stdout).toBe('')
  expect(run.stderr).toContain('update configuration at resources/app-update.yml')
})
