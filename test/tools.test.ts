// §5.3 tools that reach out: inspect (round trip + timeout) and spawn (member + brief + one pane).

import test from 'node:test';
import assert from 'node:assert/strict';

import { command, dmId, history, member, whoami } from './support.ts';
import { driveUntil, pollUntil, scenario } from './scenario.ts';

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
  assert.ok(spawn.label.includes('runner'), `the pane label must name the child: ${spawn.label}`);

  const childToken = spawn.env.PIGROUPS_TOKEN;
  assert.ok(childToken, 'the pane must be started with the child token in the env');
  const asChild = await whoami(s.platform, childToken);
  assert.equal(asChild.member.id, child.id, "the pane's token must be the new child's own token");

  const brief = await history(s.platform, s.me.token, dmId(s.me.id, child.id));
  assert.equal(brief.items.length, 1, 'the brief goes out as one DM');
  assert.ok(brief.items[0].body.includes('implement Y'), brief.items[0].body);
  assert.equal(brief.items[0].sender_id, s.me.id, 'the brief comes from the spawning member');
});
