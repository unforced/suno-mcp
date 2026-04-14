# Suno MCP

MCP server for Suno music generation. Provides tools for generating songs, checking status, and downloading MP3s.

## Architecture

```
suno-mcp/
├── src/
│   ├── index.js        # MCP server (tool definitions, handlers)
│   ├── suno-client.js  # Suno client (auth, generation, download)
│   └── cdp.js          # Minimal Chrome DevTools Protocol client
├── scripts/
│   ├── probe.js        # Inspects window / React fiber on live Suno page
│   ├── probe2.js       # Deeper probe (Clerk, Zustand, handlers)
│   ├── smoke.js        # End-to-end smoke test (read-only by default)
│   └── test-any-page.js# Confirms generate works from any /suno.com/* page
└── package.json
```

## How It Works

### Authentication
Suno uses Clerk. The client calls `window.Clerk.session.getToken()` in the
live Suno tab via CDP `Runtime.evaluate`. Clerk handles refresh internally,
so there's no page reload. Token is cached until 5 min before `exp`.

### Song Generation — direct React-fiber invocation
Direct API calls fail due to hCaptcha. Instead of scraping form selectors:

1. CDP-connect to the Suno tab. Navigate to `/create` if elsewhere.
2. Walk the React fiber from `button[aria-label="Create song"]` until we find
   the component whose `memoizedProps` expose `onCreateClick` / `lyrics` /
   `styles` / `mode`. This is the semantic generate handler.
3. Populate lyrics + style textareas via the React-compatible native value
   setter and wait for the fiber to re-render with the new props.
4. Dispatch a **trusted** mouse click via CDP `Input.dispatchMouseEvent` at
   the button's coordinates. Calling `onCreateClick()` from JS does NOT work —
   hCaptcha rejects non-trusted events (isGenerating flips true but no
   backend request fires).
5. Capture `/api/generate/v2` response via CDP `Network` events for the new
   clip IDs. Fall back to polling `getRecentSongs` (filtered by timestamp ≥
   triggerStart) if the network event is missed.

Why this is more robust than scraping: the selectors it depends on —
`aria-label="Create song"` and semantic React prop names like `onCreateClick`
— are load-bearing for accessibility and architecture, not visual design.
Class-name churn, textContent changes, and layout refactors don't break it.

### Dependencies
- **BrowserOS** (or any Chromium with `--remote-debugging-port`) on
  `http://localhost:9100`, logged into Suno. Override via
  `CDP_URL` / `CDP_HOST` / `CDP_PORT`.
- `ws` for CDP WebSocket communication.

## Tools Provided

| Tool | Purpose |
|------|---------|
| `suno_generate_song` | Generate with custom lyrics and style |
| `suno_generate_from_description` | AI writes lyrics from description |
| `suno_wait_for_songs` | Poll until complete, return URLs |
| `suno_check_status` | Check generation status |
| `suno_get_credits` | Account credits info |
| `suno_get_recent` | List recent songs |
| `suno_download_song` | Download MP3 to local folder |

## Development

```bash
# Read-only smoke test (auth, credits, recent)
node scripts/smoke.js

# Dry-run: locates the generate fiber without firing
node scripts/smoke.js --dry-run-generate

# Full test: spends ~10 credits to fire one generate
node scripts/smoke.js --generate

# Confirm navigation-to-/create works from any Suno page
node scripts/test-any-page.js
```

## Known Limitations

- **Title field** doesn't work reliably (Suno UI issue).
- `generate_from_description` falls back to custom mode if the simple-mode
  toggle isn't detected — prefer `generate_song` for deterministic results.
- Requires BrowserOS with a **visible** Suno session. The Create button must
  have non-zero size for the trusted click to land.
- Token expires every ~1 hour (auto-refreshes via Clerk).
