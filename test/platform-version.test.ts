// The adapter and platform are released as a pair. There is no compatibility range:
// a different platform release is the wrong layer, not a warning. These tests pin the
// exact check at the whoami boundary and the pure matcher.

import test from 'node:test';
import assert from 'node:assert/strict';

import { platformCandidates } from '../src/org.ts';
import { EXPECTED_PLATFORM_VERSION, platformVersionError, platformVersionMatches } from '../src/version.ts';
import { scenario } from './scenario.ts';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the platform version matcher is exact', () => {
  assert.equal(platformVersionMatches(EXPECTED_PLATFORM_VERSION), true);
  assert.equal(platformVersionMatches(` ${EXPECTED_PLATFORM_VERSION} `), true);
  assert.equal(platformVersionMatches('0.7.0'), false, 'an older patch is a different layer');
  assert.equal(platformVersionMatches('0.7.2'), false, 'a newer patch is not assumed compatible');
  assert.equal(platformVersionMatches('0.8.0'), false);
  assert.equal(platformVersionMatches('v0.7.1'), false, 'the platform reports a bare x.y.z');
  assert.match(platformVersionError('0.7.0'), /0\.7\.1/);
  assert.match(platformVersionError('0.7.0'), /no cross-version support/);
});

test('a whoami from another platform release stops before ready or delivery', async (t) => {
  const s = await scenario();
  t.after(() => s.close());
  const realWhoami = s.pg.whoami.bind(s.pg);
  s.pg.whoami = async () => ({ ...(await realWhoami()), server: { version: '0.7.0' } });

  await assert.rejects(
    s.loop.pollOnce(),
    (err: Error) => {
      assert.match(err.message, /platform version 0\.7\.0/);
      assert.match(err.message, /0\.7\.1/);
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
