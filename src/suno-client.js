/**
 * Suno API Client
 *
 * Uses browser JS injection for generation (to handle CAPTCHA)
 * and direct API calls for read operations.
 */

const WebSocket = require('ws');

const SUNO_BASE = 'https://studio-api.prod.suno.com';
const CDP_URL = 'http://127.0.0.1:9000';

class SunoClient {
  constructor() {
    this.token = null;
    this.tokenExpiry = 0;
  }

  /**
   * Get a CDP connection to the Suno page
   */
  async getSunoPage() {
    const response = await fetch(`${CDP_URL}/json/list`);
    const targets = await response.json();

    let pageTarget = targets.find(t =>
      t.type === 'page' &&
      !t.parentId &&
      t.url.includes('suno.com')
    );

    if (!pageTarget) {
      // Navigate any page to Suno
      pageTarget = targets.find(t => t.type === 'page' && !t.parentId);
      if (pageTarget) {
        // Navigate to Suno
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.on('open', () => {
            ws.send(JSON.stringify({
              id: 1,
              method: 'Page.navigate',
              params: { url: 'https://suno.com/create' }
            }));
          });
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 1) {
              // Wait for load
              setTimeout(() => {
                ws.close();
                resolve();
              }, 3000);
            }
          });
          ws.on('error', reject);
        });
      }
    }

    if (!pageTarget) {
      throw new Error('No browser pages available. Is BrowserOS running?');
    }

    return pageTarget;
  }

  /**
   * Get auth token from the __session cookie
   */
  async getTokenFromCookies() {
    const response = await fetch(`${CDP_URL}/json/list`);
    const targets = await response.json();

    const pageTarget = targets.find(t => t.type === 'page' && !t.parentId);
    if (!pageTarget) {
      throw new Error('No browser pages available');
    }

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout getting cookies'));
      }, 10000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1) {
          clearTimeout(timeout);
          ws.close();

          const cookies = msg.result?.cookies || [];
          const sessionCookie = cookies.find(c =>
            c.name === '__session' && c.domain === 'suno.com'
          );

          resolve(sessionCookie?.value || null);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Reload Suno page to refresh the auth token
   */
  async reloadSunoPage() {
    const response = await fetch(`${CDP_URL}/json/list`);
    const targets = await response.json();

    let pageTarget = targets.find(t =>
      t.type === 'page' &&
      !t.parentId &&
      t.url.includes('suno.com')
    );

    const needsNavigation = !pageTarget;
    if (!pageTarget) {
      pageTarget = targets.find(t => t.type === 'page' && !t.parentId);
    }

    if (!pageTarget) {
      throw new Error('No browser pages available');
    }

    console.error('Connecting to page:', pageTarget.url);
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    return new Promise((resolve, reject) => {
      let msgId = 0;
      let token = null;
      let pageLoaded = false;

      const send = (method, params = {}) => {
        msgId++;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return msgId;
      };

      const timeout = setTimeout(() => {
        ws.close();
        if (token) {
          resolve(token);
        } else {
          reject(new Error('Timeout waiting for token refresh. Make sure Suno is logged in.'));
        }
      }, 30000);

      ws.on('open', () => {
        // Enable network monitoring to capture the fresh token
        send('Network.enable');
        send('Page.enable');

        // Navigate to Suno create page (or reload if already there)
        if (needsNavigation || !pageTarget.url.includes('suno.com/create')) {
          console.error('Navigating to Suno create page...');
          send('Page.navigate', { url: 'https://suno.com/create' });
        } else {
          console.error('Reloading Suno page...');
          send('Page.reload', { ignoreCache: true });
        }
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        // Track page load
        if (msg.method === 'Page.loadEventFired') {
          pageLoaded = true;
          console.error('Page loaded, waiting for API requests...');
        }

        // Capture fresh auth token from network requests
        if (msg.method === 'Network.requestWillBeSent') {
          const { request } = msg.params;
          if (request.url.includes('studio-api.prod.suno.com') &&
              request.headers.Authorization) {
            const authHeader = request.headers.Authorization;
            if (authHeader.startsWith('Bearer ')) {
              token = authHeader.substring(7);
              console.error('Captured fresh token from API request');
              clearTimeout(timeout);
              ws.close();
              resolve(token);
            }
          }
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error('WebSocket error:', err.message);
        reject(err);
      });
    });
  }

  /**
   * Refresh the auth token
   */
  async refreshToken() {
    // First try to get token from cookies
    try {
      const cookieToken = await this.getTokenFromCookies();
      if (cookieToken) {
        const parts = cookieToken.split('.');
        if (parts.length === 3) {
          try {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
            const exp = payload.exp * 1000;
            if (exp > Date.now()) {
              console.error('Using valid token from cookie');
              this.token = cookieToken;
              this.tokenExpiry = exp - (5 * 60 * 1000);
              return this.token;
            } else {
              console.error('Cookie token expired, need to refresh...');
            }
          } catch (e) {
            console.error('Error parsing cookie token:', e.message);
          }
        }
      } else {
        console.error('No session cookie found');
      }
    } catch (e) {
      console.error('Error getting cookies:', e.message);
    }

    // Cookie token is expired or invalid - reload page to get fresh token
    console.error('Reloading Suno page to refresh auth token...');
    const freshToken = await this.reloadSunoPage();

    if (!freshToken) {
      throw new Error('Could not get valid token from browser. Make sure Suno is open and logged in.');
    }

    // Parse expiry from fresh token
    const parts = freshToken.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        const exp = payload.exp * 1000;
        this.token = freshToken;
        this.tokenExpiry = exp - (5 * 60 * 1000);
        console.error('Token refreshed successfully, expires:', new Date(exp).toISOString());
        return this.token;
      } catch (e) {
        console.error('Error parsing fresh token:', e.message);
      }
    }

    // Fallback expiry
    this.token = freshToken;
    this.tokenExpiry = Date.now() + (50 * 60 * 1000);
    return this.token;
  }

  async ensureToken() {
    if (!this.token || Date.now() > this.tokenExpiry) {
      await this.refreshToken();
    }
    return this.token;
  }

  /**
   * Make an authenticated API request (for read operations)
   */
  async apiRequest(endpoint, options = {}) {
    const token = await this.ensureToken();
    const url = `${SUNO_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        ...options.headers
      }
    });

    if (response.status === 401) {
      this.token = null;
      this.tokenExpiry = 0;
      const newToken = await this.ensureToken();

      const retryResponse = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${newToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          ...options.headers
        }
      });

      if (!retryResponse.ok) {
        const text = await retryResponse.text();
        throw new Error(`API request failed: ${retryResponse.status} - ${text}`);
      }

      return retryResponse.json();
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed: ${response.status} - ${text}`);
    }

    return response.json();
  }

  /**
   * Generate a song using browser JS injection (handles CAPTCHA automatically)
   */
  async generateSong({ lyrics, style, title, instrumental = false, model = 'chirp-v4' }) {
    const pageTarget = await this.getSunoPage();
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    return new Promise((resolve, reject) => {
      let msgId = 0;
      const send = (method, params = {}) => {
        msgId++;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return msgId;
      };

      const waitForResult = (targetId) => {
        return new Promise((res) => {
          const handler = (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === targetId) {
              ws.off('message', handler);
              res(msg);
            }
          };
          ws.on('message', handler);
        });
      };

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for song generation'));
      }, 60000);

      ws.on('open', async () => {
        try {
          // Enable network monitoring
          send('Network.enable');

          // Escape strings for JS
          const escapedLyrics = lyrics.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
          const escapedStyle = style.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
          const escapedTitle = title ? title.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$') : '';

          // Fill form and click create via JS
          const fillId = send('Runtime.evaluate', {
            expression: `
              (async function() {
                try {
                  const textareas = Array.from(document.querySelectorAll('textarea'));

                  // Find lyrics textarea
                  const lyricsArea = textareas.find(t =>
                    t.placeholder?.toLowerCase().includes('lyric') ||
                    t.placeholder?.toLowerCase().includes('write')
                  ) || textareas[0];

                  // Find style textarea
                  const styleArea = textareas.find(t =>
                    t.placeholder?.toLowerCase().includes('style') ||
                    t.placeholder?.toLowerCase().includes('genre') ||
                    t.placeholder?.toLowerCase().includes('synth') ||
                    t.placeholder?.toLowerCase().includes('raï')
                  ) || textareas[1];

                  if (!lyricsArea || !styleArea) {
                    return JSON.stringify({ success: false, error: 'Could not find form fields' });
                  }

                  // Set lyrics
                  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                  setter.call(lyricsArea, \`${escapedLyrics}\`);
                  lyricsArea.dispatchEvent(new Event('input', { bubbles: true }));

                  // Set style
                  setter.call(styleArea, \`${escapedStyle}\`);
                  styleArea.dispatchEvent(new Event('input', { bubbles: true }));

                  // Set title if provided
                  const titleToSet = \`${escapedTitle}\`;
                  if (titleToSet) {
                    // Find title input by placeholder - it's visible on the page
                    const titleInput = document.querySelector('input[placeholder*="Title"]');
                    if (titleInput) {
                      // Use native setter like we do for textareas to properly trigger React
                      const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                      inputSetter.call(titleInput, titleToSet);
                      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
                      titleInput.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  }

                  // Wait for React to process
                  await new Promise(r => setTimeout(r, 500));

                  // Find and click Create button (may say "Create" or "Create song")
                  const createBtn = Array.from(document.querySelectorAll('button')).find(b =>
                    (b.textContent?.toLowerCase().trim() === 'create' ||
                     b.textContent?.toLowerCase().trim() === 'create song') && !b.disabled
                  );

                  if (!createBtn) {
                    // Button might still be disabled, wait a bit more
                    await new Promise(r => setTimeout(r, 1000));
                    const retryBtn = Array.from(document.querySelectorAll('button')).find(b =>
                      (b.textContent?.toLowerCase().trim() === 'create' ||
                       b.textContent?.toLowerCase().trim() === 'create song') && !b.disabled
                    );
                    if (!retryBtn) {
                      return JSON.stringify({ success: false, error: 'Create button not found or disabled' });
                    }
                    retryBtn.click();
                  } else {
                    createBtn.click();
                  }

                  return JSON.stringify({ success: true });
                } catch (err) {
                  return JSON.stringify({ success: false, error: err.message });
                }
              })()
            `,
            returnByValue: true,
            awaitPromise: true
          });

          const fillResult = await waitForResult(fillId);
          const fillData = JSON.parse(fillResult.result?.result?.value || '{}');

          if (!fillData.success) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(fillData.error || 'Failed to fill form'));
            return;
          }

          // Listen for the generate response
          let clipIds = [];

          const networkHandler = (data) => {
            const msg = JSON.parse(data.toString());

            if (msg.method === 'Network.responseReceived') {
              const { response, requestId } = msg.params;
              if (response.url.includes('/api/generate/v2')) {
                // Get response body
                send('Network.getResponseBody', { requestId });
              }
            }

            if (msg.result?.body && msg.result.body.includes('clips')) {
              try {
                const responseData = JSON.parse(msg.result.body);
                if (responseData.clips && responseData.clips.length > 0) {
                  clipIds = responseData.clips.map(c => c.id);
                  clearTimeout(timeout);
                  ws.close();
                  resolve({
                    clips: responseData.clips,
                    message: 'Song generation started'
                  });
                }
              } catch (e) { }
            }
          };

          ws.on('message', networkHandler);

          // Also set a check timeout
          setTimeout(async () => {
            if (clipIds.length === 0) {
              // Try to get recent songs to find the new ones
              clearTimeout(timeout);
              ws.close();
              resolve({
                clips: [],
                message: 'Generation triggered - check recent songs for results'
              });
            }
          }, 15000);

        } catch (err) {
          clearTimeout(timeout);
          ws.close();
          reject(err);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Generate a song from description using browser JS
   */
  async generateFromDescription(description, instrumental = false, model = 'chirp-v4') {
    // For description mode, we use the "Simple" tab with just a prompt
    const pageTarget = await this.getSunoPage();
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    return new Promise((resolve, reject) => {
      let msgId = 0;
      const send = (method, params = {}) => {
        msgId++;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return msgId;
      };

      const waitForResult = (targetId) => {
        return new Promise((res) => {
          const handler = (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === targetId) {
              ws.off('message', handler);
              res(msg);
            }
          };
          ws.on('message', handler);
        });
      };

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timeout waiting for song generation'));
      }, 60000);

      ws.on('open', async () => {
        try {
          send('Network.enable');

          const escapedDesc = description.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

          // Use the main prompt textarea (first one, for simple mode)
          const fillId = send('Runtime.evaluate', {
            expression: `
              (async function() {
                try {
                  // Find the main prompt textarea
                  const textareas = Array.from(document.querySelectorAll('textarea'));
                  const promptArea = textareas.find(t =>
                    t.placeholder?.toLowerCase().includes('loud') ||
                    t.placeholder?.toLowerCase().includes('describe')
                  ) || textareas[2] || textareas[0];

                  if (!promptArea) {
                    return JSON.stringify({ success: false, error: 'Could not find prompt field' });
                  }

                  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                  setter.call(promptArea, \`${escapedDesc}\`);
                  promptArea.dispatchEvent(new Event('input', { bubbles: true }));

                  await new Promise(r => setTimeout(r, 500));

                  const createBtn = Array.from(document.querySelectorAll('button')).find(b =>
                    b.textContent?.toLowerCase().trim() === 'create' && !b.disabled
                  );

                  if (!createBtn) {
                    await new Promise(r => setTimeout(r, 1000));
                    const retryBtn = Array.from(document.querySelectorAll('button')).find(b =>
                      b.textContent?.toLowerCase().trim() === 'create' && !b.disabled
                    );
                    if (retryBtn) retryBtn.click();
                    else return JSON.stringify({ success: false, error: 'Create button not available' });
                  } else {
                    createBtn.click();
                  }

                  return JSON.stringify({ success: true });
                } catch (err) {
                  return JSON.stringify({ success: false, error: err.message });
                }
              })()
            `,
            returnByValue: true,
            awaitPromise: true
          });

          const fillResult = await waitForResult(fillId);
          const fillData = JSON.parse(fillResult.result?.result?.value || '{}');

          if (!fillData.success) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(fillData.error || 'Failed to fill form'));
            return;
          }

          // Wait for response
          setTimeout(() => {
            clearTimeout(timeout);
            ws.close();
            resolve({
              clips: [],
              message: 'Generation triggered - check recent songs for results'
            });
          }, 10000);

        } catch (err) {
          clearTimeout(timeout);
          ws.close();
          reject(err);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async getCredits() {
    return this.apiRequest('/api/billing/info/');
  }

  async getSongStatus(ids) {
    const idsParam = Array.isArray(ids) ? ids.join(',') : ids;
    return this.apiRequest(`/api/feed/v2?ids=${idsParam}`);
  }

  async waitForSongs(ids, maxWait = 180000, pollInterval = 5000) {
    const startTime = Date.now();
    const songIds = Array.isArray(ids) ? ids : [ids];

    while (Date.now() - startTime < maxWait) {
      const status = await this.getSongStatus(songIds);
      const clips = Array.isArray(status) ? status : (status.clips || status);

      if (!Array.isArray(clips) || clips.length === 0) {
        await new Promise(r => setTimeout(r, pollInterval));
        continue;
      }

      const allComplete = clips.every(clip =>
        clip.status === 'complete' || clip.status === 'streaming'
      );

      if (allComplete) {
        return clips.map(clip => ({
          id: clip.id,
          title: clip.title,
          audioUrl: clip.audio_url,
          imageUrl: clip.image_url,
          videoUrl: clip.video_url,
          duration: clip.metadata?.duration || clip.duration,
          status: clip.status,
          sunoUrl: `https://suno.com/song/${clip.id}`
        }));
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new Error('Timeout waiting for song generation');
  }

  async getRecentSongs(page = 1) {
    return this.apiRequest(`/api/project/default?page=${page}`);
  }

  /**
   * Download a song MP3 to a specified folder
   * @param {string} songId - The song ID
   * @param {string} folder - The folder path to save to
   * @param {string} filename - Optional filename (without extension), defaults to song ID
   * @returns {Promise<{path: string, size: number}>}
   */
  async downloadSong(songId, folder, filename = null) {
    const fs = require('fs');
    const path = require('path');

    // Get song info to find the audio URL
    const status = await this.getSongStatus([songId]);
    const clips = Array.isArray(status) ? status : (status.clips || []);
    const song = clips.find(c => c.id === songId);

    if (!song) {
      throw new Error(`Song not found: ${songId}`);
    }

    if (song.status !== 'complete' && song.status !== 'streaming') {
      throw new Error(`Song not ready for download. Status: ${song.status}`);
    }

    // Prefer CDN URL over audiopipe URL
    const audioUrl = song.audio_url?.includes('cdn')
      ? song.audio_url
      : `https://cdn1.suno.ai/${songId}.mp3`;

    // Create folder if it doesn't exist
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }

    // Determine filename
    const finalFilename = filename || song.title || songId;
    // Sanitize filename
    const safeFilename = finalFilename.replace(/[^a-z0-9\-_\s]/gi, '').replace(/\s+/g, '-').toLowerCase();
    const filePath = path.join(folder, `${safeFilename}.mp3`);

    // Download the file
    const response = await fetch(audioUrl);
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(filePath, buffer);

    return {
      path: filePath,
      size: buffer.length,
      song: {
        id: song.id,
        title: song.title,
        audioUrl: audioUrl,
        sunoUrl: `https://suno.com/song/${songId}`
      }
    };
  }
}

module.exports = { SunoClient };
