// Fog of war: per-player tile visibility, exploration and object memory.
//
// No Phaser imports. This file must run headlessly under Node (see
// tests/vision.test.mjs) — the renderer and the minimap only *read* what is
// computed here.
//
// Three states per tile, exactly AoE2's:
//   unexplored  you have never had anything near it; nothing at all is drawn
//   explored    you have seen it; terrain and *remembered* static objects are
//               drawn, dimmed. No units, and a building that died while you
//               were away keeps its ghost until you look again
//   visible     something of yours can see it right now; everything is live
//
// The two masks are the whole public contract with the renderer:
//   vision.state(player).visible[i]   1 while a viewer covers tile i
//   vision.state(player).explored[i]  1 once it ever has
// plus `memory` — the snapshots that make "explored" mean something.
//
// WHY RADIUS AND NOT LINE OF SIGHT
// --------------------------------
// pathfinding.js has a perfectly good hasLineOfSight(), and it was tempting to
// raycast every tile in a viewer's disc against the blocked grid. Two reasons
// not to:
//
//  1. AoE2 does not do it either. Vision in Age of Empires II is a plain circle;
//     units see over forests, over cliffs and over buildings. Adding occlusion
//     here would not be "more faithful", it would be a different game — and on a
//     map whose interior is mostly forest it would leave villagers working a
//     woodline in a two-tile bubble, which reads as a bug rather than as
//     tactics.
//  2. It would be *unsound* as an incremental update. The mask is maintained by
//     stamping a viewer's disc in when it moves and stamping the old one out.
//     An occluded disc depends on world.blocked, which changes underneath us
//     when a house goes up or a tree is felled, so the stamp-out would not match
//     the stamp-in and per-tile viewer counts would drift — tiles stuck bright
//     forever, or counts going negative. Fixing that needs the exact tile list
//     of every viewer kept alive (150 viewers x ~200 tiles) and a raycast storm
//     on every rebuild, for a look nobody asked for.
//
// So: plain radius, one integer per viewer, discs precomputed once per radius.
//
// COST
// ----
// The mask is *never* rebuilt from scratch in the sim loop. Each viewer caches
// the tile it last stamped and its radius; a viewer that has not changed tile
// costs one Map lookup and two integer compares. Only the handful of units that
// crossed a tile boundary this step (units move at ~1.2 tiles/s against a 20Hz
// step, so ~4% of them per step) pay for a disc removal plus a disc add. See
// visionStats for the measured numbers.

import {
  MAP_W, MAP_H, UNIT_STATS, BUILDING_STATS,
  DEFAULT_UNIT_LOS, DEFAULT_BUILDING_LOS,
} from '../core/constants.js';
import { EV } from '../core/events.js';

// --- Tuning ----------------------------------------------------------------
// The three numbers that used to live here now live in core/constants.js beside
// UNIT_STATS, which is where HANDOFF-vision.md said they belonged: every unit
// states its own `lineOfSight`, every building states one, and the two
// constants imported above are only the fallbacks for an entry that forgets.
// The derivation from attack range is gone with them — the invariant it existed
// to guarantee (sight strictly greater than reach) is now checked per entry and
// asserted over the whole table in tests/military.test.mjs.

/** Counters for tests and debugging. Reset whenever you like. */
export const visionStats = {
  updates: 0,       // update() calls
  viewerAdds: 0,    // discs stamped in
  viewerRemoves: 0, // discs stamped out
  tileWrites: 0,    // per-tile count changes (the real unit of work)
  transitions: 0,   // tiles that actually changed visible state
  lastMs: 0,
  totalMs: 0,
  maxMs: 0,
};

export function resetVisionStats() {
  visionStats.updates = 0;
  visionStats.viewerAdds = 0;
  visionStats.viewerRemoves = 0;
  visionStats.tileWrites = 0;
  visionStats.transitions = 0;
  visionStats.lastMs = 0;
  visionStats.totalMs = 0;
  visionStats.maxMs = 0;
}

const nowMs = () =>
  (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// --- Radii ------------------------------------------------------------------

/** Vision radius in whole tiles for a unit type. */
export function unitLineOfSight(type) {
  const s = UNIT_STATS[type];
  if (!s) return DEFAULT_UNIT_LOS;
  return s.lineOfSight || DEFAULT_UNIT_LOS;
}

/**
 * Vision radius in whole tiles for a building type, footprint included.
 *
 * A building is not a point: a Town Center is 3x3, so measuring from the centre
 * tile would have its stated 8 tiles of sight cover only 6.5 tiles of ground
 * past its own wall. Half the footprint is added back.
 */
export function buildingLineOfSight(type) {
  const s = BUILDING_STATS[type];
  if (!s) return DEFAULT_BUILDING_LOS;
  const los = s.lineOfSight || DEFAULT_BUILDING_LOS;
  const half = Math.floor(Math.max(s.fw || 1, s.fh || 1) / 2);
  return los + half;
}

/** Radius of whatever `e` is, or 0 if it is not a viewer at all. */
function radiusOf(e) {
  if (e.kind === 'unit') return unitLineOfSight(e.type);
  if (e.kind === 'building') return buildingLineOfSight(e.type);
  return 0;
}

// --- Disc tables ------------------------------------------------------------
//
// One entry per radius, shared by every world and every player: a flat
// Int32Array of (dy, dx0, dx1) triples. Walking rows and clamping the run
// against the map beats a nested dx/dy loop with a bounds test and a sqrt per
// tile, which is what this replaced — the inner loop below has no branches in
// it at all beyond the count compare.
//
// WHY THE DISC IS NOT A DISC
// --------------------------
// A circle in grid space is not a circle on screen. The projection is
// wx = (gx - gy) * 32, wy = (gx + gy) * 16, so a viewer with r tiles of sight
// lights an *ellipse* 90r pixels wide and 45r tall — exactly twice as wide as
// it is tall. On a portrait phone that is the wrong way round: the viewport is
// 390 wide and 844 tall, so the shape vision paints is squashed along the axis
// the player has the most screen on. A base sitting in the middle of the view
// can never light the top or the bottom of it, and a luminance measurement of
// the map window found 46% of it black at t=0 and *still* 46% black at 210s
// with the economy running normally — the fog was not hiding the map, the
// projection was.
//
// The fix is to stretch the mask along the grid diagonal gx+gy, which is the
// axis that maps to screen vertical. DILATE tiles are added to that semi-axis
// and nothing is taken off the other, so this only ever reveals more: no
// position that could see a tile before can fail to see it now, which keeps
// every existing expectation about sight range true.
//
// It is deliberately a partial correction. Making the lit region a true screen
// circle needs a = 2r, which doubles the area a viewer reveals — that is a
// different game, with fog that barely functions. A single tile of dilation
// takes the on-screen aspect from 2.0 down to about 1.6 at a villager's sight.
//
// Cost, measured with the 150-viewer stress in tests/vision.test.mjs: 68431
// tile writes over 41 updates before, 83725 after, and the steady state moved
// from 0.120ms/step to 0.121ms. The extra tiles are written inside a loop that
// was already running with the same bounds check and the same array, so they
// are close to free; what would not be free is a second pass, and there is not
// one — the shape is baked into the cached row table at the radius it is first
// asked for.
const DILATE = 1;

const DISC_CACHE = new Map();

function discRows(r) {
  let rows = DISC_CACHE.get(r);
  if (rows) return rows;
  // Semi-axes of the ellipse, in tiles: `a` along (gx+gy), `b` along (gx-gy).
  const a = r + DILATE;
  const b = r;
  const A = 1 / (a * a);
  const B = 1 / (b * b);
  // With u = (dx+dy)/sqrt2 and v = (dx-dy)/sqrt2, the ellipse u^2/a^2 +
  // v^2/b^2 <= 1 expands to a plain quadratic in dx for each row:
  //     P*dx^2 + Q*dx + R <= 0
  const P = (A + B) / 2;
  const out = [];
  // The tallest the rotated ellipse ever gets is sqrt((a^2+b^2)/2).
  const maxDy = Math.ceil(Math.sqrt((a * a + b * b) / 2));
  for (let dy = -maxDy; dy <= maxDy; dy++) {
    const Q = (A - B) * dy;
    const R = P * dy * dy - 1;
    const disc = Q * Q - 4 * P * R;
    if (disc < 0) continue;
    const root = Math.sqrt(disc);
    const x0 = Math.ceil((-Q - root) / (2 * P));
    const x1 = Math.floor((-Q + root) / (2 * P));
    if (x1 < x0) continue;
    out.push(dy, x0, x1);
  }
  rows = Int32Array.from(out);
  DISC_CACHE.set(r, rows);
  return rows;
}

// --- Per-player state -------------------------------------------------------

function makeState(n) {
  return {
    // 1 where a viewer covers the tile right now.
    visible: new Uint8Array(n),
    // 1 once the tile has ever been visible. Never cleared.
    explored: new Uint8Array(n),
    // How many viewers cover the tile. `visible` is just (count > 0), kept
    // alongside so consumers get the flat Uint8Array the renderer wants without
    // a widening read per tile.
    count: new Uint16Array(n),
    // Remembered static objects, dense so the renderer can walk it by index.
    memory: [],
    // id -> index into `memory`, for O(1) removal by swap-pop.
    memoryIndex: new Map(),
    // Which remembered object owns each tile (0 = none). This is what lets a
    // tile coming back into view notice that the thing it remembers is gone.
    memoryTile: new Int32Array(n),
    // Bumped on every mask change, so the fog texture and the minimap can skip
    // their rebuild when nothing has moved.
    revision: 1,
  };
}

/**
 * Build the vision system for a world. Call `update()` once per sim step.
 *
 * Masks are maintained for *every* player, not just the human one, so the enemy
 * AI can be made honest later without touching this file. Nothing here reads
 * or enforces who is allowed to know what; it only answers the question.
 */
export function createVision(world) {
  const W = world.width || MAP_W;
  const H = world.height || MAP_H;
  const N = W * H;

  const states = world.players.map(() => makeState(N));

  // id -> { player, tx, ty, r, gen }. The cache that makes the update
  // incremental: a viewer whose tile and radius are unchanged is skipped.
  const viewers = new Map();
  let gen = 0;

  // --- mask writes ---------------------------------------------------------

  // The add and remove paths are written out separately rather than sharing one
  // loop with a `delta` in it: this is the hot loop of the whole feature and it
  // is run tens of thousands of times a second, so the sign test belongs outside
  // it, not inside.
  function stampIn(st, tx, ty, r) {
    const rows = discRows(r);
    const { count, visible, explored } = st;
    let changed = 0;
    let writes = 0;
    for (let k = 0; k < rows.length; k += 3) {
      const y = ty + rows[k];
      if (y < 0 || y >= H) continue;
      // The rows are no longer symmetric about the viewer: the ellipse is
      // rotated 45 degrees, so each row carries its own left and right offset.
      let x0 = tx + rows[k + 1];
      let x1 = tx + rows[k + 2];
      if (x0 < 0) x0 = 0;
      if (x1 >= W) x1 = W - 1;
      const base = y * W;
      for (let x = x0; x <= x1; x++) {
        const i = base + x;
        writes++;
        if (++count[i] !== 1) continue;
        visible[i] = 1;
        changed++;
        if (!explored[i]) explored[i] = 1;
        onReveal(st, i);
      }
    }
    visionStats.tileWrites += writes;
    visionStats.transitions += changed;
    if (changed) st.revision++;
  }

  function stampOut(st, tx, ty, r) {
    const rows = discRows(r);
    const { count, visible } = st;
    let changed = 0;
    let writes = 0;
    for (let k = 0; k < rows.length; k += 3) {
      const y = ty + rows[k];
      if (y < 0 || y >= H) continue;
      let x0 = tx + rows[k + 1];
      let x1 = tx + rows[k + 2];
      if (x0 < 0) x0 = 0;
      if (x1 >= W) x1 = W - 1;
      const base = y * W;
      for (let x = x0; x <= x1; x++) {
        const i = base + x;
        writes++;
        // The counts are only ever decremented with the same tile, radius and
        // player they were incremented with, so this cannot underflow. The
        // clamp is here because a Uint16 that *did* underflow would wrap to
        // 65535 and pin the tile bright for the rest of the match — a silent,
        // permanent map hack is not a failure mode worth risking one compare.
        if (count[i] === 0) continue;
        if (--count[i] !== 0) continue;
        visible[i] = 0;
        changed++;
        onConceal(st, i);
      }
    }
    visionStats.tileWrites += writes;
    visionStats.transitions += changed;
    if (changed) st.revision++;
  }

  // --- object memory -------------------------------------------------------
  //
  // Memory is written at exactly one moment: the instant a tile stops being
  // visible. That is both the cheapest place for it (we are already walking
  // those tiles) and the *correct* place — what you remember is what was there
  // when you looked away, which is the whole point of the feature.
  //
  // Nothing here ever stores the live entity. A snapshot copies the handful of
  // fields the renderer needs; a building that is freed a second later cannot
  // drag its ghost's hit points to zero behind our back, and a tree that is
  // chopped down out of sight keeps the size it had when you last saw it.

  /**
   * Copy the fields a ghost needs out of a live entity.
   *
   * `into` lets a tile that goes dark again refresh an existing snapshot in
   * place. That matters more than it looks: a unit crossing one tile boundary
   * conceals a dozen tiles, and in the forests that cover most of this map most
   * of those tiles hold a tree we already remember. Allocating a fresh object
   * and a fresh tile array for each of them turned a free feature into steady
   * garbage at 20Hz.
   */
  function snapshot(e, into) {
    const s = into || { tiles: [] };
    const tiles = s.tiles;
    tiles.length = 0;
    if (e.kind === 'building' && e.tiles) {
      for (const [tx, ty] of e.tiles) {
        if (tx >= 0 && ty >= 0 && tx < W && ty < H) tiles.push(ty * W + tx);
      }
    } else {
      const tx = Math.floor(e.x);
      const ty = Math.floor(e.y);
      if (tx >= 0 && ty >= 0 && tx < W && ty < H) tiles.push(ty * W + tx);
    }
    s.id = e.id;
    s.kind = e.kind;
    s.type = e.type;
    s.player = e.player === undefined ? null : e.player;
    s.x = e.x;
    s.y = e.y;
    s.fw = e.fw || 1;
    s.fh = e.fh || 1;
    s.variant = e.variant || 0;
    s.complete = e.complete !== false;
    s.buildProgress = e.buildProgress || 0;
    s.buildTime = e.buildTime || 1;
    s.hp = e.hp || 0;
    s.maxHp = e.maxHp || 1;
    // Resource nodes and farms both carry these; the renderer sizes its ghost
    // from them so a nearly-worked-out tree still looks nearly worked out.
    s.amount = typeof e.amount === 'number' ? e.amount : undefined;
    s.maxAmount = typeof e.maxAmount === 'number' ? e.maxAmount : undefined;
    // A farm's remaining food is owned by economy.js and has gone by three
    // different field names during this sprint. The renderer already copes with
    // all of them (see farmStage in render.js); copy whichever one is there
    // rather than have a remembered farm always look freshly sown.
    s.remaining = typeof e.remaining === 'number' ? e.remaining : undefined;
    s.resourceLeft = typeof e.resourceLeft === 'number' ? e.resourceLeft : undefined;
    s.depleted = !!(e.depleted || e.exhausted || e.spent);
    return s;
  }

  function forget(st, id) {
    const idx = st.memoryIndex.get(id);
    if (idx === undefined) return;
    const snap = st.memory[idx];
    for (const t of snap.tiles) {
      if (st.memoryTile[t] === id) st.memoryTile[t] = 0;
    }
    const last = st.memory.length - 1;
    if (idx !== last) {
      st.memory[idx] = st.memory[last];
      st.memoryIndex.set(st.memory[idx].id, idx);
    }
    st.memory.pop();
    st.memoryIndex.delete(id);
    st.revision++;
  }

  function remember(st, e) {
    const prev = st.memoryIndex.get(e.id);
    const snap = snapshot(e, prev === undefined ? null : st.memory[prev]);
    if (!snap.tiles.length) return;
    // Anything else claiming one of these tiles is out of date by definition.
    for (const t of snap.tiles) {
      const other = st.memoryTile[t];
      if (other && other !== e.id) forget(st, other);
    }
    // Re-read the index: forget() compacts by swapping the last entry down, so
    // our own row may have moved while we were clearing someone else's.
    const idx = st.memoryIndex.get(e.id);
    if (idx === undefined) {
      st.memoryIndex.set(e.id, st.memory.length);
      st.memory.push(snap);
    } else {
      st.memory[idx] = snap;
    }
    for (const t of snap.tiles) st.memoryTile[t] = e.id;
    st.revision++;
  }

  /** A tile just became visible: whatever we remembered had better still be there. */
  function onReveal(st, i) {
    const remembered = st.memoryTile[i];
    if (!remembered) return;
    if (world.occupant[i] !== remembered) forget(st, remembered);
  }

  /** A tile just stopped being visible: commit what was standing on it. */
  function onConceal(st, i) {
    const occ = world.occupant[i];
    if (!occ) {
      // Nothing there. If we were still remembering something on this tile it
      // died while we were watching and the REMOVED handler already dealt with
      // it, but clear it rather than trust that.
      const stale = st.memoryTile[i];
      if (stale) forget(st, stale);
      return;
    }
    const e = world.entities.get(occ);
    if (!e || e.dead) return;
    if (e.kind !== 'building' && e.kind !== 'resource') return;
    remember(st, e);
  }

  // A static object leaving the world. If any player can see it happen, that
  // player's memory of it goes too; for everyone else the snapshot taken when
  // they looked away survives, which is the ghost. world.js has already cleared
  // world.occupant by the time this fires, so the tiles come off the entity.
  const offRemoved = world.events.on(EV.REMOVED, (p) => {
    const e = p && p.entity;
    if (!e) return;
    if (e.kind !== 'building' && e.kind !== 'resource') return;
    const tiles = tileIndicesOf(e);
    for (const st of states) {
      let seen = false;
      for (const t of tiles) {
        if (st.visible[t]) { seen = true; break; }
      }
      if (seen) forget(st, e.id);
    }
  });

  function tileIndicesOf(e) {
    const out = [];
    if (e.kind === 'building' && e.tiles) {
      for (const [tx, ty] of e.tiles) {
        if (tx >= 0 && ty >= 0 && tx < W && ty < H) out.push(ty * W + tx);
      }
    } else {
      const tx = Math.floor(e.x);
      const ty = Math.floor(e.y);
      if (tx >= 0 && ty >= 0 && tx < W && ty < H) out.push(ty * W + tx);
    }
    return out;
  }

  // --- viewers -------------------------------------------------------------

  function touch(e) {
    const player = e.player;
    if (player === null || player === undefined) return;
    const st = states[player];
    if (!st) return;
    const r = radiusOf(e);
    if (r <= 0) return;
    let tx = Math.floor(e.x);
    let ty = Math.floor(e.y);
    // A unit shoved off the map by separation steering should still see from
    // the edge rather than blink the whole disc off.
    if (tx < 0) tx = 0; else if (tx >= W) tx = W - 1;
    if (ty < 0) ty = 0; else if (ty >= H) ty = H - 1;

    const v = viewers.get(e.id);
    if (v === undefined) {
      viewers.set(e.id, { player, tx, ty, r, gen });
      stampIn(st, tx, ty, r);
      visionStats.viewerAdds++;
      return;
    }
    v.gen = gen;
    if (v.tx === tx && v.ty === ty && v.r === r && v.player === player) return;
    stampOut(states[v.player], v.tx, v.ty, v.r);
    visionStats.viewerRemoves++;
    v.player = player;
    v.tx = tx;
    v.ty = ty;
    v.r = r;
    stampIn(st, tx, ty, r);
    visionStats.viewerAdds++;
  }

  /**
   * Recompute the visible masks. Cheap when nothing moved — call it every sim
   * step and stop thinking about it.
   */
  function update() {
    const t0 = nowMs();
    gen++;

    const units = world.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u.dead) touch(u);
    }
    const blds = world.buildings;
    for (let i = 0; i < blds.length; i++) {
      const b = blds[i];
      if (!b.dead) touch(b);
    }

    // Anything not touched this pass is gone (dead, or removed between steps).
    // The sweep is over the viewer map, not the map grid: ~160 entries against
    // 9216 tiles.
    if (viewers.size) {
      let stale = null;
      for (const [id, v] of viewers) {
        if (v.gen !== gen) (stale || (stale = [])).push(id);
      }
      if (stale) {
        for (const id of stale) {
          const v = viewers.get(id);
          stampOut(states[v.player], v.tx, v.ty, v.r);
          visionStats.viewerRemoves++;
          viewers.delete(id);
        }
      }
    }

    const ms = nowMs() - t0;
    visionStats.updates++;
    visionStats.lastMs = ms;
    visionStats.totalMs += ms;
    if (ms > visionStats.maxMs) visionStats.maxMs = ms;
  }

  // --- queries -------------------------------------------------------------

  const state = (playerId) => states[playerId];

  function isVisible(playerId, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    return states[playerId].visible[ty * W + tx] === 1;
  }

  function isExplored(playerId, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    return states[playerId].explored[ty * W + tx] === 1;
  }

  /** True when any tile the entity stands on is visible to `playerId`. */
  function entityVisible(playerId, e) {
    const st = states[playerId];
    if (!st) return true;
    if (e.kind === 'building' && e.tiles) {
      for (const [tx, ty] of e.tiles) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        if (st.visible[ty * W + tx]) return true;
      }
      return false;
    }
    const tx = Math.floor(e.x);
    const ty = Math.floor(e.y);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    return st.visible[ty * W + tx] === 1;
  }

  /** The remembered snapshot standing on a tile, or null. Never a live entity. */
  function rememberedAt(playerId, tx, ty) {
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return null;
    const st = states[playerId];
    const id = st.memoryTile[ty * W + tx];
    if (!id) return null;
    const idx = st.memoryIndex.get(id);
    return idx === undefined ? null : st.memory[idx];
  }

  /**
   * Rebuild a player's visible mask from nothing. The incremental path is the
   * one the game uses; this exists so tests can prove the two agree, and so a
   * future "reveal map" cheat has something honest to call.
   */
  function recomputeFromScratch(playerId) {
    const count = new Uint16Array(N);
    const visible = new Uint8Array(N);
    const add = (tx, ty, r) => {
      const rows = discRows(r);
      for (let k = 0; k < rows.length; k += 3) {
        const y = ty + rows[k];
        if (y < 0 || y >= H) continue;
        const x0 = Math.max(0, tx + rows[k + 1]);
        const x1 = Math.min(W - 1, tx + rows[k + 2]);
        for (let x = x0; x <= x1; x++) {
          const i = y * W + x;
          count[i]++;
          visible[i] = 1;
        }
      }
    };
    const consider = (e) => {
      if (e.dead || e.player !== playerId) return;
      const r = radiusOf(e);
      if (r <= 0) return;
      const tx = Math.min(W - 1, Math.max(0, Math.floor(e.x)));
      const ty = Math.min(H - 1, Math.max(0, Math.floor(e.y)));
      add(tx, ty, r);
    };
    for (const u of world.units) consider(u);
    for (const b of world.buildings) consider(b);
    return { count, visible };
  }

  function destroy() {
    offRemoved();
    viewers.clear();
  }

  // --- Save and load --------------------------------------------------------
  //
  // Two of the six per-player arrays are written, and the other four are not,
  // because only two of them are *facts*:
  //
  //   explored   history. Nothing can re-derive it — it is the record of
  //              everywhere this player has ever been, and losing it would hand
  //              a resumed match a black map it had already paid to open.
  //   memory     the ghosts. Also history, and by construction they describe
  //              buildings and trees that may no longer exist, so they cannot be
  //              rebuilt from the world either.
  //
  // `visible`, `count`, `memoryTile` and the viewer cache are all *derived from
  // where the units are standing right now*, and the units are restored before
  // this is called. So they are left empty and the first update() after a load
  // stamps every viewer in from scratch — which is exactly what the first
  // update() of a fresh match does, and is the one code path that cannot drift
  // from the incremental one.

  function serialize() {
    return states.map((st) => ({
      explored: st.explored.slice(),
      // The snapshots are plain data already (see snapshot()), but they are
      // pooled and reused in place, so they are copied rather than referenced.
      memory: st.memory.map((s) => ({ ...s, tiles: s.tiles.slice() })),
    }));
  }

  function restore(data) {
    if (!Array.isArray(data)) return;
    for (let i = 0; i < states.length; i++) {
      const st = states[i];
      const rec = data[i];
      st.visible.fill(0);
      st.count.fill(0);
      st.memoryTile.fill(0);
      st.memory.length = 0;
      st.memoryIndex.clear();
      st.explored.fill(0);
      if (!rec) continue;
      if (rec.explored && rec.explored.length === N) st.explored.set(rec.explored);
      for (const snap of rec.memory || []) {
        if (!snap || !Array.isArray(snap.tiles) || !snap.tiles.length) continue;
        st.memoryIndex.set(snap.id, st.memory.length);
        st.memory.push(snap);
        for (const t of snap.tiles) if (t >= 0 && t < N) st.memoryTile[t] = snap.id;
      }
      st.revision++;
    }
    // Every viewer must be stamped in again from nothing: the cache maps a
    // viewer to the tile it last stamped, and after a load nothing has been
    // stamped at all.
    viewers.clear();
  }

  /**
   * Write the fog alpha field for a player into the alpha bytes of an RGBA
   * buffer sized MAP_W x MAP_H — one texel per tile, ready to be uploaded and
   * stretched over the map.
   *
   * This lives here, in the sim file, rather than in the renderer for one
   * reason: the main view and the minimap both draw fog, and if they compute it
   * separately they will eventually disagree about where an edge is. It is pure
   * arithmetic over the masks, no Phaser, no canvas.
   *
   * The blur is the part that earns its keep. Raw, one texel per tile, bilinear
   * filtering gives the edge exactly one tile of ramp — 45 pixels across the
   * screen but only 22 down it, which is short enough that the boundary reads
   * as a staircase of diamonds rather than as fog. One separable 1-2-1 pass
   * widens the ramp to roughly two and a half tiles in every direction, which is
   * where it stops looking like geometry and starts looking like weather. Out
   * of bounds counts as unexplored, so the coastline ramps into the black sea
   * instead of ending on a hard line at the map edge.
   */
  function writeFogAlpha(playerId, rgba, exploredByte, blur = true) {
    const st = states[playerId];
    const { visible, explored } = st;
    if (!fogRaw) {
      fogRaw = new Uint8Array(N);
      fogTmp = new Uint8Array(N);
    }
    const raw = fogRaw;
    for (let i = 0; i < N; i++) {
      raw[i] = visible[i] ? 0 : explored[i] ? exploredByte : 255;
    }
    if (!blur) {
      for (let i = 0, p = 3; i < N; i++, p += 4) rgba[p] = raw[i];
      return;
    }
    const tmp = fogTmp;
    for (let y = 0; y < H; y++) {
      const base = y * W;
      for (let x = 0; x < W; x++) {
        const i = base + x;
        const l = x > 0 ? raw[i - 1] : 255;
        const r = x < W - 1 ? raw[i + 1] : 255;
        tmp[i] = (l + raw[i] * 2 + r + 2) >> 2;
      }
    }
    for (let y = 0; y < H; y++) {
      const base = y * W;
      for (let x = 0; x < W; x++) {
        const i = base + x;
        const u = y > 0 ? tmp[i - W] : 255;
        const d = y < H - 1 ? tmp[i + W] : 255;
        rgba[i * 4 + 3] = (u + tmp[i] * 2 + d + 2) >> 2;
      }
    }
  }

  let fogRaw = null;
  let fogTmp = null;

  return {
    width: W,
    height: H,
    states,
    state,
    update,
    isVisible,
    isExplored,
    entityVisible,
    rememberedAt,
    recomputeFromScratch,
    writeFogAlpha,
    serialize,
    restore,
    destroy,
    // Exposed for tests and for anyone who wants to reason about the cache.
    _viewers: viewers,
  };
}
