/** Official `dsh-v0.2.2-rc.3` source commit the baseline must be prepared from. */
export const OFFICIAL_SOURCE_COMMIT: string

/** Packaging scripts the baseline takes from the packaging patch commit, in manifest order. */
export const BASELINE_PACKAGING_FILES: readonly string[]

/** Baseline preparation inputs. */
export interface PrepareCustomCoreBaselineOptions {
  /** Official checkout directory; it must be the work tree root at the official commit. */
  readonly source: string
  /** Packaging patch commit that carries the four packaging files. */
  readonly packagingCommit: string
  /** Official commit the checkout must be at; defaults to the pinned release commit. */
  readonly officialCommit?: string
}

/** Prepared baseline manifest. */
export interface PrepareCustomCoreBaselineRecord {
  /** Official commit the checkout was verified at. */
  readonly officialCommit: string
  /** Packaging patch commit the scripts came from. */
  readonly packagingCommit: string
  /** Scripts written into the official checkout, in manifest order. */
  readonly changedFiles: readonly string[]
  /** Reverted publisher imports per script; only the relocated-module scripts report one. */
  readonly importRewrites: Readonly<Record<string, number>>
}

/**
 * Prepare the official checkout by copying the packaging scripts and reverting their module relocation.
 * @param options - Official checkout directory, packaging patch commit, and the official commit it must be at.
 * @returns Prepared manifest: the commits used and the files written.
 */
export function prepareCustomCoreBaseline(options: PrepareCustomCoreBaselineOptions): PrepareCustomCoreBaselineRecord
