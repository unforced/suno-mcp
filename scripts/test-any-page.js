#!/usr/bin/env node
// Exercises _driveGenerate up to the trusted click — but SKIPS the click —
// to confirm the navigation-to-/create + fiber discovery works from anywhere.

const { findSunoTarget, CdpSession } = require('../src/cdp.js');

async function main() {
  const { target } = await findSunoTarget({ navigate: false });
  const s = new CdpSession(target.webSocketDebuggerUrl);
  await s.open();
  const before = await s.evaluate('window.location.pathname');
  console.log('before:', before);
  await s.send('Page.enable');

  if (!String(before).startsWith('/create')) {
    await s.send('Page.navigate', { url: 'https://suno.com/create' });
    await s.waitForEvent('Page.loadEventFired', 20000);
    await new Promise(r => setTimeout(r, 1500));
  }
  const after = await s.evaluate('window.location.pathname');
  const fiberOk = await s.evaluate(`
    (() => {
      const btn = document.querySelector('button[aria-label="Create song"]');
      if (!btn) return { err: 'button missing' };
      const fk = Object.keys(btn).find(k => k.startsWith('__reactFiber$'));
      let f = btn[fk], d = 0;
      while (f && d < 30) {
        if (f.memoizedProps && typeof f.memoizedProps.onCreateClick === 'function') {
          return { ok: true, depth: d, mode: f.memoizedProps.mode };
        }
        f = f.return; d++;
      }
      return { err: 'fiber missing' };
    })()
  `);
  console.log('after:', after, 'fiber:', fiberOk);
  s.close();
}
main().catch(e => { console.error(e); process.exit(1); });
