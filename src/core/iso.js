// Isometric projection helpers.
//
// Grid space: (gx, gy) floats, +gx runs down-right on screen, +gy runs down-left.
// World space: pixel coordinates inside the Phaser world (camera scrolls this).
//
// The map's north corner (0,0) projects to worldX = 0, worldY = 0, so the
// playable diamond spans x in [-MAP_H*HALF_W, MAP_W*HALF_W] and y in
// [0, (MAP_W+MAP_H)*HALF_H].

import { HALF_W, HALF_H } from './constants.js';

/** Grid -> world pixels. */
export function gridToWorldX(gx, gy) {
  return (gx - gy) * HALF_W;
}

export function gridToWorldY(gx, gy) {
  return (gx + gy) * HALF_H;
}

/** Grid -> world pixels, into an out object (avoids allocation in hot loops). */
export function gridToWorld(gx, gy, out = { x: 0, y: 0 }) {
  out.x = (gx - gy) * HALF_W;
  out.y = (gx + gy) * HALF_H;
  return out;
}

/** World pixels -> grid (floats). Inverse of gridToWorld. */
export function worldToGrid(wx, wy, out = { x: 0, y: 0 }) {
  const a = wx / HALF_W;
  const b = wy / HALF_H;
  out.x = (a + b) / 2;
  out.y = (b - a) / 2;
  return out;
}

/** Tile the given grid position falls in. */
export function tileOf(gx, gy, out = { x: 0, y: 0 }) {
  out.x = Math.floor(gx);
  out.y = Math.floor(gy);
  return out;
}

/**
 * Depth for painter's-algorithm sorting. Larger = drawn later = in front.
 * Everything on screen must use this so units correctly occlude tiles/buildings.
 * `bias` separates co-located things (e.g. a unit standing on a tile).
 */
export function depthFor(gx, gy, bias = 0) {
  return (gx + gy) * 16 + bias;
}

/** Euclidean distance in grid space. */
export function dist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * The length of a vector, using only operations ECMA-262 pins to IEEE-754.
 *
 * NOT Math.hypot. The spec calls hypot "implementation-approximated", which
 * means two conforming engines may return different bits for the same input —
 * and they do: V8's hypot disagrees with sqrt(a*a + b*b) on about 38% of random
 * inputs, which proves it is a distinct algorithm rather than a correctly
 * rounded composition. That is fine for a single-player game and fatal for
 * lockstep multiplayer, where every peer must compute the same number: the
 * simulation compares these lengths against exact thresholds (arrival at
 * d <= 1.0, a repath at moved > 1.2) and writes them back into positions, so
 * one differing bit forks the match permanently. Measured before this helper
 * existed: two runs of the same seed, identical but for hypot, stayed in step
 * for 273 seconds and then diverged for good.
 *
 * Addition, multiplication and Math.sqrt ARE pinned to correctly-rounded
 * IEEE-754 by the spec, so this returns the same bits on every engine.
 */
export function hyp(x, y) {
  return Math.sqrt(x * x + y * y);
}

/**
 * 64 unit vectors, as source literals, for every "pick a direction" in the sim.
 *
 * WHY A TABLE INSTEAD OF Math.cos/Math.sin. The spec calls sin and cos
 * "implementation-approximated" — V8, SpiderMonkey and JavaScriptCore each ship
 * a different libm and disagree in the last bit. Everywhere the simulation used
 * them it was not doing trigonometry, it was choosing a heading: which way two
 * exactly-stacked units shove apart, which way a stuck soldier hops, where the
 * starting villagers stand around their Town Center. A heading does not need
 * transcendental precision, it needs every machine to choose the SAME one.
 *
 * These values cannot be generated at module load — that would just move the
 * engine's libm into the table. They are literals, so every engine reads the
 * same doubles out of the same source file. 64 directions is 5.6 degrees apart,
 * finer than anything here was relying on.
 *
 * Named DIR_COUNT rather than DIRS because this file already exports a DIRS —
 * the 8-way facing table the renderer picks sprite frames from. They are
 * different things: that one is about which picture to draw, this one is about
 * which way the simulation decided to go.
 */
export const DIR_COUNT = 64;
const DIR_TABLE = [
  [1, 0],[0.9951847266721969, 0.0980171403295606],[0.9807852804032304, 0.19509032201612825],[0.9569403357322088, 0.29028467725446233],
  [0.9238795325112867, 0.3826834323650898],[0.881921264348355, 0.47139673682599764],[0.8314696123025452, 0.5555702330196022],[0.773010453362737, 0.6343932841636455],
  [0.7071067811865476, 0.7071067811865475],[0.6343932841636455, 0.7730104533627369],[0.5555702330196023, 0.8314696123025452],[0.4713967368259978, 0.8819212643483549],
  [0.38268343236508984, 0.9238795325112867],[0.29028467725446233, 0.9569403357322089],[0.19509032201612833, 0.9807852804032304],[0.09801714032956077, 0.9951847266721968],
  [6.123233995736766e-17, 1],[-0.09801714032956065, 0.9951847266721969],[-0.1950903220161282, 0.9807852804032304],[-0.29028467725446216, 0.9569403357322089],
  [-0.3826834323650897, 0.9238795325112867],[-0.4713967368259977, 0.881921264348355],[-0.555570233019602, 0.8314696123025453],[-0.6343932841636454, 0.7730104533627371],
  [-0.7071067811865475, 0.7071067811865476],[-0.773010453362737, 0.6343932841636455],[-0.8314696123025453, 0.5555702330196022],[-0.8819212643483549, 0.47139673682599786],
  [-0.9238795325112867, 0.3826834323650899],[-0.9569403357322088, 0.2902846772544624],[-0.9807852804032304, 0.1950903220161286],[-0.9951847266721968, 0.09801714032956083],
  [-1, 1.2246467991473532e-16],[-0.9951847266721969, -0.09801714032956059],[-0.9807852804032304, -0.19509032201612836],[-0.9569403357322089, -0.2902846772544621],
  [-0.9238795325112868, -0.38268343236508967],[-0.881921264348355, -0.47139673682599764],[-0.8314696123025455, -0.555570233019602],[-0.7730104533627371, -0.6343932841636453],
  [-0.7071067811865477, -0.7071067811865475],[-0.6343932841636459, -0.7730104533627367],[-0.5555702330196022, -0.8314696123025452],[-0.4713967368259979, -0.8819212643483549],
  [-0.38268343236509034, -0.9238795325112865],[-0.29028467725446244, -0.9569403357322088],[-0.19509032201612866, -0.9807852804032303],[-0.09801714032956045, -0.9951847266721969],
  [-1.8369701987210297e-16, -1],[0.09801714032956009, -0.9951847266721969],[0.1950903220161283, -0.9807852804032304],[0.29028467725446205, -0.9569403357322089],
  [0.38268343236509, -0.9238795325112866],[0.4713967368259976, -0.881921264348355],[0.5555702330196018, -0.8314696123025455],[0.6343932841636456, -0.7730104533627369],
  [0.7071067811865474, -0.7071067811865477],[0.7730104533627365, -0.6343932841636459],[0.8314696123025452, -0.5555702330196022],[0.8819212643483548, -0.4713967368259979],
  [0.9238795325112865, -0.3826834323650904],[0.9569403357322088, -0.2902846772544625],[0.9807852804032303, -0.19509032201612872],[0.9951847266721969, -0.0980171403295605]
];

/** The i-th unit vector, wrapping. `i` may be any integer, including negative. */
export function dirVec(i) {
  return DIR_TABLE[(((i | 0) % DIR_COUNT) + DIR_COUNT) % DIR_COUNT];
}

/**
 * A stable direction for an entity id — the deterministic replacement for
 * `Math.cos(id * 2.3999632)`. Uses Math.imul, which the spec defines exactly,
 * in the same spirit as phaseOf() in systems/combat.js.
 */
export function dirForId(id) {
  return dirVec(Math.imul(id | 0, 2654435761) >>> 0);
}

export function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Screen-space distance between two grid points. Because the projection squashes
 * y, grid distance is a poor proxy for "looks close" — selection and picking
 * should use this instead.
 */
export function screenDist(ax, ay, bx, by) {
  const dx = (ax - bx - (ay - by)) * HALF_W;
  const dy = (ax - bx + ay - by) * HALF_H;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Clamp a grid coordinate into the map. */
export function clampToMap(v, max) {
  return v < 0 ? 0 : v > max ? max : v;
}

/**
 * The 8 facing directions, as grid-space unit vectors, indexed to match the
 * order sprite sheets are generated in (S, SW, W, NW, N, NE, E, SE on screen).
 */
export const DIRS = [
  [1, 1], [0, 1], [-1, 1], [-1, 0],
  [-1, -1], [0, -1], [1, -1], [1, 0],
];

/** Facing index 0..7 for a grid-space movement vector. */
export function dirIndex(dx, dy) {
  if (dx === 0 && dy === 0) return 0;
  // Convert to screen space first so facings read correctly to the player.
  const sx = (dx - dy) * HALF_W;
  const sy = (dx + dy) * HALF_H;
  const ang = Math.atan2(sy, sx); // -PI..PI, 0 = screen right
  // Screen right = East = index 6 in DIRS; step 45deg per index, going CCW.
  let idx = Math.round(ang / (Math.PI / 4));
  idx = ((idx % 8) + 8) % 8;
  // Map screen angle bucket -> DIRS index.
  const SCREEN_TO_DIR = [6, 7, 0, 1, 2, 3, 4, 5];
  return SCREEN_TO_DIR[idx];
}
