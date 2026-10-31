// §3.2 control items: abort, steer, sys.terminated; §5.3 "only my superior commands me".

import test from 'node:test';
import assert from 'node:assert/strict';

import { command, quiet, removeMember, send, waitFor } from './support.ts';
import { scenario } from './scenario.ts';

test('pg.abort from the parent calls abort() and delivers nothing; a pg.steer behind it waits for the abort', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  s.surface.holdAbort = true;
  await command(s.platform, s.parent!.token, s.me.id, 'pg.abort', { reason: 'stalled 12m' });
  await command(s.platform, s.parent!.token, s.me.id, 'pg.steer', { text: 'run the tests before you continue' });

  const drive = s.loop.pollOnce();
  await waitFor(() => s.surface.aborts.length === 1, 'abort() to be called');
  await quiet(150);
  assert.equal(s.surface.deliveries.length, 0, 'pg.abort injects no hint, and the steer must wait for it');

  s.surface.releaseAbort();
  await drive;
  await s.loop.flush();

  const steer = s.surface.deliveries.filter((d) => d.text.includes('run the tests before you continue'));
  assert.equal(steer.length, 1, 'the queued steer must be delivered once the abort resolved');
  assert.equal(steer[0].kind, 'control');
});

test('pg.steer from a sibling is ignored and does not call abort()', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await command(s.platform, sibling.token, s.me.id, 'pg.steer', { text: 'do this instead' });
  await s.cycle();

  assert.equal(s.surface.aborts.length, 0, 'a sibling must not be able to abort me');
  assert.equal(s.surface.deliveries.length, 0, 'a sibling must not be able to steer me');
});

test('sys.terminated stops the member: shutdown() is called and nothing further is delivered', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  await send(s.platform, s.parent!.token, s.me.id, 'something owed before the end');
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 1);

  await removeMember(s.platform, s.parent!.token, s.me.id);
  await s.loop.pollOnce();

  assert.equal(s.surface.shutdowns.length, 1, 'sys.terminated must shut the member down');
  assert.ok(s.surface.shutdowns[0].length > 0, 'shutdown() takes a reason');

  const mark = s.surface.mark();
  await s.settle();
  await s.loop.flush();
  assert.equal(s.surface.since(mark).length, 0, 'nothing may be delivered after the shutdown');
  assert.equal(s.surface.textsOfKind('nudge').length, 0, 'a stopped member must not keep nudging');
});
