// An authoritative match, with no transport attached.
//
// This is the simulation half of multiplayer and it deliberately knows nothing
// about sockets, so it can be driven at full speed by a test (see
// tests/multiplayer.test.mjs) rather than only in real time by a server.
//
// WHAT THE SERVER IS AUTHORITATIVE OVER
// -------------------------------------
// Not the world state, as it happens — over the *schedule*. Clients run their
// own copy of the same deterministic simulation, and the server's job is to
// decide which commands happen on which tick and tell everyone the same answer.
// Shipping 96x96 tiles of world state at 20Hz to a phone would be absurd; a
// tick's worth of commands is usually zero bytes and never more than a few
// hundred.
//
// That works only because the simulation is deterministic, which it already was
// before any of this existed: a fixed timestep in GameScene.simStep(), every
// random draw through world.rng, and entity ids that replay identically. See
// src/core/rng.js and src/core/save.js for why those three properties hold.
//
// THE COMMAND DELAY
// -----------------
// A command cannot take effect on the tick it arrives, because the other player
// has not heard about it yet. So the server stamps each one for a tick a short
// way in the future — far enough that the message beats it there, close enough
// that the game still feels responsive. Every machine then applies it on the
// same tick and the worlds stay identical. This is the oldest trick in RTS
// netcode and it is still the right one.
//
// WHERE IT CAN STILL GO WRONG
// ---------------------------
// Two browsers may disagree in the last bit of Math.sin/cos/atan2/pow, which
// the simulation uses in about twenty-seven places. That is legal per spec and
// unfixable from here. So the server hashes its world periodically and ships
// the digest; a client that disagrees asks for a snapshot and rebuilds from it,
// which src/core/save.js already knows how to produce. Divergence becomes a
// hiccup rather than two players in silently different games.

import { createWorld, recomputePop, reindex } from '../src/core/world.js';
import { generateMap } from '../src/core/mapgen.js';
import { SIM_DT, PLAYER, ENEMY } from '../src/core/constants.js';
import { updateAllocation } from '../src/systems/allocation.js';
import { updateUnits } from '../src/systems/unitAI.js';
import { updateCombat } from '../src/systems/combat.js';
import { updateEconomy } from '../src/systems/economy.js';
import { createEnemyAI } from '../src/systems/enemyAI.js';
import { serializeGame } from '../src/core/save.js';
import { applyCommand } from '../src/core/command.js';
import { EV } from '../src/core/events.js';

/** Ticks between a command arriving and taking effect. 4 ticks = 200ms at 20Hz. */
export const COMMAND_DELAY = 4;

/** How often the authoritative world is hashed for desync detection. */
export const CHECKSUM_EVERY = 20; // once a second

/**
 * A cheap order-sensitive digest of everything the simulation owns.
 *
 * Positions are quantised to 1/1024 of a tile rather than hashed as raw floats.
 * A last-bit disagreement between two JS engines is not yet a divergence — it
 * either washes out or it grows, and only the growing kind matters. Quantising
 * ignores the noise and still catches drift long before a player could see it.
 */
export function checksum(world) {
  let h = 0x811c9dc5; // FNV-1a offset basis
  const mix = (n) => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  const q = (f) => Math.round(f * 1024);

  mix(world.tick);
  mix(world.rng.getState());
  mix(world.nextId);
  for (const p of world.players) {
    mix(p.id);
    mix(p.defeated ? 1 : 0);
    for (const k of ['food', 'wood', 'gold', 'stone']) mix(q(p.resources?.[k] ?? 0));
  }
  for (const u of world.units) {
    mix(u.id); mix(q(u.x)); mix(q(u.y)); mix(q(u.hp)); mix(u.player);
  }
  for (const b of world.buildings) {
    mix(b.id); mix(q(b.hp)); mix(b.player); mix(b.complete ? 1 : 0);
  }
  return h >>> 0;
}

/**
 * @param {object} opts
 * @param {number} opts.seed
 * @param {Array<{kind: 'human'|'ai', clientId?: string}>} opts.seats
 *   Index is the playerId. Exactly world.players.length entries.
 */
export function createMatch({ seed = 1, seats = null } = {}) {
  const world = createWorld(seed);
  generateMap(world);
  recomputePop(world, PLAYER);
  recomputePop(world, ENEMY);
  world.vision.update();

  // Default: the classic single-player shape, so this file can host the
  // existing game unchanged as well as a 1v1.
  const roster = seats || [{ kind: 'human' }, { kind: 'ai' }];
  if (roster.length !== world.players.length) {
    throw new Error(`need ${world.players.length} seats, got ${roster.length}`);
  }

  // An AI is built for every seat, but only stepped for seats no human holds.
  // Keeping the object around for human seats is what lets a player drop out
  // and have their economy carry on rather than freeze — see takeOver().
  const ais = roster.map((s, i) => createEnemyAI(world, i));

  // Commands waiting for their tick, keyed by the tick they fire on.
  const scheduled = new Map();
  // Everything that has been scheduled, so a late joiner can be caught up.
  const history = [];
  let over = null;

  world.events.on(EV.GAME_OVER, ({ winner }) => { over = { winner }; });

  /** Stamp a command for a future tick and return the tick it will fire on. */
  function submit(cmd, { delay = COMMAND_DELAY } = {}) {
    const at = world.tick + Math.max(1, delay);
    if (!scheduled.has(at)) scheduled.set(at, []);
    scheduled.get(at).push(cmd);
    history.push({ at, cmd });
    return at;
  }

  /** Hand a seat to its AI (disconnect) or back to a human (reconnect). */
  function takeOver(playerId, kind) {
    if (!roster[playerId]) return false;
    roster[playerId].kind = kind;
    return true;
  }

  /**
   * One fixed logic step.
   *
   * The order below is not arbitrary and must not be tidied: it mirrors
   * GameScene.simStep() exactly, including allocation running before movement
   * and vision running last. A server that stepped these in a different order
   * would be deterministic and still disagree with every client.
   */
  function step() {
    if (world.over) return null;

    const due = scheduled.get(world.tick);
    const applied = [];
    if (due) {
      for (const cmd of due) applied.push({ cmd, res: applyCommand(world, cmd) });
      scheduled.delete(world.tick);
    }

    for (const u of world.units) { u.px = u.x; u.py = u.y; }

    reindex(world);

    updateAllocation(world, SIM_DT);
    updateUnits(world, SIM_DT);
    updateCombat(world, SIM_DT);
    updateEconomy(world, SIM_DT);
    for (let i = 0; i < roster.length; i++) {
      if (roster[i].kind === 'ai') ais[i].update(SIM_DT);
    }
    world.vision.update();

    world.time += SIM_DT;
    world.tick++;

    checkVictory();

    return { tick: world.tick, applied };
  }

  // Ported from GameScene.checkVictory() so a headless match ends the same way
  // a played one does.
  function checkVictory() {
    if (world.over) return;
    for (const p of world.players) {
      if (p.defeated) continue;
      let canRecover = false;
      for (const id of p.owned) {
        const e = world.entities.get(id);
        if (!e || e.dead) continue;
        if (e.kind === 'building' || (e.kind === 'unit' && e.type === 'villager')) {
          canRecover = true;
          break;
        }
      }
      if (!canRecover && world.time > 3) p.defeated = true;
    }
    let alive = null;
    let aliveCount = 0;
    for (const p of world.players) {
      if (p.defeated) continue;
      aliveCount++;
      alive = p;
    }
    if (aliveCount === 1) {
      world.over = true;
      world.winner = alive.id;
      world.events.emit(EV.GAME_OVER, { winner: alive.id });
    }
  }

  return {
    world,
    roster,
    get tick() { return world.tick; },
    get over() { return over; },
    submit,
    step,
    takeOver,
    checksum: () => checksum(world),
    /** Full state for a late joiner or a desynced client to rebuild from. */
    snapshot: () => ({
      seed,
      tick: world.tick,
      state: serializeGame(world, { ai: null }),
      roster: roster.map((s) => ({ kind: s.kind })),
    }),
    /** Commands stamped for ticks at or after `fromTick`, for catch-up. */
    since: (fromTick) => history.filter((h) => h.at >= fromTick),
  };
}
