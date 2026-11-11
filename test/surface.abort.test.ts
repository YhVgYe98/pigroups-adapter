// §2.1's non-mapping half: `abort()`, `isBusy()`, `shutdown()`, the two unsubscribe
// functions, and the argument preview. `surface.test.ts` covers the pi-event mapping;
// these are the methods the loop calls on a live session and none of them had a test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PiSurfaceAdapter, type PiContext, type PiLike, type PiMessage } from '../src/surface.ts';

type Handler = (event: never, ctx: never) => void;

function fakePi(): {
  pi: PiLike;
  fire: (event: string, payload?: unknown) => void;
  sent: { message: PiMessage; options?: { triggerTurn?: boolean; deliverAs?: string } }[];
} {
  const handlers = new Map<string, Handler[]>();
  const sent: { message: PiMessage; options?: { triggerTurn?: boolean; deliverAs?: string } }[] = [];
  const pi = {
    sendMessage(message: PiMessage, options?: { triggerTurn?: boolean; deliverAs?: string }): void {
      sent.push(options ? { message, options } : { message });
    },
    registerTool(): void {},
    on(event: string, handler: Handler): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const at = list.indexOf(handler);
        if (at >= 0) list.splice(at, 1);
      };
    },
  } as unknown as PiLike;
  return {
    pi,
    sent,
    fire(event: string, payload?: unknown): void {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload as never, undefined as never);
    },
  };
}

function fakeCtx(initial: 'idle' | 'busy' = 'idle'): {
  ctx: PiContext;
  setBusy(): void;
  setIdle(): void;
  calls: { abort: number; shutdown: number; isIdle: number };
} {
  let idle = initial === 'idle';
  const calls = { abort: 0, shutdown: 0, isIdle: 0 };
  return {
    ctx: {
      isIdle(): boolean {
        calls.isIdle += 1;
        return idle;
      },
      abort(): void {
        calls.abort += 1;
      },
      shutdown(): void {
        calls.shutdown += 1;
      },
    },
    setBusy(): void {
      idle = false;
    },
    setIdle(): void {
      idle = true;
    },
    calls,
  };
}

function quietWarn(): { warns: string[]; restore(): void } {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    warns.push(args.map((arg) => String(arg)).join(' '));
  };
  return {
    warns,
    restore(): void {
      console.warn = original;
    },
  };
}

test('abort() before session_start returns at once, and no context is ever reported idle', async () => {
  const { pi } = fakePi();
  const surface = new PiSurfaceAdapter(pi);

  await surface.abort();

  assert.equal(
    surface.isBusy(),
    true,
    'concept §8.1: an unknown state must not open the delivery gate — no context means busy, not idle',
  );
});

test('abort() while idle does not ask pi to abort anything', async () => {
  const { pi } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const fake = fakeCtx('idle');
  surface.attachContext(fake.ctx);

  await surface.abort();

  assert.equal(fake.calls.abort, 0, 'there is no turn to cut');
});

test('abort() calls ctx.abort() and returns once isIdle() turns true', async () => {
  const { pi } = fakePi();
  const surface = new PiSurfaceAdapter(pi, { idlePollMs: 2, abortIdleTimeoutMs: 500 });
  const fake = fakeCtx('busy');
  surface.attachContext(fake.ctx);

  const wait = surface.abort();
  assert.equal(fake.calls.abort, 1, 'a running turn is cut immediately');
  const sampledBefore = fake.calls.isIdle;
  fake.setIdle();
  await wait;

  assert.ok(fake.calls.isIdle > sampledBefore, 'the wait polls isIdle() instead of assuming');
  assert.equal(fake.calls.abort, 1, 'one abort request, not one per poll');
});

test('abort() gives up at the bound, warns, and leaves the abort request standing', async () => {
  const { pi } = fakePi();
  const surface = new PiSurfaceAdapter(pi, { idlePollMs: 1, abortIdleTimeoutMs: 20 });
  const fake = fakeCtx('busy');
  surface.attachContext(fake.ctx);
  const warn = quietWarn();
  try {
    const started = Date.now();
    await surface.abort();
    assert.ok(Date.now() - started >= 15, 'it waits for the bound instead of returning at once');
  } finally {
    warn.restore();
  }

  assert.equal(fake.calls.abort, 1, 'the abort request is not withdrawn when the wait gives up');
  assert.equal(warn.warns.length, 1, 'giving up must be visible, not silent');
  assert.match(warn.warns[0], /gave up after 20 ms/);
  assert.match(warn.warns[0], /still running/);
});

test('abort() returns at once when the stop signal fires, without warning', async () => {
  const { pi } = fakePi();
  const surface = new PiSurfaceAdapter(pi, { idlePollMs: 1, abortIdleTimeoutMs: 10_000 });
  const fake = fakeCtx('busy');
  surface.attachContext(fake.ctx);
  const warn = quietWarn();
  const stop = new AbortController();
  stop.abort();
  try {
    const started = Date.now();
    await surface.abort(stop.signal);
    assert.ok(Date.now() - started < 1000, 'an already-aborted signal must not wait for the bound');
  } finally {
    warn.restore();
  }

  assert.equal(warn.warns.length, 0, 'a caller-requested stop is not a give-up');
  assert.equal(fake.calls.abort, 1, 'the turn was still cut before the wait returned');
});

test('isBusy() follows the context, and answers busy until one is attached', () => {
  const { pi } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const fake = fakeCtx('idle');

  assert.equal(surface.isBusy(), true, 'no context: unknown is busy, never idle (concept §8.1)');
  surface.attachContext(fake.ctx);
  assert.equal(surface.isBusy(), false, 'an idle context is not busy');
  fake.setBusy();
  assert.equal(surface.isBusy(), true, 'a running turn is busy');
  fake.setIdle();
  assert.equal(surface.isBusy(), false, 'a settled turn is not busy');
});

test('shutdown() calls ctx.shutdown() and is a no-op without a context', () => {
  const { pi } = fakePi();
  const surface = new PiSurfaceAdapter(pi);

  surface.shutdown('before start');
  const fake = fakeCtx();
  surface.attachContext(fake.ctx);
  surface.shutdown('terminated');

  assert.equal(fake.calls.shutdown, 1, 'the reason is not an argument to ctx.shutdown(), but the call happens once');
});

test('onSettled unsubscribe stops the callback', () => {
  const { pi, fire } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  let calls = 0;
  const unsubscribe = surface.onSettled(() => {
    calls += 1;
  });

  fire('agent_settled', { aborted: false });
  unsubscribe();
  fire('agent_settled', { aborted: false });

  assert.equal(calls, 1, 'a listener removed by the loop must not be called on the next settle');
});

test('onEvent unsubscribe stops the callback', () => {
  const { pi, fire } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const seen: string[] = [];
  const unsubscribe = surface.onEvent((event) => seen.push(event.type));

  fire('agent_start');
  unsubscribe();
  fire('agent_start');

  assert.deepEqual(seen, ['turn_start'], 'a listener removed by the loop must not see later events');
});

test('a tool argument preview is truncated and survives a value JSON cannot serialise', () => {
  const { pi, fire } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const previews: string[] = [];
  surface.onEvent((event) => {
    if (event.type === 'tool_start') previews.push(event.argsPreview);
  });

  fire('tool_execution_start', { toolName: 'bash', args: { command: 'x'.repeat(500) } });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  fire('tool_execution_start', { toolName: 'bash', args: circular });
  fire('tool_execution_start', { toolName: 'bash', args: { big: 1n } });

  assert.ok(previews[0].length <= 201, `preview must be bounded, got ${previews[0].length} chars`);
  assert.ok(previews[0].endsWith('…'), 'a truncated preview says so');
  assert.equal(previews[1], '', 'a circular argument serialises to nothing instead of throwing');
  assert.equal(previews[2], '', 'a BigInt argument serialises to nothing instead of throwing');
});
