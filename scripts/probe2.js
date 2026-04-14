#!/usr/bin/env node
// Probe 2: verify Clerk token retrieval and fiber-level invocation paths.

const WebSocket = require('ws');
const CDP_URL = process.env.CDP_URL || 'http://localhost:9100';

async function cdpListTargets() {
  const res = await fetch(`${CDP_URL}/json/list`);
  return res.json();
}
function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}
function rpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(ws, expression) {
  const res = await rpc(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (res.exceptionDetails) return { error: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
  return res.result?.value;
}

async function main() {
  const targets = await cdpListTargets();
  const suno = targets.find(t => t.type === 'page' && t.url.includes('suno.com'));
  const ws = await connect(suno.webSocketDebuggerUrl);

  console.log('=== Clerk token fetch ===');
  const clerkTok = await evaluate(ws, `
    (async function(){
      try {
        if (!window.Clerk?.session) return { error: 'No Clerk session' };
        const tok = await window.Clerk.session.getToken();
        return { ok: true, tokenLen: tok?.length, preview: tok?.slice(0, 30) + '...' };
      } catch (e) { return { error: e.message }; }
    })()
  `);
  console.log(JSON.stringify(clerkTok, null, 2));

  console.log('\n=== onCreateClick at fiber depth 7 ===');
  const onCreateClick = await evaluate(ws, `
    (function(){
      const btn = document.querySelector('button[aria-label="Create song"]');
      if (!btn) return { error: 'No button' };
      const fiberKey = Object.keys(btn).find(k => k.startsWith('__reactFiber$'));
      let f = btn[fiberKey];
      let depth = 0;
      while (f && depth < 30) {
        if (f.memoizedProps && typeof f.memoizedProps.onCreateClick === 'function') {
          return { depth, keys: Object.keys(f.memoizedProps), hasCreateClick: true };
        }
        f = f.return; depth++;
      }
      return { found: false };
    })()
  `);
  console.log(JSON.stringify(onCreateClick, null, 2));

  console.log('\n=== Look for Zustand-like stores on document/window ===');
  const stores = await evaluate(ws, `
    (function(){
      // Walk react fiber from any Suno component, looking for memoizedState hooks
      const btn = document.querySelector('button[aria-label="Create song"]');
      const fk = Object.keys(btn).find(k => k.startsWith('__reactFiber$'));
      let f = btn[fk];
      const stores = [];
      let depth = 0;
      while (f && depth < 50) {
        let hook = f.memoizedState;
        let hi = 0;
        while (hook && hi < 20) {
          // Zustand stores expose { getState, setState, subscribe, destroy }
          const v = hook.memoizedState;
          if (v && typeof v === 'object' && typeof v.getState === 'function' && typeof v.setState === 'function') {
            try {
              const state = v.getState();
              stores.push({ depth, hi, stateKeys: Object.keys(state).slice(0, 40) });
            } catch (e) {}
          }
          hook = hook.next; hi++;
        }
        f = f.return; depth++;
      }
      return stores;
    })()
  `);
  console.log(JSON.stringify(stores, null, 2));

  console.log('\n=== Webpack module search for generate functions ===');
  const webpack = await evaluate(ws, `
    (function(){
      // Many Next.js apps expose webpack chunks via window
      const keys = Object.keys(window).filter(k => k.startsWith('webpackChunk'));
      return { chunks: keys };
    })()
  `);
  console.log(JSON.stringify(webpack, null, 2));

  console.log('\n=== hCaptcha execute API ===');
  const hc = await evaluate(ws, `
    (function(){
      const h = window.hcaptcha;
      if (!h) return { none: true };
      return {
        type: typeof h,
        keys: typeof h === 'object' ? Object.keys(h) : null,
        fns: typeof h === 'object' ? Object.keys(h).filter(k => typeof h[k] === 'function') : null,
      };
    })()
  `);
  console.log(JSON.stringify(hc, null, 2));

  ws.close();
}
main().catch(e => { console.error(e); process.exit(1); });
