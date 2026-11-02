// List the platform processes that belong to one data directory.
//
// `pid` in org.json is a hint, not a liveness proof, so the probe counts by the
// process's own cmdline (src/main.ts) and the PIGROUPS_DATA it was started with.
// Prints one line per matching process: "<pid> <cmdline>"; prints nothing when none.
import { readdirSync, readFileSync } from 'node:fs';

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('usage: node platform-instances.mjs <data-dir>');
  process.exit(2);
}

let found = 0;
for (const entry of readdirSync('/proc')) {
  if (!/^\d+$/.test(entry)) continue;
  let argv;
  let env;
  try {
    argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
    env = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0');
  } catch {
    continue;
  }
  const command = argv.join(' ');
  if (!command.includes('src/main.ts')) continue;
  if (!env.includes(`PIGROUPS_DATA=${dataDir}`)) continue;
  found += 1;
  console.log(`${entry} ${command}`);
}
if (found === 0) process.exit(0);
