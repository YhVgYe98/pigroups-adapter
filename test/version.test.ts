// Version: one number, three places a person can reach it.
//
// The adapter is pre-1.0 and both repos ship as one system (CHANGELOG.md 版本策略),
// so the number lives in `src/version.ts` and nowhere else. These tests guard the
// two ways it could drift: `package.json` (the published package) and the observable
// surfaces (`pg_whoami`, the one startup log line).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pigroupsExtension from '../src/extension.ts';
import type { PiContext, PiLike, PiToolDefinition } from '../src/surface.ts';
import { ADAPTER_VERSION } from '../src/version.ts';

import { bootPlatform, bootstrapRoot, waitFor, type MemberRef, type Platform } from './support.ts';

function readJson(relative: string): Record<string, any> {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
}

test('this release is 0.16.0 for the platform 0.7 endpoint claim', () => {
  assert.equal(ADAPTER_VERSION, '0.16.0+platform.0.7.0', 'the release records the platform it was exercised against');
});

test('ADAPTER_VERSION is the version package.json and its lockfile publish', () => {
  const pkg = readJson('../package.json');
  assert.equal(pkg.version, ADAPTER_VERSION, 'package.json must say what src/version.ts says');

  const lock = readJson('../package-lock.json');
  assert.equal(lock.version, ADAPTER_VERSION, 'the lockfile carries the same version');
  assert.equal(lock.packages[''].version, ADAPTER_VERSION, 'the lockfile root package carries the same version');
});

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** A PiLike that records the tool definitions and event handlers the extension registers. */
function fakePi(): {
  pi: PiLike;
  tools: Map<string, PiToolDefinition>;
  fire(event: string, payload?: unknown, ctx?: unknown): Promise<void>;
} {
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

interface Session {
  platform: Platform;
  me: MemberRef;
  tools: Map<string, PiToolDefinition>;
  /** Fire the handler the extension registered for that pi event, and wait for it. */
  fire(event: string, payload?: unknown, ctx?: PiContext): Promise<void>;
  /** session_shutdown, then the platform and the temp adapter directory. */
  close(): Promise<void>;
}

const CTX: PiContext = { isIdle: () => true, abort: () => undefined, shutdown: () => undefined };

/** A live member session with the extension loaded through its real entry point. */
async function memberSession(ctx: PiContext = CTX): Promise<Session> {
  const platform = await bootPlatform();
  const adapterDir = await mkdtemp(join(tmpdir(), 'pigroups-version-'));

  const saved = {
    url: process.env.PIGROUPS_URL,
    token: process.env.PIGROUPS_TOKEN,
    dir: process.env.PIGROUPS_ADAPTER_DIR,
    wait: process.env.PIGROUPS_POLL_WAIT,
  };
  const restore = (): void => {
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
  };

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await fire('session_shutdown', { reason: 'quit' });
    await platform.stop();
    await rm(adapterDir, { recursive: true, force: true });
    restore();
  };

  const { pi, tools, fire } = fakePi();
  try {
    const me = await bootstrapRoot(platform);
    process.env.PIGROUPS_URL = platform.url;
    process.env.PIGROUPS_TOKEN = me.token;
    process.env.PIGROUPS_ADAPTER_DIR = adapterDir;
    process.env.PIGROUPS_POLL_WAIT = '0';

    pigroupsExtension(pi);
    // The factory registers tools; session_start starts the loop.
    await fire('session_start', { reason: 'startup' }, ctx);

    return { platform, me, tools, fire, close };
  } catch (err) {
    await close();
    throw err;
  }
}

async function callWhoami(tools: Map<string, PiToolDefinition>): Promise<any> {
  const tool = tools.get('pg_whoami');
  assert.ok(tool, 'the extension must register pg_whoami');
  const result = await tool.execute('call-1', {}, undefined, undefined, CTX);
  const text = result.content[0]?.text;
  assert.equal(typeof text, 'string', 'pg_whoami answers text');
  return JSON.parse(text as string);
}

test('pg_whoami reports adapter_version next to the platform version', async () => {
  const session = await memberSession();
  try {
    const answer = await callWhoami(session.tools);
    assert.equal(answer.adapter_version, ADAPTER_VERSION, 'the adapter version is in the answer');
    assert.equal(answer.who.member.id, session.me.id, 'the platform coordinates are still there');
    assert.equal(typeof answer.who.server.version, 'string', 'the platform version stays under who.server.version');
    assert.ok(answer.adapter !== undefined, 'the adapter state stays in the answer');
  } finally {
    await session.close();
  }
});

test('the one startup log line names the adapter version and the platform it talks to', async (t) => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.log = original;
  });

  const session = await memberSession();
  try {
    const expected = `[pigroups] adapter ${ADAPTER_VERSION} starting against ${session.platform.url}`;
    assert.deepEqual(lines, [expected], 'exactly one startup line, and it names the version');
  } finally {
    await session.close();
  }
});

test('the extension paints one footer status and clears it on shutdown', async () => {
  const firstCalls: Array<[string, string | undefined]> = [];
  const first: PiContext = {
    ...CTX,
    ui: {
      setStatus: (key, text) => firstCalls.push([key, text]),
      theme: { bold: (value) => `**${value}**` },
    },
  };
  const secondCalls: Array<[string, string | undefined]> = [];
  const session = await memberSession(first);
  try {
    await waitFor(
      () => firstCalls.some(([key, text]) => key === 'pigroups' && typeof text === 'string' && text.includes('**')),
      'the first status line',
    );

    const second: PiContext = {
      ...CTX,
      ui: {
        setStatus: (key, text) => secondCalls.push([key, text]),
        theme: { bold: (value) => `**${value}**` },
      },
    };
    await session.fire('session_tree', {}, second);
    await waitFor(
      () => secondCalls.some(([key, text]) => key === 'pigroups' && typeof text === 'string' && text.includes('PG ')),
      'a session_tree repaint into the new context',
    );
    const painted = secondCalls.filter(([key, text]) => key === 'pigroups' && text !== undefined).at(-1)?.[1];
    assert.match(painted ?? '', /^PG \*\*.+\*\*\(m_[0-9a-f]+\) · /, 'the status names the member and its path');
  } finally {
    await session.close();
  }

  await waitFor(
    () => secondCalls.some(([key, text]) => key === 'pigroups' && text === undefined),
    'the shutdown clear in the current context',
  );
});

test('a throwing setStatus cannot break the member tools', async () => {
  const ctx: PiContext = {
    ...CTX,
    ui: {
      setStatus: () => {
        throw new Error('footer is gone');
      },
      theme: { bold: (value) => value },
    },
  };
  const session = await memberSession(ctx);
  try {
    const answer = await callWhoami(session.tools);
    assert.equal(answer.who.member.id, session.me.id, 'the loop survives a broken footer');
  } finally {
    await session.close();
  }
});
