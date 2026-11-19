/** Resolve a manual Windows build version and validate the selected machine preset. */
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { desktopCiVersion as windowsCiVersion } from './desktop-ci-version.mjs'
export { desktopCiVersion as windowsCiVersion } from './desktop-ci-version.mjs'
import { loadDesktopPackageEnvironment, localWindowsPackageEnvironment, validateDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { resolveWindowsPackageSettings } from './windows-package-settings.mjs'

/**
 * Select the packaging environment one CI run uses and the compression level it reports.
 * Signed runs load the machine preset, while unsigned runs ignore preset packaging settings and use local defaults.
 * @param mode Validated signing mode.
 * @param environment Workflow environment, including the preset selectors.
 * @param appRoot Desktop application directory; relative preset paths resolve here.
 * @returns Packaging environment and its installer compression level.
 */
export function windowsCiPackageEnvironment(mode, environment, appRoot) {
  const selected = mode === 'unsigned'
    ? localWindowsPackageEnvironment(environment)
    : loadDesktopPackageEnvironment('win32', environment, appRoot, { unsigned: false })
  return { environment: selected, compressionLevel: resolveWindowsPackageSettings(selected).compressionLevel }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const appRoot = resolve(import.meta.dirname, '..')
  const product = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'))
  const version = windowsCiVersion(process.env, product.version)
  const mode = process.env.PACKAGE_SIGNING
  if (mode !== 'unsigned' && mode !== 'signed') throw new Error('Select unsigned or signed packaging')
  if (!process.env.DSH_PACKAGING_PRESET) throw new Error('Select a machine preset')
  const { environment, compressionLevel } = windowsCiPackageEnvironment(mode, process.env, appRoot)
  // Machine-owned secrets are not automatically known to the Actions log masker.
  for (const [name, value] of Object.entries(environment)) {
    if (/TOKEN|PASSWORD|SECRET/iu.test(name) && value) {
      const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
      process.stdout.write(`::add-mask::${escaped}\n`)
    }
  }
  validateDesktopPackageEnvironment(environment, { platform: 'win32', arch: 'x64' }, { unsigned: mode === 'unsigned' })
  console.log(`Windows installer compression level: ${compressionLevel}`)
  if (!process.env.GITHUB_OUTPUT || !process.env.GITHUB_STEP_SUMMARY) throw new Error('Run this adapter from GitHub Actions')
  // The preset still selects the source ref and version policy for unsigned runs, but not packaging settings.
  const preset = mode === 'unsigned'
    ? `${process.env.DSH_PACKAGING_PRESET} (source and version only; packaging uses local defaults)`
    : process.env.DSH_PACKAGING_PRESET
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Windows x64 ${mode} installer\n\nVersion: ${version}\n\nCommit: ${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}\n\nChannel: ${process.env.DSH_DESKTOP_UPDATE_CHANNEL}\n\nSource: ${process.env.PACKAGE_SOURCE_REF}\n\nPreset: ${preset}\n\nCompression: ${compressionLevel}\n`)
}
