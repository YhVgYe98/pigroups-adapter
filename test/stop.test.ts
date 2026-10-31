// §2.3: `stop()` "停止并等待在飞的活干完". It must resolve, and it must not abandon a delivery
// that is still inside the surface when the stop arrives.
//
// `scenario.stop()` used to race `stop()` against a 2s delay, which turned a hung `stop()` into
// "2 seconds elapsed" and let every test pass. It now fails on a hang instead (`within`).

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

import { delay, quiet, send, waitFor, within } from './support.ts';
import { createLoop, scenario, type Scenario } from './scenario.ts';

/** The loop is already stopped; the platform and the shared directory are all that is left. */
async function closeAfterStop(s: Scenario): Promise<void> {
  await s.platform.stop();
  await rm(s.adapterDir, { recursive: true, force: true });
}

test('stop() resolves on an idle loop', async (t) => {
  const s = await scenario();
  t.after(() => closeAfterStop(s));
  await s.cycle();

  await within(s.loop.stop(), 'stop() to resolve on an idle loop');
});

test('stop() waits for the delivery in flight and does not abandon it', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => closeAfterStop(s));
  await s.cycle();
  const sibling = s.siblings[0];

  // A group mention, not a DM: the startup brief also reads the DM history (§8 step 3), so only a
  // group message proves that a re-injection could have come from the journal.
  s.surface.holdDeliveries = true;
  await send(s.platform, sibling.token, s.group, 'the delivery that is in flight', [s.me.id]);
  const polling = s.loop.pollOnce();
  await waitFor(() => s.surface.deliveries.length === 1, 'the delivery to enter the surface');

  const stopping = s.loop.stop();
  const state = await Promise.race([
    stopping.then(() => 'resolved' as const),
    delay(100).then(() => 'still waiting' as const),
  ]);
  assert.equal(state, 'still waiting', 'stop() must not resolve while a delivery is still in flight');

  s.surface.releaseDeliveries();
  await within(stopping, 'stop() to resolve once the delivery committed');
  await polling;

  // The delivery committed before stop() resolved, so it is not waiting in the journal for a replay.
  const restarted = await createLoop(s.platform, s.me, { adapterDir: s.adapterDir });
  try {
    restarted.loop.start();
    await quiet(500);
    await restarted.loop.pollOnce();
    await restarted.loop.flush();
    const text = restarted.surface.texts().join('\n');
    assert.ok(
      !text.includes('the delivery that is in flight'),
      `stop() abandoned the delivery: it is still in the journal and got replayed:\n${text}`,
    );
  } finally {
    await restarted.stop();
  }
});
