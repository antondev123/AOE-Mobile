// Screenshots of the game as a player actually meets it, for review.
//
//   node tools/review-shots.mjs [--out screenshots/review] [--only <substring>]
//
// This is not a test and it asserts almost nothing. It exists because the only
// honest way to judge how a game looks is to look at it, and "boot it, play it
// for four minutes, photograph it at the moments that matter" is a thing worth
// having as one command rather than as a paragraph of instructions nobody
// follows the same way twice.
//
// The distinction from tests/art.browser.mjs is deliberate. That file
// photographs *subjects* — a contact sheet of every pose, a lineup of every
// building — on a frozen world, which is what you want when you are checking
// whether a sprite is drawn correctly. This file photographs *situations*: an
// opening, a working economy, a battle, a besieged town. Those are what you
// want when the question is "does this look like a game somebody would want to
// play", and they cannot be staged, because half of what is wrong with a frame
// is that too much or too little is happening in it.
//
// Every shot is taken at phone size, because that is the only size this game
// has to look good at.

import fs from 'node:fs';
import path from 'node:path';
import { boot, step } from '../tests/harness.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const OUT = arg('out', 'screenshots/review');
const ONLY = arg('only', '');

fs.mkdirSync(OUT, { recursive: true });

const shots = [];
async function shot(page, name, note) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push({ name, note, file });
  console.log(`  ${name.padEnd(24)} ${note}`);
}

/** Sim seconds, not steps — the caller should think in match time. */
async function play(page, seconds) {
  await step(page, Math.round(seconds * 20));
  // One animation frame so the renderer catches up with the state it now has.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
}

/**
 * Point the camera at a GRID position and settle the zoom.
 *
 * Grid, not world pixels — renderer.centerOn takes tile coordinates and does
 * the projection itself. Handing it pixels puts the camera several thousand
 * tiles off the map and produces a screenshot of the background colour, which
 * is exactly what the first run of this tool produced.
 *
 * Zoom is set first so that centerOn is clamping against the viewport the shot
 * will actually be taken at.
 */
async function look(page, gx, gy, zoom) {
  await page.evaluate(([x, y, z]) => {
    if (z) window.__phaser.scene.scenes[0].cameras.main.setZoom(z);
    window.__game.renderer.centerOn(x, y);
  }, [gx, gy, zoom]);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
}

/**
 * Play the player's side, badly but continuously.
 *
 * Every shot after the opening used to be taken on a match where one side did
 * nothing at all, and since the enemy AI learned to reach the Castle Age that
 * is a match the player loses at 8m30s — so "battle" photographed the defeat
 * card and "midgame" photographed a base with three villagers in it. Neither
 * is a picture of this game.
 *
 * This is not an AI and is not trying to be. It keeps a Town Center training
 * villagers, puts up the buildings an opening needs, and keeps the military
 * buildings' queues full, which is enough to produce the thing the shots are
 * for: two armies on the same piece of ground. The stockpile is topped up
 * rather than earned, deliberately — a review harness that has to play well
 * enough to afford an army is a review harness nobody can rely on.
 */
async function propUp(page) {
  await page.evaluate(() => {
    const g = window.__game;
    const w = g.world;
    if (w.__propped) return;
    w.__propped = true;
    const eco = g.economy || null;
    // Re-driven from the scene's own step, so it keeps up however fast the
    // harness advances the simulation.
    const inner = g.step;
    let acc = 0;
    g.step = (n = 1) => {
      for (let i = 0; i < n; i++) {
        inner(1);
        if (++acc % 40) continue;               // twice a simulated second
        const p = w.players[0];
        for (const k of ['food', 'wood', 'gold', 'stone']) {
          if (p.resources[k] < 400) p.resources[k] = 400;
        }
        for (const b of w.buildings) {
          if (b.dead || b.player !== 0 || !b.complete) continue;
          if (!b.trains || !b.trains.length) continue;
          if (b.queue && b.queue.length >= 2) continue;
          // Everything it can make, round-robin off the tick counter, so the
          // army that appears is mixed rather than forty militia.
          const t = b.trains[(acc / 40 | 0) % b.trains.length];
          if (g.queueTrain) g.queueTrain(b, t);
        }
      }
    };
  });
}

/**
 * Lift the fog for the player, for one screenshot.
 *
 * An artifice, and worth being clear about: this is not what a player sees. It
 * is here because half the frames worth reviewing are of ground nobody has
 * walked to yet — the middle of the map at minute zero is, correctly, a black
 * rectangle, and a black rectangle tells you nothing about whether the terrain
 * looks good. The masks are recomputed by the next update(), so this only holds
 * for the frame it is taken on and cannot leak into anything that plays on.
 */
async function reveal(page) {
  await page.evaluate(() => {
    const st = window.__game.world.vision.states[0];
    st.explored.fill(1);
    st.visible.fill(1);
    st.revision++;
  });
  // Two frames: one for the fog texture to notice the revision, one to draw.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Grid position of a player's first building of a type. */
function findBuilding(page, player, type) {
  return page.evaluate(([p, t]) => {
    const w = window.__game.world;
    const b = w.buildings.find((e) => !e.dead && e.player === p && (!t || e.type === t));
    return b ? { x: b.x, y: b.y } : null;
  }, [player, type]);
}

const want = (name) => !ONLY || name.includes(ONLY);

const { page, errors, close } = await boot({ query: 'autostart' });

try {
  // --- The first thing anybody sees ----------------------------------------
  if (want('opening')) {
    await play(page, 2);
    await shot(page, 'opening', 'the first frame of a new match');
  }

  // Everything past the opening wants a match with two sides in it.
  await propUp(page);

  // --- A working economy, at both readable zooms ----------------------------
  if (want('economy')) {
    await play(page, 150);
    const tc = await findBuilding(page, 0, 'towncenter');
    if (tc) await look(page, tc.x, tc.y, 0.7);
    await shot(page, 'economy-070', 'two and a half minutes in, default zoom');
    if (tc) await look(page, tc.x, tc.y, 1.2);
    await shot(page, 'economy-120', 'the same town, zoomed in');
    if (tc) await look(page, tc.x, tc.y, 0.55);
    await shot(page, 'economy-055', 'the same town, zoomed out');
  }

  // --- Terrain away from anybody's base -------------------------------------
  // The middle of the map is most of what a player looks at while moving an
  // army, and it is the frame with nothing in it to distract from the ground.
  if (want('terrain')) {
    const mid = await page.evaluate(() => {
      const w = window.__game.world;
      return { x: w.width / 2, y: w.height / 2 };
    });
    await look(page, mid.x, mid.y, 0.7);
    await reveal(page);
    await shot(page, 'terrain-mid', 'the middle of the map — ground, rock and water (fog lifted)');
  }

  // --- A mature town, and then a war ---------------------------------------
  if (want('midgame') || want('battle')) {
    await play(page, 210);
    const tc = await findBuilding(page, 0, 'towncenter');
    if (tc) await look(page, tc.x, tc.y, 0.7);
    await shot(page, 'midgame', 'six minutes in — a built-up base');
  }

  if (want('battle')) {
    // Find where the most bodies are and point the camera at it: a battle
    // screenshot aimed anywhere else is a screenshot of grass.
    await play(page, 180);
    const hot = await page.evaluate(() => {
      const w = window.__game.world;
      const live = w.units.filter((u) => !u.dead);
      if (!live.length) return null;
      // The densest 6-tile cell, which is where a fight is if there is one.
      const cell = new Map();
      for (const u of live) {
        const k = `${Math.floor(u.x / 6)},${Math.floor(u.y / 6)}`;
        const c = cell.get(k) || { n: 0, x: 0, y: 0, players: new Set() };
        c.n++; c.x += u.x; c.y += u.y; c.players.add(u.player);
        cell.set(k, c);
      }
      let best = null;
      for (const c of cell.values()) {
        // A cell with two players in it beats a bigger cell with one.
        const score = c.n * (c.players.size > 1 ? 10 : 1);
        if (!best || score > best.score) best = { score, x: c.x / c.n, y: c.y / c.n, n: c.n };
      }
      return best;
    });
    if (hot) {
      await look(page, hot.x, hot.y, 0.85);
      await shot(page, 'battle', `the busiest ground on the map (${hot.n} units)`);
    }
  }

  // --- The HUD doing its jobs ----------------------------------------------
  if (want('hud')) {
    // Selection: pick every soldier, which fills the command panel.
    await page.evaluate(() => {
      const w = window.__game.world;
      const mine = w.units.filter((u) => !u.dead && u.player === 0 && u.type !== 'villager');
      const pick = mine.length ? mine : w.units.filter((u) => !u.dead && u.player === 0);
      w.selection.clear();
      for (const u of pick.slice(0, 12)) w.selection.add(u.id);
      if (window.__game.hud && window.__game.hud.refresh) window.__game.hud.refresh();
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    await shot(page, 'hud-army', 'an army selected — the command panel');

    // The build menu, which is the densest screen in the game.
    await page.evaluate(() => {
      const w = window.__game.world;
      const v = w.units.find((u) => !u.dead && u.player === 0 && u.type === 'villager');
      w.selection.clear();
      if (v) w.selection.add(v.id);
      if (window.__game.hud && window.__game.hud.refresh) window.__game.hud.refresh();
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    await shot(page, 'hud-villager', 'a villager selected — the build button');

    const buildBtn = await page.$('[data-act="build"], #btn-build, .cmd-build');
    if (buildBtn) {
      await buildBtn.click();
      await page.evaluate(() => new Promise((r) => setTimeout(r, 350)));
      await shot(page, 'hud-build-menu', 'the build menu, all three ages');
    }
  }
} finally {
  await close();
}

console.log(`\n${shots.length} shots in ${OUT}`);
if (errors.length) {
  console.log(`\n${errors.length} PAGE ERROR(S) — a screenshot of a broken game is not a review:`);
  for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);
  process.exitCode = 1;
}
