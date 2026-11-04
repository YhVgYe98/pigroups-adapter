// §5 telemetry: child-side edge triggering and parent-side window consolidation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { command, createMember, delay, removeMember, send } from './support.ts';
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
  assert.match(nudges[0], /^2 children need attention:$/m, `the summary is an English prompt: ${nudges[0]}`);
  assert.match(nudges[0], /error: provider 429 ×7/, `the error note is rendered under an English label: ${nudges[0]}`);
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
  // P7: every prompt injected into a model is English. Asserting only that the child's own
  // data survives would let the labels (`said:`, `last tool`, `(failed)`) go back to Chinese
  // unnoticed — they were 8 of the 13 strings the translation touched.
  assert.match(
    nudges[0],
    new RegExp(
      `^1 child needs attention:\\n- ${child.id} \\(coder\\) stalled 5m in bash: sleep 600; ` +
        `last round said: refactoring the scheduler, last tool edit: src/scheduler\\.ts \\(failed\\)$`,
      'm',
    ),
    `the whole line is the English prompt the design pins: ${nudges[0]}`,
  );
});

// §5.2: one child is one line, and that line carries every state the child is in.
// `error` and `blocked` are a real combination: the provider failed and the member is
// also stuck owing replies in two conversations.
test('a child that is both error and blocked is rendered on one line with both states', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 60_000 });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'coder');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'error',
    since: s.clock.now(),
    note: 'provider 429 x7',
  });
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'blocked',
    since: s.clock.now() + 1_000,
    owed: ['dm:m_a_m_d', 'dm:m_b_m_d'],
    note: 'no output after 3 nudges (dm:m_b_m_d)',
  });
  await s.cycle();
  await s.timer(60_000); // the reminder window expires
  await s.timer(WINDOW); // the delivery window closes

  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, `one child means one line, got ${JSON.stringify(s.surface.texts())}`);
  const lines = nudges[0].split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 1, `the two states share the child's line: ${nudges[0]}`);
  assert.match(lines[0], /error: provider 429 x7/);
  assert.match(lines[0], /blocked \(2 convs: dm:m_a_m_d, dm:m_b_m_d\)/);
  assert.equal(
    (await s.loop.children()).find((row) => row.id === child.id)?.state,
    'blocked',
    'the snapshot keeps the latest applied state while both remain in the table',
  );
});

// §5.2: `idle_owed` is reported but never summarized. When the child also has a state the
// parent can act on, the line must not carry the unactionable one along.
test('idle_owed beside blocked is left out of the summary entirely', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 60_000 });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'coder');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'idle_owed',
    since: s.clock.now(),
    owed: ['g:someone-else'],
  });
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'blocked',
    since: s.clock.now() + 1_000,
    owed: ['dm:m_a_m_d'],
  });
  await s.cycle();
  await s.timer(60_000);
  await s.timer(WINDOW);

  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, `blocked is actionable, so it is summarized: ${JSON.stringify(s.surface.texts())}`);
  assert.match(nudges[0], /blocked \(1 conv: dm:m_a_m_d\)/);
  assert.ok(!nudges[0].includes('idle_owed'), `idle_owed never joins a summary: ${nudges[0]}`);
});

// §5.1: `stalled` is a special case of `slow_turn` (one tool eating the turn). Reporting
// both would put the same fact on the parent's line twice, so the narrower state wins.
test('a stalled tool does not also report the turn as slow', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 60_000 });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'coder');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'slow_turn',
    since: s.clock.now(),
    busy_ms: 700_000,
  });
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'stalled',
    since: s.clock.now() + 1_000,
    tool: { name: 'bash', elapsed_ms: 400_000, preview: 'find . -name "*.ts"' },
  });
  await s.cycle();
  await s.timer(60_000);
  await s.timer(WINDOW);

  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, JSON.stringify(s.surface.texts()));
  assert.match(nudges[0], /stalled/);
  assert.ok(!nudges[0].includes('slow_turn'), `the narrower state replaces the broader one: ${nudges[0]}`);
});

// §5.2: a state entry is reminded once. A different `owed` set is new information (the
// parent replaces the whole set); the same set is not.
test('a repeated blocked set is not re-reported, while a larger or smaller set is', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 60_000 });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'coder');
  const blocked = async (owed: string[]): Promise<void> => {
    await command(s.platform, child.token, s.me.id, 'pg.attention', {
      v: 1,
      child: child.id,
      name: child.name,
      state: 'blocked',
      since: s.clock.now(),
      owed,
    });
    await s.cycle();
    await s.timer(60_000);
    await s.timer(WINDOW);
  };

  await blocked(['dm:m_a_m_d']);
  assert.equal(s.surface.textsOfKind('nudge').length, 1, 'precondition: the first blocked set is reported');

  await blocked(['dm:m_a_m_d']);
  assert.equal(
    s.surface.textsOfKind('nudge').length,
    1,
    `the same set is the same state entry: no second reminder: ${JSON.stringify(s.surface.texts())}`,
  );

  await blocked(['dm:m_a_m_d', 'dm:m_b_m_d']);
  let nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 2, `a larger set is new information: ${JSON.stringify(s.surface.texts())}`);
  assert.match(nudges[1], /blocked \(2 convs: dm:m_a_m_d, dm:m_b_m_d\)/);

  await blocked(['dm:m_b_m_d']);
  nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 3, `a smaller set is news too: ${JSON.stringify(s.surface.texts())}`);
  assert.match(nudges[2], /blocked \(1 conv: dm:m_b_m_d\)/);
  assert.ok(!nudges[2].includes('dm:m_a_m_d'), `the parent replaces the set, never unions it: ${nudges[2]}`);

  // Recovering the state removes it; recovery on its own is not a reminder.
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'recovered',
    of: 'blocked',
    since: s.clock.now(),
  });
  await s.cycle();
  await s.timer(60_000);
  await s.timer(WINDOW);
  assert.equal(s.surface.textsOfKind('nudge').length, 3, 'a recovery is not a new summary by itself');
  assert.equal(
    (await s.loop.children()).find((row) => row.id === child.id)?.states.some((state) => state.state === 'blocked'),
    false,
    'recovered removes the state from the table',
  );
});

// §5.1: `gone` is terminal and is not an `of:` value. A bogus `recovered{of:'gone'}`
// must not remove anything from the table.
test('recovered never accepts gone as the state it left', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'coder');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'error',
    since: s.clock.now(),
    note: 'provider 429',
  });
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'recovered',
    of: 'gone',
    since: s.clock.now(),
  });
  await s.cycle();

  const row = (await s.loop.children()).find((entry) => entry.id === child.id);
  assert.ok(
    row?.states.some((state) => state.state === 'error'),
    `a recovered of gone changes nothing: ${JSON.stringify(row)}`,
  );
});

// §5.1: only a direct child may change what its parent believes about it. A parent is
// higher up, not a direct child: its `pg.attention` must be injected as an ordinary
// control line (nothing may be dropped) but must not touch the telemetry table.
test('pg.attention from a non-child is injected but cannot change a child state', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'watched');
  await s.cycle(); // startup roster read: the direct child is known

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    await command(s.platform, s.parent!.token, s.me.id, 'pg.attention', {
      v: 1,
      child: child.id,
      name: child.name,
      state: 'error',
      since: s.clock.now(),
      note: 'forged by the parent',
    });
    await s.cycle();
  } finally {
    console.warn = original;
  }

  await s.timer(); // past the reminder window: an applied error would produce a nudge
  await s.timer(WINDOW);

  const rows = await s.loop.children();
  assert.equal(
    rows.find((row) => row.id === child.id)?.state,
    'ok',
    `a non-child must not change the child's state: ${JSON.stringify(rows)}`,
  );
  const control = s.surface.textsOfKind('control').join('\n');
  assert.match(
    control,
    new RegExp(`^\\[control ${s.parent!.id}\\] pg.attention `, 'm'),
    `the ignored control must still reach the model as a line: ${control}`,
  );
  assert.ok(control.includes('forged by the parent'), `the payload must not be dropped: ${control}`);
  assert.equal(
    s.surface.textsOfKind('nudge').length,
    0,
    `an ignored attention must not open a reminder: ${JSON.stringify(s.surface.texts())}`,
  );
  assert.ok(
    warnings.some((line) => line.includes('not a direct child')),
    `the ignore must be explained in a warning, got ${JSON.stringify(warnings)}`,
  );
});

// A child spawned after the startup snapshot is still a child. The first report cannot
// hit the pane map (another process spawned it) or telemetry (it has never reported), so
// it must refresh the stale roster once instead of staying blind until the next settle.
test('a child missing from the startup roster is accepted after one report refreshes it', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  await s.cycle(); // startup roster snapshot: the child does not exist yet

  const late = await createMember(s.platform, s.me, 'late-child');
  s.clock.advance(31_000); // the snapshot is now older than ROSTER_TTL_MS

  await command(s.platform, late.token, s.me.id, 'pg.attention', {
    v: 1,
    child: late.id,
    name: late.name,
    state: 'error',
    since: s.clock.now(),
    note: 'provider 429',
  });
  await s.cycle();

  const rows = await s.loop.children();
  assert.equal(
    rows.find((row) => row.id === late.id)?.state,
    'error',
    `a child after the startup snapshot must be accepted after the roster refresh: ${JSON.stringify(rows)}`,
  );
  assert.equal(
    s.surface.textsOfKind('control').length,
    0,
    `an accepted attention is not injected as a control: ${JSON.stringify(s.surface.texts())}`,
  );
});

// §5.1 path 2: a child that is exiting sends `pg.attention{state:'gone'}`, not a report.
// The exit path is the same channel as every other state: it puts the sender in the table
// as gone and is never injected as a control line.
test('an exiting child arrives as attention gone and is reported without a control line', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'leaver');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'gone',
    since: s.clock.now(),
    note: 'exiting',
  });
  await s.cycle();

  assert.equal(s.surface.deliveries.length, 0, 'an exit is not a line of text for the parent');
  const rows = await s.loop.children();
  assert.equal(
    rows.find((row) => row.id === child.id)?.state,
    'gone',
    `the sender must be gone in the table, got ${JSON.stringify(rows)}`,
  );

  await s.timer(0); // gone skips the reminder merge window
  await s.timer(WINDOW); // but it still waits for the delivery window
  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, `gone must be reported once, got ${JSON.stringify(s.surface.texts())}`);
  assert.ok(nudges[0].includes(child.id), `the report must name the child that left: ${nudges[0]}`);
  assert.match(nudges[0], /gone: exiting/, `the exit note is the one fact the parent gets: ${nudges[0]}`);
});

// §5.2: gone is urgent (it skips the reminder merge window) but it is still delivered once.
// A crash cascade removes many children at the same instant; fifteen injections here is the
// 6.5 hour replay in miniature.
test('two children gone in one window produce one reminder with one line each', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 3_600_000 });
  t.after(() => s.close());
  const a = await createMember(s.platform, s.me, 'first');
  const b = await createMember(s.platform, s.me, 'second');

  for (const child of [a, b]) {
    await command(s.platform, child.token, s.me.id, 'pg.attention', {
      v: 1,
      child: child.id,
      name: child.name,
      state: 'gone',
      since: s.clock.now(),
      note: 'exiting',
    });
  }
  await s.cycle();
  assert.deepEqual(
    (await s.loop.children()).map((row) => [row.id, row.state]).sort(),
    [
      [a.id, 'gone'],
      [b.id, 'gone'],
    ].sort(),
    'both children are gone in the table before the reminder is queued',
  );

  await s.timer(0); // the merge window is bypassed, but the delivery window is not
  assert.equal(s.surface.textsOfKind('nudge').length, 0, 'one delivery, not one per gone child');

  await s.timer(WINDOW);
  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, `two gone children are one delivery, got ${JSON.stringify(s.surface.texts())}`);
  const lines = nudges[0].split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 2, `one line per gone child: ${nudges[0]}`);
  assert.ok(lines.some((line) => line.includes(a.id)), `the first child is named: ${nudges[0]}`);
  assert.ok(lines.some((line) => line.includes(b.id)), `the second child is named: ${nudges[0]}`);

  await s.timer(WINDOW);
  assert.equal(s.surface.textsOfKind('nudge').length, 1, 'a gone state is reported once, never again');
});

// §5.1 path 3: the liveness recheck must cover the telemetry table, not the pane map.
// `panes` only holds members this process spawned, so a parent that restarted (or a child
// created by an ancestor) would never be checked, and an `error` entry would stay forever.
test('a child that dies is rechecked from the telemetry table even when no pane is mapped', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'ghost');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'error',
    since: s.clock.now(),
    note: 'provider 429',
  });
  await s.cycle();
  assert.equal(s.herdr.spawns.length, 0, 'precondition: this process spawned nobody, so its pane map is empty');
  assert.equal(
    (await s.loop.children()).find((row) => row.id === child.id)?.state,
    'error',
    'precondition: the child is in the telemetry table',
  );

  await removeMember(s.platform, s.me.token, child.id); // a delete this process never issued
  s.clock.advance(30_000); // the recheck TTL
  await s.cycle();

  await s.timer(0); // gone skips the reminder merge window
  await s.timer(WINDOW);
  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, `a dead child must be reported gone, got ${JSON.stringify(s.surface.texts())}`);
  assert.match(nudges[0], /gone/, `the reminder must say the child is gone: ${nudges[0]}`);
  assert.ok(nudges[0].includes(child.id), `the reminder must name the child: ${nudges[0]}`);
});

// §5.2: one reminder per state entry, with no timeout repeat. The old rule ("still going
// after 30 minutes, said again") assumed the state could be confirmed by the child; a dead
// child confirms nothing, and that is how one frozen snapshot was replayed for 6.5 hours.
// A parent that wants to keep watching calls `pg_children()`.
test('a state that is still there hours later is reminded once, never on a repeat interval', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 60_000 });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'stuck');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'stalled',
    since: s.clock.now(),
    tool: { name: 'bash', elapsed_ms: 720_000, preview: 'sleep 600' },
  });
  await s.cycle();
  await s.timer(); // the reminder merge window expires and the reminder enters the queue
  await s.timer(WINDOW); // the delivery window closes and delivers it
  assert.equal(
    s.surface.textsOfKind('nudge').length,
    1,
    `precondition: one reminder, got ${JSON.stringify(s.surface.texts())}`,
  );

  // A second event for the same state is not a new state entry, so it must not re-arm the
  // one reminder this entry gets. Re-arming here is the exact bug that replayed a frozen
  // snapshot every 30 minutes for 6.5 hours.
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'stalled',
    since: s.clock.now(),
    tool: { name: 'bash', elapsed_ms: 720_000, preview: 'sleep 600' },
  });
  await s.cycle();

  // Well past the removed 30 minute repeat interval, twice.
  for (let i = 0; i < 2; i += 1) {
    await s.timer(31 * 60_000);
    await s.timer(WINDOW);
  }

  assert.equal(
    s.surface.textsOfKind('nudge').length,
    1,
    `the same state entry must not be reminded again, got ${JSON.stringify(s.surface.texts())}`,
  );
  const [row] = await s.loop.children();
  assert.equal(row.state, 'stalled', 'and the state stays in the table for pg_children to read');
});

// §5.2: `idle_owed` is reported (the parent can read it in `pg_children`) but never
// injects. The debt is the child's, in a conversation the parent may not even be in:
// 101 of 113 owed references measured in the real run named a conversation without the
// parent, so a reminder about them spends a whole context request on nothing.
test('idle_owed stays in the table but opens no window and joins no summary', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 60_000, deliveryWindowMs: 1_000 });
  t.after(() => s.close());
  const indebted = await createMember(s.platform, s.me, 'indebted');
  const broken = await createMember(s.platform, s.me, 'broken');

  await command(s.platform, indebted.token, s.me.id, 'pg.attention', {
    v: 1,
    child: indebted.id,
    name: indebted.name,
    state: 'idle_owed',
    since: s.clock.now(),
    owed: ['g:someone-else'],
  });
  await s.cycle();

  // `idle_owed` must not open the window, and the only way to see the difference is time:
  // if it opened one at T, an actionable state arriving at T+30 s would ride that window
  // and the reminder would be queued at T+60 s; opening its own window at T+30 s means
  // nothing can be queued before T+90 s. (An idle-only window ends silently, so delivery
  // contents alone cannot tell the two apart — the instant matters.)
  await s.timer(30_000);
  await command(s.platform, broken.token, s.me.id, 'pg.attention', {
    v: 1,
    child: broken.id,
    name: broken.name,
    state: 'error',
    since: s.clock.now(),
    note: 'provider 429',
  });
  await s.cycle();
  await s.timer(31_000); // T+61: the idle_owed window would have expired by now
  await s.timer(2_000); // and its reminder would have left through the 1 s delivery window

  assert.equal(
    s.surface.deliveries.length,
    0,
    `idle_owed opened a window that carried someone else's event out early: ${JSON.stringify(s.surface.texts())}`,
  );
  const indebtedRow = (await s.loop.children()).find((row) => row.id === indebted.id);
  assert.equal(indebtedRow?.state, 'idle_owed', 'the state is still in the table for pg_children');

  // The error's own window expires 60 s after it arrived; the summary that comes out names
  // that child only.
  await s.timer(28_000); // T+91: the window the error opened expires
  await s.timer(2_000); // and the delivery window closes

  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, `one reminder for the actionable child, got ${JSON.stringify(s.surface.texts())}`);
  assert.ok(nudges[0].includes(broken.id), `the summary names the failing child: ${nudges[0]}`);
  assert.ok(!nudges[0].includes(indebted.id), `idle_owed must never join a summary: ${nudges[0]}`);
});

// §5.2: "报一次就从表里删掉". A `gone` row that stays would make `pg_children()` list a dead
// child as gone forever, long after the parent was told once.
test('a gone child is dropped from the table once the reminder is delivered', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'departed');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'gone',
    since: s.clock.now(),
    note: 'exiting',
  });
  await s.cycle();
  await s.timer(0);
  await s.timer(WINDOW);
  assert.equal(s.surface.textsOfKind('nudge').length, 1, 'precondition: the disappearance was reported');

  const rows = await s.loop.children();
  assert.notEqual(
    rows.find((row) => row.id === child.id)?.state,
    'gone',
    `a reported disappearance is no longer a state in the table: ${JSON.stringify(rows)}`,
  );
});

// §5.1 path 2 + path 3 are two ways to learn the same fact. A child that reported `exiting`
// and then disappeared from the platform must not be reported gone a second time — and the
// pane map is what keeps the recheck alive, because a close that failed leaves the mapping in
// place for a retry. Left alone, that retry rebuilt the row every poll cycle and injected a
// fresh "1 child needs attention … gone" each time: the 6.5 hour replay with a new trigger.
test('one disappearance is reported once, even when the pane close fails and the check is retried', async (t) => {
  // A short delivery window: the 30 s liveness bound has to still be running when the next
  // poll happens, so the test cannot spend a whole 60 s window to get the reminder out.
  const s = await scenario({ role: 'root', deliveryWindowMs: 1_000 });
  t.after(() => s.close());
  const child = await s.loop.spawnMember({ brief: 'watch the build' });
  const goneLines = (): string[] =>
    s.surface.textsOfKind('nudge').filter((text) => new RegExp(`${child.id}.*gone`).test(text));
  // Count the liveness questions themselves: delivery text cannot show whether the 30 s
  // bound was honoured, and a platform that is asked once per poll is what this guards.
  let checks = 0;
  const realGetMember = s.pg.getMember.bind(s.pg);
  (s.pg as unknown as { getMember: (id: string) => Promise<unknown> }).getMember = async (id: string) => {
    checks += 1;
    return realGetMember(id);
  };

  // herdr is down: the pane stays mapped, which is exactly the retry case (§5.3).
  s.herdr.failClose = new Error('herdr daemon is not running');
  await removeMember(s.platform, s.me.token, child.id);

  s.clock.advance(30_000);
  await s.cycle(); // getMember → gone, the pane close fails
  await s.timer(0); // gone skips the merge window
  await s.timer(2_000); // and only the 1 s delivery window has to close
  assert.equal(goneLines().length, 1, `the disappearance is reported once: ${JSON.stringify(s.surface.texts())}`);

  // The background spawn watchdog notices the same 30 s and gives up; it asks `getMember`
  // too, so let it finish before counting.
  await delay(400);
  checks = 0;

  // A second look inside the 30 s bound is not a question worth asking the platform.
  await s.cycle();
  await s.timer(0);
  await s.timer(2_000);
  assert.equal(checks, 0, 'a poll inside the 30 s bound must not re-ask about a member it just checked');
  assert.equal(
    goneLines().length,
    1,
    `a retried recheck inside the TTL must not re-report: ${JSON.stringify(s.surface.texts())}`,
  );

  // And a recheck after the bound still describes the same disappearance, not a new one.
  s.clock.advance(30_001);
  await s.cycle();
  await s.timer(0);
  await s.timer(2_000);
  assert.equal(checks, 1, 'after the bound the member is checked again — the retry the failed close needs');
  assert.equal(
    goneLines().length,
    1,
    `a recheck after the TTL must not re-report either: ${JSON.stringify(s.surface.texts())}`,
  );
});
