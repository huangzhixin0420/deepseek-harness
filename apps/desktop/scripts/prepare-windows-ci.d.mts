/** Resolve the version used by the manual Windows packaging workflow. */

/**
 * Resolve an explicit version or a UTC date/run/attempt identifier without release storage access.
 * @param environment Manual version and GitHub run identity.
 * @param productVersion Version declared by the selected checkout.
 * @param now Time used for the UTC date segment.
 * @returns Validated build version.
 */
export function windowsCiVersion(environment: NodeJS.ProcessEnv, productVersion: string, now?: Date): string

/**
 * Select the packaging environment one CI run uses and the compression level it reports.
 * Signed runs load the machine preset, while unsigned runs ignore preset packaging settings and use local defaults.
 * @param mode Validated signing mode.
 * @param environment Workflow environment, including the preset selectors.
 * @param appRoot Desktop application directory; relative preset paths resolve here.
 * @returns Packaging environment and its installer compression level.
 */
export function windowsCiPackageEnvironment(
  mode: 'signed' | 'unsigned',
  environment: NodeJS.ProcessEnv,
  appRoot: string,
): { environment: NodeJS.ProcessEnv, compressionLevel: number }
