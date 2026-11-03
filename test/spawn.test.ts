// §2.2: a spawned member is a normal pi session, not a stripped worker. The default
// loads this adapter on top of the operator's environment. pg_spawn does not mirror
// pi's flags: the caller's raw argv is appended to that base command, in order.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shellQuote, splitCommand } from '../src/command.ts';
import { scenario } from './scenario.ts';
import { delay } from './support.ts';
import pigroupsExtension, { EXTENSION_ENTRY, defaultSpawnCmd, resolveSpawnCmd } from '../src/extension.ts';
import type { PiLike, PiToolDefinition } from '../src/surface.ts';

test('the default spawn command loads this extension with its own absolute path and takes nothing away', () => {
  const argv = splitCommand(defaultSpawnCmd());

  assert.equal(argv[0], 'pi', 'the child is still a pi process');
  assert.equal(argv.includes('-ne'), false, 'a member is a normal pi session; extensions are not stripped');
  assert.deepEqual(argv, ['pi', '-e', EXTENSION_ENTRY], 'the only addition is this adapter');
  assert.equal(EXTENSION_ENTRY, fileURLToPath(new URL('../src/extension.ts', import.meta.url)));
  assert.ok(isAbsolute(argv[2]), 'a child pane may start in another cwd, so the path must be absolute');
});

test('an explicit PIGROUPS_SPAWN_CMD still wins over the self-loading default', () => {
  const explicit = "pi -e '/opt/somewhere else/extension.ts' --model vendor/model";
  assert.equal(
    resolveSpawnCmd({ PIGROUPS_SPAWN_CMD: explicit }, '/this/path/must/not/be/used.ts'),
    explicit,
    'the operator remains the escape hatch for the whole base command',
  );
});

test('the derived path survives a path containing spaces', () => {
  const spaced = '/tmp/pi groups/adapter with spaces/src/extension.ts';
  const command = defaultSpawnCmd(spaced);

  assert.ok(command.includes(spaced), `the quoted command must preserve the path, got ${command}`);
  assert.deepEqual(splitCommand(command), ['pi', '-e', spaced], 'herdr must receive the spaced path as one argument');
});

test('the caller’s args are appended after the base command in order, and nothing else is injected', () => {
  const base = splitCommand(defaultSpawnCmd());
  const args = ['--model', 'vendor/model', '-p', 'do the thing', '--', '--not-a-flag'];
  const argv = [...base, ...args];

  assert.deepEqual([...base], base, 'omitting args leaves the configured base command alone');
  assert.deepEqual(argv.slice(0, base.length), base, 'the base command comes first, unchanged');
  assert.deepEqual(argv.slice(base.length), args, 'each caller word keeps its position and value');
});

test('a path with spaces, a dollar sign, a quote and a semicolon still survives as one argv word', () => {
  const nasty = '/tmp/pi groups/$(touch pwned)/ext (beta).ts';
  const hostile = "it's quoted; touch pwned";
  const args = ['--extension', nasty, '--note', hostile];
  const argv = [...splitCommand(defaultSpawnCmd(nasty)), ...args];

  // Herdr's send-text fallback quotes every argv element with the same helper.
  const commandLine = argv.map(shellQuote).join(' ');
  assert.deepEqual(splitCommand(commandLine), argv, 'the shell reads back exactly the argv herdr was given');
  assert.ok(commandLine.includes(`'${nasty}'`), 'the metacharacter path is inside one single-quoted word');
  assert.ok(commandLine.includes(`'it'\\''s quoted; touch pwned'`), 'a quote and a semicolon stay inside one word');
});

test('the pg_spawn schema is exactly name, brief, cwd and args, and points the model at pi --help', () => {
  const spawn = spawnTool();
  const parameters = spawn.parameters as any;

  assert.equal(parameters.additionalProperties, false, 'an unknown parameter name must be rejected by the schema');
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['args', 'brief', 'cwd', 'name']);
  assert.deepEqual(parameters.required, ['brief']);
  assert.equal(parameters.properties.args.type, 'array', 'args carries one argv word per element');
  assert.equal(parameters.properties.args.items.type, 'string');
  assert.match(String(spawn.description), /args/, 'the description must say what args are');
  assert.match(String(spawn.description), /pi --help/, 'the model must be told that pi’s own manual is the reference');
});

test('the command module exposes quoting only, not a pi-flag mirror', async () => {
  const command = await import('../src/command.ts');
  assert.deepEqual(
    Object.keys(command).sort(),
    ['shellQuote', 'splitCommand'],
    'pi has far more flags than any mirror would keep up with; args is the only passthrough',
  );
});

/** The tool definitions the extension registers; no session_start, so nothing talks to a platform. */
function spawnTool(): PiToolDefinition {
  const savedUrl = process.env.PIGROUPS_URL;
  const savedToken = process.env.PIGROUPS_TOKEN;
  process.env.PIGROUPS_URL = 'http://127.0.0.1:1';
  process.env.PIGROUPS_TOKEN = 'schema-only-token';

  const tools = new Map<string, PiToolDefinition>();
  const pi = {
    sendMessage(): void {},
    registerTool(tool: PiToolDefinition): void {
      tools.set(tool.name, tool);
    },
    on(): () => void {
      return () => undefined;
    },
  } as unknown as PiLike;

  try {
    pigroupsExtension(pi);
    const spawn = tools.get('pg_spawn');
    assert.ok(spawn, 'the extension must register pg_spawn');
    return spawn;
  } finally {
    if (savedUrl === undefined) delete process.env.PIGROUPS_URL;
    else process.env.PIGROUPS_URL = savedUrl;
    if (savedToken === undefined) delete process.env.PIGROUPS_TOKEN;
    else process.env.PIGROUPS_TOKEN = savedToken;
  }
}

// Handing work to someone is not waiting for them to start. The old spawn() blocked until the
// child authenticated (up to 120 s), so a parent sat still while its team was already working.
test('spawnMember returns as soon as the child is launched, without waiting for it to connect', async (t) => {
  const s = await scenario({ spawnReadyMs: 60_000 });
  t.after(() => s.close());
  s.herdr.authenticate = false; // it never connects, and that must not hold the caller

  const started = Date.now();
  const child = await s.loop.spawnMember({ name: 'fast', brief: 'work' });
  const took = Date.now() - started;

  assert.equal(child.name, 'fast');
  assert.ok(took < 5000, `spawn must not wait for readiness, took ${took}ms`);
  assert.equal(s.herdr.spawns.length, 1, 'the child was launched');
});

// The other half: if it never connects, the parent still has to learn. It arrives later, as one
// line in its own context, instead of blocking the call that asked for it.
test('a child that never connects is reported to the parent instead of blocking it', async (t) => {
  const s = await scenario({ spawnReadyMs: 300, deliveryWindowMs: 250 });
  t.after(() => s.close());
  s.herdr.authenticate = false;

  await s.loop.spawnMember({ name: 'lost', brief: 'work' });

  // The watcher runs on the loop's clock, which is injected: advance it past `spawnReadyMs`
  // and let the delivery window close, the way the real clock would.
  for (let i = 0; i < 60 && !s.surface.texts().some((text) => text.includes('[spawn] lost')); i += 1) {
    await delay(60);
    await s.timer(200);
  }
  const notice = s.surface.texts().find((text) => text.includes('[spawn] lost')) ?? '';
  assert.notEqual(notice, '', 'the parent must be told the child never joined');
  assert.match(notice, /never connected|never appeared/, 'the notice says it never joined');
});
