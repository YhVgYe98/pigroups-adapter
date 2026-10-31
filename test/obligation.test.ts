// §4 obligations: computed from history, one per conversation, and the adapter's own `blocked` report.

import test from 'node:test';
import assert from 'node:assert/strict';

import { send, waitFor } from './support.ts';
import { payloads, scenario } from './scenario.ts';

test('an owed reply is nudged when the turn settles; after replying it is not', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  await send(s.platform, s.parent!.token, s.me.id, 'status please');
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 1);

  await s.settle();
  await s.timer(0); // a settle may be noticed by the timer task too; no clock moves
  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, 'a DM from the parent with no reply must be nudged once');
  assert.ok(nudges[0].includes(s.dm), `the nudge must name the conversation: ${nudges[0]}`);

  const said = await s.loop.say(s.parent!.id, 'ack, working on it');
  assert.equal(said.conv, s.dm);
  assert.deepEqual(s.loop.state().owed, [], 'replying must clear the obligation');

  const nudgesBefore = s.surface.textsOfKind('nudge').length;
  await s.settle();
  await s.timer(0);
  assert.equal(
    s.surface.textsOfKind('nudge').length,
    nudgesBefore,
    'a settled turn with nothing owed must not be nudged',
  );
});

test('@all produces exactly one obligation for that conversation, not one per message', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  await send(s.platform, s.parent!.token, s.group, 'standup now', ['all']);
  await send(s.platform, s.parent!.token, s.group, 'and bring numbers', ['all']);
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 1, 'two mentioned messages may share one deliver');

  await s.settle();
  await s.timer(0);

  const nudges = s.surface.textsOfKind('nudge').filter((text) => text.includes(s.group));
  assert.equal(nudges.length, 1, `@all means one obligation, got ${nudges.length} nudges:\n${nudges.join('\n')}`);
  assert.deepEqual(
    s.loop.state().owed.filter((conv) => conv === s.group),
    [s.group],
    'the conversation must be owed exactly once',
  );
});

// §2.3 invariant 2: one delivery per settle, `flush()` first and `nudge()` only when flush
// delivered nothing. Nudge-first starves the queue — the nudge starts the turn, so the flush
// behind it always no-ops and new messages never reach the member that is not answering.
test('a settle delivers once: the queued message first, and the nudge only when nothing was queued', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  await send(s.platform, s.parent!.token, s.me.id, 'status please');
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 1, 'the first DM must be delivered');
  assert.equal(s.surface.deliveries[0].kind, 'message');
  assert.deepEqual(s.loop.state().owed, [s.dm], 'an answered-nothing DM leaves the conversation owed');

  // A turn is running, so the next DM is queued by pollOnce() and stays queued.
  s.surface.beginTurn();
  await send(s.platform, s.parent!.token, s.me.id, 'and the numbers');
  await s.loop.pollOnce();
  assert.equal(s.surface.deliveries.length, 1, 'nothing may be injected while a turn is running');

  // That turn ends: the settle reaction runs with something queued *and* a nudge due.
  const afterFirst = s.surface.mark();
  s.surface.settle();
  await waitFor(() => s.surface.since(afterFirst).length > 0, 'the settle reaction to deliver');
  // The signal for "that was the only delivery": the queue is empty. The first `flush()` would
  // merge into the settle reaction's own in-flight flush (§2.3), so the second one is the fresh answer.
  await s.loop.flush();
  assert.equal(await s.loop.flush(), false, 'the settle reaction left an empty queue behind');

  const first = s.surface.since(afterFirst);
  assert.equal(
    first.length,
    1,
    `one settle may deliver once, got ${first.length}: ${first.map((d) => d.kind).join(', ')}`,
  );
  assert.equal(first[0].kind, 'message', 'queued work must win over the nudge in the same settle');
  assert.ok(first[0].text.includes('and the numbers'), `the queued message must be delivered: ${first[0].text}`);

  // Next settle, nothing queued and the member has still said nothing: now the nudge.
  const afterSecond = s.surface.mark();
  s.surface.settle();
  await waitFor(() => s.surface.since(afterSecond).length > 0, 'the next settle reaction to deliver');
  await s.loop.flush();
  assert.equal(await s.loop.flush(), false, 'the next settle reaction also left an empty queue behind');

  const second = s.surface.since(afterSecond);
  assert.equal(
    second.length,
    1,
    `one settle may deliver once, got ${second.length}: ${second.map((d) => d.kind).join(', ')}`,
  );
  assert.equal(second[0].kind, 'nudge', 'with an empty queue and an owed reply, the settle must nudge');
  assert.ok(second[0].text.includes(s.dm), `the nudge must name the conversation: ${second[0].text}`);
  assert.deepEqual(s.loop.state().owed, [s.dm], 'the member never spoke, so the conversation is still owed');
});

// §2.3: `flush()` returns 这次是否真的投出去了 — false while the surface is busy (it spins), true
// when something was handed to `deliver`. A `flush()` that answers true whenever it was called
// makes the settle reaction skip the nudge forever, so the busy case has to be pinned.
test('flush() reports what it did: false while the surface is busy, true when the queued message goes out', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle(); // drain the startup sequence: no DM exists yet, so nothing is injected
  assert.equal(s.surface.deliveries.length, 0, 'precondition: the member starts idle with an empty queue');

  // A turn is already running, so the next DM is queued and stays queued.
  s.surface.beginTurn();
  await send(s.platform, s.parent!.token, s.me.id, 'queued while the turn was running');
  await s.loop.pollOnce();
  assert.equal(s.surface.deliveries.length, 0, 'precondition: nothing is injected while the surface is busy');

  const mark = s.surface.mark();
  assert.equal(await s.loop.flush(), false, 'a busy surface must report that it delivered nothing');
  assert.equal(s.surface.since(mark).length, 0, 'and it must not have delivered anything while busy');

  // The turn is cut instead of settled: `settle()` would fire the loop's own settle reaction,
  // which flushes the queue itself and leaves this `flush()` with nothing to report.
  await s.surface.abort();
  const afterIdle = s.surface.mark();
  assert.equal(await s.loop.flush(), true, 'an idle surface with a queued message must report that it delivered');
  const delivered = s.surface.since(afterIdle);
  assert.equal(delivered.length, 1, `one deliver for the queued message, got ${delivered.length}`);
  assert.ok(delivered[0].text.includes('queued while the turn was running'), `the queued message must go out: ${delivered[0].text}`);
});

test('three nudges without an outbound message produce an adapter-authored blocked report to the parent', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  await send(s.platform, s.parent!.token, s.me.id, 'report back');
  await s.cycle();

  for (let i = 0; i < 5; i += 1) {
    await s.settle();
    await s.timer(0);
  }

  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, s.config.nudgeMax, `nudging must stop at ${s.config.nudgeMax}, got ${nudges.length}`);

  const reports = payloads(await s.controlsToParent(), 'pg.report');
  const blocked = reports.filter((payload) => payload.status === 'blocked');
  assert.equal(blocked.length, 1, `the adapter must report blocked once, got ${JSON.stringify(reports)}`);
  assert.ok(String(blocked[0].text ?? '').length > 0, 'the blocked report carries a text');
});

// §4.3: "已经报过 blocked 是一个只在成员开口时才失效的状态", not something an inbound message
// resets. A fresh message continues the same episode; only `say()` closes it and opens the next.
test('a new inbound message neither resets the nudge budget nor re-reports blocked; only say() opens a new episode', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'report back');
  await s.cycle();

  for (let i = 0; i < s.config.nudgeMax + 2; i += 1) {
    await s.settle();
    await s.timer(0);
  }

  assert.equal(
    s.surface.textsOfKind('nudge').length,
    s.config.nudgeMax,
    `the budget stops at ${s.config.nudgeMax}`,
  );
  const firstEpisode = payloads(await s.controlsToParent(), 'pg.report').filter((p) => p.status === 'blocked');
  assert.equal(firstEpisode.length, 1, `the exhausted episode reports blocked once, got ${JSON.stringify(firstEpisode)}`);

  // The parent asks again: that is inbound traffic, not the member speaking.
  await send(s.platform, s.parent!.token, s.me.id, 'any progress?');
  await s.cycle();
  const afterArrival = s.surface.mark();
  for (let i = 0; i < s.config.nudgeMax + 1; i += 1) {
    await s.settle();
    await s.timer(0);
  }

  assert.equal(
    s.surface.textsOfKind('nudge').length,
    s.config.nudgeMax,
    'a new inbound message must not reset the nudge budget',
  );
  assert.equal(s.surface.since(afterArrival).length, 0, 'settles inside a blocked episode deliver nothing');
  assert.equal(
    payloads(await s.controlsToParent(), 'pg.report').filter((p) => p.status === 'blocked').length,
    0,
    'the parent must not receive a second blocked report for the same episode',
  );

  // The member speaks: that closes the episode and everything it held.
  const said = await s.loop.say(s.parent!.id, 'status: done with the first half');
  assert.equal(said.conv, s.dm);
  assert.deepEqual(s.loop.state().owed, [], 'say() clears the obligation together with the episode');

  await send(s.platform, s.parent!.token, s.me.id, 'and the second half');
  await s.cycle();
  const secondEpisode = s.surface.textsOfKind('nudge').length;
  for (let i = 0; i < s.config.nudgeMax + 2; i += 1) {
    await s.settle();
    await s.timer(0);
  }

  assert.equal(
    s.surface.textsOfKind('nudge').length,
    secondEpisode + s.config.nudgeMax,
    'a new episode gets a full nudge budget of its own',
  );
  assert.equal(
    payloads(await s.controlsToParent(), 'pg.report').filter((p) => p.status === 'blocked').length,
    1,
    'a new episode may report blocked once more',
  );
});

// §4.3: "把**所有** owed 会话合成一条文本，只 deliver 一次". Two owed conversations are one turn,
// not two: the second deliver would land in the streaming turn and be dropped silently.
test('two owed conversations are coalesced into one nudge that names both', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'the dm');
  await send(s.platform, s.parent!.token, s.group, 'the group task', [s.me.id]);
  await s.cycle();
  assert.deepEqual(
    s.loop.state().owed.slice().sort(),
    [s.dm, s.group].sort(),
    `precondition: both conversations are owed, got ${JSON.stringify(s.loop.state().owed)}`,
  );

  const mark = s.surface.mark();
  await s.settle();
  await s.timer(0);

  const delivered = s.surface.since(mark);
  assert.equal(
    delivered.length,
    1,
    `two owed conversations must coalesce into one delivery, got ${delivered.length}: ${delivered.map((d) => d.kind).join(', ')}`,
  );
  assert.equal(delivered[0].kind, 'nudge');
  assert.ok(delivered[0].text.includes(s.dm), `the nudge must name the first conversation: ${delivered[0].text}`);
  assert.ok(delivered[0].text.includes(s.group), `the nudge must name the second conversation: ${delivered[0].text}`);
});

// §4.3's budget is per conversation: exhausting one stops that one, and the still-live conversation
// keeps being nudged without the adapter repeating the exhausted one's `blocked` report.
test('an exhausted conversation reports blocked once while the live one keeps being nudged', async (t) => {
  const s = await scenario({ nudgeMax: 2 });
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'the dm that never gets answered');
  await s.cycle();
  for (let i = 0; i < s.config.nudgeMax + 1; i += 1) {
    await s.settle();
    await s.timer(0);
  }

  assert.equal(s.surface.textsOfKind('nudge').length, s.config.nudgeMax, 'the DM spends its whole budget');
  assert.equal(
    payloads(await s.controlsToParent(), 'pg.report').filter((p) => p.status === 'blocked').length,
    1,
    'the exhausted DM reports blocked once',
  );

  // A second conversation becomes owed while the first is still owed but already reported.
  // A turn is forced to be running so the arrival is queued: then the settle order is deterministic.
  s.surface.beginTurn();
  await send(s.platform, s.parent!.token, s.group, 'and this one too', [s.me.id]);
  await s.cycle();

  const nudgesBefore = s.surface.textsOfKind('nudge').length;
  await s.settle(); // the queued group message goes out first
  await s.timer(0);
  assert.equal(
    s.surface.textsOfKind('nudge').length,
    nudgesBefore,
    'the queued message, not a nudge, is what this settle delivers',
  );
  await s.settle(); // then the first nudge for the live conversation
  await s.timer(0);

  const live = s.surface.textsOfKind('nudge').slice(nudgesBefore);
  assert.equal(live.length, 1, `the live conversation gets nudged while the other is exhausted, got ${live.length}`);
  assert.ok(live[0].includes(s.group), `the live conversation must be named: ${live[0]}`);
  assert.ok(!live[0].includes(s.dm), `the exhausted conversation must not be nudged again: ${live[0]}`);
  assert.equal(
    payloads(await s.controlsToParent(), 'pg.report').filter((p) => p.status === 'blocked').length,
    0,
    'the still-live conversation must not produce another blocked report',
  );

  for (let i = 0; i < s.config.nudgeMax + 1; i += 1) {
    await s.settle();
    await s.timer(0);
  }

  assert.equal(
    s.surface.textsOfKind('nudge').length - nudgesBefore,
    s.config.nudgeMax,
    'the live conversation gets a full budget of its own, not a share of the spent one',
  );
  assert.equal(
    payloads(await s.controlsToParent(), 'pg.report').filter((p) => p.status === 'blocked').length,
    1,
    'only the newly exhausted conversation reports blocked',
  );
});
