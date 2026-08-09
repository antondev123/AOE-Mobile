// Touch input: selection, orders, camera and building placement.
//
// The renderer installs no pointer handlers — every gesture on the map is
// resolved here, from raw PointerEvents on the Phaser canvas, so multi-touch
// stays under one state machine instead of being split across libraries.
//
// ---------------------------------------------------------------------------
// GESTURE MODEL (the whole point of this file)
//
//   1 finger, released without moving past TAP_SLOP     -> TAP
//   1 finger, dragged past DRAG_BOX_THRESHOLD           -> PAN or BOX
//   1 finger, held still past TAP_TIME_MS               -> arms BOX (always)
//   2 fingers                                           -> PAN + PINCH ZOOM
//
// The box armed by a long press collapses back into a tap if the finger lifts
// without drawing a real rectangle, so those two rules never fight and no press
// duration is ever ignored.
//
// PAN or BOX for a one-finger drag is decided by a single variable, so it is
// always predictable and is always shown on the HUD's mode chip:
//
//   nothing of yours selected -> PAN   (you are looking around)
//   something of yours selected -> BOX (you are picking troops; pan with two
//                                       fingers, exactly as the brief asks)
//
// WHAT A TAP MEANS depends only on what is selected, which is always on screen:
//
//   units selected      -> ground = move, resource = gather, enemy = attack
//   a producer selected -> ground = rally, resource / your farm / your
//                          foundation = rally onto it (a standing work order),
//                          and those outrank a villager standing on them, so
//                          the bush you are already working is rally-able
//   nothing in hand     -> select what you tapped
//
// Two HUD buttons can arm the next tap instead — building placement and
// attack-move. Both say so with a bar across the bottom of the screen, both
// are cancellable, and neither survives being used.
//
// One armed mode takes the *drag* rather than the tap: a wall. With a wall type
// armed, a one-finger drag draws the whole run of segments under the finger and
// lifting buys them (see the wall-drawing section below). It is its own pointer
// mode, so it never has to argue with pan or box-select about who owns a drag,
// and two fingers still pan and zoom exactly as they always did — which doubles
// as the way to abandon a run half-drawn.
//
// The player can lock either mode from the chip, and a long press always gets
// a box even when the rule says pan — so no situation is unreachable. Adding a
// second finger mid-gesture always cancels a box and becomes a pinch, which
// means an accidental extra finger never eats your selection.
// ---------------------------------------------------------------------------

import {
  TAP_SLOP, TAP_TIME_MS, DRAG_BOX_THRESHOLD, TAP_PICK_RADIUS,
  ZOOM_MIN, ZOOM_MAX, MAP_W, MAP_H, HALF_W, HALF_H,
  PLAYER, BUILDING_STATS, isWallType, MILITARY_TYPES,
} from '../core/constants.js';
import { EV } from '../core/events.js';
import { screenDist, worldToGrid } from '../core/iso.js';
import { canPlace, wallMaskAt } from '../core/world.js';

import * as unitAI from '../systems/unitAI.js';
import * as economy from '../systems/economy.js';

import { setSelection, clearSelection, selectedEntities } from './selection.js';
import { rallyText } from './hud.js';

// --- Tuning that is local to gesture handling (the shared feel numbers live
// in core/constants.js and must not be duplicated there). --------------------
// A stationary press arms the box the moment it stops being a tap, so there is
// never a duration that does nothing at all.
const LONG_PRESS_MS = TAP_TIME_MS;
// Generous by design: two quick taps on your own unit can only mean "give me
// all of these", so a wide window costs nothing and forgives slow thumbs.
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_SLOP = 34;
// The finger hides the target, so the placement ghost sits this far above it.
const GHOST_LIFT = 62;
// A second pick probe this far below the touch compensates for sprites being
// drawn above their tile: you tap a unit's chest, its feet own the tile.
const PICK_PROBE_DOWN = 15;
// How much closer a lower-ranked entity must be before it beats the preference
// order (own units > own buildings > enemies > resources). Screen px.
const TIER_SLACK = 14;
const INERTIA_DAMP = 5.5;      // e-folds per second
const INERTIA_MIN = 12;        // world px/s below which we stop
const VELOCITY_WINDOW_MS = 90;
const SAMPLE_KEEP = 8;
// A finger that has been still for this long before lifting does not fling.
const REST_MS = 200;
const MAX_FLING = 4200;       // world px/s

// Derived from the roster, never written out. When this was a hand-written
// pair the spearman, scout and ram were silently excluded from attack-move and
// from double-tap "select every soldier like this one" the day they shipped —
// the kind of omission that reads as a broken command rather than a missing
// unit, because the units exist and simply refuse the order.
const MILITARY = new Set(MILITARY_TYPES);

export function createInput(scene, world, renderer, hud) {
  const game = scene.game;
  const canvas = game.canvas;
  const camera = (renderer && renderer.camera) || scene.cameras.main;

  // World-pixel bounds of the playable diamond (see core/iso.js).
  const BOUNDS = {
    minX: -MAP_H * HALF_W,
    maxX: MAP_W * HALF_W,
    minY: 0,
    maxY: (MAP_W + MAP_H) * HALF_H,
  };

  const st = {
    pointers: new Map(),     // pointerId -> tracked pointer
    order: [],               // pointer ids in the order they went down
    mode: 'none',            // none | tap | pan | box | pinch | place
    dragPref: 'auto',        // auto | pan | box
    anchor: null,            // { x, y, t } of the primary pointer
    box: null,               // { x, y, w, h } screen-space
    pinch: null,
    vel: { x: 0, y: 0 },
    samples: [],
    lastTap: null,
    ghost: null,             // { type, gx, gy, valid }
    placeType: null,
    wall: null,              // { tx0, ty0, tx1, ty1, plan, tiles } while drawing
    driving: false,
    destroyed: false,
  };

  // Camera centre in world pixels — this module owns it.
  let cx = camera.midPoint ? camera.midPoint.x : 0;
  let cy = camera.midPoint ? camera.midPoint.y : 0;

  // ---------------------------------------------------------------- geometry

  function gamePoint(ev) {
    const r = canvas.getBoundingClientRect();
    const sx = r.width ? ((ev.clientX - r.left) * (game.scale.gameSize.width / r.width)) : 0;
    const sy = r.height ? ((ev.clientY - r.top) * (game.scale.gameSize.height / r.height)) : 0;
    return { x: sx, y: sy };
  }

  function toGrid(sx, sy) {
    if (renderer && typeof renderer.screenToGrid === 'function') {
      const g = renderer.screenToGrid(sx, sy);
      if (g && Number.isFinite(g.x)) return g;
    }
    const z = camera.zoom || 1;
    const wx = cx + (sx - camera.width / 2) / z;
    const wy = cy + (sy - camera.height / 2) / z;
    return worldToGrid(wx, wy);
  }

  function toScreen(gx, gy) {
    if (renderer && typeof renderer.gridToScreen === 'function') {
      const p = renderer.gridToScreen(gx, gy);
      if (p && Number.isFinite(p.x)) return p;
    }
    const z = camera.zoom || 1;
    const wx = (gx - gy) * HALF_W;
    const wy = (gx + gy) * HALF_H;
    return { x: (wx - cx) * z + camera.width / 2, y: (wy - cy) * z + camera.height / 2 };
  }

  function clampCamera() {
    cx = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, cx));
    cy = Math.max(BOUNDS.minY, Math.min(BOUNDS.maxY, cy));
  }

  function applyCamera() {
    clampCamera();
    camera.centerOn(cx, cy);
    // The renderer may also call camera.setBounds(), which clamps the scroll
    // further. Adopt whatever the camera settled on, otherwise our own centre
    // drifts off-screen and the next drag feels like it does nothing.
    if (camera.useBounds) {
      cx = camera.scrollX + camera.width / 2;
      cy = camera.scrollY + camera.height / 2;
    }
  }

  function centerOnGrid(gx, gy) {
    st.vel.x = 0;
    st.vel.y = 0;
    cx = (gx - gy) * HALF_W;
    cy = (gx + gy) * HALF_H;
    applyCamera();
  }

  function setZoom(z) {
    camera.setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)));
  }

  // ------------------------------------------------------------------ picking

  /** Screen-space gap (in unzoomed px) between a grid point and an entity. */
  function entityGap(e, g) {
    if (e.kind === 'building') {
      const hw = e.fw / 2;
      const hh = e.fh / 2;
      const qx = Math.max(e.x - hw, Math.min(e.x + hw, g.x));
      const qy = Math.max(e.y - hh, Math.min(e.y + hh, g.y));
      return screenDist(qx, qy, g.x, g.y);
    }
    return screenDist(e.x, e.y, g.x, g.y);
  }

  const TIER_COUNT = 5;

  function tierOf(e) {
    if (e.player === PLAYER) return e.kind === 'unit' ? 0 : 1;
    if (e.player !== null && e.player !== undefined) return e.kind === 'unit' ? 2 : 3;
    return 4; // resources
  }

  /**
   * The tier order while a production building is in hand and no units are.
   *
   * Rally targets — a resource node, one of your farms, one of your foundations
   * — come first and everything else shifts down a rank, *including your own
   * units*. Without this the commonest use of rally-to-resource is unreachable:
   * you add newly trained villagers to the bush you are already working, which
   * by definition has one of your villagers standing on it, and that villager
   * wins the tap under the ordinary ranking (see the comment on pickAt).
   *
   * It is still only a ranking, applied within TIER_SLACK: tap the villager
   * itself, more than the slack nearer to it than to the bush, and you select
   * it as before. So nothing becomes unreachable, and the aim always decides
   * when the two are not both under the finger.
   */
  function rallyTierOf(e) {
    if (isRallyTarget(e)) return 0;
    return Math.min(TIER_COUNT - 1, tierOf(e) + 1);
  }

  /**
   * Best entity within TAP_PICK_RADIUS *screen* pixels of the touch.
   *
   * Fat-finger friendly: two probe points, footprint-aware distances, and the
   * preference order own units > own buildings > enemies > resources (or the
   * rally order above, when a producer is in hand — `rank` chooses).
   *
   * The preference is applied within a tolerance rather than absolutely: a
   * better-ranked entity wins only if it is roughly as close to the finger as
   * the nearest thing. Strict ranking would make an enemy standing in a melee
   * with your own troops impossible to tap, which is exactly when you most want
   * to attack it. Within TIER_SLACK the ranking decides; beyond it, aim wins.
   */
  function pickAt(sx, sy, rank = tierOf) {
    const z = camera.zoom || 1;
    const radius = TAP_PICK_RADIUS / z; // compare in unzoomed screen px
    const slack = TIER_SLACK / z;
    const probes = [toGrid(sx, sy), toGrid(sx, sy + PICK_PROBE_DOWN)];
    // Cheap grid-space reject box around both probes.
    const gridPad = radius / HALF_H + 2;

    const bestOf = new Array(TIER_COUNT).fill(null); // one candidate per tier
    let minGap = Infinity;

    const consider = (e) => {
      if (!e || e.dead) return;
      let gap = Infinity;
      for (const g of probes) {
        if (Math.abs(e.x - g.x) > gridPad + (e.fw || 1) || Math.abs(e.y - g.y) > gridPad + (e.fh || 1)) continue;
        const d = entityGap(e, g);
        if (d < gap) gap = d;
      }
      if (gap > radius) return;
      const tier = rank(e);
      if (!bestOf[tier] || gap < bestOf[tier].gap) bestOf[tier] = { e, gap };
      if (gap < minGap) minGap = gap;
    };

    for (const e of world.units) consider(e);
    for (const e of world.buildings) consider(e);
    for (const e of world.resources) consider(e);

    for (const c of bestOf) {
      if (c && c.gap <= minGap + slack) return c.e;
    }
    return null;
  }

  function onScreen(gx, gy, margin = 24) {
    const p = toScreen(gx, gy);
    return p.x >= -margin && p.y >= -margin &&
           p.x <= camera.width + margin && p.y <= camera.height + margin;
  }

  // ---------------------------------------------------------------- commands

  function command(units, order) {
    if (!units.length) return;
    if (typeof unitAI.commandUnits === 'function') unitAI.commandUnits(world, units, order);
  }

  function fx(gx, gy, kind) {
    world.events.emit(EV.COMMAND_FX, { gx, gy, kind });
  }

  function ownSelection() {
    return selectedEntities(world).filter((e) => e.player === PLAYER);
  }

  function clampG(g) {
    return {
      x: Math.max(0, Math.min(MAP_W, g.x)),
      y: Math.max(0, Math.min(MAP_H, g.y)),
    };
  }

  // ------------------------------------------------------------------- rally

  /** A finished building of ours that can actually produce something. */
  function isProducer(e) {
    return e.kind === 'building' && e.complete && e.trains && e.trains.length > 0;
  }

  /** A finished farm of ours with food still in it — a bush you paid wood for. */
  function isOwnFarm(e) {
    return !!(e && e.kind === 'building' && e.player === PLAYER && e.complete &&
      typeof economy.isGatherableBuilding === 'function' &&
      economy.isGatherableBuilding(e));
  }

  /**
   * What a tap means while a production building is in hand:
   *
   *   null      -> bare ground: rally there
   *   entity    -> a resource node, one of our farms, or one of our foundations:
   *                rally *onto it*, which unitAI turns into a standing gather or
   *                build order for everything trained from then on
   *   undefined -> not a rally at all (your own barracks, an enemy, a unit) —
   *                the tap falls through and selects, as it always did
   *
   * The rule is "things a villager could work become rally targets, everything
   * else stays a selection target", which is also why tapping your own Town
   * Center still selects it rather than rallying it onto itself.
   */
  function rallyTargetAt(pick) {
    if (!pick) return null;
    if (pick.kind === 'resource') return pick;
    if (pick.kind === 'building' && pick.player === PLAYER) {
      if (!pick.complete) return pick;
      if (typeof economy.isGatherableBuilding === 'function' &&
          economy.isGatherableBuilding(pick)) return pick;
    }
    return undefined;
  }

  /** Is this entity something a rally could be aimed *onto*? */
  function isRallyTarget(e) {
    const t = rallyTargetAt(e);
    return t !== undefined && t !== null;
  }

  /** pickAt, but ranked for a tap that is allowed to mean "rally onto that". */
  function pickRallyAt(sx, sy) {
    return pickAt(sx, sy, rallyTierOf);
  }

  /**
   * Point every selected producer at `target` (or at the tapped ground).
   *
   * Three things say what happened, and none of them can be confused with a
   * unit order: the ping is blue (CMD_COLOR.rally — a gather *order* pings
   * yellow), the renderer draws the flag line from the building to the point,
   * and the toast names the outcome in words ("Villagers will gather food
   * here"). hud.toast() throttles repeats, so leaning on a bush cannot spam.
   */
  function setRally(producers, target, g) {
    const p = target ? { x: target.x, y: target.y } : clampG(g);
    for (const b of producers) b.rally = { x: p.x, y: p.y };
    fx(p.x, p.y, 'rally');
    hud.toast(rallyText(world, producers, p).text, 'info');
  }

  // ------------------------------------------------------------- attack-move

  function attackArmed() {
    return !!(hud && typeof hud.isAttackArmed === 'function' && hud.isAttackArmed());
  }

  function disarmAttack() {
    if (hud && typeof hud.setAttackArmed === 'function') hud.setAttackArmed(false);
  }

  /**
   * Spend an armed attack-move on this tap. Returns false when there is nothing
   * to send, in which case the tap is handled normally rather than swallowed.
   */
  function fireAttackMove(g) {
    const troops = ownSelection().filter((e) => e.kind === 'unit' && MILITARY.has(e.type));
    disarmAttack();
    if (!troops.length) return false;
    const p = clampG(g);
    command(troops, { type: 'attackMove', gx: p.x, gy: p.y });
    fx(p.x, p.y, 'attack');
    hud.toast(`${troops.length} advancing — they will fight on the way`, 'info');
    return true;
  }

  function issueOrder(units, pick, g) {
    const villagers = units.filter((u) => u.type === 'villager');

    if (!pick) {
      const gx = Math.max(0, Math.min(MAP_W, g.x));
      const gy = Math.max(0, Math.min(MAP_H, g.y));
      command(units, { type: 'move', gx, gy });
      fx(gx, gy, 'move');
      return;
    }

    if (pick.kind === 'resource') {
      if (villagers.length) {
        command(villagers, { type: 'gather', gx: pick.x, gy: pick.y, target: pick });
        const rest = units.filter((u) => u.type !== 'villager');
        if (rest.length) command(rest, { type: 'move', gx: pick.x, gy: pick.y });
        fx(pick.x, pick.y, 'gather');
      } else {
        command(units, { type: 'move', gx: pick.x, gy: pick.y });
        fx(pick.x, pick.y, 'move');
      }
      return;
    }

    if (pick.player !== null && pick.player !== undefined && pick.player !== PLAYER) {
      command(units, { type: 'attack', gx: pick.x, gy: pick.y, target: pick });
      fx(pick.x, pick.y, 'attack');
      return;
    }

    // Own, finished farm: harvest it. A farm is a resource node you paid wood
    // for, so this is the resource branch above, word for word — same order,
    // same yellow gather ping, and the soldiers in a mixed group still just
    // walk there rather than being told to farm.
    if (isOwnFarm(pick) && villagers.length) {
      command(villagers, { type: 'gather', gx: pick.x, gy: pick.y, target: pick });
      const rest = units.filter((u) => u.type !== 'villager');
      if (rest.length) command(rest, { type: 'move', gx: pick.x, gy: pick.y });
      fx(pick.x, pick.y, 'gather');
      return;
    }

    // Own, incomplete building: go finish it.
    if (pick.kind === 'building' && !pick.complete && villagers.length) {
      command(villagers, { type: 'build', gx: pick.x, gy: pick.y, target: pick });
      fx(pick.x, pick.y, 'build');
      return;
    }

    command(units, { type: 'move', gx: pick.x, gy: pick.y });
    fx(pick.x, pick.y, 'move');
  }

  function selectAllOfTypeOnScreen(type) {
    const list = [];
    for (const u of world.units) {
      if (u.dead || u.player !== PLAYER || u.type !== type) continue;
      if (onScreen(u.x, u.y)) list.push(u);
    }
    return list;
  }

  // --------------------------------------------------------------------- tap

  function handleTap(sx, sy) {
    if (st.placeType) { confirmPlacement(); return; }

    const now = performance.now();
    const pick = pickAt(sx, sy);
    const g = toGrid(sx, sy);

    // An armed attack-move owns this tap outright — including a tap that landed
    // on a unit or a bush. Anything else would make "advance here" gamble on
    // what happened to be under your thumb.
    if (attackArmed()) {
      st.lastTap = null;
      if (fireAttackMove(g)) return;
    }

    const isDouble = st.lastTap &&
      now - st.lastTap.t < DOUBLE_TAP_MS &&
      Math.hypot(sx - st.lastTap.x, sy - st.lastTap.y) < DOUBLE_TAP_SLOP;
    st.lastTap = { x: sx, y: sy, t: now };

    // Double-tap a unit: grab every one of that type currently on screen.
    if (isDouble && pick && pick.kind === 'unit' && pick.player === PLAYER) {
      const list = selectAllOfTypeOnScreen(pick.type);
      if (list.length) {
        setSelection(world, list);
        hud.toast(`${list.length} ${pick.type}${list.length === 1 ? '' : 's'} selected`, 'info');
      }
      st.lastTap = null;
      return;
    }

    const own = ownSelection();
    const units = own.filter((e) => e.kind === 'unit');
    const villagers = units.filter((u) => u.type === 'villager');
    const producers = own.filter(isProducer);

    // A tap on a resource is "gather that" when units are in hand and "rally
    // there" when a production building is — the two can never collide, because
    // the selection decides, and the selection is on screen the whole time.
    //
    // This is the macro that matters on a phone: a Town Center hands you a body
    // every 8 seconds, and a rally sitting on the berries is the difference
    // between those villagers working and those villagers standing still.
    //
    // The pick is re-run with the rally ranking rather than reusing `pick`,
    // because the bush you want is nearly always the bush you are already
    // working — and one of your own villagers is standing on that one. Under
    // the ordinary ranking that villager takes the tap, the rally never gets
    // set, and the feature silently does nothing exactly when it is wanted.
    if (!units.length && producers.length) {
      const target = rallyTargetAt(pickRallyAt(sx, sy));
      if (target !== undefined) {
        setRally(producers, target, g);
        return;
      }
    }

    // Tapping something of yours selects it — unless it is a building villagers
    // in hand could obviously *work*: a foundation (go and finish it) or a
    // finished farm (go and harvest it, exactly as for a bush).
    //
    // Both exceptions matter for the same reason: without them the tap silently
    // replaces the whole selection with the building, issues no order and shows
    // nothing, so a dozen villagers stop working and nothing on screen says why.
    // The rule mirrors rallyTargetAt() above and unitAI's rallyOrder(), which
    // both already treat a farm as something a villager works.
    if (pick && pick.player === PLAYER) {
      const workable = pick.kind === 'building' && villagers.length &&
        !world.selection.has(pick.id) &&
        (!pick.complete || isOwnFarm(pick));
      if (workable) {
        issueOrder(units, pick, g);
        return;
      }
      setSelection(world, [pick]);
      return;
    }

    if (units.length === 0) {
      // No units and nothing that produces: a plain selection, or a deselect.
      if (pick) setSelection(world, [pick]);
      else clearSelection(world);
      return;
    }

    issueOrder(units, pick, g);
  }

  // ------------------------------------------------------------- box select

  function startBox(sx, sy) {
    st.mode = 'box';
    st.box = { x: sx, y: sy, w: 0, h: 0 };
    pushBox();
  }

  function updateBox(sx, sy) {
    const a = st.anchor;
    st.box = {
      x: Math.min(a.x, sx),
      y: Math.min(a.y, sy),
      w: Math.abs(sx - a.x),
      h: Math.abs(sy - a.y),
    };
    pushBox();
  }

  function pushBox() {
    if (renderer && typeof renderer.setDragBox === 'function') renderer.setDragBox(st.box);
  }

  function clearBox() {
    st.box = null;
    if (renderer && typeof renderer.setDragBox === 'function') renderer.setDragBox(null);
  }

  function finishBox() {
    const box = st.box;
    clearBox();
    if (!box) return;
    if (box.w < DRAG_BOX_THRESHOLD && box.h < DRAG_BOX_THRESHOLD) {
      // Too small to be a real drag — treat it as a tap where it started.
      handleTap(st.anchor.x, st.anchor.y);
      return;
    }

    const inside = (gx, gy) => {
      const p = toScreen(gx, gy);
      return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
    };

    const hits = [];
    for (const u of world.units) {
      if (u.dead || u.player !== PLAYER) continue; // never grab enemies
      if (inside(u.x, u.y)) hits.push(u);
    }

    // AoE2: a box over a mixed crowd takes the soldiers, not the workers.
    const military = hits.filter((u) => MILITARY.has(u.type));
    let picked = military.length ? military : hits;

    if (!picked.length) {
      // No units under the box — fall back to your buildings.
      for (const b of world.buildings) {
        if (b.dead || b.player !== PLAYER) continue;
        if (inside(b.x, b.y)) picked.push(b);
      }
    }

    if (picked.length) {
      setSelection(world, picked);
      const kind = military.length ? 'soldiers' : picked[0].kind === 'building' ? 'buildings' : 'units';
      hud.toast(`${picked.length} ${kind} selected`, 'info');
    } else {
      clearSelection(world);
    }
  }

  // --------------------------------------------------------------- placement

  /**
   * Why this tile would be refused, or null when it would be taken — the exact
   * predicate placeFoundation() applies, so the ghost and the rule can never
   * disagree. canPlace() alone is not it: it answers "is the ground empty",
   * which went green on the farm that sealed eight villagers into a pocket.
   *
   * CACHED, because this runs on every pointermove while the finger drags the
   * ghost around and the reachability half does a bounded flood fill (~0.08ms
   * against a mid-game base, against ~0.001ms for canPlace alone). The answer
   * can only change when the tile under the finger changes or when the world
   * moves on, so it is recomputed per tile per simulation step and reused for
   * every pointer event in between — a drag costs one check per tile, not one
   * per event, and a finger held still costs nothing at all.
   */
  let placeCache = null; // { key, tick, reason }
  function refusalFor(type, gx, gy) {
    const key = `${type}:${gx}:${gy}`;
    if (placeCache && placeCache.key === key && placeCache.tick === world.tick) {
      return placeCache.reason;
    }
    const s = BUILDING_STATS[type];
    let reason;
    if (typeof economy.placementRefusal === 'function') {
      reason = economy.placementRefusal(world, PLAYER, type, gx, gy);
    } else {
      reason = s && canPlace(world, gx, gy, s.fw, s.fh) ? null : 'Cannot build there';
    }
    placeCache = { key, tick: world.tick, reason };
    return reason;
  }

  function ghostAt(sx, sy) {
    const type = st.placeType;
    const s = BUILDING_STATS[type];
    if (!s) return null;
    const g = toGrid(sx, sy - GHOST_LIFT);
    // Snap exactly the way spawnBuilding() will, so the ghost never lies.
    //
    // The nudge is not cosmetic. Aiming at a tile corner inverts to a grid
    // coordinate a fraction of an ulp below the integer, and floor() then
    // charges that whole error to the tile: aim at exactly 5 and the footprint
    // lands on 4. A finger rarely hits a corner to the pixel, but the placement
    // bar's centre-screen ghost does it every time it opens, so the building
    // you are shown before you move your thumb was consistently one tile up
    // and left of the one you were aiming at.
    const EPS = 1e-6;
    const gx = Math.floor(g.x + EPS - s.fw / 2) + s.fw / 2;
    const gy = Math.floor(g.y + EPS - s.fh / 2) + s.fh / 2;
    // Being broke outranks the ground being wrong, as it always has: it is the
    // thing the player has to fix first, and it is true of every tile.
    const reason = canAffordType(type) ? refusalFor(type, gx, gy) : 'Not enough resources';
    return { type, gx, gy, valid: !reason, reason: reason || null };
  }

  function canAffordType(type) {
    const cost = BUILDING_STATS[type] && BUILDING_STATS[type].cost;
    if (typeof economy.canAfford === 'function') return economy.canAfford(world, PLAYER, cost);
    const r = world.players[PLAYER].resources;
    for (const k of Object.keys(cost || {})) if ((cost[k] || 0) > (r[k] || 0)) return false;
    return true;
  }

  function pushGhost() {
    if (renderer && typeof renderer.setPlacementGhost === 'function') {
      if (st.ghost) renderer.setPlacementGhost(st.ghost.type, st.ghost.gx, st.ghost.gy, st.ghost.valid);
      else renderer.setPlacementGhost(null, 0, 0, false);
    }
  }

  function moveGhost(sx, sy) {
    st.ghost = ghostAt(sx, sy);
    pushGhost();
  }

  function confirmPlacement() {
    const gh = st.ghost;
    if (!gh) return;
    if (!gh.valid) {
      // The ghost has already worked out why, and says so in the same words
      // placeFoundation() would. Refusing here rather than letting the economy
      // refuse again is what keeps one tap to one explanation.
      hud.toast(gh.reason || 'Cannot build there', 'warn');
      return; // stay in placement mode — the player just needs to move a bit
    }
    if (typeof economy.placeFoundation !== 'function') return;
    const f = economy.placeFoundation(world, PLAYER, gh.type, gh.gx, gh.gy);
    if (!f) return; // economy already explained why

    if (typeof economy.enqueueFoundation === 'function') economy.enqueueFoundation(world, f);
    fx(f.x, f.y, 'build');

    // Only send builders when nobody is already building. A batch is placed
    // faster than it is built, and re-ordering the same crew onto every new
    // site as it lands would walk them off the half-finished house to the one
    // you just tapped, over and over — the fifth tap would leave four
    // foundations standing and one villager sprinting. They work the queue
    // through instead (onJobFinished in unitAI.js), and the only thing this has
    // to guarantee is that *somebody* starts.
    if (!anyBuilding()) {
      let builders = ownSelection().filter((e) => e.kind === 'unit' && e.type === 'villager');
      if (!builders.length) {
        // Nothing selected? Send the nearest villager rather than doing nothing.
        let best = null;
        let bd = Infinity;
        for (const u of world.units) {
          if (u.dead || u.player !== PLAYER || u.type !== 'villager') continue;
          const d = (u.x - f.x) ** 2 + (u.y - f.y) ** 2;
          if (d < bd) { bd = d; best = u; }
        }
        if (best) builders = [best];
      }
      command(builders, { type: 'build', gx: f.x, gy: f.y, target: f });
    }

    // Placement stays armed: the next tap places the next one. `Done` on the
    // placement bar (or Escape, or the build menu) is what ends the batch.
    if (hud && typeof hud.onFoundationPlaced === 'function') hud.onFoundationPlaced(1);
    syncPlacement();
  }

  /** Is any villager of ours already on a construction site? */
  function anyBuilding() {
    for (const u of world.units) {
      if (u.dead || u.player !== PLAYER || u.type !== 'villager') continue;
      if (u.task && u.task.type === 'build') return true;
    }
    return false;
  }

  // ------------------------------------------------------- wall drawing mode
  //
  // A wall is not placed, it is *drawn*: press on the tile the run starts at,
  // pull, and the whole line of foundations appears under the finger with a
  // live count and cost; lift to buy the lot.
  //
  // HOW IT AVOIDS FIGHTING THE OTHER GESTURES. It is a mode of its own
  // (`st.mode === 'wallDraw'`), entered on pointerdown only while the HUD has a
  // wall type armed, and it never consults `effectiveDragMode()` — so it cannot
  // be turned into a box-select by having units in hand, and it cannot be turned
  // into a camera pan by not having any. The two-finger gestures are untouched
  // and stay reachable, because a second pointer goes down the same way it
  // always did and beginPinch() now cancels the run on its way past. That
  // doubles as the cancel gesture: a wall you have started drawing and do not
  // want is abandoned by putting a second finger down, which is also the gesture
  // for "let me look somewhere else first", and those are the same intention.
  //
  // There is no drag threshold. A press and release without moving is a one-tile
  // run, which places exactly one segment — so tapping still works and the two
  // behaviours are the same code path rather than two rules that have to agree.

  /** The type currently armed, if it is a wall. */
  function wallType() {
    return st.placeType && isWallType(st.placeType) ? st.placeType : null;
  }

  /** Tile under the touch, lifted clear of the finger the way the ghost is. */
  function tileUnder(sx, sy) {
    const g = toGrid(sx, sy - GHOST_LIFT);
    return {
      tx: Math.max(0, Math.min(MAP_W - 1, Math.floor(g.x))),
      ty: Math.max(0, Math.min(MAP_H - 1, Math.floor(g.y))),
    };
  }

  function beginWallRun(sx, sy) {
    const start = tileUnder(sx, sy);
    st.mode = 'wallDraw';
    st.ghost = null;
    pushGhost();
    st.wall = { tx0: start.tx, ty0: start.ty, tx1: start.tx, ty1: start.ty, plan: null };
    updateWallRun(sx, sy, true);
  }

  /**
   * Recompute the run for the tile now under the finger.
   *
   * The plan is only rebuilt when the *end tile* changes, not on every pointer
   * event. planWallLine walks the run and does one bounded enclosure test over
   * it, which is cheap per tile and not cheap sixty times a second — and the
   * answer cannot change between two events that land on the same tile.
   */
  function updateWallRun(sx, sy, force = false) {
    const w = st.wall;
    if (!w) return;
    const type = wallType();
    if (!type) { cancelWallRun(); return; }
    const end = tileUnder(sx, sy);
    if (!force && end.tx === w.tx1 && end.ty === w.ty1) {
      pushWallReadout(sx, sy);
      return;
    }
    w.tx1 = end.tx;
    w.ty1 = end.ty;

    const tiles = economy.wallLineTiles(w.tx0, w.ty0, w.tx1, w.ty1);
    const plan = economy.planWallLine(world, PLAYER, type, tiles);
    w.plan = plan;

    // Every tile in the run counts as a wall when working out how the segments
    // join, so the preview shows the finished shape — corners included — rather
    // than sixteen lone posts that would only knit together after they are all
    // built.
    const pending = new Set();
    for (const seg of plan.segments) pending.add(`${seg.tx},${seg.ty}`);
    const shown = plan.segments.map((seg) => ({
      tx: seg.tx,
      ty: seg.ty,
      valid: seg.valid,
      mask: wallMaskAt(world, seg.tx, seg.ty, PLAYER, pending),
    }));

    if (renderer && typeof renderer.setWallPreview === 'function') {
      renderer.setWallPreview(type, shown);
    }
    pushWallReadout(sx, sy);
  }

  /** The floating "12 walls — 60 stone" label that rides above the finger. */
  function pushWallReadout(sx, sy) {
    if (!renderer || typeof renderer.setWallReadout !== 'function') return;
    const w = st.wall;
    const plan = w && w.plan;
    if (!plan) { renderer.setWallReadout(null); return; }
    const total = plan.segments.length;
    const name = BUILDING_STATS[st.placeType] ? BUILDING_STATS[st.placeType].name : 'wall';
    let text;
    if (plan.trapped) {
      text = plan.trapped;
    } else if (plan.count === 0) {
      text = plan.reason || 'Cannot build there';
    } else {
      const cost = Object.keys(plan.cost)
        .map((k) => `${plan.cost[k]} ${k}`)
        .join(', ');
      const head = plan.count === total
        ? `${plan.count} ${name}${plan.count === 1 ? '' : 's'}`
        : `${plan.count} of ${total}`;
      text = cost ? `${head} — ${cost}` : head;
    }
    renderer.setWallReadout(text, sx, sy - GHOST_LIFT - 34);
  }

  function clearWallPreview() {
    if (renderer && typeof renderer.setWallPreview === 'function') renderer.setWallPreview(null);
    if (renderer && typeof renderer.setWallReadout === 'function') renderer.setWallReadout(null);
  }

  /** Abandon a run in progress without spending anything. */
  function cancelWallRun(announce = false) {
    if (!st.wall) return;
    st.wall = null;
    clearWallPreview();
    if (announce) hud.toast('Wall cancelled', 'info');
  }

  /** Lift: buy every segment the plan approved. */
  function commitWallRun() {
    const w = st.wall;
    const type = wallType();
    st.wall = null;
    clearWallPreview();
    if (!w || !type || !w.plan) return;

    const plan = w.plan;
    if (plan.count === 0) {
      hud.toast(plan.reason || 'Cannot build there', 'warn');
      return; // stay armed — the player only has to move
    }

    const tiles = economy.wallLineTiles(w.tx0, w.ty0, w.tx1, w.ty1);
    const res = economy.placeWallLine(world, PLAYER, type, tiles);
    const n = res.placed.length;
    if (!n) {
      hud.toast(res.reason || 'Cannot build there', 'warn');
      return;
    }

    const s = BUILDING_STATS[type];
    const label = `${n} ${s ? s.name : 'wall'}${n === 1 ? '' : 's'}`;
    if (res.refused) hud.toast(`${label} — ${res.refused} could not be placed`, 'warn');
    else hud.toast(`${label} — villagers on the way`, 'info');

    // The foundations are ordinary construction sites, so ordinary builders
    // finish them — and they are now queued, in the order the run was drawn, so
    // a villager that finishes one segment walks to the next along the line
    // instead of going back to a tree. That is what HANDOFF-walls.md left open:
    // the wall is still built from one end inwards, which is what makes it
    // useful while it is going up, but the crew no longer has to be re-ordered
    // segment by segment.
    const first = res.placed[0];
    if (typeof economy.enqueueFoundation === 'function') {
      for (const b of res.placed) economy.enqueueFoundation(world, b);
    }
    if (!anyBuilding()) {
      let builders = ownSelection().filter((e) => e.kind === 'unit' && e.type === 'villager');
      if (!builders.length) {
        let best = null;
        let bd = Infinity;
        for (const u of world.units) {
          if (u.dead || u.player !== PLAYER || u.type !== 'villager') continue;
          const d = (u.x - first.x) ** 2 + (u.y - first.y) ** 2;
          if (d < bd) { bd = d; best = u; }
        }
        if (best) builders = [best];
      }
      command(builders, { type: 'build', gx: first.x, gy: first.y, target: first });
    }
    fx(first.x, first.y, 'build');

    // Stays armed, exactly as tapped placement now does: the next drag draws the
    // next run. Two fingers still abandons a run mid-draw, and Done on the
    // placement bar ends the batch.
    if (hud && typeof hud.onFoundationPlaced === 'function') hud.onFoundationPlaced(n);
    syncPlacement();
  }

  /** Mirror hud's placement mode into the input state machine. */
  function syncPlacement() {
    const want = (hud && typeof hud.getPlacementType === 'function') ? hud.getPlacementType() : null;
    if (want === st.placeType) return;
    st.placeType = want || null;
    cancelWallRun();
    if (st.placeType && isWallType(st.placeType)) {
      // Said once, when the mode opens: the placement bar has room for the
      // building's name and nothing else, and "drag" is not a thing a player
      // guesses about a build button.
      hud.toast('Drag to draw a wall — two fingers to cancel', 'info');
    }
    if (!st.placeType) {
      st.ghost = null;
      pushGhost();
    } else {
      // Start the ghost slightly above the middle of the screen so it is
      // visible the instant placement mode opens.
      st.ghost = ghostAt(camera.width / 2, camera.height / 2 + GHOST_LIFT);
      pushGhost();
    }
  }

  // ----------------------------------------------------------------- pointers

  function primary() {
    return st.pointers.get(st.order[0]);
  }

  function twoPointers() {
    const a = st.pointers.get(st.order[0]);
    const b = st.pointers.get(st.order[1]);
    return a && b ? [a, b] : null;
  }

  function beginPinch() {
    const pair = twoPointers();
    if (!pair) return;
    clearBox();
    // A second finger always means "look somewhere else", never "keep drawing".
    // This is also the documented way to abandon a wall run mid-drag.
    cancelWallRun(!!st.wall);
    const [a, b] = pair;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const z = camera.zoom || 1;
    st.pinch = {
      dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: z,
      anchorWX: cx + (mx - camera.width / 2) / z,
      anchorWY: cy + (my - camera.height / 2) / z,
    };
    st.mode = 'pinch';
    st.driving = true;
    st.vel.x = 0;
    st.vel.y = 0;
  }

  function updatePinch() {
    const pair = twoPointers();
    if (!pair || !st.pinch) return;
    const [a, b] = pair;
    const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    setZoom(st.pinch.zoom * (d / st.pinch.dist));
    const z = camera.zoom || 1;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    // Keep the world point that was under the pinch centre pinned to it.
    cx = st.pinch.anchorWX - (mx - camera.width / 2) / z;
    cy = st.pinch.anchorWY - (my - camera.height / 2) / z;
    applyCamera();
  }

  /**
   * Record a pan position. Repeats of the same point are dropped: a pointerup
   * usually reports the last move's coordinates, and keeping it would make the
   * final displacement zero and kill every fling.
   */
  function sampleVelocity(p, now) {
    const last = st.samples[st.samples.length - 1];
    if (last && last.x === p.x && last.y === p.y) return;
    st.samples.push({ t: now, x: p.x, y: p.y });
    if (st.samples.length > SAMPLE_KEEP) st.samples.shift();
  }

  function releaseInertia(now) {
    st.vel.x = 0;
    st.vel.y = 0;
    const s = st.samples;
    if (s.length < 2) return;
    const b = s[s.length - 1];
    // Finger came to rest before lifting: that is a deliberate stop, not a fling.
    if (now - b.t > REST_MS) return;

    // Average over the last VELOCITY_WINDOW_MS so one jittery event cannot
    // launch the camera across the map.
    let a = s[0];
    for (let i = s.length - 2; i >= 0; i--) {
      a = s[i];
      if (b.t - a.t >= VELOCITY_WINDOW_MS) break;
    }
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.008) return;

    const z = camera.zoom || 1;
    // A screen drag moves the world the other way.
    let vx = -((b.x - a.x) / dt) / z;
    let vy = -((b.y - a.y) / dt) / z;
    const speed = Math.hypot(vx, vy);
    if (speed < INERTIA_MIN) return;
    if (speed > MAX_FLING) { vx = (vx / speed) * MAX_FLING; vy = (vy / speed) * MAX_FLING; }
    st.vel.x = vx;
    st.vel.y = vy;
  }

  // --------------------------------------------------------------- listeners

  function onDown(ev) {
    if (st.destroyed) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();

    const p = gamePoint(ev);
    const now = performance.now();
    st.pointers.set(ev.pointerId, { id: ev.pointerId, x: p.x, y: p.y, t: now });
    st.order.push(ev.pointerId);
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* fine */ }
    }

    if (st.order.length === 1) {
      st.vel.x = 0;
      st.vel.y = 0;
      st.samples.length = 0;
      st.anchor = { x: p.x, y: p.y, t: now };
      sampleVelocity(p, now);
      syncPlacement();
      if (wallType()) {
        beginWallRun(p.x, p.y);
      } else if (st.placeType) {
        st.mode = 'place';
        moveGhost(p.x, p.y);
      } else {
        st.mode = 'tap';
      }
    } else if (st.order.length === 2) {
      beginPinch();
    }
  }

  function onMove(ev) {
    const rec = st.pointers.get(ev.pointerId);
    if (!rec) return;
    ev.preventDefault();
    const p = gamePoint(ev);
    const now = performance.now();
    rec.x = p.x;
    rec.y = p.y;

    if (st.mode === 'pinch') { updatePinch(); return; }
    if (st.order[0] !== ev.pointerId) return;

    const a = st.anchor;
    const moved = Math.hypot(p.x - a.x, p.y - a.y);

    if (st.mode === 'wallDraw') { updateWallRun(p.x, p.y); return; }
    if (st.mode === 'place') { moveGhost(p.x, p.y); return; }

    if (st.mode === 'tap') {
      if (moved < DRAG_BOX_THRESHOLD) return;
      if (effectiveDragMode() === 'box') startBox(a.x, a.y);
      // Absorb the threshold so the camera does not jump when the pan begins.
      else { st.mode = 'pan'; st.driving = true; st.last = { x: p.x, y: p.y }; }
    }

    if (st.mode === 'box') { updateBox(p.x, p.y); return; }

    if (st.mode === 'pan') {
      const z = camera.zoom || 1;
      const last = st.last || a;
      cx -= (p.x - last.x) / z;
      cy -= (p.y - last.y) / z;
      st.last = { x: p.x, y: p.y };
      applyCamera();
      sampleVelocity(p, now);
    }
  }

  function onUp(ev) {
    const rec = st.pointers.get(ev.pointerId);
    if (!rec) return;
    ev.preventDefault();
    const p = gamePoint(ev);
    const now = performance.now();
    const wasPrimary = st.order[0] === ev.pointerId;

    st.pointers.delete(ev.pointerId);
    const i = st.order.indexOf(ev.pointerId);
    if (i >= 0) st.order.splice(i, 1);

    if (st.mode === 'pinch') {
      if (st.order.length >= 2) { beginPinch(); return; }
      if (st.order.length === 1) {
        // One finger left: continue as a pan from where it now is.
        const rest = primary();
        st.mode = 'pan';
        st.driving = true;
        st.anchor = { x: rest.x, y: rest.y, t: now };
        st.last = { x: rest.x, y: rest.y };
        st.samples.length = 0;
        sampleVelocity(rest, now);
        return;
      }
      st.mode = 'none';
      st.driving = false;
      st.pinch = null;
      return;
    }

    if (!wasPrimary) return;

    if (st.mode === 'wallDraw') {
      updateWallRun(p.x, p.y);
      commitWallRun();
    } else if (st.mode === 'box') {
      finishBox();
    } else if (st.mode === 'pan') {
      sampleVelocity(p, now);
      releaseInertia(now);
    } else if (st.mode === 'place') {
      moveGhost(p.x, p.y);
      confirmPlacement();
    } else if (st.mode === 'tap') {
      // A press that never moved is a tap, however long it lasted — there is no
      // other thing a stationary press-and-release could mean, and swallowing
      // slightly slow taps is the fastest way to make a game feel broken.
      const moved = Math.hypot(p.x - st.anchor.x, p.y - st.anchor.y);
      if (moved <= TAP_SLOP) handleTap(p.x, p.y);
    }

    st.mode = st.order.length ? 'tap' : 'none';
    if (!st.order.length) st.driving = false;
    if (st.order.length === 1) {
      const rest = primary();
      st.anchor = { x: rest.x, y: rest.y, t: now };
    }
  }

  function onCancel(ev) {
    if (!st.pointers.has(ev.pointerId)) return;
    st.pointers.delete(ev.pointerId);
    const i = st.order.indexOf(ev.pointerId);
    if (i >= 0) st.order.splice(i, 1);
    if (st.mode === 'box') clearBox();
    if (st.mode === 'wallDraw') cancelWallRun();
    if (!st.order.length) {
      st.mode = 'none';
      st.driving = false;
      st.pinch = null;
    }
  }

  function onWheel(ev) {
    // Desktop convenience; the phone path never needs it.
    ev.preventDefault();
    const z = camera.zoom || 1;
    setZoom(z * (ev.deltaY > 0 ? 0.9 : 1.1));
    applyCamera();
  }

  function onKey(ev) {
    if (ev.key === 'Escape') {
      if (st.wall) { cancelWallRun(true); st.mode = 'none'; }
      else if (st.placeType) { hud.setPlacementMode(null); syncPlacement(); }
      else if (attackArmed()) disarmAttack();
      else clearSelection(world);
    }
  }

  const stopDefault = (e) => e.preventDefault();

  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', onDown, { passive: false });
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp, { passive: false });
  window.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', stopDefault);
  canvas.addEventListener('gesturestart', stopDefault);
  window.addEventListener('keydown', onKey);

  // ------------------------------------------------------------------- modes

  function effectiveDragMode() {
    // A box already being drawn (long-press escape hatch) wins, so the HUD chip
    // always names the gesture that is actually happening.
    if (st.mode === 'box') return 'box';
    if (st.dragPref !== 'auto') return st.dragPref;
    // Auto: with something of yours in hand a drag picks troops, otherwise it
    // moves the camera. Two fingers always pan, so nothing becomes unreachable.
    for (const id of world.selection) {
      const e = world.entities.get(id);
      if (e && !e.dead && e.player === PLAYER) return 'box';
    }
    return 'pan';
  }

  function cycleDragPreference() {
    st.dragPref = st.dragPref === 'auto' ? 'pan' : st.dragPref === 'pan' ? 'box' : 'auto';
    return st.dragPref;
  }

  // ------------------------------------------------------------------- frame

  function update(dt) {
    if (st.destroyed) return;
    syncPlacement();

    // A held finger that has not moved arms a box select — the escape hatch
    // that makes group-picking reachable even while the camera owns drags.
    if (st.mode === 'tap' && st.order.length === 1 && st.anchor) {
      const p = primary();
      const moved = p ? Math.hypot(p.x - st.anchor.x, p.y - st.anchor.y) : 0;
      if (moved <= TAP_SLOP && performance.now() - st.anchor.t > LONG_PRESS_MS) {
        startBox(st.anchor.x, st.anchor.y);
      }
    }

    if (!st.driving && (st.vel.x || st.vel.y)) {
      cx += st.vel.x * dt;
      cy += st.vel.y * dt;
      const damp = Math.exp(-INERTIA_DAMP * dt);
      st.vel.x *= damp;
      st.vel.y *= damp;
      if (Math.hypot(st.vel.x, st.vel.y) < INERTIA_MIN) { st.vel.x = 0; st.vel.y = 0; }
      applyCamera();
    } else if (st.mode === 'none' && camera.midPoint) {
      // Nothing of ours is moving the camera — adopt whatever moved it (the
      // renderer's initial centreOn, the minimap, the idle-villager button).
      cx = camera.midPoint.x;
      cy = camera.midPoint.y;
    }
  }

  function destroy() {
    st.destroyed = true;
    clearBox();
    cancelWallRun();
    st.ghost = null;
    pushGhost();
    canvas.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', stopDefault);
    canvas.removeEventListener('gesturestart', stopDefault);
    window.removeEventListener('keydown', onKey);
  }

  const api = {
    update,
    destroy,
    camera,
    centerOnGrid,
    effectiveDragMode,
    cycleDragPreference,
    getDragPreference: () => st.dragPref,
    // Test/debug surface.
    _state: st,
    _pick: pickAt,
    _pickRally: pickRallyAt,
    _toScreen: toScreen,
    _toGrid: toGrid,
    _wallRun: () => st.wall,
    _cancelWallRun: cancelWallRun,
  };

  if (hud && typeof hud.attachInput === 'function') hud.attachInput(api);
  return api;
}
