// Catch each new pane's pi startup banner.
//
// pi draws its "loaded resources" block once, at startup: [Skills], [Prompts],
// [Extensions]. A spawned member's banner is the only place the child itself shows
// what it loaded, and it is erased as soon as the conversation scrolls, so this
// samples the visible screen of every pane that appears after `knownFile` was
// written, every 100 ms, from the moment the pane exists.
//
//   node banner-watch.mjs <outDir> <knownPanesFile> <stopFile>
//
// One directory per pane under <outDir>/banner/, one file per distinct screen.
// Exits when <stopFile> exists or after BANNER_WATCH_MS (default 15 min).
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, knownFile, stopFile] = process.argv.slice(2);
const POLL_MS = 100;
const PER_PANE_MS = Number(process.env.BANNER_PER_PANE_MS ?? 90_000);
const TOTAL_MS = Number(process.env.BANNER_WATCH_MS ?? 900_000);

function log(line) {
  appendFileSync(join(outDir, 'banner-watch.log'), `${new Date().toISOString()} ${line}\n`);
}
function herdr(args) {
  return new Promise((resolve) => {
    execFile('herdr', args, { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}
function paneIds(stdout) {
  try {
    const parsed = JSON.parse(stdout.trim().split('\n').pop());
    return (parsed?.result?.panes ?? []).map((pane) => pane.pane_id);
  } catch {
    return [];
  }
}
function knownPanes() {
  try {
    return new Set(readFileSync(knownFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

const watched = new Map();
const started = Date.now();
let stop = false;
log(`watching: known panes ${[...knownPanes()].join(' ')}`);

while (!stop) {
  if (existsSync(stopFile)) stop = true;
  if (Date.now() - started > TOTAL_MS) stop = true;

  const ids = paneIds(await herdr(['pane', 'list']));
  for (const pane of ids) {
    if (knownPanes().has(pane)) continue;
    let state = watched.get(pane);
    if (!state) {
      const dir = join(outDir, 'banner', pane.replace(/[^A-Za-z0-9_.-]/g, '_'));
      mkdirSync(dir, { recursive: true });
      state = { dir, seq: 0, last: '', at: Date.now(), bannerSeq: 0 };
      watched.set(pane, state);
      log(`new pane ${pane} -> ${dir}`);
    }
    if (state.bannerSeq) continue;
    if (Date.now() - state.at > PER_PANE_MS) continue;
    const screen = (await herdr(['pane', 'read', pane, '--source', 'visible', '--lines', '60'])).trim();
    if (screen.length === 0 || screen === state.last) continue;
    state.last = screen;
    state.seq += 1;
    writeFileSync(join(state.dir, `${String(state.seq).padStart(3, '0')}.txt`), screen + '\n');
    if (screen.includes('[Extensions]')) {
      state.bannerSeq = state.seq;
      log(`banner caught for ${pane} in capture ${state.seq}`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

const summary = [];
for (const [pane, state] of watched) {
  summary.push(`pane=${pane} captures=${state.seq} bannerCapture=${state.bannerSeq || 'MISSED'} dir=${state.dir}`);
}
writeFileSync(join(outDir, 'banner', 'summary.txt'), summary.join('\n') + '\n');
log('stopped');
