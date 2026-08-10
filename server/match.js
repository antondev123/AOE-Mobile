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
import { SIM_DT, mapSizeFor } from '../src/core/constants.js';
import { updateAllocation } from '../src/systems/allocation.js';
import { updateUnits } from '../src/systems/unitAI.js';
import { updateCombat } from '../src/systems/combat.js';
import { updateEconomy } from '../src/systems/economy.js';
import { createEnemyAI } from '../src/systems/enemyAI.js';
import { serializeGame } from '../src/core/save.js';
import { applyCommand } from '../src/core/command.js';
import { checksum } from '../src/core/checksum.js';
import { checkVictory } from '../src/core/victory.js';
import { EV } from '../src/core/events.js';

/** Ticks between a command arriving and taking effect. 4 ticks = 200ms at 20Hz. */
export const COMMAND_DELAY = 4;

/** How often the authoritative world is hashed for desync detection. */
export const CHECKSUM_EVERY = 20; // once a second

// The digest moved to src/core/checksum.js when the client started needing it:
// two implementations of "the same" hash is precisely the bug it exists to
// catch. Re-exported here because this is where callers already look for it.
export { checksum };

/**
 * @param {object} opts
 * @param {number} opts.seed
 * @param {Array<{kind: 'human'|'ai'|'open'|'closed', team?: number}>} opts.seats
 *   Index is the playerId. The roster decides how many players there are.
 * @param {number} [opts.width]   map size; derived from the roster when absent
 * @param {number} [opts.height]
 */
export function createMatch({ seed = 1, seats = null, width = 0, height = 0 } = {}) {
  // Default: the classic single-player shape, so this file can host the existing
  // game unchanged as well as a 1v1.
  //
  // THE ROSTER COMES FIRST NOW. It used to be checked against a world that had
  // already been built, because the world was always two players on a 96x96
  // map and the check could only ever fail. The roster is the input: it says how
  // many seats there are, which says how big the map is.
  const roster = seats || [{ kind: 'human' }, { kind: 'ai' }];
  const side = width && height ? 0 : mapSizeFor(roster.length);

  const world = createWorld(seed, {
    playerCount: roster.length,
    width: width || side,
    height: height || side,
    teams: roster.map((s, i) => (s && s.team !== undefined && s.team !== null ? s.team : i)),
  });
  generateMap(world);
  for (const p of world.players) recomputePop(world, p.id);

  // A closed slot is a seat nobody will ever sit in: it is defeated from tick
  // zero and owns nothing, which keeps slot index equal to player id everywhere
  // without leaving a live player standing on a base they cannot command. See
  // the note on compaction in server/room.js.
  for (let i = 0; i < roster.length; i++) {
    if (roster[i] && roster[i].kind === 'closed') world.players[i].defeated = true;
  }

  world.vision.update();

  // Listeners for the schedule, so a transport can tell clients about a command
  // *when it is stamped* rather than when it fires. That lead time is the only
  // reason the delay exists: a client told at the moment of execution has
  // already run the tick it was supposed to execute on.
  const scheduleListeners = new Set();

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
    for (const fn of scheduleListeners) fn({ at, cmd });
    return at;
  }

  /** Be told the moment a command is stamped, and for which tick. */
  function onSchedule(fn) {
    scheduleListeners.add(fn);
    return () => scheduleListeners.delete(fn);
  }

  /** Restore every AI seat's memory, after a rebuild from a snapshot. */
  function restoreAis(blobs) {
    if (!Array.isArray(blobs)) return;
    for (let i = 0; i < ais.length; i++) {
      if (blobs[i] && ais[i] && typeof ais[i].restore === 'function') ais[i].restore(blobs[i]);
    }
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

    // The tick these commands run *on*, which is not the tick step() reports
    // when it returns — that one has already been incremented. Clients schedule
    // against this number, so it is the one worth naming.
    const at = world.tick;
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
    // Only seats explicitly marked 'ai' are stepped, in seat order, and clients
    // step exactly the same list at exactly this point (see GameScene.simStep).
    //
    // This used to refuse to run AI in a networked room at all, because
    // snapshot() carried one AI blob for a match that has one per seat — so a
    // client rebuilding from a resync inherited the world without the brains
    // about to act on it, and drifted within seconds. The snapshot carries all
    // of them now.
    //
    // An 'open' seat still runs nothing. A chair nobody is sitting in should
    // stand still, not play itself.
    for (let i = 0; i < roster.length; i++) {
      if (roster[i].kind === 'ai') ais[i].update(SIM_DT);
    }
    world.vision.update();

    world.time += SIM_DT;
    world.tick++;

    checkVictory(world);

    return { tick: world.tick, at, applied };
  }

  return {
    world,
    roster,
    get tick() { return world.tick; },
    get over() { return over; },
    submit,
    onSchedule,
    restoreAis,
    step,
    takeOver,
    checksum: () => checksum(world),
    /** Full state for a late joiner or a desynced client to rebuild from. */
    snapshot: () => ({
      seed,
      tick: world.tick,
      // Every AI seat's memory rides along. Without it a client rebuilding from
      // this would get the world and not the brains, which is exactly why AI
      // seats used to be refused in a networked room.
      state: serializeGame(world, {
        ais: ais.map((a, i) => (roster[i].kind === 'ai' ? a.serialize() : null)),
        roster: roster.map((s2, i) => ({ kind: s2.kind, team: world.players[i].team })),
      }),
      roster: roster.map((s, i) => ({ kind: s.kind, team: world.players[i].team })),
    }),
    /** Commands stamped for ticks at or after `fromTick`, for catch-up. */
    since: (fromTick) => history.filter((h) => h.at >= fromTick),
  };
}
