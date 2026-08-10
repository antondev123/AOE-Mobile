// The lobby's rules, tested without opening a port.
//
// server/room.js is pure on purpose: every decision about what a host may do,
// what "everyone is ready" means, and whether a match can begin is a function
// over a plain object. This is where the bugs in a lobby live — not in the
// socket — so this is where the tests are.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createConfig, mapDimsFor, setSlotCount, setSlot, setMap, setSeed,
  claimSlot, releaseSlot, setReady, canStart, toRoster, fillOpenSlots,
  firstOpenSlot, lobbyPayload, MIN_SLOTS, MAX_SLOTS,
} from '../server/room.js';
import { mapSizeFor } from '../src/core/constants.js';
import { createMatch } from '../server/match.js';

/** A lobby with `n` chairs, all open. */
function lobbyOf(n) {
  const c = createConfig(7);
  setSlotCount(c, n);
  for (let i = 0; i < n; i++) setSlot(c, i, { kind: 'open' });
  return c;
}

test('a fresh lobby is the skirmish this game shipped as', () => {
  const c = createConfig(1);
  assert.equal(c.slots.length, 2);
  assert.equal(c.slots[0].kind, 'open', 'a chair for whoever opened the link');
  assert.equal(c.slots[1].kind, 'ai', 'and an opponent');
  assert.deepEqual(mapDimsFor(c), { width: mapSizeFor(2), height: mapSizeFor(2), auto: true });
});

test('the map grows with the roster, and the host may override it', () => {
  const c = createConfig(1);
  setSlotCount(c, 8);
  assert.equal(mapDimsFor(c).width, mapSizeFor(8));
  assert.ok(mapDimsFor(c).width > mapSizeFor(2), 'eight players get more ground');

  assert.ok(setMap(c, 128).ok);
  assert.deepEqual(mapDimsFor(c), { width: 128, height: 128, auto: false });
  assert.ok(!setMap(c, 12).ok, 'and not an absurd one');
  assert.ok(setMap(c, 'auto').ok);
  assert.equal(mapDimsFor(c).auto, true);
});

// --- What the host may and may not do ----------------------------------------

test('slot counts are bounded, and shrinking past somebody is refused', () => {
  const c = createConfig(1);
  assert.ok(!setSlotCount(c, 1).ok, 'a one-player match is not a match');
  assert.ok(!setSlotCount(c, MAX_SLOTS + 1).ok);
  assert.ok(setSlotCount(c, MIN_SLOTS).ok);

  setSlotCount(c, 4);
  claimSlot(c, 3, 'zoe', 'Zoe');
  assert.equal(setSlotCount(c, 2).reason, 'slot-occupied');
  assert.equal(c.slots.length, 4, 'and the lobby is left alone');
  releaseSlot(c, 'zoe');
  assert.ok(setSlotCount(c, 2).ok);
});

test("a host cannot turn a seated player into a bot", () => {
  const c = lobbyOf(3);
  claimSlot(c, 1, 'sam', 'Sam');
  assert.equal(setSlot(c, 1, { kind: 'ai' }).reason, 'slot-occupied');
  assert.equal(setSlot(c, 1, { kind: 'closed' }).reason, 'slot-occupied');
  assert.equal(c.slots[1].kind, 'human');
  // But their team is the host's to arrange — that is the normal case.
  assert.ok(setSlot(c, 1, { team: 2 }).ok);
  assert.equal(c.slots[1].team, 2);
});

test("'human' is not a kind the host can set", () => {
  const c = lobbyOf(2);
  assert.equal(setSlot(c, 0, { kind: 'human' }).reason, 'bad-kind');
  assert.equal(setSlot(c, 0, { kind: 'nonsense' }).reason, 'bad-kind');
  // It only ever arrives by somebody sitting down.
  claimSlot(c, 0, 'ana');
  assert.equal(c.slots[0].kind, 'human');
});

test('the lobby can never be closed down below two players', () => {
  const c = lobbyOf(2);
  assert.equal(setSlot(c, 0, { kind: 'closed' }).reason, 'need-two-players');
  setSlotCount(c, 3);
  assert.ok(setSlot(c, 2, { kind: 'closed' }).ok, 'a third may be closed');
  assert.equal(setSlot(c, 1, { kind: 'closed' }).reason, 'need-two-players');
});

test('changing the shape of the match un-readies everybody', () => {
  const c = lobbyOf(2);
  claimSlot(c, 0, 'ana');
  claimSlot(c, 1, 'ben');
  setReady(c, 'ana', true);
  setReady(c, 'ben', true);
  assert.ok(c.slots.every((s) => s.ready));

  // Nobody agreed to THIS match.
  setSlot(c, 1, { team: 1 });
  assert.ok(c.slots.every((s) => !s.ready), 'a team change clears every ready');

  setReady(c, 'ana', true);
  setSlotCount(c, 3);
  assert.ok(c.slots.every((s) => !s.ready), 'so does adding a chair');
});

// --- Sitting down and standing up --------------------------------------------

test('claiming moves you rather than cloning you', () => {
  const c = lobbyOf(3);
  claimSlot(c, 0, 'ana', 'Ana');
  assert.equal(claimSlot(c, 2, 'ana').slot, 2);
  assert.equal(c.slots[0].kind, 'open', 'the old chair is free again');
  assert.equal(c.slots[0].clientId, null);
  assert.equal(c.slots[2].clientId, 'ana');
  assert.equal(c.slots[2].name, 'Ana', 'and the name comes along');
});

test('a taken chair cannot be sat in twice', () => {
  const c = lobbyOf(2);
  claimSlot(c, 0, 'ana');
  assert.equal(claimSlot(c, 0, 'ben').reason, 'slot-not-open');
  assert.equal(claimSlot(c, 0, 'ana').ok, true, 'though sitting where you are is fine');
});

test('leaving frees the chair as OPEN, so it can be reclaimed', () => {
  const c = lobbyOf(2);
  claimSlot(c, 1, 'ben');
  assert.equal(releaseSlot(c, 'ben'), 1);
  assert.equal(c.slots[1].kind, 'open',
    'not ai — a dropped connection must be able to come back to its own town');
  assert.equal(firstOpenSlot(c), 0);
  assert.equal(releaseSlot(c, 'nobody'), null);
});

test('ready only applies to your own chair', () => {
  const c = lobbyOf(2);
  assert.equal(setReady(c, 'ghost', true).reason, 'not-seated');
  claimSlot(c, 0, 'ana');
  assert.ok(setReady(c, 'ana', true).ok);
  assert.equal(c.slots[0].ready, true);
});

// --- canStart, which is the whole point --------------------------------------

test('canStart names the one thing in the way', () => {
  const c = lobbyOf(2);
  assert.equal(canStart(c).reason, 'open-slots', 'nobody has sat down');

  claimSlot(c, 0, 'ana');
  assert.equal(canStart(c).reason, 'open-slots', 'one chair still empty');

  setSlot(c, 1, { kind: 'ai' });
  assert.equal(canStart(c).reason, 'slot-0-not-ready', 'and it names WHO');

  setReady(c, 'ana', true);
  assert.equal(canStart(c).ok, true, 'a human and a bot on two teams is a match');
});

test('AI and closed chairs are always ready; humans have to say so', () => {
  const c = lobbyOf(4);
  claimSlot(c, 0, 'ana');
  setSlot(c, 1, { kind: 'ai' });
  setSlot(c, 2, { kind: 'ai' });
  setSlot(c, 3, { kind: 'closed' });
  assert.equal(canStart(c).reason, 'slot-0-not-ready');
  setReady(c, 'ana', true);
  assert.equal(canStart(c).ok, true, 'one human against two bots, no waiting');

  const payload = lobbyPayload(c, { hostSlot: 0 });
  assert.equal(payload.slots[1].ready, true, 'a bot reads as ready');
  assert.equal(payload.slots[3].ready, true, 'so does a closed chair');
});

test('a match everybody could win is refused', () => {
  const c = lobbyOf(2);
  claimSlot(c, 0, 'ana');
  setSlot(c, 1, { kind: 'ai' });
  setSlot(c, 1, { team: 1 });
  setReady(c, 'ana', true);
  assert.equal(canStart(c).reason, 'one-team', 'nobody could ever lose');
  setSlot(c, 1, { team: 2 });
  setReady(c, 'ana', true);
  assert.equal(canStart(c).ok, true);
});

test('a lobby of nothing but bots is refused', () => {
  const c = lobbyOf(2);
  setSlot(c, 0, { kind: 'ai' });
  setSlot(c, 1, { kind: 'ai' });
  assert.equal(canStart(c).reason, 'need-one-human');
});

test('fillOpenSlots is the host answering the open-slots refusal', () => {
  const c = lobbyOf(4);
  claimSlot(c, 0, 'ana');
  setReady(c, 'ana', true);
  assert.equal(canStart(c).reason, 'open-slots');

  assert.ok(fillOpenSlots(c, 'ai').ok);
  setReady(c, 'ana', true);
  assert.equal(canStart(c).ok, true);
  assert.deepEqual(c.slots.map((s) => s.kind), ['human', 'ai', 'ai', 'ai']);

  // Closing them instead is the other answer, and must not close the match away.
  const d = lobbyOf(4);
  claimSlot(d, 0, 'ana');
  claimSlot(d, 1, 'ben');
  assert.ok(fillOpenSlots(d, 'closed').ok);
  assert.deepEqual(d.slots.map((s) => s.kind), ['human', 'human', 'closed', 'closed']);
});

// --- Handing over to the simulation ------------------------------------------

test('the roster hands every chair to the match, closed ones included', () => {
  const c = lobbyOf(4);
  claimSlot(c, 0, 'ana');
  setSlot(c, 1, { kind: 'ai', team: 1 });
  setSlot(c, 0, { team: 1 });
  setSlot(c, 2, { kind: 'ai', team: 2 });
  setSlot(c, 3, { kind: 'closed' });

  const roster = toRoster(c);
  assert.equal(roster.length, 4, 'slot index is player id: nothing is compacted');
  assert.deepEqual(roster.map((r) => r.kind), ['human', 'ai', 'ai', 'closed']);
  assert.deepEqual(roster.map((r) => r.team), [1, 1, 2, 4]);
});

test('a lobby roster builds a match whose closed seats are already out', () => {
  const c = lobbyOf(4);
  claimSlot(c, 0, 'ana');
  setSlot(c, 1, { kind: 'ai', team: 2 });
  setSlot(c, 2, { kind: 'closed' });
  setSlot(c, 3, { kind: 'closed' });

  const dims = mapDimsFor(c);
  const m = createMatch({ seed: c.seed, seats: toRoster(c), width: dims.width, height: dims.height });

  assert.equal(m.world.players.length, 4, 'four seats, so four players');
  assert.equal(m.world.width, dims.width);
  assert.equal(m.world.players[2].defeated, true, 'a closed chair is out from tick zero');
  assert.equal(m.world.players[3].defeated, true);
  assert.equal(m.world.players[0].defeated, false);

  // And it does not immediately declare a winner: two live sides remain.
  m.step();
  assert.equal(m.world.over, false);
});

test('the payload the lobby screen draws says what it needs to', () => {
  const c = lobbyOf(3);
  claimSlot(c, 0, 'ana', 'Ana');
  setSlot(c, 1, { kind: 'ai', difficulty: 'hard' });
  const p = lobbyPayload(c, { hostSlot: 0, phase: 'lobby' });

  assert.equal(p.type, 'lobby');
  assert.equal(p.hostSlot, 0);
  assert.equal(p.slots.length, 3);
  assert.equal(p.slots[0].name, 'Ana');
  assert.equal(p.slots[1].difficulty, 'hard');
  assert.equal(p.canStart, false);
  assert.equal(p.blockedBy, 'open-slots');
  // No per-recipient field anywhere: one payload is serialised once and sent to
  // everybody, and `welcome.you.slot` is the single source of "which am I".
  assert.ok(!('you' in p.slots[0]));
});

test('seeds are settable and survive as integers', () => {
  const c = createConfig(1);
  assert.ok(setSeed(c, 4242).ok);
  assert.equal(c.seed, 4242);
  assert.ok(!setSeed(c, NaN).ok);
});
