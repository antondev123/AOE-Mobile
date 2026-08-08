// The world: entity store, occupancy grid, spatial index, player state.
//
// This is the single source of truth for the simulation. Systems read and
// mutate it; the renderer only reads it. Keep it free of Phaser imports so it
// can be exercised headlessly in tests.

import {
  MAP_W, MAP_H, TERRAIN, RES, STARTING_RESOURCES, MAX_POP_CAP,
  UNIT_STATS, BUILDING_STATS, NODE_AMOUNT, PLAYER, ENEMY,
} from './constants.js';
import { EventBus, EV } from './events.js';
import { makeRng } from './rng.js';
import { dist2 } from './iso.js';

// Side of one spatial bucket, in tiles. Four is what forEachNear's typical
// query radius (1-5 tiles) wants: small enough that a lookup touches a handful
// of cells, large enough that the bucket array stays small. It scales with the
// map rather than being a fixed grid — see createWorld.
const BUCKET_SIZE = 4;

export function createWorld(seed = 12345) {
  const rng = makeRng(seed);

  const world = {
    seed,
    rng,
    // Entity id counter. This lives on the world rather than in module scope so
    // that replaying a seed produces identical ids: combat staggers swings and
    // unit AI breaks ties off `entity.id`, so a shared global would make "play
    // again" on the same seed diverge from the first match.
    nextId: 1,
    events: new EventBus(),
    time: 0,
    tick: 0,
    over: false,
    winner: null,

    width: MAP_W,
    height: MAP_H,
    terrain: new Uint8Array(MAP_W * MAP_H),
    // 0 = walkable, 1 = blocked by a static object, 2 = blocked by terrain
    blocked: new Uint8Array(MAP_W * MAP_H),
    // Entity id occupying each tile (0 = none). Lets units find what blocks them.
    occupant: new Int32Array(MAP_W * MAP_H),

    entities: new Map(),
    units: [],       // live unit entities (dense array, rebuilt on removal)
    buildings: [],
    resources: [],

    players: [makePlayer(PLAYER), makePlayer(ENEMY)],

    selection: new Set(),

    // In-flight projectiles, owned by combat.js and read by the renderer.
    // { x, y, tx, ty, target, damage, owner, speed, elapsed, duration }
    projectiles: [],

    // Spatial buckets for proximity queries, rebuilt each sim step. The grid is
    // derived from the map size rather than written out, so a 96x96 map gets
    // 24x24 buckets instead of silently reusing a 12x12 grid sized for 48x48 and
    // putting sixteen tiles of entities in every cell.
    _cellSize: BUCKET_SIZE,
    _cols: Math.ceil(MAP_W / BUCKET_SIZE),
    _rows: Math.ceil(MAP_H / BUCKET_SIZE),
    _buckets: null,
  };

  world._buckets = Array.from({ length: world._cols * world._rows }, () => []);
  return world;
}

function makePlayer(id) {
  return {
    id,
    resources: { ...STARTING_RESOURCES },
    pop: 0,
    // Recomputed from standing buildings by applyPopBonus as soon as the Town
    // Center exists; there is no separate starting allowance.
    popCap: 0,
    // Set of entity ids owned by this player.
    owned: new Set(),
    defeated: false,
  };
}

// --- Tile helpers -----------------------------------------------------------

export function inBounds(world, tx, ty) {
  return tx >= 0 && ty >= 0 && tx < world.width && ty < world.height;
}

export function tileIndex(world, tx, ty) {
  return ty * world.width + tx;
}

export function isBlocked(world, tx, ty) {
  if (!inBounds(world, tx, ty)) return true;
  return world.blocked[ty * world.width + tx] !== 0;
}

export function setBlocked(world, tx, ty, value, entityId = 0) {
  if (!inBounds(world, tx, ty)) return;
  const i = ty * world.width + tx;
  world.blocked[i] = value;
  world.occupant[i] = value ? entityId : 0;
}

export function occupantAt(world, tx, ty) {
  if (!inBounds(world, tx, ty)) return null;
  const id = world.occupant[tileIndex(world, tx, ty)];
  return id ? world.entities.get(id) || null : null;
}

/** Tiles a building covers, given its anchor (top tile) and footprint. */
export function footprintTiles(gx, gy, fw, fh) {
  const tiles = [];
  const ox = Math.floor(gx - fw / 2);
  const oy = Math.floor(gy - fh / 2);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) tiles.push([ox + x, oy + y]);
  }
  return tiles;
}

/** Can a building of this footprint be placed centred at (gx, gy)? */
export function canPlace(world, gx, gy, fw, fh) {
  for (const [tx, ty] of footprintTiles(gx, gy, fw, fh)) {
    if (!inBounds(world, tx, ty)) return false;
    if (world.blocked[ty * world.width + tx] !== 0) return false;
    if (world.terrain[ty * world.width + tx] === TERRAIN.WATER) return false;
  }
  return true;
}

// --- Entity creation --------------------------------------------------------

function register(world, e) {
  world.entities.set(e.id, e);
  if (e.kind === 'unit') world.units.push(e);
  else if (e.kind === 'building') world.buildings.push(e);
  else if (e.kind === 'resource') world.resources.push(e);
  if (e.player !== undefined && e.player !== null) {
    world.players[e.player].owned.add(e.id);
  }
  world.events.emit(EV.SPAWN, { entity: e });
  return e;
}

export function spawnUnit(world, type, player, gx, gy) {
  const s = UNIT_STATS[type];
  if (!s) throw new Error(`unknown unit type: ${type}`);
  const e = {
    id: world.nextId++,
    kind: 'unit',
    type,
    player,
    x: gx,
    y: gy,
    // Previous position, for render interpolation between sim steps.
    px: gx,
    py: gy,
    vx: 0,
    vy: 0,
    facing: 0,
    hp: s.hp,
    maxHp: s.hp,
    speed: s.speed,
    radius: s.radius,
    attack: s.attack,
    range: s.range,
    armor: s.armor,
    attackCooldown: s.attackCooldown,
    cooldown: 0,
    // Task state machine — owned by unitAI.js. See TASK in unitAI.
    task: null,
    path: null,
    pathIndex: 0,
    repathTimer: 0,
    // Gathering
    carrying: { type: null, amount: 0 },
    gatherProgress: 0,
    // Combat
    target: null,
    attackAnim: 0,
    // Visual state, set by the sim and read by the renderer
    state: 'idle', // idle | move | gather | build | attack | deposit
    dead: false,
  };
  return register(world, e);
}

export function spawnBuilding(world, type, player, gx, gy, { complete = true } = {}) {
  const s = BUILDING_STATS[type];
  if (!s) throw new Error(`unknown building type: ${type}`);
  // Snap the anchor so the footprint lands on whole tiles.
  const ox = Math.floor(gx - s.fw / 2);
  const oy = Math.floor(gy - s.fh / 2);
  const cx = ox + s.fw / 2;
  const cy = oy + s.fh / 2;

  const e = {
    id: world.nextId++,
    kind: 'building',
    type,
    player,
    x: cx,
    y: cy,
    fw: s.fw,
    fh: s.fh,
    tiles: footprintTiles(cx, cy, s.fw, s.fh),
    maxHp: s.hp,
    hp: complete ? s.hp : Math.max(1, Math.round(s.hp * 0.1)),
    complete,
    buildProgress: complete ? s.buildTime : 0,
    buildTime: s.buildTime,
    trains: s.trains || [],
    dropoff: s.dropoff || null,
    popBonus: s.popBonus || 0,
    // Training queue: [{ type, remaining }]
    queue: [],
    // Where trained units walk to after spawning; set by the player via HUD.
    rally: null,
    state: complete ? 'idle' : 'foundation',
    dead: false,
  };

  for (const [tx, ty] of e.tiles) setBlocked(world, tx, ty, 1, e.id);
  register(world, e);
  if (complete) applyPopBonus(world, player);
  return e;
}

// What a node type actually pays out. Kept as a table rather than a chain of
// ternaries: with four resources the chain quietly turned every unrecognised
// node into gold, which is exactly the kind of bug that only shows up as "why
// is my stone mine giving me coins".
const NODE_RESOURCE = {
  tree: RES.WOOD,
  berry: RES.FOOD,
  gold: RES.GOLD,
  stone: RES.STONE,
};

export function spawnResource(world, type, gx, gy) {
  const resourceType = NODE_RESOURCE[type];
  if (!resourceType) throw new Error(`unknown resource node type: ${type}`);
  const tx = Math.floor(gx);
  const ty = Math.floor(gy);
  const e = {
    id: world.nextId++,
    kind: 'resource',
    type,
    player: null,
    x: tx + 0.5,
    y: ty + 0.5,
    resourceType,
    amount: NODE_AMOUNT[type],
    maxAmount: NODE_AMOUNT[type],
    // How many villagers are working this node (keeps crowds from stacking).
    workers: 0,
    variant: Math.floor(world.rng() * 3),
    dead: false,
  };
  setBlocked(world, tx, ty, 1, e.id);
  return register(world, e);
}

// --- Entity removal ---------------------------------------------------------

export function removeEntity(world, e) {
  if (!world.entities.has(e.id)) return;
  e.dead = true;
  world.entities.delete(e.id);

  if (e.kind === 'unit') {
    const i = world.units.indexOf(e);
    if (i >= 0) world.units.splice(i, 1);
  } else if (e.kind === 'building') {
    const i = world.buildings.indexOf(e);
    if (i >= 0) world.buildings.splice(i, 1);
    for (const [tx, ty] of e.tiles) setBlocked(world, tx, ty, 0);
  } else if (e.kind === 'resource') {
    const i = world.resources.indexOf(e);
    if (i >= 0) world.resources.splice(i, 1);
    setBlocked(world, Math.floor(e.x), Math.floor(e.y), 0);
  }

  if (e.player !== null && e.player !== undefined) {
    world.players[e.player].owned.delete(e.id);
    if (e.kind === 'building' && e.complete) applyPopBonus(world, e.player);
  }
  world.selection.delete(e.id);

  // Anything referencing this entity must drop the reference now.
  for (const u of world.units) {
    if (u.target === e) u.target = null;
    if (u.task && (u.task.node === e || u.task.target === e || u.task.building === e)) {
      u.task = null;
      u.state = 'idle';
    }
  }
  world.events.emit(EV.REMOVED, { entity: e });
}

// --- Population -------------------------------------------------------------

export function applyPopBonus(world, playerId) {
  const p = world.players[playerId];
  let cap = 0;
  for (const id of p.owned) {
    const e = world.entities.get(id);
    if (e && e.kind === 'building' && e.complete) cap += e.popBonus;
  }
  p.popCap = Math.min(MAX_POP_CAP, cap);
}

export function recomputePop(world, playerId) {
  const p = world.players[playerId];
  let pop = 0;
  for (const id of p.owned) {
    const e = world.entities.get(id);
    if (e && e.kind === 'unit') pop += UNIT_STATS[e.type].pop;
  }
  // Queued units reserve population so you cannot over-queue past the cap.
  for (const id of p.owned) {
    const e = world.entities.get(id);
    if (e && e.kind === 'building') pop += e.queue.length;
  }
  p.pop = pop;
  return pop;
}

// --- Queries ----------------------------------------------------------------

/** Rebuild the spatial buckets. Called once per sim step by the game loop. */
export function reindex(world) {
  for (const b of world._buckets) b.length = 0;
  const cs = world._cellSize;
  const push = (e) => {
    const cx = Math.min(world._cols - 1, Math.max(0, Math.floor(e.x / cs)));
    const cy = Math.min(world._rows - 1, Math.max(0, Math.floor(e.y / cs)));
    world._buckets[cy * world._cols + cx].push(e);
  };
  for (const e of world.units) push(e);
  for (const e of world.buildings) push(e);
  for (const e of world.resources) push(e);
}

/**
 * Call `fn` for every entity whose centre lies within `radius` grid units.
 * Buildings are treated as their bounding box, so large ones are found from
 * anywhere along their edge.
 */
export function forEachNear(world, gx, gy, radius, fn) {
  const cs = world._cellSize;
  // Buildings can extend up to 1.5 tiles past their centre; widen the sweep.
  const pad = radius + 2;
  const x0 = Math.max(0, Math.floor((gx - pad) / cs));
  const x1 = Math.min(world._cols - 1, Math.floor((gx + pad) / cs));
  const y0 = Math.max(0, Math.floor((gy - pad) / cs));
  const y1 = Math.min(world._rows - 1, Math.floor((gy + pad) / cs));
  const r2 = radius * radius;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      for (const e of world._buckets[cy * world._cols + cx]) {
        if (e.dead) continue;
        if (edgeDist2(e, gx, gy) <= r2) fn(e);
      }
    }
  }
}

/** Squared distance from (gx,gy) to an entity, accounting for footprint. */
export function edgeDist2(e, gx, gy) {
  if (e.kind === 'building') {
    const hw = e.fw / 2;
    const hh = e.fh / 2;
    const dx = Math.max(Math.abs(gx - e.x) - hw, 0);
    const dy = Math.max(Math.abs(gy - e.y) - hh, 0);
    return dx * dx + dy * dy;
  }
  return dist2(e.x, e.y, gx, gy);
}

export function edgeDist(e, gx, gy) {
  return Math.sqrt(edgeDist2(e, gx, gy));
}

/** Nearest entity matching `pred` within `radius`, or null. */
export function findNearest(world, gx, gy, radius, pred) {
  let best = null;
  let bestD = Infinity;
  forEachNear(world, gx, gy, radius, (e) => {
    if (!pred(e)) return;
    const d = edgeDist2(e, gx, gy);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  });
  return best;
}

/**
 * Nearest matching entity with no radius limit. Slower (linear scan) — use for
 * infrequent decisions like "where is my closest drop-off point".
 */
export function findNearestGlobal(world, gx, gy, list, pred) {
  let best = null;
  let bestD = Infinity;
  for (const e of list) {
    if (e.dead || !pred(e)) continue;
    const d = edgeDist2(e, gx, gy);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

export function isHostile(a, b) {
  return (
    a.player !== null && b.player !== null &&
    a.player !== undefined && b.player !== undefined &&
    a.player !== b.player
  );
}

/** All live entities owned by a player, optionally filtered by kind/type. */
export function ownedBy(world, playerId, kind = null, type = null) {
  const out = [];
  for (const id of world.players[playerId].owned) {
    const e = world.entities.get(id);
    if (!e || e.dead) continue;
    if (kind && e.kind !== kind) continue;
    if (type && e.type !== type) continue;
    out.push(e);
  }
  return out;
}
