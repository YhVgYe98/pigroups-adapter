/**
 * The adapter's one version number.
 *
 * `package.json` and its lockfile must say the same thing: `test/version.test.ts`
 * fails when any of the three disagree, so this constant cannot drift from the
 * published package. Nothing else in `src/` may invent a second number.
 *
 * The build metadata records the platform the release was tested against. It is
 * documentation only: compatibility is decided by the platform's major.minor (the
 * warning below) and by the `v` field on `pg.*`, never by this suffix. A platform
 * change that needs no adapter change is answered by republishing the same numeric
 * version with new metadata, not by moving the number.
 */
export const ADAPTER_VERSION = '0.8.0+platform.0.2.0';

/**
 * Platform major.minor versions this adapter is built for. This is a warning list,
 * not a gate: an unknown platform still starts and works. Extend it once a new
 * platform minor has been exercised.
 */
export const SUPPORTED_PLATFORM_MINORS = ['0.2'];

/** The major.minor part of a platform version, or `undefined` when it cannot be read. */
export function platformMajorMinor(version: string): string | undefined {
  const match = /^\s*v?(\d+)\.(\d+)(?:\.|$)/.exec(version);
  return match === null ? undefined : `${match[1]}.${match[2]}`;
}

/**
 * The whole compatibility decision, with no I/O: one warning line for a platform
 * outside the supported majors.minors, naming both sides; `undefined` for a match.
 * An unreachable platform never reaches this function, so it cannot warn here.
 */
export function platformCompatibilityWarning(
  platformVersion: string,
  adapterVersion: string = ADAPTER_VERSION,
  supported: readonly string[] = SUPPORTED_PLATFORM_MINORS,
): string | undefined {
  const minor = platformMajorMinor(platformVersion);
  if (minor !== undefined && supported.includes(minor)) return undefined;
  const actual = minor ?? 'unreadable';
  return (
    `[pigroups] platform ${platformVersion} (major.minor ${actual}) is outside the supported list ` +
    `[${supported.join(', ')}]; adapter ${adapterVersion} will continue`
  );
}
