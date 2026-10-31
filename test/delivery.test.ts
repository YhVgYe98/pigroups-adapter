// §3.3 message grading and §3.4 injection coalescing, against the real platform.

import test from 'node:test';
import assert from 'node:assert/strict';

import { send } from './support.ts';
import { scenario } from './scenario.ts';

test('a DM from the parent is delivered with the conversation id and the message seq', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  await send(s.platform, s.parent!.token, s.me.id, 'implement X, accept Y');
  await s.cycle();

  assert.equal(s.surface.deliveries.length, 1, 'one DM must produce exactly one deliver');
  const [delivery] = s.surface.deliveries;
  assert.equal(delivery.kind, 'message');
  assert.ok(delivery.text.includes(s.dm), `injected text must carry the conversation id, got: ${delivery.text}`);
  assert.ok(delivery.text.includes('#1'), `injected text must carry the message seq, got: ${delivery.text}`);
  assert.ok(delivery.text.includes('implement X'), 'injected text must carry the preview');
});

test('a group message that mentions me is delivered; one that does not is not delivered and starts no turn', async (t) => {
  // A sibling, not the parent: `from_parent` alone would deliver the unmentioned one (§3.3).
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await send(s.platform, sibling.token, s.group, 'please review my branch', [s.me.id]);
  await send(s.platform, sibling.token, s.group, 'lunch anyone?');
  await s.cycle();

  assert.equal(s.surface.deliveries.length, 1, 'only the mentioning message may start a turn');
  const [delivery] = s.surface.deliveries;
  assert.ok(delivery.text.includes('please review my branch'), delivery.text);
  assert.ok(!delivery.text.includes('lunch anyone'), `the unmentioned message leaked: ${delivery.text}`);
  assert.ok(delivery.text.includes(s.group), `injected text must carry the conversation id, got: ${delivery.text}`);
});

test('chatter is counted and appears as a suffix on the next real delivery, never on its own', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  await send(s.platform, sibling.token, s.group, 'chatter one');
  await send(s.platform, sibling.token, s.group, 'chatter two');
  await send(s.platform, sibling.token, s.group, 'chatter three');
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 0, 'chatter must not start a turn by itself');

  await send(s.platform, s.parent!.token, s.me.id, 'the real task');
  await s.cycle();

  assert.equal(s.surface.deliveries.length, 1, 'the real message must produce one deliver');
  const [delivery] = s.surface.deliveries;
  assert.ok(delivery.text.includes('the real task'), delivery.text);
  assert.match(delivery.text, /另有\s*3\s*条无关消息/, `missing the chatter suffix: ${delivery.text}`);
});

test('while isBusy() nothing is delivered; after onSettled the held items arrive in order', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle(); // drain the startup sequence: no DM exists yet, so nothing is injected

  s.surface.beginTurn();
  await send(s.platform, s.parent!.token, s.me.id, 'first');
  await send(s.platform, s.parent!.token, s.me.id, 'second');
  await s.cycle();

  assert.equal(s.surface.deliveries.length, 0, 'nothing may be injected while a turn is running');
  assert.equal(s.surface.heldCount, 0);

  await s.settle();

  const delivered = s.surface.texts().join('\n');
  assert.ok(delivered.length > 0, 'the held messages must be delivered after the turn ends');
  assert.ok(delivered.includes('first'), delivered);
  assert.ok(delivered.includes('second'), delivered);
  assert.ok(
    delivered.indexOf('first') < delivered.indexOf('second'),
    `held items must keep arrival order, got:\n${delivered}`,
  );
});

test('a gap that skipped messages naming me is delivered as a hint with its anchor; a gap of pure chatter is only counted', async (t) => {
  // `pollLimit` 2 forces the platform to fold everything older into a gap item (§6.4).
  const s = await scenario({ siblings: 1, pollLimit: 2 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  for (let i = 0; i < 5; i += 1) await send(s.platform, sibling.token, s.group, `chatter ${i}`);
  await s.cycle();
  assert.equal(s.surface.deliveries.length, 0, 'a gap with nothing pointed at me must not start a turn');

  const pointed: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    pointed.push((await send(s.platform, sibling.token, s.group, `pointed ${i}`, [s.me.id])).seq);
  }
  await s.cycle();

  // `pollLimit` 2 keeps the newest two: the anchor is the seq of the earliest one kept (§6.4).
  const anchor = pointed[pointed.length - 2];

  const delivered = s.surface.texts().join('\n');
  assert.ok(delivered.includes('pointed 4'), `the newest messages are still delivered: ${delivered}`);
  assert.match(delivered, /跳过了\s*3\s*条/, `skipped mentions must surface a gap hint: ${delivered}`);
  assert.match(
    delivered,
    new RegExp(`before\\D{0,4}${anchor}`),
    `the hint must carry the re-read anchor (before=${anchor}): ${delivered}`,
  );
  assert.ok(s.loop.state().owed.includes(s.group), 'a gap that skipped a mention leaves the conversation owed');
});
