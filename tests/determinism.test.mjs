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
import {
  hashWorld, makeMatch, stepMatch, runVector, firstDivergence, PERTURBATIONS,
  TICKS, SEEDS, calls,
} from './simharness.mjs';

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
