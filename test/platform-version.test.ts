// The adapter and platform are released as a pair. There is no compatibility range:
// a different platform release is the wrong layer, not a warning. These tests pin the
// exact check at the whoami boundary and the pure matcher.

import test from 'node:test';
import assert from 'node:assert/strict';

import { platformCandidates } from '../src/org.ts';
import { SUPPORTED_PLATFORM_RANGE, platformVersionError, platformVersionMatches } from '../src/version.ts';
import { scenario } from './scenario.ts';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the platform matcher accepts the supported minor line and nothing else', () => {
  assert.equal(SUPPORTED_PLATFORM_RANGE, '^0.7.0');
  assert.equal(platformVersionMatches('0.7.0'), true);
  assert.equal(platformVersionMatches('0.7.2'), true);
  assert.equal(platformVersionMatches('0.7.9'), true, 'a later patch on the same line is the same contract');
  assert.equal(platformVersionMatches(' 0.7.3 '), true, 'health reports a bare x.y.z, tolerating padding');
  assert.equal(platformVersionMatches('0.8.0'), false, 'a new minor changes the wire contract');
  assert.equal(platformVersionMatches('1.0.0'), false);
  assert.equal(platformVersionMatches('0.6.9'), false);
  assert.equal(platformVersionMatches('v0.7.2'), false, 'the platform reports a bare x.y.z');
  assert.equal(platformVersionMatches('0.7'), false);
  assert.match(platformVersionError('0.8.0'), /0\.8\.0/);
  assert.match(platformVersionError('0.8.0'), /outside the range/);
});

test('a whoami from another platform line stops before ready or delivery', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  const realWhoami = s.pg.whoami.bind(s.pg);
  s.pg.whoami = async () => ({ ...(await realWhoami()), server: { version: '0.8.0' } });

  await assert.rejects(
    s.loop.pollOnce(),
    (err: Error) => {
      assert.match(err.message, /platform version 0\.8\.0/);
      assert.match(err.message, /outside the range/);
      return true;
    },
  );
  assert.deepEqual(s.loop.state().owed, [], 'no identity or obligations were accepted from the wrong platform');
});

test('an npm-installed platform package is a lookup candidate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pigroups-lookup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, 'node_modules', 'pigroups');
  await mkdir(join(installed, 'src'), { recursive: true });
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'pigroups', version: '0.7.1' }));
  await writeFile(join(installed, 'src', 'main.ts'), '');
  const candidates = platformCandidates({ adapterRoot: root });
  assert.ok(candidates.some((candidate) => candidate.source === 'node_modules/pigroups'));
});
