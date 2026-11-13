// The manifest is the installation contract: it must describe a public Pi package
// whose tarball contains the extension, skills, and only user-facing documentation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as ts from 'typescript';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, any>;

test('package.json declares the Pi package and its entry points', () => {
  assert.deepEqual(
    pkg.pi,
    { extensions: ['./src/extension.ts'], skills: ['./skills'] },
    'the manifest points at the extension entry and the two skills',
  );
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('pi-package'), 'the gallery keyword is present');
  assert.ok(existsSync(new URL(pkg.pi.extensions[0], new URL('../package.json', import.meta.url))));
  for (const name of ['pigroups-org', 'pigroups-message']) {
    const skill = new URL(`../skills/${name}/SKILL.md`, import.meta.url);
    assert.ok(existsSync(skill), `${name} ships a SKILL.md`);
    assert.doesNotMatch(readFileSync(skill, 'utf8'), /[\u4e00-\u9fff]/, `${name} must be in English`);
  }
});

test('the package is public, licensed, and accepts a platform line rather than a patch', () => {
  assert.equal(pkg.private, false, 'a published package is not private');
  assert.equal(pkg.license, 'MIT');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'npm strips build metadata; package versions must be plain');
  assert.match(pkg.dependencies.pigroups, /^\^0\.7\./, 'the platform dependency is a line range, so a platform patch never forces an adapter release');
  assert.equal(pkg.repository.type, 'git');
  assert.match(pkg.repository.url, /^git\+https:/);
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.match(changelog, /^## 0\.19\.0 - \d{4}-\d{2}-\d{2}/m, 'the latest changelog entry matches package.json');
});

test('the tarball list contains only user-facing files', () => {
  assert.deepEqual(
    [...pkg.files].sort(),
    ['src', 'skills', 'README.md', 'CHANGELOG.md', 'LICENSE', 'docs/设计说明.md', 'docs/概念稿.md'].sort(),
  );
  assert.equal(pkg.files.some((file: string) => file.includes('handoff')), false);
});

test('model-facing source strings contain no CJK text', () => {
  for (const file of ['../src/extension.ts', '../src/loop.ts']) {
    const path = new URL(file, import.meta.url);
    const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const chinese: string[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (/[\u4e00-\u9fff]/.test(node.text)) chinese.push(node.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    assert.deepEqual(chinese, [], `${file} has non-English string literals`);
  }
});
