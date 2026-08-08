// Headless tests for src/systems/vision.js.
//   node tests/vision.test.mjs
//
// Everything here runs on a bare world (no mapgen, no Phaser) with viewers
// placed by hand, so each assertion is about the fog and nothing else. The two
// that matter most are the last two: that the incremental mask agrees with a
// from-scratch recompute (the incremental path is the only one the game runs,
// so a drift in it would be invisible until somebody noticed a tile stuck
// bright), and that a full 150-viewer update fits in the 50ms sim budget many
// times over.

import { createWorld, spawnUnit, spawnBuilding, spawnResource, removeEntity } from '../src/core/world.js';
import { MAP_W, MAP_H, PLAYER, ENEMY } from '../src/core/constants.js';
import {
  unitLineOfSight, buildingLineOfSight, visionStats, resetVisionStats,
} from '../src/systems/vision.js';

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

// --- Helpers ----------------------------------------------------------------

const idx = (tx, ty) => ty * MAP_W + tx;

function blankWorld() {
  return createWorld(777);
}

/** A world with nothing in it but one villager, parked where you say. */
function loneVillager(gx, gy) {
  const w = blankWorld();
  const u = spawnUnit(w, 'villager', PLAYER, gx, gy);
  w.vision.update();
  return { w, u, st: w.vision.state(PLAYER) };
}

function countMask(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}

// --- Radii ------------------------------------------------------------------

test('unit line of sight is derived, and never shorter than the unit shoots', () => {
  eq(unitLineOfSight('villager'), 4, 'villager');
  eq(unitLineOfSight('militia'), 4, 'militia');
  // The archer's whole point: it must see further than range 4.5, or it would
  // auto-acquire targets the player cannot see.
  eq(unitLineOfSight('archer'), 6, 'archer');
  eq(unitLineOfSight('nonesuch'), 4, 'unknown types fall back rather than throw');
});

test('building line of sight includes half its footprint', () => {
  // Town Center: 8 in BUILDING_STATS, 3x3, so 8 + 1.
  eq(buildingLineOfSight('towncenter'), 9, 'towncenter');
  eq(buildingLineOfSight('house'), 5, 'house (4 + half of 2x2)');
});

// --- Basic reveal -----------------------------------------------------------

test('a tile within a unit radius becomes visible and explored', () => {
  const { u, st } = loneVillager(40.5, 40.5);
  const r = unitLineOfSight(u.type);

  assert(st.visible[idx(40, 40)], 'the tile the unit stands on is visible');
  assert(st.explored[idx(40, 40)], 'and explored');
  assert(st.visible[idx(40 + r, 40)], `a tile exactly ${r} away is visible`);
  assert(!st.visible[idx(40 + r + 1, 40)], 'one tile past the radius is not');
  assert(!st.explored[idx(40 + r + 1, 40)], 'and was never explored');

  // The disc is a disc, not a square: the corner of the bounding box is out.
  assert(!st.visible[idx(40 + r, 40 + r)], 'the bounding-box corner is not visible');
});

test('moving the unit away leaves the tile explored but not visible', () => {
  const { w, u, st } = loneVillager(40.5, 40.5);
  const home = idx(40, 40);
  assert(st.visible[home] && st.explored[home], 'seen to start with');

  u.x = 70.5;
  u.y = 70.5;
  w.vision.update();

  eq(st.visible[home], 0, 'the old tile is dark again');
  eq(st.explored[home], 1, 'but it stays explored forever');
  assert(st.visible[idx(70, 70)], 'and the new tile is lit');
});

test('overlapping viewers do not put out each others lights', () => {
  const w = blankWorld();
  const a = spawnUnit(w, 'villager', PLAYER, 40.5, 40.5);
  spawnUnit(w, 'villager', PLAYER, 42.5, 40.5);
  w.vision.update();
  const st = w.vision.state(PLAYER);
  const shared = idx(41, 40);
  assert(st.visible[shared], 'the tile between them is lit');

  a.x = 80.5;
  a.y = 80.5;
  w.vision.update();
  assert(st.visible[shared], 'and stays lit when only one of them walks away');
});

test('each player gets its own masks', () => {
  const w = blankWorld();
  spawnUnit(w, 'villager', PLAYER, 10.5, 10.5);
  spawnUnit(w, 'militia', ENEMY, 80.5, 80.5);
  w.vision.update();
  const mine = w.vision.state(PLAYER);
  const theirs = w.vision.state(ENEMY);
  assert(mine.visible[idx(10, 10)] && !mine.visible[idx(80, 80)],
    'I see my own corner and not theirs');
  assert(theirs.visible[idx(80, 80)] && !theirs.visible[idx(10, 10)],
    'and they see theirs and not mine');
});

test('a dead viewer takes its light with it', () => {
  const { w, u, st } = loneVillager(40.5, 40.5);
  assert(st.visible[idx(40, 40)], 'lit while alive');
  removeEntity(w, u);
  w.vision.update();
  eq(st.visible[idx(40, 40)], 0, 'dark once the unit is gone');
  eq(st.explored[idx(40, 40)], 1, 'still explored');
  eq(w.vision._viewers.size, 0, 'and the viewer cache does not leak the entry');
});

test('a viewer shoved off the map still sees from the edge', () => {
  const w = blankWorld();
  const u = spawnUnit(w, 'villager', PLAYER, 0.2, 0.2);
  u.x = -1.5;
  u.y = -1.5;
  w.vision.update();
  const st = w.vision.state(PLAYER);
  assert(st.visible[idx(0, 0)], 'the corner tile is lit rather than the disc vanishing');
});

// --- Memory -----------------------------------------------------------------

test('a resource seen and then left behind is remembered, not aliased', () => {
  const w = blankWorld();
  const u = spawnUnit(w, 'villager', PLAYER, 40.5, 40.5);
  const tree = spawnResource(w, 'tree', 41, 40);
  w.vision.update();
  const st = w.vision.state(PLAYER);
  eq(st.memory.length, 0, 'nothing is remembered while you are still looking at it');

  u.x = 80.5;
  u.y = 80.5;
  w.vision.update();

  const snap = w.vision.rememberedAt(PLAYER, 41, 40);
  assert(snap, 'the tree is remembered once it goes dark');
  eq(snap.type, 'tree', 'and remembered as a tree');
  eq(snap.amount, tree.amount, 'with the amount it had when you looked away');

  // The snapshot must not be the entity, nor hold a reference to it.
  assert(snap !== tree, 'the snapshot is not the live node');
  const before = snap.amount;
  tree.amount = 3;
  tree.x = 12;
  eq(snap.amount, before, 'chopping it out of sight does not shrink the memory');
  eq(snap.x, 41.5, 'and moving the live entity does not move the ghost');
  for (const v of Object.values(snap)) {
    assert(v !== tree, 'no field of the snapshot points at the live entity');
  }
});

test('a building destroyed out of sight keeps its ghost until you look again', () => {
  const w = blankWorld();
  const scout = spawnUnit(w, 'villager', PLAYER, 40.5, 40.5);
  const house = spawnBuilding(w, 'house', ENEMY, 42, 40);
  w.vision.update();
  const st = w.vision.state(PLAYER);

  // Walk away, so the house is committed to memory.
  scout.x = 80.5;
  scout.y = 80.5;
  w.vision.update();
  const snap = w.vision.rememberedAt(PLAYER, 41, 39);
  assert(snap, `the house is remembered (looked at tile 41,39)`);
  eq(snap.type, 'house', 'as a house');
  eq(snap.player, ENEMY, 'owned by the enemy');
  const rememberedHp = snap.hp;

  // Raze it while nobody is watching.
  house.hp = 0;
  removeEntity(w, house);
  w.vision.update();

  const still = w.vision.rememberedAt(PLAYER, 41, 39);
  assert(still, 'the ghost survives a demolition you did not witness');
  eq(still.hp, rememberedHp, 'at the hit points it had when you last saw it');
  eq(w.vision.state(PLAYER).memory.length, 1, 'exactly one ghost');

  // Go back and look. The ghost has to go.
  scout.x = 41.5;
  scout.y = 40.5;
  w.vision.update();
  eq(w.vision.rememberedAt(PLAYER, 41, 39), null, 'looking again clears the ghost');
  eq(w.vision.state(PLAYER).memory.length, 0, 'and nothing is left in the memory list');
});

test('a building destroyed in plain sight leaves no ghost at all', () => {
  const w = blankWorld();
  spawnUnit(w, 'villager', PLAYER, 41.5, 41.5);
  const house = spawnBuilding(w, 'house', ENEMY, 42, 40);
  w.vision.update();
  removeEntity(w, house);
  w.vision.update();
  eq(w.vision.state(PLAYER).memory.length, 0, 'you watched it fall, so you know');
});

test('a new building on a remembered tile replaces the old memory', () => {
  const w = blankWorld();
  const scout = spawnUnit(w, 'villager', PLAYER, 40.5, 40.5);
  const first = spawnBuilding(w, 'house', ENEMY, 42, 40);
  w.vision.update();
  scout.x = 80.5;
  scout.y = 80.5;
  w.vision.update();
  assert(w.vision.rememberedAt(PLAYER, 41, 39), 'house remembered');

  removeEntity(w, first);
  const second = spawnBuilding(w, 'mill', ENEMY, 42, 40);
  w.vision.update();
  eq(w.vision.rememberedAt(PLAYER, 41, 39).type, 'house', 'still the old ghost from here');

  scout.x = 41.5;
  scout.y = 40.5;
  w.vision.update();
  eq(w.vision.state(PLAYER).memory.length, 0, 'walking back replaces belief with fact');
  eq(second.dead, false, 'and the live mill is untouched');
});

// --- Incremental == from scratch --------------------------------------------

test('the incremental mask matches a from-scratch recompute', () => {
  // Property-style: a handful of random armies, each walked through a handful
  // of random relocations, checked against a clean rebuild every time. The
  // incremental path is the only one the game runs, so this is the assertion
  // that actually protects the feature.
  let seed = 20240808;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const types = ['villager', 'militia', 'archer'];

  for (let layout = 0; layout < 6; layout++) {
    const w = blankWorld();
    const units = [];
    for (let i = 0; i < 40; i++) {
      const player = i % 3 === 0 ? ENEMY : PLAYER;
      units.push(spawnUnit(
        w, types[i % types.length], player,
        rand() * MAP_W, rand() * MAP_H,
      ));
    }
    spawnBuilding(w, 'towncenter', PLAYER, 12, 12);
    spawnBuilding(w, 'barracks', ENEMY, 84, 84);
    w.vision.update();

    for (let round = 0; round < 5; round++) {
      for (const u of units) {
        if (rand() < 0.4) continue;
        u.x = Math.min(MAP_W - 0.01, Math.max(0, u.x + (rand() - 0.5) * 24));
        u.y = Math.min(MAP_H - 0.01, Math.max(0, u.y + (rand() - 0.5) * 24));
      }
      // Kill one off now and then, so viewer removal is exercised too.
      if (rand() < 0.5 && units.length > 5) {
        const victim = units.splice(Math.floor(rand() * units.length), 1)[0];
        removeEntity(w, victim);
      }
      w.vision.update();

      for (const p of [PLAYER, ENEMY]) {
        const inc = w.vision.state(p);
        const fresh = w.vision.recomputeFromScratch(p);
        for (let i = 0; i < inc.visible.length; i++) {
          if (inc.visible[i] !== fresh.visible[i]) {
            throw new Error(
              `layout ${layout} round ${round} player ${p}: tile ${i % MAP_W},${
                Math.floor(i / MAP_W)} is ${inc.visible[i]} incrementally and ` +
              `${fresh.visible[i]} from scratch`,
            );
          }
          if (inc.count[i] !== fresh.count[i]) {
            throw new Error(
              `layout ${layout} round ${round} player ${p}: viewer count drift at ` +
              `tile ${i}: ${inc.count[i]} vs ${fresh.count[i]}`,
            );
          }
        }
      }
    }
  }
});

test('explored only ever grows, and only where something has been visible', () => {
  const w = blankWorld();
  const u = spawnUnit(w, 'villager', PLAYER, 20.5, 20.5);
  w.vision.update();
  const st = w.vision.state(PLAYER);
  const seen = new Set();
  for (let i = 0; i < st.explored.length; i++) if (st.explored[i]) seen.add(i);

  for (let k = 0; k < 20; k++) {
    u.x = 20.5 + k * 3;
    w.vision.update();
    for (let i = 0; i < st.visible.length; i++) {
      if (st.visible[i]) seen.add(i);
      if (st.explored[i]) {
        assert(seen.has(i), `tile ${i} is explored but was never visible`);
      } else {
        assert(!seen.has(i), `tile ${i} was visible but is not explored`);
      }
    }
  }
});

// --- Performance ------------------------------------------------------------

test('a full update with 150 viewers is a fraction of the 50ms sim budget', () => {
  const w = blankWorld();
  // 150 viewers is the shape of a real late-game army plus its base: a hundred
  // and forty units spread over the map, plus the buildings that made them.
  for (let i = 0; i < 140; i++) {
    spawnUnit(
      w, ['villager', 'militia', 'archer'][i % 3], i % 2,
      2 + (i * 13) % (MAP_W - 4) + 0.5,
      2 + (i * 29) % (MAP_H - 4) + 0.5,
    );
  }
  for (let i = 0; i < 10; i++) {
    spawnBuilding(w, i % 2 ? 'house' : 'barracks', i % 2, 6 + i * 8, 6 + ((i * 5) % 80));
  }

  resetVisionStats();
  // The worst case the sim can ever ask for: every single viewer stamped in
  // from nothing, in one step.
  w.vision.update();
  const cold = visionStats.lastMs;

  // And the case it actually asks for twenty times a second: everybody has
  // moved a little, a fraction of them across a tile boundary.
  let warm = 0;
  for (let step = 0; step < 40; step++) {
    for (const u of w.units) {
      u.x = Math.min(MAP_W - 0.01, Math.max(0, u.x + 0.06));
      u.y = Math.min(MAP_H - 0.01, Math.max(0, u.y + 0.03));
    }
    w.vision.update();
    warm += visionStats.lastMs;
  }
  warm /= 40;

  console.log(
    `       cold rebuild ${cold.toFixed(3)}ms, steady state ${warm.toFixed(3)}ms/step, ` +
    `${visionStats.tileWrites} tile writes over ${visionStats.updates} updates`,
  );
  assert(cold < 12, `cold rebuild of 150 viewers took ${cold.toFixed(2)}ms (budget 50ms)`);
  assert(warm < 2, `steady-state update took ${warm.toFixed(3)}ms (budget 50ms)`);
});

test('a viewer that has not moved costs nothing at all', () => {
  const w = blankWorld();
  for (let i = 0; i < 100; i++) {
    spawnUnit(w, 'militia', PLAYER, 5 + (i % 40) + 0.5, 5 + Math.floor(i / 40) * 3 + 0.5);
  }
  w.vision.update();
  resetVisionStats();
  for (let i = 0; i < 20; i++) w.vision.update();
  eq(visionStats.tileWrites, 0, 'a still army writes no tiles');
  eq(visionStats.viewerAdds, 0, 'and stamps no discs');
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
  process.exit(1);
}
