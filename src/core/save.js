// Saving and resuming a match.
//
// A phone browser is killed without warning — a phone call, the task switcher,
// the OS reclaiming memory behind a locked screen — and none of those give the
// page a chance to ask the player whether they would like to keep their game.
// So there is no "Save" button anywhere in this file's design: the game saves
// itself on a clock and on the way out, and the only control the player ever
// sees is "Resume match" on the boot card.
//
// No Phaser imports: this must run headlessly under Node (see
// tests/save.test.mjs), which is also what makes the determinism assertion
// there possible at all.
//
// WHAT A SAVE IS
// --------------
// A *continuation*, not a screenshot. Stepping a restored world and stepping
// the world it came from must produce identical matches, tick for tick, and
// that is the property tests/save.test.mjs actually asserts rather than
// eyeballing entity counts. Three things carry it:
//
//   * `world.rng` is written as its 32-bit state, not as its seed. A save that
//     only carried the seed would rewind the generator to zero draws, and the
//     next wave interval, building variant and placement cursor after the load
//     would come out of a different part of the stream.
//   * `world.nextId` is written, so entities spawned after the load get the ids
//     they would have got. Both combat.js (which staggers swings by id) and
//     unitAI.js (which breaks ties by id) derive behaviour from them.
//   * every ordered collection keeps its order — world.units, world.buildings,
//     world.resources, the entity map itself and each player's `owned` set. Half
//     the simulation iterates one of those and stops at its first hit, so a set
//     rebuilt in a different order is a different game.
//
// WHAT IS NOT WRITTEN
// -------------------
// Anything a fresh step recomputes: the spatial buckets, the occupancy and block
// grids (rebuilt from the terrain and the entities standing on it), the fog's
// visible mask and viewer cache (rebuilt by the first vision update after the
// load), and the tech multiplier cache (recomputed from the tech list). Writing
// a derived value is how a save file grows a way of disagreeing with itself.
//
// VERSIONING
// ----------
// One integer, checked before anything is touched. There is no migration path
// and deliberately so: this is a ten-minute skirmish, the cost of a refused load
// is one match, and a half-applied migration would cost a player a match *and*
// leave them somewhere the game cannot be played from. `readSave` returns a
// reason string the boot card prints out loud.

import {
  createWorld, setBlocked, setGateOpen, applyPopBonus, recomputePop,
  refreshWallsAround,
} from './world.js';
import { TERRAIN, isWallType, isGateType } from './constants.js';
import { serializeTech, restoreTech } from '../systems/tech.js';
import { serializeEconomy, restoreEconomy } from '../systems/economy.js';
import { serializeAllocation, restoreAllocation } from '../systems/allocation.js';
import { serializeMarket, restoreMarket } from '../systems/market.js';

/**
 * Bump this whenever the shape below changes in a way an older payload cannot
 * satisfy — a renamed field, a new required collection, a changed id scheme.
 * Balance changes do not need it: a save carries the numbers it was played
 * with, and a match resumed after a retune is allowed to finish on the old ones.
 */
export const SAVE_VERSION = 1;

/** localStorage key. Namespaced so it cannot collide with the audio prefs. */
export const SAVE_KEY = 'aos.save.v1';

// --- Reference-aware packing -------------------------------------------------
//
// Entities point at each other constantly: a villager's task names the tree it
// is chopping and the Lumber Camp it will walk to, a soldier's target is
// another unit, a Town Center's garrison is a list of bodies. Every one of those
// has to come back as the *same object* the rest of the world is holding, or the
// restored game has two of everything and the halves drift apart.
//
// So the packer walks each entity's own properties and replaces any live entity
// it meets with `{ $ref: id }`, and the unpacker resolves those against the
// rebuilt entity map. It is generic on purpose: this codebase adds fields to
// units and buildings constantly (stances, formations, rally points, garrison
// lists, the pathfinder's half-dozen bookkeeping fields), and a hand-written
// field list would be one sprint away from silently dropping one of them.

function isEntity(v) {
  return !!v && typeof v.id === 'number' &&
    (v.kind === 'unit' || v.kind === 'building' || v.kind === 'resource');
}

function packValue(v) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? v : null;
  if (t === 'string' || t === 'boolean') return v;
  // Functions, symbols and undefined do not survive, and nothing on an entity
  // is any of them. Dropping the key is the honest outcome: it comes back
  // missing, which is what it already was.
  if (t !== 'object') return undefined;
  if (Array.isArray(v)) return v.map(packValue);
  if (isEntity(v)) return { $ref: v.id };
  if (ArrayBuffer.isView(v) || v instanceof Map || v instanceof Set) return undefined;
  const out = {};
  for (const k of Object.keys(v)) {
    const p = packValue(v[k]);
    if (p !== undefined) out[k] = p;
  }
  return out;
}

function unpackValue(v, byId) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => unpackValue(x, byId));
  if (typeof v.$ref === 'number') return byId.get(v.$ref) || null;
  const out = {};
  for (const k of Object.keys(v)) out[k] = unpackValue(v[k], byId);
  return out;
}

function packEntity(e) {
  const out = {};
  for (const k of Object.keys(e)) {
    const p = packValue(e[k]);
    if (p !== undefined) out[k] = p;
  }
  return out;
}

// --- Byte arrays -------------------------------------------------------------
//
// The terrain and each player's explored mask are one byte per tile: 9216 of
// them apiece on a 96x96 map. As a JSON array of numbers that is roughly 30kB
// each; base64 is 12kB and costs one pass. There are three of them in a save, so
// it is the difference between a payload that fits comfortably in localStorage
// beside 1900 resource nodes and one that does not.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) m[B64.charCodeAt(i)] = i;
  return m;
})();

/** Base64 a byte array. Written out rather than via btoa: no DOM in core. */
export function bytesToB64(bytes) {
  let out = '';
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const w = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(w >> 18) & 63] + B64[(w >> 12) & 63] + B64[(w >> 6) & 63] + B64[w & 63];
  }
  const rest = n - i;
  if (rest === 1) {
    const w = bytes[i] << 16;
    out += `${B64[(w >> 18) & 63]}${B64[(w >> 12) & 63]}==`;
  } else if (rest === 2) {
    const w = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += `${B64[(w >> 18) & 63]}${B64[(w >> 12) & 63]}${B64[(w >> 6) & 63]}=`;
  }
  return out;
}

export function b64ToBytes(str) {
  if (typeof str !== 'string') return new Uint8Array(0);
  let len = str.length;
  while (len > 0 && str[len - 1] === '=') len--;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const c = str.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

// --- Serialise ---------------------------------------------------------------

/**
 * Everything needed to resume this match, as a plain JSON-safe object.
 *
 * `extra` carries what the *scene* owns rather than the simulation: the enemy
 * AI's memory (`ai`) and where the camera was looking (`view`). Both are
 * optional — a save with neither still restores a playable, identical game;
 * it simply starts you looking at the middle of the map with an AI that has
 * forgotten which villager was on which tree.
 */
export function serializeGame(world, extra = {}) {
  const entities = [];
  for (const e of world.entities.values()) entities.push(packEntity(e));

  return {
    v: SAVE_VERSION,
    savedAt: Date.now(),

    seed: world.seed,
    // The generator's live state, not its seed. See the note at the top.
    rng: world.rng.getState(),
    nextId: world.nextId,
    time: world.time,
    tick: world.tick,
    over: !!world.over,
    winner: world.winner === null || world.winner === undefined ? null : world.winner,

    width: world.width,
    height: world.height,
    terrain: bytesToB64(world.terrain),
    // Rock outcrops. Stored rather than derived, and it is the one grid here
    // that has to be: the terrain under a cliff is ordinary dirt, so there is
    // nothing in `terrain` to reconstruct it from, and re-running mapgen to
    // find out would regenerate the whole map. One byte per tile, the same
    // 9216-byte cost the terrain already pays.
    cliff: bytesToB64(world.cliff),

    players: world.players.map((p) => ({
      resources: { ...p.resources },
      popCap: p.popCap,
      defeated: !!p.defeated,
      // Which side they play for. A save from before there were teams has none,
      // and restoreGame falls back to the seat number — a free-for-all, which is
      // exactly what a two-player save was.
      team: p.team,
      // Insertion order matters: ownedBy() walks this set and several passes
      // stop at their first hit.
      owned: Array.from(p.owned),
    })),

    // world.entities is a Map and its iteration order is its insertion order,
    // which is the order this array is written in — so rebuilding from it in
    // order reproduces the map exactly.
    entities,
    // ...and these three reproduce the dense lists, which are iterated far more
    // often than the map is and are not simply the map filtered by kind: a
    // garrisoned unit is in the map and not in world.units.
    units: world.units.map((e) => e.id),
    buildings: world.buildings.map((e) => e.id),
    resources: world.resources.map((e) => e.id),

    selection: Array.from(world.selection),
    projectiles: world.projectiles.map((p) => packValue(p)),

    tech: serializeTech(world),
    economy: serializeEconomy(world),
    allocation: serializeAllocation(world),
    // The trade prices are drifting world state, not a derived value: they
    // record every lot anyone has traded this match, and a reload that reset
    // them to 100 would hand back the surplus the player already sold off.
    market: serializeMarket(world),
    vision: world.vision
      ? world.vision.serialize().map((st) => ({
        explored: bytesToB64(st.explored),
        memory: st.memory,
      }))
      : null,

    // One blob per seat, not one blob.
    //
    // This carried a single `ai` because a match had a single AI, which is what
    // stopped server/match.js running AI seats in a networked room at all: a
    // client rebuilding from a snapshot would inherit the world but not the
    // brains about to act on it, and drift within seconds. `ai` is still
    // accepted and still written, so a save from before this loads unchanged.
    ais: extra.ais || (extra.ai ? [extra.ai] : null),
    ai: extra.ai || (extra.ais && extra.ais[0]) || null,
    view: extra.view || null,
    // Who was in which chair. A save without it is the classic skirmish and is
    // reconstructed as one on load; carrying it is what lets an eight-player
    // offline match come back with the same seats on the same sides.
    roster: extra.roster || null,
  };
}

// --- Restore -----------------------------------------------------------------

/**
 * Rebuild a world from `data`. Throws on anything it cannot make sense of —
 * callers should be going through `loadSave`, which turns that into a message.
 *
 * Returns { world, ai, view }: the caller owns wiring the AI memory into a
 * freshly created enemy AI, because this module does not know which player the
 * AI is playing.
 */
export function restoreGame(data) {
  if (!data || typeof data !== 'object') throw new Error('Save file is empty');
  if (data.v !== SAVE_VERSION) {
    throw new Error(
      `Save is from version ${data.v === undefined ? '?' : data.v}, this build reads ${SAVE_VERSION}`,
    );
  }
  if (!Array.isArray(data.entities)) throw new Error('Save has no entities');

  // Built to the save's shape rather than checked against the build's.
  //
  // This used to be createWorld(seed) followed by "is this the size I always
  // am", which was the only thing it could be when there was one possible map.
  // The map is a lobby decision now, so the save carries its own dimensions and
  // its own roster and the world is made to fit them.
  const savedPlayers = Array.isArray(data.players) ? data.players : [];
  const world = createWorld(data.seed, {
    playerCount: savedPlayers.length || 2,
    width: data.width,
    height: data.height,
    teams: savedPlayers.map((p, i) => (p && p.team !== undefined && p.team !== null ? p.team : i)),
  });
  if (world.width !== data.width || world.height !== data.height) {
    throw new Error(
      `Save is a ${data.width}x${data.height} map, which this build cannot build`,
    );
  }
  if (world.players.length !== savedPlayers.length) {
    throw new Error(
      `Save has ${savedPlayers.length} players, which is outside what this build supports`,
    );
  }

  world.rng.setState(data.rng >>> 0);
  world.nextId = data.nextId;
  world.time = data.time || 0;
  world.tick = data.tick || 0;
  world.over = !!data.over;
  world.winner = data.winner === null || data.winner === undefined ? null : data.winner;

  const terrain = b64ToBytes(data.terrain);
  if (terrain.length !== world.terrain.length) throw new Error('Save terrain is the wrong size');
  world.terrain.set(terrain);

  // A save written before rock outcrops existed simply has no cliffs, which is
  // a correct reading of it rather than a migration: that match was played on a
  // map with none.
  world.cliff.fill(0);
  if (data.cliff) {
    const cliff = b64ToBytes(data.cliff);
    if (cliff.length !== world.cliff.length) throw new Error('Save cliff grid is the wrong size');
    world.cliff.set(cliff);
  }

  // The block grid is derived, never stored: water from the terrain, the rock
  // from the cliff grid, everything else from the entities that are about to be
  // put back on it.
  for (let i = 0; i < world.terrain.length; i++) {
    world.blocked[i] =
      world.terrain[i] === TERRAIN.WATER || world.cliff[i] ? 2 : 0;
    world.occupant[i] = 0;
    world.gateOwner[i] = 0;
  }

  // 1. Bare objects first, so a reference can be resolved to the right one
  //    however early in the file it appears.
  const byId = new Map();
  for (const rec of data.entities) {
    if (!rec || typeof rec.id !== 'number') continue;
    byId.set(rec.id, {});
  }
  // 2. Fill them in, in the saved order, which is world.entities' order.
  for (const rec of data.entities) {
    const e = byId.get(rec.id);
    if (!e) continue;
    for (const k of Object.keys(rec)) e[k] = unpackValue(rec[k], byId);
    world.entities.set(e.id, e);
  }

  const pick = (ids) => {
    const out = [];
    for (const id of ids || []) {
      const e = byId.get(id);
      if (e) out.push(e);
    }
    return out;
  };
  world.units.push(...pick(data.units));
  world.buildings.push(...pick(data.buildings));
  world.resources.push(...pick(data.resources));

  // 3. Stamp the grids. Buildings before gates, because a gate's passability
  //    depends on its own footprint already being claimed.
  for (const b of world.buildings) {
    for (const [tx, ty] of b.tiles || []) setBlocked(world, tx, ty, 1, b.id);
  }
  for (const n of world.resources) {
    setBlocked(world, Math.floor(n.x), Math.floor(n.y), 1, n.id);
  }
  for (const b of world.buildings) {
    if (!isWallType(b.type)) continue;
    refreshWallsAround(world, Math.floor(b.x), Math.floor(b.y));
    if (isGateType(b.type)) setGateOpen(world, b, !!b.gateOpen);
  }

  // 4. Players. `owned` is rebuilt in its saved order, then reconciled against
  //    what actually came back, so a set entry for an entity that is not in the
  //    file cannot leave a dangling id behind for ownedBy to trip over.
  for (let i = 0; i < world.players.length; i++) {
    const p = world.players[i];
    const rec = data.players && data.players[i];
    if (!rec) continue;
    p.resources = { ...p.resources, ...rec.resources };
    p.popCap = rec.popCap || 0;
    p.defeated = !!rec.defeated;
    p.owned.clear();
    for (const id of rec.owned || []) if (byId.has(id)) p.owned.add(id);
  }

  world.selection.clear();
  for (const id of data.selection || []) if (byId.has(id)) world.selection.add(id);

  world.projectiles.length = 0;
  for (const rec of data.projectiles || []) {
    const p = unpackValue(rec, byId);
    if (!p) continue;
    // A projectile whose target died between the save and the load has nothing
    // to hit. combat.js copes, but there is no reason to restore one.
    //
    // A SPLASH SHOT IS THE EXCEPTION AND HAS TO BE. A mangonel's boulder
    // deliberately carries no target at all — it is thrown at a *place*, which
    // is what makes minimum range and the SPREAD formation mean anything (see
    // launchProjectile in combat.js). Testing for a target alone therefore
    // silently deleted every boulder in the air across a save, which is the
    // sort of thing nobody notices until a player reloads mid-siege and their
    // shot never lands.
    if (p.target || p.splashRadius > 0) world.projectiles.push(p);
  }

  restoreTech(world, data.tech);
  restoreEconomy(world, data.economy);
  restoreAllocation(world, data.allocation);
  restoreMarket(world, data.market);

  if (world.vision && data.vision) {
    world.vision.restore(data.vision.map((st) => ({
      explored: b64ToBytes(st.explored),
      memory: st.memory,
    })));
  }

  // 5. Population is derived from what is standing, so it is recomputed rather
  //    than read — and it must happen after the tech restore, because the age
  //    scale is already baked into the hitpoints we just loaded.
  for (let i = 0; i < world.players.length; i++) {
    applyPopBonus(world, i);
    recomputePop(world, i);
  }

  const ais = Array.isArray(data.ais) ? data.ais : (data.ai ? [data.ai] : []);
  return {
    world, ais, ai: ais[0] || data.ai || null,
    view: data.view || null,
    roster: Array.isArray(data.roster) ? data.roster : null,
  };
}

// --- Storage -----------------------------------------------------------------
//
// Everything here swallows its own failures. localStorage throws in Safari's
// private mode, throws when the quota is full, and is simply absent under Node —
// and none of those are worth ending a match over. A save that cannot be written
// is a save that is not offered on the next boot, which is the correct and
// visible outcome.

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Write a payload. Returns { ok, bytes, error }. */
export function writeSave(data, key = SAVE_KEY) {
  const store = storage();
  if (!store) return { ok: false, bytes: 0, error: 'No local storage' };
  let text;
  try {
    text = JSON.stringify(data);
  } catch (err) {
    return { ok: false, bytes: 0, error: `Could not encode the save: ${err.message}` };
  }
  try {
    store.setItem(key, text);
    return { ok: true, bytes: text.length, error: null };
  } catch (err) {
    // Quota, almost always. Take the stale save with it: a half-written or
    // superseded save is worse than none, because the boot card would offer it.
    try { store.removeItem(key); } catch { /* nothing more to try */ }
    return { ok: false, bytes: text.length, error: `Could not save: ${err.message}` };
  }
}

/**
 * Read the stored payload. Returns { data, error }: exactly one is set.
 *
 * A save from an incompatible version is refused *here*, before anything is
 * built out of it, and the reason is a sentence a player can read.
 */
export function readSave(key = SAVE_KEY) {
  const store = storage();
  if (!store) return { data: null, error: null };
  let text = null;
  try {
    text = store.getItem(key);
  } catch {
    return { data: null, error: null };
  }
  if (!text) return { data: null, error: null };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { data: null, error: 'The saved match is corrupt' };
  }
  if (!data || typeof data !== 'object') return { data: null, error: 'The saved match is corrupt' };
  if (data.v !== SAVE_VERSION) {
    return {
      data: null,
      error: `That saved match is from an older version of the game (${data.v === undefined ? 'unknown' : `v${data.v}`}, this build plays v${SAVE_VERSION})`,
    };
  }
  return { data, error: null };
}

export function clearSave(key = SAVE_KEY) {
  const store = storage();
  if (!store) return;
  try { store.removeItem(key); } catch { /* already gone */ }
}

/**
 * What the boot card needs to decide whether to offer "Resume match", without
 * parsing a 400kB payload: how far in the match had got, and whose it was.
 *
 * Returns null when there is nothing to resume, and { error } when there is
 * something there that this build refuses to read — the card says so rather
 * than pretending the save does not exist, because a player who saved five
 * minutes ago deserves to know why it is gone.
 */
export function saveInfo(key = SAVE_KEY) {
  const { data, error } = readSave(key);
  if (error) return { error, time: 0 };
  if (!data) return null;
  if (data.over) return null;   // a finished match is not worth resuming
  const t = Math.max(0, Math.floor(data.time || 0));
  return {
    error: null,
    time: t,
    label: `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`,
    savedAt: data.savedAt || 0,
    data,
  };
}

/** Is there a resumable match in storage? Cheap enough for a boot check. */
export function hasSave(key = SAVE_KEY) {
  return !!saveInfo(key);
}
