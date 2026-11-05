// §5.4 (0.13.0): liveness is observed, not announced. The member feeds a heartbeat;
// the parent judges death by heartbeat absence plus the pane list. `gone` is no longer
// an attention state, and an automatic repair reports its own outcome.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLocalMinute } from '../src/format.ts';
import { writeChildRecord, writeMemberSessionFile } from '../src/records.ts';

import {
  command,
  createMember,
  delay,
  heartbeat,
  member,
  quiet,
  send,
  waitFor,
} from './support.ts';
import type { MemberRef } from './support.ts';
import {
  DEFAULT_DELIVERY_WINDOW_MS as WINDOW,
  scenario,
  type Scenario,
} from './scenario.ts';

async function heartbeatAt(s: Scenario, id: string): Promise<number | null> {
  return (await member(s.platform, s.me.token, id)).heartbeat_at;
}

async function waitForHeartbeatAfter(s: Scenario, id: string, previous: number | null): Promise<number> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = await heartbeatAt(s, id);
    if (value !== null && (previous === null || value > previous)) return value;
    if (Date.now() > deadline) throw new Error(`no heartbeat after ${previous} for ${id}`);
    await delay(10);
  }
}

function captureWarnings(t: { after(fn: () => void): void }): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = original;
  });
  return warnings;
}

/** Close delivery windows until at least `count` queued `[repair]` lines reach the surface. */
async function waitForRepairs(s: Scenario, id: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const lines = s.surface
      .textsOfKind('nudge')
      .filter((text) => text.includes('[repair]') && text.includes(id));
    if (lines.length >= count) return lines;
    if (Date.now() > deadline) {
      throw new Error(`fewer than ${count} [repair] lines for ${id}: ${JSON.stringify(s.surface.texts())}`);
    }
    s.clock.advance(WINDOW);
    s.loop.tick();
    await delay(20);
    await s.loop.flush();
  }
}

async function waitForRepair(s: Scenario, id: string): Promise<string> {
  return (await waitForRepairs(s, id, 1))[0]!;
}

async function recordedChild(
  s: Scenario,
  name: string,
  sessionFile = `/tmp/pigroups-heartbeat/${name}.jsonl`,
): Promise<{ child: MemberRef; sessionFile: string }> {
  const child = await createMember(s.platform, s.me, name);
  writeChildRecord(s.adapterDir, {
    parentId: s.me.id,
    childId: child.id,
    name: child.name,
    cwd: null,
    args: [],
    token: child.token,
    intent: 'spawned',
  });
  writeMemberSessionFile(s.adapterDir, child.id, sessionFile);
  return { child, sessionFile };
}

async function staleChild(
  s: Scenario,
  name: string,
): Promise<{ child: MemberRef; heartbeatAt: number; sessionFile: string }> {
  const { child, sessionFile } = await recordedChild(s, name);
  s.clock.set(Date.now());
  const beat = await heartbeat(s.platform, child.token, child.id);
  s.clock.advance((s.config.heartbeatMs ?? 15_000) * (s.config.heartbeatMiss ?? 3) + 1_000);
  return { child, heartbeatAt: beat.heartbeat_at, sessionFile };
}

test('the loop feeds a heartbeat at the configured cadence and not more often', async (t) => {
  const s = await scenario({ heartbeatMs: 1_000 });
  t.after(() => s.close());
  await s.cycle(); // identity is known before a heartbeat can name it
  s.clock.set(Date.now());

  s.loop.tick();
  const first = await waitForHeartbeatAfter(s, s.me.id, null);

  s.loop.tick();
  await delay(50);
  assert.equal(await heartbeatAt(s, s.me.id), first, 'a tick inside the interval sends nothing');

  s.clock.advance(999);
  s.loop.tick();
  await delay(50);
  assert.equal(await heartbeatAt(s, s.me.id), first, '999 ms is still inside the 1 s interval');

  await delay(5);
  s.clock.advance(1);
  s.loop.tick();
  const second = await waitForHeartbeatAfter(s, s.me.id, first);
  assert.ok(second > first, 'the next interval really wrote a new heartbeat_at');
});

test('a heartbeat failure warns once per distinct error and the loop keeps working', async (t) => {
  const s = await scenario({ heartbeatMs: 1_000 });
  t.after(() => s.close());
  await s.cycle();
  s.clock.set(Date.now());
  const warnings = captureWarnings(t);

  s.pg.heartbeat = async () => {
    throw new Error('heartbeat route is down');
  };

  s.loop.tick();
  await waitFor(() => warnings.some((line) => /heartbeat/i.test(line)), 'the heartbeat failure to be warned');
  s.clock.advance(1_000);
  s.loop.tick();
  await delay(100);
  assert.equal(
    warnings.filter((line) => /heartbeat/i.test(line) && /route is down/.test(line)).length,
    1,
    `one warning for one distinct failure: ${JSON.stringify(warnings)}`,
  );

  const mark = s.surface.mark();
  const body = 'the loop still delivers after a heartbeat failure';
  await send(s.platform, s.parent!.token, s.me.id, body);
  await s.cycle();
  await s.timer(WINDOW);
  assert.ok(
    s.surface.since(mark).some((delivery) => delivery.text.includes(body)),
    `delivery still works: ${JSON.stringify(s.surface.since(mark))}`,
  );
});

test('an old-style pg.attention gone is dropped with one warn per child and never enters a summary', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'old-child');
  await s.cycle(); // the startup roster now names the child, so the claim reaches applyAttention
  const warnings = captureWarnings(t);

  const gone = {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'gone',
    since: Date.now(),
    note: 'exiting',
  };
  await command(s.platform, child.token, s.me.id, 'pg.attention', gone);
  // A retry of the same claim (or a second exit report from the same child) is not news.
  await command(s.platform, child.token, s.me.id, 'pg.attention', gone);
  await s.cycle();

  const row = (await s.loop.children()).find((entry) => entry.id === child.id);
  assert.equal(row?.state, 'ok', `gone is no longer a state: ${JSON.stringify(row)}`);
  assert.equal(row?.states.some((state) => (state.state as string) === 'gone'), false);
  const dropped = warnings.filter((line) => line.includes(child.id) && /gone/.test(line));
  assert.equal(dropped.length, 1, `exactly one warning: ${JSON.stringify(warnings)}`);

  await s.timer(0);
  await s.timer(WINDOW);
  assert.equal(
    s.surface.texts().some((text) => text.includes(child.id) && /gone/.test(text)),
    false,
    `a dropped claim never reaches a summary: ${JSON.stringify(s.surface.texts())}`,
  );
});

test('a stale heartbeat with no pane is treated as dead, restarted, and reported with its heartbeat time', async (t) => {
  const s = await scenario({
    role: 'root',
    autoRespawn: true,
    heartbeatMs: 1_000,
    heartbeatMiss: 3,
    respawnFreshMs: 1_000,
  });
  t.after(() => s.close());
  await s.cycle(); // startup runs before the recorded child exists
  const { child, heartbeatAt: beatAt, sessionFile } = await staleChild(s, 'stale-worker');

  await s.cycle();
  await waitFor(() => s.herdr.spawns.length === 1, 'the stale child to be restarted');
  assert.deepEqual((s.herdr.spawns[0]!.args ?? []).slice(0, 2), ['--session', sessionFile]);

  const line = await waitForRepair(s, child.id);
  assert.match(line, /^\[repair\] /, `the repair reports itself: ${line}`);
  assert.ok(line.includes(child.id), `the line names the child: ${line}`);
  assert.ok(line.includes(child.name), `the line carries the name: ${line}`);
  assert.ok(
    line.includes(`no heartbeat since ${formatLocalMinute(beatAt)}`),
    `the line carries the heartbeat time ${formatLocalMinute(beatAt)}: ${line}`,
  );
  assert.match(line, /; restarted \d{2}:\d{2}$/, `the line carries the restart time: ${line}`);
});

test('a stale heartbeat with a live pane is quiet, not restarted', async (t) => {
  const s = await scenario({
    role: 'root',
    autoRespawn: true,
    heartbeatMs: 1_000,
    heartbeatMiss: 3,
    respawnFreshMs: 1_000,
  });
  t.after(() => s.close());
  await s.cycle();
  const { child, sessionFile } = await staleChild(s, 'quiet-worker');
  s.herdr.paneList.push({
    pane_id: 'pane-quiet-worker',
    agent_status: 'idle',
    agent_session: { kind: 'path', source: 'herdr:pi', value: sessionFile },
  });

  await s.cycle();
  await quiet(300);

  assert.equal(s.herdr.spawns.length, 0, 'a live pane is the child still running');
  await s.timer(WINDOW);
  assert.equal(
    s.surface.textsOfKind('nudge').some((text) => text.includes('[repair]') && text.includes(child.id)),
    false,
    `a quiet child is not a repair: ${JSON.stringify(s.surface.texts())}`,
  );
});

test('a child with a newer last_seen_at than heartbeat is running, not restarted', async (t) => {
  const s = await scenario({ role: 'root', autoRespawn: false, respawnFreshMs: 30_000 });
  t.after(() => s.close());
  await s.cycle();
  const { child } = await recordedChild(s, 'seen-worker');

  // Every authenticated request refreshes `last_seen_at`, so it is a superset of the
  // heartbeat: an old heartbeat must not override a newer sighting of the same child.
  s.clock.set(Date.now());
  const realGetMember = s.pg.getMember.bind(s.pg);
  s.pg.getMember = async (id) => {
    const detail = await realGetMember(id);
    if (id !== child.id) return detail;
    return { ...detail, heartbeat_at: s.clock.now() - 60_000, last_seen_at: s.clock.now() - 10_000 };
  };

  const result = await s.loop.respawn(child.id);

  assert.equal(s.herdr.spawns.length, 0, 'a child seen ten seconds ago is running, whatever its heartbeat says');
  assert.deepEqual(result.alreadyRunning, [child.id], 'the child is told to repair its own layer instead');
  assert.deepEqual(result.restarted, [], 'no process was started');
});

test('an unreadable herdr never starts a child and never reports a repair', async (t) => {
  const s = await scenario({
    role: 'root',
    autoRespawn: true,
    heartbeatMs: 1_000,
    heartbeatMiss: 3,
    respawnFreshMs: 1_000,
  });
  t.after(() => s.close());
  await s.cycle();
  const { child } = await staleChild(s, 'unknown-worker');
  // null is "could not ask", not "no pane". Starting a process on that answer would
  // put a second process on one identity.
  s.herdr.failListPanes = new Error('herdr is not running');

  const result = await s.loop.respawn(child.id);
  assert.equal(s.herdr.spawns.length, 0, 'an explicit respawn also refuses to start on an unknown answer');
  assert.equal(result.restarted.length, 0, 'nothing was started');
  assert.ok(
    result.skipped.some((entry) => /could not list panes|answer is unknown/i.test(entry.reason)),
    `the skip explains that herdr could not answer: ${JSON.stringify(result)}`,
  );

  // The automatic reconcile sees the same unreadable answer and must stay quiet too.
  s.clock.advance(30_000);
  await s.cycle();
  await quiet(200);
  assert.equal(s.herdr.spawns.length, 0, 'the death gate never treats an unknown answer as death');
  await s.timer(WINDOW);
  assert.equal(
    s.surface.textsOfKind('nudge').filter((text) => text.includes('[repair]') && text.includes(child.id)).length,
    0,
    `an unknown answer is not a repair: ${JSON.stringify(s.surface.texts())}`,
  );
});

test('a 0.4 platform gets no heartbeat requests and one warning', async (t) => {
  const s = await scenario({ heartbeatMs: 1_000 });
  t.after(() => s.close());
  const warnings = captureWarnings(t);

  let beats = 0;
  s.pg.heartbeat = async () => {
    beats += 1;
    return { heartbeat_at: s.clock.now() };
  };
  const realWhoami = s.pg.whoami.bind(s.pg);
  s.pg.whoami = async () => {
    const who = await realWhoami();
    return { ...who, server: { ...who.server, version: '0.4.9' } };
  };

  await s.cycle();
  s.clock.set(Date.now());
  s.loop.tick();
  await delay(50);
  s.clock.advance(1_000);
  s.loop.tick();
  await delay(50);

  assert.equal(beats, 0, 'the heartbeat route only exists from platform 0.5');
  const heartbeatWarnings = warnings.filter((line) => /heartbeat/i.test(line) && /0\.5/.test(line));
  assert.equal(heartbeatWarnings.length, 1, `exactly one warning names the missing platform feature: ${JSON.stringify(warnings)}`);
});

test('a heartbeat that never settles is abandoned so later ticks can beat again', async (t) => {
  const s = await scenario({ heartbeatMs: 1_000 });
  t.after(() => s.close());
  await s.cycle();
  s.clock.set(Date.now());

  let calls = 0;
  s.pg.heartbeat = () => {
    calls += 1;
    return new Promise(() => {});
  };

  s.loop.tick();
  await waitFor(() => calls === 1, 'the first heartbeat to enter the platform client');
  await delay(2_200); // past ROSTER_TIMEOUT_MS, the bound on the request
  s.clock.advance(1_000);
  s.loop.tick();
  await waitFor(() => calls === 2, 'the in-flight flag to be released after the timeout');
});

test('one reconcile pass asks herdr for the pane list once, not once per dead child', async (t) => {
  const s = await scenario({
    role: 'root',
    autoRespawn: true,
    heartbeatMs: 1_000,
    heartbeatMiss: 3,
    respawnFreshMs: 1_000,
  });
  t.after(() => s.close());
  await s.cycle();

  const a = await recordedChild(s, 'pass-a');
  const b = await recordedChild(s, 'pass-b');
  s.clock.set(Date.now());
  await heartbeat(s.platform, a.child.token, a.child.id);
  await heartbeat(s.platform, b.child.token, b.child.id);
  s.clock.advance(4_001);
  s.herdr.paneList.push(
    { pane_id: 'pane-pass-a', agent_status: 'idle', agent_session: { kind: 'path', value: a.sessionFile } },
    { pane_id: 'pane-pass-b', agent_status: 'idle', agent_session: { kind: 'path', value: b.sessionFile } },
  );

  await s.cycle();
  await quiet(200);

  assert.equal(s.herdr.spawns.length, 0, 'both children still have a live pane');
  assert.equal(s.herdr.listPanesCalls, 1, `the pass reads the pane list once for both children, got ${s.herdr.listPanesCalls}`);
});

test('a crash cascade repairs dead children one at a time', async (t) => {
  const s = await scenario({
    role: 'root',
    autoRespawn: true,
    heartbeatMs: 1_000,
    heartbeatMiss: 3,
    respawnFreshMs: 1_000,
  });
  t.after(() => s.close());
  await s.cycle();

  const a = await recordedChild(s, 'cascade-a');
  const b = await recordedChild(s, 'cascade-b');
  s.clock.set(Date.now());
  await heartbeat(s.platform, a.child.token, a.child.id);
  await heartbeat(s.platform, b.child.token, b.child.id);
  s.clock.advance(4_001);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running = 0;
  let most = 0;
  s.herdr.onSpawn = async () => {
    running += 1;
    most = Math.max(most, running);
    await gate;
    running -= 1;
  };

  await s.cycle();
  await waitFor(() => s.herdr.spawns.length === 1, 'the first dead child to start');
  await delay(150);
  const beforeRelease = s.herdr.spawns.length;
  release();
  await waitFor(() => s.herdr.spawns.length === 2, 'the second child to start after the first finished');
  await quiet(300);

  assert.equal(beforeRelease, 1, 'the second child waits for the first repair to finish');
  assert.equal(most, 1, 'never two respawns in the air at once');
});

test('a failed restart reports why once and does not repeat on the next check', async (t) => {
  const s = await scenario({
    role: 'root',
    autoRespawn: true,
    heartbeatMs: 1_000,
    heartbeatMiss: 3,
    respawnFreshMs: 1_000,
  });
  t.after(() => s.close());
  await s.cycle();
  const { child } = await staleChild(s, 'failing-worker');
  s.herdr.failSpawn = new Error('herdr tab create failed');

  await s.cycle();
  const first = await waitForRepair(s, child.id);
  assert.match(first, /restart failed: .*herdr tab create failed/, `the failure is named: ${first}`);
  assert.equal(
    s.surface.textsOfKind('nudge').filter((text) => text.includes('[repair]') && text.includes(child.id)).length,
    1,
    'one line for the failed repair',
  );

  // Past the 30 s pane-check bound and the failure cooldown, the repair is retried.
  s.clock.advance(30_000);
  await s.cycle();
  await waitFor(() => s.herdr.spawns.length === 2, 'the failed restart to be retried');
  s.clock.advance(WINDOW);
  s.loop.tick();
  await delay(50);
  await s.loop.flush();

  assert.equal(
    s.surface.textsOfKind('nudge').filter((text) => text.includes('[repair]') && text.includes(child.id)).length,
    1,
    `the same failed outcome is not repeated: ${JSON.stringify(s.surface.texts())}`,
  );
});

test('a child that dies again with a new heartbeat observation is reported again', async (t) => {
  const s = await scenario({
    role: 'root',
    autoRespawn: true,
    heartbeatMs: 1_000,
    heartbeatMiss: 3,
    respawnFreshMs: 1_000,
  });
  t.after(() => s.close());
  await s.cycle();
  const { child } = await staleChild(s, 'twice-worker');

  await s.cycle();
  await waitFor(() => s.herdr.spawns.length === 1, 'the first death to be restarted');
  const first = await waitForRepair(s, child.id);
  assert.match(first, /; restarted \d{2}:\d{2}$/);

  // The restarted child dies again. Its new heartbeat is a new observation, not a retry
  // of the one the first [repair] line already named.
  s.herdr.paneList.length = 0;
  s.clock.set(Date.now());
  const secondBeat = await heartbeat(s.platform, child.token, child.id);
  // Also past the pane-check TTL stamped when the first restart ran.
  s.clock.advance(60_001);
  await s.cycle();
  await waitFor(() => s.herdr.spawns.length === 2, 'the second death to be restarted');

  const lines = await waitForRepairs(s, child.id, 2);
  assert.equal(lines.length, 2, `a second death is a second line: ${JSON.stringify(lines)}`);
  assert.ok(
    lines[1]!.includes(`no heartbeat since ${formatLocalMinute(secondBeat.heartbeat_at)}`),
    `the second line names the new observation: ${lines[1]}`,
  );
});
