// Skirmish map generation: terrain, resource nodes, and two mirrored bases.
//
// The layout follows AoE2's opening: a Town Center, a few villagers, berries
// and wood close by, gold a short walk away and stone a longer one — so the
// first two minutes are about assigning villagers rather than exploring, and
// the minutes after that are about deciding when to leave the base.

import { MAP_W, MAP_H, TERRAIN, PLAYER, ENEMY } from './constants.js';
import { dirVec, DIR_COUNT } from './iso.js';
import { spawnBuilding, spawnResource, spawnUnit, isBlocked, inBounds, recomputePop } from './world.js';
import { commandUnits } from '../systems/unitAI.js';

// Distance of each Town Center from its map corner.
//
// 18 on a 96x96 map puts the two bases 60 tiles apart on each axis — about 85
// tiles of walking — so a militia at 1.1 tiles/second needs a little over a
// minute to cross, and the first raid is something you hear about from the
// minimap rather than something that is already happening. It is the old figure
// (9 on 48x48) scaled with the map, deliberately: the *local* layout around a
// base is tuned and did not want moving, only the gap between the two.
const BASE_OFFSET = 18;

// Everything scattered across open ground scales with the map's area, so a map
// four times the size is not four times emptier. The counts below are the old
// 48x48 figures multiplied by this and rounded to something that reads well.
const AREA_SCALE = (MAP_W * MAP_H) / (48 * 48);

export function generateMap(world) {
  carveTerrain(world);

  const bases = [
    { player: PLAYER, x: BASE_OFFSET, y: BASE_OFFSET },
    { player: ENEMY, x: MAP_W - BASE_OFFSET, y: MAP_H - BASE_OFFSET },
  ];

  // Scatter neutral forest across the middle before bases claim their ground,
  // then clear anything that would sit on top of a base.
  scatterForests(world, bases);
  scatterGold(world, bases);
  scatterStone(world, bases);
  scatterBerries(world, bases);

  for (const b of bases) {
    const built = buildBase(world, b);
    putToWork(world, b, built.villagers);
  }

  for (const p of world.players) recomputePop(world, p.id);
  return { bases };
}

// How many of the three starting villagers open on wood rather than on food.
//
// AoE2 opens every villager on food and this does not, for a reason particular
// to what the opening has to *teach* on a phone. A player who gives no input
// for the first minute — which a measurement of this build found is exactly
// what happens — should see the two halves of the economy running, because the
// food counter and the wood counter both moving is the whole gather loop
// stated without a word of text: villager walks to thing, thing becomes number,
// number buys building. Three on berries would show that loop once; two and one
// shows it twice with different scenery, and leaves the opening still weighted
// toward food the way an AoE2 opening is.
const OPENING_WOODCUTTERS = 1;

/**
 * Send the starting villagers to the nearest food and the nearest wood.
 *
 * This is the fix for a dead opening. Three villagers standing in `idle` next
 * to a Town Center is not a neutral starting position, it is a screen with
 * nothing happening on it: measured over sixty simulated seconds of no input,
 * food went 250 -> 250, wood 250 -> 250 and every villager stayed idle, while
 * the enemy AI — which has always opened its own villagers — went from three
 * units to six. The player was losing the match during the tutorial.
 *
 * It runs for BOTH players, from mapgen rather than from the AI, so the two
 * openings are identical and a seed replays the same way for each side.
 *
 * Orders go through commandUnits, not through hand-written task objects: the
 * point is to put the villagers into exactly the state a player's tap would
 * have put them in, so that everything downstream — the idle counter, the
 * allocation manager, the job note, a save taken on the first frame — sees
 * ordinary gatherers and not a special case.
 */
function putToWork(world, base, villagers) {
  if (!villagers || !villagers.length) return;
  const food = nearestNode(world, base.x, base.y, 'berry');
  const wood = nearestNode(world, base.x, base.y, 'tree');
  villagers.forEach((u, i) => {
    // Ordered from the back so that the wood assignment lands on the villager
    // furthest round the fan, which keeps the two jobs visually separated from
    // the first frame instead of having all three set off along the same line.
    const wantWood = i >= villagers.length - OPENING_WOODCUTTERS;
    const node = (wantWood ? wood : food) || wood || food;
    if (!node) return;
    commandUnits(world, [u], { type: 'gather', target: node, gx: node.x, gy: node.y });
  });
}

/** The closest live resource node of a type to a point. Linear; runs twice per base. */
function nearestNode(world, x, y, type) {
  let best = null;
  let bestD = Infinity;
  for (const e of world.resources) {
    if (e.dead || e.type !== type || !(e.amount > 0)) continue;
    const d = (e.x - x) ** 2 + (e.y - y) ** 2;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

/** Counts that should grow with the map, never below the original figure. */
function scaled(n) {
  return Math.max(n, Math.round(n * AREA_SCALE));
}

function carveTerrain(world) {
  const { rng } = world;
  // Gentle patches of dirt and sand so the ground is not a flat green sheet.
  for (let i = 0; i < scaled(70); i++) {
    const cx = rng.int(0, MAP_W - 1);
    const cy = rng.int(0, MAP_H - 1);
    const r = rng.range(1.5, 4);
    const kind = rng.chance(0.65) ? TERRAIN.DIRT : TERRAIN.SAND;
    stamp(world, cx, cy, r, kind);
  }
  // Ponds, away from the base corners. Kept small and few: water is impassable,
  // and a lake across the middle of a 96-tile map is a wall, not scenery.
  for (let i = 0; i < scaled(2); i++) {
    const cx = rng.int(BASE_OFFSET + 6, MAP_W - BASE_OFFSET - 6);
    const cy = rng.int(BASE_OFFSET + 6, MAP_H - BASE_OFFSET - 6);
    const r = rng.range(2.5, 4.5);
    stamp(world, cx, cy, r, TERRAIN.WATER);
  }
  // Water is impassable.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = y * MAP_W + x;
      if (world.terrain[i] === TERRAIN.WATER) world.blocked[i] = 2;
    }
  }
}

function stamp(world, cx, cy, r, kind) {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (!inBounds(world, x, y)) continue;
      const dx = x - cx;
      const dy = y - cy;
      // Ragged edge, so patches do not look like stamped circles.
      if (dx * dx + dy * dy <= r2 * world.rng.range(0.7, 1.15)) {
        world.terrain[y * MAP_W + x] = kind;
      }
    }
  }
}

/** True if a tile is clear ground and far enough from every base centre. */
function freeSpot(world, x, y, bases, minBaseDist) {
  if (!inBounds(world, x, y)) return false;
  if (isBlocked(world, x, y)) return false;
  if (world.terrain[y * MAP_W + x] === TERRAIN.WATER) return false;
  for (const b of bases) {
    const dx = x - b.x;
    const dy = y - b.y;
    if (dx * dx + dy * dy < minBaseDist * minBaseDist) return false;
  }
  return true;
}

function scatterForests(world, bases) {
  const { rng } = world;
  // Big neutral woods in the middle of the map...
  for (let i = 0; i < scaled(22); i++) {
    const cx = rng.int(3, MAP_W - 4);
    const cy = rng.int(3, MAP_H - 4);
    growForest(world, cx, cy, rng.int(8, 26), bases, 7);
  }
  // ...plus a guaranteed woodline for each player, close enough to be the
  // obvious first wood assignment.
  for (const b of bases) {
    // A fixed heading per base, taken from the literal direction table. Index 9
    // of 64 is ~0.88 radians, which is where the old `0.9` put it; the opposite
    // base gets the antipode. Trigonometry is not used here because sin and cos
    // differ in the last bit between JavaScript engines, and a single flipped
    // Math.round relocates a whole woodline — which changes blocked[], which
    // changes every path near it, on one machine and not the other.
    const ang = b.player === PLAYER ? 9 : 9 + DIR_COUNT / 2;
    const d = dirVec(ang);
    const cx = Math.round(b.x + d[0] * 7);
    const cy = Math.round(b.y + d[1] * 7);
    growForest(world, cx, cy, 30, bases, 4.5);
  }
}

function growForest(world, cx, cy, count, bases, minBaseDist) {
  const { rng } = world;
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < count * 12) {
    attempts++;
    // Random walk outward from the seed so clumps look organic.
    const r = rng.range(0, Math.sqrt(count) * 0.9);
    const d = dirVec(rng.int(0, DIR_COUNT - 1));
    const x = Math.round(cx + d[0] * r);
    const y = Math.round(cy + d[1] * r);
    if (!freeSpot(world, x, y, bases, minBaseDist)) continue;
    spawnResource(world, 'tree', x, y);
    placed++;
  }
}

// How close a *neutral* cluster may sit to any base.
//
// This is the number that decides whether a big map is a big map. A review of
// the 96x96 release counted what was reachable within fifteen tiles of a Town
// Center: 2200 food, 12900 wood, 8640 gold, 2200 stone. A ten-minute match at
// around twenty villagers consumes roughly nine thousand resources in total, so
// everything a full game needed was already inside a seven-hundred-tile pocket
// the player never had to leave. The other ninety-two percent of the map was
// scenery, and the Lumber Camp — justified by woodlines fifteen tiles out —
// was answering a problem the generator never created.
//
// Pushing neutral clusters past twenty tiles is what forces the second base,
// the forward camp and the fight over the middle. The guaranteed starting
// clusters below are deliberately left close: the opening should still be about
// assigning villagers, not about exploring.
const NEUTRAL_MIN_BASE_DIST = 22;

function scatterGold(world, bases) {
  const { rng } = world;
  // Neutral gold in the contested middle — worth fighting over.
  for (let i = 0; i < scaled(7); i++) {
    const cx = rng.int(8, MAP_W - 9);
    const cy = rng.int(8, MAP_H - 9);
    placeCluster(world, cx, cy, 'gold', rng.int(3, 5), bases, NEUTRAL_MIN_BASE_DIST);
  }
  // A starting gold vein per player, a short walk from the Town Center.
  //
  // Three nodes, not four. Four held 1280 gold, which is 28 archers off a vein
  // you never have to defend — enough to reach the end of a skirmish without
  // contesting the middle even once. Three leaves you needing the map.
  for (const b of bases) {
    const dir = b.player === PLAYER ? 1 : -1;
    placeCluster(world, b.x + 7 * dir, b.y - 4 * dir, 'gold', 3, bases, 4.5);
  }
}

/**
 * Stone mines.
 *
 * Stone is the mid-game resource: nothing in the opening spends it, and its
 * sinks are the defensive buildings you reach for once the first raid has
 * landed. So it is placed to be *found*, not to be stumbled over. Each player
 * gets one guaranteed cluster, but further out than their starting gold (11
 * tiles against gold's 7) and on the far side of the base, so walking a villager
 * to it is a small decision rather than something that happens by accident on
 * the way to the berries.
 *
 * The rest sits in the contested middle in clusters of three or four. Counted in
 * nodes the map ends up with slightly fewer stone than gold and a small fraction
 * of the trees, which is the intended scarcity ordering: wood is everywhere,
 * gold is worth a fight, stone is worth a walk and a fight.
 */
function scatterStone(world, bases) {
  const { rng } = world;
  for (let i = 0; i < scaled(6); i++) {
    const cx = rng.int(10, MAP_W - 11);
    const cy = rng.int(10, MAP_H - 11);
    placeCluster(world, cx, cy, 'stone', rng.int(3, 4), bases, NEUTRAL_MIN_BASE_DIST + 2);
  }
  // Three nodes at fourteen tiles rather than four at ten. Stone is the
  // resource you go and get once the first raid has told you that you need
  // walls, so the starting mine should be a decision with a walk attached.
  for (const b of bases) {
    const dir = b.player === PLAYER ? 1 : -1;
    placeCluster(world, b.x - 5 * dir, b.y + 14 * dir, 'stone', 3, bases, 6.5);
  }
}

/** Neutral berry patches, so a long game has food worth walking out for. */
function scatterBerries(world, bases) {
  const { rng } = world;
  for (let i = 0; i < scaled(6); i++) {
    const cx = rng.int(10, MAP_W - 11);
    const cy = rng.int(10, MAP_H - 11);
    placeCluster(world, cx, cy, 'berry', rng.int(3, 5), bases, NEUTRAL_MIN_BASE_DIST);
  }
}

function placeCluster(world, cx, cy, type, count, bases, minBaseDist) {
  const { rng } = world;
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < count * 14) {
    attempts++;
    const x = Math.round(cx + rng.range(-1.6, 1.6));
    const y = Math.round(cy + rng.range(-1.6, 1.6));
    if (!freeSpot(world, x, y, bases, minBaseDist)) continue;
    spawnResource(world, type, x, y);
    placed++;
  }
}

function buildBase(world, base) {
  const { player, x, y } = base;

  // Clear the ground the Town Center and its immediate surroundings need.
  clearArea(world, x, y, 3.2);

  const tc = spawnBuilding(world, 'towncenter', player, x, y);

  // Berries: the opening food source, placed just off the Town Center, plus a
  // second patch a little further out. Food is finite — with only the opening
  // patch both economies run dry around the six minute mark and armies decay
  // into archers, which cost no food.
  //
  // Eleven bushes held 2200 food, which fed a whole match on its own and made
  // the Farm — the renewable food source the wood economy is supposed to feed
  // into — something you never had to build. Seven is enough to open on and
  // run out with, which is the point at which farms become a decision.
  const dir = player === PLAYER ? 1 : -1;
  placeCluster(world, x - 5 * dir, y + 3 * dir, 'berry', 4, [], 0);
  placeCluster(world, x + 4 * dir, y + 7 * dir, 'berry', 3, [], 0);

  // Three starting villagers, fanned out in front of the Town Center.
  const spawned = [];
  for (let i = 0; i < 3; i++) {
    // These coordinates are NOT rounded to tiles — they are the villagers'
    // exact starting positions, handed straight to spawnUnit. Computed through
    // Math.cos they would differ in the last bit between engines, which means
    // two peers in a lockstep match would start the game with their villagers
    // at measurably different places, before a single order is given. A literal
    // table removes the whole class of problem: index 6 of 64 is ~0.59 rad
    // (the old 0.6) and the enemy's 3.7 rad is 21 sixty-fourths further round.
    const d = dirVec((player === PLAYER ? 6 : 38) + Math.round((DIR_COUNT * i) / 3));
    const ux = x + d[0] * 2.6;
    const uy = y + d[1] * 2.6;
    spawned.push(spawnUnit(world, 'villager', player, ux, uy));
  }

  return { tc, villagers: spawned };
}

function clearArea(world, cx, cy, r) {
  const r2 = r * r;
  // Remove resource nodes overlapping the area so the base is not walled in.
  for (const e of world.resources.slice()) {
    const dx = e.x - cx;
    const dy = e.y - cy;
    if (dx * dx + dy * dy <= r2) {
      const tx = Math.floor(e.x);
      const ty = Math.floor(e.y);
      world.blocked[ty * MAP_W + tx] = 0;
      world.occupant[ty * MAP_W + tx] = 0;
      const i = world.resources.indexOf(e);
      if (i >= 0) world.resources.splice(i, 1);
      world.entities.delete(e.id);
      e.dead = true;
    }
  }
  // And flatten water, which would otherwise be unbuildable.
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (!inBounds(world, x, y)) continue;
      const i = y * MAP_W + x;
      if (world.terrain[i] === TERRAIN.WATER) {
        world.terrain[i] = TERRAIN.GRASS;
        world.blocked[i] = 0;
      }
    }
  }
}
