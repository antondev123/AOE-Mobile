// When the match is over, and who won.
//
// THERE WERE TWO COPIES OF THIS, AND THEY DISAGREED. GameScene.checkVictory()
// eliminated a player who owned nothing that trains units; server/match.js's
// copy eliminated one who owned no buildings and no villagers. Those are not the
// same rule and they do not fire on the same tick — which for a single-player
// skirmish is invisible, and for a networked match means the server ends a game
// the clients are still playing, or the reverse. One copy, called by both.
//
// THE RULE. You lose when you can no longer produce anything. The old rule was
// "no buildings and no villagers", which is the last possible moment rather than
// the decisive one, and it made winning worse than losing: a player who had
// razed the enemy's Town Center, Barracks and Castle still had to hunt the last
// enemy villager across a map that is 93% fog, and there is no tool in this game
// for finding one villager on nine thousand tiles. Meanwhile the loser sat in a
// game that was decided ten minutes ago with nothing to do but close the tab.
//
// A player who owns nothing that trains a unit cannot replace a villager, cannot
// replace a soldier and cannot rebuild — and a lone villager can lay a Town
// Center foundation, so a foundation counts. That is why this asks "does
// anything you own train units" rather than "is anything finished".
//
// TEAMS. The match ends when one *team* is left, not one player: a player whose
// town is gone while their ally is still fighting has lost, and their side has
// not. With everybody on their own team — the default roster — that is exactly
// the last-man-standing rule it replaces.

import { BUILDING_STATS } from './constants.js';
import { EV } from './events.js';
import { teamOf } from './teams.js';

// Grace period. Nobody is eliminated in the first few seconds, because for the
// first instant of a match nobody owns anything at all.
const GRACE_SECONDS = 3;

/** Can this player still produce? Written as a scan: it runs every sim step. */
function canRecover(world, p) {
  for (const id of p.owned) {
    const e = world.entities.get(id);
    if (!e || e.dead || e.kind !== 'building') continue;
    const s = BUILDING_STATS[e.type];
    if (s && s.trains && s.trains.length) return true;
  }
  return false;
}

/**
 * Mark the beaten, decide the winner, and end the match if it is over.
 *
 * Sets `world.over` / `world.winner` and emits EV.GAME_OVER exactly once.
 * `world.winner` stays a player id, because everything downstream — the end
 * card, the audio, the save — already speaks in seats; `winnerTeam` rides along
 * in the event for anything that needs to ask about sides.
 */
export function checkVictory(world) {
  if (world.over) return;

  for (const p of world.players) {
    if (p.defeated) continue;
    if (!canRecover(world, p) && world.time > GRACE_SECONDS) p.defeated = true;
  }

  // Count teams, not players. `first` is a survivor of the winning side and is
  // what `world.winner` reports; in a free-for-all it is the only one left.
  const teams = new Set();
  let first = null;
  for (const p of world.players) {
    if (p.defeated) continue;
    const t = teamOf(world, p.id);
    if (!teams.has(t)) {
      teams.add(t);
      if (first === null) first = p;
    }
  }

  // Nobody left. Two players whose last Town Center fell on the same step used
  // to leave the match running forever with every seat defeated — rare, and a
  // game that never ends is the worst way to find out about it. A draw is
  // reported as a win for nobody.
  if (teams.size === 0) {
    world.over = true;
    world.winner = null;
    world.events.emit(EV.GAME_OVER, { winner: null, winnerTeam: null });
    return;
  }

  if (teams.size === 1) {
    world.over = true;
    world.winner = first.id;
    world.events.emit(EV.GAME_OVER, { winner: first.id, winnerTeam: teamOf(world, first.id) });
  }
}
