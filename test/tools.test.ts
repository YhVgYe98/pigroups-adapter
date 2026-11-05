// §5.3 tools that reach out: inspect (round trip + timeout) and spawn (member + brief + one pane).

import test from 'node:test';
import assert from 'node:assert/strict';

import { writeChildRecord, writeMemberSessionFile } from '../src/records.ts';
import { command, createMember, delay, dmId, history, member, poll, removeMember, send, whoami, type ControlItem } from './support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, driveUntil, pollUntil, scenario, type Scenario } from './scenario.ts';

/** The parent's control queue, scanned for the `pg.inspect_result` that answers `request`. */
async function inspectResultFor(s: Scenario, request: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const polled = await poll(s.platform, s.parent!.token, { wait: 0, types: 'control' });
    const hit = polled.items.find(
      (item): item is ControlItem =>
        item.kind === 'control' && item.cmd === 'pg.inspect_result' && (item.payload as any)?.request === request,
    );
    if (hit !== undefined) return hit.payload as Record<string, any>;
    await delay(20);
  }
  throw new Error(`no pg.inspect_result for request "${request}" arrived within 3000ms`);
}

test('pg.inspect gets a pg.inspect_result whose request matches, and an unanswered inspect times out without inventing a result', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());

  const pending = s.loop.inspect(s.parent!.id, 3000);
  const asked = await pollUntil(s.platform, s.parent!.token, 'pg.inspect');
  const request = (asked.payload as Record<string, any> | null)?.request;
  assert.equal(typeof request, 'string', 'pg.inspect must carry a request id');

  await command(s.platform, s.parent!.token, s.me.id, 'pg.inspect_result', {
    v: 1,
    request,
    phase: 'tool_call',
    busy_ms: 1234,
    owed: [s.dm],
    children: 2,
    tool: { name: 'bash', elapsed_ms: 5000, preview: 'ls' },
    last: { text: 'the last thing it said', tool: { name: 'edit', preview: 'src/loop.ts', ok: false } },
  });

  const answered = await driveUntil(s, pending);
  assert.equal(answered.phase, 'tool_call', 'the result is matched by its request id');
  assert.equal(answered.busy_ms, 1234);
  assert.deepEqual(answered.owed, [s.dm]);
  assert.equal(answered.children, 2);
  assert.equal(answered.tool?.name, 'bash');
  assert.equal(answered.last?.text, 'the last thing it said', 'the answer carries the last-round block');
  assert.deepEqual(answered.last?.tool, { name: 'edit', preview: 'src/loop.ts', ok: false });

  const unanswered = await driveUntil(s, s.loop.inspect(s.siblings[0].id, 150));
  assert.equal(unanswered.phase, 'unknown', 'a timed-out inspect resolves as unknown, it does not invent a phase');
});

// §3.2: `pg.inspect` arriving *at* the adapter is answered on the spot. The asker here is the
// parent, not the adapter itself, so an adapter that only implements the asking side is red.
test('pg.inspect sent to the adapter is answered with its own phase, owed and children', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  await s.cycle(); // the startup sequence: nothing owed yet, no turn running

  // 1) Idle, nothing owed, no children: the answer must describe *this* adapter, not a fixed default.
  const idleRequest = 'r-idle-1';
  await command(s.platform, s.parent!.token, s.me.id, 'pg.inspect', { v: 1, request: idleRequest });
  await s.loop.pollOnce();

  const idle = await inspectResultFor(s, idleRequest);
  assert.equal(idle.request, idleRequest, 'the answer must carry the request id it answers');
  assert.equal(idle.phase, 'idle', 'no turn is running: a live answer says idle');
  assert.equal(typeof idle.busy_ms, 'number', 'the answer carries busy_ms');
  assert.deepEqual(idle.owed, [], 'nothing is owed in this conversation yet');
  assert.equal(idle.children, 0, 'this member has no children');

  // 2) After a DM the member owes a reply to, the same three fields move with the state.
  await send(s.platform, s.parent!.token, s.me.id, 'the task the member owes a reply to');
  await s.cycle();
  await s.timer(WINDOW); // the debt is marked when the window delivers it
  assert.deepEqual(s.loop.state().owed, [s.dm], 'precondition: the DM is owed');

  const owedRequest = 'r-owed-1';
  await command(s.platform, s.parent!.token, s.me.id, 'pg.inspect', { v: 1, request: owedRequest });
  await s.loop.pollOnce();

  const result = await inspectResultFor(s, owedRequest);
  assert.equal(result.request, owedRequest, 'a second inspect gets its own answer');
  assert.notEqual(result.phase, 'unknown', 'unknown is §9\'s timeout fallback, not a live answer');
  assert.ok(
    ['idle', 'thinking', 'output', 'tool_call'].includes(String(result.phase)),
    `phase must be one of §6's values, got ${result.phase}`,
  );
  assert.deepEqual(result.owed, [s.dm], "the answer reports the adapter's own obligation table");
  assert.equal(result.children, 0, 'this member still has no children');

  // 3) The last-round block (§8.5) is what makes an inspect useful about a member that
  // is inside a tool: the parent sees what it last said and what it last ran.
  s.surface.lastText = 'the answer I would give';
  s.surface.emit({ type: 'tool_start', name: 'bash', argsPreview: 'ls -la' });
  s.surface.emit({ type: 'tool_end', name: 'bash', ok: true });

  const lastRequest = 'r-last-1';
  await command(s.platform, s.parent!.token, s.me.id, 'pg.inspect', { v: 1, request: lastRequest });
  await s.loop.pollOnce();

  const withLast = await inspectResultFor(s, lastRequest);
  assert.equal(withLast.last?.text, 'the answer I would give', 'a live inspect reports the last assistant text');
  assert.equal(withLast.last?.tool?.name, 'bash', 'and the last finished tool call');
  assert.equal(withLast.last?.tool?.ok, true);
});

test('pg_spawn creates a member, DMs the brief, and starts one pane with the child token in the env', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const child = await s.loop.spawnMember({ name: 'runner', brief: 'implement Y', cwd: '/tmp/ws' });

  const created = await member(s.platform, s.me.token, child.id);
  assert.equal(created.parent_id, s.me.id, 'the new member is my child');
  assert.equal(created.name, 'runner');

  assert.equal(s.herdr.spawns.length, 1, 'one pane per spawned member');
  const spawn = s.herdr.spawns[0];
  assert.equal(spawn.cwd, '/tmp/ws');
  assert.equal(spawn.args, undefined, 'no args leaves the configured base command alone');

  const childToken = spawn.env.PIGROUPS_TOKEN;
  assert.ok(childToken, 'the pane must be started with the child token in the env');
  const asChild = await whoami(s.platform, childToken);
  assert.equal(asChild.member.id, child.id, "the pane's token must be the new child's own token");

  const brief = await history(s.platform, s.me.token, dmId(s.me.id, child.id));
  assert.equal(brief.items.length, 1, 'the brief goes out as one DM');
  assert.ok(brief.items[0].body.includes('implement Y'), brief.items[0].body);
  assert.equal(brief.items[0].sender_id, s.me.id, 'the brief comes from the spawning member');
});

// §2.2: pg_spawn's raw args reach the pane as extra argv, appended to the configured
// base command rather than replacing or string-splicing it.
test('spawnMember carries the raw pi argv to the pane', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const args = ['--model', 'vendor/model', '--extension', '/tmp/extra extension.ts', '--future', 'raw'];
  await s.loop.spawnMember({ name: 'argv', brief: 'implement W', args });

  assert.equal(s.herdr.spawns.length, 1);
  assert.deepEqual(s.herdr.spawns[0].args, args, 'the loop passes the argv tail through unchanged');
});

// 概念稿 §5.1: deleting a member is how a stuck pane is stopped. The platform marks
// it gone and tells its pi to exit; the shell the pane falls back to is still there,
// so the adapter that spawned it has to close that pane.
test('pg_terminate closes the pane of the child it spawned, and only after the delete committed', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const child = await s.loop.spawnMember({ name: 'runner', brief: 'implement Y' });
  assert.deepEqual(s.herdr.closed, [], 'nothing may be closed while the child is alive');

  // Read the platform exactly when herdr is asked to close: the pane may only go after
  // the row says `gone`, never before.
  let statusAtClose: string | undefined;
  s.herdr.onClose = async () => {
    statusAtClose = (await member(s.platform, s.me.token, child.id)).status;
  };

  const result = await s.loop.terminate(child.id);

  assert.deepEqual(result.terminated, [child.id], 'the platform deleted exactly the child');
  assert.deepEqual(result.pane_close_failed, [], 'the pane close succeeded');
  assert.deepEqual(result.pane_close_forced, [], 'the agent left cleanly, so the close was not forced');
  assert.equal(statusAtClose, 'gone', 'the delete must be committed before herdr closes the pane');
  assert.deepEqual(s.herdr.closed, ['pane-1'], 'the pane of the terminated child must be closed');
});


// §5.3: a pane close that had to cut a still-working agent is a success, but it must not
// look like a clean one. The answer names the panes that were forced.
test('pg_terminate reports a pane close that was forced past a still-running agent', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const child = await s.loop.spawnMember({ name: 'runner', brief: 'implement Y' });
  s.herdr.forceClose = true;

  const result = await s.loop.terminate(child.id);

  assert.deepEqual(result.terminated, [child.id], 'the delete still commits');
  assert.deepEqual(result.pane_close_failed, [], 'a forced close is not a retryable failure');
  assert.deepEqual(
    result.pane_close_forced,
    [{ member: child.id, pane: 'pane-1' }],
    'the answer must name the member whose live agent was cut off',
  );
  assert.deepEqual(s.herdr.closed, ['pane-1'], 'the pane was still closed');
});

// §5.3: the delete is the fact; closing the pane is cleanup. A herdr that is down must
// not turn a committed delete into a tool error, and the child record still names the
// member on the next attempt.
test('a failed pane close is reported without failing the committed delete, and a retry closes it', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const child = await s.loop.spawnMember({ name: 'runner', brief: 'implement Y' });
  s.herdr.failClose = new Error('herdr: daemon unreachable');

  const first = await s.loop.terminate(child.id);
  assert.deepEqual(first.terminated, [child.id], 'the delete committed and is reported as such');
  assert.deepEqual(
    first.pane_close_failed.map((entry) => entry.member),
    [child.id],
    'the pane that could not be closed is named in the same answer',
  );
  assert.deepEqual(s.herdr.closed, [], 'nothing was actually closed');

  s.herdr.failClose = undefined;
  const second = await s.loop.terminate(child.id);
  assert.deepEqual(second.pane_close_failed, [], 'the retry succeeds');
  assert.deepEqual(s.herdr.closed, ['pane-1'], 'the child record survived the failure, so the retry could find the pane');
});

// §5.3: pane ids are not adapter state. A parent that restarted remembers no pane, but
// the member's own session file survives on disk — and that is what herdr puts on the
// pane. Looking only at what this process spawned leaves a live pi holding a token the
// platform has already deleted.
test('pg_terminate closes a pane found by its session file after a restart', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const child = await createMember(s.platform, s.me, 'survivor');
  const sessionFile = '/tmp/pigroups-child/survivor.jsonl';
  writeMemberSessionFile(s.adapterDir, child.id, sessionFile);
  s.herdr.paneList.push({
    pane_id: 'pane-from-before-restart',
    agent_session: { kind: 'path', source: 'herdr:pi', value: sessionFile },
    agent_status: 'idle',
    tab_id: 'wE:t7',
    title: 'π - survivor - /tmp',
  });

  const result = await s.loop.terminate(child.id);

  assert.deepEqual(result.terminated, [child.id], 'the delete still commits');
  assert.deepEqual(result.pane_close_failed, [], 'the pane close succeeded');
  assert.deepEqual(s.herdr.closed, ['pane-from-before-restart'], 'the session file names the pane to close');
});

// §5.3: respawn (`pi --session`) and herdr's own restore can leave two panes running the
// same session. Both are the terminated member: one close is not enough.
test("pg_terminate closes every pane that carries the member's session file", async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const child = await s.loop.spawnMember({ name: 'twin', brief: 'implement Y' });
  const sessionFile = '/tmp/pigroups-child/twin.jsonl';
  writeMemberSessionFile(s.adapterDir, child.id, sessionFile);
  s.herdr.paneList.push(
    {
      pane_id: 'pane-1',
      agent_session: { kind: 'path', source: 'herdr:pi', value: sessionFile },
      agent_status: 'idle',
      tab_id: 'wE:t1',
      title: 'π - twin - /tmp',
    },
    {
      pane_id: 'pane-2',
      agent_session: { kind: 'path', source: 'herdr:pi', value: sessionFile },
      agent_status: 'working',
      tab_id: 'wE:t2',
      title: 'π - twin - /tmp',
    },
  );

  const result = await s.loop.terminate(child.id);

  assert.deepEqual(result.terminated, [child.id]);
  assert.deepEqual(result.pane_close_failed, []);
  assert.deepEqual(s.herdr.closed, ['pane-1', 'pane-2'], 'both panes of that session are closed');
});

// §5.3: labels are not identities. Another living member may carry the same label; only
// the pane whose session file matches this member may be closed.
test('pg_terminate does not close a same-named pane that belongs to another living member', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const other = await s.loop.spawnMember({ name: 'runner-other', brief: 'implement X' });
  const otherSession = '/tmp/pigroups-child/other.jsonl';
  writeMemberSessionFile(s.adapterDir, other.id, otherSession);

  const victim = await createMember(s.platform, s.me, 'runner');
  const victimSession = '/tmp/pigroups-child/victim.jsonl';
  writeMemberSessionFile(s.adapterDir, victim.id, victimSession);
  s.herdr.paneList.push(
    {
      pane_id: 'pane-victim',
      agent_session: { kind: 'path', source: 'herdr:pi', value: victimSession },
      agent_status: 'idle',
      tab_id: 'wE:t1',
      title: 'π - runner - /tmp',
    },
    {
      pane_id: 'pane-1',
      agent_session: { kind: 'path', source: 'herdr:pi', value: otherSession },
      agent_status: 'idle',
      tab_id: 'wE:t2',
      title: 'π - runner - /tmp',
    },
  );

  const result = await s.loop.terminate(victim.id);

  assert.deepEqual(result.terminated, [victim.id]);
  assert.deepEqual(s.herdr.closed, ['pane-victim'], 'the same label does not make the other member\'s pane a target');
});

// §5.3: without a session file the label is the only handle left. It is not an identity,
// so every pane carrying another living member's session file is off limits — computed
// from `children/` and `sessions/by-member/` at this moment, even when this process never
// spawned that member and therefore never knew its pane id.
test("pg_terminate falls back to the member's name when no session file exists, sparing another member's pane", async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const victim = await createMember(s.platform, s.me, 'runner');
  writeChildRecord(s.adapterDir, {
    parentId: s.me.id,
    childId: victim.id,
    name: victim.name,
    cwd: null,
    args: [],
    token: victim.token,
    intent: 'spawned',
  });
  const other = await createMember(s.platform, s.me, 'runner-other');
  const otherSession = '/tmp/pigroups-child/other.jsonl';
  writeChildRecord(s.adapterDir, {
    parentId: s.me.id,
    childId: other.id,
    name: other.name,
    cwd: null,
    args: [],
    token: other.token,
    intent: 'spawned',
  });
  writeMemberSessionFile(s.adapterDir, other.id, otherSession);
  s.herdr.paneList.push(
    { pane_id: 'pane-victim', agent_status: 'idle', tab_id: 'wE:t1', title: 'π - runner - /tmp' },
    {
      pane_id: 'pane-other',
      agent_session: { kind: 'path', source: 'herdr:pi', value: otherSession },
      agent_status: 'idle',
      tab_id: 'wE:t2',
      title: 'π - runner - /tmp',
    },
  );
  await s.cycle(); // the loop knows who it is; both children are alive

  const result = await s.loop.terminate(victim.id);

  assert.deepEqual(result.terminated, [victim.id]);
  assert.deepEqual(
    s.herdr.closed,
    ['pane-victim'],
    `only the victim's pane is closed: ${JSON.stringify(s.herdr.closed)}`,
  );
  assert.ok(!s.herdr.closed.includes('pane-other'), `the live other member keeps its pane (${other.id})`);
});

// §5.3: `pane list` is how a pane is found, not a fact the delete depends on. If herdr
// cannot answer (null), nothing can be identified; the committed delete still succeeds
// and reports no close failure.
test('an unreadable pane list does not fail the committed delete', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const child = await s.loop.spawnMember({ name: 'runner', brief: 'implement Y' });
  s.herdr.failListPanes = new Error('herdr: pane list failed');

  const result = await s.loop.terminate(child.id);

  assert.deepEqual(result.terminated, [child.id], 'the delete is a fact even when pane list cannot be read');
  assert.deepEqual(result.pane_close_failed, [], 'a pane that cannot be identified is not a retryable close failure');
  assert.deepEqual(s.herdr.closed, [], 'nothing was actually closed');
});

// §5.3: a grandparent's DELETE is legal and never reaches this adapter, so nothing here
// calls terminate(). The children record has to be reconciled against the platform instead.
test('a child deleted by an ancestor has its pane closed on a later poll', async (t) => {
  const s = await scenario();
  t.after(() => s.close());

  const child = await s.loop.spawnMember({ name: 'runner', brief: 'implement Y' });
  assert.deepEqual(s.herdr.closed, [], 'nothing may be closed while the child is alive');

  await removeMember(s.platform, s.parent!.token, child.id);
  await s.cycle();
  assert.deepEqual(s.herdr.closed, [], 'the pane check is cached, so the next poll is inside the TTL');

  s.clock.advance(31_000);
  await s.cycle();
  assert.deepEqual(s.herdr.closed, ['pane-1'], 'the poll confirms the child is gone and closes its pane');
});
