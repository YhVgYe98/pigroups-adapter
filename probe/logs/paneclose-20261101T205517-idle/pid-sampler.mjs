// Samples /proc/<pid> for the child's pi process, independent of herdr.
//
//   node pid-sampler.mjs <pid> <samples.tsv> <stop-file>
//
// Writes one TSV line per state change: epoch_ms, iso_utc, state (running|gone),
// /proc/<pid>/stat state letter when readable.
import { existsSync, readFileSync, appendFileSync } from 'node:fs';

const [pid, samplesPath, stopPath] = process.argv.slice(2);
if (!pid || !samplesPath || !stopPath) {
  console.error('usage: pid-sampler.mjs <pid> <samples.tsv> <stop-file>');
  process.exit(2);
}

const iso = (ms) => new Date(ms).toISOString();
let last = '';

for (;;) {
  const ms = Date.now();
  const alive = existsSync(`/proc/${pid}`);
  let state = '';
  if (alive) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      state = stat.slice(close + 2, close + 3);
    } catch {
      state = '?';
    }
  }
  const label = alive ? `running` : 'gone';
  if (label !== last) {
    appendFileSync(samplesPath, `${ms}\t${iso(ms)}\t${label}\t${state}\n`);
    last = label;
  }
  if (!alive) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
