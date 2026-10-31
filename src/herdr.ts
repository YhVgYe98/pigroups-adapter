/**
 * `Herdr`: the only way the adapter leaves its own process (设计说明 §2.2).
 *
 * The real implementation shells out to the `herdr` CLI; every call goes through
 * the interface so `loop.ts` never runs a command itself.
 */

import { execFile } from 'node:child_process';

export interface Herdr {
  /** Create a pane in the workspace and start a pi in it. Returns the pane id. */
  spawn(opts: { label: string; env: Record<string, string>; cwd?: string }): Promise<{ pane: string }>;
  /** Wait until the agent in that pane is ready/idle. */
  waitReady(pane: string, timeoutMs: number): Promise<void>;
  /** Read the raw text of that pane (diagnostics and reporting only). */
  read(pane: string, lines: number): Promise<string>;
  /** Close the pane. */
  close(pane: string): Promise<void>;
}

export interface HerdrCliOptions {
  /** `PIGROUPS_SPAWN_CMD`, default `pi`. */
  spawnCmd: string;
  /** The executable to run, default `herdr` on PATH. */
  command?: string;
}

/** `agent start` waits for the agent to become interactive. */
const AGENT_START_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 180_000;

export class HerdrCli implements Herdr {
  private readonly spawnCmd: string;
  private readonly command: string;

  constructor(opts: HerdrCliOptions) {
    this.spawnCmd = opts.spawnCmd;
    this.command = opts.command ?? 'herdr';
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

  async close(pane: string): Promise<void> {
    await this.run(['pane', 'close', pane]);
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
        (error, out) => {
          if (error) reject(error);
          else resolve(out);
        },
      );
    });
    return parseEnvelope(stdout);
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter((part) => part.length > 0);
}

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
