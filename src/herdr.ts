/**
 * `Herdr`: the only way the adapter leaves its own process (设计说明 §2.2).
 *
 * The real implementation shells out to the `herdr` CLI; every call goes through
 * the interface so `loop.ts` never runs a command itself.
 */

import { execFile } from 'node:child_process';

import { shellQuote, splitCommand } from './command.ts';
import { logWarn } from './log.ts';

export interface HerdrCloseResult {
  /**
   * True when the agent was still listed when the exit wait expired and `pane close`
   * had to cut it off. A pane that was already gone, or whose agent exited within the
   * bound, is a clean close (`forced: false`).
   */
  forced: boolean;
}

/** One pane as `pane list` reports it, reduced to the fields the adapter acts on. */
export interface HerdrPane {
  pane_id: string;
  /**
   * The agent herdr attributes to this pane. For pi, `kind` is `path` and `value` is the
   * session file the pane is running - the identity that survives a parent restart.
   */
  agent_session?: {
    kind?: string;
    source?: string;
    value?: string;
  };
  agent_status?: string;
  tab_id?: string;
  /** The tab label when herdr supplies one; fallback identity when no session file exists. */
  label?: string;
  /** The terminal title, which carries the label as `π - <label> - <cwd>`. */
  title?: string;
}

export interface Herdr {
  /** Create a tab in the workspace and start a pi in its root pane. Returns the pane id. */
  spawn(opts: {
    label: string;
    env: Record<string, string>;
    cwd?: string;
    /** Extra pi argv appended to the configured spawn command (already split into words). */
    args?: string[];
    /** Cancels the herdr calls; the started process, if any, keeps running. */
    signal?: AbortSignal;
  }): Promise<{ pane: string }>;
  /** Wait until herdr recognises an agent in that pane (any state except unknown). */
  waitReady(pane: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  /** Read the raw text of that pane (diagnostics and reporting only). */
  read(pane: string, lines: number): Promise<string>;
  /**
   * Every pane in the workspace, with the session file herdr attributes to its agent.
   * A list that cannot be read is `null` plus a warning, never a throw: `null` means
   * "could not ask", which is not the same fact as "no pane".
   */
  listPanes(): Promise<HerdrPane[] | null>;
  /**
   * Close the pane. A pane that is already gone is a success, not an error. The result
   * says whether the close was forced past a still-working agent.
   */
  close(pane: string): Promise<HerdrCloseResult>;
}

export interface HerdrCliOptions {
  /** `PIGROUPS_SPAWN_CMD`; defaults to `pi -e <own path>`. Extra spawn args are appended. */
  spawnCmd: string;
  /** The executable to run, default `herdr` on PATH. */
  command?: string;
  /** Test seam: override the agent-exit bound; production uses `PANE_AGENT_EXIT_TIMEOUT_MS`. */
  paneAgentExitTimeoutMs?: number;
  /** Test seam: override the agent-exit poll interval. */
  paneAgentExitPollMs?: number;
}

/** `agent start` waits for the agent to become interactive. */
const AGENT_START_TIMEOUT_MS = 120_000;
/** How long to wait between `agent start` attempts while the new tab's shell prints its prompt. */
const AGENT_START_RETRY_MS = 250;
const COMMAND_TIMEOUT_MS = 180_000;
/**
 * How long `close()` waits for the pane's agent to leave before it closes the pane.
 * The child must consume `sys.terminated`, run its own shutdown handler and write its
 * session file; closing the pane first cuts that off. The bound is the hard stop: a
 * child that never exits loses its pane at the end of the wait.
 */
const PANE_AGENT_EXIT_TIMEOUT_MS = 5000;
const PANE_AGENT_EXIT_POLL_MS = 200;

export class HerdrCli implements Herdr {
  private readonly spawnCmd: string;
  private readonly command: string;
  private readonly paneAgentExitTimeoutMs: number;
  private readonly paneAgentExitPollMs: number;

  constructor(opts: HerdrCliOptions) {
    this.spawnCmd = opts.spawnCmd;
    this.command = opts.command ?? 'herdr';
    this.paneAgentExitTimeoutMs = opts.paneAgentExitTimeoutMs ?? PANE_AGENT_EXIT_TIMEOUT_MS;
    this.paneAgentExitPollMs = opts.paneAgentExitPollMs ?? PANE_AGENT_EXIT_POLL_MS;
  }

  /**
   * Environment reaches the agent through the tab: `herdr tab create --env`
   * sets it for the process herdr launches in that pane, and `agent start` runs
   * the agent in the same pane.
   *
   * 设计说明 §2.2 leaves one thing unverified: whether `agent start` itself
   * accepts environment. It does not take `--env` in herdr's bundled API schema
   * (only `pane split` / `tab create` do), so if starting the agent fails the
   * fallback below types the env-prefixed command into the pane instead
   * (`herdr pane send-text`) and the interface is unchanged.
   */
  async spawn(opts: {
    label: string;
    env: Record<string, string>;
    cwd?: string;
    args?: string[];
    signal?: AbortSignal;
  }): Promise<{ pane: string }> {
    const pane = await this.createTab({ env: opts.env, cwd: opts.cwd, label: opts.label, signal: opts.signal });
    const extraArgs = opts.args ?? [];
    const argv = [...splitCommand(this.spawnCmd), ...extraArgs];
    if (baseName(argv[0] ?? 'pi') === 'pi') {
      // The normal path: herdr recognises the agent, so `agent wait` and `agent list` mean
      // something. If this fails, fail - do NOT fall back to typing the command line.
      //
      // The fallback used to type it into the pane. When the pane already held a running pi
      // (the tab's shell had been replaced, or `agent start` failed for a reason unrelated to
      // the process), the text landed in that pi's input box - the operator saw
      // "PIGROUPS_URL=… pi -e …" appear in a conversation. A failed start is a failure, and
      // the caller can close the tab it just made.
      await this.startAgentWhenShellIsReady(pane, opts.label, extraArgs, argv);
      return { pane };
    }
    // A wrapper or a non-pi command: herdr cannot track it, so the only way to run it is to
    // type it. Do that in a pane that has no agent, so the text cannot reach somebody's prompt.
    await this.waitPaneHasNoAgent(pane, this.paneAgentExitTimeoutMs);
    await this.run(['pane', 'send-text', pane, this.commandLine(opts.env, extraArgs)]);
    return { pane };
  }

  async waitReady(pane: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    // The CLI flag is `--until` (herdr's API: AgentWaitParams.until) and it may be
    // repeated. Do not wait for one label: the brief is sent before the pane starts, so
    // a healthy child has usually already finished (or is in) its first turn, and herdr
    // reports a finished turn as `done`, not `idle`. Waiting only for `idle` times out
    // on that child (probe/logs/spawn-args-20261101T142926/ready-probe/).
    //
    // Every state except `unknown` means herdr has recognised an agent in that pane, and that
    // is the only thing this method now answers - it no longer decides whether the member is
    // ready (D1 does, with the platform's `last_seen_at`). `working` therefore belongs in the
    // list: a child that starts its first turn immediately is the normal case, and leaving it
    // out made a healthy spawn time out after SPAWN_READY_MS.
    await this.run([
      'agent',
      'wait',
      pane,
      '--until',
      'idle',
      '--until',
      'done',
      '--until',
      'blocked',
      '--until',
      'working',
      '--timeout',
      String(timeoutMs),
    ], signal);
  }

  async read(pane: string, lines: number): Promise<string> {
    const envelope = await this.run(['agent', 'read', pane, '--lines', String(lines)]);
    const read = asRecord(envelope?.read);
    return typeof read?.text === 'string' ? read.text : '';
  }

  async listPanes(): Promise<HerdrPane[] | null> {
    let envelope: Record<string, unknown> | null;
    try {
      envelope = await this.run(['pane', 'list']);
    } catch (err) {
      // `null` keeps the call non-throwing (cleanup for a committed delete relies on
      // that) while still telling a caller that herdr could not answer. A caller that
      // treats this as "no pane" would start a second process on a living identity.
      logWarn(`[pigroups] could not read herdr pane list: ${(err as Error)?.message ?? String(err)}`);
      return null;
    }
    const panes = envelope?.panes;
    if (!Array.isArray(panes)) {
      logWarn('[pigroups] herdr pane list returned no pane array');
      return null;
    }
    const result: HerdrPane[] = [];
    for (const item of panes) {
      const record = asRecord(item);
      const paneId = typeof record?.pane_id === 'string' ? record.pane_id : undefined;
      if (paneId === undefined) continue;
      const pane: HerdrPane = { pane_id: paneId };
      const session = asRecord(record?.agent_session);
      if (session !== undefined) {
        const kind = typeof session.kind === 'string' ? session.kind : undefined;
        const source = typeof session.source === 'string' ? session.source : undefined;
        const value = typeof session.value === 'string' ? session.value : undefined;
        if (kind !== undefined || source !== undefined || value !== undefined) {
          pane.agent_session = {
            ...(kind === undefined ? {} : { kind }),
            ...(source === undefined ? {} : { source }),
            ...(value === undefined ? {} : { value }),
          };
        }
      }
      if (typeof record?.agent_status === 'string') pane.agent_status = record.agent_status;
      if (typeof record?.tab_id === 'string') pane.tab_id = record.tab_id;
      const title =
        typeof record?.terminal_title_stripped === 'string'
          ? record.terminal_title_stripped
          : typeof record?.terminal_title === 'string'
            ? record.terminal_title
            : typeof record?.title === 'string'
              ? record.title
              : undefined;
      if (title !== undefined) pane.title = title;
      const label =
        typeof record?.label === 'string'
          ? record.label
          : typeof record?.tab_label === 'string'
            ? record.tab_label
            : undefined;
      if (label !== undefined) pane.label = label;
      result.push(pane);
    }
    return result;
  }

  async close(pane: string): Promise<HerdrCloseResult> {
    // The platform has already marked the member gone and sent `sys.terminated`. Give
    // that pi time to consume it and finish its own shutdown before the hard close;
    // otherwise the pane disappears under a session that is still writing its file.
    const forced = await this.waitForAgentExit(pane);
    try {
      await this.run(['pane', 'close', pane]);
    } catch (err) {
      // The pane is the shell the child left behind. If it is already gone — closed by
      // hand, or its shell exited — the outcome close() wants is already true. This is
      // a delivered fact, not a failure: it must not turn a committed delete into an
      // error the caller retries forever (loop.ts §5.3).
      if (err instanceof HerdrCommandError && err.code === 'pane_not_found') return { forced };
      throw err;
    }
    return { forced };
  }

  /**
   * Poll `pane list` until the pane is gone or its agent has exited (herdr drops the
   * `agent` key and reports `agent_status: unknown` once the process is gone). A list
   * that fails is not a reason to wait: `close` is the hard stop the concept allows.
   * Returns whether the bound expired with the agent still listed.
   */
  private async waitForAgentExit(pane: string): Promise<boolean> {
    const deadline = Date.now() + this.paneAgentExitTimeoutMs;
    for (;;) {
      try {
        if (!agentStillRunning(await this.run(['pane', 'list']), pane)) return false;
      } catch {
        return false;
      }
      if (Date.now() >= deadline) return true;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.paneAgentExitPollMs);
      });
    }
  }

  /**
   * A member gets its own tab in the same workspace, not a pane beside whatever the operator
   * was looking at: a teammate running for minutes should not squeeze the work the human is
   * doing. `tab create` carries the same `--cwd` / `--env` as `pane split` and answers with the
   * tab's root pane, which is the pane the agent goes into.
   */
  private async createTab(opts: { env: Record<string, string>; cwd?: string; label: string; signal?: AbortSignal }): Promise<string> {
    const args = ['tab', 'create', '--no-focus', '--label', opts.label];
    // Without --workspace herdr puts the tab in the FOCUSED workspace, not the caller's. A
    // member therefore landed wherever the operator happened to be looking: the same
    // organisation ended up spread over two workspaces, with the same role names twice. The
    // pane's own environment knows the answer.
    const workspace = this.workspaceId();
    if (workspace !== undefined) args.push('--workspace', workspace);
    if (opts.cwd) args.push('--cwd', opts.cwd);
    for (const [key, value] of Object.entries(opts.env)) args.push('--env', `${key}=${value}`);

    const envelope = await this.run(args, opts.signal);
    const root = asRecord(envelope?.root_pane);
    const paneId = typeof root?.pane_id === 'string' ? root.pane_id : undefined;
    if (paneId === undefined) throw new Error('herdr tab create returned no root pane id');
    return paneId;
  }

  /** The workspace this adapter's own process lives in, from herdr's pane environment. */
  private workspaceId(): string | undefined {
    const fromEnv = process.env.HERDR_WORKSPACE_ID;
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
    // Older herdr builds only export the pane id; derive the workspace from its prefix (wE:p3).
    const pane = process.env.HERDR_PANE_ID;
    if (typeof pane === 'string') {
      const cut = pane.indexOf(':');
      if (cut > 0) return pane.slice(0, cut);
    }
    return undefined;
  }

  /** Wait until herdr shows no agent in that pane (the shell is free to receive a command). */
  private async waitPaneHasNoAgent(pane: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (!agentStillRunning(await this.run(['pane', 'list']), pane)) return;
      } catch {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`pane ${pane} still holds an agent; refusing to type into it`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.paneAgentExitPollMs);
      });
    }
  }

  /**
   * `agent start` requires the pane to be sitting at an interactive shell prompt, and a tab
   * that was just created is not there yet: it returns immediately, the shell takes a beat to
   * print its prompt. Calling `agent start` in that window fails, and that failure used to send
   * the command line into the pane as a fallback - the text the operator saw appear in a
   * conversation. Wait for the pane to exist, then retry the start a few times before giving up.
   */
  private async startAgentWhenShellIsReady(
    pane: string,
    label: string,
    extraArgs: string[],
    argv: string[],
  ): Promise<void> {
    const deadline = Date.now() + AGENT_START_TIMEOUT_MS;
    let lastError: unknown;
    for (;;) {
      try {
        await this.startAgent(pane, label, extraArgs, argv);
        return;
      } catch (err) {
        lastError = err;
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, AGENT_START_RETRY_MS);
      });
    }
    throw lastError instanceof Error ? lastError : new Error(`could not start the agent in ${pane}`);
  }

  private async startAgent(pane: string, label: string, extraArgs: string[], argv: string[]): Promise<void> {
    const args = ['agent', 'start', label, '--kind', 'pi', '--pane', pane, '--timeout', String(AGENT_START_TIMEOUT_MS)];
    if (argv.length > 1) args.push('--', ...argv.slice(1));
    await this.run(args);
  }

  private commandLine(env: Record<string, string>, extraArgs: string[]): string {
    const assigned = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
    return [...assigned, this.spawnCmd, ...extraArgs.map(shellQuote)].join(' ');
  }

  private async run(args: string[], signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.command,
        args,
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, ...(signal === undefined ? {} : { signal }) },
        (error, out, errOut) => {
          if (error) {
            // herdr writes its error envelope to stderr and exits non-zero (`herdr
            // pane close <missing>` → `{"error":{"code":"pane_not_found",…}}`,
            // exit 1). Keep the code typed so `close()` can recognise the one
            // failure that is really a success.
            const envelope = parseEnvelope(errOut) ?? parseEnvelope(out);
            const detail = asRecord(envelope?.error);
            const code = typeof detail?.code === 'string' ? detail.code : undefined;
            const message = typeof detail?.message === 'string' ? detail.message : error.message;
            reject(new HerdrCommandError(message, code, errOut || out));
            return;
          }
          resolve(out);
        },
      );
    });
    return parseEnvelope(stdout);
  }
}

/** Non-zero exit from `herdr`, with the `code` from its error envelope when it printed one. */
export class HerdrCommandError extends Error {
  readonly code: string | undefined;
  readonly output: string;
  constructor(message: string, code: string | undefined, output: string) {
    super(message);
    this.name = 'HerdrCommandError';
    this.code = code;
    this.output = output;
  }
}

/** herdr prints a JSON envelope `{id, result}`; older builds print plain text. */
function parseEnvelope(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  const candidates = [trimmed, ...trimmed.split('\n').reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      return asRecord(record.result) ?? record;
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return null;
}

/**
 * Whether a `pane list` answer still shows this pane's agent running. A pane that is
 * absent from the list is already gone, and an entry without `agent` (or with
 * `agent_status: "unknown"`) is the shell herdr leaves after the agent exits.
 */
function agentStillRunning(envelope: Record<string, unknown> | null, pane: string): boolean {
  const panes = envelope?.panes;
  if (!Array.isArray(panes)) return false;
  const entry = panes.find((item) => asRecord(item)?.pane_id === pane);
  const record = asRecord(entry);
  if (record === undefined) return false;
  return record.agent !== undefined && record.agent_status !== 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}
