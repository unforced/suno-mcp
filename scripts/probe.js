#!/usr/bin/env node
// Probe Suno's page internals via CDP to find direct-invocation paths.
// Run: node scripts/probe.js

const WebSocket = require('ws');

const CDP_URL = process.env.CDP_URL || 'http://localhost:9100';

async function cdpListTargets() {
  const res = await fetch(`${CDP_URL}/json/list`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function rpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.off('message', handler);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const res = await rpc(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (res.exceptionDetails) {
    return { error: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
  }
  return res.result?.value;
}

async function main() {
  const targets = await cdpListTargets();
  const suno = targets.find(t => t.type === 'page' && t.url.includes('suno.com'));
  if (!suno) {
    console.error('No Suno page found. Open https://suno.com/create in BrowserOS.');
    process.exit(1);
  }
  console.log('Suno page:', suno.url);
  const ws = await connect(suno.webSocketDebuggerUrl);

  // 1) Probe window globals
  console.log('\n=== Window globals (generate/captcha/store-ish) ===');
  const globals = await evaluate(ws, `
    (function() {
      const keys = Object.keys(window);
      const interesting = keys.filter(k => /generate|captcha|suno|store|zustand|clerk/i.test(k));
      return { totalKeys: keys.length, interesting };
    })()
  `);
  console.log(JSON.stringify(globals, null, 2));

  // 2) Find React root and walk fiber for stores / onClick handlers
  console.log('\n=== React fiber probe (Create button) ===');
  const fiberProbe = await evaluate(ws, `
    (function() {
      function getReactProps(el) {
        const key = Object.keys(el).find(k => k.startsWith('__reactProps$'));
        return key ? el[key] : null;
      }
      function getReactFiber(el) {
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
        return key ? el[key] : null;
      }
      const btn = document.querySelector('button[aria-label="Create song"]');
      if (!btn) return { error: 'Create button not found' };
      const props = getReactProps(btn);
      const fiber = getReactFiber(btn);
      // Walk up fiber to find stateNode with useful methods
      const chain = [];
      let f = fiber;
      let depth = 0;
      while (f && depth < 30) {
        const typeName = typeof f.type === 'string' ? f.type : (f.type?.displayName || f.type?.name || null);
        const memoState = f.memoizedState ? 'yes' : 'no';
        const memoProps = f.memoizedProps ? Object.keys(f.memoizedProps).slice(0, 8) : [];
        chain.push({ depth, type: typeName, memoState, props: memoProps });
        f = f.return;
        depth++;
      }
      return {
        hasProps: !!props,
        propKeys: props ? Object.keys(props) : [],
        onClick: typeof props?.onClick,
        chain,
      };
    })()
  `);
  console.log(JSON.stringify(fiberProbe, null, 2));

  // 3) Look for Zustand stores attached as window props or on React fiber
  console.log('\n=== Script tags / module hints ===');
  const scriptHints = await evaluate(ws, `
    (function() {
      const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
      return {
        chunks: scripts.filter(s => /generate|create|captcha|suno/i.test(s)).slice(0, 20),
        total: scripts.length,
      };
    })()
  `);
  console.log(JSON.stringify(scriptHints, null, 2));

  // 4) Check hCaptcha presence
  console.log('\n=== hCaptcha state ===');
  const captcha = await evaluate(ws, `
    (function() {
      return {
        hcaptchaExists: typeof window.hcaptcha,
        hcaptchaKeys: typeof window.hcaptcha === 'object' ? Object.keys(window.hcaptcha).slice(0, 30) : null,
        iframes: Array.from(document.querySelectorAll('iframe')).map(f => f.src).filter(s => s.includes('captcha')),
      };
    })()
  `);
  console.log(JSON.stringify(captcha, null, 2));

  // 5) Inspect Clerk / auth token source
  console.log('\n=== Clerk / auth ===');
  const clerk = await evaluate(ws, `
    (function() {
      return {
        hasClerk: typeof window.Clerk,
        clerkKeys: typeof window.Clerk === 'object' ? Object.keys(window.Clerk).slice(0, 30) : null,
        sessionKeys: window.Clerk?.session ? Object.keys(window.Clerk.session).slice(0, 30) : null,
      };
    })()
  `);
  console.log(JSON.stringify(clerk, null, 2));

  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
