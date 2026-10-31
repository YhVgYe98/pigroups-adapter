// §7: without a token the extension loads and does nothing — it is installed in every session,
// and only a member should start pulling.

import test from 'node:test';
import assert from 'node:assert/strict';

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
