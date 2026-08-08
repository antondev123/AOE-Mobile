// Procedural texture generation.
//
// There are no art assets: every pixel is drawn at runtime with a Phaser
// Graphics object, baked to a canvas, and packed into ONE atlas texture. The
// single atlas matters a lot for performance — hundreds of sprites drawn from
// the same texture batch into a handful of draw calls, whereas hundreds of
// standalone textures would break the batch on every sprite.
//
// Everything here runs once, during scene create.

import { makeRng } from '../core/rng.js';
import {
  TILE_W, TILE_H, HALF_W, HALF_H, PLAYER_COLORS, PLAYER_COLORS_DARK,
} from '../core/constants.js';

export const ATLAS = 'aoe-gfx';

// Terrain diamonds are baked 1px larger than a tile and blitted 1px up-left, so
// neighbouring tiles overlap and antialiased seams never show through.
export const TILE_TEX_W = TILE_W + 2;
export const TILE_TEX_H = TILE_H + 2;
export const TILE_TEX_OFF_X = -1;
export const TILE_TEX_OFF_Y = -1;

const OUT = 0x161009; // universal dark outline — what makes shapes read at 390px

const SKIN = 0xf0c69c;
const STEEL = 0xc3ccd6;
const STEEL_D = 0x7e8894;
const WOOD = 0x9a6b38;
const WOOD_D = 0x6a4522;
const PLASTER = 0xe6d8b8;
const PLASTER_D = 0xbfae8b;

// --- small colour helpers ---------------------------------------------------

export function shade(c, f) {
  let r = (c >> 16) & 255;
  let g = (c >> 8) & 255;
  let b = c & 255;
  if (f >= 0) {
    r += (255 - r) * f;
    g += (255 - g) * f;
    b += (255 - b) * f;
  } else {
    const k = 1 + f;
    r *= k;
    g *= k;
    b *= k;
  }
  return (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b);
}

function clamp255(v) {
  v = Math.round(v);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// --- frame-name helpers (the renderer calls these) --------------------------

export function terrainFrame(terrainId, variant) {
  return `t${terrainId}_${variant}`;
}
export function unitFrame(type, player, back) {
  return `u_${type}_${player}_${back ? 'b' : 'f'}`;
}
export function buildingFrame(type, player) {
  return `b_${type}_${player}`;
}
/** Farms have three harvest stages; stage 0 shares the generic building name. */
export function farmFrame(player, stage) {
  return stage ? `b_farm${stage}_${player}` : `b_farm_${player}`;
}
export function foundationFrame(fw, player) {
  return `fd_${fw}_${player}`;
}
export function farmFoundationFrame(player) {
  return `fd_farm_${player}`;
}
export function resourceFrame(type, variant) {
  return `r_${type}_${variant}`;
}
export function markerFrame(player) {
  return `mk_team_${player}`;
}
/** Out-of-bounds sea, 0 = shore shallows .. OCEAN_LEVELS-1 = open deep. */
export function oceanFrame(level) {
  return `oc_${level}`;
}
/**
 * A soft one-edge wash, drawn white so the bake can tint it with whatever
 * terrain is bleeding across. Edge order matches the diamond's corners:
 * 0 = top-right (neighbour -y), 1 = bottom-right (+x), 2 = bottom-left (+y),
 * 3 = top-left (-x).
 */
export function edgeBlendFrame(edge) {
  return `eb_${edge}`;
}
/** Surf line laid along one edge of a coastal land tile. */
export function shoreFrame(edge) {
  return `sh_${edge}`;
}
/** Big soft ellipse used to break up large flat regions at bake time. */
export const BLOB_FRAME = 'tr_blob';

export const TERRAIN_VARIANTS = [4, 4, 3, 3]; // grass, dirt, water, sand
export const RESOURCE_VARIANTS = { tree: 3, berry: 2, gold: 3 };

// How many tiles of sea are actually tiled around the island before the flat
// deep-water fill takes over. The last ramp colour equals the fill, so the
// changeover is invisible.
export const TERRAIN_BORDER = 8;
export const OCEAN_LEVELS = 6;
// Everything outside the tiled border is painted this colour in one op.
export const OCEAN_DEEP = 0x0d2740;

/**
 * Build every texture and pack it into a single atlas.
 * Returns { atlas, origins: Map<frame, {w,h,ox,oy}> }.
 */
export function buildTextures(scene) {
  const SIZE = 1024;
  if (scene.textures.exists(ATLAS)) scene.textures.remove(ATLAS);
  const canvasTex = scene.textures.createCanvas(ATLAS, SIZE, SIZE);
  const ctx = canvasTex.getContext();
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const rng = makeRng(0x5eed11);

  const origins = new Map();
  const shelf = { x: 1, y: 1, h: 0 };
  const TMP = '__aoe_gfx_tmp';

  /**
   * Draw one sprite and pack it. (ax, ay) is the pixel inside the sprite that
   * should sit on the entity's world position — stored as an origin fraction.
   */
  function put(name, w, h, ax, ay, drawFn) {
    g.clear();
    drawFn(g);
    if (scene.textures.exists(TMP)) scene.textures.remove(TMP);
    g.generateTexture(TMP, w, h);
    const src = scene.textures.get(TMP).getSourceImage();
    if (shelf.x + w + 1 > SIZE) {
      shelf.x = 1;
      shelf.y += shelf.h + 1;
      shelf.h = 0;
    }
    ctx.drawImage(src, shelf.x, shelf.y);
    canvasTex.add(name, 0, shelf.x, shelf.y, w, h);
    origins.set(name, { w, h, ox: ax / w, oy: ay / h });
    shelf.x += w + 1;
    if (h > shelf.h) shelf.h = h;
    scene.textures.remove(TMP);
  }

  // Tall things first so the shelf packer wastes as little as possible.
  buildBuildings(put);
  buildFoundations(put);
  buildResources(put, rng);
  buildUnits(put);
  buildTerrain(put, rng);
  buildMarkers(put);
  buildFx(put);

  if (shelf.y + shelf.h > SIZE) {
    console.warn('[gfx] atlas overflow', shelf.y + shelf.h);
  }

  canvasTex.refresh();
  g.destroy();

  return { atlas: ATLAS, origins };
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

function diamondPts(w, h) {
  return [
    { x: w / 2, y: 0 },
    { x: w, y: h / 2 },
    { x: w / 2, y: h },
    { x: 0, y: h / 2 },
  ];
}

/** Uniform-ish random point inside the tile diamond, `inset` from the edge. */
function inDiamond(rng, w, h, inset) {
  for (let i = 0; i < 24; i++) {
    const a = rng() * 2 - 1;
    const b = rng() * 2 - 1;
    if (Math.abs(a) + Math.abs(b) <= 1 - inset) {
      return { x: w / 2 + (a * w) / 2, y: h / 2 + (b * h) / 2 };
    }
  }
  return { x: w / 2, y: h / 2 };
}

// Variants sit close together in value on purpose: spread them out and the map
// turns into a visible quilt of alternating diamonds.
const GRASS = [0x537d38, 0x55803a, 0x4f7935, 0x577f3c];
const DIRT = [0x8a6a45, 0x866742, 0x8e6e49, 0x876b47];
const WATER = [0x2c6d9e, 0x2b6a99, 0x2f719f];
const SAND = [0xd5bf82, 0xd1bb7e, 0xd8c288];

// One representative colour per terrain id, for tinting the edge-blend wash.
export const TERRAIN_BASE = [GRASS[0], DIRT[0], WATER[0], SAND[0]];
// Which terrain bleeds over which. A tile only ever receives the wash of a
// *higher* priority neighbour, so each boundary is drawn exactly once.
export const TERRAIN_PRIORITY = [0, 1, 3, 2]; // grass < dirt < sand < water

// Sea ramp from the shoreline outwards. The last entry must equal OCEAN_DEEP.
const OCEAN_RAMP = [0x2a6d92, 0x235f83, 0x1d5273, 0x184460, 0x123449, OCEAN_DEEP];

function buildTerrain(put, rng) {
  const W = TILE_TEX_W;
  const H = TILE_TEX_H;
  const pts = diamondPts(W, H);

  GRASS.forEach((base, i) => {
    put(terrainFrame(0, i), W, H, 0, 0, (g) => {
      fillTile(g, pts, base);
      blotches(g, rng, W, H, base, 6, 0.075);
      // Grass tufts read as texture even when the tile is only ~20px on screen.
      g.lineStyle(1, shade(base, 0.22), 0.55);
      for (let k = 0; k < 7; k++) {
        const p = inDiamond(rng, W, H, 0.3);
        g.beginPath();
        g.moveTo(p.x, p.y + 1);
        g.lineTo(p.x + rng.range(-1.6, 1.6), p.y - 3);
        g.strokePath();
      }
      if (i === 3) {
        // one variant carries a small flower cluster
        for (let k = 0; k < 3; k++) {
          const p = inDiamond(rng, W, H, 0.35);
          g.fillStyle(rng.chance(0.5) ? 0xe8e0b0 : 0xd8a8bc, 0.6);
          g.fillCircle(p.x, p.y - 1, 1.2);
        }
      }
      edgeTint(g, pts, base);
    });
  });

  DIRT.forEach((base, i) => {
    put(terrainFrame(1, i), W, H, 0, 0, (g) => {
      fillTile(g, pts, base);
      blotches(g, rng, W, H, base, 7, 0.1);
      // Pebbles. Variant 3 trades some of them for dry cracks and a stray
      // weed, so a wide sheet of dirt is not the same five stones over and
      // over — the flat-dirt regions were the quilt's dullest half.
      const stones = i === 3 ? 2 : 5;
      for (let k = 0; k < stones; k++) {
        const p = inDiamond(rng, W, H, 0.32);
        g.fillStyle(shade(base, -0.3), 0.8);
        g.fillEllipse(p.x, p.y, rng.range(2.5, 4.5), rng.range(1.8, 2.8));
        g.fillStyle(shade(base, 0.25), 0.7);
        g.fillEllipse(p.x - 0.4, p.y - 0.7, 1.8, 1.2);
      }
      if (i === 3) {
        g.lineStyle(1, shade(base, -0.34), 0.45);
        for (let k = 0; k < 3; k++) {
          const p = inDiamond(rng, W, H, 0.34);
          g.beginPath();
          g.moveTo(p.x - 4, p.y);
          g.lineTo(p.x, p.y + rng.range(-1.4, 1.4));
          g.lineTo(p.x + 5, p.y + rng.range(-1.2, 1.2));
          g.strokePath();
        }
        g.lineStyle(1, 0x6f7b40, 0.5);
        for (let k = 0; k < 3; k++) {
          const p = inDiamond(rng, W, H, 0.4);
          g.beginPath();
          g.moveTo(p.x, p.y + 1);
          g.lineTo(p.x + rng.range(-1.4, 1.4), p.y - 3.4);
          g.strokePath();
        }
      }
      edgeTint(g, pts, base);
    });
  });

  WATER.forEach((base, i) => {
    put(terrainFrame(2, i), W, H, 0, 0, (g) => {
      fillTile(g, pts, base);
      // Depth: darker toward the centre, lighter near the rim.
      g.fillStyle(shade(base, -0.22), 0.55);
      g.fillEllipse(W / 2, H / 2, W * 0.6, H * 0.6);
      g.lineStyle(1.6, shade(base, 0.3), 0.5);
      for (let k = 0; k < 3; k++) {
        const p = inDiamond(rng, W, H, 0.4);
        g.beginPath();
        g.moveTo(p.x - 5, p.y);
        g.lineTo(p.x - 1.5, p.y - 1.4);
        g.lineTo(p.x + 2, p.y);
        g.lineTo(p.x + 5.5, p.y - 1.4);
        g.strokePath();
      }
      g.lineStyle(1.5, shade(base, 0.45), 0.45);
      g.strokePoints(diamondPts(W, H), true, true);
    });
  });

  SAND.forEach((base, i) => {
    put(terrainFrame(3, i), W, H, 0, 0, (g) => {
      fillTile(g, pts, base);
      blotches(g, rng, W, H, base, 5, 0.08);
      for (let k = 0; k < 8; k++) {
        const p = inDiamond(rng, W, H, 0.34);
        g.fillStyle(shade(base, -0.22), 0.55);
        g.fillCircle(p.x, p.y, 0.9);
      }
      edgeTint(g, pts, base);
    });
  });

  buildOcean(put, rng);
  buildEdgeBlends(put, rng);
  buildShores(put);

  // Big soft ellipse, drawn tinted and very faint over the baked ground so
  // large single-terrain regions get slow, map-scale variation instead of
  // reading as one flat sheet. Costs nothing per frame: it is baked in.
  put(BLOB_FRAME, 168, 100, 84, 50, (g) => {
    for (let i = 7; i >= 1; i--) {
      g.fillStyle(0xffffff, 0.085);
      g.fillEllipse(84, 50, (158 * i) / 7, (94 * i) / 7);
    }
  });

  // White diamond used for placement / hover highlights (tinted at runtime).
  put('tile_hi', W, H, 0, 0, (g) => {
    g.fillStyle(0xffffff, 0.32);
    g.fillPoints(diamondPts(W, H), true, true);
    g.lineStyle(2, 0xffffff, 1);
    g.strokePoints(diamondPts(W - 3, H - 3).map((p) => ({ x: p.x + 1.5, y: p.y + 1.5 })), true, true);
  });
}

function fillTile(g, pts, base) {
  g.fillStyle(base, 1);
  g.fillPoints(pts, true, true);
}

function blotches(g, rng, W, H, base, n, amt) {
  for (let k = 0; k < n; k++) {
    const p = inDiamond(rng, W, H, 0.14);
    g.fillStyle(rng.chance(0.5) ? shade(base, amt) : shade(base, -amt), 0.5);
    g.fillEllipse(p.x, p.y, rng.range(9, 20), rng.range(4.5, 9));
  }
}

/** A whisper of an edge, so the iso grid is legible without looking drawn-on. */
function edgeTint(g, pts, base) {
  g.lineStyle(1, shade(base, -0.35), 0.055);
  g.strokePoints(pts, true, true);
}

// --- out-of-bounds sea -------------------------------------------------------
//
// The map is a diamond, so its bounding box has four empty corners; at the
// opening camera that showed as a dead black band across the top. Rather than
// fight the geometry, the world now ends in open water: a tiled shelf that
// deepens away from the coast and then hands off to one flat fill. All of it is
// baked into the same terrain RenderTextures, so the surround costs nothing per
// frame.

function buildOcean(put, rng) {
  const W = TILE_TEX_W;
  const H = TILE_TEX_H;
  const pts = diamondPts(W, H);
  OCEAN_RAMP.forEach((base, i) => {
    const deep = i / (OCEAN_RAMP.length - 1);
    put(oceanFrame(i), W, H, 0, 0, (g) => {
      fillTile(g, pts, base);
      // The outermost ring must be perfectly flat: it butts onto the solid
      // fill, and any detail there would draw the eye to the changeover.
      if (i === OCEAN_RAMP.length - 1) return;
      g.fillStyle(shade(base, -0.2), 0.42 * (1 - deep));
      g.fillEllipse(W / 2, H / 2, W * 0.62, H * 0.62);
      if (i <= 2) {
        g.lineStyle(1.5, shade(base, 0.3), 0.42 - i * 0.12);
        for (let k = 0; k < 2; k++) {
          const p = inDiamond(rng, W, H, 0.42);
          g.beginPath();
          g.moveTo(p.x - 5, p.y);
          g.lineTo(p.x - 1.5, p.y - 1.4);
          g.lineTo(p.x + 2, p.y);
          g.lineTo(p.x + 5.5, p.y - 1.4);
          g.strokePath();
        }
      }
    });
  });
}

/** The four diamond corners, in the order the edge indices walk them. */
function diamondCorners(W, H) {
  return [
    { x: W / 2, y: 0 },
    { x: W, y: H / 2 },
    { x: W / 2, y: H },
    { x: 0, y: H / 2 },
  ];
}

function towards(p, c, t) {
  return { x: p.x + (c.x - p.x) * t, y: p.y + (c.y - p.y) * t };
}

/**
 * Soft one-edge washes. Terrain meets terrain at a hard diamond staircase
 * otherwise; these fade the higher-priority ground a little way across the
 * boundary and then dither out, which is what kills the quilted look. Drawn in
 * white so one set of four frames serves every terrain pair via tint.
 */
function buildEdgeBlends(put, rng) {
  const W = TILE_TEX_W;
  const H = TILE_TEX_H;
  const corners = diamondCorners(W, H);
  const C = { x: W / 2, y: H / 2 };
  for (let e = 0; e < 4; e++) {
    const P = corners[e];
    const Q = corners[(e + 1) % 4];
    put(edgeBlendFrame(e), W, H, 0, 0, (g) => {
      const bands = [[0, 0.15, 0.95], [0.15, 0.32, 0.62], [0.32, 0.52, 0.3]];
      for (const [t0, t1, a] of bands) {
        g.fillStyle(0xffffff, a);
        g.fillPoints([
          towards(P, C, t0), towards(Q, C, t0),
          towards(Q, C, t1), towards(P, C, t1),
        ], true, true);
      }
      // Dithered speckle past the band, the way AoE2 feathers its transitions.
      for (let k = 0; k < 18; k++) {
        const u = rng.range(0.04, 0.96);
        const v = rng.range(0.5, 0.95);
        const onEdge = { x: P.x + (Q.x - P.x) * u, y: P.y + (Q.y - P.y) * u };
        const p = towards(onEdge, C, v);
        g.fillStyle(0xffffff, 0.36 * (1 - (v - 0.5) / 0.45));
        g.fillEllipse(p.x, p.y, rng.range(3, 6.5), rng.range(1.8, 3.2));
      }
    });
  }
}

/** Surf along one edge of a coastal tile. White; tinted pale at bake time. */
function buildShores(put) {
  const W = TILE_TEX_W;
  const H = TILE_TEX_H;
  const corners = diamondCorners(W, H);
  const C = { x: W / 2, y: H / 2 };
  for (let e = 0; e < 4; e++) {
    const P = corners[e];
    const Q = corners[(e + 1) % 4];
    put(shoreFrame(e), W, H, 0, 0, (g) => {
      const a0 = towards(P, C, 0.06);
      const b0 = towards(Q, C, 0.06);
      const a1 = towards(P, C, 0.2);
      const b1 = towards(Q, C, 0.2);
      g.fillStyle(0xffffff, 0.3);
      g.fillPoints([a0, b0, b1, a1], true, true);
      g.lineStyle(2.2, 0xffffff, 0.8);
      g.beginPath();
      g.moveTo(a0.x, a0.y);
      g.lineTo(b0.x, b0.y);
      g.strokePath();
      // Broken foam a little further up the beach.
      g.lineStyle(1.6, 0xffffff, 0.55);
      for (let k = 0; k < 3; k++) {
        const u = 0.14 + k * 0.3;
        const s = towards({ x: P.x + (Q.x - P.x) * u, y: P.y + (Q.y - P.y) * u }, C, 0.3);
        const t = towards({ x: P.x + (Q.x - P.x) * (u + 0.14), y: P.y + (Q.y - P.y) * (u + 0.14) }, C, 0.3);
        g.beginPath();
        g.moveTo(s.x, s.y);
        g.lineTo(t.x, t.y);
        g.strokePath();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const UNIT_BOX = {
  villager: { w: 36, h: 52, cx: 18, ft: 46 },
  militia: { w: 44, h: 56, cx: 22, ft: 50 },
  // Wider and taller than the others on purpose: the archer's whole identity is
  // the bow arc hanging off its left and the arrow fan off its right, and both
  // need room outside the body to read at phone size.
  archer: { w: 54, h: 60, cx: 27, ft: 52 },
};

function buildUnits(put) {
  for (let p = 0; p < PLAYER_COLORS.length; p++) {
    const col = PLAYER_COLORS[p];
    const dark = PLAYER_COLORS_DARK[p];
    for (const back of [false, true]) {
      const v = UNIT_BOX.villager;
      put(unitFrame('villager', p, back), v.w, v.h, v.cx, v.ft, (g) =>
        drawVillager(g, col, dark, back));
      const m = UNIT_BOX.militia;
      put(unitFrame('militia', p, back), m.w, m.h, m.cx, m.ft, (g) =>
        drawMilitia(g, col, dark, back));
      const a = UNIT_BOX.archer;
      put(unitFrame('archer', p, back), a.w, a.h, a.cx, a.ft, (g) =>
        drawArcher(g, col, dark, back));
    }
  }
}

function legs(g, cx, ft, col, w = 5, len = 12) {
  g.fillStyle(col, 1);
  g.fillRect(cx - w - 1, ft - len, w, len);
  g.fillRect(cx + 1, ft - len, w, len);
  g.lineStyle(1.4, OUT, 1);
  g.strokeRect(cx - w - 1, ft - len, w, len);
  g.strokeRect(cx + 1, ft - len, w, len);
  g.fillStyle(0x3b2c1c, 1);
  g.fillRoundedRect(cx - w - 2.5, ft - 4, w + 2, 4, 1.5);
  g.fillRoundedRect(cx + 0.5, ft - 4, w + 2, 4, 1.5);
  g.lineStyle(1.2, OUT, 1);
  g.strokeRoundedRect(cx - w - 2.5, ft - 4, w + 2, 4, 1.5);
  g.strokeRoundedRect(cx + 0.5, ft - 4, w + 2, 4, 1.5);
}

function head(g, x, y, r, back) {
  g.fillStyle(SKIN, 1);
  g.fillCircle(x, y, r);
  g.lineStyle(1.6, OUT, 1);
  g.strokeCircle(x, y, r);
  if (!back) {
    g.fillStyle(OUT, 1);
    g.fillCircle(x - 2, y - 0.3, 1);
    g.fillCircle(x + 2, y - 0.3, 1);
  }
}

// Villager: small, narrow shoulders, straw hat, carries a tool. Reads as
// "civilian" purely from silhouette.
function drawVillager(g, col, dark, back) {
  const { cx, ft } = UNIT_BOX.villager;
  const LINEN = 0xe6d7b2;

  legs(g, cx, ft, 0x7a5c3b);

  // torso
  g.fillStyle(LINEN, 1);
  g.fillRoundedRect(cx - 9, ft - 31, 18, 20, 4);
  g.fillStyle(col, 1);
  g.fillRoundedRect(cx - 9, ft - 31, 18, 8, 4); // team yoke
  g.fillStyle(dark, 1);
  g.fillRect(cx - 9, ft - 17, 18, 3.5); // belt
  g.lineStyle(2, OUT, 1);
  g.strokeRoundedRect(cx - 9, ft - 31, 18, 20, 4);

  // arms
  g.fillStyle(LINEN, 1);
  g.fillRoundedRect(cx - 12.5, ft - 29, 4.5, 13, 2);
  g.lineStyle(1.4, OUT, 1);
  g.strokeRoundedRect(cx - 12.5, ft - 29, 4.5, 13, 2);
  g.fillStyle(SKIN, 1);
  g.fillCircle(cx - 10.3, ft - 16.5, 2.4);

  head(g, cx, ft - 36, 5.5, back);

  // straw hat
  g.fillStyle(0xdcb45f, 1);
  g.fillEllipse(cx, ft - 38.6, back ? 19 : 17, 6);
  g.fillEllipse(cx, ft - 41.4, 10, 7);
  g.lineStyle(1.5, OUT, 1);
  g.strokeEllipse(cx, ft - 38.6, back ? 19 : 17, 6);
  if (!back) g.strokeEllipse(cx, ft - 41.4, 10, 7);

  if (back) {
    // shoulder pack, so the back pose is not just a faceless front pose
    g.fillStyle(0xb08b57, 1);
    g.fillRoundedRect(cx - 6, ft - 28, 12, 11, 3);
    g.lineStyle(1.6, OUT, 1);
    g.strokeRoundedRect(cx - 6, ft - 28, 12, 11, 3);
  }

  // axe
  g.lineStyle(4.6, OUT, 1);
  g.beginPath();
  g.moveTo(cx + 7, ft - 18);
  g.lineTo(cx + 12.5, ft - 37);
  g.strokePath();
  g.lineStyle(2.6, WOOD, 1);
  g.beginPath();
  g.moveTo(cx + 7, ft - 18);
  g.lineTo(cx + 12.5, ft - 37);
  g.strokePath();
  const axe = [
    { x: cx + 9.5, y: ft - 40 },
    { x: cx + 17, y: ft - 36.5 },
    { x: cx + 11.5, y: ft - 33 },
  ];
  g.fillStyle(STEEL, 1);
  g.fillPoints(axe, true, true);
  g.lineStyle(1.6, OUT, 1);
  g.strokePoints(axe, true, true);
}

// Militia: broad, helmeted, round shield left, sword raised right.
function drawMilitia(g, col, dark, back) {
  const { cx, ft } = UNIT_BOX.militia;

  legs(g, cx, ft, 0x6a6b74, 6, 13);

  // torso — wide, team coloured
  g.fillStyle(col, 1);
  g.fillRoundedRect(cx - 12, ft - 34, 24, 23, 5);
  g.fillStyle(shade(col, 0.16), 1);
  g.fillRoundedRect(cx - 12, ft - 34, 24, 8, 5); // pauldron band
  g.fillStyle(STEEL, 1);
  g.fillRoundedRect(cx - 7, ft - 26, 14, 11, 3); // breastplate
  g.fillStyle(STEEL_D, 1);
  g.fillRect(cx - 7, ft - 17, 14, 2.5);
  g.lineStyle(2.2, OUT, 1);
  g.strokeRoundedRect(cx - 12, ft - 34, 24, 23, 5);
  g.strokeRoundedRect(cx - 7, ft - 26, 14, 11, 3);

  head(g, cx, ft - 39, 5.5, back);

  // helmet: dome + face slit
  g.fillStyle(STEEL, 1);
  g.fillEllipse(cx, ft - 41, 15, 13);
  g.fillRect(cx - 7.5, ft - 41, 15, 4);
  g.lineStyle(1.8, OUT, 1);
  g.strokeEllipse(cx, ft - 41, 15, 13);
  if (!back) {
    g.fillStyle(OUT, 1);
    g.fillRect(cx - 5, ft - 38.5, 10, 2.4);
    g.fillRect(cx - 1.2, ft - 39.5, 2.4, 5);
  }
  // team plume
  g.fillStyle(col, 1);
  g.fillEllipse(cx, ft - 47.5, 6, 9);
  g.lineStyle(1.5, OUT, 1);
  g.strokeEllipse(cx, ft - 47.5, 6, 9);

  // shield (front pose: at the side; back pose: slung across the back)
  const sx = back ? cx : cx - 13.5;
  const sy = back ? ft - 25 : ft - 24;
  g.fillStyle(shade(col, -0.12), 1);
  g.fillCircle(sx, sy, back ? 9.5 : 9);
  g.lineStyle(2.4, OUT, 1);
  g.strokeCircle(sx, sy, back ? 9.5 : 9);
  g.fillStyle(STEEL, 1);
  g.fillCircle(sx, sy, 3);
  g.lineStyle(1.4, OUT, 1);
  g.strokeCircle(sx, sy, 3);
  g.lineStyle(1.6, shade(col, 0.3), 0.9);
  g.strokeCircle(sx, sy, 6.2);

  // sword, raised
  g.lineStyle(5.5, OUT, 1);
  g.beginPath();
  g.moveTo(cx + 12, ft - 27);
  g.lineTo(cx + 17, ft - 45);
  g.strokePath();
  g.lineStyle(3.2, STEEL, 1);
  g.beginPath();
  g.moveTo(cx + 12, ft - 27);
  g.lineTo(cx + 17, ft - 45);
  g.strokePath();
  g.lineStyle(3.4, OUT, 1);
  g.beginPath();
  g.moveTo(cx + 8.5, ft - 27.5);
  g.lineTo(cx + 15.5, ft - 25.5);
  g.strokePath();
  g.lineStyle(1.8, 0xd8a840, 1);
  g.beginPath();
  g.moveTo(cx + 8.5, ft - 27.5);
  g.lineTo(cx + 15.5, ft - 25.5);
  g.strokePath();
}

// Archer. The old one was a coloured body with a 1px bow line and vanished
// next to the militia at 1x. Three things carry it now, and each of them is
// legible on its own: a bow arc taller than the archer's own head, a fan of
// fletched arrows over the right shoulder, and a hood with a sharp forward
// peak (against the militia's round helmet dome).
function drawArcher(g, col, dark, back) {
  const { cx, ft } = UNIT_BOX.archer;
  const LEATHER = 0x63482a;

  legs(g, cx, ft, 0x5d4a35, 4.5, 12);

  // --- quiver, behind the body ---------------------------------------------
  const qx = cx + 9;
  const qy = ft - 32;
  for (let i = 0; i < 4; i++) {
    const a = -0.5 + i * 0.22;
    const tipX = qx + Math.sin(a) * 17;
    const tipY = qy - Math.cos(a) * 17;
    g.lineStyle(3.6, OUT, 1);
    g.beginPath();
    g.moveTo(qx, qy);
    g.lineTo(tipX, tipY);
    g.strokePath();
    g.lineStyle(1.7, WOOD, 1);
    g.beginPath();
    g.moveTo(qx, qy);
    g.lineTo(tipX, tipY);
    g.strokePath();
    g.fillStyle(OUT, 1);
    g.fillCircle(tipX, tipY, 2.8);
    g.fillStyle(i % 2 ? 0xf2ecda : 0xe0574f, 1);
    g.fillCircle(tipX, tipY, 1.8);
  }
  g.fillStyle(LEATHER, 1);
  g.fillRoundedRect(qx - 5, qy - 6, 10, 21, 3);
  g.lineStyle(1.9, OUT, 1);
  g.strokeRoundedRect(qx - 5, qy - 6, 10, 21, 3);
  g.fillStyle(shade(LEATHER, 0.3), 1);
  g.fillRect(qx - 5, qy + 3, 10, 3);

  // --- slim tunic -----------------------------------------------------------
  g.fillStyle(col, 1);
  g.fillRoundedRect(cx - 7.5, ft - 31, 15, 20, 4);
  g.fillStyle(dark, 1);
  g.fillRect(cx - 7.5, ft - 16, 15, 3.2);
  g.lineStyle(2, OUT, 1);
  g.strokeRoundedRect(cx - 7.5, ft - 31, 15, 20, 4);
  // quiver baldric, corner to corner across the chest
  g.lineStyle(3.4, LEATHER, 1);
  g.beginPath();
  g.moveTo(cx - 7, ft - 18);
  g.lineTo(cx + 7.5, ft - 30);
  g.strokePath();
  g.lineStyle(0.9, shade(LEATHER, 0.35), 0.8);
  g.beginPath();
  g.moveTo(cx - 7, ft - 19);
  g.lineTo(cx + 7.5, ft - 31);
  g.strokePath();
  // draw arm, reaching across to the string
  g.fillStyle(shade(col, -0.16), 1);
  g.fillRoundedRect(cx - 11.5, ft - 29, 5, 12, 2);
  g.lineStyle(1.4, OUT, 1);
  g.strokeRoundedRect(cx - 11.5, ft - 29, 5, 12, 2);

  head(g, cx, ft - 35, 5.2, back);

  // --- hood with a forward peak --------------------------------------------
  const hood = [
    { x: cx - 8.5, y: ft - 32 },
    { x: cx - 10, y: ft - 40 },
    { x: cx - 3.5, y: ft - 47.5 },
    { x: cx + 5, y: ft - 43.5 },
    { x: cx + 8.5, y: ft - 36 },
    { x: cx + 7.5, y: ft - 31 },
  ];
  g.fillStyle(shade(col, back ? -0.02 : -0.22), 1);
  g.fillPoints(hood, true, true);
  g.lineStyle(2, OUT, 1);
  g.strokePoints(hood, true, true);
  // shoulder cape, so the hood does not float
  const cape = [
    { x: cx - 10, y: ft - 30 },
    { x: cx - 7.5, y: ft - 34.5 },
    { x: cx + 7.5, y: ft - 34.5 },
    { x: cx + 10, y: ft - 30 },
  ];
  g.fillStyle(shade(col, back ? 0.02 : -0.3), 1);
  g.fillPoints(cape, true, true);
  g.lineStyle(1.7, OUT, 1);
  g.strokePoints(cape, true, true);
  if (!back) {
    g.fillStyle(SKIN, 1);
    g.fillEllipse(cx - 0.5, ft - 35.5, 9.5, 7.5);
    g.fillStyle(OUT, 1);
    g.fillCircle(cx - 2.6, ft - 36, 1.1);
    g.fillCircle(cx + 1.8, ft - 36, 1.1);
  }

  // --- bow, in front of everything -----------------------------------------
  // Tall enough that the arc alone identifies the unit in a mixed crowd.
  const bx = cx - 10;
  const by = ft - 27;
  const r = 16;
  const a0 = Math.PI * 0.58;
  const a1 = Math.PI * 1.42;
  const e0 = { x: bx + Math.cos(a0) * r, y: by + Math.sin(a0) * r };
  const e1 = { x: bx + Math.cos(a1) * r, y: by + Math.sin(a1) * r };
  g.lineStyle(6.2, OUT, 1);
  g.beginPath();
  g.arc(bx, by, r, a0, a1, false);
  g.strokePath();
  g.lineStyle(3.4, WOOD, 1);
  g.beginPath();
  g.arc(bx, by, r, a0, a1, false);
  g.strokePath();
  g.lineStyle(1.6, shade(WOOD, 0.3), 0.8);
  g.beginPath();
  g.arc(bx, by, r + 1, a0 + 0.25, a1 - 0.25, false);
  g.strokePath();
  // horn nocks at the limb tips
  g.fillStyle(OUT, 1);
  g.fillCircle(e0.x, e0.y, 2.4);
  g.fillCircle(e1.x, e1.y, 2.4);
  // grip
  g.fillStyle(0x3c2b16, 1);
  g.fillRect(bx - r - 2.5, by - 4, 5.5, 8);
  g.lineStyle(1.4, OUT, 1);
  g.strokeRect(bx - r - 2.5, by - 4, 5.5, 8);
  // string, drawn back to the hand
  g.lineStyle(2.4, OUT, 0.55);
  g.beginPath();
  g.moveTo(e0.x, e0.y);
  g.lineTo(e1.x, e1.y);
  g.strokePath();
  g.lineStyle(1.3, 0xf4eedd, 1);
  g.beginPath();
  g.moveTo(e0.x, e0.y);
  g.lineTo(e1.x, e1.y);
  g.strokePath();
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

// `h` is tuned so the drawing reaches within a few px of the texture's top
// edge — the renderer hangs health bars off the sprite's top, so slack here
// shows up as a bar floating in mid-air.
const BSPEC = {
  towncenter: { fw: 3, fh: 3, w: 200, h: 236 },
  house: { fw: 2, fh: 2, w: 140, h: 106 },
  barracks: { fw: 3, fh: 3, wallH: 38, roofH: 24, crenels: true, w: 200, h: 175 },
  mill: { fw: 2, fh: 2, wallH: 30, roofH: 22, blades: true, w: 140, h: 118 },
  farm: { fw: 2, fh: 2, w: 140, h: 100, stages: 3 },
};

// The Town Center's roof is deliberately neither team colour. Packed bases put
// five house roofs against it, and when everything was the same blue the whole
// base read as one continuous mass; a warm tile roof separates the building the
// game revolves around from the housing around it at any zoom. Team identity
// moves onto the eave fascia, the door awning, the corner banners and the
// gonfalon on the mast — all of which stay loud.
const TILE_ROOF = 0xcb7c3a;
const TILE_ROOF_D = 0x8e4f20;
const STONE = 0xa8a294;
const STONE_D = 0x7c766a;

function buildBuildings(put) {
  for (let p = 0; p < PLAYER_COLORS.length; p++) {
    const col = PLAYER_COLORS[p];
    const dark = PLAYER_COLORS_DARK[p];
    for (const type of Object.keys(BSPEC)) {
      const s = BSPEC[type];
      const baseHH = (s.fw + s.fh) * (HALF_H / 2);
      const ax = s.w / 2;
      const ay = s.h - 6 - baseHH;
      if (type === 'farm') {
        for (let stage = 0; stage < s.stages; stage++) {
          put(farmFrame(p, stage), s.w, s.h, ax, ay, (g) =>
            drawFarm(g, s, ax, ay, col, dark, stage));
        }
      } else {
        put(buildingFrame(type, p), s.w, s.h, ax, ay, (g) =>
          drawBuilding(g, type, s, ax, ay, col, dark));
      }
    }
  }
}

/** The ground the building stands on: an fw x fh block of packed stone. */
function platform(g, cx, cy, hw, hh, stepped) {
  const base = [
    { x: cx, y: cy - hh },
    { x: cx + hw, y: cy },
    { x: cx, y: cy + hh },
    { x: cx - hw, y: cy },
  ];
  g.fillStyle(0x5e5648, 1);
  g.fillPoints(base.map((p) => ({ x: p.x, y: p.y + 4 })), true, true);
  g.fillStyle(0x8d8271, 1);
  g.fillPoints(base, true, true);
  g.lineStyle(2.5, OUT, 1);
  g.strokePoints(base, true, true);
  if (stepped) {
    // A second, inset course. Reads as a raised dais and adds a little more
    // mass to the Town Center's base without widening its footprint.
    const inner = base.map((p) => ({
      x: cx + (p.x - cx) * 0.86,
      y: cy + (p.y - cy) * 0.86 - 3,
    }));
    g.fillStyle(shade(0x8d8271, 0.12), 1);
    g.fillPoints(inner, true, true);
    g.lineStyle(2, OUT, 0.9);
    g.strokePoints(inner, true, true);
  }
  return base;
}

function drawBuilding(g, type, s, cx, cy, col, colDark) {
  if (type === 'towncenter') {
    drawTownCenter(g, s, cx, cy, col, colDark);
    return;
  }
  if (type === 'house') {
    drawHouse(g, s, cx, cy, col, colDark);
    return;
  }

  // Footprint diamond: an fw x fh block spans (fw+fh) half-tiles each way.
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);

  platform(g, cx, cy, hw, hh, false);

  const iw = hw * 0.78;
  const ih = hh * 0.78;
  isoBox(g, cx, cy, iw, ih, s.wallH, PLASTER, PLASTER_D, shade(PLASTER, 0.1));

  // Timber framing on the two visible walls.
  timbers(g, cx, cy, iw, ih, s.wallH);

  const topY = cy - s.wallH;
  isoRoof(g, cx, topY, iw * 1.14, ih * 1.14, s.roofH, col, colDark);

  if (s.crenels) crenellations(g, cx, topY, iw * 1.14, ih * 1.14, col, colDark);

  // Door on the south-facing wall.
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(cx - 7, cy + ih - s.wallH + 2, 14, s.wallH - 6, 3);
  g.lineStyle(2, OUT, 1);
  g.strokeRoundedRect(cx - 7, cy + ih - s.wallH + 2, 14, s.wallH - 6, 3);
  g.fillStyle(0xdcc36a, 1);
  g.fillCircle(cx + 4, cy + ih - s.wallH / 2, 1.6);

  if (type === 'barracks') {
    // crossed swords, painted on the wall
    g.lineStyle(3.4, OUT, 1);
    g.beginPath();
    g.moveTo(cx - 26, cy + 4);
    g.lineTo(cx - 12, cy - 10);
    g.moveTo(cx - 26, cy - 10);
    g.lineTo(cx - 12, cy + 4);
    g.strokePath();
    g.lineStyle(1.8, STEEL, 1);
    g.beginPath();
    g.moveTo(cx - 26, cy + 4);
    g.lineTo(cx - 12, cy - 10);
    g.moveTo(cx - 26, cy - 10);
    g.lineTo(cx - 12, cy + 4);
    g.strokePath();
  }

  if (type === 'mill') {
    const hubY = topY - s.roofH - 8;
    g.lineStyle(3, OUT, 1);
    g.beginPath();
    g.moveTo(cx, hubY);
    g.lineTo(cx, topY - s.roofH + 4);
    g.strokePath();
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI / 2) * i + 0.5;
      const bx = cx + Math.cos(a) * 20;
      const by = hubY + Math.sin(a) * 14;
      g.lineStyle(4.2, OUT, 1);
      g.beginPath();
      g.moveTo(cx, hubY);
      g.lineTo(bx, by);
      g.strokePath();
      g.lineStyle(2.2, 0xe8dcc0, 1);
      g.beginPath();
      g.moveTo(cx, hubY);
      g.lineTo(bx, by);
      g.strokePath();
    }
    g.fillStyle(WOOD_D, 1);
    g.fillCircle(cx, hubY, 3.4);
    g.lineStyle(1.6, OUT, 1);
    g.strokeCircle(cx, hubY, 3.4);
  }

  banner(g, cx + iw * 0.72, cy + 3, col, colDark, 26);
}

// ---------------------------------------------------------------------------
// Town Center — must survive being ringed by houses at radius 2
// ---------------------------------------------------------------------------
//
// Four separate cues, so losing any one of them to occlusion is survivable:
// a warm tile roof nothing else on the map wears, a stone keep raised well
// above house ridge height, a mast whose gonfalon clears every neighbouring
// roof, and a broad team-coloured fascia under the eaves.

function drawTownCenter(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, true);

  const iw = hw * 0.8;
  const ih = hh * 0.8;
  const wallH = 50;
  isoBox(g, cx, cy, iw, ih, wallH, PLASTER, PLASTER_D, shade(PLASTER, 0.1));
  timbers(g, cx, cy, iw, ih, wallH);

  // Stone piers at the three visible corners: more mass at ground level, and
  // something that still says "Town Center" if only the base is showing.
  for (const [px, py] of [[cx - iw, cy], [cx, cy + ih], [cx + iw, cy]]) {
    g.fillStyle(STONE, 1);
    g.fillRect(px - 5, py - wallH, 10, wallH);
    g.lineStyle(2, OUT, 1);
    g.strokeRect(px - 5, py - wallH, 10, wallH);
    g.fillStyle(STONE_D, 0.7);
    for (let k = 1; k < 4; k++) {
      g.fillRect(px - 5, py - (wallH * k) / 4, 10, 1.6);
    }
  }

  const topY = cy - wallH;
  isoRoof(g, cx, topY, iw * 1.16, ih * 1.16, 32, TILE_ROOF, TILE_ROOF_D, col, colDark, 8);

  // Door, under a team-coloured awning.
  const doorTop = cy + ih - wallH + 6;
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(cx - 9, doorTop, 18, wallH - 10, 3);
  g.lineStyle(2.2, OUT, 1);
  g.strokeRoundedRect(cx - 9, doorTop, 18, wallH - 10, 3);
  g.fillStyle(0xdcc36a, 1);
  g.fillCircle(cx + 5, doorTop + (wallH - 10) / 2, 1.8);
  const awning = [
    { x: cx - 14, y: doorTop - 1 },
    { x: cx + 14, y: doorTop - 1 },
    { x: cx + 10, y: doorTop - 8 },
    { x: cx - 10, y: doorTop - 8 },
  ];
  g.fillStyle(col, 1);
  g.fillPoints(awning, true, true);
  g.lineStyle(1.8, OUT, 1);
  g.strokePoints(awning, true, true);

  // Raised stone keep.
  const kw = iw * 0.46;
  const kh = ih * 0.46;
  const kBase = topY - 4;
  const keepH = 34;
  isoBox(g, cx, kBase, kw, kh, keepH, STONE, STONE_D, shade(STONE, 0.16));
  const kTop = kBase - keepH;
  // arrow slits
  g.fillStyle(OUT, 0.85);
  g.fillRect(cx - 9, kBase - keepH + 8, 3, 11);
  g.fillRect(cx + 6, kBase - keepH + 8, 3, 11);
  isoRoof(g, cx, kTop, kw * 1.36, kh * 1.36, 26, TILE_ROOF, TILE_ROOF_D, col, colDark, 5);

  // The mast. Its whole job is to be visible when the walls are not.
  const apexY = kTop - kh * 1.36 - 26;
  mast(g, cx, apexY + 8, col, colDark, 50);

  banner(g, cx - hw * 0.6, cy + 4, col, colDark, 36);
  banner(g, cx + hw * 0.6, cy + 4, col, colDark, 36);
}

/** Pole, crossbar and a big symmetric gonfalon — reads from right across the map. */
function mast(g, x, y, col, colDark, h) {
  const top = y - h;
  g.lineStyle(4.6, OUT, 1);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x, top);
  g.strokePath();
  g.lineStyle(2.4, 0x6a5334, 1);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x, top);
  g.strokePath();
  // finial
  g.fillStyle(0xf0cf62, 1);
  g.fillCircle(x, top - 3, 3.6);
  g.lineStyle(1.6, OUT, 1);
  g.strokeCircle(x, top - 3, 3.6);
  // crossbar
  g.lineStyle(3.4, OUT, 1);
  g.beginPath();
  g.moveTo(x - 13, top + 3);
  g.lineTo(x + 13, top + 3);
  g.strokePath();
  g.lineStyle(1.6, 0x6a5334, 1);
  g.beginPath();
  g.moveTo(x - 13, top + 3);
  g.lineTo(x + 13, top + 3);
  g.strokePath();
  // gonfalon, swallow-tailed
  const t = top + 4;
  const flag = [
    { x: x - 12, y: t },
    { x: x + 12, y: t },
    { x: x + 12, y: t + 20 },
    { x: x + 6, y: t + 15 },
    { x: x, y: t + 22 },
    { x: x - 6, y: t + 15 },
    { x: x - 12, y: t + 20 },
  ];
  g.fillStyle(col, 1);
  g.fillPoints(flag, true, true);
  g.lineStyle(2, OUT, 1);
  g.strokePoints(flag, true, true);
  g.fillStyle(colDark, 1);
  g.fillRect(x - 12, t + 6, 24, 4);
  g.fillStyle(shade(col, 0.5), 0.85);
  g.fillCircle(x, t + 4, 3);
}

// ---------------------------------------------------------------------------
// House — low, gabled, subordinate
// ---------------------------------------------------------------------------
//
// Keeps a full team-coloured roof slope (ownership has to stay instant), but
// the pyramid is gone: a ridge roof with a plaster gable end and a thatch cap
// breaks the "one continuous mass of identical roofs" the reviewer hit, and
// the whole thing is 25px shorter than it was.

function drawHouse(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, false);

  const iw = hw * 0.76;
  const ih = hh * 0.76;
  const wallH = 22;
  isoBox(g, cx, cy, iw, ih, wallH, PLASTER, PLASTER_D, shade(PLASTER, 0.1));
  timbers(g, cx, cy, iw, ih, wallH);

  // Door on the south wall.
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(cx - 5.5, cy + ih - wallH + 3, 11, wallH - 5, 2.5);
  g.lineStyle(1.8, OUT, 1);
  g.strokeRoundedRect(cx - 5.5, cy + ih - wallH + 3, 11, wallH - 5, 2.5);

  gableRoof(g, cx, cy - wallH, iw * 1.14, ih * 1.14, 20, col, colDark);
  banner(g, cx + iw * 0.85, cy + 3, col, colDark, 18);
}

/**
 * Ridge roof over a diamond footprint. The ridge runs along the grid's
 * north-east axis, which leaves exactly two faces facing the camera: the
 * south-east slope, and the triangular gable end on the south-west.
 */
function gableRoof(g, cx, cy, hw, hh, h, col, colDark) {
  const N = { x: cx, y: cy - hh };
  const E = { x: cx + hw, y: cy };
  const S = { x: cx, y: cy + hh };
  const W = { x: cx - hw, y: cy };
  const R1 = { x: cx + hw / 2, y: cy - hh / 2 - h }; // ridge, NE end
  const R2 = { x: cx - hw / 2, y: cy + hh / 2 - h }; // ridge, SW end

  // eave lip
  g.fillStyle(shade(colDark, -0.3), 1);
  g.fillPoints([
    { x: W.x, y: W.y }, { x: S.x, y: S.y }, { x: E.x, y: E.y },
    { x: E.x, y: E.y + 3 }, { x: S.x, y: S.y + 3 }, { x: W.x, y: W.y + 3 },
  ], true, true);

  // south-east slope
  const slope = [S, E, R1, R2];
  g.fillStyle(shade(col, 0.06), 1);
  g.fillPoints(slope, true, true);
  g.lineStyle(2.2, OUT, 1);
  g.strokePoints(slope, true, true);
  g.lineStyle(1.1, shade(col, -0.4), 0.42);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    g.beginPath();
    g.moveTo(S.x + (R2.x - S.x) * t, S.y + (R2.y - S.y) * t);
    g.lineTo(E.x + (R1.x - E.x) * t, E.y + (R1.y - E.y) * t);
    g.strokePath();
  }

  // south-west gable end: plaster with timber bracing
  const gable = [W, S, R2];
  g.fillStyle(PLASTER, 1);
  g.fillPoints(gable, true, true);
  g.lineStyle(2.4, WOOD_D, 0.9);
  g.beginPath();
  g.moveTo(W.x + 3, W.y - 1);
  g.lineTo(R2.x, R2.y + 4);
  g.moveTo(S.x - 2, S.y - 2);
  g.lineTo(R2.x, R2.y + 4);
  g.strokePath();
  g.lineStyle(2.2, OUT, 1);
  g.strokePoints(gable, true, true);
  // loft opening
  const mx = (W.x + S.x) / 2;
  const my = (W.y + S.y) / 2;
  g.fillStyle(0x3b2c1c, 1);
  g.fillEllipse((mx + R2.x) / 2, (my + R2.y) / 2 + 1, 7, 6);

  // thatch cap along the ridge
  g.lineStyle(5.5, OUT, 1);
  g.beginPath();
  g.moveTo(R2.x, R2.y);
  g.lineTo(R1.x, R1.y);
  g.strokePath();
  g.lineStyle(3.2, 0xd8b96b, 1);
  g.beginPath();
  g.moveTo(R2.x, R2.y);
  g.lineTo(R1.x, R1.y);
  g.strokePath();

  // chimney, a little more silhouette for free
  const chx = R2.x + (R1.x - R2.x) * 0.68;
  const chy = R2.y + (R1.y - R2.y) * 0.68;
  g.fillStyle(0x8a6a55, 1);
  g.fillRect(chx - 3.2, chy - 11, 6.4, 12);
  g.lineStyle(1.7, OUT, 1);
  g.strokeRect(chx - 3.2, chy - 11, 6.4, 12);
  g.fillStyle(0x5f483a, 1);
  g.fillRect(chx - 4.2, chy - 13, 8.4, 2.6);
}

// ---------------------------------------------------------------------------
// Farm — a flat tilled plot, never confusable with a house
// ---------------------------------------------------------------------------
//
// stage 0 = fresh (full gold crop), 1 = worked (half the rows cut),
// 2 = spent (grey stubble on cracked soil). The colour swing from gold to grey
// is the point: which farms are worked out has to be readable without tapping.

const FARM_STAGE = [
  { soil: 0x5c4020, crop: 0xe8bd35, lit: 0xfbe388, dark: 0x9a761b, tufts: 10 },
  { soil: 0x604a2b, crop: 0xb8993f, lit: 0xd2b96a, dark: 0x846718, tufts: 5 },
  { soil: 0x6f6455, crop: 0x9d9578, lit: 0xb6ae92, dark: 0x6e6850, tufts: 2 },
];

function drawFarm(g, s, cx, cy, col, colDark, stage) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  const P = FARM_STAGE[stage] || FARM_STAGE[0];
  const spent = stage === 2;

  const corners = [
    { x: cx, y: cy - hh },   // N
    { x: cx + hw, y: cy },   // E
    { x: cx, y: cy + hh },   // S
    { x: cx - hw, y: cy },   // W
  ];

  // Back fence first, so the northern rails sit behind the crop.
  fenceRun(g, corners[3], corners[0], spent);
  fenceRun(g, corners[0], corners[1], spent);

  // Tilled soil.
  g.fillStyle(shade(P.soil, -0.35), 1);
  g.fillPoints(corners.map((p) => ({ x: p.x, y: p.y + 3 })), true, true);
  g.fillStyle(P.soil, 1);
  g.fillPoints(corners, true, true);
  g.lineStyle(2.5, OUT, 1);
  g.strokePoints(corners, true, true);

  // Crop rows, running along the grid's north-east axis.
  const rows = 7;
  for (let i = 1; i <= rows; i++) {
    const t = i / (rows + 1);
    const x0 = cx - hw + hw * t;
    const y0 = cy + hh * t;
    const x1 = cx + hw * t;
    const y1 = cy - hh + hh * t;
    // furrow trench
    g.lineStyle(6.4, shade(P.soil, -0.34), 1);
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.strokePath();
    // Stage 1 cuts every other row right back to stubble, so a half-worked
    // farm differs from a fresh one in layout as well as in hue.
    const cut = spent || (stage === 1 && i % 2 === 0);
    if (cut) {
      // stubble: short broken bristles on bare soil, no standing crop
      g.lineStyle(1.4, P.crop, 0.8);
      for (let k = 0; k < 9; k++) {
        const u = (k + 0.4) / 9;
        const px = x0 + (x1 - x0) * u;
        const py = y0 + (y1 - y0) * u - 2;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + (k % 2 ? 1 : -1), py - 2.4);
        g.strokePath();
      }
    } else {
      g.lineStyle(5.6, P.dark, 1);
      g.beginPath();
      g.moveTo(x0 + 2, y0 - 2.5);
      g.lineTo(x1 - 2, y1 - 2.5);
      g.strokePath();
      g.lineStyle(4, P.crop, 1);
      g.beginPath();
      g.moveTo(x0 + 2, y0 - 4);
      g.lineTo(x1 - 2, y1 - 4);
      g.strokePath();
      g.lineStyle(1.4, P.lit, 0.85);
      g.beginPath();
      g.moveTo(x0 + 3, y0 - 5.4);
      g.lineTo(x1 - 3, y1 - 5.4);
      g.strokePath();
      // Ears standing proud of the row, alternating sides. Without these the
      // rows read as laid planks rather than as a crop.
      const tufts = P.tufts;
      for (let k = 0; k < tufts; k++) {
        const u = (k + 0.5) / tufts;
        const px = x0 + (x1 - x0) * u;
        const py = y0 + (y1 - y0) * u - 5;
        const lean = k % 2 ? 1.6 : -1.6;
        g.lineStyle(1.6, P.dark, 1);
        g.beginPath();
        g.moveTo(px, py + 1);
        g.lineTo(px + lean, py - 4.6);
        g.strokePath();
        g.lineStyle(1.5, P.lit, 1);
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + lean, py - 5);
        g.strokePath();
      }
    }
  }

  if (spent) {
    // dry cracks and loose straw, so a worked-out farm reads as abandoned
    g.lineStyle(1.2, shade(P.soil, -0.4), 0.6);
    for (let k = 0; k < 5; k++) {
      const px = cx - 34 + k * 17;
      const py = cy - 8 + (k % 3) * 9;
      g.beginPath();
      g.moveTo(px - 6, py);
      g.lineTo(px, py + 2.5);
      g.lineTo(px + 7, py - 1.5);
      g.strokePath();
    }
  }

  // Front fence.
  fenceRun(g, corners[3], corners[2], spent);
  fenceRun(g, corners[2], corners[1], spent);

  // Team pennant on the north post — the only loud colour on the plot, which
  // is what keeps a farm from competing with the buildings around it.
  const post = corners[0];
  g.lineStyle(3, OUT, 1);
  g.beginPath();
  g.moveTo(post.x, post.y);
  g.lineTo(post.x, post.y - 22);
  g.strokePath();
  g.lineStyle(1.5, 0x6a5334, 1);
  g.beginPath();
  g.moveTo(post.x, post.y);
  g.lineTo(post.x, post.y - 22);
  g.strokePath();
  const flagCol = spent ? shade(colDark, -0.32) : col;
  g.fillStyle(flagCol, 1);
  g.fillTriangle(post.x, post.y - 22, post.x + 12, post.y - 18, post.x, post.y - 13);
  g.lineStyle(1.6, OUT, 1);
  g.strokeTriangle(post.x, post.y - 22, post.x + 12, post.y - 18, post.x, post.y - 13);
}

/** Low post-and-rail run between two footprint corners. */
function fenceRun(g, a, b, weathered) {
  const wood = weathered ? 0x7d7361 : 0x8a6337;
  const H = 8;
  g.lineStyle(3.2, OUT, 1);
  g.beginPath();
  g.moveTo(a.x, a.y - H);
  g.lineTo(b.x, b.y - H);
  g.moveTo(a.x, a.y - H * 0.42);
  g.lineTo(b.x, b.y - H * 0.42);
  g.strokePath();
  g.lineStyle(1.6, wood, 1);
  g.beginPath();
  g.moveTo(a.x, a.y - H);
  g.lineTo(b.x, b.y - H);
  g.moveTo(a.x, a.y - H * 0.42);
  g.lineTo(b.x, b.y - H * 0.42);
  g.strokePath();
  for (const t of [0, 0.5, 1]) {
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    g.fillStyle(OUT, 1);
    g.fillRect(px - 2, py - H - 1.5, 4, H + 2);
    g.fillStyle(wood, 1);
    g.fillRect(px - 1.2, py - H - 0.8, 2.4, H + 1);
  }
}

/** An isometric box: two visible wall faces plus the flat top. */
function isoBox(g, cx, cy, hw, hh, h, faceL, faceR, top) {
  const bW = { x: cx - hw, y: cy };
  const bS = { x: cx, y: cy + hh };
  const bE = { x: cx + hw, y: cy };
  const bN = { x: cx, y: cy - hh };

  const left = [bW, bS, { x: bS.x, y: bS.y - h }, { x: bW.x, y: bW.y - h }];
  const right = [bS, bE, { x: bE.x, y: bE.y - h }, { x: bS.x, y: bS.y - h }];
  const topFace = [
    { x: bN.x, y: bN.y - h },
    { x: bE.x, y: bE.y - h },
    { x: bS.x, y: bS.y - h },
    { x: bW.x, y: bW.y - h },
  ];

  g.fillStyle(shade(faceL, -0.16), 1);
  g.fillPoints(left, true, true);
  g.fillStyle(faceR, 1);
  g.fillPoints(right, true, true);
  g.fillStyle(top, 1);
  g.fillPoints(topFace, true, true);

  g.lineStyle(2.2, OUT, 1);
  g.strokePoints(left, true, true);
  g.strokePoints(right, true, true);
  g.strokePoints(topFace, true, true);
}

function timbers(g, cx, cy, hw, hh, h) {
  g.lineStyle(2.6, WOOD_D, 0.85);
  for (let i = 1; i <= 2; i++) {
    const t = i / 3;
    const lx = cx - hw + hw * t;
    const ly = cy + hh * t;
    g.beginPath();
    g.moveTo(lx, ly);
    g.lineTo(lx, ly - h);
    g.strokePath();
    const rx = cx + hw * t;
    const ry = cy + hh - hh * t;
    g.beginPath();
    g.moveTo(rx, ry);
    g.lineTo(rx, ry - h);
    g.strokePath();
  }
}

/**
 * Hip roof as a pyramid; the two south faces are all the camera can see.
 * `fasciaCol` hangs a band of team colour under the eaves — that is how the
 * Town Center keeps loud ownership while wearing a non-team roof.
 */
function isoRoof(g, cx, cy, hw, hh, h, col, colDark, fasciaCol, fasciaDark, fasciaH) {
  const W = { x: cx - hw, y: cy };
  const S = { x: cx, y: cy + hh };
  const E = { x: cx + hw, y: cy };
  const apex = { x: cx, y: cy - hh - h };

  if (fasciaCol !== undefined && fasciaCol !== null) {
    const fh = fasciaH || 6;
    const band = [
      W, S, E,
      { x: E.x, y: E.y + fh },
      { x: S.x, y: S.y + fh },
      { x: W.x, y: W.y + fh },
    ];
    g.fillStyle(fasciaDark || shade(fasciaCol, -0.2), 1);
    g.fillPoints(band, true, true);
    g.fillStyle(fasciaCol, 1);
    g.fillPoints([
      W, S, E,
      { x: E.x, y: E.y + fh * 0.6 },
      { x: S.x, y: S.y + fh * 0.6 },
      { x: W.x, y: W.y + fh * 0.6 },
    ], true, true);
    g.lineStyle(2, OUT, 1);
    g.strokePoints(band, true, true);
  }

  // eaves
  const eave = [
    { x: cx, y: cy - hh },
    E,
    S,
    W,
  ];
  g.fillStyle(shade(colDark, -0.25), 1);
  g.fillPoints(eave.map((p) => ({ x: p.x, y: p.y + 3 })), true, true);

  const left = [W, S, apex];
  const right = [S, E, apex];
  g.fillStyle(shade(col, -0.2), 1);
  g.fillPoints(left, true, true);
  g.fillStyle(shade(col, 0.08), 1);
  g.fillPoints(right, true, true);
  g.lineStyle(2.4, OUT, 1);
  g.strokePoints(left, true, true);
  g.strokePoints(right, true, true);

  // shingle lines, faint
  g.lineStyle(1.1, shade(col, -0.4), 0.4);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    g.beginPath();
    g.moveTo(W.x + (apex.x - W.x) * t, W.y + (apex.y - W.y) * t);
    g.lineTo(S.x + (apex.x - S.x) * t, S.y + (apex.y - S.y) * t);
    g.lineTo(E.x + (apex.x - E.x) * t, E.y + (apex.y - E.y) * t);
    g.strokePath();
  }
}

function crenellations(g, cx, cy, hw, hh, col, colDark) {
  for (let i = 0; i < 4; i++) {
    const t = 0.18 + i * 0.22;
    const lx = cx - hw + hw * t;
    const ly = cy + hh * t;
    const rx = cx + hw - hw * t;
    const ry = cy + hh * t;
    g.fillStyle(shade(PLASTER, -0.05), 1);
    g.fillRect(lx - 3, ly - 9, 6, 9);
    g.fillRect(rx - 3, ry - 9, 6, 9);
    g.lineStyle(1.6, OUT, 1);
    g.strokeRect(lx - 3, ly - 9, 6, 9);
    g.strokeRect(rx - 3, ry - 9, 6, 9);
  }
}

/** Team banner on a pole — the loudest possible ownership cue. */
function banner(g, x, y, col, colDark, h) {
  g.lineStyle(3.4, OUT, 1);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x, y - h);
  g.strokePath();
  g.lineStyle(1.7, 0x6a5334, 1);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x, y - h);
  g.strokePath();
  const flag = [
    { x: x, y: y - h },
    { x: x + 15, y: y - h + 4 },
    { x: x + 11, y: y - h + 9 },
    { x: x + 15, y: y - h + 14 },
    { x: x, y: y - h + 13 },
  ];
  g.fillStyle(col, 1);
  g.fillPoints(flag, true, true);
  g.lineStyle(1.8, OUT, 1);
  g.strokePoints(flag, true, true);
  g.fillStyle(shade(col, 0.35), 0.7);
  g.fillRect(x + 1, y - h + 2, 5, 3);
}

// --- foundations ------------------------------------------------------------

function buildFoundations(put) {
  for (let p = 0; p < PLAYER_COLORS.length; p++) {
    for (const fw of [2, 3]) {
      const hw = fw * HALF_W;
      const hh = fw * HALF_H;
      const w = hw * 2 + 12;
      const h = hh * 2 + 30;
      const ax = w / 2;
      const ay = h - 6 - hh;
      put(foundationFrame(fw, p), w, h, ax, ay, (g) =>
        drawFoundation(g, ax, ay, hw, hh, PLAYER_COLORS[p], PLAYER_COLORS_DARK[p]));
    }
    // A farm under construction is ground being broken, not a timber frame.
    const hw = 2 * HALF_W;
    const hh = 2 * HALF_H;
    const w = hw * 2 + 12;
    const h = hh * 2 + 30;
    put(farmFoundationFrame(p), w, h, w / 2, h - 6 - hh, (g) =>
      drawFarmFoundation(g, w / 2, h - 6 - hh, hw, hh, PLAYER_COLORS[p]));
  }
}

/** Ploughed but unsown: furrow trenches, marker stakes, a barrow of seed. */
function drawFarmFoundation(g, cx, cy, hw, hh, col) {
  const pts = [
    { x: cx, y: cy - hh },
    { x: cx + hw, y: cy },
    { x: cx, y: cy + hh },
    { x: cx - hw, y: cy },
  ];
  g.fillStyle(0x4b3519, 1);
  g.fillPoints(pts.map((p) => ({ x: p.x, y: p.y + 3 })), true, true);
  g.fillStyle(0x63482a, 1);
  g.fillPoints(pts, true, true);
  g.lineStyle(2.5, OUT, 0.9);
  g.strokePoints(pts, true, true);

  for (let i = 1; i <= 7; i++) {
    const t = i / 8;
    g.lineStyle(5.5, 0x4a3419, 0.95);
    g.beginPath();
    g.moveTo(cx - hw + hw * t, cy + hh * t);
    g.lineTo(cx + hw * t, cy - hh + hh * t);
    g.strokePath();
    g.lineStyle(1.6, 0x7a5b34, 0.8);
    g.beginPath();
    g.moveTo(cx - hw + hw * t + 2, cy + hh * t - 3);
    g.lineTo(cx + hw * t - 2, cy - hh + hh * t - 3);
    g.strokePath();
  }

  for (const p of pts) {
    g.lineStyle(3.2, OUT, 1);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x, p.y - 13);
    g.strokePath();
    g.lineStyle(1.6, 0x6a5334, 1);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x, p.y - 13);
    g.strokePath();
    g.fillStyle(col, 1);
    g.fillTriangle(p.x, p.y - 13, p.x + 7, p.y - 10.5, p.x, p.y - 8);
    g.lineStyle(1.3, OUT, 1);
    g.strokeTriangle(p.x, p.y - 13, p.x + 7, p.y - 10.5, p.x, p.y - 8);
  }
  // string line between the stakes
  g.lineStyle(1, 0xe6dcc0, 0.55);
  g.strokePoints(pts.map((p) => ({ x: p.x, y: p.y - 11 })), true, true);
}

function drawFoundation(g, cx, cy, hw, hh, col, colDark) {
  const pts = [
    { x: cx, y: cy - hh },
    { x: cx + hw, y: cy },
    { x: cx, y: cy + hh },
    { x: cx - hw, y: cy },
  ];
  g.fillStyle(0x7a6547, 1);
  g.fillPoints(pts, true, true);
  g.lineStyle(2.5, OUT, 0.85);
  g.strokePoints(pts, true, true);

  // planks laid out along the footprint
  g.lineStyle(3.2, WOOD_D, 0.95);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    g.beginPath();
    g.moveTo(cx - hw + hw * t, cy + hh * t);
    g.lineTo(cx + hw * t, cy - hh + hh * t);
    g.strokePath();
  }
  g.lineStyle(1.4, shade(WOOD, 0.2), 0.6);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    g.beginPath();
    g.moveTo(cx - hw + hw * t, cy + hh * t - 1);
    g.lineTo(cx + hw * t, cy - hh + hh * t - 1);
    g.strokePath();
  }

  // corner stakes with team pennants
  for (const p of pts) {
    g.lineStyle(3.2, OUT, 1);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x, p.y - 14);
    g.strokePath();
    g.lineStyle(1.6, 0x6a5334, 1);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x, p.y - 14);
    g.strokePath();
    g.fillStyle(col, 1);
    g.fillTriangle(p.x, p.y - 14, p.x + 8, p.y - 11, p.x, p.y - 8);
    g.lineStyle(1.3, OUT, 1);
    g.strokeTriangle(p.x, p.y - 14, p.x + 8, p.y - 11, p.x, p.y - 8);
  }
}

// ---------------------------------------------------------------------------
// Resource nodes
// ---------------------------------------------------------------------------

const RES_TEX = {
  tree: { w: 52, h: 66, cx: 26, ft: 60 },
  berry: { w: 46, h: 40, cx: 23, ft: 34 },
  gold: { w: 48, h: 42, cx: 24, ft: 36 },
};

function buildResources(put, rng) {
  const t = RES_TEX.tree;
  for (let v = 0; v < RESOURCE_VARIANTS.tree; v++) {
    put(resourceFrame('tree', v), t.w, t.h, t.cx, t.ft, (g) => drawTree(g, t, v, rng));
  }
  const b = RES_TEX.berry;
  for (let v = 0; v < RESOURCE_VARIANTS.berry; v++) {
    put(resourceFrame('berry', v), b.w, b.h, b.cx, b.ft, (g) => drawBerry(g, b, v, rng));
  }
  const go = RES_TEX.gold;
  for (let v = 0; v < RESOURCE_VARIANTS.gold; v++) {
    put(resourceFrame('gold', v), go.w, go.h, go.cx, go.ft, (g) => drawGold(g, go, v, rng));
  }
  // Stump left behind when a tree is chopped out.
  put('r_stump_0', 30, 22, 15, 17, (g) => {
    groundShadow(g, 15, 17, 22, 9);
    g.fillStyle(0x7c5a34, 1);
    g.fillEllipse(15, 9, 18, 8);
    g.fillRect(6, 9, 18, 7);
    g.fillStyle(0x5c4023, 1);
    g.fillEllipse(15, 16, 18, 6);
    g.lineStyle(1.8, OUT, 1);
    g.strokeEllipse(15, 9, 18, 8);
    g.fillStyle(0xa07a4a, 1);
    g.fillEllipse(15, 8.6, 12, 5);
  });
}

function groundShadow(g, x, y, w, h) {
  g.fillStyle(0x000000, 0.13);
  g.fillEllipse(x, y + 1, w * 1.12, h * 1.12);
  g.fillStyle(0x000000, 0.2);
  g.fillEllipse(x, y, w, h);
}

function drawTree(g, t, v, rng) {
  const { cx, ft } = t;
  const scale = [1, 0.86, 1.08][v];
  const lean = [0, -1.6, 1.4][v];
  groundShadow(g, cx, ft - 1, 26 * scale, 10 * scale);

  // trunk
  g.fillStyle(0x6f4c2a, 1);
  g.fillRoundedRect(cx - 3.5 + lean * 0.3, ft - 22 * scale, 7, 22 * scale, 2);
  g.lineStyle(1.8, OUT, 1);
  g.strokeRoundedRect(cx - 3.5 + lean * 0.3, ft - 22 * scale, 7, 22 * scale, 2);

  // canopy — three overlapping blobs, dark outline, light from upper-left
  const cy = ft - 36 * scale;
  const blobs = [
    { x: cx - 9 * scale + lean, y: cy + 6 * scale, r: 12 * scale },
    { x: cx + 9 * scale + lean, y: cy + 5 * scale, r: 11.5 * scale },
    { x: cx + lean, y: cy - 4 * scale, r: 14 * scale },
  ];
  g.fillStyle(OUT, 1);
  for (const b of blobs) g.fillCircle(b.x, b.y, b.r + 1.8);
  g.fillStyle(0x2f6130, 1);
  for (const b of blobs) g.fillCircle(b.x, b.y, b.r);
  g.fillStyle(0x3f7a3a, 1);
  for (const b of blobs) g.fillCircle(b.x - b.r * 0.16, b.y - b.r * 0.2, b.r * 0.74);
  g.fillStyle(0x559347, 0.85);
  g.fillCircle(blobs[2].x - 4 * scale, blobs[2].y - 5 * scale, 5.5 * scale);
}

function drawBerry(g, b, v, rng) {
  const { cx, ft } = b;
  groundShadow(g, cx, ft - 1, 26, 9);
  const mounds = v === 0
    ? [{ x: cx - 7, y: ft - 8, r: 9 }, { x: cx + 7, y: ft - 8, r: 8.5 }, { x: cx, y: ft - 14, r: 10.5 }]
    : [{ x: cx - 8, y: ft - 7, r: 8 }, { x: cx + 6, y: ft - 10, r: 10 }, { x: cx, y: ft - 13, r: 9 }];
  g.fillStyle(OUT, 1);
  for (const m of mounds) g.fillCircle(m.x, m.y, m.r + 1.8);
  g.fillStyle(0x3d7a3c, 1);
  for (const m of mounds) g.fillCircle(m.x, m.y, m.r);
  g.fillStyle(0x4f9448, 1);
  for (const m of mounds) g.fillCircle(m.x - m.r * 0.2, m.y - m.r * 0.25, m.r * 0.68);
  // berries
  const spots = [[-9, -10], [-3, -16], [4, -13], [10, -9], [-1, -6], [7, -18], [-8, -3]];
  for (const [dx, dy] of spots) {
    g.fillStyle(0x8f1f26, 1);
    g.fillCircle(cx + dx, ft + dy, 2.7);
    g.fillStyle(0xe0343d, 1);
    g.fillCircle(cx + dx, ft + dy, 2.1);
    g.fillStyle(0xff8b8b, 0.9);
    g.fillCircle(cx + dx - 0.7, ft + dy - 0.8, 0.8);
  }
}

function drawGold(g, go, v, rng) {
  const { cx, ft } = go;
  groundShadow(g, cx, ft - 1, 28, 10);
  const rocks = [
    { x: cx - 9, y: ft - 7, w: 18, h: 14 },
    { x: cx + 8, y: ft - 6, w: 16, h: 12 },
    { x: cx + (v === 1 ? -2 : 1), y: ft - 15, w: 20, h: 15 },
  ];
  for (const r of rocks) {
    const pts = [
      { x: r.x - r.w / 2, y: r.y + r.h / 2 },
      { x: r.x - r.w / 2.6, y: r.y - r.h / 2 },
      { x: r.x + r.w / 3.2, y: r.y - r.h / 2.1 },
      { x: r.x + r.w / 2, y: r.y + r.h / 3 },
      { x: r.x + r.w / 5, y: r.y + r.h / 2 },
    ];
    g.fillStyle(0x8b8b93, 1);
    g.fillPoints(pts, true, true);
    g.fillStyle(0xa9a9b2, 1);
    g.fillPoints(pts.map((p) => ({ x: p.x - 1, y: p.y - 1.5 })), true, true);
    g.lineStyle(2, OUT, 1);
    g.strokePoints(pts, true, true);
  }
  // gold veins — bright and unmistakable
  const veins = [[-10, -9], [-5, -13], [6, -16], [11, -8], [2, -6], [-2, -18]];
  for (const [dx, dy] of veins) {
    g.fillStyle(0x8a6a12, 1);
    g.fillCircle(cx + dx, ft + dy, 3.1);
    g.fillStyle(0xf5c333, 1);
    g.fillCircle(cx + dx, ft + dy, 2.3);
    g.fillStyle(0xfff0a8, 1);
    g.fillCircle(cx + dx - 0.7, ft + dy - 0.8, 1);
  }
}

// ---------------------------------------------------------------------------
// Unit ground markers + selection
// ---------------------------------------------------------------------------

function buildMarkers(put) {
  // The team ellipse under each unit. This single element does more for
  // small-screen readability than anything else on the unit.
  for (let p = 0; p < PLAYER_COLORS.length; p++) {
    const col = PLAYER_COLORS[p];
    const dark = PLAYER_COLORS_DARK[p];
    put(markerFrame(p), 36, 22, 18, 11, (g) => {
      g.fillStyle(0x000000, 0.22);
      g.fillEllipse(18, 12.5, 31, 15);
      g.fillStyle(OUT, 0.9);
      g.fillEllipse(18, 11, 28, 14);
      g.fillStyle(dark, 1);
      g.fillEllipse(18, 11, 25, 12);
      g.fillStyle(col, 1);
      g.fillEllipse(18, 10.4, 20, 9);
      g.fillStyle(shade(col, 0.45), 0.65);
      g.fillEllipse(18, 8.8, 12, 4);
    });
  }

  // Selection ring: bright, high contrast against both team colours and grass.
  put('mk_sel', 44, 28, 22, 14, (g) => {
    g.lineStyle(5, 0x1a1a1a, 0.65);
    g.strokeEllipse(22, 14, 34, 17);
    g.lineStyle(3, 0xffe45c, 1);
    g.strokeEllipse(22, 14, 34, 17);
    g.lineStyle(1.4, 0xffffff, 0.95);
    g.strokeEllipse(22, 14, 29, 14);
    g.fillStyle(0xffffff, 1);
    for (const [dx, dy] of [[-17, 0], [17, 0], [0, -8.5], [0, 8.5]]) {
      g.fillCircle(22 + dx, 14 + dy, 1.9);
    }
  });
}

// ---------------------------------------------------------------------------
// FX bits
// ---------------------------------------------------------------------------

function buildFx(put) {
  put('fx_spark', 20, 20, 10, 10, (g) => {
    g.fillStyle(0xffffff, 1);
    const pts = [];
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i;
      const r = i % 2 === 0 ? 9.5 : 3.4;
      pts.push({ x: 10 + Math.cos(a) * r, y: 10 + Math.sin(a) * r });
    }
    g.fillPoints(pts, true, true);
  });

  put('fx_puff', 24, 24, 12, 12, (g) => {
    g.fillStyle(0xffffff, 0.28);
    g.fillCircle(12, 12, 11);
    g.fillStyle(0xffffff, 0.42);
    g.fillCircle(12, 12, 8);
    g.fillStyle(0xffffff, 0.75);
    g.fillCircle(12, 12, 4.5);
  });

  put('fx_chip', 8, 8, 4, 4, (g) => {
    g.fillStyle(0x000000, 0.55);
    g.fillRoundedRect(0.5, 0.5, 7, 7, 1.5);
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(1.5, 1.5, 5, 5, 1.2);
  });

  put('fx_arrow', 26, 10, 13, 5, (g) => {
    g.lineStyle(4, OUT, 1);
    g.beginPath();
    g.moveTo(3, 5);
    g.lineTo(21, 5);
    g.strokePath();
    g.lineStyle(2, 0xd8b070, 1);
    g.beginPath();
    g.moveTo(3, 5);
    g.lineTo(21, 5);
    g.strokePath();
    g.fillStyle(0xe6ebf0, 1);
    g.fillTriangle(19, 1.5, 25.5, 5, 19, 8.5);
    g.lineStyle(1.2, OUT, 1);
    g.strokeTriangle(19, 1.5, 25.5, 5, 19, 8.5);
    g.fillStyle(0xf2f2f2, 1);
    g.fillTriangle(0.5, 1, 6, 5, 0.5, 9);
  });

  // Iso ring used for command pings and "built" pulses (tinted at runtime).
  put('fx_ring', 68, 38, 34, 19, (g) => {
    g.lineStyle(6, 0x000000, 0.28);
    g.strokeEllipse(34, 19, 56, 28);
    g.lineStyle(4, 0xffffff, 1);
    g.strokeEllipse(34, 19, 56, 28);
  });

  // Chevron used inside the move ping.
  put('fx_dot', 14, 14, 7, 7, (g) => {
    g.fillStyle(0x000000, 0.35);
    g.fillCircle(7, 7.6, 5.6);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(7, 7, 5);
  });
}
