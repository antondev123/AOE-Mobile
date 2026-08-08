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
  markerFrame, TERRAIN_VARIANTS, RESOURCE_VARIANTS,
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
  // y in [0, (MAP_W+MAP_H)*HALF_H] (see the header of iso.js).
  const worldLeft = -MAP_H * HALF_W - TILE_W;
  const worldTop = -TILE_H * 3;
  const worldRight = MAP_W * HALF_W + TILE_W;
  const worldBottom = (MAP_W + MAP_H) * HALF_H + TILE_H * 3;
  camera.setBounds(
    worldLeft, worldTop,
    worldRight - worldLeft, worldBottom - worldTop,
    true,
  );
  camera.setZoom(ZOOM_DEFAULT);
  camera.setRoundPixels(true);

  // --- terrain -------------------------------------------------------------
  const chunks = bakeTerrain(scene, world);

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
  function buildingFrameFor(type, player) {
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
        const fFrame = foundationFrame(b.fw >= 3 ? 3 : 2, player);
        fo = origins.get(fFrame);
        const fs = bldPool.get();
        setFrame(fs, fFrame, origins);
        fs.setPosition(wx, wy);
        fs.setDepth(depth);
        fs.setAlpha(1);
        fs.setScale(1);
      }

      const bFrame = buildingFrameFor(b.type, player);
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
 * Bake every terrain tile into a grid of RenderTextures. Terrain never changes
 * after map generation, so this happens exactly once.
 */
function bakeTerrain(scene, world) {
  const minX = -MAP_H * HALF_W - TILE_W;
  const minY = -TILE_H;
  const maxX = MAP_W * HALF_W + TILE_W;
  const maxY = (MAP_W + MAP_H) * HALF_H + TILE_H;
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

  // Precompute each tile's blit position and frame once.
  const n = world.width * world.height;
  const posX = new Float32Array(n);
  const posY = new Float32Array(n);
  const frames = new Array(n);
  for (let ty = 0; ty < world.height; ty++) {
    for (let tx = 0; tx < world.width; tx++) {
      const i = ty * world.width + tx;
      const terrainId = world.terrain[i];
      const nVar = TERRAIN_VARIANTS[terrainId] || 1;
      frames[i] = terrainFrame(terrainId, tileHash(tx, ty) % nVar);
      posX[i] = (tx - ty) * HALF_W - TILE_TEX_W / 2 + TILE_TEX_OFF_X;
      posY[i] = (tx + ty + 1) * HALF_H - TILE_TEX_H / 2 + TILE_TEX_OFF_Y;
    }
  }

  for (const rt of chunks) {
    const x0 = rt._ox - TILE_TEX_W;
    const y0 = rt._oy - TILE_TEX_H;
    const x1 = rt._ox + rt._size;
    const y1 = rt._oy + rt._size;
    rt.beginDraw();
    for (let i = 0; i < n; i++) {
      const px = posX[i];
      const py = posY[i];
      if (px < x0 || px > x1 || py < y0 || py > y1) continue;
      rt.batchDrawFrame(ATLAS, frames[i], px - rt._ox, py - rt._oy);
    }
    rt.endDraw();
  }

  return chunks;
}

/** Well-mixed per-tile hash — a weak one leaves visible stripes of variants. */
function tileHash(tx, ty) {
  let h = Math.imul(tx + 1, 374761393) + Math.imul(ty + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
