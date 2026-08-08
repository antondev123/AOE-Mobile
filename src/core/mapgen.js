// Skirmish map generation: terrain, resource nodes, and two mirrored bases.
//
// The layout follows AoE2's opening: a Town Center, a few villagers, berries
// and wood close by, gold a short walk away and stone a longer one — so the
// first two minutes are about assigning villagers rather than exploring, and
// the minutes after that are about deciding when to leave the base.

import { MAP_W, MAP_H, TERRAIN, PLAYER, ENEMY } from './constants.js';
import { spawnBuilding, spawnResource, spawnUnit, isBlocked, inBounds, recomputePop } from './world.js';

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

  for (const b of bases) buildBase(world, b);

  for (const p of world.players) recomputePop(world, p.id);
  return { bases };
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
    const ang = b.player === PLAYER ? 0.9 : 0.9 + Math.PI;
    const cx = Math.round(b.x + Math.cos(ang) * 7);
    const cy = Math.round(b.y + Math.sin(ang) * 7);
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
    const a = rng.range(0, Math.PI * 2);
    const x = Math.round(cx + Math.cos(a) * r);
    const y = Math.round(cy + Math.sin(a) * r);
    if (!freeSpot(world, x, y, bases, minBaseDist)) continue;
    spawnResource(world, 'tree', x, y);
    placed++;
  }
}

function scatterGold(world, bases) {
  const { rng } = world;
  // Neutral gold in the contested middle — worth fighting over.
  for (let i = 0; i < scaled(7); i++) {
    const cx = rng.int(8, MAP_W - 9);
    const cy = rng.int(8, MAP_H - 9);
    placeCluster(world, cx, cy, 'gold', rng.int(3, 5), bases, 9);
  }
  // A starting gold vein per player, a short walk from the Town Center.
  for (const b of bases) {
    const dir = b.player === PLAYER ? 1 : -1;
    placeCluster(world, b.x + 7 * dir, b.y - 4 * dir, 'gold', 4, bases, 4.5);
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
    placeCluster(world, cx, cy, 'stone', rng.int(3, 4), bases, 11);
  }
  for (const b of bases) {
    const dir = b.player === PLAYER ? 1 : -1;
    placeCluster(world, b.x - 4 * dir, b.y + 10 * dir, 'stone', 4, bases, 6.5);
  }
}

/** Neutral berry patches, so a long game has food worth walking out for. */
function scatterBerries(world, bases) {
  const { rng } = world;
  for (let i = 0; i < scaled(6); i++) {
    const cx = rng.int(10, MAP_W - 11);
    const cy = rng.int(10, MAP_H - 11);
    placeCluster(world, cx, cy, 'berry', rng.int(3, 5), bases, 10);
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
  const dir = player === PLAYER ? 1 : -1;
  placeCluster(world, x - 5 * dir, y + 3 * dir, 'berry', 6, [], 0);
  placeCluster(world, x + 4 * dir, y + 7 * dir, 'berry', 5, [], 0);

  // Three starting villagers, fanned out in front of the Town Center.
  const spawned = [];
  for (let i = 0; i < 3; i++) {
    const a = (Math.PI * 2 * i) / 3 + (player === PLAYER ? 0.6 : 3.7);
    const ux = x + Math.cos(a) * 2.6;
    const uy = y + Math.sin(a) * 2.6;
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
