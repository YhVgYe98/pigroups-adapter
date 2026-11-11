// §3.2 control items: abort, steer, unknown commands; §5.3 "only my superior commands me".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { command, createMember, poll, removeMember, send, waitFor, within } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, createLoop, scenario } from './scenario.ts';

// 概念稿 §8.3: an abort ends the turn; it does not open a delivery path of its own. The
// steer queued behind it keeps its window and waits for the NEXT turn boundary.
test('pg.abort cuts the turn and leaves the steer queued behind it in the window', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  s.surface.beginTurn();
  s.surface.holdAbort = true;
  await command(s.platform, s.parent!.token, s.me.id, 'pg.abort', { reason: 'stalled 12m' });
  await command(s.platform, s.parent!.token, s.me.id, 'pg.steer', { text: 'run the tests before you continue' });

  const drive = s.loop.pollOnce();
  await waitFor(() => s.surface.aborts.length === 1, 'abort() to be called');
  // Still inside the abort gate: nothing is delivered while a turn is being cut.
  assert.equal(s.surface.deliveries.length, 0, 'pg.abort injects no hint; nothing goes out during the cut');

  const releasedAt = Date.now();
  s.surface.releaseAbort();
  await drive;
  // The cut lands: pi reports the run as aborted and the loop re-opens the window.
  s.surface.settleAborted();
  await s.loop.settled();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 0, 'an abort must not deliver the steer it interrupted');

  // Half a window later it still has not gone out; one full window after the cut it does.
  await s.timer(WINDOW / 2);
  assert.equal(s.surface.deliveries.length, 0, 'the window after an abort is a real window');
  await s.timer(WINDOW / 2);

  const steer = s.surface.deliveries.filter((d) => d.text.includes('run the tests before you continue'));
  assert.equal(steer.length, 1, 'the queued steer is delivered once, at the next boundary');
  assert.equal(steer[0].kind, 'control');
  assert.ok(steer[0].at >= releasedAt, 'the steer arrives after the abort returned, not alongside it');
  assert.equal(
    s.surface.aborts.length,
    1,
    'the steer itself no longer aborts: pg_abort is the only way to change a member inside a tool',
  );
  assert.equal(s.surface.deliveries.length, 1, 'one closed window is one deliver');
});

// 概念稿 §8.3: the window exists for a reason the abort does not remove — a delivery is
// one `sendMessage` that starts a turn. What was pending behind a cut waits a full window.
test('pg.abort does not flush what is pending; the batch waits a full window after the cut', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  s.surface.beginTurn();
  await send(s.platform, s.parent!.token, s.me.id, 'already queued when the abort lands');
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 0, 'precondition: the message is inside its window');

  await command(s.platform, s.parent!.token, s.me.id, 'pg.abort', { v: 1 });
  await s.loop.pollOnce();
  assert.equal(s.surface.aborts.length, 1, 'precondition: the turn was cut');

  // The aborted turn end re-opens the window (概念稿 §8.3 ④).
  s.surface.settleAborted();
  await s.loop.settled();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 0, 'the abort itself delivers nothing');

  await s.timer(WINDOW - 1);
  assert.equal(s.surface.deliveries.length, 0, 'one millisecond short of a window is short');
  await s.timer(1);
  const delivered = s.surface.texts().join('\n');
  assert.ok(delivered.includes('already queued when the abort lands'), `the batch goes out one window later: ${delivered}`);
});

// 概念稿 §8.3: "abort, then say" also waits. The abort is not a licence to skip the window
// for everything that follows; it only guarantees the queue is not lost.
test('a message that arrives after the abort waits for its own full window', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  s.surface.beginTurn();
  await command(s.platform, s.parent!.token, s.me.id, 'pg.abort', { v: 1 });
  await s.loop.pollOnce();
  assert.equal(s.surface.aborts.length, 1, 'precondition: the abort was handled');
  assert.equal(s.surface.deliveries.length, 0, 'precondition: nothing was pending when the abort landed');

  s.surface.settleAborted();
  await s.loop.settled();

  await send(s.platform, s.parent!.token, s.me.id, 'the new direction after the cut');
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 0, 'the post-abort message opens its own window');

  await s.timer(WINDOW - 1);
  assert.equal(s.surface.deliveries.length, 0, 'a message after a cut is not rushed');
  await s.timer(1);
  const delivered = s.surface.texts().join('\n');
  assert.ok(delivered.includes('the new direction after the cut'), delivered);
});

// 概念稿 §8.1/§8.2: a steer is a control line like any other — it enters the window and
// waits for a turn boundary. Only pg_abort can change a member that is inside a long tool.
test('pg.steer never cuts a busy member and waits for the turn boundary', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  s.surface.beginTurn();
  await command(s.platform, s.parent!.token, s.me.id, 'pg.steer', { text: 'the new direction' });
  await s.loop.pollOnce();
  assert.equal(s.surface.aborts.length, 0, 'a steer is a message; it must not cut the running turn');
  assert.equal(s.surface.deliveries.length, 0, 'the steer enters the window');

  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 0, 'a closed window inside a turn delivers nothing');

  await s.settle();
  assert.equal(s.surface.deliveries.length, 1, 'the steer goes out at the turn boundary');
  assert.ok(s.surface.deliveries[0].text.includes('the new direction'));
  assert.equal(s.surface.deliveries[0].kind, 'control');
});

test('pg.steer from a sibling is ignored and does not call abort()', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await command(s.platform, sibling.token, s.me.id, 'pg.steer', { text: 'do this instead' });
  await s.cycle();
  await s.timer(WINDOW);

  assert.equal(s.surface.aborts.length, 0, 'a sibling must not be able to abort me');
  assert.equal(s.surface.deliveries.length, 0, 'a sibling must not be able to steer me');
});

test('sys.terminated stops the member: shutdown() is called and nothing further is delivered', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  await send(s.platform, s.parent!.token, s.me.id, 'something owed before the end');
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1);

  await removeMember(s.platform, s.parent!.token, s.me.id);
  await s.loop.pollOnce();

  assert.equal(s.surface.shutdowns.length, 1, 'sys.terminated must shut the member down');
  assert.ok(s.surface.shutdowns[0].length > 0, 'shutdown() takes a reason');

  const mark = s.surface.mark();
  await s.settle();
  await s.timer(WINDOW);
  assert.equal(s.surface.since(mark).length, 0, 'nothing may be delivered after the shutdown');
  assert.equal(s.surface.textsOfKind('nudge').length, 0, 'a stopped member must not keep nudging');
});

test('sys.terminated cuts the running turn before discarding the journal and shutting down', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  await s.cycle();

  const sibling = s.siblings[0];
  s.surface.beginTurn();
  await send(s.platform, sibling.token, s.group, 'queued until the cut', [s.me.id]);
  await s.loop.pollOnce();

  const journalDir = join(s.adapterDir, 'journal', s.me.id);
  const journalEntries = async (): Promise<string[]> =>
    (await readdir(journalDir).catch(() => [])).filter((name) => name.endsWith('.json'));
  const journalsBeforeTermination = await journalEntries();
  assert.equal(journalsBeforeTermination.length, 1, 'precondition: the queued batch is still journalled');

  const deliveriesMark = s.surface.mark();
  const lifecycleMark = s.surface.lifecycle.length;
  s.surface.holdAbort = true;
  await removeMember(s.platform, s.parent!.token, s.me.id);
  const drive = s.loop.pollOnce();
  await waitFor(() => s.surface.aborts.length === 1, 'the termination to cut the running turn');

  // A settle in the middle of the cut is the path that used to start a fresh turn.
  s.surface.settle();
  await s.loop.settled();
  await s.loop.flush();
  assert.equal(s.surface.since(deliveriesMark).length, 0, 'nothing may be delivered after the abort starts');
  assert.ok(
    (await journalEntries()).length >= journalsBeforeTermination.length,
    'the journal is discarded after the abort, not while waiting for it',
  );

  s.surface.releaseAbort();
  await drive;

  assert.deepEqual(
    s.surface.lifecycle.slice(lifecycleMark),
    ['abort', 'shutdown'],
    'the surface must record the cut before shutdown, with no delivery in between',
  );
  assert.equal(s.surface.shutdowns.length, 1, 'termination still shuts the member down');
  assert.equal((await journalEntries()).length, 0, 'the journal is still discarded');

  const afterShutdown = s.surface.mark();
  await s.settle();
  await s.timer(WINDOW);
  assert.equal(s.surface.since(afterShutdown).length, 0, 'nothing may be delivered after the shutdown');
});

test('sys.terminated reaches shutdown at the abort bound when the surface abort never returns', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  s.surface.beginTurn();
  s.surface.holdAbort = true;
  await removeMember(s.platform, s.parent!.token, s.me.id);

  const started = Date.now();
  await within(s.loop.pollOnce(), 'the termination to reach shutdown at the abort bound', 5000);
  const elapsed = Date.now() - started;

  assert.equal(s.surface.aborts.length, 1, 'the termination asks for the cut');
  assert.equal(s.surface.shutdowns.length, 1, 'a surface that never answers abort must not hold shutdown forever');
  assert.ok(elapsed >= 2900, `shutdown must wait for the abort bound, took ${elapsed}ms`);
  assert.ok(elapsed < 5000, `shutdown must not wait past the abort bound, took ${elapsed}ms`);
});

// §9: "`poll` 410 `member_gone` | 停止一切，`shutdown()`". `sys.terminated` is the other trigger:
// here the termination receipt is drained by hand first, so all `poll` can answer is 410.
test('a poll answered 410 member_gone stops the member', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'the work before the end');
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 1);

  await removeMember(s.platform, s.parent!.token, s.me.id);

  const drained = await poll(s.platform, s.me.token, { wait: 0, types: 'control' });
  assert.equal(drained.items.length, 1, 'precondition: the platform had exactly one receipt left');
  const [notice] = drained.items;
  assert.equal(notice.kind, 'control', 'precondition: the receipt was a control item');
  assert.equal((notice as { cmd: string }).cmd, 'sys.terminated', 'precondition: it was the termination notice');

  // Whether a gone member's `pollOnce` rejects or returns is not specified; stopping is.
  await s.loop.pollOnce().catch(() => undefined);

  assert.equal(s.surface.shutdowns.length, 1, 'a 410 from poll must shut the member down');
  assert.ok(s.surface.shutdowns[0].length > 0, 'shutdown() takes a reason');

  const mark = s.surface.mark();
  await s.settle();
  await s.timer(WINDOW);
  assert.equal(s.surface.since(mark).length, 0, 'nothing may be delivered after a 410');
  assert.equal(s.surface.textsOfKind('nudge').length, 0, 'a gone member must not keep nudging');
});

// §3.2's last row and §6's `v`: a `cmd` the adapter has never heard of is injected as-is, and a
// `pg.*` payload with a higher `v` is treated the same way rather than guessed at.
test('an unknown cmd and a pg.* payload with v:2 are injected, not dropped', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await command(s.platform, s.parent!.token, s.me.id, 'future.ping', {
    text: 'a command from a newer platform',
  });
  await command(s.platform, s.parent!.token, s.me.id, 'pg.inspect', {
    v: 2,
    request: 'r-v2',
    text: 'an inspect from a newer protocol',
  });
  await s.cycle();
  // Controls enter the same window as messages (概念稿 §8.4), so this takes one close.
  await s.timer(WINDOW);

  const control = s.surface.textsOfKind('control').join('\n');
  assert.ok(control.length > 0, `control items must be injected, got: ${JSON.stringify(s.surface.texts())}`);
  assert.ok(control.includes('a command from a newer platform'), `the unknown cmd was dropped: ${control}`);
  assert.ok(control.includes('an inspect from a newer protocol'), `the v:2 payload never reached the model: ${control}`);

  const answers = (await poll(s.platform, s.parent!.token, { wait: 0, types: 'control' })).items.filter(
    (item) => item.kind === 'control' && (item as { cmd: string }).cmd === 'pg.inspect_result',
  );
  assert.equal(answers.length, 0, 'a v:2 pg.inspect is not understood: it must not be answered as if it were v:1');
});

// §6: `pg.report` no longer exists. A control item with that cmd is an unknown control:
// it reaches the model verbatim and changes no telemetry state at all.
test('a pg.report is an unknown control line and changes no state', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'reporter');

  await command(s.platform, child.token, s.me.id, 'pg.report', {
    v: 1,
    status: 'blocked',
    text: 'exiting',
  });
  await s.cycle();
  await s.timer(WINDOW); // controls take the same window as messages

  const control = s.surface.textsOfKind('control').join('\n');
  assert.match(
    control,
    /^\[control m_[A-Za-z0-9_]+\] pg\.report /m,
    `an unknown command is injected verbatim: ${control}`,
  );
  assert.ok(control.includes('"text":"exiting"'), `the payload is not dropped: ${control}`);
  assert.equal(
    s.surface.textsOfKind('nudge').length,
    0,
    `a pg.report must not produce a telemetry reminder: ${JSON.stringify(s.surface.texts())}`,
  );
  assert.notEqual(
    (await s.loop.children()).find((row) => row.id === child.id)?.state,
    'gone',
    'a pg.report text exiting no longer moves the sender to gone',
  );
});

// §9: "`poll` 401 | 停循环，注入一条'token 失效'给 agent，等人工". The line is a transcript
// notice, not a queue item: with the idle gate a queued line would wait for a turn boundary,
// and the `stop()` right after it never allows one — the member would go silent without its
// model ever learning why. A 401 regularly lands in the middle of a turn, so this test runs
// it that way: `notice` must reach the transcript even while the agent is busy.
test('a 401 from poll hands the model the token line even when it arrives during a turn', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  // A second loop on the same platform, holding a token the platform rejects.
  const rejected = await createLoop(s.platform, s.me, { token: 'not-a-token' });
  t.after(() => rm(rejected.adapterDir, { recursive: true, force: true }));

  // The member is in the middle of a turn when the poll answers 401.
  rejected.surface.beginTurn();
  rejected.loop.start(); // `whoami` answers 401, which reaches `handlePollError`
  await waitFor(() => rejected.surface.deliveries.length === 1, 'the token line to reach the model');

  const [line] = rejected.surface.deliveries;
  assert.equal(line.kind, 'message');
  assert.equal(line.notice, true, 'the line is appended to the transcript, not handed to a turn');
  assert.match(line.text, /token/, 'the one line says the token is invalid');
  assert.match(line.text, /replace it and restart this session/, `the line is an English prompt: ${line.text}`);
  assert.equal(rejected.surface.isBusy(), true, 'precondition: the turn was still running');

  // The loop is stopped by then, and nothing may start a turn behind it.
  await within(rejected.loop.stop(), 'the loop to stop after a 401');
  const mark = rejected.surface.mark();
  rejected.clock.advance(WINDOW);
  rejected.loop.tick();
  assert.equal(await rejected.loop.flush(), false, 'a stopped loop delivers nothing');
  assert.equal(rejected.surface.since(mark).length, 0);
});
