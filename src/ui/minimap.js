// The 160x160 minimap.
//
// Because the iso projection is linear, minimap space is just a scaled copy of
// world-pixel space — so the camera's rectangle stays an axis-aligned rectangle
// here and both directions of the mapping are trivial.
//
// Terrain never changes, so it is baked once into an offscreen canvas and
// blitted; only entities and the viewport rectangle are drawn per redraw
// (~10Hz, driven by hud.js).

import { MAP_W, MAP_H, HALF_W, HALF_H, TERRAIN } from '../core/constants.js';

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

// --- Under-attack pings ------------------------------------------------------
// A ping has to be findable on a 160px map in under a second, on grass, dirt,
// sand or water, and it must not be mistakable for the static red pip of an
// enemy unit. So it does three things a unit pip cannot: it blinks between
// white-hot and red, it throws an expanding ring, and it carries a black
// outline that keeps it legible on pale sand.
const PING_LIFE = 5.0;      // seconds before a ping is gone
const PING_PERIOD = 0.7;    // seconds per pulse
const PING_CORE_R = 4.2;    // px, at size 160 (the map is drawn ~0.73 scale)
const PING_RING_R = 16;     // px the ring expands to
const PING_MAX = 6;         // bounded: a raid on five fronts is still cheap
const PING_HOT = '#ffffff';
const PING_RED = '#ff2f18';

function now() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

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

  // Live "something of yours is being hit here" markers. Wall-clock timed, not
  // sim-timed: this is a UI effect, and it must decay at the same rate whether
  // the player is watching a live match or a fast-forwarded one.
  const pings = [];

  /** Flash a decaying red marker at a grid position. Cheap and bounded. */
  function ping(gx, gy) {
    if (!(gx >= 0) || !(gy >= 0)) return null;
    const p = { gx, gy, at: now() };
    pings.push(p);
    while (pings.length > PING_MAX) pings.shift();
    return p;
  }

  function drawPings() {
    if (!pings.length) return;
    const t = now();
    for (let i = pings.length - 1; i >= 0; i--) {
      if (t - pings[i].at > PING_LIFE) pings.splice(i, 1);
    }
    if (!pings.length) return;

    ctx.save();
    for (const p of pings) {
      const age = t - p.at;
      const fade = 1 - age / PING_LIFE;          // whole marker dies away
      const phase = (age % PING_PERIOD) / PING_PERIOD;
      const c = gridToMini(p.gx, p.gy, size);
      // The two colours swap every half pulse. Whichever way round they are,
      // white and alarm-red are both on screen at once, so the marker separates
      // itself from the enemy's red pips *and* from pale sand in every frame.
      const hot = phase < 0.5;

      // Expanding shockwave.
      const r = PING_CORE_R + phase * (PING_RING_R - PING_CORE_R);
      ctx.globalAlpha = fade * (1 - phase) * 0.95;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = hot ? PING_RED : PING_HOT;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Blinking core, outlined so it survives pale sand and dark water alike.
      ctx.globalAlpha = fade;
      ctx.beginPath();
      ctx.arc(c.x, c.y, PING_CORE_R, 0, Math.PI * 2);
      ctx.fillStyle = hot ? PING_HOT : PING_RED;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

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

    // Last, so nothing — not even the viewport rectangle — can hide an alarm.
    drawPings();
  }

  return { draw, size, ping, pings };
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
