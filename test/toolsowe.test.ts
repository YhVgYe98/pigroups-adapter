// §4.3 through the *tool* surface: `pg_ack` and `pg_read` are what the model actually
// calls, so the argument normalisation and the wiring to the loop matter as much as the
// loop methods themselves. `pg_ack` with a `conv` the model forgot used to arrive here as
// the string "undefined", which the loop took for a conversation id and answered with a
// cheerful `{cleared: []}`; `all: "true"` (a string) degraded to a single-conversation
// ack; and `pg_read` read history without telling the ledger, leaving the documented
// "read it first, then ack" exit closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pigroupsExtension from '../src/extension.ts';
import type { PiLike, PiToolDefinition } from '../src/surface.ts';

import { bootPlatform, bootstrapRoot, createMember, groupId, send } from './support.ts';

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

/** Run the real tool and return its parsed JSON answer. */
async function callTool(fake: FakePi, name: string, params: Record<string, unknown> = {}): Promise<any> {
  const tool = fake.tools.get(name);
  assert.ok(tool, `the extension must register ${name}`);
  const result = await tool.execute('call-1', params, undefined, undefined, CTX);
  const body = result.content[0]?.text;
  assert.equal(typeof body, 'string', `${name} answers text`);
  return JSON.parse(body as string);
}

async function rawToolText(fake: FakePi, name: string, params: Record<string, unknown> = {}): Promise<string> {
  const tool = fake.tools.get(name);
  assert.ok(tool, `the extension must register ${name}`);
  const result = await tool.execute('call-1', params, undefined, undefined, CTX);
  const body = result.content[0]?.text;
  assert.equal(typeof body, 'string', `${name} answers text`);
  return body;
}

test('pg_ack and pg_read behave the same through the tool layer as in the loop', async (t) => {
  const platform = await bootPlatform();
  const adapterDir = await mkdtemp(join(tmpdir(), 'pigroups-toolsowe-'));
  const saved = {
    url: process.env.PIGROUPS_URL,
    token: process.env.PIGROUPS_TOKEN,
    dir: process.env.PIGROUPS_ADAPTER_DIR,
    wait: process.env.PIGROUPS_POLL_WAIT,
  };
  const fake = fakePi();
  try {
    const me = await bootstrapRoot(platform);
    // A group is `{owner} ∪ its children`, so the group exists only once there is a child.
    await createMember(platform, me, 'peer');
    // A ledger with two owed group conversations, as an earlier process would have left it:
    // no delivery is needed to make `pg_ack` do something, and a group debt is never pruned
    // by the startup roster check.
    const one = groupId(me.id);
    const two = 'g:somebody-else';
    await mkdir(join(adapterDir, 'owed'), { recursive: true });
    await writeFile(
      join(adapterDir, 'owed', `${me.id}.json`),
      JSON.stringify({ owed: { [one]: { seq: 1, since: 0 }, [two]: { seq: 2, since: 0 } }, acks: [] }),
      'utf8',
    );
    // Three messages in the group, so `pg_read` can hand back a seq past what the ledger knows.
    for (let i = 0; i < 3; i += 1) await send(platform, me.token, one, `group line ${i}`);

    process.env.PIGROUPS_URL = platform.url;
    process.env.PIGROUPS_TOKEN = me.token;
    process.env.PIGROUPS_ADAPTER_DIR = adapterDir;
    process.env.PIGROUPS_POLL_WAIT = '0';

    pigroupsExtension(fake.pi);
    await fake.fire('session_start', { reason: 'startup' }, CTX);
    // The first poll initialises the ledger; `pg_children` waits for that.
    await callTool(fake, 'pg_children');

    // `conv` is required (§4.3). A tool layer that turns a missing value into the string
    // "undefined" answers `{cleared: []}` instead of refusing, which looks like success.
    await assert.rejects(
      () => callTool(fake, 'pg_ack', {}),
      /conv is required/,
      'a missing conv must be refused, not normalised into a conversation called "undefined"',
    );

    // Before the read, the newest seq is not confirmable — and the error names the exit.
    await assert.rejects(
      () => callTool(fake, 'pg_ack', { conv: one, seq: 3 }),
      /never named or delivered in .*call pg_read/,
      'precondition: nothing has shown this adapter seq 3 yet',
    );

    const read = await rawToolText(fake, 'pg_read', { conv: one });
    assert.match(read, new RegExp(`\\[${one}#3\\] root: group line 2`), `pg_read returns the history: ${read}`);

    const acked = await callTool(fake, 'pg_ack', { conv: one, seq: 3 });
    assert.deepEqual(
      acked.cleared.map((entry: { conv: string }) => entry.conv),
      [one],
      'the tool read widened what the tool ack may confirm',
    );

    // `all` only clears everything when it is the boolean `true`; the string "true" is not
    // a silent wipe of every debt.
    const stringAll = await callTool(fake, 'pg_ack', { conv: one, all: 'true' });
    assert.deepEqual(stringAll.cleared, [], 'nothing is owed in that conversation any more');
    assert.deepEqual(
      stringAll.remaining.map((entry: { conv: string }) => entry.conv),
      [two],
      'all:"true" must not be read as all:true',
    );

    const booleanAll = await callTool(fake, 'pg_ack', { conv: one, all: true });
    assert.deepEqual(
      booleanAll.cleared.map((entry: { conv: string }) => entry.conv),
      [two],
      'the explicit boolean clears what is left',
    );
    assert.deepEqual(booleanAll.remaining, []);
  } finally {
    await fake.fire('session_shutdown', { reason: 'quit' });
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
