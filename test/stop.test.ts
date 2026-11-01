// §2.3: `stop()` "停止并等待在飞的活干完". It must resolve, and it must not abandon a delivery
// that is still inside the surface when the stop arrives.
//
// `scenario.stop()` used to race `stop()` against a 2s delay, which turned a hung `stop()` into
// "2 seconds elapsed" and let every test pass. It now fails on a hang instead (`within`).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdapterLoop } from '../src/loop.ts';
import { PgClient } from '../src/pgclient.ts';
import type { PiSurface } from '../src/surface.ts';
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

// d19a179 made the settle reaction await the platform before delivering. That await is
// not visible in `deliveries`, so `stop()` must wait for the reaction itself: otherwise
// it returns 0 ms while the delivery it was supposed to wait for lands afterwards.
test('stop() waits for a settle that is still reading the roster, and nothing is delivered afterwards', async () => {
  const SELF = 'm_aaaaaa';
  const PEER = 'm_bbbbb1';
  const dm = `dm:${SELF}_${PEER}`;
  const dir = await mkdtemp(join(tmpdir(), 'pigroups-stop-test-'));
  const deliveries: string[] = [];
  let busy = false;
  let fired = false;
  let fireSettled: (() => void) | undefined;
  let releaseTree: ((tree: unknown) => void) | undefined;

  const surface: PiSurface = {
    deliver: async (text) => {
      deliveries.push(text);
    },
    abort: async () => undefined,
    isBusy: () => busy,
    onSettled: (cb) => {
      fireSettled = cb;
      return () => undefined;
    },
    onEvent: () => () => undefined,
    shutdown: () => undefined,
  };
  const pg = {
    whoami: async () => ({ member: { id: SELF, name: 'me', parent_id: null } }),
    conversations: async () => ({ items: [{ to: dm }] }),
    messages: async () => ({
      items: [
        {
          to: dm,
          seq: 7,
          sender_id: PEER,
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
    tree: () =>
      new Promise((resolve) => {
        releaseTree = resolve;
      }),
    poll: async () => {
      if (fired) return { items: [], control_pending: 0 };
      fired = true;
      return {
        items: [
          {
            kind: 'message',
            to: dm,
            seq: 8,
            from_id: PEER,
            from_name: 'peer',
            preview: 'held until the turn ends',
            mentions_me: false,
            from_parent: false,
          },
        ],
        control_pending: 0,
      };
    },
    getMember: async () => ({ status: 'alive' }),
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
      close: async () => undefined,
    },
    config: {
      url: 'http://127.0.0.1:1',
      token: 't',
      adapterDir: dir,
      pollLimit: 20,
      pollWait: 0,
      attentionToolMs: 300_000,
      remindWindowMs: 300_000,
      nudgeMax: 3,
      spawnCmd: 'pi',
    },
    now: () => 1_000_000,
  });
  try {
    // The polled message stays queued: the surface is inside a turn.
    busy = true;
    await loop.pollOnce();
    busy = false;
    assert.deepEqual(deliveries, [], 'precondition: the message is queued, not delivered');

    fireSettled?.(); // the settle starts and stops inside `pruneUnanswerableDms()`
    await delay(30);
    assert.equal(releaseTree !== undefined, true, 'precondition: the settle is waiting on the roster read');

    const stopping = loop.stop();
    const state = await Promise.race([
      stopping.then(() => 'resolved' as const),
      delay(100).then(() => 'still waiting' as const),
    ]);
    assert.equal(state, 'still waiting', 'stop() must wait for the settle reaction it can see is in flight');

    releaseTree?.({ nodes: [{ id: SELF }, { id: PEER }] });
    await within(stopping, 'stop() to resolve once the settle reaction finished');
    await delay(50);
    assert.deepEqual(deliveries, [], 'a stopped loop must not deliver from the settle stop() waited for');
  } finally {
    await loop.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
