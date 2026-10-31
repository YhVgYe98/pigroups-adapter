// §3.4: one injection per (conv, seq), whichever path it arrives by — the startup brief
// (§8 step 3, read from history), a poll delivery of the copy still sitting in the inbox,
// or a journal replay. The watermark is persisted in PIGROUPS_ADAPTER_DIR, so the copy the
// brief already read is not injected again after a restart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

import { quiet, send, waitFor } from './support.ts';
import { createLoop, scenario } from './scenario.ts';

/** The injected text carries `[<to>#<seq>]`; count how often one message id appears. */
function injections(text: string, dm: string, seq: number): number {
  return text.split(`[${dm}#${seq}]`).length - 1;
}

test('the startup brief and the polled copy of the same message are injected once', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  // The parent's DM is the startup brief, and it is still queued in the member's inbox
  // because the member has never polled: the overlap §3.4 exists for.
  const sent = await send(s.platform, s.parent!.token, s.me.id, 'the brief that is still queued');
  s.loop.start();
  await waitFor(() => s.surface.deliveries.length > 0, 'the startup brief to be injected');

  // The platform now delivers that same (conv, seq) through the poll path.
  await s.loop.pollOnce();
  await s.loop.flush();
  await quiet(300); // and the poll loop behind start() may meet it too

  const text = s.surface.texts().join('\n');
  assert.equal(
    injections(text, s.dm, sent.seq),
    1,
    `the same (conv, seq) must be injected exactly once, got:\n${text}`,
  );
  assert.equal(
    s.loop.state().owed.filter((conv) => conv === s.dm).length,
    1,
    `the conversation must be owed exactly once, got ${JSON.stringify(s.loop.state().owed)}`,
  );
});

test('an already-injected message is not injected again after a restart on the same adapter directory', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const sent = await send(s.platform, s.parent!.token, s.me.id, 'injected before the restart');
  s.loop.start();
  await waitFor(() => s.surface.deliveries.length > 0, 'the startup brief to be injected');
  await s.stop(); // stop the loop, keep the adapter directory for the restart

  // A second process against the same directory must read the watermark, so neither the
  // startup brief (history) nor pollOnce (the still-queued inbox copy) injects it again.
  const restarted = await createLoop(s.platform, s.me, { adapterDir: s.adapterDir });
  try {
    restarted.loop.start();
    await quiet(800); // let the startup sequence reach the brief
    await restarted.loop.pollOnce();
    await restarted.loop.flush();
    await quiet(300);

    const text = restarted.surface.texts().join('\n');
    assert.equal(
      injections(text, s.dm, sent.seq),
      0,
      `the persisted watermark must suppress the second injection, got:\n${text}`,
    );
  } finally {
    await restarted.stop();
  }
});

// Control for the test above: with a fresh directory there is no watermark, so the very
// same message *is* injected again. That is what shows the restart test's silence comes
// from the persisted state rather than from the fake surface or the platform.
test('a fresh adapter directory has no watermark, so the same message is injected again', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const sent = await send(s.platform, s.parent!.token, s.me.id, 'injected once already');
  s.loop.start();
  await waitFor(() => s.surface.deliveries.length > 0, 'the startup brief to be injected');
  await s.stop();

  const fresh = await createLoop(s.platform, s.me);
  try {
    fresh.loop.start();
    await quiet(800);
    await fresh.loop.pollOnce();
    await fresh.loop.flush();
    await quiet(300);

    const text = fresh.surface.texts().join('\n');
    assert.equal(
      injections(text, s.dm, sent.seq),
      1,
      `a fresh adapter directory has no record of the earlier injection, so it must repeat it, got:\n${text}`,
    );
  } finally {
    await fresh.stop();
    await rm(fresh.adapterDir, { recursive: true, force: true });
  }
});
