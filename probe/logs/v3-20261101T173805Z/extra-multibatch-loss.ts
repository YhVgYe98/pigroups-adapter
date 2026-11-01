import { send } from '/home/yang/Documents/pigroups-adapter/test/support.ts';
import { DEFAULT_DELIVERY_WINDOW_MS as WINDOW, scenario } from '/home/yang/Documents/pigroups-adapter/test/scenario.ts';

const s = await scenario();
try {
  await s.cycle();
  s.surface.beginTurn(); // a long tool: this turn stays open across two windows
  await send(s.platform, s.parent!.token, s.me.id, 'batch one');
  await s.cycle();
  await s.timer(WINDOW);
  console.log('deliveries after batch one:', s.surface.deliveries.length);

  await send(s.platform, s.parent!.token, s.me.id, 'batch two');
  await s.cycle();
  await s.timer(WINDOW);
  console.log('deliveries after batch two:', s.surface.deliveries.length);

  s.surface.settleAborted();
  await s.loop.settled();
  await s.loop.flush();
  console.log('deliveries after abort:', s.surface.deliveries.length);
  for (const [i, d] of s.surface.deliveries.entries()) {
    console.log(i, JSON.stringify(d.text));
  }
} finally {
  await s.close();
}
