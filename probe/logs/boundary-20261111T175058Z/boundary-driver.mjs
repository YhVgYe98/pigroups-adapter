#!/usr/bin/env node
/**
 * Real-machine verification of the turn-boundary delivery design (概念稿 §8.1/§8.3).
 *
 * One throwaway platform, one throwaway member (child of a bootstrapped root), one
 * pi session loaded with the real adapter plus probe/boundary-probe.ts.
 *
 *   A. A message is posted while the member is inside a 120 s bash tool. The window
 *      (60 s, production default) closes during the tool, so the only reason the
 *      custom message waits is the idle gate. Expected: exactly one custom_message,
 *      written after the tool result.
 *   B. A second turn is cut with `pg.abort` while a message is queued. Expected: no
 *      new turn for a full window after the cut, then exactly one delivery.
 *
 * Everything it sees is archived under the evidence directory: the probe JSONL, the
 * pi session JSONL at each snapshot, the adapter view (watermark + journal), the
 * platform log, the pane scrollback and derived timings.
 *
 * Usage: node probe/boundary-driver.mjs [evidence-dir]
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = '/home/yang/Documents/pigroups-adapter';
const PG = '/home/yang/Documents/PiGroups';
const ADAPTER_EXT = join(REPO, 'src/extension.ts');
const PROBE_EXT = join(REPO, 'probe/boundary-probe.ts');
const MODEL = `${process.env.PROBE_PROVIDER ?? process.env.PI_PROVIDER ?? 'deepseek'}/${
  process.env.PROBE_MODEL ?? process.env.PI_MODEL ?? 'deepseek-flash'
}`;

// The production delivery window. Not overridden: the point of the probe is the real
// number. The poll wait IS shortened (seconds, default 25) so "arrival -> queue" and
// "window closed -> delivery" are measurable to ~1 s instead of ~25 s. It changes no
// delivery rule, only the pacing of the poll.
const WINDOW_MS = 60_000;
const POLL_WAIT_S = 1;

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const EVID = process.argv[2] ?? process.env.EVID ?? join(REPO, 'probe/logs', `boundary-${stamp}`);
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
function logJson(name, value) {
  writeFileSync(join(EVID, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function quote(arg) {
  return /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}
function redact(text) {
  // The tab create arguments carry the model keys (they are handed to the pane env).
  // Keep them out of the committed evidence; the run only needs to show what was set.
  return text.replace(/([A-Z_]*API_KEY=)[^ ]+/g, '$1<redacted>');
}
function run(cmd, args, opts = {}) {
  const rendered = redact([cmd, ...args].map(quote).join(' '));
  appendFileSync(CMD_LOG, `[${nowIso()}] ${rendered}\n`, 'utf8');
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
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
function readSession(path) {
  return readJsonl(path);
}
function isoTs(ms) {
  return new Date(ms).toISOString();
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

// ---------------------------------------------------------------- probe / session

function probeLines(probePath) {
  return readJsonl(probePath);
}
function waitProbe(probePath, what, predicate, timeoutMs, everyMs = 200) {
  return waitFor(
    what,
    () => probeLines(probePath).find((line) => predicate(line)) ?? null,
    timeoutMs,
    everyMs,
  );
}

function sessionEntries(sessionPath) {
  return readSession(sessionPath);
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
function bashCalls(entries, needle = 'sleep') {
  const calls = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    for (const part of Array.isArray(entry.message.content) ? entry.message.content : []) {
      if (part?.type !== 'toolCall' || part.name !== 'bash') continue;
      if (!/sleep/.test(JSON.stringify(part.arguments ?? {}))) continue;
      if (needle !== 'sleep' && !JSON.stringify(part.arguments ?? {}).includes(needle)) continue;
      calls.push({
        index,
        id: part.id,
        args: part.arguments,
        timestamp: entry.timestamp,
        epoch_ms: Date.parse(entry.timestamp),
      });
    }
  }
  return calls;
}
function toolResultFor(entries, toolCallId) {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type !== 'message' || entry.message?.role !== 'toolResult') continue;
    if (entry.message.toolCallId !== toolCallId) continue;
    return {
      index,
      toolName: entry.message.toolName,
      isError: entry.message.isError === true,
      durationMs: entry.message.durationMs,
      timestamp: entry.timestamp,
      epoch_ms: Date.parse(entry.timestamp),
      text: messageText(entry.message).slice(0, 400),
    };
  }
  return undefined;
}
function markerEntries(entries, marker) {
  const rows = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === 'custom_message' && String(entry.content ?? '').includes(marker)) {
      rows.push({
        index,
        timestamp: entry.timestamp,
        epoch_ms: Date.parse(entry.timestamp),
        customType: entry.customType,
        details: entry.details,
        content: entry.content,
      });
    }
  }
  return rows;
}
function assistantMentions(entries, token) {
  const rows = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const text = messageText(entry.message);
    if (!text.includes(token)) continue;
    rows.push({
      index,
      timestamp: entry.timestamp,
      epoch_ms: Date.parse(entry.timestamp),
      stopReason: entry.message.stopReason,
      text: text.slice(0, 800),
    });
  }
  return rows;
}
function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

function archiveAdapterView(adir, memberId, destDir) {
  mkdirSync(destDir, { recursive: true });
  const out = {};
  const injected = join(adir, 'injected', `${memberId}.json`);
  if (existsSync(injected)) {
    cpSync(injected, join(destDir, 'injected.json'));
    out.injected = JSON.parse(readFileSync(injected, 'utf8'));
  } else {
    writeFileSync(join(destDir, 'injected.missing'), '', 'utf8');
    out.injected = null;
  }
  const journal = join(adir, 'journal', memberId);
  if (existsSync(journal)) {
    cpSync(journal, join(destDir, 'journal'), { recursive: true });
    out.journal = readdirSync(journal);
  } else {
    writeFileSync(join(destDir, 'journal.missing'), '', 'utf8');
    out.journal = [];
  }
  const sessions = join(adir, 'sessions');
  if (existsSync(sessions)) cpSync(sessions, join(destDir, 'sessions'), { recursive: true });
  const log = join(adir, 'adapter.log');
  if (existsSync(log)) cpSync(log, join(destDir, 'adapter.log'));
  return out;
}

function paneText(paneId, destDir) {
  try {
    const out = run('herdr', ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '800']);
    writeFileSync(join(destDir, 'pane.txt'), out, 'utf8');
  } catch (err) {
    writeFileSync(join(destDir, 'pane.txt'), `pane read failed: ${err.message}\n`, 'utf8');
  }
}

function killPiAndCloseTab(paneId, tabId, destDir) {
  let pid;
  try {
    const info = herdr('pane', 'process-info', '--pane', paneId);
    writeFileSync(join(destDir, 'process-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    const procs = info?.result?.process_info?.foreground_processes ?? [];
    const pi = procs.find((proc) => proc.name === 'pi' || /(^|\/)pi$/.test(proc.argv?.[0] ?? ''));
    pid = pi?.pid ?? procs[0]?.pid;
    if (pid) run('kill', ['-TERM', String(pid)]);
  } catch (err) {
    writeFileSync(join(destDir, 'process-info.json'), `${JSON.stringify({ error: err.message })}\n`, 'utf8');
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
      // gone
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

// ---------------------------------------------------------------- setup

const PORT = await freePort();
BASE = `http://127.0.0.1:${PORT}`;
const DATA = await mkdtemp(join(tmpdir(), 'pigroups-boundary-data.'));
const ADIR = await mkdtemp(join(tmpdir(), 'pigroups-boundary-adir.'));
const SCRATCH = await mkdtemp(join(tmpdir(), 'pigroups-boundary-scratch.'));
const SESS = await mkdtemp(join(tmpdir(), 'pigroups-boundary-sessions.'));
const platformLog = join(EVID, 'platform.log');
const platformFd = openSync(platformLog, 'a');
const platform = spawn('node', ['src/main.ts'], {
  cwd: PG,
  env: {
    ...process.env,
    PIGROUPS_ADMIN_TOKEN: 'adm',
    PORT: String(PORT),
    PIGROUPS_DATA: DATA,
    // platform 0.7.2: PIGROUPS_DATA is a data root; this names the platform under it.
    PIGROUPS_PLATFORM_ID: 'boundary',
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
    `export SCRATCH=${quote(SCRATCH)}`,
    `export SESS=${quote(SESS)}`,
    `export MODEL=${quote(MODEL)}`,
    `export WINDOW_MS=${WINDOW_MS}`,
    `export POLL_WAIT_S=${POLL_WAIT_S}`,
    '',
  ].join('\n'),
  'utf8',
);
logRun(`platform pid ${platform.pid} on ${BASE}, data=${DATA}, adir=${ADIR}, sessions=${SESS}`);

const baselinePanes = herdr('pane', 'list');
writeFileSync(join(EVID, 'baseline-panes.json'), `${JSON.stringify(baselinePanes, null, 2)}\n`, 'utf8');

let cleanupDone = false;
let paneId;
let tabId;
let agentName = 'boundary';
let platformAliveAtCleanup = null;

async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  logRun('cleanup: killing pi, closing tab, stopping platform, removing temp dirs');
  if (paneId && tabId) {
    try {
      paneText(paneId, EVID);
    } catch {
      // ignore
    }
    killPiAndCloseTab(paneId, tabId, EVID);
  }
  try {
    platform.kill('SIGTERM');
  } catch {
    // ignore
  }
  await Promise.race([new Promise((resolve) => platform.once('exit', resolve)), sleep(5000)]);
  try {
    platform.kill('SIGKILL');
  } catch {
    // ignore
  }
  await sleep(300);
  try {
    process.kill(platform.pid, 0);
    platformAliveAtCleanup = true;
  } catch {
    platformAliveAtCleanup = false;
  }
  let leftoverProcs = [];
  try {
    leftoverProcs = readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map((pid) => {
        try {
          const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
          const env = readFileSync(`/proc/${pid}/environ`, 'utf8');
          return { pid: Number(pid), cmd, boundary: env.includes('PIGROUPS_DATA=' + DATA) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    // ignore
  }
  const panesAfter = (() => {
    try {
      return herdr('pane', 'list');
    } catch (err) {
      return { error: err.message };
    }
  })();
  writeFileSync(join(EVID, 'final-panes.json'), `${JSON.stringify(panesAfter, null, 2)}\n`, 'utf8');
  const finalPids = leftoverProcs.filter((p) => p.boundary);
  writeFileSync(
    join(EVID, 'cleanup.json'),
    `${JSON.stringify(
      {
        platform: { pid: platform.pid, alive: platformAliveAtCleanup },
        panes: panesAfter,
        processesMentioningThisRun: finalPids,
        tempDirs: [DATA, ADIR, SCRATCH, SESS],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  for (const dir of [DATA, ADIR, SCRATCH, SESS]) rmSync(dir, { recursive: true, force: true });
  logRun(
    `cleanup: platformAlive=${platformAliveAtCleanup}; leftover run processes=${finalPids.length}; panes closed`,
  );
}

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(143);
});

// ---------------------------------------------------------------- experiment

const triggerDelayMs = Number(process.env.TRIGGER_DELAY_MS ?? 5000);
const SECOND_WINDOW_SLACK_MS = Number(process.env.WINDOW_SLACK_MS ?? 1000);

const PROMPT_A =
  'Call the bash tool exactly once with this exact command, and call no other tool: ' +
  'sleep 120; echo SLEEPDONE. Do not shorten the sleep. After the bash result comes back, ' +
  'follow the newest instruction. If there is none, reply exactly READY and stop.';
const PROMPT_B =
  'Call the bash tool exactly once with this exact command, and call no other tool: ' +
  'sleep 120; echo SLEEPDONE. Do not shorten the sleep. After the bash result comes back, ' +
  'follow the newest instruction. If there is none, reply exactly READY and stop.';

function phaseDir(name) {
  const dir = join(EVID, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function snapshot(dir, sessionPath, probePath) {
  if (sessionPath && existsSync(sessionPath)) cpSync(sessionPath, join(dir, 'session.jsonl'));
  if (probePath && existsSync(probePath)) cpSync(probePath, join(dir, 'probe.jsonl'));
}

async function promptAgent(text, label) {
  writeFileSync(join(EVID, `${label}.prompt.txt`), `${text}\n`, 'utf8');
  try {
    herdr('agent', 'prompt', agentName, text, '--wait', '--until', 'working', '--timeout', '60000');
    logRun(`${label}: prompt accepted`);
  } catch (err) {
    logRun(`${label}: prompt --wait failed (continuing to watch): ${err.message}`);
  }
}

async function main() {
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
    30_000,
    200,
  );
  logRun('platform healthy');
  const boot = await api('POST', '/v1/bootstrap', undefined, { name: 'root' });
  const rootToken = boot.token;
  logRun(`bootstrapped root=${boot.member.id}`);
  logJson('bootstrap.json', { member: boot.member });

  const created = await api('POST', '/v1/members', rootToken, {
    name: 'boundary',
    request_id: `boundary-${stamp}`,
  });
  const member = created.member;
  const memberToken = created.token;
  logRun(`created member ${member.id} (parent ${member.parent_id ?? boot.member.id})`);
  logJson('member.json', { member });

  const tabEnv = [
    '--env',
    `PIGROUPS_URL=${BASE}`,
    '--env',
    `PIGROUPS_TOKEN=${memberToken}`,
    '--env',
    `PIGROUPS_ADAPTER_DIR=${ADIR}`,
    '--env',
    `PIGROUPS_POLL_WAIT=${POLL_WAIT_S}`,
    '--env',
    `BOUNDARY_PROBE_LOG=${join(EVID, 'probe.jsonl')}`,
  ];
  // The pane inherits the herdr server's environment, not this shell's; forward the
  // model keys this shell has so the member uses the same credentials a human does.
  for (const key of [
    'DEEPSEEK_API_KEY',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'ZAI_CODING_CN_API_KEY',
    'GLM_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ]) {
    if (process.env[key]) tabEnv.push('--env', `${key}=${process.env[key]}`);
  }
  const tabOut = herdr(
    'tab',
    'create',
    '--no-focus',
    '--cwd',
    SCRATCH,
    '--label',
    'boundary',
    ...tabEnv,
  );
  paneId = tabOut.result.root_pane.pane_id;
  tabId = tabOut.result.tab.tab_id;
  logJson('pane.json', { paneId, tabId });

  const startOut = herdr(
    'agent',
    'start',
    agentName,
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
    SESS,
    '--model',
    MODEL,
  );
  writeFileSync(join(EVID, 'agent-start.json'), `${JSON.stringify(startOut, null, 2)}\n`, 'utf8');

  herdr('agent', 'wait', agentName, '--until', 'idle', '--timeout', '120000');
  logRun('member pi is idle');

  // The adapter is live when it has written this session's record.
  await waitFor(
    'adapter session record',
    () => (existsSync(join(ADIR, 'sessions')) && readdirSync(join(ADIR, 'sessions')).length > 0 ? true : null),
    30_000,
    500,
  );
  const sessionPath = await waitFor('probe session_start', () => {
    const lines = probeLines(join(EVID, 'probe.jsonl'));
    const start = lines.find((line) => line.step === 'session_start');
    return start?.sessionFile ?? findSessionFile(SESS) ?? null;
  }, 30_000, 250);
  logRun(`session file: ${sessionPath}`);
  writeFileSync(join(EVID, 'session-path.txt'), `${sessionPath}\n`, 'utf8');

  const results = { phaseA: null, phaseB: null };

  // ---------------------------------------------------------------- phase A
  {
    const dir = phaseDir('phase-a');
    const probePath = join(EVID, 'probe.jsonl');
    logRun('--- phase A: message while inside a 120 s tool ---');
    await promptAgent(PROMPT_A, 'phase-a');
    const toolStart = await waitProbe(
      probePath,
      'bash sleep 120 tool_start',
      (line) => line.step === 'tool_start' && line.toolName === 'bash' && /sleep 120/.test(line.argsPreview ?? ''),
      150_000,
    );
    logRun(`phase A: tool_start at ${toolStart.ts} (${toolStart.argsPreview})`);

    await sleep(triggerDelayMs);
    const marker = `BOUNDARY-A-${stamp.slice(-6)}`;
    const text = `${marker}: when you next see this marker, reply with exactly ${marker} and then stop. Do not call any tool.`;
    const postStart = Date.now();
    const response = await api('POST', '/v1/messages', rootToken, { to: member.id, body: text });
    const postEnd = Date.now();
    const posted = {
      marker,
      text,
      memberId: member.id,
      sender: 'root (parent)',
      postStart,
      postEnd,
      postStartIso: isoTs(postStart),
      postEndIso: isoTs(postEnd),
      response,
      conv: response.to,
      seq: response.seq,
      created_at: response.created_at,
    };
    logJson('phase-a/message.json', posted);
    logRun(
      `phase A: message posted at ${posted.postStartIso} (${postEnd - postStart} ms) -> ${response.to}#${response.seq}, created_at=${isoTs(Number(response.created_at))}`,
    );

    const toolEnd = await waitProbe(
      probePath,
      'bash tool_end',
      (line) => line.step === 'tool_end' && line.toolCallId === toolStart.toolCallId,
      200_000,
    );
    logRun(`phase A: tool_end at ${toolEnd.ts} (isError=${toolEnd.isError}, ${toolEnd.durationMs} ms)`);

    const delivered = await waitFor(
      'phase A marker custom_message',
      () => {
        const rows = markerEntries(sessionEntries(sessionPath), marker);
        return rows.length > 0 ? rows : null;
      },
      180_000,
      250,
    );
    logRun(`phase A: custom_message at ${delivered[0].timestamp} (${delivered.length} entr(y/ies))`);
    const reply = await waitFor(
      'phase A assistant reply',
      () => {
        const rows = assistantMentions(sessionEntries(sessionPath), marker);
        return rows.length > 0 ? rows : null;
      },
      120_000,
      250,
    );
    logRun(`phase A: assistant reply at ${reply[0].timestamp}`);
    await sleep(1500);

    const entries = sessionEntries(sessionPath);
    const calls = bashCalls(entries, 'sleep 120');
    const call = calls[0];
    const result = call ? toolResultFor(entries, call.id) : undefined;
    const raw = readFileSync(sessionPath, 'utf8');
    const prefix = `[${response.to}#${response.seq}`;
    const summary = {
      marker,
      prefix,
      posted,
      toolCall: call,
      toolResult: result,
      delivered: delivered[0],
      deliveredCount: delivered.length,
      reply: reply[0],
      occurrences: {
        exactPrefix: countOccurrences(raw, prefix),
        markerToken: countOccurrences(raw, marker),
      },
      deltas: result
        ? {
            arrivalToToolEnd: result.epoch_ms - Number(response.created_at),
            windowClosesAt: Number(response.created_at) + WINDOW_MS,
            windowClosesBeforeToolEndByMs: result.epoch_ms - (Number(response.created_at) + WINDOW_MS),
            toolEndToDelivered: delivered[0].epoch_ms - result.epoch_ms,
            arrivalToDelivered: delivered[0].epoch_ms - Number(response.created_at),
            deliveredToReply: reply[0].epoch_ms - delivered[0].epoch_ms,
            arrivalToReply: reply[0].epoch_ms - Number(response.created_at),
          }
        : null,
      adapterView: archiveAdapterView(ADIR, member.id, join(dir, 'adapter-view')),
    };
    logJson('phase-a/summary.json', summary);
    snapshot(dir, sessionPath, probePath);
    logRun(
      `phase A: tool result ${result?.timestamp}; custom_message ${delivered[0].timestamp}; ` +
        `result->delivery ${summary.deltas?.toolEndToDelivered} ms; marker occurrences: ` +
        `prefix=${summary.occurrences.exactPrefix}, token=${summary.occurrences.markerToken}`,
    );
    results.phaseA = summary;
  }

  // ---------------------------------------------------------------- phase B
  {
    const dir = phaseDir('phase-b');
    const probePath = join(EVID, 'probe.jsonl');
    logRun('--- phase B: queued message + pg.abort through the platform ---');
    await promptAgent(PROMPT_B, 'phase-b');
    const toolStart = await waitProbe(
      probePath,
      'phase B bash sleep 120 tool_start',
      (line) =>
        line.step === 'tool_start' &&
        line.toolName === 'bash' &&
        /sleep 120/.test(line.argsPreview ?? '') &&
        line.epoch_ms > (results.phaseA?.delivered?.epoch_ms ?? 0),
      150_000,
    );
    logRun(`phase B: tool_start at ${toolStart.ts}`);

    await sleep(triggerDelayMs);
    const marker = `BOUNDARY-B-${stamp.slice(-6)}`;
    const text = `${marker}: when you next see this marker, reply with exactly ${marker} and then stop. Do not call any tool.`;
    const postStart = Date.now();
    const response = await api('POST', '/v1/messages', rootToken, { to: member.id, body: text });
    const postEnd = Date.now();
    const posted = {
      marker,
      text,
      memberId: member.id,
      sender: 'root (parent)',
      postStart,
      postEnd,
      postStartIso: isoTs(postStart),
      postEndIso: isoTs(postEnd),
      response,
      conv: response.to,
      seq: response.seq,
      created_at: response.created_at,
    };
    logJson('phase-b/message.json', posted);
    logRun(
      `phase B: message posted at ${posted.postStartIso} (${postEnd - postStart} ms) -> ${response.to}#${response.seq}`,
    );

    // Give the adapter time to poll and enqueue it (poll wait is 1 s).
    await sleep(8000);
    const abortPostStart = Date.now();
    const control = await api('POST', '/v1/control', rootToken, {
      to: member.id,
      id: `abort-${stamp}-${abortPostStart}`,
      cmd: 'pg.abort',
      payload: { v: 1 },
    });
    const abortPostEnd = Date.now();
    const abortPosted = {
      postStart: abortPostStart,
      postEnd: abortPostEnd,
      postStartIso: isoTs(abortPostStart),
      postEndIso: isoTs(abortPostEnd),
      control,
    };
    logJson('phase-b/abort.json', abortPosted);
    logRun(
      `phase B: pg.abort posted at ${abortPosted.postStartIso} (${abortPostEnd - abortPostStart} ms) -> ${JSON.stringify(control)}`,
    );

    const aborted = await waitProbe(
      probePath,
      'agent_settled aborted=true',
      (line) => line.step === 'agent_settled' && line.aborted === true && line.epoch_ms >= abortPostStart,
      30_000,
    );
    const abortEffectiveAt = aborted.epoch_ms;
    logRun(`phase B: aborted settle at ${aborted.ts} (${abortEffectiveAt - abortPostStart} ms after the post)`);

    // One full window after the cut, nothing may start a turn. Sample every second so a
    // delivery anywhere in the interval is caught, not just at its end.
    const windowEnd = abortEffectiveAt + WINDOW_MS;
    const early = [];
    while (Date.now() < windowEnd) {
      const rows = markerEntries(sessionEntries(sessionPath), marker);
      if (rows.length > 0) early.push({ kind: 'custom_message', ...rows[0] });
      const starts = probeLines(probePath).filter(
        (line) => line.step === 'agent_start' && line.epoch_ms > abortEffectiveAt && line.epoch_ms < windowEnd,
      );
      if (starts.length > 0) early.push({ kind: 'agent_start', ...starts[0] });
      if (early.length > 0) break;
      await sleep(1000);
    }
    logRun(
      early.length === 0
        ? `phase B: no turn and no delivery in the ${WINDOW_MS} ms after the cut`
        : `phase B: EARLY activity inside the window: ${JSON.stringify(early)}`,
    );

    const delivered = await waitFor(
      'phase B marker custom_message',
      () => {
        const rows = markerEntries(sessionEntries(sessionPath), marker);
        return rows.length > 0 ? rows : null;
      },
      WINDOW_MS + 60_000,
      250,
    );
    logRun(
      `phase B: custom_message at ${delivered[0].timestamp} (${delivered[0].epoch_ms - abortEffectiveAt} ms after the cut)`,
    );
    const reply = await waitFor(
      'phase B assistant reply',
      () => {
        const rows = assistantMentions(sessionEntries(sessionPath), marker);
        return rows.length > 0 ? rows : null;
      },
      120_000,
      250,
    );
    logRun(`phase B: assistant reply at ${reply[0].timestamp}`);
    await sleep(1500);

    const entries = sessionEntries(sessionPath);
    const calls = bashCalls(entries, 'sleep 120').filter((call) => call.epoch_ms >= abortPostStart - 10 * 60_000);
    const call = calls[calls.length - 1];
    const result = call ? toolResultFor(entries, call.id) : undefined;
    const raw = readFileSync(sessionPath, 'utf8');
    const prefix = `[${response.to}#${response.seq}`;
    const summary = {
      marker,
      prefix,
      posted,
      abortPosted,
      abortSettled: aborted,
      abortEffectiveAt,
      toolCall: call,
      toolResult: result,
      earlyActivity: early,
      delivered: delivered[0],
      deliveredCount: delivered.length,
      deliveredAfterCutMs: delivered[0].epoch_ms - abortEffectiveAt,
      reply: reply[0],
      occurrences: {
        exactPrefix: countOccurrences(raw, prefix),
        markerToken: countOccurrences(raw, marker),
      },
      deltas: {
        arrivalToAbortPost: abortPostStart - Number(response.created_at),
        abortPostToCut: abortEffectiveAt - abortPostStart,
        cutToDelivered: delivered[0].epoch_ms - abortEffectiveAt,
        arrivalToDelivered: delivered[0].epoch_ms - Number(response.created_at),
        deliveredToReply: reply[0].epoch_ms - delivered[0].epoch_ms,
        arrivalToReply: reply[0].epoch_ms - Number(response.created_at),
      },
      adapterView: archiveAdapterView(ADIR, member.id, join(dir, 'adapter-view')),
    };
    logJson('phase-b/summary.json', summary);
    snapshot(dir, sessionPath, probePath);
    results.phaseB = summary;
  }

  await sleep(1000);
  cpSync(sessionPath, join(EVID, 'final-session.jsonl'));
  cpSync(join(EVID, 'probe.jsonl'), join(EVID, 'final-probe.jsonl'));
  archiveAdapterView(ADIR, member.id, join(EVID, 'adapter-view'));
  logJson('summary.json', results);
}

try {
  await main();
} finally {
  await cleanup();
}
