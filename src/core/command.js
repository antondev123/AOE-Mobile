// The one place a player action is allowed to change the world.
//
// WHY THIS EXISTS
// ---------------
// Until now the UI reached into the simulation directly: hud.js called
// removeEntity() to demolish, input.js called placeFoundation() to build, and
// so on across some seventy call sites. That is fine for one player on one
// device, and impossible for two on separate ones — a mutation performed
// locally has no name, so it cannot be sent anywhere, replayed, or refused.
//
// A command is that mutation given a name and a shape: a plain object, safe to
// JSON round-trip, carrying who asked and what they asked for. The UI stops
// mutating and starts *asking*; the server applies. Same function on both ends.
//
// TWO RULES MAKE IT AUTHORITATIVE
// -------------------------------
//   1. Every command names its actor in `p`, and the entities it touches are
//      filtered to those `p` actually owns. A client that asks to move someone
//      else's army gets an empty list, not an error — the check is not a
//      courtesy to honest clients, it is the whole of the trust model.
//   2. Commands are applied *between* simulation steps, never during one. The
//      server drains the queue at the top of a tick, so an order either landed
//      before tick N or lands before tick N+1, and both machines agree which.
//
// Entities are addressed by numeric id, never by reference, because the object
// on the server is not the object on the phone. commandUnits() already accepted
// ids (see normalizeUnits in systems/unitAI.js), which is most of why this
// layer stayed small.

import { removeEntity, setGateOpen } from './world.js';
import { commandUnits } from '../systems/unitAI.js';
import {
  placeFoundation, placeWallLine, cancelFoundation, queueTrain, cancelTrain,
  buildQueue, cancelQueued, clearBuildQueue,
} from '../systems/economy.js';
import { queueResearch, cancelResearch } from '../systems/tech.js';
import { setAllocationOn, setSplit, resetSplit } from '../systems/allocation.js';

/** Orders that unitAI.commandUnits() understands, as a set we can validate against. */
const UNIT_ORDERS = new Set([
  'stop', 'move', 'attackMove', 'patrol', 'gather', 'build',
  'attack', 'garrison', 'ungarrison', 'stance', 'formation',
]);

const ok = (detail = null) => ({ ok: true, detail });
const no = (reason) => ({ ok: false, reason });

/** A live entity of `kind` owned by `playerId`, or null. Ownership is the check. */
function owned(world, playerId, id, kind = null) {
  const e = world.entities.get(id);
  if (!e || e.dead) return null;
  if (e.player !== playerId) return null;
  if (kind && e.kind !== kind) return null;
  return e;
}

/** Live units owned by `playerId`, from a list of ids. Silently drops the rest. */
function ownedUnits(world, playerId, ids) {
  const out = [];
  if (!Array.isArray(ids)) return out;
  for (const id of ids) {
    const u = owned(world, playerId, id, 'unit');
    if (u) out.push(u);
  }
  return out;
}

// An order may name a target entity by id. Those ids are *not* ownership
// checked — you are allowed to attack what you do not own — but they are
// resolved here so the order handed to unitAI holds real references.
function resolveOrderTargets(world, order) {
  const o = { ...order };
  if (typeof o.target === 'number') o.target = world.entities.get(o.target) || null;
  if (typeof o.node === 'number') o.node = world.entities.get(o.node) || null;
  if (typeof o.building === 'number') o.building = world.entities.get(o.building) || null;
  return o;
}

/**
 * Apply one command to the world.
 *
 * @param {object} world
 * @param {object} cmd  { t: verb, p: playerId, ...payload }
 * @returns {{ok: boolean, reason?: string, detail?: any}}
 */
export function applyCommand(world, cmd) {
  if (!cmd || typeof cmd !== 'object') return no('malformed');
  const { t, p } = cmd;
  if (typeof t !== 'string') return no('malformed');
  if (!Number.isInteger(p) || p < 0 || p >= world.players.length) return no('no-such-player');
  // A defeated player may still have units on the field for a moment. They do
  // not get to order them about.
  if (world.over) return no('match-over');
  const player = world.players[p];
  if (player.defeated) return no('defeated');

  switch (t) {
    // ---- unit orders -------------------------------------------------------
    case 'order': {
      if (!cmd.order || !UNIT_ORDERS.has(cmd.order.type)) return no('bad-order');
      const units = ownedUnits(world, p, cmd.units);
      if (units.length === 0) return no('no-units');
      commandUnits(world, units, resolveOrderTargets(world, cmd.order));
      return ok({ units: units.length });
    }

    // ---- building placement ------------------------------------------------
    case 'place': {
      const b = placeFoundation(world, p, cmd.buildingType, cmd.gx, cmd.gy);
      if (!b) return no('refused');
      // Placing normally also enqueues the site for whoever is free to build it.
      if (cmd.enqueue !== false) buildQueue(world, p);
      return ok({ id: b.id });
    }

    case 'placeWallLine': {
      const res = placeWallLine(world, p, cmd.buildingType, cmd.tiles);
      if (!res || (Array.isArray(res) && res.length === 0)) return no('refused');
      return ok({ placed: Array.isArray(res) ? res.length : res });
    }

    case 'cancelFoundation': {
      const b = owned(world, p, cmd.id, 'building');
      if (!b) return no('not-yours');
      cancelFoundation(world, b);
      return ok();
    }

    case 'demolish': {
      const b = owned(world, p, cmd.id, 'building');
      if (!b) return no('not-yours');
      removeEntity(world, b);
      return ok();
    }

    // ---- production --------------------------------------------------------
    case 'train': {
      const b = owned(world, p, cmd.id, 'building');
      if (!b) return no('not-yours');
      const res = queueTrain(world, b, cmd.unitType);
      return res ? ok() : no('refused');
    }

    case 'cancelTrain': {
      const b = owned(world, p, cmd.id, 'building');
      if (!b) return no('not-yours');
      cancelTrain(world, b, cmd.index | 0);
      return ok();
    }

    case 'research': {
      const b = owned(world, p, cmd.id, 'building');
      if (!b) return no('not-yours');
      const res = queueResearch(world, b, cmd.techId);
      return res ? ok() : no('refused');
    }

    case 'cancelResearch': {
      const b = owned(world, p, cmd.id, 'building');
      if (!b) return no('not-yours');
      cancelResearch(world, b, cmd.index | 0);
      return ok();
    }

    // ---- build queue -------------------------------------------------------
    case 'cancelQueued':
      cancelQueued(world, p, cmd.index | 0);
      return ok();

    case 'clearBuildQueue':
      clearBuildQueue(world, p);
      return ok();

    // ---- gates -------------------------------------------------------------
    case 'gate': {
      const b = owned(world, p, cmd.id, 'building');
      if (!b) return no('not-yours');
      setGateOpen(world, b, !!cmd.open);
      return ok();
    }

    // ---- villager allocation ----------------------------------------------
    case 'allocationOn':
      setAllocationOn(world, p, !!cmd.on);
      return ok();

    case 'allocationSplit':
      setSplit(world, p, cmd.resource, cmd.pct | 0);
      return ok();

    case 'allocationReset':
      resetSplit(world, p);
      return ok();

    default:
      return no('unknown-command');
  }
}

/**
 * Apply a batch in order, returning per-command results.
 *
 * The server calls this once per tick with everything that arrived since the
 * last one. Order within a tick is the order the server received them, which is
 * arbitrary but *identical for every observer* — that is all determinism needs.
 */
export function applyCommands(world, cmds) {
  const out = [];
  for (const c of cmds) out.push(applyCommand(world, c));
  return out;
}
