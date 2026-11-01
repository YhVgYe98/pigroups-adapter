// One adapter under test, wired to a real platform process and the fakes.
//
// The shape is the one `docs/设计说明.md` §2.3 pins: `new AdapterLoop({ pg, surface, herdr, config, now })`,
// driven by hand through `pollOnce()` / `flush()` / `tick()` so no test has to sleep on a policy timer.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdapterLoop, type LoopConfig } from '../src/loop.ts';
import { PgClient } from '../src/pgclient.ts';

import {
  FakeClock,
  FakeHerdr,
  FakeSurface,
  bootPlatform,
  bootstrapRoot,
  createMember,
  delay,
  dmId,
  groupId,
  poll,
  type ControlItem,
  type MemberRef,
  type Platform,
  within,
} from './support.ts';

export const DEFAULT_ATTENTION_TOOL_MS = 300_000;
export const DEFAULT_REMIND_WINDOW_MS = 300_000;
export const DEFAULT_NUDGE_MAX = 3;
/** 概念稿 §8.1: the production default. Tests close a window by moving the fake clock. */
export const DEFAULT_DELIVERY_WINDOW_MS = 60_000;

export interface LoopConfigOverrides {
  token?: string;
  adapterDir?: string;
  pollLimit?: number;
  /** Seconds. 0 in tests: `pollOnce()` then never blocks on a quiet platform. */
  pollWait?: number;
  attentionToolMs?: number;
  remindWindowMs?: number;
  nudgeMax?: number;
  deliveryWindowMs?: number;
}

/** A loop plus its fakes, all pointed at one platform and one member identity. */
export interface LoopHandle {
  surface: FakeSurface;
  herdr: FakeHerdr;
  clock: FakeClock;
  adapterDir: string;
  config: LoopConfig;
  pg: PgClient;
  loop: AdapterLoop;
  /** One poll + one flush: the minimal "the adapter looked" drive. */
  cycle(): Promise<void>;
  /** End the current turn, then flush whatever that released. */
  settle(error?: { message: string }): Promise<void>;
  /** Move the injected clock forward and run one timer scan. */
  timer(ms?: number): Promise<void>;
  stop(): Promise<void>;
}

export async function createLoop(
  platform: Platform,
  me: MemberRef,
  opts: LoopConfigOverrides = {},
): Promise<LoopHandle> {
  const surface = new FakeSurface();
  const herdr = new FakeHerdr();
  const clock = new FakeClock();
  const adapterDir = opts.adapterDir ?? (await mkdtemp(join(tmpdir(), 'pigroups-adapter-')));

  const config: LoopConfig = {
    url: platform.url,
    token: opts.token ?? me.token,
    adapterDir,
    pollLimit: opts.pollLimit ?? 20,
    pollWait: opts.pollWait ?? 0,
    attentionToolMs: opts.attentionToolMs ?? DEFAULT_ATTENTION_TOOL_MS,
    remindWindowMs: opts.remindWindowMs ?? DEFAULT_REMIND_WINDOW_MS,
    nudgeMax: opts.nudgeMax ?? DEFAULT_NUDGE_MAX,
    deliveryWindowMs: opts.deliveryWindowMs ?? DEFAULT_DELIVERY_WINDOW_MS,
    spawnCmd: 'pi',
  };
  const pg = new PgClient({ url: config.url, token: config.token });
  const loop = new AdapterLoop({ pg, surface, herdr, config, now: clock.now });

  return {
    surface,
    herdr,
    clock,
    adapterDir,
    config,
    pg,
    loop,
    async cycle() {
      await loop.pollOnce();
      await loop.flush();
    },
    async settle(error) {
      surface.settle(error);
      // Wait for the reaction itself, not a guessed delay: it now asks the platform
      // before it delivers, and a fixed sleep passes or fails depending on the machine.
      await loop.settled();
      await loop.flush();
    },
    async timer(ms) {
      // The default advance closes both the reminder window and the delivery window.
      clock.advance(ms ?? Math.max(config.remindWindowMs, config.deliveryWindowMs) + 1);
      loop.tick();
      // `tick()` starts the delivery itself when the window is due; this second call
      // is the single-flight merge, so the batch is done when the test continues.
      await delay(10);
      await loop.flush();
    },
    async stop() {
      // Not `Promise.race(loop.stop(), delay(2000))`: that turns a hung `stop()` into "2 seconds
      // elapsed" and the test passes. `within` fails instead, so a stop() that never resolves is red.
      await within(loop.stop(), 'loop.stop() to resolve');
    },
  };
}

export interface ScenarioOptions extends LoopConfigOverrides {
  /** `child` = the adapter runs as a member with a parent; `root` = it runs as the root. */
  role?: 'child' | 'root';
  name?: string;
  /** Extra children of the parent, created before the adapter starts (siblings and group peers). */
  siblings?: number;
}

export interface Scenario extends LoopHandle {
  platform: Platform;
  /** The identity the adapter runs as. */
  me: MemberRef;
  /** The member's parent, or `null` when the adapter runs as the root. */
  parent: MemberRef | null;
  /** Other children of `parent` (empty for the root role). */
  siblings: MemberRef[];
  /** The conversation id of the DM between the adapter and its parent (`''` for the root role). */
  dm: string;
  /** The conversation id of the group owned by `parent` (or by the adapter, for the root role). */
  group: string;
  /** Control items the adapter sent to its parent, consumed from the parent's queue. */
  controlsToParent(): Promise<ControlItem[]>;
  close(): Promise<void>;
}

export async function scenario(opts: ScenarioOptions = {}): Promise<Scenario> {
  const role = opts.role ?? 'child';
  const platform = await bootPlatform();
  const root = await bootstrapRoot(platform);

  let me: MemberRef;
  let parent: MemberRef | null = null;
  const siblings: MemberRef[] = [];

  if (role === 'root') {
    me = root;
  } else {
    parent = root;
    me = await createMember(platform, root, opts.name ?? 'member');
    for (let i = 0; i < (opts.siblings ?? 0); i += 1) {
      siblings.push(await createMember(platform, root, `sibling-${i}`));
    }
  }

  const handle = await createLoop(platform, me, opts);
  const s: Scenario = {
    platform,
    me,
    parent,
    siblings,
    dm: parent === null ? '' : dmId(me.id, parent.id),
    group: groupId(parent === null ? me.id : parent.id),
    ...handle,
    async controlsToParent(): Promise<ControlItem[]> {
      const who = parent ?? me;
      const polled = await poll(platform, who.token, { wait: 0, types: 'control' });
      return polled.items.filter((i): i is ControlItem => i.kind === 'control');
    },
    async close() {
      await handle.stop();
      await platform.stop();
      await rm(handle.adapterDir, { recursive: true, force: true });
    },
  };
  return s;
}

/** Control payloads the adapter sent, filtered by `cmd`. */
export function payloads(cmds: ControlItem[], cmd: string): Array<Record<string, any>> {
  return cmds
    .filter((c) => c.cmd === cmd)
    .map((c) => (typeof c.payload === 'object' && c.payload !== null ? (c.payload as Record<string, any>) : {}));
}

/**
 * Keep polling the member's own queue until a control item named `cmd` shows up.
 * Used against the parent's queue to observe what the adapter sent.
 */
export async function pollUntil(
  platform: Platform,
  token: string,
  cmd: string,
  timeoutMs = 3000,
): Promise<ControlItem> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const polled = await poll(platform, token, { wait: 0, types: 'control' });
    const hit = polled.items.find((i) => i.kind === 'control' && (i as ControlItem).cmd === cmd);
    if (hit !== undefined) return hit as ControlItem;
    await delay(20);
  }
  throw new Error(`no control item "${cmd}" arrived within ${timeoutMs}ms`);
}

/**
 * Drive the loop (`pollOnce` + `flush`) until `promise` settles.
 * For methods that wait on an inbound command (`inspect`), which only arrives through the poll stream.
 */
export async function driveUntil<T>(h: LoopHandle, promise: Promise<T>, timeoutMs = 5000): Promise<T> {
  const tracked = promise.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raced = await Promise.race([tracked, delay(0).then(() => null)]);
    if (raced !== null) {
      if (!raced.ok) throw raced.e;
      return raced.v;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms driving the loop`);
    await h.loop.pollOnce();
    await h.loop.flush();
    await delay(10);
  }
}
