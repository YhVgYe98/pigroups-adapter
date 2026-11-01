// §2.1 pi event → PiEvent mapping. The suite's other tests drive a FakeSurface, so the
// real mapping in surface.ts had no test at all until the real-machine probe found that
// an aborted run never reaches `agent_before_settle` (probe/, 2026-11-01).

import test from 'node:test';
import assert from 'node:assert/strict';

import { PiSurfaceAdapter, type PiEvent, type PiLike, type PiMessage, type PiSurface } from '../src/surface.ts';

type Handler = (event: never) => void;

/** A PiLike that only records its handlers, so the surface can be driven event by event. */
function fakePi(): {
  pi: PiLike;
  fire: (event: string, payload?: unknown) => void;
  sent: { message: PiMessage; options?: { triggerTurn?: boolean } }[];
} {
  const handlers = new Map<string, Handler[]>();
  const sent: { message: PiMessage; options?: { triggerTurn?: boolean } }[] = [];
  const pi = {
    sendMessage(message: PiMessage, options?: { triggerTurn?: boolean }): void {
      sent.push(options ? { message, options } : { message });
    },
    registerTool(): void {},
    on(event: string, handler: Handler): () => void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
  } as unknown as PiLike;
  return {
    pi,
    sent,
    fire(event: string, payload?: unknown): void {
      for (const handler of handlers.get(event) ?? []) handler(payload as never);
    },
  };
}

function collect(surface: PiSurface): PiEvent[] {
  const events: PiEvent[] = [];
  surface.onEvent((event) => events.push(event));
  return events;
}

test('a turn maps to turn_start, tool events map to tool_start/tool_end', () => {
  const { pi, fire } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const events = collect(surface);

  fire('agent_start');
  fire('tool_execution_start', { toolName: 'bash', args: { command: 'npm test' } });
  fire('tool_execution_end', { toolName: 'bash', isError: false });
  fire('tool_execution_end', { toolName: 'bash', isError: true });

  assert.deepEqual(
    events.map((event) => event.type),
    ['turn_start', 'tool_start', 'tool_end', 'tool_end'],
  );
  const start = events[1];
  assert.ok(start.type === 'tool_start');
  assert.equal(start.name, 'bash');
  assert.ok(start.argsPreview.includes('npm test'), 'the preview carries enough to see what ran');
  const ok = events[2];
  assert.ok(ok.type === 'tool_end');
  assert.equal(ok.ok, true);
  const failed = events[3];
  assert.ok(failed.type === 'tool_end');
  assert.equal(failed.ok, false);
});

test('before_settle closes the turn, and only a non-completed outcome carries an error', () => {
  const { pi, fire } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const events = collect(surface);

  fire('agent_start');
  fire('agent_before_settle', { outcome: 'completed' });
  fire('agent_start');
  fire('agent_before_settle', { outcome: 'error' });

  const ends = events.filter((event) => event.type === 'turn_end');
  assert.equal(ends.length, 2, 'every normal run ends with one turn_end');
  assert.equal(ends[0].error, undefined, 'a completed turn carries no error');
  assert.ok(ends[1].error, 'an errored turn must tell the parent');
});

test('an aborted run closes the turn from agent_settled, because it skips before_settle', () => {
  const { pi, fire } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const events = collect(surface);

  fire('agent_start');
  // What a live session actually does on abort: no before_settle at all (probe/ P2).
  fire('agent_settled', { aborted: true });

  const ends = events.filter((event) => event.type === 'turn_end');
  assert.equal(ends.length, 1, 'the loop must not be left with a turn that never ended');
  assert.ok(ends[0].error, 'the parent has to hear that the turn was cut');
  assert.match(ends[0].error!.message, /abort/i);
});

test('a completed run\'s settle closes nothing', () => {
  const { pi, fire } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const events = collect(surface);

  fire('agent_start');
  fire('agent_before_settle', { outcome: 'completed' });
  fire('agent_settled', { aborted: false });

  assert.equal(
    events.filter((event) => event.type === 'turn_end').length,
    1,
    'a turn that already ended must not get a second turn_end from the settle callback',
  );
});

test('an abort that lands after before_settle does not close the turn twice', () => {
  const { pi, fire } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const events = collect(surface);

  fire('agent_start');
  fire('agent_before_settle', { outcome: 'completed' });
  // Another extension aborted in its async boundary after the settle decision was
  // made: pi reports the run as aborted even though before_settle already closed it.
  fire('agent_settled', { aborted: true });

  const ends = events.filter((event) => event.type === 'turn_end');
  assert.equal(ends.length, 1, 'one turn has one end, whatever the abort race does');
  assert.equal(ends[0].error, undefined, 'the close that happened first is the one that counts');
});

test('an orphan aborted settle does not invent a turn that never started', () => {
  const { pi, fire } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const events = collect(surface);

  // No agent_start: the adapter attached after the run had already begun, or pi
  // settled a run whose start this listener never saw.
  fire('agent_settled', { aborted: true });

  assert.deepEqual(events, [], 'without an open turn there is nothing to close');
});

test('a turn reopened by a new agent_start is closed by its own abort', () => {
  const { pi, fire } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const events = collect(surface);

  fire('agent_start');
  fire('agent_settled', { aborted: true });
  fire('agent_start');
  fire('agent_settled', { aborted: true });

  assert.equal(events.filter((event) => event.type === 'turn_end').length, 2, 'each run gets one end');
});

test('the settle callback runs for every run, aborted or not, and the turn_end precedes it', () => {
  const { pi, fire } = fakePi();
  const surface = new PiSurfaceAdapter(pi);
  const order: string[] = [];
  surface.onEvent((event) => order.push(event.type));
  let settles = 0;
  surface.onSettled(() => {
    settles += 1;
    order.push('settled');
  });

  fire('agent_start');
  fire('agent_settled', { aborted: true });
  fire('agent_start');
  fire('agent_before_settle', { outcome: 'completed' });
  fire('agent_settled', { aborted: false });

  assert.equal(settles, 2, 'both runs settle');
  assert.deepEqual(order, ['turn_start', 'turn_end', 'settled', 'turn_start', 'turn_end', 'settled']);
});

test('deliver sends a custom message that asks pi to start a turn', () => {
  const { pi, sent } = fakePi();
  const surface = new PiSurfaceAdapter(pi);

  void surface.deliver('hello', 'message');

  assert.equal(sent.length, 1, 'one delivery is one message');
  assert.equal(sent[0].message.customType, 'pigroups', 'the custom type is what the loop filters on');
  assert.equal(sent[0].message.content, 'hello');
  assert.equal(sent[0].options?.triggerTurn, true, 'without triggerTurn the member is never woken');
});
