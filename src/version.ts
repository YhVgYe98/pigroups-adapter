/**
 * The adapter's one version number and the platform line it accepts.
 *
 * `package.json` and its lockfile must say the same adapter version: `test/version.test.ts`
 * fails when they disagree.
 *
 * The platform is accepted by line, not by patch. A platform patch that changes no
 * contract must not force an adapter release, and an adapter must not pin one patch of a
 * platform that will keep moving; what is checked is the minor line, which is the unit
 * that actually changes the wire contract. A different minor is a different layer and is
 * refused before the platform starts, not warned about.
 */
export const ADAPTER_VERSION = '0.19.0';

/** The `pigroups` dependency range and the `/v1/health.version` line this adapter accepts. */
export const SUPPORTED_PLATFORM_RANGE = '^0.7.0';

/** `major.minor` of {@link SUPPORTED_PLATFORM_RANGE}: the unit the contract changes on. */
export const SUPPORTED_PLATFORM_LINE = '0.7';

/**
 * Same minor line, any patch. There is deliberately no lower patch bound: every patch on
 * a line is required to be contract-identical to the others on it, and a member that ran
 * against 0.7.0 keeps running on 0.7.9.
 */
export function platformVersionMatches(version: string): boolean {
  const line = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (line === null) return false;
  return `${line[1]}.${line[2]}` === SUPPORTED_PLATFORM_LINE;
}

/** The one error text used by package preflight, health checks, and whoami checks. */
export function platformVersionError(actual: string, range: string = SUPPORTED_PLATFORM_RANGE): string {
  return (
    `platform version ${actual} is outside the range this adapter supports (${range}). ` +
    'A different minor line changes the wire contract, so it is refused rather than run ' +
    `half-compatible: install a pigroups in ${range} and restart it, then reload this member.`
  );
}
