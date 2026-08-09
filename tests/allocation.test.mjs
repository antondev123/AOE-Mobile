// Headless tests for src/systems/allocation.js — the villager allocation manager.
//
//   node tests/allocation.test.mjs
//
// Two things are being proved here, and the second matters more than the first.
// One: the manager actually moves villagers until the split is met. Two: it then
// STOPS. A manager that converges on average but issues an order every pass has
// villagers permanently in transit, which is worse than no manager at all —
// every one of those walks is a round trip of income thrown away.

import assert from 'node:assert/strict';

import {
  createWorld, ownedBy, spawnUnit, spawnResource, spawnBuilding, removeEntity,
} from '../src/core/world.js';
import { generateMap } from '../src/core/mapgen.js';
import { PLAYER, SIM_DT } from '../src/core/constants.js';
import {
  ALLOC_ORDER, DEFAULT_SPLIT, ALLOC_TICK, RETASK_COOLDOWN, DEADBAND,
  allocationState, allocationCounts, allocationPass, apportion,
  getSplit, setSplit, resetSplit, setAllocationOn, isAllocationOn,
  jobResourceOf, manageable, updateAllocation,
} from '../src/systems/allocation.js';
import { updateUnits, commandUnits } from '../src/systems/unitAI.js';
import { updateEconomy } from '../src/systems/economy.js';

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

const BASE_SEED = Number(process.env.SEED || 4242);
let seedCounter = 0;

function setup() {
  const world = createWorld(BASE_SEED + seedCounter++);
  generateMap(world);
  const tc = ownedBy(world, PLAYER, 'building', 'towncenter')[0];
  return { world, tc };
}

/** Run the simulation for `secs` of game time, systems and all. */
function run(world, secs) {
  const steps = Math.round(secs / SIM_DT);
  for (let i = 0; i < steps; i++) {
    updateAllocation(world, SIM_DT);
    updateUnits(world, SIM_DT);
    updateEconomy(world, SIM_DT);
    world.time += SIM_DT;
    world.tick++;
  }
}

/** Extra villagers around the Town Center, so the split has bodies to work with. */
function staff(world, tc, n) {
  const made = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.max(1, Math.min(world.width - 2, tc.x + Math.cos(a) * 3));
    const y = Math.max(1, Math.min(world.height - 2, tc.y + Math.sin(a) * 3));
    made.push(spawnUnit(world, 'villager', PLAYER, x, y));
  }
  return made;
}

/**
 * Guarantee every resource is reachable near the base. Maps are generated, and
 * a seed with no stone within twenty tiles would make "20% on stone" a claim
 * about the map rather than about the manager.
 */
function seedNodes(world, tc) {
  const free = (tx, ty) =>
    tx > 0 && ty > 0 && tx < world.width - 1 && ty < world.height - 1 &&
    world.blocked[ty * world.width + tx] === 0 &&
    world.terrain[ty * world.width + tx] !== 2;

  const made = [];
  // Three of each, in its own quadrant, on whatever free ground is nearest to
  // the base in that direction. Hunting for the ground rather than naming tiles
  // is what makes the fixture survive every map seed — a hand-picked tile is a
  // tree stump on one seed in five.
  const dirs = [['berry', 1, 0], ['tree', -1, 0], ['gold', 0, 1], ['stone', 0, -1]];
  for (const [type, ux, uy] of dirs) {
    let placed = 0;
    for (let r = 4; r <= 20 && placed < 3; r++) {
      for (let off = -2; off <= 2 && placed < 3; off++) {
        const tx = Math.round(tc.x) + ux * r + (ux ? 0 : off);
        const ty = Math.round(tc.y) + uy * r + (uy ? 0 : off);
        if (!free(tx, ty)) continue;
        made.push(spawnResource(world, type, tx, ty));
        placed++;
      }
    }
  }
  return made;
}

// --- The split itself --------------------------------------------------------

test('the four shares always total 100, whatever you drag', () => {
  const { world } = setup();
  const sum = (s) => ALLOC_ORDER.reduce((n, k) => n + s[k], 0);
  assert.equal(sum(getSplit(world)), 100);
  assert.equal(sum(setSplit(world, PLAYER, 'wood', 70)), 100);
  assert.equal(sum(setSplit(world, PLAYER, 'food', 100)), 100);
  assert.equal(sum(setSplit(world, PLAYER, 'stone', 33)), 100);
  assert.equal(sum(setSplit(world, PLAYER, 'gold', 0)), 100);
  assert.equal(sum(resetSplit(world, PLAYER)), 100);
});

test('the slider you dragged lands on exactly what you asked for', () => {
  const { world } = setup();
  assert.equal(setSplit(world, PLAYER, 'wood', 70).wood, 70);
  assert.equal(setSplit(world, PLAYER, 'gold', 5).gold, 5);
  assert.equal(setSplit(world, PLAYER, 'food', 0).food, 0);
});

test('everything at 100% leaves the other three at nothing', () => {
  const { world } = setup();
  const s = setSplit(world, PLAYER, 'food', 100);
  assert.deepEqual(s, { food: 100, wood: 0, gold: 0, stone: 0 });
  // ...and dragging one of the zeroed sliders back up still totals 100.
  const t = setSplit(world, PLAYER, 'stone', 40);
  assert.equal(t.stone, 40);
  assert.equal(ALLOC_ORDER.reduce((n, k) => n + t[k], 0), 100);
});

test('the others keep their proportions when one is dragged', () => {
  const { world } = setup();
  setSplit(world, PLAYER, 'food', 40);   // 40 / 40 / 13 / 7 -ish
  const before = getSplit(world);
  const after = setSplit(world, PLAYER, 'food', 20);
  // wood was 3.3x stone before; it must still be far bigger after.
  assert.ok(after.wood > after.stone * 2,
    `wood ${after.wood} vs stone ${after.stone} (was ${before.wood} vs ${before.stone})`);
});

test('apportionment adds up exactly, with no fractional villagers', () => {
  for (const n of [0, 1, 2, 3, 7, 17, 41]) {
    const got = apportion(n, DEFAULT_SPLIT);
    const sum = ALLOC_ORDER.reduce((s, k) => s + got[k], 0);
    assert.equal(sum, n, `${n} villagers apportioned to ${sum}`);
    for (const k of ALLOC_ORDER) assert.ok(Number.isInteger(got[k]) && got[k] >= 0);
  }
});

test('apportionment only uses the resources it is given', () => {
  const got = apportion(10, DEFAULT_SPLIT, ['food', 'wood']);
  assert.equal(got.food + got.wood, 10);
  assert.equal(got.gold, 0);
  assert.equal(got.stone, 0);
});

// --- Off by default, and genuinely off ---------------------------------------

test('the manager is off until it is switched on, and moves nobody meanwhile', () => {
  const { world, tc } = setup();
  seedNodes(world, tc);
  staff(world, tc, 8);
  assert.equal(isAllocationOn(world, PLAYER), false);
  run(world, 8);
  assert.equal(allocationState(world, PLAYER).moves, 0);
});

test('switching it off leaves everybody exactly where they are', () => {
  const { world, tc } = setup();
  seedNodes(world, tc);
  staff(world, tc, 10);
  setAllocationOn(world, PLAYER, true);
  run(world, 20);
  const before = allocationState(world, PLAYER).moves;
  assert.ok(before > 0, 'the manager did something while it was on');
  setAllocationOn(world, PLAYER, false);
  const jobs = manageable(world, PLAYER).map((u) => `${u.id}:${jobResourceOf(u)}`);
  run(world, 20);
  assert.equal(allocationState(world, PLAYER).moves, before, 'no orders after switching off');
  const after = manageable(world, PLAYER).map((u) => `${u.id}:${jobResourceOf(u)}`);
  // Villagers still retask themselves when a bush runs out — that is unitAI, not
  // us — so this only asserts the manager stopped issuing orders, and that most
  // of the workforce is untouched by the switch itself.
  const same = after.filter((s) => jobs.includes(s)).length;
  assert.ok(same >= Math.floor(jobs.length * 0.7), `${same} of ${jobs.length} unchanged`);
});

// --- It moves villagers to match the split -----------------------------------

test('villagers end up split roughly the way the sliders ask', () => {
  const { world, tc } = setup();
  seedNodes(world, tc);
  staff(world, tc, 9); // 12 with the three the map starts you with
  setAllocationOn(world, PLAYER, true);
  setSplit(world, PLAYER, 'food', 25);
  setSplit(world, PLAYER, 'wood', 25);
  setSplit(world, PLAYER, 'gold', 25);
  setSplit(world, PLAYER, 'stone', 25);

  run(world, 90);
  const c = allocationCounts(world, PLAYER);
  for (const k of ALLOC_ORDER) {
    assert.ok(Math.abs(c.assigned[k] - c.desired[k]) <= DEADBAND + 1,
      `${k}: ${c.assigned[k]} working against ${c.desired[k]} wanted ` +
      `(${JSON.stringify(c.assigned)} vs ${JSON.stringify(c.desired)})`);
  }
  assert.equal(c.idle, 0, 'nobody left standing about');
});

test('a lopsided split really is lopsided — 70% on wood puts most of them on wood', () => {
  const { world, tc } = setup();
  seedNodes(world, tc);
  staff(world, tc, 9);
  setAllocationOn(world, PLAYER, true);
  setSplit(world, PLAYER, 'wood', 70);
  run(world, 120);
  const c = allocationCounts(world, PLAYER);
  assert.ok(c.assigned.wood >= c.desired.wood - DEADBAND,
    `${c.assigned.wood} on wood, ${c.desired.wood} wanted of ${c.total}`);
  assert.ok(c.assigned.wood > c.total / 2, `${c.assigned.wood} of ${c.total} on wood`);
});

// --- ...and then stops. The whole point. -------------------------------------

test('once it is balanced the manager issues no further orders', () => {
  const { world, tc } = setup();
  seedNodes(world, tc);
  staff(world, tc, 9);
  setAllocationOn(world, PLAYER, true);
  run(world, 120);

  const settled = allocationState(world, PLAYER).moves;
  run(world, 60);
  const churn = allocationState(world, PLAYER).moves - settled;
  // A minute is thirty passes. Anything above a couple of orders is the
  // treadmill this whole file exists to rule out; the allowance covers a bush
  // running dry under somebody and the replacement being on a different pile.
  assert.ok(churn <= 3, `${churn} orders in the minute after it settled`);
});

test('a villager the manager just moved is left alone for a round trip', () => {
  const { world, tc } = setup();
  seedNodes(world, tc);
  staff(world, tc, 9);
  const st = allocationState(world, PLAYER);
  setAllocationOn(world, PLAYER, true);
  run(world, 4);
  const moved = [...st.cooldown.entries()].filter(([, t]) => t > world.time);
  assert.ok(moved.length > 0, 'somebody was moved');
  for (const [, until] of moved) {
    assert.ok(until - world.time <= RETASK_COOLDOWN + 0.01,
      'the cooldown is one round trip, not longer');
  }
  // Flip the split hard the other way and take one pass: the villagers still
  // inside their cooldown must not be the ones that move.
  const frozen = new Set(moved.map(([id]) => id));
  setSplit(world, PLAYER, 'stone', 90);
  const before = new Map(manageable(world, PLAYER).map((u) => [u.id, jobResourceOf(u)]));
  allocationPass(world, PLAYER);
  for (const u of manageable(world, PLAYER)) {
    if (!frozen.has(u.id)) continue;
    assert.equal(jobResourceOf(u), before.get(u.id),
      `villager ${u.id} was re-tasked inside its cooldown`);
  }
});

test('one villager out of place is left alone; two are not', () => {
  const { world, tc } = setup();
  const nodes = seedNodes(world, tc);
  const vills = [...ownedBy(world, PLAYER, 'unit', 'villager'), ...staff(world, tc, 5)];
  const wood = nodes.find((n) => n.type === 'tree');
  const berry = nodes.find((n) => n.type === 'berry');
  assert.ok(wood && berry, 'the fixture has both a tree and a bush');

  // Eight villagers, a 50/50 food/wood split: four and four is the target. The
  // two shares being zeroed go first — each drag rebalances the *others*, so
  // asking for 50% food while gold and stone still hold a share does not leave
  // wood on 50.
  setSplit(world, PLAYER, 'gold', 0);
  setSplit(world, PLAYER, 'stone', 0);
  setSplit(world, PLAYER, 'food', 50);
  assert.deepEqual(getSplit(world), { food: 50, wood: 50, gold: 0, stone: 0 });
  setAllocationOn(world, PLAYER, true);

  const n = vills.length;
  const onFood = Math.ceil(n / 2) + 1; // one too many on food
  vills.forEach((u, i) => {
    const node = i < onFood ? berry : wood;
    commandUnits(world, [u], { type: 'gather', target: node, gx: node.x, gy: node.y });
  });
  const st = allocationState(world, PLAYER);
  st.cooldown.clear();
  st.moves = 0;
  allocationPass(world, PLAYER);
  assert.equal(st.moves, 0, 'one villager out of place is inside the deadband');

  // Now two too many.
  commandUnits(world, [vills[onFood]], { type: 'gather', target: berry, gx: berry.x, gy: berry.y });
  st.cooldown.clear();
  allocationPass(world, PLAYER);
  assert.ok(st.moves > 0, 'two out of place is worth a walk');
});

test('a resource with nobody on it at all is always worth opening', () => {
  const { world, tc } = setup();
  const nodes = seedNodes(world, tc);
  const vills = [...ownedBy(world, PLAYER, 'unit', 'villager'), ...staff(world, tc, 3)];
  const berry = nodes.find((n) => n.type === 'berry');
  const tree = nodes.find((n) => n.type === 'tree');
  assert.ok(berry && tree);

  // Six villagers, three on food and three on wood, and a split that asks for
  // 40/40/0/20. The stone target is one and the deficit is exactly one — inside
  // the deadband on the arithmetic — but a stone line that does not exist is
  // producing nothing at all, so it must still be opened.
  vills.forEach((u, i) => {
    const node = i % 2 === 0 ? berry : tree;
    commandUnits(world, [u], { type: 'gather', target: node, gx: node.x, gy: node.y });
  });
  setSplit(world, PLAYER, 'gold', 0);
  setSplit(world, PLAYER, 'stone', 20);
  setAllocationOn(world, PLAYER, true);
  const st = allocationState(world, PLAYER);
  st.cooldown.clear();
  st.moves = 0;
  const before = allocationCounts(world, PLAYER);
  assert.equal(before.assigned.stone, 0);
  assert.equal(before.desired.stone - before.assigned.stone, DEADBAND,
    `stone is exactly ${DEADBAND} villager short — the deadband case`);
  allocationPass(world, PLAYER);
  const c = allocationCounts(world, PLAYER);
  assert.ok(c.assigned.stone >= 1, `${c.assigned.stone} on stone after one pass`);
});

test('a resource the map cannot offer has its share handed to the others', () => {
  const { world, tc } = setup();
  const nodes = seedNodes(world, tc);
  staff(world, tc, 7);
  // Take every stone mine off the map.
  for (const n of world.resources.slice()) if (n.type === 'stone') removeEntity(world, n);
  assert.equal(world.resources.some((n) => n.type === 'stone'), false);

  setSplit(world, PLAYER, 'stone', 50);
  setAllocationOn(world, PLAYER, true);
  const c = allocationCounts(world, PLAYER);
  assert.equal(c.desired.stone, 0, 'nobody is reserved for a resource that is gone');
  assert.equal(ALLOC_ORDER.reduce((s, k) => s + c.desired[k], 0), c.total,
    'and the whole workforce is still accounted for');
  run(world, 40);
  assert.equal(allocationCounts(world, PLAYER).idle, 0, 'nobody stands about waiting for stone');
  assert.ok(nodes.length > 0);
});

test('builders are never poached off a construction site', () => {
  const { world, tc } = setup();
  seedNodes(world, tc);
  const vills = [...ownedBy(world, PLAYER, 'unit', 'villager'), ...staff(world, tc, 6)];
  const site = spawnBuilding(world, 'house', PLAYER, Math.round(tc.x) + 4, Math.round(tc.y) + 4,
    { complete: false });
  const builders = vills.slice(0, 3);
  commandUnits(world, builders, { type: 'build', target: site });
  setAllocationOn(world, PLAYER, true);
  // One pass only: over a longer run they legitimately finish the house and go
  // back to gathering, which is exactly what they should do.
  allocationPass(world, PLAYER);
  for (const u of builders) {
    assert.equal(u.task && u.task.type, 'build', `villager ${u.id} was pulled off the house`);
  }
  const pool = manageable(world, PLAYER).map((u) => u.id);
  for (const u of builders) assert.equal(pool.includes(u.id), false, 'builders are out of the pool');
});

test('a whole pass is cheap enough to run every two seconds', () => {
  const { world, tc } = setup();
  seedNodes(world, tc);
  staff(world, tc, 40);
  setAllocationOn(world, PLAYER, true);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) allocationPass(world, PLAYER);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
  assert.ok(ms < 8, `${ms.toFixed(2)}ms per pass with 43 villagers`);
  assert.ok(ALLOC_TICK >= 1);
});

// --- summary ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err && f.err.stack}`);
  process.exit(1);
}
