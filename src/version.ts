/**
 * The adapter's one version number and the exact platform version it is built for.
 *
 * `package.json` and its lockfile must say the same adapter version: `test/version.test.ts`
 * fails when they disagree. There is no compatibility range: the adapter and platform are
 * released as a pair, and using an older platform is a hard error rather than a warning.
 */
export const ADAPTER_VERSION = '0.18.1';

/** The exact `pigroups` package / `/v1/health.version` this adapter is built for. */
export const EXPECTED_PLATFORM_VERSION = '0.7.2';

/** Exact match, not a major.minor range and not a semver range. */
export function platformVersionMatches(version: string): boolean {
  return version.trim() === EXPECTED_PLATFORM_VERSION;
}

/** The one error text used by package preflight, health checks, and whoami checks. */
export function platformVersionError(actual: string, expected: string = EXPECTED_PLATFORM_VERSION): string {
  return (
    `platform version ${actual} is not the version this adapter is built for (${expected}). ` +
    `This release has no cross-version support: update the platform to pigroups@${expected} ` +
    'and restart it, then reload this member.'
  );
}
