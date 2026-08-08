// In-browser verification of the under-attack alert (playtest finding B1).
//
//   node tests/combat.browser.mjs [--minutes 10] [--shots screenshots/]
//
// The headless tests in combat.test.mjs prove the event fires and is throttled.
// This proves the thing a player actually experiences: boot the real game at
// phone size, fast-forward until the AI's first wave hits something of yours,
// and check that a red alert toast and a minimap ping appear — then tap the
// toast and check the camera really jumps to the fight. Screenshots are written
// so the alert can be looked at rather than taken on trust.

import fs from 'node:fs';
import path from 'node:path';
import { boot, step } from './harness.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const MINUTES = Number(arg('minutes', 10));
const SHOT_DIR = arg('shots', 'screenshots');
const SIM_HZ = 20;
// Small chunks: a ping decays in wall-clock seconds (it is a pulse, not a sim
// object), so a fast-forward has to notice the alert promptly or it will be
// looking at an empty minimap by the time it checks.
const CHUNK = 40; // 2 sim-seconds per poll

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}

const run = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const h = await boot();
  const { page, errors } = h;

  try {
    // Record every alert the simulation raises, from inside the page.
    await page.evaluate(() => {
      window.__alerts = [];
      window.__game.world.events.on('underAttack', (p) => {
        window.__alerts.push({ player: p.player, type: p.entity && p.entity.type, gx: p.gx, gy: p.gy, t: window.__game.world.time });
      });
    });

    // Fast-forward until one of the player's own things is hit.
    const total = Math.round(MINUTES * 60 * SIM_HZ);
    let fired = null;
    for (let done = 0; done < total && !fired; done += CHUNK) {
      await step(page, CHUNK);
      fired = await page.evaluate(() => window.__alerts.find((a) => a.player === 0) || null);
    }

    check('the AI eventually attacks something of yours', !!fired,
      fired ? `${fired.type} at ${fired.t.toFixed(0)}s` : `nothing in ${MINUTES} minutes`);
    if (!fired) return;

    // Let the page paint: the HUD redraws the minimap at 10Hz off rAF.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(250);

    const alertDom = await page.evaluate(() => {
      const n = document.querySelector('.toast.alert');
      if (!n) return null;
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return {
        text: n.textContent,
        w: Math.round(r.width),
        h: Math.round(r.height),
        pointer: cs.pointerEvents,
        bg: cs.backgroundImage.slice(0, 40),
        tag: n.tagName,
      };
    });

    check('a toast is on screen', !!alertDom, alertDom ? alertDom.text : 'no .toast.alert');
    check('it names the thing under attack',
      !!alertDom && /under attack!/.test(alertDom.text) && /Your /.test(alertDom.text),
      alertDom && alertDom.text);
    check('it is tappable', !!alertDom && alertDom.pointer === 'auto' && alertDom.tag === 'BUTTON',
      alertDom && `${alertDom.tag} pointer-events:${alertDom.pointer}`);
    check('it reads as an alarm, not a routine toast',
      !!alertDom && alertDom.bg.includes('gradient'), alertDom && alertDom.bg);
    check('it is big enough to hit on a phone', !!alertDom && alertDom.h >= 34 && alertDom.w >= 150,
      alertDom && `${alertDom.w}x${alertDom.h}`);

    const pings = await page.evaluate((f) => {
      const c = document.getElementById('minimap');
      const g = c.getContext('2d');
      // Where the attack should be drawn (gridToMini, inlined).
      const SPAN = 96;
      const ex = ((f.gx - f.gy + 48) / SPAN) * c.width;
      const ey = ((f.gx + f.gy) / SPAN) * c.width;
      const x0 = Math.max(0, Math.min(c.width - 32, Math.round(ex) - 16));
      const y0 = Math.max(0, Math.min(c.height - 32, Math.round(ey) - 16));
      const px = g.getImageData(x0, y0, 32, 32).data;
      // Only the ping paints these two colours: a white-hot core (the camera
      // rectangle is 92% white over terrain, so it never reaches 240 on every
      // channel) and #ff2f18 (enemy pips are #ff5a5a, which never gets below
      // 70 on green while staying above 220 on red).
      let hot = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i];
        const gg = px[i + 1];
        const b = px[i + 2];
        if (r > 240 && gg > 240 && b > 240) hot++;
        else if (r > 220 && gg < 70 && b < 60) hot++;
      }
      const mm = window.__game.hud._minimap;
      return {
        hot,
        tracked: mm && mm.pings ? mm.pings.length : 0,
        alarmClass: document.getElementById('minimap-wrap').classList.contains('alarm'),
      };
    }, fired);
    check('the minimap is holding a ping', pings.tracked > 0, `${pings.tracked} live`);
    check('and it is painted at the attack site', pings.hot > 4,
      `${pings.hot} alarm pixels within 16px of the fight`);
    check('and the minimap frame is flashing', pings.alarmClass);

    await page.screenshot({ path: path.join(SHOT_DIR, 'b1-under-attack.png') });
    // Two crops ~a third of a pulse apart: the ping blinks white-hot to red, and
    // one still frame can only ever show one of the two.
    const wrap = await page.$('#minimap-wrap');
    if (wrap) {
      await wrap.screenshot({ path: path.join(SHOT_DIR, 'b1-minimap-ping.png') });
      await page.waitForTimeout(340);
      await wrap.screenshot({ path: path.join(SHOT_DIR, 'b1-minimap-ping-2.png') });
    }

    // Tapping the alert must take you to the fight. Park the camera in the far
    // corner first: a jump you cannot measure proves nothing.
    const before = await page.evaluate(() => {
      window.__game.input.centerOnGrid(44, 44);
      const c = window.__game.input.camera;
      return { x: c.midPoint.x, y: c.midPoint.y };
    });
    await page.locator('.toast.alert').click({ timeout: 3000 });
    const after = await page.evaluate((f) => {
      const c = window.__game.input.camera;
      // Where the attack is, in world pixels (HALF_W/HALF_H are 32/16).
      const wx = (f.gx - f.gy) * 32;
      const wy = (f.gx + f.gy) * 16;
      return {
        x: c.midPoint.x,
        y: c.midPoint.y,
        d: Math.hypot(c.midPoint.x - wx, c.midPoint.y - wy),
      };
    }, fired);
    const moved = Math.hypot(after.x - before.x, after.y - before.y);
    check('tapping the alert jumps the camera to the fight', after.d < 260,
      `moved ${moved.toFixed(0)}px, now ${after.d.toFixed(0)}px from the attack`);

    await page.screenshot({ path: path.join(SHOT_DIR, 'b1-after-jump.png') });

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
