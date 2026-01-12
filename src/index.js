#!/usr/bin/env node

/**
 * Suno MCP Server
 *
 * An MCP server that provides Suno music generation capabilities.
 * Requires BrowserOS to be running with an active Suno session.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');
const { SunoClient } = require('./suno-client.js');

// Create Suno client
const suno = new SunoClient();

// Define available tools
const tools = [
  {
    name: 'suno_get_credits',
    description: 'Get the current Suno account credits and subscription info',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'suno_generate_song',
    description: 'Generate a song with custom lyrics and style. Returns song IDs that can be used to check status.',
    inputSchema: {
      type: 'object',
      properties: {
        lyrics: {
          type: 'string',
          description: 'The song lyrics. Can include structure tags like [Verse 1], [Chorus], [Bridge], etc.'
        },
        style: {
          type: 'string',
          description: 'Musical style/genre tags, e.g. "indie folk, acoustic, male vocals, upbeat"'
        },
        title: {
          type: 'string',
          description: 'Title for the song (optional)'
        },
        instrumental: {
          type: 'boolean',
          description: 'Whether to generate an instrumental version (no vocals)',
          default: false
        },
        model: {
          type: 'string',
          description: 'Model to use: chirp-v4 (default), chirp-v3-5, chirp-crow (v5 beta)',
          default: 'chirp-v4'
        }
      },
      required: ['lyrics', 'style']
    }
  },
  {
    name: 'suno_generate_from_description',
    description: 'Generate a song from a text description. Suno AI will write the lyrics.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A description of the song you want, e.g. "An upbeat pop song about summer adventures"'
        },
        instrumental: {
          type: 'boolean',
          description: 'Whether to generate an instrumental version',
          default: false
        },
        model: {
          type: 'string',
          description: 'Model to use',
          default: 'chirp-v4'
        }
      },
      required: ['description']
    }
  },
  {
    name: 'suno_check_status',
    description: 'Check the generation status of songs by their IDs',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of song IDs to check'
        }
      },
      required: ['ids']
    }
  },
  {
    name: 'suno_wait_for_songs',
    description: 'Wait for songs to complete generation and return their URLs',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of song IDs to wait for'
        },
        timeout: {
          type: 'number',
          description: 'Maximum time to wait in seconds (default: 180)',
          default: 180
        }
      },
      required: ['ids']
    }
  },
  {
    name: 'suno_get_recent',
    description: 'Get recently generated songs from your Suno account',
    inputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'number',
          description: 'Page number (default: 1)',
          default: 1
        }
      }
    }
  },
  {
    name: 'suno_download_song',
    description: 'Download a song MP3 to a specified folder',
    inputSchema: {
      type: 'object',
      properties: {
        songId: {
          type: 'string',
          description: 'The song ID to download'
        },
        folder: {
          type: 'string',
          description: 'The folder path to save the MP3 to'
        },
        filename: {
          type: 'string',
          description: 'Optional filename (without .mp3 extension). Defaults to song title or ID.'
        }
      },
      required: ['songId', 'folder']
    }
  }
];

async function main() {
  const server = new Server(
    {
      name: 'suno',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'suno_get_credits': {
          const credits = await suno.getCredits();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                credits: credits.credits,
                monthlyUsage: credits.monthly_usage,
                monthlyLimit: credits.monthly_limit,
                plan: credits.plan?.name,
                renewsOn: credits.renews_on
              }, null, 2)
            }]
          };
        }

        case 'suno_generate_song': {
          const result = await suno.generateSong({
            lyrics: args.lyrics,
            style: args.style,
            title: args.title || '',
            instrumental: args.instrumental || false,
            model: args.model || 'chirp-v4'
          });

          const clips = result.clips || [];
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                message: 'Song generation started',
                songIds: clips.map(c => c.id),
                status: clips.map(c => ({ id: c.id, status: c.status }))
              }, null, 2)
            }]
          };
        }

        case 'suno_generate_from_description': {
          const result = await suno.generateFromDescription(
            args.description,
            args.instrumental || false,
            args.model || 'chirp-v4'
          );

          const clips = result.clips || [];
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                message: 'Song generation started',
                songIds: clips.map(c => c.id),
                status: clips.map(c => ({ id: c.id, status: c.status }))
              }, null, 2)
            }]
          };
        }

        case 'suno_check_status': {
          const status = await suno.getSongStatus(args.ids);
          const clips = Array.isArray(status) ? status : (status.clips || []);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(clips.map(c => ({
                id: c.id,
                title: c.title,
                status: c.status,
                audioUrl: c.audio_url,
                duration: c.duration
              })), null, 2)
            }]
          };
        }

        case 'suno_wait_for_songs': {
          const timeout = (args.timeout || 180) * 1000;
          const songs = await suno.waitForSongs(args.ids, timeout);

          // Build response with markdown audio embeds for rendering
          const songsWithEmbed = songs.map(s => ({
            ...s,
            markdown: `![${s.title || 'Song'}](${s.audioUrl})`
          }));

          // Create a nice display with audio embeds
          const audioEmbeds = songs.map(s =>
            `![${s.title || 'Song ' + s.id.substring(0, 8)}](${s.audioUrl})`
          ).join('\n\n');

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  message: 'Songs ready',
                  songs: songsWithEmbed
                }, null, 2)
              },
              {
                type: 'text',
                text: `\n\n**Generated Songs:**\n\n${audioEmbeds}`
              }
            ]
          };
        }

        case 'suno_get_recent': {
          const result = await suno.getRecentSongs(args.page || 1);
          const clips = result.project_clips || result.clips || [];

          const songs = clips.slice(0, 10).map(c => {
            const clip = c.clip || c;
            return {
              id: clip.id,
              title: clip.title,
              audioUrl: clip.audio_url,
              sunoUrl: `https://suno.com/song/${clip.id}`,
              createdAt: clip.created_at,
              markdown: `![${clip.title || 'Song'}](${clip.audio_url})`
            };
          });

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(songs, null, 2)
            }]
          };
        }

        case 'suno_download_song': {
          const result = await suno.downloadSong(
            args.songId,
            args.folder,
            args.filename || null
          );

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                message: 'Song downloaded successfully',
                path: result.path,
                size: `${(result.size / 1024 / 1024).toFixed(2)} MB`,
                song: result.song
              }, null, 2)
            }]
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: error.message,
            hint: 'Make sure BrowserOS is running and logged into Suno'
          }, null, 2)
        }],
        isError: true
      };
    }
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Suno MCP server running');
}

main().catch(console.error);
