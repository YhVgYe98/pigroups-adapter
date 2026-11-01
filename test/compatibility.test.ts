// §8: the platform major.minor is a warning, never a gate. The decision is a pure
// function; the integration check proves it is actually called once at startup and
// that a supported platform stays quiet.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ADAPTER_VERSION, platformCompatibilityWarning } from '../src/version.ts';
import { scenario } from './scenario.ts';

test('a platform outside the supported majors.minors yields one warning naming both versions', () => {
  const warning = platformCompatibilityWarning('0.3.7');

  assert.equal(typeof warning, 'string', 'an unsupported platform is reported');
  assert.match(warning as string, /platform 0\.3\.7/, 'the warning names the platform version it saw');
  assert.ok((warning as string).includes(ADAPTER_VERSION), 'the warning names the adapter version doing the warning');
  assert.equal(platformCompatibilityWarning('0.2.0'), undefined, 'the supported major.minor logs nothing');
  assert.equal(platformCompatibilityWarning('v0.2.9'), undefined, 'the patch level does not matter');
});

test('starting against a supported platform logs no compatibility warning', async (t) => {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };

  const s = await scenario();
  t.after(async () => {
    console.warn = original;
    await s.close();
  });

  await s.cycle();
  assert.deepEqual(warnings, [], 'a matching platform must not add noise to the one startup line');
});

test('an unsupported platform warns once at startup and the loop keeps working', async (t) => {
  const s = await scenario();
  const realWhoami = s.pg.whoami.bind(s.pg);
  s.pg.whoami = async () => ({ ...(await realWhoami()), server: { version: '0.3.7' } });

  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(async () => {
    console.warn = original;
    await s.close();
  });

  await s.cycle();
  assert.equal(warnings.length, 1, `exactly one warning, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /platform 0\.3\.7/);
  assert.ok(warnings[0].includes(ADAPTER_VERSION));

  await s.cycle();
  assert.equal(warnings.length, 1, 'startup is initialised once; the warning does not repeat');
  assert.deepEqual(s.loop.state().owed, [], 'the member still started and its state is usable');
});
