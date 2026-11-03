// 概念稿 §7.4 / 设计说明 §8: a session that is meant to lead conjures the organisation
// itself instead of being handed two environment variables by a human.
//
// These tests drive the real extension factory and, for the end-to-end cases, a real
// platform process started by `src/org.ts` — the same process the tool starts in
// production. The only fakes are pi (tools and events) and the clock of the test.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import pigroupsExtension from '../src/extension.ts';
import { platformCandidates, startOrg } from '../src/org.ts';
import type { PiContext, PiLike, PiToolDefinition } from '../src/surface.ts';

import { bootPlatform, bootstrapRoot, delay } from './support.ts';

const PLATFORM_DIR = resolve(
  process.env.PIGROUPS_PLATFORM_DIR ?? join(import.meta.dirname, '..', '..', 'PiGroups'),
);

const CTX: PiContext = { isIdle: () => true, abort: () => undefined, shutdown: () => undefined };

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
  };
  t.after(() => {
    for (const [name, value] of [
      ['PIGROUPS_URL', saved.url],
      ['PIGROUPS_TOKEN', saved.token],
      ['PIGROUPS_ADAPTER_DIR', saved.adapterDir],
      ['PIGROUPS_POLL_WAIT', saved.pollWait],
    ] as Array<[string, string | undefined]>) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.PIGROUPS_URL;
  delete process.env.PIGROUPS_TOKEN;
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

test('a session with no identity gets exactly one tool: pg_org_start, and nothing starts by itself', async (t) => {
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

  assert.deepEqual(
    [...fake.tools.keys()],
    ['pg_org_start'],
    'without an identity the only door is starting an organisation; no member tool exists yet',
  );

  await fake.fire('session_start', { reason: 'startup' }, CTX);
  assert.deepEqual([...fake.tools.keys()], ['pg_org_start'], 'session_start must not register anything on its own');
  assert.deepEqual(logged, [], 'an unconfigured session announces nothing and starts no loop');

  const description = fake.tools.get('pg_org_start')!.description;
  assert.match(description, /already belongs/i, 'the tool says a configured session is not given it');
  assert.match(description, /not given this tool/i);
  assert.match(description, /reattach/i, 'idempotence is part of the contract the model reads');
});

test('a session with an identity gets the ten member tools and is not offered pg_org_start', async (t) => {
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
  assert.equal(fake.tools.size, 10, 'the configured surface is still the ten member tools');
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
  assert.ok(existsSync(join(state.data_dir, 'platform.log')), 'the detached platform writes its output to a log');

  const whoami = await fetch(new URL('/v1/whoami', state.url), {
    headers: { authorization: `Bearer ${state.token}` },
  }).then((r) => r.json() as Promise<any>);
  assert.equal(whoami.member.is_root, true, 'the session that called the tool is the root');
  assert.equal(whoami.member.id, started.root.id);

  assert.deepEqual(
    [...fake.tools.keys()].sort(),
    [
      'pg_abort',
      'pg_children',
      'pg_inspect',
      'pg_members',
      'pg_org_start',
      'pg_read',
      'pg_say',
      'pg_schedule',
      'pg_spawn',
      'pg_terminate',
      'pg_whoami',
    ],
    'after success the ten member tools appear next to the door tool',
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

  // A data dir that already has a root makes the bootstrap answer 409. The point is
  // not the 409; it is that a failure after the spawn must not leave a process behind.
  const seedPort = await freePort();
  const seedUrl = `http://127.0.0.1:${seedPort}`;
  const seed = spawn(process.execPath, [join(PLATFORM_DIR, 'src', 'main.ts')], {
    env: { ...process.env, PORT: String(seedPort), PIGROUPS_DATA: dataDir, PIGROUPS_ADMIN_TOKEN: 'seed' },
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

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  await assert.rejects(
    startOrg({ adapterDir, dataDir, port, platformDir: PLATFORM_DIR }),
    (err: Error) => {
      assert.match(err.message, /already_bootstrapped/i, 'the platform error code is reported');
      assert.match(err.message, /platform\.log|stopped/i, 'the message says the started platform was dealt with');
      return true;
    },
  );

  await waitUntilGone(url, 5000);
  assert.equal(orgRecords(adapterDir).length, 0, 'a failed start leaves no org record');
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
