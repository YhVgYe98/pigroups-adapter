// Compare two `herdr pane list` answers: print the pane ids present in the second
// but not the first, minus any pane id named on the command line.
//
//   node panes.mjs <before.json> <after.json> [exclude…]
//
// Used to find the pane a `pg_spawn` created: the adapter never tells the caller a
// pane id, so the new pane is identified by diffing.
import { readFileSync } from 'node:fs';

function ids(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const panes = parsed?.result?.panes;
  if (!Array.isArray(panes)) throw new Error(`${file}: no result.panes`);
  return panes.map((pane) => pane.pane_id);
}

const [before, after, ...exclude] = process.argv.slice(2);
const seen = new Set(ids(before));
const skip = new Set(exclude);
const fresh = ids(after).filter((id) => !seen.has(id) && !skip.has(id));
console.log(fresh.join('\n'));
