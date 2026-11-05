// §5 telemetry: child-side edge triggering and parent-side window consolidation.

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatLocalMinute } from '../src/format.ts';
import { writeChildRecord, writeMemberSessionFile } from '../src/records.ts';
import { command, createMember, delay, member, removeMember, send, waitFor } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, createLoop, payloads, scenario, type Scenario } from './scenario.ts';

/**
 * The loop's clock is fake (2024) while the platform stamps times from wall time.
 * Claims are ordered only by `since` (§5.1), so helper timestamps are kept close to
 * wall time; the carrier-refresh test below builds its `since` from wall time on purpose.
 */
function attentionSince(s: Scenario, offsetMs = 0): number {
  return Math.max(s.clock.now(), Date.now()) + 1_000 + offsetMs;
}

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
    since: attentionSince(s),
    tool: { name: 'bash', elapsed_ms: 720_000, preview: "find ~/ -name '*.ts'" },
  });
  await command(s.platform, b.token, s.me.id, 'pg.attention', {
    v: 1,
    child: b.id,
    name: b.name,
    state: 'error',
    since: attentionSince(s),
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
    since: attentionSince(s),
    tool: { name: 'bash', elapsed_ms: 400_000, preview: 'sleep 600' },
  });
  await quietWindow.cycle();
  await quietWindow.timer(30_000);

  await command(s.platform, c.token, s.me.id, 'pg.attention', {
    v: 1,
    child: c.id,
    name: c.name,
    state: 'recovered',
    since: attentionSince(s),
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

  const since = attentionSince(s);
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


// §5.1: attention is ordered by `since`, not by `last_seen_at`. The carrier of every
// claim is an authenticated POST, so its own sighting is always a little newer; that
// must not make the claim disappear.
test('a claim whose own carrier refreshed last_seen_at two seconds later is applied', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'carrier');
  const since = Date.now() - 2_000;

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'error',
    since,
    note: 'provider 429',
  });
  const seen = (await member(s.platform, s.me.token, child.id)).last_seen_at;
  assert.ok(seen !== null && seen > since, 'precondition: the carrier authenticated after the claim');

  await s.cycle();
  const row = (await s.loop.children()).find((entry) => entry.id === child.id);
  assert.equal(
    row?.state,
    'error',
    `the carrier's own refresh is not evidence that the claim is stale: ${JSON.stringify(row)}`,
  );
  assert.equal(row?.since, since, 'the claim keeps its own moment, not the carrier time');
});


// §5.1: attention is edge-triggered, so a `recovered` is never re-sent. The table
// orders by `since`; a recovery newer than the state it names clears it.
test('a recovered clears the state it names even when a later sighting exists', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const sender = await createMember(s.platform, s.me, 'sender');
  const subject = await createMember(s.platform, s.me, 'subject'); // never authenticates
  const stalledSince = Date.now() - 3_600_000;
  const recoveredSince = stalledSince + 60_000;

  // The subject never authenticates, so the test owns its `last_seen_at`; the sender is a
  // direct child, which is the relation the loop checks before folding a claim in.
  let seenAt: number | null = null;
  const stub = s.pg as unknown as { getMember: (id: string) => Promise<unknown> };
  const realGetMember = s.pg.getMember.bind(s.pg);
  stub.getMember = async (id: string) => {
    if (id !== subject.id) return realGetMember(id);
    return { id, name: subject.name, status: 'alive', last_seen_at: seenAt };
  };

  await command(s.platform, sender.token, s.me.id, 'pg.attention', {
    v: 1,
    child: subject.id,
    name: subject.name,
    state: 'stalled',
    since: stalledSince,
    tool: { name: 'bash', elapsed_ms: 3_600_000, preview: 'sleep 3600' },
  });
  await s.cycle();
  assert.equal(
    (await s.loop.children()).find((entry) => entry.id === subject.id)?.state,
    'stalled',
    'precondition: the state to recover is in the table',
  );

  // A sighting an hour after the recovery is irrelevant: only `since` orders claims.
  seenAt = recoveredSince + 3_600_000;
  await command(s.platform, sender.token, s.me.id, 'pg.attention', {
    v: 1,
    child: subject.id,
    name: subject.name,
    state: 'recovered',
    since: recoveredSince,
    of: 'stalled',
  });
  await s.cycle();

  const row = (await s.loop.children()).find((entry) => entry.id === subject.id);
  assert.equal(row?.state, 'ok', `an edge-triggered recovery must not be dropped: ${JSON.stringify(row)}`);
  assert.equal(row?.states.length, 0, 'the recovered state is gone from the table');
});

// §5.1: the snapshot names the latest applied state. When a recovery removes that state,
// `lastState` must re-point at the newest state that remains, not keep naming a row that
// no longer exists.
test('a recovery re-points lastState at the newest remaining state', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'multi-state');
  const errorSince = attentionSince(s);
  const blockedSince = attentionSince(s, 1_000);
  const recoveredSince = attentionSince(s, 2_000);

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'error',
    since: errorSince,
    note: 'provider 429',
  });
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'blocked',
    since: blockedSince,
    owed: ['dm:m_a_m_d'],
  });
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'recovered',
    since: recoveredSince,
    of: 'blocked',
  });
  await s.cycle();

  const row = (await s.loop.children()).find((entry) => entry.id === child.id);
  assert.equal(row?.state, 'error', `lastState points at the state that still exists: ${JSON.stringify(row)}`);
  assert.equal(row?.since, errorSince, 'the snapshot carries the remaining state\'s own since, not 0');
  assert.deepEqual(
    row?.states.map((state) => state.state),
    ['error'],
    'only the error state remains after the blocked recovery',
  );
});

// §5.1: `since: 0` means "now", not 1970. It is normalized once on the way in, so the
// stored claim and the arrival moment agree.
test('an attention with since 0 is treated as now, not as 1970', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  s.clock.set(Date.now()); // the platform's `last_seen_at` and the loop's clock agree
  const child = await createMember(s.platform, s.me, 'zero-since');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'error',
    since: 0,
    note: 'provider 429',
  });
  await s.cycle();

  const row = (await s.loop.children()).find((entry) => entry.id === child.id);
  assert.equal(row?.state, 'error', `since 0 is now, so the claim is not stale: ${JSON.stringify(row)}`);
  assert.equal(row?.since, s.clock.now(), 'the stored since is the arrival moment, not the epoch');
});


// §5.1: the ordering guard is per state name. A delayed event that describes an older
// moment is not allowed to overwrite the newer facts already in the row.
test('a state with an older since than the stored one is ignored', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'delayed');
  const newest = Date.now() + 60_000;
  const older = newest - 1_000;

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'error',
    since: newest,
    note: 'the newer fact',
  });
  await s.cycle();

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'error',
    since: older,
    note: 'the older fact',
  });
  await s.cycle();

  const row = (await s.loop.children()).find((entry) => entry.id === child.id);
  assert.equal(row?.since, newest, 'the stored entry keeps its own since');
  assert.equal(row?.note, 'the newer fact', `the delayed event did not overwrite: ${JSON.stringify(row)}`);
  assert.equal(row?.count, 1, 'the delayed event is not even counted');
});

// §5.2: an absolute time is what separates "just happened" from "seven hours ago,
// delivered now". The line must carry the state's own since, in local minute precision.
test('attention summary lines carry the state since', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 60_000 });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 't3-lead');
  const since = Date.now() + 60_000;

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'error',
    since,
    note: 'provider 429',
  });
  await s.cycle();
  await s.timer(60_000);
  await s.timer(WINDOW);

  const nudges = s.surface.textsOfKind('nudge');
  assert.equal(nudges.length, 1, JSON.stringify(s.surface.texts()));
  assert.match(nudges[0]!, new RegExp(`- ${child.id} \\(t3-lead\\) error: provider 429 since ${formatLocalMinute(since)}`));
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
  // This test pins the rendered duration (5m), so the fake clock starts near wall
  // time; the claim is still newer than the platform's `last_seen_at`.
  s.clock.set(Date.now() + 60_000);
  const since = s.clock.now();

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'stalled',
    since,
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
      `^1 child needs attention:\\n- ${child.id} \\(coder\\) stalled 5m in bash: sleep 600 ` +
        `since ${formatLocalMinute(since)}; ` +
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
    since: attentionSince(s),
    note: 'provider 429 x7',
  });
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'blocked',
    since: attentionSince(s, 1_000),
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
    since: attentionSince(s),
    owed: ['g:someone-else'],
  });
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'blocked',
    since: attentionSince(s, 1_000),
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
    since: attentionSince(s),
    busy_ms: 700_000,
  });
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'stalled',
    since: attentionSince(s, 1_000),
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
  const since = attentionSince(s);
  const blocked = async (owed: string[]): Promise<void> => {
    await command(s.platform, child.token, s.me.id, 'pg.attention', {
      v: 1,
      child: child.id,
      name: child.name,
      state: 'blocked',
      since,
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
    since: attentionSince(s),
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

// §5.1/§6: `gone` is not an attention state and cannot be an `of:` value. A bogus
// `recovered{of:'gone'}` must not remove anything from the table.
test('recovered never accepts gone as the state it left', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'coder');

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'error',
    since: attentionSince(s),
    note: 'provider 429',
  });
  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'recovered',
    of: 'gone',
    since: attentionSince(s),
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
      since: attentionSince(s),
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
// hit a children record (another process spawned it) or telemetry (it has never reported),
// so it must refresh the stale roster once instead of staying blind until the next settle.
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
    since: attentionSince(s),
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

test('a child known only from its children record is rechecked and its pane closed when the platform says gone', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'from-record');
  const sessionFile = '/tmp/pigroups-child/from-record.jsonl';
  writeChildRecord(s.adapterDir, {
    parentId: s.me.id,
    childId: child.id,
    name: child.name,
    cwd: null,
    args: [],
    token: child.token,
    intent: 'spawned',
  });
  writeMemberSessionFile(s.adapterDir, child.id, sessionFile);
  s.herdr.paneList.push({
    pane_id: 'pane-from-record',
    agent_session: { kind: 'path', source: 'herdr:pi', value: sessionFile },
    agent_status: 'idle',
    tab_id: 'wE:t9',
    title: `π - ${child.name} - /tmp`,
  });

  await s.cycle(); // startup: the child is alive, so nothing is closed
  assert.equal(s.herdr.spawns.length, 0, 'precondition: this process spawned nobody and caches no pane');
  assert.deepEqual(s.herdr.closed, [], 'an alive child keeps its pane');

  await removeMember(s.platform, s.me.token, child.id); // a delete this process never issued
  s.clock.advance(30_000);
  await s.cycle();

  assert.deepEqual(s.herdr.closed, ['pane-from-record'], 'the children record kept the member in the recheck');
  await s.timer(0);
  await s.timer(WINDOW);
  assert.equal(
    s.surface.textsOfKind('nudge').some((text) => text.includes(child.id) && /gone/.test(text)),
    false,
    `a deletion is not an attention state: ${JSON.stringify(s.surface.texts())}`,
  );
});

// §5.1: only a direct child may change this member's state. A child created after the
// startup roster was read, with no telemetry and no pane, is still a direct child when
// `children/` names it — the roster is not the only durable fact.
test('a child known only from its children record may report attention', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  await s.cycle(); // the startup roster is read before this child exists

  const late = await createMember(s.platform, s.me, 'after-roster');
  writeChildRecord(s.adapterDir, {
    parentId: s.me.id,
    childId: late.id,
    name: late.name,
    cwd: null,
    args: [],
    token: late.token,
    intent: 'spawned',
  });

  await command(s.platform, late.token, s.me.id, 'pg.attention', {
    v: 1,
    child: late.id,
    name: late.name,
    state: 'error',
    since: attentionSince(s),
    note: 'provider 429',
  });
  await s.cycle();

  const row = (await s.loop.children()).find((entry) => entry.id === late.id);
  assert.equal(
    row?.state,
    'error',
    `the children record makes the sender a direct child: ${JSON.stringify(row)}`,
  );
  assert.equal(
    s.surface.textsOfKind('control').length,
    0,
    `an accepted attention is not injected as a control: ${JSON.stringify(s.surface.texts())}`,
  );
});


test('a gone child is forgotten by the telemetry table instead of being re-fetched forever', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'ghost');
  const realGetMember = s.pg.getMember.bind(s.pg);
  let reads = 0;
  s.pg.getMember = async (id) => {
    if (id === child.id) reads += 1;
    return realGetMember(id);
  };

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'error',
    since: attentionSince(s),
    note: 'provider 429',
  });
  await s.cycle();
  assert.equal(s.herdr.spawns.length, 0, 'precondition: this process spawned nobody and recorded no child');
  assert.equal(
    (await s.loop.children()).find((row) => row.id === child.id)?.state,
    'error',
    'precondition: the child is in the telemetry table',
  );

  // A delete this process never issued: the direct GET is what notices it. The table
  // is consulted only to keep the member in the 30 s recheck; deletion is not a state.
  await removeMember(s.platform, s.me.token, child.id);
  const beforeRecheck = reads;
  s.clock.advance(30_000);
  await s.cycle();
  assert.equal(reads, beforeRecheck + 1, 'the deleted child is read once for its gone answer');

  // Once the platform says gone, the telemetry row is dropped: a long-lived parent does
  // not ask about a dead child every 30 s for the rest of its life.
  const afterGone = reads;
  s.clock.advance(30_000);
  await s.cycle();
  assert.equal(reads, afterGone, 'the forgotten child is no longer a candidate on the next pass');

  await s.timer(0);
  await s.timer(WINDOW);
  assert.equal(
    s.surface.textsOfKind('nudge').some((text) => text.includes(child.id) && /gone/.test(text)),
    false,
    `a deletion is not an attention state: ${JSON.stringify(s.surface.texts())}`,
  );
});

// §5.2: one reminder per state entry, with no timeout repeat. The old rule ("still going
// after 30 minutes, said again") assumed the state could be confirmed by the child; a dead
// child confirms nothing, and that is how one frozen snapshot was replayed for 6.5 hours.
// A parent that wants to keep watching calls `pg_children()`.
test('a state that is still there hours later is reminded once, never on a repeat interval', async (t) => {
  const s = await scenario({ role: 'root', remindWindowMs: 60_000 });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'stuck');
  const since = attentionSince(s);

  await command(s.platform, child.token, s.me.id, 'pg.attention', {
    v: 1,
    child: child.id,
    name: child.name,
    state: 'stalled',
    since,
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
    since,
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
    since: attentionSince(s),
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
    since: attentionSince(s),
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
