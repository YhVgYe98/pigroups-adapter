// 概念稿 §8.1/§8.3: one queue, a tumbling time window, and delivery at a turn boundary.
//
// The window is checked by the same 5 s `tick()`, so every test here moves the injected
// clock and calls `tick()` (via `s.timer`) instead of waiting for wall time. A delivery
// starts a turn (the fake reports busy until the test settles), which is what makes the
// idle gate observable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { formatLocalMinute } from '../src/format.ts';
import { history, send } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, scenario, type Scenario } from './scenario.ts';

/** `<adapterDir>/journal/<memberId>/*.json`: the batches whose only copy is still on disk. */
async function journalEntries(s: Scenario): Promise<string[]> {
  const dir = join(s.adapterDir, 'journal', s.me.id);
  return (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json'));
}

/** `<adapterDir>/injected/<memberId>.json`: the seqs pi has echoed into the transcript. */
async function injected(s: Scenario): Promise<Record<string, number>> {
  try {
    const raw = await readFile(join(s.adapterDir, 'injected', `${s.me.id}.json`), 'utf8');
    return (JSON.parse(raw) as { injected?: Record<string, number> }).injected ?? {};
  } catch {
    return {};
  }
}

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

// 概念稿 §8.1: a delivery is one `sendMessage` with `triggerTurn`, so the turn boundary is
// the only moment it may happen. A member inside a 60 s tool receives the batch once, after
// the tool returns — not during it, and never twice.
test('a message that arrives while a tool is running is delivered once, after the tool returns', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle(); // drain the startup sequence: no DM exists yet, so nothing is injected

  // One turn, opened by a 60 s tool: it outlives the whole delivery window.
  s.surface.beginTurn();
  s.surface.emit({ type: 'tool_start', name: 'bash', argsPreview: '{"command":"sleep 60"}' });
  await send(s.platform, s.parent!.token, s.me.id, 'first');
  await send(s.platform, s.parent!.token, s.me.id, 'second');
  await s.cycle();

  assert.equal(s.surface.isBusy(), true, 'precondition: the tool is still running');
  assert.equal(s.surface.deliveries.length, 0, 'the window is open; nothing may be handed to pi yet');

  // The window closes inside the tool. Nothing goes out, and a second window does not
  // accumulate either.
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 0, 'a closed window is not a turn boundary');
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 0, 'no delivery may pile up inside one turn');

  // The tool returns and the turn ends: now the batch goes out, in arrival order, once.
  s.surface.emit({ type: 'tool_end', name: 'bash', ok: true });
  await s.settle();
  const delivered = s.surface.texts().join('\n');
  assert.equal(s.surface.deliveries.length, 1, `one turn boundary is one delivery, got:\n${delivered}`);
  assert.ok(delivered.includes('first'), delivered);
  assert.ok(delivered.includes('second'), delivered);
  assert.ok(delivered.indexOf('first') < delivered.indexOf('second'), `arrival order, got:\n${delivered}`);

  // The batch is in the transcript: later windows and ticks do not send it again. (A
  // reminder about the unanswered message may follow; the batch itself must not.)
  await s.timer(WINDOW);
  await s.settle();
  await s.timer(WINDOW);
  const copies = s.surface.texts().filter((text) => text.includes('first') && text.includes('second'));
  assert.equal(copies.length, 1, `the echoed batch must never be delivered twice, got:\n${s.surface.texts().join('\n---\n')}`);
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
  // The first batch started a turn; the remainder waits for that turn to end as well as
  // for its own window.
  await s.settle();
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

// §3.4: the commit point is pi's echo, not `deliver` returning. A turn that ends in a
// provider error after the echo does not take the batch back: the message is in the
// transcript, so the watermark and the journal entry stand and nothing is re-sent.
test('a batch pi echoed is committed even when its turn ends in a provider error', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  await s.cycle();
  const sibling = s.siblings[0];

  const sent = await send(s.platform, sibling.token, s.group, 'the message the error did not erase', [s.me.id]);
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1, 'precondition: the batch reached pi');
  assert.equal((await journalEntries(s)).length, 0, 'the echo already committed the journal entry');
  assert.equal((await injected(s))[s.group], sent.seq, 'the echo already moved the watermark');

  s.surface.settle({ message: 'provider 429 ×7' });
  await s.loop.settled();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 1, 'an errored end does not re-send an echoed batch');

  // A later abort does not replay it either: there is no copy left to take back.
  s.surface.settleAborted();
  await s.loop.settled();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 1, 'an abort has nothing to replay');
});

// 概念稿 §8.3: an abort ends the turn and nothing else. It does not deliver the queue and
// it does not replay what was already delivered; the queue waits for the NEXT boundary,
// a full window after the cut, so the work it interrupted cannot start a new turn in the
// same tick.
test('after an aborted turn nothing is delivered until a full window has passed', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'the batch that was already in the transcript');
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1, 'precondition: one batch went out');

  // The turn runs for another half window; a second message arrives inside it and the
  // operator cuts the turn. The service window would have expired 30 s from here.
  s.clock.advance(WINDOW / 2);
  await send(s.platform, s.parent!.token, s.me.id, 'queued behind the cut');
  await s.cycle();

  s.surface.settleAborted();
  await s.loop.settled();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 1, 'the abort must not deliver the queue');
  assert.ok(
    !s.surface.texts()[0].includes('queued behind the cut'),
    'the delivered batch cannot contain the message that arrived after it',
  );

  // Half a window after the cut: nothing. Without the re-opened window this moment is a
  // full window past the previous delivery and the batch would already be out.
  await s.timer(WINDOW / 2);
  assert.equal(s.surface.deliveries.length, 1, 'the abort re-opened the window; it did not close it');

  // One full window after the cut: the queued message goes out, once, and the batch that
  // already reached the transcript is not repeated.
  await s.timer(WINDOW / 2);
  assert.equal(s.surface.deliveries.length, 2, 'the queued work goes out one window after the abort');
  const after = s.surface.texts()[1];
  assert.ok(after.includes('queued behind the cut'), after);
  assert.ok(!after.includes('the batch that was already in the transcript'), `no replay: ${after}`);
});

// §3.4/§8.1: pi's `sendMessage` is void and swallows a start failure (`_startRun` threw:
// no API key, a compaction failure). The batch is then NOT in the transcript, so the
// records must not move; it is handed over again at the next idle+window, and the retry
// is what finally commits it.
test('a delivery whose run never started stays uncommitted and is retried at the next window', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  await s.cycle();
  const sibling = s.siblings[0];

  // pi accepted the call but no run started, and no `message_end` followed.
  s.surface.startFails = true;
  const sent = await send(s.platform, sibling.token, s.group, 'the batch a failed run swallowed', [s.me.id]);
  await s.cycle();
  await s.timer(WINDOW);

  assert.equal(s.surface.deliveries.length, 1, 'precondition: the call was made once');
  assert.equal(s.surface.isBusy(), false, 'precondition: no turn started');
  assert.equal((await journalEntries(s)).length, 1, 'the journal entry is still the only copy');
  assert.equal(
    (await injected(s))[s.group] ?? 0,
    0,
    'a watermark past a message that never arrived would lose it for good',
  );

  // pi is healthy again: the retry happens at the next window, without a second poll and
  // without the item being put back into the queue.
  s.surface.startFails = false;
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 2, 'the un-acknowledged batch is handed over again');
  const retry = s.surface.texts()[1];
  assert.ok(retry.includes('the batch a failed run swallowed'), retry);
  assert.ok(retry.includes(`#${sent.seq} `), `the retry keeps its marker: ${retry}`);

  assert.equal((await journalEntries(s)).length, 0, 'the echo committed the journal entry');
  assert.equal((await injected(s))[s.group], sent.seq, 'the watermark moved only after the echo');

  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 2, 'a committed batch is not sent a third time');
});
