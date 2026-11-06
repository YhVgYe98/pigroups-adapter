// §8: the platform major.minor is a warning, never a gate. The decision is a pure
// function; the integration check proves it is actually called once at startup and
// that a supported platform stays quiet.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ADAPTER_VERSION, SUPPORTED_PLATFORM_MINORS, platformCompatibilityWarning } from '../src/version.ts';
import { scenario } from './scenario.ts';

test('a platform outside the supported majors.minors yields one warning naming both versions', () => {
  const warning = platformCompatibilityWarning('0.8.9');

  assert.deepEqual(
    SUPPORTED_PLATFORM_MINORS,
    ['0.3', '0.4', '0.5', '0.6', '0.7'],
    '0.7 owns the endpoint claim; older supported lines keep their hard gates',
  );
  assert.equal(typeof warning, 'string', 'an unsupported platform is reported');
  assert.match(warning as string, /platform 0\.8\.9/, 'the warning names the platform version it saw');
  assert.ok((warning as string).includes(ADAPTER_VERSION), 'the warning names the adapter version doing the warning');
  assert.equal(platformCompatibilityWarning('0.3.0'), undefined, 'the 0.3 line is supported and logs nothing');
  assert.equal(platformCompatibilityWarning('v0.3.9'), undefined, 'the patch level does not matter');
  assert.equal(platformCompatibilityWarning('0.4.0'), undefined, 'the 0.4 line is supported and logs nothing');
  assert.equal(platformCompatibilityWarning('v0.4.9'), undefined, 'the patch level does not matter on 0.4 either');
  assert.equal(platformCompatibilityWarning('0.5.0'), undefined, 'the 0.5 heartbeat line is supported');
  assert.equal(platformCompatibilityWarning('0.6.0'), undefined, 'the 0.6 endpoint line is supported');
  assert.equal(platformCompatibilityWarning('0.7.0'), undefined, 'the 0.7 endpoint claim line is supported');
  assert.match(
    platformCompatibilityWarning('0.2.0') ?? '',
    /platform 0\.2\.0/,
    '0.2 is outside the supported list now: the adapter relies on platform ids to keep one shared data root apart',
  );
  assert.match(platformCompatibilityWarning('0.1.9') ?? '', /platform 0\.1\.9/, '0.1 is outside the supported list and warns');
});

test('starting against a supported platform logs no compatibility warning', async (t) => {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };

  // A real pi session has a session file; supplying one keeps the startup warning
  // stream about compatibility only, which is what this test is measuring.
  const s = await scenario({ sessionFile: '/tmp/pigroups-compat-supported.jsonl' });
  t.after(async () => {
    console.warn = original;
    await s.close();
  });

  await s.cycle();
  assert.deepEqual(warnings, [], 'a matching platform must not add noise to the one startup line');
});

test('an unsupported platform warns once at startup and the loop keeps working', async (t) => {
  const s = await scenario({ sessionFile: '/tmp/pigroups-compat-unsupported.jsonl' });
  const realWhoami = s.pg.whoami.bind(s.pg);
  s.pg.whoami = async () => ({ ...(await realWhoami()), server: { version: '0.8.9' } });

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
  assert.match(warnings[0], /platform 0\.8\.9/);
  assert.ok(warnings[0].includes(ADAPTER_VERSION));

  await s.cycle();
  assert.equal(warnings.length, 1, 'startup is initialised once; the warning does not repeat');
  assert.deepEqual(s.loop.state().owed, [], 'the member still started and its state is usable');
});
