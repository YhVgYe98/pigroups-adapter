/**
 * Adapter diagnostics.
 *
 * These lines are for a person debugging the adapter, not for the model and not for
 * the TUI. In production they go to `<adapterDir>/adapter.log`; a write failure drops
 * the line instead of falling back to stderr, because stderr is what used to leak
 * `[pigroups] …` into the terminal under pi's footer.
 *
 * Before the adapter root is known, lines are buffered instead of being written to the
 * *default* path. Writing there would create `~/.pi/pigroups` during the legacy-layout
 * check and defeat its own fallback. `setLogDir()` flushes the buffer to the real root.
 *
 * Tests still capture the warnings through the console: `node --test` sets
 * `NODE_TEST_CONTEXT`, and the existing tests replace `console.warn`/`console.log`.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

const PENDING_LIMIT = 100;
let overrideDir: string | undefined;
let identity: string | undefined;
let pending: string[] = [];

/** Pin the log directory once the adapter knows its real root (legacy layouts included). */
export function setLogDir(dir: string | undefined): void {
  overrideDir = dir;
  flushPending();
}

/** Attribute subsequent file lines to the member this process became. */
export function setLogIdentity(name: string, id: string): void {
  identity = `${name}(${id})`;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * The path when one is explicitly configured. `undefined` means "wait for
 * `setLogDir()`": the default path is exactly the one the legacy check must not create.
 */
function configuredFile(): string | undefined {
  const explicit = overrideDir ?? process.env.PIGROUPS_ADAPTER_DIR;
  if (explicit !== undefined && explicit !== '') return join(resolve(expandHome(explicit)), 'adapter.log');
  const agent = process.env.PI_CODING_AGENT_DIR;
  if (agent !== undefined && agent !== '') {
    return join(resolve(expandHome(agent)), 'pigroups', 'adapter.log');
  }
  return undefined;
}

function append(file: string, line: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    // Diagnostics must never become a second failure path.
  }
}

function flushPending(): void {
  const file = configuredFile();
  if (file === undefined || pending.length === 0) return;
  const lines = pending;
  pending = [];
  for (const line of lines) append(file, line);
}

function write(level: LogLevel, message: string): void {
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    const sink = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
    sink(message);
    return;
  }
  const tag = identity === undefined ? '' : `[${identity}] `;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${tag}${message}`;
  const file = configuredFile();
  if (file === undefined) {
    pending.push(line);
    if (pending.length > PENDING_LIMIT) pending.shift();
    return;
  }
  append(file, line);
}

export function logInfo(message: string): void {
  write('info', message);
}

export function logWarn(message: string): void {
  write('warn', message);
}

export function logError(message: string): void {
  write('error', message);
}
