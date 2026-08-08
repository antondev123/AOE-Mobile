// Regression test: screen<->world mapping must be correct on the very first
// frame, before the player has moved the camera.
//
// The renderer caches the screen<->world affine and derives it from
// camera.getWorldPoint(), which reads a matrix Phaser only rebuilds in its own
// preRender pass. centerOn() runs during scene create, before the camera has
// ever rendered, so the cached affine was wrong — and because the memo key
// already matched the final camera state, it stayed wrong until the first pan
// happened to invalidate it. Every tap landed up to 193px from the finger for
// the opening half-minute of a match, then silently healed.
//
// This test taps before touching the camera, which is the only window where the
// bug is observable.
//
//   node tests/camera.browser.mjs

import { boot } from './harness.mjs';

const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
};

const run = async () => {
  const h = await boot();
  const { page, errors } = h;

  try {
    // --- The first mapping must equal the settled mapping --------------------
    // Round-tripping screenToGrid through gridToScreen proves nothing: both read
    // the same cached affine, so a wrong one still round-trips exactly. The real
    // invariant is that the affine computed before the camera has rendered
    // matches the one computed after it has settled. Nudging scroll and putting
    // it back forces a recompute at an identical camera state, which is the
    // ground truth to compare the boot-time answer against.
    const probes = await page.evaluate(() => {
      const r = window.__game.renderer;
      const cam = r.camera;
      const pts = [[60, 140], [195, 300], [330, 340], [100, 600], [330, 700], [60, 700]];

      const fresh = pts.map(([sx, sy]) => {
        const g = r.screenToGrid(sx, sy);
        return { sx, sy, x: g.x, y: g.y };
      });

      // Force the cache to rebuild at exactly the same camera state.
      const sx0 = cam.scrollX;
      const sy0 = cam.scrollY;
      cam.setScroll(sx0 + 1, sy0 + 1);
      r.screenToGrid(0, 0);
      cam.setScroll(sx0, sy0);

      return fresh.map((p) => {
        const g = r.screenToGrid(p.sx, p.sy);
        return { ...p, gx: g.x, gy: g.y, drift: Math.hypot(g.x - p.x, g.y - p.y) };
      });
    });
    const worst = probes.reduce((a, p) => Math.max(a, p.drift), 0);
    for (const p of probes) {
      console.log(
        `       (${p.sx},${p.sy}) boot -> (${p.x.toFixed(2)},${p.y.toFixed(2)})  ` +
        `settled -> (${p.gx.toFixed(2)},${p.gy.toFixed(2)})  drift ${p.drift.toFixed(2)} tiles`
      );
    }
    check('the boot-time screen mapping matches the settled one', worst < 0.05,
      `worst drift ${worst.toFixed(2)} tiles across ${probes.length} probes`);

    // --- Tapping a drawn villager must select that villager ------------------
    // This is the player-visible consequence, and the thing the boot card tells
    // you to do first.
    const result = await page.evaluate(() => {
      const g = window.__game;
      const w = g.world;
      const r = g.renderer;
      const mine = [...w.players[0].owned]
        .map((id) => w.entities.get(id))
        .filter((e) => e && e.kind === 'unit');
      // Where each villager is actually drawn, in screen pixels.
      return mine.map((u) => {
        const s = r.gridToScreen(u.x, u.y);
        return { id: u.id, sx: Math.round(s.x), sy: Math.round(s.y) };
      });
    });

    let hits = 0;
    for (const v of result) {
      // Skip any villager drawn under the HUD chrome or off-screen.
      if (v.sy < 110 || v.sy > 700 || v.sx < 10 || v.sx > 380) continue;
      await page.touchscreen.tap(v.sx, v.sy);
      const picked = await page.evaluate(() => {
        const w = window.__game.world;
        const id = [...w.selection][0];
        const e = id ? w.entities.get(id) : null;
        return e ? { kind: e.kind, type: e.type, id: e.id } : null;
      });
      const ok = picked && picked.id === v.id;
      if (ok) hits++;
      console.log(
        `       tap (${v.sx},${v.sy}) on villager ${v.id} -> ` +
        `${picked ? `${picked.kind}:${picked.type}#${picked.id}` : 'nothing'}`
      );
    }
    check('tapping a villager selects it, with no camera movement first',
      hits >= 1 && hits === result.filter((v) => v.sy >= 110 && v.sy <= 700).length,
      `${hits} hit`);

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }

  if (failures.length) {
    console.error(`\nFAILURES:\n - ${failures.join('\n - ')}\n`);
    process.exit(1);
  }
  console.log('\nall checks passed\n');
};

run().catch((e) => {
  console.error('harness error:', e);
  process.exit(1);
});
