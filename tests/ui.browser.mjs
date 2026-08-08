// In-browser verification of the HUD and touch findings from the playtests:
// rally-to-resource (including onto the bush a villager is already working),
// what the panel says about a resource you tap, how much map the alert stack
// covers and what it is allowed to swallow, issuing an attack-move, and
// demolishing one of your own buildings — including demolishing your way out of
// a ring of houses you have sealed your own villager into.
//
//   node tests/ui.browser.mjs [--shots screenshots/] [--only <substring>]
//
// Nothing here pokes the input layer's internals: every order is given the way
// a thumb gives it — a real touch on the canvas, a real click on a HUD button —
// and every claim is then checked against the simulation. Storing a rally proves
// nothing, so the first run goes all the way through the loop: tap the bush,
// train a villager out of the Town Center, and watch the food land in the bank.
//
// Each run gets a fresh boot, deliberately. The rally run has to fast-forward
// three minutes, by which time the AI's first wave is on the move — and an army
// that is busy being ambushed cannot prove anything about attack-move. Clean
// rooms beat one noisy one.

import fs from 'node:fs';
import path from 'node:path';
import { boot, step } from './harness.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SHOT_DIR = arg('shots', 'screenshots');

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}

/** Centre the camera on a grid point and return its CSS coordinates. */
async function aim(page, gx, gy) {
  return page.evaluate(([x, y]) => {
    const g = window.__game;
    g.input.centerOnGrid(x, y);
    const p = g.input._toScreen(x, y);
    // _toScreen works in Phaser game px; the touch has to land in CSS px.
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
 * Toasts live for 2.4s and a CDP touch costs ~350ms, so they are read from a
 * recording rather than from the DOM — otherwise the assertion races the
 * animation and fails for reasons that have nothing to do with the game.
 */
const watchToasts = (page) => page.evaluate(() => {
  window.__toasts = [];
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.classList && n.classList.contains('toast')) window.__toasts.push(n.textContent);
      }
    }
  }).observe(document.getElementById('toasts'), { childList: true });
});

/**
 * A tap that cannot be read as a double-tap of the previous one.
 *
 * These runs centre the camera on whatever they are aiming at, so consecutive
 * taps land within a few pixels of the middle of the screen — which is a real
 * double-tap as far as the input layer is concerned, even though the two things
 * being tapped are nowhere near each other in the world. A player's two taps
 * are separated in space; a test's are separated in time.
 */
async function tapSlow(page, x, y) {
  await page.waitForTimeout(DOUBLE_TAP_MS + 60);
  await page.touchscreen.tap(x, y);
}
const DOUBLE_TAP_MS = 400; // must match ui/input.js

/** Let killed toasts finish their 280ms exit before counting the DOM. */
const TOAST_EXIT_MS = 340;

const toastMark = (page) => page.evaluate(() => window.__toasts.length);
const toastsSince = async (page, mark) =>
  (await page.evaluate(() => window.__toasts)).slice(mark).join(' | ');

// --- Run 1: tap a bush with the Town Center selected -------------------------

async function rallyRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    await watchToasts(page);

    // A bush with nothing of ours standing near it, so the tap can only mean
    // the bush (the picker prefers your own units when they are equally close).
    const spot = await page.evaluate(() => {
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      let best = null;
      let bestD = Infinity;
      for (const n of w.resources) {
        if (n.type !== 'berry' || n.amount <= 0) continue;
        if (w.units.some((u) => Math.hypot(u.x - n.x, u.y - n.y) < 3)) continue;
        const d = Math.hypot(n.x - tc.x, n.y - tc.y);
        if (d < bestD) { bestD = d; best = n; }
      }
      return {
        tc: { id: tc.id, x: tc.x, y: tc.y },
        berry: best && { id: best.id, x: best.x, y: best.y, amount: best.amount },
        dist: bestD,
      };
    });
    check('the map has a berry bush to rally onto', !!spot.berry,
      spot.berry ? `${spot.dist.toFixed(1)} tiles from the Town Center` : 'none found');
    if (!spot.berry) return;

    // Select the Town Center with a touch.
    let p = await aim(page, spot.tc.x, spot.tc.y);
    await page.touchscreen.tap(p.x, p.y);
    check('tapping the Town Center selects it',
      await page.evaluate((id) => window.__game.world.selection.has(id), spot.tc.id));

    // Tap the bush. This must set the rally, NOT select the bush.
    const mark = await toastMark(page);
    p = await aim(page, spot.berry.x, spot.berry.y);
    await page.touchscreen.tap(p.x, p.y);

    const after = await page.evaluate(([tcId, berryId]) => {
      const w = window.__game.world;
      const tc = w.entities.get(tcId);
      const b = w.entities.get(berryId);
      const note = document.querySelector('.rally-note');
      return {
        rally: tc.rally,
        d: tc.rally ? Math.hypot(tc.rally.x - b.x, tc.rally.y - b.y) : Infinity,
        stillTc: w.selection.has(tcId),
        grabbedBush: w.selection.has(berryId),
        note: note && note.textContent,
      };
    }, [spot.tc.id, spot.berry.id]);

    check('the tap sets the rally on the bush', after.d < 0.01,
      after.rally ? `rally ${after.rally.x},${after.rally.y} vs bush ${spot.berry.x},${spot.berry.y}` : 'no rally');
    check('and does not select the bush instead', after.stillTc && !after.grabbedBush,
      `tc selected: ${after.stillTc}, bush selected: ${after.grabbedBush}`);
    check('a toast names what the rally will do',
      /gather food/i.test(await toastsSince(page, mark)), await toastsSince(page, mark));
    check('and the command panel says so too', /gather food/i.test(after.note || ''), after.note);

    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-rally-on-berries.png') });

    // Train a villager from the panel and watch it work the bush.
    const foodBefore = await page.evaluate(() => window.__game.world.players[0].resources.food);
    await page.locator('#cmd-panel .cbtn', { hasText: 'Villager' }).first().click();
    const queued = await page.evaluate(
      (id) => (window.__game.world.entities.get(id).queue || []).length, spot.tc.id);
    check('the Town Center takes the training order', queued > 0, `${queued} in queue`);

    // 8s of build time at 20Hz, plus slack for the walk out.
    await step(page, 200);
    const rallied = await page.evaluate(() => {
      const w = window.__game.world;
      const v = w.units.filter((u) => u.player === 0 && u.type === 'villager');
      const fresh = v[v.length - 1];
      return { n: v.length, task: fresh.task && fresh.task.type, state: fresh.state };
    });
    check('the trained villager gets a gather order, not a walk', rallied.task === 'gather',
      `${rallied.n} villagers, newest task=${rallied.task} state=${rallied.state}`);

    // Three minutes of it working, then check the food actually banked.
    await step(page, 3600);
    const banked = await page.evaluate(([berryId, before]) => {
      const w = window.__game.world;
      const b = w.entities.get(berryId);
      return {
        food: w.players[0].resources.food,
        gained: w.players[0].resources.food - before,
        left: b && !b.dead ? b.amount : 0,
      };
    }, [spot.berry.id, foodBefore]);
    // The villager cost 50 food up front, so any net gain is genuinely harvested.
    check('food is banked from the rallied villager', banked.gained > 0,
      `${foodBefore.toFixed(0)} -> ${banked.food.toFixed(0)} food, villager cost 50`);
    check('the bush was actually eaten into', banked.left < spot.berry.amount,
      `${spot.berry.amount} -> ${banked.left.toFixed(0)} left`);

    await page.evaluate(() => {
      const w = window.__game.world;
      const v = w.units.filter((u) => u.player === 0 && u.type === 'villager');
      window.__game.input.centerOnGrid(v[v.length - 1].x, v[v.length - 1].y);
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-rally-gathering.png') });

    check('no console errors (rally run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 2: the bush you are ALREADY working --------------------------------
//
// The commonest rally there is: you have villagers on the berries and you want
// the next ones out of the Town Center to join them. That bush has one of your
// own villagers standing on it, and the picker used to hand the tap to the
// villager — the rally silently stayed null and nothing said why.
//
// The tap here is aimed 35% of the way from the bush toward its villager: a
// thumb that is a few pixels off, still unambiguously on the bush. That is the
// exact offset that used to lose the tap (measured: the old ranking returned
// the villager from 35% onward).

async function rallyOverVillagerRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    await watchToasts(page);

    // Put a villager on the nearest bush, the way the player would.
    const s = await page.evaluate(async () => {
      const { commandUnits } = await import('/src/systems/unitAI.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      let bush = null;
      let bd = Infinity;
      for (const n of w.resources) {
        if (n.type !== 'berry' || n.amount <= 0) continue;
        const d = Math.hypot(n.x - tc.x, n.y - tc.y);
        if (d < bd) { bd = d; bush = n; }
      }
      if (!bush) return { fail: 'no berries on this map' };
      const v = w.units.find((u) => u.player === 0 && u.type === 'villager');
      commandUnits(w, [v], { type: 'gather', gx: bush.x, gy: bush.y, target: bush });
      return { tc: tc.id, bush: { id: bush.id, x: bush.x, y: bush.y }, vill: v.id };
    });
    check('the map has a berry bush and a villager to put on it', !s.fail, s.fail || '');
    if (s.fail) return;

    // Wait for it to actually be at the bush, then freeze the simulation. The
    // taps below cost ~350ms of real time each and the game keeps running
    // between them: a villager that wanders off to drop its food mid-sequence
    // would move the very thing under test. (A gatherer is only at the bush for
    // part of its cycle, so this waits for the right part rather than assuming.)
    let posted = null;
    for (let i = 0; i < 60 && !posted; i++) {
      await step(page, 10);
      posted = await page.evaluate((st) => {
        const w = window.__game.world;
        const v = w.entities.get(st.vill);
        const b = w.entities.get(st.bush.id);
        const d = Math.hypot(v.x - b.x, v.y - b.y);
        if (!v.task || v.task.type !== 'gather' || d > 1.6) return null;
        window.__game.scene.simStep = () => {}; // hold everything still
        return { d, state: v.state };
      }, s);
    }
    check('the villager is standing on the bush, working it', !!posted,
      posted ? `state=${posted.state}, ${posted.d.toFixed(2)} tiles from the bush`
        : 'it never settled on the bush');
    if (!posted) return;

    // Select the Town Center with a real touch.
    const tcAt = await page.evaluate((st) => {
      const tc = window.__game.world.entities.get(st.tc);
      return { x: tc.x, y: tc.y };
    }, s);
    const p = await aim(page, tcAt.x, tcAt.y);
    await tapSlow(page, p.x, p.y);
    check('the Town Center is selected',
      await page.evaluate((id) => window.__game.world.selection.has(id), s.tc));

    // Aim at the bush, a little off toward the villager on it.
    const target = await page.evaluate((st) => {
      const g = window.__game;
      const w = g.world;
      const b = w.entities.get(st.bush.id);
      const v = w.entities.get(st.vill);
      g.input.centerOnGrid(b.x, b.y);
      const pb = g.input._toScreen(b.x, b.y);
      const pv = g.input._toScreen(v.x, v.y);
      const t = 0.35;
      const gx = pb.x + (pv.x - pb.x) * t;
      const gy = pb.y + (pv.y - pb.y) * t;
      const canvas = g.scene.game.canvas;
      const r = canvas.getBoundingClientRect();
      const size = g.scene.game.scale.gameSize;
      const hit = g.input._pick(gx, gy);      // what the ordinary ranking says
      const rhit = g.input._pickRally(gx, gy); // what the rally ranking says
      return {
        x: r.left + (gx * r.width) / size.width,
        y: r.top + (gy * r.height) / size.height,
        plainPick: hit ? `${hit.kind}:${hit.type}` : 'null',
        rallyPick: rhit ? `${rhit.kind}:${rhit.type}` : 'null',
      };
    }, s);
    check('the offset tap is one the old ranking gave to the villager',
      target.plainPick === 'unit:villager',
      `plain pick ${target.plainPick}, rally pick ${target.rallyPick}`);

    const mark = await toastMark(page);
    await tapSlow(page, target.x, target.y);

    const after = await page.evaluate((st) => {
      const w = window.__game.world;
      const tc = w.entities.get(st.tc);
      const b = w.entities.get(st.bush.id);
      return {
        rally: tc.rally,
        d: tc.rally ? Math.hypot(tc.rally.x - b.x, tc.rally.y - b.y) : Infinity,
        stillTc: w.selection.has(st.tc),
        grabbedVillager: w.selection.has(st.vill),
        note: (document.querySelector('.rally-note') || {}).textContent,
      };
    }, s);
    check('tapping a bush with your own villager on it sets the rally', after.d < 0.01,
      after.rally ? `rally ${after.rally.x},${after.rally.y} vs bush ${s.bush.x},${s.bush.y}` : 'no rally');
    check('and the villager is NOT selected instead',
      !after.grabbedVillager && after.stillTc,
      `villager selected: ${after.grabbedVillager}, tc still selected: ${after.stillTc}`);
    check('a toast still names the outcome',
      /gather food/i.test(await toastsSince(page, mark)), await toastsSince(page, mark));
    check('and so does the panel', /gather food/i.test(after.note || ''), after.note);

    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-rally-over-villager.png') });

    // --- The ordinary cases must be untouched. -------------------------------

    // 1. Tapping the villager itself still selects it (the rally ranking is a
    //    tolerance, not an override: aim at the unit and you get the unit).
    const vp = await page.evaluate((st) => {
      const g = window.__game;
      const v = g.world.entities.get(st.vill);
      const q = g.input._toScreen(v.x, v.y);
      const r = g.scene.game.canvas.getBoundingClientRect();
      const size = g.scene.game.scale.gameSize;
      return { x: r.left + (q.x * r.width) / size.width, y: r.top + (q.y * r.height) / size.height };
    }, s);
    await tapSlow(page, vp.x, vp.y);
    check('tapping the villager itself still selects it',
      await page.evaluate((st) => window.__game.world.selection.has(st.vill) &&
        !window.__game.world.selection.has(st.tc), s));

    // 2. With that villager in hand, tapping the bush is still a gather order.
    await tapSlow(page, target.x, target.y);
    const gathering = await page.evaluate((st) => {
      const w = window.__game.world;
      const v = w.entities.get(st.vill);
      const node = v.task && (v.task.node || v.task.target);
      return {
        task: v.task && v.task.type,
        onBush: !!node && node.id === st.bush.id,
        selectedBush: w.selection.has(st.bush.id),
      };
    }, s);
    check('with units in hand the same tap is still a gather order',
      gathering.task === 'gather' && gathering.onBush && !gathering.selectedBush,
      `task=${gathering.task}, on the tapped bush=${gathering.onBush}`);

    // --- The panel a tapped resource shows. ----------------------------------
    // A bush with nobody standing on it, tapped with nothing in hand: the plain
    // ranking is in force here (the rally ranking only applies with a producer
    // selected), so this is a pure "what does the panel say about a bush".
    const lone = await page.evaluate(async () => {
      const { clearSelection } = await import('/src/ui/selection.js');
      const w = window.__game.world;
      clearSelection(w);
      let best = null;
      let bd = Infinity;
      for (const n of w.resources) {
        if (n.type !== 'berry' || n.amount <= 0) continue;
        if (w.units.some((u) => !u.dead && Math.hypot(u.x - n.x, u.y - n.y) < 3)) continue;
        const d = Math.hypot(n.x - w.units[0].x, n.y - w.units[0].y);
        if (d < bd) { bd = d; best = n; }
      }
      return best ? { id: best.id, x: best.x, y: best.y } : null;
    });
    check('there is a bush standing on its own to inspect', !!lone);
    if (!lone) return;
    const lp = await aim(page, lone.x, lone.y);
    await tapSlow(page, lp.x, lp.y);

    const panel = await page.evaluate((id) => {
      const w = window.__game.world;
      const b = w.entities.get(id);
      const sel = document.getElementById('sel-panel');
      return {
        selected: w.selection.has(id),
        title: (sel.querySelector('.sel-title') || {}).textContent,
        rows: [...sel.querySelectorAll('.hp-text')].map((n) => n.textContent),
        stockBars: sel.querySelectorAll('.hpbar.stock').length,
        hpBars: sel.querySelectorAll('.hpbar:not(.stock)').length,
        fill: (sel.querySelector('.hpbar.stock > i') || { style: {} }).style.width || null,
        cmd: document.getElementById('cmd-panel').textContent,
        amount: b.amount,
        max: b.maxAmount,
      };
    }, lone.id);
    check('tapping a resource with nothing in hand selects it', panel.selected);
    check('the resource panel shows no NaN anywhere',
      !/NaN/.test(panel.rows.join(' ') + panel.title + panel.cmd),
      `${panel.title} | ${panel.rows.join(' / ')} | ${panel.cmd}`);
    check('it shows how much of the resource is left, not hit points',
      panel.rows.length === 1 &&
      new RegExp(`^${Math.ceil(panel.amount)} / ${panel.max} food left$`).test(panel.rows[0]),
      panel.rows.join(' / '));
    check('with a stock bar and no health bar',
      panel.stockBars === 1 && panel.hpBars === 0,
      `${panel.stockBars} stock, ${panel.hpBars} hp`);
    check('and the bar is drawn at the true fraction',
      Math.abs(parseFloat(panel.fill) - (panel.amount / panel.max) * 100) < 0.2,
      `${panel.fill} for ${panel.amount}/${panel.max}`);
    check('the header names the bush rather than printing a type id',
      /berry bush/i.test(panel.title || ''), panel.title);

    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-resource-panel.png') });

    // A farm is a building with a stock: it must show both, and no NaN.
    const farm = await page.evaluate(async () => {
      const { spawnBuilding, canPlace } = await import('/src/core/world.js');
      const economy = await import('/src/systems/economy.js');
      const { setSelection } = await import('/src/ui/selection.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      let at = null;
      for (let r = 3; r <= 10 && !at; r++) {
        for (const [dx, dy] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r]]) {
          const gx = Math.floor(tc.x) + dx + 1;
          const gy = Math.floor(tc.y) + dy + 1;
          if (canPlace(w, gx, gy, 2, 2)) { at = { gx, gy }; break; }
        }
      }
      if (!at) return { fail: 'nowhere to put a farm' };
      const f = spawnBuilding(w, 'farm', 0, at.gx, at.gy);
      economy.initProvider(f);
      f.hp = Math.round(f.maxHp * 0.5); // wounded, so both rows carry real numbers
      f.amount = Math.round(f.maxAmount * 0.4);
      setSelection(w, [f]);
      window.__game.hud.update(0.016);
      const sel = document.getElementById('sel-panel');
      return {
        rows: [...sel.querySelectorAll('.hp-text')].map((n) => n.textContent),
        stock: sel.querySelectorAll('.hpbar.stock').length,
        hp: sel.querySelectorAll('.hpbar:not(.stock)').length,
      };
    });
    check('a farm shows health AND how much food is left in it',
      !farm.fail && farm.hp === 1 && farm.stock === 1 && farm.rows.length === 2 &&
      /hp$/.test(farm.rows[0]) && /food left$/.test(farm.rows[1]) &&
      !/NaN/.test(farm.rows.join(' ')),
      farm.rows.join(' / '));

    check('no console errors (rally-over-villager run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 3: how much map the alert covers ------------------------------------

async function toastCoverageRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    // Routine chatter first, then the raid. The alert must take the corner over
    // rather than pile on top of three toasts already sitting there. Counts are
    // taken after the 280ms exit animation, or retired nodes are still in the
    // DOM and every number is one stack behind.
    await page.evaluate(() => {
      const g = window.__game;
      g.hud.toast('Training Villager', 'info');
      g.hud.toast('Not enough wood', 'warn');
      g.hud.toast('Placing House', 'info');
      g.hud.toast('12 soldiers selected', 'info');
    });
    await page.waitForTimeout(TOAST_EXIT_MS);
    const before = await page.evaluate(
      () => document.querySelectorAll('#toasts .toast:not(.out)').length);

    await page.evaluate(() => {
      const g = window.__game;
      const tc = g.world.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      g.input.centerOnGrid(tc.x, tc.y);
      g.hud.underAttackAlert(tc, tc.x, tc.y);
    });
    await page.waitForTimeout(TOAST_EXIT_MS);

    const shape = await page.evaluate((beforeCount) => {
      const nodes = [...document.querySelectorAll('#toasts .toast:not(.out)')];
      const box = document.getElementById('toasts').getBoundingClientRect();
      const alert = document.querySelector('#toasts .toast.alert');
      const ab = alert.getBoundingClientRect();
      return {
        before: beforeCount,
        after: nodes.length,
        alerts: nodes.filter((n) => n.classList.contains('alert')).length,
        w: Math.round(box.width),
        h: Math.round(box.height),
        vw: window.innerWidth,
        vh: window.innerHeight,
        alertBox: { w: Math.round(ab.width), h: Math.round(ab.height) },
        text: alert.textContent,
      };
    }, before);

    check('routine toasts are capped at two', shape.before <= 2, `${shape.before} on screen`);
    check('the alert supersedes them rather than stacking under them',
      shape.after === 1 && shape.alerts === 1,
      `${shape.after} toasts, ${shape.alerts} alerts`);
    check('the stack covers a small corner of the map, not the base',
      shape.w / shape.vw <= 0.5 && shape.h <= 72,
      `${shape.w}x${shape.h} of ${shape.vw}x${shape.vh} — ` +
      `${Math.round((shape.w / shape.vw) * 100)}% wide, was 56% x 180px`);
    check('the alert is still a 44px touch target',
      shape.alertBox.h >= 44 && shape.alertBox.w >= 44,
      `${shape.alertBox.w}x${shape.alertBox.h}`);
    check('and still says what is happening', /under attack/i.test(shape.text), shape.text.trim());

    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-toast-alert-coverage.png') });

    // Tapping it still jumps the camera.
    const jumped = await page.evaluate(async () => {
      const g = window.__game;
      const w = g.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      g.input.centerOnGrid(1, 1);
      const from = { x: g.input.camera.midPoint.x, y: g.input.camera.midPoint.y };
      document.querySelector('#toasts .toast.alert').click();
      const to = { x: g.input.camera.midPoint.x, y: g.input.camera.midPoint.y };
      const p = g.input._toScreen(tc.x, tc.y);
      return { moved: Math.hypot(to.x - from.x, to.y - from.y), onScreen: p };
    });
    check('tapping the alert still jumps to the fight', jumped.moved > 50,
      `camera moved ${Math.round(jumped.moved)} world px`);

    // And the same thing for real: an enemy squad on the Town Center, the alert
    // raised by combat.js rather than by this test, with the routine toasts a
    // busy base is generating at the same time. This is the shot the finding
    // asked for — how much map is left readable while the alarm is up.
    const live = await page.evaluate(async () => {
      const { spawnUnit } = await import('/src/core/world.js');
      const { nearestWalkable } = await import('/src/systems/pathfinding.js');
      const { commandUnits } = await import('/src/systems/unitAI.js');
      const g = window.__game;
      const w = g.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      const raiders = [];
      for (let i = 0; i < 3; i++) {
        const s = nearestWalkable(w, Math.floor(tc.x) + 3 + i, Math.floor(tc.y) + 3, 6);
        raiders.push(spawnUnit(w, 'militia', 1, s.tx + 0.5, s.ty + 0.5));
      }
      commandUnits(w, raiders, { type: 'attack', gx: tc.x, gy: tc.y, target: tc });
      g.input.centerOnGrid(tc.x, tc.y);
      return { tc: { x: tc.x, y: tc.y }, alerts: g.hud.alertCount() };
    });

    let fired = null;
    for (let i = 0; i < 60 && !fired; i++) {
      await page.evaluate(() => window.__game.step(10));
      fired = await page.evaluate((was) => {
        const g = window.__game;
        if (g.hud.alertCount() <= was) return null;
        // Real chatter competing with the alarm, exactly as in the playtest —
        // one line of routine narration, and one refusal. The refusal is the
        // only record the player will ever get that the tap did nothing, so it
        // has to survive the alert; the narration does not.
        g.hud.toast('Training Villager', 'info');
        g.hud.toast('Cannot build there', 'warn');
        const nodes = [...document.querySelectorAll('#toasts .toast:not(.out)')];
        const stack = document.getElementById('toasts').getBoundingClientRect();
        const alert = nodes.find((n) => n.classList.contains('alert'));
        const ab = alert ? alert.getBoundingClientRect() : { width: 0, height: 0 };
        return {
          n: nodes.length,
          texts: nodes.map((t) => t.textContent),
          alertFirst: !!nodes[0] && nodes[0].classList.contains('alert'),
          w: Math.round(ab.width),
          h: Math.round(ab.height),
          stackH: Math.round(stack.height),
        };
      }, live.alerts);
    }
    check('a real raid raises the alert', !!fired && fired.alertFirst,
      fired ? fired.texts.join(' | ') : 'combat never raised an alert');
    check('a refused action still speaks up while the alert is live',
      !!fired && /cannot build there/i.test(fired.texts.join(' | ')),
      fired ? fired.texts.join(' | ') : '');
    check('and routine chatter is still swallowed by it',
      !!fired && !/training villager/i.test(fired.texts.join(' | ')),
      fired ? fired.texts.join(' | ') : '');
    check('the alert still leads, with at most one line under it',
      !!fired && fired.n <= 2 && fired.alertFirst && fired.stackH <= 96,
      fired ? `${fired.n} toast(s), alert ${fired.w}x${fired.h}, stack ${fired.stackH}px tall` : '');

    await page.evaluate((at) => window.__game.input.centerOnGrid(at.x, at.y), live.tc);
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-toast-alert-live.png') });

    check('no console errors (toast run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 4: what a double-tap actually grabs ---------------------------------
//
// The playtest read the boot card's "every unit of that type on screen" as a
// lie, having watched 24 of 24 villagers get selected — so this pins the real
// rule down rather than arguing about it: with villagers parked in a far
// corner, a double-tap takes the ones you can see and leaves the ones you
// cannot. That is AoE2's rule (the menu sheet's "Select all villagers" is the
// select-everything door), and the 24-of-24 reading is what you get when every
// villager you own happens to be in frame, which at the opening zoom is most of
// them. The boot card wording is the thing that has to match this test.
//
// The CDP touch pipeline cannot express a double-tap (~350ms per event, and the
// window is 400ms), so this dispatches real PointerEvents in the page.

async function doubleTapRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    const out = await page.evaluate(async () => {
      const { spawnUnit } = await import('/src/core/world.js');
      const g = window.__game;
      const w = g.world;
      // Two villagers in the far corner of the map, well outside any view.
      spawnUnit(w, 'villager', 0, 40.5, 40.5);
      spawnUnit(w, 'villager', 0, 42.5, 41.5);

      const v = w.units.find((u) => u.player === 0 && u.type === 'villager');
      g.input.centerOnGrid(v.x, v.y);

      const canvas = g.scene.game.canvas;
      const r = canvas.getBoundingClientRect();
      const size = g.scene.game.scale.gameSize;
      const p = g.input._toScreen(v.x, v.y);
      const cx = r.left + (p.x * r.width) / size.width;
      const cy = r.top + (p.y * r.height) / size.height;
      const opts = { pointerId: 1, pointerType: 'touch', clientX: cx, clientY: cy, bubbles: true, cancelable: true };
      const tap = () => {
        canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
        window.dispatchEvent(new PointerEvent('pointerup', opts));
      };
      tap();
      tap(); // inside DOUBLE_TAP_MS by construction

      const all = w.units.filter((u) => u.player === 0 && u.type === 'villager');
      const visible = all.filter((u) => {
        const q = g.input._toScreen(u.x, u.y);
        return q.x >= -24 && q.y >= -24 &&
               q.x <= g.input.camera.width + 24 && q.y <= g.input.camera.height + 24;
      });
      return {
        total: all.length,
        visible: visible.length,
        selected: w.selection.size,
        allVisibleSelected: visible.every((u) => w.selection.has(u.id)),
        anyOffScreen: all.some((u) => !visible.includes(u) && w.selection.has(u.id)),
      };
    });

    check('the corner villagers really are off screen', out.visible < out.total,
      `${out.visible} of ${out.total} villagers visible`);
    check('a double-tap grabs every villager on screen',
      out.allVisibleSelected && out.selected === out.visible,
      `${out.selected} selected, ${out.visible} on screen`);
    check('and none of the ones off screen',
      !out.anyOffScreen, `${out.total - out.visible} parked in the corner, none selected`);

    check('no console errors (double-tap run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 5: arm an attack-move and spend it ----------------------------------

async function attackMoveRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    await watchToasts(page);

    // An army, a goal across the map, and one enemy soldier standing on the
    // route they will actually walk. The picket is placed by pathing toward the
    // enemy base and sampling the real route, not by trusting a straight line —
    // this map is full of forest, and a detour round one would let the army
    // stroll past the picket and prove nothing.
    //
    // The enemy AI is stubbed out for this run: it commands every soldier the
    // enemy owns, so an un-stubbed picket marches off to raid instead of
    // standing in the road. This test is about the player's order, not the AI's.
    const fight = await page.evaluate(async () => {
      const { spawnUnit } = await import('/src/core/world.js');
      const { findPath, nearestWalkable } = await import('/src/systems/pathfinding.js');
      const w = window.__game.world;
      window.__game.scene.enemyAI.update = () => {};

      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      const etc = w.buildings.find((b) => b.player === 1 && b.type === 'towncenter');
      const muster = nearestWalkable(w, Math.floor(tc.x) + 3, Math.floor(tc.y) + 3, 8);
      const start = { x: muster.tx + 0.5, y: muster.ty + 0.5 };

      const troops = [];
      for (let i = 0; i < 3; i++) {
        const s = nearestWalkable(w, muster.tx + i - 1, muster.ty, 6);
        troops.push(spawnUnit(w, 'militia', 0, s.tx + 0.5, s.ty + 0.5).id);
      }

      // Sample a real, walkable route: toward the enemy base first, and failing
      // that any direction that yields a long enough march. Trusting a straight
      // line here would put the picket in a lake on half the maps.
      const along = (route, want) => {
        let prev = start;
        for (const q of route) {
          const d = Math.hypot(q.x - prev.x, q.y - prev.y);
          if (want <= d) {
            const t = d ? want / d : 0;
            return { x: prev.x + (q.x - prev.x) * t, y: prev.y + (q.y - prev.y) * t };
          }
          want -= d;
          prev = q;
        }
        return null; // route is shorter than `want`
      };
      const snap = (pt) => {
        const s = pt && nearestWalkable(w, Math.floor(pt.x), Math.floor(pt.y), 6);
        return s ? { x: s.tx + 0.5, y: s.ty + 0.5 } : null;
      };

      const aims = [{ x: etc.x, y: etc.y }];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        aims.push({ x: start.x + Math.cos(a) * 22, y: start.y + Math.sin(a) * 22 });
      }

      let goal = null;
      let post = null;
      for (const aimAt of aims) {
        const t = snap(aimAt) || aimAt;
        const route = findPath(w, start.x, start.y, t.x, t.y) || [];
        const g = snap(along(route, 20));
        const m = snap(along(route, 9));
        if (!g || !m) continue;
        if (Math.hypot(g.x - start.x, g.y - start.y) < 12) continue;
        goal = g;
        post = m;
        break;
      }
      if (!goal) return { fail: 'no long walkable route from the muster point' };

      const foe = spawnUnit(w, 'militia', 1, post.x, post.y);
      return {
        troops,
        foe: foe.id,
        foeHp: foe.hp,
        foeAt: { x: foe.x, y: foe.y },
        goal,
        goalD: Math.hypot(goal.x - start.x, goal.y - start.y),
        postD: Math.hypot(post.x - start.x, post.y - start.y),
        route: `picket ${Math.hypot(post.x - start.x, post.y - start.y).toFixed(0)} tiles out, goal ${Math.hypot(goal.x - start.x, goal.y - start.y).toFixed(0)} tiles out`,
      };
    });
    check('the army has a long march with an enemy standing in it',
      !fight.fail && fight.goalD >= 12 && fight.postD >= 4, fight.fail || fight.route);
    if (fight.fail) return;

    // Select the army the way a player would.
    await page.locator('#btn-menu').click();
    await page.locator('#menu-sheet button', { hasText: 'Select all military' }).click();
    check('the army can be selected from the menu',
      await page.evaluate((ids) => ids.every((id) => window.__game.world.selection.has(id)), fight.troops),
      fight.route);

    const btn = page.locator('#cmd-panel .cbtn.attack');
    check('an attack-move button is offered', await btn.count() > 0);
    const box = await btn.first().boundingBox();
    check('its touch target is at least 44x44', !!box && box.width >= 44 && box.height >= 44,
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no box');

    await btn.first().click();
    const armed = await page.evaluate(() => ({
      armed: window.__game.hud.isAttackArmed(),
      bar: !document.getElementById('attack-bar').hidden,
      barText: document.getElementById('attack-bar').textContent,
      lit: !!document.querySelector('#cmd-panel .cbtn.attack.armed'),
    }));
    check('tapping it arms the next tap', armed.armed);
    check('and the armed state is unmistakable', armed.bar && armed.lit, armed.barText);

    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-attackmove-armed.png') });

    // Cancellable — prove it, then arm it again.
    await page.locator('#attack-bar button').click();
    const cancelled = await page.evaluate(() => ({
      armed: window.__game.hud.isAttackArmed(),
      bar: !document.getElementById('attack-bar').hidden,
    }));
    check('and it can be cancelled', !cancelled.armed && !cancelled.bar);
    await btn.first().click();

    // The armed tap, aimed past the picket.
    const p = await aim(page, fight.goal.x, fight.goal.y);
    await page.touchscreen.tap(p.x, p.y);

    const ordered = await page.evaluate((ids) => {
      const w = window.__game.world;
      const us = ids.map((id) => w.entities.get(id));
      return {
        tasks: us.map((u) => u.task && `${u.task.type}${u.task.attackMove ? '+am' : ''}`),
        armed: window.__game.hud.isAttackArmed(),
        bar: !document.getElementById('attack-bar').hidden,
      };
    }, fight.troops);
    check('the tap issues an attack-move to every soldier',
      ordered.tasks.every((t) => t === 'move+am'), ordered.tasks.join(', '));
    check('and the mode disarms once spent', !ordered.armed && !ordered.bar);

    // The behaviour that makes it worth having: they must stop and fight.
    // "Engaging" is unitAI's own word for it — task.engaging is set the moment
    // an attack-moving unit breaks off to deal with something.
    let engaged = null;
    for (let i = 0; i < 60 && !engaged; i++) {
      await step(page, 20);
      engaged = await page.evaluate(([ids, foeId, hp0]) => {
        const w = window.__game.world;
        const foe = w.entities.get(foeId);
        const us = ids.map((id) => w.entities.get(id)).filter((u) => u && !u.dead);
        const fighting = us.filter((u) => u.state === 'attack' || (u.task && u.task.engaging));
        if (!fighting.length) return null;
        const hp = foe && !foe.dead ? foe.hp : 0;
        return { n: fighting.length, of: us.length, hp: Math.round(hp), hurt: hp < hp0 };
      }, [fight.troops, fight.foe, fight.foeHp]);
    }
    check('they stop to fight what they meet on the way', !!engaged,
      engaged ? `${engaged.n} of ${engaged.of} engaged, picket at ${engaged.hp} hp` : 'nobody ever engaged');

    await page.evaluate((g) => window.__game.input.centerOnGrid(g.x, g.y), fight.foeAt);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-attackmove-fight.png') });

    // Then the advance resumes: the picket dies and they carry on to the goal.
    let done = null;
    for (let i = 0; i < 90 && !done; i++) {
      await step(page, 20);
      done = await page.evaluate(([ids, foeId, goal]) => {
        const w = window.__game.world;
        const foe = w.entities.get(foeId);
        const us = ids.map((id) => w.entities.get(id)).filter((u) => u && !u.dead);
        const near = us.length ? Math.min(...us.map((u) => Math.hypot(u.x - goal.x, u.y - goal.y))) : Infinity;
        window.__amState = {
          foeDead: !foe || foe.dead,
          alive: us.length,
          near: Number.isFinite(near) ? Number(near.toFixed(1)) : null,
          states: us.map((u) => u.state),
        };
        if (foe && !foe.dead) return null;
        if (!us.length) return { wiped: true };
        return near < 3 ? { near } : null;
      }, [fight.troops, fight.foe, fight.goal]);
    }
    const amState = await page.evaluate(() => window.__amState || null);
    check('the picket dies and they carry on to where they were sent',
      !!done && !done.wiped,
      done && done.near !== undefined ? `closest soldier ${done.near.toFixed(1)} tiles from the goal`
        : `stalled: ${JSON.stringify(amState)}`);

    check('no console errors (attack-move run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 6: demolishing one of your own buildings ----------------------------
//
// The third playtest found there was no way to take a building down, anywhere —
// not in the command panel, not in the menu sheet. A house in the wrong place
// was permanent. This proves the escape hatch exists, that it cannot go off by
// accident, and that it is not offered for things that are not yours.

/** Force a synchronous HUD re-render, so a read never races the frame. */
const paint = (page) => page.evaluate(() => window.__game.hud.update(0.016));

const demolishBtn = (page) => page.locator('#cmd-panel .cbtn.demolish');

async function demolishRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    await watchToasts(page);

    // One finished house of ours, standing clear of everything else.
    const house = await page.evaluate(async () => {
      const { spawnBuilding, canPlace } = await import('/src/core/world.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      let at = null;
      for (let r = 4; r <= 14 && !at; r++) {
        for (const [dx, dy] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
          const gx = Math.floor(tc.x) + dx + 1;
          const gy = Math.floor(tc.y) + dy + 1;
          // A tile of margin all round, so the tap can only mean the house.
          if (canPlace(w, gx, gy, 4, 4) && canPlace(w, gx, gy, 2, 2)) { at = { gx, gy }; break; }
        }
      }
      if (!at) return { fail: 'nowhere to put a house' };
      const b = spawnBuilding(w, 'house', 0, at.gx, at.gy);
      return {
        id: b.id, x: b.x, y: b.y, tiles: b.tiles,
        popCap: w.players[0].popCap,
        wood: w.players[0].resources.wood,
      };
    });
    check('there is a house of ours to demolish', !house.fail, house.fail || '');
    if (house.fail) return;

    // Select it the way a thumb does.
    const p = await aim(page, house.x, house.y);
    await tapSlow(page, p.x, p.y);
    await paint(page);
    check('tapping our house selects it',
      await page.evaluate((id) => window.__game.world.selection.has(id), house.id));

    check('a demolish button is offered for it', await demolishBtn(page).count() > 0);
    const box = await demolishBtn(page).first().boundingBox();
    check('its touch target is at least 44x44', !!box && box.width >= 44 && box.height >= 44,
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no box');
    check('and it does not look like the other, harmless, buttons',
      await page.evaluate(() => {
        const d = document.querySelector('#cmd-panel .cbtn.demolish');
        const other = [...document.querySelectorAll('#cmd-panel .cbtn')].find((b) => b !== d);
        if (!d) return false;
        const a = getComputedStyle(d);
        const b = other ? getComputedStyle(other) : null;
        return a.borderTopColor !== (b ? b.borderTopColor : '') || /gradient/.test(a.backgroundImage);
      }));

    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-demolish-button.png') });

    // --- One tap must not level anything. ------------------------------------
    const mark = await toastMark(page);
    await demolishBtn(page).first().click();
    await paint(page);
    const armed = await page.evaluate((st) => {
      const w = window.__game.world;
      const b = w.entities.get(st.id);
      const btn = document.querySelector('#cmd-panel .cbtn.demolish');
      return {
        alive: !!b && !b.dead,
        hp: b ? b.hp : 0,
        armed: window.__game.hud.isDemolishArmed(),
        lit: !!document.querySelector('#cmd-panel .cbtn.demolish.armed'),
        label: btn ? btn.textContent : '',
        blocked: st.tiles.every(([tx, ty]) => w.blocked[ty * w.width + tx] !== 0),
      };
    }, house);
    check('one tap does NOT destroy the building', armed.alive && armed.blocked,
      `alive=${armed.alive} at ${armed.hp} hp, tiles still blocked=${armed.blocked}`);
    check('it arms and asks for a second tap instead', armed.armed && armed.lit, armed.label);
    check('and says so in words', /tap again/i.test(await toastsSince(page, mark)),
      await toastsSince(page, mark));

    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-demolish-confirm.png') });

    // --- The second tap does it. ---------------------------------------------
    check('the confirmation is still live when we take it',
      await page.evaluate(() => window.__game.hud.isDemolishArmed()));
    const mark2 = await toastMark(page);
    await demolishBtn(page).first().click();
    await paint(page);

    const gone = await page.evaluate((st) => {
      const w = window.__game.world;
      const b = w.entities.get(st.id);
      return {
        entity: !!b,
        inList: w.buildings.some((x) => x.id === st.id),
        selected: w.selection.has(st.id),
        free: st.tiles.every(([tx, ty]) => w.blocked[ty * w.width + tx] === 0),
        popCap: w.players[0].popCap,
        wood: w.players[0].resources.wood,
        btns: document.querySelectorAll('#cmd-panel .cbtn.demolish').length,
      };
    }, house);
    check('confirming actually removes the building',
      !gone.entity && !gone.inList && !gone.selected,
      `entity=${gone.entity}, in buildings=${gone.inList}, still selected=${gone.selected}`);
    check('and frees every tile of its footprint', gone.free,
      `${house.tiles.length} tiles`);
    check('the population cap it provided goes with it',
      gone.popCap === house.popCap - 5, `${house.popCap} -> ${gone.popCap}`);
    check('no resources are refunded, as in AoE2',
      gone.wood === house.wood, `${house.wood} -> ${gone.wood} wood`);
    check('a toast confirms the demolition',
      /demolished/i.test(await toastsSince(page, mark2)), await toastsSince(page, mark2));
    check('and the button is gone with the building', gone.btns === 0);

    // --- Never offered for things that are not ours to knock down. -----------
    const others = await page.evaluate(async () => {
      const { setSelection } = await import('/src/ui/selection.js');
      const { spawnBuilding } = await import('/src/core/world.js');
      const g = window.__game;
      const w = g.world;
      const out = {};
      const count = () => {
        g.hud.update(0.016);
        return document.querySelectorAll('#cmd-panel .cbtn.demolish').length;
      };

      const foeB = w.buildings.find((b) => b.player === 1 && b.complete);
      setSelection(w, [foeB]);
      out.enemyBuilding = count();

      const vill = w.units.find((u) => u.player === 0 && u.type === 'villager');
      setSelection(w, [vill]);
      out.ownUnit = count();

      const foeU = w.units.find((u) => u.player === 1);
      if (foeU) { setSelection(w, [foeU]); out.enemyUnit = count(); } else out.enemyUnit = 0;

      // A foundation is not a completed building: cancelling one is a different
      // (and cheaper) thing, so demolish stays off it.
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      const site = spawnBuilding(w, 'house', 0, Math.floor(tc.x) + 6, Math.floor(tc.y) + 6, { complete: false });
      setSelection(w, [site]);
      out.foundation = count();

      // ...and it is offered again for a real building of ours, so the checks
      // above are measuring the rule and not a broken panel.
      setSelection(w, [tc]);
      out.ownBuilding = count();
      return out;
    });
    check('demolish is not offered for an enemy building', others.enemyBuilding === 0,
      `${others.enemyBuilding} button(s)`);
    check('nor for a unit', others.ownUnit === 0 && others.enemyUnit === 0,
      `own unit: ${others.ownUnit}, enemy unit: ${others.enemyUnit}`);
    check('nor for a foundation still going up', others.foundation === 0,
      `${others.foundation} button(s)`);
    check('but it is offered for our own Town Center', others.ownBuilding === 1,
      `${others.ownBuilding} button(s)`);

    check('no console errors (demolish run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 7: the trap the third playtest got stuck in -------------------------
//
// A player walled their own villagers into a pocket with houses and farms; the
// economy froze at food 10 / wood 3 / gold 5 for eight minutes and there was no
// way out, because nothing in the game could take a building down. This builds
// the same cage — a solid two-tile-thick ring of our own houses around one
// villager, with the food it has been ordered to gather sitting outside — and
// then recovers from it the way a player now can: select a wall, demolish it,
// watch the villager walk out and get back to work.

async function trappedVillagerRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    const pen = await page.evaluate(async () => {
      const { spawnBuilding, spawnUnit, spawnResource, canPlace } = await import('/src/core/world.js');
      const { findPath } = await import('/src/systems/pathfinding.js');
      const { commandUnits } = await import('/src/systems/unitAI.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');

      // A clear 8x8 block near our base: a ring of 2x2 houses two tiles thick
      // (12 of them, no overlaps) leaves a 4x4 yard in the middle.
      const clear = (tx, ty, n) => {
        if (tx < 1 || ty < 1 || tx + n >= w.width - 1 || ty + n >= w.height - 1) return false;
        for (let y = ty; y < ty + n; y++) {
          for (let x = tx; x < tx + n; x++) {
            if (w.blocked[y * w.width + x] !== 0) return false;
            if (w.terrain[y * w.width + x] === 2) return false; // water
          }
        }
        return true;
      };
      // Nearest clear block to our base, preferring one with elbow room around
      // it (this map is mostly forest, so take what we can get).
      let origin = null;
      for (const margin of [2, 1, 0]) {
        let bestD = Infinity;
        for (let ty = 1; ty < w.height - 8; ty++) {
          for (let tx = 1; tx < w.width - 8; tx++) {
            if (!clear(tx - margin, ty - margin, 8 + margin * 2)) continue;
            const d = Math.hypot(tx + 4 - tc.x, ty + 4 - tc.y);
            if (d < bestD) { bestD = d; origin = { tx, ty }; }
          }
        }
        if (origin) break;
      }
      if (!origin) return { fail: 'no clear 8x8 block on this map' };
      const { tx, ty } = origin;

      // The food goes outside the pen, on a tile the villager could genuinely
      // walk to — checked *before* the walls exist, so the only thing that can
      // stop it later is the cage itself.
      const yard = { x: tx + 3.5, y: ty + 3.5 };
      let spot = null;
      for (let d = 2; d <= 7 && !spot; d++) {
        for (const [ux, uy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const bx = Math.floor(tx + 3.5 + ux * (4 + d));
          const by = Math.floor(ty + 3.5 + uy * (4 + d));
          if (!canPlace(w, bx + 0.5, by + 0.5, 1, 1)) continue;
          const route = findPath(w, yard.x, yard.y, bx + 0.5, by + 0.5);
          if (!route || !route.length) continue;
          const end = route[route.length - 1];
          if (Math.hypot(end.x - (bx + 0.5), end.y - (by + 0.5)) > 1.5) continue;
          spot = { bx, by };
          break;
        }
      }
      if (!spot) return { fail: 'nowhere reachable outside the pen to put the food' };
      const bush = spawnResource(w, 'berry', spot.bx, spot.by);

      const wall = [];
      const put = (ox, oy) => wall.push(spawnBuilding(w, 'house', 0, ox + 1, oy + 1));
      for (let i = 0; i < 8; i += 2) { put(tx + i, ty); put(tx + i, ty + 6); }   // top + bottom bands
      for (let j = 2; j < 6; j += 2) { put(tx, ty + j); put(tx + 6, ty + j); }   // left + right bands

      // One villager in the yard, ordered to go and gather that food.
      const v = spawnUnit(w, 'villager', 0, yard.x, yard.y);
      commandUnits(w, [v], { type: 'gather', gx: bush.x, gy: bush.y, target: bush });

      return {
        tx, ty,
        vill: v.id,
        bush: { id: bush.id, x: bush.x, y: bush.y, amount: bush.amount },
        wall: wall.map((b) => ({ id: b.id, x: b.x, y: b.y, tiles: b.tiles })),
        sealed: (() => {
          // Every tile of the 3-tile-wide band around the yard is blocked.
          for (let y = ty; y < ty + 8; y++) {
            for (let x = tx; x < tx + 8; x++) {
              const inYard = x >= tx + 2 && x < tx + 6 && y >= ty + 2 && y < ty + 6;
              if (!inYard && w.blocked[y * w.width + x] === 0) return false;
            }
          }
          return true;
        })(),
      };
    });
    check('the cage is built: a villager sealed in by our own houses',
      !pen.fail && pen.sealed && pen.wall.length === 12,
      pen.fail || `${pen.wall && pen.wall.length} houses, sealed=${pen.sealed}`);
    if (pen.fail) return;

    // A minute of match time. It has food to fetch and cannot reach it.
    await step(page, 1200);
    const stuck = await page.evaluate((st) => {
      const w = window.__game.world;
      const v = w.entities.get(st.vill);
      const b = w.entities.get(st.bush.id);
      const inside = v.x > st.tx + 1.9 && v.x < st.tx + 6.1 && v.y > st.ty + 1.9 && v.y < st.ty + 6.1;
      return {
        inside,
        at: `${v.x.toFixed(1)},${v.y.toFixed(1)}`,
        bush: b.amount,
        carrying: v.carrying.amount,
        progress: v.gatherProgress || 0,
      };
    }, pen);
    check('a minute later it is still in the pen, having gathered nothing at all',
      stuck.inside && stuck.bush === pen.bush.amount && stuck.carrying === 0 && stuck.progress === 0,
      `villager at ${stuck.at}, bush ${stuck.bush}/${pen.bush.amount}, carrying ${stuck.carrying}`);

    await page.evaluate((st) => window.__game.input.centerOnGrid(st.tx + 4, st.ty + 4), pen);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-demolish-trapped.png') });

    // --- Recover: tap a wall, demolish it. -----------------------------------
    // The wall between the villager and its food — the one a player would pick.
    const wallHouse = pen.wall.slice().sort((a, b) =>
      Math.hypot(a.x - pen.bush.x, a.y - pen.bush.y) - Math.hypot(b.x - pen.bush.x, b.y - pen.bush.y))[0];
    const p = await aim(page, wallHouse.x, wallHouse.y);
    await tapSlow(page, p.x, p.y);
    await paint(page);
    const picked = await page.evaluate(() => {
      const w = window.__game.world;
      const id = [...w.selection][0];
      const e = w.entities.get(id);
      return e && e.kind === 'building' && e.player === 0
        ? { id: e.id, tiles: e.tiles, type: e.type } : null;
    });
    check('tapping a wall of the pen selects it', !!picked, picked ? picked.type : 'nothing selected');
    if (!picked) return;

    await demolishBtn(page).first().click();
    await paint(page);
    await demolishBtn(page).first().click();
    await paint(page);
    const razed = await page.evaluate((st) => {
      const w = window.__game.world;
      return {
        gone: !w.entities.get(st.id),
        free: st.tiles.every(([tx, ty]) => w.blocked[ty * w.width + tx] === 0),
      };
    }, picked);
    check('two taps take the wall down and open the hole',
      razed.gone && razed.free, `removed=${razed.gone}, tiles free=${razed.free}`);

    // The villager may have given up on an order it could not carry out while it
    // was sealed in (that is the idle-villager button's job, and the other half
    // of this fix). Re-issue it if so — the question here is whether the wall
    // was what was stopping it.
    await page.evaluate(async (st) => {
      const w = window.__game.world;
      const v = w.entities.get(st.vill);
      if (v && !v.task) {
        const { commandUnits } = await import('/src/systems/unitAI.js');
        commandUnits(w, [v], {
          type: 'gather', gx: st.bush.x, gy: st.bush.y, target: w.entities.get(st.bush.id),
        });
      }
    }, pen);

    // "Back to work" is judged on the node it is actually working, not on the
    // bush this test planted: a villager that spends long enough failing to
    // reach one node retargets to another (unitAI's retargetNode), so which
    // bush it ends up on is not the claim being made here. Getting out and
    // harvesting something is.
    let freed = null;
    for (let i = 0; i < 60 && !freed; i++) {
      await step(page, 40);
      freed = await page.evaluate((st) => {
        const w = window.__game.world;
        const v = w.entities.get(st.vill);
        if (!v || v.dead) return { dead: true };
        const out = !(v.x > st.tx && v.x < st.tx + 8 && v.y > st.ty && v.y < st.ty + 8);
        if (!out) return null;
        // Its own hands, not the node's ledger: another villager could have been
        // eating that bush all along, so only this one's carry and gather
        // progress prove this one is working again.
        const working = v.carrying.amount > 0 || v.gatherProgress > 0 || v.state === 'gather';
        if (!working) return null;
        return {
          at: `${v.x.toFixed(1)},${v.y.toFixed(1)}`,
          state: v.state,
          task: v.task && v.task.type,
          carrying: Number(v.carrying.amount.toFixed(1)),
          progress: Number((v.gatherProgress || 0).toFixed(2)),
        };
      }, pen);
    }
    check('the villager walks out of the pen and gets back to work',
      !!freed && !freed.dead,
      freed && !freed.dead
        ? `at ${freed.at}, state=${freed.state} task=${freed.task}, ` +
          `carrying ${freed.carrying}, gather progress ${freed.progress}`
        : 'it never got out');

    await page.evaluate((st) => {
      const w = window.__game.world;
      const v = w.entities.get(st.vill);
      window.__game.input.centerOnGrid(v.x, v.y);
    }, pen);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-demolish-freed.png') });

    check('no console errors (trapped villager run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 8: putting villagers on your own farm -------------------------------
//
// The fourth playtest tapped a finished farm with thirteen villagers in hand and
// lost all thirteen: the tap selected the farm, gave no order, drew no ping and
// said nothing, so the whole workforce went idle in silence. A farm is a food
// node you paid wood for — tapping it has to mean what tapping a bush means.
// With nothing in hand it must still select, because its panel is where you read
// how much food is left in it.

async function farmTapRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    await watchToasts(page);
    // Command pings are recorded off the event bus: "the tap drew a ping" is a
    // claim about the order that went out, not about the renderer.
    await page.evaluate(async () => {
      const { EV } = await import('/src/core/events.js');
      window.__fx = [];
      window.__game.world.events.on(EV.COMMAND_FX, (p) => window.__fx.push(p.kind));
    });

    // A finished farm of ours with a tile of margin all round, so a tap on it
    // can only mean the farm.
    const farm = await page.evaluate(async () => {
      const { spawnBuilding, canPlace } = await import('/src/core/world.js');
      const economy = await import('/src/systems/economy.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      let at = null;
      for (let r = 3; r <= 12 && !at; r++) {
        for (const [dx, dy] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
          const gx = Math.floor(tc.x) + dx + 1;
          const gy = Math.floor(tc.y) + dy + 1;
          if (canPlace(w, gx, gy, 4, 4) && canPlace(w, gx, gy, 2, 2)) { at = { gx, gy }; break; }
        }
      }
      if (!at) return { fail: 'nowhere to put a farm' };
      const f = spawnBuilding(w, 'farm', 0, at.gx, at.gy);
      economy.initProvider(f);
      return { id: f.id, x: f.x, y: f.y, amount: f.amount, food: w.players[0].resources.food };
    });
    check('there is a finished farm of ours to tap', !farm.fail, farm.fail || `${farm.amount} food in it`);
    if (farm.fail) return;

    // --- Nothing in hand: the tap still selects it. --------------------------
    let p = await aim(page, farm.x, farm.y);
    await tapSlow(page, p.x, p.y);
    await paint(page);
    const inspected = await page.evaluate((id) => {
      const w = window.__game.world;
      const sel = document.getElementById('sel-panel');
      return {
        selected: w.selection.has(id),
        only: w.selection.size,
        rows: [...sel.querySelectorAll('.hp-text')].map((n) => n.textContent),
      };
    }, farm.id);
    check('tapping the farm with nothing selected selects it',
      inspected.selected && inspected.only === 1, `${inspected.only} selected`);
    check('and its panel shows hit points and the food left in it',
      inspected.rows.length === 2 && /hp$/.test(inspected.rows[0]) && /food left$/.test(inspected.rows[1]),
      inspected.rows.join(' / '));

    // --- Villagers in hand: the tap is a gather order. -----------------------
    await page.locator('#btn-menu').click();
    await page.locator('#menu-sheet button', { hasText: 'Select all villagers' }).click();
    const crew = await page.evaluate(() => [...window.__game.world.selection]);
    check('every villager we own is in hand', crew.length > 1, `${crew.length} villagers selected`);

    const fxMark = await page.evaluate(() => window.__fx.length);
    p = await aim(page, farm.x, farm.y);
    await tapSlow(page, p.x, p.y);

    const ordered = await page.evaluate(([id, ids, n]) => {
      const w = window.__game.world;
      const us = ids.map((i) => w.entities.get(i)).filter(Boolean);
      return {
        tasks: us.map((u) => u.task && u.task.type),
        onFarm: us.filter((u) => u.task && u.task.node && u.task.node.id === id).length,
        stillSelected: ids.filter((i) => w.selection.has(i)).length,
        grabbedFarm: w.selection.has(id),
        fx: window.__fx.slice(n),
      };
    }, [farm.id, crew, fxMark]);

    check('tapping the farm with villagers in hand issues a gather order',
      ordered.tasks.length > 0 && ordered.tasks.every((t) => t === 'gather') && ordered.onFarm > 0,
      `${ordered.onFarm} of ${ordered.tasks.length} sent to the farm, tasks: ${[...new Set(ordered.tasks)].join(',')}`);
    check('the selection survives the tap',
      ordered.stillSelected === crew.length && !ordered.grabbedFarm,
      `${ordered.stillSelected} of ${crew.length} still selected, farm selected: ${ordered.grabbedFarm}`);
    check('and it pings like any other gather order',
      ordered.fx.includes('gather'), `fx=[${ordered.fx.join(',')}]`);

    // --- And the loop closes: food actually lands in the bank. ---------------
    await step(page, 1200); // one minute
    const worked = await page.evaluate(([id, before]) => {
      const w = window.__game.world;
      const f = w.entities.get(id);
      return {
        left: f && !f.dead ? f.amount : 0,
        gone: !f || f.dead,
        food: w.players[0].resources.food,
        gained: w.players[0].resources.food - before,
      };
    }, [farm.id, farm.food]);
    check('the farm is eaten into', worked.left < farm.amount,
      worked.gone ? 'eaten out entirely' : `${farm.amount} -> ${worked.left.toFixed(0)} food left`);
    check('and the food is banked', worked.gained > 0,
      `${farm.food.toFixed(0)} -> ${worked.food.toFixed(0)} food`);

    await page.evaluate((at) => window.__game.input.centerOnGrid(at.x, at.y), farm);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-farm-gathering.png') });

    check('no console errors (farm run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// --- Run 9: the placement ghost, the refusal, and cancelling a site ----------
//
// Three findings from the fourth playtest, all in one tap:
//   * the ghost went green on a tile the game then refused, because it asked
//     canPlace() (is the ground empty) rather than the rule the placement
//     itself uses (would this seal somebody in);
//   * the refusal then stacked two identical toasts over the base;
//   * and a site you regret could not be taken back, only finished and razed.
//
// The pen below is built with setBlocked on ground that has been checked clear,
// so the map's own trees cannot decide whether this run is meaningful: a
// villager sits in a 5x5 yard whose only door is exactly the size of a house.

async function placementGhostRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    await watchToasts(page);

    const pen = await page.evaluate(async () => {
      const { setBlocked, canPlace } = await import('/src/core/world.js');
      const economy = await import('/src/systems/economy.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');

      const clear = (tx, ty, n) => {
        if (tx < 1 || ty < 1 || tx + n >= w.width - 1 || ty + n >= w.height - 1) return false;
        for (let y = ty; y < ty + n; y++) {
          for (let x = tx; x < tx + n; x++) {
            if (w.blocked[y * w.width + x] !== 0) return false;
            if (w.terrain[y * w.width + x] === 2) return false; // water
          }
        }
        return true;
      };
      let origin = null;
      let bestD = Infinity;
      for (let ty = 1; ty < w.height - 9; ty++) {
        for (let tx = 1; tx < w.width - 9; tx++) {
          if (!clear(tx, ty, 9)) continue;
          const d = Math.hypot(tx + 4 - tc.x, ty + 4 - tc.y);
          if (d < bestD) { bestD = d; origin = { tx, ty }; }
        }
      }
      if (!origin) return { fail: 'no clear 9x9 block on this map' };
      const { tx, ty } = origin;

      // A 7x7 ring inside the block, with a one-tile-wide, two-tile-tall door in
      // its right-hand wall. A 2x2 house plugs that door exactly.
      for (let y = ty + 1; y <= ty + 7; y++) {
        for (let x = tx + 1; x <= tx + 7; x++) {
          const onRing = x === tx + 1 || x === tx + 7 || y === ty + 1 || y === ty + 7;
          if (!onRing) continue;
          if (x === tx + 7 && (y === ty + 3 || y === ty + 4)) continue; // the door
          setBlocked(w, x, y, 1, 999);
        }
      }

      // One of ours in the yard, and the world held still so the taps below
      // measure the rules rather than a villager walking about between them.
      const v = w.units.find((u) => u.player === 0 && u.type === 'villager');
      v.x = tx + 4.5;
      v.y = ty + 4.5;
      v.task = null;
      window.__game.scene.simStep = () => {};
      w.players[0].resources.wood = 500;

      const plug = { gx: tx + 8, gy: ty + 4 }; // tiles (tx+7,tx+8) x (ty+3,ty+4)

      // Somewhere legitimate to build, for the other half of the claim.
      let good = null;
      for (let r = 3; r <= 14 && !good; r++) {
        for (const [dx, dy] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
          const gx = Math.floor(tc.x) + dx + 1;
          const gy = Math.floor(tc.y) + dy + 1;
          if (canPlace(w, gx, gy, 4, 4) && economy.canPlaceReachable(w, 0, 'house', gx, gy)) {
            good = { gx, gy };
            break;
          }
        }
      }

      return {
        tx, ty, plug, good, vill: v.id,
        wood: w.players[0].resources.wood,
        canPlace: canPlace(w, plug.gx, plug.gy, 2, 2),
        reachable: economy.canPlaceReachable(w, 0, 'house', plug.gx, plug.gy),
      };
    });
    check('the pen is built: a villager in a yard with one house-sized door',
      !pen.fail && pen.canPlace && pen.reachable === false && !!pen.good,
      pen.fail || `canPlace=${pen.canPlace}, canPlaceReachable=${pen.reachable}, ` +
        `somewhere legal to build=${!!pen.good}`);
    if (pen.fail || !pen.canPlace || pen.reachable !== false || !pen.good) return;

    // Aim the ghost at the door and lift, reading what the renderer was handed.
    // Real PointerEvents, because the ghost has to be inspected *between* the
    // press and the lift and the CDP pipeline cannot be interrupted mid-gesture.
    const refused = await page.evaluate((s) => {
      const g = window.__game;
      const calls = [];
      const orig = g.renderer.setPlacementGhost;
      g.renderer.setPlacementGhost = (...a) => { calls.push(a); return orig.apply(g.renderer, a); };
      g.input.centerOnGrid(s.plug.gx, s.plug.gy);
      g.hud.setPlacementMode('house');
      const p = g.input._toScreen(s.plug.gx, s.plug.gy);
      const canvas = g.scene.game.canvas;
      const r = canvas.getBoundingClientRect();
      const size = g.scene.game.scale.gameSize;
      const GHOST_LIFT = 62; // must match ui/input.js
      const opts = {
        pointerId: 11,
        pointerType: 'touch',
        clientX: r.left + (p.x * r.width) / size.width,
        clientY: r.top + ((p.y + GHOST_LIFT) * r.height) / size.height,
        bubbles: true,
        cancelable: true,
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
      const ghost = { ...g.input._state.ghost };
      window.dispatchEvent(new PointerEvent('pointerup', opts));
      g.renderer.setPlacementGhost = orig;
      const drawn = calls[calls.length - 1] || [];
      return {
        ghost,
        drawnValid: drawn[3],
        drawnAt: `${drawn[1]},${drawn[2]}`,
        armed: g.hud.getPlacementType(),
        sites: g.world.buildings.filter((b) => b.player === 0 && !b.complete).length,
        wood: g.world.players[0].resources.wood,
      };
    }, pen);

    check('the ghost sits on the tile the finger is aiming at',
      refused.ghost.gx === pen.plug.gx && refused.ghost.gy === pen.plug.gy,
      `ghost at ${refused.ghost.gx},${refused.ghost.gy}, aimed at ${pen.plug.gx},${pen.plug.gy}`);
    check('and it is RED on the tile the game will refuse',
      refused.ghost.valid === false && refused.drawnValid === false,
      `ghost.valid=${refused.ghost.valid}, drawn valid=${refused.drawnValid} at ${refused.drawnAt}`);
    check('the refused tap builds nothing and charges nothing',
      refused.sites === 0 && refused.wood === pen.wood,
      `${refused.sites} site(s), ${pen.wood} -> ${refused.wood} wood`);
    check('and placement stays armed so the player can just move a bit',
      refused.armed === 'house', String(refused.armed));

    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-ghost-refused.png') });

    // One refusal, one toast — and a second refusal a beat later must refresh
    // that line rather than stack an identical copy of it over the base.
    const first = await page.evaluate(() => ({
      nodes: [...document.querySelectorAll('#toasts .toast:not(.out)')].map((n) => n.textContent),
      all: window.__toasts.slice(),
    }));
    const refusals = (list) => list.filter((t) => /trap your villagers|seal in your Town Center/i.test(t));
    check('the refusal says which rule it is', refusals(first.all).length === 1,
      first.all.join(' | '));
    check('and it is on screen exactly once', refusals(first.nodes).length === 1,
      `${first.nodes.length} toast(s): ${first.nodes.join(' | ')}`);

    // 1.8s: past the repeat window (1600ms), inside the toast's own life (2400ms)
    // — the gap the two stacked copies used to appear in.
    await page.waitForTimeout(1800);
    const again = await page.evaluate((s) => {
      const g = window.__game;
      const p = g.input._toScreen(s.plug.gx, s.plug.gy);
      const canvas = g.scene.game.canvas;
      const r = canvas.getBoundingClientRect();
      const size = g.scene.game.scale.gameSize;
      const opts = {
        pointerId: 12,
        pointerType: 'touch',
        clientX: r.left + (p.x * r.width) / size.width,
        clientY: r.top + ((p.y + 62) * r.height) / size.height,
        bubbles: true,
        cancelable: true,
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
      window.dispatchEvent(new PointerEvent('pointerup', opts));
      return [...document.querySelectorAll('#toasts .toast:not(.out)')].map((n) => n.textContent);
    }, pen);
    check('refusing the same tile again never stacks a second copy of the line',
      refusals(again).length === 1, `${again.length} toast(s): ${again.join(' | ')}`);

    // --- Green where it will actually go through. ----------------------------
    const placed = await page.evaluate((s) => {
      const g = window.__game;
      g.input.centerOnGrid(s.good.gx, s.good.gy);
      const p = g.input._toScreen(s.good.gx, s.good.gy);
      const canvas = g.scene.game.canvas;
      const r = canvas.getBoundingClientRect();
      const size = g.scene.game.scale.gameSize;
      const opts = {
        pointerId: 13,
        pointerType: 'touch',
        clientX: r.left + (p.x * r.width) / size.width,
        clientY: r.top + ((p.y + 62) * r.height) / size.height,
        bubbles: true,
        cancelable: true,
      };
      const woodBefore = g.world.players[0].resources.wood;
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
      const ghost = { ...g.input._state.ghost };
      window.dispatchEvent(new PointerEvent('pointerup', opts));
      const site = g.world.buildings.find((b) => b.player === 0 && !b.complete);
      return {
        ghost,
        woodBefore,
        wood: g.world.players[0].resources.wood,
        site: site ? { id: site.id, x: site.x, y: site.y, tiles: site.tiles, type: site.type } : null,
        armed: g.hud.getPlacementType(),
      };
    }, pen);
    check('the ghost is GREEN where the placement will be taken',
      placed.ghost.valid === true, `ghost.valid=${placed.ghost.valid}`);
    check('and lifting there really does put the foundation down',
      !!placed.site && placed.wood === placed.woodBefore - 25,
      placed.site ? `${placed.woodBefore} -> ${placed.wood} wood` : 'no foundation');
    if (!placed.site) return;
    check('placement mode is spent once it is used', placed.armed === null, String(placed.armed));

    // --- Cancelling the site you regret. -------------------------------------
    const p2 = await aim(page, placed.site.x, placed.site.y);
    await tapSlow(page, p2.x, p2.y);
    await paint(page);
    const panel = await page.evaluate((id) => ({
      selected: window.__game.world.selection.has(id),
      note: (document.querySelector('#cmd-panel .cmd-note') || {}).textContent,
      cancels: document.querySelectorAll('#cmd-panel .cbtn.danger').length,
      demolish: document.querySelectorAll('#cmd-panel .cbtn.demolish').length,
    }), placed.site.id);
    check('tapping our own foundation selects it', panel.selected);
    check('the panel offers a Cancel for it, and not a Demolish',
      panel.cancels === 1 && panel.demolish === 0,
      `${panel.cancels} cancel, ${panel.demolish} demolish — note: ${panel.note}`);
    const box = await page.locator('#cmd-panel .cbtn.danger').first().boundingBox();
    check('its touch target is at least 44x44', !!box && box.width >= 44 && box.height >= 44,
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no box');

    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-cancel-foundation.png') });

    const mark = await toastMark(page);
    await page.locator('#cmd-panel .cbtn.danger').first().click();
    await paint(page);
    const cancelled = await page.evaluate((s) => {
      const w = window.__game.world;
      return {
        gone: !w.entities.get(s.id) && !w.buildings.some((b) => b.id === s.id),
        selected: w.selection.has(s.id),
        free: s.tiles.every(([tx, ty]) => w.blocked[ty * w.width + tx] === 0),
        wood: w.players[0].resources.wood,
      };
    }, placed.site);
    check('one tap cancels the site — no confirmation needed, nothing is destroyed',
      cancelled.gone && !cancelled.selected, `removed=${cancelled.gone}`);
    check('the ground comes back', cancelled.free, `${placed.site.tiles.length} tiles`);
    check('and so does the wood', cancelled.wood === placed.woodBefore,
      `${placed.wood} -> ${cancelled.wood}, paid ${placed.woodBefore}`);
    check('a toast says so', /cancelled/i.test(await toastsSince(page, mark)),
      await toastsSince(page, mark));

    check('no console errors (placement ghost run)', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }
}

// `--only rally` runs just the runs whose name contains "rally" — the whole
// file is four browser boots and well over a minute, which is a long wait when
// you are iterating on one of them.
const ONLY = arg('only', '');

const run = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const runs = [
    ['rally onto a resource', rallyRun],
    ['rally onto the bush a villager is already working', rallyOverVillagerRun],
    ['how much map the toast stack covers', toastCoverageRun],
    ['what a double-tap grabs', doubleTapRun],
    ['attack-move', attackMoveRun],
    ['demolish one of your own buildings', demolishRun],
    ['demolish your way out of a trap', trappedVillagerRun],
    ['put villagers on your own farm', farmTapRun],
    ['the placement ghost, the refusal and cancelling a site', placementGhostRun],
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
