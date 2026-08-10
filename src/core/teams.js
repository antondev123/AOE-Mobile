// Who is on whose side.
//
// Until eight seats existed there was no such question. Hostility was one
// expression, in core/world.js:
//
//     a.player !== b.player
//
// which is correct for a 1v1 and is the *only* thing a 1v1 can mean. With a
// roster it stops being true in a way that is invisible until you play a 2v2 and
// your ally's militia shoots your villager: every system that acquires a target,
// shuts a gate, raises an alarm or picks something to march at was asking "is
// this someone else's" and meaning "is this an enemy".
//
// So the question moves here and gets a name. Every player carries a `team`
// (see makePlayer in core/world.js); two players on the same team are allies,
// two on different teams are enemies, and a free-for-all is the case where every
// player is on a team of their own — which is what the default roster does, so a
// skirmish that never mentions teams behaves exactly as it always has.
//
// WHY THESE TAKE A WORLD. They could have taken two team numbers and stayed
// pure. Almost every caller has entities rather than numbers, though, and an
// entity's team lives one dereference away through its owner; putting that hop
// in one place is what stops it being written out at forty call sites, one of
// which will eventually get it wrong.
//
// NO VIEWPOINT HERE, EVER. This file is imported by the simulation, so it must
// answer identically on every machine. `ME` from core/viewpoint.js is a fact
// about which phone is being held and has no business in an answer the server
// and both clients have to agree on. Ask about the player who was handed in.

/** The team a seat plays for. Falls back to the seat itself: a free-for-all. */
export function teamOf(world, playerId) {
  if (playerId === null || playerId === undefined) return null;
  const p = world.players[playerId];
  if (!p) return null;
  return p.team === undefined || p.team === null ? playerId : p.team;
}

/**
 * Are these two seats on the same side?
 *
 * True for a seat and itself, which is what almost every caller wants — "may I
 * walk through this gate", "should I hold fire" — and is why the entity-level
 * helpers below, not this, are the ones that treat "mine" as a separate case.
 */
export function sameTeam(world, a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (a === b) return true;
  return teamOf(world, a) === teamOf(world, b);
}

/** The owner of an entity, or null for anything neutral (a tree, a bush). */
function ownerOf(e) {
  if (!e) return null;
  const p = e.player;
  return p === null || p === undefined ? null : p;
}

/**
 * May `a` attack `b`?
 *
 * Neutral things are hostile to nobody, which is what keeps a villager from
 * putting an arrow in a berry bush, and allies are hostile to nobody, which is
 * the whole point of this file. Note this is deliberately *not* the negation of
 * areAllies: a unit and itself is neither hostile nor an ally, and a tree is
 * neither either.
 */
export function isHostile(world, a, b) {
  const pa = ownerOf(a);
  const pb = ownerOf(b);
  if (pa === null || pb === null) return false;
  return !sameTeam(world, pa, pb);
}

/** Two entities on one side, owned by *different* seats. Yours is not an ally. */
export function areAllies(world, a, b) {
  const pa = ownerOf(a);
  const pb = ownerOf(b);
  if (pa === null || pb === null) return false;
  return pa !== pb && sameTeam(world, pa, pb);
}

/** Mine, an ally's, an enemy's, or nobody's — the four cases the UI cares about. */
export function relationTo(world, viewer, e) {
  const p = ownerOf(e);
  if (p === null) return 'neutral';
  if (p === viewer) return 'own';
  return sameTeam(world, viewer, p) ? 'ally' : 'foe';
}

/** Every seat hostile to `playerId` and still in the match. */
export function foesOf(world, playerId) {
  const out = [];
  for (const p of world.players) {
    if (p.id === playerId || p.defeated) continue;
    if (!sameTeam(world, playerId, p.id)) out.push(p.id);
  }
  return out;
}

/** Every other seat on `playerId`'s side, still in the match. */
export function alliesOf(world, playerId) {
  const out = [];
  for (const p of world.players) {
    if (p.id === playerId || p.defeated) continue;
    if (sameTeam(world, playerId, p.id)) out.push(p.id);
  }
  return out;
}

/** The distinct teams with at least one player left. Victory counts these. */
export function livingTeams(world) {
  const teams = new Set();
  for (const p of world.players) {
    if (!p.defeated) teams.add(teamOf(world, p.id));
  }
  return teams;
}
