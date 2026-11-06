// §12.6: one member, one consumer. The lease is keyed by the token hash, not the
// member id, because a token is the only identity every entry path knows before
// any network call. A second process must not register tools or poll.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pigroupsExtension from '../src/extension.ts';
import {
  acquireConsumerLease,
  consumerLeasePath,
  processStartTime,
  readConsumerLease,
} from '../src/records.ts';
import type { PiLike, PiToolDefinition } from '../src/surface.ts';

import { bootPlatform, bootstrapRoot } from './support.ts';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function existsLease(dir: string, token: string): boolean {
  return readConsumerLease(dir, token) !== undefined;
}

async function waitForStart(pid: number): Promise<number> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const start = processStartTime(pid);
    if (start !== undefined) return start;
    if (Date.now() > deadline) throw new Error(`no /proc start time for ${pid}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakePi(): {
  pi: PiLike;
  tools: Map<string, PiToolDefinition>;
  fire(event: string): Promise<void>;
} {
  const tools = new Map<string, PiToolDefinition>();
  const handlers = new Map<string, Array<() => unknown>>();
  const pi = {
    sendMessage(): void {},
    registerTool(tool: PiToolDefinition): void {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: () => unknown): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
  } as unknown as PiLike;
  return {
    pi,
    tools,
    async fire(event: string): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler();
    },
  };
}

test('a second acquire in the same process takes over, and the old release does not remove it', async () => {
  const dir = await tempDir('pigroups-lease-');
  try {
    const first = acquireConsumerLease(dir, 'token-one');
    assert.notEqual(first, null);
    const second = acquireConsumerLease(dir, 'token-one');
    assert.notEqual(second, null);
    assert.ok(second!.at > first!.at, 'the new incarnation has a new acquisition stamp');

    first!.release();
    assert.equal(readConsumerLease(dir, 'token-one')?.at, second!.at, 'the old release is not allowed to remove the new lease');

    second!.release();
    assert.equal(readConsumerLease(dir, 'token-one'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a live other process holds the seat; a dead one does not', async () => {
  const dir = await tempDir('pigroups-lease-');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const start = await waitForStart(other.pid!);
    const path = consumerLeasePath(dir, 'token-two');
    await mkdir(join(dir, 'consumers'), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ pid: other.pid, pid_start: start, at: Date.now() }), { mode: 0o600 });

    assert.equal(acquireConsumerLease(dir, 'token-two'), null, 'another live process owns the seat');

    const exited = new Promise<void>((resolve) => other.once('exit', () => resolve()));
    other.kill('SIGKILL');
    await exited;
    const acquired = acquireConsumerLease(dir, 'token-two');
    assert.notEqual(acquired, null, 'a dead pid is stale and may be taken over');
    acquired!.release();
  } finally {
    other.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unreadable lease is fail-closed', async () => {
  const dir = await tempDir('pigroups-lease-');
  try {
    const path = consumerLeasePath(dir, 'token-three');
    await mkdir(join(dir, 'consumers'), { recursive: true, mode: 0o700 });
    await writeFile(path, '{not json', { mode: 0o600 });
    assert.equal(acquireConsumerLease(dir, 'token-three'), null, 'a human must inspect the corrupt lease');
    assert.equal(await readFile(path, 'utf8'), '{not json', 'the lease is not overwritten');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the extension registers no tools while another process holds the member seat', async (t) => {
  const platform = await bootPlatform();
  const root = await bootstrapRoot(platform);
  const adapterDir = await tempDir('pigroups-lease-');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const saved = {
    url: process.env.PIGROUPS_URL,
    token: process.env.PIGROUPS_TOKEN,
    dir: process.env.PIGROUPS_ADAPTER_DIR,
    wait: process.env.PIGROUPS_POLL_WAIT,
  };
  t.after(async () => {
    other.kill('SIGKILL');
    await platform.stop();
    await rm(adapterDir, { recursive: true, force: true });
    for (const [name, value] of [
      ['PIGROUPS_URL', saved.url],
      ['PIGROUPS_TOKEN', saved.token],
      ['PIGROUPS_ADAPTER_DIR', saved.dir],
      ['PIGROUPS_POLL_WAIT', saved.wait],
    ] as Array<[string, string | undefined]>) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const start = await waitForStart(other.pid!);
  const path = consumerLeasePath(adapterDir, root.token);
  await mkdir(join(adapterDir, 'consumers'), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ pid: other.pid, pid_start: start, at: Date.now() }), { mode: 0o600 });

  process.env.PIGROUPS_URL = platform.url;
  process.env.PIGROUPS_TOKEN = root.token;
  process.env.PIGROUPS_ADAPTER_DIR = adapterDir;
  process.env.PIGROUPS_POLL_WAIT = '0';

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const blocked = fakePi();
    pigroupsExtension(blocked.pi);
    assert.equal(blocked.tools.size, 0, 'the second process does not become a member');
    assert.ok(
      warnings.some((warning) => /already open in another session/i.test(warning)),
      `expected the one-line refusal, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = originalWarn;
  }

  const exited = new Promise<void>((resolve) => other.once('exit', () => resolve()));
  other.kill('SIGKILL');
  await exited;

  const member = fakePi();
  pigroupsExtension(member.pi);
  assert.equal(member.tools.size, 12, 'after the holder is gone the next session is a full member');
  assert.ok(member.tools.has('pg_respawn'));
  assert.ok(existsLease(adapterDir, root.token), 'the new session owns the seat');
  await member.fire('session_shutdown');
  assert.equal(readConsumerLease(adapterDir, root.token), undefined, 'shutdown releases the seat last');
});
