// 概念稿 §7.1: `pg_members` is the only way a member can find anyone it has not
// already talked to. Relations make the platform's ability boundary visible in the
// data (only a `child` can be aborted), and `last_seen_at` is authentication, not life.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMember, removeMember, whoami } from './support.ts';
import { scenario } from './scenario.ts';

test('pg_members lists the live roster with each member’s relation, parent name and child count', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const sibling = s.siblings[0];

  const otherParent = await createMember(s.platform, s.parent!, 'other');
  const peer = await createMember(s.platform, otherParent, 'peer-of-mine');
  const child = await createMember(s.platform, s.me, 'worker');
  const gone = await createMember(s.platform, s.me, 'gone');
  await removeMember(s.platform, s.me.token, gone.id);

  const roster = await s.loop.members();
  assert.equal(roster.self, s.me.id, 'the answer names the caller');
  assert.equal(roster.total, 6, 'total counts the whole live roster: root, me, sibling, other, its child, my child');
  assert.equal(roster.matched, roster.members.length, 'matched is the number of rows returned');

  const row = (id: string) => {
    const found = roster.members.find((entry) => entry.id === id);
    assert.ok(found, `the roster must contain ${id}: ${JSON.stringify(roster.members)}`);
    return found;
  };
  assert.equal(row(s.me.id).relation, 'self');
  assert.equal(row(s.parent!.id).relation, 'parent');
  assert.equal(row(sibling.id).relation, 'sibling');
  assert.equal(row(child.id).relation, 'child');
  assert.equal(row(otherParent.id).relation, 'sibling', 'another child of my parent is a sibling');
  assert.equal(row(peer.id).relation, 'peer', 'a member of another branch is a peer: reachable, not commandable');
  assert.equal(row(child.id).parent_name, s.me.name, 'the child row carries my name, so the model need not look it up');
  assert.equal(row(sibling.id).parent_name, s.parent!.name);
  assert.equal(row(s.me.id).child_count, 1, 'gone children are not counted');
  assert.equal(row(s.parent!.id).child_count, 3, 'root owns me, the sibling and the other branch head');
  assert.ok(
    !roster.members.some((entry) => entry.id === gone.id),
    'a deleted member is off the roster: the platform already filters to alive members',
  );
});

test('a query filters by name, case-insensitively, and total still tells the model the roster size', async (t) => {
  const s = await scenario({ siblings: 1 });
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'worker');

  const hit = await s.loop.members('WORKER');
  assert.equal(hit.matched, 1, 'a case-insensitive substring over the name');
  assert.equal(hit.members[0].id, child.id);
  assert.equal(hit.total, 4, 'total is unfiltered: root, me, sibling, worker');

  const miss = await s.loop.members('does-not-exist');
  assert.equal(miss.matched, 0);
  assert.equal(miss.total, 4, 'total: 4, matched: 0 reads as a bad query, not an empty organisation');
  assert.deepEqual(miss.members, []);

  const all = await s.loop.members('');
  assert.equal(all.matched, all.total, 'an empty query filters nothing');
});

test('last_seen_at records the last authentication — null before the first one, a number after', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  const child = await createMember(s.platform, s.me, 'worker');

  const before = (await s.loop.members('worker')).members[0];
  assert.equal(before.last_seen_at, null, 'a member that has never authenticated has no last_seen_at');

  await whoami(s.platform, child.token); // one authenticated request is enough

  const after = (await s.loop.members('worker')).members[0];
  assert.equal(typeof after.last_seen_at, 'number', 'authentication stamps last_seen_at');
  assert.ok((after.last_seen_at as number) > 0);
});
