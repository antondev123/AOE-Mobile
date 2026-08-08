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
/**
 * A wall segment, keyed by the four-bit neighbour mask from core/world.js
 * (1 = north, 2 = east, 4 = south, 8 = west). Sixteen frames per wall type per
 * player: a lone post, two straight runs, four corners, four tees, one cross,
 * and the four stubs that have exactly one neighbour.
 *
 * Every case is drawn rather than derived, because a wall's whole job is to look
 * like one continuous structure. Rotating a single sprite cannot do it — in this
 * projection the two grid axes run in different screen directions and are lit
 * differently, so an east-west run and a north-south run are not the same
 * picture turned round.
 */
export function wallFrame(type, player, mask) {
  return `w_${type}_${player}_${mask & 15}`;
}
/** A gate, by the axis it stands across (0 = along +x, 1 = along +y) and state. */
export function gateFrame(type, player, axis, open) {
  return `g_${type}_${player}_${axis ? 'y' : 'x'}${open ? 'o' : 'c'}`;
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
export const RESOURCE_VARIANTS = { tree: 3, berry: 2, gold: 3, stone: 3 };

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
  // 2048, up from 1024. The walls are what pushed it over: sixteen connected
  // variants per wall type per player is sixty-four extra frames, and with the
  // Castle's 4x4 body and the gates the atlas needs about 1.4M pixels of the
  // 4.2M a 2048 sheet holds — against the 1.05M a 1024 sheet has in total.
  // Splitting into two atlases was the alternative and it is the worse one: a
  // second texture breaks the sprite batch every time the renderer alternates
  // between a wall and anything else, which on a walled base is every few
  // sprites. 16MB of texture memory buys back the single draw call.
  const SIZE = 2048;
  if (scene.textures.exists(ATLAS)) scene.textures.remove(ATLAS);
  const canvasTex = scene.textures.createCanvas(ATLAS, SIZE, SIZE);
  const ctx = canvasTex.getContext();
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const rng = makeRng(0x5eed11);

  const origins = new Map();
  const shelf = { x: 1, y: 1, h: 0 };
  const TMP = '__aoe_gfx_tmp';

  /**
   * Queue one sprite for packing. (ax, ay) is the pixel inside the sprite that
   * should sit on the entity's world position — stored as an origin fraction.
   * Nothing is drawn until every frame is known, so the packer can order them
   * tallest-first; a shelf packer fed in declaration order wastes close to half
   * the atlas on part-empty rows.
   */
  const queued = [];
  function put(name, w, h, ax, ay, drawFn) {
    queued.push({ name, w, h, ax, ay, drawFn });
  }

  buildBuildings(put);
  buildWalls(put);
  buildFoundations(put);
  buildResources(put, rng);
  buildUnits(put);
  buildTerrain(put, rng);
  buildMarkers(put);
  buildFx(put);

  // Stable sort by descending height: ties keep declaration order, so the same
  // build always produces the same atlas.
  queued.forEach((q, i) => { q._i = i; });
  queued.sort((a, b) => (b.h - a.h) || (a._i - b._i));

  for (const q of queued) {
    g.clear();
    q.drawFn(g);
    if (scene.textures.exists(TMP)) scene.textures.remove(TMP);
    g.generateTexture(TMP, q.w, q.h);
    const src = scene.textures.get(TMP).getSourceImage();
    if (shelf.x + q.w + 1 > SIZE) {
      shelf.x = 1;
      shelf.y += shelf.h + 1;
      shelf.h = 0;
    }
    ctx.drawImage(src, shelf.x, shelf.y);
    canvasTex.add(q.name, 0, shelf.x, shelf.y, q.w, q.h);
    origins.set(q.name, { w: q.w, h: q.h, ox: q.ax / q.w, oy: q.ay / q.h });
    shelf.x += q.w + 1;
    if (q.h > shelf.h) shelf.h = q.h;
    scene.textures.remove(TMP);
  }

  if (shelf.y + shelf.h > SIZE) {
    console.warn('[gfx] atlas overflow', shelf.y + shelf.h, 'of', SIZE);
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
  // Indexed off OCEAN_LEVELS rather than the ramp, so the renderer can never
  // ask for a depth frame that was not generated.
  for (let i = 0; i < OCEAN_LEVELS; i++) {
    const base = OCEAN_RAMP[Math.min(i, OCEAN_RAMP.length - 1)];
    const deep = i / (OCEAN_LEVELS - 1);
    put(oceanFrame(i), W, H, 0, 0, (g) => {
      fillTile(g, pts, base);
      // The outermost ring must be perfectly flat: it butts onto the solid
      // fill, and any detail there would draw the eye to the changeover.
      if (i === OCEAN_LEVELS - 1) return;
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
  }
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
  // The two forward drop-offs share a body — a low 2x2 timber shed — and are
  // told apart by what is stacked outside them. That is deliberate: they do the
  // same job, they are built for the same reason, and a player scanning their
  // base needs to read "drop-off" first and "which one" second. Both sit lower
  // than the Mill so a camp planted at the edge of a woodline does not compete
  // with the buildings that matter for attention.
  lumbercamp: { fw: 2, fh: 2, wallH: 24, roofH: 17, logs: true, w: 140, h: 106 },
  miningcamp: { fw: 2, fh: 2, wallH: 24, roofH: 17, ore: true, w: 140, h: 106 },
  // The two stone buildings that shoot. Both are drawn tall on purpose: a
  // defensive building whose silhouette does not clear the houses around it is a
  // defensive building the player forgets they own.
  watchtower: { fw: 1, fh: 1, tower: true, w: 80, h: 110 },
  castle: { fw: 4, fh: 4, castle: true, w: 280, h: 250 },
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
  if (s.tower) {
    drawWatchTower(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.castle) {
    drawCastle(g, s, cx, cy, col, colDark);
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

  // A stack of felled trunks against the near wall: the one prop that says
  // "wood arrives here" without any text, and the reason a Lumber Camp is
  // recognisable at a glance from the Mining Camp it otherwise duplicates.
  if (s.logs) {
    const bx = cx - iw * 0.55;
    const by = cy + ih * 0.35;
    const logRow = (ox, oy, n) => {
      for (let i = 0; i < n; i++) {
        const x = ox + i * 9;
        g.fillStyle(WOOD_D, 1);
        g.fillRoundedRect(x - 4.5, oy - 4.5, 9, 9, 3);
        g.lineStyle(1.8, OUT, 1);
        g.strokeRoundedRect(x - 4.5, oy - 4.5, 9, 9, 3);
        // End grain, so the stack reads as cut trunks and not as barrels.
        g.fillStyle(0xc59a5f, 1);
        g.fillCircle(x, oy, 2.6);
        g.lineStyle(1, shade(WOOD_D, -0.2), 1);
        g.strokeCircle(x, oy, 1.4);
      }
    };
    logRow(bx, by, 3);
    logRow(bx + 4.5, by - 8, 2);
    // A saw leaning against the pile, blade-out so its teeth catch the eye.
    g.lineStyle(3.2, OUT, 1);
    g.beginPath();
    g.moveTo(bx - 8, by + 4);
    g.lineTo(bx + 6, by - 18);
    g.strokePath();
    g.lineStyle(1.8, STEEL, 1);
    g.beginPath();
    g.moveTo(bx - 8, by + 4);
    g.lineTo(bx + 6, by - 18);
    g.strokePath();
  }

  // ...and for the Mining Camp, a heap of ore with a pick stood in it. Grey
  // rock with both a gold and a pale-stone nugget on top, because this one
  // building banks both of the things you dig out of the ground.
  if (s.ore) {
    const bx = cx - iw * 0.55;
    const by = cy + ih * 0.35;
    const heap = [
      { x: bx - 7, y: by - 1 },
      { x: bx + 6, y: by },
      { x: bx, y: by - 8 },
    ];
    g.fillStyle(OUT, 1);
    for (const h of heap) g.fillCircle(h.x, h.y, 7.4);
    g.fillStyle(0x6a747f, 1);
    for (const h of heap) g.fillCircle(h.x, h.y, 6);
    g.fillStyle(0x8d99a6, 1);
    for (const h of heap) g.fillCircle(h.x - 1.4, h.y - 1.8, 4);
    g.fillStyle(0xf5c333, 1);
    g.fillCircle(bx + 2, by - 11, 2.6);
    g.fillStyle(0xd8e2ec, 1);
    g.fillCircle(bx - 5, by - 9, 2.4);
    // The pick: haft, then a steel head across the top.
    g.lineStyle(3.2, OUT, 1);
    g.beginPath();
    g.moveTo(bx + 9, by + 3);
    g.lineTo(bx + 3, by - 19);
    g.strokePath();
    g.lineStyle(1.8, WOOD, 1);
    g.beginPath();
    g.moveTo(bx + 9, by + 3);
    g.lineTo(bx + 3, by - 19);
    g.strokePath();
    g.lineStyle(3.4, OUT, 1);
    g.beginPath();
    g.moveTo(bx - 4, by - 22);
    g.lineTo(bx + 10, by - 17);
    g.strokePath();
    g.lineStyle(2, STEEL_D, 1);
    g.beginPath();
    g.moveTo(bx - 4, by - 22);
    g.lineTo(bx + 10, by - 17);
    g.strokePath();
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

// ---------------------------------------------------------------------------
// Walls, gates, and the two stone buildings that shoot
// ---------------------------------------------------------------------------
//
// WHY SIXTEEN FRAMES. A wall only reads as a wall if its segments join. Drawing
// each one as an independent block gives a dotted line of huts, which is the
// single most obvious way this feature could fail, so the connection is baked
// into the art: a segment's frame is chosen by which of its four axis
// neighbours are also walls (core/world.js owns the mask), and each of the
// sixteen cases is drawn — post alone, four stubs, two straight runs, four
// corners, four tees, one cross.
//
// The pieces are assembled from one primitive: an isometric prism running from
// the tile centre out to the middle of one tile edge. A segment is a stack of
// those, one per connected direction, plus a post at the junction. Because every
// limb ends exactly on the shared edge between two tiles, the limb of one
// segment meets the limb of its neighbour with no gap and no overlap — at any
// zoom, on any of the sixteen cases, without a single hand-placed pixel.

/**
 * Half-edge vectors: tile centre to the middle of each of the four tile edges,
 * in screen pixels. Index order matches the wall mask in core/world.js
 * (0 = north/-y, 1 = east/+x, 2 = south/+y, 3 = west/-x); the two must not
 * drift apart or a wall will grow limbs in the wrong directions.
 */
const WALL_DIR = [
  { x: HALF_W / 2, y: -HALF_H / 2 },
  { x: HALF_W / 2, y: HALF_H / 2 },
  { x: -HALF_W / 2, y: HALF_H / 2 },
  { x: -HALF_W / 2, y: -HALF_H / 2 },
];

// Wall texture boxes. `ay` is the pixel the tile centre sits on; it has to leave
// room above for the tallest thing drawn (a gate tower and its finial), or the
// health bar the renderer hangs off the sprite's top edge floats in the sky.
const WALL_TEX = { w: 80, h: 76, ay: 54 };
const GATE_TEX = { w: 80, h: 92, ay: 70 };

const PAL_WOOD = { left: 0x7c5326, right: 0x9a6b38, top: 0xb2854c };
const PAL_STONE = { left: 0x7c766a, right: 0x9c9689, top: 0xbcb6a6 };

/**
 * An isometric prism: a parallelogram base swept up by `H`.
 *
 * The four side faces are painted back-to-front by the screen y of their base
 * edge, then the top. That is a painter's sort over a convex box, which is
 * exact — no face can partly occlude another — and it costs a four-element sort
 * that runs once at bake time and never again.
 */
function prism(g, cx, cy, vx, vy, px, py, H, pal, outline = 1.6) {
  const base = [
    { x: cx + px, y: cy + py },
    { x: cx + vx + px, y: cy + vy + py },
    { x: cx + vx - px, y: cy + vy - py },
    { x: cx - px, y: cy - py },
  ];
  const top = base.map((b) => ({ x: b.x, y: b.y - H }));
  const faces = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    faces.push({
      my: (base[i].y + base[j].y) / 2,
      mx: (base[i].x + base[j].x) / 2,
      quad: [base[i], base[j], top[j], top[i]],
    });
  }
  faces.sort((a, b) => a.my - b.my);
  for (const f of faces) {
    g.fillStyle(f.mx >= cx + vx / 2 ? pal.right : pal.left, 1);
    g.fillPoints(f.quad, true, true);
    g.lineStyle(outline, OUT, 1);
    g.strokePoints(f.quad, true, true);
  }
  g.fillStyle(pal.top, 1);
  g.fillPoints(top, true, true);
  g.lineStyle(outline + 0.2, OUT, 1);
  g.strokePoints(top, true, true);
  return { base, top };
}

/** A prism centred on a point, given its two in-plane half-extents. */
function box(g, x, y, a, b, H, pal, outline) {
  return prism(g, x - a.x, y - a.y, a.x * 2, a.y * 2, b.x, b.y, H, pal, outline);
}

/** The base edge of a limb that faces the camera, for surface detail. */
function nearEdge(cx, cy, vx, vy, px, py) {
  const s = py >= 0 ? 1 : -1;
  return [
    { x: cx + px * s, y: cy + py * s },
    { x: cx + vx + px * s, y: cy + vy + py * s },
  ];
}

const WALL_SPEC = {
  palisade: {
    pal: PAL_WOOD, height: 22, postH: 28, thick: 0.30, post: 0.48,
    // Sharpened stakes: the palisade's silhouette is what tells it apart from a
    // stone wall at the zoom a phone actually plays at, long before the colour
    // does.
    stakes: true,
  },
  stonewall: {
    pal: PAL_STONE, height: 27, postH: 33, thick: 0.42, post: 0.60,
    courses: true,
  },
};

function drawWallSegment(g, cx, cy, mask, spec, col, colDark) {
  const t = spec.thick;
  // Limbs first, post second: the post then sits proud of the joins, which is
  // what makes a corner read as a corner and not as two planks crossing.
  for (let d = 0; d < 4; d++) {
    if (!(mask & (1 << d))) continue;
    const v = WALL_DIR[d];
    const per = WALL_DIR[(d + 1) % 4];
    const px = per.x * t;
    const py = per.y * t;
    prism(g, cx, cy, v.x, v.y, px, py, spec.height, spec.pal);
    const [e0, e1] = nearEdge(cx, cy, v.x, v.y, px, py);
    if (spec.courses) {
      // Two mortar courses along the face.
      g.lineStyle(1.1, shade(spec.pal.left, -0.3), 0.55);
      for (const f of [0.34, 0.68]) {
        g.beginPath();
        g.moveTo(e0.x, e0.y - spec.height * f);
        g.lineTo(e1.x, e1.y - spec.height * f);
        g.strokePath();
      }
    } else {
      // Log seams.
      g.lineStyle(1.1, shade(spec.pal.left, -0.32), 0.7);
      for (let k = 1; k <= 3; k++) {
        const u = k / 4;
        const x = e0.x + (e1.x - e0.x) * u;
        const y = e0.y + (e1.y - e0.y) * u;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x, y - spec.height);
        g.strokePath();
      }
    }
  }

  // The post, with a band of team colour under its cap. The band is the same
  // idea as the Town Center's eave fascia and it exists for the same reason: a
  // wall has no roof to colour, and a contested border where you cannot tell
  // whose wall is whose is unreadable. It is a band rather than a flag on every
  // segment because a flag on every segment is a picket fence — a thirty-tile
  // run drew thirty pennants and the eye could not find the ends.
  const a = { x: WALL_DIR[1].x * spec.post, y: WALL_DIR[1].y * spec.post };
  const b = { x: WALL_DIR[2].x * spec.post * 0.5, y: WALL_DIR[2].y * spec.post * 0.5 };
  const bandH = 5;
  box(g, cx, cy, a, b, spec.postH - bandH, spec.pal);
  box(g, cx, cy - (spec.postH - bandH), a, b, bandH,
    { left: colDark, right: col, top: shade(col, 0.28) });

  const topY = cy - spec.postH;
  if (spec.stakes) {
    // Three points along the post cap.
    g.fillStyle(shade(spec.pal.top, 0.18), 1);
    for (const dx of [-6, 0, 6]) {
      g.fillTriangle(cx + dx - 3, topY + 1, cx + dx + 3, topY + 1, cx + dx, topY - 6);
      g.lineStyle(1.3, OUT, 1);
      g.strokeTriangle(cx + dx - 3, topY + 1, cx + dx + 3, topY + 1, cx + dx, topY - 6);
    }
  } else {
    // Crenellations.
    g.fillStyle(shade(spec.pal.top, 0.1), 1);
    for (const dx of [-7, 0, 7]) {
      g.fillRect(cx + dx - 2.6, topY - 5, 5.2, 6);
      g.lineStyle(1.3, OUT, 1);
      g.strokeRect(cx + dx - 2.6, topY - 5, 5.2, 6);
    }
  }

  // A pennant marks the places worth marking: the ends of a run, a lone post,
  // and the tees and crosses where two walls meet. Exactly two neighbours means
  // "middle of a run or a plain corner", which is most of a wall and gets none.
  const neighbours = ((mask >> 0) & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
  if (neighbours !== 2) {
    g.lineStyle(2.2, OUT, 1);
    g.beginPath();
    g.moveTo(cx + 9, topY - 4);
    g.lineTo(cx + 9, topY - 16);
    g.strokePath();
    g.fillStyle(col, 1);
    g.fillTriangle(cx + 9, topY - 16, cx + 18, topY - 13, cx + 9, topY - 9);
    g.lineStyle(1.2, OUT, 1);
    g.strokeTriangle(cx + 9, topY - 16, cx + 18, topY - 13, cx + 9, topY - 9);
  }
}

/**
 * A gate: two towers straddling the wall line with a doorway between them.
 *
 * `axis` is the direction the *wall* runs (0 = along +x, 1 = along +y), so the
 * towers stand at the two tile edges the wall continues through and the opening
 * faces the other way — which is the way a unit crosses. Open swings the leaves
 * back against the towers; shut brings them together across the gap. That
 * boolean is the same one the block grid reads, so what the player sees is
 * literally whether the tile is passable.
 */
function drawGate(g, cx, cy, axis, open, spec, col, colDark) {
  const along = axis === 0 ? [1, 3] : [0, 2];
  const across = axis === 0 ? [0, 2] : [1, 3];
  const towerH = spec.postH + 12;
  const A = WALL_DIR[along[0]];
  const B = WALL_DIR[across[0]];
  const half = { x: A.x * 0.34, y: A.y * 0.34 };
  const wide = { x: B.x * 0.5, y: B.y * 0.5 };

  // The doorway, drawn first so the towers overlap its ends.
  //
  // Open and shut have to be told apart at a glance from across a base, so the
  // difference is a whole shape and not a tint: shut is a slab of oak filling
  // the arch to above wall height, open is an empty threshold with the two
  // leaves folded flat against the towers and a shadow on the ground where the
  // slab was. A player glancing at their wall must be able to see which of
  // their gates is standing open.
  const gap = spec.height + 8;
  const p0 = { x: cx + WALL_DIR[along[0]].x * 0.66, y: cy + WALL_DIR[along[0]].y * 0.66 };
  const p1 = { x: cx + WALL_DIR[along[1]].x * 0.66, y: cy + WALL_DIR[along[1]].y * 0.66 };
  const across0 = { x: WALL_DIR[across[0]].x * 0.16, y: WALL_DIR[across[0]].y * 0.16 };

  if (open) {
    // The threshold: a dark strip of packed earth between the towers, so the
    // gap reads as ground you can walk on rather than as a missing sprite.
    g.fillStyle(0x2a2118, 0.55);
    g.fillPoints([
      { x: p0.x + across0.x, y: p0.y + across0.y },
      { x: p1.x + across0.x, y: p1.y + across0.y },
      { x: p1.x - across0.x, y: p1.y - across0.y },
      { x: p0.x - across0.x, y: p0.y - across0.y },
    ], true, true);
    // Leaves folded back against the towers.
    for (const p of [p0, p1]) {
      const q = { x: cx + (p.x - cx) * 0.55, y: cy + (p.y - cy) * 0.55 };
      const leaf = [
        { x: p.x, y: p.y }, { x: q.x, y: q.y },
        { x: q.x, y: q.y - gap * 0.8 }, { x: p.x, y: p.y - gap * 0.8 },
      ];
      g.fillStyle(WOOD_D, 1);
      g.fillPoints(leaf, true, true);
      g.lineStyle(1.6, OUT, 1);
      g.strokePoints(leaf, true, true);
    }
  } else {
    // A slab with thickness: the front face, a lit top edge, and iron banding.
    const door = [
      { x: p0.x, y: p0.y }, { x: p1.x, y: p1.y },
      { x: p1.x, y: p1.y - gap }, { x: p0.x, y: p0.y - gap },
    ];
    g.fillStyle(WOOD, 1);
    g.fillPoints(door, true, true);
    g.fillStyle(shade(WOOD, 0.22), 1);
    g.fillPoints([
      { x: p0.x, y: p0.y - gap }, { x: p1.x, y: p1.y - gap },
      { x: p1.x, y: p1.y - gap + 4 }, { x: p0.x, y: p0.y - gap + 4 },
    ], true, true);
    g.lineStyle(2.2, OUT, 1);
    g.strokePoints(door, true, true);
    // Plank seams down the leaf, then two iron straps across it.
    g.lineStyle(1.1, WOOD_D, 0.85);
    for (const f of [0.25, 0.5, 0.75]) {
      const x = p0.x + (p1.x - p0.x) * f;
      const y = p0.y + (p1.y - p0.y) * f;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y - gap);
      g.strokePath();
    }
    g.lineStyle(2.4, STEEL_D, 0.95);
    for (const f of [0.28, 0.68]) {
      g.beginPath();
      g.moveTo(p0.x, p0.y - gap * f);
      g.lineTo(p1.x, p1.y - gap * f);
      g.strokePath();
    }
    g.fillStyle(0xdcc36a, 1);
    g.fillCircle((p0.x + p1.x) / 2, (p0.y + p1.y) / 2 - gap * 0.48, 2.4);
    g.lineStyle(1, OUT, 1);
    g.strokeCircle((p0.x + p1.x) / 2, (p0.y + p1.y) / 2 - gap * 0.48, 2.4);
  }

  // Towers, far one first.
  const posts = [
    { x: cx + WALL_DIR[along[0]].x, y: cy + WALL_DIR[along[0]].y },
    { x: cx + WALL_DIR[along[1]].x, y: cy + WALL_DIR[along[1]].y },
  ].sort((a, b) => a.y - b.y);
  for (const p of posts) {
    box(g, p.x, p.y, half, wide, towerH, spec.pal);
    const ty = p.y - towerH;
    g.fillStyle(shade(spec.pal.top, 0.1), 1);
    g.fillRect(p.x - 8, ty - 5, 16, 6);
    g.lineStyle(1.4, OUT, 1);
    g.strokeRect(p.x - 8, ty - 5, 16, 6);
  }
  // Banner on the nearer tower.
  const near = posts[posts.length - 1];
  banner(g, near.x + 6, near.y - towerH + 4, col, colDark, 18);
}

function buildWalls(put) {
  for (let p = 0; p < PLAYER_COLORS.length; p++) {
    const col = PLAYER_COLORS[p];
    const dark = PLAYER_COLORS_DARK[p];
    for (const type of Object.keys(WALL_SPEC)) {
      const spec = WALL_SPEC[type];
      for (let mask = 0; mask < 16; mask++) {
        put(wallFrame(type, p, mask), WALL_TEX.w, WALL_TEX.h, WALL_TEX.w / 2, WALL_TEX.ay,
          (g) => drawWallSegment(g, WALL_TEX.w / 2, WALL_TEX.ay, mask, spec, col, dark));
      }
    }
    // Each gate borrows the wall family it belongs to, so a stone gate in a
    // stone wall is the same masonry with a door in it.
    for (const [gateType, wallType] of [['palisadegate', 'palisade'], ['stonegate', 'stonewall']]) {
      const spec = WALL_SPEC[wallType];
      for (let axis = 0; axis < 2; axis++) {
        for (const open of [false, true]) {
          put(gateFrame(gateType, p, axis, open), GATE_TEX.w, GATE_TEX.h,
            GATE_TEX.w / 2, GATE_TEX.ay,
            (g) => drawGate(g, GATE_TEX.w / 2, GATE_TEX.ay, axis, open, spec, col, dark));
        }
      }
    }
  }
}

/**
 * The Watch Tower: one tile of footprint and a great deal of height.
 *
 * Everything about it is vertical, because that is the only axis a 1x1 building
 * has to work with. A battered stone base, a shaft with arrow slits, a
 * corbelled parapet that overhangs it, and a shingled cap — read from bottom to
 * top, that outline is unlike anything else on the map even when only the top
 * third of it is showing over a treeline.
 */
function drawWatchTower(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, false);

  const baseA = { x: WALL_DIR[1].x * 0.82, y: WALL_DIR[1].y * 0.82 };
  const baseB = { x: WALL_DIR[2].x * 0.82, y: WALL_DIR[2].y * 0.82 };
  const shaftH = 46;
  box(g, cx, cy, baseA, baseB, 10, PAL_STONE, 2);
  const midA = { x: baseA.x * 0.82, y: baseA.y * 0.82 };
  const midB = { x: baseB.x * 0.82, y: baseB.y * 0.82 };
  box(g, cx, cy - 10, midA, midB, shaftH, PAL_STONE, 2);

  const topY = cy - 10 - shaftH;
  // Arrow slits.
  g.fillStyle(OUT, 0.9);
  g.fillRect(cx - 8, topY + 12, 3, 10);
  g.fillRect(cx + 5, topY + 12, 3, 10);

  // Overhanging parapet, wider than the shaft.
  const capA = { x: baseA.x * 1.06, y: baseA.y * 1.06 };
  const capB = { x: baseB.x * 1.06, y: baseB.y * 1.06 };
  box(g, cx, topY, capA, capB, 12, PAL_STONE, 2);
  const parY = topY - 12;
  g.fillStyle(shade(PAL_STONE.top, 0.1), 1);
  for (const dx of [-13, -4, 5, 14]) {
    g.fillRect(cx + dx - 3, parY - 6, 6, 7);
    g.lineStyle(1.4, OUT, 1);
    g.strokeRect(cx + dx - 3, parY - 6, 6, 7);
  }
  // Shingled cap and a lookout's pennant.
  isoRoof(g, cx, parY - 5, 17, 9, 16, col, colDark);
  banner(g, cx + 13, cy + 2, col, colDark, 22);
}

/**
 * The Castle: 4x4, and it has to look like 250 stone.
 *
 * Four corner towers, a curtain wall between them and a keep standing above the
 * lot. The corner towers are what carry it — they give the silhouette four
 * vertical spikes that nothing else in the game has, so a Castle is recognisable
 * from the minimap-sized end of the zoom range and through a gap in a forest.
 */
function drawCastle(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, true);

  const iw = hw * 0.86;
  const ih = hh * 0.86;
  const wallH = 44;
  isoBox(g, cx, cy, iw, ih, wallH, STONE, STONE_D, shade(STONE, 0.18));
  // Courses across the curtain, so 44 pixels of flat grey reads as masonry.
  g.lineStyle(1.2, STONE_D, 0.5);
  for (let k = 1; k <= 4; k++) {
    const y = cy - (wallH * k) / 5;
    g.beginPath();
    g.moveTo(cx - iw, y);
    g.lineTo(cx, y + ih);
    g.lineTo(cx + iw, y);
    g.strokePath();
  }
  const topY = cy - wallH;
  crenellations(g, cx, topY, iw, ih, col, colDark);

  // Gatehouse on the south face.
  const doorTop = cy + ih - wallH + 10;
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(cx - 12, doorTop, 24, wallH - 14, 3);
  g.lineStyle(2.4, OUT, 1);
  g.strokeRoundedRect(cx - 12, doorTop, 24, wallH - 14, 3);
  g.lineStyle(1.8, STEEL_D, 0.85);
  for (let k = 1; k <= 3; k++) {
    g.beginPath();
    g.moveTo(cx - 12, doorTop + (wallH - 14) * (k / 4));
    g.lineTo(cx + 12, doorTop + (wallH - 14) * (k / 4));
    g.strokePath();
  }

  // Four corner towers, painted back to front.
  const towerH = 74;
  const corners = [
    { x: cx, y: cy - hh * 0.92 },
    { x: cx - hw * 0.92, y: cy },
    { x: cx + hw * 0.92, y: cy },
    { x: cx, y: cy + hh * 0.92 },
  ].sort((a, b) => a.y - b.y);
  const tA = { x: WALL_DIR[1].x * 0.9, y: WALL_DIR[1].y * 0.9 };
  const tB = { x: WALL_DIR[2].x * 0.9, y: WALL_DIR[2].y * 0.9 };
  for (const c of corners) {
    box(g, c.x, c.y, tA, tB, towerH, PAL_STONE, 2.2);
    const ty = c.y - towerH;
    g.fillStyle(OUT, 0.85);
    g.fillRect(c.x - 2, ty + 16, 3.4, 11);
    for (const dx of [-11, -2, 7]) {
      g.fillStyle(shade(PAL_STONE.top, 0.12), 1);
      g.fillRect(c.x + dx, ty - 6, 6, 7);
      g.lineStyle(1.4, OUT, 1);
      g.strokeRect(c.x + dx, ty - 6, 6, 7);
    }
    isoRoof(g, c.x, ty - 6, 15, 8, 15, col, colDark);
  }

  // The keep, standing above the curtain, with the standard on top of it.
  const kw = iw * 0.4;
  const kh = ih * 0.4;
  const keepH = 40;
  isoBox(g, cx, topY - 2, kw, kh, keepH, STONE, STONE_D, shade(STONE, 0.2));
  const kTop = topY - 2 - keepH;
  g.fillStyle(OUT, 0.85);
  g.fillRect(cx - 10, kTop + 12, 3.4, 12);
  g.fillRect(cx + 7, kTop + 12, 3.4, 12);
  isoRoof(g, cx, kTop, kw * 1.3, kh * 1.3, 24, TILE_ROOF, TILE_ROOF_D, col, colDark, 6);
  mast(g, cx, kTop - kh * 1.3 - 18, col, colDark, 44);

  banner(g, cx - hw * 0.5, cy + hh * 0.42, col, colDark, 30);
  banner(g, cx + hw * 0.5, cy + hh * 0.42, col, colDark, 30);
}

// --- foundations ------------------------------------------------------------

function buildFoundations(put) {
  for (let p = 0; p < PLAYER_COLORS.length; p++) {
    // 1 for a wall segment, 4 for the Castle. Before these existed the renderer
    // clamped every footprint into the 2-wide frame, which drew a wall under
    // construction as a site four times its own size and a Castle site as
    // something smaller than a Barracks.
    for (const fw of [1, 2, 3, 4]) {
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
  // Taller and wider than the gold vein on purpose. At 0.7 zoom on a 390px
  // phone the two are four pixels apart in silhouette, so the difference has to
  // be carried by more than colour: a stone mine is a stack of blocky boulders
  // that stands proud of the ground, gold is a low scatter of rubble.
  stone: { w: 50, h: 46, cx: 25, ft: 40 },
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
  const st = RES_TEX.stone;
  for (let v = 0; v < RESOURCE_VARIANTS.stone; v++) {
    put(resourceFrame('stone', v), st.w, st.h, st.cx, st.ft, (g) => drawStone(g, st, v, rng));
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

/**
 * A stone mine: a cluster of squared-off grey boulders with a chiselled face.
 *
 * The whole job of this drawing is to not be the gold vein. Gold reads warm —
 * grey rubble carrying bright yellow spots of ore, lit like a scatter of
 * pebbles. Stone reads cool and heavy: bluish slate, no warm hue anywhere in
 * the palette, boulders drawn as isometric *blocks* with a flat top face rather
 * than as lumps, and one exposed quarry face of pale rock instead of glinting
 * specks. At a glance across a minimap-sized sprite the cue is the silhouette
 * (stacked cubes against a low mound) before it is ever the colour.
 */
function drawStone(g, st, v, rng) {
  const { cx, ft } = st;
  groundShadow(g, cx, ft - 1, 30, 11);

  // Cool slate, deliberately with no warm component: side by side with the gold
  // vein's rocks (0x8b8b93, which carries a faint violet) this reads bluer and
  // darker, and never picks up the yellow.
  const FACE_L = 0x707d8a;
  const FACE_R = 0x5b6774;
  const TOP = 0x94a2af;
  const CHIP = 0xc3cedb;

  // Three blocks: two squat ones on the ground and one perched across them, so
  // the cluster has a stepped profile rather than a single blob.
  const blocks = [
    { x: cx - 10, y: ft - 5, hw: 10, hh: 5, h: 11 },
    { x: cx + 9, y: ft - 4, hw: 9, hh: 4.5, h: 9 },
    { x: cx + (v === 1 ? -3 : 2), y: ft - 13, hw: 9, hh: 4.5, h: 12 },
  ];
  // v === 2 shoulders the top block over to the other side, so a cluster of
  // three mines beside each other does not look like one sprite stamped thrice.
  if (v === 2) blocks[2].x = cx - 6;

  for (const b of blocks) {
    const topY = b.y - b.h;
    const top = [
      { x: b.x, y: topY - b.hh },
      { x: b.x + b.hw, y: topY },
      { x: b.x, y: topY + b.hh },
      { x: b.x - b.hw, y: topY },
    ];
    // Left and right walls, drawn as quads hanging off the top diamond.
    g.fillStyle(FACE_L, 1);
    g.fillPoints([
      { x: b.x - b.hw, y: topY },
      { x: b.x, y: topY + b.hh },
      { x: b.x, y: topY + b.hh + b.h },
      { x: b.x - b.hw, y: topY + b.h },
    ], true, true);
    g.fillStyle(FACE_R, 1);
    g.fillPoints([
      { x: b.x + b.hw, y: topY },
      { x: b.x, y: topY + b.hh },
      { x: b.x, y: topY + b.hh + b.h },
      { x: b.x + b.hw, y: topY + b.h },
    ], true, true);
    g.fillStyle(TOP, 1);
    g.fillPoints(top, true, true);
    g.lineStyle(2, OUT, 1);
    g.strokePoints(top, true, true);
    g.beginPath();
    g.moveTo(b.x - b.hw, topY);
    g.lineTo(b.x - b.hw, topY + b.h);
    g.lineTo(b.x, topY + b.hh + b.h);
    g.lineTo(b.x + b.hw, topY + b.h);
    g.lineTo(b.x + b.hw, topY);
    g.strokePath();
  }

  // The quarried face: a few pale chips knocked off the rock, cool white rather
  // than the gold vein's yellow, so the two never read as the same material.
  const chips = [[-12, -12], [-7, -7], [8, -9], [12, -6], [0, -20], [-4, -16]];
  for (const [dx, dy] of chips) {
    g.fillStyle(CHIP, 0.9);
    g.fillTriangle(
      cx + dx, ft + dy,
      cx + dx + 3.4, ft + dy + 1.2,
      cx + dx + 0.8, ft + dy + 3.4,
    );
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
