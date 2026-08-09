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
  UNIT_STATS, BUILDING_STATS, TERRAIN, MAX_POP_CAP, PLAYER,
  isWallType, isGateType, wallFamily,
} from '../core/constants.js';
import { EV } from '../core/events.js';
import {
  spawnUnit, spawnBuilding, removeEntity, canPlace, placeBlockedBy, isBlocked, inBounds,
  applyPopBonus, recomputePop, edgeDist2, footprintTiles, ownedBy, forEachNear,
  onBuildingComplete, setGateOpen, isHostile,
} from '../core/world.js';
import { pointsSealedBy, hasOpenPerimeter } from './pathfinding.js';
// tech.js imports the three stockpile primitives back out of this module, so
// the pair is a deliberate (and shallow) import cycle — see the note at the top
// of tech.js. Research is production, so it ticks on this module's beat.
import {
  updateResearch, gatherMultiplier, lockReason, applyAgeHp,
} from './tech.js';

// --- Tuning (local to this module; constants.js is read-only for me) --------
//
// GATHER_RATE in constants.js is AoE2's real-time pace (~0.5/sec), which makes
// a 10-unit trip take ~20 seconds. GATHER_SPEED is the one dial that sets how
// compressed this skirmish is against that.
//
// It used to be 6.0, which put the harvest leg at ~3 seconds. That was too fast
// to be a strategy game: a villager finished a pack before you could finish
// reading the HUD, the whole opening was over in ninety seconds, and there was
// never a moment where nothing needed tapping. 2.5 is the AoE2 rhythm at
// skirmish length — measured beside a Town Center, a full pack now takes 7.3s
// on berries, 8.0s on wood, 8.9s on gold and 9.5s on stone, and with a 3-4 tile
// walk each way (villagers move at 1.35 tiles/s) a round trip measures 12-14
// seconds. That is roughly 0.75 resources/second per villager, so a villager
// pays for the next villager in about a minute of its own work: slow enough to
// have to choose what to build, fast enough that the counter never looks stuck.
//
// If you change this, change the train and build times in constants.js with it.
// The two are a matched pair — halving income without lengthening production
// does not slow the game down, it just makes the Town Center idle.
export const GATHER_SPEED = 2.5;

/**
 * Effective units/second for a resource type, after tuning and after whichever
 * economic upgrades the gathering player has finished.
 *
 * `world` and `playerId` are optional and default to "nobody, so no upgrades".
 * They are trailing arguments rather than leading ones on purpose: the rate is
 * a property of the *resource* first and of the player second, every existing
 * caller reads the same way it always did, and a caller that forgets to pass a
 * player gets the un-upgraded base rate — which is wrong but never a crash, and
 * shows up immediately as "my Bow Saw did nothing" rather than as a NaN.
 *
 * The multiplier is applied here rather than inside gatherTick so that anything
 * *predicting* income — the HUD, the AI's "is this walk worth it" arithmetic,
 * the round-trip test in tests/economy.test.mjs — asks one function and gets
 * the number the villager will actually gather at.
 */
export function gatherRateFor(resourceType, world = null, playerId = null) {
  const base = (GATHER_RATE[resourceType] || 0.5) * GATHER_SPEED;
  if (!world || playerId === null || playerId === undefined) return base;
  return base * gatherMultiplier(world, playerId, resourceType);
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
      // Ordered lists of foundation ids the player asked for in one breath —
      // see the build queue section below.
      buildQueue: world.players.map(() => []),
    };
  }
  // Older worlds (and the odd hand-built test fixture) predate the queue.
  if (!world._economy.buildQueue) {
    world._economy.buildQueue = world.players.map(() => []);
  }
  return world._economy;
}

// Every resource the stockpile knows about. canAfford, pay, refund and
// addResource all iterate this, so a resource that is not listed here can be
// gathered into a villager's pack and then silently vanish on deposit.
const RES_KEYS = [RES.FOOD, RES.WOOD, RES.GOLD, RES.STONE];

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

  unit.gatherProgress =
    (unit.gatherProgress || 0) + gatherRateFor(type, world, unit.player) * dt;

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
 *
 * "Nearest" is by *edge* distance, not centre distance, because a 3x3 Town
 * Center is reached a tile and a half before its middle and a 2x2 Lumber Camp
 * is not — comparing centres would send villagers past a camp they were
 * standing next to. Every building the player owns is considered, not just the
 * Town Center: that is the whole reason a Lumber Camp is worth 100 wood.
 *
 * This is deliberately re-evaluated on every trip (unitAI's routeToDropoff calls
 * it each time a villager fills its pack), so a camp planted mid-game shortens
 * the round trip of every villager already working that woodline without the
 * player re-tasking a single one. The scan is a linear pass over one player's
 * buildings and happens once per full pack — around once every ten seconds per
 * villager — which is nothing.
 *
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

// --- Placement reachability --------------------------------------------------
//
// world.canPlace() answers the geometric question — in bounds, nothing there,
// not water. That is not enough: the ghost went green for the farm that closed
// the last gap around a one-tile hole with eight villagers in it, and those
// eight were gone for the rest of the match. Demolishing a wall can undo it
// after the fact, but a player should never have to notice, diagnose and undo
// a mistake the placement rules let them make in the first place.
//
// What this layer forbids is narrow on purpose. Walling is legitimate: enclosing
// your base, or a whole quarter of the map, is a real AoE2 play and must keep
// working. The only thing refused is a placement that would leave *the placing
// player's own* units, or the last way out of their unit-producing buildings,
// inside a pocket (see POCKET_LIMIT in pathfinding.js). Anything that seals a
// map-sized area is allowed, and anything already stuck stays this module's
// business rather than the new building's fault.

const TRAP_UNITS_MSG = 'That would trap your villagers';
const TRAP_EXIT_MSG = 'That would seal in your Town Center';

/** Why this placement is refused, or null when it is fine. */
function placementTrapReason(world, playerId, type, gx, gy) {
  const s = BUILDING_STATS[type];
  if (!s) return null;
  return tilesTrapReason(world, playerId, footprintTiles(gx, gy, s.fw, s.fh));
}

/**
 * The same question asked about an arbitrary set of tiles rather than one
 * building's footprint — which is what a wall run is.
 *
 * Asking it once for the whole run is not merely faster than asking it forty
 * times (it is: each call floods a bounded region per owned unit, and forty of
 * those inside a drag handler is a visible stutter on a phone). It is also the
 * more honest question. The segment that seals your base is only sealing it
 * because the thirty-nine before it went down; testing them one at a time asks
 * "does *this* brick trap anyone", which is never the thing the player did.
 */
export function tilesTrapReason(world, playerId, tiles) {
  const units = ownedBy(world, playerId, 'unit');
  if (units.length && pointsSealedBy(world, tiles, units).length > 0) return TRAP_UNITS_MSG;

  // Buildings that put units on the map need a way out for them. If every free
  // tile around one would become a pocket, its queue can never be emptied.
  const blocked = new Set();
  for (const [tx, ty] of tiles) {
    if (inBounds(world, tx, ty)) blocked.add(ty * world.width + tx);
  }
  for (const b of ownedBy(world, playerId, 'building')) {
    if (!b.complete || !b.trains || b.trains.length === 0) continue;
    if (!hasOpenPerimeter(world, b.tiles)) continue; // already boxed in; not our doing
    if (!hasOpenPerimeter(world, b.tiles, { extraBlocked: blocked })) return TRAP_EXIT_MSG;
  }
  return null;
}

/**
 * The sentence explaining why this placement would be refused, or null when it
 * is fine — geometry first, then the reachability rules above.
 *
 * This is the same text placeFoundation() would toast, so the ghost can refuse
 * a tile in the player's own words instead of a generic "cannot build there",
 * and the refusal is worded identically wherever it is raised.
 */
export function placementRefusal(world, playerId, type, gx, gy) {
  const s = BUILDING_STATS[type];
  if (!s) return 'Cannot build there';
  // Age first, and before the geometry: "Stone Wall needs the Feudal Age" is
  // the true answer wherever you point at, and a ghost that only goes red on
  // *some* tiles would teach the player that the tile was the problem.
  const locked = lockReason(world, playerId, type);
  if (locked) return locked;
  // A gate cut into one of our own wall segments is not "blocked" — see
  // gateReplaceable and the note in placeFoundation. The ghost has to know, or
  // it goes red over the one tile the placement will actually accept.
  if (!gateReplaceable(world, playerId, type, gx, gy)) {
    const blocked = placeBlockedBy(world, gx, gy, s.fw, s.fh);
    if (blocked) return blocked;
  }
  return placementTrapReason(world, playerId, type, gx, gy);
}

/**
 * The wall segment a gate would be cut into here, or null.
 *
 * Only ours, only a finished-or-building wall of the same family, only for a
 * type that is actually a gate, and only for the 1x1 footprint every gate has.
 * Everything else falls through to the ordinary "something is in the way".
 */
export function gateReplaceable(world, playerId, type, gx, gy) {
  if (!isGateType(type)) return null;
  const fam = wallFamily(type);
  if (!fam) return null;
  const tx = Math.floor(gx);
  const ty = Math.floor(gy);
  if (!inBounds(world, tx, ty)) return null;
  const id = world.occupant[ty * world.width + tx];
  const e = id ? world.entities.get(id) : null;
  if (!e || e.dead || e.kind !== 'building' || e.player !== playerId) return null;
  if (isGateType(e.type) || wallFamily(e.type) !== fam) return null;
  return e;
}

/**
 * canPlace() plus the reachability rules above: true when `playerId` may put a
 * `type` here without sealing its own units in.
 *
 * Exported under this exact name so the placement ghost can colour itself with
 * the same predicate the placement itself uses — a green ghost that then refuses
 * the tap is worse than no ghost at all.
 */
export function canPlaceReachable(world, playerId, type, gx, gy) {
  return placementRefusal(world, playerId, type, gx, gy) === null;
}

/**
 * Validate, charge and place a construction site. Returns the new building or
 * null (emitting EV.INSUFFICIENT or EV.TOAST to say why).
 */
export function placeFoundation(world, playerId, type, gx, gy, opts = {}) {
  const s = BUILDING_STATS[type];
  if (!s) return null;
  // `quiet` suppresses the per-refusal announcements. Only the wall-line placer
  // uses it: forty segments across a treeline would otherwise be forty toasts
  // and forty "not enough resources" flashes saying one thing.
  const quiet = opts.quiet === true;

  const locked = lockReason(world, playerId, type);
  if (locked) {
    if (!quiet && playerId === PLAYER) {
      world.events.emit(EV.TOAST, { text: locked, tone: 'warn' });
    }
    return null;
  }
  // A GATE GOES INTO A WALL, which is the only place anybody has ever wanted
  // one. BUILDABLE lists the gate right beside its wall "because they are
  // placed in the same breath: you draw a run and then put the door in it" —
  // and the code refused exactly that, because a wall segment blocks its tile
  // and canPlace does not care who put it there. The only way through was to
  // select the segment, demolish it for no refund, and then hit the one-tile
  // gap with a ghost that (before this pass) did not even agree with the drag
  // about which tile it was on.
  //
  // So the gate replaces the segment. Same owner, same wall family, and the
  // segment's cost comes back — the player is not paying twice for one tile,
  // and swapping a palisade for a stone gate is not a way to launder cheap wood
  // into an expensive wall.
  const replaces = gateReplaceable(world, playerId, type, gx, gy);
  if (!replaces) {
    const blocked = placeBlockedBy(world, gx, gy, s.fw, s.fh);
    if (blocked) {
      if (!quiet) world.events.emit(EV.TOAST, { text: blocked, tone: 'warn' });
      return null;
    }
  }
  // skipTrap: the wall-line placer has already asked this question once about
  // the finished run, which is both the cheaper and the more honest form of it
  // (see tilesTrapReason). Every intermediate state of the run blocks a subset
  // of the tiles that final test approved, so if the finished wall traps nobody
  // then neither does any segment on the way to it.
  const trap = opts.skipTrap ? null : placementTrapReason(world, playerId, type, gx, gy);
  if (trap) {
    // Only the human is told: the enemy AI places dozens of buildings a match
    // and "that would trap your villagers" about someone else's villagers is a
    // lie on the player's screen.
    if (!quiet && playerId === PLAYER) {
      world.events.emit(EV.TOAST, { text: trap, tone: 'warn' });
    }
    return null;
  }
  if (!canAfford(world, playerId, s.cost)) {
    if (!quiet) world.events.emit(EV.INSUFFICIENT, { player: playerId, playerId, cost: s.cost });
    return null;
  }
  if (!pay(world, playerId, s.cost, `build:${type}`)) return null;

  // The segment comes out only once the gate is paid for, so a refused payment
  // cannot leave a hole in the wall.
  if (replaces) {
    const back = BUILDING_STATS[replaces.type] && BUILDING_STATS[replaces.type].cost;
    if (back) refund(world, playerId, back, `regate:${replaces.type}`);
    removeEntity(world, replaces);
  }

  const b = spawnBuilding(world, type, playerId, gx, gy, { complete: false });
  // A building started in the Castle Age is a Castle Age building from the
  // first shovel, not a Dark Age one that gets a retroactive top-up when the
  // next age lands. world.js stamps the base hitpoints; this restates them at
  // the owner's age scale, and it is idempotent so it is safe to call anywhere.
  applyAgeHp(world, b);
  b.state = 'foundation';
  world.events.emit(EV.FOUNDATION, { building: b, builder: null });
  return b;
}

// --- Wall lines -------------------------------------------------------------
//
// A wall is drawn, not placed. The player drags from one tile to another and
// gets a whole run of foundations at once — see the wall-drawing mode in
// ui/input.js, which is the touch half of this.
//
// THE SHAPE OF THE RUN is an L along the two grid axes, longer leg first. Two
// other shapes were tried and both are wrong here:
//
//   * a straight line between the endpoints, Bresenham style. In an isometric
//     projection a grid-diagonal line renders as a *vertical* column of tiles
//     that touch only at their corners, so the segments do not share an edge,
//     the neighbour mask comes out 0 for every one of them, and the run draws as
//     a stack of loose posts. It also is not a wall: units walk diagonally
//     between two tiles that only meet at a point.
//   * a free-form path following the drag. Unreadable under a finger, and
//     impossible to predict before you commit.
//
// The L is what AoE2 does and it is the only shape that is always four-connected,
// which is exactly what the sprite variants and the block grid both want. Longer
// leg first because that is the leg the player was aiming along: the corner then
// lands where they stopped pulling, not where they started.

/** The tiles an L-shaped wall run from (ax,ay) to (bx,by) covers, in order. */
export function wallLineTiles(ax, ay, bx, by) {
  const x0 = Math.floor(ax);
  const y0 = Math.floor(ay);
  const x1 = Math.floor(bx);
  const y1 = Math.floor(by);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const sx = dx === 0 ? 0 : dx > 0 ? 1 : -1;
  const sy = dy === 0 ? 0 : dy > 0 ? 1 : -1;
  const out = [];
  let x = x0;
  let y = y0;
  out.push([x, y]);
  if (Math.abs(dx) >= Math.abs(dy)) {
    while (x !== x1) { x += sx; out.push([x, y]); }
    while (y !== y1) { y += sy; out.push([x, y]); }
  } else {
    while (y !== y1) { y += sy; out.push([x, y]); }
    while (x !== x1) { x += sx; out.push([x, y]); }
  }
  return out;
}

/** How many segments a run may be. Long enough to wall a base side in one drag. */
export const MAX_WALL_RUN = 40;

/**
 * Cost, count and per-segment verdict for a proposed run, without spending
 * anything. The drag preview asks for this on every tile the finger crosses, so
 * it is a pure read — and it is the same predicate placeWallLine() then applies,
 * so a segment the preview drew green is a segment that gets built.
 *
 * Affordability is evaluated *cumulatively along the run*, because that is how
 * it is charged: with 12 stone in the bank the first two segments of a five-tile
 * stone wall are affordable and the last three are not, and a preview that drew
 * all five green would be lying about four of them.
 */
export function planWallLine(world, playerId, type, tiles) {
  const s = BUILDING_STATS[type];
  const out = {
    segments: [], count: 0, cost: {}, refused: 0, reason: null, trapped: null, capped: 0,
  };
  if (!s) return out;
  const locked = lockReason(world, playerId, type);
  const p = playerOf(world, playerId);
  const purse = {};
  for (const k of RES_KEYS) purse[k] = p ? (p.resources[k] || 0) : 0;

  const run = tiles.slice(0, MAX_WALL_RUN);
  // How many the player asked for that this run will not include. Reported
  // rather than dropped: a 60-tile drag used to read "40 palisades" with the
  // other 20 gone in silence, so the preview and the wall disagreed and nothing
  // ever said why.
  out.capped = Math.max(0, tiles.length - run.length);
  const buildable = [];
  for (const [tx, ty] of run) {
    const gx = tx + s.fw / 2;
    const gy = ty + s.fh / 2;
    let why = locked;
    if (!why) why = placeBlockedBy(world, gx, gy, s.fw, s.fh);
    if (!why) {
      for (const k of RES_KEYS) {
        if ((s.cost[k] || 0) > purse[k]) { why = 'Not enough resources'; break; }
      }
    }
    if (why) {
      out.refused++;
      if (!out.reason) out.reason = why;
      out.segments.push({ tx, ty, gx, gy, valid: false, reason: why });
      continue;
    }
    for (const k of RES_KEYS) {
      const need = s.cost[k] || 0;
      if (!need) continue;
      purse[k] -= need;
      out.cost[k] = (out.cost[k] || 0) + need;
    }
    out.count++;
    buildable.push([tx, ty]);
    out.segments.push({ tx, ty, gx, gy, valid: true, reason: null });
  }

  // One enclosure test for the whole run — see tilesTrapReason. A run that would
  // seal the player in is refused entire: nineteen good segments and a twentieth
  // that shuts the door is one wall, and it is the wall the player drew.
  if (buildable.length) {
    const trap = tilesTrapReason(world, playerId, buildable);
    if (trap) {
      out.trapped = trap;
      out.reason = trap;
      out.refused = out.segments.length;
      out.count = 0;
      out.cost = {};
      for (const seg of out.segments) { seg.valid = false; seg.reason = trap; }
    }
  }
  return out;
}

/**
 * Place every segment of a run that can be placed, charging for exactly those.
 *
 * Refused segments are skipped rather than aborting the run: a wall drawn across
 * a tree the player did not notice should be a wall with a gap in it, not a wall
 * that silently did nothing. Returns { placed: [buildings], refused, reason }.
 *
 * The reachability rules re-run per segment as the run is laid, which matters:
 * the segment that would seal your villagers in is only sealing them because the
 * nineteen before it went down first, and it is the twentieth that has to be
 * refused.
 */
export function placeWallLine(world, playerId, type, tiles) {
  const s = BUILDING_STATS[type];
  const result = { placed: [], refused: 0, reason: null };
  if (!s) return result;

  // The plan is the rule. Running it here rather than re-deriving the verdict
  // per segment is what guarantees that what the preview drew is what gets
  // built — including the whole-run enclosure test, which no per-segment call
  // could reproduce.
  const plan = planWallLine(world, playerId, type, tiles);
  result.reason = plan.reason;
  for (const seg of plan.segments) {
    if (!seg.valid) { result.refused++; continue; }
    // Quiet: the plan has already decided, and forty separate refusals would be
    // forty toasts saying one thing. The caller summarises once at the end.
    const b = placeFoundation(world, playerId, type, seg.gx, seg.gy, {
      quiet: true, skipTrap: true,
    });
    if (b) result.placed.push(b);
    else result.refused++;
  }
  return result;
}

// --- Gates ------------------------------------------------------------------
//
// A gate stands open when its owner's people are about and shuts otherwise, the
// way an AoE2 gate does. Two things ride on that single boolean: the sprite, and
// — because the block grid is the only passability model the movement step has —
// whether a unit can physically walk onto the tile this step.
//
// The radii are small on purpose. GATE_FRIEND_RADIUS is a little over one tile
// from the gate's edge, so the gate opens as a villager arrives at it rather
// than when one wanders past ten tiles away; GATE_ENEMY_RADIUS is wider, because
// a gate that is still swinging shut as the raider reaches it is a gate that
// does not work. A hostile inside that ring always wins the argument: your own
// soldier standing on the wall does not hold the door open for the man
// attacking it.
const GATE_FRIEND_RADIUS = 2.2;
const GATE_ENEMY_RADIUS = 3.5;

/**
 * Open and shut every gate. One pass over the gates (not over the units), and
 * each one asks the spatial index for what is near it — so the cost is
 * proportional to how many gates exist, which on a walled-in base is a handful.
 */
export function updateGates(world) {
  for (const b of world.buildings) {
    if (b.dead || !isGateType(b.type)) continue;
    if (!b.complete) { setGateOpen(world, b, false); continue; }

    let friend = false;
    let hostile = false;
    forEachNear(world, b.x, b.y, GATE_ENEMY_RADIUS, (e) => {
      if (e.kind !== 'unit' || e.dead) return;
      if (e.player === b.player) {
        if (edgeDist2(b, e.x, e.y) <= GATE_FRIEND_RADIUS * GATE_FRIEND_RADIUS) friend = true;
      } else if (isHostile(b, e)) {
        hostile = true;
      }
    });

    // Never shut a gate on somebody standing in the doorway: they would be
    // entombed inside a one-tile pocket and have to be evicted by the path
    // planner, which looks exactly like a bug.
    const tx = Math.floor(b.x);
    const ty = Math.floor(b.y);
    let occupied = false;
    forEachNear(world, b.x, b.y, 0.9, (e) => {
      if (e.kind === 'unit' && !e.dead &&
          Math.floor(e.x) === tx && Math.floor(e.y) === ty) occupied = true;
    });

    setGateOpen(world, b, occupied || (friend && !hostile));
  }
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

// --- The build queue --------------------------------------------------------
//
// Placing a building on a phone is four gestures: open the menu, pick the type,
// aim, lift. Three of those are the same three every time, which is why a base
// on a touch screen ends up smaller and worse laid out than one on a desktop —
// not because the player wants fewer houses, but because the fifth house costs
// the same four gestures as the first.
//
// The queue is the answer: arm a type once, tap as many places as you like, and
// each tap puts a foundation down and remembers the order you asked for them in.
// Two things ride on remembering that order.
//
//   * The player can see and undo it. A queue of six sites you can read and take
//     back one at a time is a plan; six foundations scattered across the map
//     that you have to find and select individually is a mess.
//   * A villager that finishes a queued site walks to the *next* one instead of
//     going back to a tree (see onJobFinished in unitAI.js). That is the whole
//     point of a batch: you place the row of houses and then stop thinking about
//     it, exactly as the wall drag already lets you do with a run of palisade.
//
// It is a list of ids rather than of buildings so a site that is destroyed,
// finished or cancelled by any other route simply drops out on the next read —
// there is no second bookkeeping path to keep in step with world.removeEntity.

/** Add a freshly placed foundation to the back of the player's build queue. */
export function enqueueFoundation(world, building) {
  if (!building || building.kind !== 'building' || building.complete) return false;
  const q = econState(world).buildQueue[building.player];
  if (!q || q.includes(building.id)) return false;
  q.push(building.id);
  building.queued = true;
  return true;
}

/**
 * The player's queued sites, oldest first, pruned of anything that has since
 * been finished, cancelled or destroyed. This is the read the HUD draws and the
 * unit AI asks — both get the same list, so what the strip shows is what the
 * builders are working through.
 */
export function buildQueue(world, playerId) {
  const st = econState(world);
  const q = st.buildQueue[playerId];
  if (!q || !q.length) return [];
  const out = [];
  const live = [];
  for (const id of q) {
    const b = world.entities.get(id);
    if (!b || b.dead || b.kind !== 'building' || b.complete) continue;
    live.push(id);
    out.push(b);
  }
  if (live.length !== q.length) st.buildQueue[playerId] = live;
  return out;
}

/**
 * The next queued site for a builder standing at (gx, gy), nearest first.
 *
 * Nearest rather than strictly first-in: the queue records what the player asked
 * for, not a route, and a villager that has just finished the house at the north
 * end should not walk the length of the base because that house happened to be
 * tapped last. Ties go to the older entry, so a row of houses placed left to
 * right does get built left to right.
 */
export function nextQueuedSite(world, playerId, gx, gy, exclude = null) {
  let best = null;
  let bestD = Infinity;
  const list = buildQueue(world, playerId);
  for (const b of list) {
    if (b === exclude) continue;
    const d = edgeDist2(b, gx, gy);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Take one entry back off the queue and refund it. Index into buildQueue(). */
export function cancelQueued(world, playerId, index) {
  const list = buildQueue(world, playerId);
  const b = list[index];
  if (!b) return null;
  const type = b.type;
  if (!cancelFoundation(world, b)) return null;
  return type;
}

/** Take the whole queue back, refunding every site. Returns how many went. */
export function clearBuildQueue(world, playerId) {
  const list = buildQueue(world, playerId);
  let n = 0;
  for (const b of list) if (cancelFoundation(world, b)) n++;
  econState(world).buildQueue[playerId] = [];
  return n;
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
    // Cheap and idempotent; it only does anything for a site that was placed
    // before an age-up and finished after one.
    applyAgeHp(world, building);
    building.hp = building.maxHp;
    building.state = 'idle';
    // Tile-grid facts that only become true on completion: a gate starts being
    // a gate rather than a building site, and a wall joins up with its
    // neighbours. See onBuildingComplete in core/world.js.
    onBuildingComplete(world, building);
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
 * Advance training queues and research queues, and keep population figures
 * honest. Called once per fixed sim step from GameScene.
 *
 * Research rides along here rather than being a system of its own: it is
 * production — a queue on a building that ticks down and then pays out — and
 * putting it on the same beat as training means the two can never drift by a
 * step, which is what a separate updateTech() in the scene would have risked.
 */
export function updateEconomy(world, dt) {
  const st = econState(world);
  updateResearch(world, dt);
  // Gates ride here for the same reason research does: it is a per-step pass
  // over one list of buildings, and the scene's system list stays as it is.
  updateGates(world);

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

// --- Save and load ----------------------------------------------------------
//
// Two things: the population nag timers (so a reloaded game does not shout
// "population capped" the instant it starts) and the build queue, which is an
// ordered list of foundation ids and therefore the one piece of economy state
// that cannot be re-derived from the world. Everything else this module owns —
// stockpiles, training queues, farm stocks, build progress — lives on the
// players and the entities and is saved with them.

export function serializeEconomy(world) {
  const st = econState(world);
  return {
    popNag: st.popNag.slice(),
    buildQueue: st.buildQueue.map((q) => q.slice()),
  };
}

export function restoreEconomy(world, data) {
  const st = econState(world);
  if (!data) return;
  for (let i = 0; i < st.popNag.length; i++) {
    st.popNag[i] = Number.isFinite(data.popNag && data.popNag[i]) ? data.popNag[i] : 0;
    const q = data.buildQueue && data.buildQueue[i];
    // Ids only, and pruned on read (see buildQueue) — a site that finished or
    // was destroyed between the save and the load simply drops out.
    st.buildQueue[i] = Array.isArray(q) ? q.filter((id) => world.entities.has(id)) : [];
  }
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
