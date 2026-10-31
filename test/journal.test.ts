// §3.1 / 概念稿 §8 ①: the batch is journalled before injection, committed after,
// and a restart with an uncommitted journal replays it even though `poll` is at-most-once.
//
// The batch is a group mention, not a DM: the startup brief also reads the DM conversation
// from history (§8 step 3), so only a group message proves the journal was the source.

import test from 'node:test';
import assert from 'node:assert/strict';

import { poll, quiet, send, waitFor } from './support.ts';
import { createLoop, scenario } from './scenario.ts';

test('a polled batch is journalled before injection and cleared after; a restart with an uncommitted journal re-delivers that batch', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await s.cycle(); // drain the startup sequence while the history is still empty

  // The turn never commits: `deliver` stays pending, so the journal entry must stay too.
  s.surface.holdDeliveries = true;
  const sent = await send(s.platform, sibling.token, s.group, 'the batch that must survive a crash', [s.me.id]);
  void s.loop.pollOnce();
  await waitFor(() => s.surface.deliveries.length === 1, 'the batch to be injected');

  const leftover = await poll(s.platform, s.me.token, { wait: 0, types: 'message' });
  assert.equal(leftover.items.length, 0, 'the batch is already consumed: a replay can only come from the journal');

  // Restart against the same adapter dir: the uncommitted batch must be injected again.
  const replay = await createLoop(s.platform, s.me, { adapterDir: s.adapterDir });
  try {
    replay.loop.start();
    await waitFor(() => replay.surface.deliveries.length > 0, 'the uncommitted batch to be replayed', 5000);
    const replayed = replay.surface.texts().join('\n');
    assert.ok(replayed.includes('the batch that must survive a crash'), replayed);
    assert.ok(replayed.includes(s.group), `the replay must keep the conversation id: ${replayed}`);
    assert.ok(replayed.includes(`#${sent.seq}`), `the replay must keep the message seq: ${replayed}`);
  } finally {
    await replay.stop();
  }

  // That delivery committed, so a further restart must stay silent.
  const after = await createLoop(s.platform, s.me, { adapterDir: s.adapterDir });
  try {
    after.loop.start();
    await quiet(500);
    assert.equal(after.surface.deliveries.length, 0, 'a committed batch must not be replayed');
  } finally {
    await after.stop();
  }
});
