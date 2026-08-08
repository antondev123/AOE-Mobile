// End-to-end integration smoke test.
//
// Boots the real game in Chromium at phone size, fast-forwards the simulation,
// and asserts the whole thing actually plays: villagers gather, the stockpile
// grows, the enemy builds a base and an army, nobody throws. Also drops
// screenshots so the visual pass has something to look at.
//
//   node tests/smoke.mjs [--minutes 6] [--shots screenshots/]

import fs from 'node:fs';
import path from 'node:path';
import { boot, step, snapshot } from './harness.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const MINUTES = Number(arg('minutes', 6));
const SHOT_DIR = arg('shots', 'screenshots');
const SIM_HZ = 20;
const TOTAL_STEPS = Math.round(MINUTES * 60 * SIM_HZ);
const CHUNK = 400;

const failures = [];
const checks = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}

const run = async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const h = await boot();
  const { page, errors } = h;

  try {
    console.log(`\nBooting and simulating ${MINUTES} minutes of skirmish...\n`);

    const start = await snapshot(page);
    check('game boots with a world', start.villagers[0] === 3 && start.villagers[1] === 3,
      `villagers ${JSON.stringify(start.villagers)}`);
    check('map has resource nodes', start.nodes > 100, `${start.nodes} nodes`);
    await page.screenshot({ path: path.join(SHOT_DIR, '01-start.png') });

    // --- Player-side: order every villager to gather, then watch the economy --
    await page.evaluate(() => {
      const g = window.__game;
      const w = g.world;
      const mine = [...w.players[0].owned]
        .map((id) => w.entities.get(id))
        .filter((e) => e && e.kind === 'unit');
      // Send each villager to the nearest resource node of any type.
      for (const u of mine) {
        let best = null;
        let bestD = Infinity;
        for (const n of w.resources) {
          const d = (n.x - u.x) ** 2 + (n.y - u.y) ** 2;
          if (d < bestD) { bestD = d; best = n; }
        }
        if (best) g.command([u], { type: 'gather', target: best, gx: best.x, gy: best.y });
      }
    }).catch(() => {});

    let mid = null;
    for (let done = 0; done < TOTAL_STEPS; done += CHUNK) {
      await step(page, Math.min(CHUNK, TOTAL_STEPS - done));
      if (mid === null && done + CHUNK >= TOTAL_STEPS / 2) {
        mid = await snapshot(page);
        await page.screenshot({ path: path.join(SHOT_DIR, '02-midgame.png') });
      }
      const s = await snapshot(page);
      if (s.over) {
        console.log(`\n  match ended early at ${s.time.toFixed(0)}s, winner = player ${s.winner}\n`);
        break;
      }
    }

    const end = await snapshot(page);
    await page.screenshot({ path: path.join(SHOT_DIR, '03-endgame.png') });

    console.log('\n--- final state ---');
    console.log(JSON.stringify(end, null, 2), '\n');

    // --- Economy ------------------------------------------------------------
    const gatheredAny =
      end.resources[0].food + end.resources[0].wood + end.resources[0].gold >
      start.resources[0].food + start.resources[0].wood + start.resources[0].gold;
    check('player economy produced resources', gatheredAny,
      `start ${JSON.stringify(start.resources[0])} end ${JSON.stringify(end.resources[0])}`);
    check('resource nodes were consumed', end.nodes < start.nodes,
      `${start.nodes} -> ${end.nodes}`);

    // --- Enemy AI -----------------------------------------------------------
    check('enemy trained villagers', end.villagers[1] > start.villagers[1],
      `${start.villagers[1]} -> ${end.villagers[1]}`);
    check('enemy built houses', end.houses[1] >= 1, `${end.houses[1]} houses`);
    check('enemy built a barracks', end.barracks[1] >= 1, `${end.barracks[1]} barracks`);
    // The barracks only lands around 1:45 and the first wave is scheduled at
    // 170s, so a short run legitimately has no soldiers yet. The seed is random
    // per run and the AI's opening varies with how its local resources fall, so
    // the four minute mark is only good for "it has started"; hold it to a real
    // army only once it has had time to build one.
    if (MINUTES >= 5) {
      check('enemy trained military', end.military[1] >= 3, `${end.military[1]} soldiers`);
    } else if (MINUTES >= 4) {
      check('enemy started training military', end.military[1] >= 1, `${end.military[1]} soldiers`);
    } else {
      console.log(`  skip  enemy trained military (needs a >=4 minute run, got ${MINUTES})`);
    }
    check('enemy respected its pop cap',
      end.resources[1].pop <= end.resources[1].popCap,
      `pop ${end.resources[1].pop}/${end.resources[1].popCap}`);

    // --- Liveness -----------------------------------------------------------
    const idle = end.states.idle || 0;
    const total = Object.values(end.states).reduce((a, b) => a + b, 0);
    check('most units are not standing idle', total === 0 || idle / total < 0.6,
      `${idle}/${total} idle, states ${JSON.stringify(end.states)}`);

    // --- Errors -------------------------------------------------------------
    check('no console errors or exceptions', errors.length === 0,
      errors.slice(0, 6).join(' | '));
  } finally {
    await h.close();
  }

  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
  if (failures.length) {
    console.error(`\nFAILURES:\n - ${failures.join('\n - ')}\n`);
    process.exit(1);
  }
  console.log('smoke test passed\n');
};

run().catch((e) => {
  console.error('harness error:', e);
  process.exit(1);
});
