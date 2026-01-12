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
- [BrowserOS](https://browseros.dev) running on port 9000 with an active Suno session
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
Suno uses Clerk for auth with short-lived JWT tokens (~1 hour). The client:
1. Checks the `__session` cookie from BrowserOS via Chrome DevTools Protocol (CDP)
2. If expired, reloads the Suno page to trigger a token refresh
3. Captures the fresh token from network requests

### Song Generation
Direct API calls fail due to hCaptcha. Instead, we:
1. Connect to the Suno page via CDP
2. Inject JavaScript to fill the form (lyrics, style)
3. Click the Create button (CAPTCHA runs invisibly in browser context)
4. Capture song IDs from the network response

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

- Title field doesn't work reliably (Suno UI limitation)
- Requires BrowserOS with an active Suno session
- Token expires every ~1 hour (auto-refreshes)

## License

MIT
