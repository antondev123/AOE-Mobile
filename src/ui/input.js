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
  TAP_SLOP, DRAG_BOX_THRESHOLD, TAP_PICK_RADIUS, ORDER_PICK_RADIUS,
  ZOOM_MIN, ZOOM_MAX, HALF_W, HALF_H,
  BUILDING_STATS, isWallType, isGateType, MILITARY_TYPES,
} from '../core/constants.js';
import { EV } from '../core/events.js';
// The local player's seat, as a live binding — see src/core/viewpoint.js for
// why this is imported under the old name instead of threading a parameter.
import { ME as PLAYER } from '../core/viewpoint.js';
import { screenDist, worldToGrid } from '../core/iso.js';
import { placeBlockedBy, wallMaskAt } from '../core/world.js';

import * as unitAI from '../systems/unitAI.js';
import * as economy from '../systems/economy.js';

import { setSelection, clearSelection, selectedEntities } from './selection.js';
import { rallyText } from './hud.js';
import { createLocalBus } from '../net/bus.js';

// --- Tuning that is local to gesture handling (the shared feel numbers live
// in core/constants.js and must not be duplicated there). --------------------
//
// PRESS-AND-HOLD IS NOT THE TAP CEILING, and tying the two together cost the
// player their pan. At TAP_TIME_MS (300ms) the hold fired during the ordinary
// beginning of a deliberate drag: touch down, spend a third of a second
// deciding where to go, then move — and the box had already armed, so the pan
// came out as a selection rectangle. 500ms is past the point where a press is
// plausibly the start of a drag and still well inside what reads as "hold".
const LONG_PRESS_MS = 500;
// Generous by design: two quick taps on your own unit can only mean "give me
// all of these", so a wide window costs nothing and forgives slow thumbs.
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_SLOP = 34;
// The finger hides the target, so the placement ghost sits this far above it.
const GHOST_LIFT = 62;
// ...but never more than this many tile-rows away from the touch. The lift is
// a *screen* distance because its job is to clear a thumb, which is a fixed
// number of millimetres — but the map underneath is not: at ZOOM_MIN 62px is
// 3.5 tiles and at ZOOM_MAX it is 1.0, so the same gesture put the building
// three and a half tiles from your finger zoomed out and one tile from it
// zoomed in. Muscle memory learned at one zoom was simply wrong at the other.
// Capping it in tiles keeps the full 62px around zoom 1 and closes the gap at
// the ends of the range.
// 2.0 puts the ghost exactly two tile-rows up-screen from the finger at every
// zoom, which is a thing a player can learn once. It caps the pixel lift at
// zoom < ~0.97 and leaves the full 62px above that.
const MAX_LIFT_TILES = 2.0;
// A second pick probe this far below the touch compensates for sprites being
// drawn above their tile: you tap a unit's chest, its feet own the tile. That
// offset is a *world* distance — the sprite scales with the camera — so it is
// multiplied by the zoom before use. Left as a screen offset it was 1.7 tiles
// at ZOOM_MIN and a quarter of a tile at ZOOM_MAX: far too eager zoomed out,
// where it dragged picks toward whatever happened to be below your finger.
const PICK_PROBE_DOWN = 15;
// How much closer a lower-ranked entity must be before it beats the preference
// order (own units > own buildings > enemies > resources). Screen px.
const TIER_SLACK = 14;
// The same, for a tap that is giving an order. Tighter, because the preference
// order exists to help you *choose* things and only gets in the way once you
// have already chosen.
const ORDER_TIER_SLACK = 8;
// A drag has to be at least this wide or tall, and cover at least this much
// area, before it counts as a selection rectangle rather than a smeared tap.
// The old test was `w < 14 && h < 14` — note the `&&` — so a 15x3 px scuff was
// a "real" box, which at ZOOM_MIN is less than one tile and therefore an
// almost-certain miss that then wiped the selection.
const BOX_MIN_SIDE = 24;
const BOX_MIN_AREA = 900;
// How far a wall-drawing finger must stray from the straight line between where
// it started and where it is now before the run is allowed a corner. Generous:
// a swipe across a phone wanders by a few pixels and must still count as one
// stroke, while a deliberate turn is tens of pixels off the chord long before
// the finger stops.
const BEND_SLOP = 30;
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

  // Every action this file takes goes through the bus rather than into the
  // world. The scene owns it; the fallback keeps a hand-built input (a test, the
  // console) working exactly as it did before there was a bus at all.
  const bus = scene.bus || createLocalBus(world, PLAYER);

  // World-pixel bounds of the playable diamond (see core/iso.js). Read off the
  // world rather than off a constant: the map is as big as the roster needs.
  const MAP_W = world.width;
  const MAP_H = world.height;
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

  // --- Audio ----------------------------------------------------------------
  //
  // The engine lives on the scene (see GameScene.create) rather than being
  // passed in, so that a page booted without one — or a test that swaps it —
  // costs nothing here but a null check.

  let musicStarted = false;

  function unlockAudio() {
    const audio = scene.audio;
    if (!audio) return;
    if (!audio.unlock()) return;
    // Only once the context is genuinely running: startMusic() is a no-op while
    // locked, and calling it every pointer-down until it took would be a silent
    // way of never noticing it had not.
    if (!musicStarted) {
      musicStarted = true;
      audio.startMusic();
    }
  }

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

  /**
   * The part of the canvas the player can actually see, in screen px.
   *
   * The renderer draws the map edge to edge and the HUD sits on top of it, so
   * "the screen" and "the map" are not the same rectangle: a 390x844 phone with
   * something selected shows the map between roughly y=48 and y=560, and the
   * rest is chrome. Anything that reasons about where things are — centring the
   * camera, deciding whether a unit is on screen, deciding which units a
   * selection box caught — has to use this and not `camera.height`.
   */
  function viewRect() {
    let top = 0;
    let bottom = 0;
    if (hud && typeof hud.viewInsets === 'function') {
      const v = hud.viewInsets();
      if (v) { top = v.top || 0; bottom = v.bottom || 0; }
    }
    // Never let the chrome claim so much that the band collapses; a wrong
    // measurement should degrade to "the whole screen", not to nothing.
    if (top + bottom > camera.height * 0.8) { top = 0; bottom = 0; }
    return { top, bottom, height: camera.height - top - bottom };
  }

  /** How far the centre of the visible band sits below the centre of the canvas. */
  function viewOffsetY() {
    const v = viewRect();
    return (v.bottom - v.top) / 2;
  }

  function centerOnGrid(gx, gy) {
    st.vel.x = 0;
    st.vel.y = 0;
    const z = camera.zoom || 1;
    cx = (gx - gy) * HALF_W;
    // Bias the camera down by half the chrome imbalance so the target lands in
    // the middle of the *visible* map rather than behind the dock.
    cy = (gx + gy) * HALF_H + viewOffsetY() / z;
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
  function pickAt(sx, sy, rank = tierOf, opts = null) {
    const z = camera.zoom || 1;
    const radius = (opts && opts.radius ? opts.radius : TAP_PICK_RADIUS) / z; // unzoomed screen px
    const slack = (opts && opts.slack !== undefined ? opts.slack : TIER_SLACK) / z;
    const skipSelected = !!(opts && opts.skipSelected);
    // PICK_PROBE_DOWN is a world offset expressed at zoom 1, so it scales with
    // the camera the way the sprite it compensates for does.
    const probes = [toGrid(sx, sy), toGrid(sx, sy + PICK_PROBE_DOWN * z)];
    // Cheap grid-space reject box around both probes.
    const gridPad = radius / HALF_H + 2;

    const bestOf = new Array(TIER_COUNT).fill(null); // one candidate per tier
    let minGap = Infinity;

    const consider = (e) => {
      if (!e || e.dead) return;
      // On the order path, things already in hand are not candidates: a tap
      // just ahead of your own army means "advance", and letting one of those
      // soldiers win the pick turned it into "select that soldier instead",
      // which threw the rest of the selection away and issued nothing.
      if (skipSelected && world.selection.has(e.id)) return;
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

  /**
   * Is this grid point somewhere the player can see it?
   *
   * Bounded by the visible band, not the canvas: "select every villager on
   * screen" used to include the ones hidden behind the dock and the bottom bar,
   * which is a third of the phone. Being handed units you cannot see is the
   * same complaint as being handed none.
   */
  function onScreen(gx, gy, margin = 24) {
    const p = toScreen(gx, gy);
    const v = viewRect();
    return p.x >= -margin && p.y >= v.top - margin &&
           p.x <= camera.width + margin && p.y <= camera.height - v.bottom + margin;
  }

  // ---------------------------------------------------------------- commands

  // Orders name their units and their targets by id, because the object on this
  // phone is not the object on the server. resolveOrderTargets() in command.js
  // turns them back into references at the far end.
  function command(units, order) {
    if (!units.length) return;
    bus.dispatch({ t: 'order', units: units.map((u) => u.id), order: idifyOrder(order) });
  }

  /** An order with its entity references flattened to ids, ready to be sent. */
  function idifyOrder(order) {
    const o = { ...order };
    if (o.target && typeof o.target === 'object') o.target = o.target.id;
    if (o.node && typeof o.node === 'object') o.node = o.node.id;
    if (o.building && typeof o.building === 'object') o.building = o.building.id;
    return o;
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
    if (!troops.length) {
      // Two things just happened — the armed mode went away and the tap did
      // something else entirely — and neither used to be announced, so the bar
      // vanished and a villager walked somewhere for no visible reason.
      hud.toast('No soldiers selected — attack-move cancelled', 'warn');
      return false;
    }
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

    // What a tap means once something is in hand is decided by aim, not by the
    // preference order: a much tighter radius, a smaller tier slack, and the
    // things already selected taken out of the running entirely. See
    // ORDER_PICK_RADIUS in core/constants.js for what this was costing.
    const orderPick = (x, y) => pickAt(x, y, tierOf, {
      radius: ORDER_PICK_RADIUS, slack: ORDER_TIER_SLACK, skipSelected: true,
    });

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
    if (units.length === 0) {
      // Nothing in hand: this tap is a choice. The wide fat-finger radius and
      // the full preference order apply, which is what they are for.
      if (pick) setSelection(world, [pick]);
      else clearSelection(world);
      return;
    }

    // Something IS in hand, so re-aim. `pick` was found with the 34px selection
    // radius — a disc covering eleven tiles at ZOOM_MIN — which is the right
    // tool for choosing a unit and the wrong one for pointing at the ground
    // beside it.
    const aim = orderPick(sx, sy);

    if (aim && aim.player === PLAYER) {
      // One of ours, and not already selected. Two of those are work orders
      // rather than a change of selection: a foundation (go and finish it) and
      // a finished farm (go and harvest it, exactly as for a bush). Without
      // these the tap silently replaces a dozen working villagers with the
      // building, issues nothing, and shows nothing to say why they stopped.
      const workable = aim.kind === 'building' && villagers.length &&
        (!aim.complete || isOwnFarm(aim));
      if (workable) {
        issueOrder(units, aim, g);
        return;
      }
      // Anything else of ours under a tightly-aimed tap really is a request to
      // select it — you hit it, at 18px, with the current selection excluded.
      setSelection(world, [aim]);
      return;
    }

    issueOrder(units, aim, g);
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
    // A rectangle has to be a rectangle. `w < 14 && h < 14` let a 15x3px scuff
    // through as a real box — under one tile of ground at ZOOM_MIN, so a
    // near-certain miss, and a miss used to wipe the selection.
    if ((box.w < BOX_MIN_SIDE && box.h < BOX_MIN_SIDE) || box.w * box.h < BOX_MIN_AREA) {
      // Too small to be a real drag — treat it as a tap where it started.
      handleTap(st.anchor.x, st.anchor.y);
      return;
    }

    // Clipped to the visible band: the pointer listeners are on `window` and
    // the canvas holds pointer capture, so a box begun on the map can be pulled
    // down over the dock and the bottom bar. It used to happily select the
    // units under them — invisible ones, named in a toast the player could not
    // reconcile with anything on screen.
    const v = viewRect();
    const clip = {
      x0: box.x,
      x1: box.x + box.w,
      y0: Math.max(box.y, v.top),
      y1: Math.min(box.y + box.h, camera.height - v.bottom),
    };

    const inside = (gx, gy) => {
      const p = toScreen(gx, gy);
      return p.x >= clip.x0 && p.x <= clip.x1 && p.y >= clip.y0 && p.y <= clip.y1;
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
    } else if (world.selection.size) {
      // AN EMPTY BOX KEEPS WHAT YOU HAD. It used to clear the selection in
      // silence, which is the single loudest way this game felt broken: with
      // troops in hand a one-finger drag *is* a box (see effectiveDragMode), so
      // every attempt to look around threw the army away and said nothing. The
      // player is told instead, and the army survives; deselecting has its own
      // deliberate gestures (the × on the panel, Escape, a tap on bare ground
      // with nothing in hand).
      hud.toast('Nothing in the box — selection kept', 'info');
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
      reason = s ? placeBlockedBy(world, gx, gy, s.fw, s.fh) : 'Cannot build there';
    }
    placeCache = { key, tick: world.tick, reason };
    return reason;
  }

  /**
   * The centre coordinate of an `n`-wide footprint aimed at grid position `v`.
   *
   * Odd sizes have a middle tile and the player is aiming at it, so the tile
   * under the finger becomes the centre. Even sizes have no middle tile — they
   * straddle a grid line — so the aim rounds to the nearest line.
   *
   * The 1x1 case is the one that was wrong, and it was wrong for everything
   * that matters most here: every wall, every gate and the watch tower. The old
   * form, `floor(v - 0.5) + 0.5`, is the tile *before* the one under the finger
   * whenever the fraction is below a half — so the ghost and the wall drag
   * (which floors, via tileUnder) disagreed across three quarters of the map,
   * and a gate tapped into the gap left by a wall you had just dragged missed
   * the gap. Now `snapFootprint(v, 1) === Math.floor(v) + 0.5`, which is
   * exactly `tileUnder`'s tile, by construction.
   */
  function snapFootprint(v, n) {
    return n % 2 === 1
      ? Math.floor(v) - (n - 1) / 2 + n / 2
      : Math.round(v) - n / 2 + n / 2;
  }

  function ghostAt(sx, sy) {
    const type = st.placeType;
    const s = BUILDING_STATS[type];
    if (!s) return null;
    // ONE RULE FOR "WHICH TILE IS UNDER THE FINGER", shared with the wall drag.
    //
    // There used to be two, and they disagreed on three quarters of the map.
    // The ghost snapped with `floor(g - fw/2) + fw/2`, which for a 1x1 is
    // `floor(g - 0.5)` — the tile *before* the one under the touch unless the
    // fraction happened to be past a half. tileUnder(), which the wall drag
    // uses, snapped with `floor(g)`. So the palisade you dragged and the gate
    // you then tapped into the gap you left for it were computed from different
    // tiles, and the gate missed the gap. Now the aimed tile is derived once,
    // and the footprint is centred on it (odd sizes) or hung off it
    // symmetrically (even ones).
    const g = toGrid(sx, sy - liftPx());
    const gx = snapFootprint(g.x, s.fw);
    const gy = snapFootprint(g.y, s.fh);
    // Being broke outranks the ground being wrong, as it always has: it is the
    // thing the player has to fix first, and it is true of every tile. Named,
    // though — the build-menu button that armed this mode says "Not enough
    // wood", and it would be a strange game where the moment of failure knew
    // less than the moment of arming.
    const reason = canAffordType(type) ? refusalFor(type, gx, gy) : shortOfText(type);
    return { type, gx, gy, valid: !reason, reason: reason || null };
  }

  /** "Not enough wood", not "Not enough resources", whenever we can tell. */
  function shortOfText(type) {
    const cost = BUILDING_STATS[type] && BUILDING_STATS[type].cost;
    const r = world.players[PLAYER].resources;
    for (const k of Object.keys(cost || {})) {
      if ((cost[k] || 0) > (r[k] || 0)) return `Not enough ${k}`;
    }
    return 'Not enough resources';
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
    // Which villagers should start on this is a *local* decision — it reads the
    // selection, which lives on this device and nowhere else — but it has to
    // take effect on the authoritative path along with the placement itself.
    // So the crew rides along in the command and command.js dispatches it the
    // moment the foundation exists. One command, one tick, both machines.
    //
    // Only send builders when nobody is already building. A batch is placed
    // faster than it is built, and re-ordering the same crew onto every new
    // site as it lands would walk them off the half-finished house to the one
    // you just tapped, over and over — the fifth tap would leave four
    // foundations standing and one villager sprinting. They work the queue
    // through instead (onJobFinished in unitAI.js), and the only thing this has
    // to guarantee is that *somebody* starts.
    // Measured to the tile that was tapped, since the foundation does not exist
    // yet — its centre is within half a tile of it either way.
    const builders = pickBuilders(gh.gx, gh.gy);

    const res = bus.dispatch({
      t: 'place',
      buildingType: gh.type,
      gx: gh.gx,
      gy: gh.gy,
      builders: builders.map((u) => u.id),
    });
    if (!res.ok) return; // economy already explained why

    // The tap gets its acknowledgement now either way. Locally the foundation
    // already exists, so the flash lands on its centre exactly as it always
    // has; over a network it is a few ticks out, and a flash that waited for it
    // would read as the tap having been dropped — so it goes on the tapped
    // tile, which for a 1x1 is the same place and for a Town Center is a tile
    // off in a puff of dust nobody will measure.
    const built = res.detail && world.entities.get(res.detail.id);
    if (built) fx(built.x, built.y, 'build');
    else fx(gh.gx, gh.gy, 'build');

    // Placement stays armed: the next tap places the next one. `Done` on the
    // placement bar (or Escape, or the build menu) is what ends the batch.
    if (hud && typeof hud.onFoundationPlaced === 'function') hud.onFoundationPlaced(1);
    syncPlacement();
  }

  /**
   * WHO would build at (gx, gy), without ordering anybody.
   *
   * This used to be dispatchBuilders(), which chose the crew AND gave it its
   * orders. It cannot any more: a foundation is created by a command now, and
   * over a network that command has not been applied — may not even have reached
   * the server — by the time this returns. So the site cannot be pointed at, only
   * *described*: the crew rides along in the command as a list of ids and
   * core/command.js gives the order the instant the site is real, on every
   * machine, on the same tick.
   *
   * Choosing the crew stays here, because it reads the selection, and the
   * selection lives on this device and nowhere else.
   *
   * SPREAD, NOT STACKED, is now command.js's problem rather than this file's:
   * everything used to be sent to the first site, which for a wall means twenty
   * villagers converging on one 1x1 tile with at most six standable neighbours.
   * The surplus fail their approach four times over and unitAI drops them back to
   * gathering — the "I sent everyone and half of them wandered off" complaint,
   * and the open item at the end of HANDOFF-walls.md.
   *
   * Nobody is sent while somebody is already building: a batch is placed faster
   * than it is built, and re-ordering the same crew onto every new site as it
   * lands would walk them off the half-finished house to the one you just
   * tapped. They work the queue through instead (onJobFinished in unitAI.js).
   */
  function pickBuilders(gx, gy) {
    if (anyBuilding()) return [];
    const sel = ownSelection().filter((e) => e.kind === 'unit' && e.type === 'villager');
    if (sel.length) return sel;
    // Nothing selected? Send the nearest villager rather than doing nothing.
    const near = nearestVillager(gx, gy);
    return near ? [near] : [];
  }

  function nearestVillager(gx, gy) {
    let best = null;
    let bd = Infinity;
    for (const u of world.units) {
      if (u.dead || u.player !== PLAYER || u.type !== 'villager') continue;
      const d = (u.x - gx) ** 2 + (u.y - gy) ** 2;
      if (d < bd) { bd = d; best = u; }
    }
    return best;
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

  /**
   * The type currently armed, if it is a wall you draw a run of.
   *
   * A GATE IS NOT ONE. Gates carry `wall: true` because they join up with a
   * wall's sprite mask and sit in the same block grid, and that made them fall
   * into the drag-draw path with everything else — so pulling a Palisade Gate
   * across twelve tiles bought twelve palisade gates for 240 wood, which is not
   * a thing any player has ever wanted. A gate is a *door*: there is exactly one
   * of it in a stretch of wall, and AoE2 places them one at a time.
   *
   * Refusing them here is the whole fix, because a type that is not a wall for
   * this purpose falls through to ordinary tap placement — which is already
   * single-tile, already stays armed for the next one, and already runs
   * refreshWallsAround so the gate joins the wall either side of it.
   */
  function wallType() {
    if (!st.placeType || !isWallType(st.placeType)) return null;
    return isGateType(st.placeType) ? null : st.placeType;
  }

  /**
   * How far above the finger the thing being placed sits, in screen px.
   *
   * The lift is a screen distance because what it is dodging is a thumb, and a
   * thumb is the same size whatever the camera is doing. But the *map* is not:
   * 62px is 3.5 tile-rows at ZOOM_MIN and 1.0 at ZOOM_MAX, so the building
   * appeared three and a half tiles from your finger zoomed out and one tile
   * from it zoomed in, and the aim you learned at one zoom was wrong at the
   * other. Capping the lift in tiles as well as pixels keeps the full 62px
   * where it matters (around zoom 1, where people place buildings) and pulls
   * the ghost back to the finger at the wide end.
   */
  function liftPx() {
    const z = camera.zoom || 1;
    return Math.min(GHOST_LIFT, MAX_LIFT_TILES * 2 * HALF_H * z);
  }

  /** Tile under the touch, lifted clear of the finger the way the ghost is. */
  function tileUnder(sx, sy) {
    const g = toGrid(sx, sy - liftPx());
    return {
      tx: Math.max(0, Math.min(MAP_W - 1, Math.floor(g.x))),
      ty: Math.max(0, Math.min(MAP_H - 1, Math.floor(g.y))),
    };
  }

  /**
   * Decide what the stroke the player just drew was meant to be.
   *
   * THE SINGLE BIGGEST REASON WALLS WERE HARD. wallLineTiles draws an L — the
   * longer leg first, then the corner — which is the right shape for a wall
   * that turns. But the grid axes run at ±26.6° across an isometric screen, so
   * the gesture a player makes for "a wall across the front of my base" is a
   * straight horizontal swipe, and a straight horizontal swipe is an exact grid
   * anti-diagonal: dx = +n, dy = -n. Fed to an L that came out as a chevron —
   * n tiles down-right then n tiles up-right, twice the length asked for, twice
   * the price, in a shape nobody has ever wanted. Nothing said so, and no
   * amount of aiming could avoid it, because the drag really did span both axes
   * equally. It was not a tolerance problem; it was the wrong question.
   *
   * The right question is whether the FINGER turned. One straight stroke is one
   * straight wall — and which of the two grid axes it becomes is settled by
   * pointing them both at the screen and seeing which one goes the way the
   * finger went. A stroke that visibly bends keeps its corner, because a bend
   * is what asking for a corner looks like.
   */
  function snapWallEnd(tx0, ty0, tx1, ty1) {
    const w = st.wall;
    // A finger that visibly turned meant to turn. Everything else is one
    // stroke, and one stroke is one wall.
    if (!w || w.bend > BEND_SLOP) return { tx: tx1, ty: ty1 };
    if (tx1 === tx0 && ty1 === ty0) return { tx: tx1, ty: ty1 };

    // Both straight runs the stroke could have meant...
    const alongX = { tx: tx1, ty: ty0 };
    const alongY = { tx: tx0, ty: ty1 };
    if (tx1 === tx0) return alongY;
    if (ty1 === ty0) return alongX;

    // ...judged by which one points the way the finger actually went. Screen
    // space is the only place that question has an answer: the two grid axes
    // run at +-26.6 degrees across an isometric map, so "along +x" and "along
    // -y" both look like dragging rightwards, and which of them the player
    // meant is decided by where they stopped, not by the grid.
    const a = toScreen(tx0, ty0);
    const dragX = w.sx1 - w.sx0;
    const dragY = w.sy1 - w.sy0;
    const score = (end) => {
      const p = toScreen(end.tx, end.ty);
      return (p.x - a.x) * dragX + (p.y - a.y) * dragY;
    };
    return score(alongX) >= score(alongY) ? alongX : alongY;
  }

  function beginWallRun(sx, sy) {
    const start = tileUnder(sx, sy);
    st.mode = 'wallDraw';
    st.ghost = null;
    pushGhost();
    st.wall = {
      tx0: start.tx, ty0: start.ty, tx1: start.tx, ty1: start.ty, plan: null,
      // The stroke, in screen space, for snapWallEnd: where it started, where
      // it is now, and how far it has strayed from the straight line between
      // the two. `bend` only ever grows, so a stroke that turned stays turned
      // even if the finger comes back onto the chord afterwards.
      sx0: sx, sy0: sy, sx1: sx, sy1: sy, bend: 0,
    };
    updateWallRun(sx, sy, true);
  }

  /** Update the stroke record, including how far it has bent. */
  function trackStroke(sx, sy) {
    const w = st.wall;
    if (!w) return;
    w.sx1 = sx;
    w.sy1 = sy;
    const dx = sx - w.sx0;
    const dy = sy - w.sy0;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    // Distance of the current point from the chord drawn so far is no use — it
    // is zero by definition. What matters is the far point: keep the running
    // maximum of how far off the *current* chord any earlier sample was.
    if (!w.samples) w.samples = [];
    const last = w.samples[w.samples.length - 1];
    if (!last || Math.hypot(sx - last.x, sy - last.y) > 6) {
      w.samples.push({ x: sx, y: sy });
      if (w.samples.length > 48) w.samples.shift();
    }
    let worst = 0;
    for (const p of w.samples) {
      const d = Math.abs((p.x - w.sx0) * dy - (p.y - w.sy0) * dx) / len;
      if (d > worst) worst = d;
    }
    if (worst > w.bend) w.bend = worst;
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
    trackStroke(sx, sy);
    const end = tileUnder(sx, sy);
    if (!force && end.tx === w.tx1 && end.ty === w.ty1) {
      pushWallReadout(sx, sy);
      return;
    }
    const snapped = snapWallEnd(w.tx0, w.ty0, end.tx, end.ty);
    if (!force && snapped.tx === w.tx1 && snapped.ty === w.ty1) {
      pushWallReadout(sx, sy);
      return;
    }
    w.tx1 = snapped.tx;
    w.ty1 = snapped.ty;

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
      // Say why some of them are grey. The readout used to print "3 of 12" and
      // drop plan.reason on the floor unless the whole run was refused, so the
      // one moment the player could still fix it — before lifting — was the one
      // moment they were not told what was wrong.
      if (plan.count < total && plan.reason) text += ` (${plan.reason.toLowerCase()})`;
      if (plan.capped) text += ` · ${plan.capped} beyond the ${plan.count + plan.refused}-tile limit`;
    }
    renderer.setWallReadout(text, sx, sy - liftPx() - 34);
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

    // Re-planned, not read from the drag. The cached plan is the one from the
    // last tile the finger crossed, and the world moves on while a finger rests:
    // hold still for a second while stone comes in and the cache says "3 of 12"
    // while the placement that follows lays all twelve — the preview and the
    // outcome disagreeing about what the player just bought.
    const tiles = economy.wallLineTiles(w.tx0, w.ty0, w.tx1, w.ty1);
    const plan = economy.planWallLine(world, PLAYER, type, tiles);
    if (plan.count === 0) {
      hud.toast(plan.reason || 'Cannot build there', 'warn');
      return; // stay armed — the player only has to move
    }

    // As with a single foundation, the crew is chosen here (it reads the local
    // selection) and dispatched there (it has to happen on the same tick as the
    // placement, on both machines). See the 'placeWallLine' case in
    // core/command.js, which also does the queueing.
    const wallCrew = pickBuilders(w.tx0, w.ty0);
    const res = bus.dispatch({
      t: 'placeWallLine',
      buildingType: type,
      tiles,
      builders: wallCrew.map((u) => u.id),
    });
    if (!res.ok) {
      hud.toast(res.reason || 'Cannot build there', 'warn');
      return;
    }

    // Locally we know exactly how many segments went down. Over a network we do
    // not yet, so the plan's own count — the same number the preview has been
    // showing under the player's finger — stands in for it.
    const n = res.detail ? res.detail.placed : plan.count;
    const refused = res.detail ? res.detail.refused : 0;
    const sent = wallCrew.length;

    const s = BUILDING_STATS[type];
    const label = `${n} ${s ? s.name : 'wall'}${n === 1 ? '' : 's'}`;
    if (refused) hud.toast(`${label} — ${refused} could not be placed`, 'warn');
    // AND ONLY SAY IT WHEN IT IS TRUE. "villagers on the way" was printed
    // unconditionally — including when somebody was already building and nobody
    // was sent, and including when the player had no villagers left at all, in
    // which case the wall simply never got built and the game had promised out
    // loud that it would. The crew is picked on this device before the command
    // goes out, so its size is knowable here even when the placement is not.
    else if (sent) hud.toast(`${label} — ${sent} villager${sent === 1 ? '' : 's'} on the way`, 'info');
    else hud.toast(`${label} — queued behind what is already building`, 'info');

    // The queueing and the crew dispatch both happened inside the command — the
    // wall is still built from one end inwards, which is what makes it useful
    // while it is going up, and a villager finishing one segment walks to the
    // next along the line instead of back to a tree. That is what
    // HANDOFF-walls.md left open. All that is left here is the dust.
    const first = res.detail && world.entities.get(res.detail.firstId);
    if (first) fx(first.x, first.y, 'build');
    else fx(w.tx0, w.ty0, 'build');

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
    if (wallType()) {
      // Said once, when the mode opens: the placement bar has room for the
      // building's name and nothing else, and "drag" is not a thing a player
      // guesses about a build button. Not for a gate — a gate is placed one at
      // a time (see wallType) and telling the player to drag one would be an
      // instruction to do something the game now refuses.
      hud.toast('Drag to draw a wall — two fingers to cancel', 'info');
    }
    if (!st.placeType) {
      st.ghost = null;
      pushGhost();
    } else {
      // Start the ghost in the middle of the part of the screen the player can
      // actually see, which is well above the middle of the canvas once the
      // dock and the bottom bar have taken their share.
      const v = viewRect();
      st.ghost = ghostAt(camera.width / 2, v.top + v.height / 2 + liftPx());
      pushGhost();
    }
  }

  /**
   * Keep an idle ghost honest.
   *
   * The seed ghost was computed once, when the mode opened, and then never
   * again until a finger touched the map — so it stayed green after the wood
   * that would have paid for it was spent elsewhere, and it stayed where it was
   * put while the minimap or the idle-villager button moved the camera out from
   * under it. Re-running it costs one cached refusal lookup (see refusalFor)
   * and only while a placement is armed and no gesture is in flight.
   */
  function refreshIdleGhost() {
    if (!st.placeType || st.mode !== 'none' || !st.ghost) return;
    const p = toScreen(st.ghost.gx, st.ghost.gy);
    const next = ghostAt(p.x, p.y + liftPx());
    if (!next) return;
    if (next.valid === st.ghost.valid && next.reason === st.ghost.reason &&
        next.gx === st.ghost.gx && next.gy === st.ghost.gy) return;
    st.ghost = next;
    pushGhost();
  }

  // ----------------------------------------------------------------- pointers

  function primary() {
    return st.pointers.get(st.order[0]);
  }

  function forgetPointer(id) {
    st.pointers.delete(id);
    for (let i = st.order.length - 1; i >= 0; i--) {
      if (st.order[i] === id) st.order.splice(i, 1);
    }
  }

  /**
   * Forget every finger and go back to a resting state.
   *
   * WHY THIS EXISTS. `pointerup` is not guaranteed. Pull down Control Centre
   * mid-drag, take a call, swipe the tab away, let the page go to the
   * background — and the up event for that finger never arrives, so its entry
   * sits in `pointers`/`order` forever. What happens next is not a small
   * glitch: the next real touch makes `order.length === 2`, which is a pinch
   * against a finger that is not there, so one finger zooms and throws the
   * camera across the map; on release the pinch branch hands the *phantom* the
   * role of surviving pointer and returns early, leaving `driving` true so even
   * the camera-adoption path in update() is dead. Every gesture after that is
   * wrong, permanently, until the page is reloaded — which is exactly the shape
   * of "sometimes everything isn't even selectable".
   */
  function resetPointers() {
    if (!st.pointers.size && !st.order.length) return;
    st.pointers.clear();
    st.order.length = 0;
    clearBox();
    cancelWallRun();
    st.mode = 'none';
    st.driving = false;
    st.pinch = null;
    st.vel.x = 0;
    st.vel.y = 0;
    st.samples.length = 0;
  }

  function twoPointers() {
    const a = st.pointers.get(st.order[0]);
    const b = st.pointers.get(st.order[1]);
    return a && b ? [a, b] : null;
  }

  function beginPinch() {
    const pair = twoPointers();
    if (!pair) {
      // The bookkeeping disagrees with itself. Rather than leave the state
      // machine in a mode nobody set — which used to swallow every subsequent
      // event — drop back to something that works.
      st.mode = st.order.length ? 'tap' : 'none';
      return;
    }
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

  // How close to the edge of the visible map a wall-drawing finger has to get
  // before the camera starts following it, and how fast it then follows.
  const EDGE_SCROLL_MARGIN = 56;   // screen px
  const EDGE_SCROLL_SPEED = 620;   // screen px per second at the very edge

  /**
   * Let a wall run reach past the edge of the screen.
   *
   * A run may be up to MAX_WALL_RUN (40) tiles, but a 390px portrait phone at
   * zoom 1 can only *see* about twelve of them — and the two-finger gesture that
   * would otherwise scroll the map is the documented way to abandon the run. So
   * the longest wall the player could actually draw was a third of the length
   * the game offers, and the way to find that out was to drag off the edge and
   * watch the preview snap back toward the corner of the map.
   *
   * Holding the finger near the edge now pans, which is the standard answer in
   * every RTS and needs no explanation. It only runs while a run is being drawn,
   * so it can never fight the ordinary gestures.
   */
  function edgeScrollWall(dt) {
    if (st.mode !== 'wallDraw' || !st.wall) return;
    const p = primary();
    if (!p) return;
    const v = viewRect();
    const z = camera.zoom || 1;
    const push = (pos, lo, hi) => {
      if (pos < lo + EDGE_SCROLL_MARGIN) return -(1 - (pos - lo) / EDGE_SCROLL_MARGIN);
      if (pos > hi - EDGE_SCROLL_MARGIN) return 1 - (hi - pos) / EDGE_SCROLL_MARGIN;
      return 0;
    };
    const ax = Math.max(-1, Math.min(1, push(p.x, 0, camera.width)));
    const ay = Math.max(-1, Math.min(1, push(p.y, v.top, camera.height - v.bottom)));
    if (!ax && !ay) return;
    cx += (ax * EDGE_SCROLL_SPEED * dt) / z;
    cy += (ay * EDGE_SCROLL_SPEED * dt) / z;
    applyCamera();
    // The finger has not moved but the ground under it has, so the run must be
    // recomputed against the new tile.
    updateWallRun(p.x, p.y);
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
    // Belt and braces on the mobile autoplay policy. The engine attaches its own
    // one-shot document listeners, but this is the first *trusted* gesture the
    // game itself sees, it costs a state check after the first success, and it
    // is the moment the ambient bed should start — a player who has just touched
    // the map is a player who is playing.
    unlockAudio();

    const p = gamePoint(ev);
    const now = performance.now();
    // A repeated pointerdown for a live id would push a second entry into
    // `order` that `splice` (which removes one index) can never take back out,
    // leaving an id in the order with no record in the map: `twoPointers()`
    // then returns null, `beginPinch()` bails without setting a mode, and every
    // later event falls out of both onMove and onUp on the "not the primary"
    // check. Input dies silently and stays dead.
    if (st.pointers.has(ev.pointerId)) forgetPointer(ev.pointerId);
    st.pointers.set(ev.pointerId, { id: ev.pointerId, x: p.x, y: p.y, t: now, dx: p.x, dy: p.y, dt: now });
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

    forgetPointer(ev.pointerId);

    if (st.mode === 'pinch') {
      if (st.order.length >= 2) { beginPinch(); return; }
      if (st.order.length === 1) {
        const rest = primary();
        // A STRAY SECOND CONTACT MUST NOT EAT A TAP. On a tall phone held in
        // one hand, the base of the thumb brushing the glass is routine: the
        // brush opens a pinch, the brush lifts, and this branch used to hand
        // the still-motionless original finger to the pan handler — so the tap
        // it was always going to be came out as a small camera fling instead,
        // and the order the player gave was simply lost. If that finger has not
        // moved and has not been down long, it is still a tap.
        const stillATap = rest &&
          Math.hypot(rest.x - rest.dx, rest.y - rest.dy) <= TAP_SLOP &&
          now - rest.dt < LONG_PRESS_MS;
        st.mode = stillATap ? 'tap' : 'pan';
        st.driving = !stillATap;
        st.anchor = stillATap
          ? { x: rest.dx, y: rest.dy, t: rest.dt }
          : { x: rest.x, y: rest.y, t: now };
        st.last = { x: rest.x, y: rest.y };
        st.samples.length = 0;
        if (!stillATap) sampleVelocity(rest, now);
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
    forgetPointer(ev.pointerId);
    if (st.mode === 'box') clearBox();
    if (st.mode === 'wallDraw') cancelWallRun();
    if (!st.order.length) {
      st.mode = 'none';
      st.driving = false;
      st.pinch = null;
    } else if (st.mode === 'pinch' && st.order.length < 2) {
      // A cancelled finger mid-pinch left the mode set to 'pinch' with only one
      // pointer left, and updatePinch bails on that — so the surviving finger
      // did nothing at all until it lifted.
      st.mode = 'tap';
      st.pinch = null;
      const rest = primary();
      if (rest) st.anchor = { x: rest.x, y: rest.y, t: performance.now() };
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

  // Every one of these is a way a `pointerup` never arrives. See resetPointers.
  const onLost = () => { if (st.pointers.size) resetPointers(); };
  const onHidden = () => { if (document.visibilityState !== 'visible') resetPointers(); };

  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', onDown, { passive: false });
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp, { passive: false });
  window.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('lostpointercapture', onLost);
  window.addEventListener('blur', onLost);
  window.addEventListener('pagehide', onLost);
  document.addEventListener('visibilitychange', onHidden);
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
    // Auto: with your own TROOPS in hand a drag picks more of them, otherwise
    // it moves the camera. Two fingers always pan, and a long press always gets
    // a box, so nothing is unreachable either way.
    //
    // "Troops", not "anything of yours", is the fix for the commonest way this
    // game fought its player. A selected *building* is menu state — you tapped
    // the Town Center to queue a villager, which happens every few seconds all
    // match — and it used to flip one-finger drag from pan to box for as long
    // as the building stayed selected. So the ordinary act of queueing a
    // villager took away the ordinary act of looking around, and the drag that
    // resulted was an empty box, which then wiped the selection. Nothing about
    // having a barracks selected suggests the next drag is about picking units.
    for (const id of world.selection) {
      const e = world.entities.get(id);
      if (e && !e.dead && e.player === PLAYER && e.kind === 'unit') return 'box';
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

    // Last line of defence. The two containers are written together everywhere,
    // so they can only disagree if an event was lost in a way the listeners
    // above did not catch — and the failure mode when they disagree is that
    // input stops working altogether rather than misbehaving visibly. One
    // integer comparison a frame buys back a state nobody can otherwise escape
    // without reloading the page.
    if (st.order.length !== st.pointers.size) resetPointers();
    refreshIdleGhost();
    edgeScrollWall(dt);

    // A held finger that has not moved arms a box select — the escape hatch
    // that makes group-picking reachable even while the camera owns drags.
    //
    // ONLY WHEN IT IS AN ESCAPE HATCH. Unconditionally it was the opposite: it
    // fired when the rule already said box (adding nothing), and it fired when
    // the player had explicitly locked the mode chip to "pan" (overriding a
    // choice they had just made by hand). Both cases turn a deliberate pan into
    // a rectangle, which is the gesture the chip exists to let them refuse.
    if (st.mode === 'tap' && st.order.length === 1 && st.anchor &&
        st.dragPref === 'auto' && effectiveDragMode() === 'pan') {
      const p = primary();
      const moved = p ? Math.hypot(p.x - st.anchor.x, p.y - st.anchor.y) : 0;
      if (moved <= TAP_SLOP && performance.now() - st.anchor.t > LONG_PRESS_MS) {
        startBox(st.anchor.x, st.anchor.y);
        // Say so. A rectangle appearing under a finger that was not moving is
        // otherwise indistinguishable from a bug.
        hud.toast('Box select — drag to pick troops', 'info');
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
    canvas.removeEventListener('lostpointercapture', onLost);
    window.removeEventListener('blur', onLost);
    window.removeEventListener('pagehide', onLost);
    document.removeEventListener('visibilitychange', onHidden);
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
    // The tests aim a synthetic touch at a known tile, so they need the same
    // offset the ghost uses. It used to be copied into two test files as a
    // literal 62 with a "must match ui/input.js" comment, which stopped being
    // true the moment the lift learned about zoom.
    _ghostLift: liftPx,
    _viewRect: viewRect,
    // The two snap paths, so a test can assert they agree rather than trusting
    // that they were derived from the same function.
    _ghostAt: ghostAt,
    _tileUnder: tileUnder,
    _cancelWallRun: cancelWallRun,
  };

  if (hud && typeof hud.attachInput === 'function') hud.attachInput(api);
  return api;
}
