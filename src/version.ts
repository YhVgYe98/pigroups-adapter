/**
 * The adapter's one version number.
 *
 * `package.json` must say the same thing: `test/version.test.ts` fails when the two
 * disagree, so this constant cannot drift from the published package. Nothing else
 * in `src/` may invent a second number.
 *
 * The adapter and the platform ship as one system (CHANGELOG.md 版本策略), so this
 * is the platform's `SERVER_VERSION` for the same release. It is reported in the
 * `pg_whoami` answer (`adapter_version`) and in the one startup log line.
 */
export const ADAPTER_VERSION = '0.2.0';
