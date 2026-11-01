// §3.2 control items: abort, steer, unknown commands; §5.3 "only my superior commands me".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { command, poll, removeMember, send, waitFor, within } from './support.ts';
import { scenario } from './scenario.ts';

test('pg.abort from the parent calls abort() and delivers nothing; a pg.steer behind it waits for the abort', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  s.surface.holdAbort = true;
  await command(s.platform, s.parent!.token, s.me.id, 'pg.abort', { reason: 'stalled 12m' });
  await command(s.platform, s.parent!.token, s.me.id, 'pg.steer', { text: 'run the tests before you continue' });

  const drive = s.loop.pollOnce();
  await waitFor(() => s.surface.aborts.length === 1, 'abort() to be called');
  // Still inside the abort gate: the steer queued behind it must not have been injected yet.
  assert.equal(s.surface.deliveries.length, 0, 'pg.abort injects no hint, and the steer must wait for it');

  const releasedAt = Date.now();
  s.surface.releaseAbort();
  await drive;
  await s.loop.flush();

  const steer = s.surface.deliveries.filter((d) => d.text.includes('run the tests before you continue'));
  assert.equal(steer.length, 1, 'the queued steer must be delivered once the abort resolved');
  assert.equal(steer[0].kind, 'control');
  assert.ok(steer[0].at >= releasedAt, 'the steer is injected after the abort returned, not alongside it');
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


test('sys.terminated cuts the running turn before discarding the journal and shutting down', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  await s.cycle();

  const sibling = s.siblings[0];
  s.surface.beginTurn();
  await send(s.platform, sibling.token, s.group, 'queued until the cut', [s.me.id]);
  await s.loop.pollOnce();

  const journalDir = join(s.adapterDir, 'journal', s.me.id);
  const journalEntries = async (): Promise<string[]> =>
    (await readdir(journalDir).catch(() => [])).filter((name) => name.endsWith('.json'));
  const journalsBeforeTermination = await journalEntries();
  assert.equal(journalsBeforeTermination.length, 1, 'precondition: the queued batch is still journalled');

  const deliveriesMark = s.surface.mark();
  const lifecycleMark = s.surface.lifecycle.length;
  s.surface.holdAbort = true;
  await removeMember(s.platform, s.parent!.token, s.me.id);
  const drive = s.loop.pollOnce();
  await waitFor(() => s.surface.aborts.length === 1, 'the termination to cut the running turn');

  // A settle in the middle of the cut is the path that used to start a fresh turn.
  s.surface.settle();
  await s.loop.settled();
  await s.loop.flush();
  assert.equal(s.surface.since(deliveriesMark).length, 0, 'nothing may be delivered after the abort starts');
  assert.ok(
    (await journalEntries()).length >= journalsBeforeTermination.length,
    'the journal is discarded after the abort, not while waiting for it',
  );

  s.surface.releaseAbort();
  await drive;

  assert.deepEqual(
    s.surface.lifecycle.slice(lifecycleMark),
    ['abort', 'shutdown'],
    'the surface must record the cut before shutdown, with no delivery in between',
  );
  assert.equal(s.surface.shutdowns.length, 1, 'termination still shuts the member down');
  assert.equal((await journalEntries()).length, 0, 'the journal is still discarded');

  const afterShutdown = s.surface.mark();
  await s.settle();
  await s.loop.flush();
  assert.equal(s.surface.since(afterShutdown).length, 0, 'nothing may be delivered after the shutdown');
});

test('sys.terminated reaches shutdown at the abort bound when the surface abort never returns', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  s.surface.beginTurn();
  s.surface.holdAbort = true;
  await removeMember(s.platform, s.parent!.token, s.me.id);

  const started = Date.now();
  await within(s.loop.pollOnce(), 'the termination to reach shutdown at the abort bound', 5000);
  const elapsed = Date.now() - started;

  assert.equal(s.surface.aborts.length, 1, 'the termination asks for the cut');
  assert.equal(s.surface.shutdowns.length, 1, 'a surface that never answers abort must not hold shutdown forever');
  assert.ok(elapsed >= 2900, `shutdown must wait for the abort bound, took ${elapsed}ms`);
  assert.ok(elapsed < 5000, `shutdown must not wait past the abort bound, took ${elapsed}ms`);
});

// §9: "`poll` 410 `member_gone` | 停止一切，`shutdown()`". `sys.terminated` is the other trigger:
// here the termination receipt is drained by hand first, so all `poll` can answer is 410.
test('a poll answered 410 member_gone stops the member', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'the work before the end');
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 1);

  await removeMember(s.platform, s.parent!.token, s.me.id);

  const drained = await poll(s.platform, s.me.token, { wait: 0, types: 'control' });
  assert.equal(drained.items.length, 1, 'precondition: the platform had exactly one receipt left');
  const [notice] = drained.items;
  assert.equal(notice.kind, 'control', 'precondition: the receipt was a control item');
  assert.equal((notice as { cmd: string }).cmd, 'sys.terminated', 'precondition: it was the termination notice');

  // Whether a gone member's `pollOnce` rejects or returns is not specified; stopping is.
  await s.loop.pollOnce().catch(() => undefined);

  assert.equal(s.surface.shutdowns.length, 1, 'a 410 from poll must shut the member down');
  assert.ok(s.surface.shutdowns[0].length > 0, 'shutdown() takes a reason');

  const mark = s.surface.mark();
  await s.settle();
  await s.loop.flush();
  assert.equal(s.surface.since(mark).length, 0, 'nothing may be delivered after a 410');
  assert.equal(s.surface.textsOfKind('nudge').length, 0, 'a gone member must not keep nudging');
});

// §3.2's last row and §6's `v`: a `cmd` the adapter has never heard of is injected as-is, and a
// `pg.*` payload with a higher `v` is treated the same way rather than guessed at.
test('an unknown cmd and a pg.* payload with v:2 are injected, not dropped', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  await command(s.platform, s.parent!.token, s.me.id, 'future.ping', {
    text: 'a command from a newer platform',
  });
  await command(s.platform, s.parent!.token, s.me.id, 'pg.inspect', {
    v: 2,
    request: 'r-v2',
    text: 'an inspect from a newer protocol',
  });
  await s.cycle();
  // Controls are handled one by one and the first one starts a turn, so the second may be queued
  // behind it; a settle is what releases the queue (§2.3).
  await s.settle();
  await s.timer(0);

  const control = s.surface.textsOfKind('control').join('\n');
  assert.ok(control.length > 0, `control items must be injected, got: ${JSON.stringify(s.surface.texts())}`);
  assert.ok(control.includes('a command from a newer platform'), `the unknown cmd was dropped: ${control}`);
  assert.ok(control.includes('an inspect from a newer protocol'), `the v:2 payload never reached the model: ${control}`);

  const answers = (await poll(s.platform, s.parent!.token, { wait: 0, types: 'control' })).items.filter(
    (item) => item.kind === 'control' && (item as { cmd: string }).cmd === 'pg.inspect_result',
  );
  assert.equal(answers.length, 0, 'a v:2 pg.inspect is not understood: it must not be answered as if it were v:1');
});
