// 设计说明 §12.1: one directory per plugin under the Pi profile, with the old
// `~/.pigroups-adapter` layout read once when the new one has never been created.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAdapterDir } from '../src/datadir.ts';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test('PIGROUPS_ADAPTER_DIR wins and expands a leading ~', async (t) => {
  const home = await tempDir('pigroups-home-');
  t.after(() => rm(home, { recursive: true, force: true }));

  const warnings: string[] = [];
  const dir = resolveAdapterDir({
    home,
    env: { PIGROUPS_ADAPTER_DIR: '~/profiles/work' },
    warn: (message) => warnings.push(message),
  });

  assert.equal(dir, join(home, 'profiles', 'work'));
  assert.deepEqual(warnings, [], 'an explicit directory never falls back to the old layout');
});

test('PI_CODING_AGENT_DIR puts pigroups beside that profile', async (t) => {
  const home = await tempDir('pigroups-home-');
  t.after(() => rm(home, { recursive: true, force: true }));

  const warnings: string[] = [];
  const dir = resolveAdapterDir({
    home,
    env: { PI_CODING_AGENT_DIR: '~/custom-agent' },
    warn: (message) => warnings.push(message),
  });

  assert.equal(dir, join(home, 'custom-agent', 'pigroups'));
  assert.deepEqual(warnings, []);
});

test('the default is ~/.pi/pigroups, not ~/.pigroups-adapter', async (t) => {
  const home = await tempDir('pigroups-home-');
  t.after(() => rm(home, { recursive: true, force: true }));

  const warnings: string[] = [];
  const dir = resolveAdapterDir({ home, env: {}, warn: (message) => warnings.push(message) });

  assert.equal(dir, join(home, '.pi', 'pigroups'));
  assert.deepEqual(warnings, []);
});

test('an old ~/.pigroups-adapter with content is used and asks the person to migrate', async (t) => {
  const home = await tempDir('pigroups-home-');
  const oldDir = join(home, '.pigroups-adapter');
  await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, 'owed.json'), '{}');
  t.after(() => rm(home, { recursive: true, force: true }));

  const warnings: string[] = [];
  const dir = resolveAdapterDir({ home, env: {}, warn: (message) => warnings.push(message) });

  assert.equal(dir, oldDir, 'the old path is read, not silently abandoned');
  assert.equal(warnings.length, 1, 'exactly one warning');
  assert.match(warnings[0]!, /legacy|old/i, 'the warning names the old layout');
  assert.match(warnings[0]!, /migrat|move/i, 'it asks a person to migrate; the adapter does not move it');
});

test('an explicit PIGROUPS_ADAPTER_DIR never falls back to the old layout', async (t) => {
  const home = await tempDir('pigroups-home-');
  const oldDir = join(home, '.pigroups-adapter');
  const explicit = join(home, 'profiles', 'work');
  await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, 'owed.json'), '{}');
  t.after(() => rm(home, { recursive: true, force: true }));

  const warnings: string[] = [];
  const dir = resolveAdapterDir({
    home,
    env: { PIGROUPS_ADAPTER_DIR: explicit },
    warn: (message) => warnings.push(message),
  });

  assert.equal(dir, explicit, 'the explicit directory is the answer even when it does not exist yet');
  assert.deepEqual(warnings, [], 'a different profile must not be swallowed by the legacy directory');
});

test('a custom PI_CODING_AGENT_DIR never falls back to the old layout', async (t) => {
  const home = await tempDir('pigroups-home-');
  const oldDir = join(home, '.pigroups-adapter');
  await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, 'owed.json'), '{}');
  t.after(() => rm(home, { recursive: true, force: true }));

  const warnings: string[] = [];
  const dir = resolveAdapterDir({
    home,
    env: { PI_CODING_AGENT_DIR: '~/custom-agent' },
    warn: (message) => warnings.push(message),
  });

  assert.equal(dir, join(home, 'custom-agent', 'pigroups'));
  assert.deepEqual(warnings, [], 'a custom profile is explicit, so the old layout is not a fallback');
});

test('an explicit agentDir test seam is also explicit and never falls back', async (t) => {
  const home = await tempDir('pigroups-home-');
  const oldDir = join(home, '.pigroups-adapter');
  await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, 'owed.json'), '{}');
  t.after(() => rm(home, { recursive: true, force: true }));

  const warnings: string[] = [];
  const dir = resolveAdapterDir({
    home,
    env: {},
    agentDir: join(home, 'other-profile'),
    warn: (message) => warnings.push(message),
  });

  assert.equal(dir, join(home, 'other-profile', 'pigroups'));
  assert.deepEqual(warnings, []);
});
