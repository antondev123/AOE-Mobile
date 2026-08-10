// The lobby's rules, with no socket anywhere near them.
//
// server.js is transport: it reads a message, calls one of these, and broadcasts
// whatever comes back. Everything that decides whether a thing is *allowed*
// lives here, as pure functions over a plain config object — which is the same
// split match.js already makes, and for the same reason: this is where the bugs
// will be, and a test should be able to reach them without opening a port.
//
// SLOT INDEX IS PLAYER ID. Always, everywhere, with no compaction.
//
// The tempting design filters closed slots out so world.players.length equals
// the number of people actually playing. Don't: it introduces a slot -> playerId
// mapping that has to be maintained across reconnection, spectators, snapshots
// and the seat check on every command, and every one of those is a place to get
// it wrong silently. A closed slot is a player who is defeated from tick zero
// and owns nothing (see createMatch), which costs one all-zero vision mask —
// about 37kB on the largest map, and it gzips to nothing.

import { mapSizeFor, MAX_PLAYERS } from '../src/core/constants.js';

export const MIN_SLOTS = 2;
export { MAX_PLAYERS as MAX_SLOTS };

/** @typedef {'open'|'human'|'ai'|'closed'} SlotKind */

// A host may set these. 'human' is deliberately absent: it is a *consequence* of
// somebody claiming a chair, never something the host can do to you, which
// removes a whole class of "the host turned me into a bot" validation.
const SETTABLE_KINDS = new Set(['open', 'ai', 'closed']);

export const DIFFICULTIES = ['easy', 'normal', 'hard'];

function makeSlot(index) {
  return {
    index,
    // Both of the first two chairs are OPEN. That is the invite flow: you make
    // a link and send it, and the person who opens it sits down. Defaulting the
    // second to 'ai' would have made a friend arriving at your link a spectator
    // at their own match. Everything past the second starts closed, so a fresh
    // lobby is the 1v1 this game shipped as and growing it is deliberate.
    kind: index < 2 ? 'open' : 'closed',
    // Teams default to "everybody for themselves", which is the free-for-all the
    // simulation already treats as the no-teams case.
    team: index + 1,
    difficulty: 'normal',
    clientId: null,
    ready: false,
    name: '',
  };
}

/** A fresh two-seat lobby, both chairs open: the invite this game shipped as. */
export function createConfig(seed = 1) {
  return {
    seed,
    // 'auto' derives from the roster; a number is the host overriding it.
    mapSize: 'auto',
    slots: [makeSlot(0), makeSlot(1)],
  };
}

/** The map this config will actually be played on. */
export function mapDimsFor(config) {
  const auto = config.mapSize === 'auto' || !Number.isFinite(config.mapSize);
  const side = auto ? mapSizeFor(config.slots.length) : Math.round(config.mapSize);
  return { width: side, height: side, auto };
}

const ok = (detail) => ({ ok: true, ...(detail || {}) });
const no = (reason) => ({ ok: false, reason });

/**
 * Nobody stays ready across a change to what they are readying FOR.
 *
 * This is the rule most easily forgotten and the most annoying when it is: you
 * say yes to a 2v2, the host moves somebody to the other team, and the match
 * starts without you having agreed to the one being played.
 */
function unready(config) {
  for (const s of config.slots) s.ready = false;
}

export function setSlotCount(config, n) {
  const want = Math.round(n);
  if (!Number.isFinite(want) || want < MIN_SLOTS || want > MAX_PLAYERS) {
    return no('slot-count-out-of-range');
  }
  if (want < config.slots.length) {
    for (let i = want; i < config.slots.length; i++) {
      if (config.slots[i].clientId) return no('slot-occupied');
    }
    config.slots.length = want;
  } else {
    while (config.slots.length < want) {
      const s = makeSlot(config.slots.length);
      // A slot added by hand is one the host wants filled, so it opens rather
      // than arriving closed the way the tail of a fresh lobby does.
      s.kind = 'open';
      config.slots.push(s);
    }
  }
  unready(config);
  return ok();
}

export function setSlot(config, index, patch) {
  const s = config.slots[index];
  if (!s) return no('no-such-slot');

  if (patch.kind !== undefined) {
    if (!SETTABLE_KINDS.has(patch.kind)) return no('bad-kind');
    // The host may not evict or transform somebody who is sitting there. That
    // needs a kick, which is deliberately not in scope yet.
    if (s.clientId) return no('slot-occupied');
    const after = config.slots.filter((x, i) => (i === index ? patch.kind : x.kind) !== 'closed');
    if (after.length < MIN_SLOTS) return no('need-two-players');
    s.kind = patch.kind;
    if (patch.kind !== 'ai') s.difficulty = 'normal';
    unready(config);
  }

  if (patch.team !== undefined) {
    const t = Math.round(patch.team);
    if (!Number.isFinite(t) || t < 1 || t > config.slots.length) return no('bad-team');
    // Allowed on an occupied slot: the host arranging sides is the normal case,
    // and the unready() below is what keeps it honest.
    s.team = t;
    unready(config);
  }

  if (patch.difficulty !== undefined) {
    if (!DIFFICULTIES.includes(patch.difficulty)) return no('bad-difficulty');
    s.difficulty = patch.difficulty;
  }

  return ok();
}

export function setMap(config, size) {
  if (size === 'auto') { config.mapSize = 'auto'; return ok(); }
  const n = Math.round(size);
  if (!Number.isFinite(n) || n < 64 || n > 256) return no('bad-map-size');
  config.mapSize = n;
  return ok();
}

export function setSeed(config, seed) {
  if (!Number.isFinite(seed)) return no('bad-seed');
  config.seed = Math.floor(seed) >>> 0;
  return ok();
}

/** Take a chair. Releases whatever the caller was sitting in first. */
export function claimSlot(config, index, clientId, name = '') {
  const s = config.slots[index];
  if (!s) return no('no-such-slot');
  if (s.clientId === clientId) return ok({ slot: index });
  if (s.kind !== 'open') return no('slot-not-open');
  // Moving chairs must not cost you your name. `claim` carries one on the way in
  // from the URL, but a player changing seats mid-lobby sends only the slot, and
  // releasing the old chair is what would otherwise throw the name away.
  const previous = config.slots.find((x) => x.clientId === clientId);
  const carried = previous ? previous.name : '';
  releaseSlot(config, clientId);
  s.kind = 'human';
  s.clientId = clientId;
  s.name = name || carried || '';
  s.ready = false;
  return ok({ slot: index });
}

/** The lowest open chair, or null when the room is full. */
export function firstOpenSlot(config) {
  for (const s of config.slots) if (s.kind === 'open') return s.index;
  return null;
}

/** Stand up. Returns the slot let go of, or null. */
export function releaseSlot(config, clientId) {
  for (const s of config.slots) {
    if (s.clientId !== clientId) continue;
    s.clientId = null;
    s.ready = false;
    s.name = '';
    // Back to open, never to AI: the chair is theirs to come back to. Handing it
    // to a brain the moment somebody's phone drops the connection would mean
    // reconnecting into a town that had been played without them.
    s.kind = 'open';
    return s.index;
  }
  return null;
}

export function setReady(config, clientId, ready) {
  for (const s of config.slots) {
    if (s.clientId !== clientId) continue;
    s.ready = !!ready;
    return ok({ slot: s.index, ready: s.ready });
  }
  return no('not-seated');
}

/**
 * May this start, and if not, which fact is in the way?
 *
 * The reason is machine-readable so the button can say why it is grey rather
 * than simply being grey. "Everyone ready" means every HUMAN chair is filled and
 * has said yes; AI and closed chairs are always ready, which is the whole reason
 * a host can start a game against seven bots without waiting for anybody.
 */
export function canStart(config) {
  const live = config.slots.filter((s) => s.kind !== 'closed');
  if (live.length < MIN_SLOTS) return no('need-two-players');
  if (live.some((s) => s.kind === 'open')) return no('open-slots');
  if (!live.some((s) => s.kind === 'human')) return no('need-one-human');
  for (const s of live) {
    if (s.kind === 'human' && !(s.clientId && s.ready)) return no(`slot-${s.index}-not-ready`);
  }
  // Somebody has to be able to win. Every live seat on one team is a match with
  // no losing side, which checkVictory would end on the first tick.
  if (new Set(live.map((s) => s.team)).size < 2) return no('one-team');
  return ok();
}

/** The roster createMatch wants: seat-indexed, every slot present. */
export function toRoster(config) {
  return config.slots.map((s) => ({
    kind: s.kind === 'open' ? 'closed' : s.kind,
    team: s.team,
    difficulty: s.difficulty,
    name: s.name,
  }));
}

/**
 * Fill the empty chairs so a match can begin without them.
 *
 * canStart refuses while any chair is open, deliberately: quietly converting
 * them would be a surprise. This is the host saying what to do about it, which
 * is why it is a parameter of pressing Start rather than a rule.
 */
export function fillOpenSlots(config, kind) {
  if (!SETTABLE_KINDS.has(kind) || kind === 'open') return no('bad-kind');
  for (const s of config.slots) {
    if (s.kind === 'open') { s.kind = kind; s.ready = false; }
  }
  const live = config.slots.filter((s) => s.kind !== 'closed');
  if (live.length < MIN_SLOTS) return no('need-two-players');
  return ok();
}

/** What the lobby screen draws. Identical for every recipient — see server.js. */
export function lobbyPayload(config, { hostSlot = null, phase = 'lobby' } = {}) {
  const start = canStart(config);
  return {
    type: 'lobby',
    phase,
    hostSlot,
    seed: config.seed,
    mapSize: mapDimsFor(config),
    slots: config.slots.map((s) => ({
      index: s.index,
      kind: s.kind,
      team: s.team,
      difficulty: s.difficulty,
      filled: !!s.clientId,
      ready: s.kind === 'human' ? !!s.ready : s.kind !== 'open',
      name: s.name,
    })),
    canStart: start.ok,
    blockedBy: start.ok ? null : start.reason,
  };
}
