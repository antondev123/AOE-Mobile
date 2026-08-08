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
// The player can lock either mode from the chip, and a long press always gets
// a box even when the rule says pan — so no situation is unreachable. Adding a
// second finger mid-gesture always cancels a box and becomes a pinch, which
// means an accidental extra finger never eats your selection.
// ---------------------------------------------------------------------------

import {
  TAP_SLOP, TAP_TIME_MS, DRAG_BOX_THRESHOLD, TAP_PICK_RADIUS,
  ZOOM_MIN, ZOOM_MAX, MAP_W, MAP_H, HALF_W, HALF_H,
  PLAYER, BUILDING_STATS,
} from '../core/constants.js';
import { EV } from '../core/events.js';
import { screenDist, worldToGrid } from '../core/iso.js';
import { canPlace } from '../core/world.js';

import * as unitAI from '../systems/unitAI.js';
import * as economy from '../systems/economy.js';

import { setSelection, clearSelection, selectedEntities } from './selection.js';

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

const MILITARY = new Set(['militia', 'archer']);

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

  function tierOf(e) {
    if (e.player === PLAYER) return e.kind === 'unit' ? 0 : 1;
    if (e.player !== null && e.player !== undefined) return e.kind === 'unit' ? 2 : 3;
    return 4; // resources
  }

  /**
   * Best entity within TAP_PICK_RADIUS *screen* pixels of the touch.
   *
   * Fat-finger friendly: two probe points, footprint-aware distances, and the
   * preference order own units > own buildings > enemies > resources.
   *
   * The preference is applied within a tolerance rather than absolutely: a
   * better-ranked entity wins only if it is roughly as close to the finger as
   * the nearest thing. Strict ranking would make an enemy standing in a melee
   * with your own troops impossible to tap, which is exactly when you most want
   * to attack it. Within TIER_SLACK the ranking decides; beyond it, aim wins.
   */
  function pickAt(sx, sy) {
    const z = camera.zoom || 1;
    const radius = TAP_PICK_RADIUS / z; // compare in unzoomed screen px
    const slack = TIER_SLACK / z;
    const probes = [toGrid(sx, sy), toGrid(sx, sy + PICK_PROBE_DOWN)];
    // Cheap grid-space reject box around both probes.
    const gridPad = radius / HALF_H + 2;

    const bestOf = [null, null, null, null, null]; // one candidate per tier
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
      const tier = tierOf(e);
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
    const buildings = own.filter((e) => e.kind === 'building');

    // Tapping something of yours selects it — unless it is a foundation and you
    // have villagers in hand, in which case it is obviously a build order.
    if (pick && pick.player === PLAYER) {
      if (pick.kind === 'building' && !pick.complete && villagers.length &&
          !world.selection.has(pick.id)) {
        command(villagers, { type: 'build', gx: pick.x, gy: pick.y, target: pick });
        fx(pick.x, pick.y, 'build');
        return;
      }
      setSelection(world, [pick]);
      return;
    }

    if (units.length === 0) {
      // No units in hand: buildings get a rally point, otherwise this is a
      // plain selection (or a deselect on empty ground).
      if (!pick && buildings.length) {
        const gx = Math.max(0, Math.min(MAP_W, g.x));
        const gy = Math.max(0, Math.min(MAP_H, g.y));
        for (const b of buildings) b.rally = { x: gx, y: gy };
        fx(gx, gy, 'move');
        hud.toast('Rally point set', 'info');
        return;
      }
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

  function ghostAt(sx, sy) {
    const type = st.placeType;
    const s = BUILDING_STATS[type];
    if (!s) return null;
    const g = toGrid(sx, sy - GHOST_LIFT);
    // Snap exactly the way spawnBuilding() will, so the ghost never lies.
    const gx = Math.floor(g.x - s.fw / 2) + s.fw / 2;
    const gy = Math.floor(g.y - s.fh / 2) + s.fh / 2;
    const valid = canPlace(world, gx, gy, s.fw, s.fh) && canAffordType(type);
    return { type, gx, gy, valid };
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
      hud.toast(canAffordType(gh.type) ? 'Cannot build there' : 'Not enough resources', 'warn');
      return; // stay in placement mode — the player just needs to move a bit
    }
    if (typeof economy.placeFoundation !== 'function') return;
    const f = economy.placeFoundation(world, PLAYER, gh.type, gh.gx, gh.gy);
    if (!f) return; // economy already explained why

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
    fx(f.x, f.y, 'build');
    hud.setPlacementMode(null);
    syncPlacement();
  }

  /** Mirror hud's placement mode into the input state machine. */
  function syncPlacement() {
    const want = (hud && typeof hud.getPlacementType === 'function') ? hud.getPlacementType() : null;
    if (want === st.placeType) return;
    st.placeType = want || null;
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
      if (st.placeType) {
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
        st.anchor = { x: rest.x, y: rest.y, t: now };
        st.last = { x: rest.x, y: rest.y };
        st.samples.length = 0;
        return;
      }
      st.mode = 'none';
      st.driving = false;
      st.pinch = null;
      return;
    }

    if (!wasPrimary) return;

    if (st.mode === 'box') {
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
      if (st.placeType) { hud.setPlacementMode(null); syncPlacement(); }
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
    _toScreen: toScreen,
    _toGrid: toGrid,
  };

  if (hud && typeof hud.attachInput === 'function') hud.attachInput(api);
  return api;
}
