// Which seat is sitting in front of this screen.
//
// The simulation is written from nobody's point of view: every system takes a
// playerId and means it. The *client* is not — the HUD shows one player's
// resources, the fog hides what one player cannot see, a tap selects one
// player's units, and until there was a second player none of that had to be
// said out loud. It was `PLAYER`, it was 0, and it was 0 in eighty-six places.
//
// This is that constant made answerable at runtime. It is a module-level `let`
// exported directly, which makes it a *live binding*: every module that did
//
//     import { PLAYER } from '../core/constants.js'
//
// now does
//
//     import { ME as PLAYER } from '../core/viewpoint.js'
//
// and reads the seat this client was given, with no other line changing. The
// alternative was rewriting all eighty-six call sites to thread a parameter
// that is, genuinely, global to the page: there is exactly one person holding
// this phone.
//
// It is deliberately NOT imported by anything under src/systems or src/core
// that the simulation runs. A rule that behaved differently depending on who
// was watching would desync two machines within a tick, which is the one bug
// this whole branch exists to prevent. If you find yourself reaching for this
// inside a system, you want the playerId that system was already handed.

/** The local player's seat. 0 until a match says otherwise. */
export let ME = 0;

/** The seat opposite, in a 1v1. Kept in step with ME. */
export let THEM = 1;

/**
 * Point the client at a seat. Called once, by GameScene, before the renderer
 * and the HUD are built — they read the binding as they construct.
 */
export function setViewpoint(seat, seatCount = 2) {
  ME = Number.isInteger(seat) && seat >= 0 ? seat : 0;
  THEM = (ME + 1) % Math.max(2, seatCount);
}
