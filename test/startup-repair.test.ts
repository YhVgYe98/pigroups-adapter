// Two "the adapter silently does nothing" failures:
//
// A. `session_tree` invalidates the pi context captured at `session_start`. The
//    extension must attach the fresh one and repair a startup that never finished.
// B. A failing startup courtesy must be reported and must not keep the member from
//    becoming ready or from running the respawn repair.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pigroupsExtension from '../src/extension.ts';
import { writeChildRecord, writeMemberSessionFile } from '../src/records.ts';
import type { ChildRecord } from '../src/records.ts';
import { PiSurfaceAdapter } from '../src/surface.ts';
import type { PiContext, PiLike, PiMessage, PiToolDefinition } from '../src/surface.ts';

import { scenario } from './scenario.ts';
import type { Scenario } from './scenario.ts';
import {
  bootPlatform,
  bootstrapRoot,
  createMember,
  dmId,
  quiet,
  send,
  waitFor,
} from './support.ts';
import type { MemberRef, Platform } from './support.ts';

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface FakePi {
  pi: PiLike;
  tools: Map<string, PiToolDefinition>;
  /** Every `pi.sendMessage` call, in delivery order. */
  sent: PiMessage[];
  fire(event: string, payload?: unknown, ctx?: unknown): Promise<void>;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, PiToolDefinition>();
  const sent: PiMessage[] = [];
  const pi = {
    sendMessage(message: PiMessage): void {
      sent.push(message);
    },
    registerTool(tool: PiToolDefinition): void {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: Handler): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
  } as unknown as PiLike;
  return {
    pi,
    tools,
    sent,
    async fire(event, payload, ctx): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

function ctx(label: string, calls: string[]): PiContext {
  return {
    isIdle: () => true,
    abort: () => calls.push(`${label}:abort`),
    shutdown: () => calls.push(`${label}:shutdown`),
  };
}

interface ExtensionHandle {
  platform: Platform;
  parent: MemberRef;
  me: MemberRef;
  fake: FakePi;
  /** Every context handed to a PiSurfaceAdapter, in attach order. */
  attached: PiContext[];
  dm: string;
  close(): Promise<void>;
}

async function extensionSession(
  t: { after(fn: () => Promise<void> | void): void },
): Promise<ExtensionHandle> {
  const platform = await bootPlatform();
  const parent = await bootstrapRoot(platform);
  const me = await createMember(platform, parent, 'tree-member');
  const adapterDir = await mkdtemp(join(tmpdir(), 'pigroups-tree-'));

  const saved = {
    url: process.env.PIGROUPS_URL,
    token: process.env.PIGROUPS_TOKEN,
    dir: process.env.PIGROUPS_ADAPTER_DIR,
    wait: process.env.PIGROUPS_POLL_WAIT,
    window: process.env.PIGROUPS_DELIVERY_WINDOW_MS,
    autoRespawn: process.env.PIGROUPS_AUTO_RESPAWN,
  };
  process.env.PIGROUPS_URL = platform.url;
  process.env.PIGROUPS_TOKEN = me.token;
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;
  process.env.PIGROUPS_POLL_WAIT = '0';
  process.env.PIGROUPS_DELIVERY_WINDOW_MS = '0';
  process.env.PIGROUPS_AUTO_RESPAWN = '0';

  const attached: PiContext[] = [];
  const originalAttach = PiSurfaceAdapter.prototype.attachContext;
  PiSurfaceAdapter.prototype.attachContext = function attach(ctx: PiContext): void {
    attached.push(ctx);
    originalAttach.call(this, ctx);
  };

  const fake = fakePi();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await fake.fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
    } finally {
      PiSurfaceAdapter.prototype.attachContext = originalAttach;
      await platform.stop();
      await rm(adapterDir, { recursive: true, force: true });
      for (const [name, value] of [
        ['PIGROUPS_URL', saved.url],
        ['PIGROUPS_TOKEN', saved.token],
        ['PIGROUPS_ADAPTER_DIR', saved.dir],
        ['PIGROUPS_POLL_WAIT', saved.wait],
        ['PIGROUPS_DELIVERY_WINDOW_MS', saved.window],
        ['PIGROUPS_AUTO_RESPAWN', saved.autoRespawn],
      ] as Array<[string, string | undefined]>) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };
  t.after(close);

  pigroupsExtension(fake.pi);
  return { platform, parent, me, fake, attached, dm: dmId(me.id, parent.id), close };
}

async function callTool(fake: FakePi, name: string, ctx: PiContext): Promise<unknown> {
  const tool = fake.tools.get(name);
  assert.ok(tool, `the extension must register ${name}`);
  const result = await tool.execute('call-1', {}, undefined, undefined, ctx);
  return JSON.parse(result.content[0]!.text);
}

test('a session_tree reattaches the fresh pi context and the loop still delivers', async (t) => {
  const h = await extensionSession(t);
  const first = ctx('first', []);
  const second = ctx('second', []);

  await h.fake.fire('session_start', { reason: 'startup' }, first);
  await callTool(h.fake, 'pg_children', second); // startup finished: identity + records exist
  assert.equal(h.attached.at(-1), first);

  const sentToFirst = h.fake.sent.length;
  await h.fake.fire('session_tree', { newLeafId: 'leaf-2', oldLeafId: 'leaf-1' }, second);

  assert.equal(h.attached.at(-1), second, 'the jump must hand the surface the fresh context');

  const body = 'delivered after the tree jump';
  await send(h.platform, h.parent.token, h.me.id, body);
  await waitFor(
    () => h.fake.sent.slice(sentToFirst).some((message) => message.content.includes(body)),
    'a delivery after the jump to reach pi',
  );
  assert.equal(
    h.attached.at(-1),
    second,
    'a later delivery must not switch the surface back to the invalidated context',
  );
});

test('a second session_tree does not inject the startup brief twice', async (t) => {
  const h = await extensionSession(t);
  const first = ctx('first', []);
  const second = ctx('second', []);
  const third = ctx('third', []);
  const brief = 'the task book, injected exactly once';
  const queued = await send(h.platform, h.parent.token, h.me.id, brief);

  await h.fake.fire('session_start', { reason: 'startup' }, first);
  await waitFor(
    () => h.fake.sent.some((message) => message.content.includes(`[${h.dm}#${queued.seq} `)),
    'the startup brief to be injected',
  );
  const briefs = (): number =>
    h.fake.sent.filter((message) => message.content.includes(`[${h.dm}#${queued.seq} `)).length;
  assert.equal(briefs(), 1, 'precondition: the brief reached the context once');

  await h.fake.fire('session_tree', { newLeafId: 'leaf-2', oldLeafId: 'leaf-1' }, second);
  await h.fake.fire('session_tree', { newLeafId: 'leaf-1', oldLeafId: 'leaf-2' }, third);
  await quiet(200);

  assert.equal(h.attached.at(-1), third, 'every jump must attach its own fresh context');
  assert.equal(briefs(), 1, 'the injection watermark must keep the re-run from repeating the brief');
});

function recordFor(s: Scenario, child: MemberRef): ChildRecord {
  return {
    parentId: s.me.id,
    childId: child.id,
    name: child.name,
    cwd: '/tmp/startup-repair-child',
    args: [],
    token: child.token,
    intent: 'spawned',
  };
}

async function childToRepair(s: Scenario, name: string): Promise<MemberRef> {
  const child = await createMember(s.platform, s.me, name);
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, `/tmp/pigroups-startup-repair/${child.id}.jsonl`);
  return child;
}

function captureWarnings(t: { after(fn: () => void): void }): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = original;
  });
  return warnings;
}

test('a failing brief warns once, still becomes ready, and still respawns', async (t) => {
  const s = await scenario({ role: 'child', autoRespawn: true, respawnGraceMs: 0 });
  t.after(() => s.close());
  const child = await childToRepair(s, 'brief-failure-child');

  const original = s.pg.messages.bind(s.pg);
  s.pg.messages = async (input) => {
    if (input.to === s.dm) throw new Error('parent DM history is unavailable');
    return original(input);
  };
  t.after(() => {
    s.pg.messages = original;
  });

  const warnings = captureWarnings(t);
  s.loop.start();
  await waitFor(() => s.herdr.spawns.length === 1, 'automatic respawn to start the recorded child');
  assert.deepEqual(
    s.herdr.spawns[0]!.args,
    ['--session', `/tmp/pigroups-startup-repair/${child.id}.jsonl`],
    'the child was really opened, not skipped',
  );
  await quiet(100);

  const briefWarnings = warnings.filter((warning) => /injectBrief/.test(warning));
  assert.equal(briefWarnings.length, 1, `exactly one warning must name the step: ${JSON.stringify(warnings)}`);
  assert.match(briefWarnings[0]!, /parent DM history is unavailable/, 'the warning names the error');
  assert.equal(
    warnings.some((warning) => /poll failed/.test(warning)),
    false,
    'the courtesy failure must not reach run() as a poll error',
  );
});

test('a failing reconciliation warns once, still becomes ready, and still respawns', async (t) => {
  const s = await scenario({ role: 'child', siblings: 1, autoRespawn: true, respawnGraceMs: 0 });
  t.after(() => s.close());
  const sibling = s.siblings[0]!;
  const peerDm = dmId(s.me.id, sibling.id);
  await send(s.platform, sibling.token, s.me.id, 'a debt discovered only by reconciliation');
  const child = await childToRepair(s, 'reconcile-failure-child');

  const original = s.pg.messages.bind(s.pg);
  s.pg.messages = async (input) => {
    if (input.to === peerDm) throw new Error('peer DM history is unavailable');
    return original(input);
  };
  t.after(() => {
    s.pg.messages = original;
  });

  const warnings = captureWarnings(t);
  s.loop.start();
  await waitFor(() => s.herdr.spawns.length === 1, 'automatic respawn to start the recorded child');
  assert.deepEqual(
    s.herdr.spawns[0]!.args,
    ['--session', `/tmp/pigroups-startup-repair/${child.id}.jsonl`],
    'the child was really opened, not skipped',
  );
  await quiet(100);

  const reconcileWarnings = warnings.filter((warning) => /reconcileObligations/.test(warning));
  assert.equal(
    reconcileWarnings.length,
    1,
    `exactly one warning must name the step: ${JSON.stringify(warnings)}`,
  );
  assert.match(reconcileWarnings[0]!, /peer DM history is unavailable/, 'the warning names the error');
  assert.equal(
    warnings.some((warning) => /poll failed/.test(warning)),
    false,
    'the courtesy failure must not reach run() as a poll error',
  );
  assert.deepEqual(s.loop.state().owed, [], 'a failed reconciliation leaves the ledger for the next start');
});
