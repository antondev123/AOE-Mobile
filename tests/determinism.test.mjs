// Is this simulation bit-identical on two machines?
//
// THIS IS THE GATE ON NETWORKED MULTIPLAYER, and it is worth being blunt about
// why it comes before anything else. Deterministic lockstep sends inputs, not
// state: every peer runs the whole simulation and they must agree exactly, for
// the whole match, or two players are looking at different games while both
// believe they are looking at the same one. There is no partial credit — a
// single differing bit in one unit's x coordinate becomes, four minutes later,
// a battle that one player won and the other lost.
//
// The good news is that "exactly" is a property you can test offline, in one
// process, in a few seconds. No server, no second device, no netcode. Two
// worlds from one seed, the same commands, and a hash per tick.
//
// WHAT ACTUALLY THREATENS DETERMINISM HERE. ECMA-262 pins +, -, *, / and
// Math.sqrt to IEEE-754 correctly-rounded results, and floor/ceil/round/abs/
// min/max/imul to exact definitions. Every conforming engine agrees on those to
// the bit. It explicitly does NOT pin the transcendentals: Math.hypot,
// Math.sin, Math.cos, Math.atan2 and Math.pow are "implementation-approximated",
// and V8, SpiderMonkey and JavaScriptCore genuinely differ in the last unit in
// the last place. Measured here: Math.hypot(a, b) and Math.sqrt(a*a + b*b)
// disagree on about 38% of random inputs in V8, which proves hypot is a
// distinct algorithm rather than a correctly-rounded composition — so an engine
// that implements it differently differs on roughly a third of all calls.
//
// A third of calls, one ulp. That sounds survivable and is not: the simulation
// compares those distances against exact thresholds (arrival at d <= 1.0, a
// repath at moved > 1.2, a separation deadband) and writes them straight back
// into positions. One ulp on the wrong side of a threshold flips a branch, and
// the two worlds never come back.
//
// SO THIS FILE TESTS THE FIX BY BREAKING IT ON PURPOSE. Rather than assert that
// two identical runs match — which they trivially do, in one process, with one
// libm — each perturbation mode below monkey-patches a transcendental with a
// different-but-equally-valid implementation, exactly as a foreign engine
// would. That is what a second engine IS, from this simulation's point of view.
// If the sim survives every perturbation for the full run, it is not relying on
// anything the spec leaves free.
//
//   node --test tests/determinism.test.mjs
//
// A failure prints the tick where the two worlds first disagreed. That number
// is the whole value of this harness: a desync stops being "the game went weird
// after seven minutes" and becomes a line number.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, recomputePop } from '../src/core/world.js';
import { generateMap } from '../src/core/mapgen.js';
import { updateAllocation } from '../src/systems/allocation.js';
import { updateUnits } from '../src/systems/unitAI.js';
import { updateCombat } from '../src/systems/combat.js';
import { updateEconomy } from '../src/systems/economy.js';
import { createEnemyAI } from '../src/systems/enemyAI.js';
import { reindex } from '../src/core/world.js';
import { SIM_DT } from '../src/core/constants.js';

// Long enough to matter, short enough to run in CI. At 20Hz this is ten
// simulated minutes, which is past the point where the measured hypot fork
// showed up (t=274s, tick 5468) and well into the part of a match where armies
// exist and the AI is making decisions off distances.
const TICKS = 12000;
// Three seeds, because one seed exercises one map and one AI opening. A
// determinism bug that only fires when somebody builds near water is still a
// determinism bug.
const SEEDS = [4242, 99, 1337];
// Sampling the hash every tick is the honest thing to do and costs little; the
// expensive part is walking the entity list, so we do it once per tick and
// fold it into a running digest rather than keeping 12,000 hashes.
const HASH_EVERY = 1;

// --- The digest --------------------------------------------------------------
//
// FNV-1a over the fields the simulation actually branches on. Deliberately NOT
// a hash of everything: px/py are render interpolation and vx/vy are facing,
// neither of which any sim decision reads, and including them would make this
// test fail for cosmetic reasons and train everybody to ignore it.
//
// Floats go in by their exact bits, not by toFixed — the entire point is to
// catch a one-ulp difference, and rounding to a few decimals throws away
// precisely the signal we are hunting.

const f64 = new Float64Array(1);
const bytes = new Uint8Array(f64.buffer);

function mixNumber(h, v) {
  f64[0] = v;
  for (let i = 0; i < 8; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function mixInt(h, v) {
  let x = v | 0;
  for (let i = 0; i < 4; i++) {
    h ^= x & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    x >>>= 8;
  }
  return h;
}

/**
 * A hash of everything the next step's decisions can depend on.
 *
 * Entities are walked in world.units / world.buildings order. That order is
 * itself part of the state — if two peers ever hold the same entities in a
 * different order, iteration order changes and so do tie-breaks, so a hash that
 * sorted first would hide a real divergence rather than catch it.
 */
export function hashWorld(world) {
  let h = 0x811c9dc5;
  h = mixInt(h, world.tick);
  h = mixNumber(h, world.time);
  h = mixInt(h, world.nextId);

  for (const p of world.players) {
    const r = p.resources;
    h = mixNumber(h, r.food);
    h = mixNumber(h, r.wood);
    h = mixNumber(h, r.gold);
    h = mixNumber(h, r.stone);
    h = mixInt(h, p.pop);
    h = mixInt(h, p.popCap);
    h = mixInt(h, p.age || 0);
    h = mixInt(h, p.defeated ? 1 : 0);
    h = mixInt(h, p.owned ? p.owned.size : 0);
  }

  for (const u of world.units) {
    h = mixInt(h, u.id);
    h = mixInt(h, u.dead ? 1 : 0);
    h = mixNumber(h, u.x);
    h = mixNumber(h, u.y);
    h = mixNumber(h, u.hp);
    h = mixInt(h, u.player);
    // state and task type are strings; fold their characters.
    h = mixString(h, u.state);
    h = mixString(h, u.task ? u.task.type : '-');
    h = mixInt(h, u.task && u.task.target ? u.task.target.id : 0);
    h = mixNumber(h, u.carrying ? u.carrying.amount : 0);
  }

  for (const b of world.buildings) {
    h = mixInt(h, b.id);
    h = mixInt(h, b.dead ? 1 : 0);
    h = mixNumber(h, b.x);
    h = mixNumber(h, b.y);
    h = mixNumber(h, b.hp);
    h = mixInt(h, b.player);
    h = mixInt(h, b.complete ? 1 : 0);
    h = mixInt(h, b.queue ? b.queue.length : 0);
  }

  for (const r of world.resources) {
    h = mixInt(h, r.id);
    h = mixNumber(h, r.amount);
  }

  return h >>> 0;
}

function mixString(h, s) {
  const str = String(s == null ? '-' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// --- A headless match --------------------------------------------------------
//
// Mirrors GameScene.simStep exactly (see src/scenes/GameScene.js): reindex,
// allocation, units, combat, economy, every AI in ascending slot order, then
// vision. The order is part of the contract — two peers stepping the systems in
// a different order is a divergence, so this harness must not "tidy" it.

function makeMatch(seed) {
  const world = createWorld(seed);
  // createWorld() builds an EMPTY world — terrain arrays, an empty entity list
  // and nothing else. generateMap() is what puts the map, the resources, the
  // Town Centers and the starting villagers in it, and GameScene calls the two
  // in that order (GameScene.js:87-90). Leaving it out does not fail loudly: the
  // harness happily steps an empty world twelve thousand times, every hash
  // matches every other hash, and all four perturbation tests pass while
  // proving nothing whatsoever. That is exactly what happened on the first run
  // of this file, and it is why the canary test above exists.
  generateMap(world);
  for (let p = 0; p < world.players.length; p++) recomputePop(world, p);
  const ais = [];
  // Every non-human slot gets an AI, in ascending slot order. Today that is
  // slot 1; when the world grows to 8 slots this loop is already correct.
  for (let p = 1; p < world.players.length; p++) ais.push(createEnemyAI(world, p));
  return { world, ais };
}

function stepMatch(m) {
  const { world, ais } = m;
  if (world.over) return;
  for (const u of world.units) { u.px = u.x; u.py = u.y; }
  reindex(world);
  updateAllocation(world, SIM_DT);
  updateUnits(world, SIM_DT);
  updateCombat(world, SIM_DT);
  updateEconomy(world, SIM_DT);
  for (const ai of ais) ai.update(SIM_DT);
  world.vision.update();
  world.time += SIM_DT;
  world.tick++;
}

// --- Perturbations -----------------------------------------------------------
//
// Each of these swaps a transcendental for a different implementation that is
// every bit as correct. This is not a synthetic worst case: it is a faithful
// model of what a second JavaScript engine does. Math.sqrt and the four basic
// operations are pinned by the spec, so the replacements below are built from
// those and are themselves deterministic — the difference is only that they are
// a *different* valid answer, which is exactly the situation across engines.

// The ORIGINAL implementations, captured before anything is patched. Calling
// Math.hypot from inside a function that has been installed AS Math.hypot is
// unbounded recursion, and it does not look like a determinism failure — it
// looks like 'Maximum call stack size exceeded', which is easy to read as a bug
// in the game rather than a bug in the test. It happened on the first run.
const RAW = {
  hypot: Math.hypot, sin: Math.sin, cos: Math.cos, atan2: Math.atan2,
};

// How many times each patched function was actually reached during a run.
// WITHOUT THIS THE TESTS CAN PASS BY DOING NOTHING: once the simulation stops
// calling Math.sin at all, a 'sin' perturbation patches a function nobody
// invokes, both runs are trivially identical, and the test reports success
// while proving nothing. That is the correct end state — but it must be
// asserted as "no longer reachable", never inferred from a green tick.
const calls = { hypot: 0, sin: 0, cos: 0, atan2: 0 };

const PERTURBATIONS = {
  none: {},

  // V8's hypot disagrees with sqrt(a*a+b*b) on ~38% of inputs. Either is a
  // legal implementation; the spec pins neither.
  hypot: {
    hypot: (...args) => {
      calls.hypot++;
      let s = 0;
      for (const a of args) s += a * a;
      return Math.sqrt(s);
    },
  },

  // A Taylor-corrected sin/cos: same value to ~1ulp, different last bit. Stands
  // in for a different libm.
  trig: {
    sin: (x) => {
      calls.sin++;
      const s = RAW.sin(x);
      // Nudge by one ulp in a value-dependent but deterministic direction.
      return s === 0 ? s : s * (1 + Number.EPSILON) - s * Number.EPSILON;
    },
    cos: (x) => {
      calls.cos++;
      const c = RAW.cos(x);
      return c === 0 ? c : c * (1 + Number.EPSILON) - c * Number.EPSILON;
    },
  },

  atan2: {
    atan2: (y, x) => {
      calls.atan2++;
      const a = RAW.atan2(y, x);
      return a === 0 ? a : a * (1 + Number.EPSILON) - a * Number.EPSILON;
    },
  },
};
// Everything at once — the realistic case, since a foreign engine differs in
// all of them simultaneously.
PERTURBATIONS.all = {
  ...PERTURBATIONS.hypot, ...PERTURBATIONS.trig, ...PERTURBATIONS.atan2,
};

function withPerturbation(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) {
    saved[k] = Math[k];
    Math[k] = patch[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) Math[k] = saved[k];
  }
}

/** Run a match and return the per-tick hash vector. */
function runVector(seed, patch, ticks = TICKS) {
  for (const k of Object.keys(calls)) calls[k] = 0;
  return withPerturbation(patch, () => {
    const m = makeMatch(seed);
    const out = new Uint32Array(Math.ceil(ticks / HASH_EVERY));
    let k = 0;
    for (let t = 0; t < ticks; t++) {
      stepMatch(m);
      if (t % HASH_EVERY === 0) out[k++] = hashWorld(m.world);
    }
    return out;
  });
}

/** The first tick at which two vectors differ, or -1. */
function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i * HASH_EVERY;
  return a.length === b.length ? -1 : n * HASH_EVERY;
}

// --- The tests ---------------------------------------------------------------

test('the harness itself detects a divergence', () => {
  // A canary. If this ever passes-by-accident — because the hash is too coarse,
  // or the run too short, or the systems were not actually stepped — every
  // other test in this file becomes a lie that reports success. So we take a
  // known-good run and corrupt one unit's position by one ulp at tick 50, and
  // require the harness to notice.
  const seed = SEEDS[0];
  const base = runVector(seed, {}, 400);
  const m = makeMatch(seed);
  const out = new Uint32Array(400);
  for (let t = 0; t < 400; t++) {
    stepMatch(m);
    if (t === 50) {
      const u = m.world.units.find((x) => !x.dead);
      assert.ok(u, 'expected at least one living unit to perturb');
      u.x += Number.EPSILON * Math.abs(u.x || 1);
    }
    out[t] = hashWorld(m.world);
  }
  const at = firstDivergence(base, out);
  assert.ok(at >= 0 && at <= 51,
    `the harness must catch a one-ulp corruption at tick 50, saw divergence at ${at}`);
});

test('the world under test is actually a match', () => {
  // The cheapest possible guard against the harness testing nothing. Every
  // assertion in this file is conditional on there being a simulation here.
  const m = makeMatch(SEEDS[0]);
  assert.ok(m.world.units.length >= 6, `expected starting villagers, saw ${m.world.units.length}`);
  assert.ok(m.world.buildings.length >= 2, `expected Town Centers, saw ${m.world.buildings.length}`);
  assert.ok(m.world.resources.length > 50, `expected a populated map, saw ${m.world.resources.length} nodes`);
  assert.ok(m.ais.length >= 1, 'expected at least one AI');
  const before = hashWorld(m.world);
  for (let i = 0; i < 100; i++) stepMatch(m);
  assert.notEqual(hashWorld(m.world), before, 'the world did not change in 100 steps');
});

test('a seed replays identically in one process', () => {
  for (const seed of SEEDS) {
    const a = runVector(seed, {}, 2000);
    const b = runVector(seed, {}, 2000);
    assert.equal(firstDivergence(a, b), -1, `seed ${seed} did not replay identically`);
  }
});

for (const [name, patch] of Object.entries(PERTURBATIONS)) {
  if (name === 'none') continue;
  test(`the simulation survives a foreign engine's ${name}`, () => {
    for (const seed of SEEDS) {
      const stock = runVector(seed, {});
      const other = runVector(seed, patch);
      const reached = Object.entries(calls).filter(([, n]) => n > 0);
      // A mode nobody reaches is the goal, not a pass to be quietly banked.
      // Say so out loud, so a green run is never mistaken for coverage.
      if (!reached.length) {
        console.log(`    (${name}: never called from the simulation — the fix is that these are gone)`);
      } else {
        console.log(`    (${name}: still reached ${reached.map(([k, n]) => `${k} x${n}`).join(', ')})`);
      }
      const at = firstDivergence(stock, other);
      assert.equal(at, -1,
        `seed ${seed} forked at tick ${at} (${(at / 20).toFixed(1)}s) under '${name}'. ` +
        'Something in the simulation path depends on a Math function the ECMAScript ' +
        'spec leaves implementation-defined. Replace it with sqrt/+-*/ arithmetic ' +
        '(see iso.js dist()) or a seeded integer choice (see phaseOf in combat.js).');
    }
  });
}
