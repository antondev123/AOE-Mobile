// The art review harness.
//
// Everything in gfx/ is generated code that produces pictures, and the only
// honest test of a picture is looking at it. This boots the real game in a real
// phone-sized Chromium, arranges the things worth looking at, and drops a PNG
// per subject into screenshots/ — plus the numbers that decide whether the art
// is affordable: atlas size, frame count, draw calls per frame and frame time
// under load.
//
//   node tests/art.browser.mjs [--shots screenshots/] [--only <substring>]
//
// The contact sheets are drawn by blitting atlas frames onto a canvas laid over
// the page, so a pose sheet is the actual packed texture rather than a
// re-render of it: if a frame is clipped by its box, or packed on top of its
// neighbour, it shows up here and nowhere else.

import fs from 'node:fs';
import path from 'node:path';
import { boot, step } from './harness.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SHOT_DIR = arg('shots', 'screenshots');
const ONLY = arg('only', null);

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });

/**
 * Lay a canvas over the page and blit atlas frames onto it in a grid, with a
 * caption under each. Returns the canvas size so the caller can screenshot the
 * element rather than the viewport.
 */
const SHEET = ({ frames, cols, scale, bg, label }) => {
  const game = window.__phaser;
  const tex = game.textures.get('aoe-gfx');
  const src = tex.getSourceImage();
  const cells = frames.map((f) => {
    const fr = tex.frames[f];
    return fr ? { name: f, x: fr.cutX, y: fr.cutY, w: fr.width, h: fr.height } : null;
  });
  const cw = Math.max(...cells.map((c) => (c ? c.w : 10))) * scale + 12;
  const ch = Math.max(...cells.map((c) => (c ? c.h : 10))) * scale + 26;
  const rows = Math.ceil(cells.length / cols);
  let cv = document.getElementById('__sheet');
  if (cv) cv.remove();
  cv = document.createElement('canvas');
  cv.id = '__sheet';
  cv.width = cols * cw;
  cv.height = rows * ch + 22;
  cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:' + bg;
  document.body.appendChild(cv);
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.fillStyle = bg;
  c.fillRect(0, 0, cv.width, cv.height);
  c.font = '12px system-ui, sans-serif';
  c.fillStyle = '#fff';
  c.fillText(label, 6, 15);
  cells.forEach((cell, i) => {
    const gx = (i % cols) * cw;
    const gy = Math.floor(i / cols) * ch + 22;
    if (!cell) {
      c.fillStyle = '#f66';
      c.fillText('missing', gx + 6, gy + 20);
      return;
    }
    c.drawImage(
      src, cell.x, cell.y, cell.w, cell.h,
      gx + (cw - cell.w * scale) / 2, gy + (ch - 20 - cell.h * scale) / 2,
      cell.w * scale, cell.h * scale,
    );
    c.fillStyle = '#cbb';
    c.fillText(cell.name.replace(/^u_/, '').replace(/_0_/, ' '), gx + 4, gy + ch - 6);
  });
  return { w: cv.width, h: cv.height };
};

const CLEAR_SHEET = () => {
  const cv = document.getElementById('__sheet');
  if (cv) cv.remove();
};

/**
 * Freeze the simulation and light the whole map.
 *
 * Both halves matter for a review shot. Frozen, because a screenshot of a
 * running game is a screenshot of whatever the enemy AI happened to be doing;
 * and lit, because a tall building's sprite reaches into tiles well north of
 * its own footprint, so an unlit map cuts the top off the very silhouettes this
 * pass exists to compare. `world.over` is the sim's own brake — GameScene's
 * simStep returns immediately when it is set — so nothing has to be stubbed.
 */
const REVEAL = () => {
  const w = window.__game.world;
  w.over = true;
  const st = w.vision.state(0);
  st.visible.fill(1);
  st.explored.fill(1);
  st.revision++;
};

const run = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const h = await boot();
  const { page, errors } = h;
  const want = (name) => !ONLY || name.includes(ONLY);

  try {
    // world.js helpers are not on window; expose them once for the arrangers.
    await page.evaluate(async () => {
      window.__world = await import('/src/core/world.js');
    });

    // --- 1. the atlas itself -------------------------------------------------
    const atlas = await page.evaluate(() => {
      const tex = window.__phaser.textures.get('aoe-gfx');
      const names = Object.keys(tex.frames).filter((n) => n !== '__BASE');
      let used = 0;
      let maxY = 0;
      const byKind = {};
      for (const n of names) {
        const f = tex.frames[n];
        used += f.width * f.height;
        maxY = Math.max(maxY, f.cutY + f.height);
        const kind = n.split('_')[0];
        byKind[kind] = (byKind[kind] || 0) + 1;
      }
      const img = tex.getSourceImage();
      return { count: names.length, used, maxY, w: img.width, h: img.height, byKind };
    });
    console.log('\n  atlas', `${atlas.w}x${atlas.h}`, `${atlas.count} frames`,
      `${(atlas.used / 1e6).toFixed(2)}M px used`,
      `packed to y=${atlas.maxY} (${((atlas.maxY / atlas.h) * 100).toFixed(0)}% of the sheet)`);
    console.log('  by kind:', JSON.stringify(atlas.byKind));
    check('the atlas has not overflowed', atlas.maxY <= atlas.h,
      `packed to ${atlas.maxY} of ${atlas.h}`);
    check('the atlas is one texture', atlas.w === atlas.h && atlas.w <= 2048, `${atlas.w}px`);

    // --- 2. unit pose sheets -------------------------------------------------
    if (want('poses')) {
      const sets = {
        villager: ['i', 'w0', 'w1', 'w2', 'g0', 'g1', 'b0', 'b1', 'd0', 'd1'],
        militia: ['i', 'w0', 'w1', 'w2', 'a0', 'a1', 'd0', 'd1'],
        spearman: ['i', 'w0', 'w1', 'w2', 'a0', 'a1', 'd0', 'd1'],
        archer: ['i', 'w0', 'w1', 'w2', 'a0', 'a1', 'd0', 'd1'],
        scout: ['i', 'w0', 'w1', 'w2', 'a0', 'a1', 'd0', 'd1'],
        ram: ['i', 'w0', 'w1', 'w2', 'a0', 'a1', 'd0', 'd1'],
      };
      for (const [type, poses] of Object.entries(sets)) {
        const frames = [];
        for (const b of ['f', 'b']) for (const p of poses) frames.push(`u_${type}_0_${b}_${p}`);
        await page.evaluate(SHEET, {
          frames, cols: poses.length, scale: 2, bg: '#3f5a2e', label: `${type} — front row, back row`,
        });
        // The sheet is far wider than a phone. Capture the element rather than
        // the viewport so nothing is cropped away unseen.
        await page.locator('#__sheet').screenshot({
          path: path.join(SHOT_DIR, `art-poses-${type}.png`),
        });
      }
      await page.evaluate(CLEAR_SHEET);
      console.log('  wrote pose sheets for 6 unit types');
    }

    // --- 3. every unit on the ground, at the zoom the game actually uses -----
    if (want('lineup')) {
      const at = await page.evaluate(() => {
        const g = window.__game;
        const w = g.world;
        const W = window.__world;
        const tc = [...w.players[0].owned].map((id) => w.entities.get(id))
          .find((e) => e && e.type === 'towncenter');
        const gx = Math.round(tc.x) + 10;
        const gy = Math.round(tc.y) - 6;
        for (const e of [...w.resources, ...w.buildings, ...w.units]) {
          if (e.type === 'towncenter') continue;
          if (Math.abs(e.x - gx) < 12 && Math.abs(e.y - gy) < 12) W.removeEntity(w, e);
        }
        const types = ['villager', 'militia', 'spearman', 'archer', 'scout', 'ram'];
        types.forEach((t, i) => {
          for (let k = 0; k < 2; k++) {
            const u = W.spawnUnit(w, t, k, gx - 4 + i * 1.6, gy + k * 2.2);
            u.facing = k === 0 ? 0 : 7;
            u.state = k === 0 ? 'idle' : 'move';
          }
        });
        w.vision.update();
        w.over = true;
        const st = w.vision.state(0);
        st.visible.fill(1);
        st.explored.fill(1);
        st.revision++;
        g.renderer.centerOn(gx - 0.5, gy + 1);
        // The HUD owns the bottom half of a phone screen, so a subject centred in
        // the camera is a subject behind the command panel. Push the view down so
        // what is being reviewed sits in the band the player actually sees.
        g.renderer.camera.scrollY += 210;
        return { gx, gy };
      });
      await page.waitForTimeout(400);
      await shot(page, 'art-lineup-070');
      await page.evaluate(() => window.__game.renderer.camera.setZoom(1.4));
      await page.waitForTimeout(300);
      await shot(page, 'art-lineup-140');
      await page.evaluate(() => window.__game.renderer.camera.setZoom(0.7));
      console.log(`  unit lineup posed at ${at.gx},${at.gy}`);
    }

    // --- 4. the three camps, side by side, at the real default zoom ----------
    if (want('camps')) {
      await page.evaluate(() => {
        const g = window.__game;
        const w = g.world;
        const W = window.__world;
        const tc = [...w.players[0].owned].map((id) => w.entities.get(id))
          .find((e) => e && e.type === 'towncenter');
        const gx = Math.round(tc.x) + 8;
        const gy = Math.round(tc.y) + 8;
        for (const e of [...w.resources, ...w.buildings, ...w.units]) {
          if (e.type === 'towncenter') continue;
          if (Math.abs(e.x - gx) < 16 && Math.abs(e.y - gy) < 16) W.removeEntity(w, e);
        }
        // Along a screen-horizontal line (equal gx+gy), so all three sit at the
        // same depth and none of them can hide behind another.
        ['mill', 'lumbercamp', 'miningcamp'].forEach((t, i) => {
          W.spawnBuilding(w, t, 0, gx - 3 + i * 3, gy + 3 - i * 3);
        });
        W.spawnBuilding(w, 'house', 0, gx + 2, gy + 8);
        w.vision.update();
        w.over = true;
        const st = w.vision.state(0);
        st.visible.fill(1);
        st.explored.fill(1);
        st.revision++;
        g.renderer.centerOn(gx + 2, gy + 2);
        // The HUD owns the bottom half of a phone screen, so a subject centred in
        // the camera is a subject behind the command panel. Push the view down so
        // what is being reviewed sits in the band the player actually sees.
        g.renderer.camera.scrollY += 210;
      });
      await page.waitForTimeout(400);
      await shot(page, 'art-camps-070');
      await page.evaluate(() => window.__game.renderer.camera.setZoom(1.2));
      await page.waitForTimeout(300);
      await shot(page, 'art-camps-120');
      await page.evaluate(() => window.__game.renderer.camera.setZoom(0.7));
    }

    // --- 5. construction stages ---------------------------------------------
    if (want('build')) {
      await page.evaluate(() => {
        const g = window.__game;
        const w = g.world;
        const W = window.__world;
        const tc = [...w.players[0].owned].map((id) => w.entities.get(id))
          .find((e) => e && e.type === 'towncenter');
        const gx = Math.round(tc.x) + 4;
        const gy = Math.round(tc.y) + 14;
        for (const e of [...w.resources, ...w.buildings, ...w.units]) {
          if (e.type === 'towncenter') continue;
          if (Math.abs(e.x - gx) < 16 && Math.abs(e.y - gy) < 16) W.removeEntity(w, e);
        }
        [0.02, 0.3, 0.6, 0.85, 1].forEach((f, i) => {
          const b = W.spawnBuilding(w, 'barracks', 0, gx - 8 + i * 4, gy, { complete: f >= 1 });
          if (f < 1) {
            b.buildProgress = b.buildTime * f;
            b.complete = false;
          }
        });
        w.vision.update();
        w.over = true;
        const st = w.vision.state(0);
        st.visible.fill(1);
        st.explored.fill(1);
        st.revision++;
        g.renderer.centerOn(gx, gy + 1);
        // The HUD owns the bottom half of a phone screen, so a subject centred in
        // the camera is a subject behind the command panel. Push the view down so
        // what is being reviewed sits in the band the player actually sees.
        g.renderer.camera.scrollY += 210;
      });
      await page.waitForTimeout(400);
      await shot(page, 'art-construction');
    }

    // --- 6. cliffs -----------------------------------------------------------
    if (want('cliff')) {
      const n = await page.evaluate(() => {
        const g = window.__game;
        const w = g.world;
        const W = window.__world;
        const tc = [...w.players[0].owned].map((id) => w.entities.get(id))
          .find((e) => e && e.type === 'towncenter');
        const gx = Math.round(tc.x) - 4;
        const gy = Math.round(tc.y) - 16;
        for (const e of [...w.resources, ...w.buildings, ...w.units]) {
          if (e.type === 'towncenter') continue;
          if (Math.abs(e.x - gx) < 16 && Math.abs(e.y - gy) < 16) W.removeEntity(w, e);
        }
        // A ridge with a step in it and a two-tile-thick shoulder, which is what
        // exercises every one of the four neighbour masks.
        const tiles = [];
        for (let i = 0; i < 9; i++) tiles.push([gx - 4 + i, gy]);
        for (let i = 0; i < 5; i++) tiles.push([gx - 4 + i, gy + 1]);
        for (let i = 0; i < 4; i++) tiles.push([gx + 4, gy + 1 + i]);
        const count = g.renderer.debugCliffs(tiles);
        // Prove the block grid took: A* must refuse a path through the ridge.
        const u = W.spawnUnit(w, 'militia', 0, gx - 1, gy + 4);
        w.vision.update();
        w.over = true;
        const st = w.vision.state(0);
        st.visible.fill(1);
        st.explored.fill(1);
        st.revision++;
        g.renderer.centerOn(gx, gy + 2);
        // The HUD owns the bottom half of a phone screen, so a subject centred in
        // the camera is a subject behind the command panel. Push the view down so
        // what is being reviewed sits in the band the player actually sees.
        g.renderer.camera.scrollY += 210;
        return { count, blocked: w.blocked[gy * w.width + (gx - 1)], unit: u.id };
      });
      await page.waitForTimeout(400);
      await shot(page, 'art-cliffs');
      check('cliff tiles are terrain-blocked for pathfinding', n.blocked === 2,
        `blocked value ${n.blocked}`);
      // The route across the ridge. A smoothed path can be very few waypoints
      // even when it detours a long way, so the thing to measure is its length
      // against the straight line, and whether any step of it stands on rock.
      const route = await page.evaluate(async ([ux]) => {
        const w = window.__game.world;
        const pf = await import('/src/systems/pathfinding.js');
        const u = w.units.find((e) => e.id === ux);
        const p = pf.findPath(w, u.x, u.y, u.x, u.y - 8);
        if (!p || !p.length) return { len: 0, onRock: 0, direct: 8 };
        let len = 0;
        let px = u.x;
        let py = u.y;
        let onRock = 0;
        for (const q of p) {
          len += Math.hypot(q.x - px, q.y - py);
          px = q.x;
          py = q.y;
          if (w.cliff[(q.y | 0) * w.width + (q.x | 0)]) onRock++;
        }
        return { len, onRock, direct: 8 };
      }, [n.unit]);
      check('no step of the route stands on a cliff', route.onRock === 0,
        `${route.onRock} waypoints on rock`);
      check('the route round the ridge is longer than the straight line',
        route.len > route.direct * 1.2, `${route.len.toFixed(1)} tiles vs 8 direct`);
      console.log(`  ${n.count} cliff tiles drawn`);
    }

    // --- 7. selection, rally, bars, damage -----------------------------------
    if (want('feedback')) {
      await page.evaluate(() => {
        const g = window.__game;
        const w = g.world;
        const W = window.__world;
        const tc = [...w.players[0].owned].map((id) => w.entities.get(id))
          .find((e) => e && e.type === 'towncenter');
        const gx = Math.round(tc.x) + 16;
        const gy = Math.round(tc.y) + 4;
        for (const e of [...w.resources, ...w.buildings, ...w.units]) {
          if (e.type === 'towncenter') continue;
          if (Math.abs(e.x - gx) < 14 && Math.abs(e.y - gy) < 14) W.removeEntity(w, e);
        }
        const barracks = W.spawnBuilding(w, 'barracks', 0, gx - 3, gy - 3);
        barracks.rally = { x: gx + 4, y: gy + 4 };
        w.selection.clear();
        w.selection.add(barracks.id);
        for (let i = 0; i < 3; i++) {
          const mine = W.spawnUnit(w, 'militia', 0, gx + i * 1.4, gy + 2);
          mine.hp = mine.maxHp * (0.9 - i * 0.3);
          w.selection.add(mine.id);
          const foe = W.spawnUnit(w, 'spearman', 1, gx + i * 1.4, gy + 4);
          foe.hp = foe.maxHp * 0.55;
          foe.state = 'attack';
        }
        w.vision.update();
        w.over = true;
        const st = w.vision.state(0);
        st.visible.fill(1);
        st.explored.fill(1);
        st.revision++;
        g.renderer.centerOn(gx, gy + 1);
        // The HUD owns the bottom half of a phone screen, so a subject centred in
        // the camera is a subject behind the command panel. Push the view down so
        // what is being reviewed sits in the band the player actually sees.
        g.renderer.camera.scrollY += 210;
      });
      // Damage *after* the reveal: every effect in fx.js is fog-gated, so a hit
      // on a tile that is not yet lit produces no flash and no number — which
      // is correct behaviour and a useless screenshot.
      await page.evaluate(() => {
        const w = window.__game.world;
        for (const u of w.units) {
          if (u.player === 1) w.events.emit('damage', { entity: null, target: u, amount: 7 });
        }
      });
      await page.waitForTimeout(90);
      await shot(page, 'art-feedback');
    }

    // --- 7b. a real melee, for the hit flashes and the deaths ----------------
    if (want('melee')) {
      await page.evaluate(() => {
        const g = window.__game;
        const w = g.world;
        const W = window.__world;
        const tc = [...w.players[0].owned].map((id) => w.entities.get(id))
          .find((e) => e && e.type === 'towncenter');
        const gx = Math.round(tc.x) - 10;
        const gy = Math.round(tc.y) + 12;
        for (const e of [...w.resources, ...w.buildings, ...w.units]) {
          if (e.type === 'towncenter') continue;
          if (Math.abs(e.x - gx) < 16 && Math.abs(e.y - gy) < 16) W.removeEntity(w, e);
        }
        for (let i = 0; i < 7; i++) {
          W.spawnUnit(w, i % 2 ? 'militia' : 'spearman', 0, gx - 2 + i * 0.9, gy - 1.2);
          W.spawnUnit(w, i % 3 ? 'militia' : 'archer', 1, gx - 2 + i * 0.9, gy + 1.2);
        }
        w.vision.update();
        const st = w.vision.state(0);
        st.visible.fill(1);
        st.explored.fill(1);
        st.revision++;
        g.renderer.centerOn(gx, gy);
        g.renderer.camera.scrollY += 210;
        // Every other section freezes the sim with world.over so its shots hold
        // still, and this is the one section that needs it running: the fight is
        // played by the real combat system rather than staged, so the shots
        // catch what a player would see. Without this the melee is photographed
        // against a stopped clock and nobody ever swings.
        w.over = false;
        w.winner = null;
      });
      // The fight is run by the real combat system rather than staged, so what
      // the shots catch is what a player would see: units acquiring, swinging,
      // flashing white on a hit, and falling over.
      const before = await page.evaluate(() => window.__game.world.units.length);
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.__game.step(60));
        await page.waitForTimeout(200);
        await shot(page, `art-melee-${i}`);
      }
      const left = await page.evaluate(() => window.__game.world.units.length);
      check('the staged melee actually killed somebody', left < before,
        `${before} before, ${left} after`);
    }

    // --- 8. performance ------------------------------------------------------
    //
    // WHAT THIS CHECKS, AND WHY IT NO LONGER CHECKS A FRAME TIME
    // ----------------------------------------------------------
    // This section used to assert a median frame time under a fixed number of
    // milliseconds. It cannot: the harness runs Chromium with
    // `--use-gl=swiftshader`, so there is no GPU and every pixel is rasterised
    // on the CPU. Two measurements settle it.
    //
    // First, the floor. With the whole display list hidden — nothing drawn at
    // all, just Phaser's loop and the swap — a frame here costs twenty to
    // thirty milliseconds depending on how busy the build box is. The 60fps
    // budget is 16.7ms. There is no arrangement of this game, or of any game,
    // that renders inside a frame budget on this machine, so a wall-clock
    // pass/fail here can only ever be a number picked to sit above whatever the
    // renderer currently costs. The floor is measured and printed below rather
    // than quoted, so the reader can see it for themselves on the day.
    //
    // Second, the split. Of a 45ms frame in a two-hundred unit battle, about
    // 4ms is our JavaScript and the rest is software rasterisation — and the
    // per-layer breakdown is all fill: the fog quad and the terrain, both of
    // which are single screen-sized textured quads that a phone GPU draws in
    // microseconds and swiftshader takes ten milliseconds over.
    //
    // So the assertions are the structural ones, which mean the same thing on
    // both machines: how many draw calls the frame submits, how many Game
    // Objects it touches, and how many milliseconds of JavaScript it costs. The
    // wall clock is printed next to the measured floor, because the ratio
    // between them is informative and the absolute number is not.
    //
    // tests/perf.browser.mjs is the full version of this: a running battle with
    // the fog, the minimap and the HUD all live, and budgets per phase.
    if (want('perf')) {
      const perf = await page.evaluate(async () => {
        const g = window.__game;
        const w = g.world;
        const W = window.__world;
        const tc = [...w.players[0].owned].map((id) => w.entities.get(id))
          .find((e) => e && e.type === 'towncenter');
        const gx = Math.round(tc.x);
        const gy = Math.round(tc.y);
        const types = ['villager', 'militia', 'spearman', 'archer', 'scout', 'ram'];
        for (let i = 0; i < 130; i++) {
          const u = W.spawnUnit(w, types[i % types.length], i % 2,
            gx - 7 + (i % 15) * 1.0, gy - 7 + Math.floor(i / 15) * 1.0);
          u.state = i % 3 === 0 ? 'move' : i % 3 === 1 ? 'attack' : 'gather';
          u.facing = i % 8;
        }
        w.vision.update();
        w.over = true;
        const st = w.vision.state(0);
        st.visible.fill(1);
        st.explored.fill(1);
        st.revision++;
        g.renderer.centerOn(gx, gy);
        // The HUD owns the bottom half of a phone screen, so a subject centred in
        // the camera is a subject behind the command panel. Push the view down so
        // what is being reviewed sits in the band the player actually sees.
        g.renderer.camera.scrollY += 210;
        g.renderer.camera.setZoom(0.7);

        // Count real GL draw calls by wrapping the context. This is the only
        // number that says whether the single-atlas promise is being kept.
        const gl = g.scene.game.renderer.gl;
        let calls = 0;
        const de = gl.drawElements.bind(gl);
        const da = gl.drawArrays.bind(gl);
        gl.drawElements = (...a) => { calls++; return de(...a); };
        gl.drawArrays = (...a) => { calls++; return da(...a); };

        const spin = async (n) => {
          const out = [];
          let last = performance.now();
          await new Promise((resolve) => {
            let k = 0;
            const tick = () => {
              const now = performance.now();
              out.push(now - last);
              last = now;
              if (++k >= n) resolve();
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          const kept = out.slice(Math.floor(n / 3)).sort((a, b) => a - b);
          return { all: out, median: kept[Math.floor(kept.length / 2)],
            p95: kept[Math.floor(kept.length * 0.95)] };
        };

        g.perf.enable(true);
        const live = await spin(90);
        g.perf.enable(false);
        gl.drawElements = de;
        gl.drawArrays = da;

        // The floor: the same loop with nothing in the display list at all.
        // Whatever this costs is the harness, not the game.
        const list = g.scene.children.list.slice();
        const was = list.map((o) => o.visible);
        list.forEach((o) => o.setVisible(false));
        const empty = await spin(60);
        list.forEach((o, i) => o.setVisible(was[i]));

        const report = g.perf.report(30);
        return {
          units: w.units.length,
          drawCallsPerFrame: calls / live.all.length,
          medianMs: live.median,
          p95Ms: live.p95,
          floorMs: empty.median,
          cpuMs: (report['scene.update'] || { median: 0 }).median,
          objects: (report.objects || { p95: 0 }).p95,
        };
      });
      console.log(`\n  perf: ${perf.units} units on screen — ` +
        `${perf.drawCallsPerFrame.toFixed(1)} draw calls/frame, ` +
        `${perf.objects.toFixed(0)} objects touched, ` +
        `${perf.cpuMs.toFixed(2)}ms of JavaScript`);
      console.log(`  wall clock ${perf.medianMs.toFixed(1)}ms median, ` +
        `p95 ${perf.p95Ms.toFixed(1)}ms — against a ${perf.floorMs.toFixed(1)}ms floor ` +
        'for an empty display list on this software rasteriser, versus a 16.7ms ' +
        '60fps budget. Not a phone number; see the note above.');
      await shot(page, 'art-crowd');
      check('the batch is not being broken per sprite',
        perf.drawCallsPerFrame < 24, `${perf.drawCallsPerFrame.toFixed(1)} calls`);
      // Only what the camera holds. 130 units at the default zoom is about 260
      // bodies and markers plus the ground under them; the map's 1900 trees and
      // every remembered ghost must not be in this number.
      check('130 units cost only the objects the camera can hold',
        perf.objects < 700, `${perf.objects.toFixed(0)} Game Objects touched`);
      // The transferable half of a frame. A tenth of the 60fps budget spent in
      // our own JavaScript, with the whole of the rest left for the browser,
      // the driver and the phone's slower core.
      check('130 units cost little enough JavaScript to leave the budget alone',
        perf.cpuMs < 4, `${perf.cpuMs.toFixed(2)}ms of scene update`);
    }

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }

  console.log('');
  if (failures.length) {
    console.log(`${failures.length} failure(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('art review complete\n');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
