// Headless tests for src/systems/pathfinding.js.
//   node tests/pathfinding.test.mjs
//
// Everything here runs on a bare world (no mapgen, no Phaser) with obstacles
// stamped by hand, so each assertion is about the planner and nothing else.

import { createWorld, setBlocked, spawnBuilding, spawnResource } from '../src/core/world.js';
import { generateMap } from '../src/core/mapgen.js';
import {
  findPath, findAdjacentStandTile, isWalkable, nearestWalkable, pathStats,
  floodRegion, isPocket, isSealedFrom, pointsSealedBy, hasOpenPerimeter,
  POCKET_LIMIT,
} from '../src/systems/pathfinding.js';

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

function blankWorld() {
  return createWorld(4242);
}

function wall(world, x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) setBlocked(world, x, y, 1, 999);
  }
}

/** Every step is one tile (8-way) and every tile on it is walkable. */
function assertContiguousAndWalkable(world, path) {
  assert(path && path.length > 0, 'path is empty');
  for (const p of path) {
    assert(isWalkable(world, p.x, p.y), `waypoint ${p.x},${p.y} is not walkable`);
  }
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(Math.floor(path[i].x) - Math.floor(path[i - 1].x));
    const dy = Math.abs(Math.floor(path[i].y) - Math.floor(path[i - 1].y));
    assert(dx <= 1 && dy <= 1 && dx + dy > 0, `waypoints ${i - 1}->${i} are not adjacent (${dx},${dy})`);
  }
}

/** Sample a smoothed leg densely: the straight line must stay walkable. */
function assertLegsClear(world, sx, sy, path) {
  let ax = sx;
  let ay = sy;
  for (const p of path) {
    const steps = Math.ceil(Math.hypot(p.x - ax, p.y - ay) / 0.1);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const x = ax + (p.x - ax) * t;
      const y = ay + (p.y - ay) * t;
      assert(isWalkable(world, x, y), `smoothed leg crosses a blocked tile at ${x.toFixed(2)},${y.toFixed(2)}`);
    }
    ax = p.x;
    ay = p.y;
  }
}

console.log('pathfinding');

// --- Tiles ------------------------------------------------------------------

test('isWalkable respects bounds and the blocked grid', () => {
  const w = blankWorld();
  assert(isWalkable(w, 5, 5), 'open ground should be walkable');
  assert(!isWalkable(w, -1, 5), 'out of bounds is not walkable');
  assert(!isWalkable(w, 5, w.height), 'out of bounds is not walkable');
  setBlocked(w, 5, 5, 1, 1);
  assert(!isWalkable(w, 5, 5), 'blocked tile should not be walkable');
  // Float grid positions land in the right tile.
  assert(!isWalkable(w, 5.9, 5.1), 'float position inside a blocked tile');
  assert(isWalkable(w, 6.1, 5.5), 'float position in the next tile over');
});

test('nearestWalkable escapes a blocked tile and gives up past maxR', () => {
  const w = blankWorld();
  wall(w, 10, 10, 12, 12);
  const n = nearestWalkable(w, 11, 11, 4);
  assert(n, 'should find a way out of a 3x3 block');
  assert(isWalkable(w, n.tx, n.ty), 'result must be walkable');
  assert(Math.abs(n.x - (n.tx + 0.5)) < 1e-9, 'x should be the tile centre');

  wall(w, 20, 20, 30, 30);
  eq(nearestWalkable(w, 25, 25, 2), null, 'should give up inside a big block');
});

// --- Paths ------------------------------------------------------------------

test('open ground gives a direct path', () => {
  const w = blankWorld();
  const p = findPath(w, 4.5, 4.5, 12.5, 9.5);
  assert(p && p.length >= 1, 'expected a path');
  assert(!p.partial, 'open ground should not be partial');
  const end = p[p.length - 1];
  assert(Math.hypot(end.x - 12.5, end.y - 9.5) < 1e-6, 'must end exactly on the target');
});

test('path around a wall exists, is contiguous, walkable, and reaches the goal', () => {
  const w = blankWorld();
  // A wall spanning most of the map with a gap at the top.
  wall(w, 20, 5, 20, 47);
  const raw = findPath(w, 10.5, 25.5, 30.5, 25.5, { smooth: false });
  assert(raw, 'expected a path around the wall');
  assert(!raw.partial, 'the goal is reachable, so the path must not be partial');
  assertContiguousAndWalkable(w, raw);
  const end = raw[raw.length - 1];
  eq(Math.floor(end.x), 30, 'ends on the goal tile x');
  eq(Math.floor(end.y), 25, 'ends on the goal tile y');
  // It must actually go around: through the gap above row 5.
  assert(raw.some((p) => p.y < 5.9), 'path should route through the gap');

  // And the smoothed version must still never cross the wall.
  const smoothed = findPath(w, 10.5, 25.5, 30.5, 25.5);
  assert(smoothed.length <= raw.length, 'smoothing should not add waypoints');
  assertLegsClear(w, 10.5, 25.5, smoothed);
});

test('diagonal moves never cut a corner', () => {
  const w = blankWorld();
  // Blocking both orthogonal neighbours seals the diagonal gap at (10,10).
  setBlocked(w, 11, 10, 1, 1);
  setBlocked(w, 10, 11, 1, 1);
  const p = findPath(w, 10.5, 10.5, 11.5, 11.5, { smooth: false });
  assert(p, 'expected some path');
  // The one-step diagonal is illegal, so it must take the long way (or fail to
  // reach at all) — never a single hop into (11,11).
  assert(p.length > 1, 'must not squeeze through the diagonal gap');
  assertContiguousAndWalkable(w, p);
});

test('a sealed goal degrades gracefully instead of hanging', () => {
  const w = blankWorld();
  // Walled-off room with the goal inside it.
  wall(w, 20, 20, 26, 20);
  wall(w, 20, 26, 26, 26);
  wall(w, 20, 20, 20, 26);
  wall(w, 26, 20, 26, 26);
  const t0 = Date.now();
  const p = findPath(w, 5.5, 5.5, 23.5, 23.5);
  const ms = Date.now() - t0;
  assert(ms < 250, `search took too long: ${ms}ms`);
  assert(p, 'should return a best-effort path, not null');
  assert(p.partial, 'an unreachable goal must be flagged partial');
  // Best effort means "got closer", not "went nowhere".
  const end = p[p.length - 1];
  const before = Math.hypot(5.5 - 23.5, 5.5 - 23.5);
  const after = Math.hypot(end.x - 23.5, end.y - 23.5);
  assert(after < before, 'partial path should make progress toward the goal');
  assertLegsClear(w, 5.5, 5.5, p);
});

test('a goal on a blocked tile slides to the nearest free tile', () => {
  const w = blankWorld();
  const tree = spawnResource(w, 'tree', 18, 18);
  const p = findPath(w, 10.5, 10.5, tree.x, tree.y);
  assert(p, 'tapping a tree must still produce a path');
  const end = p[p.length - 1];
  assert(isWalkable(w, end.x, end.y), 'must not end inside the tree');
  assert(Math.hypot(end.x - tree.x, end.y - tree.y) < 2.0, 'must end next to the tree');
});

test('a start inside a wall walks out instead of refusing', () => {
  const w = blankWorld();
  // A building drops on top of a unit; it must still be able to leave.
  spawnBuilding(w, 'house', 0, 12, 12);
  const p = findPath(w, 12.0, 12.0, 20.5, 20.5);
  assert(p, 'a trapped unit must still get a path');
  const end = p[p.length - 1];
  assert(Math.hypot(end.x - 20.5, end.y - 20.5) < 1.5, 'should still head for the goal');
});

test('paths do not pass through buildings', () => {
  const w = blankWorld();
  spawnBuilding(w, 'towncenter', 0, 15, 15);
  const p = findPath(w, 12.5, 15.5, 19.5, 15.5);
  assert(p && !p.partial, 'must route around the Town Center');
  assertLegsClear(w, 12.5, 15.5, p);
});

// --- Stand tiles ------------------------------------------------------------

test('findAdjacentStandTile picks a free neighbour of a resource', () => {
  const w = blankWorld();
  const tree = spawnResource(w, 'tree', 30, 30);
  const s = findAdjacentStandTile(w, tree, 27.5, 30.5);
  assert(s, 'expected a stand tile');
  assert(isWalkable(w, s.tx, s.ty), 'stand tile must be walkable');
  const d = Math.hypot(s.x - tree.x, s.y - tree.y);
  assert(d <= 1.5, `stand tile must be adjacent (was ${d.toFixed(2)})`);
  // Should approach from the side the caller is on.
  assert(s.tx <= 30, 'should stand on the near side');
});

test('findAdjacentStandTile respects the avoid set, so a group spreads out', () => {
  const w = blankWorld();
  const tree = spawnResource(w, 'tree', 30, 30);
  const avoid = new Set();
  const picks = [];
  for (let i = 0; i < 4; i++) {
    const s = findAdjacentStandTile(w, tree, 27.5, 30.5, { avoid });
    assert(s, 'expected a stand tile');
    avoid.add(`${s.tx},${s.ty}`);
    picks.push(`${s.tx},${s.ty}`);
  }
  eq(new Set(picks).size, 4, 'each villager should get its own tile');
});

test('findAdjacentStandTile hugs a building footprint, not its centre', () => {
  const w = blankWorld();
  const tc = spawnBuilding(w, 'towncenter', 0, 20, 20);
  const s = findAdjacentStandTile(w, tc, 14.5, 20.5);
  assert(s, 'expected a stand tile beside the Town Center');
  assert(isWalkable(w, s.tx, s.ty), 'stand tile must be free');
  // Touching the 3x3 footprint means one tile outside it.
  const inside = tc.tiles.some(([x, y]) => x === s.tx && y === s.ty);
  assert(!inside, 'stand tile must not be inside the building');
  const near = tc.tiles.some(
    ([x, y]) => Math.abs(x - s.tx) <= 1 && Math.abs(y - s.ty) <= 1,
  );
  assert(near, 'stand tile must touch the footprint');
});

test('a completely walled-in target has no stand tile', () => {
  const w = blankWorld();
  const tree = spawnResource(w, 'tree', 35, 35);
  wall(w, 34, 34, 36, 36);
  eq(findAdjacentStandTile(w, tree, 30.5, 35.5), null, 'nothing to stand on');
});

// --- Real maps --------------------------------------------------------------

test('base-to-base paths work on generated maps, over many seeds', () => {
  let worst = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const w = createWorld(seed * 7919);
    generateMap(w);
    const tcs = w.buildings.filter((b) => b.type === 'towncenter');
    eq(tcs.length, 2, 'map should have two Town Centers');
    const from = findAdjacentStandTile(w, tcs[0], tcs[0].x, tcs[0].y + 2);
    assert(from, 'a Town Center must be reachable on foot');
    const t0 = Date.now();
    const p = findPath(w, from.x, from.y, tcs[1].x, tcs[1].y);
    worst = Math.max(worst, Date.now() - t0);
    assert(p, `seed ${seed}: no path between bases`);
    assert(!p.partial, `seed ${seed}: bases should not be walled off from each other`);
    assertLegsClear(w, from.x, from.y, p);
    const end = p[p.length - 1];
    assert(
      Math.hypot(end.x - tcs[1].x, end.y - tcs[1].y) < 3.0,
      `seed ${seed}: path stopped short of the enemy base`,
    );
  }
  console.log(`       worst cross-map search over 12 seeds: ${worst}ms`);
});

test('a villager can always reach the wood and gold it starts next to', () => {
  const w = createWorld(20250808);
  generateMap(w);
  const vil = w.units.find((u) => u.player === 0);
  for (const type of ['tree', 'gold', 'berry']) {
    const node = w.resources
      .filter((n) => n.type === type)
      .sort((a, b) => Math.hypot(a.x - vil.x, a.y - vil.y) - Math.hypot(b.x - vil.x, b.y - vil.y))[0];
    if (!node) continue;
    const stand = findAdjacentStandTile(w, node, vil.x, vil.y);
    assert(stand, `no way to stand next to the nearest ${type}`);
    const p = findPath(w, vil.x, vil.y, stand.x, stand.y);
    assert(p && !p.partial, `villager cannot reach the nearest ${type}`);
    assertLegsClear(w, vil.x, vil.y, p);
  }
});

// --- Cost -------------------------------------------------------------------

test('many searches stay well inside a frame budget', () => {
  const w = blankWorld();
  // A maze-ish field of obstacles, like a forest map.
  for (let y = 4; y < 44; y += 3) wall(w, 4, y, 40, y);
  for (let y = 4; y < 44; y += 6) setBlocked(w, 10 + (y % 12), y, 0);
  for (let y = 7; y < 44; y += 6) setBlocked(w, 30 - (y % 12), y, 0);

  const t0 = Date.now();
  const N = 200;
  let found = 0;
  for (let i = 0; i < N; i++) {
    // Vary the start so the same-tick memo cannot answer everything.
    const p = findPath(w, 2.5 + (i % 30) * 0.05, 2.5, 45.5, 45.5, { cache: false });
    if (p) found++;
  }
  const ms = Date.now() - t0;
  assert(found === N, 'every search should return something');
  assert(ms < 1000, `${N} searches took ${ms}ms — too slow for many units`);
  console.log(`       ${N} worst-case searches in ${ms}ms (${(ms / N).toFixed(2)}ms each)`);
});

test('the same-tick memo answers repeated group orders for free', () => {
  const w = blankWorld();
  wall(w, 20, 5, 20, 40);
  const before = pathStats.cacheHits;
  for (let i = 0; i < 10; i++) findPath(w, 10.5, 25.5, 30.5, 25.5);
  assert(pathStats.cacheHits > before + 5, 'repeat searches in one tick should hit the cache');
  // A new tick invalidates it, so a changed map is never served stale.
  w.tick++;
  const mid = pathStats.searches;
  findPath(w, 10.5, 25.5, 30.5, 25.5);
  assert(pathStats.searches > mid, 'a new tick must re-plan');
});

// --- Enclosure --------------------------------------------------------------
//
// Regression cover for B1: eight villagers sealed into a one-tile pocket by the
// player's own houses and farms, with no way for the planner to say so.

/**
 * The base from the B1 report, reconstructed tile for tile.
 *
 *   y=8   ..#####...
 *   y=9   ..#####...
 *   y=10  ..##.##...   <- (9,10) is the pocket
 *   y=11  ..##......
 *
 * Returns the world *before* the sealing farm goes in: (9,10) still has a way
 * out to the south through (9,11).
 */
function entombmentBase() {
  const w = blankWorld();
  spawnBuilding(w, 'towncenter', 0, 8.5, 8.5); // tiles 7..9 x 7..9
  spawnBuilding(w, 'house', 0, 11, 8);         // tiles 10..11 x 7..8
  spawnBuilding(w, 'house', 0, 8, 11);         // tiles 7..8  x 10..11
  spawnBuilding(w, 'farm', 0, 11, 10);         // tiles 10..11 x 9..10
  return w;
}

/** The footprint of the farm that closes the last gap: tiles 9..10 x 11..12. */
const SEALING_FARM = [[9, 11], [10, 11], [9, 12], [10, 12]];

test('the reported base really does leave one free tile, with a way out', () => {
  const w = entombmentBase();
  const row = (y) => {
    let s = '';
    for (let x = 5; x <= 14; x++) s += isWalkable(w, x, y) ? '.' : '#';
    return s;
  };
  eq(row(8), '..#####...', 'y=8');
  eq(row(9), '..#####...', 'y=9');
  eq(row(10), '..##.##...', 'y=10 — (9,10) is the only free tile in the ring');
  eq(row(11), '..##......', 'y=11 still open');
  assert(!isPocket(w, 9.5, 10.5), '(9,10) is not yet a pocket — it can reach the map');
});

test('floodRegion tells a one-tile pocket from open ground', () => {
  const w = blankWorld();
  wall(w, 20, 20, 22, 22);
  setBlocked(w, 21, 21, 0);
  const pocket = floodRegion(w, 21, 21);
  eq(pocket.size, 1, 'the hole is exactly one tile');
  eq(pocket.open, false, 'and it is not open ground');
  assert(isPocket(w, 21.5, 21.5), 'isPocket should say so');

  const field = floodRegion(w, 5, 5);
  eq(field.open, true, 'open ground stops at the limit rather than enumerating the map');
  assert(!isPocket(w, 5.5, 5.5), 'open ground is never a pocket');
  eq(floodRegion(w, 20, 20).size, 0, 'a solid tile has no region at all');
});

test('a large walled compound is not a pocket — walling stays legal', () => {
  const w = blankWorld();
  // A 14x14 enclosure: 196 free tiles inside, comfortably over the limit.
  wall(w, 10, 10, 25, 25);
  for (let y = 11; y <= 24; y++) for (let x = 11; x <= 24; x++) setBlocked(w, x, y, 0);
  assert(196 > POCKET_LIMIT, 'the fixture must be bigger than the pocket limit');
  assert(!isPocket(w, 17.5, 17.5), 'a base-sized enclosure must never count as a trap');
  assert(isSealedFrom(w, 17.5, 17.5, 40.5, 40.5) === false,
    'and a unit inside it is not reported as entombed');
});

test('isSealedFrom is the honest answer findPath cannot give', () => {
  const w = entombmentBase();
  for (const [tx, ty] of SEALING_FARM) setBlocked(w, tx, ty, 1, 4242);
  assert(isPocket(w, 9.5, 10.5), '(9,10) is now a sealed pocket');
  assert(isSealedFrom(w, 9.5, 10.5, 30.5, 30.5), 'and it cannot reach the rest of the map');
  eq(findPath(w, 9.5, 10.5, 30.5, 30.5), null, 'findPath has nothing to offer either');
  // The goal being inside the pocket with you is not being sealed away from it.
  assert(!isSealedFrom(w, 9.5, 10.5, 9.5, 10.5), 'the pocket is not sealed from itself');
});

test('pointsSealedBy catches the farm that entombs eight villagers', () => {
  const w = entombmentBase();
  const inPocket = [{ x: 9.5, y: 10.5 }];
  const outside = [{ x: 13.5, y: 12.5 }];
  eq(pointsSealedBy(w, SEALING_FARM, inPocket).length, 1, 'the placement seals the pocket');
  eq(pointsSealedBy(w, SEALING_FARM, outside).length, 0, 'it does not seal open ground');
  eq(pointsSealedBy(w, [[40, 40], [41, 40]], inPocket).length, 0,
    'an unrelated placement across the map seals nobody');
});

test('pointsSealedBy blames only the new building, never an existing pocket', () => {
  const w = entombmentBase();
  for (const [tx, ty] of SEALING_FARM) setBlocked(w, tx, ty, 1, 4242);
  const stuck = [{ x: 9.5, y: 10.5 }];
  assert(isPocket(w, 9.5, 10.5), 'the villager is already sealed in');
  eq(pointsSealedBy(w, [[30, 30], [31, 30]], stuck).length, 0,
    'a later placement elsewhere must not be refused over an existing pocket');
});

test('hasOpenPerimeter sees when a building loses its last exit', () => {
  const w = blankWorld();
  const tc = spawnBuilding(w, 'towncenter', 0, 20.5, 20.5); // tiles 19..21
  assert(hasOpenPerimeter(w, tc.tiles), 'a Town Center in a field has plenty of exits');
  // Box it in completely, leaving one free tile in the wall against its corner.
  wall(w, 17, 17, 23, 23);
  setBlocked(w, 18, 18, 0);
  assert(!hasOpenPerimeter(w, tc.tiles),
    'a single walled-off corner tile is not a way out');
});

test('a stand tile the caller cannot reach is never offered', () => {
  // Straight from the report: the free tile inside the pocket was the *closest*
  // tile to the Town Center's south side, so every villager hauling food home
  // was routed into a wall and froze there — even the ones outside the pocket.
  const w = entombmentBase();
  for (const [tx, ty] of SEALING_FARM) setBlocked(w, tx, ty, 1, 4242);
  const tc = w.buildings.find((b) => b.type === 'towncenter');
  const stand = findAdjacentStandTile(w, tc, 13.5, 12.5);
  assert(stand, 'the Town Center still has reachable sides');
  assert(!(stand.tx === 9 && stand.ty === 10), 'must not pick the sealed pocket tile');
  const p = findPath(w, 13.5, 12.5, stand.x, stand.y);
  assert(p && !p.partial, 'the offered stand tile must actually be walkable to');

  // ...but a villager already inside the pocket may of course stand there.
  const inside = findAdjacentStandTile(w, tc, 9.5, 10.5);
  assert(inside && inside.tx === 9 && inside.ty === 10,
    'a unit in the pocket is not sealed away from its own tile');
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
  process.exit(1);
}
