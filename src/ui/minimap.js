// The 160x160 minimap.
//
// Because the iso projection is linear, minimap space is just a scaled copy of
// world-pixel space — so the camera's rectangle stays an axis-aligned rectangle
// here and both directions of the mapping are trivial.
//
// Terrain never changes, so it is baked once into an offscreen canvas and
// blitted; only entities and the viewport rectangle are drawn per redraw
// (~10Hz, driven by hud.js).

import {
  MAP_W, MAP_H, HALF_W, HALF_H, TERRAIN, PLAYER, ENEMY,
} from '../core/constants.js';

const SPAN = MAP_W + MAP_H;

const TERRAIN_COLOR = {
  [TERRAIN.GRASS]: '#3d6430',
  [TERRAIN.DIRT]:  '#6a5232',
  [TERRAIN.WATER]: '#25456f',
  [TERRAIN.SAND]:  '#9c8a5b',
};

const RES_COLOR = { tree: '#2e5a24', berry: '#a8324a', gold: '#d8b33c' };
const TEAM = ['#5aa2ff', '#ff5a5a'];
const TEAM_DARK = ['#1c56ab', '#a01f1f'];

/** Grid -> minimap pixels (0..size). */
export function gridToMini(gx, gy, size) {
  return {
    x: ((gx - gy + MAP_H) / SPAN) * size,
    y: ((gx + gy) / SPAN) * size,
  };
}

/** World pixels -> minimap pixels. */
function worldToMini(wx, wy, size) {
  return {
    x: ((wx + MAP_H * HALF_W) / (SPAN * HALF_W)) * size,
    y: (wy / (SPAN * HALF_H)) * size,
  };
}

/** Minimap pixels -> grid coordinates. */
export function miniToGrid(px, py, size) {
  const a = (px / size) * SPAN - MAP_H; // gx - gy
  const b = (py / size) * SPAN;         // gx + gy
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

export function createMinimap(canvas, world) {
  const size = canvas.width || 160;
  const ctx = canvas.getContext('2d');

  // --- Bake terrain -------------------------------------------------------
  const bg = document.createElement('canvas');
  bg.width = size;
  bg.height = size;
  bake(bg.getContext('2d'), world, size);

  function draw(camera) {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bg, 0, 0);

    // Resource nodes: small, dim, but enough to read the map's shape.
    for (const r of world.resources) {
      if (r.dead) continue;
      const p = gridToMini(r.x, r.y, size);
      ctx.fillStyle = RES_COLOR[r.type] || '#888';
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    }

    // Buildings first so units sit on top of them.
    for (const b of world.buildings) {
      if (b.dead) continue;
      const p = gridToMini(b.x, b.y, size);
      const s = Math.max(3, Math.round((b.fw / SPAN) * size * 2));
      ctx.fillStyle = b.complete ? TEAM[b.player] : TEAM_DARK[b.player];
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(p.x - s / 2 + 0.5, p.y - s / 2 + 0.5, s - 1, s - 1);
    }

    for (const u of world.units) {
      if (u.dead) continue;
      const p = gridToMini(u.x, u.y, size);
      ctx.fillStyle = TEAM[u.player];
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }

    // Selected things get a bright pip so you can find your army at a glance.
    if (world.selection.size) {
      ctx.fillStyle = '#ffffff';
      for (const id of world.selection) {
        const e = world.entities.get(id);
        if (!e || e.dead) continue;
        const p = gridToMini(e.x, e.y, size);
        ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
      }
    }

    // Camera viewport.
    if (camera && camera.worldView) {
      const v = camera.worldView;
      const a = worldToMini(v.x, v.y, size);
      const b = worldToMini(v.x + v.width, v.y + v.height, size);
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        Math.round(a.x) + 0.5,
        Math.round(a.y) + 0.5,
        Math.max(4, Math.round(b.x - a.x)),
        Math.max(4, Math.round(b.y - a.y)),
      );
    }
  }

  return { draw, size };
}

function bake(g, world, size) {
  g.clearRect(0, 0, size, size);

  // The playable area is a diamond; fill it with grass, then paint the tiles
  // that differ. That is a few hundred fills instead of MAP_W*MAP_H.
  const corners = [
    gridToMini(0, 0, size),
    gridToMini(MAP_W, 0, size),
    gridToMini(MAP_W, MAP_H, size),
    gridToMini(0, MAP_H, size),
  ];
  g.beginPath();
  g.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) g.lineTo(corners[i].x, corners[i].y);
  g.closePath();
  g.fillStyle = TERRAIN_COLOR[TERRAIN.GRASS];
  g.fill();

  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const t = world.terrain[ty * MAP_W + tx];
      if (t === TERRAIN.GRASS) continue;
      g.fillStyle = TERRAIN_COLOR[t] || '#444';
      tileDiamond(g, tx, ty, size);
      g.fill();
    }
  }

  // Map border.
  g.beginPath();
  g.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) g.lineTo(corners[i].x, corners[i].y);
  g.closePath();
  g.strokeStyle = 'rgba(217,171,79,0.55)';
  g.lineWidth = 1;
  g.stroke();
}

function tileDiamond(g, tx, ty, size) {
  // Grown by a hair so neighbouring tiles do not leave hairline seams.
  const c = gridToMini(tx + 0.5, ty + 0.5, size);
  const hw = (1 / SPAN) * size + 0.35;
  const hh = (1 / SPAN) * size + 0.35;
  g.beginPath();
  g.moveTo(c.x, c.y - hh);
  g.lineTo(c.x + hw, c.y);
  g.lineTo(c.x, c.y + hh);
  g.lineTo(c.x - hw, c.y);
  g.closePath();
}

export { PLAYER, ENEMY };
