// §2.2: a spawned child must load this adapter without the operator setting anything.
// The default therefore carries the extension's own absolute path, and the command
// splitter has to keep a path with spaces in one token.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitCommand } from '../src/command.ts';
import { EXTENSION_ENTRY, defaultSpawnCmd, resolveSpawnCmd } from '../src/extension.ts';

test('the default spawn command loads this extension with its own absolute path', () => {
  const argv = splitCommand(defaultSpawnCmd());

  assert.equal(argv[0], 'pi', 'the child is still a pi process');
  assert.ok(argv.includes('-ne'), 'the child starts without the operator’s global extensions');
  const at = argv.indexOf('-e');
  assert.ok(at >= 0, `the default must pass -e, got ${JSON.stringify(argv)}`);
  assert.equal(argv[at + 1], EXTENSION_ENTRY, 'the -e path is this file, not a guessed install path');
  assert.equal(EXTENSION_ENTRY, fileURLToPath(new URL('../src/extension.ts', import.meta.url)));
  assert.ok(isAbsolute(argv[at + 1]), 'a child pane may start in another cwd, so the path must be absolute');
});

test('an explicit PIGROUPS_SPAWN_CMD still wins over the self-loading default', () => {
  const explicit = "pi -ne -e '/opt/somewhere else/extension.ts' --model vendor/model";
  assert.equal(
    resolveSpawnCmd({ PIGROUPS_SPAWN_CMD: explicit }, '/this/path/must/not/be/used.ts'),
    explicit,
    'the operator remains the escape hatch',
  );
});

test('the derived path survives a path containing spaces', () => {
  const spaced = '/tmp/pi groups/adapter with spaces/src/extension.ts';
  const command = defaultSpawnCmd(spaced);

  assert.ok(command.includes(spaced), `the quoted command must preserve the path, got ${command}`);
  assert.deepEqual(
    splitCommand(command),
    ['pi', '-ne', '-e', spaced],
    'herdr must receive the spaced path as one argument, not four',
  );
});
