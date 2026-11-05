// 概念稿 §8.1/§8.2: one queue, a tumbling time window, and delivery as a steer.
//
// The window is checked by the same 5 s `tick()`, so every test here moves the injected
// clock and calls `tick()` (via `s.timer`) instead of waiting for wall time.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLocalMinute } from '../src/format.ts';
import { history, send } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, scenario } from './scenario.ts';

test('a DM from the parent waits for its window, then arrives with the conversation id and the message seq', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  // Drain the startup sequence first: a DM that exists before the first poll is the brief,
  // and the brief is the one item that does not wait for a window (概念稿 §8.4).
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'implement X, accept Y');
  await s.cycle();

  assert.equal(s.surface.deliveries.length, 0, 'the first item opens the window; nothing goes out yet');

  await s.timer(WINDOW);

  assert.equal(s.surface.deliveries.length, 1, 'a closed window is exactly one deliver');
  const [delivery] = s.surface.deliveries;
  assert.equal(delivery.kind, 'message');
  assert.ok(delivery.text.includes(s.dm), `injected text must carry the conversation id, got: ${delivery.text}`);
  assert.ok(delivery.text.includes('#1'), `injected text must carry the message seq, got: ${delivery.text}`);
  assert.ok(delivery.text.includes('implement X'), 'injected text must carry the body');
});

// §3.3: a backlog delivered after a failure used to look exactly like a live message.
// The message's own `at` travels with it, in local time and minute precision.
test('a delivered message starts with its conversation, seq and the message local timestamp', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle(); // drain startup: no DM yet, so no windowless brief

  const sent = await send(s.platform, s.parent!.token, s.me.id, 'implement X, accept Y');
  const [record] = (await history(s.platform, s.me.token, s.dm, { limit: 1 })).items;
  assert.ok(record, 'the platform records the message it accepted');

  await s.cycle();
  await s.timer(WINDOW);

  const [delivery] = s.surface.deliveries;
  assert.ok(delivery, 'the message is delivered');
  assert.ok(
    delivery.text.startsWith(
      `[${s.dm}#${sent.seq} ${formatLocalMinute(record.created_at)}] ${s.parent!.name}: implement X, accept Y`,
    ),
    `the injected prefix carries the message time: ${delivery.text}`,
  );
});

// §3.3/§5.2: the shape and the timezone of every injected stamp are pinned here, not just
// computed with the same formatter the adapter uses. An assertion that compares against
// `formatLocalMinute` moves with the implementation; this one names the literal shape.
test('the injected header carries a YYYY-MM-DD HH:MM local stamp', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle(); // drain startup

  await send(s.platform, s.parent!.token, s.me.id, 'what is the date?');
  await s.cycle();
  await s.timer(WINDOW);

  const [delivery] = s.surface.deliveries;
  assert.ok(delivery, 'the message is delivered');
  assert.match(delivery.text, /^\[\S+#\d+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /, `the header shape is pinned: ${delivery.text}`);
});

test('items that arrive inside one window share a single delivery, in arrival order', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle(); // startup: no DM yet, so no windowless brief

  await send(s.platform, s.parent!.token, s.me.id, 'first');
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 0, 'precondition: the window is open');

  s.clock.advance(WINDOW / 2);
  await send(s.platform, s.parent!.token, s.me.id, 'second');
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 0, 'a second item joins the open window instead of delivering');

  await s.timer(WINDOW / 2); // the clock is now WINDOW past the first item
  const delivered = s.surface.texts().join('\n');
  assert.equal(s.surface.deliveries.length, 1, `one window is one deliver, got:\n${delivered}`);
  assert.ok(delivered.includes('first') && delivered.includes('second'), delivered);
  assert.ok(delivered.indexOf('first') < delivered.indexOf('second'), `arrival order, got:\n${delivered}`);
});

test('a group message that mentions me is delivered; one that does not is not delivered and starts no turn', async (t) => {
  // A sibling, not the parent: `from_parent` alone would deliver the unmentioned one (§3.3).
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await send(s.platform, sibling.token, s.group, 'please review my branch', [s.me.id]);
  await send(s.platform, sibling.token, s.group, 'lunch anyone?');
  await s.cycle();

  assert.equal(s.surface.deliveries.length, 0, 'the window is open; the unmentioned message is not queued');
  await s.timer(WINDOW);

  assert.equal(s.surface.deliveries.length, 1, 'only the mentioning message may start a turn');
  const [delivery] = s.surface.deliveries;
  assert.ok(delivery.text.includes('please review my branch'), delivery.text);
  assert.ok(!delivery.text.includes('lunch anyone'), `the unmentioned message leaked: ${delivery.text}`);
  assert.ok(delivery.text.includes(s.group), `injected text must carry the conversation id, got: ${delivery.text}`);
});

test('chatter is counted and appears as a suffix on the next real delivery, never on its own', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await send(s.platform, sibling.token, s.group, 'chatter one');
  await send(s.platform, sibling.token, s.group, 'chatter two');
  await send(s.platform, sibling.token, s.group, 'chatter three');
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 0, 'chatter must not start a turn, not even a window');

  await send(s.platform, s.parent!.token, s.me.id, 'the real task');
  await s.cycle();
  await s.timer(WINDOW);

  assert.equal(s.surface.deliveries.length, 1, 'the real message must produce one deliver');
  const [delivery] = s.surface.deliveries;
  assert.ok(delivery.text.includes('the real task'), delivery.text);
  assert.match(delivery.text, /and 3 unrelated messages/, `missing the chatter suffix: ${delivery.text}`);
});

test('a busy member still receives the window batch: delivery is a steer, not a wait for idle', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle(); // drain the startup sequence: no DM exists yet, so nothing is injected

  s.surface.beginTurn();
  await send(s.platform, s.parent!.token, s.me.id, 'first');
  await send(s.platform, s.parent!.token, s.me.id, 'second');
  await s.cycle();

  assert.equal(s.surface.isBusy(), true, 'precondition: a turn is running');
  assert.equal(s.surface.deliveries.length, 0, 'the window, not the busy flag, decides when');
  assert.equal(s.surface.heldCount, 0);

  await s.timer(WINDOW);

  const delivered = s.surface.texts().join('\n');
  assert.equal(s.surface.deliveries.length, 1, `one window is one steer, got:\n${delivered}`);
  assert.equal(s.surface.isBusy(), true, 'the turn is still running: the batch was steered into it');
  assert.ok(delivered.includes('first'), delivered);
  assert.ok(delivered.includes('second'), delivered);
  assert.ok(
    delivered.indexOf('first') < delivered.indexOf('second'),
    `held items must keep arrival order, got:\n${delivered}`,
  );
});

test('a gap that skipped messages naming me is delivered as a hint with its anchor; a gap of pure chatter is only counted', async (t) => {
  // `pollLimit` 2 forces the platform to fold everything older into a gap item (§6.4).
  const s = await scenario({ siblings: 1, pollLimit: 2 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  for (let i = 0; i < 5; i += 1) await send(s.platform, sibling.token, s.group, `chatter ${i}`);
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 0, 'a gap with nothing pointed at me must not start a turn');

  const pointed: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    pointed.push((await send(s.platform, sibling.token, s.group, `pointed ${i}`, [s.me.id])).seq);
  }
  await s.cycle();
  await s.timer(WINDOW);

  // `pollLimit` 2 keeps the newest two: the anchor is the seq of the earliest one kept (§6.4).
  const anchor = pointed[pointed.length - 2];

  const delivered = s.surface.texts().join('\n');
  assert.ok(delivered.includes('pointed 4'), `the newest messages are still delivered: ${delivered}`);
  assert.match(delivered, /skipped 3 messages/, `skipped mentions must surface a gap hint: ${delivered}`);
  assert.match(
    delivered,
    new RegExp(`before\\D{0,4}${anchor}`),
    `the hint must carry the re-read anchor (before=${anchor}): ${delivered}`,
  );
  assert.ok(s.loop.state().owed.includes(s.group), 'a gap that skipped a mention leaves the conversation owed');
});

test('the batch cap is a size valve, not a trigger: a full window sends ten and the rest waits for the next', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  for (let i = 0; i < 12; i += 1) await send(s.platform, s.parent!.token, s.me.id, `message ${i}`);
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 0, 'precondition: one window, nothing out yet');

  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1, 'the count closes no window and starts no second delivery');
  const first = s.surface.texts()[0];
  assert.ok(first.includes('message 9'), `the first ten go out: ${first}`);
  assert.ok(!first.includes('message 10'), `the eleventh must wait for the next window: ${first}`);

  assert.equal(s.surface.deliveries.length, 1, 'the remainder does not ride the same close');
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 2, 'the remainder goes out when the next window closes');
  const second = s.surface.texts()[1];
  assert.ok(second.includes('message 10') && second.includes('message 11'), second);
});

test('a settle is no longer a delivery trigger; the window is', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  // A turn is running, so the polled DM is queued and opens its window.
  s.surface.beginTurn();
  await send(s.platform, s.parent!.token, s.me.id, 'queued behind the turn');
  await s.cycle();

  // The turn ends with the window still open: a settle may enqueue a nudge, nothing more.
  await s.settle();
  assert.equal(s.surface.deliveries.length, 0, 'a settle must not deliver; it only lets the tick look');

  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1, 'the closed window delivers the queued work');
  assert.equal(s.surface.deliveries[0].kind, 'message', 'the queued message wins the window over the nudge');
  assert.ok(s.surface.deliveries[0].text.includes('queued behind the turn'));
  assert.deepEqual(s.loop.state().owed, [s.dm], 'the nudge was not delivered alongside the message');
});

test('a batch delivered into a provider-error turn is dropped; a later abort does not replay it', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'the message a failed turn did not necessarily show');
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1, 'precondition: the batch reached pi');

  // §3.4: a provider error proves neither that the model saw it nor that it did not, and
  // keeping the copy would put everything delivered during that turn under suspicion. The
  // measured cost of keeping it was 31 re-deliveries after `pg.abort` on a real run, so the
  // rule is "delivered means seen": the table goes.
  s.surface.settle({ message: 'provider 429 ×7' });
  await s.loop.settled();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 1, 'an errored end does not re-send by itself');

  s.surface.settleAborted();
  await s.loop.settled();
  await s.loop.flush();
  assert.equal(
    s.surface.deliveries.length,
    1,
    'the errored end dropped the copy, so a later abort has nothing to take back',
  );
});

test('a batch delivered into an aborted turn is put back and delivered again; a clean end clears it', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  const sent = await send(s.platform, s.parent!.token, s.me.id, 'the message the abort could swallow');
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1, 'precondition: the batch reached pi');
  assert.ok(s.surface.deliveries[0].text.includes(`#${sent.seq}`), s.surface.deliveries[0].text);

  // pi drops a steer still queued when an abort lands; the turn ends `aborted`.
  s.surface.settleAborted();
  await s.loop.settled();
  await s.loop.flush();

  assert.equal(s.surface.deliveries.length, 2, 'the aborted turn must hand the batch back');
  const replay = s.surface.deliveries[1].text;
  assert.ok(replay.includes('the message the abort could swallow'), replay);
  assert.ok(replay.includes(`[${s.dm}#${sent.seq} `), `the duplicate still carries its marker: ${replay}`);

  // A clean turn end means pi kept it: nothing is re-sent.
  s.surface.settle();
  await s.loop.settled();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 2, 'a clean end clears the copy');
});

test('two batches steered into one still-running turn are both re-sent, in delivery order, when that turn is aborted', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  // One long tool: the turn stays open across both windows, so both deliveries are
  // steers into the same turn — the case one `lastDelivered` slot cannot cover.
  s.surface.beginTurn();

  await send(s.platform, s.parent!.token, s.me.id, 'batch one');
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1, 'precondition: batch one reached the turn');

  await send(s.platform, s.parent!.token, s.me.id, 'batch two');
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 2, 'precondition: batch two was steered into the same turn');

  // The abort takes back both steers, not just the last one.
  s.surface.settleAborted();
  await s.loop.settled();
  await s.loop.flush();

  assert.equal(s.surface.deliveries.length, 3, 'the aborted turn must hand the batches back');
  const replay = s.surface.deliveries[2].text;
  assert.ok(replay.includes('batch one'), `batch one must be re-delivered, got:\n${replay}`);
  assert.ok(replay.includes('batch two'), replay);
  assert.ok(
    replay.indexOf('batch one') < replay.indexOf('batch two'),
    `the batches must be re-delivered in delivery order, got:\n${replay}`,
  );
});

test('the unacknowledged list is capped: a turn that outlives the cap loses only the oldest copy', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();
  s.surface.beginTurn();

  // One delivery per window; nine is one more than the cap of eight (§8.3 ②).
  const batches = 9;
  for (let i = 1; i <= batches; i += 1) {
    await send(s.platform, s.parent!.token, s.me.id, `batch ${i}`);
    await s.cycle();
    await s.timer(WINDOW);
  }
  assert.equal(s.surface.deliveries.length, batches, 'precondition: one delivery per window');

  s.surface.settleAborted();
  await s.loop.settled();
  await s.loop.flush();

  assert.equal(s.surface.deliveries.length, batches + 1, 'the abort replays the batches it still holds');
  const replay = s.surface.texts().slice(batches).join('\n');
  assert.ok(!replay.includes('batch 1'), `the oldest copy was dropped: ${replay}`);
  for (let i = 2; i <= batches; i += 1) {
    assert.ok(replay.includes(`batch ${i}`), `batch ${i} must survive the cap, got:\n${replay}`);
  }
});
