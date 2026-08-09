// Unit AI: orders, the task state machine, movement, and local avoidance.
//
// This module owns *where a unit is and what it is trying to do*. It does not
// own the numbers: harvesting rates, deposits and construction progress live in
// economy.js, and cooldowns, damage and death live in combat.js. Those systems
// are called at the right moment from here and are never second-guessed.
//
// No Phaser imports: this file must run headlessly under Node (see
// tests/units.test.mjs).
//
// The unit fields this module owns (all declared in world.js spawnUnit):
//   task       { type, ... }  the current job, or null when idle
//   path       array of waypoints from pathfinding.js, or null
//   pathIndex  index of the waypoint currently being walked to
//   state      'idle' | 'move' | 'gather' | 'build' | 'attack' | 'deposit'
//   facing     0..7, from dirIndex() — the renderer reads this every frame
//   target     the entity combat.js should shoot at
//
// The shape of `task` matters to world.js: removeEntity() clears any task whose
// `node`, `target` or `building` field points at a removed entity, so those
// three names are used verbatim and every stage tolerates them turning null.
//
// `task.node` is a resource node *or* one of the player's finished farms — see
// the Farms note in economy.js. Both carry `resourceType` and `amount`, and are
// worked, emptied and retasked away from identically; the only difference is
// that a farm is a building, so distances to it use edgeDist().

import { dirIndex } from '../core/iso.js';
import {
  UNIT_STATS, ARMOR_CLASS, STANCE, FORMATION, DEFAULT_FORMATION,
  FORMATION_SPACING, SPREAD_SPACING,
} from '../core/constants.js';
import { forEachNear, edgeDist, edgeDist2, findNearestGlobal } from '../core/world.js';
import { EV } from '../core/events.js';
import {
  findPath, findAdjacentStandTile, isWalkable, nearestWalkable, hasLineOfSight,
  isSealedFrom, isPocket,
} from './pathfinding.js';
import {
  gatherTick, depositCarry, buildTick, nearestDropoff, isGatherableBuilding,
  acceptsDropoff, nextQueuedSite,
} from './economy.js';
import {
  inRange, canAttack, attackReach, stanceOf, setStance, isGarrisoned,
  garrisonUnit, garrisonRefusal, garrisonCount, garrisonCapacity,
  nearestShelter, ungarrisonUnit,
} from './combat.js';

// --- Tuning -----------------------------------------------------------------

// How close counts as "arrived" at a move destination. Big enough that a unit
// nudged by its neighbours does not re-trigger a walk, small enough that a
// group still lands on the spot you tapped.
const ARRIVE_TOL = 0.12;
// Intermediate waypoints are corners to be rounded, not spots to be hit.
const WAYPOINT_TOL = 0.18;

// Interaction reach. A stand tile is at most a diagonal (1.41) from a node
// centre, so arriving always satisfies this and a villager nudged by its
// neighbours keeps working instead of re-walking (the gap between the two
// numbers below is deliberate hysteresis).
const GATHER_REACH = 1.7;
// ...but a villager still walking gets that little bit closer first, so it ends
// up beside the tree rather than swinging at it from a tile and a half away.
const GATHER_START = 1.15;
const BUILD_REACH = 1.25;
const DROPOFF_REACH = 1.25;

// A* searches granted per sim step, shared by every unit. Orders get their own
// (larger) immediate allowance, so a command always registers at once; repaths
// and background retasks queue up behind this budget. Units waiting for a
// search still move — straight at the goal — so nothing ever looks frozen.
const SEARCHES_PER_STEP = 24;
const IMMEDIATE_SEARCHES_PER_ORDER = 48;

// A unit closing less than this fraction of its expected distance is stuck —
// measured as progress toward the goal, not distance travelled, so a unit being
// shoved around inside a crowd counts as stuck even though it is moving.
const STUCK_FRACTION = 0.2;
// When a walk stalls within this distance of its destination *and nothing but
// other units is in the way*, the unit has effectively arrived: its spot is
// taken by its own neighbours. Stopping is what "the group arrived" looks like;
// grinding on would be a shoving match. The line-of-sight condition is what
// keeps this from ever excusing a unit that simply has a wall in front of it.
const CROWD_ARRIVE = 2.0;
const STUCK_TIME = 0.6;
const REPATH_COOLDOWN = 0.45;

// Headway watchdog.
//
// The waypoint-distance test above cannot see two real failures:
//   * a unit whose destination is unreachable has an *empty* path, so its only
//     "waypoint" is the destination itself and every measurement is against a
//     point it will never approach — it can sit there forever;
//   * a unit orbiting a crowded destination genuinely closes on its waypoint
//     every other step, so stuck time keeps resetting while it walks nineteen
//     tiles inside a two-tile box.
// Both are caught by asking a blunter question: over HEADWAY_TIME seconds, did
// this unit end up HEADWAY_DIST from where it started? A unit on an honest walk
// covers 1.5 tiles/second and clears that with room to spare, even braked to
// 70% by a crowd; a unit going nowhere never does, whatever its waypoints say.
const HEADWAY_TIME = 3.0;
const HEADWAY_DIST = 1.5;

// How long an entombed unit stays retired before its pocket is re-tested. Cheap
// (one capped flood fill), so a villager freed by a demolished or destroyed wall
// picks its job back up within a few seconds instead of waiting for a new order.
const TRAPPED_RECHECK = 4.0;
// Give up on a destination after this many *consecutive* fruitless repaths.
// Any real headway resets the count: shuffling through a crowd of forty
// villagers is slow, not hopeless, and a unit must never abandon its job over
// ordinary traffic.
const MAX_PATH_FAILS = 6;
// Arriving somewhere and still not being able to reach the thing you came for
// means the spot is wrong. Try a few, then take the job elsewhere — pacing back
// and forth in front of a tree is the worst thing a villager can do.
const MAX_APPROACH_TRIES = 4;

// Separation steering.
//
// The cardinal rule: separation may never cancel movement. It is a steering
// *bias*, not a competing force. A unit under orders keeps at least
// (1 - SEP_MAX_BRAKE) of its step no matter how many neighbours lean on it,
// which is what makes a head-on meeting resolve instead of settling into a
// zero-velocity equilibrium.
const SEP_RADIUS = 1.0;
// Most of the correction goes sideways — that is the direction that actually
// unpicks a jam — and only a little into slowing down.
const SEP_CROSS_GAIN = 0.9;
const SEP_MAX_BRAKE = 0.3;
const SEP_MAX_YIELD = 0.5;
// Units that are not going anywhere absorb the shove instead: idle ones step
// aside readily, working ones only a little (they must stay in reach of the
// tree they are chopping).
const SEP_GAIN_IDLE = 0.7;
const SEP_GAIN_WORKING = 0.35;
// A neighbour standing still is a softer obstacle than one under orders, so
// traffic flows around parked villagers rather than being stopped by them.
const STATIONARY_WEIGHT = 0.55;
// Below this the push is noise; ignoring it is what lets crowds settle.
const SEP_DEADBAND = 0.02;
// A push this close to head-on has no sideways component to exploit, so a side
// is chosen deliberately (see sidestep below).
const HEAD_ON_DOT = -0.5;
const SIDESTEP_MIN = 0.35;

// How close a unit has to get to a building before it can step inside it. The
// same order of magnitude as BUILD_REACH — you garrison from the doorstep, not
// from across the square — with a little more slack because a group of eight
// walking into one Town Center will not all reach the same tile.
const GARRISON_REACH = 1.6;

// How far a villager will walk to find replacement work.
const RETASK_RADIUS = 24;
const FOLLOWUP_WORK_RADIUS = 14;

// Crowding on one node.
//
// A node is worked from the ring of tiles around it, so beyond a handful of
// villagers the rest are not gathering, they are queueing — and while they
// queue they are in `move`, which is income of exactly zero. Sixteen villagers
// tapped onto one bush used to produce twenty-second windows with no food at
// all. Past this many, a group order spills the remainder onto equivalent nodes
// nearby: the same thing the enemy AI does node-by-node, and the reason its
// food never stalls.
const MAX_WORKERS_PER_NODE = 5;
// How far the spill looks for an equivalent node, measured from the node the
// player actually tapped — far enough to cover the rest of a berry patch or
// woodline, near enough that nobody is sent across the map.
const SPREAD_RADIUS = 12;
// A villager hovering inside GATHER_REACH for this long without closing to
// GATHER_START is not going to: its spot is taken by its own neighbours. It
// starts working from where it stands rather than shuffling forever.
const NEAR_SETTLE = 0.6;
// What one villager too many on a node is worth, in tiles of walking. Queueing
// behind a full bush is bad; walking fifteen tiles to an empty one is worse, and
// that is the trade this number sets. Every alternative is priced against it.
const QUEUE_COST = 2.5;
// A node's distance to the nearest drop-off is paid on *every* trip for the
// rest of its life, while the walk out to it is paid once — so it counts for
// more when choosing replacement work. Without this a crowd retasking off an
// exhausted patch fans out across the map and the round trip doubles.
const HAUL_WEIGHT = 2.0;

// A rally point this close (edge distance) to something workable *is* an order
// to work it. One and a bit tiles: it covers the node the player actually tapped
// and the ring of ground around it, without a rally dropped in the middle of a
// clearing quietly hijacking a bush two tiles away.
const RALLY_SNAP = 1.5;

// --- Per-world context ------------------------------------------------------

const CTX = new WeakMap();

function getCtx(world) {
  let c = CTX.get(world);
  if (!c) {
    c = { searches: 0 };
    CTX.set(world, c);
    // A node running dry is the single most common reason a villager would
    // silently stop working, so retasking is wired to the event rather than
    // discovered later by polling.
    world.events.on(EV.NODE_DEPLETED, ({ node }) => onNodeDepleted(world, node));
    world.events.on(EV.BUILT, ({ building }) => onBuilt(world, building));
    // Economy trains the unit and hands the walk to us; without this, rallied
    // production piles up on the spawn tile.
    world.events.on(EV.TRAINED, ({ unit, rally }) => onTrained(world, unit, rally));
  }
  return c;
}

function onTrained(world, unit, rally) {
  if (!unit || unit.dead) return;
  const r = rally || unit.pendingRally;
  if (!r) return;
  unit.pendingRally = null;
  commandUnits(world, [unit], rallyOrder(world, unit, r));
}

/**
 * Turn a rally point into the order the player actually meant.
 *
 * A rally is a standing macro instruction, and on a phone it is *the* one that
 * matters: a Town Center hands you a fresh villager every 8 seconds, and hunting
 * each one down to tap it onto a bush is the thing no thumb can keep up with.
 * So a rally that lands on (or beside) something workable is a work order:
 *
 *   resource node or one of our finished farms -> gather it
 *   one of our foundations                     -> go help build it
 *   anything else                              -> walk there
 *
 * Only villagers get the work orders; soldiers rallying onto a bush just muster
 * there, which is what a barracks rally means.
 */
function rallyOrder(world, unit, r) {
  const move = { type: 'move', gx: r.x, gy: r.y };
  if (!unit || unit.type !== 'villager') return move;

  let best = null;
  let bestD = Infinity;
  const consider = (e, type) => {
    const d = edgeDist2(e, r.x, r.y);
    if (d > RALLY_SNAP * RALLY_SNAP || d >= bestD) return;
    bestD = d;
    best = { e, type };
  };
  forEachNear(world, r.x, r.y, RALLY_SNAP, (e) => {
    if (e.dead) return;
    if (e.kind === 'resource') {
      if (e.amount > 0) consider(e, 'gather');
      return;
    }
    if (e.kind !== 'building' || e.player !== unit.player) return;
    if (!e.complete) consider(e, 'build');
    else if (isGatherableBuilding(e)) consider(e, 'gather');
  });

  if (!best) return move;
  return { type: best.type, target: best.e, gx: best.e.x, gy: best.e.y };
}

// --- Public API -------------------------------------------------------------

/**
 * Issue an order to a group of units.
 *
 * `order` = { type, gx, gy, target } where type is
 * 'move' | 'attackMove' | 'gather' | 'attack' | 'build' | 'stop' | 'patrol' |
 * 'garrison' | 'ungarrison' | 'stance' | 'formation'.
 *
 * The last four are settings rather than journeys: 'stance' and 'formation'
 * change how every *subsequent* order is carried out and are the two things a
 * phone player sets once and forgets, which is exactly why they are unit state
 * and not order flags.
 *
 * 'attackMove' is a 'move' whose task carries `attackMove: true`; combat.js
 * reads that flag (isAttackMoving) to keep acquiring while the unit walks, and
 * tickMove() stops for the fight and resumes the walk afterwards.
 *
 * Called by ui/input.js for the player and by systems/enemyAI.js for the AI.
 * `units` may be entities, ids, an array or any iterable — selections travel in
 * several shapes and an order must never be dropped over that.
 */
export function commandUnits(world, units, order) {
  if (!order) return;
  const all = normalizeUnits(world, units);
  // A unit inside a building is not on the map and cannot be given a journey.
  // Coming back out is the one thing it *can* be told to do, so that order is
  // the single exception rather than a check in every branch below.
  const list = order.type === 'ungarrison' ? all : all.filter((u) => !isGarrisoned(u));
  if (list.length === 0) return;
  const ctx = getCtx(world);
  ctx.orderSearches = IMMEDIATE_SEARCHES_PER_ORDER;

  switch (order.type) {
    case 'stop':
      for (const u of list) stopUnit(u);
      return;

    case 'move':
      orderMove(world, list, order, ctx);
      return;

    // Walk there, but fight anything met on the way. combat.js does the seeing
    // and the swinging (isAttackMoving reads the flag we set on the task); this
    // module owns stopping for the fight and picking the walk back up.
    case 'attackMove':
      orderMove(world, list, { ...order, attackMove: true }, ctx);
      return;

    case 'patrol':
      orderPatrol(world, list, order, ctx);
      return;

    case 'gather':
      orderGather(world, list, order, ctx);
      return;

    case 'build':
      orderBuild(world, list, order, ctx);
      return;

    case 'attack':
      orderAttack(world, list, order, ctx);
      return;

    // Go and stand inside something. See the garrison notes in combat.js.
    case 'garrison':
      orderGarrison(world, list, order, ctx);
      return;

    case 'ungarrison':
      for (const u of list) ungarrisonUnit(world, u);
      return;

    case 'stance':
      for (const u of list) setStance(u, order.stance);
      return;

    case 'formation':
      if (!isFormation(order.formation)) return;
      for (const u of list) u.formation = order.formation;
      return;

    default:
      // Unknown verb with a position still reads as "go there".
      if (order.gx !== undefined) orderMove(world, list, order, ctx);
  }
}

/** One fixed simulation step of unit behaviour. Called from GameScene.simStep. */
export function updateUnits(world, dt) {
  const ctx = getCtx(world);
  ctx.searches = SEARCHES_PER_STEP;
  ctx.orderSearches = 0;

  // Snapshot: a unit stepping into a Town Center splices itself out of
  // world.units mid-loop, and iterating the live array would silently skip its
  // neighbour. combat.js takes the same copy for the same reason.
  const units = world.units.slice();
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (!u || u.dead || u.garrisonedIn) continue;
    stepUnit(world, u, dt, ctx);
  }
  // Separation runs after every unit has moved, so pushes are computed against
  // this step's positions and the result is symmetric.
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (!u || u.dead || u.garrisonedIn) continue;
    separate(world, u, dt);
  }
}

/**
 * True when a unit has nothing to do. The HUD's "idle villager" button hangs
 * off this, so it must not report a villager walking to a tree as idle, nor a
 * villager that quietly lost its job as busy.
 */
export function isIdle(unit) {
  if (!unit || unit.dead || unit.kind !== 'unit') return false;
  // A garrisoned villager is not idle, it is somewhere specific on purpose.
  // ownedBy() still returns it (it is still yours and still costs population),
  // so without this the idle-villager button would count the six villagers the
  // player deliberately sheltered from a raid and nag them about it.
  if (unit.garrisonedIn) return false;
  if (unit.task) return false;
  if (unit.target) return false;
  if (unit.dest) return false;
  if (unit.path && unit.pathIndex < unit.path.length) return false;
  // A villager still holding resources but with no job *is* idle — that is
  // exactly the case the HUD's idle-villager button exists to surface. Anything
  // actually walking a load home has a task, so it is excluded above.
  return unit.state === 'idle';
}

// --- Order helpers ----------------------------------------------------------

function normalizeUnits(world, units) {
  const out = [];
  if (!units) return out;
  const push = (v) => {
    const e = typeof v === 'number' ? world.entities.get(v) : v;
    if (e && !e.dead && e.kind === 'unit') out.push(e);
  };
  if (Array.isArray(units)) for (const v of units) push(v);
  else if (typeof units[Symbol.iterator] === 'function') for (const v of units) push(v);
  else push(units);
  return out;
}

function stopUnit(u) {
  u.task = null;
  u.target = null;
  u.path = null;
  u.pathIndex = 0;
  u.dest = null;
  u.vx = 0;
  u.vy = 0;
  u.state = 'idle';
  u.aiStuck = 0;
  u.aiFails = 0;
  u.aiAnchorT = undefined;
  u.aiTrapped = false;
  u.aiTrappedJob = null;
}

/** Begin a task and start moving in the same step the order was given. */
function setTask(world, u, task, ctx, destX, destY) {
  u.task = task;
  u.target = null;
  u.aiStuck = 0;
  u.aiFails = 0;
  u.repathTimer = 0;
  u.aiAnchorT = undefined;
  u.aiTrappedJob = null;
  if (destX !== undefined && destY !== undefined) {
    requestPath(world, u, destX, destY, ctx, true);
    u.state = 'move';
  }
}

function orderMove(world, list, order, ctx) {
  const gx = order.gx !== undefined ? order.gx : order.target ? order.target.x : null;
  const gy = order.gy !== undefined ? order.gy : order.target ? order.target.y : null;
  if (gx === null || gy === null) return;
  const slots = assignSlots(world, list, gx, gy, order.formation);
  const attackMove = !!order.attackMove;
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    const s = slots[i];
    setTask(world, u, { type: 'move', gx: s.x, gy: s.y, attackMove }, ctx, s.x, s.y);
  }
}

function orderPatrol(world, list, order, ctx) {
  const gx = order.gx;
  const gy = order.gy;
  if (gx === undefined || gy === undefined) return;
  const slots = assignSlots(world, list, gx, gy, order.formation);
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    const s = slots[i];
    const task = {
      type: 'patrol',
      a: { x: u.x, y: u.y },
      b: { x: s.x, y: s.y },
      leg: 'b',
    };
    setTask(world, u, task, ctx, s.x, s.y);
  }
}

function orderGather(world, list, order, ctx) {
  let node = order.target;

  // Farms are gathered from exactly like bushes, and an *unfinished* farm is a
  // build order — tapping the field you just placed means "go plant it".
  if (node && node.kind === 'building') {
    if (!node.complete && node.player === list[0].player) {
      orderBuild(world, list, { ...order, target: node }, ctx);
      return;
    }
    if (!isGatherableBuilding(node) || node.player !== list[0].player) node = null;
  } else if (!node || node.kind !== 'resource' || node.amount <= 0) {
    node = null;
  }

  if (!node && order.gx !== undefined) {
    node = nearestWorkSource(world, list[0], order.gx, order.gy);
  }
  if (!node) {
    // Tapped bare ground with a gather order — walk there instead of refusing.
    if (order.gx !== undefined) orderMove(world, list, order, ctx);
    return;
  }
  // Spread the group over the patch rather than stacking it on one node. The
  // two most natural phone actions in the game — select-all then tap the
  // berries, and rallying the Town Center onto them — both land every villager
  // you own on a single bush, where most of them can only queue.
  const load = currentNodeLoads(world, new Set(list));
  const avoid = new Map();
  for (const u of list) {
    const target = spreadTarget(world, u, node, load);
    load.set(target, (load.get(target) || 0) + 1);
    let taken = avoid.get(target);
    if (!taken) { taken = new Set(); avoid.set(target, taken); }
    const stand = findAdjacentStandTile(world, target, u.x, u.y, { avoid: taken, maxRing: 1 })
      || findAdjacentStandTile(world, target, u.x, u.y, { maxRing: 1 });
    if (stand) taken.add(`${stand.tx},${stand.ty}`);
    beginGatherTask(world, u, target, ctx, stand);
  }
}

/** How many walkable tiles a node can actually be worked from, capped. */
function nodeCapacity(world, node) {
  const own = node.kind === 'building' && node.tiles && node.tiles.length
    ? node.tiles
    : [[Math.floor(node.x), Math.floor(node.y)]];
  const ownKeys = new Set(own.map(([x, y]) => `${x},${y}`));
  const seen = new Set();
  let free = 0;
  for (const [ox, oy] of own) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${ox + dx},${oy + dy}`;
        if (seen.has(key) || ownKeys.has(key)) continue;
        seen.add(key);
        if (isWalkable(world, ox + dx, oy + dy)) free++;
      }
    }
  }
  return Math.max(1, Math.min(MAX_WORKERS_PER_NODE, free));
}

/** Villagers already assigned to each node, by task (not by arrival). */
function currentNodeLoads(world, exclude) {
  const m = new Map();
  for (const u of world.units) {
    if (u.dead || (exclude && exclude.has(u))) continue;
    const t = u.task;
    if (!t || t.type !== 'gather' || !t.node) continue;
    m.set(t.node, (m.get(t.node) || 0) + 1);
  }
  return m;
}

/**
 * The node this villager should actually work, given how many are already on
 * the one that was tapped.
 *
 * Everything is priced in tiles of walking, so the comparison is honest: an
 * extra body on a node that already has more than it can hold costs QUEUE_COST
 * tiles, and the alternative has to be nearer than that to win. Below capacity
 * nothing is charged, so a small group all lands on the node the player tapped —
 * only a genuine crowd fans out, and only onto the patch next door. The order is
 * never refused, just redistributed.
 */
function spreadTarget(world, u, primary, load) {
  // Until the tapped node is genuinely full, the tap *is* the order. Comparing
  // costs from the first villager would quietly redirect a group onto whatever
  // happened to be nearer than the thing the player pointed at.
  if ((load.get(primary) || 0) < nodeCapacity(world, primary)) return primary;

  const type = primary.resourceType;
  const cost = (n) => {
    const over = Math.max(0, (load.get(n) || 0) - nodeCapacity(world, n) + 1);
    return edgeDist(n, u.x, u.y) + over * QUEUE_COST;
  };
  let best = primary;
  let bestC = cost(primary);
  eachWorkSource(world, u, (n) => {
    if (n === primary || n.dead || !(n.amount > 0)) return;
    if (type && n.resourceType !== type) return;
    if (edgeDist(n, primary.x, primary.y) > SPREAD_RADIUS) return;
    const c = cost(n);
    if (c < bestC) { bestC = c; best = n; }
  });
  return best;
}

function orderBuild(world, list, order, ctx) {
  let b = order.target;
  if (!b || b.kind !== 'building') {
    b = order.gx !== undefined
      ? findNearestGlobal(world, order.gx, order.gy, world.buildings, (e) => !e.complete)
      : null;
  }
  if (!b) return;
  if (b.complete) {
    // Nothing to build: fall back to "go there", which is what a player who
    // tapped a finished building most likely meant.
    orderMove(world, list, { type: 'move', gx: b.x, gy: b.y }, ctx);
    return;
  }
  const avoid = new Set();
  for (const u of list) {
    const stand = findAdjacentStandTile(world, b, u.x, u.y, { avoid, maxRing: 1 })
      || findAdjacentStandTile(world, b, u.x, u.y, { maxRing: 1 });
    if (stand) avoid.add(`${stand.tx},${stand.ty}`);
    const task = { type: 'build', building: b, stand: stand || null };
    if (stand) setTask(world, u, task, ctx, stand.x, stand.y);
    else setTask(world, u, task, ctx, b.x, b.y);
  }
}

function orderAttack(world, list, order, ctx) {
  const t = order.target;
  if (!t || t.dead) {
    if (order.gx !== undefined) orderMove(world, list, order, ctx);
    return;
  }
  for (const u of list) {
    const task = { type: 'attack', target: t };
    u.task = task;
    u.aiStuck = 0;
    u.aiFails = 0;
    // Setting target directly is what tells combat.js this is a player order:
    // it clears `autoTarget`, so an ordered attack is never leashed.
    u.target = t;
    // Move now; the state machine stops the unit the moment it is in range.
    if (!inRange(u, t)) {
      const p = approachPoint(world, u, t);
      requestPath(world, u, p.x, p.y, ctx, true);
      u.state = 'move';
      task.lastX = t.x;
      task.lastY = t.y;
    } else {
      clearMovement(u);
      u.state = 'attack';
    }
  }
}

/**
 * Walk into a building and disappear inside it.
 *
 * `order.target` names the building; without one, every unit heads for its own
 * nearest shelter with room, which is what the HUD's one-tap "Garrison" does
 * and what the enemy AI does when its town is raided. A group larger than the
 * building can hold is not refused here — the ones that arrive to find it full
 * simply stop, which is both cheaper and more honest than pre-allocating places
 * to units that may die on the way.
 */
function orderGarrison(world, list, order, ctx) {
  for (const u of list) {
    const b = (order.target && order.target.kind === 'building')
      ? order.target
      : nearestShelter(world, u, order.gx !== undefined ? order.gx : u.x,
        order.gy !== undefined ? order.gy : u.y);
    if (!b) continue;
    // Already on the doorstep: no need to plan a walk for a step.
    if (edgeDist(b, u.x, u.y) <= GARRISON_REACH && garrisonUnit(world, u, b)) continue;
    const stand = findAdjacentStandTile(world, b, u.x, u.y, { maxRing: 2 });
    const p = stand || { x: b.x, y: b.y };
    setTask(world, u, { type: 'garrison', building: b, stand: stand || null }, ctx, p.x, p.y);
  }
}

/**
 * Where to walk to hit `target`. combat.attackReach() is the authoritative
 * stop distance, so an archer walks to the near edge of its range instead of
 * marching into the enemy's face and backing off.
 */
function approachPoint(world, u, target) {
  const reach = attackReach(u, target);
  const dx = u.x - target.x;
  const dy = u.y - target.y;
  const d = Math.hypot(dx, dy);
  if (reach > 1.2 && d > reach) {
    const want = reach * 0.8;
    const px = target.x + (dx / d) * want;
    const py = target.y + (dy / d) * want;
    if (isWalkable(world, px, py)) return { x: px, y: py };
  }
  if (target.kind === 'building') {
    const stand = findAdjacentStandTile(world, target, u.x, u.y, { maxRing: 3 });
    if (stand) return stand;
  }
  return { x: target.x, y: target.y };
}

function beginGatherTask(world, u, node, ctx, stand) {
  const task = {
    type: 'gather',
    node,
    building: null,
    stage: 'toNode',
    stand: stand || null,
  };
  u.aiMemory = { resourceType: node.resourceType };
  // Carrying a different resource? Bank it first, then come back to this node —
  // economy.gatherTick would otherwise refuse to start on the new type.
  if (u.carrying && u.carrying.amount > 0 && u.carrying.type !== node.resourceType) {
    task.stage = 'toDrop';
    u.task = task;
    u.aiStuck = 0;
    u.aiFails = 0;
    routeToDropoff(world, u, task, ctx, true);
    return;
  }
  if (stand) setTask(world, u, task, ctx, stand.x, stand.y);
  else setTask(world, u, task, ctx, node.x, node.y);
}

// --- Formations -------------------------------------------------------------
//
// A formation here decides one thing and one thing only: which unit walks to
// which square when a group is given a destination. There is no per-frame
// formation keeping, no facing lock, no rotation while marching. That is a
// deliberate ceiling on the cost — the whole feature is O(n log n) once per
// order and *zero* per step, which is what makes it safe with a hundred and
// fifty units on a phone. What the player sees is the thing they asked for: a
// group that arrives in ranks rather than as a blob.
//
// The three shapes, all built in a local frame whose +forward axis points the
// way the group is travelling and whose +right axis is ninety degrees off it,
// then rotated into the world:
//
//   Line    a wide, shallow block. Roughly three times as wide as it is deep,
//           which is what "line" means in every RTS: everybody's weapon bears,
//           and nobody is queueing behind a friend.
//   Box     a rectangle with the tough units on the perimeter and the ranged
//           and siege inside it. The one formation that is a *tactic* rather
//           than a shape — it is the answer to cavalry going round the side.
//   Spread  the Line, at more than twice the spacing, so one mangonel shot or
//           one burning ram cannot reach two bodies.

export function isFormation(f) {
  return f === FORMATION.LINE || f === FORMATION.BOX || f === FORMATION.SPREAD;
}

/** The formation a group is in: whatever most of it is set to. */
function groupFormation(list) {
  let best = DEFAULT_FORMATION;
  let bestN = 0;
  const counts = new Map();
  for (const u of list) {
    const f = isFormation(u.formation) ? u.formation : DEFAULT_FORMATION;
    const n = (counts.get(f) || 0) + 1;
    counts.set(f, n);
    if (n > bestN) { bestN = n; best = f; }
  }
  return best;
}

/**
 * Does this unit belong in the middle of a Box?
 *
 * Anything that shoots, and anything too slow or too fragile to be on the
 * outside of a fight: archers, siege, and any villager caught up in the group.
 * Everything else is the wall.
 */
function prefersInside(u) {
  const s = UNIT_STATS[u.type];
  if (!s) return false;
  if (s.projectile) return true;
  if (s.armorClass === ARMOR_CLASS.SIEGE) return true;
  return u.type === 'villager';
}

/**
 * Local (right, forward) cell offsets for a formation, one per unit, paired
 * with the index of the unit that should take it. Pure arithmetic — no world
 * access, no walkability, no allocation beyond the result.
 */
function formationCells(list, formation) {
  const n = list.length;
  const cells = [];

  if (formation === FORMATION.BOX) {
    const cols = Math.max(2, Math.ceil(Math.sqrt(n)));
    const rows = Math.max(2, Math.ceil(n / cols));
    const perimeter = [];
    const interior = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = { r: c - (cols - 1) / 2, f: -(r - (rows - 1) / 2) };
        if (c === 0 || c === cols - 1 || r === 0 || r === rows - 1) perimeter.push(cell);
        else interior.push(cell);
      }
    }
    // Fill the inside with as many of the units that want it as will fit, and
    // let the rest of both groups spill into whatever is left. A box of four
    // archers has no inside, and that is fine — it is a box of four archers.
    const wantIn = list.filter(prefersInside).length;
    const inside = Math.min(wantIn, interior.length, n);
    const outside = Math.min(n - inside, perimeter.length);
    for (let i = 0; i < outside; i++) cells.push({ ...perimeter[i], inside: false });
    for (let i = 0; i < inside; i++) cells.push({ ...interior[i], inside: true });
    // Anything still unplaced (a huge group in a small box) goes behind.
    for (let i = cells.length, back = 0; i < n; i++, back++) {
      cells.push({ r: (back % cols) - (cols - 1) / 2, f: -(rows - 1) / 2 - 1 - Math.floor(back / cols), inside: false });
    }
    return cells;
  }

  // Line and Spread share their shape and differ only in spacing.
  const cols = Math.max(1, Math.round(Math.sqrt(n * 3)));
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const rank = Math.floor(i / cols);
    // The last rank is centred on its own width rather than on the full one, so
    // a group of seven in ranks of five ends up centred, not left-aligned.
    const wide = Math.min(cols, n - rank * cols);
    cells.push({ r: c - (wide - 1) / 2, f: -rank, inside: false });
  }
  return cells;
}

/**
 * Destination slots for a group order, in formation, so a dozen units arrive as
 * a body instead of a conga line fighting over one tile.
 *
 * Units are matched to slots by where they already are along the formation's
 * own axes: the leftmost unit takes the leftmost slot, the one nearest the
 * front takes the front rank. That is a sort rather than the old greedy nearest
 * pass — O(n log n) instead of O(n²), and it *keeps the group's layout*, which
 * is what stops units walking through each other on the way.
 */
function assignSlots(world, list, gx, gy, formation) {
  const n = list.length;
  if (n === 1) {
    // Fall back to the raw point when nothing near it is free: findPath slides
    // the goal onto walkable ground anyway, and refusing the order is worse.
    return [walkablePoint(world, gx, gy) || { x: gx, y: gy }];
  }
  const form = isFormation(formation) ? formation : groupFormation(list);
  const spacing = form === FORMATION.SPREAD ? SPREAD_SPACING : FORMATION_SPACING;

  // The frame: +forward is the way the group is going, +right is across it.
  let cx = 0;
  let cy = 0;
  for (const u of list) { cx += u.x; cy += u.y; }
  cx /= n;
  cy /= n;
  let fx = gx - cx;
  let fy = gy - cy;
  const fl = Math.hypot(fx, fy);
  if (fl < 1e-3) { fx = 0; fy = 1; } else { fx /= fl; fy /= fl; }
  const rx = -fy;
  const ry = fx;

  const cells = formationCells(list, form);

  // Order the units the same way the cells are ordered, so the assignment is a
  // zip. Box keeps its two classes apart first — a knight must not be handed an
  // interior slot because it happened to be standing on the left.
  const order = list.map((u, i) => ({
    i,
    inside: form === FORMATION.BOX ? prefersInside(u) : false,
    r: (u.x - cx) * rx + (u.y - cy) * ry,
    f: (u.x - cx) * fx + (u.y - cy) * fy,
  }));
  const cellOrder = cells.map((c, i) => ({ i, ...c }));
  const rank = (a, b) =>
    (a.inside === b.inside ? 0 : a.inside ? 1 : -1) ||
    (b.f - a.f) || (a.r - b.r);
  order.sort(rank);
  cellOrder.sort(rank);

  const out = new Array(n);
  for (let k = 0; k < n; k++) {
    const cell = cellOrder[k];
    const px = gx + rx * cell.r * spacing + fx * cell.f * spacing;
    const py = gy + ry * cell.r * spacing + fy * cell.f * spacing;
    out[order[k].i] = walkablePoint(world, px, py) || { x: px, y: py };
  }
  return out;
}

function walkablePoint(world, x, y) {
  if (isWalkable(world, x, y)) return { x, y };
  const alt = nearestWalkable(world, x, y, 3);
  return alt ? { x: alt.x, y: alt.y } : null;
}

// --- Per-unit step ----------------------------------------------------------

function stepUnit(world, u, dt, ctx) {
  if (u.repathTimer > 0) u.repathTimer -= dt;

  // A building went up on the tile this unit was standing on. Every candidate
  // step now starts inside a wall, so advance() refuses all of them and the unit
  // is frozen under the roof. Walk it out instead.
  if (!isWalkable(world, u.x, u.y)) {
    tickEvict(world, u, dt);
    return;
  }

  // Entombed: a pocket closed around it (an enemy building, or a foundation that
  // finished across the last gap). It has already been retired to idle by
  // markTrapped, so all that is left is to hold still — and to re-test the
  // pocket now and then, so a villager freed by a destroyed wall goes back to
  // work by itself.
  if (u.aiTrapped) {
    if (world.time >= (u.aiTrappedCheck || 0)) {
      u.aiTrappedCheck = world.time + TRAPPED_RECHECK;
      if (!isPocket(world, u.x, u.y)) {
        u.aiTrapped = false;
        const job = u.aiTrappedJob;
        u.aiTrappedJob = null;
        if (job && !u.task && (!job.target || !job.target.dead)) commandUnits(world, [u], job);
      }
    }
    if (u.aiTrapped && !u.task && !u.target) {
      u.state = 'idle';
      u.vx = 0;
      u.vy = 0;
      return;
    }
  }

  // A unit trained with a rally point set (economy.js stamps pendingRally, and
  // also emits EV.TRAINED, which we handle; this catches anything that slips).
  if (u.pendingRally && !u.task) {
    const r = u.pendingRally;
    u.pendingRally = null;
    commandUnits(world, [u], rallyOrder(world, u, r));
  }

  // Panicking villager (combat.js sets these). Running away outranks any job;
  // the job is kept and resumed when the fright wears off.
  if (u.fleeing && u.fleeTo) {
    tickFlee(world, u, ctx);
    advance(world, u, dt);
    return;
  }
  if (u.aiFleeGoal) {
    // Just calmed down: drop the flee route so the task re-paths from here.
    u.aiFleeGoal = null;
    clearMovement(u);
  }

  // A snapped leash (combat.js) sends the unit back to where it was standing.
  if (u.returnTo && !u.target) {
    const r = u.returnTo;
    u.returnTo = null;
    if (!u.task || u.task.type === 'attack') {
      u.task = { type: 'move', gx: r.x, gy: r.y };
      u.aiFails = 0;
      requestPath(world, u, r.x, r.y, ctx, false);
      u.state = 'move';
    }
  }

  // world.js clears `task` when the thing a unit was working on is removed. It
  // cannot clear the destination, so do it here: no job means no journey.
  if (!u.task && u.dest) clearMovement(u);

  if (!u.task) adoptFollowUpWork(world, u, ctx);

  if (u.task) {
    switch (u.task.type) {
      case 'move': tickMove(world, u, dt, ctx); break;
      case 'patrol': tickPatrol(world, u, dt, ctx); break;
      case 'gather': tickGather(world, u, dt, ctx); break;
      case 'build': tickBuild(world, u, dt, ctx); break;
      case 'attack': tickAttack(world, u, dt, ctx); break;
      case 'garrison': tickGarrison(world, u, dt, ctx); break;
      default: u.task = null; u.state = 'idle';
    }
  } else if (u.state !== 'idle') {
    u.state = 'idle';
    u.vx = 0;
    u.vy = 0;
  }

  advance(world, u, dt);
  checkStuck(world, u, dt, ctx);
}

/**
 * What an unemployed unit does. In AoE2 an idle villager is a mistake the
 * player is meant to fix, but a villager that lost its job to something the
 * player did not choose (a tree ran out, a building finished) should get on
 * with the obvious equivalent instead of standing there.
 */
function adoptFollowUpWork(world, u, ctx) {
  // Auto-acquisition belongs to combat.js: it stamps `target` on idle soldiers
  // (villagers never), and we walk them in. Note the task is flagged `auto` so
  // we do not clear combat's leash bookkeeping when the fight ends.
  if (u.target && canAttack(u, u.target)) {
    u.task = { type: 'attack', target: u.target, auto: true };
    return;
  }
  // Holding resources with nowhere to be: bank them.
  if (u.carrying && u.carrying.amount > 0 && world.time >= (u.aiDropRetry || 0)) {
    const task = { type: 'gather', node: null, building: null, stage: 'toDrop', stand: null };
    u.task = task;
    routeToDropoff(world, u, task, ctx, false);
  }
}

/**
 * Walk out from under a building that went up on top of this unit.
 *
 * This is a short walk at normal speed to the nearest free ground, not a
 * teleport: the villager visibly steps out from under the new roof, which is
 * what a player expects to see. It is deliberately the *only* way a unit ever
 * leaves ground it could not otherwise path off — an entombed unit in a sealed
 * pocket stays where it is (see markTrapped).
 */
function tickEvict(world, u, dt) {
  const spot = nearestWalkable(world, u.x, u.y, 5);
  if (!spot) {
    u.state = 'idle';
    u.vx = 0;
    u.vy = 0;
    return;
  }
  const dx = spot.x - u.x;
  const dy = spot.y - u.y;
  const d = Math.hypot(dx, dy);
  // The route it was walking started from ground it no longer stands on; the
  // task re-plans from wherever it lands.
  u.path = null;
  u.pathIndex = 0;
  u.dest = null;
  u.aiStuck = 0;
  u.aiLastDist = undefined;
  u.aiAnchorT = undefined;
  if (d <= 1e-6) return;
  const step = Math.min(d, u.speed * dt);
  u.x += (dx / d) * step;
  u.y += (dy / d) * step;
  u.facing = dirIndex(dx, dy);
  u.vx = (dx / d) * u.speed;
  u.vy = (dy / d) * u.speed;
  u.state = 'move';
}

/**
 * Give up on a destination this unit is sealed away from.
 *
 * A villager walled into a pocket cannot dig itself out, and it must not spend
 * the rest of the match cycling A* against a wall while reporting itself busy —
 * that is what made eight of them invisible for eight minutes. It drops the job
 * and goes *genuinely* idle, which is the one signal the player already reads:
 * the HUD's idle-villager button surfaces it. It is deliberately not teleported
 * or squeezed through the wall; a unit appearing on the far side of a building
 * reads as a bug, and the honest answer to "I am walled in" is to stop and say
 * so. stepUnit re-tests the pocket every few seconds, so demolishing the wall
 * puts it straight back to work with no further order.
 */
function markTrapped(world, u) {
  u.aiTrapped = true;
  u.aiTrappedCheck = world.time + TRAPPED_RECHECK;
  // Remember the job so freeing the villager puts it straight back to work. It
  // never chose to stop, and making the player re-task a villager they just dug
  // out is a second punishment for the same mistake.
  u.aiTrappedJob = trappedJobOf(u.task);
  releaseNode(u);
  u.task = null;
  u.target = null;
  clearMovement(u);
  u.state = 'idle';
  u.aiFails = 0;
  u.aiGoal = null;
}

/** The order that would resume `task`, or null if there is nothing to resume. */
function trappedJobOf(task) {
  if (!task) return null;
  switch (task.type) {
    case 'gather':
      return task.node ? { type: 'gather', target: task.node, gx: task.node.x, gy: task.node.y } : null;
    case 'build':
      return task.building ? { type: 'build', target: task.building } : null;
    case 'move':
    case 'patrol':
      return { type: 'move', gx: task.gx, gy: task.gy };
    default:
      return null;
  }
}

/**
 * Run to the Town Center (or away) while combat.js says the villager is scared.
 * One route per scare: once it gets there it cowers rather than re-planning
 * every step until the fright wears off.
 */
function tickFlee(world, u, ctx) {
  const dest = u.fleeTo;
  if (u.aiFleeGoal !== dest) {
    u.aiFleeGoal = dest;
    u.aiFails = 0;
    requestPath(world, u, dest.x, dest.y, ctx, true);
  }
  u.state = u.dest ? 'move' : 'idle';
}

// --- Tasks ------------------------------------------------------------------

function tickMove(world, u, dt, ctx) {
  const t = u.task;

  // Attack-move: stop for the fight, then carry on to where you were sent.
  //
  // combat.js acquires the target (it scans wider for an attack-moving unit and
  // keeps scanning while the unit walks) and does the damage. Without this hook
  // it would swing once and the unit would keep walking past the enemy, which is
  // the whole reason a deliberate attack-move looked broken.
  if (t.attackMove) {
    const target = u.target;
    if (target && canAttack(u, target)) {
      if (inRange(u, target)) {
        clearMovement(u);
        u.state = 'attack';
        u.facing = dirIndex(target.x - u.x, target.y - u.y);
        t.engaging = true;
        return;
      }
      // Close the gap. Repath only when the quarry has actually moved, exactly
      // as an ordered attack does.
      const moved = t.lastX === undefined
        ? Infinity
        : Math.hypot(target.x - t.lastX, target.y - t.lastY);
      if (!t.engaging || !u.dest || (moved > 1.2 && u.repathTimer <= 0)) {
        t.engaging = true;
        t.lastX = target.x;
        t.lastY = target.y;
        u.repathTimer = REPATH_COOLDOWN;
        const p = approachPoint(world, u, target);
        requestPath(world, u, p.x, p.y, ctx, false);
      }
      u.state = 'move';
      return;
    }
    if (t.engaging) {
      // Nothing left to fight here — resume the advance from where we stand.
      t.engaging = false;
      t.lastX = undefined;
      t.lastY = undefined;
      u.aiFails = 0;
      u.returnTo = null;   // the destination is the order, not where we stood
      clearMovement(u);
      requestPath(world, u, t.gx, t.gy, ctx, false);
      u.state = 'move';
      return;
    }
  }

  if (!u.dest) {
    // Arrived (or the path ran out). Close enough counts.
    const d = Math.hypot(u.x - t.gx, u.y - t.gy);
    if (d <= 1.0 || u.aiFails >= MAX_PATH_FAILS) {
      u.task = null;
      u.state = 'idle';
      u.vx = 0;
      u.vy = 0;
      return;
    }
    // A partial path got us as far as it could; try again from here.
    if (u.repathTimer <= 0) {
      u.aiFails++;
      u.repathTimer = REPATH_COOLDOWN;
      requestPath(world, u, t.gx, t.gy, ctx, false);
    }
    return;
  }
  u.state = 'move';
}

function tickPatrol(world, u, dt, ctx) {
  const t = u.task;
  if (!u.dest) {
    t.leg = t.leg === 'b' ? 'a' : 'b';
    const p = t.leg === 'b' ? t.b : t.a;
    requestPath(world, u, p.x, p.y, ctx, false);
  }
  u.state = 'move';
}

function tickGather(world, u, dt, ctx) {
  const t = u.task;

  if (t.stage === 'toDrop') {
    tickDeposit(world, u, dt, ctx);
    return;
  }

  // Node gone or empty: find the nearest equivalent one rather than stopping.
  if (!t.node || t.node.dead || t.node.amount <= 0) {
    if (!retargetNode(world, u, t, ctx)) {
      if (u.carrying && u.carrying.amount > 0) {
        t.stage = 'toDrop';
        routeToDropoff(world, u, t, ctx, false);
      } else {
        u.task = null;
        u.state = 'idle';
        clearMovement(u);
      }
    }
    return;
  }

  const node = t.node;
  // Edge distance, so a 2x2 farm is reached from beside its field rather than
  // requiring the villager to stand on its centre tile.
  const reach = edgeDist(node, u.x, u.y);
  // Time spent hovering in reach but still walking. A clean approach crosses
  // from GATHER_REACH to GATHER_START in about a third of a second; a villager
  // that cannot, because its neighbours are standing on the last free tile, has
  // arrived as far as it ever will and should start working instead of
  // shuffling. This is where the twenty-second windows of zero income came from.
  t.near = reach <= GATHER_REACH ? (t.near || 0) + dt : 0;
  if (reach <= GATHER_REACH && (!u.dest || reach <= GATHER_START || t.near >= NEAR_SETTLE)) {
    t.tries = 0;
    t.near = 0;
    clearMovement(u);
    u.state = 'gather';
    u.facing = dirIndex(node.x - u.x, node.y - u.y);
    claimNode(u, node);
    const done = gatherTick(world, u, node, dt);
    if (done) {
      if (u.carrying && u.carrying.amount > 0) {
        t.stage = 'toDrop';
        routeToDropoff(world, u, t, ctx, false);
      } else if (!t.node || t.node.dead || t.node.amount <= 0) {
        // Emptied it without filling up: straight to the next tree.
        if (!retargetNode(world, u, t, ctx)) {
          u.task = null;
          u.state = 'idle';
        }
      }
    }
    return;
  }

  // Walk to it.
  if (!u.dest) {
    if ((t.tries = (t.tries || 0) + 1) > MAX_APPROACH_TRIES) {
      t.tries = 0;
      if (!retargetNode(world, u, t, ctx)) {
        u.task = null;
        u.state = 'idle';
        clearMovement(u);
      }
      return;
    }
    const stand = pickStand(world, u, node);
    if (stand) {
      t.stand = stand;
      requestPath(world, u, stand.x, stand.y, ctx, false);
    } else if (!retargetNode(world, u, t, ctx)) {
      // Completely walled in and nothing else to work: stop cleanly.
      u.task = null;
      u.state = 'idle';
      return;
    }
  }
  u.state = 'move';
}

function tickDeposit(world, u, dt, ctx) {
  const t = u.task;
  if (!u.carrying || u.carrying.amount <= 0) {
    // Nothing to bank (someone else's code emptied it) — back to work.
    resumeGather(world, u, t, ctx);
    return;
  }
  let b = t.building;
  if (!b || b.dead || !b.complete) {
    b = null;
    routeToDropoff(world, u, t, ctx, false);
    b = t.building;
    if (!b) {
      // No drop-off exists. Stand still holding the goods; the moment one is
      // built the villager resumes. isIdle() reports it so the HUD can nag.
      clearMovement(u);
      u.state = 'idle';
      return;
    }
  }

  if (edgeDist(b, u.x, u.y) <= DROPOFF_REACH) {
    t.tries = 0;
    clearMovement(u);
    u.state = 'deposit';
    u.facing = dirIndex(b.x - u.x, b.y - u.y);
    depositCarry(world, u, b);
    resumeGather(world, u, t, ctx);
    return;
  }

  if (!u.dest) {
    if ((t.tries = (t.tries || 0) + 1) > MAX_APPROACH_TRIES) {
      // Cannot get to the drop-off at all. Stand down rather than pace, and do
      // not immediately re-adopt the same impossible errand.
      u.aiDropRetry = world.time + 5;
      u.task = null;
      clearMovement(u);
      u.state = 'idle';
      return;
    }
    routeToDropoff(world, u, t, ctx, false);
  }
  u.state = 'move';
}

/** Head back to the node just worked, or the nearest equivalent if it is gone. */
function resumeGather(world, u, t, ctx) {
  t.building = null;
  t.stage = 'toNode';
  if (t.node && !t.node.dead && t.node.amount > 0) {
    const stand = pickStand(world, u, t.node);
    t.stand = stand;
    if (stand) requestPath(world, u, stand.x, stand.y, ctx, false);
    else if (!retargetNode(world, u, t, ctx)) { u.task = null; u.state = 'idle'; }
    return;
  }
  if (!retargetNode(world, u, t, ctx)) {
    u.task = null;
    u.state = 'idle';
    clearMovement(u);
  }
}

function routeToDropoff(world, u, t, ctx, immediate) {
  const type = u.carrying ? u.carrying.type : null;
  const b = type ? nearestDropoff(world, u.player, u.x, u.y, type) : null;
  t.building = b || null;
  if (!b) return;
  const stand = findAdjacentStandTile(world, b, u.x, u.y, { maxRing: 1 });
  const p = stand || { x: b.x, y: b.y };
  requestPath(world, u, p.x, p.y, ctx, immediate);
  u.state = 'move';
}

function tickBuild(world, u, dt, ctx) {
  const t = u.task;
  const b = t.building;
  // A site that vanished under us (cancelled, destroyed) is not a finished one:
  // there is no next-in-the-batch to walk to, only work to find.
  if (!b || b.dead) { onJobFinished(world, u, ctx); return; }
  if (b.complete) { onJobFinished(world, u, ctx, b); return; }

  if (edgeDist(b, u.x, u.y) <= BUILD_REACH) {
    t.tries = 0;
    clearMovement(u);
    u.state = 'build';
    u.facing = dirIndex(b.x - u.x, b.y - u.y);
    const done = buildTick(world, u, b, dt);
    if (done) onJobFinished(world, u, ctx, b);
    return;
  }

  if (!u.dest) {
    if ((t.tries = (t.tries || 0) + 1) > MAX_APPROACH_TRIES) {
      // Could not get to it at all — leave the batch alone rather than skipping
      // to the next site, which would only walk into the same wall.
      onJobFinished(world, u, ctx);
      return;
    }
    // Take a tile no other builder has claimed. Two villagers walking at the
    // same square shove each other off it forever: each ends up ~1.6 tiles from
    // the wall — just outside BUILD_REACH — and the foundation never moves.
    const stand = pickBuildStand(world, u, b);
    t.stand = stand || null;
    if (stand) requestPath(world, u, stand.x, stand.y, ctx, false);
    else requestPath(world, u, b.x, b.y, ctx, false);
  }
  u.state = 'move';
}

/**
 * AoE2 behaviour: a villager that finishes a building does not stand around,
 * it walks to the nearest resource and starts working.
 *
 * ...unless the site it just finished was one of a batch the player queued, in
 * which case the next site in that batch outranks the nearest tree. That is the
 * whole contract of batch placement: you tap out a row of houses once and the
 * builders work through it without another order. It is deliberately gated on
 * the queue rather than on "is there any foundation nearby" — a villager must
 * not wander off to help with a building the player never asked *these* people
 * to build, and the enemy AI (which places foundations constantly and never
 * queues) keeps the behaviour it has always had.
 */
function onJobFinished(world, u, ctx, finished = null) {
  u.task = null;
  clearMovement(u);
  u.state = 'idle';
  if (u.type !== 'villager') return;

  if (finished && finished.queued) {
    const next = nextQueuedSite(world, u.player, u.x, u.y, finished);
    if (next) {
      orderBuild(world, [u], { type: 'build', target: next }, ctx);
      return;
    }
  }

  const preferred = u.aiMemory ? u.aiMemory.resourceType : null;
  const node = findWorkNode(world, u, u.x, u.y, FOLLOWUP_WORK_RADIUS, preferred);
  if (node) beginGatherTask(world, u, node, ctx, pickStand(world, u, node));
}

/**
 * Walk to the shelter and step inside it.
 *
 * The task ends three ways: the unit gets in (combat.garrisonUnit lifts it out
 * of world.units and this loop never sees it again), the building refuses it
 * for good — destroyed, filled up while we walked, someone else's — or the walk
 * cannot be served. Every one of them puts the unit back to idle rather than
 * leaving it pacing outside a full Town Center, which is the failure a player
 * reads as "the button did nothing".
 */
function tickGarrison(world, u, dt, ctx) {
  const t = u.task;
  const b = t.building;
  if (!b || b.dead) { u.task = null; clearMovement(u); u.state = 'idle'; return; }

  if (edgeDist(b, u.x, u.y) <= GARRISON_REACH) {
    clearMovement(u);
    u.facing = dirIndex(b.x - u.x, b.y - u.y);
    if (garrisonUnit(world, u, b)) return;
    // Refused at the door. A full building is worth waiting a beat for —
    // somebody may step out — but anything structural (not ours, still a
    // foundation, holds nobody at all) is not.
    if (!garrisonRefusal(world, u, b) || garrisonCount(b) < garrisonCapacity(b)) {
      u.task = null;
      u.state = 'idle';
      return;
    }
    t.waited = (t.waited || 0) + dt;
    if (t.waited > 3) { u.task = null; u.state = 'idle'; }
    return;
  }

  if (!u.dest) {
    if ((t.tries = (t.tries || 0) + 1) > MAX_APPROACH_TRIES) {
      u.task = null;
      clearMovement(u);
      u.state = 'idle';
      return;
    }
    const stand = findAdjacentStandTile(world, b, u.x, u.y, { maxRing: 2 });
    t.stand = stand || null;
    const p = stand || { x: b.x, y: b.y };
    requestPath(world, u, p.x, p.y, ctx, false);
  }
  u.state = 'move';
}

function tickAttack(world, u, dt, ctx) {
  const t = u.task;
  // Combat owns the target field: it drops targets that die, that stop being
  // attackable, or whose leash snapped (setting `returnTo`, handled upstream).
  // An auto task follows combat's choice; an ordered task keeps its own.
  if (t.auto) t.target = u.target;
  const target = t.target;

  if (!target || !canAttack(u, target)) {
    if (!t.auto) u.target = null;
    u.task = null;
    clearMovement(u);
    u.state = 'idle';
    return;
  }

  if (inRange(u, target)) {
    clearMovement(u);
    // combat.js sets facing while swinging; set it now so the very first frame
    // of the engagement already looks at the enemy.
    u.target = target;
    u.state = 'attack';
    u.facing = dirIndex(target.x - u.x, target.y - u.y);
    return;
  }

  // Stand Ground never takes a step for a fight it picked itself: the target
  // walked out of reach, so it stops being a target. An attack order the player
  // gave is a different thing entirely and still walks — telling a unit to kill
  // that is telling it to go there — which is why this only fires on `auto`.
  if (t.auto && stanceOf(u) === STANCE.STAND_GROUND) {
    u.target = null;
    u.task = null;
    clearMovement(u);
    u.state = 'idle';
    return;
  }

  u.target = target;
  u.state = 'move';
  // Repath only when the quarry has actually moved, or when the path ran out.
  const moved = t.lastX === undefined
    ? Infinity
    : Math.hypot(target.x - t.lastX, target.y - t.lastY);
  if (!u.dest || (moved > 1.2 && u.repathTimer <= 0)) {
    t.lastX = target.x;
    t.lastY = target.y;
    u.repathTimer = REPATH_COOLDOWN;
    const p = approachPoint(world, u, target);
    requestPath(world, u, p.x, p.y, ctx, false);
  }
}

// --- Retasking --------------------------------------------------------------

function claimNode(u, node) {
  if (u.aiNode === node) return;
  releaseNode(u);
  u.aiNode = node;
  node.workers = (node.workers || 0) + 1;
}

function releaseNode(u) {
  if (u.aiNode && !u.aiNode.dead) {
    u.aiNode.workers = Math.max(0, (u.aiNode.workers || 0) - 1);
  }
  u.aiNode = null;
}

/**
 * Everything `unit` may harvest: every resource node on the map, plus its own
 * player's finished farms. A farm is deliberately indistinguishable from a bush
 * from here down — same task, same walk, same drop-off trip.
 */
function eachWorkSource(world, unit, fn) {
  for (const n of world.resources) fn(n);
  if (!unit) return;
  for (const b of world.buildings) {
    if (b.player !== unit.player) continue;
    if (isGatherableBuilding(b)) fn(b);
  }
}

function findWorkNode(world, unit, x, y, radius, preferredType, exclude) {
  // Load counted by *assignment*, not by arrival: node.workers only rises once a
  // villager is already standing there gathering, so a whole crowd retasking off
  // an exhausted bush in the same step all read every node as empty and pile
  // onto the one next door — the exact stall this is here to stop.
  const load = currentNodeLoads(world, unit ? new Set([unit]) : null);
  const drops = unit
    ? world.buildings.filter((b) => !b.dead && b.player === unit.player && b.dropoff)
    : [];
  const haul = (n) => {
    let best = Infinity;
    for (const b of drops) {
      if (!acceptsDropoff(b, n.resourceType)) continue;
      const d = edgeDist(b, n.x, n.y);
      if (d < best) best = d;
    }
    return best === Infinity ? 0 : best;
  };

  let best = null;
  let bestScore = Infinity;
  // A retasked lumberjack stays a lumberjack: the preferred resource gets the
  // whole radius to itself, and only when it holds nothing at all does anything
  // else become work. A penalty instead of a pass used to lose this fight — once
  // hauling distance was priced in, a berry patch nine tiles out scored worse
  // than the tree line next door, and a food crew quietly became a wood crew.
  for (let pass = 0; pass < 2 && !best; pass++) {
    eachWorkSource(world, unit, (n) => {
      if (n.dead || n === exclude || !(n.amount > 0)) return;
      if (pass === 0 && preferredType && n.resourceType !== preferredType) return;
      // edgeDist, not centre distance: a 2x2 farm is worked from its edge.
      const d = edgeDist(n, x, y);
      if (d > radius) return;
      // The walk out there, once...
      let score = d;
      // ...plus the trip home, over and over.
      score += HAUL_WEIGHT * haul(n);
      // Spread out, but only once a node is genuinely oversubscribed: queueing
      // on a bush by the Town Center beats an empty one across the map.
      score += Math.max(0, (load.get(n) || 0) - nodeCapacity(world, n) + 1) * QUEUE_COST;
      if (score < bestScore) { bestScore = score; best = n; }
    });
    if (!preferredType) break;
  }
  return best;
}

/** Nearest thing `unit` could work, at any distance. */
function nearestWorkSource(world, unit, x, y) {
  let best = null;
  let bestD = Infinity;
  eachWorkSource(world, unit, (n) => {
    if (n.dead || !(n.amount > 0)) return;
    const d = edgeDist2(n, x, y);
    if (d < bestD) { bestD = d; best = n; }
  });
  return best;
}

/** Point a gather task at the nearest equivalent node. False if there is none. */
function retargetNode(world, u, t, ctx) {
  const old = t.node;
  const type = (old && old.resourceType)
    || (u.aiMemory && u.aiMemory.resourceType)
    || null;
  const ox = old && !old.dead ? old.x : u.x;
  const oy = old && !old.dead ? old.y : u.y;
  const node = findWorkNode(world, u, ox, oy, RETASK_RADIUS, type, old);
  if (!node) { releaseNode(u); return false; }

  releaseNode(u);
  t.node = node;
  t.stand = null;
  u.aiMemory = { resourceType: node.resourceType };
  if (t.stage === 'toDrop') return true; // finish the trip, then walk to the new node

  // Holding a part-load and the replacement node is further off than the
  // drop-off? Bank it on the way out. A whole crew migrating to the next patch
  // otherwise carries half-full packs straight past its own Town Center, and the
  // resource counter stops dead for the length of the walk — which is exactly
  // what a player reads as "my economy died".
  if (u.carrying && u.carrying.amount > 0) {
    const drop = nearestDropoff(world, u.player, u.x, u.y, u.carrying.type);
    if (drop && edgeDist(drop, u.x, u.y) < edgeDist(node, u.x, u.y)) {
      t.stage = 'toDrop';
      routeToDropoff(world, u, t, ctx, false);
      return true;
    }
  }
  const stand = pickStand(world, u, node);
  t.stand = stand;
  const p = stand || { x: node.x, y: node.y };
  requestPath(world, u, p.x, p.y, ctx, false);
  u.state = 'move';
  return true;
}

/**
 * EV.NODE_DEPLETED fires *before* world.removeEntity() wipes tasks pointing at
 * the node, so retargeting here keeps the task alive across the removal.
 */
function onNodeDepleted(world, node) {
  if (!node) return;
  const ctx = getCtx(world);
  for (const u of world.units) {
    if (u.dead || !u.task || u.task.type !== 'gather') continue;
    if (u.task.node !== node) continue;
    if (u.aiNode === node) releaseNode(u);
    if (!retargetNode(world, u, u.task, ctx)) {
      u.task.node = null;
      if (u.carrying && u.carrying.amount > 0) {
        u.task.stage = 'toDrop';
        routeToDropoff(world, u, u.task, ctx, false);
      } else {
        u.task = null;
        clearMovement(u);
        u.state = 'idle';
      }
    }
  }
}

/** Another builder finished the job — everyone on it moves on. */
function onBuilt(world, building) {
  if (!building) return;
  const ctx = getCtx(world);
  for (const u of world.units) {
    if (u.dead || !u.task || u.task.type !== 'build') continue;
    if (u.task.building !== building) continue;
    onJobFinished(world, u, ctx, building);
  }
  adoptNewDropoff(world, building, ctx);
}

/**
 * A drop-off just went up. Anyone already walking a load somewhere further away
 * turns and uses it instead.
 *
 * Every trip picks its drop-off fresh (routeToDropoff calls nearestDropoff), so
 * without this a new Lumber Camp still pays for itself — from the *next* trip.
 * That is one full round trip of nothing happening, which on a fifteen-tile haul
 * is half a minute, and the player who just spent 100 wood watching their
 * villagers walk past the new building is entitled to think it is broken. So the
 * moment the camp is finished, anyone whose current errand it shortens is
 * re-routed mid-walk.
 *
 * Deliberately narrow: only villagers already heading for a drop-off are
 * touched, and only when the new building is genuinely closer to where they are
 * standing right now. Nobody working a node is interrupted, and nobody is sent
 * backwards past a load they have almost delivered.
 */
function adoptNewDropoff(world, building, ctx) {
  if (!building.complete || !building.dropoff || !building.dropoff.length) return;
  for (const u of world.units) {
    if (u.dead || u.player !== building.player) continue;
    const t = u.task;
    if (!t || t.type !== 'gather' || t.stage !== 'toDrop') continue;
    const type = u.carrying ? u.carrying.type : null;
    if (!type || !building.dropoff.includes(type)) continue;
    const old = t.building;
    if (old === building) continue;
    if (old && !old.dead && edgeDist(old, u.x, u.y) <= edgeDist(building, u.x, u.y)) continue;
    routeToDropoff(world, u, t, ctx, false);
  }
}

/**
 * A free tile beside `node`, preferring one no other villager has claimed.
 *
 * Only the first ring is acceptable: a tile two rings out is further away than
 * GATHER_REACH, so a villager sent there would arrive, still not be able to
 * reach the tree, and walk in circles. When the ring is genuinely full the
 * villagers share tiles and separation shuffles them apart.
 */
function pickStand(world, u, node) {
  return standAvoidingPeers(world, u, node, 'gather', (t) => t.node === node);
}

/** The same idea for construction: one tile per builder on a foundation. */
function pickBuildStand(world, u, building) {
  return standAvoidingPeers(world, u, building, 'build', (t) => t.building === building);
}

function standAvoidingPeers(world, u, target, taskType, sameJob) {
  const avoid = new Set();
  for (const other of world.units) {
    if (other === u || other.dead) continue;
    const ot = other.task;
    if (!ot || ot.type !== taskType || !ot.stand || !sameJob(ot)) continue;
    avoid.add(`${ot.stand.tx},${ot.stand.ty}`);
  }
  return (
    findAdjacentStandTile(world, target, u.x, u.y, { avoid, maxRing: 1 }) ||
    findAdjacentStandTile(world, target, u.x, u.y, { maxRing: 1 })
  );
}

// --- Pathing ----------------------------------------------------------------

function clearMovement(u) {
  u.path = null;
  u.pathIndex = 0;
  u.dest = null;
  u.vx = 0;
  u.vy = 0;
  u.aiStuck = 0;
  u.aiLastDist = undefined;
  u.aiAnchorT = undefined;
}

/**
 * Ask for a path to (x,y). Searches are rationed per step, but a unit whose
 * search is queued still sets off in a straight line — a command must register
 * on the step it is given, never on the step the planner gets around to it.
 */
function requestPath(world, u, x, y, ctx, immediate) {
  u.dest = { x, y };
  u.aiGoal = { x, y };
  u.aiStuck = 0;
  u.aiLastDist = undefined;
  // NB: the headway anchor is deliberately *not* reset here. Repathing is the
  // thing a going-nowhere unit does most, and clearing the anchor on every
  // repath is exactly how it would stay invisible to the watchdog.

  let allowed = false;
  if (immediate && ctx.orderSearches > 0) { ctx.orderSearches--; allowed = true; }
  else if (ctx.searches > 0) { ctx.searches--; allowed = true; }

  if (!allowed) {
    // Straight-line intent this step; the real path lands within a step or two.
    u.path = null;
    u.pathIndex = 0;
    u.aiPathPending = true;
    return;
  }

  const p = findPath(world, u.x, u.y, x, y, {});
  u.aiPathPending = false;
  if (p && p.length) {
    u.path = p;
    u.pathIndex = 0;
    const end = p[p.length - 1];
    u.dest = { x: end.x, y: end.y };
    u.aiPartial = !!p.partial;
    if (p.partial) u.aiFails++;
  } else {
    // Nowhere to go at all. Usually a blocked corner, and checkStuck() will
    // retire the task if it really cannot be served — but this is also what
    // being entombed looks like, so ask the question properly and retire the
    // unit at once when the answer is yes. Cycling A* against the inside of a
    // wall for eight minutes is exactly the failure this closes.
    u.path = null;
    u.pathIndex = 0;
    u.aiPartial = true;
    u.aiFails++;
    if (isSealedFrom(world, u.x, u.y, x, y)) markTrapped(world, u);
  }
}

function currentWaypoint(u) {
  if (u.path && u.pathIndex < u.path.length) return u.path[u.pathIndex];
  return u.dest;
}

function isFinalWaypoint(u) {
  if (u.path && u.pathIndex < u.path.length) return u.pathIndex === u.path.length - 1;
  return true;
}

// --- Movement ---------------------------------------------------------------

function advance(world, u, dt) {
  u.aiMoved = 0;
  if (!u.dest) { u.vx = 0; u.vy = 0; return; }

  let remaining = u.speed * dt;
  let dirX = 0;
  let dirY = 0;
  let guard = 8;

  while (remaining > 1e-6 && guard-- > 0) {
    const wp = currentWaypoint(u);
    if (!wp) break;
    const dx = wp.x - u.x;
    const dy = wp.y - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const final = isFinalWaypoint(u);

    if (d <= (final ? ARRIVE_TOL : WAYPOINT_TOL)) {
      if (final) { onArrive(u); break; }
      u.pathIndex++;
      continue;
    }

    const step = Math.min(remaining, d);
    const nx = u.x + (dx / d) * step;
    const ny = u.y + (dy / d) * step;

    // Something was built across the path since it was planned.
    if (!isWalkable(world, nx, ny)) {
      u.aiStuck += dt;
      break;
    }

    u.x = nx;
    u.y = ny;
    u.aiMoved += step;
    remaining -= step;
    dirX = dx;
    dirY = dy;

    if (step >= d - 1e-9) {
      if (final) { onArrive(u); break; }
      u.pathIndex++;
    }
  }

  const len = Math.hypot(dirX, dirY);
  if (u.aiMoved > 1e-6 && len > 1e-9) {
    const speed = u.aiMoved / dt;
    u.vx = (dirX / len) * speed;
    u.vy = (dirY / len) * speed;
    u.facing = dirIndex(dirX, dirY);
  } else {
    u.vx = 0;
    u.vy = 0;
  }
}

/** Stop dead on the spot rather than sliding past and correcting back. */
function onArrive(u) {
  const wp = currentWaypoint(u);
  if (wp) { u.x = wp.x; u.y = wp.y; }
  u.path = null;
  u.pathIndex = 0;
  u.dest = null;
  u.vx = 0;
  u.vy = 0;
  u.aiStuck = 0;
  u.aiLastDist = undefined;
  u.aiAnchorT = undefined;
}

function checkStuck(world, u, dt, ctx) {
  if (!u.dest) {
    u.aiStuck = 0;
    u.aiLastDist = undefined;
    u.aiAnchorT = undefined;
    return;
  }

  // --- Headway: net ground covered over a window, whatever the waypoints say.
  let noHeadway = false;
  if (u.aiAnchorT === undefined) {
    u.aiAnchorX = u.x;
    u.aiAnchorY = u.y;
    u.aiAnchorT = world.time;
  } else if (Math.hypot(u.x - u.aiAnchorX, u.y - u.aiAnchorY) >= HEADWAY_DIST) {
    u.aiAnchorX = u.x;
    u.aiAnchorY = u.y;
    u.aiAnchorT = world.time;
  } else if (world.time - u.aiAnchorT >= HEADWAY_TIME) {
    noHeadway = true;
    u.aiAnchorX = u.x;
    u.aiAnchorY = u.y;
    u.aiAnchorT = world.time;
  }

  // Progress is measured against the waypoint being walked to, not the final
  // goal: while rounding an obstacle a unit legitimately moves *away* from its
  // destination, and that must not read as being stuck.
  const wp = currentWaypoint(u) || u.dest;
  const d = Math.hypot(wp.x - u.x, wp.y - u.y);
  const prev = u.aiLastDist;
  u.aiLastDist = d;
  // The first sample after a re-plan has nothing to compare against; judging it
  // as progress would silently reset the failure count on every repath, and a
  // hopeless order would never be retired.
  if (prev !== undefined) {
    if (prev - d < u.speed * dt * STUCK_FRACTION) {
      u.aiStuck += dt;
    } else {
      u.aiStuck = 0;
      u.aiFails = 0;
    }
  }

  // A unit with no headway has earned an escalation whatever its stuck timer
  // says — that timer is precisely what a shoved or path-less unit never
  // accumulates — so it bypasses both the threshold and the repath cooldown.
  if (!noHeadway) {
    if (u.aiStuck < STUCK_TIME) return;
    if (u.repathTimer > 0) return;
  }
  u.aiStuck = 0;

  const t = u.task;
  const walking = !t || t.type === 'move' || t.type === 'patrol';
  const goal = u.aiGoal || u.dest;

  // Crowded out of the last stretch of a walk: call it arrived. Measured to the
  // goal itself and gated on plain sight of it, so a unit wedged at a corner
  // halfway there — a real problem — is never excused, while the nine of
  // twenty-four that used to orbit a shared destination forever now settle.
  const gd = Math.hypot(goal.x - u.x, goal.y - u.y);
  if (walking && gd <= CROWD_ARRIVE && hasLineOfSight(world, u.x, u.y, goal.x, goal.y)) {
    u.path = null;
    u.pathIndex = 0;
    u.dest = null;
    u.vx = 0;
    u.vy = 0;
    u.aiLastDist = undefined;
    u.aiAnchorT = undefined;
    return;
  }

  // Sealed away from where it was sent: retire it now rather than after six more
  // fruitless searches, and — crucially — retire it for good instead of letting
  // retargetNode hand it another destination in the same pocket.
  if (isSealedFrom(world, u.x, u.y, goal.x, goal.y)) {
    markTrapped(world, u);
    return;
  }

  u.repathTimer = REPATH_COOLDOWN;
  u.aiFails++;
  if (u.aiFails > MAX_PATH_FAILS) {
    // Genuinely cannot be served. Stop cleanly instead of grinding A* forever.
    clearMovement(u);
    if (t && t.type === 'gather' && t.stage !== 'toDrop') {
      if (retargetNode(world, u, t, ctx)) { u.aiFails = 0; return; }
    }
    u.task = null;
    u.target = null;
    u.state = 'idle';
    u.aiFails = 0;
    return;
  }
  requestPath(world, u, goal.x, goal.y, ctx, false);
}

// --- Local avoidance --------------------------------------------------------

/**
 * Local avoidance.
 *
 * Separation is applied as a *steering bias on top of movement*, never as an
 * opposing force. The original version added a displacement of up to a full
 * movement step against the direction of travel, which gave two units walking
 * into each other a stable equilibrium at zero velocity: each cancelled the
 * other's step exactly, and neither ever arrived. Villagers hauling gold across
 * a shared route met head-on and froze there.
 *
 * Three things prevent that now:
 *   1. The component that opposes travel is clamped to SEP_MAX_BRAKE, so a unit
 *      under orders always retains most of its speed however deep the crowd.
 *   2. A head-on push (nothing to slide along) is turned into a sidestep, taken
 *      relative to the unit's *own* heading — so two units meeting nose to nose
 *      peel off to opposite sides of the road, like traffic keeping right.
 *      Deterministic, and it uses no randomness at all.
 *   3. Units that are not going anywhere yield instead, and count for less as
 *      obstacles, so moving traffic pushes through parked villagers.
 *
 * Stuck detection still exists, but as a genuine last resort for walls and
 * impossible orders — not as the thing that unpicks crowds.
 */
function separate(world, u, dt) {
  let px = 0;
  let py = 0;
  let n = 0;

  forEachNear(world, u.x, u.y, SEP_RADIUS, (e) => {
    if (e === u || e.dead || e.kind !== 'unit') return;
    let dx = u.x - e.x;
    let dy = u.y - e.y;
    const d2 = dx * dx + dy * dy;
    const min = (u.radius + e.radius) * 1.15;
    if (d2 > min * min) return;
    let d = Math.sqrt(d2);
    if (d < 1e-4) {
      // Exactly stacked (two units spawned on one spot): break the tie by id so
      // the result is deterministic and the pair never chases itself. Uses the
      // id rather than world.rng, which belongs to the seeded simulation.
      const a = u.id * 2.3999632;
      dx = Math.cos(a);
      dy = Math.sin(a);
      d = 1;
    }
    const weight = e.dest ? 1 : STATIONARY_WEIGHT;
    const push = ((min - d) / min) * weight;
    px += (dx / d) * push;
    py += (dy / d) * push;
    n++;
  });

  if (n === 0) return;
  const mag = Math.hypot(px, py);
  if (mag < SEP_DEADBAND) return;

  const step = u.speed * dt;
  // How badly we are overlapping, 0..1 — scales the whole correction.
  const strength = Math.min(1, mag);
  px /= mag;
  py /= mag;

  let ox;
  let oy;
  const wp = u.dest ? currentWaypoint(u) : null;

  if (wp) {
    // --- Under orders: steer, do not stop. ---
    let hx = wp.x - u.x;
    let hy = wp.y - u.y;
    const hl = Math.hypot(hx, hy);
    if (hl < 1e-6) return;
    hx /= hl;
    hy /= hl;

    const along = px * hx + py * hy;      // -1 head-on, +1 from behind
    let cx = px - along * hx;             // the part that is pure sideways
    let cy = py - along * hy;
    let cl = Math.hypot(cx, cy);

    if (cl < SIDESTEP_MIN && along < HEAD_ON_DOT) {
      // Dead ahead: no sideways component exists to grow, so pick a side.
      // Rotating our own heading by +90 degrees means two units approaching
      // each other choose opposite sides of the road and slide past.
      cx = -hy;
      cy = hx;
      cl = 1;
    }
    if (cl > 1e-6) { cx /= cl; cy /= cl; }
    else { cx = 0; cy = 0; }

    const brake = clamp(along, -SEP_MAX_BRAKE, SEP_MAX_YIELD) * step * strength;
    const slide = SEP_CROSS_GAIN * step * strength;
    ox = cx * slide + hx * brake;
    oy = cy * slide + hy * brake;
  } else {
    // --- Not going anywhere: absorb the shove and get out of the way. ---
    const working = u.state === 'gather' || u.state === 'build' ||
      u.state === 'deposit' || u.state === 'attack';
    const gain = working ? SEP_GAIN_WORKING : SEP_GAIN_IDLE;
    ox = px * step * gain * strength;
    oy = py * step * gain * strength;
  }

  let nx = u.x + ox;
  let ny = u.y + oy;

  // Never let a shove push a unit inside a wall: slide along it instead.
  if (!isWalkable(world, nx, ny)) {
    if (isWalkable(world, nx, u.y)) ny = u.y;
    else if (isWalkable(world, u.x, ny)) nx = u.x;
    else return;
  }
  u.x = clamp(nx, 0.05, world.width - 0.05);
  u.y = clamp(ny, 0.05, world.height - 0.05);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
