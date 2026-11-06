// 设计说明 §12.3: the child side records who it is, and the parent records whom it
// must be able to reopen. Both are credentials, so permissions are part of the contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { scenario } from './scenario.ts';
import { readSessionRecord, writeSessionRecords } from '../src/records.ts';
import { whoami } from './support.ts';

function hash(file: string): string {
  return createHash('sha1').update(file).digest('hex');
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('an identity start writes both session records, 0600, keyed by sha1(sessionFile)', async (t) => {
  const sessionFile = '/tmp/pigroups-session-records/session.jsonl';
  const s = await scenario({ sessionFile });
  t.after(() => s.close());

  await s.loop.pollOnce();

  const sessionPath = join(s.adapterDir, 'sessions', `${hash(sessionFile)}.json`);
  const byMemberPath = join(s.adapterDir, 'sessions', 'by-member', `${s.me.id}.json`);
  assert.ok(existsSync(sessionPath), 'sessions/<sha1(sessionFile)>.json exists');
  assert.ok(existsSync(byMemberPath), 'sessions/by-member/<memberId>.json exists');

  assert.deepEqual(readJson(sessionPath), {
    memberId: s.me.id,
    orgUrl: s.platform.url,
    token: s.me.token,
    parentId: s.parent!.id,
    sessionFile,
  });
  assert.deepEqual(readJson(byMemberPath), { sessionFile });

  assert.equal(statSync(sessionPath).mode & 0o777, 0o600, 'the token makes this file owner-only');
  assert.equal(statSync(byMemberPath).mode & 0o777, 0o600, 'the by-member index is owner-only too');
  assert.equal(statSync(join(s.adapterDir, 'sessions')).mode & 0o777, 0o700, 'the directory is 0700');
});

test('a session record carries the organisation key so a later start need not guess it', async (t) => {
  const sessionFile = '/tmp/pigroups-session-records/keyed.jsonl';
  const s = await scenario({ sessionFile, orgKey: 'team-a' });
  t.after(() => s.close());

  await s.loop.pollOnce();

  const sessionPath = join(s.adapterDir, 'sessions', `${hash(sessionFile)}.json`);
  assert.deepEqual(readJson(sessionPath), {
    memberId: s.me.id,
    orgUrl: s.platform.url,
    token: s.me.token,
    parentId: s.parent!.id,
    sessionFile,
    orgKey: 'team-a',
  });
});

test('pg_spawn passes the organisation key to the child so its own record is self-locating', async (t) => {
  const s = await scenario({ role: 'root', orgKey: 'team-a' });
  t.after(() => s.close());

  await s.loop.spawnMember({ name: 'keyed-child', brief: 'work' });

  assert.equal(s.herdr.spawns.length, 1);
  assert.equal(s.herdr.spawns[0]!.env.PIGROUPS_ORG_KEY, 'team-a');
});

test('without a sessionFile nothing is written and the skip is warned about', async (t) => {
  const s = await scenario({});
  t.after(() => s.close());

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  await s.loop.pollOnce();

  assert.equal(existsSync(join(s.adapterDir, 'sessions')), false, 'no record is invented without a file path');
  assert.ok(
    warnings.some((warning) => /session|record/i.test(warning)),
    `expected a warning about the skipped record, got ${JSON.stringify(warnings)}`,
  );
});

test('pg_spawn writes the child record and pg_terminate keeps it with intent:terminated', async (t) => {
  const s = await scenario({ role: 'root' });
  t.after(() => s.close());

  const spawned = await s.loop.spawnMember({
    name: 'worker',
    brief: 'do the work',
    cwd: '/tmp/worker-cwd',
    args: ['--model', 'vendor/model'],
  });

  const childPath = join(s.adapterDir, 'children', `${spawned.id}.json`);
  assert.ok(existsSync(childPath), 'children/<memberId>.json is written by the parent');
  const record = readJson(childPath);
  assert.equal(record.childId, spawned.id);
  assert.equal(record.name, 'worker');
  assert.equal(record.cwd, '/tmp/worker-cwd');
  assert.deepEqual(record.args, ['--model', 'vendor/model']);
  assert.equal(record.intent, 'spawned');
  assert.equal(statSync(childPath).mode & 0o777, 0o600, 'the child token makes this file owner-only');
  assert.equal(statSync(join(s.adapterDir, 'children')).mode & 0o777, 0o700, 'children/ is 0700');
  assert.equal((await whoami(s.platform, record.token)).member.id, spawned.id, 'the recorded token is the child identity');

  const result = await s.loop.terminate(spawned.id);
  assert.ok(result.terminated.includes(spawned.id));
  assert.ok(existsSync(childPath), 'the record is kept, not deleted');
  assert.equal(readJson(childPath).intent, 'terminated', 'a terminated child is never auto-restarted');
});

test('a record without parentId reads as unknown, not root', async (t) => {
  const s = await scenario({});
  t.after(() => s.close());
  const sessionFile = '/tmp/pigroups-session-records/unknown-parent.jsonl';

  writeSessionRecords(s.adapterDir, {
    memberId: s.me.id,
    orgUrl: s.platform.url,
    token: s.me.token,
    parentId: undefined,
    sessionFile,
  });
  assert.equal(readSessionRecord(s.adapterDir, sessionFile)?.parentId, undefined, 'absent is unknown');

  writeSessionRecords(s.adapterDir, {
    memberId: s.me.id,
    orgUrl: s.platform.url,
    token: s.me.token,
    parentId: null,
    sessionFile,
  });
  assert.equal(readSessionRecord(s.adapterDir, sessionFile)?.parentId, null, 'null is the root');

  writeSessionRecords(s.adapterDir, {
    memberId: s.me.id,
    orgUrl: s.platform.url,
    token: s.me.token,
    parentId: 'm_parent1',
    sessionFile,
  });
  assert.equal(readSessionRecord(s.adapterDir, sessionFile)?.parentId, 'm_parent1', 'a string is a child');
});
