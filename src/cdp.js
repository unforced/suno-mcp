// Small CDP client wrapper. Promise-based RPC over a single WebSocket.
// Spec: https://chromedevtools.github.io/devtools-protocol/

const WebSocket = require('ws');

const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = process.env.CDP_PORT || '9100';
const CDP_URL = process.env.CDP_URL || `http://${CDP_HOST}:${CDP_PORT}`;

async function listTargets() {
  let res;
  try {
    res = await fetch(`${CDP_URL}/json/list`);
  } catch (e) {
    throw new Error(`CDP unreachable at ${CDP_URL} (${e.message}). Is BrowserOS running with --remote-debugging-port?`);
  }
  if (!res.ok) throw new Error(`CDP at ${CDP_URL} returned ${res.status}. Is BrowserOS running?`);
  return res.json();
}

async function findSunoTarget({ navigate = true } = {}) {
  const targets = await listTargets();
  let suno = targets.find(t => t.type === 'page' && !t.parentId && t.url.includes('suno.com'));
  if (suno) return { target: suno, navigated: false };

  if (!navigate) return { target: null, navigated: false };

  // No Suno tab open — navigate the first available page.
  const spare = targets.find(t => t.type === 'page' && !t.parentId);
  if (!spare) throw new Error('No browser pages available. Is BrowserOS running?');

  const sess = new CdpSession(spare.webSocketDebuggerUrl);
  await sess.open();
  await sess.send('Page.enable');
  await sess.send('Page.navigate', { url: 'https://suno.com/create' });
  await sess.waitForEvent('Page.loadEventFired', 20000);
  await new Promise(r => setTimeout(r, 1500));
  sess.close();

  const refreshed = await listTargets();
  suno = refreshed.find(t => t.type === 'page' && !t.parentId && t.url.includes('suno.com'));
  if (!suno) throw new Error('Failed to navigate a tab to suno.com');
  return { target: suno, navigated: true };
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('error', (err) => {
        for (const [, { reject: r }] of this.pending) r(err);
        this.pending.clear();
        reject(err);
      });
      this.ws.on('message', (data) => this._handle(data));
    });
  }

  _handle(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      const ls = this.listeners.get(msg.method);
      if (ls) for (const l of ls) l(msg.params);
      const all = this.listeners.get('*');
      if (all) for (const l of all) l(msg);
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  waitForEvent(event, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        off();
        reject(new Error(`Timeout waiting for ${event}`));
      }, timeoutMs);
      const off = this.on(event, (params) => {
        clearTimeout(to);
        off();
        resolve(params);
      });
    });
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue,
    });
    if (res.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description
        || res.exceptionDetails.exception?.value
        || res.exceptionDetails.text;
      throw new Error(`Runtime.evaluate: ${msg}`);
    }
    return res.result?.value;
  }

  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}

module.exports = { CdpSession, listTargets, findSunoTarget, CDP_URL };
