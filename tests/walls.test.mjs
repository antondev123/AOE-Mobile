// Headless tests for castles, walls and gates.
//
//   node tests/walls.test.mjs
//
// No Phaser, no renderer: everything here is the simulation half of the wall
// pass — the neighbour mask that decides which of the sixteen sprites a segment
// wears, per-player gate passability checked through the *real* A*, the
// charging rules for a drag-drawn run, and the Castle's age gate and stone bill.
//
// Garrisoning is deliberately not tested here: combat.js owns it end to end
// (the volley, the healing, the refusal rules) and tests/military.test.mjs is
// where it belongs. What this file holds down is the wall pass's half of that
// contract — that the Castle and the tower *declare* an attack, a range, a
// cooldown and a capacity, and carry the mutable state a volley ticks.
//
// The one thing these tests will not catch is whether the sixteen sprites
// actually meet up on screen. That is a question only a screenshot can answer,
// and screenshots/walls-*.png is where it was answered.

import assert from 'node:assert/strict';

import {
  createWorld, spawnUnit, spawnBuilding, removeEntity, setBlocked, reindex,
  wallMaskAt, setGateOpen,
  WALL_N, WALL_E, WALL_S, WALL_W, BLOCK_GATE,
} from '../src/core/world.js';
import { generateMap } from '../src/core/mapgen.js';
import { EV } from '../src/core/events.js';
import {
  PLAYER, ENEMY, BUILDING_STATS, isWallType, isGateType,
} from '../src/core/constants.js';
import {
  findPath, isWalkable, pointsSealedBy,
} from '../src/systems/pathfinding.js';
import {
  placeFoundation, placeWallLine, planWallLine, wallLineTiles, buildTick,
  updateGates,
} from '../src/systems/economy.js';
import { completeResearch, currentAge, AGE } from '../src/systems/tech.js';

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

const BASE_SEED = Number(process.env.SEED || 909090);
let seedCounter = 0;

/**
 * A completely bare world: no map generation at all, so there is not a tree or
 * a Town Center anywhere and every blocked tile in the assertions below is one
 * this file put there. Walls are about the tile grid, and a generated map is
 * noise on top of it.
 */
function bareWorld() {
  const world = createWorld(BASE_SEED + seedCounter++);
  // Enough of everything that nothing under test is refused for being poor.
  for (const p of world.players) {
    p.resources.food = 2000;
    p.resources.wood = 2000;
    p.resources.gold = 2000;
    p.resources.stone = 2000;
  }
  return world;
}

function generatedWorld() {
  const world = createWorld(BASE_SEED + seedCounter++);
  generateMap(world);
  return world;
}

/** Put a finished wall piece on a tile. 1x1, so the anchor is the tile centre. */
function wallAt(world, type, player, tx, ty) {
  return spawnBuilding(world, type, player, tx + 0.5, ty + 0.5, { complete: true });
}

function ageUp(world, playerId, age) {
  if (age >= AGE.FEUDAL) completeResearch(world, playerId, 'feudal_age');
  if (age >= AGE.CASTLE) completeResearch(world, playerId, 'castle_age');
}

function record(world, ev) {
  const seen = [];
  world.events.on(ev, (p) => seen.push(p));
  return seen;
}

console.log('\nwalls, gates and castles');

// ---------------------------------------------------------------------------
// 1. The neighbour mask — every one of the sixteen cases
// ---------------------------------------------------------------------------

test('the stats table declares the wall family the rest of this file assumes', () => {
  for (const t of ['palisade', 'stonewall', 'palisadegate', 'stonegate']) {
    assert.ok(BUILDING_STATS[t], `${t} must exist`);
    assert.equal(isWallType(t), true, `${t} must be a wall piece`);
    assert.equal(BUILDING_STATS[t].fw, 1, `${t} must be 1x1 or a run cannot tile`);
    assert.equal(BUILDING_STATS[t].fh, 1);
  }
  assert.equal(isGateType('palisadegate'), true);
  assert.equal(isGateType('stonegate'), true);
  assert.equal(isGateType('stonewall'), false);
  assert.equal(isWallType('house'), false);
});

test('a lone segment has mask 0, and every single neighbour lights its own bit', () => {
  const cases = [
    [[0, -1], WALL_N, 'north'],
    [[1, 0], WALL_E, 'east'],
    [[0, 1], WALL_S, 'south'],
    [[-1, 0], WALL_W, 'west'],
  ];
  for (const [[dx, dy], bit, name] of cases) {
    const world = bareWorld();
    const me = wallAt(world, 'palisade', PLAYER, 20, 20);
    assert.equal(me.wallMask, 0, 'a wall with nothing around it is a lone post');
    wallAt(world, 'palisade', PLAYER, 20 + dx, 20 + dy);
    assert.equal(me.wallMask, bit, `a ${name} neighbour must set exactly its own bit`);
  }
});

test('all sixteen masks are reachable, and each is the sum of its neighbours', () => {
  // The exhaustive sweep: build every combination of the four neighbours and
  // check the mask the simulation computes is the one the sprite table is
  // indexed by. Sixteen cases is small enough to simply do all of them, and
  // "the corner case nobody tried" is exactly how connected tiles go wrong.
  const OFFSETS = [[0, -1, WALL_N], [1, 0, WALL_E], [0, 1, WALL_S], [-1, 0, WALL_W]];
  const seen = new Set();
  for (let want = 0; want < 16; want++) {
    const world = bareWorld();
    const me = wallAt(world, 'stonewall', PLAYER, 30, 30);
    for (const [dx, dy, bit] of OFFSETS) {
      if (want & bit) wallAt(world, 'stonewall', PLAYER, 30 + dx, 30 + dy);
    }
    assert.equal(me.wallMask, want, `mask ${want} did not come out as ${want}`);
    assert.equal(wallMaskAt(world, 30, 30, PLAYER), want);
    seen.add(me.wallMask);
  }
  assert.equal(seen.size, 16, 'every one of the sixteen variants must be reachable');
});

test('a straight run reads as a run, and a corner as a corner', () => {
  const world = bareWorld();
  for (let x = 10; x <= 14; x++) wallAt(world, 'stonewall', PLAYER, x, 10);
  for (let y = 11; y <= 13; y++) wallAt(world, 'stonewall', PLAYER, 14, y);

  const at = (tx, ty) => world.entities.get(world.occupant[ty * world.width + tx]);
  assert.equal(at(10, 10).wallMask, WALL_E, 'the west end is a stub');
  assert.equal(at(12, 10).wallMask, WALL_E | WALL_W, 'the middle is a straight run');
  assert.equal(at(14, 10).wallMask, WALL_W | WALL_S, 'the turn is a corner');
  assert.equal(at(14, 12).wallMask, WALL_N | WALL_S, 'the leg is a straight run');
  assert.equal(at(14, 13).wallMask, WALL_N, 'the far end is a stub');
});

test('removing a segment re-opens its neighbours the same step', () => {
  const world = bareWorld();
  const a = wallAt(world, 'palisade', PLAYER, 5, 5);
  const b = wallAt(world, 'palisade', PLAYER, 6, 5);
  const c = wallAt(world, 'palisade', PLAYER, 7, 5);
  assert.equal(b.wallMask, WALL_E | WALL_W);
  removeEntity(world, b);
  assert.equal(a.wallMask, 0, 'the west neighbour must forget the gap');
  assert.equal(c.wallMask, 0, 'and so must the east one');
});

test('a wall only joins up with its own side, and only with wall pieces', () => {
  const world = bareWorld();
  const mine = wallAt(world, 'stonewall', PLAYER, 40, 40);
  wallAt(world, 'stonewall', ENEMY, 41, 40);           // the enemy's wall
  spawnBuilding(world, 'house', PLAYER, 41.5, 42.5);   // one of mine, not a wall
  // (a 2x2 anchored there covers 40,41 — the tile due south of `mine`)
  assert.equal(mine.wallMask, 0,
    'neither an enemy segment nor a house of your own is something to join to');
  // A gate of the same player *is* part of the wall, whichever family.
  wallAt(world, 'palisadegate', PLAYER, 39, 40);
  assert.equal(mine.wallMask, WALL_W);
});

test('a foundation counts as a wall, so a run looks like a run while it goes up', () => {
  const world = bareWorld();
  const done = wallAt(world, 'palisade', PLAYER, 8, 8);
  spawnBuilding(world, 'palisade', PLAYER, 9.5, 8.5, { complete: false });
  assert.equal(done.wallMask, WALL_E,
    'a wall under construction is still the shape of the wall you drew');
});

// ---------------------------------------------------------------------------
// 2. Gates: passable for the owner, a wall for everybody else
// ---------------------------------------------------------------------------

test('a shut gate is walkable for its owner and solid for the enemy', () => {
  const world = bareWorld();
  const gate = wallAt(world, 'stonegate', PLAYER, 20, 20);
  setGateOpen(world, gate, false);

  assert.equal(world.blocked[20 * world.width + 20], BLOCK_GATE);
  assert.equal(world.gateOwner[20 * world.width + 20], PLAYER + 1);

  assert.equal(isWalkable(world, 20, 20, PLAYER), true, 'the owner walks through');
  assert.equal(isWalkable(world, 20, 20, ENEMY), false, 'the enemy does not');
  assert.equal(isWalkable(world, 20, 20), false,
    'and a caller that did not say who is asking gets the safe answer');
});

test('the real pathfinder takes the owner through the gate and turns the enemy back', () => {
  const world = bareWorld();
  // A wall from the top of the map to the bottom, with a stone gate in it. The
  // only way across is the gate, so the two answers cannot be confused with a
  // planner that simply walked round.
  const X = 30;
  for (let y = 0; y < world.height; y++) {
    if (y === 40) continue;
    wallAt(world, 'stonewall', PLAYER, X, y);
  }
  const gate = wallAt(world, 'stonegate', PLAYER, X, 40);
  setGateOpen(world, gate, false);

  const mine = findPath(world, X - 6 + 0.5, 40.5, X + 6 + 0.5, 40.5, { player: PLAYER });
  assert.ok(mine && !mine.partial, 'the owner must find a way across');
  const crossed = mine.some((p) => Math.floor(p.x) >= X);
  assert.ok(crossed, 'and it must actually be on the far side');

  const theirs = findPath(world, X - 6 + 0.5, 40.5, X + 6 + 0.5, 40.5, { player: ENEMY });
  // Either no path at all, or a partial one that never gets past the wall.
  const enemyCrossed = !!theirs && !theirs.partial &&
    theirs.some((p) => Math.floor(p.x) > X);
  assert.equal(enemyCrossed, false, 'the enemy must not get through a shut gate');
});

test('an open gate is ground for everybody — that is what open means', () => {
  const world = bareWorld();
  const gate = wallAt(world, 'palisadegate', PLAYER, 12, 12);
  setGateOpen(world, gate, true);
  assert.equal(world.blocked[12 * world.width + 12], 0);
  assert.equal(isWalkable(world, 12, 12, PLAYER), true);
  assert.equal(isWalkable(world, 12, 12), true);
  // ...and the occupant is still there, so it can be tapped, shot and rebuilt.
  assert.equal(world.occupant[12 * world.width + 12], gate.id);
});

test('a gate under construction is a building site, not a doorway', () => {
  const world = bareWorld();
  const gate = spawnBuilding(world, 'stonegate', PLAYER, 15.5, 15.5, { complete: false });
  assert.equal(isWalkable(world, 15, 15, PLAYER), false);
  const villager = spawnUnit(world, 'villager', PLAYER, 14.5, 15.5);
  for (let i = 0; i < 400 && !gate.complete; i++) buildTick(world, villager, gate, 0.05);
  assert.equal(gate.complete, true);
  assert.equal(isWalkable(world, 15, 15, PLAYER), true, 'finished: the owner may pass');
  assert.equal(isWalkable(world, 15, 15, ENEMY), false);
});

test('a gate opens for its owner, and shuts in an enemy face', () => {
  const world = bareWorld();
  const gate = wallAt(world, 'palisadegate', PLAYER, 25, 25);
  const stepGates = () => { reindex(world); updateGates(world); };

  stepGates();
  assert.equal(gate.gateOpen, false, 'nobody about: shut');

  const villager = spawnUnit(world, 'villager', PLAYER, 25.5, 26.4);
  stepGates();
  assert.equal(gate.gateOpen, true, 'its owner walks up: open');

  const raider = spawnUnit(world, 'militia', ENEMY, 25.5, 23.2);
  stepGates();
  assert.equal(gate.gateOpen, false,
    'a hostile in range shuts it even with a friend standing there');

  removeEntity(world, raider);
  removeEntity(world, villager);
  stepGates();
  assert.equal(gate.gateOpen, false);
});

test('a gate never shuts on somebody standing in the doorway', () => {
  const world = bareWorld();
  const gate = wallAt(world, 'palisadegate', PLAYER, 50, 50);
  spawnUnit(world, 'villager', PLAYER, 50.5, 50.5);   // in the gateway itself
  spawnUnit(world, 'militia', ENEMY, 50.5, 48.0);     // and a raider nearby
  reindex(world);
  updateGates(world);
  assert.equal(gate.gateOpen, true, 'entombing your own villager is never the answer');
});

// ---------------------------------------------------------------------------
// 3. Drawing a run: the line, the bill, and what is refused
// ---------------------------------------------------------------------------

test('a run is an L along the grid axes, longer leg first, four-connected', () => {
  const straight = wallLineTiles(10, 10, 15, 10);
  assert.deepEqual(straight.map(([x]) => x), [10, 11, 12, 13, 14, 15]);
  assert.ok(straight.every(([, y]) => y === 10));

  const ell = wallLineTiles(10, 10, 14, 12);
  assert.deepEqual(ell[0], [10, 10]);
  assert.deepEqual(ell[ell.length - 1], [14, 12]);
  // The long leg is x, so it is walked first and the corner lands at the end.
  assert.deepEqual(ell[4], [14, 10]);
  for (let i = 1; i < ell.length; i++) {
    const d = Math.abs(ell[i][0] - ell[i - 1][0]) + Math.abs(ell[i][1] - ell[i - 1][1]);
    assert.equal(d, 1, 'every step must share an edge, never only a corner');
  }

  // Taller than wide: the y leg goes first instead.
  const tall = wallLineTiles(10, 10, 12, 16);
  assert.deepEqual(tall[6], [10, 16]);
  assert.deepEqual(tall[tall.length - 1], [12, 16]);

  assert.deepEqual(wallLineTiles(7, 7, 7, 7), [[7, 7]], 'a tap is a one-tile run');
});

test('placing a line charges for exactly the segments it places', () => {
  const world = bareWorld();
  ageUp(world, PLAYER, AGE.FEUDAL);
  const p = world.players[PLAYER];
  p.resources.stone = 100;
  const unit = BUILDING_STATS.stonewall.cost.stone;

  const tiles = wallLineTiles(20, 20, 29, 20);   // ten segments
  const plan = planWallLine(world, PLAYER, 'stonewall', tiles);
  assert.equal(plan.count, 10);
  assert.equal(plan.cost.stone, 10 * unit);

  const res = placeWallLine(world, PLAYER, 'stonewall', tiles);
  assert.equal(res.placed.length, 10);
  assert.equal(res.refused, 0);
  assert.equal(p.resources.stone, 100 - 10 * unit, 'stone is actually deducted');
  for (const b of res.placed) {
    assert.equal(b.complete, false, 'a drawn wall is foundations for villagers to build');
    assert.equal(b.type, 'stonewall');
  }
});

test('segments that cannot be placed are skipped, and only the rest are paid for', () => {
  const world = bareWorld();
  ageUp(world, PLAYER, AGE.FEUDAL);
  const p = world.players[PLAYER];
  p.resources.stone = 500;
  // Three tiles of the run are already occupied by something else.
  for (const x of [23, 24, 25]) setBlocked(world, x, 30, 1, 999);

  const tiles = wallLineTiles(20, 30, 29, 30);
  const before = p.resources.stone;
  const res = placeWallLine(world, PLAYER, 'stonewall', tiles);
  assert.equal(res.placed.length, 7);
  assert.equal(res.refused, 3);
  assert.equal(before - p.resources.stone, 7 * BUILDING_STATS.stonewall.cost.stone,
    'the blocked tiles must not be charged for');
});

test('a run longer than the purse stops at what the purse buys', () => {
  const world = bareWorld();
  ageUp(world, PLAYER, AGE.FEUDAL);
  const p = world.players[PLAYER];
  const unit = BUILDING_STATS.stonewall.cost.stone;
  p.resources.stone = unit * 4;

  const tiles = wallLineTiles(40, 60, 59, 60);   // twenty asked for
  const plan = planWallLine(world, PLAYER, 'stonewall', tiles);
  assert.equal(plan.count, 4, 'the plan must run out exactly when the stone does');
  assert.equal(plan.segments.filter((s) => s.valid).length, 4);
  assert.match(plan.reason, /resources/i);

  const res = placeWallLine(world, PLAYER, 'stonewall', tiles);
  assert.equal(res.placed.length, 4);
  assert.equal(p.resources.stone, 0);
});

test('a wall line may not seal the player in, and the whole run is refused when it would', () => {
  const world = bareWorld();
  ageUp(world, PLAYER, AGE.FEUDAL);
  // A three-sided box with one villager in it; the run closes the fourth side.
  for (let x = 10; x <= 16; x++) {
    setBlocked(world, x, 10, 1, 999);
    setBlocked(world, x, 16, 1, 999);
  }
  for (let y = 10; y <= 16; y++) setBlocked(world, 10, y, 1, 999);
  spawnUnit(world, 'villager', PLAYER, 13.5, 13.5);

  const tiles = wallLineTiles(16, 10, 16, 16);
  const plan = planWallLine(world, PLAYER, 'stonewall', tiles);
  assert.equal(plan.count, 0, 'nothing may be bought');
  assert.match(plan.trapped, /trap/i);
  assert.ok(plan.segments.every((s) => !s.valid), 'and the preview must show it in red');

  const before = world.players[PLAYER].resources.stone;
  const res = placeWallLine(world, PLAYER, 'stonewall', tiles);
  assert.equal(res.placed.length, 0);
  assert.equal(world.players[PLAYER].resources.stone, before, 'and nothing is charged');
});

test('the same enclosure is legal once it is big enough to live in', () => {
  const world = bareWorld();
  ageUp(world, PLAYER, AGE.FEUDAL);
  // Same shape, but a base-sized one: walling yourself in is a real play and
  // must never be refused. See POCKET_LIMIT in pathfinding.js.
  const X0 = 10;
  const X1 = 30;
  for (let x = X0; x <= X1; x++) {
    setBlocked(world, x, 10, 1, 999);
    setBlocked(world, x, 32, 1, 999);
  }
  for (let y = 10; y <= 32; y++) setBlocked(world, X0, y, 1, 999);
  spawnUnit(world, 'villager', PLAYER, 20.5, 20.5);

  const plan = planWallLine(world, PLAYER, 'stonewall', wallLineTiles(X1, 10, X1, 32));
  assert.equal(plan.trapped, null, 'a base-sized enclosure is honest ground');
  // 23 tiles asked for; the two corners are already part of the north and south
  // walls, so 21 are actually bought — the corner case a run drawn between two
  // existing walls hits every single time.
  assert.equal(plan.count, 21);
  assert.equal(plan.refused, 2);
});

test('pointsSealedBy does not count a gate as a wall', () => {
  const world = bareWorld();
  // A tiny box whose only exit is a gate: nobody inside is sealed, because a
  // gate is a way out.
  for (let x = 10; x <= 14; x++) {
    setBlocked(world, x, 10, 1, 999);
    setBlocked(world, x, 14, 1, 999);
  }
  for (let y = 10; y <= 14; y++) {
    setBlocked(world, 10, y, 1, 999);
    if (y !== 12) setBlocked(world, 14, y, 1, 999);
  }
  const gate = wallAt(world, 'palisadegate', PLAYER, 14, 12);
  setGateOpen(world, gate, false);
  const inside = [{ x: 12.5, y: 12.5 }];
  assert.deepEqual(pointsSealedBy(world, [], inside), [],
    'a pocket with a door in it is not a pocket');
});

// ---------------------------------------------------------------------------
// 4. The Castle
// ---------------------------------------------------------------------------

test('the Castle is a 4x4 stone building that trains, banks and sees a long way', () => {
  const s = BUILDING_STATS.castle;
  assert.equal(s.fw, 4);
  assert.equal(s.fh, 4);
  assert.ok(s.cost.stone > 0, 'the Castle is the reason stone exists');
  assert.equal(s.cost.wood || 0, 0);
  assert.equal(s.cost.food || 0, 0);
  assert.ok(s.trains.length > 0, 'a Castle trains units');
  assert.ok(s.dropoff.includes('stone') && s.dropoff.includes('food'));
  assert.ok(s.lineOfSight >= 10, 'worth building for the vision alone');
  assert.ok(s.attack > 0 && s.attackRange > 0, 'and it shoots');
  assert.ok(s.garrisonCapacity > 0);
});

test('a Castle is refused before the Castle Age and allowed after it', () => {
  const world = generatedWorld();
  const p = world.players[PLAYER];
  p.resources.stone = 5000;
  const before = p.resources.stone;

  const toasts = record(world, EV.TOAST);
  assert.equal(currentAge(world, PLAYER), AGE.DARK);
  assert.equal(placeFoundation(world, PLAYER, 'castle', 30, 30), null,
    'no Castle in the Dark Age');
  assert.equal(p.resources.stone, before, 'and nothing charged for the refusal');
  assert.ok(toasts.some((t) => /Castle Age/i.test(t.text)), 'the refusal has to say why');

  ageUp(world, PLAYER, AGE.FEUDAL);
  assert.equal(placeFoundation(world, PLAYER, 'castle', 30, 30), null,
    'nor in the Feudal Age');

  ageUp(world, PLAYER, AGE.CASTLE);
  const c = findOpenSpot(world, 4);
  const b = placeFoundation(world, PLAYER, 'castle', c.gx, c.gy);
  assert.ok(b, 'in the Castle Age it goes down');
  assert.equal(b.tiles.length, 16, 'and it covers sixteen tiles');
  assert.equal(before - p.resources.stone, BUILDING_STATS.castle.cost.stone,
    'stone is deducted, exactly once, exactly the listed amount');
});

test('the walls are age-gated too, and the palisade is not', () => {
  const world = generatedWorld();
  const spot = findOpenSpot(world, 1);
  assert.ok(placeFoundation(world, PLAYER, 'palisade', spot.gx, spot.gy),
    'a palisade is a Dark Age fence');
  const spot2 = findOpenSpot(world, 1);
  const toasts = record(world, EV.TOAST);
  assert.equal(placeFoundation(world, PLAYER, 'stonewall', spot2.gx, spot2.gy), null);
  assert.ok(toasts.some((t) => /Feudal Age/i.test(t.text)));
});

test('the tower and the Castle declare what combat.js needs, and carry its state', () => {
  // The *numbers* live in BUILDING_STATS and combat.js reads them from there;
  // what world.js stamps is the mutable state a volley ticks. Both halves are
  // checked here because a missing field on either side is silent — the tower
  // simply never shoots and nothing says why.
  for (const type of ['watchtower', 'castle']) {
    const s = BUILDING_STATS[type];
    assert.ok(s.attack > 0, `${type} must declare an attack`);
    assert.ok(s.attackRange > 0, `${type} must declare a range`);
    assert.ok(s.attackCooldown > 0, `${type} must declare a cooldown`);
    assert.ok(s.garrisonCapacity > 0, `${type} must hold a garrison`);
  }
  const world = bareWorld();
  const b = spawnBuilding(world, 'castle', PLAYER, 70, 70, { complete: true });
  assert.equal(b.cooldown, 0, 'a swing timer, from birth');
  assert.equal(b.attackAnim, 0);
  assert.deepEqual(b.garrison, [], 'and an empty garrison, so nothing has to guard for undefined');

  // Everything else must still say "I do not fight", or a sweep that starts
  // looking at buildings will find a shooting house.
  const h = spawnBuilding(world, 'house', PLAYER, 60, 60, { complete: true });
  assert.equal(BUILDING_STATS.house.attack || 0, 0);
  assert.equal(BUILDING_STATS.house.garrisonCapacity || 0, 0);
  assert.deepEqual(h.garrison, []);
});

test('an enemy soldier cannot be stuffed into your tower', () => {
  // The rule lives in combat.js (garrisonRefusal); this is the wall pass making
  // sure its half — the capacity declaration and the owner on the building —
  // says what that rule needs to hear.
  assert.equal(BUILDING_STATS.watchtower.garrisonCapacity, 5);
  const world = bareWorld();
  const tower = spawnBuilding(world, 'watchtower', PLAYER, 60.5, 60.5, { complete: true });
  assert.equal(tower.player, PLAYER);
  assert.equal(tower.complete, true);
});

// --- helpers ----------------------------------------------------------------

/** A clear patch of a generated map big enough for an fw x fw footprint. */
function findOpenSpot(world, fw) {
  for (let ty = 4; ty < world.height - 6; ty++) {
    for (let tx = 4; tx < world.width - 6; tx++) {
      let ok = true;
      for (let y = ty - 1; y <= ty + fw && ok; y++) {
        for (let x = tx - 1; x <= tx + fw && ok; x++) {
          if (world.blocked[y * world.width + x] !== 0) ok = false;
          if (world.terrain[y * world.width + x] === 2) ok = false;
        }
      }
      if (ok) return { gx: tx + fw / 2, gy: ty + fw / 2, tx, ty };
    }
  }
  throw new Error('no open ground on this map');
}

// --- summary ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err && f.err.stack}`);
  process.exit(1);
}
