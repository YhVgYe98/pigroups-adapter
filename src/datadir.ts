/**
 * Where this adapter keeps its durable state (设计说明 §12.1, §7).
 *
 * Pi already has a profile directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), and
 * `getAgentDir()` is its public answer. This module mirrors that one lookup instead
 * of importing the pi package: the repository has no pi dependency, and every test
 * must be able to resolve the directory without a live pi (AGENTS.md).
 *
 * A custom `PI_CODING_AGENT_DIR` moves the state with the profile:
 * `<agent dir>/pigroups`. Without one the public default is `~/.pi/pigroups`, not
 * `<agent dir>/pigroups` — the plugin lives beside `~/.pi/agent`, not inside it.
 *
 * The old `~/.pigroups-adapter` layout is read once. It is never moved automatically:
 * that directory can hold a running platform, and `mv` would pull the data out from
 * under it.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { logWarn } from './log.ts';

export interface AdapterDirOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam / explicit home; production uses `os.homedir()`. */
  home?: string;
  /** Test seam for the agent directory; overrides `PI_CODING_AGENT_DIR` when present. */
  agentDir?: string;
  /** Where the migration warning goes; tests capture it instead of the console. */
  warn?: (message: string) => void;
}

const OLD_DIR_NAME = '.pigroups-adapter';

/** Same semantics as pi's `getAgentDir()`: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
function piAgentDir(env: NodeJS.ProcessEnv, home: string, override: string | undefined): string {
  const raw = override !== undefined && override !== '' ? override : env.PI_CODING_AGENT_DIR;
  if (raw !== undefined && raw !== '') return expandHome(raw, home);
  return join(home, '.pi', 'agent');
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

function hasContent(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the adapter root, including the one-time old-layout fallback. Pure except
 * for the directory inspection and the caller-supplied warning sink.
 */
export function resolveAdapterDir(opts: AdapterDirOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const explicit = env.PIGROUPS_ADAPTER_DIR;
  const customAgent = opts.agentDir !== undefined && opts.agentDir !== '' ? opts.agentDir : env.PI_CODING_AGENT_DIR;
  // §12.1: a custom profile is a separate identity, not a reason to share the old
  // layout's journal. The fallback is only for the pure default path.
  const explicitSource =
    (explicit !== undefined && explicit !== '') || (customAgent !== undefined && customAgent !== '');

  const chosen =
    explicit !== undefined && explicit !== ''
      ? expandHome(explicit, home)
      : customAgent !== undefined && customAgent !== ''
        ? join(expandHome(customAgent, home), 'pigroups')
        : join(home, '.pi', 'pigroups');

  const resolved = resolve(chosen);
  const oldDir = resolve(home, OLD_DIR_NAME);
  if (!explicitSource && resolved !== oldDir && !existsSync(resolved) && hasContent(oldDir)) {
    const warn = opts.warn ?? ((message: string) => logWarn(message));
    warn(
      `[pigroups] using the legacy adapter directory ${oldDir}: ${resolved} does not exist. ` +
        `Move ${oldDir} to ${resolved} when no platform is running from it; it will not be moved automatically.`,
    );
    return oldDir;
  }
  return resolved;
}

/** The warned legacy directories, so one process logs the migration request once. */
const warnedLegacy = new Set<string>();

/** `PIGROUPS_ADAPTER_DIR`, or the per-profile default, with the old-layout fallback. */
export function defaultAdapterDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveAdapterDir({
    env,
    warn: (message) => {
      if (warnedLegacy.has(message)) return;
      warnedLegacy.add(message);
      logWarn(message);
    },
  });
}

