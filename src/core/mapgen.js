// Skirmish map generation: terrain, resource nodes, and two mirrored bases.
//
// The layout follows AoE2's opening: a Town Center, a few villagers, berries
// and wood close by, and gold a short walk away — so the first two minutes are
// about assigning villagers rather than exploring.

import { MAP_W, MAP_H, TERRAIN, PLAYER, ENEMY } from './constants.js';
import { spawnBuilding, spawnResource, spawnUnit, isBlocked, inBounds, recomputePop } from './world.js';

const BASE_OFFSET = 9; // distance of each Town Center from its map corner

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

  for (const b of bases) buildBase(world, b);

  for (const p of world.players) recomputePop(world, p.id);
  return { bases };
}

function carveTerrain(world) {
  const { rng } = world;
  // Gentle patches of dirt and sand so the ground is not a flat green sheet.
  for (let i = 0; i < 70; i++) {
    const cx = rng.int(0, MAP_W - 1);
    const cy = rng.int(0, MAP_H - 1);
    const r = rng.range(1.5, 4);
    const kind = rng.chance(0.65) ? TERRAIN.DIRT : TERRAIN.SAND;
    stamp(world, cx, cy, r, kind);
  }
  // A pond or two, away from the base corners.
  for (let i = 0; i < 2; i++) {
    const cx = rng.int(14, MAP_W - 14);
    const cy = rng.int(14, MAP_H - 14);
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
  for (let i = 0; i < 22; i++) {
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
  for (let i = 0; i < 7; i++) {
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

  // Berries: the opening food source, placed just off the Town Center.
  const dir = player === PLAYER ? 1 : -1;
  placeCluster(world, x - 5 * dir, y + 3 * dir, 'berry', 6, [], 0);

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
