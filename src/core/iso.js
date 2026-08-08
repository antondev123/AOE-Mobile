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
