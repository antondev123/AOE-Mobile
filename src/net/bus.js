// Where a player's intent goes.
//
// The UI never applies a command itself. It hands it to a bus, and the bus
// decides what "apply" means:
//
//   single player   apply it to the local world, right now, synchronously.
//                   Identical to the direct mutation this replaced — same
//                   function, same tick, same frame — which is the whole reason
//                   the skirmish does not change behaviour.
//
//   multiplayer     send it and wait. The server stamps it for a tick a little
//                   way ahead and tells everyone; it lands when that tick comes
//                   round, on both machines, in the same order.
//
// The two return the same shape so callers do not branch. What differs is that
// a networked dispatch cannot yet know whether the command will be accepted, so
// it answers `{ ok: true, pending: true }` — optimistic, because the alternative
// is a UI that goes dead for a fifth of a second after every tap. A command the
// server refuses simply never happens, and the HUD redraws from a world that
// did not change, which is the same correction it already makes when the
// economy refuses a purchase locally.
//
// The seat is *not* the bus's to choose in multiplayer. It stamps `p` for the
// local path, but the server overwrites it on arrival (see server.js) — a
// client that lies about its seat is lying to itself.

import { applyCommand } from '../core/command.js';

/**
 * The skirmish bus: apply straight to the world.
 * @param {object} world
 * @param {number} playerId
 */
export function createLocalBus(world, playerId) {
  return {
    playerId,
    multiplayer: false,
    dispatch(cmd) {
      return applyCommand(world, { ...cmd, p: playerId });
    },
  };
}

/**
 * The networked bus: hand the command to the transport and answer optimistically.
 * @param {{send: (cmd: object) => void}} net
 * @param {number} playerId  the seat the server assigned us
 */
export function createNetBus(net, playerId) {
  return {
    playerId,
    multiplayer: true,
    dispatch(cmd) {
      // A spectator has no seat, so it has no commands. Refusing here rather
      // than at the server keeps the HUD's optimistic toasts honest.
      if (playerId === null || playerId === undefined) return { ok: false, reason: 'spectator' };
      net.send({ ...cmd, p: playerId });
      return { ok: true, pending: true };
    },
  };
}
