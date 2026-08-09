// A tripwire on the cost of a simulation step.
//
// The browser performance guard (tests/perf.browser.mjs) is the complete
// picture, but it measures inside a Chromium doing software rasterisation, so
// its CPU numbers move by fifty per cent depending on how busy the build box
// is. This one runs the fixed step and nothing else — no Phaser, no renderer,
// no browser — which makes it the quietest instrument in the repo: across
// repeated runs on the same machine the median moves by under five per cent.
//
// It exists to catch the class of regression that does not show up as a slightly
// slower frame but as a change of complexity: a proximity query that goes back
// to scanning every entity on the map, a per-entity allocation in the step, an
// A* budget that stops being a budget. Those all show here as a multiple, not a
// few per cent, which is why the budget below can be generous enough to survive
// a slow CI box and still be worth having.
//
// Reference measurement (this machine, 2026-08): 1.46ms median per step with
// 120 units left standing out of 210 spawned, against 1.91ms before the
// performance pass. See the Performance section of CHANGELOG.md.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWorld, spawnUnit, reindex,
} from '../src/core/world.js';
import { generateMap } from '../src/core/mapgen.js';
import { SIM_DT } from '../src/core/constants.js';
import { updateUnits, commandUnits } from '../src/systems/unitAI.js';
import { updateCombat } from '../src/systems/combat.js';
import { updateEconomy } from '../src/systems/economy.js';
import { updateAllocation } from '../src/systems/allocation.js';

// Milliseconds for one fixed step with two armies in contact. Measured at 1.46;
// three times that is still comfortably inside the 20Hz step's own 50ms, and a
// regression of the kind this exists to catch overshoots it several times over.
const STEP_BUDGET_MS = 4.5;
const ARMY = 85;

function stage(seed) {
  const world = createWorld(seed);
  generateMap(world);
  const tc = [...world.players[0].owned]
    .map((id) => world.entities.get(id))
    .find((e) => e && e.type === 'towncenter');
  const gx = Math.round(tc.x);
  const gy = Math.round(tc.y);
  const kinds = ['militia', 'spearman', 'archer', 'scout'];
  const mine = [];
  const theirs = [];
  for (let i = 0; i < ARMY; i++) {
    const col = i % 10;
    const row = Math.floor(i / 10);
    mine.push(spawnUnit(world, kinds[i % 4], 0, gx - 5 + col * 0.9, gy + 4 + row * 0.9));
    theirs.push(spawnUnit(world, kinds[(i + 2) % 4], 1, gx - 5 + col * 0.9, gy + 12 + row * 0.9));
  }
  for (let i = 0; i < 40; i++) {
    spawnUnit(world, 'villager', 0, gx - 8 + (i % 8) * 0.8, gy - 8 + Math.floor(i / 8) * 0.8);
  }
  world.players[0].popCap = 400;
  world.players[1].popCap = 400;
  commandUnits(world, mine, { type: 'attackMove', x: gx - 1, y: gy + 16 });
  commandUnits(world, theirs, { type: 'attackMove', x: gx - 1, y: gy + 2 });
  return world;
}

/** One fixed step, in the order GameScene.simStep runs them. */
function step(world) {
  for (const u of world.units) {
    u.px = u.x;
    u.py = u.y;
  }
  reindex(world);
  updateAllocation(world, SIM_DT);
  updateUnits(world, SIM_DT);
  updateCombat(world, SIM_DT);
  updateEconomy(world, SIM_DT);
  world.vision.update();
  world.time += SIM_DT;
  world.tick++;
}

test('a fixed step with two armies in contact stays inside its budget', () => {
  const world = stage(4242);
  // Warm the JIT and let the armies close, so what is timed is the melee and
  // not two lines of men walking across open ground.
  for (let i = 0; i < 40; i++) step(world);
  assert.ok(world.units.length > 150, `expected a crowd, got ${world.units.length}`);

  const samples = [];
  for (let i = 0; i < 240; i++) {
    const t0 = performance.now();
    step(world);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[samples.length >> 1];
  const p95 = samples[Math.round((samples.length - 1) * 0.95)];
  assert.ok(
    median < STEP_BUDGET_MS,
    `sim step median ${median.toFixed(2)}ms (p95 ${p95.toFixed(2)}ms, ` +
    `${world.units.length} units) exceeds the ${STEP_BUDGET_MS}ms budget`,
  );
});

// Allocation is deliberately NOT asserted here. `process.memoryUsage().heapUsed`
// is a reading of where the collector happens to have got to, and over the same
// two hundred steps it returns anything between 14kB and 34kB a step for
// identical work. tests/perf.browser.mjs measures it properly, with V8's
// sampling allocation profiler, which counts bytes as they are allocated and can
// name the call site — see 'the frame loop is not making garbage' there.
