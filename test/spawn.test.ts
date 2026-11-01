// §2.2: a spawned member is a normal pi session, not a stripped worker. The default
// loads this adapter on top of the operator's environment; pg_spawn's optional flags
// are argv appended to that base command, never string-spliced into it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPAWN_THINKING_LEVELS, shellQuote, spawnFlagArgs, splitCommand } from '../src/command.ts';
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

test('pg_spawn flags map one-to-one onto pi argv, arrays repeat their flag, and args stays last', () => {
  assert.deepEqual(
    spawnFlagArgs({
      model: 'vendor/model:high',
      thinking: 'high',
      tools: 'read,bash,*',
      exclude_tools: 'write,edit',
      extensions: ['/extra/one.ts', '/extra/two.ts'],
      skills: ['/skills/a', '/skills/b'],
      prompt_templates: ['/prompts/a.md', '/prompts/b.md'],
      args: ['--future-flag', 'value with spaces'],
    }),
    [
      '--model',
      'vendor/model:high',
      '--thinking',
      'high',
      '--tools',
      'read,bash,*',
      '--exclude-tools',
      'write,edit',
      '--extension',
      '/extra/one.ts',
      '--extension',
      '/extra/two.ts',
      '--skill',
      '/skills/a',
      '--skill',
      '/skills/b',
      '--prompt-template',
      '/prompts/a.md',
      '--prompt-template',
      '/prompts/b.md',
      '--future-flag',
      'value with spaces',
    ],
    'scalar flags are one pair, array flags repeat, and the raw args tail is untouched at the end',
  );
});

test('no spawn flags adds nothing, and the same flags always produce the same argv', () => {
  assert.deepEqual(spawnFlagArgs(), [], 'omitting every parameter leaves the configured base command alone');

  const flags = {
    model: 'vendor/model',
    thinking: 'low',
    extensions: ['/extra/ext.ts'],
    args: ['--verbose'],
  };
  assert.deepEqual(spawnFlagArgs(flags), spawnFlagArgs(flags), 'the argv is a function of the parameters only');
});

test('a path with spaces, a dollar sign and parentheses cannot escape its argv element', () => {
  const nasty = '/tmp/pi groups/$(touch pwned)/ext (beta).ts';
  const base = splitCommand(defaultSpawnCmd(nasty));
  const extra = spawnFlagArgs({ extensions: [nasty], args: ['--future', nasty] });
  const argv = [...base, ...extra];

  // Herdr's send-text fallback quotes every argv element with the same helper.
  const commandLine = argv.map(shellQuote).join(' ');
  assert.deepEqual(splitCommand(commandLine), argv, 'the shell reads back exactly the argv herdr was given');
  assert.ok(commandLine.includes(`'${nasty}'`), 'the metacharacter path is inside one single-quoted word');
  assert.equal(extra[1], nasty, 'flag values stay raw argv elements; quoting is only for the shell string');
});

test('the pg_spawn tool schema exposes the closed pi-flag set and rejects unknown parameters', () => {
  const parameters = spawnToolParameters();

  assert.equal(parameters.additionalProperties, false, 'an unknown parameter name must be rejected by the schema');
  assert.deepEqual(
    Object.keys(parameters.properties).sort(),
    ['args', 'brief', 'cwd', 'exclude_tools', 'extensions', 'model', 'name', 'prompt_templates', 'skills', 'thinking', 'tools'],
  );
  assert.deepEqual(parameters.required, ['brief']);
  assert.deepEqual(parameters.properties.thinking.enum, [...SPAWN_THINKING_LEVELS]);
  for (const name of ['extensions', 'skills', 'prompt_templates', 'args']) {
    assert.equal(parameters.properties[name].type, 'array', `${name} carries repeated flags`);
    assert.equal(parameters.properties[name].items.type, 'string', `${name} elements are argv strings`);
  }
  for (const name of ['model', 'tools', 'exclude_tools']) {
    assert.equal(parameters.properties[name].type, 'string');
  }
});

/** The tool definitions the extension registers; no session_start, so nothing talks to a platform. */
function spawnToolParameters(): any {
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
    return spawn.parameters;
  } finally {
    if (savedUrl === undefined) delete process.env.PIGROUPS_URL;
    else process.env.PIGROUPS_URL = savedUrl;
    if (savedToken === undefined) delete process.env.PIGROUPS_TOKEN;
    else process.env.PIGROUPS_TOKEN = savedToken;
  }
}
