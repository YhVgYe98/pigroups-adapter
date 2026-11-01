// §3.1 / 概念稿 §8 ①: the batch is journalled before injection, committed after,
// and a restart with an uncommitted journal replays it even though `poll` is at-most-once.
//
// The batch is a group mention, not a DM: the startup brief also reads the DM conversation
// from history (§8 step 3), so only a group message proves the journal was the source.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMember, poll, quiet, send, waitFor } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, createLoop, scenario } from './scenario.ts';

test('a polled batch is journalled before injection and cleared after; a restart with an uncommitted journal re-delivers that batch', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await s.cycle(); // drain the startup sequence while the history is still empty

  // The turn never commits: `deliver` stays pending, so the journal entry must stay too.
  s.surface.holdDeliveries = true;
  const sent = await send(s.platform, sibling.token, s.group, 'the batch that must survive a crash', [s.me.id]);
  await s.loop.pollOnce(); // journalled and queued; the window has not closed
  assert.equal(s.surface.deliveries.length, 0, 'precondition: the window is open');

  s.clock.advance(WINDOW);
  s.loop.tick(); // the closed window enters the surface, which is holding it
  await waitFor(() => s.surface.deliveries.length === 1, 'the batch to be injected');

  const leftover = await poll(s.platform, s.me.token, { wait: 0, types: 'message' });
  assert.equal(leftover.items.length, 0, 'the batch is already consumed: a replay can only come from the journal');

  // Restart against the same adapter dir: the uncommitted batch must be injected again.
  const replay = await createLoop(s.platform, s.me, { adapterDir: s.adapterDir });
  try {
    // `pollOnce()` runs the same startup sequence as `start()`; awaiting it means the
    // journal replay has been queued before the window is closed by hand.
    await replay.loop.pollOnce();
    // Journal replay is windowed like any other item (概念稿 §8.1); the restart's clock
    // has not moved, so close the window explicitly instead of waiting 60 real seconds.
    replay.clock.advance(WINDOW);
    replay.loop.tick();
    await replay.loop.flush();
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
    await after.loop.pollOnce();
    after.clock.advance(WINDOW);
    after.loop.tick();
    await after.loop.flush();
    await quiet(500);
    assert.equal(after.surface.deliveries.length, 0, 'a committed batch must not be replayed');
  } finally {
    await after.stop();
  }
});

// §3.4: the journal is per member, `<adapterDir>/journal/<memberId>/`. `spawnMember` hands the same
// `PIGROUPS_ADAPTER_DIR` to the child, and `dm:<a>_<b>` names the same conversation on both ends, so
// one shared journal would replay the parent's batch into the child, and that replay's commit would
// delete the parent's only copy.
test('two members sharing one adapter directory each replay only their own uncommitted batch', async (t) => {
  const adapterDir = await mkdtemp(join(tmpdir(), 'pigroups-shared-'));
  const s = await scenario({ role: 'root', adapterDir });
  const child = await createMember(s.platform, s.me, 'child');
  const peer = await createMember(s.platform, s.me, 'peer');
  const childLoop = await createLoop(s.platform, child, { adapterDir });

  await s.cycle(); // both startup sequences, with an empty history
  await childLoop.cycle();

  // Neither turn ever commits, so both batches stay in the journal.
  s.surface.holdDeliveries = true;
  childLoop.surface.holdDeliveries = true;

  await send(s.platform, peer.token, s.group, 'for the parent only', [s.me.id]);
  await send(s.platform, peer.token, s.group, 'for the child only', [child.id]);

  await s.loop.pollOnce();
  s.clock.advance(WINDOW);
  s.loop.tick();
  await waitFor(() => s.surface.deliveries.length === 1, 'the batch to be injected into the parent');
  await childLoop.loop.pollOnce();
  childLoop.clock.advance(WINDOW);
  childLoop.loop.tick();
  await waitFor(() => childLoop.surface.deliveries.length === 1, 'the batch to be injected into the child');

  t.after(async () => {
    s.surface.releaseDeliveries();
    childLoop.surface.releaseDeliveries();
    await childLoop.stop();
    await s.close();
  });

  // Restart the child against the same directory: only its own batch may come back.
  const childRestart = await createLoop(s.platform, child, { adapterDir });
  try {
    await childRestart.loop.pollOnce();
    childRestart.clock.advance(WINDOW);
    childRestart.loop.tick();
    await childRestart.loop.flush();
    await waitFor(() => childRestart.surface.deliveries.length > 0, 'the child journal to replay', 5000);
    await quiet(300); // give a shared journal the chance to replay the parent's batch too
    const replayed = childRestart.surface.texts().join('\n');
    assert.ok(replayed.includes('for the child only'), `the child's own batch must be replayed: ${replayed}`);
    assert.ok(
      !replayed.includes('for the parent only'),
      `the child replayed the parent's batch into its own context: ${replayed}`,
    );
  } finally {
    await childRestart.stop();
  }

  // The parent's batch must still be there: the child's replay committed only the child's entry.
  const rootRestart = await createLoop(s.platform, s.me, { adapterDir });
  try {
    await rootRestart.loop.pollOnce();
    rootRestart.clock.advance(WINDOW);
    rootRestart.loop.tick();
    await rootRestart.loop.flush();
    await waitFor(() => rootRestart.surface.deliveries.length > 0, 'the parent journal to replay', 5000);
    await quiet(300);
    const replayed = rootRestart.surface.texts().join('\n');
    assert.ok(replayed.includes('for the parent only'), `the parent lost its batch to the child's replay: ${replayed}`);
    assert.ok(
      !replayed.includes('for the child only'),
      `the parent replayed the child's batch into its own context: ${replayed}`,
    );
  } finally {
    await rootRestart.stop();
  }
});
