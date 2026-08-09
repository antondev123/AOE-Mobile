// Villager allocation: "keep 40% of my people on wood" as a standing order.
//
// This is the macro a phone cannot do by hand. On a desktop you fix a lopsided
// economy by boxing eight villagers and clicking a tree; with one thumb, on a
// 96x96 map where the gold you are working is off screen, that is four gestures
// and a camera trip per correction — so in practice nobody corrects, and the
// match is decided by whichever ratio you happened to open with. The manager
// turns the ratio itself into the control: you say what the split should be, and
// the game keeps the villagers matching it.
//
// It owns *who works what*. It never moves a unit itself (that is unitAI's job)
// and it never touches the stockpile (that is economy.js): it decides, then
// issues ordinary gather orders through commandUnits, exactly as a player's tap
// would. So a managed villager is not a special kind of villager — it retargets
// when its bush runs dry, it flees a raid, it is selectable and orderable, and
// switching the manager off leaves everyone exactly where they stand.
//
// No Phaser imports: this file must run headlessly under Node (see
// tests/allocation.test.mjs).

import { RES, PLAYER } from '../core/constants.js';
import { edgeDist, ownedBy } from '../core/world.js';
import { isGatherableBuilding, nearestDropoff } from './economy.js';
import { commandUnits } from './unitAI.js';

/** The four resources, in the order the HUD lists them. */
export const ALLOC_ORDER = [RES.FOOD, RES.WOOD, RES.GOLD, RES.STONE];

// --- Tuning ------------------------------------------------------------------
//
// Everything below exists to answer one question: how do you chase a ratio
// without spending the whole match walking villagers past each other?
//
// A villager's round trip is 12-14 seconds (see GATHER_SPEED in economy.js), and
// a re-task typically costs most of one — the walk out to the new node, with
// nothing gathered on the way. So every correction has a price of roughly one
// trip's income, and the numbers here are all that price being weighed against
// what the correction buys.

// How often the split is reconsidered. Ten sim steps between passes is not about
// CPU — a pass is a couple of linear scans — it is about not reacting to a state
// that lasts a fraction of a second. A villager banking a load, a bush running
// out, a new villager stepping off the Town Center: all of those flicker the
// counts for one step, and a manager that answered every flicker would issue
// orders nobody asked for.
export const ALLOC_TICK = 2.0;

// How far out of balance a resource has to be before a villager already working
// is taken off it. One villager out of place on a four-man wood line is 25% of
// that line but about 0.7 resources a second in absolute terms, and fixing it
// costs ten seconds of the villager doing the fixing — so the exchange does not
// pay until the second one. Under this deadband the counts are allowed to sit
// slightly wrong forever, which is the entire reason the manager converges: with
// a fractional target (17 villagers on a 35/35/20/10 split) the rounding is
// *always* slightly wrong, and chasing it is a treadmill.
export const DEADBAND = 1;

// ...with one exception, and it is not a fudge. A resource with nobody on it at
// all is not "one villager out of balance", it is a line that does not exist:
// the stone the player asked for is arriving at zero per second and no amount of
// waiting changes that. So opening a new line is always worth one trip.
// (The reverse — the last villager on a line the player has dialled to 0% —
// still moves, because its own surplus is 1 over a target of 0 and that is what
// "0%" was asked for.)

// A villager the manager has just re-tasked is off limits for this long. This is
// the anti-ping-pong: it is a whole round trip, so a villager always gets to
// *finish something* on its new job before anyone reconsiders it. Without it the
// interesting failure is not oscillation between two resources but a three-way
// shuffle — food is short so a woodcutter moves, which makes wood short, which
// moves a miner, which makes gold short — with the same three villagers walking
// in a circle and nobody ever gathering.
export const RETASK_COOLDOWN = 12;

// How many *working* villagers may be moved in one pass. Two, because a pass is
// every two seconds and a re-task takes ten: any more and the manager would have
// a dozen villagers in flight before the first one arrived, all of them counted
// as already assigned, and the next pass would happily order a dozen more back.
// Gradual is not a compromise here, it is the correctness condition.
export const MAX_RETASKS_PER_PASS = 2;

// Idle villagers are not rationed the same way: they are producing nothing
// wherever they stand, so putting one to work has no cost to weigh. The cap is
// only here so that a Town Center that has just emptied a twelve-deep queue does
// not do twelve pathfinding searches in one step.
export const MAX_IDLE_PER_PASS = 6;

// Scoring a node for a villager, in tiles of walking. Same shape and the same
// numbers as unitAI's replacement-work scorer, deliberately: the manager must
// not have its own opinion about what a good bush is, or a villager it sends
// somewhere will be sent straight back by the unit AI's own retargeting.
const HAUL_WEIGHT = 2.0;
const QUEUE_COST = 2.5;
const MAX_WORKERS_PER_NODE = 5;

/** The split a player starts on: a dark-age opening, food and wood first. */
export const DEFAULT_SPLIT = { food: 35, wood: 35, gold: 20, stone: 10 };

// --- State -------------------------------------------------------------------

function allocState(world) {
  if (!world._alloc) {
    world._alloc = {
      players: world.players.map(() => ({
        on: false,
        split: { ...DEFAULT_SPLIT },
        timer: 0,
        // unit id -> world.time before which this villager may not be moved again
        cooldown: new Map(),
        moves: 0,        // lifetime re-tasks, for the tests and the HUD
      })),
    };
  }
  return world._alloc;
}

/** The manager's state for a player. Created on first use. */
export function allocationState(world, playerId = PLAYER) {
  return allocState(world).players[playerId];
}

export function isAllocationOn(world, playerId = PLAYER) {
  return allocationState(world, playerId).on;
}

/**
 * Turn the manager on or off. Switching it off is instantaneous and total:
 * nothing is re-tasked back, nothing is remembered, every villager simply keeps
 * doing what it was doing. That is the promise the on/off switch has to make, or
 * a player who wants to place their own villagers is arguing with a system they
 * cannot see.
 */
export function setAllocationOn(world, playerId, on) {
  const st = allocationState(world, playerId);
  st.on = !!on;
  // Act on the next step rather than in two seconds' time: switching it on is
  // the one moment the player is watching for it to do something.
  st.timer = ALLOC_TICK;
  return st.on;
}

export function getSplit(world, playerId = PLAYER) {
  return { ...allocationState(world, playerId).split };
}

/**
 * Set one resource's share and rebalance the rest so the four still total 100.
 *
 * The other three keep their *relative* proportions — drag wood from 20 to 50
 * and the 30 points come off food, gold and stone in the ratio they were already
 * in, so a player who has carefully set 5% stone does not find it doubled
 * because they touched a different slider. When the others are all at zero the
 * remainder is split evenly, because there is no ratio to preserve.
 *
 * Integer percentages throughout, with the rounding drift pushed onto the
 * largest of the others: two sliders that each say 33% and a total that says 99
 * is the kind of arithmetic a player notices immediately.
 */
export function setSplit(world, playerId, resource, pct) {
  const st = allocationState(world, playerId);
  if (!ALLOC_ORDER.includes(resource)) return { ...st.split };
  const want = Math.max(0, Math.min(100, Math.round(pct)));
  const others = ALLOC_ORDER.filter((k) => k !== resource);
  const rest = 100 - want;
  const sum = others.reduce((n, k) => n + st.split[k], 0);

  const next = { [resource]: want };
  let given = 0;
  for (const k of others) {
    const share = sum > 0 ? (st.split[k] / sum) * rest : rest / others.length;
    next[k] = Math.floor(share);
    given += next[k];
  }
  // Hand the rounding remainder to whichever of the others is already biggest,
  // so it lands where it is least visible.
  let drift = rest - given;
  const bySize = others.slice().sort((a, b) => next[b] - next[a] || ALLOC_ORDER.indexOf(a) - ALLOC_ORDER.indexOf(b));
  for (let i = 0; drift > 0; i = (i + 1) % bySize.length) {
    next[bySize[i]]++;
    drift--;
  }
  st.split = next;
  st.timer = ALLOC_TICK; // a change the player just made must be acted on now
  return { ...st.split };
}

/** Put the split back to the opening ratio. */
export function resetSplit(world, playerId) {
  const st = allocationState(world, playerId);
  st.split = { ...DEFAULT_SPLIT };
  st.timer = ALLOC_TICK;
  return { ...st.split };
}

// --- Reading the world -------------------------------------------------------

/**
 * What resource this villager is currently working, or null when it is not
 * gathering at all.
 *
 * The node it is walking to is the honest answer even while it is walking back
 * to a drop-off with a full pack — that trip is part of the job, and counting a
 * hauling villager as unassigned would have the manager re-task half the wood
 * line every time it went home.
 */
export function jobResourceOf(u) {
  const t = u && u.task;
  if (!t || t.type !== 'gather') return null;
  if (t.node && !t.node.dead && t.node.resourceType) return t.node.resourceType;
  if (u.carrying && u.carrying.amount > 0) return u.carrying.type;
  return (u.aiMemory && u.aiMemory.resourceType) || null;
}

/**
 * Villagers the manager is allowed to have an opinion about.
 *
 * Deliberately narrow. A villager building something, walking somewhere, running
 * from a raid or sealed inside a pocket is doing something that is not "working
 * a resource", and every one of those is either the player's explicit order or a
 * situation the manager would make worse by adding a second order on top. What
 * is left is the set the ratio is actually about: people gathering, and people
 * standing around not gathering.
 */
export function manageable(world, playerId) {
  const out = [];
  for (const u of ownedBy(world, playerId, 'unit', 'villager')) {
    if (u.dead || u.garrisonedIn || u.aiTrapped || u.fleeing) continue;
    if (u.task && u.task.type !== 'gather') continue;
    out.push(u);
  }
  return out;
}

/**
 * Largest-remainder apportionment: how many of `n` villagers each resource
 * should have, given percentages that may not divide evenly.
 *
 * Largest remainder rather than rounding each share independently, because
 * independent rounding does not add up — 3 villagers on 35/35/20/10 rounds to
 * 1/1/1/0, which is four villagers' worth of orders for three villagers, and the
 * manager would spend the whole match trying to satisfy an impossible target.
 */
export function apportion(n, weights, keys = ALLOC_ORDER) {
  const total = keys.reduce((s, k) => s + Math.max(0, weights[k] || 0), 0);
  // Every resource is present in the answer, including the ones that were not
  // in the running: a caller reading `desired.stone` while the map has no stone
  // left wants the number 0, not `undefined` — which formats as "NaN" on a HUD.
  const out = {};
  for (const k of ALLOC_ORDER) out[k] = 0;
  for (const k of keys) out[k] = 0;
  if (n <= 0 || total <= 0) return out;

  const rem = [];
  let given = 0;
  for (const k of keys) {
    const exact = (n * Math.max(0, weights[k] || 0)) / total;
    out[k] = Math.floor(exact);
    given += out[k];
    rem.push({ k, r: exact - out[k] });
  }
  // Ties broken by the display order, so the same inputs always give the same
  // answer — a manager that shuffled a villager because a Map iterated
  // differently would be impossible to debug and impossible to trust.
  rem.sort((a, b) => b.r - a.r || keys.indexOf(a.k) - keys.indexOf(b.k));
  for (let i = 0; given < n; i++, given++) out[rem[i % rem.length].k]++;
  return out;
}

/** Everything this player could put a villager on, bucketed by resource. */
function workSources(world, playerId) {
  const by = { food: [], wood: [], gold: [], stone: [] };
  for (const n of world.resources) {
    if (n.dead || !(n.amount > 0)) continue;
    if (by[n.resourceType]) by[n.resourceType].push(n);
  }
  for (const b of world.buildings) {
    if (b.player !== playerId) continue;
    if (isGatherableBuilding(b)) by[b.resourceType || 'food'].push(b);
  }
  return by;
}

/** Villagers already assigned to each node, so a crowd is priced. */
function nodeLoads(world) {
  const m = new Map();
  for (const u of world.units) {
    if (u.dead) continue;
    const t = u.task;
    if (!t || t.type !== 'gather' || !t.node) continue;
    m.set(t.node, (m.get(t.node) || 0) + 1);
  }
  return m;
}

/**
 * The node a villager standing at (x, y) should be sent to for `res`, priced in
 * tiles: the walk out there once, the haul home on every trip afterwards, and
 * what it costs to be the sixth person on a bush that seats five.
 */
export function bestNodeFor(world, playerId, res, x, y, sources, loads) {
  const list = (sources || workSources(world, playerId))[res] || [];
  const load = loads || nodeLoads(world);
  let best = null;
  let bestScore = Infinity;
  for (const n of list) {
    const drop = nearestDropoff(world, playerId, n.x, n.y, res);
    const haul = drop ? edgeDist(drop, n.x, n.y) : 0;
    const over = Math.max(0, (load.get(n) || 0) - MAX_WORKERS_PER_NODE + 1);
    const score = edgeDist(n, x, y) + HAUL_WEIGHT * haul + over * QUEUE_COST;
    if (score < bestScore || (score === bestScore && best && n.id < best.id)) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

/**
 * The whole picture, for the HUD: what the split asks for, what the villagers
 * are actually doing, and which resources the map can even offer right now.
 * Pure read — the panel calls this every frame.
 */
export function allocationCounts(world, playerId = PLAYER) {
  const st = allocationState(world, playerId);
  const pool = manageable(world, playerId);
  const sources = workSources(world, playerId);

  const assigned = { food: 0, wood: 0, gold: 0, stone: 0 };
  let idle = 0;
  for (const u of pool) {
    const res = jobResourceOf(u);
    if (res && assigned[res] !== undefined) assigned[res]++;
    else idle++;
  }

  // A resource with nothing left to gather is dropped from the apportionment
  // and its share goes to the others. Holding a quarter of the workforce in
  // reserve for a stone mine that no longer exists is the one failure that would
  // make the manager worse than doing nothing.
  const available = ALLOC_ORDER.filter((k) => sources[k].length > 0);
  const desired = apportion(pool.length, st.split, available);
  for (const k of ALLOC_ORDER) if (desired[k] === undefined) desired[k] = 0;

  return {
    on: st.on,
    split: { ...st.split },
    assigned,
    desired,
    idle,
    total: pool.length,
    available,
    moves: st.moves,
  };
}

// --- The pass ----------------------------------------------------------------

/**
 * One reconsideration of one player's workforce.
 *
 * The order of business is the order of cost: idle villagers first (free), then
 * the shortest walk that fixes the biggest gap. Returns the number of orders
 * issued, which is what the tests assert converges to zero.
 */
export function allocationPass(world, playerId) {
  const st = allocationState(world, playerId);
  const pool = manageable(world, playerId);
  if (!pool.length) return 0;

  const sources = workSources(world, playerId);
  const loads = nodeLoads(world);
  const available = ALLOC_ORDER.filter((k) => sources[k].length > 0);
  if (!available.length) return 0;

  const assigned = { food: 0, wood: 0, gold: 0, stone: 0 };
  const workers = { food: [], wood: [], gold: [], stone: [] };
  const idle = [];
  for (const u of pool) {
    const res = jobResourceOf(u);
    if (res && workers[res]) {
      assigned[res]++;
      workers[res].push(u);
    } else {
      idle.push(u);
    }
  }
  const desired = apportion(pool.length, st.split, available);

  // Deterministic order everywhere: two runs of the same match must issue the
  // same orders, or nothing about this is testable.
  idle.sort((a, b) => a.id - b.id);
  for (const k of ALLOC_ORDER) workers[k].sort((a, b) => a.id - b.id);

  const need = () => {
    // The hungriest available resource, and how many bodies short it is.
    //
    // A line with nobody on it at all outranks a line that is merely short,
    // however much shorter the second one is. Without that, "20% on stone" with
    // six villagers can starve indefinitely: stone is one body short, so is
    // food, food is listed first, food is inside the deadband, and the pass
    // gives up before it ever looks at the resource producing literally nothing.
    //
    // `available` is walked in ALLOC_ORDER, and a strict > keeps the first of
    // any tie — so a two-way tie is always broken by display order rather than
    // by whatever the iteration happened to reach last.
    let bestK = null;
    let bestD = 0;
    for (const k of available) {
      if (assigned[k] > 0 || !(desired[k] > 0)) continue;
      if (desired[k] > bestD) {
        bestD = desired[k];
        bestK = k;
      }
    }
    if (bestK) return { k: bestK, d: bestD };

    for (const k of available) {
      const d = (desired[k] || 0) - assigned[k];
      if (d > bestD) {
        bestD = d;
        bestK = k;
      }
    }
    return bestD > 0 ? { k: bestK, d: bestD } : null;
  };

  let orders = 0;

  // --- 1. Idle villagers, cheapest first. -----------------------------------
  for (const u of idle) {
    if (orders >= MAX_IDLE_PER_PASS) break;
    const want = need();
    if (!want) break;
    const node = bestNodeFor(world, playerId, want.k, u.x, u.y, sources, loads);
    if (!node) break;
    commandUnits(world, [u], { type: 'gather', target: node, gx: node.x, gy: node.y });
    loads.set(node, (loads.get(node) || 0) + 1);
    assigned[want.k]++;
    workers[want.k].push(u);
    st.cooldown.set(u.id, world.time + RETASK_COOLDOWN);
    st.moves++;
    orders++;
  }

  // --- 2. Move people who are already working, but only when it pays. -------
  let retasks = 0;
  while (retasks < MAX_RETASKS_PER_PASS) {
    const want = need();
    if (!want) break;
    // The deadband, and its one exception: opening a line that does not exist
    // is always worth a trip; nudging an existing one by a body is not.
    if (want.d <= DEADBAND && assigned[want.k] > 0) break;

    // Take from whoever has the most to spare. A resource is only "spare" when
    // it is over its own target — never rob a line that is itself short.
    let from = null;
    let fromSurplus = 0;
    for (const k of ALLOC_ORDER) {
      if (k === want.k) continue;
      const s = assigned[k] - (desired[k] || 0);
      if (s > fromSurplus) {
        fromSurplus = s;
        from = k;
      }
    }
    if (!from) break;

    // Whoever is nearest to where the work is. This is the difference between a
    // manager that helps and one that sends a villager across the map: the
    // villager standing at the wood line closest to the gold is the one who
    // becomes a miner, and the round trip barely changes for anybody.
    const target = bestNodeFor(world, playerId, want.k, 0, 0, sources, loads);
    if (!target) break;
    let pick = null;
    let pickD = Infinity;
    for (const u of workers[from]) {
      if ((st.cooldown.get(u.id) || 0) > world.time) continue;
      const d = edgeDist(target, u.x, u.y);
      if (d < pickD) {
        pickD = d;
        pick = u;
      }
    }
    if (!pick) break; // everyone on that line is still settling in — try later

    // ...and now pick the node properly, from where that villager actually is.
    const node = bestNodeFor(world, playerId, want.k, pick.x, pick.y, sources, loads) || target;
    commandUnits(world, [pick], { type: 'gather', target: node, gx: node.x, gy: node.y });
    loads.set(node, (loads.get(node) || 0) + 1);
    assigned[from]--;
    assigned[want.k]++;
    workers[from].splice(workers[from].indexOf(pick), 1);
    workers[want.k].push(pick);
    st.cooldown.set(pick.id, world.time + RETASK_COOLDOWN);
    st.moves++;
    orders++;
    retasks++;
  }

  // Cooldowns for villagers that have died or been sheltered would otherwise
  // accumulate for the length of the match. Cheap to prune here, where the live
  // set is already in hand.
  if (st.cooldown.size > 64) {
    for (const [id, until] of st.cooldown) if (until <= world.time) st.cooldown.delete(id);
  }

  return orders;
}

/**
 * Tick every player's manager. Called once per fixed sim step from GameScene,
 * beside the other systems — it issues unit orders, so it has to run on the
 * simulation's beat and not on the HUD's.
 */
export function updateAllocation(world, dt) {
  const st = allocState(world);
  for (let i = 0; i < st.players.length; i++) {
    const p = st.players[i];
    if (!p.on) continue;
    p.timer += dt;
    if (p.timer < ALLOC_TICK) continue;
    p.timer = 0;
    allocationPass(world, i);
  }
}
