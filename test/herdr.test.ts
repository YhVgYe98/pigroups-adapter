// §2.2 `Herdr.close`: one herdr failure is really a success. A pane that is already
// gone — closed by hand, or its shell exited — is the outcome close() wants. Every
// other failure must still reach the caller, or a broken herdr would look like a
// cleaned-up pane.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    await assert.doesNotReject(herdr.close('wE:pX'), 'a pane that is already gone is a success');
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
