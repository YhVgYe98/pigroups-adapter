// §5 telemetry: child-side edge triggering and parent-side window consolidation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { command, createMember, delay, send } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, createLoop, payloads, scenario } from './scenario.ts';

test('a tool call past the threshold emits exactly one stalled attention, and recovery emits recovered', async (t) => {
  const s = await scenario({ attentionToolMs: 60_000 });
  t.after(() => s.close());
  await s.cycle(); // the adapter has run a poll: it knows who it is and who to report to

  s.surface.beginTurn();
  s.surface.emit({ type: 'turn_start' });
  s.surface.emit({ type: 'tool_start', name: 'bash', argsPreview: "find ~/ -name '*.ts'" });

  await s.timer(61_000);
  const first = payloads(await s.controlsToParent(), 'pg.attention');
  const stalled = first.filter((payload) => payload.state === 'stalled');
  assert.equal(stalled.length, 1, `one stalled attention expected, got ${JSON.stringify(first)}`);
  assert.equal(stalled[0].tool?.name, 'bash', 'the attention must carry the tool that is stuck');

  await s.timer(10_000);
  await s.timer(10_000);
  const repeats = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'stalled');
  assert.equal(repeats.length, 0, 'stalled is edge-triggered: not one report per tick');

  s.surface.emit({ type: 'tool_end', name: 'bash', ok: true });
  await s.timer(1_000);
  const recovered = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'recovered');
  assert.equal(recovered.length, 1, 'leaving the stalled state must report recovered once');
  assert.equal(recovered[0].of, 'stalled', 'recovered names the state it left');
});

test('two children stalled in one window produce one consolidated nudge; a window that ends recovered produces none', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 300_000 });
  t.after(() => s.close());

  const a = await createMember(s.platform, s.me, 'reviewer');
  const b = await createMember(s.platform, s.me, 'coder');

  await command(s.platform, a.token, s.me.id, 'pg.attention', {
    v: 1,
    child: a.id,
    name: a.name,
    state: 'stalled',
    since: s.clock.now(),
    tool: { name: 'bash', elapsed_ms: 720_000, preview: "find ~/ -name '*.ts'" },
  });
  await command(s.platform, b.token, s.me.id, 'pg.attention', {
    v: 1,
    child: b.id,
    name: b.name,
    state: 'error',
    since: s.clock.now(),
    note: 'provider 429 ×7',
  });

  await s.cycle();
  assert.equal(s.surface.deliveries.length, 0, 'inbound attention updates the table, it is not injected');

  await s.timer(); // the reminder merge window expires and the reminder enters the queue
  assert.equal(s.surface.textsOfKind('nudge').length, 0, 'a reminder still waits for the delivery window');
  await s.timer(WINDOW); // the delivery window closes
  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, `two events in one window mean one nudge, got ${nudges.length}`);
  assert.ok(nudges[0].includes(a.id), `the summary must name the stalled child: ${nudges[0]}`);
  assert.ok(nudges[0].includes(b.id), `the summary must name the failing child: ${nudges[0]}`);

  await s.timer(WINDOW);
  assert.equal(s.surface.textsOfKind('nudge').length, 1, 'an already reminded state is not reminded again');

  // A second, independent window: everything recovers before it expires.
  const quietWindow = await createLoop(s.platform, s.me, { remindWindowMs: 300_000 });
  t.after(() => quietWindow.stop());
  const c = await createMember(s.platform, s.me, 'slowpoke');

  await command(s.platform, c.token, s.me.id, 'pg.attention', {
    v: 1,
    child: c.id,
    name: c.name,
    state: 'stalled',
    since: s.clock.now(),
    tool: { name: 'bash', elapsed_ms: 400_000, preview: 'sleep 600' },
  });
  await quietWindow.cycle();
  await quietWindow.timer(30_000);

  await command(s.platform, c.token, s.me.id, 'pg.attention', {
    v: 1,
    child: c.id,
    name: c.name,
    state: 'recovered',
    since: s.clock.now(),
    of: 'stalled',
  });
  await quietWindow.cycle();
  await quietWindow.timer(300_000);
  await quietWindow.timer(WINDOW);

  assert.equal(
    quietWindow.surface.textsOfKind('nudge').length,
    0,
    'a window that expires with everything recovered must be cancelled silently',
  );
});

test('two attentions from one child build a real table entry: state, since, count and tool', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'coder');

  // The list is the tree, the state comes from telemetry: before any attention the child is
  // there and simply reports nothing wrong.
  assert.deepEqual(
    (await s.loop.children()).map((row) => [row.id, row.state]),
    [[child.id, 'ok']],
    'a child that has reported nothing is listed as ok',
  );

  const since = s.clock.now() - 120_000;
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'stalled',
    since,
    tool: { name: 'bash', elapsed_ms: 720_000, preview: "find ~/ -name '*.ts'" },
  });
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'stalled',
    since,
    tool: { name: 'edit', elapsed_ms: 90_000, preview: 'src/loop.ts' },
  });
  await s.cycle();

  assert.equal(s.surface.deliveries.length, 0, 'attention updates the table, it is not injected');

  const rows = await s.loop.children();
  assert.equal(rows.length, 1, `the telemetry table must hold the child, got ${JSON.stringify(rows)}`);
  const [row] = rows;
  assert.equal(row.id, child.id, 'the row is keyed by the child id');
  assert.equal(row.name, child.name, 'the row carries the name the child reported');
  assert.equal(row.state, 'stalled', 'the row carries the state the child reported');
  assert.equal(row.since, since, "the row carries the child's own since, not the receipt time");
  assert.equal(row.count, 2, 'two attentions mean two counted events');
  assert.equal(row.tool?.name, 'edit', 'the row carries the tool of the latest event');
  assert.ok(String(row.tool?.preview).includes('loop.ts'), `the row keeps the preview: ${JSON.stringify(row.tool)}`);
});

test('state gone skips the reminder merge window, but still waits for the delivery window', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 3_600_000 });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'vanished');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'gone',
    since: s.clock.now(),
  });
  await s.cycle();
  await s.timer(0); // the 1h reminder window cannot have expired
  assert.equal(s.surface.textsOfKind('nudge').length, 0, 'the delivery window still applies to a reminder');

  await s.timer(WINDOW);
  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, 'gone must not wait for the reminder merge window');
  assert.ok(nudges[0].includes(child.id), `the report must name the child that went away: ${nudges[0]}`);
});

test('a turn that ends with a provider error reports one error attention with its note', async (t) => {
  const s = await scenario({ attentionToolMs: 60_000 });
  t.after(() => s.close());
  await s.cycle(); // the adapter has run a poll: it knows who it is and who to report to

  s.surface.beginTurn();
  s.surface.emit({ type: 'turn_start' });
  await s.settle({ message: 'provider 429 ×7' });
  await s.timer(0);

  const errors = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'error');
  assert.equal(errors.length, 1, `one error attention expected, got ${JSON.stringify(errors)}`);
  assert.ok(String(errors[0].note ?? '').includes('429'), 'the error attention carries the note');
});

test('a turn running past twice the tool threshold reports one slow_turn with busy_ms', async (t) => {
  const s = await scenario({ attentionToolMs: 60_000 });
  t.after(() => s.close());
  await s.cycle();

  s.surface.beginTurn();
  s.surface.emit({ type: 'turn_start' });
  await s.timer(121_000);

  const slow = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'slow_turn');
  assert.equal(slow.length, 1, `one slow_turn attention expected, got ${JSON.stringify(slow)}`);
  assert.ok(Number(slow[0].busy_ms) >= 121_000, 'slow_turn carries how long the turn has been running');

  await s.timer(30_000);
  const again = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'slow_turn');
  assert.equal(again.length, 0, 'slow_turn is edge-triggered: not one report per tick');
});

test('idle with an unanswered message past the threshold reports one idle_owed naming the conversations', async (t) => {
  const s = await scenario({ attentionToolMs: 60_000 });
  t.after(() => s.close());
  await s.cycle();

  await send(s.platform, s.parent!.token, s.me.id, 'still waiting');
  await s.cycle();
  await s.timer(WINDOW); // the message is delivered and the conversation becomes owed
  await s.settle(); // the turn ends, so the member is idle but still owes a reply
  await s.timer(61_000); // owed for longer than attentionToolMs
  await delay(50); // the attention report is fire-and-forget, like every telemetry control

  const idleOwed = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'idle_owed');
  assert.equal(idleOwed.length, 1, `one idle_owed attention expected, got ${JSON.stringify(idleOwed)}`);
  assert.deepEqual(idleOwed[0].owed, [s.dm], 'idle_owed names the conversations still owed');
});

// 概念稿 §8.5: without the last round, pg_abort is a blind operation. The child reports
// what it last said and what it last ran; the parent reads it in the snapshot and in the
// consolidated reminder.
test('a child’s attention report carries its last round: last assistant text and last finished tool', async (t) => {
  const s = await scenario({ attentionToolMs: 60_000 });
  t.after(() => s.close());
  await s.cycle();

  s.surface.lastText = 'I am testing the parser now';
  s.surface.beginTurn();
  s.surface.emit({ type: 'turn_start' });
  s.surface.emit({ type: 'tool_start', name: 'bash', argsPreview: "npm test -- --grep 'parser'" });
  s.surface.emit({ type: 'tool_end', name: 'bash', ok: true });
  s.surface.emit({ type: 'tool_start', name: 'edit', argsPreview: 'src/parser.ts' });

  await s.timer(61_000);
  await delay(50);

  const stalled = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'stalled');
  assert.equal(stalled.length, 1, `precondition: a stalled report went out, got ${JSON.stringify(stalled)}`);
  assert.equal(stalled[0].last?.text, 'I am testing the parser now', 'the parent reads what the child last said');
  assert.equal(stalled[0].last?.tool?.name, 'bash', 'and the last tool it finished, not the one still running');
  assert.match(String(stalled[0].last?.tool?.preview), /parser/, 'with the argument preview');
  assert.equal(stalled[0].last?.tool?.ok, true, 'and whether pi called it ok');
});

test('the last assistant text is truncated before it travels', async (t) => {
  const s = await scenario({ attentionToolMs: 60_000 });
  t.after(() => s.close());
  await s.cycle();

  s.surface.lastText = 'x'.repeat(600);
  s.surface.beginTurn();
  s.surface.emit({ type: 'turn_start' });
  s.surface.emit({ type: 'tool_start', name: 'bash', argsPreview: 'sleep 600' });
  await s.timer(61_000);
  await delay(50);

  const stalled = payloads(await s.controlsToParent(), 'pg.attention').filter((p) => p.state === 'stalled');
  const text = String(stalled[0]?.last?.text ?? '');
  assert.equal(text.length, 501, '§13.5: the assistant text is cut at 500 characters, plus the ellipsis');
  assert.ok(text.endsWith('…'), 'and says that it was cut');
});

test('the parent sees a child’s last round in its snapshot and in the consolidated reminder', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 300_000 });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'coder');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'stalled',
    since: s.clock.now(),
    tool: { name: 'bash', elapsed_ms: 720_000, preview: 'sleep 600' },
    last: {
      text: 'refactoring the scheduler',
      tool: { name: 'edit', preview: 'src/scheduler.ts', ok: false },
    },
  });
  await s.cycle();

  const [row] = await s.loop.children();
  assert.equal(row.last?.text, 'refactoring the scheduler', 'pg_children carries the last round');
  assert.equal(row.last?.tool?.name, 'edit');
  assert.equal(row.last?.tool?.ok, false, 'a failed last tool stays visibly failed');

  await s.timer(); // the reminder merge window expires
  await s.timer(WINDOW); // the delivery window closes
  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, `precondition: one consolidated reminder, got ${JSON.stringify(s.surface.texts())}`);
  assert.ok(nudges[0].includes('refactoring the scheduler'), `the reminder says what the child last said: ${nudges[0]}`);
  assert.ok(nudges[0].includes('edit'), `the reminder names the last tool: ${nudges[0]}`);
});
