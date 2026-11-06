// §12.3/§12.5: a session record is a claim about identity, not proof. A record whose
// token is dead or whose member is gone must NOT fall back to the no-identity path:
// a record-bearing session always stays a member, and only a session with no record
// may be offered `pg_org_start`.

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

async function assertRecordStaysMember(
  f: RecoverFixture,
  root: MemberRef,
  me: MemberRef,
  sessionFile: string,
): Promise<void> {
  // The member's session record names its organisation; the org record exists so a
  // root record could ensure the platform. A dead token must not turn this session
  // into a root: the member tools stay, and pg_org_start is never registered.
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

  assert.equal(f.tools.has('pg_org_start'), false, 'a record-bearing session never gets the no-identity door');
  assert.equal(f.tools.size, 12, 'a dead identity keeps the member tools; the loop reports the verdict');
}

test('an invalid token in a session record never falls back to the no-identity path', async (t) => {
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
    await assertRecordStaysMember(f, root, bad, '/tmp/pigroups-recover/bad-token.jsonl');
  } finally {
    console.warn = originalWarn;
  }
});

test('a session record for a gone member never falls back to the no-identity path', async (t) => {
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
    await assertRecordStaysMember(f, root, gone, '/tmp/pigroups-recover/gone.jsonl');
  } finally {
    console.warn = originalWarn;
  }
});
