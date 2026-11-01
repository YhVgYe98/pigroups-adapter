// §3: the adapter is a Pi package. The manifest is the install contract, so these
// checks guard the entry point, the gallery keyword, and the tarball file list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, any>;

test('package.json declares a Pi package whose extension entry exists', () => {
  assert.deepEqual(pkg.pi, { extensions: ['./src/extension.ts'] }, 'the manifest points at the extension entry');
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('pi-package'), 'the gallery discovery keyword is present');
  assert.ok(
    existsSync(new URL(pkg.pi.extensions[0], new URL('../package.json', import.meta.url))),
    'the declared extension path exists in this package',
  );
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
    ['CHANGELOG.md', 'README.md', 'docs', 'src'].sort(),
    'probe/, test/ and lockfiles are not part of the installed package',
  );
});
