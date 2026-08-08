// Grid pathfinding: A* over the tile grid, plus the "where do I stand" helpers
// the unit AI needs to walk up to a tree, a building, or an enemy.
//
// No Phaser imports: this file must run headlessly under Node (see
// tests/pathfinding.test.mjs).
//
// Coordinate convention
// ---------------------
// The simulation lives in *grid space*: floats, where tile (tx,ty) spans
// [tx,tx+1) x [ty,ty+1) and its centre is (tx+0.5, ty+0.5). Resource nodes are
// spawned on tile centres (world.js), so "stand next to that tree" is a
// question about tile centres too.
//
// Every waypoint this module returns is a **point in grid space** — a tile
// centre, except for the final waypoint, which is the exact requested
// destination when it is reachable. Helpers that answer "which tile" return
// `{ x, y, tx, ty }`: `x,y` is the centre to walk to, `tx,ty` the integer tile,
// so callers can use whichever they need.
//
// Blocking comes from `world.blocked` (0 = free, 1 = static object, 2 = terrain).
// Units do NOT write to that grid — crowds are handled by separation steering in
// unitAI.js, not by the planner, so paths stay stable while units shuffle.

// --- Tuning -----------------------------------------------------------------

// Expansions before A* gives up and returns its best effort.
//
// The map is 96*96 = 9216 tiles, so 12000 is "search every tile, with a third
// again in hand for re-expansion". It has to be at least the tile count or a
// genuinely long walk — corner to corner is 85 tiles and the two bases really
// are in opposite corners — would come back as a partial path and the unit
// would re-plan every few tiles for the whole journey.
//
// It is a *cap*, not a cost: measured over a four-minute smoke run on the 96x96
// map (pathStats.expanded / pathStats.searches) an average search expands well
// under two hundred nodes, because H_WEIGHT keeps A* in a narrow corridor toward
// the goal. The budget only bites when the goal is unreachable, and that case is
// exactly the one it exists to stop — an impossible destination fails in bounded
// time with a partial path rather than stalling the frame. unitAI.js bounds the
// other side of it: SEARCHES_PER_STEP caps how many of these can happen in one
// sim step, so a hundred units all re-planning at once still cannot spike.
const DEFAULT_BUDGET = 12000;
const SQRT2 = Math.SQRT2;
// Slight tie-breaker toward the goal: keeps A* from fanning out over the huge
// open areas of an AoE2 map when a straight walk would do. Bounded so paths
// stay within ~1% of optimal.
const H_WEIGHT = 1.01;

// Half-width used when testing whether a straight shortcut clears an obstacle.
// A villager's radius is 0.32; give it a little more so smoothed paths do not
// scrape building corners.
const CLEARANCE = 0.38;
const LOS_STEP = 0.25;
// Smoothing never looks further ahead than this many waypoints, so a very long
// path cannot turn into an O(n^2) line-of-sight storm.
const SMOOTH_LOOKAHEAD = 12;

// How many connected walkable tiles a region needs before it stops counting as
// a *pocket*. Below it, a unit standing in the region has nowhere to work, no
// drop-off to reach and no way home — it is entombed.
//
// The number is deliberately generous. There is no wall building in this game
// (BUILDABLE is house / farm / barracks / mill / lumber camp / mining camp /
// towncenter), so the smallest enclosure a player can build on purpose is far
// larger than this — and on a 9216-tile map 96 tiles is about 1% of the ground,
// so it stays a pocket limit rather than a cap on legitimate walling — while every
// accidental seal seen in play has been one to a few tiles. Anything at or above
// the limit is treated as honest ground and never restricts placement — walling
// off a quarter of the map stays legal.
export const POCKET_LIMIT = 96;

/** Counters for tests and debugging. Reset whenever you like. */
export const pathStats = {
  searches: 0,
  cacheHits: 0,
  expanded: 0,
  partials: 0,
  failures: 0,
};

// --- Per-world scratch ------------------------------------------------------
// Typed arrays sized to the map, allocated once per world and reused. A
// generation stamp avoids clearing them between searches.

const SCRATCH = new WeakMap();

function getScratch(world) {
  const n = world.width * world.height;
  let s = SCRATCH.get(world);
  if (!s || s.n !== n) {
    s = {
      n,
      g: new Float32Array(n),
      from: new Int32Array(n),
      stamp: new Uint32Array(n),
      closed: new Uint8Array(n),
      gen: 0,
      heap: new Int32Array(1024),
      heapKey: new Float32Array(1024),
      heapSize: 0,
      // Same-tick memo of finished searches (see findPath).
      memo: new Map(),
      memoTick: -1,
    };
    SCRATCH.set(world, s);
  }
  return s;
}

// --- Binary heap (min by key, lazy deletion) --------------------------------

function heapClear(s) {
  s.heapSize = 0;
}

function heapPush(s, node, key) {
  let i = s.heapSize++;
  if (i >= s.heap.length) {
    const cap = s.heap.length * 2;
    const h = new Int32Array(cap);
    h.set(s.heap);
    const k = new Float32Array(cap);
    k.set(s.heapKey);
    s.heap = h;
    s.heapKey = k;
  }
  const heap = s.heap;
  const hk = s.heapKey;
  heap[i] = node;
  hk[i] = key;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (hk[p] <= hk[i]) break;
    const tn = heap[p]; heap[p] = heap[i]; heap[i] = tn;
    const tk = hk[p]; hk[p] = hk[i]; hk[i] = tk;
    i = p;
  }
}

function heapPop(s) {
  if (s.heapSize === 0) return -1;
  const heap = s.heap;
  const hk = s.heapKey;
  const top = heap[0];
  const last = --s.heapSize;
  if (last > 0) {
    heap[0] = heap[last];
    hk[0] = hk[last];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < last && hk[l] < hk[m]) m = l;
      if (r < last && hk[r] < hk[m]) m = r;
      if (m === i) break;
      const tn = heap[m]; heap[m] = heap[i]; heap[i] = tn;
      const tk = hk[m]; hk[m] = hk[i]; hk[i] = tk;
      i = m;
    }
  }
  return top;
}

// --- Tile queries -----------------------------------------------------------

/**
 * Can a unit stand on this tile? Accepts either integer tile coordinates or
 * float grid positions (it floors them), so callers never have to remember.
 */
export function isWalkable(world, tx, ty) {
  const x = Math.floor(tx);
  const y = Math.floor(ty);
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return false;
  return world.blocked[y * world.width + x] === 0;
}

/**
 * Nearest walkable tile to (tx,ty), searched outward in rings up to `maxR`.
 * Returns { x, y, tx, ty } (x,y = tile centre) or null.
 */
export function nearestWalkable(world, tx, ty, maxR = 6) {
  const cx = Math.floor(tx);
  const cy = Math.floor(ty);
  if (isWalkable(world, cx, cy)) return tile(cx, cy);

  let best = null;
  let bestD = Infinity;
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // Only the shell of the ring; interior was covered by smaller r.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!isWalkable(world, x, y)) continue;
        // Compare against the true (possibly fractional) request point.
        const ex = x + 0.5 - tx;
        const ey = y + 0.5 - ty;
        const d = ex * ex + ey * ey;
        if (d < bestD) {
          bestD = d;
          best = tile(x, y);
        }
      }
    }
    if (best) return best;
  }
  return null;
}

function tile(tx, ty) {
  return { x: tx + 0.5, y: ty + 0.5, tx, ty };
}

/** Tiles an entity physically covers. Buildings carry a footprint; others one tile. */
function occupiedTiles(target) {
  if (target.kind === 'building' && target.tiles && target.tiles.length) return target.tiles;
  return [[Math.floor(target.x), Math.floor(target.y)]];
}

/**
 * The best free tile to stand on to interact with `target` (a tree, a building,
 * an enemy), preferring tiles close to (fromX,fromY) so a villager walks around
 * the near side of a Town Center rather than the far side.
 *
 * `opts.avoid` may be a Set of "tx,ty" keys already claimed by other units, so a
 * group sent to one tree spreads around it instead of stacking on one tile.
 * `opts.maxRing` (default 1) widens the search when everything nearby is taken.
 *
 * Candidates the caller could never walk to are dropped, not merely penalised:
 * a tile sealed into a pocket used to win on raw distance (it is, after all, the
 * closest tile to the Town Center's south side), and every villager sent to it
 * walked into a wall forever. `opts.reachable === false` turns the test off for
 * callers that only want geometry.
 *
 * Returns { x, y, tx, ty } or null when the target is completely walled in.
 */
export function findAdjacentStandTile(world, target, fromX, fromY, opts = {}) {
  if (!target) return null;
  const avoid = opts.avoid || null;
  const maxRing = Math.max(1, opts.maxRing || 1);
  const checkReach = opts.reachable !== false;
  const own = occupiedTiles(target);
  const ownKeys = new Set(own.map(([x, y]) => `${x},${y}`));

  for (let ring = 1; ring <= maxRing; ring++) {
    const seen = new Set();
    const cands = [];
    for (const [ox, oy] of own) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const x = ox + dx;
          const y = oy + dy;
          const key = `${x},${y}`;
          if (seen.has(key) || ownKeys.has(key)) continue;
          seen.add(key);
          if (!isWalkable(world, x, y)) continue;
          if (avoid && avoid.has(key)) continue;

          const cxp = x + 0.5;
          const cyp = y + 0.5;
          const dxf = cxp - fromX;
          const dyf = cyp - fromY;
          let score = Math.sqrt(dxf * dxf + dyf * dyf);
          // Prefer orthogonal adjacency: a diagonal neighbour is a longer reach
          // and can be cut off by two blocked corners.
          if (dx !== 0 && dy !== 0) score += 0.45;
          // Prefer tiles that are not themselves cramped, so the unit can get
          // out again without a second search.
          const open = openness(world, x, y);
          if (open <= 2) score += 1.5;
          cands.push({ x, y, score, open });
        }
      }
    }
    cands.sort((a, b) => a.score - b.score);
    for (const c of cands) {
      // Only cramped tiles can be pockets, and only those pay for a flood fill.
      if (checkReach && c.open <= 2 && isSealedFrom(world, c.x + 0.5, c.y + 0.5, fromX, fromY)) {
        continue;
      }
      return tile(c.x, c.y);
    }
  }
  return null;
}

function openness(world, x, y) {
  let n = 0;
  if (isWalkable(world, x + 1, y)) n++;
  if (isWalkable(world, x - 1, y)) n++;
  if (isWalkable(world, x, y + 1)) n++;
  if (isWalkable(world, x, y - 1)) n++;
  return n;
}

// --- Regions and enclosure --------------------------------------------------
//
// A* answers "how do I get from A to B". These answer the cheaper question the
// placement rules and the stuck detector need: "is this patch of ground a sealed
// pocket, and is that other spot inside it with me?"
//
// The fill uses *exactly* A*'s connectivity — 8-way, no corner cutting — so a
// region that says "reachable" is reachable by a real path, and one that says
// "sealed" cannot be escaped by any path the planner could find. It stops as
// soon as it has seen `limit` tiles, so the cost is bounded by POCKET_LIMIT and
// never by the size of the map.

const REGION = new WeakMap();

function getRegionScratch(world) {
  const n = world.width * world.height;
  let r = REGION.get(world);
  if (!r || r.n !== n) {
    r = { n, mark: new Uint32Array(n), queue: new Int32Array(n), gen: 0 };
    REGION.set(world, r);
  }
  // Stamps are a Uint32; wrap safely rather than growing stale marks.
  if (r.gen >= 0xfffffff0) { r.mark.fill(0); r.gen = 0; }
  return r;
}

function solidAt(world, i, extra) {
  return world.blocked[i] !== 0 || (extra !== null && extra.has(i));
}

/**
 * Flood the walkable region containing the tile at (tx,ty).
 *
 * opts:
 *   limit        stop after this many tiles (default POCKET_LIMIT)
 *   extraBlocked Set of tile indices to treat as solid — "what if I built here"
 *   goal         { x, y } to look for while filling
 *
 * Returns { size, open, reachedGoal }.
 *   `open` — the fill hit `limit`, so this is map-sized ground, not a pocket.
 *            When it is true the fill stopped early, so `size` is truncated and
 *            `reachedGoal` is not meaningful.
 *   `size` 0 means (tx,ty) is itself solid: there is no region to speak of.
 */
export function floodRegion(world, tx, ty, opts = {}) {
  const W = world.width;
  const H = world.height;
  const limit = opts.limit == null ? POCKET_LIMIT : opts.limit;
  const extra = opts.extraBlocked || null;
  const gtx = opts.goal ? Math.floor(opts.goal.x) : -1;
  const gty = opts.goal ? Math.floor(opts.goal.y) : -1;

  const out = { size: 0, open: false, reachedGoal: false };

  const x0 = Math.floor(tx);
  const y0 = Math.floor(ty);
  if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return out;
  const start = y0 * W + x0;
  if (solidAt(world, start, extra)) return out;

  const r = getRegionScratch(world);
  const gen = ++r.gen;
  const { mark, queue } = r;
  let head = 0;
  let tail = 0;
  mark[start] = gen;
  queue[tail++] = start;

  while (head < tail) {
    const cur = queue[head++];
    out.size++;
    const cx = cur % W;
    const cy = (cur - cx) / W;
    if (cx === gtx && cy === gty) out.reachedGoal = true;
    if (out.size >= limit) { out.open = true; break; }

    for (let d = 0; d < 8; d++) {
      const dx = NDX[d];
      const dy = NDY[d];
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (mark[ni] === gen) continue;
      if (solidAt(world, ni, extra)) continue;
      if (dx !== 0 && dy !== 0) {
        // Same no-corner-cutting rule A* uses, or the fill would claim ground
        // no path can actually reach.
        if (solidAt(world, cy * W + nx, extra)) continue;
        if (solidAt(world, ny * W + cx, extra)) continue;
      }
      mark[ni] = gen;
      queue[tail++] = ni;
    }
  }
  return out;
}

/**
 * True when the walkable region containing (tx,ty) is a pocket: smaller than
 * `limit` tiles and therefore somewhere a unit cannot live. A solid tile is not
 * a pocket — standing inside a wall is a different problem (the unit is evicted
 * from under it), so this answers false for one.
 */
export function isPocket(world, tx, ty, opts = {}) {
  const r = floodRegion(world, tx, ty, opts);
  return r.size > 0 && !r.open;
}

/**
 * True when a unit at (sx,sy) is sealed away from (gx,gy): its region is a
 * pocket and the goal is not in it. This is the honest "entombed" test —
 * findPath returning null is only a hint, since a blocked corner can produce
 * the same answer for a unit standing in the open.
 */
export function isSealedFrom(world, sx, sy, gx, gy, opts = {}) {
  const r = floodRegion(world, sx, sy, { ...opts, goal: { x: gx, y: gy } });
  if (r.open || r.size === 0) return false;
  return !r.reachedGoal;
}

/** Nearest tile that is free once `extra` is treated as solid, or null. */
function nearestFree(world, tx, ty, extra, maxR) {
  const W = world.width;
  const H = world.height;
  const cx = Math.floor(tx);
  const cy = Math.floor(ty);
  for (let r = 0; r <= maxR; r++) {
    let best = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (solidAt(world, y * W + x, extra)) continue;
        const ex = x + 0.5 - tx;
        const ey = y + 0.5 - ty;
        const d = ex * ex + ey * ey;
        if (d < bestD) { bestD = d; best = { x: x + 0.5, y: y + 0.5, tx: x, ty: y }; }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Which of `points` would be sealed into a pocket if `blockTiles` — an array of
 * [tx,ty] — turned solid.
 *
 * A point that is *already* sealed before the placement is never reported: the
 * new building is not what trapped it, and refusing every subsequent placement
 * because of an existing pocket would be its own bug. A point standing on the
 * new footprint is resolved to the tile it will be pushed out to first.
 *
 * Returns the offending points (empty array = the placement seals nobody).
 */
export function pointsSealedBy(world, blockTiles, points, opts = {}) {
  const W = world.width;
  const H = world.height;
  const limit = opts.limit == null ? POCKET_LIMIT : opts.limit;
  const extra = new Set();
  for (const t of blockTiles || []) {
    const tx = t[0];
    const ty = t[1];
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
    extra.add(ty * W + tx);
  }

  const memo = new Map();
  const sealed = (p, block) => {
    const spot = nearestFree(world, p.x, p.y, block, 4);
    if (!spot) return true; // nowhere at all to stand
    const key = (block === null ? 'b' : 'a') + (spot.ty * W + spot.tx);
    let v = memo.get(key);
    if (v === undefined) {
      const r = floodRegion(world, spot.tx, spot.ty, { limit, extraBlocked: block });
      v = r.size > 0 && !r.open;
      memo.set(key, v);
    }
    return v;
  };

  const out = [];
  for (const p of points || []) {
    if (!sealed(p, extra)) continue;
    if (sealed(p, null)) continue; // was already stuck; not this building's doing
    out.push(p);
  }
  return out;
}

/**
 * Is there at least one free tile touching `tiles` (a building footprint) that
 * sits on map-sized ground? This is how "can anything still get out of my Town
 * Center" is asked — a building whose whole perimeter is walls or pockets can
 * never place a trained unit again.
 */
export function hasOpenPerimeter(world, tiles, opts = {}) {
  const W = world.width;
  const H = world.height;
  const limit = opts.limit == null ? POCKET_LIMIT : opts.limit;
  const extra = opts.extraBlocked || null;
  const own = new Set(tiles.map(([x, y]) => `${x},${y}`));
  const seen = new Set();
  for (const [ox, oy] of tiles) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = ox + dx;
        const y = oy + dy;
        const key = `${x},${y}`;
        if (seen.has(key) || own.has(key)) continue;
        seen.add(key);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (solidAt(world, y * W + x, extra)) continue;
        const r = floodRegion(world, x, y, { limit, extraBlocked: extra });
        if (r.open) return true;
      }
    }
  }
  return false;
}

// --- Line of sight ----------------------------------------------------------

/**
 * True if a unit of radius ~CLEARANCE can walk the straight segment a->b
 * without clipping a blocked tile. Used to smooth A* output; also useful to
 * skip planning entirely when the goal is in plain sight.
 */
export function hasLineOfSight(world, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return isWalkable(world, ax, ay);
  const steps = Math.max(1, Math.ceil(len / LOS_STEP));
  const sx = dx / steps;
  const sy = dy / steps;
  // Sample the swept capsule: centre plus the four extremes of the unit's body.
  for (let i = 0; i <= steps; i++) {
    const x = ax + sx * i;
    const y = ay + sy * i;
    if (!isWalkable(world, x, y)) return false;
    if (!isWalkable(world, x + CLEARANCE, y)) return false;
    if (!isWalkable(world, x - CLEARANCE, y)) return false;
    if (!isWalkable(world, x, y + CLEARANCE)) return false;
    if (!isWalkable(world, x, y - CLEARANCE)) return false;
  }
  return true;
}

// --- A* ---------------------------------------------------------------------

function octile(dx, dy) {
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  return ax > ay ? ax + (SQRT2 - 1) * ay : ay + (SQRT2 - 1) * ax;
}

/**
 * A* from (sx,sy) to (tx,ty) in grid space, 8-way, no corner cutting.
 *
 * Returns an array of waypoints `[{x,y}, ...]` (see the coordinate note at the
 * top), or null when there is nothing sensible to return at all. The array
 * carries two flags:
 *   `path.partial` — the goal was not reached; this is the best effort toward
 *                    it. Callers should treat arrival as "I got as close as I
 *                    can", not as success.
 *   `path.goal`    — { x, y } the goal actually planned to.
 *
 * A unit that refuses to move because its goal is blocked feels broken, so the
 * failure modes are all soft: a blocked start escapes to the nearest free tile,
 * a blocked goal slides to the nearest free tile near it, and an unreachable
 * goal returns the partial path that gets closest.
 *
 * opts: { budget, smooth, allowPartial, goalSearchR, cache }
 */
export function findPath(world, sx, sy, tx, ty, opts = {}) {
  const W = world.width;
  const H = world.height;
  const budget = opts.budget || DEFAULT_BUDGET;
  const smooth = opts.smooth !== false;
  const allowPartial = opts.allowPartial !== false;

  let stx = Math.floor(sx);
  let sty = Math.floor(sy);
  if (stx < 0 || sty < 0 || stx >= W || sty >= H) {
    const esc = nearestWalkable(world, clamp(stx, 0, W - 1), clamp(sty, 0, H - 1), 6);
    if (!esc) { pathStats.failures++; return null; }
    stx = esc.tx; sty = esc.ty;
  }
  // Standing inside a wall (a building went up on top of the unit): walk out.
  if (!isWalkable(world, stx, sty)) {
    const esc = nearestWalkable(world, stx, sty, 4);
    if (!esc) { pathStats.failures++; return null; }
    stx = esc.tx; sty = esc.ty;
  }

  let gx = tx;
  let gy = ty;
  let gtx = Math.floor(tx);
  let gty = Math.floor(ty);
  let goalMoved = false;
  if (!isWalkable(world, gtx, gty)) {
    const alt = nearestWalkable(world, gtx, gty, opts.goalSearchR == null ? 4 : opts.goalSearchR);
    if (!alt) { pathStats.failures++; return null; }
    gtx = alt.tx; gty = alt.ty;
    gx = alt.x; gy = alt.y;
    goalMoved = true;
  }

  // Already there.
  if (stx === gtx && sty === gty) {
    const out = [{ x: gx, y: gy }];
    out.partial = false;
    out.goal = { x: gx, y: gy };
    return out;
  }

  const s = getScratch(world);

  // Same-tick memo: a group ordered together produces many near-identical
  // searches in one step. Keyed on tiles, so the answer is at most one tile
  // stale, and the caller gets a copy it may freely own.
  const useCache = opts.cache !== false;
  const key = useCache ? `${stx},${sty},${gtx},${gty},${smooth ? 1 : 0}` : null;
  if (useCache) {
    if (s.memoTick !== world.tick) {
      s.memo.clear();
      s.memoTick = world.tick;
    }
    const hit = s.memo.get(key);
    if (hit) {
      pathStats.cacheHits++;
      return reheadPath(world, hit, sx, sy, smooth);
    }
  }

  // Plain sight? Skip the search entirely — most orders in an open base are
  // this case, and it keeps A* for the walks that actually need it.
  if (!goalMoved && hasLineOfSight(world, sx, sy, gx, gy)) {
    const out = [{ x: gx, y: gy }];
    out.partial = false;
    out.goal = { x: gx, y: gy };
    return out;
  }

  const gen = ++s.gen;
  const { g, from, stamp, closed } = s;
  heapClear(s);

  const startIdx = sty * W + stx;
  const goalIdx = gty * W + gtx;
  g[startIdx] = 0;
  from[startIdx] = -1;
  stamp[startIdx] = gen;
  closed[startIdx] = 0;
  heapPush(s, startIdx, octile(stx - gtx, sty - gty) * H_WEIGHT);

  let expanded = 0;
  let found = false;
  // Best fallback: closest to the goal, breaking ties by cheapest to reach.
  let bestIdx = startIdx;
  let bestH = octile(stx - gtx, sty - gty);
  let bestG = 0;

  while (s.heapSize > 0) {
    const cur = heapPop(s);
    if (stamp[cur] !== gen || closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goalIdx) { found = true; break; }
    if (++expanded > budget) break;

    const cx = cur % W;
    const cy = (cur - cx) / W;
    const cg = g[cur];

    for (let d = 0; d < 8; d++) {
      const dx = NDX[d];
      const dy = NDY[d];
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (world.blocked[ni] !== 0) continue;
      if (stamp[ni] === gen && closed[ni]) continue;
      if (dx !== 0 && dy !== 0) {
        // No corner cutting: both orthogonal neighbours must be free, or the
        // unit would clip the corner of a building it cannot walk through.
        if (world.blocked[cy * W + nx] !== 0) continue;
        if (world.blocked[ny * W + cx] !== 0) continue;
      }
      const ng = cg + (dx !== 0 && dy !== 0 ? SQRT2 : 1);
      if (stamp[ni] === gen && ng >= g[ni]) continue;
      stamp[ni] = gen;
      closed[ni] = 0;
      g[ni] = ng;
      from[ni] = cur;
      const h = octile(nx - gtx, ny - gty);
      heapPush(s, ni, ng + h * H_WEIGHT);
      if (h < bestH || (h === bestH && ng < bestG)) {
        bestH = h;
        bestG = ng;
        bestIdx = ni;
      }
    }
  }

  pathStats.searches++;
  pathStats.expanded += expanded;

  let endIdx = goalIdx;
  let partial = false;
  if (!found) {
    if (!allowPartial) { pathStats.failures++; return null; }
    partial = true;
    pathStats.partials++;
    endIdx = bestIdx;
    if (endIdx === startIdx) {
      // Boxed in with nowhere at all to go.
      pathStats.failures++;
      return null;
    }
  }

  const pts = reconstruct(s, endIdx, startIdx, W);
  if (pts.length === 0) { pathStats.failures++; return null; }
  // Land exactly on the requested point when it is genuinely the destination,
  // so formation offsets inside a tile are respected and units do not all pile
  // onto one tile centre.
  if (found && !goalMoved) {
    pts[pts.length - 1] = { x: gx, y: gy };
  }

  const out = smooth ? smoothPath(world, sx, sy, pts) : pts;
  out.partial = partial;
  out.goal = { x: gx, y: gy };

  if (useCache && s.memo.size < 512) {
    s.memo.set(key, out);
    // Hand back a copy: the caller owns its path and may splice it.
    return reheadPath(world, out, sx, sy, false);
  }
  return out;
}

// Directions: 4 orthogonal first (cheaper, explored first on ties), then diagonals.
const NDX = [1, -1, 0, 0, 1, 1, -1, -1];
const NDY = [0, 0, 1, -1, 1, -1, 1, -1];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function reconstruct(s, endIdx, startIdx, W) {
  const out = [];
  let cur = endIdx;
  let guard = s.n + 8;
  while (cur !== -1 && cur !== startIdx && guard-- > 0) {
    const x = cur % W;
    const y = (cur - x) / W;
    out.push({ x: x + 0.5, y: y + 0.5 });
    cur = s.from[cur];
  }
  out.reverse();
  return out;
}

/**
 * String-pull the tile path: repeatedly jump to the furthest waypoint still in
 * plain sight. Turns the staircase A* produces into the two or three straight
 * legs a player expects, and drops the first waypoint when the unit is already
 * past it (so a command never starts with a step backwards).
 */
function smoothPath(world, sx, sy, pts) {
  if (pts.length <= 1) return pts;
  const out = [];
  let ax = sx;
  let ay = sy;
  let i = 0;
  const last = pts.length - 1;
  while (i <= last) {
    let best = i;
    const limit = Math.min(last, i + SMOOTH_LOOKAHEAD);
    for (let k = i; k <= limit; k++) {
      if (hasLineOfSight(world, ax, ay, pts[k].x, pts[k].y)) best = k;
      else break;
    }
    out.push(pts[best]);
    ax = pts[best].x;
    ay = pts[best].y;
    i = best + 1;
  }
  return out;
}

/**
 * Reuse a cached path from a slightly different start: re-run the smoothing
 * head so the unit does not walk back to the cached start's tile centre.
 */
function reheadPath(world, cached, sx, sy, smooth) {
  const out = smooth ? smoothPath(world, sx, sy, cached.slice()) : cached.slice();
  out.partial = cached.partial;
  out.goal = cached.goal;
  return out;
}
