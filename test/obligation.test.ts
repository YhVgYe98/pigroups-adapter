// §4 obligations: computed from history, one per conversation, and the adapter's own `blocked` report.

import test from 'node:test';
import assert from 'node:assert/strict';

import { quiet, send, waitFor } from './support.ts';
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
  await quiet(300);

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
  await quiet(300);

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
