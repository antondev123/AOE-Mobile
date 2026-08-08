// The 160x160 minimap.
//
// Because the iso projection is linear, minimap space is just a scaled copy of
// world-pixel space — so the camera's rectangle stays an axis-aligned rectangle
// here and both directions of the mapping are trivial.
//
// Terrain never changes, so it is baked once into an offscreen canvas and
// blitted; only entities and the viewport rectangle are drawn per redraw
// (~10Hz, driven by hud.js).
//
// Fog of war is drawn the same way as in the main view (see makeFog in
// render.js): a canvas at one pixel per tile in *grid* space, blitted through
// the grid->minimap transform, which is linear, so one setTransform and one
// drawImage put it exactly over the diamonds with a soft edge. It is rebuilt
// only when the vision revision changes, which at 10Hz is most redraws but
// costs 9216 byte writes — a rounding error next to the ~2000 node pips this
// map already paints.

import { MAP_W, MAP_H, HALF_W, HALF_H, TERRAIN, PLAYER } from '../core/constants.js';

const SPAN = MAP_W + MAP_H;

const TERRAIN_COLOR = {
  [TERRAIN.GRASS]: '#3d6430',
  [TERRAIN.DIRT]:  '#6a5232',
  [TERRAIN.WATER]: '#25456f',
  [TERRAIN.SAND]:  '#9c8a5b',
};

// Node colours. Stone is deliberately the palest, coolest pip on the map: at
// two pixels it has to separate from gold's warm yellow *and* from the blue-grey
// of water underneath it, and a light slate is the only value that does both.
//
// Berry used to be #a8324a, which is an RGB distance of 97 from the enemy's
// #ff5a5a. With around 114 bushes on a map that is 114 things that read as
// "enemy" at a glance, so it moved to a plum that shares no channel ordering
// with the team colours: no red pip on this map is now anything but a unit.
const RES_COLOR = {
  tree: '#2b5122', berry: '#9c3f8f', gold: '#d8b33c', stone: '#b9c3ce',
};

// Trees are ~1600 of the ~1800 nodes on a 96x96 map. Painted at the same weight
// as everything else they are the map, and a unit pip lands on top of them as
// noise on noise. They are drawn a pixel smaller and a shade darker so they
// still describe where the forests are without competing with anything alive.
const NODE_SIZE = { tree: 1 };
const NODE_SIZE_DEFAULT = 2;

const TEAM = ['#5aa2ff', '#ff5a5a'];
const TEAM_DARK = ['#1c56ab', '#a01f1f'];

// --- Unit pips ---------------------------------------------------------------
// Units are binned rather than drawn one per unit. A ten-strong raid used to be
// ten 3x3 pips scattered over three tiles, which measured as 221 changed pixels
// out of 53824 against the same map without the raid: 0.4%, invisible in
// practice on the one instrument that can see the 93% of the map the camera
// cannot. Binned, that raid is a single pip that grows with the size of the
// stack, so an army reads as an army and a lone scout still reads as a dot.
//
// Three tiles per bin is the size of a clumped group at this scale; wider and
// two separate flanks merge into one blob, narrower and a moving army flickers
// between bins as it walks.
const UNIT_BIN = 3;
const UNIT_PIP_MIN = 3.5;   // px at size 160, a single unit
const UNIT_PIP_MAX = 12.0;  // px, a doomstack; beyond this it stops meaning more

// Hostile soldiers you can actually see get a ring around them.
//
// Binning alone was not enough. Ten scattered 3px pips and one 12px blob cover
// almost the same number of pixels — the blob is easier to parse, but it is not
// louder, and "louder" is the requirement: this is the only warning the player
// gets before a raid lands. The ring roughly triples the marked area and, more
// importantly, is a shape nothing else on the minimap draws.
//
// It is only ever drawn for enemy *military* that is currently in vision, which
// under fog of war is both rare and, without exception, something the player
// needs to look at. A ring around every red pip would be noise; a ring around
// the four that matter is an alarm.
const THREAT_RING_SCALE = 1.55;
const THREAT_RING = 'rgba(255,90,90,0.75)';

// --- Fog ---------------------------------------------------------------------
// The same warm black and the same explored alpha as the main view, so the two
// surfaces agree about what "you have been here" looks like. Kept as raw
// components because the overlay is built as ImageData, one byte per tile.
const FOG_R = 0x14;
const FOG_G = 0x0e;
const FOG_B = 0x08;
const FOG_EXPLORED_BYTE = Math.round(0.52 * 255);
const FOG_CSS = `rgb(${FOG_R},${FOG_G},${FOG_B})`;
// One tile of opaque border around the mask, so the coastline gets the same
// soft ramp into the unexplorable sea that every other fog edge gets instead of
// stopping dead on the map boundary.
const FOG_PAD = 1;

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

  // --- Fog layer ----------------------------------------------------------
  const vision = world.vision || null;
  const fogState = vision ? vision.state(PLAYER) : null;
  const fogW = MAP_W + FOG_PAD * 2;
  const fogH = MAP_H + FOG_PAD * 2;
  let fogCanvas = null;
  let fogCtx = null;
  let fogImage = null;
  let fogRevision = -1;

  if (fogState) {
    fogCanvas = document.createElement('canvas');
    fogCanvas.width = fogW;
    fogCanvas.height = fogH;
    fogCtx = fogCanvas.getContext('2d');
    fogCtx.fillStyle = `rgb(${FOG_R},${FOG_G},${FOG_B})`;
    fogCtx.fillRect(0, 0, fogW, fogH);
    fogImage = fogCtx.createImageData(MAP_W, MAP_H);
    const d = fogImage.data;
    for (let p = 0; p < d.length; p += 4) {
      d[p] = FOG_R;
      d[p + 1] = FOG_G;
      d[p + 2] = FOG_B;
    }
  }

  function refreshFog() {
    if (!fogState || fogState.revision === fogRevision) return;
    fogRevision = fogState.revision;
    vision.writeFogAlpha(PLAYER, fogImage.data, FOG_EXPLORED_BYTE);
    fogCtx.putImageData(fogImage, FOG_PAD, FOG_PAD);
  }

  function drawFog() {
    if (!fogState) return;
    refreshFog();
    // grid -> minimap is x = k(gx - gy) + MAP_H*k, y = k(gx + gy). Handing that
    // straight to the canvas transform means the fog pixels land on the tile
    // diamonds rather than on a screen-aligned grid rotated across them.
    const k = size / SPAN;
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(k, k, -k, k, MAP_H * k, 0);
    ctx.drawImage(fogCanvas, -FOG_PAD, -FOG_PAD, fogW, fogH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = smooth;
  }

  /** Is this grid point lit for the human player right now? */
  function lit(gx, gy) {
    if (!fogState) return true;
    const tx = gx | 0;
    const ty = gy | 0;
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return false;
    return fogState.visible[ty * MAP_W + tx] === 1;
  }

  function litTiles(indices) {
    if (!fogState) return true;
    for (let i = 0; i < indices.length; i++) {
      if (fogState.visible[indices[i]]) return true;
    }
    return false;
  }

  function litBuilding(b) {
    if (!fogState || !b.tiles) return lit(b.x, b.y);
    for (const [tx, ty] of b.tiles) {
      if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) continue;
      if (fogState.visible[ty * MAP_W + tx]) return true;
    }
    return false;
  }

  // --- Unit binning scratch ------------------------------------------------
  // Allocated once. `binStamp` carries a generation counter so a redraw only
  // clears the bins it actually touched, rather than sweeping 1024 bins to find
  // the handful an army occupies.
  const binCols = Math.ceil(MAP_W / UNIT_BIN);
  const binRows = Math.ceil(MAP_H / UNIT_BIN);
  const binCount = binCols * binRows;
  const binStamp = new Int32Array(binCount);
  const binN = [new Int16Array(binCount), new Int16Array(binCount)];
  const binSx = [new Float32Array(binCount), new Float32Array(binCount)];
  const binSy = [new Float32Array(binCount), new Float32Array(binCount)];
  // Set when any unit in the bin is a soldier, so an incoming raid can be drawn
  // hotter than a line of villagers walking to a woodline.
  const binMil = [new Uint8Array(binCount), new Uint8Array(binCount)];
  const binTouched = [];
  let binGen = 0;

  /**
   * Bin every visible unit, then draw one pip per occupied bin per player,
   * sized by how many units are in it and centred on their centroid so a pip
   * sits where the group actually is rather than on a bin boundary.
   */
  function drawUnits() {
    binGen++;
    binTouched.length = 0;

    for (const u of world.units) {
      if (u.dead || !lit(u.x, u.y)) continue;
      const bx = (u.x / UNIT_BIN) | 0;
      const by = (u.y / UNIT_BIN) | 0;
      if (bx < 0 || by < 0 || bx >= binCols || by >= binRows) continue;
      const i = by * binCols + bx;
      if (binStamp[i] !== binGen) {
        binStamp[i] = binGen;
        binN[0][i] = binN[1][i] = 0;
        binSx[0][i] = binSx[1][i] = 0;
        binSy[0][i] = binSy[1][i] = 0;
        binMil[0][i] = binMil[1][i] = 0;
        binTouched.push(i);
      }
      const p = u.player;
      binN[p][i]++;
      binSx[p][i] += u.x;
      binSy[p][i] += u.y;
      if (u.type !== 'villager') binMil[p][i] = 1;
    }

    if (!binTouched.length) return;
    ctx.save();
    ctx.lineWidth = 1;
    for (const i of binTouched) {
      for (let p = 0; p < 2; p++) {
        const n = binN[p][i];
        if (!n) continue;
        const c = gridToMini(binSx[p][i] / n, binSy[p][i] / n, size);
        // sqrt, so the pip grows quickly from one unit to a squad and then
        // levels off: the difference between 1 and 8 units matters far more
        // than the difference between 40 and 60.
        const s = Math.min(UNIT_PIP_MAX, UNIT_PIP_MIN + Math.sqrt(n - 1) * 2.8);
        const x = c.x - s / 2;
        const y = c.y - s / 2;
        // Threat ring first, so the pip sits inside it rather than under it.
        if (p !== PLAYER && binMil[p][i]) {
          ctx.beginPath();
          ctx.arc(c.x, c.y, s * THREAT_RING_SCALE, 0, Math.PI * 2);
          ctx.strokeStyle = THREAT_RING;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        // A black keyline is what makes a pip survive landing on dark forest,
        // pale sand or the fog veil. Without it the team colours only read on
        // grass, which is where they were tested and nowhere else.
        ctx.fillStyle = TEAM[p];
        ctx.fillRect(x, y, s, s);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
        // Soldiers get a white inner tick. It costs one more rect and it is the
        // difference between "someone is over there" and "an army is over there".
        if (binMil[p][i] && s >= 5) {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.fillRect(c.x - 1, c.y - 1, 2, 2);
        }
      }
    }
    ctx.restore();
  }

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

  /** One resource pip. Shared by the live pass and the memory pass. */
  function node(type, gx, gy) {
    const p = gridToMini(gx, gy, size);
    const s = NODE_SIZE[type] || NODE_SIZE_DEFAULT;
    ctx.fillStyle = RES_COLOR[type] || '#888';
    ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
  }

  /** One building block. Shared by the live pass and the memory pass. */
  function building(type, player, fw, complete, gx, gy) {
    const p = gridToMini(gx, gy, size);
    const s = Math.max(3, Math.round((fw / SPAN) * size * 2));
    ctx.fillStyle = complete ? TEAM[player] : TEAM_DARK[player];
    ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(p.x - s / 2 + 0.5, p.y - s / 2 + 0.5, s - 1, s - 1);
  }

  function draw(camera) {
    // The baked layer is opaque edge to edge (sea, then map), so blitting it is
    // also the clear — no need to pay for both at 10Hz.
    ctx.drawImage(bg, 0, 0);

    // Resource nodes: small, dim, but enough to read the map's shape. Only the
    // ones you can see right now; the rest come from memory below, at the same
    // colour, and the fog veil is what makes them read as remembered.
    for (const r of world.resources) {
      if (r.dead || !lit(r.x, r.y)) continue;
      node(r.type, r.x, r.y);
    }

    // Buildings first so units sit on top of them.
    for (const b of world.buildings) {
      if (b.dead || !litBuilding(b)) continue;
      building(b.type, b.player, b.fw, b.complete, b.x, b.y);
    }

    // Everything the player remembers but cannot see. This is the half of the
    // minimap that makes it a *navigation* tool rather than a live radar: the
    // enemy town you scouted at four minutes stays on the map afterwards, which
    // is how you find your way back to it.
    if (fogState) {
      const mem = fogState.memory;
      for (let i = 0; i < mem.length; i++) {
        const m = mem[i];
        if (litTiles(m.tiles)) continue;
        if (m.kind === 'resource') node(m.type, m.x, m.y);
        else if (m.kind === 'building') building(m.type, m.player, m.fw, m.complete, m.x, m.y);
      }
    }

    // Units are never remembered — see drawUnits in render.js.
    drawUnits();

    // The veil, over the entities so explored ones dim with the ground they
    // stand on, but under the selection pips and the viewport rectangle, which
    // are chrome and have to stay readable wherever they land.
    drawFog();

    // Selected things get a bright pip so you can find your army at a glance.
    if (world.selection.size) {
      ctx.fillStyle = '#ffffff';
      for (const id of world.selection) {
        const e = world.entities.get(id);
        if (!e || e.dead) continue;
        if (e.kind === 'building' ? !litBuilding(e) : !lit(e.x, e.y)) continue;
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
  // Everything outside the playable diamond is open sea you can never set foot
  // on, so under fog of war it is permanently unexplored and it is painted in
  // the fog's own black rather than in water. The main view does exactly the
  // same thing with the padding around its fog texture (see makeFog), and the
  // two surfaces have to agree or the minimap says "island in a sea" while the
  // world says "edge of the known world".
  g.fillStyle = FOG_CSS;
  g.fillRect(0, 0, size, size);

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
