// Headless tests for src/systems/unitAI.js.
//   node tests/units.test.mjs
//
// These run the real economy and combat modules, stepped exactly the way
// GameScene.simStep() does, so what passes here is what happens in the game.

import { SIM_DT, PLAYER, ENEMY, CARRY_CAPACITY } from '../src/core/constants.js';
import {
  createWorld, spawnUnit, spawnBuilding, spawnResource, setBlocked, reindex,
  removeEntity, recomputePop,
} from '../src/core/world.js';
import { EV } from '../src/core/events.js';
import { generateMap } from '../src/core/mapgen.js';
import { updateEconomy, queueTrain, placeFoundation } from '../src/systems/economy.js';
import { updateCombat } from '../src/systems/combat.js';
import { commandUnits, updateUnits, isIdle } from '../src/systems/unitAI.js';

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

/** One fixed step, in the same order as GameScene.simStep(). */
function step(world, n = 1) {
  for (let i = 0; i < n; i++) {
    for (const u of world.units) { u.px = u.x; u.py = u.y; }
    reindex(world);
    updateUnits(world, SIM_DT);
    updateCombat(world, SIM_DT);
    updateEconomy(world, SIM_DT);
    world.time += SIM_DT;
    world.tick++;
  }
}

/** Step until `pred` holds; returns the number of steps, or -1 on timeout. */
function stepUntil(world, maxSteps, pred) {
  for (let i = 0; i < maxSteps; i++) {
    step(world);
    if (pred(world, i)) return i + 1;
  }
  return -1;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** A bare world: flat walkable ground, no map generation. */
function blankWorld() {
  const w = createWorld(777);
  reindex(w);
  return w;
}

function wall(world, x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) setBlocked(world, x, y, 1, 999);
  }
}

/** A minimal base: Town Center, one tree, one villager. */
function baseWorld() {
  const w = blankWorld();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 10, 10);
  const tree = spawnResource(w, 'tree', 16, 10);
  const vil = spawnUnit(w, 'villager', PLAYER, 12.5, 12.5);
  recomputePop(w, PLAYER);
  reindex(w);
  return { w, tc, tree, vil };
}

console.log('unitAI');

// --- Movement ---------------------------------------------------------------

test('a move order registers on the very first step', () => {
  const w = blankWorld();
  const u = spawnUnit(w, 'villager', PLAYER, 5.5, 5.5);
  reindex(w);
  commandUnits(w, [u], { type: 'move', gx: 20.5, gy: 5.5 });
  eq(u.state, 'move', 'state must flip to move immediately, before any step');
  const x0 = u.x;
  step(w);
  assert(u.x > x0 + 0.05, `unit should have moved on step 1 (moved ${(u.x - x0).toFixed(3)})`);
  eq(u.facing, 7, 'facing should point along +x');
});

test('a unit arrives on time and stops cleanly', () => {
  const w = blankWorld();
  const u = spawnUnit(w, 'villager', PLAYER, 5.5, 5.5);
  reindex(w);
  const goal = { x: 25.5, y: 5.5 };
  commandUnits(w, [u], { type: 'move', gx: goal.x, gy: goal.y });

  // 20 tiles at 1.5 tiles/sec = 13.3s. Allow 20% slack for steering.
  const expected = Math.ceil((20 / u.speed) / SIM_DT);
  const used = stepUntil(w, Math.ceil(expected * 1.2), (_, i) => dist(u, goal) < 0.2);
  assert(used > 0, 'unit never arrived');
  assert(used >= expected * 0.95, `arrived impossibly fast (${used} steps vs ${expected})`);

  // ...and then holds still, without oscillating around the goal.
  stepUntil(w, 40, () => isIdle(u));
  const at = { x: u.x, y: u.y };
  step(w, 40);
  assert(dist(u, at) < 1e-6, 'unit drifted after arriving');
  eq(u.state, 'idle', 'state should return to idle');
  eq(u.vx, 0, 'velocity should be zero at rest');
  assert(isIdle(u), 'an arrived unit with no job is idle');
});

test('a unit walks around an obstacle rather than into it', () => {
  const w = blankWorld();
  wall(w, 12, 0, 12, 20);   // wall with a gap below y=20
  const u = spawnUnit(w, 'villager', PLAYER, 6.5, 6.5);
  reindex(w);
  const goal = { x: 18.5, y: 6.5 };
  commandUnits(w, [u], { type: 'move', gx: goal.x, gy: goal.y });

  let wentAround = false;
  const used = stepUntil(w, 1200, () => {
    if (u.y > 20) wentAround = true;
    assert(w.blocked[Math.floor(u.y) * w.width + Math.floor(u.x)] === 0, 'unit entered a blocked tile');
    return dist(u, goal) < 0.3;
  });
  assert(used > 0, 'unit never got around the wall');
  assert(wentAround, 'unit should have detoured around the end of the wall');
});

test('an unreachable order stops instead of grinding forever', () => {
  const w = blankWorld();
  wall(w, 30, 30, 36, 30);
  wall(w, 30, 36, 36, 36);
  wall(w, 30, 30, 30, 36);
  wall(w, 36, 30, 36, 36);
  const u = spawnUnit(w, 'villager', PLAYER, 6.5, 6.5);
  reindex(w);
  commandUnits(w, [u], { type: 'move', gx: 33.5, gy: 33.5 });
  step(w, 900); // 45 seconds
  assert(isIdle(u), 'unit should have given up and gone idle');
  assert(u.x > 6.5, 'it should still have walked as close as it could');
});

test('a group order spreads into a block instead of stacking', () => {
  const w = blankWorld();
  const units = [];
  for (let i = 0; i < 9; i++) {
    units.push(spawnUnit(w, 'villager', PLAYER, 4.5 + (i % 3) * 0.7, 4.5 + Math.floor(i / 3) * 0.7));
  }
  reindex(w);
  const goal = { x: 24.5, y: 24.5 };
  commandUnits(w, units, { type: 'move', gx: goal.x, gy: goal.y });
  step(w, 900);

  for (const u of units) {
    assert(dist(u, goal) < 4.0, `unit ended ${dist(u, goal).toFixed(2)} tiles from the rally point`);
    assert(isIdle(u), 'every unit in the group should have arrived and settled');
  }
  // Nobody sharing a spot.
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const d = dist(units[i], units[j]);
      assert(d > 0.5, `units ${i} and ${j} are stacked (${d.toFixed(2)} apart)`);
    }
  }
  // And nobody vibrating in place.
  const before = units.map((u) => ({ x: u.x, y: u.y }));
  step(w, 60);
  for (let i = 0; i < units.length; i++) {
    assert(dist(units[i], before[i]) < 0.05, 'settled units must not jitter');
  }
});

test('units do not get shoved into walls by their neighbours', () => {
  const w = blankWorld();
  wall(w, 10, 0, 10, 47);
  const units = [];
  for (let i = 0; i < 6; i++) units.push(spawnUnit(w, 'villager', PLAYER, 9.5, 20.5));
  reindex(w);
  step(w, 200);
  for (const u of units) {
    assert(w.blocked[Math.floor(u.y) * w.width + Math.floor(u.x)] === 0, 'a unit was pushed into the wall');
    assert(u.x >= 0 && u.x < w.width && u.y >= 0 && u.y < w.height, 'a unit was pushed off the map');
  }
});

// --- Gathering --------------------------------------------------------------

test('gather runs the full loop: walk, harvest, deposit, walk back', () => {
  const { w, tree, vil } = baseWorld();
  const wood0 = w.players[PLAYER].resources.wood;

  commandUnits(w, [vil], { type: 'gather', target: tree });
  eq(vil.state, 'move', 'the order registers at once');

  const seen = new Set();
  const toGather = stepUntil(w, 600, () => { seen.add(vil.state); return vil.state === 'gather'; });
  assert(toGather > 0, 'villager never reached the tree');
  assert(dist(vil, tree) <= 1.75, 'villager should be standing next to the tree');

  const toFull = stepUntil(w, 600, () => vil.carrying.amount >= CARRY_CAPACITY);
  assert(toFull > 0, 'villager never filled up');

  const toDeposit = stepUntil(w, 600, () => { seen.add(vil.state); return vil.state === 'deposit'; });
  assert(toDeposit > 0, 'villager never reached the drop-off');
  const wood1 = w.players[PLAYER].resources.wood;
  assert(wood1 > wood0, `stockpile should have grown (${wood0} -> ${wood1})`);
  eq(vil.carrying.amount, 0, 'pack should be empty after depositing');

  // ...and goes straight back to the same tree.
  const back = stepUntil(w, 600, () => vil.state === 'gather');
  assert(back > 0, 'villager did not return to work');
  eq(vil.task.node, tree, 'should return to the same tree');
  assert(!isIdle(vil), 'a working villager is never idle');

  assert(seen.has('move') && seen.has('gather') && seen.has('deposit'),
    `expected the full state loop, saw ${[...seen].join(',')}`);
});

test('the loop keeps banking wood over time without stalling', () => {
  const { w, vil } = baseWorld();
  const wood0 = w.players[PLAYER].resources.wood;
  step(w, 1200); // one minute
  const wood1 = w.players[PLAYER].resources.wood;
  assert(wood1 === wood0, 'no order was given, so nothing should be gathered');

  const tree = w.resources[0];
  commandUnits(w, [vil], { type: 'gather', target: tree });
  step(w, 1200);
  const wood2 = w.players[PLAYER].resources.wood;
  // A trip is ~3s of harvesting plus ~8 tiles of walking: at least 3 trips/min.
  assert(wood2 >= wood0 + 3 * CARRY_CAPACITY,
    `expected several full trips in 60s, banked ${wood2 - wood0}`);
  assert(!isIdle(vil), 'the villager should still be working');
});

test('several villagers on one tree take their own tiles', () => {
  const { w, tree } = baseWorld();
  tree.amount = 2000; // a whole woodline's worth, so it outlives the test
  const vils = [];
  for (let i = 0; i < 4; i++) vils.push(spawnUnit(w, 'villager', PLAYER, 12.5 + i * 0.4, 13.5));
  reindex(w);
  commandUnits(w, vils, { type: 'gather', target: tree });

  // Record where each villager first settles down to chop.
  const spots = new Map();
  const all = stepUntil(w, 600, () => {
    for (const v of vils) {
      if (v.state === 'gather' && !spots.has(v.id)) {
        spots.set(v.id, { tile: `${Math.floor(v.x)},${Math.floor(v.y)}`, d: dist(v, tree) });
      }
    }
    return spots.size === vils.length;
  });
  assert(all > 0, `only ${spots.size}/${vils.length} villagers reached the tree`);
  for (const [id, s] of spots) {
    assert(s.d <= 1.5, `villager ${id} chopped from ${s.d.toFixed(2)} tiles away`);
  }
  const tiles = new Set([...spots.values()].map((s) => s.tile));
  eq(tiles.size, vils.length, 'each villager should chop from its own tile');
});

test('tapping a tree that runs dry retasks to the nearest equivalent node', () => {
  const { w, tree, vil } = baseWorld();
  const spare = spawnResource(w, 'tree', 18, 12);
  reindex(w);
  tree.amount = 4; // nearly exhausted

  commandUnits(w, [vil], { type: 'gather', target: tree });
  const gone = stepUntil(w, 900, () => tree.dead);
  assert(gone > 0, 'the tree should have been exhausted');

  const retasked = stepUntil(w, 900, () => vil.task && vil.task.node === spare);
  assert(retasked > 0, 'villager should have moved onto the spare tree');
  const working = stepUntil(w, 900, () => vil.state === 'gather');
  assert(working > 0, 'villager should be harvesting again');
  assert(!isIdle(vil), 'it must not be left standing around');
});

test('a villager whose only node vanishes banks its load and goes idle', () => {
  const { w, tree, vil } = baseWorld();
  commandUnits(w, [vil], { type: 'gather', target: tree });
  stepUntil(w, 600, () => vil.carrying.amount > 3);
  const carried = vil.carrying.amount;
  const wood0 = w.players[PLAYER].resources.wood;

  removeEntity(w, tree); // e.g. it was chopped by someone else
  reindex(w);
  const banked = stepUntil(w, 900, () => w.players[PLAYER].resources.wood >= wood0 + carried);
  assert(banked > 0, 'the villager should still bank what it is carrying');
  const idled = stepUntil(w, 300, () => isIdle(vil));
  assert(idled > 0, 'with nothing left to gather it should report idle for the HUD');
});

test('gather uses the nearest drop-off, not always the Town Center', () => {
  const { w, tree, vil } = baseWorld();
  const mill = spawnBuilding(w, 'mill', PLAYER, 19, 14);
  reindex(w);
  const berry = spawnResource(w, 'berry', 20, 12);
  reindex(w);
  commandUnits(w, [vil], { type: 'gather', target: berry });
  let bankedAt = null;
  w.events.on(EV.DEPOSIT, ({ building }) => { bankedAt = bankedAt || building; });
  const dropped = stepUntil(w, 1200, () => bankedAt !== null);
  assert(dropped > 0, 'villager never deposited');
  eq(bankedAt, mill, 'food should go to the nearby Mill');
});

// --- Building ---------------------------------------------------------------

test('a builder walks to the foundation, finishes it, then finds work', () => {
  const { w, vil } = baseWorld();
  const tree = w.resources[0];
  const site = placeFoundation(w, PLAYER, 'house', 14, 14);
  assert(site && !site.complete, 'foundation should have been placed');
  reindex(w);

  commandUnits(w, [vil], { type: 'build', target: site });
  const building = stepUntil(w, 600, () => vil.state === 'build');
  assert(building > 0, 'builder never started building');

  const done = stepUntil(w, 900, () => site.complete);
  assert(done > 0, 'the house was never finished');

  // AoE2: the builder does not stand around afterwards.
  const working = stepUntil(w, 900, () => vil.task && vil.task.type === 'gather');
  assert(working > 0, 'builder should pick up the nearest resource job');
  assert(vil.task.node === tree || vil.task.node, 'it should target a real node');
});

test('two builders both contribute and both move on when it is done', () => {
  const { w } = baseWorld();
  const a = spawnUnit(w, 'villager', PLAYER, 12.5, 14.5);
  const b = spawnUnit(w, 'villager', PLAYER, 13.5, 14.5);
  const site = placeFoundation(w, PLAYER, 'house', 15, 15);
  reindex(w);
  commandUnits(w, [a, b], { type: 'build', target: site });
  const done = stepUntil(w, 600, () => site.complete);
  assert(done > 0, 'the pair never finished the house');
  step(w, 20);
  assert(a.state !== 'build' && b.state !== 'build', 'both should have stopped building');
});

// --- Combat interplay -------------------------------------------------------

test('an attack order walks the unit into range and hands off to combat', () => {
  const w = blankWorld();
  const me = spawnUnit(w, 'militia', PLAYER, 6.5, 6.5);
  const foe = spawnUnit(w, 'villager', ENEMY, 20.5, 6.5);
  reindex(w);
  const hp0 = foe.hp;
  commandUnits(w, [me], { type: 'attack', target: foe });
  eq(me.target, foe, 'target must be set the instant the order is given');

  const engaged = stepUntil(w, 900, () => me.state === 'attack');
  assert(engaged > 0, 'never closed to melee range');
  const hurt = stepUntil(w, 300, () => foe.hp < hp0 || foe.dead);
  assert(hurt > 0, 'combat should be dealing the damage');
  assert(me.aiMoved < 1e-6, 'an in-range attacker should be standing still');
});

test('an archer stops at its own range instead of walking into the enemy', () => {
  const w = blankWorld();
  const archer = spawnUnit(w, 'archer', PLAYER, 6.5, 6.5);
  const foe = spawnBuilding(w, 'house', ENEMY, 24, 6);
  reindex(w);
  commandUnits(w, [archer], { type: 'attack', target: foe });
  const engaged = stepUntil(w, 900, () => archer.state === 'attack');
  assert(engaged > 0, 'archer never engaged');
  const gap = Math.abs(archer.x - foe.x) - foe.fw / 2;
  assert(gap > 1.5, `archer walked too close (${gap.toFixed(2)} tiles from the wall)`);
});

test('a unit killed mid-order leaves no dangling task', () => {
  const w = blankWorld();
  const me = spawnUnit(w, 'militia', PLAYER, 6.5, 6.5);
  const foe = spawnUnit(w, 'villager', ENEMY, 12.5, 6.5);
  reindex(w);
  commandUnits(w, [me], { type: 'attack', target: foe });
  const over = stepUntil(w, 1200, () => foe.dead);
  assert(over > 0, 'the fight never resolved');
  step(w, 10);
  eq(me.task, null, 'task should be cleared when the target dies');
  eq(me.target, null, 'target should be cleared when the target dies');
  assert(me.state === 'idle' || me.state === 'attack', `unexpected state ${me.state}`);
});

// --- Orders, idleness, rally ------------------------------------------------

test('stop cancels everything and leaves the unit idle', () => {
  const { w, tree, vil } = baseWorld();
  commandUnits(w, [vil], { type: 'gather', target: tree });
  step(w, 10);
  assert(!isIdle(vil), 'should be busy');
  commandUnits(w, [vil], { type: 'stop' });
  eq(vil.task, null, 'task cleared');
  assert(isIdle(vil), 'stopped unit is idle');
  const at = { x: vil.x, y: vil.y };
  step(w, 40);
  assert(dist(vil, at) < 1e-6, 'a stopped unit should not wander');
});

test('isIdle tracks the whole lifecycle of an order', () => {
  const w = blankWorld();
  const u = spawnUnit(w, 'villager', PLAYER, 5.5, 5.5);
  reindex(w);
  assert(isIdle(u), 'a fresh unit with no orders is idle');
  commandUnits(w, [u], { type: 'move', gx: 12.5, gy: 5.5 });
  assert(!isIdle(u), 'a unit under orders is not idle');
  step(w, 5);
  assert(!isIdle(u), 'still walking, still not idle');
  stepUntil(w, 400, () => isIdle(u));
  assert(isIdle(u), 'idle again once it arrives');
});

test('commandUnits accepts ids, sets and entities alike', () => {
  const w = blankWorld();
  const a = spawnUnit(w, 'villager', PLAYER, 5.5, 5.5);
  const b = spawnUnit(w, 'villager', PLAYER, 6.5, 5.5);
  reindex(w);
  commandUnits(w, new Set([a.id, b.id]), { type: 'move', gx: 15.5, gy: 15.5 });
  assert(a.task && b.task, 'both units should have been ordered');
  commandUnits(w, a, { type: 'stop' });
  eq(a.task, null, 'a bare entity is a valid target too');
  // Junk must not throw.
  commandUnits(w, [null, 12345, b], { type: 'stop' });
  eq(b.task, null, 'the real unit in the list still got the order');
});

test('a trained unit walks to the rally point', () => {
  const w = blankWorld();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 10, 10);
  tc.rally = { x: 22.5, y: 18.5 };
  recomputePop(w, PLAYER);
  reindex(w);
  step(w, 1); // let unitAI subscribe before economy emits

  assert(queueTrain(w, tc, 'villager'), 'training should have been queued');
  const trained = stepUntil(w, 400, () => w.units.length > 0);
  assert(trained > 0, 'no villager was produced');
  const u = w.units[0];
  assert(u.task && u.task.type === 'move', 'the new villager should be walking to the rally point');
  const arrived = stepUntil(w, 900, () => dist(u, tc.rally) < 1.0);
  assert(arrived > 0, `the villager never reached the rally point (stopped at ${u.x.toFixed(1)},${u.y.toFixed(1)})`);
  assert(!u.pendingRally, 'pendingRally should be consumed');
});

test('a new building across a path makes units re-plan, not freeze', () => {
  const w = blankWorld();
  const u = spawnUnit(w, 'villager', PLAYER, 5.5, 20.5);
  reindex(w);
  commandUnits(w, [u], { type: 'move', gx: 40.5, gy: 20.5 });
  step(w, 60);
  // Drop a long wall in front of it, mid-walk.
  wall(w, 15, 0, 15, 34);
  reindex(w);
  const arrived = stepUntil(w, 2000, () => dist(u, { x: 40.5, y: 20.5 }) < 0.5);
  assert(arrived > 0, 'the unit should have re-planned around the new wall');
});

// --- Real map integration ---------------------------------------------------

test('on a generated map the opening villagers work without getting stuck', () => {
  const w = createWorld(31337);
  generateMap(w);
  reindex(w);
  const vils = w.units.filter((u) => u.player === PLAYER && u.type === 'villager');
  eq(vils.length, 3, 'the map should start three villagers');

  // Send each to the nearest node, the way a player opens a game.
  for (const v of vils) {
    const node = w.resources
      .filter((n) => !n.dead)
      .sort((a, b) => dist(a, v) - dist(b, v))[0];
    commandUnits(w, [v], { type: 'gather', target: node });
  }

  const before = { ...w.players[PLAYER].resources };
  const stuckSteps = new Map(vils.map((v) => [v.id, 0]));
  for (let i = 0; i < 2400; i++) { // two minutes
    const at = vils.map((v) => ({ x: v.x, y: v.y }));
    step(w);
    vils.forEach((v, k) => {
      // "Standing still" is only suspicious when it is not working or waiting.
      const still = dist(v, at[k]) < 1e-4 && v.state === 'move';
      stuckSteps.set(v.id, still ? stuckSteps.get(v.id) + 1 : 0);
    });
    for (const v of vils) {
      assert(stuckSteps.get(v.id) < 60, `villager ${v.id} froze while moving at ${v.x.toFixed(1)},${v.y.toFixed(1)}`);
      assert(
        w.blocked[Math.floor(v.y) * w.width + Math.floor(v.x)] === 0,
        `villager ${v.id} ended up inside a blocked tile`,
      );
    }
  }

  const after = w.players[PLAYER].resources;
  const gained = (after.food - before.food) + (after.wood - before.wood) + (after.gold - before.gold);
  assert(gained > 100, `two minutes of three villagers should bank plenty (got ${gained})`);
  for (const v of vils) assert(!isIdle(v), `villager ${v.id} was left with nothing to do`);
});

// --- Cost -------------------------------------------------------------------

test('a busy crowd stays well inside the sim step budget', () => {
  const w = blankWorld();
  spawnBuilding(w, 'towncenter', PLAYER, 6, 6);
  for (let i = 0; i < 30; i++) spawnResource(w, 'tree', 30 + (i % 6), 10 + Math.floor(i / 6));
  const vils = [];
  for (let i = 0; i < 40; i++) {
    vils.push(spawnUnit(w, 'villager', PLAYER, 8.5 + (i % 8) * 0.6, 8.5 + Math.floor(i / 8) * 0.6));
  }
  reindex(w);
  for (const v of vils) {
    commandUnits(w, [v], { type: 'gather', target: w.resources[Math.floor(Math.random() * w.resources.length)] });
  }
  const t0 = Date.now();
  const STEPS = 1200; // a full minute: long enough for the round trip to land
  step(w, STEPS);
  const ms = Date.now() - t0;
  const perStep = ms / STEPS;
  assert(perStep < 5, `${perStep.toFixed(2)}ms per sim step with 40 workers is too slow`);
  console.log(`       40 villagers, ${STEPS} steps: ${ms}ms total, ${perStep.toFixed(2)}ms/step`);
  const wood = w.players[PLAYER].resources.wood;
  assert(wood > 250, `the crowd should still be banking wood (had ${wood})`);
  const stranded = vils.filter((v) => isIdle(v));
  assert(stranded.length === 0, `${stranded.length} villagers were left standing idle`);
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
  process.exit(1);
}
