// 设计说明 §12: respawn reopens a member whose platform row is still alive but whose
// process is gone. Herdr pane presence is the only running evidence; it never reissues
// a token, never starts a second process, and never brings back a terminated member.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeChildRecord, writeMemberSessionFile } from '../src/records.ts';
import { PgUnavailable } from '../src/pgclient.ts';
import type { ChildRecord } from '../src/records.ts';
import { scenario, pollUntil } from './scenario.ts';
import type { Scenario } from './scenario.ts';
import { command, createMember, delay, member, poll, quiet, removeMember, waitFor, whoami, within } from './support.ts';
import type { MemberRef, Platform } from './support.ts';

async function childOf(s: Scenario, name: string): Promise<MemberRef> {
  return createMember(s.platform, s.me, name);
}

function recordFor(s: Scenario, child: MemberRef, overrides: Partial<ChildRecord> = {}): ChildRecord {
  return {
    parentId: s.me.id,
    childId: child.id,
    name: child.name,
    cwd: '/tmp/child-cwd',
    args: ['--model', 'vendor/model'],
    token: child.token,
    intent: 'spawned',
    ...overrides,
  };
}

function controlsOf(platform: Platform, token: string) {
  return poll(platform, token, { wait: 0, types: 'control' });
}

function lockPath(s: Scenario, childId: string): string {
  return join(s.adapterDir, 'respawn', `${childId}.lock`);
}

async function writeLock(s: Scenario, childId: string, pid: number, at: number): Promise<void> {
  const dir = join(s.adapterDir, 'respawn');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(lockPath(s, childId), JSON.stringify({ pid, at }), { mode: 0o600 });
}

function deadPid(): number {
  return 2_147_483_647;
}

test('respawn skips a gone member and says its identity cannot be restored', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const gone = await childOf(s, 'gone-child');
  await removeMember(s.platform, s.me.token, gone.id);
  writeChildRecord(s.adapterDir, recordFor(s, gone));

  const result = await s.loop.respawn();

  assert.deepEqual(result.restarted, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.id, gone.id);
  assert.match(result.skipped[0]!.reason, /gone|identity|cannot/i);
  assert.equal(s.herdr.spawns.length, 0, 'a gone member is never started');
});

test('respawn skips a terminated record, because terminate must not become "start later"', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const child = await childOf(s, 'terminated-child');
  writeChildRecord(s.adapterDir, recordFor(s, child, { intent: 'terminated' }));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/terminated.jsonl');

  const result = await s.loop.respawn();

  assert.deepEqual(result.restarted, [], 'the process is not restarted');
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.id, child.id);
  assert.match(result.skipped[0]!.reason, /terminated/i);
  assert.equal(s.herdr.spawns.length, 0);
});

test('a pane running the child session is already running: control only', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const child = await childOf(s, 'pane-child');
  const sessionFile = '/tmp/pigroups-child/pane.jsonl';
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, sessionFile);
  s.herdr.paneList.push({
    pane_id: 'pane-already-running',
    agent_status: 'idle',
    agent_session: { kind: 'path', source: 'herdr:pi', value: sessionFile },
  });

  const result = await s.loop.respawn();

  assert.deepEqual(result.alreadyRunning, [child.id]);
  assert.deepEqual(result.restarted, []);
  assert.equal(s.herdr.spawns.length, 0, 'a pane running that session is never given a second process');
  const controls = await controlsOf(s.platform, child.token);
  assert.ok(
    controls.items.some((item) => item.kind === 'control' && item.cmd === 'pg.respawn'),
    'the running child is asked to fix its own layer',
  );
});
test('a scoped respawn still skips a terminated record', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await childOf(s, 'terminated-scoped');
  writeChildRecord(s.adapterDir, recordFor(s, child, { intent: 'terminated' }));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/terminated-scoped.jsonl');

  const result = await s.loop.respawn(child.id);
  assert.deepEqual(result.restarted, []);
  assert.ok(result.skipped.some((entry) => entry.id === child.id && /terminated/i.test(entry.reason)));
  assert.equal(s.herdr.spawns.length, 0, 'the tombstone is absolute');
});

test('a shell pane without an agent session is started beside, not closed', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await childOf(s, 'shell-child');
  const sessionFile = '/tmp/pigroups-child/shell.jsonl';
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, sessionFile);
  s.herdr.paneList.push({ pane_id: 'shell-pane', agent_status: 'unknown' });

  const result = await s.loop.respawn();
  assert.deepEqual(result.restarted, [child.id]);
  assert.equal(s.herdr.spawns.length, 1);
  assert.deepEqual(s.herdr.closed, [], 'the shell is not the child and is not closed');
});

test('a transient getMember failure still uses the pane list', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await childOf(s, 'transient-child');
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/pigroups-child/transient.jsonl');
  const realGetMember = s.pg.getMember.bind(s.pg);
  let first = true;
  s.pg.getMember = async (id) => {
    if (first) {
      first = false;
      throw new PgUnavailable(1, 'transient');
    }
    return realGetMember(id);
  };

  const result = await s.loop.respawn();
  assert.deepEqual(result.restarted, [child.id]);
  assert.equal(s.herdr.spawns.length, 1);
});

test('the automatic settle starts at the first successful whoami, not at construction', async (t) => {
  const s = await scenario({ role: 'root', autoRespawn: true, respawnGraceMs: 30_000 });
  t.after(() => s.close());
  const realWhoami = s.pg.whoami.bind(s.pg);
  s.pg.whoami = async () => {
    s.clock.advance(25_000);
    return realWhoami();
  };
  const child = await childOf(s, 'late-connect-child');
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/pigroups-child/late.jsonl');

  await s.loop.pollOnce();
  assert.equal(s.herdr.spawns.length, 0, 'the settle begins after the late whoami');

  s.clock.advance(29_000); // t=54s, still inside 25s + 30s
  s.loop.tick();
  assert.equal(s.herdr.spawns.length, 0, 'the settle is measured from the successful connection');

  s.clock.advance(2_000); // t=56s
  s.loop.tick();
  await waitFor(() => s.herdr.spawns.length === 1, 'the automatic pass after the real settle');
});

test('a pg.respawn control during the settle defers; the manual tool is immediate', async (t) => {
  const s = await scenario({ role: 'child', respawnGraceMs: 5_000 });
  t.after(() => s.close());
  const child = await childOf(s, 'control-settle');
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/pigroups-child/control-settle.jsonl');

  await command(s.platform, s.parent!.token, s.me.id, 'pg.respawn', { v: 1 });
  await s.loop.pollOnce();
  assert.equal(s.herdr.spawns.length, 0, 'the control only sends the next control during the settle');

  s.clock.advance(5_001);
  s.loop.tick();
  await waitFor(() => s.herdr.spawns.length === 1, 'the deferred control to start after the settle');
});
test('a stale member with no session file is reported as unreopenable, not guessed', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const child = await childOf(s, 'stale-no-file');
  writeChildRecord(s.adapterDir, recordFor(s, child));

  const result = await s.loop.respawn();

  assert.deepEqual(result.restarted, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.id, child.id);
  assert.match(result.skipped[0]!.reason, /session/i);
  assert.match(result.skipped[0]!.reason, /cannot|unreopen|reopen/i);
  assert.equal(s.herdr.spawns.length, 0);
});

test('a stale member with a session file is started once with --session, then told to recurse', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const child = await childOf(s, 'stale-with-file');
  const sessionFile = '/tmp/pigroups-child/stale-with-file.jsonl';
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, sessionFile);

  const result = await s.loop.respawn();

  assert.deepEqual(result.restarted, [child.id]);
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(s.herdr.spawns.length, 1, 'exactly one process is started');
  const spawn = s.herdr.spawns[0]!;
  assert.deepEqual(
    spawn.args,
    ['--session', sessionFile, '--model', 'vendor/model'],
    '--session comes before the caller args, so a `--` in those args cannot turn it into a positional',
  );
  assert.equal(spawn.cwd, '/tmp/child-cwd');
  assert.equal(spawn.env.PIGROUPS_URL, s.platform.url);
  assert.equal(spawn.env.PIGROUPS_TOKEN, child.token, 'the recorded token is reused; it is never reissued');
  assert.equal(spawn.env.PIGROUPS_ADAPTER_DIR, s.adapterDir);
  assert.equal(spawn.env.PIGROUPS_SPAWN_CMD, 'pi');

  const detail = await member(s.platform, s.me.token, child.id);
  assert.notEqual(detail.last_seen_at, null, 'D1 advanced');

  const controls = await controlsOf(s.platform, child.token);
  assert.ok(
    controls.items.some((item) => item.kind === 'control' && item.cmd === 'pg.respawn'),
    'the restarted child is asked to fix its own layer',
  );
});

test('two respawn calls start one process, never two', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const child = await childOf(s, 'idempotent-child');
  const sessionFile = '/tmp/pigroups-child/idempotent.jsonl';
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, sessionFile);

  const [first, second] = await Promise.all([s.loop.respawn(), s.loop.respawn()]);
  assert.equal(s.herdr.spawns.length, 1, 'concurrent calls share the in-process start marker');

  const third = await s.loop.respawn();
  assert.equal(s.herdr.spawns.length, 1, 'a later call sees last_seen_at or the start marker, not a new process');
  assert.ok(
    [...first.alreadyRunning, ...second.alreadyRunning, ...third.alreadyRunning].includes(child.id),
    'the repeated calls report the member as already running',
  );
});

test('pg.respawn from a non-parent is ignored and starts nothing', async (t) => {
  const s = await scenario({ role: 'child', siblings: 1 });
  t.after(() => s.close());

  const child = await childOf(s, 'would-restart');
  const sessionFile = '/tmp/pigroups-child/would-restart.jsonl';
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, sessionFile);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  const sibling = s.siblings[0]!;
  await command(s.platform, sibling.token, s.me.id, 'pg.respawn', { v: 1 });
  await s.loop.pollOnce();
  await quiet(300);

  assert.equal(s.herdr.spawns.length, 0, 'a sibling cannot make this member reopen anything');
  assert.ok(
    warnings.some((warning) => /ignored pg\.respawn/i.test(warning)),
    `expected an ignored-control warning, got ${JSON.stringify(warnings)}`,
  );
  const queued = await controlsOf(s.platform, child.token);
  assert.equal(queued.items.length, 0, 'nothing is forwarded to the child either');
});

test('pg.respawn from the direct parent runs this layer without injecting context', async (t) => {
  const s = await scenario({ role: 'child', respawnGraceMs: 0 });
  t.after(() => s.close());

  const child = await childOf(s, 'parent-triggered');
  const sessionFile = '/tmp/pigroups-child/parent-triggered.jsonl';
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, sessionFile);

  await command(s.platform, s.parent!.token, s.me.id, 'pg.respawn', { v: 1 });
  await s.loop.pollOnce();
  await waitFor(() => s.herdr.spawns.length === 1, 'the trusted control to start the stale child');

  assert.deepEqual(s.herdr.spawns[0]!.args, ['--session', sessionFile, '--model', 'vendor/model']);
  assert.deepEqual(s.surface.textsOfKind('control'), [], 'a respawn control is acted on, never shown to the model');
});

test('startup respawn runs when enabled and stays off when disabled', async (t) => {
  const enabled = await scenario({ role: 'root', autoRespawn: true, respawnGraceMs: 0 });
  t.after(() => enabled.close());
  const child = await childOf(enabled, 'auto-child');
  writeChildRecord(enabled.adapterDir, recordFor(enabled, child));
  writeMemberSessionFile(enabled.adapterDir, child.id, '/tmp/pigroups-child/auto.jsonl');

  await enabled.loop.pollOnce();
  await waitFor(() => enabled.herdr.spawns.length === 1, 'automatic respawn to start the child');
  await enabled.loop.pollOnce();
  await quiet(200);
  assert.equal(enabled.herdr.spawns.length, 1, 'the automatic run happens once per startup');

  const disabled = await scenario({ role: 'root', autoRespawn: false });
  t.after(() => disabled.close());
  const other = await childOf(disabled, 'manual-child');
  writeChildRecord(disabled.adapterDir, recordFor(disabled, other));
  writeMemberSessionFile(disabled.adapterDir, other.id, '/tmp/pigroups-child/manual.jsonl');

  await disabled.loop.pollOnce();
  await quiet(400);
  assert.equal(disabled.herdr.spawns.length, 0, 'the switch really turns the startup path off');
});

// F1: children/ is shared by every member on the machine. A record belongs to this
// member only when it says so; otherwise A would reopen B's child and register its pane,
// which also lets B's child through `isKnownDirectChild`.
test('respawn only touches child records whose parentId is this member', async (t) => {
  const s = await scenario({ role: 'child', siblings: 1 });
  t.after(() => s.close());

  const otherParent = s.siblings[0]!;
  const notMine = await createMember(s.platform, otherParent, 'other-parents-child');
  writeChildRecord(s.adapterDir, recordFor(s, notMine, { parentId: otherParent.id }));
  writeMemberSessionFile(s.adapterDir, notMine.id, '/tmp/pigroups-child/not-mine.jsonl');

  const result = await s.loop.respawn();

  assert.equal(s.herdr.spawns.length, 0, 'another member\'s child is never started by this one');
  assert.deepEqual(result.restarted, []);
  const controls = await controlsOf(s.platform, notMine.token);
  assert.equal(controls.items.length, 0, 'and it is not told to repair a layer it does not own');
});

test('pg_respawn(scope) rejects an id that is not this member\'s direct child', async (t) => {
  const s = await scenario({ role: 'child', siblings: 1 });
  t.after(() => s.close());

  const otherParent = s.siblings[0]!;
  const notMine = await createMember(s.platform, otherParent, 'other-scoped-child');
  writeChildRecord(s.adapterDir, recordFor(s, notMine, { parentId: otherParent.id }));
  writeMemberSessionFile(s.adapterDir, notMine.id, '/tmp/pigroups-child/other-scoped.jsonl');

  const result = await s.loop.respawn(notMine.id);

  assert.equal(s.herdr.spawns.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]!.id, notMine.id);
  assert.match(result.skipped[0]!.reason, /direct child/i, 'the answer names the trust boundary');
});

// C: time cannot tell "not started" from "just started"; a herdr pane can. The
// automatic path asks `pane list` before it starts anything.
test('automatic respawn sends controls during the settle and starts after it', async (t) => {
  const s = await scenario({ role: 'root', autoRespawn: true, respawnGraceMs: 5_000 });
  t.after(() => s.close());

  const child = await childOf(s, 'fact-child');
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/pigroups-child/fact.jsonl');

  await s.loop.pollOnce();
  assert.equal(s.herdr.spawns.length, 0, 'the settle sends only the control');
  const control = await pollUntil(s.platform, child.token, 'pg.respawn');
  assert.equal(control.cmd, 'pg.respawn', 'the child is told to repair its own layer during the settle');

  s.clock.advance(5_001);
  s.loop.tick();
  await waitFor(() => s.herdr.spawns.length === 1, 'the automatic pass to start after the settle');
  assert.deepEqual(s.herdr.spawns[0]!.args, ['--session', '/tmp/pigroups-child/fact.jsonl', '--model', 'vendor/model']);
});
test('automatic respawn treats a pane already running that session as already running', async (t) => {
  const s = await scenario({ role: 'root', autoRespawn: true, respawnGraceMs: 0 });
  t.after(() => s.close());

  const child = await childOf(s, 'pane-child');
  const sessionFile = '/tmp/pigroups-child/pane.jsonl';
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, sessionFile);
  s.herdr.paneList.push({
    pane_id: 'pane-already-running',
    agent_status: 'idle',
    agent_session: { kind: 'path', source: 'herdr:pi', value: sessionFile },
  });

  await s.loop.pollOnce();
  const control = await pollUntil(s.platform, child.token, 'pg.respawn');

  assert.equal(control.cmd, 'pg.respawn', 'the running child is told to repair its own layer');
  assert.equal(s.herdr.spawns.length, 0, 'a pane running that session is never given a second process');
});

// C: an unreadable pane list is not evidence of absence. The automatic path may send
// the control, but it must never start a process while herdr cannot answer.
test('automatic respawn never starts a child while herdr cannot list panes', async (t) => {
  const s = await scenario({ role: 'root', autoRespawn: true, respawnGraceMs: 5_000 });
  t.after(() => s.close());

  const child = await childOf(s, 'herdr-down-child');
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/pigroups-child/herdr-down.jsonl');
  s.herdr.failListPanes = new Error('herdr is not running');

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  await s.loop.pollOnce();
  await waitFor(
    () => warnings.some((warning) => /startup settle/i.test(warning)),
    'the settle notification to be sent',
  );
  assert.equal(s.herdr.spawns.length, 0, 'inside the settle the automatic path only sends the control');

  s.clock.advance(5_001);
  s.loop.tick();
  await waitFor(
    () => warnings.some((warning) => /could not list panes|answer is unknown/i.test(warning)),
    'the unreadable pane list to be reported by the repair path',
  );
  await delay(200);
  assert.equal(s.herdr.spawns.length, 0, 'an unreadable pane list never starts a process, even after the grace');
});

// §12.5 says the grace is for the *automatic* path ("只通报、不起进程"); a person who
// called `pg_respawn` asked for the repair, so the tool must act even inside the grace.
test('an explicit respawn starts the child even inside the startup grace period', async (t) => {
  const s = await scenario({ role: 'root', autoRespawn: false, respawnGraceMs: 5_000 });
  t.after(() => s.close());

  const child = await childOf(s, 'manual-child');
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/pigroups-child/manual.jsonl');

  // No clock advance: the loop is still inside its own startup grace.
  const result = await s.loop.respawn();

  assert.equal(s.herdr.spawns.length, 1, 'the explicit call must start the child immediately');
  assert.deepEqual(result.restarted, [child.id]);
  assert.deepEqual(result.skipped, [], 'nothing is skipped for the grace when a person asked');
});

// F3: two parent processes can both see a stale last_seen_at. The lock is the only
// cross-process guard; without it both start the same session and the token's cursor
// is split or its injection watermark overwritten.
test('a fresh live lock makes respawn skip the start', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const child = await childOf(s, 'locked-child');
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/pigroups-child/locked.jsonl');
  await writeLock(s, child.id, process.pid, s.clock.now());

  const result = await s.loop.respawn();

  assert.equal(s.herdr.spawns.length, 0, 'another process is already starting it');
  assert.ok(
    result.skipped.some((entry) => entry.id === child.id && /another process/i.test(entry.reason)),
    `expected an "another process" skip, got ${JSON.stringify(result)}`,
  );
  assert.ok(existsSync(lockPath(s, child.id)), 'the live lock belongs to the other process; this one does not remove it');
});

test('a stale or dead lock is removed and the start proceeds', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const expired = await childOf(s, 'expired-lock');
  writeChildRecord(s.adapterDir, recordFor(s, expired));
  writeMemberSessionFile(s.adapterDir, expired.id, '/tmp/pigroups-child/expired.jsonl');
  await writeLock(s, expired.id, process.pid, s.clock.now() - 300_001);

  let sawLock: { mode: number; body: { pid: number; at: number } } | undefined;
  s.herdr.onSpawn = async () => {
    const path = lockPath(s, expired.id);
    const info = await stat(path);
    sawLock = { mode: info.mode & 0o777, body: JSON.parse(await readFile(path, 'utf8')) };
  };
  const first = await s.loop.respawn();
  assert.deepEqual(first.restarted, [expired.id]);
  assert.equal(s.herdr.spawns.length, 1);
  assert.deepEqual(sawLock?.body, { pid: process.pid, at: s.clock.now() });
  assert.equal(sawLock?.mode, 0o600, 'the lock carries a pid, so it is private like every other token file');
  assert.equal(existsSync(lockPath(s, expired.id)), false, 'the lock is removed after the start completes');

  s.herdr.onSpawn = undefined;
  const dead = await childOf(s, 'dead-lock');
  writeChildRecord(s.adapterDir, recordFor(s, dead));
  writeMemberSessionFile(s.adapterDir, dead.id, '/tmp/pigroups-child/dead.jsonl');
  await writeLock(s, dead.id, deadPid(), s.clock.now());
  const second = await s.loop.respawn();
  assert.deepEqual(second.restarted, [dead.id], 'a lock held by a dead pid is not a lock');
  assert.equal(s.herdr.spawns.length, 2);
});

// F4: a failed start used to become a permanent "already running" marker, so the
// member could never be repaired by this process again.
test('a failed start is retried on the next explicit call', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const child = await childOf(s, 'retry-child');
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/pigroups-child/retry.jsonl');

  s.herdr.failSpawn = new Error('herdr tab create failed');
  const first = await s.loop.respawn();
  assert.deepEqual(first.restarted, []);
  assert.equal(first.failed.length, 1);
  assert.equal(first.failed[0]!.id, child.id);
  assert.match(first.failed[0]!.error, /tab create failed/);
  assert.equal(existsSync(lockPath(s, child.id)), false, 'a failed attempt leaves no lock behind');

  s.herdr.failSpawn = undefined;
  const second = await s.loop.respawn();
  assert.deepEqual(second.restarted, [child.id], 'the next explicit call retries immediately');
  assert.equal(s.herdr.spawns.length, 2, 'the failed attempt and the successful retry are both observed');
});
test('the respawn deadline follows the injected clock, not wall time', async (t) => {
  const s = await scenario({ role: 'root', spawnReadyMs: 60_000 });
  t.after(() => s.close());
  s.herdr.authenticate = false;

  const child = await childOf(s, 'clock-deadline');
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/pigroups-child/clock-deadline.jsonl');

  const pending = s.loop.respawn();
  await waitFor(() => s.herdr.spawns.length === 1, 'the child to be started before the clock is moved');
  s.clock.advance(60_001);
  const result = await within(pending, 'the wait to end when the injected clock crosses spawnReadyMs', 2_000);

  assert.equal(result.failed.length, 1, 'the child never authenticated, so the attempt fails');
  assert.deepEqual(s.herdr.closed, ['pane-1'], 'the failed attempt closes the pane it created');
});

test('a start that fails after creating a pane closes it', async (t) => {
  const s = await scenario({ role: 'root', spawnReadyMs: 0 });
  t.after(() => s.close());
  s.herdr.authenticate = false;

  const child = await childOf(s, 'close-on-failure');
  writeChildRecord(s.adapterDir, recordFor(s, child));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/pigroups-child/failing.jsonl');

  const result = await s.loop.respawn();

  assert.equal(result.failed.length, 1);
  assert.deepEqual(s.herdr.closed, ['pane-1'], 'the pane a failed attempt created does not outlive the attempt');
});

// F8: the automatic and control paths run in the background, so their skips must be
// logged there too. The warning is once per (record, reason) per process: startup runs
// on every session start and must not fill the log with the same tombstone.
test('a background respawn warns about skipped records once per process', async (t) => {
  const s = await scenario({ role: 'child' });
  t.after(() => s.close());

  const child = await childOf(s, 'tombstoned');
  writeChildRecord(s.adapterDir, recordFor(s, child, { intent: 'terminated' }));
  writeMemberSessionFile(s.adapterDir, child.id, '/tmp/pigroups-child/tombstoned.jsonl');

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  const runControl = async (): Promise<void> => {
    await command(s.platform, s.parent!.token, s.me.id, 'pg.respawn', { v: 1 });
    await s.loop.pollOnce();
  };

  try {
    await runControl();
    await waitFor(
      () => warnings.some((warning) => /skipped.*terminated|terminated.*skipped/i.test(warning)),
      'the background path to log the skip',
    );
    await runControl();
    await quiet(300);
    assert.equal(
      warnings.filter((warning) => /skipped.*terminated|terminated.*skipped/i.test(warning)).length,
      1,
      'the same skip is not logged again on the next automatic/control run',
    );
  } finally {
    console.warn = originalWarn;
  }

  const explicit = await s.loop.respawn();
  assert.equal(explicit.skipped.length, 1, 'the tool result still carries skipped entries');
  assert.equal(explicit.skipped[0]!.id, child.id);
});
