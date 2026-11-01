// Samples `herdr pane list` for one pane and records every observation.
//
//   node pane-sampler.mjs <pane-id> <samples.tsv> <pane-at-exit.txt> <stop-file>
//
// Every sample is one TSV line: epoch_ms, iso_utc, present, agent, agent_status,
// terminal_title, note. On the first sample that shows the pane present but its agent
// gone (no `agent` key, or agent_status "unknown"), it immediately reads the pane's
// scrollback into <pane-at-exit.txt> — that window is the only chance to see pi's
// graceful-exit output before the adapter closes the pane.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const [pane, samplesPath, readPath, stopPath] = process.argv.slice(2);
if (!pane || !samplesPath || !readPath || !stopPath) {
  console.error('usage: pane-sampler.mjs <pane> <samples.tsv> <pane-at-exit.txt> <stop-file>');
  process.exit(2);
}

const iso = (ms) => new Date(ms).toISOString();
let dumped = false;
let sawRunning = false;

function sample() {
  return execFileSync('herdr', ['pane', 'list'], { encoding: 'utf8', timeout: 5000 });
}

for (;;) {
  const ms = Date.now();
  let present = 'error';
  let agent = '';
  let status = '';
  let title = '';
  let note = '';
  try {
    const env = JSON.parse(sample());
    const panes = env?.result?.panes ?? [];
    const entry = panes.find((item) => item.pane_id === pane);
    if (entry === undefined) {
      present = 'absent';
    } else {
      present = 'present';
      agent = entry.agent ?? '';
      status = entry.agent_status ?? '';
      title = entry.terminal_title_stripped ?? '';
    }
  } catch (err) {
    note = String(err?.message ?? err).replace(/[\t\n]/g, ' ').slice(0, 120);
  }

  const running = present === 'present' && agent !== '' && status !== 'unknown';
  if (running) sawRunning = true;

  if (present === 'present' && !running && !dumped && sawRunning) {
    dumped = true;
    note = note === '' ? 'agent-gone-first-seen' : `${note}; agent-gone-first-seen`;
    try {
      const text = execFileSync(
        'herdr',
        ['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', '80'],
        { encoding: 'utf8', timeout: 5000 },
      );
      writeFileSync(readPath, `# herdr pane read ${pane} at ${iso(Date.now())} (${Date.now()} ms)\n${text}`);
    } catch (err) {
      writeFileSync(readPath, `# pane read failed at ${iso(Date.now())}: ${String(err?.message ?? err)}\n`);
    }
  }

  appendFileSync(samplesPath, `${ms}\t${iso(ms)}\t${present}\t${agent}\t${status}\t${title}\t${note}\n`);

  if (present === 'absent') break;
  if (existsSync(stopPath)) break;
  await new Promise((resolve) => setTimeout(resolve, 40));
}
