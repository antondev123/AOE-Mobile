// Headless tests for the three mechanics siege and support brought with them:
// area-of-effect damage, minimum range, and healing.
//
//   node --test tests/siege.test.mjs
//
// Everything runs on a blank world — no mapgen — so no shot is ever decided by
// where the generator happened to put a tree.
//
// TWO STEP FUNCTIONS, AND THE DIFFERENCE MATTERS. `step` runs combat only, the
// way tests/combat.test.mjs does, and is what every splash test uses: the whole
// point of those tests is *where bodies are standing*, and separation steering
// nudges units around by a fraction of a tile every step, which would quietly
// move the thing being measured. `simStep` runs the full loop and is used by the
// minimum-range tests, which are about a unit walking somewhere.
//
// --- ON CANARIES -------------------------------------------------------------
//
// Every test in this file carries a control that must come out DIFFERENT from
// the thing under test. Not an extra assertion — a second measurement, taken
// with the mechanic removed, that fails in the same way a broken implementation
// would.
//
// This is not ceremony. A test that says "the militia took damage" passes
// whether the damage came from splash, from a direct hit, from the second shot
// four seconds later, or from a harness bug that damaged everything on the map.
// This repository has been bitten three times by tests that were green and
// measuring nothing, so each test below pairs its claim with the arrangement in
// which the claim must be false:
//
//   splash hits several bodies      <-> an archer's arrow hits exactly one
//   damage falls off with distance  <-> equidistant bodies take equal damage
//   the blast catches your own men  <-> your men outside the radius are unhurt
//   an engine backs off a close foe <-> a militia closes on the same foe
//   a monk never fights             <-> a militia in the monk's place does
//   healing stops at maxHp          <-> the last tick would have overshot it
//
// If the mechanic under test were deleted, the control and the subject would
// agree, and the test would fail on that.

import {
  SIM_DT, PLAYER, ENEMY, UNIT_STATS, MIN_DAMAGE, STANCE,
} from '../src/core/constants.js';
import {
  createWorld, spawnUnit, spawnBuilding, reindex,
} from '../src/core/world.js';
import {
  updateCombat, inRange, tooClose, canAttack, minAttackReach,
  effectiveAttack, findPatient, healRateOf,
} from '../src/systems/combat.js';
import { commandUnits, updateUnits } from '../src/systems/unitAI.js';
import { EV } from '../src/core/events.js';
import { dist } from '../src/core/iso.js';

// --- Micro test framework ---------------------------------------------------

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'expected equal'}: ${a} !== ${b}`);
}

// --- Sim harness ------------------------------------------------------------

/** An empty grass field. No mapgen: nothing here is about terrain. */
function field(seed = 5150) {
  const w = createWorld(seed);
  reindex(w);
  return w;
}

/** Combat only — nothing moves except projectiles. */
function step(world, n = 1) {
  for (let i = 0; i < n; i++) {
    reindex(world);
    world.vision.update();
    updateCombat(world, SIM_DT);
    world.time += SIM_DT;
    world.tick++;
  }
}

/** The whole loop, in GameScene.simStep()'s order. */
function simStep(world, n = 1) {
  for (let i = 0; i < n; i++) {
    for (const u of world.units) { u.px = u.x; u.py = u.y; }
    reindex(world);
    updateUnits(world, SIM_DT);
    updateCombat(world, SIM_DT);
    world.vision.update();
    world.time += SIM_DT;
    world.tick++;
  }
}

/**
 * Step until exactly one shot has been thrown and has landed.
 *
 * Returns false if nothing was ever launched, which every caller asserts on:
 * "no damage" is the same reading as "the unit never fired", and telling those
 * two apart is the difference between a test and a decoration.
 */
function fireOnce(world, max = 400) {
  let launched = false;
  for (let i = 0; i < max; i++) {
    step(world);
    if (world.projectiles.length) launched = true;
    else if (launched) return true;
  }
  return false;
}

/** A stationary punchbag: it will not fight back and it will not run. */
function dummy(world, type, player, x, y) {
  const u = spawnUnit(world, type, player, x, y);
  u.stance = STANCE.NO_ATTACK;
  return u;
}

/** Damage taken so far. */
function taken(u) {
  return u.maxHp - u.hp;
}

// --- 1. Splash hits several bodies ------------------------------------------

test('splash: one boulder hits every body around where it lands', () => {
  // Three enemies in a huddle, well inside the 1.4-tile blast of a mangonel
  // aimed at the middle one.
  const w = field();
  const m = spawnUnit(w, 'mangonel', PLAYER, 20, 20);
  const a = dummy(w, 'militia', ENEMY, 26, 20);
  const b = dummy(w, 'militia', ENEMY, 26.8, 20);
  const c = dummy(w, 'militia', ENEMY, 25.2, 20);
  m.target = a;

  assert(fireOnce(w), 'the mangonel never fired');
  assert(taken(a) > 0, 'the target of the shot took nothing');
  assert(taken(b) > 0, `the body 0.8 tiles from the impact took nothing (hp ${b.hp})`);
  assert(taken(c) > 0, `the body 0.8 tiles the other way took nothing (hp ${c.hp})`);

  // THE CANARY. The identical arrangement, shot by an archer instead. If splash
  // were not implemented — or if this harness were measuring something other
  // than the blast, such as three units all being shot at in turn — the two
  // arrangements would agree, and one of these two claims would be false.
  const w2 = field();
  const arch = spawnUnit(w2, 'archer', PLAYER, 22, 20);
  const a2 = dummy(w2, 'militia', ENEMY, 26, 20);
  const b2 = dummy(w2, 'militia', ENEMY, 26.8, 20);
  const c2 = dummy(w2, 'militia', ENEMY, 25.2, 20);
  arch.target = a2;

  assert(fireOnce(w2), 'the archer never fired');
  assert(taken(a2) > 0, 'the archer missed its own target — the harness is broken');
  eq(taken(b2), 0, 'an arrow must hit exactly one body');
  eq(taken(c2), 0, 'an arrow must hit exactly one body');
});

// --- 2. Splash falls off with distance --------------------------------------

test('splash: damage falls off from the centre of the blast to its rim', () => {
  const w = field();
  const m = spawnUnit(w, 'mangonel', PLAYER, 20, 20);
  // The direct target, one body 0.7 tiles out, one body 1.3 tiles out — just
  // inside the 1.4 radius, so it takes the thinnest slice the blast gives.
  const centre = dummy(w, 'militia', ENEMY, 26, 20);
  const near = dummy(w, 'militia', ENEMY, 26.7, 20);
  const rim = dummy(w, 'militia', ENEMY, 27.3, 20);
  m.target = centre;

  assert(fireOnce(w), 'the mangonel never fired');
  const dc = taken(centre);
  const dn = taken(near);
  const dr = taken(rim);
  assert(dc > 0 && dn > 0 && dr > 0,
    `every body inside the radius must be hit: ${dc}/${dn}/${dr}`);
  assert(dc > dn, `the centre must take more than 0.7 tiles out: ${dc} vs ${dn}`);
  assert(dn > dr, `0.7 tiles out must take more than 1.3: ${dn} vs ${dr}`);
  // ...and the falloff is the declared one, not merely "less". At the rim a
  // mangonel's 14 becomes 0.4 of it before armour, which is 5.6 - 1 = 5.
  const s = UNIT_STATS.mangonel;
  const rimShare = 1 + (s.splashFalloff - 1) * (1.3 / s.splashRadius);
  eq(dr, Math.max(MIN_DAMAGE, Math.round(s.attack * rimShare - centre.armor)),
    'rim damage does not match the declared linear falloff');

  // THE CANARY. Three bodies the SAME distance from the impact point must take
  // the SAME damage. Without this, a test that simply saw three descending
  // numbers would also pass on an implementation that handed out damage by
  // arrival order, by id, or by nothing at all.
  const w2 = field();
  const m2 = spawnUnit(w2, 'mangonel', PLAYER, 20, 20);
  const hub = dummy(w2, 'militia', ENEMY, 26, 20);
  const left = dummy(w2, 'militia', ENEMY, 25.2, 20);
  const right = dummy(w2, 'militia', ENEMY, 26.8, 20);
  const up = dummy(w2, 'militia', ENEMY, 26, 19.2);
  m2.target = hub;

  assert(fireOnce(w2), 'the mangonel never fired');
  assert(taken(left) > 0, 'the equidistant control took no damage at all');
  eq(taken(left), taken(right), 'two bodies 0.8 tiles out took different damage');
  eq(taken(left), taken(up), 'distance, not direction, must decide the share');
  assert(taken(hub) > taken(left), 'the direct hit must still be the worst of them');
});

// --- 3. Splash catches your own men -----------------------------------------

test('splash: friendly fire is on — the blast does not care whose men they are', () => {
  const w = field();
  const m = spawnUnit(w, 'mangonel', PLAYER, 20, 20);
  const foe = dummy(w, 'militia', ENEMY, 26, 20);
  // One of ours standing beside the enemy, and one of ours standing well clear.
  const friendNear = dummy(w, 'militia', PLAYER, 26.6, 20);
  const friendFar = dummy(w, 'militia', PLAYER, 29, 20);
  // A second mangonel of ours, right in the blast. It is here to prove the
  // exemption below is "the unit that fired", not "mangonels".
  const friendEngine = dummy(w, 'mangonel', PLAYER, 25.4, 20);
  m.target = foe;

  assert(fireOnce(w), 'the mangonel never fired');
  assert(taken(foe) > 0, 'the enemy took nothing — the shot did not land');
  assert(taken(friendNear) > 0,
    'FRIENDLY FIRE IS THE BALANCING WEIGHT OF THIS UNIT: our militia beside the '
    + 'enemy must be hurt by our own boulder');
  assert(taken(friendEngine) > 0, 'our other mangonel in the blast must be hurt too');
  eq(taken(m), 0, 'a unit must never be hurt by its own shot');

  // THE CANARY. Our man three tiles away — outside the 1.4 radius — must be
  // untouched. Without it, "friendly fire works" would also be reported by an
  // implementation that damaged every friendly unit on the map, and by a
  // harness that had simply hurt everything.
  eq(taken(friendFar), 0,
    'a friendly unit outside the blast radius must not be scratched');
});

// --- 4. The boulder is thrown at a place ------------------------------------

test('splash: the shot lands where it was aimed, so a body that moves is missed', () => {
  const w = field();
  const m = spawnUnit(w, 'mangonel', PLAYER, 20, 20);
  const foe = dummy(w, 'militia', ENEMY, 26, 20);
  m.target = foe;
  // The instant the boulder is in the air, the target walks three tiles off —
  // well outside the blast it was aimed into.
  let jumped = false;
  w.events.on(EV.PROJECTILE, () => {
    if (jumped) return;
    jumped = true;
    foe.y = 23;
  });

  assert(fireOnce(w), 'the mangonel never fired');
  assert(jumped, 'the target never moved — this test measured nothing');
  eq(taken(foe), 0, 'a mangonel shoots at a spot; a body that leaves it is missed');

  // THE CANARY. An arrow does home, and hits the same target after the same
  // jump. So the miss above is a property of the splash weapon, not of the
  // harness moving units out of every projectile's way.
  const w2 = field();
  const arch = spawnUnit(w2, 'archer', PLAYER, 22, 20);
  const foe2 = dummy(w2, 'militia', ENEMY, 26, 20);
  arch.target = foe2;
  let jumped2 = false;
  w2.events.on(EV.PROJECTILE, () => {
    if (jumped2) return;
    jumped2 = true;
    foe2.y = 23;
  });

  assert(fireOnce(w2, 800), 'the archer never fired');
  assert(jumped2, 'the archer control never moved its target');
  assert(taken(foe2) > 0, 'an arrow steers after its quarry and connects');
});

// --- 5. Minimum range: refusing a target that is too close ------------------

test('minRange: a siege engine cannot fire at what is standing on it', () => {
  const w = field();
  const m = spawnUnit(w, 'mangonel', PLAYER, 20, 20);
  const close = dummy(w, 'militia', ENEMY, 21, 20);
  const far = dummy(w, 'militia', ENEMY, 25, 20);

  assert(tooClose(m, close), 'a militia one tile away is inside the minimum');
  assert(!inRange(m, close), 'and therefore cannot be fired at');
  // THE CANARY, half one: the same predicate on the same unit at a workable
  // distance. Without it, "cannot fire" would also be reported by an inRange
  // that had been broken into returning false for everything.
  assert(!tooClose(m, far), 'four tiles is outside the minimum');
  assert(inRange(m, far), 'and well inside the maximum');

  // A shot that is refused must actually be refused: with only the close body
  // on the map, no damage is ever dealt however long we wait.
  const w2 = field();
  const m2 = spawnUnit(w2, 'mangonel', PLAYER, 20, 20);
  const close2 = dummy(w2, 'militia', ENEMY, 21, 20);
  m2.target = close2;
  step(w2, 300); // fifteen seconds: three reloads' worth
  eq(taken(close2), 0, 'a mangonel must not damage a body inside its minimum range');
  eq(w2.projectiles.length, 0, 'and must not have thrown anything at it');

  // THE CANARY, half two: a scorpion's minimum is 1.5 rather than 2.0, so the
  // rule is read off the unit's own sheet and is not a constant baked into the
  // combat system. Both minima are measured surface to surface, exactly as the
  // maximum reach is, so the centre distance that separates them is
  //   mangonel  2.0 + 0.46 + 0.34 = 2.80
  //   scorpion  1.5 + 0.42 + 0.34 = 2.26
  // and two and a half tiles falls between the two.
  const sc = spawnUnit(w, 'scorpion', PLAYER, 20, 24);
  const at25 = dummy(w, 'militia', ENEMY, 22.5, 24);
  assert(tooClose(m, dummy(w, 'militia', ENEMY, 22.5, 20)),
    'a mangonel (min 2.0) refuses a body two and a half tiles away');
  assert(!tooClose(sc, at25), 'a scorpion (min 1.5) accepts the same distance');
});

test('minRange: it applies to men and never to masonry', () => {
  const w = field();
  const tc = spawnBuilding(w, 'towncenter', ENEMY, 30, 30);
  // Parked against the wall of the footprint — the exact case a minimum range
  // must not break, because knocking a building down at point-blank range is
  // the one thing the unit's name promises.
  const m = spawnUnit(w, 'mangonel', PLAYER, tc.x - tc.fw / 2 - 0.5, tc.y);
  assert(!tooClose(m, tc), 'a building is exempt from minimum range');
  assert(inRange(m, tc), 'so a mangonel at the wall may fire at the wall');
  eq(minAttackReach(m, tc), 0, 'there is no minimum reach against masonry at all');

  m.target = tc;
  assert(fireOnce(w), 'the mangonel never fired at the building');
  assert(tc.maxHp - tc.hp > 0, 'the Town Center took no damage from point-blank fire');

  // THE CANARY. A unit standing on the very same spot IS refused, so the
  // exemption above is about what is being shot at rather than about where the
  // mangonel happens to be standing.
  const man = dummy(w, 'militia', ENEMY, m.x + 0.4, m.y);
  assert(tooClose(m, man), 'a man at that distance is still inside the minimum');
  assert(minAttackReach(m, man) > 0, 'and a man does have a minimum reach');
});

test('minRange: nothing auto-acquires a target it could not shoot', () => {
  // A mangonel with a militia in its face and nothing else on the map must pick
  // no target at all. Picking one it cannot fire on is worse than picking none:
  // it is what would send the engine walking backwards away from a man it chose
  // over the archer line it could have hit.
  const w = field();
  const m = spawnUnit(w, 'mangonel', PLAYER, 20, 20);
  dummy(w, 'militia', ENEMY, 21, 20);
  step(w, 60);
  eq(m.target, null, 'a mangonel must not acquire a body inside its minimum range');

  // THE CANARY. The same mangonel, the same number of steps, one body four
  // tiles further out — which it does acquire. Without this the test would pass
  // just as happily against a mangonel that never acquires anything, or against
  // a harness that never ran the acquisition pass at all.
  const w2 = field();
  const m2 = spawnUnit(w2, 'mangonel', PLAYER, 20, 20);
  const far = dummy(w2, 'militia', ENEMY, 25, 20);
  step(w2, 60);
  eq(m2.target, far, 'a mangonel must acquire a body it can actually shoot');
});

// --- 6. Minimum range: backing away -----------------------------------------

test('minRange: an engine ordered onto a close target backs away, then fires', () => {
  const w = field();
  const m = spawnUnit(w, 'mangonel', PLAYER, 20, 20);
  const foe = dummy(w, 'militia', ENEMY, 21, 20);
  const startGap = dist(m.x, m.y, foe.x, foe.y);
  commandUnits(w, [m], { type: 'attack', target: foe });

  // Long enough to walk two tiles at 0.6 tiles a second and reload once.
  simStep(w, 240);
  const endGap = dist(m.x, m.y, foe.x, foe.y);
  assert(endGap > startGap + 1.0,
    `the mangonel must open the distance: ${startGap.toFixed(2)} -> ${endGap.toFixed(2)}`);
  assert(!tooClose(m, foe), 'and must end up outside its own minimum range');
  assert(taken(foe) > 0,
    'having backed off, it must then actually shoot the thing it was sent at');
  assert(m.target === foe, 'and must never have abandoned the order to do it');

  // THE CANARY. A militia given the identical order from the identical spot
  // closes instead. Two units, one order, opposite movement — which is the
  // whole claim, and it cannot be produced by a harness that simply fails to
  // move anything.
  const w2 = field();
  const inf = spawnUnit(w2, 'militia', PLAYER, 20, 20);
  const foe2 = dummy(w2, 'militia', ENEMY, 21, 20);
  const startGap2 = dist(inf.x, inf.y, foe2.x, foe2.y);
  commandUnits(w2, [inf], { type: 'attack', target: foe2 });
  simStep(w2, 240);
  const endGap2 = dist(inf.x, inf.y, foe2.x, foe2.y);
  assert(endGap2 <= startGap2,
    `a unit with no minimum range must not retreat: ${startGap2.toFixed(2)} -> ${endGap2.toFixed(2)}`);
  assert(taken(foe2) > 0, 'the control never landed a blow — it measured nothing');
});

// --- 7. The monk heals ------------------------------------------------------

test('monk: heals the most wounded friendly unit within reach', () => {
  const w = field();
  const monk = spawnUnit(w, 'monk', PLAYER, 10, 10);
  const badly = spawnUnit(w, 'militia', PLAYER, 11, 10);
  const lightly = spawnUnit(w, 'archer', PLAYER, 10, 11);
  const outOfReach = spawnUnit(w, 'militia', PLAYER, 10, 20);
  badly.hp = 10;
  lightly.hp = 30;
  outOfReach.hp = 5;

  // findPatient reads the spatial index, which is rebuilt per step — so it has
  // to be rebuilt here too, before a single step has run.
  reindex(w);
  eq(findPatient(w, monk), badly, 'the most wounded body in reach is the patient');

  let events = 0;
  let healed = 0;
  w.events.on(EV.HEAL, (p) => { events++; healed += p.amount; });

  step(w, 100); // five seconds at 2.0 hp/s
  assert(badly.hp > 10, `the wounded militia was not healed (hp ${badly.hp})`);
  assert(Math.abs((badly.hp - 10) - UNIT_STATS.monk.heal * 5) < 0.2,
    `healed ${(badly.hp - 10).toFixed(2)} in five seconds, expected about 10`);
  assert(events > 0, 'healing emitted no EV.HEAL for the FX layer to draw');
  assert(Math.abs(healed - (badly.hp - 10)) < 0.2,
    'the event stream does not add up to the hitpoints actually restored');
  eq(outOfReach.hp, 5, 'a body ten tiles away is not in a monk\'s reach');
  eq(lightly.hp, 30, 'and the less wounded body waits its turn');

  // THE CANARY. The identical arrangement with no monk in it. If hitpoints came
  // back on their own — a stray garrison heal, a regeneration rule, a harness
  // that reset units — this would rise too, and every number above would be
  // measuring that instead.
  const w2 = field();
  const badly2 = spawnUnit(w2, 'militia', PLAYER, 11, 10);
  badly2.hp = 10;
  step(w2, 100);
  eq(badly2.hp, 10, 'a wounded unit with no monk near it must not heal at all');
});

test('monk: never picks a fight, whatever is in front of it', () => {
  const w = field();
  const monk = spawnUnit(w, 'monk', PLAYER, 10, 10);
  const foe = dummy(w, 'militia', ENEMY, 11, 10);

  eq(UNIT_STATS.monk.attack, 0, 'the monk sheet must carry no attack');
  assert(!canAttack(monk, foe), 'canAttack must refuse an attacker with no attack');
  assert(healRateOf(monk) > 0, 'and the unit under test must be a healer');

  // Not by auto-acquisition...
  step(w, 100);
  eq(monk.target, null, 'a monk must never acquire a target');
  eq(taken(foe), 0, 'and must never deal damage');

  // ...and not when a target is forced onto it by hand, either. combat.js drops
  // any target canAttack refuses, on the next step.
  monk.target = foe;
  step(w, 4);
  eq(monk.target, null, 'a target set on a monk by hand must be dropped');
  eq(taken(foe), 0, 'and must still have cost the enemy nothing');

  // THE CANARY. A militia standing exactly where the monk stands, given exactly
  // the same steps, does fight — so the silence above is the monk's, not the
  // harness's.
  const w2 = field();
  spawnUnit(w2, 'militia', PLAYER, 10, 10);
  const foe2 = dummy(w2, 'militia', ENEMY, 11, 10);
  step(w2, 100);
  assert(taken(foe2) > 0, 'the control militia never swung — the harness is broken');
});

test('monk: heals standing still, not on the march', () => {
  const w = field();
  const monk = spawnUnit(w, 'monk', PLAYER, 10, 10);
  const hurt = spawnUnit(w, 'militia', PLAYER, 10.8, 10);
  hurt.hp = 20;

  // Sent across the map: it walks past the patient without mending it.
  commandUnits(w, [monk], { type: 'move', gx: 40, gy: 10 });
  simStep(w, 40);
  eq(monk.state, 'move', 'the monk should still be walking two seconds in');
  eq(hurt.hp, 20, 'a monk on the march heals nobody');

  // THE CANARY. Told to stop, in reach of the same patient, it mends. Same
  // world, same monk, same wounded militia — only the walking has changed.
  commandUnits(w, [monk], { type: 'stop' });
  monk.x = 10;
  monk.y = 10;
  simStep(w, 40);
  assert(hurt.hp > 20, `a stopped monk must heal (hp ${hurt.hp})`);
});

// --- 8. The monk never overheals --------------------------------------------

test('monk: healing stops dead at maxHp', () => {
  const w = field();
  const monk = spawnUnit(w, 'monk', PLAYER, 10, 10);
  const hurt = spawnUnit(w, 'militia', PLAYER, 11, 10);
  const rate = UNIT_STATS.monk.heal;
  // A hair below full, deliberately: the next tick would restore rate * dt and
  // land the unit ABOVE its maximum if nothing clamped it. That is the canary —
  // see the assertion under it — and it is what makes this test capable of
  // failing rather than merely capable of passing.
  const shortfall = rate * SIM_DT * 0.5;
  hurt.hp = hurt.maxHp - shortfall;
  assert(shortfall < rate * SIM_DT,
    'the setup must leave less missing than one tick of healing restores, or '
    + 'this test never exercises the clamp at all');

  let peak = hurt.hp;
  for (let i = 0; i < 200; i++) {
    step(w);
    if (hurt.hp > peak) peak = hurt.hp;
    assert(hurt.hp <= hurt.maxHp,
      `hp went above maxHp at step ${i}: ${hurt.hp} > ${hurt.maxHp}`);
  }
  eq(hurt.hp, hurt.maxHp, 'a fully mended unit sits exactly on its maximum');
  eq(peak, hurt.maxHp, 'and never went past it on the way');
  assert(monk.healTarget === null || monk.healTarget === undefined,
    'with nobody left to mend the monk should have no patient');

  // And the same claim over a long heal from very low, so the cap is not being
  // satisfied merely by the run being too short to reach it.
  const w2 = field();
  spawnUnit(w2, 'monk', PLAYER, 10, 10);
  const wreck = spawnUnit(w2, 'militia', PLAYER, 11, 10);
  wreck.hp = 1;
  for (let i = 0; i < 1200; i++) {
    step(w2);
    assert(wreck.hp <= wreck.maxHp,
      `hp went above maxHp at step ${i}: ${wreck.hp} > ${wreck.maxHp}`);
  }
  eq(wreck.hp, wreck.maxHp, 'a wreck mended for a minute ends exactly full');
  assert(wreck.maxHp > 1, 'the patient must actually have been wounded');
});

// --- report -----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}`);
  process.exit(1);
}
