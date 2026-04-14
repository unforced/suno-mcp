/**
 * Suno API Client.
 *
 * Strategy:
 *   - Auth: pulled from window.Clerk.session.getToken() in the live Suno tab
 *     via CDP. No page reloads needed; Clerk handles refresh under the hood.
 *   - Read endpoints (credits, feed, projects): direct HTTPS with the JWT.
 *   - Generate: does NOT scrape visible buttons. Finds the React fiber that
 *     exposes `onCreateClick` / `lyrics` / `styles` / `mode` as props (an
 *     internal semantic component near the Create button), fills lyrics/
 *     styles into the page's React state, and invokes the handler directly.
 *     hCaptcha validation runs inside the page as a side effect.
 *   - Captures the /api/generate/v2 response via CDP Network events to return
 *     the new clip IDs. Falls back to polling `getRecentSongs` if the network
 *     event is missed.
 *
 * Requires BrowserOS (or any Chromium with --remote-debugging-port) on
 * $CDP_URL (default http://localhost:9100), logged into suno.com.
 */

const { CdpSession, findSunoTarget } = require('./cdp.js');

const SUNO_BASE = 'https://studio-api.prod.suno.com';

class SunoClient {
  constructor() {
    this.token = null;
    this.tokenExpiry = 0;
  }

  // ---------- Auth ----------

  async _withSunoSession(fn, { navigate = true } = {}) {
    const { target } = await findSunoTarget({ navigate });
    if (!target) throw new Error('No Suno tab open. Open https://suno.com/create in BrowserOS.');
    const sess = new CdpSession(target.webSocketDebuggerUrl);
    await sess.open();
    try {
      return await fn(sess, target);
    } finally {
      sess.close();
    }
  }

  async refreshToken() {
    const token = await this._withSunoSession(async (sess) => {
      const result = await sess.evaluate(`
        (async () => {
          if (!window.Clerk) return { error: 'Clerk not loaded yet. Reload the Suno tab.' };
          if (!window.Clerk.session) return { error: 'Not signed in to Suno.' };
          try {
            const t = await window.Clerk.session.getToken();
            return { ok: true, token: t };
          } catch (e) {
            return { error: e && e.message || String(e) };
          }
        })()
      `);
      if (result?.error) throw new Error(result.error);
      return result?.token;
    });

    if (!token) throw new Error('Clerk returned no token');
    this.token = token;
    // JWT expiry is in the payload. Refresh 5min early.
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      this.tokenExpiry = (payload.exp * 1000) - (5 * 60 * 1000);
    } catch {
      this.tokenExpiry = Date.now() + 50 * 60 * 1000;
    }
    return token;
  }

  async ensureToken() {
    if (!this.token || Date.now() > this.tokenExpiry) await this.refreshToken();
    return this.token;
  }

  // ---------- HTTP ----------

  async apiRequest(endpoint, options = {}) {
    const token = await this.ensureToken();
    const doFetch = (tok) => fetch(`${SUNO_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${tok}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        ...(options.headers || {}),
      },
    });

    let response = await doFetch(token);
    if (response.status === 401) {
      this.token = null;
      const fresh = await this.ensureToken();
      response = await doFetch(fresh);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API ${endpoint} ${response.status}: ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  // ---------- Generation ----------

  /**
   * Drive Suno's internal generate flow via React fiber.
   *
   * @param {object} opts
   * @param {'custom'|'simple'} opts.mode
   * @param {string} [opts.lyrics]       custom-mode lyrics (or full text in simple)
   * @param {string} [opts.style]        custom-mode style tags
   * @param {string} [opts.simplePrompt] simple-mode description
   */
  async _driveGenerate(opts) {
    const triggerStart = Date.now();
    return this._withSunoSession(async (sess) => {
      await sess.send('Network.enable');
      await sess.send('Page.enable');

      // Navigate to /create if we're elsewhere within suno.com.
      const here = await sess.evaluate(`window.location.pathname`);
      if (!String(here || '').startsWith('/create')) {
        await sess.send('Page.navigate', { url: 'https://suno.com/create' });
        await sess.waitForEvent('Page.loadEventFired', 20000);
        // React hydration settles a beat after load.
        await new Promise(r => setTimeout(r, 1500));
      }

      // Listen for generate response BEFORE triggering.
      const capturedClips = this._captureGenerateResponse(sess);

      const payload = {
        mode: opts.mode,
        lyrics: opts.lyrics || '',
        style: opts.style || '',
        simplePrompt: opts.simplePrompt || '',
      };

      // Phase 1: populate React state with lyrics/styles/prompt. We do NOT
      // click the button from JS — hCaptcha rejects non-trusted events. We
      // synthesize the click via CDP Input.dispatchMouseEvent below, which the
      // browser treats as a real user gesture.
      const result = await sess.evaluate(`
        (async () => {
          const payload = ${JSON.stringify(payload)};
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));

          function walkUp(el, match, maxDepth = 40) {
            const fkey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
            if (!fkey) return null;
            let f = el[fkey], d = 0;
            while (f && d < maxDepth) {
              if (match(f)) return f;
              f = f.return; d++;
            }
            return null;
          }

          function setReactValue(el, value) {
            const proto = el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }

          // Find the semantic create fiber (has onCreateClick + mode props).
          const anchor = document.querySelector('button[aria-label="Create song"]')
            || document.querySelector('main') || document.body;
          const createFiber = walkUp(anchor, f =>
            f.memoizedProps && typeof f.memoizedProps.onCreateClick === 'function'
          );
          if (!createFiber) {
            return { success: false, error: 'Could not locate generate handler (onCreateClick) in React fiber.' };
          }

          const cp = createFiber.memoizedProps;
          if (cp.isGenerating) {
            return { success: false, error: 'A generation is already in progress. Wait for it to finish.' };
          }
          if (cp.isOutOfCredits) {
            return { success: false, error: 'Out of credits.' };
          }

          // Switch mode if needed. We can't reliably write React state from outside,
          // so we still click the mode toggle — but this is a simple tab, not fragile.
          const wantMode = payload.mode === 'simple' ? 'simple' : 'custom';
          if (cp.mode && cp.mode !== wantMode) {
            const label = wantMode === 'simple' ? 'simple' : 'custom';
            const tabBtn = Array.from(document.querySelectorAll('button, [role="tab"]')).find(b =>
              b.textContent && b.textContent.trim().toLowerCase() === label
            );
            if (tabBtn) { tabBtn.click(); await sleep(600); }
          }

          if (payload.mode === 'custom') {
            // Fill lyrics + style textareas. Stable selectors: data-testid + maxlength.
            const lyricsArea = document.querySelector('textarea[data-testid="lyrics-textarea"]')
              || Array.from(document.querySelectorAll('textarea')).find(t =>
                /lyric|write/i.test(t.placeholder || ''));
            if (!lyricsArea) return { success: false, error: 'Lyrics textarea not found.' };
            setReactValue(lyricsArea, payload.lyrics);

            let styleArea = document.querySelector(
              'textarea[maxlength="1000"]:not([data-testid="lyrics-textarea"])'
            );
            if (!styleArea) {
              styleArea = Array.from(document.querySelectorAll('textarea')).find(t =>
                t !== lyricsArea && !t.closest('[style*="display: none"]'));
            }
            if (!styleArea) return { success: false, error: 'Style textarea not found.' };
            setReactValue(styleArea, payload.style);
          } else {
            // Simple mode: single prompt textarea.
            const promptArea = document.querySelector('textarea[data-testid="prompt-textarea"]')
              || document.querySelector('textarea');
            if (!promptArea) return { success: false, error: 'Simple-mode prompt textarea not found.' };
            setReactValue(promptArea, payload.simplePrompt);
          }

          // Wait for React to re-render so the fiber's onCreateClick closes over
          // the updated lyrics/styles state (not the empty values at mount time).
          async function waitForFiberSync(attempts = 20) {
            for (let i = 0; i < attempts; i++) {
              const fresh = walkUp(
                document.querySelector('button[aria-label="Create song"]') || anchor,
                f => f.memoizedProps && typeof f.memoizedProps.onCreateClick === 'function'
              );
              if (!fresh) { await sleep(150); continue; }
              const p = fresh.memoizedProps;
              const ok = payload.mode === 'custom'
                ? (p.lyrics && p.lyrics.length > 0 && p.styles && (
                    Array.isArray(p.styles) ? p.styles.length > 0 : String(p.styles).length > 0
                  ))
                : (p.lyrics && p.lyrics.length > 0) || (p.simplePrompt && p.simplePrompt.length > 0);
              if (ok) return { fiber: fresh, waited: i * 150 };
              await sleep(150);
            }
            return { fiber: null };
          }

          const synced = await waitForFiberSync();
          const freshFiber = synced.fiber || walkUp(
            document.querySelector('button[aria-label="Create song"]') || anchor,
            f => f.memoizedProps && typeof f.memoizedProps.onCreateClick === 'function'
          );
          const propSnapshot = freshFiber?.memoizedProps || {};

          // Scroll button into view and report its coordinates so CDP can
          // dispatch a trusted mouse click (required by hCaptcha).
          const btnEl = document.querySelector('button[aria-label="Create song"]');
          if (!btnEl) return { success: false, error: 'Create button not in DOM.' };
          btnEl.scrollIntoView({ block: 'center' });
          await sleep(100);
          const r = btnEl.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) {
            return { success: false, error: 'Create button has zero size (not visible).' };
          }
          return {
            success: true,
            clickX: r.left + r.width / 2,
            clickY: r.top + r.height / 2,
            waitedMs: synced.waited || 0,
            observedLyricsLen: (propSnapshot.lyrics || '').length,
            observedStylesLen: Array.isArray(propSnapshot.styles)
              ? propSnapshot.styles.length
              : String(propSnapshot.styles || '').length,
            observedMode: propSnapshot.mode,
          };
        })()
      `);

      if (!result?.success) {
        throw new Error(result?.error || 'Unknown failure preparing Suno generate.');
      }
      if (process.env.SUNO_DEBUG) console.error('[suno] prepared generate:', result);

      // Phase 2: trusted click via CDP Input domain. hCaptcha accepts this as
      // a real user gesture; invoking onCreateClick directly does not.
      const { clickX: x, clickY: y } = result;
      await sess.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y, button: 'none', buttons: 0,
      });
      await sess.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
      });
      await new Promise(r => setTimeout(r, 40));
      await sess.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
      });

      // Wait for either the network capture or a timeout, then fall back to polling.
      const clips = await Promise.race([
        capturedClips,
        new Promise(resolve => setTimeout(() => resolve(null), 20000)),
      ]);

      if (clips && clips.length) {
        return { clips, message: 'Song generation started' };
      }

      // Fallback: query recent songs, only returning clips created after we
      // dispatched the click. Avoids returning stale top-of-feed results.
      try {
        const recent = await this.getRecentSongs();
        const raw = recent.project_clips || recent.clips || [];
        const flat = raw
          .map(c => c.clip || c)
          .filter(c => {
            const t = Date.parse(c.created_at || 0);
            return Number.isFinite(t) && t >= triggerStart - 2000;
          })
          .slice(0, 2);
        return {
          clips: flat,
          message: flat.length
            ? 'Generation triggered (clips resolved via recent list)'
            : 'Generation triggered — new clips not yet visible. Poll `suno_get_recent`.',
        };
      } catch {
        return { clips: [], message: 'Generation triggered — check recent songs for results' };
      }
    });
  }

  // Resolves to the clip array from the next /api/generate/v2 response,
  // or never — callers race this against a timeout.
  _captureGenerateResponse(sess) {
    return new Promise((resolve) => {
      const pendingByReqId = new Set();
      sess.on('Network.responseReceived', (params) => {
        if (params.response?.url?.includes('/api/generate/v2')) {
          pendingByReqId.add(params.requestId);
        }
      });
      sess.on('Network.loadingFinished', async (params) => {
        if (!pendingByReqId.has(params.requestId)) return;
        pendingByReqId.delete(params.requestId);
        try {
          const body = await sess.send('Network.getResponseBody', { requestId: params.requestId });
          const text = body?.body;
          if (!text) return;
          const parsed = JSON.parse(text);
          const clips = parsed.clips || parsed.data?.clips;
          if (clips && clips.length) resolve(clips);
        } catch { /* fall through to timeout */ }
      });
    });
  }

  async generateSong({ lyrics, style, title /* unused — Suno UI bug */, instrumental, model } = {}) {
    return this._driveGenerate({ mode: 'custom', lyrics, style });
  }

  async generateFromDescription(description) {
    return this._driveGenerate({ mode: 'simple', simplePrompt: description });
  }

  // ---------- Reads ----------

  async getCredits() {
    return this.apiRequest('/api/billing/info/');
  }

  async getSongStatus(ids) {
    const idsParam = Array.isArray(ids) ? ids.join(',') : ids;
    return this.apiRequest(`/api/feed/v2?ids=${idsParam}`);
  }

  async getRecentSongs(page = 1) {
    return this.apiRequest(`/api/project/default?page=${page}`);
  }

  async waitForSongs(ids, maxWait = 180000, pollInterval = 5000) {
    const start = Date.now();
    const songIds = Array.isArray(ids) ? ids : [ids];
    while (Date.now() - start < maxWait) {
      const status = await this.getSongStatus(songIds);
      const clips = Array.isArray(status) ? status : (status.clips || status);
      if (Array.isArray(clips) && clips.length) {
        const done = clips.every(c => c.status === 'complete' || c.status === 'streaming');
        if (done) {
          return clips.map(c => ({
            id: c.id,
            title: c.title,
            audioUrl: c.audio_url,
            imageUrl: c.image_url,
            videoUrl: c.video_url,
            duration: c.metadata?.duration || c.duration,
            status: c.status,
            sunoUrl: `https://suno.com/song/${c.id}`,
          }));
        }
      }
      await new Promise(r => setTimeout(r, pollInterval));
    }
    throw new Error('Timeout waiting for song generation');
  }

  async downloadSong(songId, folder, filename = null) {
    const fs = require('fs');
    const path = require('path');

    const status = await this.getSongStatus([songId]);
    const clips = Array.isArray(status) ? status : (status.clips || []);
    const song = clips.find(c => c.id === songId);
    if (!song) throw new Error(`Song not found: ${songId}`);
    if (song.status !== 'complete' && song.status !== 'streaming') {
      throw new Error(`Song not ready for download. Status: ${song.status}`);
    }

    const audioUrl = song.audio_url?.includes('cdn')
      ? song.audio_url
      : `https://cdn1.suno.ai/${songId}.mp3`;

    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

    const base = filename || song.title || songId;
    const safe = base.replace(/[^a-z0-9\-_\s]/gi, '').replace(/\s+/g, '-').toLowerCase();
    const filePath = path.join(folder, `${safe}.mp3`);

    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buf);

    return {
      path: filePath,
      size: buf.length,
      song: {
        id: song.id,
        title: song.title,
        audioUrl,
        sunoUrl: `https://suno.com/song/${songId}`,
      },
    };
  }
}

module.exports = { SunoClient };
