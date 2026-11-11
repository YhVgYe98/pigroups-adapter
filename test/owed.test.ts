// §4.2/§4.3: the owed reply is a persisted flag, not something re-derived from history,
// and `pg_ack` is the local way out of it. The ledger file is
// `<adapterDir>/owed/<memberId>.json`, so every test reads it from disk rather than
// trusting `loop.state()`: what survives a restart is exactly what is in that file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { delay, dmId, history, poll, quiet, send, waitFor } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, createLoop, payloads, scenario, type Scenario } from './scenario.ts';

interface LedgerFile {
  owed: Record<string, { seq: number; since: number }>;
  acks: Array<{ conv: string; seq: number; at: number }>;
  /** Absent in files written before Q2's fix; treated as empty. */
  cleared?: Record<string, number>;
}

/** `undefined` means "no file", which is the state the one-time reconciliation exists for. */
async function readLedger(s: { adapterDir: string; me: { id: string } }): Promise<LedgerFile | undefined> {
  const path = join(s.adapterDir, 'owed', `${s.me.id}.json`);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LedgerFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** §5.1: the blocked attention whose note names this episode's reason (§4.3's audit trail). */
function blockedWithNote(items: Array<{ cmd: string; payload: unknown }>, text: string): Array<Record<string, any>> {
  return payloads(items as never, 'pg.attention').filter(
    (payload) => payload.state === 'blocked' && payload.note === text,
  );
}

test('a delivered message writes its owed flag to <adapterDir>/owed/<memberId>.json, and a reply removes it', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  const sent = await send(s.platform, s.parent!.token, s.me.id, 'the task');
  await s.cycle();
  await s.timer(WINDOW);

  const written = await readLedger(s);
  assert.ok(written, `the flag must be on disk before anything else can trust it: ${JSON.stringify(written)}`);
  assert.deepEqual(Object.keys(written.owed), [s.dm], 'one conversation, one flag');
  assert.equal(written.owed[s.dm].seq, sent.seq, 'the flag names the seq the nudge will quote');
  assert.equal(typeof written.owed[s.dm].since, 'number', '`since` is the instant the flag became non-empty');

  await s.loop.say(s.parent!.id, 'on it');

  const after = await readLedger(s);
  assert.deepEqual(after?.owed, {}, 'a reply clears the persisted flag, not just the in-memory view');
  assert.deepEqual(s.loop.state().owed, [], 'and the loop agrees with the file');
});

// §4.2: "启动简报不置 flag". The brief is a one-to-one message from the parent, so the
// delivery rule would give the member a debt for its own task book.
test('the startup brief does not create a debt of its own', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  // Not polled yet: the message is the brief read from history *and* a queued inbox copy.
  const brief = await send(s.platform, s.parent!.token, s.me.id, 'the task book that is also the brief');
  s.loop.start();
  await waitFor(() => s.surface.deliveries.length > 0, 'the startup brief to be injected');
  await s.loop.pollOnce();
  await s.loop.flush();
  await quiet(300);

  assert.ok(
    s.surface.deliveries[0].text.includes(`[${s.dm}#${brief.seq} `),
    `precondition: the first injection is the brief, got ${s.surface.deliveries[0].text}`,
  );
  assert.deepEqual(
    s.loop.state().owed,
    [],
    'a member cannot owe a reply for the task book it was just handed',
  );
  const written = await readLedger(s);
  assert.deepEqual(written?.owed ?? {}, {}, 'and nothing about the brief may be written to the ledger');
});

// §4.2: "文件存在就以文件为准". The history is not consulted again, in either direction.
test('a restart takes the ledger file as the truth: a flag the history would clear survives', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  const sent = await send(s.platform, s.parent!.token, s.me.id, 'delivered, never answered');
  await s.cycle();
  await s.timer(WINDOW);
  assert.deepEqual(s.loop.state().owed, [s.dm], 'precondition: the flag exists');

  // I speak in that conversation outside the adapter, so the last message in the history
  // is mine — the shape a "derive it from history" restart reads as answered.
  await send(s.platform, s.me.token, s.parent!.id, 'a message the ledger never heard about');
  // `GET /v1/messages` serves a page oldest-first, so the last element is the newest.
  const latest = await history(s.platform, s.me.token, s.dm, { limit: 2 });
  assert.equal(latest.items[1]?.sender_id, s.me.id, 'precondition: history now ends with my own message');
  assert.equal(latest.items[0]?.seq, sent.seq, 'precondition: the delivered message is the one before it');

  await s.stop(); // stop the loop, keep the adapter directory for the restart

  const restarted = await createLoop(s.platform, s.me, { adapterDir: s.adapterDir });
  try {
    await restarted.loop.pollOnce(); // the whole startup sequence, reconciliation included
    assert.deepEqual(
      restarted.loop.state().owed,
      [s.dm],
      'the file is the truth: only a reply or an ack clears a flag, never the history moving on',
    );
    assert.equal(
      (await readLedger({ adapterDir: restarted.adapterDir, me: s.me }))?.owed[s.dm].seq,
      sent.seq,
      'the restart did not rewrite it',
    );
  } finally {
    await restarted.stop();
  }
});

// §4.2: "启动简报不置 flag" is about *the task book `pg_spawn` sent*, not about whatever
// the parent happened to say last. A member that was down while its parent sent an
// instruction used to come back, inject that instruction, call it the brief and clear it
// of any debt — a message in the context that nothing was owed for, so nothing could
// nudge it, `idle_owed` never saw it, and a restart forgot it entirely.
test('a message that arrived while the member was down is owed, not mistaken for the brief', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'the original task book');
  await s.cycle();
  await s.timer(WINDOW);
  assert.deepEqual(s.loop.state().owed, [s.dm], 'precondition: the first message is owed');
  await s.loop.say(s.parent!.id, 'done with that');
  assert.deepEqual(s.loop.state().owed, [], 'precondition: answered, so the ledger is empty but written');

  await s.stop(); // the member is down; the adapter directory (and its ledger) stays

  await send(s.platform, s.parent!.token, s.me.id, 'a new instruction sent while you were down');
  const restarted = await createLoop(s.platform, s.me, { adapterDir: s.adapterDir });
  try {
    await restarted.loop.pollOnce();
    assert.match(
      restarted.surface.texts().join('\n'),
      /a new instruction sent while you were down/,
      'precondition: the message reaches the context through the startup read',
    );
    assert.deepEqual(
      restarted.loop.state().owed,
      [s.dm],
      'the brief is the one `pg_spawn` sent; anything newer the parent said is a message someone owes a reply to',
    );
  } finally {
    await restarted.stop();
  }
});

// §4.2's fallback: a file that does not exist yet (first start, or an upgrade) is the only
// time the four §4.1 triggers are read out of history — and the brief is not one of them.
test('with no ledger file the adapter reconciles once from history and persists what it found', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  // The sibling writes privately, and the member's inbox is drained before it starts, so
  // nothing but the reconciliation can know about this message.
  const sent = await send(s.platform, sibling.token, s.me.id, 'ping while you were down');
  const drained = await poll(s.platform, s.me.token, { wait: 0, types: 'message' });
  assert.equal(drained.items.length, 1, 'precondition: the message was consumed, not delivered');
  // And I spoke last in the DM with my parent: that conversation must not be marked.
  await send(s.platform, s.me.token, s.parent!.id, 'my own last word there');

  assert.equal(await readLedger(s), undefined, 'precondition: no ledger file exists');

  await s.loop.pollOnce(); // the startup sequence, reconciliation included

  const peerDm = dmId(s.me.id, sibling.id);
  assert.deepEqual(s.loop.state().owed, [peerDm], 'only the conversation whose last message is not mine is owed');
  const written = await readLedger(s);
  assert.ok(written, 'the reconciliation must persist what it found, or the next restart repeats it');
  assert.equal(written.owed[peerDm].seq, sent.seq, 'it persists the seq it read');
  assert.equal(typeof written.owed[peerDm].since, 'number');
});

// §4.2's fallback must be all-or-nothing: the flags are written only after every history
// read has succeeded. Writing as it went turned one failed read into a permanent skip — the
// file existed on the retry, so `load()` returned true and the conversation whose read had
// thrown was never reconciled again (Q9).
//
// A failed courtesy is reported, not fatal: startup still becomes ready and keeps the
// journal/ledger for the next process to retry (the respawn repair must not be disabled).
test('a failed reconciliation writes no flags and is retried by the next startup', async (t) => {
  const s = await scenario({ siblings: 2 });
  t.after(() => s.close());
  const [first, second] = s.siblings;

  await send(s.platform, first.token, s.me.id, 'from the first sibling');
  await send(s.platform, second.token, s.me.id, 'from the second sibling');
  // Drained, so nothing but the fallback's history read can find these messages.
  const drained = await poll(s.platform, s.me.token, { wait: 0, types: 'message' });
  assert.equal(drained.items.length, 2, 'precondition: both messages were consumed, not delivered');
  assert.equal(await readLedger(s), undefined, 'precondition: no ledger file exists');

  // Fail the *second* conversation's read. The reconciliation reads them in this order,
  // so the first one already succeeded when the second throws: a write-as-you-go ledger
  // would have persisted that first flag and then made `load()` trust the half-written file.
  const items = (await s.pg.conversations()).items;
  assert.ok(items.length >= 2, 'precondition: at least two conversations to reconcile');
  const failing = items[1].to;
  const original = s.pg.messages.bind(s.pg);
  s.pg.messages = async (input) => {
    if (input.to === failing) throw new Error('history read failed');
    return original(input);
  };
  t.after(() => {
    s.pg.messages = original;
  });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  await s.loop.pollOnce(); // the courtesy failure is reported, not thrown to run()
  assert.equal(
    warnings.filter((warning) => /reconcileObligations/.test(warning)).length,
    1,
    `exactly one warning must name the step: ${JSON.stringify(warnings)}`,
  );
  assert.equal(
    await readLedger(s),
    undefined,
    'a reconciliation that did not finish must leave no ledger behind, or the retry would trust it',
  );
  assert.deepEqual(s.loop.state().owed, [], 'and no flag may survive in memory either');

  // The failure is gone: the next process's startup reads history again and writes it all.
  s.pg.messages = original;
  await s.loop.stop();
  const restarted = await createLoop(s.platform, s.me, { adapterDir: s.adapterDir });
  try {
    await restarted.loop.pollOnce();

    const written = await readLedger(s);
    assert.ok(written, 'the retry must persist what it found');
    const expected = [dmId(s.me.id, first.id), dmId(s.me.id, second.id)].sort();
    assert.deepEqual(Object.keys(written.owed).sort(), expected, 'both debts are written, not just the first');
    assert.deepEqual(restarted.loop.state().owed.slice().sort(), expected, 'and the loop agrees with the file');
  } finally {
    await restarted.stop();
  }
});

// §4.2's fallback, for the other way a file can be absent: half a file. A crash mid-write
// (no temp file + rename would leave this) must not kill the startup — the documented choice
// is to treat it as missing and reconcile from history.
test('a corrupt ledger is reconciled from history instead of breaking the startup', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await send(s.platform, sibling.token, s.me.id, 'ping while you were down');
  // Drained, so nothing but the reconciliation can find this message.
  await poll(s.platform, s.me.token, { wait: 0, types: 'message' });
  const peerDm = dmId(s.me.id, sibling.id);

  await mkdir(join(s.adapterDir, 'owed'), { recursive: true });
  await writeFile(join(s.adapterDir, 'owed', `${s.me.id}.json`), '{"owed":{"dm:', 'utf8');

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = original;
  });

  await s.loop.pollOnce();

  assert.ok(
    warnings.some((line) => line.includes('unreadable owed ledger')),
    `a half-written ledger is reported, not swallowed: ${JSON.stringify(warnings)}`,
  );
  assert.deepEqual(s.loop.state().owed, [peerDm], 'the fallback read the history instead of trusting the file');
  const rewritten = await readLedger(s);
  assert.ok(rewritten, 'and the file is rewritten, so the next start has something real to trust');
  assert.equal(rewritten.owed[peerDm].seq > 0, true, 'the reconciliation persisted the seq it found');
});

// §4.2: "`seq` 只在更大时覆盖，`since` 只在 flag 从空变非空时写一次". A second message in the
// same conversation is still one debt, and the clock that §4.1's roster snapshot judges it
// by does not restart. (An aborted turn no longer re-delivers anything — 概念稿 §8.3 — so
// the "redelivery" half of this test now lives in `delivery.test.ts`.)
test('a bigger seq moves the flag forward and keeps since', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'the first message');
  await s.cycle();
  await s.timer(WINDOW);
  const first = (await readLedger(s))!.owed[s.dm];
  assert.ok(first, 'precondition: the flag is written');

  // The turn the first delivery started ends before the next message is delivered.
  await s.settle();
  s.clock.advance(5_000);

  const second = await send(s.platform, s.parent!.token, s.me.id, 'and a newer one');
  await s.cycle();
  await s.timer(WINDOW);
  assert.equal(s.surface.deliveries.length, 2, 'precondition: the second message went out');

  const moved = (await readLedger(s))!.owed[s.dm];
  assert.equal(moved.seq, second.seq, 'the nudge must quote the newest message it covers');
  assert.equal(moved.since, first.since, 'one flag covers everything since it was first set');
});

// §4.2 / Q2: the ledger remembers the seq each clear settled, so a set at or below it can
// only advance the ack bound, never open the debt again. The abort no longer replays the
// batch it interrupted (概念稿 §8.3), so this covers the surviving path to a re-set: the
// debt is cleared, the turn is cut, and nothing comes back to re-open it.
test('an aborted turn does not re-open a debt that say() already cleared', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  const sent = await send(s.platform, s.parent!.token, s.me.id, 'the message the cut turn contained');
  await s.cycle();
  await s.timer(WINDOW);
  assert.deepEqual(s.loop.state().owed, [s.dm], 'precondition: the delivered message is owed');

  await s.loop.say(s.parent!.id, 'answered before the abort');
  assert.deepEqual(s.loop.state().owed, [], 'precondition: say() cleared the flag');
  const cleared = await readLedger(s);
  assert.deepEqual(cleared?.owed, {}, 'precondition: the cleared flag is gone from disk');
  assert.deepEqual(cleared?.cleared, { [s.dm]: sent.seq }, 'the ledger remembers the seq the reply settled');

  // The turn is cut after the answer. Nothing is replayed: the batch was already echoed.
  s.clock.advance(5_000);
  s.surface.settleAborted();
  await s.loop.settled();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 1, 'the aborted turn must not re-deliver the batch');

  assert.deepEqual(s.loop.state().owed, [], 'an answered message must not become owed again');
  assert.deepEqual((await readLedger(s))?.owed, {}, 'and the ledger must not re-open it');

  const mark = s.surface.mark();
  await s.settle();
  await s.timer(WINDOW);
  assert.equal(
    s.surface.since(mark).length,
    0,
    `no nudge may name a conversation the model already answered: ${JSON.stringify(s.surface.since(mark))}`,
  );
});

// ---------------------------------------------------------------------------
// §4.3: `pg_ack`
// ---------------------------------------------------------------------------

test('pg_ack clears the flag without sending anything, and leaves the nudge budget alone', async (t) => {
  // One nudge is the whole budget, so "the budget survived the ack" is observable: a
  // reset would immediately produce another nudge and another blocked report.
  const s = await scenario({ nudgeMax: 1 });
  t.after(() => s.close());
  await s.cycle();

  const sent = await send(s.platform, s.parent!.token, s.me.id, 'status please');
  await s.cycle();
  await s.timer(WINDOW); // delivered → owed
  await s.settle();
  await s.timer(WINDOW); // nudged once: the budget is now spent
  assert.equal(s.loop.state().nudges[s.dm], 1, 'precondition: one nudge was delivered');
  await s.settle(); // the spent budget reports blocked
  await s.timer(WINDOW);
  const blockedBefore = blockedWithNote(await s.controlsToParent(), `no output after 1 nudges (${s.dm})`);
  assert.equal(blockedBefore.length, 1, 'precondition: this conversation was reported blocked');

  const before = await history(s.platform, s.me.token, s.dm, { limit: 200 });
  const result = await s.loop.ack({ conv: s.dm });

  assert.deepEqual(result.cleared, [{ conv: s.dm, seq: sent.seq }], 'the ack names what it cleared');
  assert.deepEqual(result.remaining, [], 'nothing is left owed');
  assert.deepEqual(s.loop.state().owed, [], 'the flag is gone');
  const after = await history(s.platform, s.me.token, s.dm, { limit: 200 });
  assert.equal(after.items.length, before.items.length, 'an ack sends no message and writes no history');

  const written = await readLedger(s);
  assert.deepEqual(written?.owed, {}, 'the flag is gone from the file too');
  assert.equal(written?.acks.length, 1, 'the ack is audited locally');
  assert.deepEqual(
    { conv: written!.acks[0].conv, seq: written!.acks[0].seq },
    { conv: s.dm, seq: sent.seq },
    'the audit record names the conversation and the seq',
  );

  // The debt comes back, and the ack left the spent budget and the reported episode
  // where they were: no fresh nudge, no second report.
  await send(s.platform, s.parent!.token, s.me.id, 'and one more thing');
  await s.cycle();
  await s.timer(WINDOW); // delivered, so this conversation is owed again
  assert.deepEqual(s.loop.state().owed, [s.dm], 'precondition: a new debt exists');
  const nudgesBefore = s.surface.textsOfKind('nudge').length;
  await s.settle();
  await s.timer(WINDOW);
  assert.equal(
    s.surface.textsOfKind('nudge').length,
    nudgesBefore,
    'an ack must not hand out a fresh nudge budget',
  );
  assert.equal(
    blockedWithNote(await s.controlsToParent(), `no output after 1 nudges (${s.dm})`).length,
    0,
    'and it must not end the blocked episode, so the parent is not told again',
  );
});

// §4.3: `conv` is required, and wiping every debt has to be said out loud.
test('pg_ack needs a conversation, and clearing everything needs all:true', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'the dm');
  await send(s.platform, s.parent!.token, s.group, 'the group task', [s.me.id]);
  await s.cycle();
  await s.timer(WINDOW);
  assert.deepEqual(s.loop.state().owed.slice().sort(), [s.dm, s.group].sort(), 'precondition: two debts');

  await assert.rejects(() => s.loop.ack({ conv: '' }), /conv/, 'conv is required, even when all is asked for');
  await assert.rejects(() => s.loop.ack({ conv: '', all: true }), /conv/, 'all:true does not stand in for conv');

  const one = await s.loop.ack({ conv: s.dm });
  assert.deepEqual(one.cleared.map((entry) => entry.conv), [s.dm], 'one conversation is cleared');
  assert.deepEqual(one.remaining.map((entry) => entry.conv), [s.group], 'the other one stays owed');

  const groupBefore = await history(s.platform, s.me.token, s.group, { limit: 200 });
  const all = await s.loop.ack({ conv: s.dm, all: true });
  assert.deepEqual(all.cleared.map((entry) => entry.conv), [s.group], 'all:true clears what is left');
  assert.deepEqual(all.remaining, [], 'and reports nothing remaining');
  assert.deepEqual(s.loop.state().owed, []);
  const groupAfter = await history(s.platform, s.me.token, s.group, { limit: 200 });
  assert.equal(groupAfter.items.length, groupBefore.items.length, 'acking a group debt writes nothing into the group');

  // §4.3: the `acks` record is the only trace a silent confirmation leaves, so every
  // branch — one conversation and `all:true` — has to write it.
  const written = await readLedger(s);
  assert.deepEqual(
    (written?.acks ?? []).map((ack) => ack.conv).sort(),
    [s.dm, s.group].sort(),
    `every cleared conversation is in the audit trail, got ${JSON.stringify(written?.acks)}`,
  );
});

// §4.3 + Q11: the bound is "the largest seq this adapter delivered **or named**", not the
// injection watermark. A `gap` anchor is named and owed but never injected (§3.4), so a
// watermark-derived bound would refuse the very seq the nudge asked the model to ack.
test('pg_ack refuses a seq this adapter never named, and accepts a gap anchor it did', async (t) => {
  const s = await scenario({ siblings: 1, pollLimit: 2 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await send(s.platform, sibling.token, s.group, 'the pointed message', [s.me.id]);
  for (let i = 0; i < 3; i += 1) await send(s.platform, sibling.token, s.group, `chatter ${i}`);
  await s.cycle();
  await s.timer(WINDOW);

  const delivered = s.surface.texts().join('\n');
  assert.match(delivered, /skipped 2 messages/, `precondition: the mention was folded into a gap: ${delivered}`);

  const flag = (await readLedger(s))?.owed[s.group];
  assert.ok(flag, 'the gap sets the flag with its backfill anchor as the seq');

  await assert.rejects(
    () => s.loop.ack({ conv: s.group, seq: flag.seq + 100 }),
    /never named or delivered in .*call pg_read/,
    'a model may not ack past what it has been shown; it must pg_read first',
  );

  const cleared = await s.loop.ack({ conv: s.group, seq: flag.seq });
  assert.deepEqual(
    cleared.cleared,
    [{ conv: s.group, seq: flag.seq }],
    'the anchor is a seq the adapter named, so the very seq the nudge quoted can be acked',
  );
});

// §4.3: "要清更后面的，先 `pg_read`". The bound exists so a model cannot confirm what it was
// never shown — and a `pg_read` is exactly "shown". If reading does not move the bound, the
// error message sends the model to a `pg_read` that changes nothing and the very same ack is
// refused again: an exit that does not exist.
test('pg_read is how a later seq becomes confirmable: what a read returned counts as seen', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await send(s.platform, sibling.token, s.group, 'the pointed message', [s.me.id]);
  await s.cycle();
  await s.timer(WINDOW); // delivered → owed at that seq

  // After it, three messages the adapter only counts as chatter (no mention, not my parent):
  // they are in the history, so `pg_read` can show them, but nothing delivers them.
  for (let i = 0; i < 3; i += 1) await send(s.platform, sibling.token, s.group, `chatter ${i}`);
  await s.cycle();
  const newest = await send(s.platform, sibling.token, s.group, 'the newest thing said');
  await s.cycle();

  assert.deepEqual(s.loop.state().owed, [s.group], 'precondition: the conversation still owes a reply');
  await assert.rejects(
    () => s.loop.ack({ conv: s.group, seq: newest.seq }),
    /never named or delivered in .*call pg_read/,
    'precondition: the adapter has neither delivered nor named the newest seq',
  );

  const read = await s.loop.read({ conv: s.group });
  assert.match(
    read,
    new RegExp(`\\[${s.group}#${newest.seq}\\] sibling-0: the newest thing said`),
    `the read must hand the model the message it is about to confirm: ${read}`,
  );

  const acked = await s.loop.ack({ conv: s.group, seq: newest.seq });
  assert.deepEqual(
    acked.cleared.map((entry) => entry.conv),
    [s.group],
    'the very seq the error message sent the model to read is now confirmable',
  );
  assert.deepEqual(acked.remaining, [], 'and the debt is gone');
});

// §4.3: a confirmation is silent and answers `{cleared, remaining}`; the upper bound is a
// guardrail against confirming what was never shown, not a requirement that a debt exist.
// After a restart the in-memory bound starts empty, so a repeat of an ack that already went
// through must not come back as an error that names a `pg_read` exit nobody needs.
test('an ack for a conversation with nothing owed is a silent no-op, not an error', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  const result = await s.loop.ack({ conv: s.group, seq: 71 });
  assert.deepEqual(result.cleared, [], 'there was nothing to clear, and nothing was cleared');
  assert.deepEqual(result.remaining, [], 'the answer is the ordinary shape, not a thrown error');
  assert.deepEqual(s.loop.state().owed, [], 'and no flag appeared out of nowhere');
});

// §4.3: `seq` is a number.
test('pg_ack rejects a seq that is not a positive integer', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();
  await send(s.platform, s.parent!.token, s.me.id, 'anything');
  await s.cycle();
  await s.timer(WINDOW);

  await assert.rejects(() => s.loop.ack({ conv: s.dm, seq: 0 }), /positive integer/);
  await assert.rejects(() => s.loop.ack({ conv: s.dm, seq: Number.NaN }), /positive integer/);
  assert.deepEqual(s.loop.state().owed, [s.dm], 'a rejected ack leaves the debt where it was');
});

// §4.3/§5.1: "同一会话连续 ack ≥3 次且期间没有任何回复时" — acking is not doing the work,
// and the parent is the only one who can act on that. The state is per conversation:
// a no-op ack does not count, the entry is sent once, and `pg_say` leaves it.
test('three real acks enter silent_acking once; a no-op ack does not count and say() leaves', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  // A no-op ack has no flag to clear, so it is not one of the three confirmations.
  const noop = await s.loop.ack({ conv: s.group, seq: 71 });
  assert.deepEqual(noop.cleared, [], 'precondition: the no-op ack cleared nothing');

  // Each counting ack needs a fresh flag. The delivery starts a turn, so each round ends
  // that turn too; the ack clears the debt before the settle, so no nudge follows it.
  const ackRound = async (round: number): Promise<void> => {
    await send(s.platform, s.parent!.token, s.me.id, `round ${round}`);
    await s.cycle();
    await s.timer(WINDOW);
    await s.loop.ack({ conv: s.dm });
    await s.settle();
  };

  for (let i = 0; i < 2; i += 1) await ackRound(i);
  assert.equal(
    payloads(await s.controlsToParent(), 'pg.attention').filter((payload) => payload.state === 'silent_acking').length,
    0,
    'two real acks (plus a no-op) are not yet three',
  );

  await ackRound(2);
  const first = payloads(await s.controlsToParent(), 'pg.attention').filter(
    (payload) => payload.state === 'silent_acking',
  );
  assert.equal(first.length, 1, `three real acks enter silent_acking once, got ${JSON.stringify(first)}`);
  assert.deepEqual(first[0].owed, [s.dm], 'the state names the conversation it is about');

  // A fourth ack is the same set: the state is not re-sent.
  await ackRound(3);
  assert.equal(
    payloads(await s.controlsToParent(), 'pg.attention').filter((payload) => payload.state === 'silent_acking').length,
    0,
    'the same set must not repeat inside one episode',
  );

  // A reply is the member speaking: it leaves silent_acking and resets the run.
  await s.loop.say(s.parent!.id, 'here is the actual answer');
  await delay(50);
  const left = payloads(await s.controlsToParent(), 'pg.attention').filter(
    (payload) => payload.state === 'recovered' && payload.of === 'silent_acking',
  );
  assert.equal(left.length, 1, 'pg_say is the exit from silent_acking');

  for (let i = 0; i < 3; i += 1) await ackRound(4 + i);
  assert.equal(
    payloads(await s.controlsToParent(), 'pg.attention').filter((payload) => payload.state === 'silent_acking').length,
    1,
    'after a reply, a new run of three acks is a new episode and enters again',
  );
});
