// §12.3/§12.5: a session record is a claim about identity, not proof. A record whose
// token is dead or whose member is gone must fall back to the no-identity path: only
// `pg_org_start`, no member tools and no polling against an identity that cannot work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pigroupsExtension from '../src/extension.ts';
import { writeSessionRecords } from '../src/records.ts';
import type { PiLike, PiToolDefinition } from '../src/surface.ts';

import { bootPlatform, bootstrapRoot, createMember, removeMember } from './support.ts';
import type { MemberRef, Platform } from './support.ts';

type Handler = (event: unknown, ctx?: unknown) => unknown;

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

function ctxFor(sessionFile: string): unknown {
  return {
    isIdle: () => true,
    abort: () => undefined,
    shutdown: () => undefined,
    sessionManager: { getSessionFile: () => sessionFile },
  };
}

interface RecoverFixture {
  platform: Platform;
  adapterDir: string;
  pi: PiLike;
  tools: Map<string, PiToolDefinition>;
  fire(event: string, payload?: unknown, ctx?: unknown): Promise<void>;
  close(): Promise<void>;
}

async function fixture(t: { after(fn: () => Promise<void> | void): void }): Promise<RecoverFixture> {
  const platform = await bootPlatform();
  const adapterDir = await mkdtemp(join(tmpdir(), 'pigroups-recover-'));
  const saved = {
    url: process.env.PIGROUPS_URL,
    token: process.env.PIGROUPS_TOKEN,
    dir: process.env.PIGROUPS_ADAPTER_DIR,
    wait: process.env.PIGROUPS_POLL_WAIT,
  };
  delete process.env.PIGROUPS_URL;
  delete process.env.PIGROUPS_TOKEN;
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;
  process.env.PIGROUPS_POLL_WAIT = '0';

  const { pi, tools, fire } = fakePi();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
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
  };
  t.after(close);
  return { platform, adapterDir, pi, tools, fire, close };
}

async function assertFallsBackToOrgStart(
  f: RecoverFixture,
  root: MemberRef,
  me: MemberRef,
  sessionFile: string,
  warnings: string[],
): Promise<void> {
  // The member's session record names its organisation; the org record is what
  // lets the startup path ensure (or reattach to) the platform before the identity
  // check. Without it a record without orgKey is not allowed to start anything.
  const orgDir = join(f.adapterDir, 'orgs', 'recover');
  await mkdir(orgDir, { recursive: true });
  await writeFile(
    join(orgDir, 'org.json'),
    JSON.stringify({
      url: f.platform.url,
      token: root.token,
      admin_token: f.platform.adminToken,
      pid: 999_999,
      data_dir: f.platform.dataDir,
    }),
  );
  writeSessionRecords(f.adapterDir, {
    memberId: me.id,
    orgUrl: f.platform.url,
    token: me.token,
    parentId: null,
    sessionFile,
    orgKey: 'recover',
  });
  pigroupsExtension(f.pi);
  await f.fire('session_start', { reason: 'startup' }, ctxFor(sessionFile));

  assert.deepEqual([...f.tools.keys()], ['pg_org_start'], 'a dead identity gets the no-identity tool surface');
  assert.ok(
    warnings.some((warning) => /record|identity/i.test(warning) && /invalid|expired|gone|reissue/i.test(warning)),
    `expected a clear invalid-record warning, got ${JSON.stringify(warnings)}`,
  );
  assert.ok(
    warnings.some((warning) => /pg_org_start|parent/i.test(warning)),
    'the warning says how to get a working identity back',
  );
}

test('an invalid token in a session record falls back to the no-identity path', async (t) => {
  const f = await fixture(t);
  const root = await bootstrapRoot(f.platform);
  const bad = { id: root.id, name: root.name, token: 'not-a-valid-token' };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  try {
    await assertFallsBackToOrgStart(f, root, bad, '/tmp/pigroups-recover/bad-token.jsonl', warnings);
  } finally {
    console.warn = originalWarn;
  }
});

test('a session record for a gone member falls back to the no-identity path', async (t) => {
  const f = await fixture(t);
  const root = await bootstrapRoot(f.platform);
  const gone = await createMember(f.platform, root, 'recover-gone');
  await removeMember(f.platform, root.token, gone.id);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  try {
    await assertFallsBackToOrgStart(f, root, gone, '/tmp/pigroups-recover/gone.jsonl', warnings);
  } finally {
    console.warn = originalWarn;
  }
});
