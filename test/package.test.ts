// §3: the adapter is a Pi package. The manifest is the install contract, so these
// checks guard the entry point, the gallery keyword, and the tarball file list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, any>;

test('package.json declares a Pi package whose extension entry and skills exist', () => {
  assert.deepEqual(
    pkg.pi,
    { extensions: ['./src/extension.ts'], skills: ['./skills'] },
    'the manifest points at the extension entry and the two skills',
  );
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('pi-package'), 'the gallery discovery keyword is present');
  assert.ok(
    existsSync(new URL(pkg.pi.extensions[0], new URL('../package.json', import.meta.url))),
    'the declared extension path exists in this package',
  );
  for (const name of ['pigroups-org', 'pigroups-message']) {
    assert.ok(
      existsSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url)),
      `the skill directory ${name} ships a SKILL.md`,
    );
  }
});

test('the package stays private and ships only what a user needs', () => {
  assert.equal(pkg.private, true, 'nothing is published to a registry this round');
  assert.equal(typeof pkg.description, 'string');
  assert.ok(pkg.description.length > 0);
  assert.equal(typeof pkg.license, 'string', 'a package records its license');
  assert.equal(pkg.repository.type, 'git', 'a package records where it comes from');
  assert.equal(typeof pkg.repository.url, 'string');
  assert.deepEqual(
    [...pkg.files].sort(),
    ['CHANGELOG.md', 'README.md', 'docs', 'skills', 'src'].sort(),
    'the skills ship with the package; probe/, test/ and lockfiles do not',
  );
});
