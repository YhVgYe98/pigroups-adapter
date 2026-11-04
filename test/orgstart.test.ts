// 概念稿 §7.4 / 设计说明 §8: a session that is meant to lead conjures the organisation
// itself instead of being handed two environment variables by a human.
//
// These tests drive the real extension factory and, for the end-to-end cases, a real
// platform process started by `src/org.ts` — the same process the tool starts in
// production. The only fakes are pi (tools and events) and the clock of the test.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import pigroupsExtension from '../src/extension.ts';
import { platformCandidates, startOrg } from '../src/org.ts';
import { writeSessionRecords } from '../src/records.ts';
import type { PiContext, PiLike, PiToolDefinition } from '../src/surface.ts';

import { bootPlatform, bootstrapRoot, createMember, delay } from './support.ts';

const PLATFORM_DIR = resolve(
  process.env.PIGROUPS_PLATFORM_DIR ?? join(import.meta.dirname, '..', '..', 'PiGroups'),
);

const CTX: PiContext = { isIdle: () => true, abort: () => undefined, shutdown: () => undefined };

/** The seam pi supplies on session_start; the fake context in the other tests predates it. */
function ctxWithSession(sessionFile: string): PiContext {
  return { ...CTX, sessionManager: { getSessionFile: () => sessionFile } };
}

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

/** Run the real tool and return its parsed JSON answer. */
async function callTool(fake: FakePi, name: string, params: Record<string, unknown> = {}): Promise<any> {
  const tool = fake.tools.get(name);
  assert.ok(tool, `the extension must register ${name}`);
  const result = await tool.execute('call-1', params, undefined, undefined, CTX);
  const body = result.content[0]?.text;
  assert.equal(typeof body, 'string', `${name} answers text`);
  return JSON.parse(body as string);
}

/** The env keys these tests touch, restored after each test even when it fails. */
function isolateEnv(t: { after(fn: () => void | Promise<void>): void }): void {
  const saved = {
    url: process.env.PIGROUPS_URL,
    token: process.env.PIGROUPS_TOKEN,
    adapterDir: process.env.PIGROUPS_ADAPTER_DIR,
    pollWait: process.env.PIGROUPS_POLL_WAIT,
    orgKey: process.env.PIGROUPS_ORG_KEY,
  };
  t.after(() => {
    for (const [name, value] of [
      ['PIGROUPS_URL', saved.url],
      ['PIGROUPS_TOKEN', saved.token],
      ['PIGROUPS_ADAPTER_DIR', saved.adapterDir],
      ['PIGROUPS_POLL_WAIT', saved.pollWait],
      ['PIGROUPS_ORG_KEY', saved.orgKey],
    ] as Array<[string, string | undefined]>) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.PIGROUPS_URL;
  delete process.env.PIGROUPS_TOKEN;
  delete process.env.PIGROUPS_ORG_KEY;
  // The loop the tool starts must not block a test on a 25 s long poll.
  process.env.PIGROUPS_POLL_WAIT = '0';
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const server = createServer();
    server.on('error', rej);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rej(new Error('no port'));
        return;
      }
      const { port } = address;
      server.close(() => res(port));
    });
  });
}

interface OccupiedPlatform {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * A process holding the recorded port. It answers /v1/health only after
 * `answerAfterMs`, so the first health probe misses it and the port wait is the
 * path under test; `answerAfterMs: undefined` means it never becomes a platform.
 */
async function occupiedPlatform(opts: { platformId: string; answerAfterMs?: number }): Promise<OccupiedPlatform> {
  const port = await freePort();
  const openedAt = Date.now();
  const server = createHttpServer((req, res) => {
    const ready = opts.answerAfterMs !== undefined && Date.now() - openedAt >= opts.answerAfterMs;
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (ready && req.url === '/v1/health') {
      json(200, { status: 'ok', version: '0.3.0', uptime_ms: 1, platform_id: opts.platformId });
      return;
    }
    if (ready && req.url === '/v1/whoami') {
      json(200, {
        kind: 'member',
        member: {
          id: 'm_occupied_root',
          name: 'root',
          parent_id: null,
          status: 'alive',
          is_root: true,
          child_count: 0,
          groups: [],
          last_seen_at: 1,
          created_at: 1,
        },
        groups: [],
        dms: [],
        last_seen_at: 1,
        server: { version: '0.3.0' },
      });
      return;
    }
    json(503, { error: { code: 'starting', message: 'not ready' } });
  });
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => res());
  });
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections();
        server.close(() => res());
      }),
  };
}

async function seedPlatformDatabase(dataDir: string, platformId: string): Promise<void> {
  await mkdir(join(dataDir, 'platforms', platformId), { recursive: true });
  await writeFile(join(dataDir, 'platforms', platformId, 'pigroups.db'), 'placeholder');
}

/** A checkout whose src/main.ts records each start and then runs the real platform. */
async function instrumentedPlatformCheckout(): Promise<{ dir: string; log: string }> {
  const dir = await tempDir('pigroups-platform-count-');
  const log = join(dir, 'starts.log');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const realMain = pathToFileURL(join(PLATFORM_DIR, 'src', 'main.ts')).href;
  await writeFile(
    join(dir, 'src', 'main.ts'),
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.PIGROUPS_TEST_START_LOG ?? '/dev/null', 'spawn\\n');",
      `await import(${JSON.stringify(realMain)});`,
    ].join('\n'),
  );
  return { dir, log };
}

async function startCount(log: string): Promise<number> {
  try {
    return (await readFile(log, 'utf8')).split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

async function answers(url: string, timeoutMs = 500): Promise<boolean> {
  try {
    const response = await fetch(new URL('/v1/health', url), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return body.status === 'ok';
  } catch {
    return false;
  }
}

async function waitUntilGone(url: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await answers(url))) return;
    await delay(50);
  }
  throw new Error(`the platform at ${url} is still answering; it was not stopped`);
}

async function waitUntilProcessGone(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(25);
  }
  throw new Error(`process ${pid} is still running; it was not stopped`);
}

/** Stop the platform recorded in org.json and remove both directories. */
async function cleanupOrg(adapterDir: string, ...extraDirs: string[]): Promise<void> {
  let state: { pid?: number; url?: string } | undefined;
  try {
    // The record now lives under orgs/<key>/; the newest one is this test's org.
    const dir = join(adapterDir, 'orgs');
    const keys = await readdir(dir).catch(() => [] as string[]);
    const files = await Promise.all(
      keys.map(async (key) => {
        const file = join(dir, key, 'org.json');
        const info = await stat(file).catch(() => undefined);
        return info === undefined ? undefined : { file, at: info.mtimeMs };
      }),
    );
    const newest = files.filter((f) => f !== undefined).sort((a, b) => b!.at - a!.at)[0];
    state = newest === undefined ? undefined : (JSON.parse(await readFile(newest.file, 'utf8')) as { pid?: number; url?: string });
  } catch {
    state = undefined;
  }
  if (typeof state?.pid === 'number') {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    if (typeof state.url === 'string') await waitUntilGone(state.url).catch(() => undefined);
  }
  for (const dir of [adapterDir, ...extraDirs]) await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The two registration paths
// ---------------------------------------------------------------------------

test('a session with no identity and no session record gets exactly one tool: pg_org_start', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  t.after(() => rm(adapterDir, { recursive: true, force: true }));
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;

  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    logged.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.log = originalLog;
  });

  const fake = fakePi();
  pigroupsExtension(fake.pi);

  assert.deepEqual([...fake.tools.keys()], [], 'the surface waits for session_start, which is where a session file appears');

  await fake.fire('session_start', { reason: 'startup' }, CTX);
  assert.deepEqual([...fake.tools.keys()], ['pg_org_start'], 'without a record the only door is starting an organisation');
  assert.deepEqual(logged, [], 'an unconfigured session announces nothing and starts no loop');

  const description = fake.tools.get('pg_org_start')!.description;
  assert.match(description, /already belongs/i, 'the tool says a configured session is not given it');
  assert.match(description, /not given this tool/i);
  assert.match(description, /reattach/i, 'idempotence is part of the contract the model reads');
});

test('a session with an identity gets the twelve member tools and is not offered pg_org_start', async (t) => {
  isolateEnv(t);
  const platform = await bootPlatform();
  const adapterDir = await tempDir('pigroups-orgstart-');
  const root = await bootstrapRoot(platform);
  process.env.PIGROUPS_URL = platform.url;
  process.env.PIGROUPS_TOKEN = root.token;
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;
  const fake = fakePi();
  t.after(async () => {
    await fake.fire('session_shutdown', { reason: 'quit' });
    await platform.stop();
    await rm(adapterDir, { recursive: true, force: true });
  });

  pigroupsExtension(fake.pi);
  await fake.fire('session_start', { reason: 'startup' }, CTX);

  assert.equal(fake.tools.has('pg_org_start'), false, 'a member already belongs to a platform; conjuring a second org is not an offer');
  assert.equal(fake.tools.size, 12, 'the configured surface is still the twelve member tools');
});

test('a session with no env identity recovers it from sessions/<sha1(sessionFile)>.json', async (t) => {
  isolateEnv(t);
  const platform = await bootPlatform();
  const adapterDir = await tempDir('pigroups-orgstart-');
  const root = await bootstrapRoot(platform);
  const me = await createMember(platform, root, 'recovered');
  const sessionFile = join(adapterDir, 'pi-session.jsonl');
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;
  const orgDir = join(adapterDir, 'orgs', 'recovered');
  await mkdir(orgDir, { recursive: true });
  await writeFile(
    join(orgDir, 'org.json'),
    JSON.stringify({
      url: platform.url,
      token: root.token,
      admin_token: platform.adminToken,
      pid: 999_999,
      data_dir: platform.dataDir,
    }),
  );
  writeSessionRecords(adapterDir, {
    memberId: me.id,
    orgUrl: platform.url,
    token: me.token,
    parentId: root.id,
    sessionFile,
    orgKey: 'recovered',
  });

  const fake = fakePi();
  t.after(async () => {
    await fake.fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
    await platform.stop();
    await rm(adapterDir, { recursive: true, force: true });
  });

  pigroupsExtension(fake.pi);
  await fake.fire('session_start', { reason: 'resume' }, ctxWithSession(sessionFile));

  assert.equal(fake.tools.has('pg_org_start'), false, 'a recovered member must not be offered a second organisation');
  assert.equal(fake.tools.size, 12, 'a recovered identity gets the same twelve member tools as an env-configured one');
  const who = await callTool(fake, 'pg_whoami');
  assert.equal(who.who.member.id, me.id, 'the record supplied the platform and token');
});

// ---------------------------------------------------------------------------
// A: a member session heals its own platform
// ---------------------------------------------------------------------------

// §8.1 A2: a session record is enough to bring the whole organisation back. The
// record names the adapter directory holding orgs/<key>/org.json, so the platform
// can be ensured before any identity check talks to it.
test('a resumed member whose platform is down starts the recorded organisation itself, on the recorded port', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;

  const before = await startOrg({ adapterDir, name: 'self-heal', platformDir: PLATFORM_DIR });
  t.after(() => cleanupOrg(adapterDir));
  const beforeState = JSON.parse(await readFile(before.orgFile, 'utf8')) as { token: string; pid: number };
  process.kill(before.pid, 'SIGTERM');
  await waitUntilGone(before.url);
  await waitUntilProcessGone(before.pid);

  const sessionFile = join(adapterDir, 'pi-session.jsonl');
  writeSessionRecords(adapterDir, {
    memberId: before.root.id,
    orgUrl: before.url,
    token: beforeState.token,
    parentId: null,
    sessionFile,
    orgKey: 'self-heal',
  });

  const fake = fakePi();
  t.after(async () => {
    await fake.fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
  });
  pigroupsExtension(fake.pi);
  await fake.fire('session_start', { reason: 'resume' }, ctxWithSession(sessionFile));

  assert.equal(fake.tools.size, 12, 'the resumed member is a full member again, not a zombie behind pg_org_start');
  const who = await callTool(fake, 'pg_whoami');
  assert.equal(who.who.member.id, before.root.id, 'the recorded identity is the one that came back');
  assert.ok(await answers(before.url), 'the platform answers on the URL the record named');

  const afterState = JSON.parse(await readFile(before.orgFile, 'utf8')) as { pid: number; url: string };
  assert.equal(afterState.url, before.url, 'the organisation did not move to another port');
  assert.notEqual(afterState.pid, before.pid, 'a new process serves the same organisation');
  assert.equal(orgRecords(adapterDir).length, 1, 'self-healing reattached the record instead of creating a second organisation');

  const rewritten = JSON.parse(
    await readFile(join(adapterDir, 'sessions', `${createHash('sha1').update(sessionFile).digest('hex')}.json`), 'utf8'),
  ) as { orgKey?: string };
  assert.equal(rewritten.orgKey, 'self-heal', 'the session record now names the organisation it belongs to');
});

// An old record written before orgKey existed is still usable: the URL is matched
// against the small org.json files under orgs/, never against a platform database.
test('a session record without orgKey reattaches by matching its orgUrl under orgs/*/org.json', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;

  const org = await startOrg({ adapterDir, name: 'by-url', platformDir: PLATFORM_DIR });
  t.after(() => cleanupOrg(adapterDir));
  const state = JSON.parse(await readFile(org.orgFile, 'utf8')) as { token: string; pid: number };

  const sessionFile = join(adapterDir, 'pi-session.jsonl');
  writeSessionRecords(adapterDir, {
    memberId: org.root.id,
    orgUrl: org.url,
    token: state.token,
    parentId: null,
    sessionFile,
  });

  const fake = fakePi();
  t.after(async () => {
    await fake.fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
  });
  pigroupsExtension(fake.pi);
  await fake.fire('session_start', { reason: 'resume' }, ctxWithSession(sessionFile));

  assert.equal(fake.tools.size, 12, 'matching the URL found the organisation');
  const who = await callTool(fake, 'pg_whoami');
  assert.equal(who.who.member.id, org.root.id);
  const afterState = JSON.parse(await readFile(org.orgFile, 'utf8')) as { pid: number };
  assert.equal(afterState.pid, state.pid, 'a healthy platform was reattached, not restarted');
});

// §8.1 A2: without a matching organisation record there is nothing to ensure. The
// session must not invent a platform; it falls back to the one door and says why.
test('a session record with no orgKey and no matching org record does not start a platform', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;

  const sessionFile = join(adapterDir, 'pi-session.jsonl');
  writeSessionRecords(adapterDir, {
    memberId: 'm_orphan',
    orgUrl: 'http://127.0.0.1:1',
    token: 'orphan-token',
    parentId: null,
    sessionFile,
  });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  const fake = fakePi();
  t.after(async () => {
    await fake.fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
  });
  pigroupsExtension(fake.pi);
  try {
    await fake.fire('session_start', { reason: 'resume' }, ctxWithSession(sessionFile));
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual([...fake.tools.keys()], ['pg_org_start'], 'without an organisation record the session takes the one door');
  assert.ok(
    warnings.some((warning) => /orgKey|orgs\/|organisation record/i.test(warning) && /pg_org_start/i.test(warning)),
    `expected a warning naming the missing organisation record, got ${JSON.stringify(warnings)}`,
  );
  assert.equal(orgRecords(adapterDir).length, 0, 'no platform was started and no org.json was written');
});

// ---------------------------------------------------------------------------
// What the tool does
// ---------------------------------------------------------------------------


/** Every organisation record under a test's adapter directory. */
function orgRecords(adapterDir: string): string[] {
  const root = join(adapterDir, 'orgs');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((key) => join(root, key, 'org.json'))
    .filter((file) => existsSync(file));
}

test('pg_org_start starts a platform, bootstraps a root, wires the member tools, and is idempotent', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;

  const fake = fakePi();
  pigroupsExtension(fake.pi);
  t.after(async () => {
    // A failed assertion must not leave a polling loop behind: that keeps the test
    // file's event loop alive and turns a red assertion into a hung run.
    await fake.fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
    await cleanupOrg(adapterDir);
  });
  await fake.fire('session_start', { reason: 'startup' }, CTX);

  const started = await callTool(fake, 'pg_org_start', { name: 'alpha', platform_dir: PLATFORM_DIR });
  assert.equal(started.reattached, false, 'the first call creates the organisation');
  assert.equal(started.already_member, false);
  assert.equal(started.root.name, 'alpha', 'the name argument names the root member');
  assert.equal(typeof started.url, 'string');
  assert.ok(await answers(started.url), 'the org answers /v1/health');

  const state = JSON.parse(await readFile(String(started.org_file), 'utf8')) as {
    url: string;
    token: string;
    admin_token: string;
    pid: number;
    data_dir: string;
  };
  assert.equal(state.url, started.url, 'org.json records where the org lives');
  assert.equal(typeof state.token, 'string');
  assert.equal(typeof state.admin_token, 'string');
  assert.equal(state.pid, started.pid, 'org.json records the process that must outlive this session');
  assert.ok(
    existsSync(join(dirname(String(started.org_file)), 'platform.log')),
    'the detached platform writes its output to a log beside the org record',
  );
  assert.equal(existsSync(join(state.data_dir, 'platform.log')), false, 'the shared data root does not mix organisation logs');

  const whoami = await fetch(new URL('/v1/whoami', state.url), {
    headers: { authorization: `Bearer ${state.token}` },
  }).then((r) => r.json() as Promise<any>);
  assert.equal(whoami.member.is_root, true, 'the session that called the tool is the root');
  assert.equal(whoami.member.id, started.root.id);

  assert.deepEqual(
    [...fake.tools.keys()].sort(),
    [
      'pg_abort',
      'pg_ack',
      'pg_children',
      'pg_inspect',
      'pg_members',
      'pg_org_start',
      'pg_read',
      'pg_respawn',
      'pg_say',
      'pg_schedule',
      'pg_spawn',
      'pg_terminate',
      'pg_whoami',
    ],
    'after success the twelve member tools appear next to the door tool',
  );

  const live = await callTool(fake, 'pg_whoami');
  assert.equal(live.who.member.is_root, true, 'the loop is running with the new identity');
  assert.notEqual(live.adapter, null, 'the adapter state exists, so start() ran');

  const again = await callTool(fake, 'pg_org_start', { name: 'second' });
  assert.equal(again.already_member, true, 'a second call in the same session answers instead of starting again');
  assert.equal(again.url, started.url);
  assert.equal(again.root.id, started.root.id);

  await fake.fire('session_shutdown', { reason: 'quit' });
});

test('a later session reattaches to the org that outlived the root session instead of starting a second platform', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;

  const first = fakePi();
  const second = fakePi();
  t.after(async () => {
    await first.fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
    await second.fire('session_shutdown', { reason: 'quit' }).catch(() => undefined);
    await cleanupOrg(adapterDir);
  });
  pigroupsExtension(first.pi);
  await first.fire('session_start', { reason: 'startup' }, CTX);
  const started = await callTool(first, 'pg_org_start', { name: 'alpha', platform_dir: PLATFORM_DIR });
  const pid = started.pid as number;
  const token = (JSON.parse(await readFile(String(started.org_file), 'utf8')) as { token: string }).token;

  // The root session goes away; the organisation must not.
  await first.fire('session_shutdown', { reason: 'quit' });
  assert.ok(await answers(started.url), 'the platform outlives the root session that started it');

  pigroupsExtension(second.pi);
  await second.fire('session_start', { reason: 'startup' }, CTX);
  assert.deepEqual([...second.tools.keys()], ['pg_org_start'], 'the new session starts from the same one door');
  // The organisation is identified by its name; that is what makes two roots on one
  // machine two organisations instead of one shared record.
  const reattached = await callTool(second, 'pg_org_start', { name: 'alpha', platform_dir: PLATFORM_DIR });

  assert.equal(reattached.reattached, true, 'a healthy recorded org is reused');
  assert.equal(reattached.url, started.url, 'the URL did not move: no second platform was started');
  assert.equal(reattached.pid, pid, 'the recorded process is still the one serving the org');
  assert.equal(reattached.root.id, started.root.id, 'the same root identity came back');
  assert.equal(reattached.root.name, 'alpha', 'the name argument is ignored when reattaching');

  const again = await fetch(new URL('/v1/whoami', reattached.url), {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json() as Promise<any>);
  assert.equal(again.member.is_root, true, 'the old token still names the root');
  assert.ok(second.tools.has('pg_say'), 'the reattached session got the member tools too');
  await second.fire('session_shutdown', { reason: 'quit' });
});

test('a new organisation keeps its platform under the one shared data root and records the id health reports', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;

  const started = await startOrg({ adapterDir, name: 'shared-root', platformDir: PLATFORM_DIR });
  t.after(() => cleanupOrg(adapterDir));

  const state = JSON.parse(await readFile(started.orgFile, 'utf8')) as {
    data_dir: string;
    platform_id?: string;
  };
  assert.equal(state.data_dir, join(adapterDir, 'platform-data'), 'one data root is shared by every organisation');
  assert.notEqual(state.data_dir, join(adapterDir, 'orgs', 'shared-root', 'platform-data'), 'the old per-org root is gone');
  assert.match(state.platform_id ?? '', /^p_[0-9a-f]{8}$/, 'org.json records the platform id that /v1/health reported');

  const health = await fetch(new URL('/v1/health', started.url)).then((r) => r.json() as Promise<any>);
  assert.equal(health.platform_id, state.platform_id, 'the recorded id is the id the platform itself answers with');
  assert.ok(
    existsSync(join(state.data_dir, 'platforms', String(state.platform_id), 'pigroups.db')),
    'the database lives under <root>/platforms/<platform_id>/',
  );
});

test('an explicit data_dir still wins over the shared root', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  const dataDir = await tempDir('pigroups-orgdata-');
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;

  const started = await startOrg({ adapterDir, name: 'explicit-data', dataDir, platformDir: PLATFORM_DIR });
  t.after(() => cleanupOrg(adapterDir, dataDir));

  const state = JSON.parse(await readFile(started.orgFile, 'utf8')) as { data_dir: string; platform_id?: string };
  assert.equal(state.data_dir, resolve(dataDir), 'a person who names a data_dir gets that directory');
  assert.match(state.platform_id ?? '', /^p_[0-9a-f]{8}$/, 'the platform id is still recorded');
  assert.ok(
    existsSync(join(state.data_dir, 'platforms', String(state.platform_id), 'pigroups.db')),
    'the explicit root gets the same platforms/<id>/ layout',
  );
});

test('a restart passes the recorded platform id to the platform process', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;

  const first = await startOrg({ adapterDir, name: 'id-env', platformDir: PLATFORM_DIR });
  t.after(() => cleanupOrg(adapterDir));
  const state = JSON.parse(await readFile(first.orgFile, 'utf8')) as { platform_id?: string };
  assert.match(state.platform_id ?? '', /^p_[0-9a-f]{8}$/, 'the first start recorded an id before the restart');

  process.kill(first.pid, 'SIGTERM');
  await waitUntilGone(first.url);
  await waitUntilProcessGone(first.pid);

  const second = await startOrg({ adapterDir, name: 'id-env', platformDir: PLATFORM_DIR });
  assert.equal(second.reattached, true, 'the recorded organisation came back');
  assert.notEqual(second.pid, first.pid, 'a new process serves the same organisation');

  const environ = await readFile(`/proc/${second.pid}/environ`, 'utf8').catch(() => undefined);
  if (environ === undefined) {
    t.skip('/proc/<pid>/environ is unavailable on this host');
    return;
  }
  assert.ok(
    environ.split('\0').includes(`PIGROUPS_PLATFORM_ID=${state.platform_id}`),
    'the restarted platform was pinned to the id in org.json',
  );
  const restarted = JSON.parse(await readFile(second.orgFile, 'utf8')) as { platform_id?: string };
  assert.equal(restarted.platform_id, state.platform_id, 'the restart kept the same platform id');
});

// ---------------------------------------------------------------------------
// B: never start a second platform for the same organisation
// ---------------------------------------------------------------------------

// B1: a recorded port that is occupied may belong to the very platform another
// session just brought back. Waiting for health is how a restart becomes a
// reattach; choosing a free port would be a second platform on one database.
test('an occupied recorded port is reattached when health answers, never replaced by a new port', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  const dataDir = await tempDir('pigroups-orgdata-');
  const platformId = 'p_0cc00001';
  const occupied = await occupiedPlatform({ platformId, answerAfterMs: 700 });
  t.after(async () => {
    await occupied.close();
    await rm(adapterDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  const orgDir = join(adapterDir, 'orgs', 'occupied');
  await mkdir(orgDir, { recursive: true });
  await seedPlatformDatabase(dataDir, platformId);
  await writeFile(
    join(orgDir, 'org.json'),
    JSON.stringify({
      url: occupied.url,
      token: 'root-token',
      admin_token: 'admin-token',
      pid: 999_999,
      data_dir: dataDir,
      platform_id: platformId,
    }),
  );

  const started = await startOrg({
    adapterDir,
    name: 'occupied',
    platformDir: PLATFORM_DIR,
    env: { ...process.env, PIGROUPS_START_WAIT_MS: '5000' },
  });

  assert.equal(started.reattached, true, 'the service that won the port became the organisation again');
  assert.equal(started.url, occupied.url, 'the URL stayed the recorded one');
  assert.equal(existsSync(join(orgDir, 'platform.log')), false, 'no platform process was started');
});

// B1: if nothing answers health at the recorded port, there is no safe way to
// start the organisation. A random port would be a second process on the same
// database, so the start fails and says exactly that.
test('an occupied recorded port with no health answer fails instead of starting a second platform', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  const dataDir = await tempDir('pigroups-orgdata-');
  const platformId = 'p_0cc00002';
  const occupied = await occupiedPlatform({ platformId });
  t.after(async () => {
    await occupied.close();
    await rm(adapterDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  const orgDir = join(adapterDir, 'orgs', 'occupied-dead');
  await mkdir(orgDir, { recursive: true });
  await seedPlatformDatabase(dataDir, platformId);
  await writeFile(
    join(orgDir, 'org.json'),
    JSON.stringify({
      url: occupied.url,
      token: 'root-token',
      admin_token: 'admin-token',
      pid: 999_999,
      data_dir: dataDir,
      platform_id: platformId,
    }),
  );

  await assert.rejects(
    startOrg({
      adapterDir,
      name: 'occupied-dead',
      platformDir: PLATFORM_DIR,
      env: { ...process.env, PIGROUPS_START_WAIT_MS: '600' },
    }),
    (err: Error) => {
      assert.match(err.message, new RegExp(`port ${occupied.port}`), 'the error names the occupied port');
      assert.match(err.message, /\/v1\/health/, 'the error names the answer that was missing');
      assert.match(err.message, /second platform/i, 'the error says a second platform was refused');
      assert.match(err.message, /600 ms|0\.6 s/, 'the error names the wait it performed');
      return true;
    },
  );
  assert.equal(existsSync(join(orgDir, 'platform.log')), false, 'nothing was spawned, on this port or another');
  assert.equal(orgRecords(adapterDir).length, 1, 'the failed start did not write a second record');
});

// B2: simultaneous starts of one new organisation converge on one process.
test('two simultaneous starts of the same new organisation spawn one platform and share its URL', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  const checkout = await instrumentedPlatformCheckout();
  const env = { ...process.env, PIGROUPS_TEST_START_LOG: checkout.log };
  t.after(async () => {
    await cleanupOrg(adapterDir);
    await rm(checkout.dir, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    startOrg({ adapterDir, name: 'race', platformDir: checkout.dir, env, healthTimeoutMs: 8000 }),
    startOrg({ adapterDir, name: 'race', platformDir: checkout.dir, env, healthTimeoutMs: 8000 }),
  ]);

  assert.equal(first.url, second.url, 'both callers got the one organisation URL');
  assert.equal(first.root.id, second.root.id, 'both callers got the one root identity');
  assert.equal(await startCount(checkout.log), 1, 'exactly one platform process was spawned');

  const third = await startOrg({ adapterDir, name: 'race', platformDir: checkout.dir, env, healthTimeoutMs: 8000 });
  assert.equal(third.reattached, true, 'a later start reattaches to the running platform');
  assert.equal(third.url, first.url, 'the URL did not move');
  assert.equal(await startCount(checkout.log), 1, 'reattaching never spawns another process');
});

// B2: the lock is not a reason to wait while the platform is already up. A caller
// that cannot take the lock probes health and adopts the running organisation.
test('a start that cannot take the lock adopts the healthy platform instead of waiting it out', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;

  const org = await startOrg({ adapterDir, name: 'locked-healthy', platformDir: PLATFORM_DIR });
  t.after(() => cleanupOrg(adapterDir));
  const lock = join(adapterDir, 'orgs', 'locked-healthy', 'org.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });

  const startedAt = Date.now();
  const adopted = await startOrg({ adapterDir, name: 'locked-healthy', platformDir: PLATFORM_DIR });
  const took = Date.now() - startedAt;

  assert.equal(adopted.reattached, true, 'the healthy platform was adopted');
  assert.equal(adopted.url, org.url);
  assert.ok(took < 5000, `adopting must not wait for the 15 s lock deadline, took ${took}ms`);
  assert.ok(existsSync(lock), 'the live lock belongs to another process; this caller must not remove it');
});

test('a platform whose id differs from org.json is refused without rewriting the record or bootstrapping', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  const dataDir = await tempDir('pigroups-orgdata-');
  const checkout = await tempDir('pigroups-fake-platform-');
  t.after(async () => {
    await rm(adapterDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
    await rm(checkout, { recursive: true, force: true });
  });

  // A platform that answers health with an id different from the recorded one. It
  // records any bootstrap so the test can prove the adapter refused before that.
  await mkdir(join(checkout, 'src'), { recursive: true });
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    join(checkout, 'src', 'main.ts'),
    [
      "import { createServer } from 'node:http';",
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const port = Number(process.env.PORT);',
      'const server = createServer((req, res) => {',
      "  if (req.url === '/v1/health') {",
      "    res.writeHead(200, { 'content-type': 'application/json' });",
      "    res.end(JSON.stringify({ status: 'ok', version: '0.3.0', uptime_ms: 0, platform_id: 'p_22222222' }));",
      '    return;',
      '  }',
      "  if (req.url === '/v1/bootstrap') {",
      "    writeFileSync(join(process.env.PIGROUPS_DATA ?? '.', 'bootstrapped'), 'yes');",
      "    res.writeHead(200, { 'content-type': 'application/json' });",
      "    res.end(JSON.stringify({ member: { id: 'm_fake', name: 'fake' }, token: 'fake-token' }));",
      '    return;',
      '  }',
      "  res.writeHead(401, { 'content-type': 'application/json' });",
      "  res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }));",
      '});',
      "server.listen(port, '127.0.0.1', () => console.error('listening on ' + port));",
    ].join('\n'),
  );

  // F1 refuses a record whose named data dir has no database before it ever spawns.
  // This test is about the next check (the id the platform reports), so give the
  // record a database to point at; the fake platform does not open it.
  await mkdir(join(dataDir, 'platforms', 'p_11111111'), { recursive: true });
  await writeFile(join(dataDir, 'platforms', 'p_11111111', 'pigroups.db'), 'placeholder');

  const deadPort = await freePort();
  const orgDir = join(adapterDir, 'orgs', 'mismatch');
  await mkdir(orgDir, { recursive: true });
  const orgFile = join(orgDir, 'org.json');
  await writeFile(
    orgFile,
    JSON.stringify({
      url: `http://127.0.0.1:${deadPort}`,
      token: 'old-token',
      admin_token: 'old-admin',
      pid: 999999,
      data_dir: dataDir,
      platform_id: 'p_11111111',
    }),
  );
  const before = await readFile(orgFile, 'utf8');

  await assert.rejects(
    startOrg({ adapterDir, name: 'mismatch', dataDir, platformDir: checkout }),
    (err: Error) => {
      assert.match(err.message, /p_11111111/, 'the error names the recorded id');
      assert.match(err.message, /p_22222222/, 'the error names the id the platform reported');
      assert.match(err.message, /same .*different platform instance/i, 'the error says the ids are not the same instance');
      return true;
    },
  );

  assert.equal(await readFile(orgFile, 'utf8'), before, 'org.json is not overwritten with the reported id');
  assert.equal(existsSync(join(dataDir, 'bootstrapped')), false, 'no root was bootstrapped on the wrong platform');
});

test('a platform older than 0.3.0 is refused: one shared data root needs platform ids', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  const dataDir = await tempDir('pigroups-orgdata-');
  const checkout = await tempDir('pigroups-old-platform-');
  t.after(async () => {
    await rm(adapterDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
    await rm(checkout, { recursive: true, force: true });
  });

  // A 0.2.0 platform: it answers /v1/health without a platform_id and ignores
  // PIGROUPS_PLATFORM_ID, which today would put every organisation in one database.
  await mkdir(join(checkout, 'src'), { recursive: true });
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    join(checkout, 'src', 'main.ts'),
    [
      "import { createServer } from 'node:http';",
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const port = Number(process.env.PORT);',
      'const server = createServer((req, res) => {',
      "  if (req.url === '/v1/health') {",
      "    res.writeHead(200, { 'content-type': 'application/json' });",
      "    res.end(JSON.stringify({ status: 'ok', version: '0.2.0', uptime_ms: 0 }));",
      '    return;',
      '  }',
      "  if (req.url === '/v1/bootstrap') {",
      "    writeFileSync(join(process.env.PIGROUPS_DATA ?? '.', 'bootstrapped'), 'yes');",
      "    res.writeHead(200, { 'content-type': 'application/json' });",
      "    res.end(JSON.stringify({ member: { id: 'm_fake', name: 'fake' }, token: 'fake-token' }));",
      '    return;',
      '  }',
      "  res.writeHead(401, { 'content-type': 'application/json' });",
      "  res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }));",
      '});',
      "server.listen(port, '127.0.0.1', () => console.error('listening on ' + port));",
    ].join('\n'),
  );

  await assert.rejects(
    startOrg({ adapterDir, name: 'old-platform', dataDir, platformDir: checkout }),
    (err: Error) => {
      assert.match(err.message, /does not report a platform_id/, 'the error names the missing id');
      assert.match(err.message, /0\.3\.0/, 'the error names the minimum platform version');
      return true;
    },
  );

  assert.equal(existsSync(join(dataDir, 'bootstrapped')), false, 'no root was bootstrapped on a platform we refuse');
  assert.equal(existsSync(join(adapterDir, 'orgs', 'old-platform', 'org.json')), false, 'no record was written');
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

test('a missing platform checkout fails with every candidate path it tried', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  const explicit = await tempDir('pigroups-no-platform-');
  const fromEnv = await tempDir('pigroups-no-platform-env-');
  const root = await tempDir('pigroups-no-adapter-root-');
  t.after(() => cleanupOrg(adapterDir, explicit, fromEnv, root));

  // `adapterRoot` is the seam that lets the two relative candidates be absent too:
  // in this workspace `../PiGroups` exists, so a real failure needs the test's own root.
  const candidates = platformCandidates({
    platformDir: explicit,
    env: { ...process.env, PIGROUPS_PLATFORM_DIR: fromEnv },
    adapterRoot: root,
  });
  assert.equal(candidates.length, 4, 'the four documented candidates are all in play');

  await assert.rejects(
    startOrg({
      adapterDir,
      platformDir: explicit,
      env: { ...process.env, PIGROUPS_PLATFORM_DIR: fromEnv },
      adapterRoot: root,
    }),
    (err: Error) => {
      assert.match(err.message, /src\/main\.ts/, 'the message names the fact that was checked');
      for (const candidate of candidates) {
        assert.ok(err.message.includes(candidate.path), `the message lists ${candidate.path}`);
      }
      return true;
    },
  );
  assert.equal(orgRecords(adapterDir).length, 0, 'a failed lookup writes no org record');
});

test('a recorded pid that is alive but is not this platform is never signalled', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  const dataDir = await tempDir('pigroups-orgdata-');
  // Not cleanupOrg: it trusts org.json's pid, and this record deliberately names
  // the test process itself.
  t.after(async () => {
    await rm(adapterDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  const deadPort = await freePort();
  const url = `http://127.0.0.1:${deadPort}`;
  // The record lives under orgs/<key>/, keyed by the org name; the test names it explicitly
  // so it does not have to guess a key derived from the working directory.
  const orgDir = join(adapterDir, 'orgs', 'stale-pid');
  await mkdir(orgDir, { recursive: true });
  await writeFile(
    join(orgDir, 'org.json'),
    JSON.stringify({ url, token: 'stale', admin_token: 'stale-admin', pid: process.pid, data_dir: dataDir }),
  );

  await assert.rejects(
    startOrg({ adapterDir, platformDir: PLATFORM_DIR, name: 'stale-pid' }),
    (err: Error) => {
      assert.match(err.message, new RegExp(String(process.pid)), 'the message names the pid it refused to kill');
      assert.match(err.message, /still running/i);
      return true;
    },
  );

  // If the guard were missing, this test process would have received SIGTERM and the
  // suite would die here; reaching this line is the proof that it did not.
  assert.equal(orgRecords(adapterDir).length, 1, 'the unreadable record is left for a person to inspect');
});

test('a failed bootstrap kills the platform it just started', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  const dataDir = await tempDir('pigroups-orgdata-');
  t.after(async () => {
    await rm(adapterDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  // A data dir that already has a root makes the bootstrap answer 409. Seed one on a
  // named platform, then record that platform with a token it will reject: the
  // adapter restarts the same instance, fails to reattach, and falls through to the
  // 409. The point is not the 409; it is that the spawn is stopped again.
  const platformId = 'p_5eed0001';
  const seedPort = await freePort();
  const seedUrl = `http://127.0.0.1:${seedPort}`;
  const seed = spawn(process.execPath, [join(PLATFORM_DIR, 'src', 'main.ts')], {
    env: {
      ...process.env,
      PORT: String(seedPort),
      PIGROUPS_DATA: dataDir,
      PIGROUPS_PLATFORM_ID: platformId,
      PIGROUPS_ADMIN_TOKEN: 'seed',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      seed.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  });
  const seedDeadline = Date.now() + 8000;
  while (!(await answers(seedUrl))) {
    if (Date.now() > seedDeadline) throw new Error('the seed platform did not start');
    await delay(25);
  }
  const bootstrapped = await fetch(`${seedUrl}/v1/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'seed-root' }),
  });
  assert.equal(bootstrapped.status, 200, 'the seed data dir has a root before the tool runs');
  seed.kill('SIGTERM');
  await waitUntilGone(seedUrl);
  if (seed.pid !== undefined) await waitUntilProcessGone(seed.pid);

  const orgDir = join(adapterDir, 'orgs', 'seed-org');
  await mkdir(orgDir, { recursive: true });
  await writeFile(
    join(orgDir, 'org.json'),
    JSON.stringify({
      url: seedUrl,
      token: 'wrong-token',
      admin_token: 'old-admin',
      pid: 999999,
      data_dir: dataDir,
      platform_id: platformId,
    }),
  );

  await assert.rejects(
    startOrg({ adapterDir, name: 'seed-org', dataDir, port: seedPort, platformDir: PLATFORM_DIR }),
    (err: Error) => {
      assert.match(err.message, /already_bootstrapped/i, 'the platform error code is reported');
      assert.match(err.message, /platform\.log|stopped/i, 'the message says the started platform was dealt with');
      return true;
    },
  );

  await waitUntilGone(seedUrl, 5000);
  assert.equal(orgRecords(adapterDir).length, 1, 'the failed start did not add or rewrite the record');
});

// Two roots on one machine are two organisations. Before the per-name keying they shared one
// org.json, so the second call found the first one's record and both teams landed on one platform.
test('two organisations with different names are two platforms and two records', async (t) => {
  isolateEnv(t);
  const adapterDir = await tempDir('pigroups-orgstart-');
  t.after(() => cleanupOrg(adapterDir));

  const first = await startOrg({ adapterDir, platformDir: PLATFORM_DIR, name: 'team-a' });
  const second = await startOrg({ adapterDir, platformDir: PLATFORM_DIR, name: 'team-b' });
  try {
    assert.notEqual(first.url, second.url, 'each organisation has its own platform');
    assert.notEqual(first.pid, second.pid, 'each organisation has its own process');
    assert.equal(first.root.name, 'team-a');
    assert.equal(second.root.name, 'team-b');
    assert.ok(await answers(first.url), 'the first organisation still answers');
    assert.ok(await answers(second.url), 'the second organisation answers too');
    assert.equal(orgRecords(adapterDir).length, 2, 'two records, one per name');
    assert.equal(resolve(first.dataDir), resolve(adapterDir, 'platform-data'), 'both organisations share one data root');
    assert.equal(resolve(second.dataDir), resolve(adapterDir, 'platform-data'), 'the second uses the same root');
    const firstState = JSON.parse(await readFile(first.orgFile, 'utf8')) as { platform_id?: string };
    const secondState = JSON.parse(await readFile(second.orgFile, 'utf8')) as { platform_id?: string };
    assert.match(firstState.platform_id ?? '', /^p_[0-9a-f]{8}$/, 'each organisation records its platform id');
    assert.match(secondState.platform_id ?? '', /^p_[0-9a-f]{8}$/, 'each organisation records its platform id');
    assert.notEqual(firstState.platform_id, secondState.platform_id, 'the shared root did not collapse them into one platform');
  } finally {
    for (const org of [first, second]) {
      try {
        process.kill(org.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
});

// A test process that dies mid-run leaves its platform behind: 17 of them piled up during one
// afternoon, each holding a port and a database. Clean up by looking at what is actually
// running, not at what the test hoped to have finished.
after(async () => {
  const entries = await readdir('/proc').catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const environ = await readFile(`/proc/${entry}/environ`, 'utf8').catch(() => '');
    if (!environ.includes('PIGROUPS_DATA=/tmp/pigroups-orgstart-')) continue;
    try {
      process.kill(Number(entry), 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
});
