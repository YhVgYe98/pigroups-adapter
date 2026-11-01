// 概念稿 §7: the tool surface is the whole of what the model can do. This file pins
// the ten tools and the two things the spec says about their text: there is no
// `pg_steer`, and `pg_members` must say what `last_seen_at` is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pigroupsExtension from '../src/extension.ts';
import type { PiLike, PiToolDefinition } from '../src/surface.ts';

import { bootPlatform, bootstrapRoot } from './support.ts';

type Handler = (event: unknown, ctx?: unknown) => unknown;

function fakePi(): { pi: PiLike; tools: Map<string, PiToolDefinition>; fire(event: string, payload?: unknown, ctx?: unknown): Promise<void> } {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, PiToolDefinition>();
  const pi = {
    sendMessage(): void {},
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
    async fire(event, payload, ctx): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
  };
}

const CTX = { isIdle: () => true, abort: () => undefined, shutdown: () => undefined };

test('the registered tool surface is exactly the ten tools, with no pg_steer', async () => {
  const platform = await bootPlatform();
  const adapterDir = await mkdtemp(join(tmpdir(), 'pigroups-toolsurface-'));
  const saved = {
    url: process.env.PIGROUPS_URL,
    token: process.env.PIGROUPS_TOKEN,
    dir: process.env.PIGROUPS_ADAPTER_DIR,
    wait: process.env.PIGROUPS_POLL_WAIT,
  };
  const { pi, tools, fire } = fakePi();
  try {
    const me = await bootstrapRoot(platform);
    process.env.PIGROUPS_URL = platform.url;
    process.env.PIGROUPS_TOKEN = me.token;
    process.env.PIGROUPS_ADAPTER_DIR = adapterDir;
    process.env.PIGROUPS_POLL_WAIT = '0';

    pigroupsExtension(pi);
    await fire('session_start', { reason: 'startup' }, CTX);

    assert.deepEqual(
      [...tools.keys()].sort(),
      ['pg_abort', 'pg_children', 'pg_inspect', 'pg_members', 'pg_read', 'pg_say', 'pg_schedule', 'pg_spawn', 'pg_terminate', 'pg_whoami'],
      '概念稿 §7: ten tools, and steering is pg_say + pg_abort, never a pg_steer',
    );
    assert.equal(tools.has('pg_steer'), false, 'pg_steer is gone: only pg_abort can change a member inside a tool');

    const members = tools.get('pg_members')!;
    assert.match(members.description, /last_seen_at/i, 'the roster tool must explain the one surprising field');
    assert.match(members.description, /authenticated/i, 'last_seen_at is "the last time that member authenticated"');
    assert.match(members.description, /not liveness/i, 'and it must say it is not a heartbeat');
    assert.match(members.description, /case-insensitive/i, 'query is a case-insensitive name search');

    const schedule = tools.get('pg_schedule')!;
    assert.match(schedule.description, /one-shot|once/i, 'a wake is one-shot');
    assert.match(schedule.description, /In memory only/i, 'a restart drops pending wakes');
    assert.match(schedule.description, /at least 5|5 s/i, 'the lower bound is stated');
    assert.match(schedule.description, /24 h|24 hours/i, 'the upper bound is stated');
    assert.match(schedule.description, /delivery window/i, 'a wake does not bypass the window');
    assert.deepEqual(
      (schedule.parameters as { required: string[] }).required,
      ['after_seconds', 'note'],
      'the tool takes the delay and the note, nothing else',
    );

  } finally {
    // Even when an assertion above failed, stop the loop before the platform: a live
    // adapter keeps polling a dead platform and turns a red test into a hung file.
    await fire('session_shutdown', { reason: 'quit' });
    await platform.stop();
    await rm(adapterDir, { recursive: true, force: true });
    const entries: Array<[string, string | undefined]> = [
      ['PIGROUPS_URL', saved.url],
      ['PIGROUPS_TOKEN', saved.token],
      ['PIGROUPS_ADAPTER_DIR', saved.dir],
      ['PIGROUPS_POLL_WAIT', saved.wait],
    ];
    for (const [name, value] of entries) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
