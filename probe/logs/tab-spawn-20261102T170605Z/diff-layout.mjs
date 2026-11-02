// Baseline-vs-final pane and tab diff, printed by the driver's cleanup so the run ends
// with a plain statement of what it left behind.
import { readFileSync } from 'node:fs';
const [, , panesBaseFile, panesFinalFile, tabsBaseFile, tabsFinalFile] = process.argv;
const read = (f, key) => JSON.parse(readFileSync(f, 'utf8')).result[key];
const pBefore = read(panesBaseFile, 'panes');
const pAfter = read(panesFinalFile, 'panes');
const tBefore = read(tabsBaseFile, 'tabs');
const tAfter = read(tabsFinalFile, 'tabs');
const ids = (xs, k) => xs.map((x) => x[k]);
const added = (b, a) => ids(a, 'pane_id').filter((x) => !ids(b, 'pane_id').includes(x));
const gone = (b, a) => ids(b, 'pane_id').filter((x) => !ids(a, 'pane_id').includes(x));
const tAdded = ids(tAfter, 'tab_id').filter((x) => !ids(tBefore, 'tab_id').includes(x));
const tGone = ids(tBefore, 'tab_id').filter((x) => !ids(tAfter, 'tab_id').includes(x));
console.log(`panes baseline=${pBefore.length} final=${pAfter.length} added=[${added(pBefore, pAfter).join(' ')}] missing=[${gone(pBefore, pAfter).join(' ')}]`);
console.log(`tabs  baseline=${tBefore.length} final=${tAfter.length} added=[${tAdded.join(' ')}] missing=[${tGone.join(' ')}]`);
