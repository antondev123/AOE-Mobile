// Can the minimap actually show you an attack?
//
// A review of the 96x96 map release measured this and found it could not: a
// ten-strong raid beside the player's Town Center changed 221 of 53824 minimap
// pixels, 0.4%, which is indistinguishable from noise on the one instrument
// that can see the 93% of the world the camera cannot.
//
// So the property is measured rather than asserted by eye. Screenshot the
// minimap, spawn a raid inside the Town Center's vision, screenshot again, and
// diff. The threshold below is deliberately far above the old behaviour and far
// below "the whole map changed", so it fails if either the pips stop being
// drawn or something starts repainting the entire minimap every frame.

import fs from 'node:fs';
import path from 'node:path';
import { boot, step } from './harness.mjs';

const SHOT_DIR = 'screenshots';
// A ten-unit stack has to move at least this fraction of the minimap's pixels.
//
// Measured: 0.41% originally, 0.33% with binning alone, 0.70% with binning plus
// the threat ring. The absolute number stays small for a reason that is not a
// defect — ten units standing on nine tiles of a 9216-tile map cannot cover much
// of it, and under fog of war most of the minimap is unexplored black that
// nothing can change. So this threshold is a regression guard, not a certificate
// of legibility: it fails if the pips stop being drawn or the threat ring is
// lost. Legibility itself was checked by looking at minimap-raid-after.png,
// where the raid reads as a ringed red blob against the blue base.
const MIN_DELTA = 0.005;

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}

/** Fraction of differing pixels between two PNG buffers of identical size. */
async function diffFraction(page, aB64, bB64) {
  return page.evaluate(async ([a, b]) => {
    const load = (d) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.src = `data:image/png;base64,${d}`;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas');
    c.width = ia.width; c.height = ia.height;
    const g = c.getContext('2d');
    g.drawImage(ia, 0, 0);
    const da = g.getImageData(0, 0, c.width, c.height).data;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(ib, 0, 0);
    const db = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < da.length; i += 4) {
      // Ignore imperceptible differences so antialiasing jitter is not counted
      // as signal; a team-coloured pip lands far outside this.
      if (Math.abs(da[i] - db[i]) > 12 ||
          Math.abs(da[i + 1] - db[i + 1]) > 12 ||
          Math.abs(da[i + 2] - db[i + 2]) > 12) n++;
    }
    return { frac: n / (da.length / 4), total: da.length / 4 };
  }, [aB64, bB64]);
}

const run = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const h = await boot();
  const { page, errors } = h;

  try {
    // Settle the map and let vision fill in around the base.
    await step(page, 40);

    const mm = page.locator('#minimap');
    const before = (await mm.screenshot()).toString('base64');
    fs.writeFileSync(path.join(SHOT_DIR, 'minimap-raid-before.png'), Buffer.from(before, 'base64'));

    // Ten enemy soldiers inside the Town Center's line of sight, so this is a
    // test of legibility and not an accidental test of fog of war.
    const placed = await page.evaluate(() => {
      const g = window.__game;
      const w = g.world;
      const tc = [...w.players[0].owned]
        .map((id) => w.entities.get(id))
        .find((e) => e && e.kind === 'building' && e.type === 'towncenter');
      if (!tc) return 0;
      const spawn = w.__spawnUnit || null;
      let n = 0;
      for (let i = 0; i < 10; i++) {
        const x = tc.x + 4 + (i % 3);
        const y = tc.y + 4 + Math.floor(i / 3);
        try {
          const u = (spawn || g.scene.spawnUnit || null)
            ? (spawn || g.scene.spawnUnit)(w, 'militia', 1, x, y)
            : null;
          if (u) n++;
        } catch (e) { /* fall through to the module path below */ }
      }
      return n;
    });

    // The harness has no direct handle on spawnUnit, so import it in-page.
    if (!placed) {
      await page.evaluate(async () => {
        const { spawnUnit } = await import('/src/core/world.js');
        const g = window.__game;
        const w = g.world;
        const tc = [...w.players[0].owned]
          .map((id) => w.entities.get(id))
          .find((e) => e && e.kind === 'building' && e.type === 'towncenter');
        for (let i = 0; i < 10; i++) {
          spawnUnit(w, 'militia', 1, tc.x + 4 + (i % 3), tc.y + 4 + Math.floor(i / 3));
        }
      });
    }

    await step(page, 4);
    const after = (await mm.screenshot()).toString('base64');
    fs.writeFileSync(path.join(SHOT_DIR, 'minimap-raid-after.png'), Buffer.from(after, 'base64'));

    const { frac, total } = await diffFraction(page, before, after);
    check(
      'a ten-unit raid is visible on the minimap',
      frac >= MIN_DELTA,
      `${(frac * 100).toFixed(2)}% of ${total} px changed, need >= ${(MIN_DELTA * 100).toFixed(1)}%`,
    );
    check('the minimap did not simply repaint itself', frac < 0.5, `${(frac * 100).toFixed(2)}%`);
    check('no console errors or exceptions', errors.length === 0, errors.join('; '));
  } finally {
    await h.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nminimap raid visibility passed');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
