/**
 * Shell-style tokenising and quoting for spawn commands, plus the `pg_spawn` flags (§2.2).
 *
 * The value is a command line, not an argv array, so a path with spaces must be
 * quoted. `herdr agent start` receives the tokens after `--`; the `pane send-text`
 * fallback receives the command line verbatim, where the same quotes are read by
 * the shell. Both paths therefore use this one splitter.
 */

/** Split a command line into words, honouring single quotes, double quotes and backslash. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;

  const push = (): void => {
    if (!tokenStarted) return;
    args.push(current);
    current = '';
    tokenStarted = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (quote === "'") {
      tokenStarted = true;
      if (ch === "'") quote = undefined;
      else current += ch;
      continue;
    }

    if (quote === '"') {
      tokenStarted = true;
      if (ch === '"') {
        quote = undefined;
      } else if (ch === '\\') {
        const next = command[i + 1];
        if (next !== undefined && (next === '"' || next === '\\' || next === '$' || next === '`')) {
          current += next;
          i += 1;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStarted = true;
      continue;
    }

    if (ch === '\\') {
      const next = command[i + 1];
      tokenStarted = true;
      if (next !== undefined) {
        current += next;
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      push();
      continue;
    }

    current += ch;
    tokenStarted = true;
  }

  // An unterminated quote is kept as literal text, matching the old permissive behaviour.
  push();
  return args;
}

/** Quote one argument so both `splitCommand` and a POSIX shell read it back unchanged. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The pi startup flags `pg_spawn` exposes (设计说明 §5.3). These are optional
 * additions to the configured base command; they never replace it.
 */
export interface SpawnFlags {
  model?: string;
  thinking?: string;
  tools?: string;
  exclude_tools?: string;
  extensions?: string[];
  skills?: string[];
  prompt_templates?: string[];
  args?: string[];
}

/** The levels `pi --thinking` accepts today; `args` is the escape hatch for a later one. */
export const SPAWN_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function spawnString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`spawn ${name} must be a non-empty string`);
  }
  return value;
}

function spawnStrings(name: string, value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(`spawn ${name} must be an array of strings`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error(`spawn ${name}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

/**
 * Turn `pg_spawn`'s optional pi flags into an argv tail. The caller appends this
 * tail to the command split from `PIGROUPS_SPAWN_CMD`; an array flag repeats its
 * flag once per element. `args` is appended last and is not interpreted at all.
 */
export function spawnFlagArgs(flags: SpawnFlags = {}): string[] {
  const out: string[] = [];
  if (flags.model !== undefined) out.push('--model', spawnString('model', flags.model));
  if (flags.thinking !== undefined) {
    const thinking = spawnString('thinking', flags.thinking);
    if (!(SPAWN_THINKING_LEVELS as readonly string[]).includes(thinking)) {
      throw new Error(`spawn thinking must be one of ${SPAWN_THINKING_LEVELS.join(', ')}`);
    }
    out.push('--thinking', thinking);
  }
  if (flags.tools !== undefined) out.push('--tools', spawnString('tools', flags.tools));
  if (flags.exclude_tools !== undefined) out.push('--exclude-tools', spawnString('exclude_tools', flags.exclude_tools));
  for (const path of spawnStrings('extensions', flags.extensions ?? [])) out.push('--extension', path);
  for (const path of spawnStrings('skills', flags.skills ?? [])) out.push('--skill', path);
  for (const path of spawnStrings('prompt_templates', flags.prompt_templates ?? [])) out.push('--prompt-template', path);
  if (flags.args !== undefined) {
    if (!Array.isArray(flags.args)) throw new Error('spawn args must be an array of strings');
    for (const [index, value] of flags.args.entries()) {
      if (typeof value !== 'string') throw new Error(`spawn args[${index}] must be a string`);
    }
    out.push(...flags.args);
  }
  return out;
}
