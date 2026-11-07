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
import { delay, send, waitFor, within } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, createLoop, scenario, type Scenario } from './scenario.ts';

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
  await s.loop.pollOnce(); // journalled and queued
  s.clock.advance(WINDOW);
  s.loop.tick(); // the closed window enters the surface, which is holding it
  await waitFor(() => s.surface.deliveries.length === 1, 'the delivery to enter the surface');

  const stopping = s.loop.stop();
  const state = await Promise.race([
    stopping.then(() => 'resolved' as const),
    delay(100).then(() => 'still waiting' as const),
  ]);
  assert.equal(state, 'still waiting', 'stop() must not resolve while a delivery is still in flight');

  s.surface.releaseDeliveries();
  await within(stopping, 'stop() to resolve once the delivery committed');

  // The delivery committed before stop() resolved, so it is not waiting in the journal for a replay.
  const restarted = await createLoop(s.platform, s.me, { adapterDir: s.adapterDir });
  try {
    await restarted.loop.pollOnce(); // initialise: journal replay is queued, if there is any
    restarted.clock.advance(WINDOW); // close the replay window
    restarted.loop.tick();
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
// it returns while the reaction is still about to spend a delivery.
test('stop() waits for a settle that is still reading the roster, and a stopped loop never delivers', async () => {
  const SELF = 'm_aaaaaa';
  const PEER = 'm_bbbbb1';
  const dm = `dm:${SELF}_${PEER}`;
  const dir = await mkdtemp(join(tmpdir(), 'pigroups-stop-test-'));
  const deliveries: string[] = [];
  let busy = false;
  let fired = false;
  let fireSettled: (() => void) | undefined;
  let releaseTree: ((tree: unknown) => void) | undefined;
  let treeReads = 0;
  let now = 1_000_000;

  const surface: PiSurface = {
    deliver: async (text) => {
      deliveries.push(text);
    },
    abort: async () => undefined,
    isBusy: () => busy,
    lastAssistantText: () => undefined,
    onSettled: (cb) => {
      fireSettled = cb;
      return () => undefined;
    },
    onEvent: () => () => undefined,
    shutdown: () => undefined,
  };
  const pg = {
    whoami: async () => ({
      member: { id: SELF, name: 'me', parent_id: null },
      server: { version: '0.7.2' },
    }),
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
    // The startup prune reads a healthy roster first. Only the settle under test
    // gets the held read, which is what `releaseTree` exposes.
    tree: () => {
      treeReads += 1;
      if (treeReads === 1) return Promise.resolve({ nodes: [{ id: SELF }, { id: PEER }] });
      return new Promise((resolve) => {
        releaseTree = resolve;
      });
    },
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
            body: 'held until the turn ends',
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
      listPanes: async () => [],
      close: async () => ({ forced: false }),
    },
    config: {
      url: 'http://127.0.0.1:1',
      token: 't',
      adapterDir: dir,
      pollLimit: 20,
      pollWait: 0,
      deliveryMaxChars: 4096,
      attentionToolMs: 300_000,
      remindWindowMs: 300_000,
      nudgeMax: 3,
      deliveryWindowMs: 60_000,
      spawnReadyMs: 5000,
      spawnCmd: 'pi',
    },
    now: () => now,
  });
  try {
    // The polled message stays queued: the window was just opened.
    await loop.pollOnce();
    assert.deepEqual(deliveries, [], 'precondition: the message is queued, not delivered');
    now += 31_000; // the roster snapshot is stale; the delivery window is still open

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

    // The window is now past its deadline; even a manual drive must not deliver.
    now += 60_000;
    loop.tick();
    assert.equal(await loop.flush(), false, 'a stopped loop reports that it delivered nothing');
    assert.deepEqual(deliveries, [], 'a stopped loop delivers nothing, window or no window');
  } finally {
    await loop.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
