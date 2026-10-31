// §5 telemetry: child-side edge triggering and parent-side window consolidation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { command, createMember, send } from './support.ts';
import { createLoop, payloads, scenario } from './scenario.ts';

test('a tool call past the threshold emits exactly one stalled attention, and recovery emits recovered', async (t) => {
  const s = await scenario({ attentionToolMs: 60_000 });
  t.after(() => s.close());
  await s.cycle(); // the adapter has run a poll: it knows who it is and who to report to

  s.surface.beginTurn();
  s.surface.emit({ type: 'turn_start' });
  s.surface.emit({ type: 'tool_start', name: 'bash', argsPreview: "find ~/ -name '*.ts'" });

  await s.timer(61_000);
  const first = payloads(await s.controlsToParent(), 'pg.attention');
  const stalled = first.filter((payload) => payload.state === 'stalled');
  assert.equal(stalled.length, 1, `one stalled attention expected, got ${JSON.stringify(first)}`);
  assert.equal(stalled[0].tool?.name, 'bash', 'the attention must carry the tool that is stuck');

  await s.timer(10_000);
  await s.timer(10_000);
  const repeats = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'stalled');
  assert.equal(repeats.length, 0, 'stalled is edge-triggered: not one report per tick');

  s.surface.emit({ type: 'tool_end', name: 'bash', ok: true });
  await s.timer(1_000);
  const recovered = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'recovered');
  assert.equal(recovered.length, 1, 'leaving the stalled state must report recovered once');
  assert.equal(recovered[0].of, 'stalled', 'recovered names the state it left');
});

test('two children stalled in one window produce one consolidated nudge; a window that ends recovered produces none', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 300_000 });
  t.after(() => s.close());

  const a = await createMember(s.platform, s.me, 'reviewer');
  const b = await createMember(s.platform, s.me, 'coder');

  await command(s.platform, a.token, s.me.id, 'pg.attention', {
    v: 1,
    child: a.id,
    name: a.name,
    state: 'stalled',
    since: s.clock.now(),
    tool: { name: 'bash', elapsed_ms: 720_000, preview: "find ~/ -name '*.ts'" },
  });
  await command(s.platform, b.token, s.me.id, 'pg.attention', {
    v: 1,
    child: b.id,
    name: b.name,
    state: 'error',
    since: s.clock.now(),
    note: 'provider 429 ×7',
  });

  await s.cycle();
  assert.equal(s.surface.deliveries.length, 0, 'inbound attention updates the table, it is not injected');

  await s.timer();
  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, `two events in one window mean one nudge, got ${nudges.length}`);
  assert.ok(nudges[0].includes(a.id), `the summary must name the stalled child: ${nudges[0]}`);
  assert.ok(nudges[0].includes(b.id), `the summary must name the failing child: ${nudges[0]}`);

  await s.timer();
  assert.equal(s.surface.textsOfKind('nudge').length, 1, 'an already reminded state is not reminded again');

  // A second, independent window: everything recovers before it expires.
  const quietWindow = await createLoop(s.platform, s.me, { remindWindowMs: 300_000 });
  t.after(() => quietWindow.stop());
  const c = await createMember(s.platform, s.me, 'slowpoke');

  await command(s.platform, c.token, s.me.id, 'pg.attention', {
    v: 1,
    child: c.id,
    name: c.name,
    state: 'stalled',
    since: s.clock.now(),
    tool: { name: 'bash', elapsed_ms: 400_000, preview: 'sleep 600' },
  });
  await quietWindow.cycle();
  await quietWindow.timer(30_000);

  await command(s.platform, c.token, s.me.id, 'pg.attention', {
    v: 1,
    child: c.id,
    name: c.name,
    state: 'recovered',
    since: s.clock.now(),
    of: 'stalled',
  });
  await quietWindow.cycle();
  await quietWindow.timer(300_000);

  assert.equal(
    quietWindow.surface.textsOfKind('nudge').length,
    0,
    'a window that expires with everything recovered must be cancelled silently',
  );
});

test('state gone bypasses the window and is delivered immediately', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 3_600_000 });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'vanished');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'gone',
    since: s.clock.now(),
  });
  await s.cycle();
  await s.timer(0); // the clock does not move: the 1h reminder window cannot have expired

  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, 'gone must be delivered without waiting for the reminder window');
  assert.ok(nudges[0].includes(child.id), `the report must name the child that went away: ${nudges[0]}`);
});

test('a turn that ends with a provider error reports one error attention with its note', async (t) => {
  const s = await scenario({ attentionToolMs: 60_000 });
  t.after(() => s.close());
  await s.cycle(); // the adapter has run a poll: it knows who it is and who to report to

  s.surface.beginTurn();
  s.surface.emit({ type: 'turn_start' });
  await s.settle({ message: 'provider 429 ×7' });
  await s.timer(0);

  const errors = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'error');
  assert.equal(errors.length, 1, `one error attention expected, got ${JSON.stringify(errors)}`);
  assert.ok(String(errors[0].note ?? '').includes('429'), 'the error attention carries the note');
});

test('a turn running past twice the tool threshold reports one slow_turn with busy_ms', async (t) => {
  const s = await scenario({ attentionToolMs: 60_000 });
  t.after(() => s.close());
  await s.cycle();

  s.surface.beginTurn();
  s.surface.emit({ type: 'turn_start' });
  await s.timer(121_000);

  const slow = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'slow_turn');
  assert.equal(slow.length, 1, `one slow_turn attention expected, got ${JSON.stringify(slow)}`);
  assert.ok(Number(slow[0].busy_ms) >= 121_000, 'slow_turn carries how long the turn has been running');

  await s.timer(30_000);
  const again = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'slow_turn');
  assert.equal(again.length, 0, 'slow_turn is edge-triggered: not one report per tick');
});

test('idle with an unanswered message past the threshold reports one idle_owed naming the conversations', async (t) => {
  const s = await scenario({ attentionToolMs: 60_000 });
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'still waiting');
  await s.cycle();
  for (let i = 0; i < 4; i += 1) {
    await s.settle(); // nudges stop at nudgeMax, which leaves the member idle and still owing
    await s.timer(0);
  }
  await s.timer(61_000);

  const idleOwed = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'idle_owed');
  assert.equal(idleOwed.length, 1, `one idle_owed attention expected, got ${JSON.stringify(idleOwed)}`);
  assert.deepEqual(idleOwed[0].owed, [s.dm], 'idle_owed names the conversations still owed');
});
