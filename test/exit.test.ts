// §8.6 (0.13.0): a graceful exit sends nothing. The heartbeat stops, and the parent
// observes the absence on its next liveness check. There is no `gone` attention and no
// `pg.report`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pigroupsExtension from '../src/extension.ts';
import type { PiLike, PiToolDefinition } from '../src/surface.ts';

import { bootPlatform, bootstrapRoot, createMember, delay, poll } from './support.ts';

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface FakePi {
  pi: PiLike;
  tools: Map<string, PiToolDefinition>;
  fire(event: string, payload?: unknown, ctx?: unknown): Promise<void>;
}

function fakePi(): FakePi {
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

test('session_shutdown sends no exit message: the heartbeat stopping is the signal', async () => {
  const platform = await bootPlatform();
  const adapterDir = await mkdtemp(join(tmpdir(), 'pigroups-exit-'));
  const saved = {
    url: process.env.PIGROUPS_URL,
    token: process.env.PIGROUPS_TOKEN,
    dir: process.env.PIGROUPS_ADAPTER_DIR,
    wait: process.env.PIGROUPS_POLL_WAIT,
  };
  const fake = fakePi();
  try {
    const parent = await bootstrapRoot(platform, 'root');
    const me = await createMember(platform, parent, 'leaver');
    process.env.PIGROUPS_URL = platform.url;
    process.env.PIGROUPS_TOKEN = me.token;
    process.env.PIGROUPS_ADAPTER_DIR = adapterDir;
    process.env.PIGROUPS_POLL_WAIT = '0';

    pigroupsExtension(fake.pi);
    await fake.fire('session_start', { reason: 'startup' }, CTX);
    // Wait for the startup handshake: the tools answer only once the loop knows who it is.
    const children = fake.tools.get('pg_children');
    assert.ok(children, 'the member tools are registered');
    await children.execute('call-1', {}, undefined, undefined, CTX);

    await fake.fire('session_shutdown', { reason: 'quit' }, CTX);
    await delay(100);

    const polled = await poll(platform, parent.token, { wait: 0, types: 'control' });
    assert.equal(
      polled.items.filter((item) => item.kind === 'control').length,
      0,
      `a graceful exit sends no control at all: ${JSON.stringify(polled.items)}`,
    );
  } finally {
    await fake.fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
    await platform.stop();
    await rm(adapterDir, { recursive: true, force: true });
    for (const [name, value] of [
      ['PIGROUPS_URL', saved.url],
      ['PIGROUPS_TOKEN', saved.token],
      ['PIGROUPS_ADAPTER_DIR', saved.dir],
      ['PIGROUPS_POLL_WAIT', saved.wait],
    ] as Array<[string, string | undefined]>) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
