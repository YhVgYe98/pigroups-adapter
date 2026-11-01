// §2.2 `Herdr.close`: one herdr failure is really a success. A pane that is already
// gone — closed by hand, or its shell exited — is the outcome close() wants. Every
// other failure must still reach the caller, or a broken herdr would look like a
// cleaned-up pane.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HerdrCli, HerdrCommandError } from '../src/herdr.ts';

/** A stand-in for the herdr binary: writes `stderr` and exits with `code`. */
async function fakeHerdr(dir: string, stderr: string, code: number): Promise<string> {
  const path = join(dir, 'herdr-fake');
  await writeFile(path, `#!/bin/sh\ncat >&2 <<'EOF'\n${stderr}\nEOF\nexit ${code}\n`);
  await chmod(path, 0o755);
  return path;
}

test('close() treats pane_not_found as a closed pane', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pigroups-herdr-'));
  try {
    // The real shape, captured from `herdr 0.9.5`: the error envelope goes to stderr
    // and the process exits 1.
    const command = await fakeHerdr(
      dir,
      '{"error":{"code":"pane_not_found","message":"pane wE:pX not found"},"id":"cli:pane:close"}',
      1,
    );
    const herdr = new HerdrCli({ spawnCmd: 'pi', command });
    const result = await herdr.close('wE:pX');
    assert.equal(result.forced, false, 'a pane that is already gone is a clean close');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('close() waits for the pane agent to exit before it runs pane close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pigroups-herdr-'));
  try {
    // Two lists still show a working agent; the third is the shell herdr leaves after
    // the agent exits (`agent` absent, `agent_status: unknown`). Every invocation is
    // appended to `invocations`, so the test can see the order close() used.
    const command = join(dir, 'herdr-fake');
    await writeFile(
      command,
      `#!/bin/sh
DIR=$(dirname "$0")
printf '%s\n' "$*" >> "$DIR/invocations"
case "$1 $2" in
  "pane list")
    n=$(cat "$DIR/lists" 2>/dev/null || echo 0)
    if [ "$n" -lt 2 ]; then
      echo $((n+1)) > "$DIR/lists"
      printf '%s\n' '{"id":"cli:pane:list","result":{"panes":[{"pane_id":"wE:pX","agent":"pi","agent_status":"working"}]}}'
    else
      printf '%s\n' '{"id":"cli:pane:list","result":{"panes":[{"pane_id":"wE:pX","agent_status":"unknown"}]}}'
    fi
    ;;
  "pane close")
    printf '%s\n' '{"id":"cli:pane:close","result":{"ok":true}}'
    ;;
  *)
    printf '%s\n' '{"error":{"code":"unexpected_command","message":"unexpected"},"id":"cli"}' >&2
    exit 1
    ;;
esac
`,
    );
    await chmod(command, 0o755);

    const herdr = new HerdrCli({ spawnCmd: 'pi', command });
    const result = await herdr.close('wE:pX');
    assert.equal(result.forced, false, 'the agent left inside the bound: the close was not forced');

    const calls = (await readFile(join(dir, 'invocations'), 'utf8')).trim().split('\n');
    const closeAt = calls.indexOf('pane close wE:pX');
    assert.ok(closeAt > 0, `pane close must happen after the wait, got ${JSON.stringify(calls)}`);
    assert.equal(
      calls.slice(0, closeAt).filter((call) => call === 'pane list').length,
      3,
      `the running agent must be polled until it exits, got ${JSON.stringify(calls)}`,
    );
    assert.equal(
      calls.filter((call) => call === 'pane close wE:pX').length,
      1,
      'the pane is closed exactly once, after the agent is gone',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('close() reports a forced close when the agent is still running at the bound', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pigroups-herdr-'));
  try {
    // The pane's agent never leaves: every `pane list` says it is working. The bound is
    // shortened only in the test; production keeps `PANE_AGENT_EXIT_TIMEOUT_MS`.
    const command = join(dir, 'herdr-fake');
    await writeFile(
      command,
      `#!/bin/sh
DIR=$(dirname "$0")
printf '%s\n' "$*" >> "$DIR/invocations"
case "$1 $2" in
  "pane list")
    printf '%s\n' '{"id":"cli:pane:list","result":{"panes":[{"pane_id":"wE:pX","agent":"pi","agent_status":"working"}]}}'
    ;;
  "pane close")
    printf '%s\n' '{"id":"cli:pane:close","result":{"ok":true}}'
    ;;
  *)
    printf '%s\n' '{"error":{"code":"unexpected_command","message":"unexpected"},"id":"cli"}' >&2
    exit 1
    ;;
esac
`,
    );
    await chmod(command, 0o755);

    const herdr = new HerdrCli({
      spawnCmd: 'pi',
      command,
      paneAgentExitTimeoutMs: 80,
      paneAgentExitPollMs: 10,
    });
    const result = await herdr.close('wE:pX');

    assert.equal(result.forced, true, 'a live agent at the bound must not look like a clean close');
    const calls = (await readFile(join(dir, 'invocations'), 'utf8')).trim().split('\n');
    const closeAt = calls.indexOf('pane close wE:pX');
    assert.ok(closeAt > 0, `pane close must happen after the wait, got ${JSON.stringify(calls)}`);
    assert.ok(
      calls.slice(0, closeAt).filter((call) => call === 'pane list').length >= 2,
      `the agent must be polled until the bound, got ${JSON.stringify(calls)}`,
    );
    assert.equal(
      calls.filter((call) => call === 'pane close wE:pX').length,
      1,
      'the pane is still closed exactly once after a forced wait',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('close() still reports any other herdr failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pigroups-herdr-'));
  try {
    const command = await fakeHerdr(
      dir,
      '{"error":{"code":"daemon_unavailable","message":"herdr daemon is not running"},"id":"cli:pane:close"}',
      1,
    );
    const herdr = new HerdrCli({ spawnCmd: 'pi', command });
    await assert.rejects(
      herdr.close('wE:pX'),
      (err: unknown) =>
        err instanceof HerdrCommandError &&
        err.code === 'daemon_unavailable' &&
        err.message.includes('daemon is not running'),
      'a herdr that could not close anything must not look like a closed pane',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
