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
//
// Fog of war rides on top of that shape rather than fighting it: the masks in
// systems/vision.js decide which entities are drawn at all, and one overlay
// quad — see makeFog — darkens the ground. Nothing per-tile happens per frame.

import {
  MAP_W, MAP_H, HALF_W, HALF_H, TILE_W, TILE_H,
  ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT, PLAYER,
  BUILDING_STATS, isWallType, isGateType,
} from '../core/constants.js';
import { WALL_E, WALL_W } from '../core/world.js';
import { depthFor } from '../core/iso.js';
import {
  buildTextures, ATLAS, TILE_TEX_W, TILE_TEX_H, TILE_TEX_OFF_X, TILE_TEX_OFF_Y,
  terrainFrame, unitFrame, unitAnim, buildingFrame, foundationFrame, resourceFrame,
  markerFrame, farmFrame, farmFoundationFrame, wallFrame, gateFrame, scaffoldFrame,
  oceanFrame, edgeBlendFrame, shoreFrame, cliffFrame, BLOB_FRAME,
  TERRAIN_VARIANTS, RESOURCE_VARIANTS, DETAIL_VARIANTS, DETAIL_BOX, detailFrame,
  TERRAIN_BORDER, OCEAN_LEVELS, OCEAN_DEEP, TERRAIN_BASE, TERRAIN_PRIORITY,
  CLIFF_H, CLIFF_VARIANTS,
} from './textures.js';
import { createFx } from './fx.js';
import { EV } from '../core/events.js';

// Facing index -> { back, flip }. See DIRS in iso.js: 0=S 1=SW 2=W 3=NW 4=N
// 5=NE 6=E 7=SE on screen.
const FACE_BACK = [false, false, false, true, true, true, false, false];
const FACE_FLIP = [false, true, true, true, false, false, false, false];

// --- animation --------------------------------------------------------------
//
// The pose *set* lives in textures.js (it has to: it decides which frames get
// baked). What lives here is the clock — which pose of the set is showing this
// frame, and what drives it.
//
// Walks are driven by wall time scaled by the unit's own speed, so a scout's
// legs go round faster than a spearman's without a second table to keep in
// step with UNIT_STATS. Work loops run slowly on purpose: a villager chopping
// at 9Hz reads as a blur of pixels at phone size, and at 3Hz you can see the
// axe come down.
const ANIM_FPS = { gather: 3.2, build: 4.2 };
// Seconds a swing lasts, matching SWING_MAX in systems/combat.js. `attackAnim`
// counts *down* from the instant the blow lands, so a high value means the
// follow-through is still showing and a spent one means the unit is back on
// guard waiting out its cooldown. Nothing breaks if combat.js retunes it: the
// value is only used to normalise, and it is clamped.
const SWING_TIME = 0.4;
// How long a unit stays washed out after being hit. Two frames at 60Hz is
// invisible; a quarter of a second reads as a flinch without turning a melee
// into a strobe.
const HIT_FLASH = 0.16;
const HIT_FLASH_TINT = 0xffd9d0;

const RES_COLOR = { food: 0xe8524a, wood: 0xc98a45, gold: 0xf5c333, stone: 0x9aa7b4 };

// How big a unit's ground ellipse and selection ring are, relative to a
// villager's. This is footprint, not importance: a horse and a siege engine
// stand on more ground than a man does, and a ring that does not match what the
// player sees on the floor reads as a targeting error.
const MARKER_SCALE = {
  militia: 1.12, spearman: 1.08, archer: 1.05, scout: 1.34, ram: 1.42,
};

// Selection colours by relationship. Own units are the warm gold the HUD uses
// for "yours"; hostiles are red; anything else (a neutral, an ally in a future
// team game) is blue. Colour, not just presence, so a tap on an enemy in a
// melee is not mistaken for having selected him.
const SEL_OWN = 0xffe45c;
const SEL_ENEMY = 0xff6b6b;
const SEL_OTHER = 0x7fd0ff;

const animCache = new Map();
function animOf(type) {
  let a = animCache.get(type);
  if (!a) {
    a = unitAnim(type);
    animCache.set(type, a);
  }
  return a;
}

/**
 * Which pose a unit is showing this frame.
 *
 * Everything is driven off state the simulation already keeps, so no animation
 * state lives on the entity and nothing has to be reset when an order changes:
 * a unit that stops walking is simply asked for a different list next frame.
 */
function poseOf(u, t, phase) {
  const set = animOf(u.type);
  const state = u.state || 'idle';
  if (state === 'attack') {
    const seq = set.attack || set.idle;
    if (seq.length < 2) return seq[0];
    // High attackAnim = the blow just landed, so show the follow-through;
    // spent = back on guard for the rest of the cooldown.
    const f = Math.min(1, (u.attackAnim || 0) / SWING_TIME);
    return f > 0.45 ? seq[1] : seq[0];
  }
  const seq = set[state] || set.idle;
  if (seq.length < 2) return seq[0];
  // A stride is a distance, not a duration: scaling the walk clock by the
  // unit's speed keeps feet from skating for the fast units and from
  // sewing-machining for the slow ones.
  const fps = (state === 'move' || state === 'deposit')
    ? 7 * (u.speed || 1.2)
    : (ANIM_FPS[state] || 6);
  return seq[Math.floor(t * fps + phase) % seq.length];
}

// How far outside the camera an entity may be before we stop drawing it.
const CULL_PAD = 140;

const TERRAIN_CHUNK = 512;

// Which ground decals suit which terrain. Grass takes flowers, tussocks, stones
// and fallen wood; dirt takes pebbles, stones and dead brush; sand takes
// pebbles and brush and nothing green. Index 6 (reeds) is never picked from
// here — the bake places those only where land meets water.
const DETAIL_FOR_TERRAIN = [
  [1, 2, 2, 0, 3],
  [4, 0, 5, 3],
  [],
  [4, 5, 4, 0],
];

// --- Fog of war -------------------------------------------------------------
//
// The veil is a warm black rather than a neutral one. Neutral black over this
// palette reads as a hole punched in the screen; a trace of red and green in it
// (0x140e08) reads as unlit ground, which is what it is meant to be.
const FOG_R = 0x14;
const FOG_G = 0x0e;
const FOG_B = 0x08;
// Alpha over explored-but-not-visible ground. 0.52 is where the terrain type is
// still legible — you can tell your woodline from the open field you have to
// cross to reach it — while nothing on it competes for attention with the
// brightly lit part of the map. Under 0.4 the fog stops reading as fog; over
// 0.6 the map you have explored may as well be the map you have not.
const FOG_EXPLORED_ALPHA = 0.52;
// Remembered objects are drawn with this multiplied over them. It is a cool
// slate, not a grey: multiplying by grey only darkens, and the ghost then looks
// like the same building at night. Pulling the red down and leaving the blue
// nearly intact drains the warmth out of roofs and foliage, which is the part
// of "desaturated" that actually says *memory* at a glance.
const FOG_MEMORY_TINT = 0x7c8698;
const FOG_MEMORY_ALPHA = 0.85;
// The fog texture is only redrawn this often. The mask changes on most sim
// steps — somebody is always walking — but re-uploading the whole canvas at
// 20Hz is bandwidth spent on a change nobody can see, since one tile of fog is
// a 45x22 pixel blob on screen. At 12Hz the edge still slides smoothly under a
// walking unit and the upload cost drops by half.
const FOG_REFRESH_INTERVAL = 1 / 12;
// Above every entity, every effect and the terrain; below the overlay Graphics
// (800000), which draws selection rings and bars for things you can see.
const FOG_DEPTH = 700000;

let fogTextureSerial = 0;

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
  const terrain = bakeTerrain(scene, world, worldRect);

  // --- fog of war ----------------------------------------------------------
  const fog = makeFog(scene, world, worldRect);
  // The masks the draw passes below consult. When there is no vision system at
  // all (a stripped-down harness world), everything is permanently visible and
  // nothing remembered, so the whole feature falls away without a branch in any
  // inner loop.
  const fogState = fog ? fog.state : null;
  const visMask = fogState ? fogState.visible : null;

  // --- cliffs --------------------------------------------------------------
  // Terrain the player cannot cross, and the only thing on the map with real
  // height that is not a building. Placement belongs to mapgen (see
  // HANDOFF-art.md); everything here works off `world.cliff`, a byte per tile,
  // and does nothing at all when there isn't one.
  let cliffs = buildCliffList(world);

  // --- pools ---------------------------------------------------------------
  const cliffPool = makePool(() => mkImage(scene, cliffFrame(0, 0), -1));
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
  let wallRun = null;    // { type, segments: [{ tx, ty, mask, valid }] }
  let t = 0;

  // --- combat feedback ------------------------------------------------------
  // Two facts, both read straight off the damage event: which units were hit
  // just now (so they can flash), and whether anything is happening at all (so
  // health bars can come up across the army and go away again when it is over).
  const hitFlash = new Map(); // entity id -> renderer time of the last hit
  let lastCombat = -1e9;
  let barsWanted = false;
  let sinceFlashPrune = 0;
  const evOffs = [];
  evOffs.push(world.events.on(EV.DAMAGE, (p) => {
    const tgt = p && p.target;
    if (!tgt) return;
    hitFlash.set(tgt.id, t);
    // Only the player's own fights raise everyone's bars. An AI skirmish on the
    // far side of the map is not a reason to redraw the player's whole economy
    // with health bars over it.
    const src = p.entity;
    if (tgt.player === PLAYER || (src && src.player === PLAYER)) lastCombat = t;
  }));

  // The live "12 segments — 60 stone" readout that follows the finger while a
  // wall is being drawn. A Phaser text pinned to the screen rather than a HUD
  // element, for one reason: it has to sit *next to the finger*, which is a
  // position only the gesture knows, and reaching into the DOM HUD to move a
  // node every pointermove is both slower and somebody else's file.
  const runLabel = scene.add.text(0, 0, '', {
    fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
    fontSize: '15px',
    color: '#f4ecd8',
    backgroundColor: 'rgba(12,10,7,0.82)',
    padding: { x: 8, y: 4 },
  });
  runLabel.setScrollFactor(0);
  runLabel.setDepth(960000);
  runLabel.setOrigin(0.5, 1);
  runLabel.setVisible(false);

  const viewRect = { x: 0, y: 0, r: 0, b: 0 };
  const _wp0 = new Phaser.Math.Vector2();
  const _wp1 = new Phaser.Math.Vector2();

  const fx = createFx(scene, world, { depthFor, camera, viewRect, origins });

  // Other systems own the entity types; if one ever grows a type we have no
  // art for, fall back rather than spraying missing-frame warnings.
  const has = (frame) => origins.has(frame);
  /** Clamp an owner id into the range we generated colours for. */
  const pi = (player) => (player === 1 ? 1 : 0);
  function unitFrameFor(type, player, back, pose = 'i') {
    let f = unitFrame(type, player, back, pose);
    if (has(f)) return f;
    // A type with art but no such pose (a soldier asked to "gather") falls back
    // to its own idle before it falls back to somebody else's body.
    f = unitFrame(type, player, back, 'i');
    if (has(f)) return f;
    f = unitFrame('villager', player, back, pose);
    return has(f) ? f : unitFrame('villager', player, back, 'i');
  }
  function buildingFrameFor(type, player, b) {
    if (type === 'farm') return farmFrame(player, farmStage(b));
    if (isWallType(type)) return wallPieceFrame(type, player, b);
    const f = buildingFrame(type, player);
    return has(f) ? f : buildingFrame('house', player);
  }

  /**
   * Which of a wall piece's sixteen connected variants to draw.
   *
   * The mask itself is the simulation's (core/world.js recomputes it whenever a
   * neighbour appears or disappears, never per frame), so this is a lookup and a
   * string join. A gate has only two orientations, taken from the same mask: a
   * gate with an east or west neighbour stands across a wall running along +x.
   * A gate with no neighbours at all has to guess, and guesses +x — placed on
   * its own it is a door in a wall that does not exist yet.
   */
  function wallPieceFrame(type, player, b) {
    const mask = (b && b.wallMask) | 0;
    if (isGateType(type)) {
      const axis = (mask & (WALL_E | WALL_W)) ? 0 : mask ? 1 : 0;
      const f = gateFrame(type, player, axis, !!(b && b.gateOpen));
      return has(f) ? f : gateFrame('palisadegate', player, axis, false);
    }
    const f = wallFrame(type, player, mask);
    return has(f) ? f : wallFrame('palisade', player, mask);
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
    // getWorldPoint reads camera.matrix, which Phaser only rebuilds during its
    // own preRender pass. centerOn() runs in scene create, before the camera has
    // ever rendered, so the matrix is still identity and the sampled affine
    // comes out as plain scroll*zoom. The memo key then already equals the final
    // camera state, so that wrong answer sticks until a pan changes scroll —
    // which is why every tap landed up to 193px from the finger for the first
    // half-minute of a match, and why it silently healed the moment you panned.
    // At zoom 1.0 the bad affine happens to be correct, which is how this hid
    // until the default zoom moved to 0.7.
    camera.preRender();
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

  /**
   * Preview a whole run of wall foundations under the finger.
   *
   * `segments` is [{ tx, ty, mask, valid }] — the mask already resolved by the
   * caller against the run itself, so the preview joins up exactly the way the
   * built wall will. Pass null to clear.
   */
  function setWallPreview(type, segments) {
    wallRun = (type && segments && segments.length) ? { type, segments } : null;
  }

  /** The floating cost/count label. Screen coordinates; null text hides it. */
  function setWallReadout(text, sx, sy) {
    if (!text) {
      runLabel.setVisible(false);
      return;
    }
    runLabel.setText(text);
    const halfW = runLabel.width / 2 + 6;
    runLabel.setPosition(
      Math.max(halfW, Math.min(camera.width - halfW, sx)),
      Math.max(runLabel.height + 6, sy),
    );
    runLabel.setVisible(true);
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

    // Bars stay up for a few seconds after the last blow, so they do not
    // flicker out between swings in a running fight.
    barsWanted = t - lastCombat < 5;
    sinceFlashPrune += dt;
    if (sinceFlashPrune > 2) {
      sinceFlashPrune = 0;
      for (const [id, at] of hitFlash) {
        if (t - at > HIT_FLASH) hitFlash.delete(id);
      }
    }

    // Visible world rect (exact, straight off the camera transform).
    screenToWorld(0, 0, _tmpA);
    screenToWorld(camera.width, camera.height, _tmpB);
    viewRect.x = _tmpA.x - CULL_PAD;
    viewRect.y = _tmpA.y - CULL_PAD;
    viewRect.r = _tmpB.x + CULL_PAD;
    viewRect.b = _tmpB.y + CULL_PAD;

    // Ground the camera is about to reach has to exist before anything is drawn
    // on top of it; see bakeTerrain for why this is not done up front.
    terrain.ensure(viewRect);

    cliffPool.reset();
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

    drawCliffs();
    drawResources();
    drawBuildings(invZ);
    drawUnits(alpha, invZ);
    drawMemory();
    drawGhost();
    drawWallRun();

    cliffPool.trim();
    markerPool.trim();
    unitPool.trim();
    bldPool.trim();
    resPool.trim();
    selPool.trim();
    ghostPool.trim();

    drawDragBox();

    if (fog) fog.update(dt);

    fx.update(dt);
  }

  function visible(wx, wy) {
    return wx > viewRect.x && wx < viewRect.r && wy > viewRect.y && wy < viewRect.b;
  }

  // --- fog gates -----------------------------------------------------------
  // One typed-array read per entity. Deliberately not a call into vision.js:
  // this runs a few hundred times a frame and the bounds test there is dead
  // weight for coordinates that came out of the simulation.

  /** Is the tile under a point lit for the human player? */
  function litAt(gx, gy) {
    if (!visMask) return true;
    const tx = gx | 0;
    const ty = gy | 0;
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false;
    return visMask[ty * MAP_W + tx] === 1;
  }

  /** A building counts as seen if any tile of its footprint is lit. */
  function litBuilding(b) {
    if (!visMask) return true;
    const tiles = b.tiles;
    if (!tiles) return litAt(b.x, b.y);
    for (let i = 0; i < tiles.length; i++) {
      const tx = tiles[i][0];
      const ty = tiles[i][1];
      if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) continue;
      if (visMask[ty * MAP_W + tx]) return true;
    }
    return false;
  }

  /** Same question for a remembered snapshot, whose tiles are flat indices. */
  function litTiles(indices) {
    if (!visMask) return true;
    for (let i = 0; i < indices.length; i++) {
      if (visMask[indices[i]]) return true;
    }
    return false;
  }

  /**
   * Cliffs. Sprites rather than part of the terrain bake, because they have
   * height: a unit walking past the foot of one has to pass in front of it and
   * a unit behind it has to be hidden by it, and that is a depth sort, which
   * baked ground cannot take part in.
   *
   * They are not fog-gated. A cliff is terrain, and terrain you have seen once
   * stays on your map — the fog overlay darkens it along with everything else,
   * which is exactly the treatment the ground under it gets.
   */
  function drawCliffs() {
    for (let i = 0; i < cliffs.length; i++) {
      const c = cliffs[i];
      if (!visible(c.wx, c.wy)) continue;
      const s = cliffPool.get();
      setFrame(s, c.frame, origins);
      s.setPosition(c.wx, c.wy);
      s.setDepth(c.depth);
    }
  }

  function drawResources() {
    const list = world.resources;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dead) continue;
      if (!litAt(e.x, e.y)) continue;
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
      // Out of sight the building is drawn from memory instead, by drawMemory.
      if (!litBuilding(b)) continue;
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
          : foundationFrame(footprintFrameWidth(b.fw), player);
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
        constructionStage(b, s, o, wx, wy, depth, progress);
      }

      const selected = world.selection.has(b.id);
      if (selected) footprintOutline(b, b.player === PLAYER ? SEL_OWN : SEL_ENEMY);

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

      // Rally point, for the player's own production buildings.
      if (selected && b.rally && typeof b.rally.x === 'number') {
        rallyLine(b, wx, wy, invZ);
      }
    }
  }

  /**
   * Four visible stages of construction out of one building sprite.
   *
   * The building is revealed bottom-up by a crop, which in this projection is
   * exactly the order a building is actually built in: platform, then walls,
   * then the roof last. Two more things carry the read that a crop alone
   * cannot. The masonry is tinted toward bare, unpainted stone early and warms
   * to full colour as it finishes, so a half-built house is not just a
   * *shorter* house. And a timber scaffold stands in front of it until the
   * work is nearly done — an open cage of poles and planks that is instantly
   * legible as "site" at any zoom, and whose disappearance (with the pop from
   * fx.js) is what makes completion an event.
   *
   * Stages, in the player's terms: bare foundation and scaffold, walls rising
   * inside the cage, walls up and roof going on, scaffold struck and the
   * building finished.
   */
  function constructionStage(b, s, o, wx, wy, depth, progress) {
    const shown = Math.max(0.001, Math.min(1, (progress - 0.05) / 0.8));
    s.setCrop(0, o.h * (1 - shown), o.w, o.h * shown);
    s.setAlpha(progress < 0.05 ? 0 : 1);
    // Bare, unpainted material early; full colour by the time it is finished.
    s.setTint(mixColor(0x9c9484, 0xffffff, Math.min(1, progress * 1.5)));

    // The scaffold. Not over a farm (a field is not built on a frame) and not
    // over a wall segment, whose whole footprint is smaller than the poles.
    if (progress < 0.97 && b.type !== 'farm' && !isWallType(b.type)) {
      const scFrame = scaffoldFrame(footprintFrameWidth(b.fw));
      if (has(scFrame)) {
        const sc = bldPool.get();
        setFrame(sc, scFrame, origins);
        sc.setPosition(wx, wy);
        sc.setDepth(depth + 0.5);
        sc.setAlpha(progress < 0.8 ? 1 : Math.max(0, 1 - (progress - 0.8) / 0.17));
      }
    }
  }

  /**
   * The line from a production building to where its units will walk.
   *
   * An arc rather than a straight line, and dashes that march along it rather
   * than a static stroke: on a map this dense a plain line between two points
   * is read as a wall, a road or a border before it is read as an instruction.
   * A curve that leaves the roof, rises and comes down on a marked spot is
   * unmistakably a *path*, and the direction of travel is in the motion so the
   * player never has to work out which end is the destination.
   */
  function rallyLine(b, wx, wy, invZ) {
    const rx = (b.rally.x - b.rally.y) * HALF_W;
    const ry = (b.rally.x + b.rally.y) * HALF_H;
    const dx = rx - wx;
    const dy = ry - wy;
    const len = Math.hypot(dx, dy) || 1;
    const lift = Math.min(80, len * 0.24);
    const N = Math.max(8, Math.min(36, Math.round(len / 16)));
    const px = (k) => wx + dx * k;
    const py = (k) => wy + dy * k - Math.sin(Math.PI * k) * lift;

    // The whole arc, faint, so the connection survives even where a dash is
    // currently in a gap.
    overlay.lineStyle(4 * invZ, 0x06121b, 0.32);
    overlay.beginPath();
    overlay.moveTo(px(0), py(0));
    for (let i = 1; i <= N; i++) overlay.lineTo(px(i / N), py(i / N));
    overlay.strokePath();

    // Marching dashes. Long gaps: a dash pattern that is more ink than air
    // reads as a solid line with texture on it, and the whole point of the
    // dashes is that they are visibly *travelling* toward the far end.
    const phase = (t * 0.5) % 1;
    overlay.lineStyle(3.2 * invZ, 0x9ad8ff, 0.95);
    for (let i = 0; i < N; i++) {
      const k = i / N;
      if (((k - phase) % 0.3 + 0.3) % 0.3 > 0.13) continue;
      overlay.beginPath();
      overlay.moveTo(px(k), py(k));
      overlay.lineTo(px(k + 1 / N), py(k + 1 / N));
      overlay.strokePath();
    }

    // The endpoint: a flag standing on a ring on the ground, so the target is a
    // place on the map and not a floating dot.
    const ring = 1 + Math.sin(t * 3.4) * 0.08;
    overlay.lineStyle(3 * invZ, 0x06121b, 0.45);
    overlay.strokeEllipse(rx, ry, 26 * invZ * ring, 13 * invZ * ring);
    overlay.lineStyle(2 * invZ, 0x9ad8ff, 0.95);
    overlay.strokeEllipse(rx, ry, 26 * invZ * ring, 13 * invZ * ring);
    const flag = selPool.get();
    setFrame(flag, 'fx_flag', origins);
    flag.setPosition(rx, ry);
    flag.setDepth(depthFor(b.rally.x, b.rally.y, 500));
    flag.setTint(0xbfe6ff);
    flag.setScale(invZ);
  }

  /**
   * The ring under a selected unit.
   *
   * Two sprites: a solid ring that breathes, and a second ring that swells and
   * fades out of it once a second. The moving one is what makes a selection
   * findable on a busy phone screen — a static ring disappears into a crowd of
   * ground ellipses, and a *moving* one is the only thing on the ground plane
   * that changes shape, so the eye lands on it without being told to.
   */
  function selectionRing(pool, wx, wy, depth, owner, type) {
    const scale = MARKER_SCALE[type] || 1;
    const tint = owner === PLAYER ? SEL_OWN
      : (owner === undefined || owner === null) ? SEL_OTHER : SEL_ENEMY;

    const ring = pool.get();
    setFrame(ring, 'mk_sel', origins);
    ring.setPosition(wx, wy);
    ring.setDepth(depth);
    ring.setTint(tint);
    ring.setScale(scale * (1 + Math.sin(t * 4.5) * 0.04));

    // The swell. One period per second, and it spends most of it small and
    // faint, so a screenful of selected villagers does not pulse in unison
    // loudly enough to be the loudest thing on screen.
    const f = (t * 1.1) % 1;
    if (f < 0.55) {
      const k = f / 0.55;
      const halo = pool.get();
      setFrame(halo, 'mk_sel_halo', origins);
      halo.setPosition(wx, wy);
      halo.setDepth(depth - 0.01);
      halo.setTint(tint);
      halo.setScale(scale * (0.86 + k * 0.5));
      halo.setAlpha(0.55 * (1 - k));
    }
  }

  /**
   * A selected building's footprint.
   *
   * A building cannot wear the unit ring — it does not stand on a point, it
   * covers ground — so the selection is the ground it covers, outlined, with a
   * bracket pulled out from each of the four corners. The brackets breathe in
   * and out by a couple of pixels, which is what distinguishes "this is
   * selected" from the several other diamonds the renderer draws on the floor
   * (placement ghosts, wall previews, tile highlights).
   */
  function footprintOutline(b, color) {
    const hw = (b.fw + b.fh) * HALF_W * 0.5;
    const hh = (b.fw + b.fh) * HALF_H * 0.5;
    const wx = (b.x - b.y) * HALF_W;
    const wy = (b.x + b.y) * HALF_H;
    const lw = 1 / camera.zoom;
    overlay.lineStyle(3 * lw, 0x000000, 0.5);
    strokeDiamond(overlay, wx, wy, hw, hh);
    overlay.lineStyle(2 * lw, color, 1);
    strokeDiamond(overlay, wx, wy, hw, hh);

    const out = 3 + Math.sin(t * 4.5) * 2;
    const arm = Math.min(14, hw * 0.34);
    const corners = [
      [0, -hh, 0, -1], [hw, 0, 1, 0], [0, hh, 0, 1], [-hw, 0, -1, 0],
    ];
    for (const [ox, oy, nx, ny] of corners) {
      const cx = wx + ox + nx * out;
      const cy = wy + oy + ny * out * (HALF_H / HALF_W);
      // Two strokes out of the corner, along the two diamond edges.
      const ax = nx !== 0 ? -nx * arm : arm;
      const ay = nx !== 0 ? -arm * (HALF_H / HALF_W) : -ny * arm * (HALF_H / HALF_W);
      overlay.lineStyle(3.4 * lw, 0x000000, 0.5);
      overlay.beginPath();
      overlay.moveTo(cx + ax, cy + ay);
      overlay.lineTo(cx, cy);
      overlay.lineTo(cx + (nx !== 0 ? ax : -ax), cy + (nx !== 0 ? -ay : ay));
      overlay.strokePath();
      overlay.lineStyle(2.2 * lw, color, 1);
      overlay.beginPath();
      overlay.moveTo(cx + ax, cy + ay);
      overlay.lineTo(cx, cy);
      overlay.lineTo(cx + (nx !== 0 ? ax : -ax), cy + (nx !== 0 ? -ay : ay));
      overlay.strokePath();
    }
  }

  function drawUnits(alpha, invZ) {
    const list = world.units;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (u.dead) continue;
      // Units are never remembered. Where they were a moment ago is exactly the
      // information fog exists to withhold, and an enemy left standing at his
      // last known position is worse than no information at all.
      if (!litAt(u.x, u.y)) continue;
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
      m.setScale(MARKER_SCALE[u.type] || 1);

      if (selected) selectionRing(selPool, wx, wy, depth + 0.1, u.player, u.type);

      // 2. body, in whichever pose the unit's current action calls for
      const face = u.facing | 0;
      const back = FACE_BACK[face & 7];
      const flip = FACE_FLIP[face & 7];
      const phase = (u.id % 32) * 0.63;
      const uFrame = unitFrameFor(u.type, player, back, poseOf(u, t, phase));
      const s = unitPool.get();
      setFrame(s, uFrame, origins);
      s.setFlipX(flip);
      s.setDepth(depth + 0.2);
      const uo = origins.get(uFrame);

      // The poses carry the limb motion; this is only the whole-body travel
      // that a drawn frame cannot express — the rise and fall of a stride, and
      // the slow breath of a unit standing still.
      let bob = 0;
      if (u.state === 'move' || u.state === 'deposit') {
        bob = -Math.abs(Math.sin(t * 9 + phase)) * 1.2;
      } else if (u.state === 'idle') {
        bob = Math.sin(t * 2.2 + phase) * 0.6;
      }
      s.setPosition(wx, wy + bob);

      // A wash of light over anything hit in the last fraction of a second.
      // Cheap (a tint, no extra sprite) and it is the single clearest way to
      // say "that landed" without shaking the screen.
      const hitAt = hitFlash.get(u.id);
      if (hitAt !== undefined) {
        if (t - hitAt < HIT_FLASH) s.setTint(HIT_FLASH_TINT);
        else hitFlash.delete(u.id);
      }

      const top = wy - uo.h * uo.oy;

      // 3. health bar. Always for a damaged unit, always for a selected one,
      //    and for everything in a fight — see barsWanted: during a battle the
      //    question "who is about to die" is the only question, and answering
      //    it only for units that have already been hit answers it too late.
      const hurt = u.hp < u.maxHp;
      if (hurt || selected || (barsWanted && u.player === PLAYER)) {
        healthBar(
          overlay, wx, top - 6 * invZ, u.hp / u.maxHp,
          u.player === PLAYER ? 0x4ade80 : 0xf05252, invZ,
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

  /**
   * Everything the player remembers but cannot currently see.
   *
   * These are snapshots taken by vision.js at the instant the tile went dark —
   * never the live entity — so a Town Center razed behind your back keeps
   * standing here, at the hit points it had when you looked away, until you
   * send something back to look. That is the whole point of the state, and it
   * is why this pass reads a parallel list instead of dimming live entities.
   *
   * Cost is one pass over the memory list, which is bounded by the number of
   * static objects on the map (~1900 trees on a full 96x96) and touches nothing
   * but plain fields — the view cull throws almost all of it away before any
   * sprite is pulled.
   */
  function drawMemory() {
    if (!fogState) return;
    const list = fogState.memory;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      // Anything currently lit is drawn live by the passes above.
      if (litTiles(m.tiles)) continue;
      const wx = (m.x - m.y) * HALF_W;
      const wy = (m.x + m.y) * HALF_H;
      if (!visible(wx, wy)) continue;

      if (m.kind === 'resource') {
        const s = resPool.get();
        setFrame(s, resourceFrameFor(m.type, m.variant || 0), origins);
        s.setPosition(wx, wy);
        s.setDepth(depthFor(m.x, m.y, 2));
        const left = m.maxAmount ? m.amount / m.maxAmount : 1;
        s.setScale(0.82 + 0.18 * Math.max(0, Math.min(1, left)));
        s.setTint(FOG_MEMORY_TINT);
        s.setAlpha(FOG_MEMORY_ALPHA);
        continue;
      }
      if (m.kind !== 'building') continue;

      const player = pi(m.player === undefined || m.player === null ? PLAYER : m.player);
      const depth = depthFor(m.x, m.y, 1);
      if (!m.complete) {
        const fFrame = m.type === 'farm'
          ? farmFoundationFrame(player)
          : foundationFrame(footprintFrameWidth(m.fw), player);
        const fs = bldPool.get();
        setFrame(fs, fFrame, origins);
        fs.setPosition(wx, wy);
        fs.setDepth(depth);
        fs.setTint(FOG_MEMORY_TINT);
        fs.setAlpha(FOG_MEMORY_ALPHA);
      }
      const bFrame = buildingFrameFor(m.type, player, m);
      const s = bldPool.get();
      setFrame(s, bFrame, origins);
      s.setPosition(wx, wy);
      s.setDepth(depth + 0.4);
      s.setTint(FOG_MEMORY_TINT);
      if (m.complete) {
        s.setAlpha(FOG_MEMORY_ALPHA);
      } else {
        // Half-built when you last looked, half-built in your memory.
        const progress = Math.max(0.02, Math.min(1, (m.buildProgress || 0) / (m.buildTime || 1)));
        const o = origins.get(bFrame);
        s.setCrop(0, o.h * (1 - progress), o.w, o.h * progress);
        s.setAlpha(FOG_MEMORY_ALPHA * (0.55 + 0.45 * progress));
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

  /**
   * The wall run being dragged out.
   *
   * Drawn as the real connected sprites rather than as a row of highlight
   * diamonds, because the whole question the player is asking while they drag is
   * "will this line join up" — and a preview made of abstract markers cannot
   * answer it. A refused segment keeps its shape and turns red, so a gap in the
   * run is visible as a gap rather than as a missing sprite.
   */
  function drawWallRun() {
    if (!wallRun) return;
    const segs = wallRun.segments;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const cx = seg.tx + 0.5;
      const cy = seg.ty + 0.5;
      const wx = (cx - cy) * HALF_W;
      const wy = (cx + cy) * HALF_H;
      if (!visible(wx, wy)) continue;
      const tint = seg.valid ? 0x5ce08d : 0xff5a5a;

      const h = ghostPool.get();
      setFrame(h, 'tile_hi', origins);
      h.setOrigin(0.5, 0.5);
      h.setPosition((seg.tx - seg.ty) * HALF_W, (seg.tx + seg.ty + 1) * HALF_H);
      h.setDepth(depthFor(seg.tx, seg.ty, 0.5));
      h.setTint(tint);
      h.setAlpha(0.85);

      const frame = buildingFrameFor(wallRun.type, PLAYER, {
        wallMask: seg.mask, gateOpen: false,
      });
      const s = ghostPool.get();
      setFrame(s, frame, origins);
      s.setPosition(wx, wy);
      s.setDepth(depthFor(cx, cy, 400));
      if (seg.valid) {
        s.setAlpha(0.8);
      } else {
        s.setTint(0xff8080);
        s.setAlpha(0.55);
      }
    }
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

  /**
   * Stand cliffs on a list of tiles and block them, for tests and for the
   * console.
   *
   * This exists because the renderer can be finished for cliffs long before
   * mapgen (someone else's file) places any: without it there is no way to look
   * at the feature, and art nobody has looked at is art nobody has made. It is
   * also the honest way to prove the pathfinding integration — the tiles it
   * writes are BLOCK_TERRAIN, the same value water uses, so A* refuses them
   * through the code path it already had.
   */
  function debugCliffs(tiles) {
    if (!world.cliff) world.cliff = new Uint8Array(MAP_W * MAP_H);
    for (const [tx, ty] of tiles) {
      if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) continue;
      const i = ty * MAP_W + tx;
      world.cliff[i] = 1;
      world.blocked[i] = 2;
    }
    cliffs = buildCliffList(world);
    return cliffs.length;
  }

  function destroy() {
    // The scene is torn down and relaunched on "Play again"; a surviving
    // listener would pile up one dead renderer per game.
    if (scaler) scaler.off('resize', onResize);
    for (const off of evOffs) off();
    evOffs.length = 0;
    fx.destroy();
    cliffPool.destroy();
    markerPool.destroy();
    unitPool.destroy();
    bldPool.destroy();
    resPool.destroy();
    selPool.destroy();
    ghostPool.destroy();
    overlay.destroy();
    screenG.destroy();
    runLabel.destroy();
    terrain.destroy();
    if (fog) fog.destroy();
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
    setWallPreview,
    setWallReadout,
    debugCliffs,
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
  // economy.js deletes a farm the moment it hits zero, so the "spent" art has
  // to arrive well before that or the player would never see it. Worn-out
  // reads from the last third, which is when it matters: that is when you go
  // and queue the replacement.
  if (f <= 0.3) return 2;
  if (f <= 0.62) return 1;
  return 0;
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

/**
 * Which foundation art a footprint gets. There is one frame per whole-tile width
 * from 1 (a wall segment) to 4 (the Castle); anything wider clamps to 4 rather
 * than falling back to a frame that would draw the site smaller than the
 * building going up on it.
 */
function footprintFrameWidth(fw) {
  const w = Math.round(fw || 2);
  return w < 1 ? 1 : w > 4 ? 4 : w;
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
  const pad = 1.4 * invZ;
  // Two rings of dark around the bar, not one. On grass at 0.7 zoom a single
  // hairline outline is the same value as the ground behind it and the bar's
  // ends dissolve; a solid black surround is what makes a 20px bar read as an
  // object rather than as a smear of colour.
  g.fillStyle(0x000000, 0.55);
  g.fillRect(wx - w / 2 - pad * 2, wy - pad * 2, w + pad * 4, h + pad * 4);
  g.fillStyle(0x0b0906, 0.95);
  g.fillRect(wx - w / 2 - pad, wy - pad, w + pad * 2, h + pad * 2);
  g.fillStyle(0x3a3630, 1);
  g.fillRect(wx - w / 2, wy, w, h);
  g.fillStyle(color, 1);
  g.fillRect(wx - w / 2, wy, w * f, h);
  g.fillStyle(0xffffff, 0.3);
  g.fillRect(wx - w / 2, wy, w * f, h * 0.42);
}

/**
 * A unit's health bar. Wider and taller than it used to be, and drawn at a
 * fixed screen size: 24 x 5 CSS pixels at the default zoom on a 390px phone,
 * which is the smallest bar this pass could still read the fraction off at
 * arm's length. The old 18 x 3.6 was legible only if you already knew it was
 * there. The colour crosses to amber and then red as the unit dies, so a
 * glance at a melee sorts it into "fine / hurt / about to die" without
 * measuring any lengths.
 */
function healthBar(g, wx, wy, frac, ownColor, invZ) {
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  const color = ownColor === 0x4ade80
    ? (f > 0.6 ? 0x4ade80 : f > 0.3 ? 0xf0b429 : 0xf05252)
    : ownColor;
  bar(g, wx, wy, 24 * invZ, 5 * invZ, f, color, invZ);
}

/** Blend two packed RGB colours. Used for the "unpainted masonry" tint. */
function mixColor(a, b, k) {
  const f = k < 0 ? 0 : k > 1 ? 1 : k;
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * f;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * f;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * f;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
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
 * The fog overlay.
 *
 * WHY THIS SHAPE AND NOT A SCREEN-SPACE GRID
 * ------------------------------------------
 * The obvious cheap trick — a small canvas at one pixel per tile, stretched
 * over the viewport with smoothing — is wrong here, and wrong in a way that is
 * obvious the moment you look at it: this is an isometric projection, so a tile
 * is a diamond and an axis-aligned pixel grid cuts across it at 45 degrees.
 * Every fog edge would sit at a diagonal to the ground it is meant to be lying
 * on, and the soft blur would smear along screen axes rather than along the
 * furrows of the map.
 *
 * Per-tile diamond sprites are the other obvious answer, and they line up
 * perfectly, but that is 9216 quads with alpha blending in the worst case and
 * a hard-edged staircase of diamonds in the best.
 *
 * So the fog canvas is one pixel per tile in *grid* space, and the grid->screen
 * transform is handed to the GPU. That transform,
 *     wx = (gx - gy) * HALF_W
 *     wy = (gx + gy) * HALF_H
 * is a rotation by 45 degrees followed by a non-uniform scale. A Phaser
 * GameObject applies its own scale *before* its rotation, which is the wrong
 * order and cannot express this — hence the container: the image inside carries
 * the 45 degree rotation, and the container carries the squash. The two
 * matrices multiply out to exactly the projection above, so texture pixel
 * (PAD+tx, PAD+ty) lands on tile (tx,ty), dead centre, at every zoom.
 *
 * The payoff is that bilinear filtering now interpolates *between tile centres
 * along the grid axes*. A fog edge is a soft ramp that follows the diamonds
 * instead of cutting across them, it costs one textured quad per frame, and the
 * only work when the mask changes is 9216 alpha bytes and one texture upload.
 *
 * The canvas is padded out past the map because the camera can see well beyond
 * the coastline — the four corners of its bounds rectangle are open sea. That
 * ocean is ground you can never explore, so it is left permanently unexplored,
 * which is both correct and what AoE2 looks like when you pan off the edge of
 * the world.
 */
function makeFog(scene, world, rect) {
  const vision = world.vision;
  if (!vision) return null;

  // Pad the texture until its diamond swallows the camera's bounds rectangle,
  // corners included; otherwise the fog stops in a straight 45 degree line
  // across open water.
  let lo = 0;
  let hi = 0;
  for (const [cx, cy] of [
    [rect.minX, rect.minY], [rect.maxX, rect.minY],
    [rect.minX, rect.maxY], [rect.maxX, rect.maxY],
  ]) {
    const a = cx / HALF_W;
    const b = cy / HALF_H;
    const gx = (a + b) / 2;
    const gy = (b - a) / 2;
    lo = Math.min(lo, gx, gy);
    hi = Math.max(hi, gx - MAP_W, gy - MAP_H);
  }
  const PAD = Math.ceil(Math.max(-lo, hi)) + 1;
  const TW = MAP_W + PAD * 2;
  const TH = MAP_H + PAD * 2;

  const key = `fog-${++fogTextureSerial}`;
  const tex = scene.textures.createCanvas(key, TW, TH);
  if (!tex) return null;
  const ctx = tex.getContext();
  // Everything starts unexplored, including the permanently unexplorable sea in
  // the padding, which is never written again.
  ctx.fillStyle = `rgb(${FOG_R},${FOG_G},${FOG_B})`;
  ctx.fillRect(0, 0, TW, TH);
  tex.refresh();
  if (Phaser.Textures && Phaser.Textures.FilterMode) {
    tex.setFilter(Phaser.Textures.FilterMode.LINEAR);
  }

  // One scratch ImageData for the playable area. The colour bytes are written
  // once here; a repaint only touches alpha.
  const img = ctx.createImageData(MAP_W, MAP_H);
  const bytes = img.data;
  for (let p = 0; p < bytes.length; p += 4) {
    bytes[p] = FOG_R;
    bytes[p + 1] = FOG_G;
    bytes[p + 2] = FOG_B;
  }
  const EXPLORED_BYTE = Math.round(FOG_EXPLORED_ALPHA * 255);

  const root = scene.add.container(0, -2 * PAD * HALF_H);
  root.setScale(HALF_W * Math.SQRT2, HALF_H * Math.SQRT2);
  root.setDepth(FOG_DEPTH);
  const quad = scene.add.image(0, 0, key);
  quad.setOrigin(0, 0);
  quad.setRotation(Math.PI / 4);
  root.add(quad);

  const st = vision.state(PLAYER);
  let paintedRevision = -1;
  let since = FOG_REFRESH_INTERVAL;

  function repaint() {
    vision.writeFogAlpha(PLAYER, bytes, EXPLORED_BYTE);
    ctx.putImageData(img, PAD, PAD);
    tex.refresh();
    paintedRevision = st.revision;
    since = 0;
  }

  function update(dt) {
    since += dt;
    if (st.revision === paintedRevision) return;
    if (since < FOG_REFRESH_INTERVAL) return;
    repaint();
  }

  function destroy() {
    root.destroy(true);
    scene.textures.remove(key);
  }

  repaint();
  return { update, destroy, state: st, pad: PAD };
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
 *
 * LAZY. The chunks are *planned* here but only allocated and painted the first
 * time the camera comes near them. On the old 48x48 map an eager bake was 8
 * RenderTextures and about 30MB of GPU memory, which was free. A 96x96 map is
 * 6272x3168 world pixels — 91 chunks and close to 100MB — and a mid-range phone
 * does not have that to spare on ground the player may never look at. Baking on
 * approach keeps the resident set to the handful of chunks around the viewport
 * plus whatever has already been visited, and each bake is a single batched
 * draw of a few thousand quads, which lands inside one frame.
 */
function bakeTerrain(scene, world, rect) {
  const { minX, minY, maxX, maxY } = rect;
  const cols = Math.ceil((maxX - minX) / TERRAIN_CHUNK);
  const rows = Math.ceil((maxY - minY) / TERRAIN_CHUNK);

  // Chunks overlap by CHUNK_PAD so neighbours cover each other's edge pixels;
  // without it, a hairline seam shows wherever two chunks meet.
  const CHUNK_PAD = 4;
  // Bake this far outside the visible rect, so a chunk is always finished before
  // it is on screen and a fast pan never shows bare ocean where land should be.
  const PREBAKE_PAD = TERRAIN_CHUNK * 0.75;

  const size = TERRAIN_CHUNK + CHUNK_PAD * 2;
  const planned = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      planned.push({
        ox: minX + cx * TERRAIN_CHUNK - CHUNK_PAD,
        oy: minY + cy * TERRAIN_CHUNK - CHUNK_PAD,
        rt: null,
      });
    }
  }

  // The draw list is shared by every chunk and built once; it is plain data, so
  // holding it for the life of the renderer costs a few hundred kB and saves
  // rebuilding the whole map's op list every time a new chunk is reached.
  const ops = buildTerrainOps(world);

  function paint(chunk) {
    const rt = scene.add.renderTexture(chunk.ox, chunk.oy, size, size);
    rt.setOrigin(0, 0);
    rt.setDepth(-1000000);
    chunk.rt = rt;

    const x0 = chunk.ox - TILE_TEX_W - 90;
    const y0 = chunk.oy - TILE_TEX_H - 60;
    const x1 = chunk.ox + size + 90;
    const y1 = chunk.oy + size + 60;
    rt.fill(OCEAN_DEEP, 1);
    rt.beginDraw();
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (o.x < x0 || o.x > x1 || o.y < y0 || o.y > y1) continue;
      rt.batchDrawFrame(ATLAS, o.f, o.x - chunk.ox, o.y - chunk.oy, o.a, o.t);
    }
    rt.endDraw();
  }

  /** Paint every planned chunk overlapping the view (plus a margin). */
  function ensure(view) {
    const x0 = view.x - PREBAKE_PAD;
    const y0 = view.y - PREBAKE_PAD;
    const x1 = view.r + PREBAKE_PAD;
    const y1 = view.b + PREBAKE_PAD;
    for (let i = 0; i < planned.length; i++) {
      const c = planned[i];
      if (c.rt) continue;
      if (c.ox > x1 || c.ox + size < x0 || c.oy > y1 || c.oy + size < y0) continue;
      paint(c);
    }
  }

  function destroy() {
    for (const c of planned) {
      if (c.rt) c.rt.destroy();
      c.rt = null;
    }
    planned.length = 0;
    ops.length = 0;
  }

  return { ensure, destroy };
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

  // --- 4b. scattered ground detail -----------------------------------------
  // Roughly one tile in thirteen gets one decal, jittered off the tile centre
  // by up to half a tile. Both numbers matter: denser than this and the map
  // reads as noise rather than as ground with things on it, and without the
  // jitter every rock in the world sits dead centre of a diamond and the grid
  // becomes visible through the decoration meant to hide it.
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const id = world.terrain[ty * W + tx];
      if (id === 2) continue; // never on water
      const h = tileHash(tx * 3 + 11, ty * 5 + 7);
      if (h % 13 !== 0) continue;
      const choices = DETAIL_FOR_TERRAIN[id] || DETAIL_FOR_TERRAIN[0];
      let d = choices[(h >>> 5) % choices.length];
      // Reeds only where the land meets water, which is the one place a stand
      // of them is not a mistake.
      const nearWater =
        terrainAt(tx + 1, ty) === 2 || terrainAt(tx - 1, ty) === 2 ||
        terrainAt(tx, ty + 1) === 2 || terrainAt(tx, ty - 1) === 2;
      if (nearWater && (h >>> 11) % 3 !== 0) d = 6;
      else if (d === 6) d = 2;
      if (d >= DETAIL_VARIANTS) continue;
      tilePos(tx, ty, p);
      p.x += TILE_TEX_W / 2 - DETAIL_BOX.ax + (((h >>> 13) % 21) - 10);
      p.y += TILE_TEX_H / 2 - DETAIL_BOX.ay + (((h >>> 18) % 11) - 5);
      push(detailFrame(d), 1, undefined);
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

/**
 * Flatten `world.cliff` into a draw list, once.
 *
 * Each entry carries its world position, its frame and its depth, all of which
 * are fixed for the life of the map — so the per-frame cost of cliffs is a walk
 * over this array and a rectangle test, with no grid lookups and no string
 * building.
 *
 * All four neighbours go into the mask, not just the two whose faces the camera
 * can see. The +x and +y bits decide which walls are drawn; the -x and -y bits
 * decide whether the *top* edge on that side is outlined. Miss the second pair
 * and every interior tile of a plateau outlines its own northern edges, which
 * draws the tile grid across the rock in black — the exact failure this frame
 * set exists to avoid.
 */
function buildCliffList(world) {
  const grid = world.cliff;
  const out = [];
  if (!grid) return out;
  const W = world.width;
  const H = world.height;
  const at = (tx, ty) => (tx < 0 || ty < 0 || tx >= W || ty >= H ? 0 : grid[ty * W + tx]);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (!grid[ty * W + tx]) continue;
      const mask =
        (at(tx + 1, ty) ? 1 : 0) | (at(tx, ty + 1) ? 2 : 0) |
        (at(tx - 1, ty) ? 4 : 0) | (at(tx, ty - 1) ? 8 : 0);
      const h = tileHash(tx, ty);
      out.push({
        wx: (tx - ty) * HALF_W,
        wy: (tx + ty + 1) * HALF_H,
        frame: cliffFrame(h % CLIFF_VARIANTS, mask),
        depth: depthFor(tx + 0.5, ty + 0.5, 0.6),
      });
    }
  }
  return out;
}

/** Well-mixed per-tile hash — a weak one leaves visible stripes of variants. */
function tileHash(tx, ty) {
  let h = Math.imul(tx + 1, 374761393) + Math.imul(ty + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
