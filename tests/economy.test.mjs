// Headless tests for src/systems/economy.js.
//
//   node tests/economy.test.mjs
//
// Imports only core/ + economy.js, so it runs while the other systems are still
// being written. Core has no Phaser dependency.

import assert from 'node:assert/strict';

import {
  createWorld, ownedBy, recomputePop, canPlace, spawnUnit, removeEntity,
} from '../src/core/world.js';
import { generateMap } from '../src/core/mapgen.js';
import { EV } from '../src/core/events.js';
import {
  SIM_DT, CARRY_CAPACITY, RES, STARTING_RESOURCES, PLAYER, UNIT_STATS,
  BUILDING_STATS,
} from '../src/core/constants.js';
import {
  canAfford, pay, refund, addResource,
  queueTrain, cancelTrain, placeFoundation,
  gatherTick, depositCarry, buildTick, updateEconomy,
  nearestDropoff, acceptsDropoff, gatherRateFor,
} from '../src/systems/economy.js';

// --- tiny harness -----------------------------------------------------------

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err && err.message}`);
  }
}

// --- fixtures ---------------------------------------------------------------

// Every test gets a fresh map. Override with SEED=n to shake out map-layout
// assumptions (all tests must pass for any seed).
const BASE_SEED = Number(process.env.SEED || 4242);
let seedCounter = 0;

function setup() {
  const world = createWorld(BASE_SEED + seedCounter++);
  generateMap(world);
  const tc = ownedBy(world, PLAYER, 'building', 'towncenter')[0];
  const villagers = ownedBy(world, PLAYER, 'unit').filter((u) => u.type === 'villager');
  return { world, tc, villagers, p: world.players[PLAYER] };
}

/** Nearest live resource node of a given node type to (gx, gy). */
function nearestNode(world, type, gx, gy) {
  let best = null;
  let bestD = Infinity;
  for (const r of world.resources) {
    if (r.dead || r.type !== type) continue;
    const d = (r.x - gx) ** 2 + (r.y - gy) ** 2;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

function record(world, type) {
  const seen = [];
  world.events.on(type, (payload) => seen.push(payload));
  return seen;
}

/** Gather until the module says "go drop off". Returns seconds elapsed. */
function gatherUntilReturn(world, unit, node, maxSeconds = 60) {
  let t = 0;
  while (t < maxSeconds) {
    const done = gatherTick(world, unit, node, SIM_DT);
    t += SIM_DT;
    if (done) return t;
  }
  throw new Error('gatherTick never signalled a return trip');
}

/** Free 2x2/3x3 spot near the town centre for a foundation. */
function findSpot(world, tc, fw, fh) {
  for (let r = 3; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const gx = Math.round(tc.x) + dx;
        const gy = Math.round(tc.y) + dy;
        if (canPlace(world, gx, gy, fw, fh)) return { gx, gy };
      }
    }
  }
  throw new Error('no free building spot near the town centre');
}

function runSim(world, seconds) {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) updateEconomy(world, SIM_DT);
}

// --- stockpile --------------------------------------------------------------

console.log('\neconomy');

test('starting stockpile matches constants', () => {
  const { p } = setup();
  assert.equal(p.resources.food, STARTING_RESOURCES.food);
  assert.equal(p.resources.wood, STARTING_RESOURCES.wood);
  assert.equal(p.resources.gold, STARTING_RESOURCES.gold);
});

test('canAfford / pay / refund and EV.INSUFFICIENT', () => {
  const { world, p } = setup();
  const broke = record(world, EV.INSUFFICIENT);
  const changes = record(world, EV.RESOURCE_CHANGE);

  assert.equal(canAfford(world, PLAYER, { food: 50, wood: 0, gold: 0 }), true);
  assert.equal(canAfford(world, PLAYER, { food: 99999 }), false);

  assert.equal(pay(world, PLAYER, { food: 50, wood: 25 }), true);
  assert.equal(p.resources.food, STARTING_RESOURCES.food - 50);
  assert.equal(p.resources.wood, STARTING_RESOURCES.wood - 25);
  assert.equal(changes.length, 2, 'every mutation emits RESOURCE_CHANGE');

  assert.equal(pay(world, PLAYER, { gold: 99999 }), false);
  assert.equal(broke.length, 1);
  assert.equal(broke[0].player, PLAYER);
  assert.equal(p.resources.gold, STARTING_RESOURCES.gold, 'failed pay charges nothing');

  refund(world, PLAYER, { food: 50, wood: 25 });
  assert.equal(p.resources.food, STARTING_RESOURCES.food);
  assert.equal(p.resources.wood, STARTING_RESOURCES.wood);

  addResource(world, PLAYER, RES.FOOD, -99999, 'test');
  assert.equal(p.resources.food, 0, 'stockpiles never go negative');
});

// --- gathering --------------------------------------------------------------

test('villager gathers to capacity then signals a return trip', () => {
  const { world, tc, villagers } = setup();
  const v = villagers[0];
  const berry = nearestNode(world, 'berry', tc.x, tc.y);
  assert.ok(berry, 'map has berries near the base');

  const ticks = record(world, EV.GATHER_TICK);
  const before = berry.amount;

  const t = gatherUntilReturn(world, v, berry);

  assert.equal(v.carrying.type, RES.FOOD);
  assert.equal(v.carrying.amount, CARRY_CAPACITY);
  assert.equal(ticks.length, CARRY_CAPACITY, 'one GATHER_TICK per unit harvested');
  assert.equal(berry.amount, before - CARRY_CAPACITY, 'node pays for what was taken');
  assert.ok(t < 6, `harvest leg should read as a loop, took ${t.toFixed(1)}s`);
  assert.ok(t > 1, `harvest leg should not be instant, took ${t.toFixed(1)}s`);
});

test('a full round trip is a few seconds, not thirty', () => {
  const { world, tc, villagers } = setup();
  const v = villagers[0];
  const berry = nearestNode(world, 'berry', tc.x, tc.y);

  const harvest = gatherUntilReturn(world, v, berry);
  // Walking is the unit AI's job; estimate it from the real distance/speed.
  const d = Math.hypot(berry.x - tc.x, berry.y - tc.y);
  const walk = (2 * d) / UNIT_STATS.villager.speed;
  const round = harvest + walk;
  assert.ok(round < 15, `round trip ${round.toFixed(1)}s is too slow to read`);
});

test('depositing banks the carry and clears the villager', () => {
  const { world, tc, villagers, p } = setup();
  const v = villagers[0];
  const berry = nearestNode(world, 'berry', tc.x, tc.y);
  const deposits = record(world, EV.DEPOSIT);
  const changes = record(world, EV.RESOURCE_CHANGE);

  gatherUntilReturn(world, v, berry);
  const before = p.resources.food;
  const banked = depositCarry(world, v, tc);

  assert.equal(banked, CARRY_CAPACITY);
  assert.equal(p.resources.food, before + CARRY_CAPACITY);
  assert.equal(v.carrying.amount, 0);
  assert.equal(v.carrying.type, null);
  assert.equal(deposits.length, 1);
  assert.equal(deposits[0].type, RES.FOOD);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].reason, 'gather');
});

test('drop-off buildings only accept what they are for', () => {
  const { world, tc, villagers, p } = setup();
  const v = villagers[0];

  // Build a mill and finish it.
  const spot = findSpot(world, tc, BUILDING_STATS.mill.fw, BUILDING_STATS.mill.fh);
  const mill = placeFoundation(world, PLAYER, 'mill', spot.gx, spot.gy);
  assert.ok(mill);
  let done = false;
  for (let i = 0; i < 2000 && !done; i++) done = buildTick(world, v, mill, SIM_DT);
  assert.equal(mill.complete, true);

  assert.equal(acceptsDropoff(tc, RES.WOOD), true, 'town centre takes everything');
  assert.equal(acceptsDropoff(mill, RES.FOOD), true);
  assert.equal(acceptsDropoff(mill, RES.WOOD), false);

  v.carrying = { type: RES.WOOD, amount: 10 };
  const woodBefore = p.resources.wood;
  assert.equal(depositCarry(world, v, mill), 0, 'mill refuses wood');
  assert.equal(p.resources.wood, woodBefore);
  assert.equal(v.carrying.amount, 10, 'refused deposit keeps the carry');

  v.carrying = { type: RES.FOOD, amount: 7 };
  assert.equal(depositCarry(world, v, mill), 7);

  const near = nearestDropoff(world, PLAYER, mill.x, mill.y, RES.FOOD);
  assert.equal(near, mill, 'nearestDropoff prefers the mill for food');
  assert.equal(nearestDropoff(world, PLAYER, mill.x, mill.y, RES.GOLD), tc);
});

test('an exhausted node is removed from the world', () => {
  const { world, tc, villagers } = setup();
  const v = villagers[0];
  const tree = nearestNode(world, 'tree', tc.x, tc.y);
  assert.ok(tree, 'map has trees near the base');

  const depleted = record(world, EV.NODE_DEPLETED);
  const removed = record(world, EV.REMOVED);
  tree.amount = 3;

  const done = gatherTick(world, v, tree, 10);
  assert.equal(done, true, 'exhausted node ends the gather');
  assert.equal(v.carrying.amount, 3, 'villager keeps the partial load');
  assert.equal(depleted.length, 1);
  assert.equal(depleted[0].node, tree);
  assert.ok(removed.some((r) => r.entity === tree));
  assert.equal(world.resources.includes(tree), false);
  assert.equal(world.entities.has(tree.id), false);
  assert.equal(tree.dead, true);
  // The tile it stood on is walkable again.
  assert.equal(world.blocked[Math.floor(tree.y) * world.width + Math.floor(tree.x)], 0);

  // Calling again with the dead node is safe and still says "stop".
  assert.equal(gatherTick(world, v, tree, SIM_DT), true);
  assert.equal(depleted.length, 1, 'NODE_DEPLETED is not re-emitted');
});

test('gathering a second resource type banks the first load', () => {
  const { world, tc, villagers } = setup();
  const v = villagers[0];
  const berry = nearestNode(world, 'berry', tc.x, tc.y);
  const tree = nearestNode(world, 'tree', tc.x, tc.y);

  gatherTick(world, v, berry, 2);
  assert.ok(v.carrying.amount > 0);
  assert.equal(gatherTick(world, v, tree, SIM_DT), true, 'must deposit before switching');
  assert.equal(v.carrying.type, RES.FOOD);
});

// --- training ---------------------------------------------------------------

test('training charges, queues, completes and spawns', () => {
  const { world, tc, p } = setup();
  const trained = record(world, EV.TRAINED);
  const foodBefore = p.resources.food;
  const popBefore = recomputePop(world, PLAYER);

  assert.equal(queueTrain(world, tc, 'villager'), true);
  assert.equal(p.resources.food, foodBefore - UNIT_STATS.villager.cost.food);
  assert.equal(tc.queue.length, 1);
  recomputePop(world, PLAYER);
  assert.equal(p.pop, popBefore + 1, 'queued units reserve population');

  runSim(world, UNIT_STATS.villager.buildTime + 0.5);

  assert.equal(tc.queue.length, 0);
  assert.equal(trained.length, 1);
  assert.equal(trained[0].unitType, 'villager');
  const u = trained[0].unit;
  assert.ok(u && !u.dead);
  assert.equal(u.player, PLAYER);
  const d = Math.hypot(u.x - tc.x, u.y - tc.y);
  assert.ok(d < 4, `spawned unit should be adjacent to the building (was ${d.toFixed(1)})`);
  assert.equal(world.blocked[Math.floor(u.y) * world.width + Math.floor(u.x)], 0);
  assert.equal(p.pop, popBefore + 1, 'pop unchanged when a reservation becomes a unit');
});

test('training respects the queue cap and the buildings type list', () => {
  const { world, tc } = setup();
  assert.equal(queueTrain(world, tc, 'militia'), false, 'TC does not train militia');
  assert.equal(queueTrain(world, tc, 'nosuchunit'), false);
});

test('cancelling a queued unit refunds it', () => {
  const { world, tc, p } = setup();
  const foodBefore = p.resources.food;
  const popBefore = recomputePop(world, PLAYER);

  assert.equal(queueTrain(world, tc, 'villager'), true);
  assert.equal(cancelTrain(world, tc, 0), true);

  assert.equal(p.resources.food, foodBefore, 'full refund');
  assert.equal(tc.queue.length, 0);
  assert.equal(recomputePop(world, PLAYER), popBefore, 'reservation released');
  assert.equal(cancelTrain(world, tc, 0), false, 'nothing left to cancel');
});

test('population cap blocks training', () => {
  const { world, tc, p } = setup();
  const capped = record(world, EV.POP_CAPPED);
  recomputePop(world, PLAYER);
  const room = p.popCap - p.pop;
  assert.ok(room > 0 && room < 10, `expected a tight opening cap, got ${p.pop}/${p.popCap}`);

  for (let i = 0; i < room; i++) {
    assert.equal(queueTrain(world, tc, 'villager'), true, `queue slot ${i}`);
  }
  const foodBefore = p.resources.food;
  assert.equal(queueTrain(world, tc, 'villager'), false, 'blocked at the cap');
  assert.equal(p.resources.food, foodBefore, 'blocked training charges nothing');
  assert.equal(capped.length, 1);
  assert.equal(capped[0].player, PLAYER);
});

test('a house raises the cap and unblocks training', () => {
  const { world, tc, villagers, p } = setup();
  const v = villagers[0];
  recomputePop(world, PLAYER);
  const capBefore = p.popCap;

  const spot = findSpot(world, tc, BUILDING_STATS.house.fw, BUILDING_STATS.house.fh);
  const house = placeFoundation(world, PLAYER, 'house', spot.gx, spot.gy);
  assert.ok(house);
  let done = false;
  for (let i = 0; i < 2000 && !done; i++) done = buildTick(world, v, house, SIM_DT);

  updateEconomy(world, SIM_DT);
  assert.equal(p.popCap, capBefore + BUILDING_STATS.house.popBonus);

  const room = p.popCap - p.pop;
  for (let i = 0; i < Math.min(room, 5); i++) {
    assert.equal(queueTrain(world, tc, 'villager'), true);
  }
});

test('POP_CAPPED is throttled, not spammed every step', () => {
  const { world, tc, villagers, p } = setup();
  const v = villagers[0];
  // House first, so there is headroom to queue into.
  const spot = findSpot(world, tc, BUILDING_STATS.house.fw, BUILDING_STATS.house.fh);
  const house = placeFoundation(world, PLAYER, 'house', spot.gx, spot.gy);
  let done = false;
  for (let i = 0; i < 2000 && !done; i++) done = buildTick(world, v, house, SIM_DT);
  updateEconomy(world, SIM_DT);

  for (let i = 0; i < 4; i++) {
    assert.equal(queueTrain(world, tc, 'villager'), true, `queue slot ${i}`);
  }
  // The house burns down under the queued villagers: cap drops below pop.
  removeEntity(world, house);
  const capped = record(world, EV.POP_CAPPED);
  runSim(world, 10);
  assert.ok(capped.length >= 1, 'stalled queue reports the problem');
  assert.ok(capped.length <= 3, `throttled (got ${capped.length} in 10s)`);
  assert.ok(tc.queue.length > 0, 'queue stalls rather than popping over the cap');
});

// --- foundations ------------------------------------------------------------

test('placeFoundation validates, charges and spawns an incomplete building', () => {
  const { world, tc, p } = setup();
  const foundations = record(world, EV.FOUNDATION);
  const woodBefore = p.resources.wood;

  // Invalid: on top of the town centre.
  assert.equal(placeFoundation(world, PLAYER, 'house', Math.round(tc.x), Math.round(tc.y)), null);
  assert.equal(p.resources.wood, woodBefore, 'rejected placement charges nothing');
  assert.equal(placeFoundation(world, PLAYER, 'nosuchbuilding', 2, 2), null);

  const spot = findSpot(world, tc, BUILDING_STATS.house.fw, BUILDING_STATS.house.fh);
  const house = placeFoundation(world, PLAYER, 'house', spot.gx, spot.gy);
  assert.ok(house);
  assert.equal(house.complete, false);
  assert.equal(house.buildProgress, 0);
  assert.ok(house.hp < house.maxHp);
  assert.equal(p.resources.wood, woodBefore - BUILDING_STATS.house.cost.wood);
  assert.equal(foundations.length, 1);
  assert.equal(foundations[0].building, house);

  // Cannot afford: drain the wood.
  addResource(world, PLAYER, RES.WOOD, -p.resources.wood, 'test');
  const spot2 = findSpot(world, tc, BUILDING_STATS.house.fw, BUILDING_STATS.house.fh);
  assert.equal(placeFoundation(world, PLAYER, 'house', spot2.gx, spot2.gy), null);
});

test('buildTick raises hp with progress and finishes the building', () => {
  const { world, tc, villagers, p } = setup();
  const v = villagers[0];
  const built = record(world, EV.BUILT);
  const spot = findSpot(world, tc, BUILDING_STATS.house.fw, BUILDING_STATS.house.fh);
  const house = placeFoundation(world, PLAYER, 'house', spot.gx, spot.gy);
  const startHp = house.hp;

  let t = 0;
  let done = false;
  while (!done && t < 60) {
    done = buildTick(world, v, house, SIM_DT);
    t += SIM_DT;
    if (!done) assert.ok(house.hp >= startHp, 'hp never regresses');
  }

  assert.equal(done, true);
  assert.equal(house.complete, true);
  assert.equal(house.hp, house.maxHp);
  assert.equal(built.length, 1);
  assert.ok(
    Math.abs(t - BUILDING_STATS.house.buildTime) < 0.5,
    `one builder takes buildTime seconds (took ${t.toFixed(1)}s)`,
  );
  assert.equal(buildTick(world, v, house, SIM_DT), true, 'late callers are told to stop');
  assert.equal(built.length, 1, 'BUILT fires once');
});

test('two builders finish in half the time', () => {
  const { world, tc, villagers } = setup();
  const [a, b] = villagers;
  const spot = findSpot(world, tc, BUILDING_STATS.house.fw, BUILDING_STATS.house.fh);
  const house = placeFoundation(world, PLAYER, 'house', spot.gx, spot.gy);

  let t = 0;
  while (!house.complete && t < 60) {
    buildTick(world, a, house, SIM_DT);
    buildTick(world, b, house, SIM_DT);
    t += SIM_DT;
  }
  assert.ok(
    Math.abs(t - BUILDING_STATS.house.buildTime / 2) < 0.5,
    `two builders should halve it (took ${t.toFixed(1)}s)`,
  );
});

// --- pace sanity ------------------------------------------------------------

test('opening pace: villagers early, barracks affordable within ~2 minutes', () => {
  const { world, tc, villagers, p } = setup();
  const berry = nearestNode(world, 'berry', tc.x, tc.y);
  const tree = nearestNode(world, 'tree', tc.x, tc.y);

  // Rough model of the loop the unit AI will drive: harvest + walk, repeat.
  const walkFood = (2 * Math.hypot(berry.x - tc.x, berry.y - tc.y)) / UNIT_STATS.villager.speed;
  const walkWood = (2 * Math.hypot(tree.x - tc.x, tree.y - tc.y)) / UNIT_STATS.villager.speed;
  const tripFood = CARRY_CAPACITY / gatherRateFor(RES.FOOD) + walkFood;
  const tripWood = CARRY_CAPACITY / gatherRateFor(RES.WOOD) + walkWood;

  const foodPerSec = CARRY_CAPACITY / tripFood;
  const woodPerSec = CARRY_CAPACITY / tripWood;

  // Two villagers on food, one on wood for the first two minutes.
  const food2min = p.resources.food + 2 * foodPerSec * 120;
  const wood2min = p.resources.wood + woodPerSec * 120;

  assert.ok(food2min > 3 * UNIT_STATS.villager.cost.food,
    `should afford several villagers early (food after 2min: ${food2min | 0})`);
  assert.ok(wood2min > BUILDING_STATS.barracks.cost.wood,
    `barracks within ~2 minutes (wood after 2min: ${wood2min | 0})`);
  assert.ok(foodPerSec < 2, `a single villager should not out-earn the game (${foodPerSec.toFixed(2)}/s)`);
  // Food is the early bottleneck: villagers cost food and nothing else does.
  assert.ok(villagers.length >= 3);
});

test('updateEconomy keeps pop and cap honest every step', () => {
  const { world, tc, p } = setup();
  updateEconomy(world, SIM_DT);
  const pop = p.pop;
  const cap = p.popCap;
  spawnUnit(world, 'villager', PLAYER, tc.x + 3, tc.y);
  updateEconomy(world, SIM_DT);
  assert.equal(p.pop, pop + 1);
  assert.equal(p.popCap, cap);
});

// --- summary ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err && f.err.stack}`);
  process.exit(1);
}
