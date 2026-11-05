// §3.3/§8.4: the platform's poll now carries the full body, and the adapter — not the
// platform — owns the context budget. These run against the real platform process the
// rest of the suite boots, so a body that the platform leaves whole reaches the model
// whole, and a cut one always names the `pg_read` call that returns the rest.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLocalMinute } from '../src/format.ts';
import { history, send, waitFor } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, scenario, type Scenario } from './scenario.ts';

const MARKER = /\[truncated: first (\d+) of (\d+) chars; pg_read (\S+) before=(\d+) limit=(\d+)\]/;

function markerOf(text: string): RegExpExecArray {
  const match = MARKER.exec(text);
  assert.ok(match, `a cut delivery must name its pg_read call, got: ${text}`);
  return match;
}

async function deliverAfter(message: string, opts: Parameters<typeof scenario>[0] = {}): Promise<{
  s: Scenario;
  seq: number;
  text: string;
}> {
  const s = await scenario(opts);
  // Drain startup first: a DM that exists before it is the startup brief, not a polled
  // delivery. The tests below are about the polled path unless they say otherwise.
  await s.cycle();
  const sent = await send(s.platform, s.parent!.token, s.me.id, message);
  await s.cycle();
  await s.timer(WINDOW);
  return { s, seq: sent.seq, text: s.surface.texts().join('\n') };
}

test('a 3000-character message is delivered whole, not cut at the old 200', async (t) => {
  const body = 'a'.repeat(2992) + '-TAIL-42';
  assert.equal(Array.from(body).length, 3000, 'the fixture is 3000 characters');

  const { s, text } = await deliverAfter(body);
  t.after(() => s.close());

  assert.ok(text.includes(body), `the full body must reach the model: ${text.slice(0, 300)}`);
  assert.ok(text.endsWith(body.slice(-8)), `the injected text must end with the body's last 8 characters: ${text.slice(-80)}`);
  assert.doesNotMatch(text, MARKER, 'a body inside the default cap must not carry a truncation marker');
});

test('a 12000-character message is capped at 4096 with an executable pg_read hint', async (t) => {
  const body = 'x'.repeat(11992) + 'TAIL-120';
  assert.equal(Array.from(body).length, 12000, 'the fixture is 12000 characters');

  const { s, seq, text } = await deliverAfter(body);
  t.after(() => s.close());

  assert.ok(!text.includes(body), 'the full 12000 characters must not enter the context');
  const marker = markerOf(text);
  assert.equal(Number(marker[1]), 4096, 'the default cap is 4096 characters');
  assert.equal(Number(marker[2]), 12000, 'the marker names the whole body length');
  assert.equal(marker[3], s.dm, 'the marker names this conversation');
  assert.equal(Number(marker[4]), seq + 1, 'before=seq+1 is where /v1/messages selects the message');
  assert.equal(Number(marker[5]), 1, 'one message is enough to return the rest');

  const rest = await s.loop.read({
    conv: marker[3],
    before: Number(marker[4]),
    limit: Number(marker[5]),
  });
  assert.ok(rest.includes(body), `the pg_read call named by the marker must return the full body: ${rest.slice(0, 300)}`);
  assert.equal(rest.split(body).length - 1, 1, 'the full body comes back exactly once');
});

test('PIGROUPS_DELIVERY_MAX_CHARS moves the cap', async (t) => {
  const body = 'b'.repeat(2992) + '-CAP-800';
  assert.equal(Array.from(body).length, 3000, 'the fixture is 3000 characters');

  const { s, seq, text } = await deliverAfter(body, { deliveryMaxChars: 800 });
  t.after(() => s.close());

  assert.ok(!text.includes(body), 'the 3000-character body must be cut at 800');
  const marker = markerOf(text);
  assert.equal(Number(marker[1]), 800, 'the configured cap is the one used');
  assert.equal(Number(marker[2]), 3000, 'the marker still names the whole body length');
  assert.equal(marker[3], s.dm);
  assert.equal(Number(marker[4]), seq + 1);
  assert.equal(Number(marker[5]), 1);
});

test('the startup brief is capped by the same rule and names its pg_read call', async (t) => {
  const body = 'c'.repeat(11992) + 'BRIEF120';
  assert.equal(Array.from(body).length, 12000, 'the fixture is 12000 characters');

  const s = await scenario();
  t.after(() => s.close());
  const brief = await send(s.platform, s.parent!.token, s.me.id, body);
  s.loop.start();
  await waitFor(() => s.surface.deliveries.length > 0, 'the startup brief to be injected');

  const text = s.surface.texts()[0];
  assert.ok(!text.includes(body), 'the brief must not inject all 12000 characters');
  const marker = markerOf(text);
  assert.equal(Number(marker[1]), 4096, 'the brief uses the same default cap');
  assert.equal(Number(marker[2]), 12000);
  assert.equal(marker[3], s.dm, 'the marker names the DM the brief came from');
  assert.equal(Number(marker[4]), brief.seq + 1);
  assert.equal(Number(marker[5]), 1);
});

// §3.3/§8.4: the startup brief is a message too. It carries its own creation time,
// not the time the member happened to start.
test('the startup brief carries its own local timestamp', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  const sent = await send(s.platform, s.parent!.token, s.me.id, 'the task book');
  const [record] = (await history(s.platform, s.me.token, s.dm, { limit: 1 })).items;
  assert.ok(record, 'the platform records the brief it accepted');
  assert.equal(record.seq, sent.seq);

  s.loop.start();
  await waitFor(() => s.surface.deliveries.length > 0, 'the startup brief to be injected');

  const text = s.surface.texts()[0];
  assert.ok(
    text.startsWith(`[${s.dm}#${record.seq} ${formatLocalMinute(record.created_at)}] ${s.parent!.name}: the task book`),
    `the brief carries the message time: ${text}`,
  );
});

test('199- and 200-character messages are delivered with no marker', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  const justUnder = 'd'.repeat(199);
  const exactly = 'e'.repeat(200);

  const first = await send(s.platform, s.parent!.token, s.me.id, justUnder);
  await s.cycle();
  await s.timer(WINDOW);
  const firstText = s.surface.texts()[0];
  assert.ok(firstText.includes(justUnder), `the 199-character body must arrive whole: ${firstText}`);
  assert.ok(firstText.includes(`#${first.seq} `), 'the first delivery is the 199-character message');
  assert.doesNotMatch(firstText, MARKER, '199 characters is under the cap and must not be marked');

  const second = await send(s.platform, s.parent!.token, s.me.id, exactly);
  await s.cycle();
  await s.timer(WINDOW);
  const secondText = s.surface.texts()[1];
  assert.ok(secondText.includes(exactly), `the 200-character body must arrive whole: ${secondText}`);
  assert.ok(secondText.includes(`#${second.seq} `), 'the second delivery is the 200-character message');
  assert.doesNotMatch(secondText, MARKER, '200 characters is exactly at the old boundary but under the new cap');
});

test('a poll message without a body is reported as a protocol error, never injected as undefined', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle();

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  s.pg.poll = async () => ({
    items: [
      {
        kind: 'message' as const,
        to: s.dm,
        seq: 1,
        from_id: s.parent!.id,
        from_name: s.parent!.name,
        from_kind: 'member' as const,
        mentions_me: false,
        from_parent: true,
        at: Date.now(),
      },
    ],
    control_pending: 0,
  });

  await s.cycle();
  await s.timer(WINDOW);

  assert.equal(s.surface.deliveries.length, 0, 'a message with no body must not reach the model');
  assert.equal(
    warnings.filter((line) => line.includes('no body field')).length,
    1,
    `the missing field must be reported, got: ${JSON.stringify(warnings)}`,
  );
  assert.ok(!s.surface.texts().join('\n').includes('undefined'), 'nothing is silently injected as undefined');
});
