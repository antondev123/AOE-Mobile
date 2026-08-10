// The simulation, headless, with a hash — shared by the Node determinism tests
// and by the cross-engine check that runs the same code in Firefox and WebKit.
//
// NOTHING IN THIS FILE MAY IMPORT node:anything. It is loaded verbatim by a
// browser in tests/crossengine.browser.mjs, and the entire point of that test is
// that the bytes JavaScriptCore executes are the bytes Node executes.

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
export const TICKS = 12000;
// Three seeds, because one seed exercises one map and one AI opening. A
// determinism bug that only fires when somebody builds near water is still a
// determinism bug.
export const SEEDS = [4242, 99, 1337];
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

export function makeMatch(seed) {
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

export function stepMatch(m) {
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
export const calls = { hypot: 0, sin: 0, cos: 0, atan2: 0 };

export const PERTURBATIONS = {
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
export function runVector(seed, patch, ticks = TICKS) {
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
export function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i * HASH_EVERY;
  return a.length === b.length ? -1 : n * HASH_EVERY;
}

