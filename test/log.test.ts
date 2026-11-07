// Production diagnostics must go to <adapterDir>/adapter.log, never to the terminal
// that pi is drawing its TUI on. The test runner keeps the console seam for old tests;
// this test spawns a normal child with that seam absent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('a production warning goes to adapter.log and not to stdout/stderr', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pigroups-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const env: NodeJS.ProcessEnv = { ...process.env, PIGROUPS_ADAPTER_DIR: dir };
  delete env.NODE_TEST_CONTEXT;
  const module = pathToFileURL(join(import.meta.dirname, '..', 'src', 'log.ts')).href;
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `import { logWarn, setLogIdentity } from ${JSON.stringify(module)}; setLogIdentity('billing-api', 'm_a1b2c3'); logWarn('[pigroups] file-only');`,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

  assert.equal(code, 0);
  assert.equal(stdout, '', 'the diagnostic must not be printed to stdout');
  assert.doesNotMatch(stderr, /\[pigroups\] file-only/, 'the diagnostic must not be printed to stderr');
  const file = await readFile(join(dir, 'adapter.log'), 'utf8');
  assert.match(file, /WARN \[billing-api\(m_a1b2c3\)\] \[pigroups\] file-only/);
});

test('a warning before setLogDir is buffered, so it cannot create the default dir', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'pigroups-home-'));
  const target = await mkdtemp(join(tmpdir(), 'pigroups-target-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PIGROUPS_TARGET: target,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.PIGROUPS_ADAPTER_DIR;
  delete env.PI_CODING_AGENT_DIR;
  const module = pathToFileURL(join(import.meta.dirname, '..', 'src', 'log.ts')).href;
  const script = [
    `import { logWarn, setLogDir } from ${JSON.stringify(module)};`,
    "logWarn('[pigroups] early');",
    'setLogDir(process.env.PIGROUPS_TARGET);',
    "logWarn('[pigroups] late');",
  ].join(' ');
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

  assert.equal(code, 0);
  assert.doesNotMatch(stdout + stderr, /\[pigroups\] (early|late)/);
  assert.equal(existsSync(join(home, '.pi', 'pigroups')), false, 'the pure default directory must not be created');
  const file = await readFile(join(target, 'adapter.log'), 'utf8');
  assert.match(file, /\[pigroups\] early/);
  assert.match(file, /\[pigroups\] late/);
});

test('a legacy-layout warning is flushed to the legacy dir, never the default', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'pigroups-legacy-'));
  const legacy = join(home, '.pigroups-adapter');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'org.json'), '{}\n');
  t.after(() => rm(home, { recursive: true, force: true }));

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.NODE_TEST_CONTEXT;
  delete env.PIGROUPS_ADAPTER_DIR;
  delete env.PI_CODING_AGENT_DIR;
  const datadir = pathToFileURL(join(import.meta.dirname, '..', 'src', 'datadir.ts')).href;
  const log = pathToFileURL(join(import.meta.dirname, '..', 'src', 'log.ts')).href;
  const script = [
    `import { defaultAdapterDir } from ${JSON.stringify(datadir)};`,
    `import { setLogDir } from ${JSON.stringify(log)};`,
    'setLogDir(defaultAdapterDir());',
  ].join(' ');
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /legacy adapter directory/);
  assert.equal(existsSync(join(home, '.pi', 'pigroups')), false, 'the default must not be created by the warning');
  const file = await readFile(join(legacy, 'adapter.log'), 'utf8');
  assert.match(file, /using the legacy adapter directory/);
});
