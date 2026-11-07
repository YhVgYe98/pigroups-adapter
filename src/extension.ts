/**
 * Pi extension entry point (设计说明 §1, §8).
 *
 * This file only translates: `pi.registerTool` → `AdapterLoop` methods, pi
 * session events → `PiSurface`. All the behaviour lives in `loop.ts`.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { shellQuote } from './command.ts';
import { AdapterLoop, DEFAULT_DELIVERY_MAX_CHARS } from './loop.ts';
import type { LoopConfig, MemberStatus } from './loop.ts';
import { HerdrCli } from './herdr.ts';
import { logInfo, logWarn, setLogDir } from './log.ts';
import { defaultAdapterDir, findOrgKeyByUrl, isRecordedOrg, recordedOrgUrl, startOrg } from './org.ts';
import type { OrgHandle } from './org.ts';
import { PgClient } from './pgclient.ts';
import { acquireConsumerLease, readSessionRecord } from './records.ts';
import { PiSurfaceAdapter } from './surface.ts';
import type { PiContext, PiLike, PiToolDefinition } from './surface.ts';
import { ADAPTER_VERSION } from './version.ts';

const INSPECT_TIMEOUT_MS = 10_000;

/** The file pi loaded, not a path guessed from cwd or an install location. */
export const EXTENSION_ENTRY = fileURLToPath(import.meta.url);

/**
 * §2.2: a spawned member is a normal pi session, not a disposable worker. The
 * default loads this adapter on top of the operator's own environment: extensions,
 * skills, prompt templates, MCP servers and context files are inherited exactly as
 * if a person had started pi in that pane. `PIGROUPS_SPAWN_CMD` overrides the whole
 * base command; `pg_spawn`'s caller-supplied `args` are appended to it in order,
 * never spliced in and never interpreted here — that is pi's manual's job.
 */
export function defaultSpawnCmd(extensionPath: string = EXTENSION_ENTRY): string {
  return ['pi', '-e', shellQuote(extensionPath)].join(' ');
}

/** The operator's explicit command always wins over the self-loading default. */
export function resolveSpawnCmd(
  env: NodeJS.ProcessEnv = process.env,
  extensionPath: string = EXTENSION_ENTRY,
): string {
  return env.PIGROUPS_SPAWN_CMD ?? defaultSpawnCmd(extensionPath);
}

export default function pigroupsExtension(pi: PiLike): void {
  // Three entry paths, one member session.
  //
  // Configured (概念稿 §7.4): the session was handed an identity, so the twelve member
  // tools exist and `session_start` starts the loop. `pg_org_start` is deliberately
  // NOT registered here: this session already belongs to a platform, and a tool that
  // could conjure a second organisation from inside a member would be a way to end up
  // polling two platforms with one identity (or to orphan the one it belongs to).
  //
  // Recovered (§12.3, §12.5): no environment identity, but this pi session file has a
  // `sessions/<sha1(sessionFile)>.json` record from an earlier start. The tool surface
  // is decided on `session_start`, the first moment `ctx.sessionManager` exists.
  //
  // Unconfigured: exactly one tool, `pg_org_start`. Nothing polls, nothing calls out,
  // and no other tool exists until that tool has succeeded. On success it builds the
  // same member session the configured path builds and starts it on the spot (the
  // `session_start` event has already fired by the time a tool can run).
  const config = readConfig();
  if (config !== null) setLogDir(config.adapterDir);
  let session: MemberSession | undefined;
  let org: OrgHandle | undefined;
  let orgToolRegistered = false;

  if (config !== null) {
    const lease = acquireConsumerLease(config.adapterDir, config.token);
    if (lease === null) {
      logWarn(
        `[pigroups] this member is already open in another session (${config.url}); ` +
          'not registering tools and not polling. Close that pane, then /reload.',
      );
      return;
    }
    try {
      session = openMemberSession(pi, config, lease.release);
    } catch (err) {
      lease.release();
      throw err;
    }
    pi.on('session_start', (_event, ctx) => session?.start(ctx));
  } else {
    // Resolve and pin the root before any tool can fail. Otherwise a failed
    // `pg_org_start` would exit with its diagnostics still in the pre-root buffer.
    setLogDir(defaultAdapterDir());
    const registerOrgStart = (): void => {
      if (orgToolRegistered) return;
      orgToolRegistered = true;
      pi.registerTool({
        name: 'pg_org_start',
        label: 'PiGroups start organisation',
        description:
          'Start a PiGroups organisation and make this session its root. This tool exists only in a ' +
          'session that has no identity yet: a session started with PIGROUPS_URL and PIGROUPS_TOKEN already ' +
          'belongs to a platform, so it is not given this tool at all. It finds the platform checkout ' +
          '(`platform_dir`, else PIGROUPS_PLATFORM_DIR, else ../PiGroups next to the adapter, else ' +
          '../../PiGroups) and verifies it by src/main.ts; a failed lookup lists every candidate it tried. ' +
          'If <adapter dir>/org.json records a healthy organisation it reattaches to that one instead of ' +
          'starting a second platform. Otherwise it starts the platform detached (the organisation outlives ' +
          'this session), waits for /v1/health, bootstraps a root and writes org.json. Idempotent: a second ' +
          'call, from this session or a later one, reattaches. After success the member tools (pg_say, ' +
          'pg_members, pg_spawn, ...) appear and this session is the root; if it fails, the platform it ' +
          'started is stopped again.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name for the root member (the organisation\u2019s first name).' },
            port: {
              type: 'number',
              description:
                'First candidate port for a new platform. The platform keeps the port it bound in its own ' +
                'endpoint record and advances past a candidate that belongs to another service, so this is ' +
                'a starting point, not a guarantee.',
            },
            data_dir: {
              type: 'string',
              description:
                'Where the platform keeps its database and log. Defaults to <adapter dir>/platform-data; ' +
                'reuse the recorded one when the platform process is gone but its organisation should return.',
            },
            platform_dir: {
              type: 'string',
              description: 'PiGroups checkout containing src/main.ts. Overrides PIGROUPS_PLATFORM_DIR and the defaults.',
            },
          },
          additionalProperties: false,
        },
        execute: async (_id, params, signal, _update, ctx) => {
          if (session !== undefined && org !== undefined) {
            // The loop already runs; a second start would create a second polling
            // identity against the same token (platform poll is single-consumer).
            return text(JSON.stringify({ already_member: true, ...orgAnswer(org, true) }, null, 2));
          }
          const started = await startOrg({
            name: typeof params.name === 'string' && params.name !== '' ? params.name : undefined,
            port: optionalPort(params.port),
            dataDir: typeof params.data_dir === 'string' && params.data_dir !== '' ? params.data_dir : undefined,
            platformDir:
              typeof params.platform_dir === 'string' && params.platform_dir !== '' ? params.platform_dir : undefined,
            signal,
          });
          org = started;
          const adapterDir = defaultAdapterDir();
          setLogDir(adapterDir);
          const lease = acquireConsumerLease(adapterDir, started.token);
          if (lease === null) {
            logWarn(
              `[pigroups] this root is already open in another session (${started.url}); ` +
                'not registering tools and not polling. Close that pane, then /reload.',
            );
            return text(
              JSON.stringify(
                {
                  already_member: false,
                  leased: false,
                  url: started.url,
                  note: 'another session already consumes this root token; close it and /reload',
                },
                null,
                2,
              ),
            );
          }
          const config = loopConfig(started.url, started.token, process.env, started.orgKey);
          config.parentId = null;
          config.ensurePlatform = async () =>
            (await startOrg({ adapterDir, name: started.orgKey, mayBootstrap: false })).url;
          try {
            session = openMemberSession(pi, config, lease.release);
          } catch (err) {
            lease.release();
            throw err;
          }
          session.start(ctx);
          return text(JSON.stringify({ already_member: false, ...orgAnswer(started, started.reattached) }, null, 2));
        },
      });
    };

    pi.on('session_start', async (_event, ctx) => {
      if (session !== undefined) return;
      // §12.3: the session file is the only identity a manually resumed pi knows.
      // A record is a full member: the twelve tools, no pg_org_start, and no way to
      // start the platform unless this session is the root.
      const sessionFile = sessionFileOf(ctx);
      const adapterDir = defaultAdapterDir();
      setLogDir(adapterDir);
      const saved = sessionFile === undefined ? undefined : readSessionRecord(adapterDir, sessionFile);
      if (saved !== undefined) {
        const lease = acquireConsumerLease(adapterDir, saved.token);
        if (lease === null) {
          logWarn(
            `[pigroups] this member is already open in another session (${saved.orgUrl}); ` +
              'not registering tools and not polling. Close that pane, then /reload.',
          );
          return;
        }

        const orgKey = saved.orgKey ?? findOrgKeyByUrl(adapterDir, saved.orgUrl);
        const url = recordedOrgUrl(adapterDir, orgKey) ?? saved.orgUrl;
        const config = loopConfig(url, saved.token, process.env, orgKey);
        config.parentId = saved.parentId;
        // Only a record that says root may bring its platform back. The ensure runs
        // from the loop's PgUnavailable path, never from this handler.
        if (saved.parentId === null && orgKey !== undefined && isRecordedOrg(adapterDir, orgKey)) {
          config.ensurePlatform = async () =>
            (await startOrg({ adapterDir, name: orgKey, mayBootstrap: false })).url;
        } else if (saved.parentId === null) {
          logWarn(
            `[pigroups] root record ${saved.memberId} names no organisation record; ` +
              'it will poll its recorded URL but cannot restart the platform',
          );
        }
        try {
          session = openMemberSession(pi, config, lease.release);
        } catch (err) {
          lease.release();
          throw err;
        }
        session.start(ctx);
        return;
      }
      registerOrgStart();
    });
  }

  pi.on('session_tree', (_event, ctx) => session?.start(ctx));

  pi.on('session_shutdown', async () => {
    const active = session;
    session = undefined;
    if (!active) return;
    await active.stop();
  });
}

/**
 * One member session: the PiSurface, the platform client, the herdr CLI, the twelve
 * member tools, and the loop. Building it twice would register the same tools twice
 * and run two polls of one identity, so `start()` is idempotent.
 */
interface MemberSession {
  start(ctx: PiContext): void;
  stop(): Promise<void>;
}

function openMemberSession(pi: PiLike, config: LoopConfig, releaseLease: () => void): MemberSession {
  setLogDir(config.adapterDir);
  const surface = new PiSurfaceAdapter(pi);
  const pg = new PgClient({ url: config.url, token: config.token });
  const herdr = new HerdrCli({ spawnCmd: config.spawnCmd });

  let loop: AdapterLoop | undefined;
  let statusCtx: PiContext | undefined;
  let lastStatus: MemberStatus | undefined;
  let statusActive = true;
  const applyStatus = (status: MemberStatus): void => {
    if (!statusActive) return;
    lastStatus = status;
    renderStatus(statusCtx, status);
  };
  config.onStatus = applyStatus;

  for (const tool of buildTools(() => loop, pg, surface)) pi.registerTool(tool);

  return {
    start(ctx: PiContext): void {
      statusCtx = ctx;
      // `session_start` installs the first context; a `session_tree` jump replaces it
      // with a fresh one. Attach before deciding whether the loop exists: a delivery
      // that is queued during a jump must never reach the invalidated context.
      surface.attachContext(ctx);
      if (loop) {
        // Idempotent. If the first startup never became ready, this also retries the
        // identity/records handshake; a tree jump is a new chance to repair the session.
        loop.start();
        if (lastStatus !== undefined) renderStatus(statusCtx, lastStatus);
        return;
      }
      // The one startup line: which adapter this member is running, and against what.
      logInfo(`[pigroups] adapter ${ADAPTER_VERSION} starting against ${config.url}`);
      loop = new AdapterLoop({ pg, surface, herdr, config, now: () => Date.now(), sessionFile: sessionFileOf(ctx) });
      loop.start();
    },
    async stop(): Promise<void> {
      const active = loop;
      loop = undefined;
      statusActive = false;
      // The status line belongs to this session; remove it before waiting for anything.
      try {
        statusCtx?.ui?.setStatus('pigroups', undefined);
      } catch {
        // A gone TUI is not an error on shutdown.
      }
      // §8.6: nothing is sent. The heartbeat stops with the loop, and the parent's
      // liveness check observes the absence (§5.4). The consumer lease is released
      // last: the old loop must not overlap a new incarnation.
      try {
        if (active) await active.stop();
      } finally {
        releaseLease();
      }
    },
  };
}

function orgAnswer(org: OrgHandle, reattached: boolean): Record<string, unknown> {
  return {
    reattached,
    url: org.url,
    root: org.root,
    data_dir: org.dataDir,
    // Where this organisation's record lives. Two roots on one machine are two
    // records under <adapter dir>/orgs/<key>/, and a person debugging needs the path.
    org_file: org.orgFile,
    ...(org.platformDir === undefined ? {} : { platform_dir: org.platformDir }),
    pid: org.pid,
  };
}

function optionalPort(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`port must be an integer between 1 and 65535, got ${String(raw)}`);
  }
  return port;
}

/** `ReadonlySessionManager.getSessionFile()`; absent in old pi versions and before a file exists. */
function sessionFileOf(ctx: PiContext): string | undefined {
  const file = ctx.sessionManager?.getSessionFile();
  return typeof file === 'string' && file !== '' ? file : undefined;
}

function readConfig(): LoopConfig | null {
  const url = process.env.PIGROUPS_URL;
  const token = process.env.PIGROUPS_TOKEN;
  if (!url || !token) return null;
  return loopConfig(url, token);
}

/** The same wiring for both paths: a configured member and one that just started an org. */
export function loopConfig(url: string, token: string, env: NodeJS.ProcessEnv = process.env, orgKey?: string): LoopConfig {
  const key = orgKey ?? env.PIGROUPS_ORG_KEY;
  return {
    url,
    token,
    adapterDir: defaultAdapterDir(env),
    ...(key === undefined || key === '' ? {} : { orgKey: key }),
    pollLimit: envInt(env, 'PIGROUPS_POLL_LIMIT', 20),
    pollWait: envInt(env, 'PIGROUPS_POLL_WAIT', 25),
    deliveryMaxChars: envInt(env, 'PIGROUPS_DELIVERY_MAX_CHARS', DEFAULT_DELIVERY_MAX_CHARS),
    attentionToolMs: envInt(env, 'PIGROUPS_ATTENTION_TOOL_MS', 300_000),
    // §5.4: the member feeds its heartbeat on the timer; the parent judges absence by
    // how many of those intervals may pass. The floor keeps a mistyped knob from either
    // beating on every tick or treating the first interval as already missed.
    heartbeatMs: Math.max(1_000, envInt(env, 'PIGROUPS_HEARTBEAT_MS', 15_000)),
    heartbeatMiss: Math.max(1, envInt(env, 'PIGROUPS_HEARTBEAT_MISS', 3)),
    remindWindowMs: envInt(env, 'PIGROUPS_REMIND_WINDOW_MS', 300_000),
    nudgeMax: envInt(env, 'PIGROUPS_NUDGE_MAX', 3),
    // 概念稿 §8.1 / §13.3: the tumbling delivery window. 60 s covers two 25 s polls, so
    // a window usually sees a whole batch; `tick()` (5 s) checks when it expires.
    deliveryWindowMs: envInt(env, 'PIGROUPS_DELIVERY_WINDOW_MS', 60_000),
    spawnReadyMs: envInt(env, 'PIGROUPS_SPAWN_READY_MS', 120_000),
    // §12.5: the automatic repair waits this long after startup before starting anything.
    respawnGraceMs: envInt(env, 'PIGROUPS_RESPAWN_GRACE_MS', 30_000),
    autoRespawn: envBool(env, 'PIGROUPS_AUTO_RESPAWN', true),
    spawnCmd: resolveSpawnCmd(env),
  };
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  return fallback;
}

function buildTools(
  getLoop: () => AdapterLoop | undefined,
  pg: PgClient,
  surface: PiSurfaceAdapter,
): PiToolDefinition[] {
  const requireLoop = (): AdapterLoop => {
    const loop = getLoop();
    if (!loop) throw new Error('pigroups adapter is not running in this session');
    return loop;
  };

  return [
    {
      name: 'pg_members',
      label: 'PiGroups members',
      description:
        'The live roster: id, name, parent_id, parent_name, relation (self|parent|child|sibling|peer), ' +
        'child_count and last_seen_at for every living member. `query` is a case-insensitive substring ' +
        'over the name — names are the only handle; ids are opaque. `total` is the roster size before ' +
        'filtering and `matched` is the number of rows returned, so `total: 23, matched: 0` means the ' +
        'query missed, not that nobody exists. `last_seen_at` is the last time that member ' +
        'authenticated — NOT liveness (the roster already lists only living members). Only a `child` ' +
        'can be aborted; a `peer` can only be messaged.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Case-insensitive substring of the member name.' },
        },
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const query = typeof params.query === 'string' ? params.query : undefined;
        const roster = await requireLoop().members(query);
        return text(JSON.stringify(roster, null, 2));
      },
    },
    {
      name: 'pg_say',
      label: 'PiGroups say',
      description: 'Send a message to a group (`g:<owner>`) or to a member id. Clears the owed reply for that conversation.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '`g:<owner>` or a member id.' },
          text: { type: 'string', description: 'Message body.' },
          mentions: { type: 'array', items: { type: 'string' }, description: 'Member ids, or ["all"].' },
        },
        required: ['to', 'text'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const mentions = Array.isArray(params.mentions) ? params.mentions.map(String) : undefined;
        const sent = await requireLoop().say(String(params.to), String(params.text), mentions);
        return text(JSON.stringify(sent));
      },
    },
    {
      name: 'pg_ack',
      label: 'PiGroups ack',
      description:
        'Confirm an owed conversation without sending anything: the owed flag goes, no message is ' +
        'written and no new debt appears at the other end. This is the way to close a notification you ' +
        'do not intend to answer. `conv` is required; clearing every owed conversation needs an ' +
        'explicit `all: true`. `seq` may not exceed the largest seq this adapter delivered or named ' +
        'in that conversation — call `pg_read` first to confirm something newer. An ack keeps the ' +
        'nudge budget and the blocked episode as they are: three confirmations in a row without a ' +
        'reply are reported to the parent as `silent acking`.',
      parameters: {
        type: 'object',
        properties: {
          conv: { type: 'string', description: 'Conversation id (`dm:<a>_<b>` or `g:<owner>`).' },
          seq: {
            type: 'number',
            description: 'The seq being confirmed; must not exceed what this adapter delivered or named.',
          },
          all: {
            type: 'boolean',
            description: 'Clear every owed conversation. Must be explicit; never the default.',
          },
        },
        required: ['conv'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const result = await requireLoop().ack({
          // A missing `conv` must reach the loop as "missing": `String(undefined)` is the
          // conversation named "undefined", and the loop cannot refuse that (§4.3).
          conv: typeof params.conv === 'string' ? params.conv : '',
          seq: typeof params.seq === 'number' ? params.seq : undefined,
          all: params.all === true,
        });
        return text(JSON.stringify(result));
      },
    },
    {
      name: 'pg_children',
      label: 'PiGroups children',
      description:
        'Telemetry snapshot of this member’s direct children (state, since, tool, count) including what ' +
        'each one’s last round did (last assistant text and last tool call).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_id, _params, signal) =>
        text(JSON.stringify(await requireLoop().children(signal), null, 2)),
    },
    {
      name: 'pg_inspect',
      label: 'PiGroups inspect',
      description:
        'Ask a member (usually a direct child) for its current phase, tool, owed replies, children, and ' +
        'its last round: the last assistant text and the last tool call (name, args preview, ok).',
      parameters: {
        type: 'object',
        properties: { member: { type: 'string', description: 'Member id to inspect.' } },
        required: ['member'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const member = String(params.member);
        const result = await requireLoop().inspect(member, INSPECT_TIMEOUT_MS);
        return text(JSON.stringify(result, null, 2));
      },
    },
    {
      name: 'pg_abort',
      label: 'PiGroups abort',
      description: 'Send pg.abort to a member, or cut this session’s own running turn when no member is given.',
      parameters: {
        type: 'object',
        properties: { member: { type: 'string', description: 'Member id; omit to abort yourself.' } },
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const member = typeof params.member === 'string' ? params.member : undefined;
        if (!member) {
          await surface.abort();
          return text('aborted');
        }
        await pg.sendControl({ to: member, id: randomUUID(), cmd: 'pg.abort', payload: { v: 1 } });
        return text(`pg.abort sent to ${member}`);
      },
    },
    {
      name: 'pg_schedule',
      label: 'PiGroups schedule',
      description:
        'Wake this member once, `after_seconds` from now (at least 5 s, at most 24 h): the adapter ' +
        'delivers `[scheduled] note` and starts a turn. One-shot, never periodic. At most 8 wakes may be ' +
        'pending; the 9th is rejected. In memory only — a restart drops every pending wake. It does not ' +
        'bypass the delivery window, so the wake may arrive up to one window after the delay.',
      parameters: {
        type: 'object',
        properties: {
          after_seconds: { type: 'number', description: 'Delay in seconds (5 to 86400).' },
          note: { type: 'string', description: 'The line to deliver, prefixed with `[scheduled]`.' },
        },
        required: ['after_seconds', 'note'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const after = Number(params.after_seconds);
        const result = requireLoop().schedule(after, String(params.note));
        return text(JSON.stringify(result));
      },
    },
    {
      name: 'pg_read',
      label: 'PiGroups read',
      description: 'Read conversation history backwards, e.g. to backfill a gap or re-read the briefing.',
      parameters: {
        type: 'object',
        properties: {
          conv: { type: 'string', description: 'Conversation id (`g:<owner>` or `dm:<a>_<b>`).' },
          before: { type: 'number', description: 'Read messages before this seq.' },
          limit: { type: 'number', description: 'How many messages (max 200).' },
        },
        required: ['conv'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const conv = typeof params.conv === 'string' ? params.conv : '';
        const before = typeof params.before === 'number' ? params.before : undefined;
        const limit = typeof params.limit === 'number' ? params.limit : undefined;
        // §4.3: reading is the documented way to make a later seq confirmable, so the read
        // has to go through the loop — the ledger is the half that knows what was seen.
        return text(await requireLoop().read({ conv, before, limit }));
      },
    },
    {
      name: 'pg_spawn',
      label: 'PiGroups spawn',
      description:
        'Create a child member, send it the brief as a direct message, and start it in a new herdr pane. ' +
        '`args` is a raw pi argv tail for this one child: appended to the configured spawn command in order, ' +
        'not validated or rewritten by the adapter, so the caller decides how pi starts (including flags ' +
        'that change its mode). Do not guess pi flags from this schema; when a flag is unknown, run `pi --help` ' +
        'and read pi’s own manual.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional member name.' },
          brief: { type: 'string', description: 'Task brief, sent as the first direct message.' },
          cwd: { type: 'string', description: 'Working directory for the child.' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Raw pi argv appended after the base command, in order, one array element per argv word ' +
              '(e.g. ["--model", "vendor/model"]). Not sanitised: a caller can pass `-p` or `--` and change ' +
              'how the child starts. `pi --help` lists the flags.',
          },
        },
        required: ['brief'],
        additionalProperties: false,
      },
      execute: async (_id, params, signal) => {
        const spawned = await requireLoop().spawnMember({
          signal,
          name: typeof params.name === 'string' ? params.name : undefined,
          brief: String(params.brief),
          cwd: typeof params.cwd === 'string' ? params.cwd : undefined,
          args: Array.isArray(params.args) ? params.args.map(String) : undefined,
        });
        return text(JSON.stringify(spawned));
      },
    },
    {
      name: 'pg_terminate',
      label: 'PiGroups terminate',
      description: 'Delete a child subtree (`DELETE /v1/members/{id}`); the platform cascades.',
      parameters: {
        type: 'object',
        properties: { member: { type: 'string', description: 'Member id to delete.' } },
        required: ['member'],
        additionalProperties: false,
      },
      execute: async (_id, params) => {
        const result = await requireLoop().terminate(String(params.member));
        // The delete is committed either way. `pane_close_failed` is the cleanup that
        // did not happen yet (herdr down, a timeout); `pane_close_forced` names panes
        // that were closed while their agent was still running. Reporting both in the
        // same answer keeps the tool honest without pretending the delete failed (§5.3).
        return text(JSON.stringify(result));
      },
    },
    {
      name: 'pg_respawn',
      label: 'PiGroups respawn',
      description:
        'Reopen this member’s direct children whose processes are gone (design §12). The caller’s position ' +
        'in the tree defines the scope: every recorded direct child is considered, and a started or running ' +
        'child is sent pg.respawn so it repairs its own children in turn. Herdr pane presence is the only ' +
        'evidence a child is already running: a pane carrying its session file gets the control; a missing ' +
        'pane is started from the recorded session file and token; an unreadable pane list never starts a ' +
        'process. A gone member is unrecoverable, a terminated one is skipped, and a live token is never ' +
        'reissued. The automatic startup pass uses the same rule after a settle; this tool acts immediately.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => text(JSON.stringify(await requireLoop().respawn(), null, 2)),
    },
    {
      name: 'pg_whoami',
      label: 'PiGroups whoami',
      description: 'Platform coordinates plus this adapter’s own state (owed conversations and nudge counts).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        const who = await pg.whoami();
        const loop = getLoop();
        // `adapter_version` is this adapter; `who.server.version` is the platform. Both
        // are in the answer so a person can tell which pair a member is running (§5.3).
        return text(JSON.stringify({ adapter_version: ADAPTER_VERSION, who, adapter: loop?.state() ?? null }, null, 2));
      },
    },
  ];
}

function text(value: string): { content: { type: 'text'; text: string }[]; details?: unknown } {
  return { content: [{ type: 'text', text: value }] };
}

export interface StatusTheme {
  bold?(text: string): string;
}

/**
 * One footer line: `PG name(id) · root → … → name (n kids)`. The self name is bold when
 * the active theme supports it; a missing theme must not change the text's identity.
 */
export function formatStatus(status: MemberStatus, theme?: StatusTheme): string {
  const bold = (value: string): string => theme?.bold?.(value) ?? value;
  const path = status.path.length === 0 ? [status.name] : status.path;
  const renderedPath = path
    .map((name, index) => (index === path.length - 1 ? bold(name) : name))
    .join(' → ');
  const kids = status.childCount === 1 ? '1 kid' : `${status.childCount} kids`;
  return `PG ${bold(status.name)}(${status.id}) · ${renderedPath} (${kids})`;
}

function renderStatus(ctx: PiContext | undefined, status: MemberStatus): void {
  const ui = ctx?.ui;
  if (ui === undefined) return;
  try {
    ui.setStatus('pigroups', formatStatus(status, ui.theme));
  } catch {
    // The footer is cosmetic; a failed render must never affect the agent loop.
  }
}
