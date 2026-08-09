// In-browser verification of the touch UI pass: the villager allocation
// manager, the idle-villager button, batch building placement and its queue,
// the training queue, and a layout regression guard for the whole HUD at
// phone size with worst-case late-game numbers.
//
//   node tests/touchui.browser.mjs [--shots screenshots/] [--only <substring>]
//
// Same house rules as tests/ui.browser.mjs: nothing pokes the input layer's
// internals, every control is worked the way a thumb works it (a real click, a
// real touch drag), and every claim is then checked against the simulation
// rather than against the DOM that made it.

import fs from 'node:fs';
import path from 'node:path';
import { boot, step, drag } from './harness.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SHOT_DIR = arg('shots', 'screenshots');
const ONLY = arg('only', '');

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}

/**
 * Force a synchronous HUD re-render, so a read never races the frame. A no-op
 * before the game has started, which is the state the boot-card sweep runs in.
 */
const paint = (page) => page.evaluate(() => {
  if (window.__game && window.__game.hud) window.__game.hud.update(0.016);
});

/** Centre the camera on a grid point and return its CSS coordinates. */
async function aim(page, gx, gy) {
  return page.evaluate(([x, y]) => {
    const g = window.__game;
    g.input.centerOnGrid(x, y);
    const p = g.input._toScreen(x, y);
    const canvas = g.scene.game.canvas;
    const r = canvas.getBoundingClientRect();
    const size = g.scene.game.scale.gameSize;
    return {
      x: r.left + (p.x * r.width) / size.width,
      y: r.top + (p.y * r.height) / size.height,
    };
  }, [gx, gy]);
}

/**
 * A press-and-lift on the canvas with real PointerEvents, aimed so the
 * placement ghost lands on (gx, gy). The CDP touch pipeline cannot be inspected
 * mid-gesture and costs ~350ms a tap, which a five-tap batch cannot afford.
 */
async function tapGrid(page, gx, gy, pointerId) {
  return page.evaluate(([x, y, id]) => {
    const g = window.__game;
    g.input.centerOnGrid(x, y);
    const p = g.input._toScreen(x, y);
    const canvas = g.scene.game.canvas;
    const r = canvas.getBoundingClientRect();
    const size = g.scene.game.scale.gameSize;
    const GHOST_LIFT = g.input._ghostLift(); // the lift the ghost is actually using
    const opts = {
      pointerId: id,
      pointerType: 'touch',
      clientX: r.left + (p.x * r.width) / size.width,
      clientY: r.top + ((p.y + GHOST_LIFT) * r.height) / size.height,
      bubbles: true,
      cancelable: true,
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
    window.dispatchEvent(new PointerEvent('pointerup', opts));
  }, [gx, gy, pointerId]);
}

/** Spawn n villagers in a ring around the Town Center. */
const staffUp = (page, n) => page.evaluate(async (count) => {
  const { spawnUnit } = await import('/src/core/world.js');
  const { nearestWalkable } = await import('/src/systems/pathfinding.js');
  const w = window.__game.world;
  const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
  const made = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const s = nearestWalkable(w, Math.round(tc.x + Math.cos(a) * 4), Math.round(tc.y + Math.sin(a) * 4), 6);
    if (s) made.push(spawnUnit(w, 'villager', 0, s.tx + 0.5, s.ty + 0.5).id);
  }
  // Housing, so the population cap never quietly decides the outcome.
  w.players[0].popCap = 200;
  return made;
}, n);

// --- Run 1: the villager allocation manager ----------------------------------
//
// The headline claim is two-sided and the second half matters more: the manager
// must move villagers until the split is met, and it must then STOP. A manager
// that keeps issuing orders has villagers permanently walking, and a walking
// villager gathers nothing.

async function allocationRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    await staffUp(page, 9);
    // Guarantee food and wood are both workable near the base; which resources a
    // generated map puts within reach is not what is under test here.
    await page.evaluate(async () => {
      const { spawnResource } = await import('/src/core/world.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      const free = (tx, ty) => w.blocked[ty * w.width + tx] === 0 && w.terrain[ty * w.width + tx] !== 2;
      for (const [type, ux, uy] of [['berry', 1, 0], ['tree', -1, 0]]) {
        let placed = 0;
        for (let r = 4; r <= 16 && placed < 4; r++) {
          for (let off = -1; off <= 1 && placed < 4; off++) {
            const tx = Math.round(tc.x) + ux * r + (ux ? 0 : off);
            const ty = Math.round(tc.y) + uy * r + (uy ? 0 : off);
            if (!free(tx, ty)) continue;
            spawnResource(w, type, tx, ty);
            placed++;
          }
        }
      }
    });

    // --- Open the sheet from the dock, exactly as a thumb does. --------------
    await page.locator('#btn-jobs').click();
    const opened = await page.evaluate(() => ({
      shown: !document.getElementById('alloc-sheet').hidden,
      sliders: document.querySelectorAll('#alloc-sheet input[type="range"]').length,
      on: document.querySelector('.alloc-toggle .state').textContent,
    }));
    check('the Jobs button opens the allocation sheet', opened.shown);
    check('with one slider per resource', opened.sliders === 4, `${opened.sliders} sliders`);
    check('and the manager starts switched OFF', opened.on === 'OFF', opened.on);

    // --- A real thumb drag on a slider must move the slider, not the map. ----
    // A genuine touch drag through CDP, not a synthesised PointerEvent: the
    // whole question is whether the browser gives the gesture to the slider or
    // to the map underneath, and only a real touch sequence can answer it.
    const where = await page.evaluate(() => {
      const g = window.__game;
      const r = document.getElementById('alloc-food').getBoundingClientRect();
      return {
        y: r.top + r.height / 2,
        x0: r.left + r.width * 0.12,
        x1: r.left + r.width * 0.62,
        v: Number(document.getElementById('alloc-food').value),
        cx: g.input.camera.midPoint.x,
        cy: g.input.camera.midPoint.y,
      };
    });
    await drag(page, where.x0, where.y, where.x1, where.y, 10);
    await page.waitForTimeout(60);
    const dragged = await page.evaluate((was) => {
      const g = window.__game;
      return {
        after: Number(document.getElementById('alloc-food').value),
        shown: document.querySelector('.alloc-row[data-res="food"] .pct').firstChild.textContent,
        moved: Math.hypot(g.input.camera.midPoint.x - was.cx, g.input.camera.midPoint.y - was.cy),
      };
    }, where);
    check('dragging a slider with a thumb moves it', dragged.after !== where.v,
      `${where.v}% -> ${dragged.after}%`);
    check('and the readout follows the thumb', dragged.shown === `${dragged.after}%`,
      `${dragged.shown} against a value of ${dragged.after}`);
    check('and the map underneath it does not move', dragged.moved < 0.5,
      `camera moved ${dragged.moved.toFixed(1)} world px`);

    // --- Ask for 50/50 food and wood, and switch it on. ---------------------
    const setSlider = (res, v) => page.evaluate(([id, val]) => {
      const el = document.getElementById(id);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(val));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [`alloc-${res}`, v]);

    // Zeroed shares first: every drag rebalances the *others*, so asking for
    // 50% food while gold and stone still hold a share does not leave wood on 50.
    await setSlider('gold', 0);
    await setSlider('stone', 0);
    await setSlider('food', 50);
    const split = await page.evaluate(() =>
      [...document.querySelectorAll('.alloc-row')].map((r) => `${r.dataset.res}:${r.querySelector('.pct').firstChild.textContent}`).join(' '));
    check('the four sliders read the split back', split === 'food:50% wood:50% gold:0% stone:0%', split);

    await page.locator('.alloc-toggle').click();
    check('the toggle turns it on',
      await page.evaluate(() => document.querySelector('.alloc-toggle .state').textContent === 'ON'));

    await page.screenshot({ path: path.join(SHOT_DIR, 'touch-alloc-sheet.png') });

    // --- Ninety seconds of match time. --------------------------------------
    await step(page, 1800);
    await paint(page);
    const settled = await page.evaluate(async () => {
      const a = await import('/src/systems/allocation.js');
      const w = window.__game.world;
      const c = a.allocationCounts(w, 0);
      return { c, moves: a.allocationState(w, 0).moves };
    });
    const c = settled.c;
    check('villagers end up split the way the sliders ask',
      Math.abs(c.assigned.food - c.desired.food) <= 1 &&
      Math.abs(c.assigned.wood - c.desired.wood) <= 1,
      `working ${JSON.stringify(c.assigned)} against wanted ${JSON.stringify(c.desired)}`);
    check('and nobody is left standing about', c.idle === 0, `${c.idle} idle of ${c.total}`);
    check('the panel shows the same numbers the sim has',
      await page.evaluate(([food, wood]) => {
        const txt = (res) => document.querySelector(`.alloc-row[data-res="${res}"] .pct small`).textContent;
        return txt('food').startsWith(String(food)) && txt('wood').startsWith(String(wood));
      }, [c.assigned.food, c.assigned.wood]),
      `panel should read ${c.assigned.food} / ${c.desired.food} and ${c.assigned.wood} / ${c.desired.wood}`);

    // --- ...and then it stops. -----------------------------------------------
    await step(page, 1200); // another minute, thirty more passes
    const churn = await page.evaluate(async () => {
      const a = await import('/src/systems/allocation.js');
      return a.allocationState(window.__game.world, 0).moves;
    });
    check('once balanced it stops re-tasking people', churn - settled.moves <= 3,
      `${churn - settled.moves} orders in the minute after it settled (${settled.moves} to get there)`);

    // --- Switching it off hands control straight back. ----------------------
    await page.locator('#btn-jobs').click();               // reopen (a step closed nothing, but be explicit)
    await page.evaluate(() => { document.getElementById('alloc-sheet').hidden = false; });
    await paint(page);
    // Hold the simulation still across the toggle. The claim is that *the
    // switch* moves nobody, not that the world stops — and a real Playwright
    // click takes 50-100ms of wall clock, which is one or two live sim steps
    // in which a villager can perfectly legitimately finish a bush and pick
    // the next one on its own. That race made this check fail about one run in
    // eight, always on a change that had nothing to do with it.
    const resume = await page.evaluate(() => {
      const s = window.__game.scene;
      s._realStep = s.simStep;
      s.simStep = () => {};
      return true;
    });
    const before = await page.evaluate(() => window.__game.world.units
      .filter((u) => u.player === 0 && u.type === 'villager')
      .map((u) => `${u.id}:${u.task && u.task.node ? u.task.node.id : '-'}`).join(','));
    await page.locator('.alloc-toggle').click();
    check('one tap switches it off',
      await page.evaluate(() => document.querySelector('.alloc-toggle .state').textContent === 'OFF'));
    const after = await page.evaluate((was) => {
      const now = window.__game.world.units
        .filter((u) => u.player === 0 && u.type === 'villager')
        .map((u) => `${u.id}:${u.task && u.task.node ? u.task.node.id : '-'}`).join(',');
      return { same: now === was, now };
    }, before);
    check('and nobody is moved by the switch itself', after.same, after.now);
    if (resume) {
      await page.evaluate(() => {
        const s = window.__game.scene;
        s.simStep = s._realStep;
      });
    }

    check('no console errors (allocation run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 2: the idle villager button -----------------------------------------

async function idleButtonRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    // Three villagers, deliberately idle, spread out enough that visiting each
    // one has to move the camera a measurable distance.
    const idlers = await page.evaluate(async () => {
      const { spawnUnit } = await import('/src/core/world.js');
      const { nearestWalkable } = await import('/src/systems/pathfinding.js');
      const { commandUnits } = await import('/src/systems/unitAI.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      // Put the starting villagers to work so only ours are idle.
      for (const u of w.units.filter((x) => x.player === 0 && x.type === 'villager')) {
        const n = w.resources.find((r) => r.amount > 0);
        if (n) commandUnits(w, [u], { type: 'gather', target: n, gx: n.x, gy: n.y });
      }
      const made = [];
      for (const [dx, dy] of [[8, 8], [-8, 8], [8, -8]]) {
        const s = nearestWalkable(w, Math.round(tc.x) + dx, Math.round(tc.y) + dy, 8);
        if (s) made.push(spawnUnit(w, 'villager', 0, s.tx + 0.5, s.ty + 0.5).id);
      }
      window.__game.scene.simStep = () => {}; // hold everything still
      window.__game.hud.update(0.016);
      return made;
    });
    check('three villagers are standing idle', idlers.length === 3, `${idlers.length}`);

    const btn = await page.evaluate(() => {
      const b = document.getElementById('btn-idle');
      const r = b.getBoundingClientRect();
      return {
        count: b.querySelector('.count').textContent,
        zero: b.classList.contains('is-zero'),
        w: Math.round(r.width), h: Math.round(r.height),
        onScreen: r.right <= innerWidth && r.bottom <= innerHeight && r.left >= 0 && r.top >= 0,
      };
    });
    check('the button shows the live count', btn.count === '3', btn.count);
    check('it is a full touch target and on screen',
      btn.w >= 44 && btn.h >= 44 && btn.onScreen, `${btn.w}x${btn.h}`);

    // --- Tapping cycles through them, centring the camera on each. -----------
    const visited = [];
    const jumps = [];
    for (let i = 0; i < 4; i++) {
      const from = await page.evaluate(() => ({
        x: window.__game.input.camera.midPoint.x, y: window.__game.input.camera.midPoint.y,
      }));
      await page.locator('#btn-idle').click();
      const after = await page.evaluate((f) => {
        const g = window.__game;
        const id = [...g.world.selection][0];
        const u = g.world.entities.get(id);
        return {
          id,
          moved: Math.hypot(g.input.camera.midPoint.x - f.x, g.input.camera.midPoint.y - f.y),
          centred: u ? Math.hypot(g.input._toScreen(u.x, u.y).x - g.input.camera.width / 2,
            g.input._toScreen(u.x, u.y).y - g.input.camera.height / 2) : Infinity,
        };
      }, from);
      visited.push(after.id);
      jumps.push(Math.round(after.moved));
    }
    check('each tap selects a different idle villager',
      new Set(visited.slice(0, 3)).size === 3, visited.join(' -> '));
    // Centred on the part of the screen the player can SEE, not on the middle
    // of the canvas. The HUD covers the bottom third, so a jump aimed at the
    // geometric centre used to land its villager under the dock — behind the
    // controls, and behind the thumb pressing them.
    check('and the camera lands on the one it selected, in the visible map band',
      await page.evaluate(() => {
        const g = window.__game;
        const u = g.world.entities.get([...g.world.selection][0]);
        const p = g.input._toScreen(u.x, u.y);
        const v = g.input._viewRect();
        return Math.abs(p.x - g.input.camera.width / 2) < 2 &&
               Math.abs(p.y - (v.top + v.height / 2)) < 2;
      }), `camera jumps: ${jumps.join(', ')} world px`);
    check('the fourth tap wraps back to the first',
      visited[3] === visited[0], visited.join(' -> '));

    await page.screenshot({ path: path.join(SHOT_DIR, 'touch-idle-button.png') });

    // --- At zero it dims rather than disappearing. --------------------------
    const quiet = await page.evaluate(async (ids) => {
      const { commandUnits } = await import('/src/systems/unitAI.js');
      const w = window.__game.world;
      const n = w.resources.find((r) => r.amount > 0);
      for (const id of ids) commandUnits(w, [w.entities.get(id)], { type: 'gather', target: n, gx: n.x, gy: n.y });
      window.__game.hud.update(0.016);
      const b = document.getElementById('btn-idle');
      const r = b.getBoundingClientRect();
      const style = getComputedStyle(b);
      return {
        count: b.querySelector('.count').textContent,
        label: b.querySelector('.lbl').textContent,
        zero: b.classList.contains('is-zero'),
        visible: style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0,
        w: Math.round(r.width), h: Math.round(r.height),
        opacity: Number(style.opacity),
        pulse: style.animationName,
        x: Math.round(r.left), y: Math.round(r.top),
      };
    }, idlers);
    check('with nobody idle the button stays exactly where it was',
      quiet.visible && quiet.w >= 44 && quiet.h >= 44,
      `${quiet.w}x${quiet.h} at ${quiet.x},${quiet.y}`);
    check('but goes quiet: dimmed, no pulse, and it says so',
      quiet.zero && quiet.opacity < 1 && quiet.pulse === 'none' && /none/i.test(quiet.label),
      `count=${quiet.count} label="${quiet.label}" opacity=${quiet.opacity} animation=${quiet.pulse}`);

    check('no console errors (idle button run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 3: batch placement and the build queue ------------------------------

async function batchPlacementRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    await staffUp(page, 5);
    const spots = await page.evaluate(async () => {
      const economy = await import('/src/systems/economy.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      w.players[0].resources.wood = 900;
      // Five places a house will genuinely be accepted, well apart from each
      // other so no two taps can be read as one. Five, not three: the second
      // batch below needs ground the first batch has not already built on.
      const out = [];
      for (let r = 4; r <= 22 && out.length < 5; r++) {
        for (const [dx, dy] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
          const gx = Math.floor(tc.x) + dx + 1;
          const gy = Math.floor(tc.y) + dy + 1;
          if (!economy.canPlaceReachable(w, 0, 'house', gx, gy)) continue;
          if (out.some((p) => Math.hypot(p.gx - gx, p.gy - gy) < 4)) continue;
          out.push({ gx, gy });
          if (out.length === 5) break;
        }
      }
      return out;
    });
    check('the map has five places to put a house', spots.length === 5, `${spots.length} found`);
    if (spots.length < 5) return;
    const batchSpots = spots.slice(0, 3);
    const laterSpots = spots.slice(3);

    // Arm the type once, through the real UI.
    await page.locator('#btn-menu').click();
    await page.locator('#menu-sheet button', { hasText: 'Select all villagers' }).click();
    await page.locator('#cmd-panel .cbtn', { hasText: 'Build' }).first().click();
    await page.locator('#build-menu .cbtn', { hasText: 'House' }).first().click();
    check('placement is armed',
      await page.evaluate(() => window.__game.hud.getPlacementType() === 'house'));

    const woodBefore = await page.evaluate(() => window.__game.world.players[0].resources.wood);
    for (let i = 0; i < batchSpots.length; i++) await tapGrid(page, batchSpots[i].gx, batchSpots[i].gy, 20 + i);
    await paint(page);

    const batch = await page.evaluate(async ([n, wood]) => {
      const economy = await import('/src/systems/economy.js');
      const w = window.__game.world;
      const sites = w.buildings.filter((b) => b.player === 0 && !b.complete);
      return {
        sites: sites.length,
        queued: economy.buildQueue(w, 0).length,
        chips: document.querySelectorAll('#build-queue .bq-chip').length,
        stripShown: !document.getElementById('build-queue').hidden,
        armed: window.__game.hud.getPlacementType(),
        placed: window.__game.hud.placedThisArm(),
        paid: wood - w.players[0].resources.wood,
        want: n * 25,
      };
    }, [batchSpots.length, woodBefore]);
    check('three taps put down three foundations without re-arming',
      batch.sites === 3 && batch.placed === 3 && batch.armed === 'house',
      `${batch.sites} sites, bar counted ${batch.placed}, still armed: ${batch.armed}`);
    check('and charged for exactly three', batch.paid === batch.want,
      `${batch.paid} wood for ${batch.want}`);
    check('the build queue strip shows all three',
      batch.stripShown && batch.queued === 3 && batch.chips === 3,
      `${batch.queued} queued, ${batch.chips} chips`);

    await page.screenshot({ path: path.join(SHOT_DIR, 'touch-batch-queue.png') });

    await page.locator('#place-bar button').click(); // Done

    // --- Builders work through it on their own. -----------------------------
    // No further orders are given from here: everything that happens next is
    // the queue doing its job.
    let built = null;
    for (let i = 0; i < 40 && !built; i++) {
      await step(page, 60);
      built = await page.evaluate(async () => {
        const economy = await import('/src/systems/economy.js');
        const w = window.__game.world;
        const left = economy.buildQueue(w, 0).length;
        const houses = w.buildings.filter((b) => b.player === 0 && b.type === 'house' && b.complete).length;
        return left === 0 ? { houses, time: w.time } : null;
      });
    }
    check('builders work through the whole queue with no further orders',
      !!built && built.houses >= 3,
      built ? `${built.houses} houses standing after ${built.time.toFixed(0)}s`
        : 'the queue never emptied');
    check('and the strip empties itself when the work is done',
      await page.evaluate(() => { window.__game.hud.update(0.016); return document.getElementById('build-queue').hidden; }));

    await page.evaluate((s) => window.__game.input.centerOnGrid(s.gx, s.gy), batchSpots[0]);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOT_DIR, 'touch-batch-built.png') });

    // --- Cancelling an entry gives the wood back. ---------------------------
    await page.locator('#cmd-panel .cbtn', { hasText: 'Build' }).first().click();
    await page.locator('#build-menu .cbtn', { hasText: 'House' }).first().click();
    const before2 = await page.evaluate(() => window.__game.world.players[0].resources.wood);
    await tapGrid(page, laterSpots[0].gx, laterSpots[0].gy, 60);
    await tapGrid(page, laterSpots[1].gx, laterSpots[1].gy, 61);
    await paint(page);
    const two = await page.evaluate(() => document.querySelectorAll('#build-queue .bq-chip').length);
    check('a second batch queues two more', two === 2, `${two} chips`);
    await page.locator('#build-queue .bq-chip').first().click();
    await paint(page);
    const cancelled = await page.evaluate(async ([wood]) => {
      const economy = await import('/src/systems/economy.js');
      const w = window.__game.world;
      return {
        queued: economy.buildQueue(w, 0).length,
        chips: document.querySelectorAll('#build-queue .bq-chip').length,
        refunded: w.players[0].resources.wood - (wood - 50),
      };
    }, [before2]);
    check('tapping a queue chip cancels that site and refunds it',
      cancelled.queued === 1 && cancelled.chips === 1 && cancelled.refunded === 25,
      `${cancelled.queued} left, ${cancelled.refunded} wood back`);

    check('no console errors (batch placement run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 4: the training queue -----------------------------------------------

async function trainQueueRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    await page.evaluate(async () => {
      const { spawnBuilding } = await import('/src/core/world.js');
      const { setSelection } = await import('/src/ui/selection.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      w.players[0].resources.food = 900;
      w.players[0].popCap = 200;
      // Real housing, so recomputePop does not take the cap away again.
      for (let i = 0; i < 6; i++) {
        for (let r = 5; r < 20; r++) {
          const gx = Math.floor(tc.x) + r;
          const gy = Math.floor(tc.y) + 4 + i * 3;
          const { canPlace } = await import('/src/core/world.js');
          if (canPlace(w, gx, gy, 2, 2)) { spawnBuilding(w, 'house', 0, gx, gy); break; }
        }
      }
      setSelection(w, [tc]);
      window.__game.hud.update(0.016);
    });

    const train = page.locator('#cmd-panel .cbtn', { hasText: 'Villager' }).first();
    for (let i = 0; i < 3; i++) await train.click();
    await step(page, 20);
    await paint(page);

    const q = await page.evaluate(() => {
      const head = document.querySelector('.qhead');
      const slots = [...document.querySelectorAll('.qslot')];
      const boxes = slots.map((s) => {
        const b = s.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) };
      });
      const fill = document.querySelector('.qprog > i');
      return {
        what: head.querySelector('.what').textContent,
        behind: head.querySelector('.behind').textContent,
        eta: head.querySelector('.eta').textContent,
        fill: parseFloat(fill.style.width),
        slots: slots.length,
        boxes,
        queue: window.__game.world.buildings.find((b) => b.player === 0 && b.type === 'towncenter').queue.length,
      };
    });
    check('the queue names what is training', /Training Villager/.test(q.what), q.what);
    check('and says how many are behind it', /\+2 waiting/.test(q.behind), q.behind);
    check('and how long the current one has left', /^\d+s$/.test(q.eta), q.eta);
    check('the progress bar has actually moved', q.fill > 0 && q.fill < 100, `${q.fill}%`);
    check('there is one chip per queued unit', q.slots === 3 && q.queue === 3,
      `${q.slots} chips for ${q.queue} queued`);
    check('every chip is a full touch target',
      q.boxes.every((b) => b.w >= 44 && b.h >= 44),
      q.boxes.map((b) => `${b.w}x${b.h}`).join(', '));

    await page.screenshot({ path: path.join(SHOT_DIR, 'touch-train-queue.png') });

    // --- Cancel the second one: refunded in full, and only that one goes. ----
    const before = await page.evaluate(() => ({
      food: window.__game.world.players[0].resources.food,
      queue: window.__game.world.buildings.find((b) => b.player === 0 && b.type === 'towncenter').queue.length,
    }));
    await page.locator('.qslot').nth(1).click();
    await paint(page);
    const after = await page.evaluate((was) => {
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      return {
        food: w.players[0].resources.food,
        gained: w.players[0].resources.food - was.food,
        queue: tc.queue.length,
        chips: document.querySelectorAll('.qslot').length,
        behind: document.querySelector('.qhead .behind').textContent,
        stillTraining: tc.queue.length ? tc.queue[0].type : null,
      };
    }, before);
    check('tapping a chip cancels that entry', after.queue === before.queue - 1 && after.chips === 2,
      `${before.queue} -> ${after.queue} queued, ${after.chips} chips`);
    check('and refunds it in full', after.gained === 50, `${after.gained} food back of 50`);
    check('the one being trained is untouched', after.stillTraining === 'villager', String(after.stillTraining));
    check('and the "behind it" count keeps up', /\+1 waiting/.test(after.behind), after.behind);

    check('no console errors (training queue run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 5: the layout regression guard --------------------------------------
//
// This is the one that exists because a reviewer measured the HUD on a real
// phone-sized page and found the menu button 23px off the right edge with an
// ordinary late-game bank, and 41px off with four five-digit stockpiles — the
// menu being the only door to "centre on Town Center" and both select-alls, so
// it became untappable exactly when a 200-pop army made it essential.
//
// So it is deliberately blunt and deliberately exhaustive: put the worst
// numbers the game can produce into the bar, walk through every state the HUD
// can be in, and assert that EVERY interactive control is on screen and at
// least 44x44. No exceptions, no allowances.

const WORST = `four five-digit stockpiles and 199/200 population`;

/**
 * Audit every control in the HUD.
 *
 * A control inside a scrolling panel (the command panel, the build menu, the
 * allocation sheet) is judged on its size and on whether its scroller is on
 * screen — it is reachable by scrolling, which is what the scroller is for.
 * Everything else must be inside the viewport outright.
 */
const AUDIT = `(() => {
  const vw = innerWidth;
  const vh = innerHeight;
  const bad = [];
  const seen = [];
  const scrolls = (n) => n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1;
  // The boot card is in the sweep too. It is the first screen a player ever
  // touches and, since the save landed, it can carry two full-width buttons
  // instead of one — which is exactly the kind of change that pushes something
  // off a 390px screen without anyone noticing. So is the end card, which has
  // grown a second button and a Results pill pinned to a corner of the map.
  for (const n of document.querySelectorAll(
    '#hud button, #hud input, #hud .tappable, #boot button, #boot summary, ' +
    '#endcard button')) {
    if (n.hidden || n.disabled) continue;
    const st = getComputedStyle(n);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    let hiddenByParent = false;
    for (let p = n.parentElement; p; p = p.parentElement) {
      if (p.hidden || getComputedStyle(p).display === 'none') { hiddenByParent = true; break; }
    }
    if (hiddenByParent) continue;
    const b = n.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) continue;
    const name = (n.id ? '#' + n.id : '') + '.' + (n.className || n.tagName);
    seen.push(name);
    if (b.width < 44 || b.height < 44) {
      bad.push(name + ' is ' + b.width.toFixed(1) + 'x' + b.height.toFixed(1));
    }
    let scroller = null;
    for (let p = n.parentElement; p && !scroller; p = p.parentElement) {
      if (scrolls(p)) scroller = p;
    }
    const box = scroller ? scroller.getBoundingClientRect() : b;
    if (box.left < -0.5 || box.right > vw + 0.5 || box.top < -0.5 || box.bottom > vh + 0.5) {
      bad.push(name + ' is off screen: ' + box.left.toFixed(1) + '..' + box.right.toFixed(1) +
        ' x ' + box.top.toFixed(1) + '..' + box.bottom.toFixed(1) + ' of ' + vw + 'x' + vh);
    }
  }
  return { bad, n: seen.length };
})()`;

async function audit(page, label) {
  await paint(page);
  const r = await page.evaluate(AUDIT);
  check(`${label}: every control on screen and at least 44x44`,
    r.bad.length === 0 && r.n > 0,
    r.bad.length ? r.bad.join(' | ') : `${r.n} controls checked`);
  return r;
}

async function layoutRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    // The worst numbers the HUD can ever be asked to print.
    await page.evaluate(async () => {
      const { spawnUnit } = await import('/src/core/world.js');
      const { commandUnits } = await import('/src/systems/unitAI.js');
      const w = window.__game.world;
      // Hold the simulation still: recomputePop() runs every step and would put
      // the population back to 3/5 before the first measurement, and the whole
      // point of this run is what the HUD looks like with numbers it will only
      // ever see once, late, when it matters most.
      window.__game.scene.simStep = () => {};
      const p = w.players[0];
      p.resources.food = 99999;
      p.resources.wood = 99999;
      p.resources.gold = 99999;
      p.resources.stone = 99999;
      p.pop = 199;
      p.popCap = 200;
      // A villager hauling to a long-named drop-off, so the job note is at its
      // longest, and the Castle Age so every research button exists.
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      const { completeResearch } = await import('/src/systems/tech.js');
      completeResearch(w, 0, 'feudal_age');
      completeResearch(w, 0, 'castle_age');
      spawnUnit(w, 'villager', 0, tc.x + 2, tc.y + 2);
      const tree = w.resources.find((n) => n.type === 'tree' && n.amount > 0);
      if (tree) {
        commandUnits(w, w.units.filter((u) => u.player === 0 && u.type === 'villager'),
          { type: 'gather', target: tree, gx: tree.x, gy: tree.y });
      }
      window.__game.hud.update(0.016);
    });

    const bar = await page.evaluate(() => {
      const r = document.getElementById('res-bar').getBoundingClientRect();
      const t = document.querySelector('.hud-top').getBoundingClientRect();
      return {
        res: `${r.left.toFixed(1)}..${r.right.toFixed(1)} x${r.height.toFixed(0)}`,
        top: `${t.left.toFixed(1)}..${t.right.toFixed(1)}`,
        vw: innerWidth,
        overflow: r.right > innerWidth || t.right > innerWidth,
        text: document.getElementById('res-bar').textContent.replace(/\\s+/g, ' ').trim(),
      };
    });
    check(`the resource bar stays on screen with ${WORST}`, !bar.overflow,
      `${bar.res} of ${bar.vw} — "${bar.text}"`);

    await audit(page, 'nothing selected');
    await page.screenshot({ path: path.join(SHOT_DIR, 'touch-layout-worst.png') });

    // Every state the HUD can be in, one after another.
    const states = [
      ['a villager selected', async () => page.evaluate(async () => {
        const { setSelection } = await import('/src/ui/selection.js');
        const w = window.__game.world;
        setSelection(w, [w.units.find((u) => u.player === 0 && u.type === 'villager')]);
      })],
      ['a mixed army selected', async () => page.evaluate(async () => {
        const { spawnUnit } = await import('/src/core/world.js');
        const { setSelection } = await import('/src/ui/selection.js');
        const w = window.__game.world;
        const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
        const made = [];
        for (const t of ['militia', 'archer', 'spearman', 'scout']) {
          made.push(spawnUnit(w, t, 0, tc.x + 3, tc.y + 3));
        }
        setSelection(w, made);
      })],
      ['the Town Center selected', async () => page.evaluate(async () => {
        const { setSelection } = await import('/src/ui/selection.js');
        const economy = await import('/src/systems/economy.js');
        const w = window.__game.world;
        const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
        for (let i = 0; i < 5; i++) economy.queueTrain(w, tc, 'villager');
        setSelection(w, [tc]);
      })],
      ['the build menu open', async () => {
        await page.evaluate(async () => {
          const { setSelection } = await import('/src/ui/selection.js');
          const w = window.__game.world;
          setSelection(w, [w.units.find((u) => u.player === 0 && u.type === 'villager')]);
          window.__game.hud.update(0.016);
        });
        await page.locator('#cmd-panel .cbtn', { hasText: 'Build' }).first().click();
        // Past the 140ms sheetin. The menu's Close row is sticky now — it is
        // the first row in the document since the shelves were reversed to put
        // the Dark Age under the thumb — and a rect read while the sheet is
        // still sliding in measures the slide, not the layout.
        await page.waitForTimeout(200);
      }],
      ['the allocation sheet open', async () => {
        await page.evaluate(() => window.__game.hud.toggleAlloc(true));
      }],
      ['the menu sheet open', async () => {
        await page.evaluate(() => { window.__game.hud.toggleAlloc(false); window.__game.hud.toggleMenu(true); });
      }],
      ['placing a building with a queue up', async () => {
        await page.evaluate(async () => {
          const economy = await import('/src/systems/economy.js');
          const w = window.__game.world;
          window.__game.hud.toggleMenu(false);
          const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
          let put = 0;
          for (let r = 4; r <= 18 && put < 6; r++) {
            for (const [dx, dy] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
              const gx = Math.floor(tc.x) + dx + 1;
              const gy = Math.floor(tc.y) + dy + 1;
              if (!economy.canPlaceReachable(w, 0, 'house', gx, gy)) continue;
              const b = economy.placeFoundation(w, 0, 'house', gx, gy);
              if (b) { economy.enqueueFoundation(w, b); put++; }
              if (put >= 6) break;
            }
          }
          window.__game.hud.setPlacementMode('house');
          window.__game.hud.onFoundationPlaced(put);
        });
      }],
      ['the market trade sheet open', async () => {
        await page.evaluate(async () => {
          const { spawnBuilding } = await import('/src/core/world.js');
          const { setSelection } = await import('/src/ui/selection.js');
          const w = window.__game.world;
          const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
          // Somewhere clear of the town, so the 3x3 lands.
          let stall = null;
          for (let r = 5; r <= 14 && !stall; r++) {
            for (const [dx, dy] of [[r, 0], [0, r], [-r, 0], [0, -r]]) {
              const gx = Math.round(tc.x) + dx;
              const gy = Math.round(tc.y) + dy;
              const { canPlace } = await import('/src/core/world.js');
              if (!canPlace(w, gx, gy, 3, 3)) continue;
              stall = spawnBuilding(w, 'market', 0, gx, gy);
              break;
            }
          }
          if (stall) setSelection(w, [stall]);
        });
        await paint(page);
        await page.locator('#cmd-panel .cbtn', { hasText: 'Trade' }).first().click();
      }],
      // Added by the review pass. Four states the sweep had never seen, three
      // of which contain controls that did not exist before it: the rules
      // sheet cloned out of the boot card, the armed Resign row at the foot of
      // the menu, and the end card's two buttons plus the Results pill that
      // brings it back after "Look at the map".
      ['the how-to-play sheet open', async () => {
        await page.evaluate(() => { window.__game.hud.toggleMenu(true); });
        await paint(page);
        await page.locator('#menu-sheet .menu-help').click();
        await paint(page);
      }],
      ['Resign armed in the menu sheet', async () => {
        await page.evaluate(() => {
          const h2 = window.__game.hud;
          h2.toggleMenu(false);
          h2.toggleMenu(true);
        });
        await paint(page);
        const row = page.locator('#menu-sheet .menu-resign');
        await row.scrollIntoViewIfNeeded();
        await row.click();
        await paint(page);
      }],
      ['an under-attack alert up', async () => {
        await page.evaluate(() => window.__game.hud.toggleMenu(false));
        await page.evaluate(() => {
          const g = window.__game;
          const tc = g.world.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
          g.hud.underAttackAlert(tc, tc.x, tc.y);
        });
        // The alert slides in from 14px to the left of where it lands, and a
        // rect read mid-animation is a measurement of the animation, not of the
        // layout. 250ms is comfortably past the 170ms entrance.
        await page.waitForTimeout(250);
      }],
      // The age-up card. It is the widest thing the toast stack ever holds —
      // the stack is a 182px corner box for everything else — so it is exactly
      // the shape that overflows a 390px screen without anyone noticing.
      ['the age-up card up', async () => {
        await page.evaluate(async () => {
          const { AGE } = await import('/src/systems/tech.js');
          window.__game.hud._ageCard(AGE.FEUDAL);
        });
        await page.waitForTimeout(250);
      }],
      ['the end card', async () => {
        await page.evaluate(() => {
          window.__game.scene.onGameOver(0);
        });
        await paint(page);
      }],
      ['the end card folded away to look at the map', async () => {
        await page.locator('#btn-look').click();
        await paint(page);
      }],
    ];

    for (const [label, setup] of states) {
      await setup();
      await audit(page, label);
      if (label === 'the allocation sheet open' || label === 'placing a building with a queue up' ||
          label === 'the market trade sheet open' || label === 'the menu sheet open') {
        await page.screenshot({
          path: path.join(SHOT_DIR, `touch-layout-${label.split(' ')[1]}.png`),
        });
      }
    }

    // --- Reachability, measured. --------------------------------------------
    // A right thumb pivots roughly at (330, 800) on a 390x844 phone and sweeps a
    // comfortable arc of about 400px. The two navigation controls have to be
    // inside it; before this pass the minimap was 690px away and the menu 774.
    const reach = await page.evaluate(() => {
      const PIVOT = { x: 330, y: 800 };
      const at = (sel) => {
        const n = document.querySelector(sel);
        if (!n) return null;
        const b = n.getBoundingClientRect();
        return Math.round(Math.hypot((b.left + b.right) / 2 - PIVOT.x, (b.top + b.bottom) / 2 - PIVOT.y));
      };
      return {
        minimap: at('#minimap'),
        menu: at('#btn-menu'),
        idle: at('#btn-idle'),
        jobs: at('#btn-jobs'),
        chip: at('#mode-chip'),
      };
    });
    check('the minimap is inside a one-handed reach', reach.minimap <= 400,
      `${reach.minimap}px from the thumb pivot, was 690`);
    check('and so is the menu', reach.menu <= 400, `${reach.menu}px, was 774`);
    check('every dock control is inside it',
      reach.idle <= 400 && reach.jobs <= 400 && reach.chip <= 400,
      `idle ${reach.idle}px, jobs ${reach.jobs}px, drag mode ${reach.chip}px`);

    check('no console errors (layout run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 6: the sound controls, and silence under test ------------------------
//
// Two claims, and the second one is the one that matters here. The engine is
// wired — cues actually reach it from the simulation, and the menu sheet's mute
// and volumes drive it — and the harness never gestures, so the AudioContext
// stays locked, the game runs silently, and nothing is logged. The README calls
// that the correct behaviour rather than a failure; this is where it is checked.

async function soundRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    const wired = await page.evaluate(() => {
      const a = window.__game.audio;
      return {
        present: !!a,
        names: a ? a.names.length : 0,
        hasAge: !!(a && a.has('ageAdvance')),
        hasHammer: !!(a && a.has('hammer')),
        played: a ? a.stats().played : -1,
      };
    });
    check('the scene owns an audio engine', wired.present && wired.names >= 24,
      `${wired.names} cues`);
    check('and the cues the wiring needs are in it', wired.hasAge && wired.hasHammer);

    // Run a minute of simulation. Hundreds of events go through the adapter —
    // gather ticks, deposits, hammer blows, training — and what happens to them
    // depends on one thing outside this repository: whether the browser's
    // autoplay policy left the AudioContext suspended.
    //
    // This check used to assert flatly that nothing played, and it was passing
    // for the wrong reason. Headless Chromium here starts its context in
    // `running`, so the premise was never true; what actually kept the counter
    // at zero was that the player's three villagers stood idle for the whole
    // minute and every cue the enemy raised was out of earshot. The moment the
    // starting villagers were put to work (core/mapgen.js) the same silent run
    // played thirteen cues and the check failed — on a change that fixed a bug.
    //
    // So the premise is measured rather than assumed, and the claim is the one
    // that is actually worth defending in each case: a suspended context must
    // schedule nothing at all (queued voices would fire in a heap on unlock),
    // and a running one must carry the game's own events through to the mixer
    // without raising a single console error.
    const policy = await page.evaluate(() => {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return 'none';
      const probe = new C();
      const state = probe.state;
      probe.close();
      return state;
    });
    await step(page, 1200);
    const heard = await page.evaluate(() => {
      const s = window.__game.audio.stats();
      return { played: s.played, voices: s.voices, coalesced: s.coalesced };
    });
    if (policy === 'suspended' || policy === 'none') {
      check('with the context still locked, a minute of play schedules nothing',
        heard.played === 0 && heard.voices === 0,
        `${heard.played} played, ${heard.voices} voices (context ${policy})`);
    } else {
      check('a minute of play reaches the mixer through the adapter',
        heard.played > 0,
        `${heard.played} played, ${heard.coalesced} coalesced (context ${policy})`);
    }

    // Now gesture, the way a player does, and prove the wiring is real: a
    // selection is the cheapest cue to raise from outside the audio module.
    await page.locator('#btn-menu').click();
    const after = await page.evaluate(() => {
      const g = window.__game;
      const unlocked = g.audio.unlock();
      const before = g.audio.stats().played;
      g.world.events.emit('selection', { ids: [1] });
      return { unlocked, before, after: g.audio.stats().played };
    });
    check('once unlocked, a game event really does reach the engine',
      !after.unlocked || after.after > after.before,
      after.unlocked ? `${after.before} -> ${after.after} voices played`
        : 'no AudioContext in this browser — the silent stub is doing its job');

    // --- The controls -------------------------------------------------------
    await page.evaluate(() => window.__game.hud.toggleMenu(true));
    await paint(page);
    const controls = await page.evaluate(() => {
      const m = document.querySelector('.sound-mute');
      const rows = [...document.querySelectorAll('.sound-row')];
      const box = (n) => {
        const r = n.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      };
      return {
        mute: m ? { ...box(m), text: m.textContent.replace(/\s+/g, ' ').trim() } : null,
        rows: rows.map((r) => ({
          label: r.querySelector('.who').textContent,
          ...box(r.querySelector('input')),
        })),
      };
    });
    check('the menu sheet carries a mute toggle', !!controls.mute,
      controls.mute && controls.mute.text);
    check('and separate effects and music volumes',
      controls.rows.length === 2 &&
      controls.rows[0].label === 'Effects' && controls.rows[1].label === 'Music',
      controls.rows.map((r) => r.label).join(', '));
    check('every sound control is a full touch target',
      controls.mute.h >= 44 && controls.rows.every((r) => r.h >= 44),
      `mute ${controls.mute.w}x${controls.mute.h}, ` +
      controls.rows.map((r) => `${r.label} ${r.w}x${r.h}`).join(', '));

    await page.locator('.sound-mute').click();
    const muted = await page.evaluate(() => ({
      muted: window.__game.audio.isMuted(),
      label: document.querySelector('.sound-mute .state').textContent,
      stored: localStorage.getItem('aos.audio.v1'),
    }));
    check('tapping it mutes the game', muted.muted === true, muted.label);
    check('and the preference is written down, not just held in memory',
      !!muted.stored && /"muted":true/.test(muted.stored), muted.stored);

    await page.locator('.sound-mute').click();
    const unmuted = await page.evaluate(() => window.__game.audio.isMuted());
    check('and tapping it again brings it back', unmuted === false);

    // The music slider drives the engine, and it too is remembered.
    await page.evaluate(() => {
      const s = [...document.querySelectorAll('.sound-row input')][1];
      s.value = '40';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const vol = await page.evaluate(() => ({
      music: window.__game.audio.getMusicVolume(),
      stored: localStorage.getItem('aos.audio.v1'),
    }));
    check('the music slider sets the music bus', Math.abs(vol.music - 0.4) < 0.001,
      String(vol.music));
    check('and that is persisted too', /"music":0\.4/.test(vol.stored || ''), vol.stored);

    check('no console errors (sound run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 7: the boot card, with and without a saved match ---------------------
//
// The card grew a second full-width button when saving landed, and it is the one
// screen every player sees before anything else. Two things are checked: the
// buttons are real touch targets that fit on a 390px phone, and the resume path
// actually comes back to the match it claims to — the label says "12m 30s in"
// and the world behind it had better agree.

async function bootCardRun() {
  const h = await boot({ query: 'autostart' });
  const { page, errors } = h;
  try {
    // Play a while, then take the save the way the page itself would.
    await step(page, 1400);
    const saved = await page.evaluate(() => {
      const g = window.__game;
      const r = g.save();
      return { ok: r && r.ok, bytes: r && r.bytes, time: g.world.time, tick: g.world.tick };
    });
    check('a match writes itself to local storage', saved.ok,
      `${(saved.bytes / 1024).toFixed(0)}kB at ${saved.time.toFixed(0)}s`);

    // Reload onto the boot card. The save has to survive the page going away.
    await page.goto(page.url().replace(/\?.*$/, ''), { waitUntil: 'load' });
    await page.waitForSelector('#btn-resume:not([hidden])', { timeout: 10000 });

    const card = await page.evaluate(() => {
      const b = (sel) => {
        const n = document.querySelector(sel);
        if (!n || n.hidden) return null;
        const r = n.getBoundingClientRect();
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          on: r.left >= -0.5 && r.right <= innerWidth + 0.5 &&
            r.top >= -0.5 && r.bottom <= innerHeight + 0.5,
          text: n.textContent.replace(/\s+/g, ' ').trim(),
        };
      };
      return { resume: b('#btn-resume'), start: b('#btn-start'), vw: innerWidth };
    });
    check('the boot card offers Resume match', !!card.resume,
      card.resume ? card.resume.text : 'no resume button');
    check('and says how far in the match was',
      /\d+m \d\ds in/.test(card.resume ? card.resume.text : ''), card.resume && card.resume.text);
    check('the new-game button says it discards the save',
      /discards/.test(card.start ? card.start.text : ''), card.start && card.start.text);
    check('both buttons are full touch targets on screen',
      card.resume.w >= 44 && card.resume.h >= 44 && card.resume.on &&
      card.start.w >= 44 && card.start.h >= 44 && card.start.on,
      `resume ${card.resume.w}x${card.resume.h}, new ${card.start.w}x${card.start.h}, vw ${card.vw}`);

    const boot1 = await audit(page, 'the boot card with a saved match');
    check('the boot card sweep actually saw the buttons', boot1.n >= 3, `${boot1.n} controls`);
    await page.screenshot({ path: path.join(SHOT_DIR, 'boot-resume.png') });

    // Take it. The world that comes back has to be the one that was saved.
    await page.locator('#btn-resume').click();
    await page.waitForFunction(() => window.__game && window.__game.world, null, { timeout: 20000 });
    const back = await page.evaluate(() => {
      const w = window.__game.world;
      return { time: w.time, tick: w.tick, entities: w.entities.size, seed: w.seed };
    });
    // The resumed scene is already running frames by the time this reads it, so
    // the honest claim is that it picked up *from* the save and not from zero —
    // never earlier, and never more than a few ticks later. The tick-for-tick
    // equality is asserted properly, with the clock held still, in
    // tests/save.test.mjs.
    check('resuming comes back to the same match',
      back.tick >= saved.tick && back.tick - saved.tick < 40 && back.seed > 0,
      `saved ${saved.time.toFixed(2)}s/${saved.tick}, resumed ${back.time.toFixed(2)}s/${back.tick}`);
    check('...with its world intact', back.entities > 100, `${back.entities} entities`);
    await page.screenshot({ path: path.join(SHOT_DIR, 'boot-resumed.png') });

    // And a new skirmish throws it away, so the next boot has nothing to offer.
    await page.goto(page.url().replace(/\?.*$/, ''), { waitUntil: 'load' });
    await page.waitForSelector('#btn-start:not([hidden])', { timeout: 10000 });
    await page.locator('#btn-start').click();
    await page.waitForFunction(() => window.__game && window.__game.world, null, { timeout: 20000 });
    const gone = await page.evaluate(() => localStorage.getItem('aos.save.v1'));
    check('starting a new skirmish discards the saved match', gone === null,
      gone === null ? 'cleared' : 'the old save is still there');

    check('no console errors (boot card run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

const run = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const runs = [
    ['the villager allocation manager', allocationRun],
    ['the idle villager button', idleButtonRun],
    ['batch placement and the build queue', batchPlacementRun],
    ['the training queue', trainQueueRun],
    ['HUD layout at phone size, worst case', layoutRun],
    ['the sound controls, and silence under test', soundRun],
    ['the boot card and resuming a match', bootCardRun],
  ];
  for (const [name, fn] of runs) {
    if (ONLY && !name.includes(ONLY)) continue;
    console.log(`\n--- ${name} ---`);
    await fn();
  }
};

run().then(() => {
  console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all checks passed'}`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
