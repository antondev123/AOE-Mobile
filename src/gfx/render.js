// The renderer. Owns the camera, the baked terrain, every entity sprite and
// the world-space overlays (selection, health bars, carry indicators,
// placement ghost, drag box).
//
// Shape of a frame:
//   1. work out the visible world rect once
//   2. walk resources / buildings / units, pull a pooled sprite for each
//      visible one, position + depth-sort it
//   3. redraw the overlay Graphics in one pass
//   4. tick FX
//
// Terrain is baked into a handful of RenderTextures at startup and never
// touched again, so 2304 tiles cost nothing per frame.

import {
  MAP_W, MAP_H, HALF_W, HALF_H, TILE_W, TILE_H,
  ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT, PLAYER,
  BUILDING_STATS,
} from '../core/constants.js';
import { depthFor } from '../core/iso.js';
import {
  buildTextures, ATLAS, TILE_TEX_W, TILE_TEX_H, TILE_TEX_OFF_X, TILE_TEX_OFF_Y,
  terrainFrame, unitFrame, buildingFrame, foundationFrame, resourceFrame,
  markerFrame, farmFrame, farmFoundationFrame,
  oceanFrame, edgeBlendFrame, shoreFrame, BLOB_FRAME,
  TERRAIN_VARIANTS, RESOURCE_VARIANTS,
  TERRAIN_BORDER, OCEAN_LEVELS, OCEAN_DEEP, TERRAIN_BASE, TERRAIN_PRIORITY,
} from './textures.js';
import { createFx } from './fx.js';

// Facing index -> { back, flip }. See DIRS in iso.js: 0=S 1=SW 2=W 3=NW 4=N
// 5=NE 6=E 7=SE on screen.
const FACE_BACK = [false, false, false, true, true, true, false, false];
const FACE_FLIP = [false, true, true, true, false, false, false, false];

const RES_COLOR = { food: 0xe8524a, wood: 0xc98a45, gold: 0xf5c333 };

// How far outside the camera an entity may be before we stop drawing it.
const CULL_PAD = 140;

const TERRAIN_CHUNK = 512;

export function createRenderer(scene, world) {
  const tex = buildTextures(scene);
  const origins = tex.origins;

  const camera = scene.cameras.main;

  // --- camera --------------------------------------------------------------
  // The playable diamond spans x in [-MAP_H*HALF_W, MAP_W*HALF_W] and
  // y in [0, (MAP_W+MAP_H)*HALF_H] (see the header of iso.js). Its bounding
  // box therefore has four empty corners, which used to show as raw canvas
  // background — a dead black band across the top of the opening view.
  //
  // Camera bounds and the terrain bake now use the *same* rectangle, so there
  // is no reachable pixel the bake has not painted, and the pad is kept small
  // so the player cannot drift far off the coast.
  const worldRect = {
    minX: -MAP_H * HALF_W - TILE_W,
    minY: -TILE_H * 2,
    maxX: MAP_W * HALF_W + TILE_W,
    maxY: (MAP_W + MAP_H) * HALF_H + TILE_H * 2,
  };
  camera.setBounds(
    worldRect.minX, worldRect.minY,
    worldRect.maxX - worldRect.minX, worldRect.maxY - worldRect.minY,
    true,
  );
  camera.setZoom(ZOOM_DEFAULT);
  camera.setRoundPixels(true);

  // --- viewport ------------------------------------------------------------
  // Phaser's RESIZE-mode ScaleManager can drop an orientation flip.
  //
  // Two DOM listeners race on a rotate: the `screen.orientation` "change"
  // handler calls scale.refresh() straight away, while the window "resize"
  // handler only sets scale.dirty and leaves the work to the next
  // ScaleManager.step(). When orientation wins, refresh() -> updateScale()
  // resizes the canvas from `parentSize`, which is still the *old* size, so
  // nothing actually changes — and then the getParentBounds() call at the tail
  // of updateScale() quietly caches the *new* parent size. The following
  // step() therefore sees "parent unchanged" and never refreshes again.
  //
  // The canvas, the WebGL renderer and every camera stay at the portrait size
  // for good. Terrain, units and effects are all clipped to that stale
  // rectangle, so everything past the old edge draws as bare background — the
  // black right-hand half of a rotated phone.
  //
  // Re-driving scale.resize() with the parent size the ScaleManager itself has
  // already measured puts canvas, renderer and cameras back in step. It
  // re-emits 'resize', but that second pass is a no-op because by then the
  // sizes agree, so there is no loop and no cost when nothing is wrong.
  const scaler = scene.scale;
  let syncing = false;
  let sinceSizeCheck = 0;

  function syncViewport() {
    if (syncing || !scaler || scaler.scaleMode !== Phaser.Scale.RESIZE) return;
    const parent = scaler.parentSize;
    if (!parent) return;
    const w = Math.floor(parent.width);
    const h = Math.floor(parent.height);
    if (w <= 0 || h <= 0) return;
    if (scaler.gameSize.width === w && scaler.gameSize.height === h) return;
    syncing = true;
    try {
      scaler.resize(w, h);
    } finally {
      syncing = false;
    }
    refreshCamMap();
  }

  const onResize = () => syncViewport();
  if (scaler) scaler.on('resize', onResize);

  // --- terrain -------------------------------------------------------------
  // Baked once, over the whole map diamond rather than the boot-time view, so
  // no viewport change, zoom-out or pan can reach unpainted ground.
  const chunks = bakeTerrain(scene, world, worldRect);

  // --- pools ---------------------------------------------------------------
  const markerPool = makePool(() => mkImage(scene, markerFrame(0), -1));
  const unitPool = makePool(() => mkImage(scene, unitFrame('villager', 0, false), -1));
  const bldPool = makePool(() => mkImage(scene, buildingFrame('house', 0), -1));
  const resPool = makePool(() => mkImage(scene, resourceFrame('tree', 0), -1));
  const selPool = makePool(() => mkImage(scene, 'mk_sel', -1));
  const ghostPool = makePool(() => mkImage(scene, 'tile_hi', -1));

  // --- overlays ------------------------------------------------------------
  // One Graphics for every bar/ring/indicator: a single draw call for the lot,
  // and always on top so nothing important hides behind a roof.
  const overlay = scene.add.graphics();
  overlay.setDepth(800000);

  const screenG = scene.add.graphics();
  screenG.setDepth(950000);

  // --- state ---------------------------------------------------------------
  let ghost = null;      // { type, gx, gy, valid }
  let dragBox = null;    // screen-space { x, y, w, h }
  let t = 0;

  const viewRect = { x: 0, y: 0, r: 0, b: 0 };
  const _wp0 = new Phaser.Math.Vector2();
  const _wp1 = new Phaser.Math.Vector2();

  const fx = createFx(scene, world, { depthFor, camera, viewRect, origins });

  // Other systems own the entity types; if one ever grows a type we have no
  // art for, fall back rather than spraying missing-frame warnings.
  const has = (frame) => origins.has(frame);
  /** Clamp an owner id into the range we generated colours for. */
  const pi = (player) => (player === 1 ? 1 : 0);
  function unitFrameFor(type, player, back) {
    const f = unitFrame(type, player, back);
    return has(f) ? f : unitFrame('villager', player, back);
  }
  function buildingFrameFor(type, player, b) {
    if (type === 'farm') return farmFrame(player, farmStage(b));
    const f = buildingFrame(type, player);
    return has(f) ? f : buildingFrame('house', player);
  }
  function resourceFrameFor(type, variant) {
    const n = RESOURCE_VARIANTS[type];
    const f = resourceFrame(type, n ? variant % n : 0);
    return has(f) ? f : resourceFrame('tree', 0);
  }

  // Cached screen<->world affine terms, refreshed whenever the camera moves.
  const camMap = { sx: 0, sy: 0, zoom: 0, w: 0, h: 0, ax: 1, bx: 0, ay: 1, by: 0 };

  function refreshCamMap() {
    if (
      camMap.sx === camera.scrollX && camMap.sy === camera.scrollY &&
      camMap.zoom === camera.zoom && camMap.w === camera.width && camMap.h === camera.height
    ) return;
    camera.getWorldPoint(0, 0, _wp0);
    camera.getWorldPoint(100, 100, _wp1);
    camMap.ax = (_wp1.x - _wp0.x) / 100;
    camMap.bx = _wp0.x;
    camMap.ay = (_wp1.y - _wp0.y) / 100;
    camMap.by = _wp0.y;
    camMap.sx = camera.scrollX;
    camMap.sy = camera.scrollY;
    camMap.zoom = camera.zoom;
    camMap.w = camera.width;
    camMap.h = camera.height;
  }

  function screenToWorld(sx, sy, out) {
    refreshCamMap();
    out.x = camMap.ax * sx + camMap.bx;
    out.y = camMap.ay * sy + camMap.by;
    return out;
  }

  function worldToScreen(wx, wy, out) {
    refreshCamMap();
    out.x = (wx - camMap.bx) / camMap.ax;
    out.y = (wy - camMap.by) / camMap.ay;
    return out;
  }

  const _tmpA = { x: 0, y: 0 };
  const _tmpB = { x: 0, y: 0 };

  // --- public API ----------------------------------------------------------

  function screenToGrid(sx, sy) {
    screenToWorld(sx, sy, _tmpA);
    const a = _tmpA.x / HALF_W;
    const b = _tmpA.y / HALF_H;
    return { x: (a + b) / 2, y: (b - a) / 2 };
  }

  function gridToScreen(gx, gy) {
    const out = { x: 0, y: 0 };
    worldToScreen((gx - gy) * HALF_W, (gx + gy) * HALF_H, out);
    return out;
  }

  function centerOn(gx, gy) {
    camera.centerOn((gx - gy) * HALF_W, (gx + gy) * HALF_H);
    refreshCamMap();
  }

  function setPlacementGhost(type, gx, gy, valid) {
    if (!type) {
      ghost = null;
      return;
    }
    ghost = { type, gx, gy, valid: valid !== false };
  }

  function setDragBox(rect) {
    dragBox = rect || null;
  }

  // --- frame ---------------------------------------------------------------

  function update(alpha, dt) {
    t += dt;

    // Belt and braces: the 'resize' event above can fire while the browser is
    // still settling a rotation, in which case the size we synced to was the
    // intermediate one and no further event is coming. This re-check only
    // compares numbers the ScaleManager already keeps — no DOM reads, no
    // layout, and it does nothing at all once the sizes agree.
    sinceSizeCheck += dt;
    if (sinceSizeCheck >= 0.5) {
      sinceSizeCheck = 0;
      syncViewport();
    }

    refreshCamMap();

    // Visible world rect (exact, straight off the camera transform).
    screenToWorld(0, 0, _tmpA);
    screenToWorld(camera.width, camera.height, _tmpB);
    viewRect.x = _tmpA.x - CULL_PAD;
    viewRect.y = _tmpA.y - CULL_PAD;
    viewRect.r = _tmpB.x + CULL_PAD;
    viewRect.b = _tmpB.y + CULL_PAD;

    markerPool.reset();
    unitPool.reset();
    bldPool.reset();
    resPool.reset();
    selPool.reset();
    ghostPool.reset();

    overlay.clear();
    // Bars and dots are only *partially* zoom-compensated: fully compensating
    // makes them swamp the units when zoomed out, not compensating at all makes
    // them unreadable. sqrt splits the difference.
    const invZ = 1 / Math.sqrt(camera.zoom);

    drawResources();
    drawBuildings(invZ);
    drawUnits(alpha, invZ);
    drawGhost();

    markerPool.trim();
    unitPool.trim();
    bldPool.trim();
    resPool.trim();
    selPool.trim();
    ghostPool.trim();

    drawDragBox();

    fx.update(dt);
  }

  function visible(wx, wy) {
    return wx > viewRect.x && wx < viewRect.r && wy > viewRect.y && wy < viewRect.b;
  }

  function drawResources() {
    const list = world.resources;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dead) continue;
      const wx = (e.x - e.y) * HALF_W;
      const wy = (e.x + e.y) * HALF_H;
      if (!visible(wx, wy)) continue;
      const frame = resourceFrameFor(e.type, e.variant || 0);
      const s = resPool.get();
      setFrame(s, frame, origins);
      s.setPosition(wx, wy);
      s.setDepth(depthFor(e.x, e.y, 2));
      // A node visibly shrinks as it is worked out, so players can see which
      // trees are nearly gone without selecting them.
      const left = e.maxAmount ? e.amount / e.maxAmount : 1;
      s.setScale(0.82 + 0.18 * Math.max(0, Math.min(1, left)));
      if (world.selection.has(e.id)) {
        overlayNodeRing(e);
      }
    }
  }

  function overlayNodeRing(e) {
    const wx = (e.x - e.y) * HALF_W;
    const wy = (e.x + e.y) * HALF_H;
    overlay.lineStyle(2.5 / camera.zoom, 0xffe45c, 0.95);
    overlay.strokeEllipse(wx, wy, 40, 20);
  }

  function drawBuildings(invZ) {
    const list = world.buildings;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.dead) continue;
      const wx = (b.x - b.y) * HALF_W;
      const wy = (b.x + b.y) * HALF_H;
      if (!visible(wx, wy)) continue;
      const depth = depthFor(b.x, b.y, 1);
      const player = pi(b.player === undefined || b.player === null ? PLAYER : b.player);

      const progress = b.complete
        ? 1
        : Math.max(0, Math.min(1, (b.buildProgress || 0) / (b.buildTime || 1)));

      let fo = null;
      if (!b.complete) {
        const fFrame = b.type === 'farm'
          ? farmFoundationFrame(player)
          : foundationFrame(b.fw >= 3 ? 3 : 2, player);
        fo = origins.get(fFrame);
        const fs = bldPool.get();
        setFrame(fs, fFrame, origins);
        fs.setPosition(wx, wy);
        fs.setDepth(depth);
        fs.setAlpha(1);
        fs.setScale(1);
      }

      const bFrame = buildingFrameFor(b.type, player, b);
      const s = bldPool.get();
      setFrame(s, bFrame, origins);
      s.setPosition(wx, wy);
      s.setDepth(depth + 0.4);
      s.setScale(1);
      const o = origins.get(bFrame);
      if (b.complete) {
        if (s.isCropped) s.setCrop();
        s.setAlpha(1);
      } else {
        // The building rises out of its foundation as it is built.
        const shown = Math.max(0.02, progress);
        s.setCrop(0, o.h * (1 - shown), o.w, o.h * shown);
        s.setAlpha(0.55 + 0.45 * progress);
      }

      const selected = world.selection.has(b.id);
      if (selected) footprintOutline(b, 0xffe45c);

      // Bar sits just above the sprite's own top edge, whatever its height.
      // While building, it tracks the visible (cropped) top so it rises with
      // the structure rather than hovering over empty sky.
      const top = o.h * o.oy;
      if (!b.complete) {
        const visTop = Math.max(fo ? fo.h * fo.oy : 0, top * progress);
        bar(overlay, wx, wy - visTop - 7 * invZ, 30 * invZ, 4.5 * invZ, progress, 0xf3c04a, invZ);
      } else if (b.hp < b.maxHp || selected) {
        bar(
          overlay, wx, wy - top - 7 * invZ, 30 * invZ, 4.5 * invZ,
          b.hp / b.maxHp, b.player === PLAYER ? 0x4ade80 : 0xf05252, invZ,
        );
      }

      // Rally point flag, for the player's own production buildings.
      if (selected && b.rally && typeof b.rally.x === 'number') {
        const rx = (b.rally.x - b.rally.y) * HALF_W;
        const ry = (b.rally.x + b.rally.y) * HALF_H;
        overlay.lineStyle(2 * invZ, 0x9ad8ff, 0.85);
        overlay.beginPath();
        overlay.moveTo(wx, wy);
        overlay.lineTo(rx, ry);
        overlay.strokePath();
        overlay.fillStyle(0x9ad8ff, 0.9);
        overlay.fillCircle(rx, ry, 4 * invZ);
      }
    }
  }

  function footprintOutline(b, color) {
    const hw = (b.fw + b.fh) * HALF_W * 0.5;
    const hh = (b.fw + b.fh) * HALF_H * 0.5;
    const wx = (b.x - b.y) * HALF_W;
    const wy = (b.x + b.y) * HALF_H;
    overlay.lineStyle(3 / camera.zoom, 0x000000, 0.45);
    strokeDiamond(overlay, wx, wy, hw, hh);
    overlay.lineStyle(2 / camera.zoom, color, 1);
    strokeDiamond(overlay, wx, wy, hw, hh);
  }

  function drawUnits(alpha, invZ) {
    const list = world.units;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (u.dead) continue;
      // Interpolate between sim steps: the sim runs at 20Hz, we draw at 60.
      const gx = u.px + (u.x - u.px) * alpha;
      const gy = u.py + (u.y - u.py) * alpha;
      const wx = (gx - gy) * HALF_W;
      const wy = (gx + gy) * HALF_H;
      if (!visible(wx, wy)) continue;

      const depth = depthFor(gx, gy, 3);
      const player = pi(u.player === undefined || u.player === null ? PLAYER : u.player);
      const selected = world.selection.has(u.id);

      // 1. team-coloured ground ellipse — the thing that makes a 30px unit
      //    legible on a phone.
      const m = markerPool.get();
      setFrame(m, markerFrame(player), origins);
      m.setPosition(wx, wy);
      m.setDepth(depth);
      m.setScale(u.type === 'militia' ? 1.12 : 1);

      if (selected) {
        const sel = selPool.get();
        setFrame(sel, 'mk_sel', origins);
        sel.setPosition(wx, wy);
        sel.setDepth(depth + 0.1);
        // Gentle pulse so the selection reads even against a busy background.
        sel.setScale(1 + Math.sin(t * 5) * 0.05);
      }

      // 2. body
      const face = u.facing | 0;
      const back = FACE_BACK[face & 7];
      const flip = FACE_FLIP[face & 7];
      const uFrame = unitFrameFor(u.type, player, back);
      const s = unitPool.get();
      setFrame(s, uFrame, origins);
      s.setFlipX(flip);
      s.setDepth(depth + 0.2);
      const uo = origins.get(uFrame);

      let bob = 0;
      let rot = 0;
      const phase = (u.id % 32) * 0.63;
      switch (u.state) {
        case 'move':
        case 'deposit':
          bob = -Math.abs(Math.sin(t * 9 + phase)) * 2.6;
          break;
        case 'gather':
          rot = Math.sin(t * 7 + phase) * 0.34 - 0.1;
          break;
        case 'build':
          rot = Math.sin(t * 9 + phase) * 0.28 - 0.08;
          break;
        case 'attack':
          rot = Math.sin(t * 11 + phase) * 0.26;
          break;
        default:
          bob = Math.sin(t * 2.2 + phase) * 0.7;
          break;
      }
      s.setPosition(wx, wy + bob);
      s.setRotation(flip ? -rot : rot);

      const top = wy - uo.h * uo.oy;

      // 3. health bar — only when hurt, or when selected.
      const hurt = u.hp < u.maxHp;
      if (hurt || selected) {
        bar(
          overlay, wx, top - 5 * invZ, 18 * invZ, 3.6 * invZ, u.hp / u.maxHp,
          player === PLAYER ? 0x4ade80 : 0xf05252, invZ,
        );
      }

      // 4. carrying indicator — makes the gather loop visible at a glance.
      const carry = u.carrying;
      if (carry && carry.amount > 0 && carry.type) {
        const cc = RES_COLOR[carry.type] || 0xffffff;
        const cx = wx + 11 * invZ;
        const cy = top + 6 * invZ;
        const r = 4.6 * invZ;
        overlay.fillStyle(0x120e08, 0.9);
        overlay.fillCircle(cx, cy, r * 1.35);
        overlay.fillStyle(cc, 1);
        overlay.fillCircle(cx, cy, r);
        overlay.fillStyle(0xffffff, 0.6);
        overlay.fillCircle(cx - r * 0.3, cy - r * 0.35, r * 0.36);
      }
    }
  }

  function drawGhost() {
    if (!ghost) return;
    const st = BUILDING_STATS[ghost.type];
    if (!st) return;
    // Match world.js's snapping exactly, so the preview is where it will land.
    const ox = Math.floor(ghost.gx - st.fw / 2);
    const oy = Math.floor(ghost.gy - st.fh / 2);
    const cx = ox + st.fw / 2;
    const cy = oy + st.fh / 2;
    const tint = ghost.valid ? 0x5ce08d : 0xff5a5a;

    for (let y = 0; y < st.fh; y++) {
      for (let x = 0; x < st.fw; x++) {
        const tx = ox + x;
        const ty = oy + y;
        const wx = (tx - ty) * HALF_W;
        const wy = (tx + ty + 1) * HALF_H;
        const h = ghostPool.get();
        setFrame(h, 'tile_hi', origins);
        h.setOrigin(0.5, 0.5);
        h.setPosition(wx, wy);
        h.setDepth(depthFor(tx, ty, 0.5));
        h.setTint(tint);
        h.setAlpha(0.9);
        h.setScale(1);
      }
    }

    const wx = (cx - cy) * HALF_W;
    const wy = (cx + cy) * HALF_H;
    const g = ghostPool.get();
    setFrame(g, buildingFrameFor(ghost.type, PLAYER), origins);
    g.setPosition(wx, wy);
    g.setDepth(depthFor(cx, cy, 400));
    // Valid: show the building nearly as-is so the player can judge the fit.
    // Invalid: wash it red — no ambiguity about why the tap did nothing.
    if (ghost.valid) {
      g.clearTint();
      g.setAlpha(0.78);
    } else {
      g.setTint(0xff8080);
      g.setAlpha(0.6);
    }
    g.setScale(1);

    // Bold outline around the whole footprint.
    const ohw = (st.fw + st.fh) * HALF_W * 0.5;
    const ohh = (st.fw + st.fh) * HALF_H * 0.5;
    overlay.lineStyle(4 / camera.zoom, 0x0b1a10, 0.5);
    strokeDiamond(overlay, wx, wy, ohw, ohh);
    overlay.lineStyle(2.5 / camera.zoom, tint, 1);
    strokeDiamond(overlay, wx, wy, ohw, ohh);
  }

  function drawDragBox() {
    screenG.clear();
    if (!dragBox) return;
    const x0 = Math.min(dragBox.x, dragBox.x + dragBox.w);
    const y0 = Math.min(dragBox.y, dragBox.y + dragBox.h);
    const x1 = Math.max(dragBox.x, dragBox.x + dragBox.w);
    const y1 = Math.max(dragBox.y, dragBox.y + dragBox.h);
    screenToWorld(x0, y0, _tmpA);
    screenToWorld(x1, y1, _tmpB);
    const w = _tmpB.x - _tmpA.x;
    const h = _tmpB.y - _tmpA.y;
    const lw = 2 / camera.zoom;
    screenG.fillStyle(0x7fe3a0, 0.14);
    screenG.fillRect(_tmpA.x, _tmpA.y, w, h);
    screenG.lineStyle(lw + 2 / camera.zoom, 0x0d1a12, 0.55);
    screenG.strokeRect(_tmpA.x, _tmpA.y, w, h);
    screenG.lineStyle(lw, 0x8bffb5, 0.95);
    screenG.strokeRect(_tmpA.x, _tmpA.y, w, h);
  }

  function destroy() {
    // The scene is torn down and relaunched on "Play again"; a surviving
    // listener would pile up one dead renderer per game.
    if (scaler) scaler.off('resize', onResize);
    fx.destroy();
    markerPool.destroy();
    unitPool.destroy();
    bldPool.destroy();
    resPool.destroy();
    selPool.destroy();
    ghostPool.destroy();
    overlay.destroy();
    screenG.destroy();
    for (const c of chunks) c.destroy();
    chunks.length = 0;
  }

  return {
    update,
    destroy,
    centerOn,
    camera,
    screenToGrid,
    gridToScreen,
    setPlacementGhost,
    setDragBox,
    // Extras other systems may find useful; not part of the required contract.
    fx,
    atlas: ATLAS,
    zoomLimits: { min: ZOOM_MIN, max: ZOOM_MAX },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkImage(scene, frame, depth) {
  const s = scene.add.image(0, 0, ATLAS, frame);
  s.setDepth(depth);
  s.setVisible(false);
  return s;
}

/**
 * Which of the three farm arts to draw: 0 fresh, 1 worked, 2 spent.
 *
 * The farm's gameplay side is owned elsewhere, so this reads whatever field
 * that code ends up using for "food left" rather than insisting on one name,
 * and falls back to "fresh" if it finds nothing. A farm you cannot tell apart
 * from a full one is a worse failure than a farm that never looks spent.
 */
function farmStage(b) {
  if (!b) return 0;
  if (b.depleted || b.exhausted || b.spent) return 2;
  const st = BUILDING_STATS.farm;
  const max =
    num(b.maxAmount) ?? num(b.maxResource) ??
    num(st && st.provides && st.provides.amount);
  let cur = num(b.amount);
  if (cur === undefined) cur = num(b.remaining);
  if (cur === undefined) cur = num(b.resourceLeft);
  if (cur === undefined) cur = num(b.provides && b.provides.amount);
  if (cur === undefined || max === undefined || max <= 0) return 0;
  const f = cur / max;
  if (f <= 0.03) return 2;
  if (f <= 0.5) return 1;
  return 0;
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

/** Set a pooled sprite's frame and re-apply that frame's origin. */
function setFrame(s, frame, origins) {
  if (s._frameKey !== frame) {
    s.setTexture(ATLAS, frame);
    const o = origins.get(frame);
    if (o) s.setOrigin(o.ox, o.oy);
    s._frameKey = frame;
  }
  if (s.isCropped) s.setCrop();
  s.clearTint();
  s.setFlipX(false);
  s.setRotation(0);
  s.setAlpha(1);
}

function makePool(create) {
  const items = [];
  let n = 0;
  return {
    get() {
      let it = items[n];
      if (!it) {
        it = create();
        items.push(it);
      }
      n++;
      if (!it.visible) it.setVisible(true);
      return it;
    },
    reset() { n = 0; },
    trim() {
      for (let i = n; i < items.length; i++) {
        if (items[i].visible) items[i].setVisible(false);
      }
    },
    destroy() {
      for (const it of items) it.destroy();
      items.length = 0;
      n = 0;
    },
  };
}

/** Health / progress bar in world space, pre-scaled to hold its screen size. */
function bar(g, wx, wy, w, h, frac, color, invZ) {
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  const pad = 1.2 * invZ;
  g.fillStyle(0x0b0906, 0.8);
  g.fillRect(wx - w / 2 - pad, wy - pad, w + pad * 2, h + pad * 2);
  g.fillStyle(0x3a3630, 1);
  g.fillRect(wx - w / 2, wy, w, h);
  g.fillStyle(color, 1);
  g.fillRect(wx - w / 2, wy, w * f, h);
  g.fillStyle(0xffffff, 0.25);
  g.fillRect(wx - w / 2, wy, w * f, h * 0.4);
}

function strokeDiamond(g, cx, cy, hw, hh) {
  g.beginPath();
  g.moveTo(cx, cy - hh);
  g.lineTo(cx + hw, cy);
  g.lineTo(cx, cy + hh);
  g.lineTo(cx - hw, cy);
  g.closePath();
  g.strokePath();
}

/**
 * Bake the whole world into a grid of RenderTextures. Terrain never changes
 * after map generation, so this happens exactly once and costs nothing per
 * frame — which is why every one of the passes below is done here and not in
 * update().
 *
 * Passes, in order:
 *   0. flat deep-water fill over the entire bake rect
 *   1. a tiled sea shelf that deepens away from the island, so the fill is
 *      never met head-on
 *   2. the map's own terrain tiles
 *   3. edge-blend washes, which feather the hard diamond staircases where
 *      grass/dirt/sand meet
 *   4. surf along the coastline
 *   5. very faint map-scale mottling, so wide single-terrain regions vary
 */
function bakeTerrain(scene, world, rect) {
  const { minX, minY, maxX, maxY } = rect;
  const cols = Math.ceil((maxX - minX) / TERRAIN_CHUNK);
  const rows = Math.ceil((maxY - minY) / TERRAIN_CHUNK);

  // Chunks overlap by CHUNK_PAD so neighbours cover each other's edge pixels;
  // without it, a hairline seam shows wherever two chunks meet.
  const CHUNK_PAD = 4;
  const chunks = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const ox = minX + cx * TERRAIN_CHUNK - CHUNK_PAD;
      const oy = minY + cy * TERRAIN_CHUNK - CHUNK_PAD;
      const size = TERRAIN_CHUNK + CHUNK_PAD * 2;
      const rt = scene.add.renderTexture(ox, oy, size, size);
      rt.setOrigin(0, 0);
      rt.setDepth(-1000000);
      rt._ox = ox;
      rt._oy = oy;
      rt._size = size;
      chunks.push(rt);
    }
  }

  const ops = buildTerrainOps(world);

  for (const rt of chunks) {
    const x0 = rt._ox - TILE_TEX_W - 90;
    const y0 = rt._oy - TILE_TEX_H - 60;
    const x1 = rt._ox + rt._size + 90;
    const y1 = rt._oy + rt._size + 60;
    rt.fill(OCEAN_DEEP, 1);
    rt.beginDraw();
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (o.x < x0 || o.x > x1 || o.y < y0 || o.y > y1) continue;
      rt.batchDrawFrame(ATLAS, o.f, o.x - rt._ox, o.y - rt._oy, o.a, o.t);
    }
    rt.endDraw();
  }

  return chunks;
}

/** Screen position for a tile's terrain blit. */
function tilePos(tx, ty, out) {
  out.x = (tx - ty) * HALF_W - TILE_TEX_W / 2 + TILE_TEX_OFF_X;
  out.y = (tx + ty + 1) * HALF_H - TILE_TEX_H / 2 + TILE_TEX_OFF_Y;
  return out;
}

/**
 * Flatten every bake pass into one ordered draw list. Built once; each chunk
 * then walks it and culls. Order in this array *is* paint order.
 */
function buildTerrainOps(world) {
  const W = world.width;
  const H = world.height;
  const B = TERRAIN_BORDER;
  const ops = [];
  const p = { x: 0, y: 0 };
  const push = (frame, alpha, tint) => {
    ops.push({ f: frame, x: p.x, y: p.y, a: alpha, t: tint });
  };
  const terrainAt = (tx, ty) =>
    (tx < 0 || ty < 0 || tx >= W || ty >= H ? -1 : world.terrain[ty * W + tx]);

  // --- 1. sea shelf ---------------------------------------------------------
  for (let ty = -B; ty < H + B; ty++) {
    for (let tx = -B; tx < W + B; tx++) {
      if (tx >= 0 && ty >= 0 && tx < W && ty < H) continue;
      const dx = tx < 0 ? -tx : tx >= W ? tx - W + 1 : 0;
      const dy = ty < 0 ? -ty : ty >= H ? ty - H + 1 : 0;
      const ring = Math.max(dx, dy);
      let level;
      if (ring >= B - 1) {
        // The last ring has to match the flat fill exactly, or the changeover
        // from tiles to fill draws a visible line around the whole map.
        level = OCEAN_LEVELS - 1;
      } else {
        // Dither between adjacent depths instead of stepping, so the shelf
        // does not read as concentric diamonds drawn around the island.
        const dd = ((ring - 1) * (OCEAN_LEVELS - 1)) / (B - 1)
          + (tileHash(tx, ty) & 255) / 256 - 0.5;
        level = Math.max(0, Math.min(OCEAN_LEVELS - 1, Math.round(dd)));
      }
      tilePos(tx, ty, p);
      push(oceanFrame(level), 1, undefined);
    }
  }

  // --- 2. terrain -----------------------------------------------------------
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const id = world.terrain[ty * W + tx];
      const nVar = TERRAIN_VARIANTS[id] || 1;
      tilePos(tx, ty, p);
      push(terrainFrame(id, tileHash(tx, ty) % nVar), 1, undefined);
    }
  }

  // --- 3. transition washes -------------------------------------------------
  // Edge index order matches textures.js: 0 = -y, 1 = +x, 2 = +y, 3 = -x.
  const NEIGH = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const id = world.terrain[ty * W + tx];
      const mine = TERRAIN_PRIORITY[id];
      let placed = false;
      for (let e = 0; e < 4; e++) {
        const nId = terrainAt(tx + NEIGH[e][0], ty + NEIGH[e][1]);
        if (nId < 0 || nId === id) continue;
        if (TERRAIN_PRIORITY[nId] <= mine) continue;
        if (!placed) {
          tilePos(tx, ty, p);
          placed = true;
        }
        push(edgeBlendFrame(e), 0.85, TERRAIN_BASE[nId]);
      }
    }
  }

  // --- 4. surf along the coast ---------------------------------------------
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (tx !== 0 && ty !== 0 && tx !== W - 1 && ty !== H - 1) continue;
      tilePos(tx, ty, p);
      if (ty === 0) push(shoreFrame(0), 0.75, 0xdff1ff);
      if (tx === W - 1) push(shoreFrame(1), 0.75, 0xdff1ff);
      if (ty === H - 1) push(shoreFrame(2), 0.75, 0xdff1ff);
      if (tx === 0) push(shoreFrame(3), 0.75, 0xdff1ff);
    }
  }

  // --- 5. map-scale mottling ------------------------------------------------
  // Six tiles apart with hashed jitter: far coarser than a tile, so it reads
  // as ground shading rather than as more quilting.
  for (let ty = 2; ty < H; ty += 6) {
    for (let tx = 2; tx < W; tx += 6) {
      const h = tileHash(tx * 7 + 1, ty * 13 + 5);
      const jx = tx + ((h >>> 2) % 5) - 2;
      const jy = ty + ((h >>> 7) % 5) - 2;
      if (jx < 0 || jy < 0 || jx >= W || jy >= H) continue;
      if (world.terrain[jy * W + jx] === 2) continue; // never over water
      p.x = (jx - jy) * HALF_W - 84;
      p.y = (jx + jy + 1) * HALF_H - 50;
      const warm = (h & 1) === 0;
      push(BLOB_FRAME, warm ? 0.16 : 0.13, warm ? 0x6b5a3a : 0x9fd07a);
    }
  }

  return ops;
}

/** Well-mixed per-tile hash — a weak one leaves visible stripes of variants. */
function tileHash(tx, ty) {
  let h = Math.imul(tx + 1, 374761393) + Math.imul(ty + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
