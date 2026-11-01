// 概念稿 §7.5: `pg_schedule` is a one-shot, bounded, in-memory wake. It enters the
// same delivery queue as everything else — it does not bypass the window.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, createLoop, scenario } from './scenario.ts';

test('schedule() takes 5 s to 24 h and at most eight pending wakes', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const at = s.clock.now();
  const first = s.loop.schedule(5, 'check the build');
  assert.equal(first.due_at, at + 5_000, 'the delay is on the injected clock');
  assert.equal(first.pending, 1);

  assert.throws(() => s.loop.schedule(4, 'too soon'), /at least 5/, 'the lower bound is the tick period');
  assert.throws(() => s.loop.schedule(86_401, 'too far'), /at most 86400/, 'the upper bound is 24 hours');
  assert.throws(() => s.loop.schedule(Number.NaN, 'not a number'), /must be a number/);
  assert.throws(() => s.loop.schedule(60, '   '), /must not be empty/);

  for (let i = 2; i <= 8; i += 1) s.loop.schedule(60, `wake ${i}`);
  assert.throws(() => s.loop.schedule(60, 'the ninth'), /8 wakes are already pending/, 'bounds are checked, not trimmed');
});

test('a due wake enters the queue as `[scheduled]`, waits for the delivery window, and fires once', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  s.loop.schedule(5, 'check the build');
  s.clock.advance(4_999);
  s.loop.tick();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 0, 'not due yet');

  s.clock.advance(1);
  s.loop.tick();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 0, 'due, but it enters the window like any other item (概念稿 §8.4)');

  s.clock.advance(WINDOW);
  s.loop.tick();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 1, 'the closed window delivers the wake');
  assert.equal(s.surface.deliveries[0].kind, 'scheduled');
  assert.equal(s.surface.deliveries[0].text, '[scheduled] check the build', 'the prefix is how the model knows who woke it');

  s.clock.advance(24 * 60 * 60 * 1000);
  s.loop.tick();
  await s.loop.flush();
  assert.equal(s.surface.deliveries.length, 1, 'a wake is one-shot, not a periodic timer');
});

test('a restart drops pending wakes: the schedule is memory only', async (t) => {
  const s = await scenario();
  const fresh = { current: undefined as Awaited<ReturnType<typeof createLoop>> | undefined };
  t.after(async () => {
    await fresh.current?.stop();
    await s.close();
  });

  await s.cycle();
  s.loop.schedule(5, 'the wake that a restart forgets');
  await s.stop(); // stop the first loop but keep the platform and the adapter directory

  fresh.current = await createLoop(s.platform, s.me, { adapterDir: s.adapterDir });
  await fresh.current.loop.pollOnce(); // startup: nothing about the wake may come back
  fresh.current.clock.advance(24 * 60 * 60 * 1000);
  fresh.current.loop.tick();
  await fresh.current.loop.flush();

  assert.equal(
    fresh.current.surface.deliveries.length,
    0,
    'a wake is in memory only: nothing about it survives a restart (概念稿 §7.5)',
  );
});
