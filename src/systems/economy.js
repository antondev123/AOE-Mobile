// Economy: stockpiles, gathering, drop-off, construction, training queues, pop.
//
// This module owns *the numbers*. The unit AI owns movement and the task state
// machine; it walks a villager somewhere and then calls into here every sim
// step (`gatherTick`, `buildTick`) or once on arrival (`depositCarry`).
// Nothing here moves a unit or paths — that would be a dependency cycle.
//
// No Phaser imports: this file must run headlessly under Node (see
// tests/economy.test.mjs).

import {
  RES, CARRY_CAPACITY, GATHER_RATE, BUILD_RATE,
  UNIT_STATS, BUILDING_STATS, TERRAIN, MAX_POP_CAP,
} from '../core/constants.js';
import { EV } from '../core/events.js';
import {
  spawnUnit, spawnBuilding, removeEntity, canPlace, isBlocked, inBounds,
  applyPopBonus, recomputePop, edgeDist2,
} from '../core/world.js';

// --- Tuning (local to this module; constants.js is read-only for me) --------
//
// GATHER_RATE in constants.js is AoE2's real-time pace (~0.5/sec), which makes
// a 10-unit trip take ~20 seconds — far too slow to read as a *loop* on a phone
// in a 10-minute skirmish. Scaling by GATHER_SPEED compresses the harvest leg
// to ~3 seconds, so with a 3-4 tile walk each way a full round trip lands
// around 8-10 seconds: long enough to see the villager work, short enough that
// the food counter visibly ticks up.
export const GATHER_SPEED = 6.0;

/** Effective units/second for a resource type, after tuning. */
export function gatherRateFor(resourceType) {
  return (GATHER_RATE[resourceType] || 0.5) * GATHER_SPEED;
}

/** Longest a training queue may get (AoE2 uses 5 per building tab). */
export const MAX_QUEUE = 5;

// --- Farms (buildings you harvest) ------------------------------------------
//
// A building whose stats carry `provides: { type, amount }` — currently the
// Farm — is a resource node you paid wood for. Once complete it behaves exactly
// like a berry bush: a villager stands next to it, fills its pack, and walks the
// load to a drop-off. Nothing trickles in passively, so the visible gather loop
// is identical and a farm is worth exactly as much as the villager working it.
//
// EXHAUSTION: a spent farm is removed from the world, the same way an emptied
// bush is, and the player (or the AI) rebuilds one for another 60 wood. Reasons:
//   * There is no demolish order in this game. A derelict 2x2 husk would block
//     its ground forever with no way to clear it — the worst outcome on a phone.
//   * Auto re-seeding (AoE2's farm queue) would have to spend the player's wood
//     without an order, off-screen, which is not readable on a 390px HUD.
//   * Removal reuses the exact depleted-node path, so villagers retask to the
//     next food source, tasks pointing at it are cleared, and the tile is free
//     for the replacement farm — all behaviour that already exists and is tested.

/** The `provides` block for a building type, or null if it is not harvestable. */
export function providesOf(type) {
  const s = BUILDING_STATS[type];
  return (s && s.provides) || null;
}

/**
 * Stamp the node fields (`resourceType`, `amount`, `maxAmount`) onto a completed
 * provider building. Idempotent, and a no-op for everything else — call it
 * anywhere a farm might first be looked at.
 */
export function initProvider(building) {
  if (!building || building.dead || !building.complete) return building;
  const p = providesOf(building.type);
  if (!p) return building;
  if (building.resourceType === undefined || building.resourceType === null) {
    building.resourceType = p.type;
    building.amount = p.amount;
    building.maxAmount = p.amount;
    building.workers = building.workers || 0;
  }
  return building;
}

/** True when `b` is a finished farm (or other provider) with food still in it. */
export function isGatherableBuilding(b) {
  if (!b || b.dead || b.kind !== 'building' || !b.complete) return false;
  if (!providesOf(b.type)) return false;
  initProvider(b);
  return b.amount > 0;
}

/**
 * Every harvestable farm belonging to `playerId`. Cheap (one pass over
 * buildings) and used by the unit AI and the enemy AI when looking for food.
 */
export function gatherableBuildings(world, playerId) {
  const out = [];
  for (const b of world.buildings) {
    if (b.player !== playerId) continue;
    if (isGatherableBuilding(b)) out.push(b);
  }
  return out;
}

/** Can `unit` harvest `node`? Farms are private; bushes belong to nobody. */
export function canGatherFrom(unit, node) {
  if (!node || node.dead) return false;
  if (node.kind === 'building') {
    return isGatherableBuilding(node) && node.player === unit.player;
  }
  return node.kind === 'resource' && node.amount > 0;
}

/** Seconds between repeated "population capped" nags, per player. */
const POP_CAP_NAG_INTERVAL = 6;

/** Rings searched around a building when looking for a free spawn tile. */
const SPAWN_SEARCH_RINGS = 4;

// --- Internal state ---------------------------------------------------------

function econState(world) {
  if (!world._economy) {
    world._economy = {
      popNag: world.players.map(() => 0), // seconds until we may nag again
    };
  }
  return world._economy;
}

const RES_KEYS = [RES.FOOD, RES.WOOD, RES.GOLD];

function playerOf(world, playerId) {
  return world.players[playerId] || null;
}

// --- Stockpile --------------------------------------------------------------

/** Does the player have every resource in `cost`? A missing key means 0. */
export function canAfford(world, playerId, cost) {
  const p = playerOf(world, playerId);
  if (!p) return false;
  if (!cost) return true;
  for (const k of RES_KEYS) {
    const need = cost[k] || 0;
    if (need > 0 && (p.resources[k] || 0) < need) return false;
  }
  return true;
}

/**
 * Move `amount` of `type` into (or out of, if negative) a player's stockpile.
 * Every stockpile mutation in the game goes through here so EV.RESOURCE_CHANGE
 * always fires and the HUD can stay in sync without polling.
 */
export function addResource(world, playerId, type, amount, reason = 'other') {
  const p = playerOf(world, playerId);
  if (!p || !amount || !RES_KEYS.includes(type)) return 0;

  const before = p.resources[type] || 0;
  const after = Math.max(0, before + amount);
  const delta = after - before;
  if (delta === 0) return 0;

  p.resources[type] = after;
  world.events.emit(EV.RESOURCE_CHANGE, {
    player: playerId,
    playerId,
    type,
    amount: delta,
    total: after,
    reason,
  });
  return delta;
}

/** Charge a cost. Returns false (and emits EV.INSUFFICIENT) if broke. */
export function pay(world, playerId, cost, reason = 'spend') {
  if (!canAfford(world, playerId, cost)) {
    world.events.emit(EV.INSUFFICIENT, { player: playerId, playerId, cost });
    return false;
  }
  if (!cost) return true;
  for (const k of RES_KEYS) {
    const need = cost[k] || 0;
    if (need > 0) addResource(world, playerId, k, -need, reason);
  }
  return true;
}

/** Give a cost back (cancelled training, refunded foundation). */
export function refund(world, playerId, cost, reason = 'refund') {
  if (!cost) return;
  for (const k of RES_KEYS) {
    const give = cost[k] || 0;
    if (give > 0) addResource(world, playerId, k, give, reason);
  }
}

// --- Gathering --------------------------------------------------------------

function ensureCarry(unit) {
  if (!unit.carrying) unit.carrying = { type: null, amount: 0 };
  return unit.carrying;
}

function nodeIsLive(world, node) {
  if (!node || node.dead || !world.entities.has(node.id)) return false;
  // A farm is only a node once it is finished; a foundation is a build job.
  if (node.kind === 'building') return isGatherableBuilding(node);
  return node.amount > 0;
}

/**
 * Harvest from `node` for `dt` seconds. Called every sim step by the unit AI
 * while `unit.state === 'gather'`. `node` is either a resource node or one of
 * this player's completed farms — they are harvested identically.
 *
 * Returns true when the villager should stop and walk to a drop-off: either the
 * pack is full or the node is gone.
 */
export function gatherTick(world, unit, node, dt) {
  if (!unit || unit.dead) return true;
  const carry = ensureCarry(unit);

  // Someone else's farm is not food you may take.
  if (node && node.kind === 'building' && node.player !== unit.player) return true;

  // Node vanished or was already emptied by someone else.
  if (!nodeIsLive(world, node)) {
    if (node && !node.dead && node.amount <= 0 && node.resourceType) {
      depleteNode(world, node);
    }
    return true;
  }

  const type = node.resourceType;

  // Carrying something else? Bank it before switching resource.
  if (carry.type && carry.type !== type) {
    if (carry.amount > 0) return true;
    carry.type = null;
  }
  if (carry.amount >= CARRY_CAPACITY) return true;

  if (!carry.type) {
    carry.type = type;
    unit.gatherProgress = unit.gatherProgress || 0;
  }

  unit.gatherProgress = (unit.gatherProgress || 0) + gatherRateFor(type) * dt;

  // Bank whole units only — the renderer draws one "chip" per EV.GATHER_TICK.
  let guard = 64;
  while (
    unit.gatherProgress >= 1 &&
    carry.amount < CARRY_CAPACITY &&
    node.amount > 0 &&
    guard-- > 0
  ) {
    unit.gatherProgress -= 1;
    node.amount -= 1;
    carry.amount += 1;
    world.events.emit(EV.GATHER_TICK, { unit, node, type, amount: 1 });
  }

  const full = carry.amount >= CARRY_CAPACITY;
  if (full) unit.gatherProgress = 0;

  if (node.amount <= 0) {
    depleteNode(world, node);
    return true;
  }
  return full;
}

/**
 * Announce, then remove, an exhausted node.
 *
 * A spent farm goes through here too: it is removed exactly like an emptied
 * bush, which frees its ground for the replacement farm and lets every villager
 * on it retask through the path that already exists. See the Farms note above.
 */
function depleteNode(world, node) {
  if (!node || node.dead) return;
  node.amount = 0;
  // Emitted *before* removal so the unit AI can retask onto the nearest
  // equivalent node using this one's position; removeEntity() then clears any
  // task still pointing at it.
  world.events.emit(EV.NODE_DEPLETED, { node });
  removeEntity(world, node);
}

// --- Drop-off ---------------------------------------------------------------

/** Can this building bank that resource type right now? */
export function acceptsDropoff(building, resourceType) {
  return !!(
    building &&
    !building.dead &&
    building.complete &&
    building.dropoff &&
    building.dropoff.includes(resourceType)
  );
}

/**
 * Nearest completed building of `playerId` that accepts `resourceType`.
 * Exported because "where do I drop this off" is an economy rule, but the
 * walking to it is the unit AI's job.
 */
export function nearestDropoff(world, playerId, gx, gy, resourceType) {
  let best = null;
  let bestD = Infinity;
  for (const b of world.buildings) {
    if (b.player !== playerId) continue;
    if (!acceptsDropoff(b, resourceType)) continue;
    const d = edgeDist2(b, gx, gy);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * Bank whatever the villager is carrying. Instant on arrival.
 * Returns the amount actually banked (0 if the building will not take it).
 */
export function depositCarry(world, unit, building) {
  if (!unit || unit.dead) return 0;
  const carry = ensureCarry(unit);
  if (!carry.type || carry.amount <= 0) return 0;
  if (!building || building.player !== unit.player) return 0;
  if (!acceptsDropoff(building, carry.type)) return 0;

  const type = carry.type;
  const amount = Math.floor(carry.amount);
  if (amount <= 0) return 0;

  addResource(world, unit.player, type, amount, 'gather');
  world.events.emit(EV.DEPOSIT, { unit, building, type, amount });

  carry.type = null;
  carry.amount = 0;
  unit.gatherProgress = 0;
  return amount;
}

// --- Foundations & construction --------------------------------------------

/**
 * Validate, charge and place a construction site. Returns the new building or
 * null (emitting EV.INSUFFICIENT or EV.TOAST to say why).
 */
export function placeFoundation(world, playerId, type, gx, gy) {
  const s = BUILDING_STATS[type];
  if (!s) return null;

  if (!canPlace(world, gx, gy, s.fw, s.fh)) {
    world.events.emit(EV.TOAST, { text: `Cannot build there`, tone: 'warn' });
    return null;
  }
  if (!canAfford(world, playerId, s.cost)) {
    world.events.emit(EV.INSUFFICIENT, { player: playerId, playerId, cost: s.cost });
    return null;
  }
  if (!pay(world, playerId, s.cost, `build:${type}`)) return null;

  const b = spawnBuilding(world, type, playerId, gx, gy, { complete: false });
  b.state = 'foundation';
  world.events.emit(EV.FOUNDATION, { building: b, builder: null });
  return b;
}

/**
 * Abandon an unfinished building: refund what it cost and take the site back.
 *
 * A foundation nobody can reach is otherwise permanent — there is no demolish
 * order — and it goes on blocking both its ground and, for the AI, the "do I
 * already have one of these" test. Returns false for anything already finished.
 */
export function cancelFoundation(world, building, { giveBack = true } = {}) {
  if (!building || building.dead || building.kind !== 'building') return false;
  if (building.complete) return false;
  const s = BUILDING_STATS[building.type];
  if (giveBack && s) refund(world, building.player, s.cost, `cancel:${building.type}`);
  removeEntity(world, building);
  return true;
}

/**
 * Advance construction by one builder for `dt` seconds. Several villagers may
 * each call this in the same step — progress simply adds up, so a second
 * builder halves the wall-clock time.
 *
 * Returns true when the building is finished (also true if it already was, so
 * a late caller is told to stop).
 */
export function buildTick(world, unit, building, dt) {
  if (!building || building.dead) return true;
  if (building.complete) return true;

  const total = building.buildTime || BUILDING_STATS[building.type].buildTime;
  building.buildProgress = (building.buildProgress || 0) + BUILD_RATE * dt;

  const frac = Math.max(0, Math.min(1, building.buildProgress / total));
  // Scaffolding starts at 10% hp and grows into the finished shell.
  building.hp = Math.max(1, Math.round(building.maxHp * (0.1 + 0.9 * frac)));

  if (building.buildProgress >= total) {
    building.buildProgress = total;
    building.complete = true;
    building.hp = building.maxHp;
    building.state = 'idle';
    // A finished Farm is a food node from this instant, so the villager that
    // built it can turn round and start harvesting without a new order.
    initProvider(building);
    applyPopBonus(world, building.player);
    recomputePop(world, building.player);
    world.events.emit(EV.BUILT, { building, builder: unit || null });
    return true;
  }
  building.state = 'foundation';
  return false;
}

// --- Training ---------------------------------------------------------------

function popOf(unitType) {
  const s = UNIT_STATS[unitType];
  return s ? s.pop || 1 : 1;
}

function nagPopCapped(world, playerId, force = false) {
  const st = econState(world);
  if (force || (st.popNag[playerId] || 0) <= 0) {
    st.popNag[playerId] = POP_CAP_NAG_INTERVAL;
    world.events.emit(EV.POP_CAPPED, { player: playerId, playerId });
  }
}

/**
 * Queue a unit at a building. The cost is charged now and refunded on cancel
 * (AoE2 behaviour), and the queued unit reserves population immediately — see
 * recomputePop() in world.js — so you cannot over-queue past the cap.
 */
export function queueTrain(world, building, unitType) {
  if (!building || building.dead || !building.complete) return false;
  if (!building.trains || !building.trains.includes(unitType)) return false;
  const s = UNIT_STATS[unitType];
  if (!s) return false;

  const playerId = building.player;
  const p = playerOf(world, playerId);
  if (!p) return false;

  if (building.queue.length >= MAX_QUEUE) {
    world.events.emit(EV.TOAST, { text: 'Queue is full', tone: 'warn' });
    return false;
  }

  // Housing: pop already includes everything queued elsewhere.
  applyPopBonus(world, playerId);
  recomputePop(world, playerId);
  if (p.pop + popOf(unitType) > p.popCap) {
    nagPopCapped(world, playerId, true);
    return false;
  }

  if (!pay(world, playerId, s.cost, `train:${unitType}`)) return false;

  building.queue.push({ type: unitType, remaining: s.buildTime, total: s.buildTime });
  recomputePop(world, playerId);
  return true;
}

/** Cancel a queued unit and refund it in full. */
export function cancelTrain(world, building, index) {
  if (!building || !building.queue) return false;
  const i = index === undefined ? building.queue.length - 1 : index;
  if (i < 0 || i >= building.queue.length) return false;

  const [entry] = building.queue.splice(i, 1);
  const s = UNIT_STATS[entry.type];
  if (s) refund(world, building.player, s.cost, `cancel:${entry.type}`);
  recomputePop(world, building.player);
  return true;
}

/** A walkable, unblocked tile next to a building, preferring one near `toward`. */
function freeTileNear(world, building, toward) {
  const ox = Math.floor(building.x - building.fw / 2);
  const oy = Math.floor(building.y - building.fh / 2);
  const tx0 = toward ? toward.x : building.x;
  const ty0 = toward ? toward.y : building.y;

  let best = null;
  let bestD = Infinity;
  for (let r = 1; r <= SPAWN_SEARCH_RINGS; r++) {
    for (let y = oy - r; y < oy + building.fh + r; y++) {
      for (let x = ox - r; x < ox + building.fw + r; x++) {
        // Perimeter of this ring only.
        const onRing =
          x === ox - r || x === ox + building.fw + r - 1 ||
          y === oy - r || y === oy + building.fh + r - 1;
        if (!onRing) continue;
        if (!inBounds(world, x, y)) continue;
        if (isBlocked(world, x, y)) continue;
        if (world.terrain[y * world.width + x] === TERRAIN.WATER) continue;
        const cx = x + 0.5;
        const cy = y + 0.5;
        const d = (cx - tx0) * (cx - tx0) + (cy - ty0) * (cy - ty0);
        if (d < bestD) {
          bestD = d;
          best = { x: cx, y: cy };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

function completeTraining(world, building, entry) {
  const playerId = building.player;
  const spot = freeTileNear(world, building, building.rally);
  if (!spot) return false; // walled in — hold the unit in the queue

  const unit = spawnUnit(world, entry.type, playerId, spot.x, spot.y);

  // Rally is a movement order and movement is the unit AI's department, so it
  // is handed over rather than executed: the AI listens for EV.TRAINED (or
  // picks up `unit.pendingRally` on its next pass) and issues the walk.
  if (building.rally) {
    unit.pendingRally = { x: building.rally.x, y: building.rally.y };
  }

  world.events.emit(EV.TRAINED, {
    building,
    unit,
    unitType: entry.type,
    rally: building.rally || null,
  });
  recomputePop(world, playerId);
  return true;
}

// --- Per-step update --------------------------------------------------------

/**
 * Advance training queues and keep population figures honest.
 * Called once per fixed sim step from GameScene.
 */
export function updateEconomy(world, dt) {
  const st = econState(world);

  for (let i = 0; i < world.players.length; i++) {
    if (st.popNag[i] > 0) st.popNag[i] -= dt;
    applyPopBonus(world, i);
    recomputePop(world, i);
  }

  for (const b of world.buildings) {
    if (b.dead || !b.queue || b.queue.length === 0) continue;
    if (!b.complete) continue;

    const p = playerOf(world, b.player);
    if (!p) continue;

    // Housing was destroyed under a queued unit — stall rather than pop over.
    if (p.pop > p.popCap) {
      nagPopCapped(world, b.player);
      continue;
    }

    const head = b.queue[0];
    head.remaining -= dt;
    if (head.remaining > 0) continue;

    if (completeTraining(world, b, head)) {
      b.queue.shift();
      // Carry any overshoot into the next unit so a long queue keeps cadence.
      const over = -head.remaining;
      if (b.queue.length > 0) b.queue[0].remaining -= over;
    } else {
      // No room to place the unit; try again next step.
      head.remaining = 0;
    }
  }

  for (let i = 0; i < world.players.length; i++) recomputePop(world, i);
}

// --- Read-only helpers for the HUD / AI -------------------------------------

/** Progress 0..1 of the unit currently training at a building (0 if idle). */
export function trainProgress(building) {
  if (!building || !building.queue || building.queue.length === 0) return 0;
  const h = building.queue[0];
  const total = h.total || UNIT_STATS[h.type].buildTime;
  return Math.max(0, Math.min(1, 1 - h.remaining / total));
}

/** Progress 0..1 of a building under construction. */
export function buildProgressOf(building) {
  if (!building) return 0;
  if (building.complete) return 1;
  const total = building.buildTime || BUILDING_STATS[building.type].buildTime;
  return Math.max(0, Math.min(1, (building.buildProgress || 0) / total));
}

/** True if the player has room for one more unit of this type. */
export function hasPopRoom(world, playerId, unitType = 'villager') {
  const p = playerOf(world, playerId);
  if (!p) return false;
  return p.pop + popOf(unitType) <= Math.min(MAX_POP_CAP, p.popCap);
}
