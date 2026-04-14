#!/usr/bin/env node
// Smoke test: verifies CDP + Clerk-based auth + read endpoints.
// Does NOT trigger a generation (costs credits). Pass --generate to fire one.

const { SunoClient } = require('../src/suno-client.js');

async function main() {
  const c = new SunoClient();

  console.log('1) refreshToken via Clerk...');
  const tok = await c.refreshToken();
  console.log('   got token, len=', tok.length, 'expires in',
    Math.round((c.tokenExpiry - Date.now()) / 60000), 'min');

  console.log('2) getCredits...');
  const credits = await c.getCredits();
  console.log('   credits:', {
    credits: credits.credits,
    plan: credits.plan?.name,
    monthly: `${credits.monthly_usage}/${credits.monthly_limit}`,
  });

  console.log('3) getRecentSongs...');
  const recent = await c.getRecentSongs();
  const clips = (recent.project_clips || recent.clips || []).slice(0, 3);
  console.log('   recent:', clips.map(x => {
    const cl = x.clip || x;
    return { id: cl.id, title: cl.title, status: cl.status };
  }));

  if (process.argv.includes('--dry-run-generate')) {
    console.log('4) dry-run: locate generate fiber + confirm it would fire...');
    const { findSunoTarget } = require('../src/cdp.js');
    const { CdpSession } = require('../src/cdp.js');
    const { target } = await findSunoTarget({ navigate: true });
    const sess = new CdpSession(target.webSocketDebuggerUrl);
    await sess.open();
    const probe = await sess.evaluate(`
      (() => {
        const anchor = document.querySelector('button[aria-label="Create song"]')
          || document.querySelector('main') || document.body;
        const fkey = Object.keys(anchor).find(k => k.startsWith('__reactFiber$'));
        if (!fkey) return { error: 'no fiber on anchor' };
        let f = anchor[fkey], d = 0;
        while (f && d < 40) {
          if (f.memoizedProps && typeof f.memoizedProps.onCreateClick === 'function') {
            const p = f.memoizedProps;
            return {
              ok: true, depth: d, mode: p.mode,
              isGenerating: p.isGenerating, isOutOfCredits: p.isOutOfCredits,
              hasLyrics: !!p.lyrics, hasStyles: !!p.styles,
            };
          }
          f = f.return; d++;
        }
        return { error: 'fiber not found' };
      })()
    `);
    sess.close();
    console.log('   fiber probe:', probe);
  }

  if (process.argv.includes('--generate')) {
    console.log('4) generateSong (custom mode, costs credits)...');
    const gen = await c.generateSong({
      lyrics: '[Verse]\nSmoke test hum, the wires all align\n[Chorus]\nEverything fine, everything fine',
      style: 'minimal synthwave, test track, short',
    });
    console.log('   generate result:', {
      clipCount: gen.clips?.length,
      ids: gen.clips?.map(x => x.id),
      message: gen.message,
    });
  }

  console.log('OK');
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
