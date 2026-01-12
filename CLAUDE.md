# Suno MCP

MCP server for Suno music generation. Provides tools for generating songs, checking status, and downloading MP3s.

## Architecture

```
suno-mcp/
├── src/
│   ├── index.js        # MCP server (tool definitions, handlers)
│   └── suno-client.js  # Suno API client (auth, generation, download)
└── package.json
```

## How It Works

### Authentication
Suno uses Clerk for auth with short-lived JWT tokens (~1 hour). The client:
1. Checks `__session` cookie from BrowserOS via CDP
2. If expired, reloads the Suno page to trigger token refresh
3. Captures fresh token from network requests

### Song Generation
Direct API calls fail due to hCaptcha. Instead:
1. Connect to Suno page via Chrome DevTools Protocol (CDP)
2. Inject JavaScript to fill the form (lyrics, style)
3. Click Create button (CAPTCHA runs invisibly in browser context)
4. Capture song IDs from network response

### Dependencies
- **BrowserOS** must be running on port 9000 (CDP) with Suno logged in
- Uses WebSocket for CDP communication

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
# Test directly
node src/index.js

# Or test client
node -e "
const { SunoClient } = require('./src/suno-client.js');
const client = new SunoClient();
client.getCredits().then(console.log);
"
```

## Known Limitations

- **Title field** doesn't work reliably (Suno UI issue)
- Requires BrowserOS with active Suno session
- Token expires every ~1 hour (auto-refreshes)
