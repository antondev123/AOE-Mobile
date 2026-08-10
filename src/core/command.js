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
  enqueueFoundation, cancelQueued, clearBuildQueue,
} from '../systems/economy.js';
import { queueResearch, cancelResearch } from '../systems/tech.js';
import { setAllocationOn, setSplit, resetSplit } from '../systems/allocation.js';
import { ungarrisonAll } from '../systems/combat.js';
import { buy as marketBuy, sell as marketSell } from '../systems/market.js';

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
      // This must be enqueueFoundation() and not buildQueue(): the latter only
      // *reads* the queue (and prunes it), so routing the UI through a command
      // that called it would place foundations nobody was ever dispatched to.
      if (cmd.enqueue !== false) enqueueFoundation(world, b);
      // Placing may also dispatch a crew, because the UI's "somebody start on
      // this" rule picks its builders from the local selection — knowledge the
      // server does not have. Carrying the ids in the command keeps that choice
      // client-side while keeping the *effect* on the authoritative path, which
      // is the only way both machines end up ordering the same villagers.
      if (Array.isArray(cmd.builders) && cmd.builders.length) {
        const crew = ownedUnits(world, p, cmd.builders);
        if (crew.length) {
          commandUnits(world, crew, { type: 'build', gx: b.x, gy: b.y, target: b });
        }
      }
      return ok({ id: b.id });
    }

    case 'placeWallLine': {
      // placeWallLine returns { placed: [...], refused: n, reason }, not an array.
      const res = placeWallLine(world, p, cmd.buildingType, cmd.tiles);
      const placed = res && Array.isArray(res.placed) ? res.placed : [];
      if (!placed.length) return no(res?.reason || 'refused');
      // Queued in the order the run was drawn, so a villager finishing one
      // segment walks to the next along the line rather than back to a tree.
      if (cmd.enqueue !== false) for (const b of placed) enqueueFoundation(world, b);
      const first = placed[0];
      if (Array.isArray(cmd.builders) && cmd.builders.length) {
        const crew = ownedUnits(world, p, cmd.builders);
        if (crew.length) {
          commandUnits(world, crew, { type: 'build', gx: first.x, gy: first.y, target: first });
        }
      }
      return {
        ok: true,
        detail: { placed: placed.length, refused: res.refused || 0, firstId: first.id },
      };
    }

    case 'cancelFoundation': {
      const b = owned(world, p, cmd.id, 'building');
      if (!b) return no('not-yours');
      // The underlying call can still refuse — a site that has already been
      // finished or destroyed this tick. The HUD's confirmation reads off this,
      // so a refusal has to come back as one rather than as a silent ok().
      if (!cancelFoundation(world, b)) return no('refused');
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
      if (!cancelTrain(world, b, cmd.index | 0)) return no('refused');
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
      if (!cancelResearch(world, b, cmd.index | 0)) return no('refused');
      return ok();
    }

    // ---- build queue -------------------------------------------------------
    case 'cancelQueued':
      if (!cancelQueued(world, p, cmd.index | 0)) return no('refused');
      return ok();

    case 'clearBuildQueue': {
      // Answers with how many sites it dropped, because the HUD says so out loud.
      const n = clearBuildQueue(world, p);
      return ok({ cleared: n });
    }

    // ---- gates -------------------------------------------------------------
    case 'gate': {
      const b = owned(world, p, cmd.id, 'building');
      if (!b) return no('not-yours');
      setGateOpen(world, b, !!cmd.open);
      return ok();
    }

    // ---- garrison ----------------------------------------------------------
    //
    // Turning a building out is a *building* verb, so it cannot ride on the
    // per-unit 'ungarrison' order in UNIT_ORDERS: the bodies inside are off the
    // map and out of every list the UI can address them by. The HUD's alarm
    // button turns out every shelter in the selection at once, so this takes a
    // list of ids and answers with how many came out — which is what the toast
    // says out loud.
    case 'ungarrisonAll': {
      const ids = Array.isArray(cmd.ids) ? cmd.ids : [cmd.id];
      let out = 0;
      for (const id of ids) {
        const b = owned(world, p, id, 'building');
        if (b) out += ungarrisonAll(world, b);
      }
      return ok({ out });
    }

    // ---- the market --------------------------------------------------------
    //
    // Trading was the last thing in the game that changed the world without
    // saying so: the HUD called market.buy() straight through, which on one
    // device is fine and on two is a desync inside one tap — the price is one
    // set of numbers for the whole map (see the note in systems/market.js), so a
    // trade that happened on one machine and not the other moves every future
    // trade apart as well as the two stockpiles.
    //
    // The lot size is not a parameter. TRADE_LOT is the unit of trade and a
    // command that could name its own amount would let a client buy in
    // fractional lots the price ladder was never designed for.
    case 'trade': {
      if (cmd.side !== 'buy' && cmd.side !== 'sell') return no('bad-side');
      const done = cmd.side === 'buy'
        ? marketBuy(world, p, cmd.resource)
        : marketSell(world, p, cmd.resource);
      return done ? ok({ side: cmd.side, resource: cmd.resource }) : no('refused');
    }

    // ---- villager allocation ----------------------------------------------
    case 'allocationOn':
      // Returns the state it settled on, which is what the toggle relabels from.
      return ok({ on: setAllocationOn(world, p, !!cmd.on) });

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
