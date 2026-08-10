// AI seats inside deterministic lockstep.
//
// server/match.js used to refuse to run AI in a networked room, and the comment
// explaining why was correct: snapshot() carried ONE ai blob for a match that
// has one AI per seat, so a client rebuilding from a resync inherited the world
// without the brains about to act on it and drifted within seconds.
//
// The whole point of this change is "any mix of human and AI", so that
// restriction had to go, and these are the three claims that let it. The third
// is the one that matters — two matches agreeing from tick zero only proves the
// AI is deterministic, which it already was. Rebuilding one from a mid-match
// snapshot and having it *converge* is what proves the refusal is lifted rather
// than merely ignored.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMatch } from '../server/match.js';
import { restoreGame } from '../src/core/save.js';
import { checksum } from '../src/core/checksum.js';
import { createEnemyAI } from '../src/systems/enemyAI.js';
import { updateAllocation } from '../src/systems/allocation.js';
import { updateUnits } from '../src/systems/unitAI.js';
import { updateCombat } from '../src/systems/combat.js';
import { updateEconomy } from '../src/systems/economy.js';
import { reindex } from '../src/core/world.js';
import { checkVictory } from '../src/core/victory.js';
import { SIM_DT } from '../src/core/constants.js';

const SEED = 20260810;

/** Four seats: one human who never acts, three AIs who very much do. */
const ROSTER = [
  { kind: 'human', team: 1 },
  { kind: 'ai', team: 2 },
  { kind: 'ai', team: 3 },
  { kind: 'ai', team: 4 },
];

test('two matches with three AI seats stay identical for 2000 ticks', () => {
  const a = createMatch({ seed: SEED, seats: ROSTER });
  const b = createMatch({ seed: SEED, seats: ROSTER });

  assert.equal(a.world.players.length, 4);
  assert.equal(a.checksum(), b.checksum(), 'worlds differ before a single step');

  for (let i = 0; i < 2000; i++) {
    a.step();
    b.step();
    if (i % 100 === 0) assert.equal(a.checksum(), b.checksum(), `desync at tick ${a.tick}`);
  }
  assert.equal(a.checksum(), b.checksum(), 'final checksums differ');

  // And the AIs actually did something, or the above proves only that two
  // empty maps stay empty.
  const built = a.world.buildings.filter((x) => x.player !== 0).length;
  assert.ok(built > 4, `AI seats should have built something, saw ${built}`);
});

test("each AI's random stream is its own, so adding a seat does not move the others", () => {
  // Same seed, same seat 1, different roster size. Seat 1's decisions must not
  // depend on how many other brains are in the room — which is exactly what
  // drawing from the shared world.rng made them do.
  const two = createMatch({ seed: SEED, seats: [{ kind: 'human' }, { kind: 'ai' }] });
  const four = createMatch({ seed: SEED, seats: ROSTER });

  // The match keeps its AIs to itself, so build one per world by hand off the
  // same seat and compare where their generators start. `_ai` is the instance
  // behind createEnemyAI's wrapper.
  const one = createEnemyAI(two.world, 1)._ai;
  const other = createEnemyAI(four.world, 1)._ai;
  assert.ok(one.rng && other.rng, 'each AI carries its own generator');
  assert.equal(one.rng.getState(), other.rng.getState(),
    'seat 1 seeds identically whatever else is in the roster');

  // And two different seats must NOT share a stream, or seven AIs would make
  // the same "random" choice at the same moment.
  const seatTwo = createEnemyAI(four.world, 2)._ai;
  assert.notEqual(one.rng.getState(), seatTwo.rng.getState(),
    'different seats draw from different streams');
});

test('a client rebuilt from a mid-match snapshot converges with the server', () => {
  const server = createMatch({ seed: SEED, seats: ROSTER });

  // Play a while, so the AIs have real memory — jobs, build cursors, a wave
  // clock. This is precisely the state that used to be lost.
  for (let i = 0; i < 1200; i++) server.step();
  const at = server.tick;
  const snap = server.snapshot();

  // Rebuild the way a client does: the world out of the payload, then one AI
  // per 'ai' seat restored from the blobs that rode along with it.
  const restored = restoreGame(snap.state);
  const client = restored.world;
  assert.equal(client.tick, at, 'the snapshot names the tick it was taken at');
  assert.equal(checksum(client), checksum(server.world), 'the rebuild starts in step');

  const ais = [];
  for (let i = 0; i < snap.roster.length; i++) {
    if (snap.roster[i].kind !== 'ai') continue;
    ais[i] = createEnemyAI(client, i);
    assert.ok(restored.ais[i], `seat ${i}'s brain rode along in the snapshot`);
    ais[i].restore(restored.ais[i]);
  }

  // Step both on for a good while. Nothing is sent between them: if the client's
  // AIs are thinking the same thoughts, the two worlds stay identical, and if
  // any part of that memory was missing they will part company within seconds.
  const stepClient = () => {
    for (const u of client.units) { u.px = u.x; u.py = u.y; }
    reindex(client);
    updateAllocation(client, SIM_DT);
    updateUnits(client, SIM_DT);
    updateCombat(client, SIM_DT);
    updateEconomy(client, SIM_DT);
    for (let i = 0; i < ais.length; i++) if (ais[i]) ais[i].update(SIM_DT);
    client.vision.update();
    client.time += SIM_DT;
    client.tick++;
    checkVictory(client);
  };

  for (let i = 0; i < 800; i++) {
    server.step();
    stepClient();
    if (i % 50 === 0) {
      assert.equal(checksum(client), checksum(server.world),
        `diverged ${i} ticks after the rebuild (tick ${client.tick})`);
    }
  }
  assert.equal(checksum(client), checksum(server.world), 'diverged by the end');
});
