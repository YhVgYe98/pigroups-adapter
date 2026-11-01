/**
 * Shell-style tokenising and quoting for spawn commands (§2.2).
 *
 * The value is a command line, not an argv array, so a path with spaces must be
 * quoted. `herdr agent start` receives the tokens after `--`; the `pane send-text`
 * fallback receives the command line verbatim, where the same quotes are read by
 * the shell. Both paths therefore use this one splitter. `pg_spawn` does not
 * interpret pi's flags: its caller-supplied argv is appended after the base
 * command and only quoted on the way to the shell.
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
