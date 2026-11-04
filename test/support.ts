// Test support: a real PiGroups platform process, HTTP helpers over §10's endpoints,
// and the two fakes the loop is allowed to depend on (PiSurface, Herdr) plus a fake clock.
// Nothing here reads the adapter's implementation: shapes come from
// `docs/设计说明.md` §2/§4/§7 and `../PiGroups/docs/设计说明.md` §10.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { DeliverKind, PiEvent, PiSurface } from '../src/surface.ts';
import type { Herdr } from '../src/herdr.ts';

// ---------------------------------------------------------------------------
// Platform process
// ---------------------------------------------------------------------------

export interface Platform {
  url: string;
  port: number;
  adminToken: string;
  dataDir: string;
  stop(): Promise<void>;
}

export const ADMIN_TOKEN = 'test-admin-token';

const PLATFORM_DIR = resolve(
  process.env.PIGROUPS_PLATFORM_DIR ?? join(import.meta.dirname, '..', '..', 'PiGroups'),
);

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        rej(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => res(port));
    });
  });
}

/** Boot `node <PIGROUPS_PLATFORM_DIR>/src/main.ts` on a fresh data dir and a free port. */
export async function bootPlatform(): Promise<Platform> {
  const dataDir = await mkdtemp(join(tmpdir(), 'pigroups-'));
  const port = await freePort();
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(process.execPath, [join(PLATFORM_DIR, 'src', 'main.ts')], {
      env: { ...process.env, PORT: String(port), PIGROUPS_DATA: dataDir, PIGROUPS_ADMIN_TOKEN: ADMIN_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    await rm(dataDir, { recursive: true, force: true });
    throw err;
  }

  const exited = new Promise<void>((res) => child.once('exit', () => res()));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    stderr += d;
  });

  await new Promise<void>((res, rej) => {
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
      if (out.split('\n').some((line) => line.trim() === `listening on ${port}`)) res();
    });
    void exited.then(() => rej(new Error(`platform exited before listening\n${stderr}`)));
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    adminToken: ADMIN_TOKEN,
    dataDir,
    async stop() {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3000).then(() => child.kill('SIGKILL'))]);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP over ../PiGroups/docs/设计说明.md §10
// ---------------------------------------------------------------------------

export interface Res<T = any> {
  status: number;
  body: T;
}

export async function call<T = any>(
  platform: Platform,
  token: string | null,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Res<T>> {
  const res = await fetch(`${platform.url}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

export async function ok<T = any>(
  platform: Platform,
  token: string | null,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await call<T>(platform, token, method, path, body);
  if (res.status >= 300) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

export interface MemberRef {
  id: string;
  name: string;
  token: string;
}

/** `POST /v1/bootstrap` — the root member. */
export function bootstrapRoot(platform: Platform, name = 'root'): Promise<MemberRef> {
  return ok(platform, null, 'POST', '/v1/bootstrap', { name }).then((r) => ({
    id: r.member.id,
    name: r.member.name,
    token: r.token,
  }));
}

/** `POST /v1/members` — a child of `parent`, with its token. */
export async function createMember(platform: Platform, parent: MemberRef, name?: string): Promise<MemberRef> {
  const r = await ok(platform, parent.token, 'POST', '/v1/members', {
    request_id: crypto.randomUUID(),
    ...(name === undefined ? {} : { name }),
  });
  return { id: r.member.id, name: r.member.name, token: r.token };
}

/** `POST /v1/humans` — needs the admin token; the only way to read every control. */
export async function createHuman(platform: Platform, name = 'human'): Promise<{ id: string; token: string }> {
  const r = await ok(platform, platform.adminToken, 'POST', '/v1/humans', { name });
  return { id: r.human.id, token: r.token };
}

export interface SendResult {
  to: string;
  seq: number;
  recipients: string[];
}

/** `POST /v1/messages`. `to` is the write-side form: `g:<owner>` or a member id. */
export function send(
  platform: Platform,
  token: string,
  to: string,
  body: string,
  mentions?: string[],
): Promise<SendResult> {
  return ok(platform, token, 'POST', '/v1/messages', {
    to,
    body,
    ...(mentions === undefined ? {} : { mentions }),
    client_msg_id: crypto.randomUUID(),
  });
}

export interface HistoryItem {
  to: string;
  seq: number;
  sender_id: string;
  sender_kind: string;
  sender_name: string;
  body: string;
  meta: unknown;
  mentions: string[];
  created_at: number;
}

/** `GET /v1/messages?to=&before=&limit=`. */
export function history(
  platform: Platform,
  token: string,
  to: string,
  opts: { before?: number; limit?: number } = {},
): Promise<{ items: HistoryItem[]; next: number | null }> {
  const q = new URLSearchParams({ to });
  if (opts.before !== undefined) q.set('before', String(opts.before));
  if (opts.limit !== undefined) q.set('limit', String(opts.limit));
  return ok(platform, token, 'GET', `/v1/messages?${q}`);
}

/** `POST /v1/control` — the adapter's command channel (`pg.*` payloads are opaque to the platform). */
export function command(
  platform: Platform,
  token: string,
  to: string | string[],
  cmd: string,
  payload?: unknown,
): Promise<{ control_seq: number; receipts: Array<{ to_id: string; state: string }> }> {
  return ok(platform, token, 'POST', '/v1/control', {
    to,
    id: crypto.randomUUID(),
    cmd,
    ...(payload === undefined ? {} : { payload }),
  });
}

export interface ControlItem {
  kind: 'control';
  control_seq: number;
  id: string;
  from_id: string;
  cmd: string;
  payload: unknown;
  reply_to: string | null;
  created_at: number;
}

export interface PolledItems {
  items: Array<ControlItem | { kind: 'gap' } | { kind: 'message'; to: string; seq: number; from_id: string; from_name: string; mentions_me: boolean; from_parent: boolean }>;
  control_pending: number;
}

/** `GET /v1/poll` — consumes. Only ever called by the test's own identities (parent, watcher). */
export function poll(platform: Platform, token: string, opts: { wait?: number; types?: string } = {}): Promise<PolledItems> {
  const q = new URLSearchParams({ wait: String(opts.wait ?? 0) });
  if (opts.types !== undefined) q.set('types', opts.types);
  return ok(platform, token, 'GET', `/v1/poll?${q}`);
}

/** `GET /v1/control?all=true` as a human — every control ever sent, with `cmd` and `payload`. */
export function allControls(
  platform: Platform,
  humanToken: string,
  opts: { since?: number; from_id?: string; to?: string } = {},
): Promise<{ items: Array<{ seq: number; id: string; from_id: string; to: string; cmd: string; payload: unknown; receipts: Array<{ to_id: string; state: string }> }>; next: number | null }> {
  const q = new URLSearchParams({ all: 'true' });
  if (opts.since !== undefined) q.set('since', String(opts.since));
  if (opts.from_id !== undefined) q.set('from_id', opts.from_id);
  if (opts.to !== undefined) q.set('to', opts.to);
  return ok(platform, humanToken, 'GET', `/v1/control?${q}`);
}

export interface MemberDetail {
  id: string;
  name: string;
  parent_id: string | null;
  status: string;
  is_root: boolean;
  child_count: number;
  groups: Array<{ to: string; owner: string }>;
  last_seen_at: number | null;
  created_at: number;
}

/** `GET /v1/members/{id}`. */
export function member(platform: Platform, token: string, id: string): Promise<MemberDetail> {
  return ok(platform, token, 'GET', `/v1/members/${id}`);
}

/** `GET /v1/whoami`. */
export function whoami(platform: Platform, token: string): Promise<any> {
  return ok(platform, token, 'GET', '/v1/whoami');
}

/** `DELETE /v1/members/{id}` — the parent's structural power; causes `sys.terminated`. */
export function removeMember(platform: Platform, token: string, id: string): Promise<{ terminated: string[] }> {
  return ok(platform, token, 'DELETE', `/v1/members/${id}`);
}

/** The conversation id of the DM between two identities (§3.4). */
export function dmId(a: string, b: string): string {
  return `dm:${[a, b].sort().join('_')}`;
}

/** The group owned by `owner` (§3.3). */
export function groupId(owner: string): string {
  return `g:${owner}`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Resolve as soon as `predicate` holds, else throw with `what` after `timeoutMs`.
 * Used instead of fixed sleeps wherever the adapter's own async loop is the producer.
 */
export async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await delay(10);
  }
}

/** Give the adapter's loops time to (wrongly) act: used only for "nothing must happen" assertions. */
export function quiet(ms = 400): Promise<void> {
  return delay(ms);
}

/**
 * Await `promise`, but fail with `what` instead of letting the whole run hang.
 * Used where the promise is the thing under test (`stop()` must resolve): a hang is a red,
 * not a timeout and not a silent pass.
 */
export async function within<T>(promise: Promise<T>, what: string, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${timeoutMs}ms: ${what}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A clock the test moves by hand, injected as the loop's `now`. */
export class FakeClock {
  #ms: number;
  constructor(start = 1_730_000_000_000) {
    this.#ms = start;
  }
  now = (): number => this.#ms;
  advance(ms: number): void {
    this.#ms += ms;
  }
  set(ms: number): void {
    this.#ms = ms;
  }
}

// ---------------------------------------------------------------------------
// Fake PiSurface — docs/设计说明.md §2.1
// ---------------------------------------------------------------------------

// `DeliverKind` and `PiEvent` are imported from `src/surface.ts`, never re-declared here:
// a union widened in `src` must reach this fake, otherwise the fake keeps compiling against
// the old shape and the test suite would not see the new member at all.
export type { DeliverKind, PiEvent };

export interface Delivery {
  text: string;
  kind: DeliverKind;
  at: number;
}

/**
 * Records every `deliver` (text + kind) and every `abort`. The test owns the turn lifecycle:
 * `deliver` marks the surface busy, `settle()` ends the turn and fires the `onSettled` callbacks.
 */
export class FakeSurface implements PiSurface {
  readonly deliveries: Delivery[] = [];
  readonly aborts: number[] = [];
  readonly shutdowns: string[] = [];
  readonly settles: number[] = [];
  /** Every surface call in order, so a test can assert the termination sequence. */
  readonly lifecycle: Array<'deliver' | 'abort' | 'shutdown'> = [];
  readonly #settledCallbacks = new Set<() => void>();
  readonly #eventCallbacks = new Set<(e: PiEvent) => void>();
  readonly events: PiEvent[] = [];
  readonly #held: Array<() => void> = [];
  #busy = false;
  /** What the surface would report for `lastAssistantText()` (概念稿 §8.5). */
  lastText: string | undefined;
  /** When set, `deliver` stays pending until `releaseDeliveries()` (simulates a turn that never commits). */
  holdDeliveries = false;
  /** When set, `abort` stays pending until the returned resolver is called. */
  holdAbort = false;
  #releaseAbort: (() => void) | null = null;

  isBusy(): boolean {
    return this.#busy;
  }

  lastAssistantText(): string | undefined {
    return this.lastText;
  }

  onSettled(cb: () => void): () => void {
    this.#settledCallbacks.add(cb);
    return () => {
      this.#settledCallbacks.delete(cb);
    };
  }

  onEvent(cb: (e: PiEvent) => void): () => void {
    this.#eventCallbacks.add(cb);
    return () => {
      this.#eventCallbacks.delete(cb);
    };
  }

  /** Push one `PiEvent` into the adapter, the way the real surface relays pi's events. */
  emit(event: PiEvent): void {
    this.events.push(event);
    for (const cb of [...this.#eventCallbacks]) cb(event);
  }

  async deliver(text: string, kind: DeliverKind): Promise<void> {
    this.#busy = true;
    this.lifecycle.push('deliver');
    this.deliveries.push({ text, kind, at: Date.now() });
    if (this.holdDeliveries) {
      await new Promise<void>((res) => this.#held.push(res));
    }
  }

  async abort(): Promise<void> {
    this.lifecycle.push('abort');
    this.aborts.push(Date.now());
    this.#busy = false;
    if (this.holdAbort) {
      await new Promise<void>((res) => {
        this.#releaseAbort = res;
      });
    }
  }

  shutdown(reason: string): void {
    this.lifecycle.push('shutdown');
    this.shutdowns.push(reason);
  }

  /** Test-controlled turn end: idle + `turn_end` + `onSettled` fired. */
  settle(error?: { message: string }): void {
    this.#busy = false;
    this.settles.push(Date.now());
    this.emit(error === undefined ? { type: 'turn_end' } : { type: 'turn_end', error });
    for (const cb of [...this.#settledCallbacks]) cb();
  }

  /**
   * The turn was cut: what pi does on an abort (`agent_settled aborted:true`, no
   * `agent_before_settle`). The loop must requeue the batch it delivered into it.
   */
  settleAborted(): void {
    this.#busy = false;
    this.settles.push(Date.now());
    this.emit({ type: 'turn_end', error: { message: 'turn ended: aborted' }, aborted: true });
    for (const cb of [...this.#settledCallbacks]) cb();
  }

  /** Start a turn without going through the adapter (e.g. the member is already thinking). */
  beginTurn(): void {
    this.#busy = true;
  }

  releaseDeliveries(): void {
    for (const res of this.#held.splice(0)) res();
  }

  releaseAbort(): void {
    const res = this.#releaseAbort;
    this.#releaseAbort = null;
    res?.();
  }

  get heldCount(): number {
    return this.#held.length;
  }

  /** All delivered texts, in delivery order. */
  texts(): string[] {
    return this.deliveries.map((d) => d.text);
  }

  textsOfKind(kind: DeliverKind): string[] {
    return this.deliveries.filter((d) => d.kind === kind).map((d) => d.text);
  }

  /** Forget every delivery so far; returns the mark for `since()`. */
  mark(): number {
    return this.deliveries.length;
  }

  since(mark: number): Delivery[] {
    return this.deliveries.slice(mark);
  }
}

/** `Promise<void>` surface for fakes that don't need to be awaited by type. */
export type PiSurfaceLike = FakeSurface;

// ---------------------------------------------------------------------------
// Fake Herdr — docs/设计说明.md §2.2
// ---------------------------------------------------------------------------

export interface SpawnRecord {
  label: string;
  env: Record<string, string>;
  cwd?: string;
  args?: string[];
}

export class FakeHerdr implements Herdr {
  readonly spawns: SpawnRecord[] = [];
  readonly waits: Array<{ pane: string; timeoutMs: number }> = [];
  /** Panes close() actually returned successfully for. */
  readonly closed: string[] = [];
  readonly reads: Array<{ pane: string; lines: number }> = [];
  paneText = '';
  /** When set, `waitReady` rejects after recording the call (the timeout path). */
  failWait = false;
  /** False simulates a child that never reaches the platform (D1 never satisfied). */
  authenticate = true;
  /** When set, `close` rejects with this after recording the attempt (herdr down / a timeout). */
  failClose: Error | undefined;
  /** When set, `spawn` records the attempt and then rejects with this (herdr down / shell not ready). */
  failSpawn: Error | undefined;
  /** Runs after the attempt is recorded and before it returns, so a test can inspect the lock. */
  onSpawn: ((opts: { label: string; env: Record<string, string>; cwd?: string; args?: string[] }) => Promise<void> | void) | undefined;
  /** When set, `close` reports that it cut off an agent still running at the bound. */
  forceClose = false;
  /** Runs before a close is recorded: lets a test read platform state at that exact moment. */
  onClose: ((pane: string) => Promise<void> | void) | undefined;

  async spawn(opts: { label: string; env: Record<string, string>; cwd?: string; args?: string[] }): Promise<{ pane: string }> {
    this.spawns.push(opts);
    if (this.failSpawn !== undefined) throw this.failSpawn;
    if (this.onSpawn !== undefined) await this.onSpawn(opts);
    // A real child's first act is one authenticated request, and that is what D1 waits for
    // (the platform's `last_seen_at`). A fake that only returns a pane name leaves the member
    // permanently unseen, which is not a shape that happens outside the tests.
    const url = opts.env.PIGROUPS_URL;
    const token = opts.env.PIGROUPS_TOKEN;
    if (this.authenticate && url !== undefined && token !== undefined) {
      void fetch(`${url}/v1/whoami`, { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
    }
    return { pane: `pane-${this.spawns.length}` };
  }

  async waitReady(pane: string, timeoutMs: number): Promise<void> {
    this.waits.push({ pane, timeoutMs });
    if (this.failWait) throw new Error(`pane ${pane} not ready after ${timeoutMs}ms`);
  }

  async read(pane: string, lines: number): Promise<string> {
    this.reads.push({ pane, lines });
    return this.paneText;
  }

  async close(pane: string): Promise<{ forced: boolean }> {
    if (this.onClose !== undefined) await this.onClose(pane);
    if (this.failClose !== undefined) throw this.failClose;
    this.closed.push(pane);
    return { forced: this.forceClose };
  }
}
