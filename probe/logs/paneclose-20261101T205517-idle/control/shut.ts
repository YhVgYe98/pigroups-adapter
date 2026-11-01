export default function (pi: any): void {
  let n = 0;
  pi.on('agent_settled', () => {
    n += 1;
    console.log(`[ctl] agent_settled n=${n} at ${new Date().toISOString()}`);
    if (n === 1) {
      console.log(`[ctl] calling ctx.shutdown() at ${new Date().toISOString()}`);
    }
  });
  pi.on('session_start', (_e: any, ctx: any) => {
    console.log(`[ctl] session_start at ${new Date().toISOString()}`);
    const t = setInterval(() => {
      // poll n via closure: keep it simple, shut down on the first settled
      if (n >= 1) { clearInterval(t); ctx.shutdown(); }
    }, 20);
  });
  pi.on('session_shutdown', () => { console.log(`[ctl] session_shutdown at ${new Date().toISOString()}`); });
}
