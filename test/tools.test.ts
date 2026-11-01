// §5.3 tools that reach out: inspect (round trip + timeout) and spawn (member + brief + one pane).

import test from 'node:test';
import assert from 'node:assert/strict';

import { command, delay, dmId, history, member, poll, removeMember, send, whoami, type ControlItem } from './support.ts';
import { driveUntil, pollUntil, scenario, type Scenario } from './scenario.ts';

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
  });

  const answered = await driveUntil(s, pending);
  assert.equal(answered.phase, 'tool_call', 'the result is matched by its request id');
  assert.equal(answered.busy_ms, 1234);
  assert.deepEqual(answered.owed, [s.dm]);
  assert.equal(answered.children, 2);
  assert.equal(answered.tool?.name, 'bash');

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

  const childToken = spawn.env.PIGROUPS_TOKEN;
  assert.ok(childToken, 'the pane must be started with the child token in the env');
  const asChild = await whoami(s.platform, childToken);
  assert.equal(asChild.member.id, child.id, "the pane's token must be the new child's own token");

  const brief = await history(s.platform, s.me.token, dmId(s.me.id, child.id));
  assert.equal(brief.items.length, 1, 'the brief goes out as one DM');
  assert.ok(brief.items[0].body.includes('implement Y'), brief.items[0].body);
  assert.equal(brief.items[0].sender_id, s.me.id, 'the brief comes from the spawning member');
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
  assert.equal(statusAtClose, 'gone', 'the delete must be committed before herdr closes the pane');
  assert.deepEqual(s.herdr.closed, ['pane-1'], 'the pane of the terminated child must be closed');
});

// §5.3: the delete is the fact; closing the pane is cleanup. A herdr that is down must
// not turn a committed delete into a tool error, and must not lose the mapping either.
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
  assert.deepEqual(s.herdr.closed, ['pane-1'], 'the mapping survived the failure, so the retry could close it');
});

// §5.3: a grandparent's DELETE is legal and never reaches this adapter, so nothing here
// calls terminate(). The pane map has to be reconciled against the platform instead.
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
