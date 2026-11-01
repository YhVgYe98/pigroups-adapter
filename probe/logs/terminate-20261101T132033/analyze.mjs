// Reads one or more terminate evidence directories and prints the timeline plus a
// PASS/FAIL per observation. Exit code 0 = every observation passed.
//
//   node analyze.mjs case1-idle case2-midturn case3-midtool40
//
// Inputs (all written by driver.sh):
//   env.sh                      CASE_NAME, CHILD_TASK, CHILD_ID, CHILD_PANE, CHILD_PID
//   pane-samples.tsv            epoch ms, iso, present, agent, agent_status, title, note
//   pid-samples.tsv             epoch ms, iso, running|gone, /proc stat letter
//   child-session.jsonl         the child's own pi session file
//   child-pane-at-exit.txt      `herdr pane read` when the agent vanished from pane list
//   controls-after-terminate.json   GET /v1/control?all — sys.terminated + receipts
//   herdr-server-window.txt     herdr server log around the close
//   herdr-pane-lifecycle.txt    every herdr log line for this numeric pane
//   panes-after-terminate.json, ps-after-terminate.txt, member-after-terminate.json
//   root-terminate-result.txt   the pg_terminate tool result the root got
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node analyze.mjs <evidence-dir> [...]');
  process.exit(2);
}

const ms = (value) => (typeof value === 'number' ? value : Date.parse(value));
const show = (t) => (t === undefined || t === null || Number.isNaN(t) ? '?' : new Date(t).toISOString());
const secs = (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? '?' : `${b - a} ms`);
const between = (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? '?' : `${b - a} ms after DELETE`);

function analyse(dir) {
  const read = (name) => {
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  };
  const results = [];
  function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  }
  function note(label, text) {
    console.log(`NOTE  ${label}: ${text}`);
  }

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
  const task = env.CHILD_TASK ?? 'idle';
  const toolSleep = Number(env.CHILD_TOOL_SLEEP ?? 0);
  const paneNum = env.HERDR_PANE_NUM ?? '';

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
  const lastEntry = entries[entries.length - 1];
  const lastWrite = ms(lastEntry?.timestamp ?? '');
  const lastMessage = lastEntry?.message;

  const controls = (() => {
    try {
      return JSON.parse(read('controls-after-terminate.json')).items ?? [];
    } catch {
      return [];
    }
  })();
  const notice = controls.find((item) => item.cmd === 'sys.terminated' && item.to === childId);
  const receipt = (notice?.receipts ?? []).find((r) => r.to_id === childId);
  const tDelete = notice?.created_at ?? Number.NaN;

  const windowLines = read('herdr-server-window.txt').split('\n').filter(Boolean);
  const paneExit = windowLines.find((line) => paneNum !== '' && line.includes(`event="pane.exit"`) && line.includes(`pane_id=${paneNum} `));
  const tPaneExit = paneExit === undefined ? Number.NaN : ms(paneExit.split(' ')[0]);
  const closeRequests = windowLines
    .filter((line) => line.includes('method="pane.close"') && line.includes('api.request.start'))
    .map((line) => ms(line.split(' ')[0]))
    .filter((t) => !Number.isNaN(t));
  const tClose = closeRequests.filter((t) => Number.isNaN(tPaneExit) || t <= tPaneExit).at(-1) ?? Number.NaN;
  const hangupLine = windowLines.find((line) => paneNum !== '' && line.includes(`pane session terminated pane=${paneNum} `) && line.includes('signal=Hangup'));
  const hangup = hangupLine !== undefined;

  const firstRunning = pidSamples.find((s) => s.state === 'running');
  const firstGone = pidSamples.find((s) => s.state === 'gone');
  const sawAgent = paneSamples.find((s) => s.agent === 'pi' || s.agent !== '');
  const agentGone = paneSamples.find((s) => s.present === 'present' && (s.agent === '' || s.agent === undefined) && sawAgent);
  const paneAbsent = paneSamples.find((s) => s.present === 'absent');
  const beforeDelete = [...paneSamples].reverse().find((s) => s.t <= tDelete);

  const paneAtExit = read('child-pane-at-exit.txt');
  const panesAfter = read('panes-after-terminate.json');
  const psAfter = read('ps-after-terminate.txt');
  const memberAfter = (() => {
    try {
      return JSON.parse(read('member-after-terminate.json'));
    } catch {
      return {};
    }
  })();

  const terminateResultRaw = read('root-terminate-result.txt').trim();
  const terminateAnswer = (() => {
    for (const line of terminateResultRaw.split('\n').reverse()) {
      try {
        const content = JSON.parse(line.slice(line.indexOf('[')));
        const text = content.map((part) => part.text ?? '').join('');
        return JSON.parse(text);
      } catch {
        // try the next older result line
      }
    }
    return undefined;
  })();

  const contentOf = (entry) => (Array.isArray(entry?.message?.content) ? entry.message.content : []);
  const calls = entries.flatMap((entry) => contentOf(entry).filter((part) => part.type === 'toolCall').map((call) => ({ at: entry.timestamp, id: call.id, name: call.name, args: call.arguments })));
  const toolResults = entries.filter((entry) => entry.message?.role === 'toolResult');
  const bashCall = calls.find((call) => call.name === 'bash');
  const bashResult = bashCall === undefined ? undefined : toolResults.find((entry) => entry.message?.toolCallId === bashCall.id);
  const bashText = contentOf(bashResult).map((part) => part.text ?? '').join('');
  const bashCut = bashText.includes('Command aborted');

  console.log('');
  console.log(`=== ${env.CASE_NAME ?? dir} (${task}) ===`);
  console.log(`evidence: ${dir}`);
  console.log(`child: member ${childId}, pane ${pane}, pi pid ${childPid}, herdr pane ${paneNum || '?'}`);
  console.log('');
  console.log('timeline (all times UTC, epoch ms in parentheses; pid sampled every 20 ms, pane every 40 ms)');
  console.log(`  ${show(ms(bashCall?.at))}  child's bash toolCall written (${ms(bashCall?.at) ?? '?'})`);
  console.log(`  ${show(tDelete)}  DELETE committed, sys.terminated written (${tDelete})${Number.isNaN(tDelete) ? '' : ` [${beforeDelete?.status ?? '?'} at last pane sample before DELETE]`}`);
  console.log(`  ${show(ms(receipt?.delivered_at))}  child's poll took that notice (state=${receipt?.state ?? '?'}) (${ms(receipt?.delivered_at) ?? '?'})`);
  console.log(`  ${show(ms(bashResult?.timestamp))}  child's bash toolResult written (${ms(bashResult?.timestamp) ?? '?'}) [${between(tDelete, ms(bashResult?.timestamp))}]${bashResult === undefined ? '' : bashCut ? ' — cut, "Command aborted"' : ' — returned without an abort marker'}`);
  console.log(`  ${show(lastWrite)}  last session write (${lastWrite}) [${between(tDelete, lastWrite)}]`);
  console.log(`  ${show(firstGone?.t)}  first pid sample: pi gone (${firstGone?.t ?? '?'}) [${between(tDelete, firstGone?.t)}]`);
  console.log(`  ${show(agentGone?.t)}  pane list first reported the pane with no agent (${agentGone?.t ?? '?'}) [${between(tDelete, agentGone?.t)}]`);
  console.log(`  ${show(tClose)}  herdr pane.close request (${tClose}) [${between(tDelete, tClose)}]`);
  console.log(`  ${show(paneAbsent?.t)}  pane list first reported the pane absent (${paneAbsent?.t ?? '?'}) [${between(tDelete, paneAbsent?.t)}]`);
  console.log(`  ${hangupLine === undefined ? '?' : hangupLine.split(' ')[0]}  herdr logged signal=Hangup for pane ${paneNum || '?'}: ${hangup ? 'yes' : 'no'}`);
  console.log('');

  check(
    'S1 the child session file is complete',
    entries.length > 0 && badLines.length === 0 && sessionText.endsWith('\n'),
    `${entries.length} entries, ${badLines.length} unparseable lines, endsWithNewline=${sessionText.endsWith('\n')}` +
      `${badLines.length > 0 ? ` (first bad line ${badLines[0].index}: ${badLines[0].error})` : ''}`,
  );

  check(
    'S2 the child consumed sys.terminated before it exited',
    receipt?.state === 'delivered' && ms(receipt.delivered_at) <= (firstGone?.t ?? Number.NaN),
    `receipt delivered at ${show(ms(receipt?.delivered_at))}, pi gone at ${show(firstGone?.t)} (${secs(ms(receipt?.delivered_at), firstGone?.t)})`,
  );

  check(
    'S3 the child pi process exited before pane.close',
    !Number.isNaN(firstGone?.t) && !Number.isNaN(tClose) && firstGone.t <= tClose,
    `pi gone at ${show(firstGone?.t)}; pane.close at ${show(tClose)} (${secs(firstGone?.t, tClose)} before the close)`,
  );

  check(
    'S4 pane list reported the agent gone before pane.close',
    agentGone !== undefined && !Number.isNaN(tClose) && agentGone.t <= tClose,
    `pane list: agent gone at ${show(agentGone?.t)}; pane.close at ${show(tClose)} (${secs(agentGone?.t, tClose)} before the close)`,
  );

  check(
    'S5 pi reached its graceful interactive exit path',
    paneAtExit.includes('To resume this session:'),
    paneAtExit.includes('To resume this session:')
      ? 'the scrollback captured when the agent vanished contains pi\'s graceful-exit line'
      : 'no "To resume this session:" line in child-pane-at-exit.txt — pi did not finish its own shutdown path',
  );

  check(
    'S6 pane gone, child pi gone, member gone',
    !panesAfter.includes(`"${pane}"`) && !psAfter.split('\n').some((line) => line.includes(childPid)) && memberAfter.status === 'gone',
    `pane "${pane}": ${panesAfter.includes(`"${pane}"`) ? 'present' : 'absent'}; ps for ${childPid}: ${psAfter.split('\n').some((line) => line.includes(childPid)) ? 'present' : 'absent'}; member status ${memberAfter.status ?? '?'}`,
  );

  check(
    'S7 pg_terminate reported no pane_close_failed',
    terminateAnswer !== undefined && Array.isArray(terminateAnswer.pane_close_failed) && terminateAnswer.pane_close_failed.length === 0,
    `answer: ${terminateResultRaw || '(missing)'} -> pane_close_failed=${JSON.stringify(terminateAnswer?.pane_close_failed ?? 'MISSING')}`,
  );

  check(
    'S8 pg_terminate reported no pane_close_forced',
    terminateAnswer !== undefined && Array.isArray(terminateAnswer.pane_close_forced) && terminateAnswer.pane_close_forced.length === 0,
    `answer: ${terminateResultRaw || '(missing)'} -> pane_close_forced=${JSON.stringify(terminateAnswer?.pane_close_forced ?? 'MISSING')}`,
  );

  const wait = Number.isNaN(tClose) || Number.isNaN(tDelete) ? Number.NaN : tClose - tDelete;
  check(
    'S9 the close stayed inside the 5 s hard bound',
    !Number.isNaN(wait) && wait >= 0 && wait <= 5000,
    `DELETE ${show(tDelete)} -> pane.close ${show(tClose)}: ${wait} ms of the 5000 ms PANE_AGENT_EXIT_TIMEOUT_MS (margin ${5000 - wait} ms)`,
  );

  if (task === 'idle') {
    check(
      'C1idle the delete landed on an idle child',
      beforeDelete?.status === 'idle',
      `last pane sample before DELETE: ${beforeDelete?.status ?? '?'} at ${show(beforeDelete?.t)}`,
    );
    check(
      'C2idle the idle child was not cut: its session still ends on a normal turn',
      lastMessage?.role === 'assistant' && lastMessage?.stopReason === 'stop' && lastWrite <= tDelete,
      `last entry ${lastEntry?.type}/${lastMessage?.role ?? '-'} stopReason=${lastMessage?.stopReason ?? '-'} at ${show(lastWrite)} (DELETE ${show(tDelete)})`,
    );
  }

  if (task === 'midturn') {
    check(
      'C1midturn the delete landed while the child was in a model turn',
      beforeDelete?.status === 'working',
      `last pane sample before DELETE: ${beforeDelete?.status ?? '?'} at ${show(beforeDelete?.t)}`,
    );
    check(
      'C2midturn the running turn was cut, not allowed to finish',
      lastMessage?.role === 'assistant' &&
        (lastMessage?.stopReason === 'error' || lastMessage?.stopReason === 'aborted') &&
        String(lastMessage?.errorMessage ?? '').includes('aborted') &&
        lastWrite >= tDelete,
      `last entry stopReason=${lastMessage?.stopReason ?? '-'} errorMessage=${JSON.stringify(lastMessage?.errorMessage ?? '')} at ${show(lastWrite)} (${between(tDelete, lastWrite)})`,
    );
  }

  if (task === 'midtool') {
    check(
      'C1midtool the delete landed while the child was running bash',
      beforeDelete?.status === 'working' && bashCall !== undefined && String(bashCall.args?.command ?? '').includes(`sleep ${toolSleep}`),
      `last pane sample before DELETE: ${beforeDelete?.status ?? '?'}; bash call: ${bashCall === undefined ? 'MISSING' : JSON.stringify(bashCall.args)}`,
    );
    check(
      'C2midtool the live bash call got a toolResult instead of being left dangling',
      bashResult !== undefined,
      bashResult === undefined
        ? 'no toolResult for the bash toolCall'
        : `toolResult at ${show(ms(bashResult.timestamp))} (${between(tDelete, ms(bashResult.timestamp))}), isError=${bashResult.message.isError}, text=${JSON.stringify(bashText.slice(0, 200))}`,
    );
    check(
      'C3midtool the tool was cut with "Command aborted" before its natural end',
      bashCut && ms(bashResult?.timestamp) >= tDelete,
      bashResult === undefined
        ? 'no toolResult; cannot have been cut cleanly'
        : `marker=${bashCut}; tool ran ${ms(bashResult.timestamp) - ms(bashCall.at)} ms of a requested ${toolSleep * 1000} ms`,
    );
    check(
      'C4midtool the session ends on an aborted turn, not a dangling toolUse',
      lastMessage?.role === 'assistant' &&
        (lastMessage?.stopReason === 'error' || lastMessage?.stopReason === 'aborted') &&
        String(lastMessage?.errorMessage ?? '').includes('aborted') &&
        lastWrite >= tDelete,
      `last entry stopReason=${lastMessage?.stopReason ?? '-'} errorMessage=${JSON.stringify(lastMessage?.errorMessage ?? '')} at ${show(lastWrite)} (${between(tDelete, lastWrite)})`,
    );
  }

  note('session ending', `type=${lastEntry?.type ?? '?'} role=${lastMessage?.role ?? '-'} stopReason=${lastMessage?.stopReason ?? '-'} errorMessage=${JSON.stringify(lastMessage?.errorMessage ?? '')}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  console.log(failed === 0 ? `VERDICT: PASS (${results.length}/${results.length} observations)` : `VERDICT: FAIL (${failed}/${results.length} observations failed)`);
  return { dir, failed, total: results.length };
}

const summaries = [];
for (const dir of dirs) summaries.push(analyse(dir));
const failed = summaries.reduce((n, s) => n + s.failed, 0);
console.log('');
console.log('=== summary ===');
for (const s of summaries) console.log(`${s.failed === 0 ? 'PASS' : 'FAIL'}  ${s.dir} (${s.total - s.failed}/${s.total})`);
console.log(failed === 0 ? 'OVERALL: PASS' : `OVERALL: FAIL (${failed} observations failed)`);
process.exit(failed === 0 ? 0 : 1);
