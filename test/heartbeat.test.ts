// §5.4: the member feeds a heartbeat as a fact. The parent no longer judges death from
// it: the 30 s scan only closes panes the platform says are gone, and a manual
// `pg_respawn` uses the pane list. `gone` is not an attention state.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLocalMinute } from '../src/format.ts';
import { PgUnavailable } from '../src/pgclient.ts';
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

test('a stale heartbeat with no pane is not started by the periodic scan', async (t) => {
  const s = await scenario({
    role: 'root',
    autoRespawn: true,
    heartbeatMs: 1_000,
    heartbeatMiss: 3,
  });
  t.after(() => s.close());
  await s.cycle(); // startup runs before the recorded child exists
  const { child } = await staleChild(s, 'stale-worker');

  await s.cycle();
  await quiet(300);
  assert.equal(s.herdr.spawns.length, 0, 'the periodic scan never starts a child');
  assert.equal(
    s.surface.texts().some((text) => text.includes('[repair]') && text.includes(child.id)),
    false,
    'the periodic scan does not report a repair it no longer performs',
  );

  const result = await s.loop.respawn();
  assert.deepEqual(result.restarted, [child.id], 'the explicit tool still starts it');
  assert.equal(s.herdr.spawns.length, 1);
});
test('a stale heartbeat with a live pane is quiet, not restarted', async (t) => {
  const s = await scenario({
    role: 'root',
    autoRespawn: true,
    heartbeatMs: 1_000,
    heartbeatMiss: 3,
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

test('an unreadable herdr list does not start a child in the periodic scan', async (t) => {
  const s = await scenario({
    role: 'root',
    autoRespawn: true,
    heartbeatMs: 1_000,
    heartbeatMiss: 3,
  });
  t.after(() => s.close());
  await s.cycle();
  const { child } = await staleChild(s, 'unreadable-worker');
  s.herdr.failListPanes = new Error('herdr is not running');

  await s.cycle();
  await quiet(300);
  assert.equal(s.herdr.spawns.length, 0, 'an unreadable pane list never starts a process');
  assert.equal(
    s.surface.texts().some((text) => text.includes('[repair]') && text.includes(child.id)),
    false,
    'the scan does not invent a repair report',
  );
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

test('25 consecutive PgUnavailable failures do not stop the loop', async (t) => {
  const s = await scenario({ role: 'root', sleep: async () => {} });
  t.after(() => s.close());
  const loop = s.loop as unknown as {
    handlePollError(error: unknown): Promise<void>;
    stopped: boolean;
  };

  for (let i = 0; i < 25; i += 1) {
    await loop.handlePollError(new PgUnavailable(1, `platform down ${i}`));
  }

  assert.equal(loop.stopped, false, 'weather never stops the loop');
  assert.equal(
    s.surface.texts().some((text) => /platform unreachable|blocked/i.test(text)),
    false,
    'no blocked line is produced',
  );
});
