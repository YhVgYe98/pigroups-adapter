#!/usr/bin/env node
/**
 * Driver for the steer/abort experiments (E1/E2).
 *
 * It starts one throwaway PiGroups platform, then for each case creates a child
 * member, starts a pi session in its own herdr tab with the real adapter plus
 * probe/steer-probe.ts, drives one bash sleep, injects a steer (native pi or a
 * platform pg.steer), optionally aborts, and archives:
 *   - probe.jsonl       probe extension's send/abort/tool timeline
 *   - session.jsonl     pi's own session JSONL (the measurement)
 *   - timeline.txt      the relevant entries, verbatim JSON one per line
 *   - summary.json      derived ordering and verdict inputs
 *   - adapter-view/     journal + injected watermark for that member
 *   - pane.txt          pane scrollback before teardown
 *
 * Usage: node driver.mjs [evidence-dir]
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = '/home/yang/Documents/pigroups-adapter';
const PG = '/home/yang/Documents/PiGroups';
const ADAPTER_EXT = join(REPO, 'src/extension.ts');
const PROBE_EXT = join(REPO, 'probe/steer-probe.ts');
const MODEL = `${process.env.PI_PROVIDER ?? 'deepseek'}/${process.env.PI_MODEL ?? 'deepseek-flash'}`;

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const EVID = process.argv[2] ?? process.env.EVID ?? join(REPO, 'probe/logs', `steer-${stamp}`);
mkdirSync(EVID, { recursive: true });
const CMD_LOG = join(EVID, 'commands.log');
const RUN_LOG = join(EVID, 'run.log');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

function logRun(line) {
  const text = `[${nowIso()}] ${line}\n`;
  appendFileSync(RUN_LOG, text, 'utf8');
  process.stdout.write(text);
}

function quote(arg) {
  return /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function run(cmd, args, opts = {}) {
  const rendered = [cmd, ...args].map(quote).join(' ');
  appendFileSync(CMD_LOG, `[${nowIso()}] ${rendered}\n`, 'utf8');
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
    return out;
  } catch (err) {
    logRun(`COMMAND FAILED: ${rendered}\n${err.stdout ?? ''}${err.stderr ?? ''}`);
    throw err;
  }
}

function herdr(...args) {
  const out = run('herdr', args);
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ parse_error: line });
    }
  }
  return out;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

let BASE;
async function api(method, path, token, body) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // keep text
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return data;
}

async function waitFor(what, fn, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timeout after ${timeoutMs} ms waiting for ${what}`);
}

function findSessionFile(dir) {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0];
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .map((part) => {
      if (part?.type === 'text') return part.text ?? '';
      if (part?.type === 'thinking') return part.thinking ?? '';
      return '';
    })
    .join('\n');
}

function entryText(entry) {
  if (entry?.type === 'custom_message') return String(entry.content ?? '');
  if (entry?.type !== 'message') return '';
  return messageText(entry.message);
}

function analyze(sessionPath, markers) {
  const entries = readJsonl(sessionPath);
  const toolCalls = [];
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    for (const part of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (part?.type === 'toolCall') {
        toolCalls.push({
          entryIndex: entries.indexOf(entry),
          id: part.id,
          name: part.name,
          args: part.arguments,
          timestamp: entry.timestamp,
        });
      }
    }
  }
  const sleepCalls = toolCalls.filter((call) => /sleep/.test(JSON.stringify(call.args ?? {})));
  const toolResults = [];
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message?.role !== 'toolResult') continue;
    toolResults.push({
      entryIndex: entries.indexOf(entry),
      toolCallId: entry.message.toolCallId,
      toolName: entry.message.toolName,
      isError: entry.message.isError,
      durationMs: entry.message.durationMs,
      timestamp: entry.timestamp,
      text: messageText(entry.message).slice(0, 600),
    });
  }
  const resultFor = (call) => toolResults.find((result) => result.toolCallId === call.id);

  const markerRows = {};
  for (const marker of markers) {
    const steerEntries = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.type === 'custom_message' && String(entry.content ?? '').includes(marker));
    const assistantMentions = entries
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          entry.type === 'message' &&
          entry.message?.role === 'assistant' &&
          entryText(entry).includes(marker),
      );
    const allMentions = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entryText(entry).includes(marker));
    markerRows[marker] = {
      steerEntries: steerEntries.map(({ entry, index }) => ({
        index,
        timestamp: entry.timestamp,
        customType: entry.customType,
        content: entry.content,
      })),
      assistantMentions: assistantMentions.map(({ entry, index }) => ({
        index,
        timestamp: entry.timestamp,
        stopReason: entry.message.stopReason,
        text: messageText(entry.message).slice(0, 1000),
      })),
      allMentions: allMentions.map(({ entry, index }) => ({
        index,
        type: entry.type,
        role: entry.message?.role,
        timestamp: entry.timestamp,
        text: entryText(entry).slice(0, 500),
      })),
    };
  }

  const errorAssistants = entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.type === 'message' &&
        entry.message?.role === 'assistant' &&
        (entry.message.stopReason === 'error' || entry.message.stopReason === 'aborted' || entry.message.errorMessage),
    )
    .map(({ entry, index }) => ({
      index,
      timestamp: entry.timestamp,
      stopReason: entry.message.stopReason,
      errorMessage: entry.message.errorMessage,
    }));

  const relevant = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const isToolCall =
      entry.type === 'message' &&
      entry.message?.role === 'assistant' &&
      (entry.message.content ?? []).some((part) => part?.type === 'toolCall');
    const isToolResult = entry.type === 'message' && entry.message?.role === 'toolResult';
    const isCustom = entry.type === 'custom_message';
    const isErrorAssistant =
      entry.type === 'message' &&
      entry.message?.role === 'assistant' &&
      (entry.message.stopReason === 'error' || entry.message.errorMessage);
    const isMarkerAssistant =
      entry.type === 'message' &&
      entry.message?.role === 'assistant' &&
      markers.some((marker) => entryText(entry).includes(marker));
    if (!isToolCall && !isToolResult && !isCustom && !isErrorAssistant && !isMarkerAssistant) continue;
    relevant.push({
      index,
      type: entry.type,
      timestamp: entry.timestamp,
      role: entry.message?.role,
      toolName: entry.message?.toolName,
      toolCallId: entry.message?.toolCallId,
      isError: entry.message?.isError,
      stopReason: entry.message?.stopReason,
      customType: entry.customType,
      content: entry.content,
      toolCalls: isToolCall
        ? (entry.message.content ?? [])
            .filter((part) => part?.type === 'toolCall')
            .map((part) => ({ id: part.id, name: part.name, args: part.arguments }))
        : undefined,
      text: isToolResult || isErrorAssistant ? messageText(entry.message).slice(0, 500) : undefined,
    });
  }

  return {
    sessionPath,
    entryCount: entries.length,
    firstTimestamp: entries[0]?.timestamp,
    lastTimestamp: entries[entries.length - 1]?.timestamp,
    sleepCalls: sleepCalls.map((call) => ({ ...call, result: resultFor(call) })),
    toolResults,
    markers: markerRows,
    errorAssistants,
    relevant,
  };
}

function writeTimeline(path, analysis) {
  const lines = analysis.relevant.map((row) => JSON.stringify(row));
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function markerVerdict(analysis, marker) {
  const row = analysis.markers[marker];
  if (!row) return { verdict: 'NO-MARKER-ROW' };
  if (row.steerEntries.length === 0 && row.assistantMentions.length === 0) return { verdict: 'LOST' };
  if (row.assistantMentions.length === 0) return { verdict: 'KEPT-BUT-UNSEEN' };
  return { verdict: 'SEEN' };
}

function probeStep(probePath, step, predicate = () => true) {
  return readJsonl(probePath).find((line) => line.step === step && predicate(line));
}

async function waitProbe(probePath, what, predicate, timeoutMs) {
  return await waitFor(
    what,
    () => {
      const lines = readJsonl(probePath);
      return lines.find((line) => predicate(line)) ?? null;
    },
    timeoutMs,
    200,
  );
}

function archiveAdapterView(adir, memberId, caseDir) {
  const dest = join(caseDir, 'adapter-view');
  mkdirSync(dest, { recursive: true });
  const injected = join(adir, 'injected', `${memberId}.json`);
  if (existsSync(injected)) cpSync(injected, join(dest, 'injected.json'));
  else writeFileSync(join(dest, 'injected.missing'), '', 'utf8');
  const journal = join(adir, 'journal', memberId);
  if (existsSync(journal)) cpSync(journal, join(dest, 'journal'), { recursive: true });
  else writeFileSync(join(dest, 'journal.missing'), '', 'utf8');
  const listing = existsSync(journal) ? readdirSync(journal) : [];
  writeFileSync(join(dest, 'journal-listing.json'), `${JSON.stringify(listing, null, 2)}\n`, 'utf8');
  return { injected, journal, journalListing: listing };
}

function paneText(paneId, caseDir) {
  try {
    const out = run('herdr', ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '800']);
    writeFileSync(join(caseDir, 'pane.txt'), out, 'utf8');
  } catch (err) {
    writeFileSync(join(caseDir, 'pane.txt'), `pane read failed: ${err.message}\n`, 'utf8');
  }
}

function killPiAndCloseTab(paneId, tabId, caseDir) {
  let pid;
  try {
    const info = herdr('pane', 'process-info', '--pane', paneId);
    writeFileSync(join(caseDir, 'process-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    const procs = info?.result?.process_info?.foreground_processes ?? [];
    const pi = procs.find((proc) => proc.name === 'pi' || /(^|\/)pi$/.test(proc.argv?.[0] ?? ''));
    pid = pi?.pid ?? procs[0]?.pid;
    if (pid) run('kill', ['-TERM', String(pid)]);
  } catch (err) {
    writeFileSync(join(caseDir, 'process-info.json'), `${JSON.stringify({ error: err.message })}\n`, 'utf8');
  }

  if (pid) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      execFileSync('sleep', ['0.2']);
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  try {
    herdr('tab', 'close', tabId);
  } catch (err) {
    logRun(`tab close failed for ${tabId}: ${err.message}`);
    try {
      herdr('pane', 'close', paneId);
    } catch {
      // ignore
    }
  }
}

const CASES = ([
  {
    id: 'e1-long-native',
    marker: 'STEER-MARK-7f31',
    sleepSeconds: 60,
    triggerDelayMs: 5000,
    steerVia: 'native',
    prompt:
      'Call the bash tool exactly once with this exact command, and call no other tool: sleep 60; echo SLEEPDONE. Do not shorten the sleep. After the bash result comes back, follow the newest instruction. If there is none, reply exactly READY and stop.',
    steerText:
      'STEER-MARK-7f31: when you next see this marker, reply with exactly "STEER-MARK-7f31" and then stop. Do not call any tool.',
  },
  {
    id: 'e1-short-native',
    marker: 'STEER-MARK-7f31',
    sleepSeconds: 5,
    triggerDelayMs: 1500,
    steerVia: 'native',
    prompt:
      'Call the bash tool exactly once with this exact command, and call no other tool: sleep 5; echo SLEEPDONE. Do not lengthen the sleep. After the bash result comes back, follow the newest instruction. If there is none, reply exactly READY and stop.',
    steerText:
      'STEER-MARK-7f31: when you next see this marker, reply with exactly "STEER-MARK-7f31" and then stop. Do not call any tool.',
  },
  {
    id: 'e1-long-adapter',
    marker: 'STEER-MARK-7f31A',
    sleepSeconds: 60,
    triggerDelayMs: 5000,
    steerVia: 'platform',
    prompt:
      'Call the bash tool exactly once with this exact command, and call no other tool: sleep 60; echo SLEEPDONE. Do not shorten the sleep. After the bash result comes back, follow the newest instruction. If there is none, reply exactly READY and stop.',
    steerText:
      'STEER-MARK-7f31A: when you next see this marker, reply with exactly "STEER-MARK-7f31A" and then stop. Do not call any tool.',
  },
  {
    id: 'e2-native-steer-platform-abort',
    marker: 'STEER-MARK-9c02',
    sleepSeconds: 60,
    triggerDelayMs: 5000,
    steerVia: 'native',
    abortVia: 'platform',
    followUpAfterAbort: true,
    prompt:
      'Call the bash tool exactly once with this exact command, and call no other tool: sleep 60; echo SLEEPDONE. Do not shorten the sleep. After the bash result comes back, follow the newest instruction. If there is none, reply exactly READY and stop.',
    steerText:
      'STEER-MARK-9c02: when you next see this marker, reply with exactly "STEER-MARK-9c02" and then stop. Do not call any tool.',
  },
  {
    id: 'e2-adapter-steer-then-abort',
    marker: 'STEER-MARK-9c02A',
    sleepSeconds: 60,
    triggerDelayMs: 5000,
    steerVia: 'platform',
    abortVia: 'platform',
    followUpAfterAbort: true,
    prompt:
      'Call the bash tool exactly once with this exact command, and call no other tool: sleep 60; echo SLEEPDONE. Do not shorten the sleep. After the bash result comes back, follow the newest instruction. If there is none, reply exactly READY and stop.',
    steerText:
      'STEER-MARK-9c02A: when you next see this marker, reply with exactly "STEER-MARK-9c02A" and then stop. Do not call any tool.',
  },
]).filter((def) => !process.env.CASE_FILTER || process.env.CASE_FILTER.split(',').includes(def.id));

async function runCase(def) {
  const caseDir = join(EVID, def.id);
  mkdirSync(caseDir, { recursive: true });
  mkdirSync(join(caseDir, 'trigger'), { recursive: true });
  const probePath = join(caseDir, 'probe.jsonl');
  writeFileSync(probePath, '', 'utf8');
  const sessionsDir = join(caseDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  logRun(`=== CASE ${def.id} ===`);
  const created = await api('POST', '/v1/members', rootToken, {
    name: def.id,
    request_id: `req-${def.id}`,
  });
  const member = created.member;
  const memberToken = created.token;
  if (!memberToken) throw new Error(`no token for ${def.id}`);
  writeFileSync(
    join(caseDir, 'ids.json'),
    `${JSON.stringify({ member, token: memberToken, model: MODEL }, null, 2)}\n`,
    'utf8',
  );

  const tabOut = herdr(
    'tab',
    'create',
    '--no-focus',
    '--cwd',
    scratch,
    '--label',
    `steerprobe-${def.id}`,
    '--env',
    `PIGROUPS_URL=${BASE}`,
    '--env',
    `PIGROUPS_TOKEN=${memberToken}`,
    '--env',
    `PIGROUPS_ADAPTER_DIR=${adir}`,
    '--env',
    `STEER_PROBE_LOG=${probePath}`,
    '--env',
    `STEER_PROBE_DIR=${join(caseDir, 'trigger')}`,
  );
  const paneId = tabOut.result.root_pane.pane_id;
  const tabId = tabOut.result.tab.tab_id;
  writeFileSync(join(caseDir, 'pane.json'), `${JSON.stringify({ paneId, tabId }, null, 2)}\n`, 'utf8');

  const startArgs = [
    'agent',
    'start',
    def.id,
    '--kind',
    'pi',
    '--pane',
    paneId,
    '--timeout',
    '60000',
    '--',
    '-ne',
    '-e',
    ADAPTER_EXT,
    '-e',
    PROBE_EXT,
    '-ns',
    '-np',
    '-nc',
    '--no-mcp',
    '--session-dir',
    sessionsDir,
    '--model',
    MODEL,
  ];
  const startOut = herdr(...startArgs);
  writeFileSync(join(caseDir, 'agent-start.json'), `${JSON.stringify(startOut, null, 2)}\n`, 'utf8');

  let summary;
  try {
    herdr('agent', 'wait', def.id, '--until', 'idle', '--timeout', '120000');
    logRun(`member ${member.id} ready in pane ${paneId}`);

    // One retry at the prompt level if the model never starts the sleep tool.
    let toolStart;
    for (let attempt = 1; attempt <= 2 && !toolStart; attempt += 1) {
      logRun(`prompt attempt ${attempt}: ${def.prompt}`);
      try {
        herdr('agent', 'prompt', def.id, def.prompt, '--wait', '--until', 'working', '--timeout', '30000');
      } catch (err) {
        logRun(`prompt wait failed (continuing to watch): ${err.message}`);
      }
      try {
        toolStart = await waitProbe(
          probePath,
          'bash sleep tool_start',
          (line) =>
            line.step === 'tool_start' &&
            line.toolName === 'bash' &&
            /sleep/.test(JSON.stringify(line.args ?? {})),
          attempt === 1 ? 90_000 : 90_000,
        );
      } catch (err) {
        logRun(`no bash sleep on attempt ${attempt}: ${err.message}`);
        try {
          herdr('agent', 'wait', def.id, '--until', 'idle', '--until', 'done', '--timeout', '60000');
        } catch {
          // ignore
        }
      }
    }
    if (!toolStart) throw new Error('model never started bash sleep after 2 prompts');
    logRun(`tool_start at ${toolStart.ts}`);

    await sleep(def.triggerDelayMs);
    let steerFileTime = null;
    let steerResponse = null;
    if (def.steerVia === 'native') {
      const steerFile = join(caseDir, 'trigger', 'steer-1.json');
      writeFileSync(
        steerFile,
        `${JSON.stringify({ marker: def.marker, text: def.steerText }, null, 2)}\n`,
        'utf8',
      );
      steerFileTime = nowIso();
      logRun(`native steer trigger written at ${steerFileTime}`);
      const sendReturn = await waitProbe(
        probePath,
        'native steer send',
        (line) => line.step === 'steer_send_return' && line.marker === def.marker,
        15_000,
      );
      logRun(`native steer send returned at ${sendReturn.ts} (isIdle=${sendReturn.isIdle})`);
    } else {
      const sendAt = Date.now();
      steerResponse = await api('POST', '/v1/control', humanToken, {
        to: member.id,
        id: `steer-${def.id}-${Date.now()}`,
        cmd: 'pg.steer',
        payload: { v: 1, text: def.steerText },
      });
      logRun(
        `platform pg.steer posted at ${new Date(sendAt).toISOString()} (${Date.now() - sendAt} ms) -> ${JSON.stringify(steerResponse)}`,
      );
    }

    if (def.abortVia === 'platform') {
      // "Immediately after": the native arm waits only for sendMessage to return.
      await sleep(250);
      const abortAt = Date.now();
      const abortResponse = await api('POST', '/v1/control', humanToken, {
        to: member.id,
        id: `abort-${def.id}-${Date.now()}`,
        cmd: 'pg.abort',
        payload: { v: 1 },
      });
      logRun(
        `platform pg.abort posted at ${new Date(abortAt).toISOString()} (${Date.now() - abortAt} ms) -> ${JSON.stringify(abortResponse)}`,
      );
      try {
        await waitFor(
          'agent idle after abort',
          () => {
            const got = herdr('agent', 'get', def.id);
            const agent = got?.result?.agent;
            return agent && ['idle', 'done', 'blocked'].includes(agent.agent_status) ? agent : null;
          },
          30_000,
          500,
        );
      } catch (err) {
        logRun(`warning: ${err.message}`);
      }
      await sleep(8000);
    } else {
      // No abort: wait for the tool result and the marker assistant message.
      await waitFor(
        'assistant marker after tool result',
        () => {
          const sessionPath = findSessionFile(sessionsDir);
          if (!sessionPath) return null;
          const analysis = analyze(sessionPath, [def.marker]);
          return analysis.markers[def.marker]?.assistantMentions.length > 0 ? analysis : null;
        },
        150_000,
        500,
      ).catch((err) => logRun(`warning: ${err.message}`));
    }

    const sessionPath = findSessionFile(sessionsDir);
    if (!sessionPath) throw new Error('no session JSONL found');
    const archivedSession = join(caseDir, 'session.jsonl');
    cpSync(sessionPath, archivedSession);
    writeFileSync(join(caseDir, 'session-path.txt'), `${sessionPath}\n`, 'utf8');

    let analysis = analyze(archivedSession, [def.marker]);
    writeTimeline(join(caseDir, 'timeline.txt'), analysis);
    const immediate = markerVerdict(analysis, def.marker);
    logRun(`immediate marker verdict for ${def.marker}: ${immediate.verdict}`);

    let followUp = null;
    if (def.followUpAfterAbort) {
      logRun('sending follow-up prompt BANANA after the immediate snapshot');
      try {
        herdr('agent', 'prompt', def.id, 'Reply with exactly BANANA and stop. Do not call any tool.', '--wait', '--until', 'working', '--timeout', '30000');
      } catch (err) {
        logRun(`follow-up prompt wait failed: ${err.message}`);
      }
      await waitFor(
        'BANANA assistant after follow-up',
        () => {
          const latest = findSessionFile(sessionsDir);
          if (!latest) return null;
          const text = readFileSync(latest, 'utf8');
          return text.includes('BANANA') ? true : null;
        },
        90_000,
        500,
      ).catch((err) => logRun(`warning: ${err.message}`));
      await sleep(1000);
      const latest = findSessionFile(sessionsDir);
      if (latest) cpSync(latest, join(caseDir, 'session-after-followup.jsonl'));
      analysis = analyze(join(caseDir, 'session-after-followup.jsonl'), [def.marker]);
      writeTimeline(join(caseDir, 'timeline-after-followup.txt'), analysis);
      followUp = markerVerdict(analysis, def.marker);
      logRun(`after-followup marker verdict for ${def.marker}: ${followUp.verdict}`);
    }

    const adapterView = archiveAdapterView(adir, member.id, caseDir);
    paneText(paneId, caseDir);

    summary = {
      case: def.id,
      member,
      model: MODEL,
      paneId,
      tabId,
      marker: def.marker,
      steerVia: def.steerVia,
      abortVia: def.abortVia ?? null,
      steerFileTime,
      probePath,
      sessionPath: archivedSession,
      immediate,
      afterFollowUp: followUp,
      adapterView: {
        injectedFile: adapterView.injected,
        injectedExists: existsSync(adapterView.injected),
        journalDir: adapterView.journal,
        journalListing: adapterView.journalListing,
      },
      analysis,
    };
    writeFileSync(join(caseDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  } catch (err) {
    summary = { case: def.id, error: err.stack ?? String(err) };
    writeFileSync(join(caseDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    logRun(`CASE ${def.id} ERROR: ${err.stack ?? err}`);
  } finally {
    try {
      paneText(paneId, caseDir);
    } catch {
      // ignore
    }
    killPiAndCloseTab(paneId, tabId, caseDir);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const PORT = await freePort();
BASE = `http://127.0.0.1:${PORT}`;
const DATA = await mkdtemp(join(tmpdir(), 'pigroups-steer-data.'));
const ADIR = await mkdtemp(join(tmpdir(), 'pigroups-steer-adir.'));
const scratch = await mkdtemp(join(tmpdir(), 'pigroups-steer-scratch.'));
const adir = ADIR;
const platformLog = join(EVID, 'platform.log');
const platformFd = (await import('node:fs')).openSync(platformLog, 'a');
const platform = spawn('node', ['src/main.ts'], {
  cwd: PG,
  env: {
    ...process.env,
    PIGROUPS_ADMIN_TOKEN: 'adm',
    PORT: String(PORT),
    PIGROUPS_DATA: DATA,
  },
  stdio: ['ignore', platformFd, platformFd],
});
writeFileSync(join(EVID, 'platform.pid'), `${platform.pid}\n`, 'utf8');
writeFileSync(
  join(EVID, 'env.sh'),
  [
    `export EVID=${quote(EVID)}`,
    `export PORT=${PORT}`,
    `export PIGROUPS_URL=${BASE}`,
    `export PIGROUPS_DATA=${quote(DATA)}`,
    `export ADIR=${quote(ADIR)}`,
    `export SCRATCH=${quote(scratch)}`,
    `export MODEL=${quote(MODEL)}`,
    '',
  ].join('\n'),
  'utf8',
);
logRun(`platform pid ${platform.pid} on ${BASE}, data=${DATA}, adir=${ADIR}, scratch=${scratch}`);

let rootToken;
let humanToken;
let humanId;
let cleanupDone = false;

async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  logRun('cleanup: closing platform and removing temp dirs');
  try {
    platform.kill('SIGTERM');
  } catch {
    // ignore
  }
  await Promise.race([
    new Promise((resolve) => platform.once('exit', resolve)),
    sleep(5000),
  ]);
  try {
    platform.kill('SIGKILL');
  } catch {
    // ignore
  }
  try {
    const panes = herdr('pane', 'list');
    writeFileSync(join(EVID, 'final-panes.json'), `${JSON.stringify(panes, null, 2)}\n`, 'utf8');
  } catch (err) {
    logRun(`pane list at cleanup failed: ${err.message}`);
  }
  rmSync(DATA, { recursive: true, force: true });
  rmSync(ADIR, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(143);
});

try {
  await waitFor(
    'platform health',
    async () => {
      try {
        const res = await fetch(`${BASE}/v1/health`);
        return res.ok;
      } catch {
        return null;
      }
    },
    30000,
    200,
  );
  const boot = await api('POST', '/v1/bootstrap', undefined, { name: 'root' });
  rootToken = boot.token;
  writeFileSync(join(EVID, 'bootstrap.json'), `${JSON.stringify(boot, null, 2)}\n`, 'utf8');
  const human = await api('POST', '/v1/humans', 'adm', { name: 'steer-human' });
  humanToken = human.token;
  humanId = human.human?.id ?? human.id;
  writeFileSync(join(EVID, 'human.json'), `${JSON.stringify(human, null, 2)}\n`, 'utf8');
  logRun(`bootstrapped root=${boot.member.id}, human=${humanId}`);

  const summaries = [];
  for (const def of CASES) summaries.push(await runCase(def));
  writeFileSync(join(EVID, 'summaries.json'), `${JSON.stringify(summaries, null, 2)}\n`, 'utf8');
  logRun('all cases done');
} finally {
  await cleanup();
}

function finalChecks() {
  const checks = {};
  const panes = readJson(join(EVID, 'final-panes.json'));
  const ids = (panes?.result?.panes ?? []).map((pane) => pane.pane_id).sort();
  checks.finalPaneIds = ids;
  checks.onlyBossPanes = ids.filter((id) => !['wD:p1E', 'wE:p1', 'wE:p12', 'wE:p1J'].includes(id));
  checks.platformPid = platform.pid;
  let platformAlive = false;
  try {
    process.kill(platform.pid, 0);
    platformAlive = true;
  } catch {
    // gone
  }
  checks.platformAlive = platformAlive;
  return checks;
}

const checks = finalChecks();
writeFileSync(join(EVID, 'cleanup.json'), `${JSON.stringify(checks, null, 2)}\n`, 'utf8');
logRun(`cleanup: final panes=${checks.finalPaneIds.join(' ')}; extra=${checks.onlyBossPanes.join(' ') || 'none'}; platformAlive=${checks.platformAlive}`);

// Compact human-readable index.
const summaries = readJson(join(EVID, 'summaries.json'));
const rows = [];
for (const summary of summaries) {
  if (summary.error) {
    rows.push(`| ${summary.case} | ERROR | ${summary.error.split('\n')[0]} | | | | |`);
    continue;
  }
  const analysis = summary.analysis;
  const sleepCall = analysis.sleepCalls[0];
  const result = sleepCall?.result;
  const marker = analysis.markers[summary.marker];
  const steer = marker?.steerEntries[0];
  const mention = marker?.assistantMentions[0];
  rows.push(
    `| ${summary.case} | ${summary.marker} | ${steer?.timestamp ?? '—'} | ${result?.timestamp ?? '—'} | ${mention?.timestamp ?? '—'} | ${summary.immediate.verdict} | ${summary.afterFollowUp?.verdict ?? '—'} |`,
  );
}
const md = [
  `# Steer/abort experiment ${stamp}`,
  '',
  `pi ${run('pi', ['--version']).trim()}, adapter HEAD ${run('git', ['rev-parse', 'HEAD'], { cwd: REPO }).trim()}, model ${MODEL}.`,
  `Platform ${BASE} (throwaway; pid in platform.pid).`,
  '',
  '| case | marker | steer entry timestamp | tool result timestamp | first assistant mention | immediate | after follow-up |',
  '|---|---|---|---|---|---|---|',
  ...rows,
  '',
  'Raw evidence is in each case directory: `probe.jsonl`, `session.jsonl`, `timeline.txt`, `summary.json`, `adapter-view/`, `pane.txt`.',
  '',
].join('\n');
writeFileSync(join(EVID, 'README.md'), md, 'utf8');
logRun('wrote README.md');
