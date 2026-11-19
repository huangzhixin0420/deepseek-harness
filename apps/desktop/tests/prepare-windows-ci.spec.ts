import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { windowsCiPackageEnvironment, windowsCiVersion } from '../scripts/prepare-windows-ci.mjs'
import { resolveWindowsPackageSettings } from '../scripts/windows-package-settings.mjs'

const inputs = { PACKAGE_BUILD_VERSION: 'auto', GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '2' }
const now = new Date('2026-10-09T01:02:03Z')

async function withDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'windows-ci-'))
  try {
    await action(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('manual Windows CI version', () => {
  it('uses the selected product prefix and UTC run identity', () => {
    expect(windowsCiVersion(inputs, '0.2.1-alpha.1', now)).toBe('0.2.1-alpha.1.20261009.42.2')
    expect(windowsCiVersion(inputs, '0.2.1', now)).toBe('0.2.1-test.20261009.42.2')
  })
  it.each(['0.2.1-alpha.1', '0.2.1-alpha.1.20261009.7'])('accepts explicit version %s without run identity', (version) => {
    expect(windowsCiVersion({ PACKAGE_BUILD_VERSION: version }, '0.2.1-alpha.1', now)).toBe(version)
  })
  it.each(['', 'bad', '0.3.0'])('reports checkout-specific guidance for %s', (version) => {
    expect(() => windowsCiVersion({ PACKAGE_BUILD_VERSION: version }, '0.2.1-alpha.1', now))
      .toThrow(/version_mode=build-number, or use 0\.2\.1-alpha\.1, or e\.g\. 0\.2\.1-alpha\.1\.20261009\.1/u)
  })
  it.each([{ GITHUB_RUN_NUMBER: '0' }, { GITHUB_RUN_ATTEMPT: '1\nINJECTED=value' }])('rejects invalid run identity %j', (override) => {
    expect(() => windowsCiVersion({ ...inputs, ...override }, '0.2.1', now)).toThrow(/positive integer/u)
  })
})


it('resolves the selected version policy independently of the update channel', () => {
  expect(windowsCiVersion({ ...inputs, PACKAGE_VERSION_MODE: 'default', DSH_PACKAGING_PRESET: 'production' }, '1.2.3', now)).toBe('1.2.3')
  expect(windowsCiVersion({ ...inputs, PACKAGE_VERSION_MODE: 'default', DSH_PACKAGING_PRESET: 'test' }, '1.2.3', now)).toBe('1.2.3-test.20261009.42.2')
  expect(windowsCiVersion({ PACKAGE_VERSION_MODE: 'follow-dsh' }, '1.2.3-alpha.1', now)).toBe('1.2.3-alpha.1')
  expect(() => windowsCiVersion({ PACKAGE_VERSION_MODE: 'manual', PACKAGE_BUILD_VERSION: 'auto' }, '1.2.3', now)).toThrow(/explicit version/u)
  expect(() => windowsCiVersion({ PACKAGE_VERSION_MODE: 'invalid' }, '1.2.3', now)).toThrow(/version mode/u)
})

describe('manual Windows CI packaging selection', () => {
  it('ignores preset and workflow compression for unsigned runs and reports the local default', async () => {
    await withDirectory(async (directory) => {
      await mkdir(join(directory, 'presets'))
      await writeFile(join(directory, 'presets', 'test.env'), 'DSH_DESKTOP_AUTO_UPDATE_ENV=test\n'
        + 'DSH_DESKTOP_APP_ID=com.example.preset\nDSH_DESKTOP_WINDOWS_COMPRESSION_LEVEL=9\nDSH_DESKTOP_WINDOWS_PACK_CONCURRENCY=2\n')
      const selected = windowsCiPackageEnvironment('unsigned', {
        DSH_PACKAGING_PRESET: 'test', DSH_PACKAGING_CONFIG_DIR: directory,
        PACKAGE_WINDOWS_COMPRESSION_LEVEL: '7', DSH_DESKTOP_WINDOWS_COMPRESSION_LEVEL: '5',
        PATH: '/custom/windows-ci-path',
      }, directory)
      expect(selected.environment.PATH).toBe('/custom/windows-ci-path')
      expect(selected.compressionLevel).toBe(3)
      expect(resolveWindowsPackageSettings(selected.environment))
        .toEqual({ signatureCacheConcurrency: 4, packConcurrency: 4, compressionLevel: 3 })
      expect(selected.environment.DSH_DESKTOP_APP_ID).toBe('com.deepseek.dsh')
    })
  })

  it('keeps the selected dotenv and workflow compression override for signed runs', async () => {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, '.env.windows'), 'DSH_DESKTOP_APP_ID=com.example.windows\nDSH_DESKTOP_WINDOWS_COMPRESSION_LEVEL=9\n')
      const selected = windowsCiPackageEnvironment('signed', { PACKAGE_WINDOWS_COMPRESSION_LEVEL: '7' }, directory)
      expect(selected.environment.DSH_DESKTOP_APP_ID).toBe('com.example.windows')
      expect(selected.compressionLevel).toBe(7)
    })
  })
})
