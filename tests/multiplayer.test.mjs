// The claims multiplayer rests on, asserted rather than assumed.
//
// The interesting one is not "the server runs" — it is that two independently
// constructed worlds, fed the same commands on the same ticks, stay identical
// for thousands of ticks. That is the property that lets clients simulate
// locally instead of being shipped the world, and it is the only reason this
// design is affordable on a phone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMatch, checksum, COMMAND_DELAY } from '../server/match.js';
import { applyCommand } from '../src/core/command.js';
import { PLAYER, ENEMY } from '../src/core/constants.js';

const SEED = 20260809;

/** Every villager a player owns, as ids — the handle most commands want. */
function villagers(world, playerId) {
  return world.units
    .filter((u) => u.player === playerId && u.type === 'villager' && !u.dead)
    .map((u) => u.id);
}

test('two worlds given the same commands stay identical for 2000 ticks', () => {
  const a = createMatch({ seed: SEED, seats: [{ kind: 'human' }, { kind: 'ai' }] });
  const b = createMatch({ seed: SEED, seats: [{ kind: 'human' }, { kind: 'ai' }] });

  assert.equal(a.checksum(), b.checksum(), 'worlds differ before a single step');

  // A script of orders, stamped at ticks both matches will reach.
  const script = [
    { at: 10, make: (m) => ({ t: 'order', p: PLAYER, units: villagers(m.world, PLAYER).slice(0, 2), order: { type: 'move', gx: 40, gy: 40 } }) },
    { at: 200, make: (m) => ({ t: 'order', p: PLAYER, units: villagers(m.world, PLAYER), order: { type: 'move', gx: 52, gy: 44 } }) },
    { at: 600, make: (m) => ({ t: 'allocationOn', p: PLAYER, on: true }) },
    { at: 900, make: (m) => ({ t: 'order', p: PLAYER, units: villagers(m.world, PLAYER).slice(0, 3), order: { type: 'stop' } }) },
  ];

  for (let i = 0; i < 2000; i++) {
    for (const s of script) {
      if (s.at === a.tick) {
        // Built from each match's own world, but the payload is plain data and
        // must come out identical — if it does not, ids are not replaying.
        const ca = s.make(a);
        const cb = s.make(b);
        assert.deepEqual(ca, cb, `command payloads diverged at tick ${s.at}`);
        a.submit(ca);
        b.submit(cb);
      }
    }
    a.step();
    b.step();
    if (i % 100 === 0) {
      assert.equal(a.checksum(), b.checksum(), `desync at tick ${a.tick}`);
    }
  }

  assert.equal(a.tick, 2000);
  assert.equal(a.checksum(), b.checksum(), 'final checksums differ');
});

test('a command fires on the tick it was stamped for, not the one it arrived on', () => {
  const m = createMatch({ seed: SEED });
  for (let i = 0; i < 50; i++) m.step();

  const ids = villagers(m.world, PLAYER).slice(0, 1);
  const before = m.world.entities.get(ids[0]).task;
  const at = m.submit({ t: 'order', p: PLAYER, units: ids, order: { type: 'move', gx: 30, gy: 30 } });

  assert.equal(at, 50 + COMMAND_DELAY, 'not stamped for the delayed tick');
  // Stepping up to (but not onto) the scheduled tick must change nothing.
  for (let i = m.tick; i < at; i++) m.step();
  assert.deepEqual(m.world.entities.get(ids[0]).task, before, 'order fired early');

  m.step(); // this is the scheduled tick
  assert.notDeepEqual(m.world.entities.get(ids[0]).task, before, 'order never fired');
});

test('a player cannot command units they do not own', () => {
  const m = createMatch({ seed: SEED });
  for (let i = 0; i < 20; i++) m.step();

  const enemyUnits = villagers(m.world, ENEMY);
  assert.ok(enemyUnits.length > 0, 'no enemy villagers to test against');
  const target = m.world.entities.get(enemyUnits[0]);
  const taskBefore = target.task;

  // PLAYER asks for ENEMY's villagers by id.
  const res = applyCommand(m.world, {
    t: 'order', p: PLAYER, units: enemyUnits, order: { type: 'move', gx: 5, gy: 5 },
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-units');
  assert.deepEqual(target.task, taskBefore, 'an enemy unit was moved by the wrong player');
});

test('a player cannot demolish, train from, or research at a building they do not own', () => {
  const m = createMatch({ seed: SEED });
  for (let i = 0; i < 20; i++) m.step();

  const enemyTc = m.world.buildings.find((b) => b.player === ENEMY && !b.dead);
  assert.ok(enemyTc, 'no enemy building to test against');
  const id = enemyTc.id;

  for (const cmd of [
    { t: 'demolish', p: PLAYER, id },
    { t: 'train', p: PLAYER, id, unitType: 'villager' },
    { t: 'research', p: PLAYER, id, techId: 'feudal' },
    { t: 'gate', p: PLAYER, id, open: true },
  ]) {
    const res = applyCommand(m.world, cmd);
    assert.equal(res.ok, false, `${cmd.t} was allowed against another player's building`);
    assert.equal(res.reason, 'not-yours');
  }

  assert.ok(!enemyTc.dead, 'the enemy building was destroyed by the wrong player');
});

test('malformed and out-of-range commands are refused, not thrown', () => {
  const m = createMatch({ seed: SEED });
  for (const bad of [
    null, undefined, 42, 'move', {},
    { t: 'order' },
    { t: 'order', p: 99, units: [], order: { type: 'move' } },
    { t: 'order', p: PLAYER, units: [1], order: { type: 'not-a-real-order' } },
    { t: 'no-such-verb', p: PLAYER },
  ]) {
    const res = applyCommand(m.world, bad);
    assert.equal(res.ok, false, `${JSON.stringify(bad)} was accepted`);
    assert.ok(typeof res.reason === 'string');
  }
});

test('a seat handed to the AI keeps playing, and can be handed back', () => {
  const m = createMatch({ seed: SEED, seats: [{ kind: 'human' }, { kind: 'human' }] });
  for (let i = 0; i < 100; i++) m.step();

  // Player 1 drops. Their economy should not freeze.
  assert.equal(m.takeOver(ENEMY, 'ai'), true);
  const before = { ...m.world.players[ENEMY].resources };
  for (let i = 0; i < 400; i++) m.step();
  const after = m.world.players[ENEMY].resources;

  const moved = ['food', 'wood', 'gold', 'stone'].some((k) => after[k] !== before[k]);
  assert.ok(moved, 'the AI did not play the abandoned seat');

  assert.equal(m.takeOver(ENEMY, 'human'), true);
  assert.equal(m.roster[ENEMY].kind, 'human');
});

test('the checksum actually notices a divergence', () => {
  const a = createMatch({ seed: SEED });
  const b = createMatch({ seed: SEED });
  for (let i = 0; i < 60; i++) { a.step(); b.step(); }
  assert.equal(a.checksum(), b.checksum());

  // Nudge one unit by a hair more than the quantiser tolerates.
  a.world.units[0].x += 0.01;
  assert.notEqual(a.checksum(), b.checksum(), 'checksum missed a moved unit');
});

test('a snapshot carries the tick and a restorable world', () => {
  const m = createMatch({ seed: SEED });
  for (let i = 0; i < 120; i++) m.step();
  const snap = m.snapshot();

  assert.equal(snap.tick, 120);
  assert.equal(snap.seed, SEED);
  assert.ok(snap.state, 'no serialized state');
  assert.equal(snap.roster.length, m.world.players.length);
  // Must survive the trip a socket would put it through.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(snap)));
});
