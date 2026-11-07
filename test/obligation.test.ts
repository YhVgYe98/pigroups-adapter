// §4 obligations: computed from history, one per conversation, and the adapter's own `blocked` report.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdapterLoop } from '../src/loop.ts';
import { PgClient, PgGone } from '../src/pgclient.ts';
import { FakeClock, FakeSurface, createMember, delay, dmId, poll, removeMember, send, waitFor } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, payloads, scenario, type Scenario } from './scenario.ts';

/**
 * One whole nudge cycle for a conversation that is already owed: a new inbound message
 * (a new `seq`, so the text changes and §4.3 does not skip it), its delivery, then the
 * nudge for it.
 */
async function nudgeRound(s: Scenario, text: string): Promise<void> {
  await send(s.platform, s.parent!.token, s.me.id, text);
  await s.cycle();
  await s.timer(WINDOW); // the message goes out
  await s.settle(); // the turn ends, so a nudge becomes due
  await s.timer(WINDOW); // the nudge goes out
}

/** §5.1: `blocked` is an attention state now, not the old `pg.report`. */
function blockedAttention(items: Array<{ cmd: string; payload: unknown }>): Array<Record<string, any>> {
  return payloads(items as never, 'pg.attention').filter((payload) => payload.state === 'blocked');
}

test('an owed reply is nudged on the window after the turn settles; after replying it is not', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  // Drain the startup sequence first: a DM that is there before the first poll is the
  // brief, and §4.2 says the brief is not a debt (the member cannot answer its task book).
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'status please');
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1);

  await s.settle();
  assert.equal(s.surface.textsOfKind('nudge').length, 0, 'a settle enqueues the nudge; the window delivers it');
  await s.timer(WINDOW);
  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, 'a DM from the parent with no reply must be nudged once');
  assert.match(nudges[0], /^Unanswered messages: /, `the nudge is an English prompt: ${nudges[0]}`);
  assert.match(
    nudges[0],
    /Reply, or call pg_ack to clear this notification\./,
    `the nudge names the way out (§4.3): ${nudges[0]}`,
  );
  assert.ok(nudges[0].includes(s.dm), `the nudge must name the conversation: ${nudges[0]}`);

  const said = await s.loop.say(s.parent!.id, 'ack, working on it');
  assert.equal(said.conv, s.dm);
  assert.deepEqual(s.loop.state().owed, [], 'replying must clear the obligation');

  const nudgesBefore = s.surface.textsOfKind('nudge').length;
  await s.settle();
  await s.timer(WINDOW);
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
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1, 'two mentioned messages may share one deliver');

  await s.settle();
  await s.timer(WINDOW);

  const nudges = s.surface.textsOfKind('nudge').filter((text) => text.includes(s.group));
  assert.equal(nudges.length, 1, `@all means one obligation, got ${nudges.length} nudges:\n${nudges.join('\n')}`);
  assert.deepEqual(
    s.loop.state().owed.filter((conv) => conv === s.group),
    [s.group],
    'the conversation must be owed exactly once',
  );
});

// §8.4's \"催办：窗口关闭，且只在没别的东西可投时\", expressed on one queue: queued work
// wins the window over a nudge, and the nudge is delivered by a window with nothing else.
test('queued work wins the window over a nudge, and the nudge waits for a quiet window', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle(); // drain the startup sequence: a DM already there would be the brief

  await send(s.platform, s.parent!.token, s.me.id, 'status please');
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1, 'the first DM must be delivered');
  assert.equal(s.surface.deliveries[0].kind, 'message');
  assert.deepEqual(s.loop.state().owed, [s.dm], 'an answered-nothing DM leaves the conversation owed');

  // A turn is running, so the next DM is queued when the poll sees it.
  s.surface.beginTurn();
  await send(s.platform, s.parent!.token, s.me.id, 'and the numbers');
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 1, 'the window is open: nothing has gone out');

  // That turn ends with work queued *and* a nudge due (§4.3). The settle itself delivers
  // nothing; the closed window delivers the queued message, and only that.
  const afterFirst = s.surface.mark();
  await s.settle();
  assert.equal(s.surface.since(afterFirst).length, 0, 'a settle is not a delivery trigger');
  await s.timer(WINDOW);

  const first = s.surface.since(afterFirst);
  assert.equal(
    first.length,
    1,
    `one window is one delivery, got ${first.length}: ${first.map((d) => d.kind).join(', ')}`,
  );
  assert.equal(first[0].kind, 'message', 'queued work must win over the nudge in the same window');
  assert.ok(first[0].text.includes('and the numbers'), `the queued message must be delivered: ${first[0].text}`);

  // Next window, nothing else queued and the member has still said nothing: the nudge.
  const afterSecond = s.surface.mark();
  await s.settle();
  assert.equal(s.surface.since(afterSecond).length, 0, 'the settle only marked the nudge due');
  await s.timer(WINDOW);

  const second = s.surface.since(afterSecond);
  assert.equal(
    second.length,
    1,
    `one window is one delivery, got ${second.length}: ${second.map((d) => d.kind).join(', ')}`,
  );
  assert.equal(second[0].kind, 'nudge', 'with nothing queued and an owed reply, the window delivers a nudge');
  assert.ok(second[0].text.includes(s.dm), `the nudge must name the conversation: ${second[0].text}`);
  assert.deepEqual(s.loop.state().owed, [s.dm], 'the member never spoke, so the conversation is still owed');
});

// `flush()` answers "did a delivery happen now?": false while the window is open, true
// when it closes, false again once the queue is drained.
test('flush() reports what it did: false while the window is open, true when it closes', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle(); // drain the startup sequence: no DM exists yet, so nothing is injected
  assert.equal(s.surface.deliveries.length, 0, 'precondition: the member starts with an empty queue');

  await send(s.platform, s.parent!.token, s.me.id, 'queued behind the window');
  await s.loop.pollOnce();
  assert.equal(s.surface.deliveries.length, 0, 'precondition: the window is open');

  const mark = s.surface.mark();
  assert.equal(await s.loop.flush(), false, 'an open window must report that it delivered nothing');
  assert.equal(s.surface.since(mark).length, 0, 'and it must not have delivered anything');

  s.clock.advance(WINDOW);
  const afterClose = s.surface.mark();
  assert.equal(await s.loop.flush(), true, 'a closed window with a queued message must report that it delivered');
  const delivered = s.surface.since(afterClose);
  assert.equal(delivered.length, 1, `one deliver for the closed window, got ${delivered.length}`);
  assert.ok(delivered[0].text.includes('queued behind the window'), `the message must go out: ${delivered[0].text}`);

  assert.equal(await s.loop.flush(), false, 'a drained queue reports that it delivered nothing');
});

test('three nudges without an outbound message produce an adapter-authored blocked report to the parent', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  // Each nudge has to carry something new: §4.3 skips a verbatim repeat, so the parent
  // writes again between nudges and the text names a fresh `#seq`. The budget still stops
  // at `nudgeMax`, and the report that follows is still the adapter's own.
  for (let i = 0; i < s.config.nudgeMax + 2; i += 1) await nudgeRound(s, `report back ${i}`);

  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, s.config.nudgeMax, `nudging must stop at ${s.config.nudgeMax}, got ${nudges.length}`);

  const blocked = blockedAttention(await s.controlsToParent());
  assert.equal(blocked.length, 1, `the adapter must report blocked once, got ${JSON.stringify(blocked)}`);
  assert.deepEqual(blocked[0].owed, [s.dm], 'the blocked state names the conversation whose budget is spent');
  assert.match(String(blocked[0].note ?? ''), /no output after 3 nudges/, 'the blocked state carries its reason');
});

// §4.3 (design decision): a verbatim repeat is not delivered, but it is still a nudge that
// came due, so it spends one unit of the budget. Otherwise a frozen debt could be "nudged"
// forever without ever reaching `no output after N nudges`, and `idle_owed` — which does not
// carry the budget — would leave the parent unable to see either side of the loop.
test('a skipped verbatim nudge spends the budget, so a frozen debt still reports blocked', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'report back');
  await s.cycle();
  await s.timer(WINDOW); // delivered → owed
  await s.settle();
  await s.timer(WINDOW); // nudge #1: delivered
  assert.equal(s.surface.textsOfKind('nudge').length, 1, 'precondition: the first nudge went out');
  assert.equal(s.loop.state().nudges[s.dm], 1, 'precondition: the first nudge spent one unit of budget');

  // Nothing changed — same conversation, same seq — so the next two dues are verbatim
  // repeats. They must not be injected, and they must still be counted.
  const mark = s.surface.mark();
  await s.settle();
  await s.timer(WINDOW); // due #2: skipped, counted
  await s.settle();
  await s.timer(WINDOW); // due #3: skipped, counted
  assert.equal(
    s.surface.since(mark).length,
    0,
    `a verbatim repeat must not be delivered: ${JSON.stringify(s.surface.since(mark))}`,
  );
  assert.equal(s.surface.textsOfKind('nudge').length, 1, 'only the first nudge reached the model');
  assert.equal(s.loop.state().nudges[s.dm], 3, 'every skipped due spends one unit of the budget');

  await s.settle(); // the spent budget is seen at this settle
  const blocked = blockedAttention(await s.controlsToParent()).filter(
    (payload) => payload.note === `no output after 3 nudges (${s.dm})`,
  );
  assert.equal(
    blocked.length,
    1,
    `a frozen debt must still reach the blocked report after 3 nudges, got ${JSON.stringify(blocked)}`,
  );
});

// §4.3: "已经报过 blocked 是一个只在成员开口时才失效的状态", not something an inbound message
// resets. A fresh message continues the same episode; only `say()` closes it and opens the next.
test('a new inbound message neither resets the nudge budget nor re-reports blocked; only say() opens a new episode', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  // Spend the budget: §4.3 skips a verbatim repeat, so every nudge names a new `#seq`.
  for (let i = 0; i < s.config.nudgeMax; i += 1) await nudgeRound(s, `report back ${i}`);
  await s.settle(); // the spend is seen at the next settle, which reports blocked
  await s.timer(WINDOW);

  assert.equal(
    s.surface.textsOfKind('nudge').length,
    s.config.nudgeMax,
    `the budget stops at ${s.config.nudgeMax}`,
  );
  const firstEpisode = blockedAttention(await s.controlsToParent());
  assert.equal(firstEpisode.length, 1, `the exhausted episode reports blocked once, got ${JSON.stringify(firstEpisode)}`);

  // The parent asks again: that is inbound traffic, not the member speaking.
  await send(s.platform, s.parent!.token, s.me.id, 'any progress?');
  await s.cycle();
  await s.timer(WINDOW); // the inbound message is delivered; its arrival is not a new episode
  const afterArrival = s.surface.mark();
  for (let i = 0; i < s.config.nudgeMax + 1; i += 1) {
    await s.settle();
    await s.timer(WINDOW);
  }

  assert.equal(
    s.surface.textsOfKind('nudge').length,
    s.config.nudgeMax,
    'a new inbound message must not reset the nudge budget',
  );
  assert.equal(s.surface.since(afterArrival).length, 0, 'settles inside a blocked episode deliver nothing');
  assert.equal(
    blockedAttention(await s.controlsToParent()).length,
    0,
    'the parent must not receive a second blocked state for the same episode',
  );

  // The member speaks: that closes the episode and everything it held.
  const said = await s.loop.say(s.parent!.id, 'status: done with the first half');
  assert.equal(said.conv, s.dm);
  assert.deepEqual(s.loop.state().owed, [], 'say() clears the obligation together with the episode');

  await send(s.platform, s.parent!.token, s.me.id, 'and the second half');
  await s.cycle();
  await s.timer(WINDOW);
  const secondEpisode = s.surface.textsOfKind('nudge').length;
  for (let i = 0; i < s.config.nudgeMax; i += 1) await nudgeRound(s, `second half ${i}`);
  await s.settle(); // the spent budget reports blocked
  await s.timer(WINDOW);

  assert.equal(
    s.surface.textsOfKind('nudge').length,
    secondEpisode + s.config.nudgeMax,
    'a new episode gets a full nudge budget of its own',
  );
  assert.equal(
    blockedAttention(await s.controlsToParent()).length,
    1,
    'a new episode may report blocked once more',
  );
});

// §4.3: "把**所有** owed 会话合成一条文本，只 deliver 一次". Two owed conversations are one
// window, one delivery: one wake-up shows all the debts, not one turn per conversation.
test('two owed conversations are coalesced into one nudge that names both', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'the dm');
  await send(s.platform, s.parent!.token, s.group, 'the group task', [s.me.id]);
  await s.cycle();
  await s.timer(WINDOW);
  assert.deepEqual(
    s.loop.state().owed.slice().sort(),
    [s.dm, s.group].sort(),
    `precondition: both conversations are owed, got ${JSON.stringify(s.loop.state().owed)}`,
  );

  const mark = s.surface.mark();
  await s.settle();
  await s.timer(WINDOW);

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

  // The DM spends its whole budget: §4.3 skips a verbatim repeat, so each round brings a
  // new inbound message and the nudge names a new `#seq`.
  for (let i = 0; i < s.config.nudgeMax; i += 1) await nudgeRound(s, `the dm that never gets answered ${i}`);
  await s.settle(); // the spent budget reports blocked
  await s.timer(WINDOW);

  assert.equal(s.surface.textsOfKind('nudge').length, s.config.nudgeMax, 'the DM spends its whole budget');
  assert.equal(
    blockedAttention(await s.controlsToParent()).length,
    1,
    'the exhausted DM reports blocked once',
  );

  // A second conversation becomes owed while the first is still owed but already reported.
  s.surface.beginTurn();
  await send(s.platform, s.parent!.token, s.group, 'and this one too', [s.me.id]);
  await s.cycle();
  assert.equal(s.surface.textsOfKind('nudge').length, s.config.nudgeMax, 'the queued message opens its window');

  const nudgesBefore = s.surface.textsOfKind('nudge').length;
  await s.settle(); // the queued group message still has its window open
  await s.timer(WINDOW); // the message goes out first
  assert.equal(
    s.surface.textsOfKind('nudge').length,
    nudgesBefore,
    'the queued message, not a nudge, is what this window delivers',
  );

  await s.settle(); // then the first nudge for the live conversation
  await s.timer(WINDOW);

  const live = s.surface.textsOfKind('nudge').slice(nudgesBefore);
  assert.equal(live.length, 1, `the live conversation gets nudged while the other is exhausted, got ${live.length}`);
  assert.ok(live[0].includes(s.group), `the live conversation must be named: ${live[0]}`);
  assert.ok(!live[0].includes(s.dm), `the exhausted conversation must not be nudged again: ${live[0]}`);
  assert.equal(
    blockedAttention(await s.controlsToParent()).length,
    0,
    'the still-live conversation must not produce another blocked report',
  );

  // The live conversation gets a full budget of its own, again one new `#seq` per nudge.
  for (let i = 0; i < s.config.nudgeMax - 1; i += 1) {
    await send(s.platform, s.parent!.token, s.group, `and this one too ${i}`, [s.me.id]);
    await s.cycle();
    await s.timer(WINDOW);
    await s.settle();
    await s.timer(WINDOW);
  }
  await s.settle(); // the newly spent budget reports blocked
  await s.timer(WINDOW);

  assert.equal(
    s.surface.textsOfKind('nudge').length - nudgesBefore,
    s.config.nudgeMax,
    'the live conversation gets a full budget of its own, not a share of the spent one',
  );
  assert.equal(
    blockedAttention(await s.controlsToParent()).length,
    1,
    'only the newly exhausted conversation reports blocked',
  );
});

// §5.1/§5.2: `blocked` is one state per child whose value is a set of conversations.
// A second conversation re-sends the same state with the whole set; `say(conv)` shrinks
// it; only an empty set is `recovered`. The parent should never have to union anything.
test('two blocked conversations are one state whose set shrinks as each is answered', async (t) => {
  const s = await scenario({ nudgeMax: 1 });
  t.after(() => s.close());
  await s.cycle();

  // First conversation spends its single nudge and reaches blocked.
  await nudgeRound(s, 'the dm that never gets answered');
  await s.settle(); // the spent budget enters blocked [dm]
  await delay(50);

  // A second conversation becomes blocked later: the state is re-sent with both.
  await send(s.platform, s.parent!.token, s.group, 'the group task', [s.me.id]);
  await s.cycle();
  await s.timer(WINDOW); // the group message is delivered, so it is owed
  await s.settle(); // its nudge becomes due
  await s.timer(WINDOW); // the group-only nudge is delivered
  await s.settle(); // the spent budget adds the group to blocked
  await delay(50);

  const blocked = blockedAttention(await s.controlsToParent());
  assert.equal(blocked.length, 2, `a set change is a re-send, got ${JSON.stringify(blocked)}`);
  assert.deepEqual(blocked[0].owed, [s.dm], 'entering blocked names the first conversation');
  assert.deepEqual(blocked[1].owed, [s.dm, s.group].sort(), 'the re-send carries the whole set');
  assert.equal(blocked[1].since, blocked[0].since, 'the set changed; the state was not re-entered');

  // Answering one conversation takes only that conversation out of the set.
  const said = await s.loop.say(s.parent!.id, 'one answer');
  assert.equal(said.conv, s.dm);
  await delay(50);
  const afterOne = payloads(await s.controlsToParent(), 'pg.attention');
  const smaller = afterOne.filter((payload) => payload.state === 'blocked');
  assert.equal(smaller.length, 1, `a smaller set is new information: ${JSON.stringify(afterOne)}`);
  assert.deepEqual(smaller[0].owed, [s.group], 'the parent replaces the set with what remains');
  assert.equal(
    afterOne.filter((payload) => payload.state === 'recovered' && payload.of === 'blocked').length,
    0,
    'a non-empty set is not recovered',
  );

  // Answering the last conversation empties the set: now, and only now, recovered.
  const saidGroup = await s.loop.say(s.group, 'the group answer');
  assert.equal(saidGroup.conv, s.group);
  await delay(50);
  const afterBoth = payloads(await s.controlsToParent(), 'pg.attention');
  const recovered = afterBoth.filter((payload) => payload.state === 'recovered' && payload.of === 'blocked');
  assert.equal(recovered.length, 1, `an empty set is recovered: ${JSON.stringify(afterBoth)}`);
});

// §4.3/§5.2: `pg_ack` clears the flag but not the blocked episode. Silence is exactly
// what `blocked` exists to expose, so only `say()` may leave it.
test('pg_ack does not leave the blocked state; only say does', async (t) => {
  const s = await scenario({ nudgeMax: 1 });
  t.after(() => s.close());
  await s.cycle();

  await nudgeRound(s, 'the dm that will be acked');
  await s.settle(); // spent budget -> blocked
  await delay(50);
  const before = payloads(await s.controlsToParent(), 'pg.attention');
  assert.equal(
    before.filter((payload) => payload.state === 'blocked').length,
    1,
    'precondition: the conversation is blocked',
  );

  const acked = await s.loop.ack({ conv: s.dm });
  assert.deepEqual(acked.remaining, [], 'the ack clears the owed flag');
  await delay(50);
  const afterAck = payloads(await s.controlsToParent(), 'pg.attention');
  assert.equal(
    afterAck.filter((payload) => payload.state === 'recovered' && payload.of === 'blocked').length,
    0,
    'pg_ack must not recover the blocked state',
  );
  assert.equal(
    afterAck.filter((payload) => payload.state === 'blocked').length,
    0,
    'the blocked set did not change, so there is nothing new to send',
  );

  await s.loop.say(s.parent!.id, 'now I actually speak');
  await delay(50);
  const afterSay = payloads(await s.controlsToParent(), 'pg.attention');
  assert.equal(
    afterSay.filter((payload) => payload.state === 'recovered' && payload.of === 'blocked').length,
    1,
    'say() is what leaves the blocked state',
  );
});

// §3.2: an abort is cutting the turn, so a nudge must not start the very turn the
// abort then waits for. `onSettled` already refuses while `aborting`, but the nudge
// itself is reachable from a settle that began before the abort landed — and the
// blocked report below awaits the platform, which leaves a second window right
// before the nudge is marked. Both guards are checked here through the loop's internals:
// no public drive can hold the report open at a chosen instant.
interface LoopInternals {
  aborting: boolean;
  nudges: { record(conv: string): number };
  markNudgeDue(): Promise<void>;
  pg: { sendControl(input: unknown): Promise<unknown> };
}

function internals(loop: unknown): LoopInternals {
  return loop as LoopInternals;
}

test('a nudge is not marked or delivered while an abort is already cutting the turn', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'status please');
  await s.cycle();
  await s.timer(WINDOW);
  const inner = internals(s.loop);
  inner.aborting = true;

  const mark = s.surface.mark();
  await inner.markNudgeDue();
  s.clock.advance(WINDOW);
  s.loop.tick();
  await s.loop.flush();

  assert.equal(s.surface.since(mark).length, 0, 'a nudge during pg.abort would be the turn the abort is cutting');
});

test('an abort during the blocked report stops the nudge to the live conversation', async (t) => {
  const s = await scenario({ nudgeMax: 1 });
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'the dm that never gets answered');
  await send(s.platform, s.parent!.token, s.group, 'the group task', [s.me.id]);
  await s.cycle();
  await s.timer(WINDOW);
  const inner = internals(s.loop);
  assert.equal(
    inner.nudges.record(s.dm),
    s.config.nudgeMax,
    'precondition: the DM has spent its budget, the group has not',
  );

  const pg = inner.pg;
  const original = pg.sendControl.bind(pg);
  let releaseReport: (() => void) | undefined;
  pg.sendControl = () =>
    new Promise((resolve) => {
      releaseReport = () => resolve({});
    });
  t.after(() => {
    pg.sendControl = original;
  });

  const mark = s.surface.mark();
  const driving = inner.markNudgeDue();
  await waitFor(() => releaseReport !== undefined, 'the blocked report to reach the platform');

  // The report is in flight; this is the moment a `pg.abort` can land.
  inner.aborting = true;
  releaseReport!();
  await driving;
  s.clock.advance(WINDOW);
  s.loop.tick();
  await s.loop.flush();

  assert.equal(
    s.surface.since(mark).length,
    0,
    'the live conversation must not be nudged while the abort is cutting the turn',
  );
});

test('a debt to a member that was deleted is dropped, not nudged forever', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  // A sibling writes to me privately: a one-to-one debt I can only pay by answering.
  await send(s.platform, sibling.token, s.me.id, 'ping');
  await s.cycle();
  await s.timer(WINDOW);
  await s.settle();
  await s.timer(WINDOW);
  assert.equal(s.surface.textsOfKind('nudge').length, 1, 'a living peer is owed an answer');

  // The parent deletes it. From now on every reply would answer 410 `member_gone`, so
  // the debt can never be paid — and nothing in the platform withdraws the marker.
  await removeMember(s.platform, s.parent!.token, sibling.id);
  // The roster is cached for 30 s; let it go stale so the adapter has to look again.
  await s.timer(31_000);

  const before = s.surface.textsOfKind('nudge').length;
  await s.settle();
  await s.timer(WINDOW);
  assert.equal(
    s.surface.textsOfKind('nudge').length,
    before,
    'a deleted peer must not be nudged again — the member cannot answer it',
  );
  assert.deepEqual(s.loop.state().owed, [], 'the marker is gone, not merely skipped');
});

test('a member that starts up owing a dead peer has no debt before the first settle', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];
  const peerDm = dmId(s.me.id, sibling.id);

  // The member saw the message before it went down: drain the queue, so only the
  // startup reconciliation can put the debt back. History keeps it.
  await send(s.platform, sibling.token, s.me.id, 'ping before you restart');
  const drained = await poll(s.platform, s.me.token, { wait: 0, types: 'message' });
  assert.equal(drained.items.length, 1, 'precondition: the message was consumed before the restart');

  await removeMember(s.platform, s.parent!.token, sibling.id);

  // First drive is the startup sequence itself; no settle is fired.
  await s.loop.pollOnce();
  assert.deepEqual(
    s.loop.state().owed,
    [],
    'a startup reconciliation must not leave a debt to a peer that is already gone',
  );
  await s.timer(WINDOW);
  assert.equal(s.surface.textsOfKind('nudge').length, 0, 'nothing may be nudged before the first settle');
  assert.ok(!s.surface.texts().some((text) => text.includes(peerDm)), 'the dead conversation is not delivered');
});

test('a deleted peer is not nudged by the settle that follows', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await send(s.platform, sibling.token, s.me.id, 'ping');
  await s.cycle();
  await s.timer(WINDOW);
  const peerDm = dmId(s.me.id, sibling.id);
  assert.ok(s.loop.state().owed.includes(peerDm), 'precondition: a living peer leaves a real debt');

  await removeMember(s.platform, s.parent!.token, sibling.id);
  await s.timer(31_000); // let the roster snapshot go stale

  await s.settle();
  await s.timer(WINDOW);
  assert.deepEqual(s.loop.state().owed, [], 'the pruned debt is gone, not merely unreported');
  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(
    nudges.filter((text) => text.includes(peerDm)).length,
    0,
    `no nudge may name a conversation with nobody in it: ${JSON.stringify(s.surface.texts())}`,
  );
});

// ---------------------------------------------------------------------------
// §4.1 "the peer must still be alive": the two ways that condition can be read
// wrong. A stale-but-true snapshot (the peer was created after the read) and a
// 200 body that is not a roster at all.
// ---------------------------------------------------------------------------

test('a peer created after the cached roster read keeps its debt', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  // T: a DM debt exists, so the settle reads the roster and caches it at T.
  await send(s.platform, sibling.token, s.me.id, 'ping');
  await s.cycle();
  await s.timer(WINDOW);
  await s.settle();
  assert.ok(
    s.loop.state().owed.includes(dmId(s.me.id, sibling.id)),
    'precondition: the debt exists and the roster is cached',
  );

  // Pay it: the next settle has no DM debt, so it does not read the roster again.
  await s.loop.say(sibling.id, 'on it');
  await s.settle();

  // T+5s: a member that did not exist at T arrives through `pg_spawn` and writes to me.
  const fresh = await s.loop.spawnMember({ name: 'late', brief: 'implement Z' });
  const freshToken = s.herdr.spawns[s.herdr.spawns.length - 1].env.PIGROUPS_TOKEN;
  s.clock.advance(5_000);
  await send(s.platform, freshToken, s.me.id, 'hi, I just started');
  await s.cycle();
  await s.timer(WINDOW);

  const freshDm = dmId(s.me.id, fresh.id);
  assert.ok(s.loop.state().owed.includes(freshDm), 'the fresh peer wrote to me: this is a real debt');
  const nudgesBefore = s.surface.textsOfKind('nudge').length;

  // The settle 5 s later still sees the roster read at T, where the fresh peer did not exist.
  await s.settle();
  await s.timer(WINDOW);
  assert.ok(
    s.loop.state().owed.includes(freshDm),
    `a debt younger than the roster snapshot must not be pruned as unanswerable: ${JSON.stringify(s.loop.state().owed)}`,
  );
  assert.equal(
    s.surface.textsOfKind('nudge').length,
    nudgesBefore + 1,
    'and the living peer must be nudged like any other debt',
  );
});

test('a debt older than the snapshot to a peer missing from it is still pruned', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await send(s.platform, sibling.token, s.me.id, 'ping');
  await s.cycle();
  await s.timer(WINDOW);
  await s.settle(); // caches the roster at T, with the sibling alive
  assert.deepEqual(s.loop.state().owed, [dmId(s.me.id, sibling.id)]);
  await s.settle(); // still owed: the peer is alive and I have not answered

  await removeMember(s.platform, s.parent!.token, sibling.id);
  s.clock.advance(31_000); // the snapshot is now stale, so the next settle reads a new one
  await s.settle();
  assert.deepEqual(s.loop.state().owed, [], 'the older debt is judged against a fresh snapshot, and pruned');
});

/** A loop wired only to a fake platform: the real AdapterLoop, a fake roster read. */
const SELF_ID = 'm_aaaaaa';
const PEER_ID = 'm_bbbbb1';
const PEER_DM = `dm:${SELF_ID}_${PEER_ID}`;

interface FakeLoop {
  loop: AdapterLoop;
  surface: FakeSurface;
  clock: FakeClock;
  dir: string;
}

/**
 * `pollOnce()` initialises the loop the way a real start does: `whoami`, then one
 * conversation that owes a reply. Draining the clock afterwards makes the debt older
 * than the snapshot the settle takes, so only the roster's content can decide it.
 */
async function makeLoop(tree: (signal?: AbortSignal) => Promise<unknown>): Promise<FakeLoop> {
  const surface = new FakeSurface();
  const clock = new FakeClock(1_000_000);
  const dir = await mkdtemp(join(tmpdir(), 'pigroups-roster-'));
  const pg = {
    whoami: async () => ({
      member: { id: SELF_ID, name: 'me', parent_id: null },
      server: { version: '0.7.2' },
    }),
    conversations: async () => ({ items: [{ to: PEER_DM }] }),
    messages: async () => ({
      items: [
        {
          to: PEER_DM,
          seq: 7,
          sender_id: PEER_ID,
          sender_kind: 'member',
          sender_name: 'peer',
          body: 'ping',
          meta: null,
          mentions: [],
          created_at: 0,
        },
      ],
      next: null,
    }),
    tree,
    poll: async () => ({ items: [], control_pending: 0 }),
    getMember: async () => ({ status: 'alive', heartbeat_at: null }),
    heartbeat: async () => ({ heartbeat_at: Date.now() }),
    sendMessage: async () => ({ to: '', seq: 0, recipients: [], created_at: 0 }),
    sendControl: async () => ({ control_seq: 0, receipts: [] }),
  };
  const loop = new AdapterLoop({
    pg: pg as unknown as PgClient,
    surface,
    herdr: {
      spawn: async () => ({ pane: 'pane-x' }),
      waitReady: async () => undefined,
      read: async () => '',
      listPanes: async () => [],
      close: async () => ({ forced: false }),
    },
    config: {
      url: 'http://127.0.0.1:1',
      token: 't',
      adapterDir: dir,
      pollLimit: 20,
      pollWait: 0,
      deliveryMaxChars: 4096,
      attentionToolMs: 300_000,
      remindWindowMs: 300_000,
      nudgeMax: 3,
      deliveryWindowMs: WINDOW,
      spawnReadyMs: 5000,
      spawnCmd: 'pi',
    },
    now: clock.now,
  });
  return { loop, surface, clock, dir };
}

async function settleWithRoster(tree: () => Promise<unknown>): Promise<{ owed: string[]; surface: FakeSurface }> {
  const { loop, surface, clock, dir } = await makeLoop(tree);
  await loop.pollOnce(); // initialise: selfId + the DM debt, exactly as a real start would
  assert.deepEqual(loop.state().owed, [PEER_DM], 'precondition: the reconciliation found the debt');
  // Move past the instant the debt was marked, so the snapshot's age is not what saves it.
  clock.advance(60_000);
  surface.settle();
  await loop.settled();
  // The nudge is a windowed item (概念稿 §8.4): close its window so the test can see whether
  // a pruned debt would still have been nudged.
  clock.advance(WINDOW);
  loop.tick();
  await loop.flush();
  const owed = loop.state().owed;
  await loop.stop();
  await rm(dir, { recursive: true, force: true });
  return { owed, surface };
}

test('a roster that is not a roster prunes nothing', async () => {
  const notRosters: Array<[string, unknown]> = [
    ['an empty nodes array', { nodes: [] }],
    ['a body without nodes', { ok: true }],
    ['nodes without ids', { nodes: [{}] }],
    ['non-string ids', { nodes: [{ id: 42 }] }],
    ['a roster that does not contain this member', { nodes: [{ id: PEER_ID }] }],
    ['null', null],
    ['a JSON array', []],
  ];
  for (const [name, body] of notRosters) {
    const { owed, surface } = await settleWithRoster(async () => body);
    assert.deepEqual(owed, [PEER_DM], `${name} must not clear a real debt`);
    assert.equal(surface.textsOfKind('nudge').length, 1, `${name} must leave the debt nudgeable`);
  }
});

test('a failed roster read keeps every debt', async () => {
  const { owed, surface } = await settleWithRoster(async () => {
    throw new Error('platform down');
  });
  assert.deepEqual(owed, [PEER_DM], 'a read that failed proves nothing about the peer');
  assert.equal(surface.textsOfKind('nudge').length, 1, 'and the debt is still owed to a living peer');
});

test('a failed roster read keeps the last good snapshot and prunes nothing', async () => {
  let reads = 0;
  let failing = false;
  const f = await makeLoop(async () => {
    reads += 1;
    if (failing) throw new Error('platform down');
    return { nodes: [{ id: SELF_ID }, { id: PEER_ID }] };
  });
  try {
    await f.loop.pollOnce(); // startup: a good snapshot containing the peer
    assert.equal(reads, 1, 'precondition: the startup read succeeded');

    f.clock.advance(60_000); // the snapshot is stale, so a settle must ask again
    failing = true;
    f.surface.settle();
    await f.loop.settled();

    assert.deepEqual(f.loop.state().owed, [PEER_DM], 'a failed read proves nothing about the peer');
    assert.equal(reads, 2, 'precondition: the settle really attempted the read');
    const inner = f.loop as unknown as { roster?: { ids: Set<string> } };
    assert.ok(inner.roster?.ids.has(PEER_ID), 'the last good snapshot must be kept, not discarded');
  } finally {
    await f.loop.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('a roster read is not retried before the retry backoff elapses', async () => {
  let reads = 0;
  let failing = false;
  let peerAlive = true;
  const f = await makeLoop(async () => {
    reads += 1;
    if (failing) throw new Error('platform down');
    return { nodes: peerAlive ? [{ id: SELF_ID }, { id: PEER_ID }] : [{ id: SELF_ID }] };
  });
  try {
    await f.loop.pollOnce(); // startup read: the peer is alive
    f.clock.advance(60_000);
    failing = true;
    f.surface.settle();
    await f.loop.settled(); // the failed read starts the backoff
    const afterFailure = reads;
    assert.equal(afterFailure, 2, 'precondition: the settle attempted one read');

    f.clock.advance(4_999); // one millisecond short of the 5 s backoff
    f.surface.settle();
    await f.loop.settled();
    assert.equal(reads, afterFailure, 'no roster request may be made inside the backoff');
    assert.deepEqual(f.loop.state().owed, [PEER_DM], 'the stale snapshot keeps pruning conservative');

    f.clock.advance(1);
    failing = false;
    peerAlive = false;
    f.surface.settle();
    await f.loop.settled();
    assert.equal(reads, afterFailure + 1, 'the first settle after the backoff asks again');
    assert.deepEqual(f.loop.state().owed, [], 'the fresh roster now prunes the dead peer');
  } finally {
    await f.loop.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('the roster timeout aborts the request instead of abandoning it', async () => {
  let seen: AbortSignal | undefined;
  const f = await makeLoop(
    (signal) =>
      new Promise((_resolve, reject) => {
        seen = signal;
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  );
  try {
    const startup = f.loop.pollOnce();
    await waitFor(() => seen !== undefined, 'the roster request to start');
    assert.equal(seen?.aborted, false, 'precondition: the request is still in flight');
    await startup; // the 2 s roster bound expires and must cancel the request
    assert.equal(seen?.aborted, true, 'the timeout must abort the request, not only stop waiting for it');
  } finally {
    await f.loop.stop();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('PgClient.tree passes its signal through to fetch and aborts the request', async () => {
  const original = globalThis.fetch;
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as typeof fetch;
  try {
    const pg = new PgClient({ url: 'http://127.0.0.1:1', token: 't' });
    const controller = new AbortController();
    const reading = pg.tree(controller.signal);
    assert.equal(requestSignal, controller.signal, 'the signal must reach fetch');
    controller.abort();
    await assert.rejects(
      reading,
      (err: unknown) => (err as Error).name === 'AbortError',
      'aborting the signal must abort the request',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('a healthy roster missing the peer prunes the debt', async () => {
  // The startup pass reads a roster that still has the peer, so it keeps the debt.
  // The settle then reads one without it: that second read is the prune under test.
  let reads = 0;
  const { owed, surface } = await settleWithRoster(async () => {
    reads += 1;
    return reads === 1
      ? { nodes: [{ id: SELF_ID }, { id: PEER_ID }] }
      : { nodes: [{ id: SELF_ID }] };
  });
  assert.deepEqual(owed, [], 'this is the case the prune exists for');
  assert.equal(surface.textsOfKind('nudge').length, 0, 'a pruned debt is not nudged');
});

// §4.1: terminate() sees the whole cascade the platform deleted, not just its argument.
test('terminate drops the debts of every member the platform cascaded', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const child = await s.loop.spawnMember({ name: 'child', brief: 'implement Y' });
  const childToken = s.herdr.spawns[s.herdr.spawns.length - 1].env.PIGROUPS_TOKEN;
  const grandchild = await createMember(s.platform, { ...child, token: childToken }, 'grandchild');

  // The grandchild writes to me privately: a debt I can only pay in that conversation.
  await send(s.platform, grandchild.token, s.me.id, 'ping from the grandchild');
  await s.cycle();
  await s.timer(WINDOW);
  const grandchildDm = dmId(s.me.id, grandchild.id);
  assert.ok(s.loop.state().owed.includes(grandchildDm), 'precondition: the grandchild debt exists');

  const result = await s.loop.terminate(child.id);
  assert.deepEqual(
    [...result.terminated].sort(),
    [child.id, grandchild.id].sort(),
    'the platform deleted the whole subtree',
  );
  assert.deepEqual(
    s.loop.state().owed,
    [],
    'the cascade debts must go with the cascade, not just the argument of terminate()',
  );
});

// §4.1: the other fast path — a send that answers 410 means the peer is gone now.
test('say() answering 410 forgets the conversation the peer can no longer answer', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await send(s.platform, sibling.token, s.me.id, 'ping');
  await s.cycle();
  await s.timer(WINDOW);
  assert.ok(s.loop.state().owed.includes(dmId(s.me.id, sibling.id)), 'precondition: the debt exists');

  await removeMember(s.platform, s.parent!.token, sibling.id);
  await assert.rejects(
    () => s.loop.say(sibling.id, 'reply'),
    (err: unknown) => err instanceof PgGone,
    'the platform must answer 410 for a deleted member',
  );
  assert.deepEqual(s.loop.state().owed, [], 'the 410 pruned the unpayable conversation immediately');
});

// §4.3: the same nudge text is not delivered twice in a session, but each skipped due still
// spends one unit of budget. 61 of the 62 verbatim duplicate injections measured on the real
// run were nudges: the same `(conv, #seq)` was already in the context above.
test('an identical nudge is skipped and logged, but the skip still spends the budget', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'report back');
  await s.cycle();
  await s.timer(WINDOW); // the message is delivered
  await s.settle();
  await s.timer(WINDOW); // the first nudge
  assert.equal(s.surface.textsOfKind('nudge').length, 1, 'precondition: the first nudge went out');
  assert.equal(s.loop.state().nudges[s.dm], 1, 'precondition: the first nudge spent one unit of budget');

  // Nothing changed: same conversation, same seq, so the text is verbatim the same.
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = original;
  });

  const mark = s.surface.mark();
  await s.settle();
  await s.timer(WINDOW);

  assert.equal(
    s.surface.since(mark).length,
    0,
    `a verbatim repeat must not be delivered: ${JSON.stringify(s.surface.since(mark))}`,
  );
  assert.equal(s.loop.state().nudges[s.dm], 2, 'a skipped nudge still spends one unit of budget');
  const logged = warnings.filter((line) => line.includes('skipped a repeated nudge, identical to the last one this session'));
  assert.equal(logged.length, 1, `the skip must be logged once, got ${JSON.stringify(warnings)}`);
  assert.ok(
    logged[0].includes(`Unanswered messages: ${s.dm}`),
    `the log has to show which nudge was skipped, not just that one was: ${logged[0]}`,
  );

  // New information — a new seq — makes the text different, so the nudge goes out again.
  await send(s.platform, s.parent!.token, s.me.id, 'any news?');
  await s.cycle();
  await s.timer(WINDOW); // the message
  await s.settle();
  await s.timer(WINDOW); // the nudge naming the new seq
  assert.equal(
    s.surface.textsOfKind('nudge').length,
    2,
    `a nudge with new information must be delivered: ${JSON.stringify(s.surface.textsOfKind('nudge'))}`,
  );
  assert.equal(s.loop.state().nudges[s.dm], 3, 'the delivered nudge moves the budget again');
});
