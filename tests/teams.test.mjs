// Teams: the claims that only mean anything past two players.
//
// Every one of these was trivially true in a 1v1 and is trivially true in a
// free-for-all, which is why none of them had a test: "different player" and
// "enemy" were the same sentence. They stop being the same sentence the moment
// two seats are on one side, and each of the checks below is a place the old
// wording would have done something wrong and quiet — a militia shooting your
// ally's villager, a gate slamming in their face, a match that never ends.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, spawnUnit, spawnBuilding, isHostile } from '../src/core/world.js';
import {
  teamOf, sameTeam, areAllies, relationTo, foesOf, alliesOf, livingTeams,
} from '../src/core/teams.js';
import { checkVictory } from '../src/core/victory.js';
import { canAttack } from '../src/systems/combat.js';
import { applyCommand } from '../src/core/command.js';
import { tributeArrives } from '../src/systems/market.js';
import { isWalkable } from '../src/systems/pathfinding.js';
import { setGateOpen } from '../src/core/world.js';
import { mapSizeFor, MAX_PLAYERS, DEFAULT_MAP_W } from '../src/core/constants.js';
import { generateMap, baseSites } from '../src/core/mapgen.js';

/** A 2v2 on a small blank map: seats 0,1 on team 1 and seats 2,3 on team 2. */
function twoVtwo() {
  return createWorld(99, { playerCount: 4, teams: [1, 1, 2, 2] });
}

// --- The model ---------------------------------------------------------------

test('a player with no team stated is on a team of their own', () => {
  const w = createWorld(1, { playerCount: 4 });
  assert.deepEqual(w.players.map((p) => teamOf(w, p.id)), [0, 1, 2, 3]);
  // Which is a free-for-all: everybody is hostile to everybody.
  assert.equal(foesOf(w, 0).length, 3);
  assert.equal(alliesOf(w, 0).length, 0);
  assert.equal(livingTeams(w).size, 4);
});

test('teams partition the roster', () => {
  const w = twoVtwo();
  assert.ok(sameTeam(w, 0, 1));
  assert.ok(!sameTeam(w, 1, 2));
  assert.deepEqual(foesOf(w, 0), [2, 3]);
  assert.deepEqual(alliesOf(w, 0), [1]);
  // A seat is on its own side, but is not its own ally.
  assert.ok(sameTeam(w, 0, 0));
  const mine = spawnUnit(w, 'militia', 0, 5, 5);
  assert.ok(!areAllies(w, mine, mine));
});

test('a defeated player is neither a foe nor an ally', () => {
  const w = twoVtwo();
  w.players[1].defeated = true;
  w.players[2].defeated = true;
  assert.deepEqual(alliesOf(w, 0), []);
  assert.deepEqual(foesOf(w, 0), [3]);
});

test('neutral things belong to nobody and are hostile to nobody', () => {
  const w = twoVtwo();
  const mine = spawnUnit(w, 'militia', 0, 5, 5);
  const tree = { kind: 'resource', player: null, x: 6, y: 5 };
  assert.ok(!isHostile(w, mine, tree));
  assert.ok(!areAllies(w, mine, tree));
  assert.equal(relationTo(w, 0, tree), 'neutral');
});

test('relationTo names all four cases', () => {
  const w = twoVtwo();
  const mine = spawnUnit(w, 'militia', 0, 5, 5);
  const ally = spawnUnit(w, 'militia', 1, 6, 5);
  const foe = spawnUnit(w, 'militia', 2, 7, 5);
  assert.equal(relationTo(w, 0, mine), 'own');
  assert.equal(relationTo(w, 0, ally), 'ally');
  assert.equal(relationTo(w, 0, foe), 'foe');
  assert.equal(relationTo(w, 0, { player: null }), 'neutral');
});

// --- No friendly fire --------------------------------------------------------

test('allies cannot be attacked, and the other team still can', () => {
  const w = twoVtwo();
  const mine = spawnUnit(w, 'militia', 0, 5, 5);
  const ally = spawnUnit(w, 'villager', 1, 5.5, 5);
  const foe = spawnUnit(w, 'villager', 2, 6, 5);

  assert.ok(!canAttack(w, mine, ally), 'no friendly fire');
  assert.ok(!canAttack(w, ally, mine), 'and none the other way');
  assert.ok(canAttack(w, mine, foe), 'the other team is a target');

  const allyTc = spawnBuilding(w, 'towncenter', 1, 20, 20);
  const foeTc = spawnBuilding(w, 'towncenter', 2, 30, 30);
  assert.ok(!canAttack(w, mine, allyTc), "nor an ally's buildings");
  assert.ok(canAttack(w, mine, foeTc), "but an enemy's are fair game");
});

// --- Gates -------------------------------------------------------------------

test("a shut gate opens for its owner and their ally, and for nobody else", () => {
  const w = twoVtwo();
  const gate = spawnBuilding(w, 'palisadegate', 0, 10, 10);
  setGateOpen(w, gate, false);
  const tx = Math.floor(gate.x);
  const ty = Math.floor(gate.y);

  assert.ok(isWalkable(w, tx, ty, 0), 'its owner walks through');
  assert.ok(isWalkable(w, tx, ty, 1), 'so does their ally');
  assert.ok(!isWalkable(w, tx, ty, 2), 'the other team does not');
  assert.ok(!isWalkable(w, tx, ty, 3), 'nor their ally');
  // A caller that does not say who is asking gets the safe answer: a wall.
  assert.ok(!isWalkable(w, tx, ty), 'anonymous callers see a wall');
});

// --- Victory -----------------------------------------------------------------

test('the match ends when one TEAM is left, not one player', () => {
  const w = twoVtwo();
  w.time = 100; // past the grace window
  for (const p of w.players) spawnBuilding(w, 'towncenter', p.id, 10 + p.id * 8, 10);

  checkVictory(w);
  assert.equal(w.over, false, 'two teams standing, nothing decided');

  // Knock out one of team 2. Their ally carries on and the match continues —
  // under the old last-player-standing rule this was still a live three-way.
  w.players[2].defeated = true;
  checkVictory(w);
  assert.equal(w.over, false, 'one of a pair down is not a decision');

  w.players[3].defeated = true;
  checkVictory(w);
  assert.equal(w.over, true);
  assert.ok([0, 1].includes(w.winner), 'a survivor of the winning side');
});

test('a player whose side wins after they are gone has still won', () => {
  const w = twoVtwo();
  w.time = 100;
  for (const p of w.players) spawnBuilding(w, 'towncenter', p.id, 10 + p.id * 8, 10);
  w.players[0].defeated = true;
  w.players[2].defeated = true;
  w.players[3].defeated = true;
  checkVictory(w);
  assert.equal(w.winner, 1);
  assert.ok(sameTeam(w, w.winner, 0), 'seat 0 is on the winning side');
});

test('a mutual elimination ends the match rather than hanging forever', () => {
  const w = twoVtwo();
  w.time = 100;
  // Nobody owns anything that trains, so every seat falls on the same pass.
  checkVictory(w);
  assert.equal(w.over, true, 'the match must end');
  assert.equal(w.winner, null, 'and it is a draw');
});

// --- Shared vision -----------------------------------------------------------

test("a team's mask is the union of its members', and a loner's is their own", () => {
  const w = twoVtwo();
  // Far apart, so neither disc could possibly cover the other's ground.
  const a = spawnUnit(w, 'scout', 0, 12, 12);
  const b = spawnUnit(w, 'scout', 1, 60, 60);
  const enemy = spawnUnit(w, 'scout', 2, 12, 60);
  w.vision.update();

  const mineOnly = w.vision.state(0);
  const ours = w.vision.viewState(0);
  const i = (x, y) => Math.floor(y) * w.width + Math.floor(x);

  assert.equal(mineOnly.visible[i(a.x, a.y)], 1, 'I see my own scout');
  assert.equal(mineOnly.visible[i(b.x, b.y)], 0, "and not my ally's, alone");
  assert.equal(ours.visible[i(a.x, a.y)], 1, 'the team sees mine');
  assert.equal(ours.visible[i(b.x, b.y)], 1, "and the team sees my ally's");
  assert.equal(ours.visible[i(enemy.x, enemy.y)], 0, 'but not the enemy scout');

  // A seat with no allies gets its own state back, untouched and uncopied.
  const solo = createWorld(3, { playerCount: 2 });
  spawnUnit(solo, 'scout', 0, 10, 10);
  solo.vision.update();
  assert.equal(solo.vision.viewState(0), solo.vision.state(0));
});

test('shared vision keeps up as an ally moves', () => {
  const w = twoVtwo();
  spawnUnit(w, 'scout', 0, 12, 12);
  const ally = spawnUnit(w, 'scout', 1, 60, 60);
  w.vision.update();
  const ours = w.vision.viewState(0);
  const i = (x, y) => Math.floor(y) * w.width + Math.floor(x);
  assert.equal(ours.visible[i(60, 60)], 1);

  // The composite is captured once by its readers, so it has to be refreshed
  // by update() rather than only on a fresh call — this is that check.
  ally.x = 30;
  ally.y = 30;
  w.vision.update();
  assert.equal(ours.visible[i(30, 30)], 1, 'the new ground is lit');
  assert.equal(ours.visible[i(60, 60)], 0, 'and the old ground went dark');
  assert.equal(ours.explored[i(60, 60)], 1, 'but stays explored');
});

// --- Tribute -----------------------------------------------------------------

test('a gift reaches an ally, minus the tithe', () => {
  const w = twoVtwo();
  const before = w.players[1].resources.food;
  assert.equal(applyCommand(w, { t: 'tribute', p: 0, to: 1, resource: 'food', amount: 100 }).ok, true);
  assert.equal(w.players[0].resources.food, 150, 'the giver pays the full amount');
  assert.equal(w.players[1].resources.food, before + tributeArrives(100),
    'and the ally receives what survives the tithe');
  assert.ok(tributeArrives(100) < 100, 'a gift must cost something');
});

test('you cannot fund an enemy, or yourself, or the dead', () => {
  const w = twoVtwo();
  assert.equal(applyCommand(w, { t: 'tribute', p: 0, to: 2, resource: 'food', amount: 100 }).reason,
    'not-an-ally', 'the other side is not a recipient');
  assert.equal(applyCommand(w, { t: 'tribute', p: 0, to: 0, resource: 'food', amount: 100 }).reason,
    'not-an-ally', 'nor are you');
  assert.equal(applyCommand(w, { t: 'tribute', p: 0, to: 9, resource: 'food', amount: 100 }).reason,
    'no-such-player');
  w.players[1].defeated = true;
  assert.equal(applyCommand(w, { t: 'tribute', p: 0, to: 1, resource: 'food', amount: 100 }).reason,
    'defeated');
});

test('a gift you cannot afford is refused outright, not part-paid', () => {
  const w = twoVtwo();
  const had = w.players[0].resources.stone;
  const res = applyCommand(w, { t: 'tribute', p: 0, to: 1, resource: 'stone', amount: had + 1 });
  assert.equal(res.ok, false);
  assert.equal(w.players[0].resources.stone, had, 'nothing left the giver');
  // And nonsense amounts do nothing at all.
  assert.equal(applyCommand(w, { t: 'tribute', p: 0, to: 1, resource: 'food', amount: -50 }).ok, false);
  assert.equal(applyCommand(w, { t: 'tribute', p: 0, to: 1, resource: 'nonsense', amount: 50 }).ok, false);
});

// --- The map -----------------------------------------------------------------

test('every roster from 2 to 8 gets a fair, in-bounds map', () => {
  for (let n = 2; n <= MAX_PLAYERS; n++) {
    const side = mapSizeFor(n);
    const w = createWorld(20260810 + n, { playerCount: n, width: side, height: side });
    generateMap(w);
    const sites = baseSites(w, n);

    assert.equal(sites.length, n, `${n}p: one base per player`);

    for (const s of sites) {
      assert.ok(s.x > 2 && s.y > 2 && s.x < side - 2 && s.y < side - 2,
        `${n}p: base ${s.player} at ${s.x},${s.y} is off a ${side} map`);
    }

    // Nobody starts on top of anybody.
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        const d = Math.hypot(sites[i].x - sites[j].x, sites[i].y - sites[j].y);
        assert.ok(d > 30, `${n}p: bases ${i} and ${j} are only ${d.toFixed(1)} apart`);
      }
    }

    // Every player opens with the same things to do: a town centre, three
    // villagers, and food and wood within reach of them.
    for (let p = 0; p < n; p++) {
      const tcs = w.buildings.filter((b) => b.player === p && b.type === 'towncenter');
      assert.equal(tcs.length, 1, `${n}p: player ${p} has a town centre`);
      const vills = w.units.filter((u) => u.player === p && u.type === 'villager');
      assert.equal(vills.length, 3, `${n}p: player ${p} has three villagers`);

      const near = (type, r) => w.resources.some((e) => e.type === type && !e.dead
        && Math.hypot(e.x - tcs[0].x, e.y - tcs[0].y) < r);
      assert.ok(near('berry', 14), `${n}p: player ${p} has berries to open on`);
      assert.ok(near('tree', 18), `${n}p: player ${p} has a woodline`);
      assert.ok(near('gold', 20), `${n}p: player ${p} has a starting gold vein`);
    }
  }
});

test('the two-player map is exactly the one that was tuned', () => {
  // The whole ring layout has to reproduce the corners it replaced, or every
  // number in mapgen's comments — the 85-tile walk, the minute of marching —
  // silently stops describing the game.
  const w = createWorld(5, { playerCount: 2 });
  const sites = baseSites(w, 2);
  assert.equal(Math.round(sites[0].x), 18);
  assert.equal(Math.round(sites[0].y), 18);
  assert.equal(Math.round(sites[1].x), DEFAULT_MAP_W - 18);
  assert.equal(Math.round(sites[1].y), DEFAULT_MAP_W - 18);
  // And the second base faces exactly opposite the first, which is what the old
  // `dir = player === PLAYER ? 1 : -1` sign flip meant.
  assert.equal(sites[0].rot, 0);
  assert.equal(sites[1].rot, 32);
});
