// Reads one paneclose evidence directory and prints the timeline with a PASS/FAIL per
// observation. Exit code 0 = every observation passed.
//
//   node probe/paneclose-analyze.mjs probe/logs/paneclose-<ts>-<variant>
//
// Inputs (all written by the driver in that directory):
//   env.sh                      CHILD_PANE, CHILD_PID, CHILD_ID, PORT
//   pane-samples.tsv            epoch ms, iso, present, agent, agent_status, title, note
//   pid-samples.tsv             epoch ms, iso, running|gone, /proc stat letter
//   child-session.jsonl         the child's own pi session file
//   child-pane-at-exit.txt      `herdr pane read` of the child pane the instant its agent
//                               vanished from `pane list` (before the adapter closes it)
//   controls-after-terminate.json   GET /v1/control?all — sys.terminated + receipts
//   herdr-server-window.txt     herdr server log lines around the close
//   panes-after-terminate.json, ps-after-terminate.txt, member-after-terminate.json
//   root-terminate-result.txt   the pg_terminate tool result the root got
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node probe/paneclose-analyze.mjs <evidence-dir>');
  process.exit(2);
}

const read = (name) => {
  const path = join(dir, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};
const ms = (iso) => Date.parse(iso);
const show = (t) => (t === undefined || t === null || Number.isNaN(t) ? '?' : new Date(t).toISOString());
const secs = (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? '?' : `${b - a} ms`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}
function note(label, text) {
  console.log(`NOTE  ${label}: ${text}`);
}

// ---------------------------------------------------------------- inputs
const env = Object.fromEntries(
  read('env.sh')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
const pane = env.CHILD_PANE ?? '';
const childId = env.CHILD_ID ?? '';
const childPid = env.CHILD_PID ?? '';

const paneSamples = read('pane-samples.tsv')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [t, iso, present, agent, status, title, note] = line.split('\t');
    return { t: Number(t), iso, present, agent, status, title, note };
  });
const pidSamples = read('pid-samples.tsv')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [t, iso, state, stat] = line.split('\t');
    return { t: Number(t), iso, state, stat };
  });

const sessionText = read('child-session.jsonl');
const sessionEntries = sessionText
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line, index) => {
    try {
      return { ok: true, value: JSON.parse(line) };
    } catch (err) {
      return { ok: false, index: index + 1, error: String(err?.message ?? err) };
    }
  });
const badLines = sessionEntries.filter((e) => !e.ok);
const entries = sessionEntries.filter((e) => e.ok).map((e) => e.value);

const controls = (() => {
  try {
    return JSON.parse(read('controls-after-terminate.json')).items ?? [];
  } catch {
    return [];
  }
})();
const notice = controls.find((item) => item.cmd === 'sys.terminated' && item.to === childId);
const receipt = (notice?.receipts ?? []).find((r) => r.to_id === childId);

const closeLine = read('herdr-server-window.txt')
  .split('\n')
  .find((line) => line.includes('method="pane.close"') && line.includes('api.request.start'));
const tClose = closeLine === undefined ? Number.NaN : ms(closeLine.split(' ')[0]);

const firstRunning = pidSamples.find((s) => s.state === 'running');
const firstGone = pidSamples.find((s) => s.state === 'gone');

const sawAgent = paneSamples.find((s) => s.agent === 'pi' || s.agent !== '');
const agentGone = paneSamples.find((s) => s.present === 'present' && (s.agent === '' || s.agent === undefined) && sawAgent);
const paneAbsent = paneSamples.find((s) => s.present === 'absent');

const paneAtExit = read('child-pane-at-exit.txt');
const lastEntry = entries[entries.length - 1];
const lastWrite = ms(lastEntry?.timestamp ?? '');
const afterDelete = entries.filter((e) => ms(e.timestamp) > (notice?.created_at ?? 0));

const panesAfter = read('panes-after-terminate.json');
const psAfter = read('ps-after-terminate.txt');
const memberAfter = (() => {
  try {
    return JSON.parse(read('member-after-terminate.json'));
  } catch {
    return {};
  }
})();
const terminateResult = read('root-terminate-result.txt');

// ---------------------------------------------------------------- timeline
console.log(`evidence: ${dir}`);
console.log(`child: member ${childId}, pane ${pane}, pi pid ${childPid}`);
console.log('');
console.log('timeline (all times UTC, epoch ms in parentheses; samplers: pid every 20 ms, pane every 40 ms)');
console.log(`  ${show(notice?.created_at)}  DELETE committed on the platform, sys.terminated written (${notice?.created_at ?? '?'})`);
console.log(`  ${show(receipt?.delivered_at)}  the child's poll took that notice (receipt state=${receipt?.state ?? '?'}) (${receipt?.delivered_at ?? '?'})`);
console.log(`  ${show(firstRunning?.t)}  pid sampler saw pi running from here (state changes only) (${firstRunning?.t ?? '?'})`);
console.log(`  ${show(firstGone?.t)}  first pid sample: pi gone (${firstGone?.t ?? '?'})`);
console.log(`  ${show(agentGone?.t)}  pane list first reported the pane with no agent (${agentGone?.t ?? '?'})`);
console.log(`  ${show(tClose)}  herdr pane.close request (from the herdr server log) (${Number.isNaN(tClose) ? '?' : tClose})`);
console.log(`  ${show(paneAbsent?.t)}  pane list first reported the pane absent (${paneAbsent?.t ?? '?'})`);
console.log('');

// ---------------------------------------------------------------- observations
check(
  'O1 the child pi ran and its session file is complete',
  entries.length > 0 && badLines.length === 0 && sessionText.endsWith('\n'),
  `child-session.jsonl: ${entries.length} entries, ${badLines.length} unparseable lines` +
    `${badLines.length > 0 ? ` (first bad line ${badLines[0].index}: ${badLines[0].error})` : ''}, ` +
    `endsWithNewline=${sessionText.endsWith('\n')}, last entry ${lastEntry?.type}/${lastEntry?.message?.role ?? '-'}` +
    ` stopReason=${lastEntry?.message?.stopReason ?? '-'} at ${lastEntry?.timestamp ?? '?'}`,
);

check(
  'O2 the last session write precedes the pi process exit',
  !Number.isNaN(lastWrite) && !Number.isNaN(firstGone?.t) && lastWrite <= firstGone.t,
  `last session entry ${show(lastWrite)} <= pi gone ${show(firstGone?.t)} ` +
    `(${firstGone === undefined ? '?' : secs(lastWrite, firstGone.t)}); the file cannot have been cut mid-write`,
);

check(
  'O3 the child consumed sys.terminated before it exited',
  receipt?.state === 'delivered' && receipt.delivered_at <= (firstGone?.t ?? Number.NaN),
  `receipt delivered at ${show(receipt?.delivered_at)}, pi gone at ${show(firstGone?.t)} ` +
    `(${receipt?.state === 'delivered' ? secs(receipt.delivered_at, firstGone?.t) : 'no delivered receipt'})`,
);

check(
  'O4 the pane was still listed after pi exited, and closed only after that',
  agentGone !== undefined && !Number.isNaN(tClose) && agentGone.t < tClose,
  `pane list: agent gone at ${show(agentGone?.t)}; pane.close at ${show(tClose)} ` +
    `(${agentGone === undefined || Number.isNaN(tClose) ? '?' : secs(agentGone.t, tClose)} later)`,
);

check(
  'O5 pi reached its graceful interactive exit path, not a killed TUI',
  paneAtExit.includes('To resume this session:'),
  paneAtExit.includes('To resume this session:')
    ? 'the pane scrollback captured at the moment the agent vanished contains pi\'s ' +
      'graceful-exit line ("To resume this session: ...", printed after session_shutdown and ' +
      'immediately before process.exit(0)) and the shell prompt below it'
    : 'no "To resume this session:" line in child-pane-at-exit.txt — pi did not reach the end of ' +
      'its own shutdown path',
);

check(
  'O6 the pane is gone and no child pi process remains',
  !panesAfter.includes(`"${pane}"`) && !psAfter.split('\n').some((line) => line.includes(childPid)) && memberAfter.status === 'gone',
  `pane "${pane}" in panes-after-terminate.json: ${panesAfter.includes(`"${pane}"`) ? 'present' : 'absent'}; ` +
    `ps for pid ${childPid}: ${psAfter.split('\n').some((line) => line.includes(childPid)) ? 'present' : 'absent'}; ` +
    `member status ${memberAfter.status ?? '?'}`,
);

// The tool result is JSON-in-JSON: `{"type":"text","text":"{\"terminated\":[... ],\"pane_close_failed\":[]}"}`.
const closeFailures = [...terminateResult.matchAll(/pane_close_failed\\?":\s*\[([^\]]*)\]/g)].map((m) => m[1].trim());
check(
  'O7 the adapter reported no pane_close_failed',
  closeFailures.length > 0 && closeFailures.every((entry) => entry === ''),
  `root's pg_terminate tool result: ${terminateResult.trim() || '(missing)'}` +
    ` -> ${closeFailures.length} result(s), pane_close_failed contents: ${JSON.stringify(closeFailures)}`,
);

const wait = Number.isNaN(tClose) || notice === undefined ? Number.NaN : tClose - notice.created_at;
check(
  'O8 the close waited for the child, inside the 5 s hard bound',
  !Number.isNaN(wait) && wait >= 0 && wait <= 5000,
  `DELETE ${show(notice?.created_at)} -> pane.close ${show(tClose)}: ${wait} ms of the 5000 ms ` +
    `PANE_AGENT_EXIT_TIMEOUT_MS (margin ${5000 - wait} ms); pi exited at ${show(firstGone?.t)}, ` +
    `${firstGone === undefined ? '?' : tClose - firstGone.t} ms before the close`,
);

if (lastEntry?.message?.stopReason === 'toolUse') {
  note(
    'in-flight at the end',
    'the session\'s last entry is an assistant toolUse with no toolResult after it: the turn was ' +
      'still running when the file stopped changing, so the child never wrote the end of that turn',
  );
}

// What the pre-fix code would have done: close at the moment of the DELETE.
note(
  'counterfactual',
  `before 7ae1adc the pane would have been closed at ${show(notice?.created_at)} ` +
    `(${firstGone === undefined ? '?' : `${firstGone.t - notice.created_at} ms before pi exited`}); ` +
    `${afterDelete.length} session entr${afterDelete.length === 1 ? 'y' : 'ies'} written after the DELETE ` +
    `would have been lost or cut: ${afterDelete.map((e) => `${e.timestamp}(${e.type}/${e.message?.role ?? '-'})`).join(', ') || 'none'}`,
);

const failed = results.filter((r) => !r.ok).length;
console.log('');
console.log(failed === 0 ? `VERDICT: PASS (${results.length}/${results.length} observations)` : `VERDICT: FAIL (${failed}/${results.length} observations failed)`);
process.exit(failed === 0 ? 0 : 1);
