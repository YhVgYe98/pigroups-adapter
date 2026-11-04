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

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultAdapterDir } from './datadir.ts';
import { PgClient, PgError } from './pgclient.ts';

export { defaultAdapterDir } from './datadir.ts';

/** What `<adapterDir>/org.json` records. `pid` is the process we started, not a promise it is still that process. */
export interface OrgState {
  url: string;
  token: string;
  admin_token: string;
  pid: number;
  data_dir: string;
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
const LOCK_FILE = 'org.lock';
const PLATFORM_ENTRY = join('src', 'main.ts');
const HEALTH_TIMEOUT_MS = 1200;
const START_TIMEOUT_MS = 6000;
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

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
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

  return withOrgLock(orgDir, () => startOrgLocked(opts, orgDir, orgFile, env));
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
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'org' : cleaned.slice(0, 64);
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
  // need the source tree at all.
  if (previous !== undefined) {
    if (await platformAnswers(previous.url)) {
      try {
        const root = await whoamiRoot(previous.url, previous.token);
        return {
          reattached: true,
          url: previous.url,
          token: previous.token,
          adminToken: previous.admin_token,
          pid: previous.pid,
          dataDir: previous.data_dir,
          orgFile,
          root,
        };
      } catch (err) {
        throw new OrgStartError(
          `the platform at ${previous.url} (pid ${previous.pid}) answers /v1/health, but the member ` +
            `token in ${orgFile} was rejected (${describe(err)}). Refusing to start a second ` +
            `organisation on top of it: that would leave the old one running with no session able ` +
            `to reach it.\n` +
            `Restore that platform's data, or stop pid ${previous.pid} and delete ${orgFile} to ` +
            `start a new organisation.`,
        );
      }
    }
    // The platform process is gone (a reboot, a killed process). Keep its data dir
    // and port so the same organisation comes back with the same URL and tokens.
    await stopRecordedProcess(previous, orgFile);
  }

  // (a) Find the checkout only when a platform actually has to be started.
  const checkout = findPlatformDir({ platformDir: opts.platformDir, env, adapterRoot: opts.adapterRoot });

  // (c) Start it: free port by default, the recorded port when this is a restart;
  // data under the adapter dir unless told otherwise; a fresh admin token unless
  // the old organisation had one (creating humans is the only use).
  let port = opts.port ?? portOf(previous?.url);
  if (port === undefined || !(await portIsFree(port))) {
    if (opts.port !== undefined) {
      throw new OrgStartError(
        `port ${opts.port} is already in use; the platform was not started. ` +
          `Pass a free port or drop the argument to let the tool choose one.`,
      );
    }
    // The recorded port may now belong to another service. Moving is safer than
    // spawning into EADDRINUSE and then reading health from the old process.
    port = await freePort();
  }
  const dataDir = resolve(opts.dataDir ?? previous?.data_dir ?? join(adapterDir, 'platform-data'));
  const adminToken = previous?.admin_token ?? randomBytes(24).toString('base64url');
  const url = `http://127.0.0.1:${port}`;

  const platform = launchPlatform({ platformDir: checkout.dir, port, dataDir, adminToken, env });
  const logFile = join(dataDir, 'platform.log');
  let tokenError: string | undefined;

  try {
    // (d) Wait bounded, then claim the root seat.
    await waitForPlatform(platform.child, url, opts.healthTimeoutMs ?? START_TIMEOUT_MS, opts.signal);

    if (previous !== undefined) {
      try {
        const root = await whoamiRoot(url, previous.token);
        const state: OrgState = {
          url,
          token: previous.token,
          admin_token: adminToken,
          pid: platform.pid,
          data_dir: dataDir,
        };
        writeOrgState(orgFile, state);
        return {
          reattached: true,
          url,
          token: state.token,
          adminToken,
          orgFile,
          pid: platform.pid,
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

    const created = await new PgClient({ url, token: adminToken }).bootstrap(
      opts.name === undefined ? {} : { name: opts.name },
    );
    const state: OrgState = {
      url,
      token: created.token,
      admin_token: adminToken,
      pid: platform.pid,
      data_dir: dataDir,
    };
    writeOrgState(orgFile, state);
    return {
      reattached: false,
      url,
      token: state.token,
      adminToken,
      orgFile,
      pid: platform.pid,
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
    throw new OrgStartError(
      `${detail}${rejected}\n` +
        `The platform process (pid ${platform.pid}) was stopped; its log may say why: ${logFile}`,
    );
  }
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
  if (
    typeof url !== 'string' ||
    typeof token !== 'string' ||
    typeof adminToken !== 'string' ||
    typeof pid !== 'number' ||
    typeof dataDir !== 'string'
  ) {
    throw new OrgStartError(
      `${file} does not look like an org record (need url, token, admin_token, pid, data_dir). ` +
        `Restore it or delete it to start a new one.`,
    );
  }
  return { url, token, admin_token: adminToken, pid, data_dir: dataDir };
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
 * removed, and one that has waited longer than `LOCK_WAIT_MS` is reported rather
 * than silently starting a second platform.
 */
async function withOrgLock<T>(adapterDir: string, work: () => Promise<T>): Promise<T> {
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
  port: number;
  dataDir: string;
  adminToken: string;
  env: NodeJS.ProcessEnv;
}): LaunchedPlatform {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const logFile = join(opts.dataDir, 'platform.log');
  const log = openSync(logFile, 'a', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [join(opts.platformDir, PLATFORM_ENTRY)], {
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...opts.env,
        PORT: String(opts.port),
        PIGROUPS_DATA: opts.dataDir,
        PIGROUPS_ADMIN_TOKEN: opts.adminToken,
      },
    });
  } finally {
    closeSync(log);
  }
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new OrgStartError(`could not start the platform from ${opts.platformDir}`);
  return { child, pid };
}

async function waitForPlatform(
  child: ChildProcess,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let exited = child.exitCode !== null || child.signalCode !== null;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted === true) throw new OrgStartError('cancelled while waiting for the platform to answer');
    if (exited) throw new OrgStartError(`the platform process at ${url} exited before answering`);
    if (await platformAnswers(url)) {
      // Something answered at the URL, and it may not be the child we just started
      // (an old process on the same port, a leftover from a previous run). If our
      // child has already died, recording its pid in org.json would make the next
      // session trust a process that does not exist.
      if (exited || child.exitCode !== null || child.signalCode !== null) {
        throw new OrgStartError(`the platform process at ${url} exited before answering`);
      }
      return;
    }
    if (Date.now() >= deadline) {
      throw new OrgStartError(`the platform at ${url} did not answer GET /v1/health within ${timeoutMs} ms`);
    }
    await sleep(50);
  }
}

/** Health is the platform's own word. A 404 from some other service is not a platform. */
async function platformAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/v1/health', url), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown; version?: unknown };
    return body.status === 'ok' && typeof body.version === 'string';
  } catch {
    return false;
  }
}

async function whoamiRoot(url: string, token: string): Promise<{ id: string; name: string }> {
  const who = await new PgClient({ url, token }).whoami();
  return { id: who.member.id, name: who.member.name };
}

/**
 * A recorded platform that does not answer health must not be replaced blindly:
 * starting a second process on the same SQLite data dir while the first is still
 * alive can corrupt it. Only a process we can identify as our platform (or a pid
 * that is already gone) is safe to clear.
 */
async function stopRecordedProcess(previous: OrgState, orgFile: string): Promise<void> {
  if (previous.pid <= 0 || !processExists(previous.pid)) return;
  if (!looksLikePlatformProcess(previous.pid, previous.data_dir)) {
    throw new OrgStartError(
      `${orgFile} records pid ${previous.pid}, which is still running, but ${previous.url} does not ` +
        `answer /v1/health. Refusing to start a second platform on ${previous.data_dir}; ` +
        `stop that process first, or delete ${orgFile} to start a new organisation.`,
    );
  }
  try {
    process.kill(previous.pid, 'SIGTERM');
  } catch (err) {
    throw new OrgStartError(`could not stop the unresponsive platform pid ${previous.pid}: ${describe(err)}`);
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (processExists(previous.pid) && Date.now() < deadline) await sleep(50);
  if (processExists(previous.pid)) {
    try {
      process.kill(previous.pid, 'SIGKILL');
    } catch {
      // Already gone between the check and the kill.
    }
  }
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Cross-check a recorded pid before signalling it: a recycled pid must never be
 * killed. Linux exposes the argv in /proc; elsewhere `ps` is the portable fallback.
 * An unreadable answer means "not proven", and the caller refuses to proceed.
 */
function looksLikePlatformProcess(pid: number, dataDir: string): boolean {
  let commandLine = '';
  try {
    commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    try {
      commandLine = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
    } catch {
      return false;
    }
  }
  if (!commandLine.includes('src/main.ts')) return false;
  // On Linux the environment pins the process to the recorded data dir, which a
  // recycled pid (or another org on this machine) would not match.
  try {
    const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    return environ.split('\0').includes(`PIGROUPS_DATA=${dataDir}`);
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.once('error', () => resolveFree(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolveFree(true)));
  });
}

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
