/** Types for scripts/check-global-install-lockfile.mjs (flair#1683). */

/** Repo-relative path of the reviewed weight/floor budget file. */
export const BUDGET_REL: string;

/** The one package this regression lane knows how to install (flair#1683). */
export const FLAIR_PACKAGE: string;

/**
 * Exact-version registry install spec for `--registry-version` (flair#1686).
 * Throws when `version` is not a plain semver.
 */
export function registryInstallSpec(version: string): string;

/** Repo root, resolved from this script's location (scripts/ → repo root). */
export function repoRoot(): string;

/**
 * Floor for the measured installed-package count, read from
 * `.github/install-weight-budget.json` → `minPackages` (default: this script's
 * repo root). Throws when the field is missing or not positive.
 */
export function readMinPackages(root?: string): number;

export interface TreePaths {
  /** `<prefix>/lib/node_modules/@tpsdev-ai/flair` */
  flair: string;
  /** `<prefix>/lib/node_modules` — the root the package count walks */
  globalNodeModules: string;
  /** harper's CLI entrypoint inside that tree */
  harperJs: string;
  /** harper's logging dir — where the fs-extra resolve probe starts */
  harperLoggingDir: string;
}

export interface ResolveCheck {
  ok: boolean;
  resolved?: string;
  error?: string;
}

export interface HarperCheck {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface InstallEvaluation {
  /** npm's "added N packages" summary, reported only — never compared to the floor. */
  added: number | null;
  /** Packages on disk: package.json with a name and version under lib/node_modules. */
  measured: number;
  fsExtra: ResolveCheck;
  harper: HarperCheck;
  failures: string[];
  ok: boolean;
}

export function treePaths(prefix: string): TreePaths;
/**
 * Counts package directories under a global `lib/node_modules`, bundled copies
 * included. Throws on an unreadable directory or a tree past its hard bounds.
 */
export function countInstalledPackages(globalNodeModules: string): number;
export function parseAddedCount(log: string): number | null;
export function hasDamagedLockfileWarning(log: string): boolean;
/** `ok` is false unless the resolve lands inside `paths.flair` (no ambient hoist). */
export function resolveFromLoggingDir(paths: TreePaths): ResolveCheck;
export function harperVersion(paths: TreePaths): HarperCheck;
/** `minPackages` is required; pass `readMinPackages()` for the reviewed floor. */
export function evaluateInstall(args: { log: string; paths: TreePaths; minPackages: number }): InstallEvaluation;
