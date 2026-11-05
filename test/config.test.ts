// §7: without a token the extension loads and does nothing — it is installed in every session,
// and only a member should start pulling.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loopConfig } from '../src/extension.ts';
import { member, poll, send } from './support.ts';
import { scenario } from './scenario.ts';

test('missing PIGROUPS_TOKEN means the adapter does nothing at all: no poll, no deliver', async (t) => {
  const s = await scenario({ token: '' });
  t.after(() => s.close());

  await send(s.platform, s.parent!.token, s.me.id, 'nobody is listening');

  await Promise.allSettled([s.loop.pollOnce(), s.loop.flush()]);
  await s.loop.flush().catch(() => undefined);
  try {
    s.loop.tick();
  } catch {
    // A disabled adapter may refuse the manual drive too; what matters is that it did not run.
  }

  assert.equal(s.surface.deliveries.length, 0, 'no token means no delivery');
  assert.equal(s.surface.aborts.length, 0);

  const seen = await member(s.platform, s.parent!.token, s.me.id);
  assert.equal(seen.last_seen_at, null, 'no token means the adapter never talks to the platform');

  const untouched = await poll(s.platform, s.me.token, { wait: 0, types: 'message' });
  assert.equal(untouched.items.length, 1, 'the message is still queued: nothing polled');
});


test('PIGROUPS_DELIVERY_MAX_CHARS defaults to 4096 code points and can be moved', () => {
  assert.equal(
    loopConfig('http://127.0.0.1:1', 'token', {}).deliveryMaxChars,
    4096,
    'the measured default is 4096 code points',
  );
  assert.equal(
    loopConfig('http://127.0.0.1:1', 'token', { PIGROUPS_DELIVERY_MAX_CHARS: '800' }).deliveryMaxChars,
    800,
    'an operator can move the context cap',
  );
});

test('PIGROUPS_AUTO_RESPAWN defaults on and 0/false turn the startup repair off', () => {
  const base = loopConfig('http://127.0.0.1:1', 'token', {});
  assert.equal(base.autoRespawn, true, 'the automatic repair is on unless the operator says otherwise');
  assert.equal(loopConfig('http://127.0.0.1:1', 'token', { PIGROUPS_AUTO_RESPAWN: '1' }).autoRespawn, true);
  assert.equal(loopConfig('http://127.0.0.1:1', 'token', { PIGROUPS_AUTO_RESPAWN: '0' }).autoRespawn, false);
  assert.equal(loopConfig('http://127.0.0.1:1', 'token', { PIGROUPS_AUTO_RESPAWN: 'false' }).autoRespawn, false);
});

test('PIGROUPS_RESPAWN_FRESH_MS is read from the environment', () => {
  assert.equal(
    loopConfig('http://127.0.0.1:1', 'token', {}).respawnFreshMs,
    120_000,
    'the documented default is two minutes',
  );
  assert.equal(
    loopConfig('http://127.0.0.1:1', 'token', { PIGROUPS_RESPAWN_FRESH_MS: '5000' }).respawnFreshMs,
    5_000,
    'the freshness window and the startup grace are configurable together',
  );
});

test('PIGROUPS_HEARTBEAT_MS and PIGROUPS_HEARTBEAT_MISS are the two liveness knobs', () => {
  const base = loopConfig('http://127.0.0.1:1', 'token', {});
  assert.equal(base.heartbeatMs, 15_000, 'a member feeds a heartbeat every 15 s by default');
  assert.equal(base.heartbeatMiss, 3, 'three missed intervals mean the member is not running');

  const moved = loopConfig('http://127.0.0.1:1', 'token', {
    PIGROUPS_HEARTBEAT_MS: '5000',
    PIGROUPS_HEARTBEAT_MISS: '5',
  });
  assert.equal(moved.heartbeatMs, 5_000, 'the cadence is configurable');
  assert.equal(moved.heartbeatMiss, 5, 'so is the number of missed beats');

  const clamped = loopConfig('http://127.0.0.1:1', 'token', {
    PIGROUPS_HEARTBEAT_MS: '0',
    PIGROUPS_HEARTBEAT_MISS: '0',
  });
  assert.equal(clamped.heartbeatMs, 1_000, 'a cadence below the 5 s tick cannot beat more than once per tick');
  assert.equal(clamped.heartbeatMiss, 1, 'a threshold below one interval would judge a child dead before its first beat');

  const negative = loopConfig('http://127.0.0.1:1', 'token', {
    PIGROUPS_HEARTBEAT_MS: '-5',
    PIGROUPS_HEARTBEAT_MISS: '-2',
  });
  assert.equal(negative.heartbeatMs, 1_000, 'a negative cadence is clamped to the same floor');
  assert.equal(negative.heartbeatMiss, 1, 'a negative miss count is clamped to the same floor');

  assert.equal(
    'attentionStaleGraceMs' in base,
    false,
    'the 0.12.0 stale-attention grace is gone with the gone state',
  );
});
