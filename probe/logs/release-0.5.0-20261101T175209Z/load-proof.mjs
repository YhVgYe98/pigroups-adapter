// Prove the extracted tarball is a loadable package, not just a file list.
//
//   node load-proof.mjs <extracted package dir>
//
// Three checks, each printed, exit 1 on any failure:
//   1. the `pi.extensions` entry named in package.json exists;
//   2. every relative import inside the extracted src/ resolves to a packed file
//      (a missing file would make pi fail at import time, not at install time);
//   3. importing the entry with node's own loader succeeds and exports the
//      extension function pi calls.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = resolve(process.argv[2] ?? '');
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
let failed = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

check(pkg.name === 'pigroups-adapter-pi', 'package name', pkg.name);
check(pkg.version === '0.5.0+platform.0.2.0', 'package version', pkg.version);
const skills = pkg.pi?.skills ?? [];
check(skills.length === 1, 'pi.skills names one directory', JSON.stringify(skills));
const skillDir = join(dir, skills[0] ?? '');
const skillNames = existsSync(skillDir)
  ? readdirSync(skillDir).filter((name) => existsSync(join(skillDir, name, 'SKILL.md'))).sort()
  : [];
check(skillNames.join(',') === 'pigroups-message,pigroups-org', 'both skills shipped with their SKILL.md', skillNames.join(','));

const entries = pkg.pi?.extensions ?? [];
check(entries.length === 1, 'pi.extensions has one entry', JSON.stringify(entries));
const entry = join(dir, entries[0] ?? '');
check(existsSync(entry), 'extension entry exists', entries[0]);

const srcDir = join(dir, 'src');
const files = readdirSync(srcDir).filter((name) => name.endsWith('.ts'));
check(files.length > 0, 'src ships TypeScript modules', files.join(' '));

const specifier = /(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const missing = [];
let relative = 0;
for (const name of files) {
  const text = readFileSync(join(srcDir, name), 'utf8');
  for (const match of text.matchAll(specifier)) {
    relative += 1;
    const target = resolve(dirname(join(srcDir, name)), match[1]);
    if (!existsSync(target)) missing.push(`${name} -> ${match[1]}`);
  }
}
check(missing.length === 0, `${relative} relative imports resolve`, missing.join(', ') || 'all found');

const mod = await import(pathToFileURL(entry).href);
check(typeof mod.default === 'function', 'entry default export is the extension function', typeof mod.default);
check(typeof mod.EXTENSION_ENTRY === 'string', 'EXTENSION_ENTRY names the loaded file', mod.EXTENSION_ENTRY);
check(mod.defaultSpawnCmd?.().startsWith('pi -e '), 'default spawn command loads this extension',
  mod.defaultSpawnCmd?.());

process.exit(failed === 0 ? 0 : 1);
