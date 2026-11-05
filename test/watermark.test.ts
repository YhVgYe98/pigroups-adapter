// §3.4: one injection per (conv, seq), whichever path it arrives by — the startup brief
// (§8 step 3, read from history), a poll delivery of the copy still sitting in the inbox,
// or a journal replay. The watermark is persisted in PIGROUPS_ADAPTER_DIR, so the copy the
// brief already read is not injected again after a restart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

import { quiet, send, waitFor } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, createLoop, scenario } from './scenario.ts';

/** The injected text carries `[<to>#<seq>]`; count how often one message id appears. */
function injections(text: string, dm: string, seq: number): number {
  return text.split(`[${dm}#${seq} `).length - 1;
}

test('the startup brief and the polled copy of the same message are injected once', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  // The parent's DM is the startup brief, and it is still queued in the member's inbox
  // because the member has never polled: the overlap §3.4 exists for.
  const sent = await send(s.platform, s.parent!.token, s.me.id, 'the brief that is still queued');
  s.loop.start();
  await waitFor(() => s.surface.deliveries.length > 0, 'the startup brief to be injected');

  // The platform now delivers that same (conv, seq) through the poll path.
  await s.loop.pollOnce();
  await s.loop.flush();
  await quiet(300); // and the poll loop behind start() may meet it too

  const text = s.surface.texts().join('\n');
  assert.equal(
    injections(text, s.dm, sent.seq),
    1,
    `the same (conv, seq) must be injected exactly once, got:\n${text}`,
  );
  // §4.2: what the member was handed at startup is its brief, and the brief is not a debt
  // (the member cannot answer its own task book) — so the dedup is visible in the text
  // above and in the absence of a flag, not in a count of one.
  assert.deepEqual(
    s.loop.state().owed,
    [],
    `the startup brief must not leave a debt, got ${JSON.stringify(s.loop.state().owed)}`,
  );
});

// §3.4: the watermark is per member, not per directory. `spawnMember` hands the same
// `PIGROUPS_ADAPTER_DIR` down to the child, and a conversation id (`g:<owner>`, `dm:<a>_<b>`) is
// the same string at both ends. A single directory-wide watermark would let the first member's
// advance drop the second member's copy of the same `(conv, seq)`.
test('the injection watermark is per member: one member advancing it must not drop the other member\'s copy', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  // The child of the same parent, on the directory `spawnMember` would have handed down.
  const peer = await createLoop(s.platform, sibling, { adapterDir: s.adapterDir });
  try {
    // One group message naming both members: same conversation, same seq, two recipients.
    const body = 'both of you: read the design doc before tomorrow';
    const sent = await send(s.platform, s.parent!.token, s.group, body, [s.me.id, sibling.id]);

    await s.cycle();
    await s.timer(WINDOW);
    const mine = s.surface.texts().join('\n');
    assert.equal(injections(mine, s.group, sent.seq), 1, `the first member injects its copy once, got:\n${mine}`);
    assert.equal(mine.split(body).length - 1, 1, `the body reaches the first member exactly once, got:\n${mine}`);

    await peer.cycle();
    await peer.timer(WINDOW);
    const theirs = peer.surface.texts().join('\n');
    assert.equal(
      injections(theirs, s.group, sent.seq),
      1,
      `the second member has injected nothing, so its own copy must still be injected, got:\n${theirs}`,
    );
    assert.equal(theirs.split(body).length - 1, 1, `the body reaches the second member exactly once, got:\n${theirs}`);
  } finally {
    await peer.stop();
  }
});

test('an already-injected message is not injected again after a restart on the same adapter directory', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const sent = await send(s.platform, s.parent!.token, s.me.id, 'injected before the restart');
  s.loop.start();
  await waitFor(() => s.surface.deliveries.length > 0, 'the startup brief to be injected');
  await s.stop(); // stop the loop, keep the adapter directory for the restart

  // A second process against the same directory must read the watermark, so neither the
  // startup brief (history) nor pollOnce (the still-queued inbox copy) injects it again.
  const restarted = await createLoop(s.platform, s.me, { adapterDir: s.adapterDir });
  try {
    restarted.loop.start();
    await quiet(800); // let the startup sequence reach the brief
    await restarted.loop.pollOnce();
    await restarted.loop.flush();
    await quiet(300);

    const text = restarted.surface.texts().join('\n');
    assert.equal(
      injections(text, s.dm, sent.seq),
      0,
      `the persisted watermark must suppress the second injection, got:\n${text}`,
    );
  } finally {
    await restarted.stop();
  }
});

// Control for the test above: with a fresh directory there is no watermark, so the very
// same message *is* injected again. That is what shows the restart test's silence comes
// from the persisted state rather than from the fake surface or the platform.
test('a fresh adapter directory has no watermark, so the same message is injected again', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const sent = await send(s.platform, s.parent!.token, s.me.id, 'injected once already');
  s.loop.start();
  await waitFor(() => s.surface.deliveries.length > 0, 'the startup brief to be injected');
  await s.stop();

  const fresh = await createLoop(s.platform, s.me);
  try {
    fresh.loop.start();
    await quiet(800);
    await fresh.loop.pollOnce();
    await fresh.loop.flush();
    await quiet(300);

    const text = fresh.surface.texts().join('\n');
    assert.equal(
      injections(text, s.dm, sent.seq),
      1,
      `a fresh adapter directory has no record of the earlier injection, so it must repeat it, got:\n${text}`,
    );
  } finally {
    await fresh.stop();
    await rm(fresh.adapterDir, { recursive: true, force: true });
  }
});

// §3.4: "`gap` 项不推进水位". Platform §6.4's second shape is a gap for a conversation with no
// retained item in the batch: `before` is then "newest skipped seq + 1", and the next real message
// in that conversation gets exactly that seq. Advancing the watermark to the anchor drops it forever.
test('a gap does not advance the injection watermark: the message at seq === gap.before is still injected', async (t) => {
  // `pollLimit` 2 keeps the newest two items of a batch and folds the rest into per-conversation gaps.
  const s = await scenario({ siblings: 1, pollLimit: 2 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await s.cycle(); // drain the startup sequence while the history is still empty

  for (let i = 0; i < 3; i += 1) await send(s.platform, sibling.token, s.group, `skipped group ${i}`, [s.me.id]);
  await send(s.platform, s.parent!.token, s.me.id, 'dm one');
  await send(s.platform, s.parent!.token, s.me.id, 'dm two');

  // The newest two slots are the DMs, so the group has no retained item: this is the second shape.
  await s.cycle();
  await s.timer(WINDOW);

  const batchText = s.surface.texts().join('\n');
  const anchor = Number(/before=(\d+)/.exec(batchText)?.[1]);
  assert.ok(Number.isFinite(anchor), `the gap hint must carry the re-read anchor: ${batchText}`);
  assert.equal(anchor, 4, `three skipped group messages anchor the gap one past the newest: ${batchText}`);

  // That batch started a turn. End it, and every nudge the settle reaction takes afterwards,
  // until the member is idle again: only an idle member can be injected a new message.
  for (let i = 0; i < 10 && s.surface.isBusy(); i += 1) await s.settle();
  assert.equal(s.surface.isBusy(), false, 'precondition: the member is idle before the next poll');

  const next = await send(s.platform, sibling.token, s.group, 'the first message after the gap', [s.me.id]);
  assert.equal(next.seq, anchor, 'the next message in the conversation takes exactly the anchor seq');

  await s.cycle();
  await s.timer(WINDOW);

  const text = s.surface.texts().join('\n');
  assert.equal(
    injections(text, s.group, anchor),
    1,
    `seq === gap.before is a message nobody has seen yet, so it must be injected:\n${text}`,
  );
  assert.ok(text.includes('the first message after the gap'), `the message body must reach the member: ${text}`);
});
