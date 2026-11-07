/**
 * Starting the organisation from inside the session that will lead it (概念稿 §7.4).
 *
 * Until now a root was made by a human: start the platform, `POST /v1/bootstrap`
 * with the admin token, then launch pi with `PIGROUPS_URL` and `PIGROUPS_TOKEN`.
 * A session with the skills loaded but without those variables registered no
 * tools at all, and the model quietly fell back to subagent.
 *
 * `pg_org_start` closes that gap: an unconfigured session can find the platform
 * checkout, start the platform detached, bootstrap a root and hand the identity
 * back to `extension.ts`, which then builds the loop. This module owns the
 * process and file side of that; it never touches pi.
 *
 * The organisation outlives the session that created it. The platform is
 * deliberately detached and unreferenced, and `org.json` is the durable record
 * that lets a later session reattach instead of starting a second organisation.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultAdapterDir } from './datadir.ts';
import { PgClient, PgError } from './pgclient.ts';
import { EXPECTED_PLATFORM_VERSION, platformVersionError, platformVersionMatches } from './version.ts';

export { defaultAdapterDir } from './datadir.ts';

/** What `<adapterDir>/org.json` records. `pid` is the process we started, not a promise it is still that process. */
export interface OrgState {
  url: string;
  token: string;
  admin_token: string;
  pid: number;
  data_dir: string;
  /**
   * The platform instance inside the shared data root. Absent from records written
   * before the platform named itself; a healthy reattach fills it in.
   */
  platform_id?: string;
}

export interface OrgHandle {
  /** True when an organisation recorded in `org.json` answered and its token still works. */
  reattached: boolean;
  url: string;
  token: string;
  adminToken: string;
  /** The recorded platform process; `0` is never written, so this is always a real pid. */
  pid: number;
  dataDir: string;
  /** The directory name under `<adapterDir>/orgs/` that holds this organisation. */
  orgKey: string;
  /** Where this organisation's record lives: `<adapterDir>/orgs/<key>/org.json`. */
  orgFile: string;
  /** The checkout that was started; undefined when we only reattached and did not need one. */
  platformDir?: string;
  root: { id: string; name: string };
}

export interface OrgStartOptions {
  name?: string;
  port?: number;
  dataDir?: string;
  platformDir?: string;
  /** The adapter directory holding `orgs/`; defaults to `PIGROUPS_ADAPTER_DIR` or `~/.pi/pigroups`. */
  adapterDir?: string;
  /** Working directory used to derive the organisation key when no name is given. */
  cwd?: string;
  /** Cancels the waits. A platform already started is stopped again on cancellation. */
  signal?: AbortSignal;
  /**
   * The adapter's own repository root, from which the `../PiGroups` candidates are
   * resolved. Defaults to this file's location; overridable so the lookup can be
   * tested where the sibling checkout does not exist.
   */
  adapterRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: how long to wait for a freshly started platform to answer `/v1/health`. */
  healthTimeoutMs?: number;
  /** Test seam: where a new organisation's platform id comes from. */
  platformIdSource?: () => string;
  /**
   * A session that already has a record must never mint a new root. With `false`,
   * an organisation whose recorded root token no longer works fails instead of
   * bootstrapping a second root over the old one.
   */
  mayBootstrap?: boolean;
}

/** One place the adapter looked for the platform checkout, and why. */
export interface PlatformCandidate {
  path: string;
  source: string;
}

/** A failure a person can act on: the message is the documentation the stuck user sees. */
export class OrgStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgStartError';
  }
}

const ORG_FILE = 'org.json';
/** `<adapterDir>/orgs/<key>/` - one directory per organisation. */
const ORG_DIR = 'orgs';
const PLATFORM_DATA_DIR = 'platform-data';
const PLATFORM_DB = 'pigroups.db';
const LOCK_FILE = 'org.lock';
const PLATFORM_ENTRY = join('src', 'main.ts');
const HEALTH_TIMEOUT_MS = 1200;
const START_TIMEOUT_MS = 6000;
/** §8.2/§9: how long a start may wait for the platform to become healthy. */
const DEFAULT_START_WAIT_MS = 30_000;
const STOP_TIMEOUT_MS = 2000;
const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 120_000;

/** The adapter's own directory, independent of cwd: `src/org.ts` → repository root. */
export function defaultAdapterRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** `org.json` and the journal live side by side under the adapter directory (§12.1). */
/**
 * Where the platform checkout may be, in the order the tool tries them. The two
 * relative candidates are resolved from the adapter's own location (the repository
 * root), never from cwd: a session may run anywhere.
 */
export function platformCandidates(
  opts: { platformDir?: string; env?: NodeJS.ProcessEnv; adapterRoot?: string } = {},
): PlatformCandidate[] {
  const env = opts.env ?? process.env;
  const root = opts.adapterRoot ?? defaultAdapterRoot();
  const candidates: PlatformCandidate[] = [];
  if (opts.platformDir !== undefined && opts.platformDir !== '') {
    candidates.push({ path: resolve(opts.platformDir), source: 'platform_dir argument' });
  }
  const fromEnv = env.PIGROUPS_PLATFORM_DIR;
  if (fromEnv !== undefined && fromEnv !== '') {
    candidates.push({ path: resolve(fromEnv), source: 'PIGROUPS_PLATFORM_DIR' });
  }
  candidates.push({ path: resolve(root, '..', 'PiGroups'), source: '../PiGroups next to the adapter' });
  candidates.push({ path: resolve(root, '..', '..', 'PiGroups'), source: '../../PiGroups' });
  candidates.push({ path: resolve(root, 'node_modules', 'pigroups'), source: 'node_modules/pigroups' });
  // The published adapter depends on the platform package. A local checkout still
  // wins above, but an npm install finds the exact dependency here. A test that
  // overrides `adapterRoot` deliberately isolates the filesystem layout, so it must
  // not inherit the developer's installed dependency.
  if (opts.adapterRoot === undefined) {
    try {
      const installed = createRequire(import.meta.url).resolve('pigroups/package.json');
      candidates.push({ path: dirname(installed), source: 'installed pigroups npm package' });
    } catch {
      // Not installed: the lookup error lists every other candidate.
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

/** The checkout's own package version. A checkout without a readable version is not usable. */
function readPlatformPackageVersion(dir: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof raw.version !== 'string' || raw.version === '') {
      throw new Error('package.json has no version');
    }
    return raw.version;
  } catch (err) {
    throw new OrgStartError(
      `cannot read the platform version from ${join(dir, 'package.json')}: ${describe(err)}. ` +
        `This adapter requires pigroups@${EXPECTED_PLATFORM_VERSION}; install that package or point ` +
        'PIGROUPS_PLATFORM_DIR at its checkout.',
    );
  }
}

/** Refuse a platform from another release before it can start or migrate data. */
function assertPlatformVersion(actual: string, where: string): void {
  if (platformVersionMatches(actual)) return;
  throw new OrgStartError(`${where}: ${platformVersionError(actual)}`);
}

/** Resolve the checkout by the one fact that matters: `src/main.ts` exists. */
export function findPlatformDir(
  opts: { platformDir?: string; env?: NodeJS.ProcessEnv; adapterRoot?: string } = {},
): {
  dir: string;
  tried: PlatformCandidate[];
} {
  const tried = platformCandidates(opts);
  const found = tried.find((candidate) => existsSync(join(candidate.path, PLATFORM_ENTRY)));
  if (found !== undefined) return { dir: found.path, tried };
  throw new OrgStartError(platformLookupMessage(tried));
}

function platformLookupMessage(tried: PlatformCandidate[]): string {
  const lines = tried.map((candidate) => `  - ${candidate.path}  (${candidate.source})`);
  return [
    'cannot find the PiGroups platform checkout: none of these paths has src/main.ts:',
    ...lines,
    'Pass `platform_dir`, set PIGROUPS_PLATFORM_DIR, or clone PiGroups next to this adapter.',
  ].join('\n');
}

/**
 * The whole operation: reattach to the recorded organisation when it is still
 * healthy, otherwise start a platform and bootstrap a root. Idempotent: a repeated
 * or concurrent call converges on one organisation thanks to `org.json` and a lock.
 */
export async function startOrg(opts: OrgStartOptions = {}): Promise<OrgHandle> {
  const env = opts.env ?? process.env;
  const adapterDir = resolve(opts.adapterDir ?? defaultAdapterDir(env));
  // One directory per organisation, keyed by its name. A single org.json under the adapter
  // directory made two roots on one machine fight over the same file: the second call found
  // the first one's record, answered "healthy" and reattached both teams to one platform.
  // The key is the org name, or the working directory it was started from when no name is
  // given - two roots in two projects are two organisations, the same project is the same one.
  const key = orgKey(opts.name, opts.cwd ?? process.cwd(), adapterDir);
  const orgDir = join(adapterDir, ORG_DIR, key);
  const orgFile = join(orgDir, ORG_FILE);

  // B2: a caller that cannot take the lock probes health on the same 100 ms cadence. A
  // platform that is already answering is this organisation, so there is nothing to
  // start and no reason to wait out the lock (or to report a failure after 18 sessions
  // start at once). Errors here are only a race with the lock holder's bootstrap; the
  // locked path below reports the real one.
  const probe = async (): Promise<OrgHandle | undefined> => {
    const current = readOrgState(orgFile);
    if (current === undefined) return undefined;
    return reattachRecorded(current, adapterDir, orgFile, opts.dataDir);
  };

  return withOrgLock(orgDir, probe, () => startOrgLocked(opts, adapterDir, orgFile, env));
}

/** Keys that already hold a record under <adapterDir>/orgs/. */
function orgKeys(adapterDir: string): string[] {
  const root = join(adapterDir, ORG_DIR);
  try {
    return readdirSync(root).filter((key) => existsSync(join(root, key, ORG_FILE)));
  } catch {
    return [];
  }
}

/**
 * The organisation key a session record's URL names. A record written before `orgKey`
 * existed still has to find its organisation, and the URL is the fact both files share.
 * This reads only the small `org.json` records under `orgs/` - never a platform database.
 */
export function findOrgKeyByUrl(adapterDir: string, url: string): string | undefined {
  for (const key of orgKeys(adapterDir)) {
    let state: OrgState | undefined;
    try {
      state = readOrgState(join(adapterDir, ORG_DIR, key, ORG_FILE));
    } catch {
      continue;
    }
    if (state !== undefined && sameOrgUrl(state.url, url)) return key;
  }
  return undefined;
}

/** True when `<adapterDir>/orgs/<key>/org.json` exists; the key is sanitised the same way `orgKey` does. */
export function isRecordedOrg(adapterDir: string, key: string): boolean {
  const clean = sanitizeOrgKey(key);
  return clean !== undefined && existsSync(join(adapterDir, ORG_DIR, clean, ORG_FILE));
}

function sameOrgUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/**
 * The current URL of a recorded organisation, read from local files only. The
 * platform may have advanced past the recorded port; its endpoint record wins.
 * Returns undefined when the record is missing or unreadable, so the caller can
 * fall back to the URL stored in its own session record.
 */
export function recordedOrgUrl(adapterDir: string, key: string | undefined): string | undefined {
  if (key === undefined || key === '') return undefined;
  const clean = sanitizeOrgKey(key);
  if (clean === undefined) return undefined;
  try {
    const state = readOrgState(join(adapterDir, ORG_DIR, clean, ORG_FILE));
    if (state === undefined) return undefined;
    if (state.platform_id !== undefined && state.data_dir !== '') {
      const endpoint = readPlatformEndpoint(resolve(state.data_dir), state.platform_id);
      if (endpoint !== undefined) return urlOfPort(endpoint.port);
    }
    return state.url;
  } catch {
    return undefined;
  }
}

/**
 * Directory-safe key. The name wins; without one it is the basename of the working
 * directory, unless exactly one organisation is already recorded here - then that is the
 * one a later session means. Two records and no name is ambiguous, so the working
 * directory decides: guessing between two teams is worse than starting a third record.
 */
function orgKey(name: string | undefined, cwd: string, adapterDir: string): string {
  if (name === undefined) {
    const existing = orgKeys(adapterDir);
    if (existing.length === 1) return existing[0];
  }
  const base = (name ?? basename(cwd)) || ORG_FILE;
  return sanitizeOrgKey(base) ?? 'org';
}

function sanitizeOrgKey(base: string): string | undefined {
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? undefined : cleaned.slice(0, 64);
}

/**
 * The record answered `/v1/health`: prove it is the same platform instance, that its
 * database is where the record says, and that its token still names a live root. Returns
 * undefined when nothing answers, which is the caller's signal to restart it.
 */
async function reattachRecorded(
  previous: OrgState,
  adapterDir: string,
  orgFile: string,
  explicitDataDir?: string,
): Promise<OrgHandle | undefined> {
  // The platform may have moved since the record was written (a restart that
  // advanced past an occupied port). The platform's own endpoint record wins; the
  // URL in org.json is only the fallback for a platform that has no record.
  const endpoint =
    previous.platform_id === undefined ? undefined : readPlatformEndpoint(resolve(previous.data_dir), previous.platform_id);
  // A record can outlive the instance that wrote it: its port may now hold a
  // different platform. That makes the record stale, not the organisation wrong,
  // so fall back to the URL org.json already had and let the identity check judge
  // that address.
  let url = previous.url;
  let health: PlatformHealth | undefined;
  if (endpoint !== undefined && previous.platform_id !== undefined) {
    const atEndpoint = await platformHealth(urlOfPort(endpoint.port));
    if (atEndpoint !== undefined && platformIdOf(atEndpoint) === previous.platform_id) {
      url = urlOfPort(endpoint.port);
      health = atEndpoint;
    }
  }
  if (health === undefined) health = await platformHealth(previous.url);
  if (health === undefined) return undefined;
  assertPlatformVersion(health.version, `the platform at ${url}`);
  // One-time follow of a moved data root. It is only a candidate here: a live
  // platform is reattached first, and an unresponsive one is stopped against the
  // data dir its process was actually started with before anything is rewritten.
  const migratedDataDir =
    explicitDataDir !== undefined && explicitDataDir !== ''
      ? undefined
      : migratedRecordDataDir(previous, adapterDir, orgFile);
  assertPlatformIdentity({
    requested: undefined,
    recorded: previous.platform_id,
    health,
    url,
    orgFile,
  });
  // A healthy URL does not make a wrong record right: if the record names a
  // platform, its database must be where the record says. A restart would
  // otherwise create a second instance in the empty dir.
  assertRecordedPlatformDatabase(previous, migratedDataDir ?? resolve(previous.data_dir), orgFile);
  let root: { id: string; name: string };
  try {
    root = await whoamiRoot(url, previous.token);
  } catch (err) {
    throw new OrgStartError(
      `the platform at ${url} (pid ${previous.pid}) answers /v1/health, but the member ` +
        `token in ${orgFile} was rejected (${describe(err)}). Refusing to start a second ` +
        `organisation on top of it: that would leave the old one running with no session able ` +
        `to reach it.\n` +
        `Restore that platform's data, or stop pid ${previous.pid} and delete ${orgFile} to ` +
        `start a new organisation.`,
    );
  }
  // A record written before the platform had ids gets one the first time it is
  // seen again, and a platform that moved ports makes org.json follow it. Writing
  // both now means the next start does not look at a dead address first.
  const platformId = previous.platform_id ?? platformIdOf(health);
  const urlChanged = url !== previous.url;
  // A duplicate starter can leave a pre-bind endpoint claim whose pid is already
  // gone; a dead pid must not replace the serving process the record names.
  const endpointPid =
    endpoint?.pid !== undefined && pidAlive(endpoint.pid) ? endpoint.pid : undefined;
  const pidChanged = endpointPid !== undefined && endpointPid !== previous.pid;
  if (
    migratedDataDir !== undefined ||
    urlChanged ||
    pidChanged ||
    (previous.platform_id === undefined && platformId !== undefined)
  ) {
    writeOrgState(orgFile, {
      ...previous,
      url,
      data_dir: migratedDataDir ?? previous.data_dir,
      ...(endpointPid === undefined ? {} : { pid: endpointPid }),
      ...(platformId === undefined ? {} : { platform_id: platformId }),
    });
  }
  return {
    reattached: true,
    url,
    token: previous.token,
    adminToken: previous.admin_token,
    pid: endpointPid ?? previous.pid,
    dataDir: migratedDataDir ?? previous.data_dir,
    orgKey: basename(dirname(orgFile)),
    orgFile,
    root,
  };
}

async function startOrgLocked(
  opts: OrgStartOptions,
  adapterDir: string,
  orgFile: string,
  env: NodeJS.ProcessEnv,
): Promise<OrgHandle> {
  const previous = readOrgState(orgFile);

  // (b) Reattach when the recorded organisation is still there. This is checked
  // before the platform checkout: a member that already has an identity does not
  // need the source tree at all, and a caller that lost the lock race adopts the
  // platform the winner has just brought up.
  if (previous !== undefined) {
    const reattached = await reattachRecorded(previous, adapterDir, orgFile, opts.dataDir);
    if (reattached !== undefined) return reattached;
    // Nothing answered. Do not signal the recorded pid: a platform that is still
    // starting, or that is briefly unreachable, is not a dead one, and killing it
    // would turn a transient failure into an outage. The start below meets it on
    // the platform's recorded port; it either exits as a duplicate or reports a
    // port whose holder it cannot identify.
    if (previous.platform_id === undefined) {
      // A record from before platform ids cannot prove that a platform started now
      // is the recorded one, and bootstrapping would replace that organisation's
      // root. Reattach is the only safe move, and it just failed.
      throw new OrgStartError(
        `${orgFile} names no platform_id, and ${previous.url} does not answer GET /v1/health. ` +
          `Without an id there is no way to prove a platform started now is the recorded one, and a ` +
          `bootstrap would replace the old organisation's root. Start the recorded platform by hand, ` +
          `or delete ${orgFile} to start a new organisation.`,
      );
    }
  }

  // The startup path must never create a platform in a directory that the record
  // says already holds one: an empty new platform would accept the bootstrap and
  // overwrite the record with a second organisation's identity.
  const dataDir = resolveStartDataDir(opts, previous, adapterDir, orgFile);
  assertRecordedPlatformDatabase(previous, dataDir, orgFile);

  // (a) Find the checkout only when a platform actually has to be started. The
  // checkout version is checked before spawning: an old checkout must not migrate
  // or touch the shared data root.
  const checkout = findPlatformDir({ platformDir: opts.platformDir, env, adapterRoot: opts.adapterRoot });
  assertPlatformVersion(readPlatformPackageVersion(checkout.dir), `platform checkout ${checkout.dir}`);

  // (c) Start it: the recorded port for a restart, the caller's port for a new
  // organisation; data under the adapter dir unless told otherwise; a fresh admin
  // token unless the old organisation had one (creating humans is the only use).
  //
  // This is only the *first candidate*. The platform owns the port: it prefers the
  // port in its own endpoint record, and advances past a candidate that answers as
  // another service. An existing organisation never probes: its candidate comes
  // from the record. A new one with no `port` gets an ephemeral seed from
  // `freePort()`; binding and releasing it reserves nothing, which is fine because
  // the platform treats the seed as a candidate rather than as ownership.
  const seedPort =
    previous !== undefined ? (portOf(previous.url) ?? opts.port) : (opts.port ?? (await freePort()));
  // One data root per adapter directory, not one per organisation: the platform
  // makes `platforms/<platform_id>/` inside it. A new organisation therefore has to
  // name its own id, otherwise the platform reuses the only platform already there
  // and bootstrap would find that platform's root.
  const adminToken = previous?.admin_token ?? randomBytes(24).toString('base64url');
  const requestedPlatformId =
    previous === undefined ? generatePlatformId(dataDir, opts.platformIdSource) : previous.platform_id;
  // Each organisation logs beside its own record. The data root is shared, so a
  // platform.log there would interleave every organisation's stderr.
  const logFile = join(dirname(orgFile), 'platform.log');
  const launchedAt = Date.now();

  const platform = launchPlatform({
    platformDir: checkout.dir,
    seedPort,
    dataDir,
    adminToken,
    platformId: requestedPlatformId,
    logFile,
    env,
  });
  let tokenError: string | undefined;

  try {
    // (d) Wait bounded, then claim the root seat. The platform may have bound a
    // different port than the seed, so the URL is discovered, not assumed.
    const started = await waitForPlatform(platform.child, {
      dataDir,
      platformId: requestedPlatformId,
      ...(seedPort === undefined ? {} : { candidatePort: seedPort }),
      timeoutMs: opts.healthTimeoutMs ?? envMs(env, 'PIGROUPS_START_WAIT_MS', DEFAULT_START_WAIT_MS),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });

    if (started.kind === 'duplicate') {
      // Another process already serves this platform. That is the normal outcome
      // of a restart racing its predecessor, not a failure: attach to the instance
      // that owns the port, with the token the record already has.
      if (previous === undefined) {
        throw new OrgStartError(
          `the platform for the new organisation ${requestedPlatformId} exited because that platform ` +
            `is already bound on ${started.url}, and there is no recorded root token to attach with. ` +
            `Delete ${orgFile} and pick a different organisation, or stop the process serving ` +
            `${started.url}.`,
        );
      }
      const adopted = await reattachRecorded({ ...previous, url: started.url }, adapterDir, orgFile, opts.dataDir);
      if (adopted !== undefined) return adopted;
      throw new OrgStartError(
        `the platform reported that ${requestedPlatformId} is already served at ${started.url}, but that ` +
          `address did not answer GET /v1/health with the recorded identity. Nothing was stopped and ` +
          `${orgFile} was not rewritten; inspect the process holding that port (log: ${logFile}).`,
      );
    }

    const { health, url } = started;
    assertPlatformVersion(health.version, `the platform at ${url}`);

    // The platform that answered must be the instance org.json names, and a new
    // organisation must get exactly the id it asked for. This is checked before
    // whoami or bootstrap: attaching to a same-named record on a different instance,
    // or bootstrapping into a platform that won the port race, is the one mistake
    // that must not be repaired silently.
    assertPlatformIdentity({
      requested: requestedPlatformId,
      recorded: previous?.platform_id,
      health,
      url,
      ...(previous === undefined ? {} : { orgFile }),
    });
    // A platform that reports no id is older than 0.3.0: it ignores
    // PIGROUPS_PLATFORM_ID and writes `pigroups.db` flat into the data root. With one
    // shared root that would put every organisation in one database, and the damage
    // would surface as "my other team's members are here". Refuse.
    if (platformIdOf(health) === undefined) {
      throw new OrgStartError(
        `the platform at ${url} (pid ${platform.pid}) does not report a platform_id, so it is older than ` +
          `0.3.0. This adapter keeps every organisation's database in one shared data root ` +
          `(${dataDir}) and relies on platform ids to keep them apart; an older platform would put them ` +
          `all in one database. Point PIGROUPS_PLATFORM_DIR at a 0.3.0 checkout, or set data_dir to a ` +
          `dedicated directory for this organisation.`,
      );
    }
    const platformId = platformIdOf(health) ?? previous?.platform_id;
    // The endpoint's pid is the process that actually holds the port. A duplicate
    // start exits before binding, so `platform.pid` is only the fallback for a
    // platform too old to write a record.
    const servingPid = started.pid ?? platform.pid;

    if (previous !== undefined) {
      try {
        const root = await whoamiRoot(url, previous.token);
        const state: OrgState = {
          url,
          token: previous.token,
          admin_token: adminToken,
          pid: servingPid,
          data_dir: dataDir,
          ...(platformId === undefined ? {} : { platform_id: platformId }),
        };
        writeOrgState(orgFile, state);
        return {
          reattached: true,
          url,
          token: state.token,
          adminToken,
          orgKey: basename(dirname(orgFile)),
          orgFile,
          pid: servingPid,
          dataDir,
          platformDir: checkout.dir,
          root,
        };
      } catch (err) {
        // The recorded data dir may have been wiped while org.json survived. A
        // bootstrap below can still make a root; if one exists, its 409 is the
        // answer and both reasons are reported.
        tokenError = describe(err);
      }
    }

    if (opts.mayBootstrap === false) {
      throw new OrgStartError(
        `refusing to bootstrap a new root for ${orgFile}: this session already has a recorded identity, ` +
          'and a bootstrap would replace the recorded organisation\'s root. ' +
          (tokenError === undefined ? '' : `The recorded root token did not work: ${tokenError}. `) +
          'Reissue the root token, or start a new organisation from a session with no record.',
      );
    }
    const created = await new PgClient({ url, token: adminToken }).bootstrap(
      opts.name === undefined ? {} : { name: opts.name },
    );
    const state: OrgState = {
      url,
      token: created.token,
      admin_token: adminToken,
      pid: servingPid,
      data_dir: dataDir,
      ...(platformId === undefined ? {} : { platform_id: platformId }),
    };
    writeOrgState(orgFile, state);
    return {
      reattached: false,
      url,
      token: state.token,
      adminToken,
      orgKey: basename(dirname(orgFile)),
      orgFile,
      pid: servingPid,
      dataDir,
      platformDir: checkout.dir,
      root: { id: created.member.id, name: created.member.name },
    };
  } catch (err) {
    // Cleanup on failure: never leave the platform we just started behind. An
    // orphan would hold the port and the data dir and look like a healthy org.
    await stopChild(platform.child);
    const detail = describe(err);
    const rejected = tokenError === undefined ? '' : `\n(the recorded member token was also rejected: ${tokenError})`;
    let debris = '';
    try {
      const moved = relocateLegacyFlatDatabase(dataDir, requestedPlatformId, launchedAt);
      if (moved !== undefined) {
        debris =
          `\nThis start created a flat ${PLATFORM_DB} in ${dataDir} (the pre-0.3 layout). ` +
          `It was moved, not deleted, to ${moved}; the data root is usable by a 0.3.0 platform again.`;
      }
    } catch (moveErr) {
      debris =
        `\nA flat ${PLATFORM_DB} in ${dataDir} could not be moved aside: ${describe(moveErr)}. ` +
        `Move it by hand before starting a 0.3.0 platform on this data root.`;
    }
    const disposition =
      platform.child.exitCode === null && platform.child.signalCode === null
        ? `The platform process (pid ${platform.pid}) was stopped; its log may say why: ${logFile}`
        : `Nothing was left running; the platform's log may say why: ${logFile}`;
    throw new OrgStartError(`${detail}${rejected}${debris}${logTail(logFile)}\n${disposition}`);
  }
}

/**
 * The data dir the next platform start uses. The record wins unless it is the old
 * per-organisation default and the platform has actually been moved into the shared
 * root: then the record follows its database once. An explicit data_dir always wins;
 * an old default with no matching database in the shared root is left alone.
 */
function resolveStartDataDir(
  opts: OrgStartOptions,
  previous: OrgState | undefined,
  adapterDir: string,
  orgFile: string,
): string {
  if (opts.dataDir !== undefined && opts.dataDir !== '') return resolve(opts.dataDir);
  if (previous === undefined) return resolve(adapterDir, PLATFORM_DATA_DIR);
  return migratedRecordDataDir(previous, adapterDir, orgFile) ?? resolve(previous.data_dir);
}

/** The shared root when the record is the old per-org default and its database moved there. */
function migratedRecordDataDir(
  previous: OrgState,
  adapterDir: string,
  orgFile: string,
): string | undefined {
  const recorded = resolve(previous.data_dir);
  const oldDefault = resolve(dirname(orgFile), PLATFORM_DATA_DIR);
  if (recorded !== oldDefault || previous.platform_id === undefined) return undefined;
  const shared = resolve(adapterDir, PLATFORM_DATA_DIR);
  return existsSync(platformDatabasePath(shared, previous.platform_id)) ? shared : undefined;
}

function platformDatabasePath(dataDir: string, platformId: string): string {
  return join(dataDir, 'platforms', platformId, PLATFORM_DB);
}

/**
 * A record that names a platform is a promise that its database is under that data
 * dir. Starting in an empty directory would make the platform create a second
 * instance with the same id, the old token would be rejected, and bootstrap would
 * overwrite the record with a new organisation. Never do that silently.
 */
function assertRecordedPlatformDatabase(
  previous: OrgState | undefined,
  dataDir: string,
  orgFile: string,
): void {
  if (previous?.platform_id === undefined) return;
  const database = platformDatabasePath(dataDir, previous.platform_id);
  if (existsSync(database)) return;
  throw new OrgStartError(
    `${orgFile} records platform_id ${previous.platform_id} and data_dir ${dataDir}, but ${database} does ` +
      `not exist. The record says that platform lives there, and the filesystem does not have it. ` +
      `Refusing to start: a platform started in this directory would be a second, empty instance with ` +
      `the same id, and bootstrapping on it would overwrite ${orgFile}. Restore ${database} (for example ` +
      `by moving the old platform's platforms/${previous.platform_id}/ back), or delete ${orgFile} to ` +
      `start a new organisation.`,
  );
}

/**
 * A pre-0.3 platform ignores PIGROUPS_PLATFORM_ID and writes `pigroups.db` flat into
 * the data root. The refusal is correct, but that file makes the platform itself
 * refuse every later start ("root database + platforms/ is not empty"). Move the
 * debris aside (never delete it), and only when it was created by this start and no
 * directory for the id we asked for exists. Anything else is left untouched.
 */
function relocateLegacyFlatDatabase(
  dataDir: string,
  platformId: string | undefined,
  launchedAt: number,
): string | undefined {
  if (platformId === undefined) return undefined;
  const database = join(dataDir, PLATFORM_DB);
  if (!existsSync(database)) return undefined;
  if (statSync(database).mtimeMs < launchedAt) return undefined;
  if (existsSync(join(dataDir, 'platforms', platformId))) return undefined;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let destination = join(dataDir, `refused-0.2.0-${stamp}`);
  for (let suffix = 1; existsSync(destination); suffix += 1) {
    destination = join(dataDir, `refused-0.2.0-${stamp}-${suffix}`);
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  // Sidecars first, database last: the flat database remaining in the root is the
  // marker that the move has not finished.
  for (const suffix of ['-wal', '-shm', '-journal', '']) {
    const source = `${database}${suffix}`;
    if (existsSync(source)) renameSync(source, join(destination, `${PLATFORM_DB}${suffix}`));
  }
  return destination;
}

// ---------------------------------------------------------------------------
// org.json
// ---------------------------------------------------------------------------

export function readOrgState(file: string): OrgState | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new OrgStartError(`cannot read ${file}: ${describe(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OrgStartError(
      `${file} is not valid JSON; it is the record of a running organisation. ` +
        `Restore it or delete it to start a new one.`,
    );
  }
  const record = asRecord(parsed);
  const url = record?.url;
  const token = record?.token;
  const adminToken = record?.admin_token;
  const pid = record?.pid;
  const dataDir = record?.data_dir;
  const platformId = record?.platform_id;
  if (
    typeof url !== 'string' ||
    typeof token !== 'string' ||
    typeof adminToken !== 'string' ||
    typeof pid !== 'number' ||
    typeof dataDir !== 'string' ||
    (platformId !== undefined && platformId !== null && typeof platformId !== 'string')
  ) {
    throw new OrgStartError(
      `${file} does not look like an org record (need url, token, admin_token, pid, data_dir, ` +
        `optional platform_id). Restore it or delete it to start a new one.`,
    );
  }
  return {
    url,
    token,
    admin_token: adminToken,
    pid,
    data_dir: dataDir,
    ...(typeof platformId === 'string' && platformId !== '' ? { platform_id: platformId } : {}),
  };
}

function writeOrgState(file: string, state: OrgState): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // The file holds two credentials, so it is owner-only. Write-then-rename keeps a
  // crash from leaving a half-written record that the next session would distrust.
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(temporary, file);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw new OrgStartError(`cannot write ${file}: ${describe(err)}`);
  }
}

/**
 * One organisation per adapter directory, even when two sessions call the tool at
 * the same time. The lock is advisory and short-lived; a dead holder's lock is
 * removed. While waiting, B2 probes health: a platform that already answers makes
 * the lock pointless, so the caller adopts it instead of waiting out the deadline.
 */
async function withOrgLock<T>(
  adapterDir: string,
  probe: () => Promise<T | undefined>,
  work: () => Promise<T>,
): Promise<T> {
  mkdirSync(adapterDir, { recursive: true, mode: 0o700 });
  const lockFile = join(adapterDir, LOCK_FILE);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new OrgStartError(`cannot create ${lockFile}: ${describe(err)}`);
      }
      if (lockIsStale(lockFile)) {
        rmSync(lockFile, { force: true });
        continue;
      }
      // A failure here is a race with the holder's bootstrap, not a verdict: the
      // locked path below reads the record again and reports the real error.
      const adopted = await probe().catch(() => undefined);
      if (adopted !== undefined) return adopted;
      if (Date.now() >= deadline) {
        throw new OrgStartError(
          `another pg_org_start is still starting an organisation (lock: ${lockFile}). ` +
            `If no such session exists, delete that file and try again.`,
        );
      }
      await sleep(100);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lockFile, { force: true });
  }
}

function lockIsStale(lockFile: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockFile, 'utf8');
  } catch {
    return false;
  }
  const record = asRecord(safeJson(raw));
  const pid = record?.pid;
  const at = record?.at;
  if (typeof at === 'number' && Date.now() - at > LOCK_STALE_MS) return true;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  // On the same machine a dead holder's pid is provably gone. On a shared
  // filesystem the pid means nothing; the age bound above is the only safe rule.
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

// ---------------------------------------------------------------------------
// Platform process
// ---------------------------------------------------------------------------

interface LaunchedPlatform {
  child: ChildProcess;
  pid: number;
}

/**
 * `detached` + `unref` is the lifetime decision: the organisation must outlive the
 * session that conjured it. stdout/stderr go to a file because there is no terminal
 * to hold them anymore.
 */
function launchPlatform(opts: {
  platformDir: string;
  /** The first candidate. Absent lets the platform use its record or its own default. */
  seedPort?: number;
  dataDir: string;
  adminToken: string;
  /** Absent only for a record written before platform ids existed. */
  platformId?: string;
  logFile: string;
  env: NodeJS.ProcessEnv;
}): LaunchedPlatform {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(opts.logFile), { recursive: true, mode: 0o700 });
  const log = openSync(opts.logFile, 'a', 0o600);
  const env: NodeJS.ProcessEnv = {
    ...opts.env,
    PIGROUPS_DATA: opts.dataDir,
    PIGROUPS_ADMIN_TOKEN: opts.adminToken,
  };
  // The platform prefers the port in its own endpoint record; PORT only seeds a
  // platform that has none. Inheriting an unrelated PORT would be a third opinion.
  delete env.PORT;
  if (opts.seedPort !== undefined) env.PORT = String(opts.seedPort);
  // Do not let an unrelated value inherited from the session choose a platform:
  // only the id recorded in org.json (or the fresh one for a new organisation) does.
  delete env.PIGROUPS_PLATFORM_ID;
  if (opts.platformId !== undefined) env.PIGROUPS_PLATFORM_ID = opts.platformId;
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [join(opts.platformDir, PLATFORM_ENTRY)], {
      detached: true,
      stdio: ['ignore', log, log],
      env,
    });
  } finally {
    closeSync(log);
  }
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new OrgStartError(`could not start the platform from ${opts.platformDir}`);
  return { child, pid };
}

interface PlatformHealth {
  status: string;
  version: string;
  platform_id?: string;
}

/**
 * The platform's own record of the port it bound (`platforms/<id>/endpoint.json`).
 * It is how a start that advanced past the seed port tells the adapter where the
 * platform actually is. A record naming another platform is not ours.
 */
interface PlatformEndpoint {
  platform_id: string;
  port: number;
  pid?: number;
}

function readPlatformEndpoint(dataDir: string, platformId: string): PlatformEndpoint | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataDir, 'platforms', platformId, 'endpoint.json'), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.platform_id !== platformId) return undefined;
    const port = record.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
    return {
      platform_id: platformId,
      port,
      ...(typeof record.pid === 'number' && Number.isInteger(record.pid) ? { pid: record.pid } : {}),
    };
  } catch {
    return undefined;
  }
}

function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  if (exit.signal !== null) return `was killed by ${exit.signal}`;
  return `exited (code ${exit.code ?? 'unknown'})`;
}

function urlOfPort(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** The platform's exit code when another process already serves the same platform. */
const DUPLICATE_EXIT_CODE = 2;

type PlatformWait =
  | { kind: 'ready'; url: string; health: PlatformHealth; pid?: number }
  | { kind: 'duplicate'; url: string };

/**
 * Wait for the platform this call launched to answer, or for it to exit because
 * another process already serves the organisation.
 *
 * The port is discovered, never assumed: the platform prefers its endpoint record
 * and may advance past the seed, and the record is read before every probe so a
 * platform that is still writing it is still found. `PIGROUPS_START_WAIT_MS` bounds
 * the whole wait; a timeout is a report, not a reason to signal anything.
 */
async function waitForPlatform(
  child: ChildProcess,
  opts: {
    dataDir: string;
    /** Absent for a record written before the platform had ids: no endpoint to read. */
    platformId?: string;
    candidatePort?: number;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<PlatformWait> {
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
    child.exitCode === null && child.signalCode === null
      ? null
      : { code: child.exitCode, signal: child.signalCode };
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (opts.signal?.aborted === true) throw new OrgStartError('cancelled while waiting for the platform to answer');

    const endpoint =
      opts.platformId === undefined ? undefined : readPlatformEndpoint(opts.dataDir, opts.platformId);
    const url =
      endpoint !== undefined
        ? urlOfPort(endpoint.port)
        : opts.candidatePort === undefined
          ? undefined
          : urlOfPort(opts.candidatePort);

    if (exit !== null && exit.code !== DUPLICATE_EXIT_CODE) {
      throw new OrgStartError(`the platform process ${describeExit(exit)} before answering`);
    }
    const duplicate = exit !== null && exit.code === DUPLICATE_EXIT_CODE;

    if (url !== undefined) {
      const health = await platformHealth(url);
      if (health !== undefined) {
        // The child may have lost the port to an older instance after it answered;
        // recording a dead pid would make the next session trust it.
        if (duplicate) return { kind: 'duplicate', url };
        if (exit !== null) {
          throw new OrgStartError(`the platform process at ${url} ${describeExit(exit)} before answering`);
        }
        return { kind: 'ready', url, health, ...(endpoint?.pid === undefined ? {} : { pid: endpoint.pid }) };
      }
    }

    if (Date.now() >= deadline) {
      if (duplicate) {
        throw new OrgStartError(
          `the platform exited because this organisation is already served elsewhere, but ` +
            (url === undefined ? 'no endpoint record says where' : `${url} did not answer GET /v1/health`) +
            ` within ${opts.timeoutMs} ms. Nothing was stopped and no second process was started; ` +
            `inspect the process holding the port.`,
        );
      }
      throw new OrgStartError(
        `the platform did not answer GET /v1/health within ${opts.timeoutMs} ms` +
          (url === undefined ? '' : ` at ${url}`),
      );
    }
    await sleep(50);
  }
}


/** Health is the platform's own word. A 404 from some other service is not a platform. */
async function platformHealth(url: string): Promise<PlatformHealth | undefined> {
  try {
    const response = await fetch(new URL('/v1/health', url), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { status?: unknown; version?: unknown; platform_id?: unknown };
    if (body.status !== 'ok' || typeof body.version !== 'string') return undefined;
    return {
      status: body.status,
      version: body.version,
      ...(typeof body.platform_id === 'string' && body.platform_id !== ''
        ? { platform_id: body.platform_id }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** `p_` + 8 hex, the shape the platform itself generates. */
function newPlatformId(): string {
  return `p_${randomBytes(4).toString('hex')}`;
}

/** A generated id must not name a directory that already exists in the shared root. */
function generatePlatformId(dataDir: string, source?: () => string): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = source === undefined ? newPlatformId() : source();
    if (!existsSync(join(dataDir, 'platforms', id))) return id;
  }
  throw new OrgStartError(
    `could not generate a platform id that is unused under ${join(dataDir, 'platforms')}; ` +
      `remove the empty directories there or pass an organisation that already has a record.`,
  );
}

function platformIdOf(health: PlatformHealth): string | undefined {
  return health.platform_id;
}

/**
 * A record and a health answer naming different platforms are not two views of one
 * organisation: they are the same name attached to a different instance. Attaching
 * would hand the session someone else's root token; bootstrapping would overwrite
 * the recorded organisation. The same check also covers a brand-new organisation:
 * a platform that ignores the id we passed is not the platform we asked for.
 */
function assertPlatformIdentity(opts: {
  requested: string | undefined;
  recorded: string | undefined;
  health: PlatformHealth;
  url: string;
  /** Absent only for a new organisation, which has no record yet. */
  orgFile?: string;
}): void {
  const actual = platformIdOf(opts.health);
  const expected = opts.requested ?? opts.recorded;
  if (opts.requested !== undefined && opts.recorded !== undefined && opts.requested !== opts.recorded) {
    throw new OrgStartError(
      `this start asked for platform_id ${opts.requested}, but ${opts.orgFile ?? 'the record'} names ` +
        `${opts.recorded}. Refusing to start: the two identities cannot both be right.`,
    );
  }
  if (expected === undefined || actual === undefined || actual === expected) return;
  if (opts.orgFile !== undefined) {
    throw new OrgStartError(
      `${opts.orgFile} records platform_id ${expected}, but the platform at ${opts.url} reports ${actual}: ` +
        `the same organisation record names a different platform instance. Refusing to attach to it or to ` +
        `bootstrap a second one. Restore the platform with id ${expected}, or delete ${opts.orgFile} ` +
        `to start a new organisation.`,
    );
  }
  throw new OrgStartError(
    `the platform at ${opts.url} reports platform_id ${actual}, but this organisation asked for ${expected}. ` +
      `Refusing to bootstrap: a different platform instance would receive this organisation's root. ` +
      `Point PIGROUPS_PLATFORM_DIR at a 0.3.0 platform that honours PIGROUPS_PLATFORM_ID, or choose a ` +
      `free port so the platform this start launched can answer.`,
  );
}

async function whoamiRoot(url: string, token: string): Promise<{ id: string; name: string }> {
  const who = await new PgClient({ url, token }).whoami();
  return { id: who.member.id, name: who.member.name };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  await Promise.race([exited, sleep(STOP_TIMEOUT_MS)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}


// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * A seed for a new organisation. Binding port 0 and releasing it reserves
 * nothing — the platform treats it as a candidate and advances if it was taken
 * meanwhile. It exists only to spread new organisations out instead of making
 * them all start their search at the platform's default port.
 */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new OrgStartError('could not find a free local port'));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

function envMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function portOf(url: string | undefined): number | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The last few lines of the platform's own log. A platform that refuses to bind
 * writes the reason there; repeating it in the adapter's error is the difference
 * between "code 1" and an instruction a person can act on.
 */
function logTail(logFile: string, lines = 6): string {
  try {
    const all = readFileSync(logFile, 'utf8')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line !== '');
    if (all.length === 0) return '';
    return `\nThe platform said:\n${all.slice(-lines).map((line) => `  ${line}`).join('\n')}`;
  } catch {
    return '';
  }
}

function describe(err: unknown): string {
  if (err instanceof OrgStartError) return err.message;
  // A platform error's `message` is written for a person; the code is what a script
  // or a model can act on (`already_bootstrapped`, `unauthorized`, ...).
  if (err instanceof PgError) return err.code === '' ? err.message : `${err.message} [${err.code}]`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
