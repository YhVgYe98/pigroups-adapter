// 设计说明 §8.2/§12.1: the organisation record is the one thing that may not be
// repaired silently. These are the "would this break a live organisation?" cases:
// a moved data root, debris left by a pre-0.3 platform, an id the platform did not
// honour, a generated id colliding with an existing directory, a null id, and the
// per-organisation platform log.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { readOrgState, startOrg } from '../src/org.ts';
import { delay } from './support.ts';

const PLATFORM_DIR = resolve(
  process.env.PIGROUPS_PLATFORM_DIR ?? join(import.meta.dirname, '..', '..', 'PiGroups'),
);

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

async function stopRecordedOrgs(adapterDir: string): Promise<void> {
  const root = join(adapterDir, 'orgs');
  const keys = await readdir(root).catch(() => [] as string[]);
  for (const key of keys) {
    let state: { pid?: unknown; url?: unknown } | undefined;
    try {
      state = JSON.parse(await readFile(join(root, key, 'org.json'), 'utf8')) as { pid?: unknown; url?: unknown };
    } catch {
      continue;
    }
    if (typeof state?.pid !== 'number' || state.pid <= 0) continue;
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    if (typeof state.url === 'string') await waitUntilGone(state.url).catch(() => undefined);
    await waitUntilProcessGone(state.pid).catch(() => undefined);
  }
}

async function cleanup(adapterDir: string, ...extraDirs: string[]): Promise<void> {
  await stopRecordedOrgs(adapterDir);
  for (const dir of [adapterDir, ...extraDirs]) await rm(dir, { recursive: true, force: true });
}

/**
 * A platform checkout whose src/main.ts answers /v1/health and records bootstrap.
 * It can impersonate the pre-0.3 line: no platform_id, and a flat pigroups.db in
 * the data root that ignores PIGROUPS_PLATFORM_ID.
 */
async function fakePlatformCheckout(
  prefix: string,
  opts: { version: string; platformId?: string; flatDatabase?: boolean },
): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  const health = {
    status: 'ok',
    version: opts.version,
    uptime_ms: 0,
    ...(opts.platformId === undefined ? {} : { platform_id: opts.platformId }),
  };
  const lines = [
    "import { createServer } from 'node:http';",
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const dataDir = process.env.PIGROUPS_DATA ?? '.';",
    ...(opts.flatDatabase === true
      ? ["writeFileSync(join(dataDir, 'pigroups.db'), 'a pre-0.3 platform wrote this flat database');"]
      : []),
    `const health = ${JSON.stringify(health)};`,
    'const port = Number(process.env.PORT);',
    'const server = createServer((req, res) => {',
    "  if (req.url === '/v1/health') {",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    '    res.end(JSON.stringify(health));',
    '    return;',
    '  }',
    "  if (req.url === '/v1/bootstrap') {",
    "    writeFileSync(join(dataDir, 'bootstrapped'), 'yes');",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    "    res.end(JSON.stringify({ member: { id: 'm_fake', name: 'fake' }, token: 'fake-token' }));",
    '    return;',
    '  }',
    "  res.writeHead(401, { 'content-type': 'application/json' });",
    "  res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }));",
    '});',
    "server.listen(port, '127.0.0.1', () => console.error('listening on ' + port));",
  ];
  await writeFile(join(dir, 'src', 'main.ts'), lines.join('\n'));
  return dir;
}

async function writeOrgRecord(
  adapterDir: string,
  key: string,
  record: Record<string, unknown>,
): Promise<string> {
  const orgDir = join(adapterDir, 'orgs', key);
  await mkdir(orgDir, { recursive: true });
  const file = join(orgDir, 'org.json');
  await writeFile(file, JSON.stringify(record, null, 2));
  return file;
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// F1: a moved data root must be followed, and a missing platform must not be
// re-created in an empty directory.
// ---------------------------------------------------------------------------

test('a record still on the old per-org data dir follows its platform into the shared root without bootstrapping', async (t) => {
  const adapterDir = await tempDir('pigroups-orgrepair-');
  t.after(() => cleanup(adapterDir));

  // Seed one real platform under the shared root, then stop it. Its record gives us
  // a real root token and a real platform_id to write into the old-layout record.
  const seed = await startOrg({ adapterDir, name: 'seed', platformDir: PLATFORM_DIR });
  const seedState = await readJson(seed.orgFile);
  process.kill(seed.pid, 'SIGTERM');
  await waitUntilGone(seed.url);
  await waitUntilProcessGone(seed.pid);

  const oldDefault = join(adapterDir, 'orgs', 'migrated', 'platform-data');
  const orgFile = await writeOrgRecord(adapterDir, 'migrated', {
    url: seed.url,
    token: seedState.token,
    admin_token: seedState.admin_token,
    pid: 999999,
    data_dir: oldDefault,
    platform_id: seedState.platform_id,
  });
  assert.equal(existsSync(oldDefault), false, 'the old per-org data dir is gone: its contents were moved');

  const started = await startOrg({ adapterDir, name: 'migrated', platformDir: PLATFORM_DIR });
  const state = await readJson(orgFile);

  assert.equal(resolve(started.dataDir), resolve(adapterDir, 'platform-data'), 'the platform came back from the shared root');
  assert.equal(resolve(state.data_dir), resolve(adapterDir, 'platform-data'), 'the record was rewritten to the shared root');
  assert.equal(state.platform_id, seedState.platform_id, 'the same platform instance was pinned');
  assert.equal(state.token, seedState.token, 'the recorded root token still works: no bootstrap replaced it');
  assert.equal(started.reattached, true, 'a moved platform is reattached, not re-created and bootstrapped');
});

test('a live platform on the shared root also moves a stale old-default record', async (t) => {
  const adapterDir = await tempDir('pigroups-orgrepair-');
  t.after(() => cleanup(adapterDir));

  const seed = await startOrg({ adapterDir, name: 'seed-live', platformDir: PLATFORM_DIR });
  const seedState = await readJson(seed.orgFile);
  const oldDefault = join(adapterDir, 'orgs', 'migrated-live', 'platform-data');
  const orgFile = await writeOrgRecord(adapterDir, 'migrated-live', {
    url: seed.url,
    token: seedState.token,
    admin_token: seedState.admin_token,
    pid: seed.pid,
    data_dir: oldDefault,
    platform_id: seedState.platform_id,
  });

  const started = await startOrg({ adapterDir, name: 'migrated-live', platformDir: PLATFORM_DIR });
  const state = await readJson(orgFile);

  assert.equal(started.reattached, true, 'the live platform was reattached');
  assert.equal(started.pid, seed.pid, 'no second platform was started');
  assert.equal(resolve(started.dataDir), resolve(adapterDir, 'platform-data'), 'the returned data dir is the shared root');
  assert.equal(resolve(state.data_dir), resolve(adapterDir, 'platform-data'), 'the record followed the moved database too');
  assert.equal(state.platform_id, seedState.platform_id, 'the platform id did not change');
});

test('a record on the old per-org data dir stays there when the shared root has no platform with that id', async (t) => {
  const adapterDir = await tempDir('pigroups-orgrepair-');
  t.after(() => cleanup(adapterDir));

  const platformId = 'p_0ld00001';
  const oldDefault = join(adapterDir, 'orgs', 'kept', 'platform-data');
  const seed = await startOrg({ adapterDir, name: 'seed-shared', platformDir: PLATFORM_DIR });
  const seedState = await readJson(seed.orgFile);
  process.kill(seed.pid, 'SIGTERM');
  await waitUntilGone(seed.url);
  await waitUntilProcessGone(seed.pid);

  // Put a different, older platform under the old default. The shared root only has
  // seedState.platform_id; it does not have platformId.
  const seeded = await spawnRealPlatform(oldDefault, platformId);
  const orgFile = await writeOrgRecord(adapterDir, 'kept', {
    url: seeded.url,
    token: seeded.token,
    admin_token: seeded.adminToken,
    pid: 999999,
    data_dir: oldDefault,
    platform_id: platformId,
  });
  await seeded.stop();

  const started = await startOrg({ adapterDir, name: 'kept', platformDir: PLATFORM_DIR });
  const state = await readJson(orgFile);

  assert.equal(resolve(started.dataDir), resolve(oldDefault), 'without a matching database in the shared root, the old dir is kept');
  assert.equal(resolve(state.data_dir), resolve(oldDefault), 'the record is not rewritten without a platform to follow');
  assert.equal(started.reattached, true, 'the platform in the old dir still answers with its token');
  assert.notEqual(state.platform_id, seedState.platform_id, 'the unrelated shared platform was not adopted');
});

test('a record naming a data dir with no database for its platform is refused, and the record is untouched', async (t) => {
  const adapterDir = await tempDir('pigroups-orgrepair-');
  const dataDir = await tempDir('pigroups-orgrepair-data-');
  t.after(() => cleanup(adapterDir, dataDir));

  const deadPort = await freePort();
  const platformId = 'p_m1ss0001';
  const orgFile = await writeOrgRecord(adapterDir, 'missing-db', {
    url: `http://127.0.0.1:${deadPort}`,
    token: 'old-token',
    admin_token: 'old-admin',
    pid: 999999,
    data_dir: dataDir,
    platform_id: platformId,
  });
  const before = await readFile(orgFile, 'utf8');
  const expectedDb = join(dataDir, 'platforms', platformId, 'pigroups.db');

  await assert.rejects(
    startOrg({ adapterDir, name: 'missing-db', platformDir: PLATFORM_DIR }),
    (err: Error) => {
      assert.ok(err.message.includes(dataDir), 'the error names the effective data dir');
      assert.ok(err.message.includes(expectedDb), 'the error names the database path it looked for');
      assert.match(err.message, /records platform_id p_m1ss0001/, 'the error names the recorded platform');
      assert.match(err.message, /does not exist/, 'the error says the database is absent');
      assert.match(err.message, /record says .*lives there|record.*says.*there/i, 'the error says the record and reality disagree');
      return true;
    },
  );

  assert.equal(await readFile(orgFile, 'utf8'), before, 'the refusal does not rewrite org.json');
  assert.equal(existsSync(join(dataDir, 'platforms')), false, 'no empty platform was created in the named directory');
});

// ---------------------------------------------------------------------------
// F2: a refused pre-0.3 platform leaves a flat database behind. Move it aside.
// ---------------------------------------------------------------------------

test('a pre-0.3 flat database created by this start is moved to refused-0.2.0-* and does not block the next 0.3 platform', async (t) => {
  const adapterDir = await tempDir('pigroups-orgrepair-');
  const dataDir = await tempDir('pigroups-orgrepair-data-');
  const checkout = await fakePlatformCheckout('pigroups-orgrepair-old-', {
    version: '0.2.0',
    flatDatabase: true,
  });
  t.after(() => cleanup(adapterDir, dataDir, checkout));

  await assert.rejects(
    startOrg({ adapterDir, name: 'debris', dataDir, platformDir: checkout }),
    (err: Error) => {
      assert.match(err.message, /does not report a platform_id/, 'the platform is refused for its missing id');
      assert.match(err.message, /refused-0\.2\.0-/, 'the error says where the debris was moved');
      return true;
    },
  );

  assert.equal(existsSync(join(dataDir, 'pigroups.db')), false, 'no flat pigroups.db remains in the data root');
  assert.equal(existsSync(join(dataDir, 'bootstrapped')), false, 'the refused platform was never bootstrapped');
  const refused = (await readdir(dataDir)).filter((name) => name.startsWith('refused-0.2.0-'));
  assert.equal(refused.length, 1, 'exactly one debris directory was made');
  assert.ok(existsSync(join(dataDir, refused[0]!, 'pigroups.db')), 'the database was moved, not deleted');

  const started = await startOrg({ adapterDir, name: 'after-debris', dataDir, platformDir: PLATFORM_DIR });
  const state = await readJson(started.orgFile);
  assert.match(String(state.platform_id), /^p_[0-9a-f]{8}$/, 'a normal 0.3 platform starts on the same data root');
  assert.ok(
    existsSync(join(dataDir, 'platforms', String(state.platform_id), 'pigroups.db')),
    'the next platform gets its own database under platforms/<id>/',
  );
});

test('an old flat database that was not created by this start is left exactly where it is', async (t) => {
  const adapterDir = await tempDir('pigroups-orgrepair-');
  const dataDir = await tempDir('pigroups-orgrepair-data-');
  const checkout = await fakePlatformCheckout('pigroups-orgrepair-old-', {
    version: '0.2.0',
    flatDatabase: false,
  });
  t.after(() => cleanup(adapterDir, dataDir, checkout));

  const oldDb = join(dataDir, 'pigroups.db');
  await writeFile(oldDb, 'a database from a previous run');
  const oldTime = new Date(Date.now() - 60_000);
  const { utimes } = await import('node:fs/promises');
  await utimes(oldDb, oldTime, oldTime);

  await assert.rejects(
    startOrg({ adapterDir, name: 'old-db', dataDir, platformDir: checkout }),
    (err: Error) => {
      assert.match(err.message, /does not report a platform_id/);
      assert.doesNotMatch(err.message, /refused-0\.2\.0-/, 'nothing was moved, so nothing is reported as moved');
      return true;
    },
  );

  assert.equal(await readFile(oldDb, 'utf8'), 'a database from a previous run', 'the pre-existing database is untouched');
});

// ---------------------------------------------------------------------------
// F3/F4: the platform must be the one we named, including for a brand-new org.
// ---------------------------------------------------------------------------

test('a new organisation whose platform reports a different id is refused before bootstrap and writes no record', async (t) => {
  const adapterDir = await tempDir('pigroups-orgrepair-');
  const dataDir = await tempDir('pigroups-orgrepair-data-');
  const checkout = await fakePlatformCheckout('pigroups-orgrepair-wrong-id-', {
    version: '0.3.0',
    platformId: 'p_22222222',
  });
  t.after(() => cleanup(adapterDir, dataDir, checkout));

  await assert.rejects(
    startOrg({ adapterDir, name: 'wrong-new', dataDir, platformDir: checkout }),
    (err: Error) => {
      assert.match(err.message, /p_22222222/, 'the error names the id the platform reported');
      assert.match(err.message, /p_[0-9a-f]{8}/, 'the error names the id the adapter asked for');
      assert.match(err.message, /asked for|requested/i, 'the error says the platform did not honour our id');
      return true;
    },
  );

  assert.equal(existsSync(join(adapterDir, 'orgs', 'wrong-new', 'org.json')), false, 'no record was written');
  assert.equal(existsSync(join(dataDir, 'bootstrapped')), false, 'the wrong platform never received a root');
});

test('a generated platform id that already has a directory is regenerated', async (t) => {
  const adapterDir = await tempDir('pigroups-orgrepair-');
  t.after(() => cleanup(adapterDir));

  const taken = 'p_00000000';
  await mkdir(join(adapterDir, 'platform-data', 'platforms', taken), { recursive: true });
  const ids = [taken, 'p_00000001'];
  const started = await startOrg({
    adapterDir,
    name: 'id-collision',
    platformDir: PLATFORM_DIR,
    platformIdSource: () => ids.shift() ?? 'p_00000002',
  });
  const state = await readJson(started.orgFile);

  assert.equal(state.platform_id, 'p_00000001', 'the occupied id was skipped and the next one was used');
  assert.equal(existsSync(join(adapterDir, 'platform-data', 'platforms', taken)), true, 'the occupied directory was not reused');
  assert.ok(
    existsSync(join(adapterDir, 'platform-data', 'platforms', 'p_00000001', 'pigroups.db')),
    'the platform was created under the regenerated id',
  );
});

// ---------------------------------------------------------------------------
// F5: a null/empty platform_id is an old record, not a broken one.
// ---------------------------------------------------------------------------

test('platform_id null or empty is read as "no id", not as a corrupt org record', async (t) => {
  const dir = await tempDir('pigroups-orgrepair-read-');
  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const [name, value] of [
    ['null', null],
    ['empty', ''],
  ] as Array<[string, string | null]>) {
    const file = join(dir, `${name}.json`);
    await writeFile(
      file,
      JSON.stringify({
        url: 'http://127.0.0.1:1',
        token: 'token',
        admin_token: 'admin',
        pid: 1,
        data_dir: join(dir, 'data'),
        platform_id: value,
      }),
    );

    const state = readOrgState(file);
    assert.ok(state !== undefined, `${name}: the record is readable`);
    assert.equal(state.platform_id, undefined, `${name}: no platform id is claimed`);
  }
});

// ---------------------------------------------------------------------------
// F6: one platform.log per organisation, beside its record.
// ---------------------------------------------------------------------------

test('each organisation writes platform.log beside org.json, not into the shared data root', async (t) => {
  const adapterDir = await tempDir('pigroups-orgrepair-');
  t.after(() => cleanup(adapterDir));

  const started = await startOrg({ adapterDir, name: 'log-beside-record', platformDir: PLATFORM_DIR });
  const beside = join(dirname(started.orgFile), 'platform.log');

  assert.ok(existsSync(beside), 'the log is in <adapterDir>/orgs/<key>/platform.log');
  assert.equal(existsSync(join(started.dataDir, 'platform.log')), false, 'the shared data root has no mixed log');
});

// ---------------------------------------------------------------------------
// F7: 0.2 is outside the supported list, and START refuses it with a way out.
// ---------------------------------------------------------------------------

test('a 0.2 platform is refused at START with an actionable upgrade path, not warned past', async (t) => {
  const adapterDir = await tempDir('pigroups-orgrepair-');
  const dataDir = await tempDir('pigroups-orgrepair-data-');
  const checkout = await fakePlatformCheckout('pigroups-orgrepair-020-', { version: '0.2.0' });
  t.after(() => cleanup(adapterDir, dataDir, checkout));

  await assert.rejects(
    startOrg({ adapterDir, name: 'old-start', dataDir, platformDir: checkout }),
    (err: Error) => {
      assert.match(err.message, /does not report a platform_id/, 'the refusal is grounded in the missing id');
      assert.match(err.message, /0\.3\.0/, 'the error names the minimum platform line');
      assert.match(err.message, /Point PIGROUPS_PLATFORM_DIR at a 0\.3\.0 checkout/i, 'the remedy names what to upgrade');
      assert.doesNotMatch(err.message, /will continue/, 'START does not warn and continue');
      return true;
    },
  );

  assert.equal(existsSync(join(adapterDir, 'orgs', 'old-start', 'org.json')), false, 'the refused org has no record');
});

// ---------------------------------------------------------------------------
// A real platform with an explicit id/data dir, used by F1's "do not migrate" case.
// ---------------------------------------------------------------------------

interface SeededPlatform {
  url: string;
  pid: number;
  token: string;
  adminToken: string;
  stop(): Promise<void>;
}

async function spawnRealPlatform(dataDir: string, platformId: string): Promise<SeededPlatform> {
  await mkdir(dataDir, { recursive: true });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const adminToken = 'seed-admin-token';
  const child = spawn(process.execPath, [join(PLATFORM_DIR, 'src', 'main.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      PIGROUPS_DATA: dataDir,
      PIGROUPS_PLATFORM_ID: platformId,
      PIGROUPS_ADMIN_TOKEN: adminToken,
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 8000;
  while (!(await answers(url))) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('the seed platform did not start');
    }
    await delay(25);
  }
  const response = await fetch(`${url}/v1/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'seed-root' }),
  });
  assert.equal(response.status, 200, 'the seed platform bootstrapped');
  const body = (await response.json()) as { token: string };
  const pid = child.pid;
  if (pid === undefined) throw new Error('the seed platform has no pid');
  return {
    url,
    pid,
    token: body.token,
    adminToken,
    async stop(): Promise<void> {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      await waitUntilGone(url).catch(() => undefined);
      await waitUntilProcessGone(pid).catch(() => undefined);
    },
  };
}

// A test process that dies mid-run leaves its platforms behind. Clean up only the
// ones whose PIGROUPS_DATA points at this file's temporary prefix.
after(async () => {
  const entries = await readdir('/proc').catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const environ = await readFile(`/proc/${entry}/environ`, 'utf8').catch(() => '');
    if (!environ.includes('PIGROUPS_DATA=/tmp/pigroups-orgrepair-')) continue;
    try {
      process.kill(Number(entry), 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
});
