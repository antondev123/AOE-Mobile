// In-browser verification of the two touch affordances added for the playtest
// findings: rally-to-resource, and issuing an attack-move.
//
//   node tests/ui.browser.mjs [--shots screenshots/]
//
// Nothing here pokes the input layer's internals: every order is given the way
// a thumb gives it — a real touch on the canvas, a real click on a HUD button —
// and every claim is then checked against the simulation. Storing a rally proves
// nothing, so the first run goes all the way through the loop: tap the bush,
// train a villager out of the Town Center, and watch the food land in the bank.
//
// The two halves get a fresh boot each, deliberately. The rally run has to
// fast-forward three minutes, by which time the AI's first wave is on the move —
// and an army that is busy being ambushed cannot prove anything about
// attack-move. Two clean rooms beat one noisy one.

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

// --- Run 2: arm an attack-move and spend it ----------------------------------

async function attackMoveRun() {
  const h = await boot();
  const { page, errors } = h;
  try {
    await watchToasts(page);

    // An army, a goal well across the map, and one enemy soldier standing on
    // the route they will actually walk — placed on the planned path rather
    // than on the straight line, or a detour round a forest would let them
    // stroll past it and prove nothing.
    const fight = await page.evaluate(async () => {
      const { spawnUnit } = await import('/src/core/world.js');
      const { findPath, nearestWalkable } = await import('/src/systems/pathfinding.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      const etc = w.buildings.find((b) => b.player === 1 && b.type === 'towncenter');
      const dx = etc.x - tc.x;
      const dy = etc.y - tc.y;
      const len = Math.hypot(dx, dy);
      const along = (t) => {
        const raw = { x: tc.x + (dx / len) * t, y: tc.y + (dy / len) * t };
        const ok = nearestWalkable(w, Math.floor(raw.x), Math.floor(raw.y), 10);
        return ok ? { x: ok.tx + 0.5, y: ok.ty + 0.5 } : raw;
      };

      const start = along(4);
      const goal = along(22);

      const troops = [];
      for (let i = 0; i < 3; i++) {
        const s = nearestWalkable(w, Math.floor(start.x) + i - 1, Math.floor(start.y), 6);
        troops.push(spawnUnit(w, 'militia', 0, s.tx + 0.5, s.ty + 0.5).id);
      }

      // Halfway along the real path.
      const p = findPath(w, start.x, start.y, goal.x, goal.y);
      const pts = (p && p.length ? p : [goal]);
      let total = 0;
      const segs = [];
      let prev = start;
      for (const q of pts) {
        const d = Math.hypot(q.x - prev.x, q.y - prev.y);
        segs.push({ a: prev, b: q, d });
        total += d;
        prev = q;
      }
      let want = total * 0.45;
      let mid = goal;
      for (const s of segs) {
        if (want <= s.d) {
          const t = s.d ? want / s.d : 0;
          mid = { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
          break;
        }
        want -= s.d;
      }
      const m = nearestWalkable(w, Math.floor(mid.x), Math.floor(mid.y), 6) || { tx: Math.floor(mid.x), ty: Math.floor(mid.y) };
      const foe = spawnUnit(w, 'militia', 1, m.tx + 0.5, m.ty + 0.5);
      return {
        troops,
        foe: foe.id,
        foeAt: { x: foe.x, y: foe.y },
        goal,
        route: `${total.toFixed(0)} tiles, picket at ${(total * 0.45).toFixed(0)}`,
      };
    });

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
    let engaged = null;
    for (let i = 0; i < 60 && !engaged; i++) {
      await step(page, 20);
      engaged = await page.evaluate(([ids, foeId]) => {
        const w = window.__game.world;
        const foe = w.entities.get(foeId);
        const us = ids.map((id) => w.entities.get(id)).filter(Boolean);
        const fighting = us.filter((u) => u.state === 'attacking' || (u.task && u.task.type === 'attack'));
        if (!fighting.length) return null;
        return {
          n: fighting.length,
          foeHp: foe && !foe.dead ? Math.round(foe.hp) : 0,
          walked: Math.round(Math.hypot(us[0].x - w.entities.get(ids[0]).x, 0)),
        };
      }, [fight.troops, fight.foe]);
    }
    check('they stop to fight what they meet on the way', !!engaged,
      engaged ? `${engaged.n} of 3 engaged, picket down to ${engaged.foeHp} hp` : 'nobody ever engaged');

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

const run = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  console.log('\n--- rally onto a resource ---');
  await rallyRun();
  console.log('\n--- attack-move ---');
  await attackMoveRun();
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
