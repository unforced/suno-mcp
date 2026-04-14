# Suno MCP

An MCP (Model Context Protocol) server for generating music with [Suno](https://suno.com).

## Features

- **Generate songs** with custom lyrics and style tags
- **Generate from description** - let Suno AI write the lyrics
- **Wait for completion** and get audio URLs with markdown embeds
- **Download MP3s** to local folders
- **Auto-refresh tokens** when they expire

## Requirements

- Node.js 18+
- [BrowserOS](https://browseros.dev) (or any Chromium with `--remote-debugging-port`) on `http://localhost:9100` with Suno logged in. Override with `CDP_URL`.
- A Suno account (free or paid)

## Installation

```bash
npm install
```

## Usage with Claude Code

Add to your `.mcp.json`:

```json
{
  "suno": {
    "command": "node",
    "args": ["/path/to/suno-mcp/src/index.js"]
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `suno_generate_song` | Generate with custom lyrics and style |
| `suno_generate_from_description` | AI writes lyrics from a description |
| `suno_wait_for_songs` | Wait for completion, returns URLs + markdown |
| `suno_check_status` | Check generation status |
| `suno_get_credits` | Get account credits info |
| `suno_get_recent` | List recent songs |
| `suno_download_song` | Download MP3 to a folder |

## How It Works

### Authentication
Suno uses Clerk for auth with short-lived JWT tokens. The client calls
`window.Clerk.session.getToken()` in the live Suno tab via CDP — Clerk handles
refresh under the hood, so no page reload is needed. The token is cached until
5 minutes before its `exp` claim.

### Song Generation
Direct API calls fail due to hCaptcha. Rather than scrape form selectors, the
client drives Suno's own React app:

1. Connect to the Suno tab via CDP; navigate to `/create` if needed.
2. Walk the React fiber tree from the Create button to find the component that
   exposes `onCreateClick` / `lyrics` / `styles` / `mode` as props — the semantic
   generate handler.
3. Populate lyrics + style textareas using the React-compatible native setter
   so internal state updates.
4. Wait until the fiber's props reflect the new values (i.e. React has
   re-rendered).
5. Dispatch a trusted mouse click via CDP `Input.dispatchMouseEvent` at the
   button's coordinates. hCaptcha accepts CDP-synthesized events as real user
   gestures (calling `onCreateClick()` from JS does not — captcha refuses).
6. Capture the `/api/generate/v2` response via CDP `Network` events to return
   the new clip IDs. Falls back to polling `/api/project/default` if the
   network event is missed.

This approach is robust to UI redesigns: it depends on semantic React props
(`onCreateClick`, `lyrics`, `styles`) and the `aria-label="Create song"` button
— both of which are load-bearing and unlikely to change — rather than on
class names, textContent matches, or DOM layout.

## Example

```javascript
// Generate a song
const result = await suno_generate_song({
  lyrics: "[Verse]\nHello world\n\n[Chorus]\nThis is a test",
  style: "indie folk, acoustic, male vocals"
});

// Wait for it to complete
const songs = await suno_wait_for_songs({
  ids: result.songIds
});

// Download it
await suno_download_song({
  songId: songs[0].id,
  folder: "./downloads"
});
```

## Known Limitations

- Title field doesn't work reliably (Suno UI limitation — not currently wired
  through the new generate path).
- `generate_from_description` (simple mode) currently falls back to custom mode
  if the UI mode toggle isn't found; pass lyrics + style via `generate_song`
  for deterministic behaviour.
- Requires BrowserOS with an active, visible Suno session. The Create button
  must have non-zero size on screen for the trusted click to land.
- Token expires every ~1 hour (auto-refreshes via Clerk).

## License

MIT
