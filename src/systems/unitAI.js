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

import { dirIndex } from '../core/iso.js';
import { forEachNear, edgeDist, findNearestGlobal } from '../core/world.js';
import { EV } from '../core/events.js';
import {
  findPath, findAdjacentStandTile, isWalkable, nearestWalkable, hasLineOfSight,
} from './pathfinding.js';
import {
  gatherTick, depositCarry, buildTick, nearestDropoff,
} from './economy.js';
import { inRange, canAttack, attackReach } from './combat.js';

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

// Formation spacing for group orders, in tiles.
const FORMATION_SPACING = 1.0;

// How far a villager will walk to find replacement work.
const RETASK_RADIUS = 24;
const FOLLOWUP_WORK_RADIUS = 14;

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
  commandUnits(world, [unit], { type: 'move', gx: r.x, gy: r.y });
}

// --- Public API -------------------------------------------------------------

/**
 * Issue an order to a group of units.
 *
 * `order` = { type, gx, gy, target } where type is
 * 'move' | 'gather' | 'attack' | 'build' | 'stop' | 'patrol'.
 *
 * Called by ui/input.js for the player and by systems/enemyAI.js for the AI.
 * `units` may be entities, ids, an array or any iterable — selections travel in
 * several shapes and an order must never be dropped over that.
 */
export function commandUnits(world, units, order) {
  if (!order) return;
  const list = normalizeUnits(world, units);
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

  const units = world.units;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (!u || u.dead) continue;
    stepUnit(world, u, dt, ctx);
  }
  // Separation runs after every unit has moved, so pushes are computed against
  // this step's positions and the result is symmetric.
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (!u || u.dead) continue;
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
}

/** Begin a task and start moving in the same step the order was given. */
function setTask(world, u, task, ctx, destX, destY) {
  u.task = task;
  u.target = null;
  u.aiStuck = 0;
  u.aiFails = 0;
  u.repathTimer = 0;
  if (destX !== undefined && destY !== undefined) {
    requestPath(world, u, destX, destY, ctx, true);
    u.state = 'move';
  }
}

function orderMove(world, list, order, ctx) {
  const gx = order.gx !== undefined ? order.gx : order.target ? order.target.x : null;
  const gy = order.gy !== undefined ? order.gy : order.target ? order.target.y : null;
  if (gx === null || gy === null) return;
  const slots = assignSlots(world, list, gx, gy);
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    const s = slots[i];
    setTask(world, u, { type: 'move', gx: s.x, gy: s.y }, ctx, s.x, s.y);
  }
}

function orderPatrol(world, list, order, ctx) {
  const gx = order.gx;
  const gy = order.gy;
  if (gx === undefined || gy === undefined) return;
  const slots = assignSlots(world, list, gx, gy);
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
  if (!node || node.kind !== 'resource') {
    node = order.gx !== undefined
      ? findNearestGlobal(world, order.gx, order.gy, world.resources, (e) => e.amount > 0)
      : null;
  }
  if (!node) {
    // Tapped bare ground with a gather order — walk there instead of refusing.
    if (order.gx !== undefined) orderMove(world, list, order, ctx);
    return;
  }
  const avoid = new Set();
  for (const u of list) {
    const stand = findAdjacentStandTile(world, node, u.x, u.y, { avoid, maxRing: 1 })
      || findAdjacentStandTile(world, node, u.x, u.y, { maxRing: 1 });
    if (stand) avoid.add(`${stand.tx},${stand.ty}`);
    beginGatherTask(world, u, node, ctx, stand);
  }
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

/**
 * Destination slots for a group order: a loose block centred on the tap, so a
 * dozen units arrive as a formation instead of a conga line fighting over one
 * tile. Slots are matched to units nearest-first, which keeps the group's
 * relative layout and stops units from crossing through each other.
 */
function assignSlots(world, list, gx, gy) {
  const n = list.length;
  if (n === 1) {
    // Fall back to the raw point when nothing near it is free: findPath slides
    // the goal onto walkable ground anyway, and refusing the order is worse.
    return [walkablePoint(world, gx, gy) || { x: gx, y: gy }];
  }
  const slots = [];
  const spacing = FORMATION_SPACING;
  for (let ring = 0; slots.length < n && ring < 14; ring++) {
    if (ring === 0) {
      const p = walkablePoint(world, gx, gy);
      if (p) slots.push(p);
      continue;
    }
    const count = Math.max(6, ring * 6);
    for (let i = 0; i < count && slots.length < n; i++) {
      const a = (i / count) * Math.PI * 2 + ring * 0.5;
      const px = gx + Math.cos(a) * ring * spacing;
      const py = gy + Math.sin(a) * ring * spacing;
      const p = walkablePoint(world, px, py);
      if (!p) continue;
      let tooClose = false;
      for (const s of slots) {
        const dx = s.x - p.x;
        const dy = s.y - p.y;
        if (dx * dx + dy * dy < spacing * spacing * 0.64) { tooClose = true; break; }
      }
      if (!tooClose) slots.push(p);
    }
  }
  while (slots.length < n) slots.push({ x: gx, y: gy });

  // Greedy nearest assignment, centre slot first.
  const out = new Array(n).fill(null);
  const taken = new Array(n).fill(false);
  for (let si = 0; si < slots.length && si < n; si++) {
    let best = -1;
    let bestD = Infinity;
    for (let ui = 0; ui < n; ui++) {
      if (taken[ui]) continue;
      const dx = list[ui].x - slots[si].x;
      const dy = list[ui].y - slots[si].y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = ui; }
    }
    if (best >= 0) { taken[best] = true; out[best] = slots[si]; }
  }
  for (let i = 0; i < n; i++) if (!out[i]) out[i] = { x: gx, y: gy };
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

  // A unit trained with a rally point set (economy.js stamps pendingRally, and
  // also emits EV.TRAINED, which we handle; this catches anything that slips).
  if (u.pendingRally && !u.task) {
    const r = u.pendingRally;
    u.pendingRally = null;
    commandUnits(world, [u], { type: 'move', gx: r.x, gy: r.y });
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
  const reach = Math.hypot(u.x - node.x, u.y - node.y);
  if (reach <= GATHER_REACH && (!u.dest || reach <= GATHER_START)) {
    t.tries = 0;
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
  if (!b || b.dead) { onJobFinished(world, u, ctx); return; }
  if (b.complete) { onJobFinished(world, u, ctx); return; }

  if (edgeDist(b, u.x, u.y) <= BUILD_REACH) {
    t.tries = 0;
    clearMovement(u);
    u.state = 'build';
    u.facing = dirIndex(b.x - u.x, b.y - u.y);
    const done = buildTick(world, u, b, dt);
    if (done) onJobFinished(world, u, ctx);
    return;
  }

  if (!u.dest) {
    if ((t.tries = (t.tries || 0) + 1) > MAX_APPROACH_TRIES) {
      onJobFinished(world, u, ctx);
      return;
    }
    const stand = findAdjacentStandTile(world, b, u.x, u.y, { maxRing: 1 });
    if (stand) requestPath(world, u, stand.x, stand.y, ctx, false);
    else requestPath(world, u, b.x, b.y, ctx, false);
  }
  u.state = 'move';
}

/**
 * AoE2 behaviour: a villager that finishes a building does not stand around,
 * it walks to the nearest resource and starts working.
 */
function onJobFinished(world, u, ctx) {
  u.task = null;
  clearMovement(u);
  u.state = 'idle';
  if (u.type !== 'villager') return;
  const preferred = u.aiMemory ? u.aiMemory.resourceType : null;
  const node = findWorkNode(world, u.x, u.y, FOLLOWUP_WORK_RADIUS, preferred);
  if (node) beginGatherTask(world, u, node, ctx, pickStand(world, u, node));
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

function findWorkNode(world, x, y, radius, preferredType, exclude) {
  let best = null;
  let bestScore = Infinity;
  const r2 = radius * radius;
  for (const n of world.resources) {
    if (n.dead || n === exclude || n.amount <= 0) continue;
    const dx = n.x - x;
    const dy = n.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    let score = Math.sqrt(d2);
    // Prefer the same resource so a retasked lumberjack stays a lumberjack.
    if (preferredType && n.resourceType !== preferredType) score += radius * 0.5;
    // Spread out: an unworked node beats one with a queue on it.
    score += (n.workers || 0) * 0.75;
    if (score < bestScore) { bestScore = score; best = n; }
  }
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
  const node = findWorkNode(world, ox, oy, RETASK_RADIUS, type, old);
  if (!node) { releaseNode(u); return false; }

  releaseNode(u);
  t.node = node;
  t.stand = null;
  u.aiMemory = { resourceType: node.resourceType };
  if (t.stage === 'toDrop') return true; // finish the trip, then walk to the new node
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
    onJobFinished(world, u, ctx);
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
  const avoid = new Set();
  for (const other of world.units) {
    if (other === u || other.dead) continue;
    const ot = other.task;
    if (!ot || ot.type !== 'gather' || ot.node !== node || !ot.stand) continue;
    avoid.add(`${ot.stand.tx},${ot.stand.ty}`);
  }
  return (
    findAdjacentStandTile(world, node, u.x, u.y, { avoid, maxRing: 1 }) ||
    findAdjacentStandTile(world, node, u.x, u.y, { maxRing: 1 })
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
    // Nowhere to go at all. Keep the straight-line intent; checkStuck() will
    // retire the task if it really cannot be served.
    u.path = null;
    u.pathIndex = 0;
    u.aiPartial = true;
    u.aiFails++;
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
}

function checkStuck(world, u, dt, ctx) {
  if (!u.dest) {
    u.aiStuck = 0;
    u.aiLastDist = undefined;
    return;
  }
  // Progress is measured against the waypoint being walked to, not the final
  // goal: while rounding an obstacle a unit legitimately moves *away* from its
  // destination, and that must not read as being stuck.
  const wp = currentWaypoint(u);
  if (!wp) { u.aiStuck = 0; return; }
  const d = Math.hypot(wp.x - u.x, wp.y - u.y);
  const prev = u.aiLastDist;
  u.aiLastDist = d;
  // The first sample after a re-plan has nothing to compare against; judging it
  // as progress would silently reset the failure count on every repath, and a
  // hopeless order would never be retired.
  if (prev === undefined) return;
  if (prev - d < u.speed * dt * STUCK_FRACTION) {
    u.aiStuck += dt;
  } else {
    u.aiStuck = 0;
    u.aiFails = 0;
  }

  if (u.aiStuck < STUCK_TIME) return;
  if (u.repathTimer > 0) return;
  u.aiStuck = 0;

  // Crowded out of the last stretch of a walk: call it arrived. Only at the end
  // of the path — being wedged at a corner halfway there is a real problem.
  const t = u.task;
  const walking = !t || t.type === 'move' || t.type === 'patrol';
  if (
    walking && isFinalWaypoint(u) && d <= CROWD_ARRIVE &&
    hasLineOfSight(world, u.x, u.y, wp.x, wp.y)
  ) {
    u.path = null;
    u.pathIndex = 0;
    u.dest = null;
    u.vx = 0;
    u.vy = 0;
    u.aiLastDist = undefined;
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
  const goal = u.aiGoal || u.dest;
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
