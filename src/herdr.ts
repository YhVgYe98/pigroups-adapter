/**
 * `Herdr`: the only way the adapter leaves its own process (设计说明 §2.2).
 *
 * The real implementation shells out to the `herdr` CLI; every call goes through
 * the interface so `loop.ts` never runs a command itself.
 */

import { execFile } from 'node:child_process';

import { shellQuote, splitCommand } from './command.ts';

export interface HerdrCloseResult {
  /**
   * True when the agent was still listed when the exit wait expired and `pane close`
   * had to cut it off. A pane that was already gone, or whose agent exited within the
   * bound, is a clean close (`forced: false`).
   */
  forced: boolean;
}

export interface Herdr {
  /** Create a pane in the workspace and start a pi in it. Returns the pane id. */
  spawn(opts: { label: string; env: Record<string, string>; cwd?: string }): Promise<{ pane: string }>;
  /** Wait until the agent in that pane is ready/idle. */
  waitReady(pane: string, timeoutMs: number): Promise<void>;
  /** Read the raw text of that pane (diagnostics and reporting only). */
  read(pane: string, lines: number): Promise<string>;
  /**
   * Close the pane. A pane that is already gone is a success, not an error. The result
   * says whether the close was forced past a still-working agent.
   */
  close(pane: string): Promise<HerdrCloseResult>;
}

export interface HerdrCliOptions {
  /** `PIGROUPS_SPAWN_CMD`; defaults to this extension loaded with `pi -ne -e <own path>`. */
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
   * Environment reaches the agent through the pane: `herdr pane split --env`
   * sets it for the process herdr launches in that pane, and `agent start` runs
   * the agent in the same pane.
   *
   * 设计说明 §2.2 leaves one thing unverified: whether `agent start` itself
   * accepts environment. It does not take `--env` in herdr's bundled API schema
   * (only `pane split` / `tab create` do), so if starting the agent fails the
   * fallback below types the env-prefixed command into the pane instead
   * (`herdr pane send-text`) and the interface is unchanged.
   */
  async spawn(opts: { label: string; env: Record<string, string>; cwd?: string }): Promise<{ pane: string }> {
    const pane = await this.splitPane(opts);
    try {
      await this.startAgent(pane, opts.label);
    } catch {
      await this.run(['pane', 'send-text', pane, this.commandLine(opts.env)]);
    }
    return { pane };
  }

  async waitReady(pane: string, timeoutMs: number): Promise<void> {
    // The CLI flag is `--until` (herdr's API: AgentWaitParams.until).
    await this.run(['agent', 'wait', pane, '--until', 'idle', '--timeout', String(timeoutMs)]);
  }

  async read(pane: string, lines: number): Promise<string> {
    const envelope = await this.run(['agent', 'read', pane, '--lines', String(lines)]);
    const read = asRecord(envelope?.read);
    return typeof read?.text === 'string' ? read.text : '';
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

  private async splitPane(opts: { env: Record<string, string>; cwd?: string }): Promise<string> {
    const args = ['pane', 'split', '--direction', 'down', '--no-focus'];
    if (opts.cwd) args.push('--cwd', opts.cwd);
    for (const [key, value] of Object.entries(opts.env)) args.push('--env', `${key}=${value}`);

    const envelope = await this.run(args);
    const pane = asRecord(envelope?.pane);
    const paneId = typeof pane?.pane_id === 'string' ? pane.pane_id : envelope?.pane_id;
    if (typeof paneId !== 'string') throw new Error('herdr pane split returned no pane id');
    return paneId;
  }

  private async startAgent(pane: string, label: string): Promise<void> {
    const argv = splitCommand(this.spawnCmd);
    const executable = argv[0] ?? 'pi';
    if (baseName(executable) !== 'pi') {
      // Not a pi invocation: herdr cannot detect it as an agent, so run it as a
      // plain command line in the pane.
      throw new Error(`unsupported spawn command: ${this.spawnCmd}`);
    }
    const args = ['agent', 'start', label, '--kind', 'pi', '--pane', pane, '--timeout', String(AGENT_START_TIMEOUT_MS)];
    if (argv.length > 1) args.push('--', ...argv.slice(1));
    await this.run(args);
  }

  private commandLine(env: Record<string, string>): string {
    const assigned = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
    return [...assigned, this.spawnCmd].join(' ');
  }

  private async run(args: string[]): Promise<Record<string, unknown> | null> {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.command,
        args,
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
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
