// In-browser verification of the two touch affordances added for the playtest
// findings: rally-to-resource, and issuing an attack-move.
//
//   node tests/ui.browser.mjs [--shots screenshots/]
//
// Nothing here pokes the input layer's internals: every order is given the way
// a thumb gives it — a real touch on the canvas, a real click on a HUD button —
// and every claim is checked against the simulation afterwards. Storing a rally
// proves nothing, so this runs the loop all the way through: tap the bush, train
// a villager out of the Town Center, and watch the food land in the stockpile.

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

const toastText = (page) =>
  page.evaluate(() => document.getElementById('toasts').textContent || '');

const run = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const h = await boot();
  const { page, errors } = h;

  try {
    // ---------------------------------------------------------------- rally

    // A bush with nothing else of ours nearby, so the tap can only mean the
    // bush (the picker prefers your own units when they are equally close).
    const spot = await page.evaluate(() => {
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      let best = null;
      let bestD = Infinity;
      for (const n of w.resources) {
        if (n.type !== 'berry' || n.amount <= 0) continue;
        const near = w.units.some((u) => Math.hypot(u.x - n.x, u.y - n.y) < 3);
        if (near) continue;
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
    const selectedTc = await page.evaluate((id) => window.__game.world.selection.has(id), spot.tc.id);
    check('tapping the Town Center selects it', selectedTc);

    // Tap the bush. This must set the rally, NOT select the bush.
    p = await aim(page, spot.berry.x, spot.berry.y);
    await page.touchscreen.tap(p.x, p.y);

    const after = await page.evaluate(([tcId, berryId]) => {
      const w = window.__game.world;
      const tc = w.entities.get(tcId);
      const b = w.entities.get(berryId);
      return {
        rally: tc.rally,
        d: tc.rally ? Math.hypot(tc.rally.x - b.x, tc.rally.y - b.y) : Infinity,
        stillTc: w.selection.has(tcId),
        grabbedBush: w.selection.has(berryId),
        note: document.querySelector('.rally-note') && document.querySelector('.rally-note').textContent,
      };
    }, [spot.tc.id, spot.berry.id]);

    check('the tap sets the rally on the bush', after.d < 0.01,
      after.rally ? `rally ${after.rally.x},${after.rally.y} vs bush ${spot.berry.x},${spot.berry.y}` : 'no rally');
    check('and does not select the bush instead', after.stillTc && !after.grabbedBush,
      `tc selected: ${after.stillTc}, bush selected: ${after.grabbedBush}`);

    const toast = await toastText(page);
    check('a toast names what the rally will do', /gather food/i.test(toast), toast.trim());
    check('and the command panel says so too', /gather food/i.test(after.note || ''), after.note);

    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-rally-on-berries.png') });

    // Train a villager from the panel and watch it work the bush.
    const foodBefore = await page.evaluate(() => window.__game.world.players[0].resources.food);
    await page.locator('#cmd-panel .cbtn', { hasText: 'Villager' }).first().click();
    const queued = await page.evaluate(
      (id) => (window.__game.world.entities.get(id).queue || []).length, spot.tc.id);
    check('the Town Center takes the training order', queued > 0, `${queued} in queue`);

    // 8s build time at 20Hz, plus slack for the walk out.
    await step(page, 200);
    const rallied = await page.evaluate(() => {
      const w = window.__game.world;
      const v = w.units.filter((u) => u.player === 0 && u.type === 'villager');
      const fresh = v[v.length - 1];
      return { n: v.length, task: fresh.task && fresh.task.type, state: fresh.state, id: fresh.id };
    });
    check('the trained villager gets a gather order, not a walk', rallied.task === 'gather',
      `task=${rallied.task} state=${rallied.state}`);

    // Three minutes of it working, then check the food actually banked.
    await step(page, 3600);
    const banked = await page.evaluate(([berryId, foodBefore]) => {
      const w = window.__game.world;
      const b = w.entities.get(berryId);
      return {
        food: w.players[0].resources.food,
        gained: w.players[0].resources.food - foodBefore,
        left: b ? b.amount : 0,
        carrying: w.units.filter((u) => u.player === 0 && u.carry && u.carry.amount > 0).length,
      };
    }, [spot.berry.id, foodBefore]);
    // The villager cost 50 food, so anything above that is genuinely harvested.
    check('food is banked from the rallied villager', banked.gained > 0,
      `${foodBefore.toFixed(0)} -> ${banked.food.toFixed(0)} food (villager cost 50)`);
    check('the bush was actually eaten into', banked.left < spot.berry.amount,
      `${spot.berry.amount} -> ${banked.left.toFixed(0)}`);

    await page.evaluate(() => {
      const w = window.__game.world;
      const v = w.units.filter((u) => u.player === 0 && u.type === 'villager');
      window.__game.input.centerOnGrid(v[v.length - 1].x, v[v.length - 1].y);
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-rally-gathering.png') });

    // ---------------------------------------------------------- attack-move

    // Give the player an army and the enemy a picket standing in its way.
    const fight = await page.evaluate(async () => {
      const { spawnUnit } = await import('/src/core/world.js');
      const w = window.__game.world;
      const tc = w.buildings.find((b) => b.player === 0 && b.type === 'towncenter');
      const etc = w.buildings.find((b) => b.player === 1 && b.type === 'towncenter');
      const dx = etc.x - tc.x;
      const dy = etc.y - tc.y;
      const len = Math.hypot(dx, dy);
      const at = (t) => ({ x: tc.x + (dx / len) * t, y: tc.y + (dy / len) * t });

      const troops = [];
      for (let i = 0; i < 3; i++) {
        const s = at(3);
        troops.push(spawnUnit(w, 'militia', 0, s.x + i * 0.8, s.y - 0.8).id);
      }
      // One enemy soldier a third of the way along — squarely "on the road".
      const e = at(10);
      const foe = spawnUnit(w, 'militia', 1, e.x, e.y);
      const goal = at(20);
      return { troops, foe: foe.id, foeAt: { x: foe.x, y: foe.y }, goal };
    });

    // Select the army through the menu, the way a player would.
    await page.locator('#btn-menu').click();
    await page.locator('#menu-sheet button', { hasText: 'Select all military' }).click();
    const armyOk = await page.evaluate((ids) =>
      ids.every((id) => window.__game.world.selection.has(id)), fight.troops);
    check('the army can be selected from the menu', armyOk);

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

    // Cancellable: prove it, then arm it again.
    await page.locator('#attack-bar button').click();
    const cancelled = await page.evaluate(() => ({
      armed: window.__game.hud.isAttackArmed(),
      bar: !document.getElementById('attack-bar').hidden,
    }));
    check('and it can be cancelled', !cancelled.armed && !cancelled.bar);
    await btn.first().click();

    // The armed tap: aim past the enemy picket.
    p = await aim(page, fight.goal.x, fight.goal.y);
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

    // Now the behaviour that makes it worth having: they must stop and fight.
    let engaged = null;
    for (let i = 0; i < 40 && !engaged; i++) {
      await step(page, 20);
      engaged = await page.evaluate(([ids, foeId]) => {
        const w = window.__game.world;
        const foe = w.entities.get(foeId);
        const us = ids.map((id) => w.entities.get(id)).filter(Boolean);
        const fighting = us.filter((u) => u.state === 'attacking' || (u.task && u.task.type === 'attack'));
        if (!fighting.length && (!foe || foe.dead)) return { hurt: true, n: 0, foeDead: true };
        if (!fighting.length) return null;
        return {
          n: fighting.length,
          foeDead: !foe || foe.dead,
          foeHp: foe && !foe.dead ? foe.hp : 0,
          d: us[0] && Math.hypot(us[0].x - w.entities.get(foeId).x, us[0].y - w.entities.get(foeId).y),
        };
      }, [fight.troops, fight.foe]).catch(() => null);
    }
    check('they stop to fight what they meet on the way', !!engaged,
      engaged ? `${engaged.n} engaged, foe hp ${engaged.foeHp}` : 'nobody ever engaged');

    await page.evaluate((g) => window.__game.input.centerOnGrid(g.x, g.y), fight.foeAt);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOT_DIR, 'ui-attackmove-fight.png') });

    // Kill the picket off and confirm the advance resumes.
    let done = null;
    for (let i = 0; i < 60 && !done; i++) {
      await step(page, 20);
      done = await page.evaluate(([ids, foeId, goal]) => {
        const w = window.__game.world;
        const foe = w.entities.get(foeId);
        if (foe && !foe.dead) return null;
        const us = ids.map((id) => w.entities.get(id)).filter((u) => u && !u.dead);
        if (!us.length) return { wiped: true };
        const near = Math.min(...us.map((u) => Math.hypot(u.x - goal.x, u.y - goal.y)));
        return near < 3 ? { near, alive: us.length } : null;
      }, [fight.troops, fight.foe, fight.goal]);
    }
    check('and then carry on to where they were sent', !!done && !done.wiped,
      done ? `closest ${done.near && done.near.toFixed(1)} tiles from the goal` : 'never arrived');

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
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
