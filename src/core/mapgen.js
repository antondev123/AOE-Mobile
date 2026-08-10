// Skirmish map generation: terrain, resource nodes, and two mirrored bases.
//
// The layout follows AoE2's opening: a Town Center, a few villagers, berries
// and wood close by, gold a short walk away and stone a longer one — so the
// first two minutes are about assigning villagers rather than exploring, and
// the minutes after that are about deciding when to leave the base.

import { MAP_W, MAP_H, TERRAIN, PLAYER, ENEMY } from './constants.js';
import { dirVec, DIR_COUNT } from './iso.js';
import {
  spawnBuilding, spawnResource, spawnUnit, isBlocked, inBounds, recomputePop,
  setBlocked, BLOCK_TERRAIN,
} from './world.js';
import { commandUnits } from '../systems/unitAI.js';

// Distance of each Town Center from its map corner.
//
// 18 on a 96x96 map puts the two bases 60 tiles apart on each axis — about 85
// tiles of walking — so a militia at 1.1 tiles/second needs a little over a
// minute to cross, and the first raid is something you hear about from the
// minimap rather than something that is already happening. It is the old figure
// (9 on 48x48) scaled with the map, deliberately: the *local* layout around a
// base is tuned and did not want moving, only the gap between the two.
const BASE_OFFSET = 18;

// Everything scattered across open ground scales with the map's area, so a map
// four times the size is not four times emptier. The counts below are the old
// 48x48 figures multiplied by this and rounded to something that reads well.
const AREA_SCALE = (MAP_W * MAP_H) / (48 * 48);

export function generateMap(world) {
  carveTerrain(world);

  const bases = [
    { player: PLAYER, x: BASE_OFFSET, y: BASE_OFFSET },
    { player: ENEMY, x: MAP_W - BASE_OFFSET, y: MAP_H - BASE_OFFSET },
  ];

  // Rock before anything that has to path around it: an outcrop that landed on
  // top of a forest would have to evict trees, whereas trees placed afterwards
  // simply do not choose a rock tile.
  scatterCliffs(world, bases);

  // Scatter neutral forest across the middle before bases claim their ground,
  // then clear anything that would sit on top of a base.
  scatterForests(world, bases);
  scatterGold(world, bases);
  scatterStone(world, bases);
  scatterBerries(world, bases);

  for (const b of bases) {
    const built = buildBase(world, b);
    putToWork(world, b, built.villagers);
  }

  for (const p of world.players) recomputePop(world, p.id);
  return { bases };
}

// How many of the three starting villagers open on wood rather than on food.
//
// AoE2 opens every villager on food and this does not, for a reason particular
// to what the opening has to *teach* on a phone. A player who gives no input
// for the first minute — which a measurement of this build found is exactly
// what happens — should see the two halves of the economy running, because the
// food counter and the wood counter both moving is the whole gather loop
// stated without a word of text: villager walks to thing, thing becomes number,
// number buys building. Three on berries would show that loop once; two and one
// shows it twice with different scenery, and leaves the opening still weighted
// toward food the way an AoE2 opening is.
const OPENING_WOODCUTTERS = 1;

/**
 * Send the starting villagers to the nearest food and the nearest wood.
 *
 * This is the fix for a dead opening. Three villagers standing in `idle` next
 * to a Town Center is not a neutral starting position, it is a screen with
 * nothing happening on it: measured over sixty simulated seconds of no input,
 * food went 250 -> 250, wood 250 -> 250 and every villager stayed idle, while
 * the enemy AI — which has always opened its own villagers — went from three
 * units to six. The player was losing the match during the tutorial.
 *
 * It runs for BOTH players, from mapgen rather than from the AI, so the two
 * openings are identical and a seed replays the same way for each side.
 *
 * Orders go through commandUnits, not through hand-written task objects: the
 * point is to put the villagers into exactly the state a player's tap would
 * have put them in, so that everything downstream — the idle counter, the
 * allocation manager, the job note, a save taken on the first frame — sees
 * ordinary gatherers and not a special case.
 */
function putToWork(world, base, villagers) {
  if (!villagers || !villagers.length) return;
  const food = nearestNode(world, base.x, base.y, 'berry');
  const wood = nearestNode(world, base.x, base.y, 'tree');
  villagers.forEach((u, i) => {
    // Ordered from the back so that the wood assignment lands on the villager
    // furthest round the fan, which keeps the two jobs visually separated from
    // the first frame instead of having all three set off along the same line.
    const wantWood = i >= villagers.length - OPENING_WOODCUTTERS;
    const node = (wantWood ? wood : food) || wood || food;
    if (!node) return;
    commandUnits(world, [u], { type: 'gather', target: node, gx: node.x, gy: node.y });
  });
}

/** The closest live resource node of a type to a point. Linear; runs twice per base. */
function nearestNode(world, x, y, type) {
  let best = null;
  let bestD = Infinity;
  for (const e of world.resources) {
    if (e.dead || e.type !== type || !(e.amount > 0)) continue;
    const d = (e.x - x) ** 2 + (e.y - y) ** 2;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

/** Counts that should grow with the map, never below the original figure. */
function scaled(n) {
  return Math.max(n, Math.round(n * AREA_SCALE));
}

function carveTerrain(world) {
  const { rng } = world;
  // Gentle patches of dirt and sand so the ground is not a flat green sheet.
  for (let i = 0; i < scaled(70); i++) {
    const cx = rng.int(0, MAP_W - 1);
    const cy = rng.int(0, MAP_H - 1);
    const r = rng.range(1.5, 4);
    const kind = rng.chance(0.65) ? TERRAIN.DIRT : TERRAIN.SAND;
    stamp(world, cx, cy, r, kind);
  }
  // Ponds, away from the base corners. Kept small and few: water is impassable,
  // and a lake across the middle of a 96-tile map is a wall, not scenery.
  for (let i = 0; i < scaled(2); i++) {
    const cx = rng.int(BASE_OFFSET + 6, MAP_W - BASE_OFFSET - 6);
    const cy = rng.int(BASE_OFFSET + 6, MAP_H - BASE_OFFSET - 6);
    const r = rng.range(2.5, 4.5);
    stamp(world, cx, cy, r, TERRAIN.WATER);
  }
  // Water is impassable.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = y * MAP_W + x;
      if (world.terrain[i] === TERRAIN.WATER) world.blocked[i] = 2;
    }
  }
}

function stamp(world, cx, cy, r, kind) {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (!inBounds(world, x, y)) continue;
      const dx = x - cx;
      const dy = y - cy;
      // Ragged edge, so patches do not look like stamped circles.
      if (dx * dx + dy * dy <= r2 * world.rng.range(0.7, 1.15)) {
        world.terrain[y * MAP_W + x] = kind;
      }
    }
  }
}

/** True if a tile is clear ground and far enough from every base centre. */
function freeSpot(world, x, y, bases, minBaseDist) {
  if (!inBounds(world, x, y)) return false;
  if (isBlocked(world, x, y)) return false;
  if (world.terrain[y * MAP_W + x] === TERRAIN.WATER) return false;
  for (const b of bases) {
    const dx = x - b.x;
    const dy = y - b.y;
    if (dx * dx + dy * dy < minBaseDist * minBaseDist) return false;
  }
  return true;
}

function scatterForests(world, bases) {
  const { rng } = world;
  // Big neutral woods in the middle of the map...
  for (let i = 0; i < scaled(22); i++) {
    const cx = rng.int(3, MAP_W - 4);
    const cy = rng.int(3, MAP_H - 4);
    growForest(world, cx, cy, rng.int(8, 26), bases, 7);
  }
  // ...plus a guaranteed woodline for each player, close enough to be the
  // obvious first wood assignment.
  for (const b of bases) {
    // A fixed heading per base, taken from the literal direction table. Index 9
    // of 64 is ~0.88 radians, which is where the old `0.9` put it; the opposite
    // base gets the antipode. Trigonometry is not used here because sin and cos
    // differ in the last bit between JavaScript engines, and a single flipped
    // Math.round relocates a whole woodline — which changes blocked[], which
    // changes every path near it, on one machine and not the other.
    const ang = b.player === PLAYER ? 9 : 9 + DIR_COUNT / 2;
    const d = dirVec(ang);
    const cx = Math.round(b.x + d[0] * 7);
    const cy = Math.round(b.y + d[1] * 7);
    growForest(world, cx, cy, 30, bases, 4.5);
  }
}

function growForest(world, cx, cy, count, bases, minBaseDist) {
  const { rng } = world;
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < count * 12) {
    attempts++;
    // Random walk outward from the seed so clumps look organic.
    const r = rng.range(0, Math.sqrt(count) * 0.9);
    const d = dirVec(rng.int(0, DIR_COUNT - 1));
    const x = Math.round(cx + d[0] * r);
    const y = Math.round(cy + d[1] * r);
    if (!freeSpot(world, x, y, bases, minBaseDist)) continue;
    spawnResource(world, 'tree', x, y);
    placed++;
  }
}

// How close a *neutral* cluster may sit to any base.
//
// This is the number that decides whether a big map is a big map. A review of
// the 96x96 release counted what was reachable within fifteen tiles of a Town
// Center: 2200 food, 12900 wood, 8640 gold, 2200 stone. A ten-minute match at
// around twenty villagers consumes roughly nine thousand resources in total, so
// everything a full game needed was already inside a seven-hundred-tile pocket
// the player never had to leave. The other ninety-two percent of the map was
// scenery, and the Lumber Camp — justified by woodlines fifteen tiles out —
// was answering a problem the generator never created.
//
// Pushing neutral clusters past twenty tiles is what forces the second base,
// the forward camp and the fight over the middle. The guaranteed starting
// clusters below are deliberately left close: the opening should still be about
// assigning villagers, not about exploring.
const NEUTRAL_MIN_BASE_DIST = 22;

function scatterGold(world, bases) {
  const { rng } = world;
  // Neutral gold in the contested middle — worth fighting over.
  for (let i = 0; i < scaled(7); i++) {
    const cx = rng.int(8, MAP_W - 9);
    const cy = rng.int(8, MAP_H - 9);
    placeCluster(world, cx, cy, 'gold', rng.int(3, 5), bases, NEUTRAL_MIN_BASE_DIST);
  }
  // A starting gold vein per player, a short walk from the Town Center.
  //
  // Three nodes, not four. Four held 1280 gold, which is 28 archers off a vein
  // you never have to defend — enough to reach the end of a skirmish without
  // contesting the middle even once. Three leaves you needing the map.
  for (const b of bases) {
    const dir = b.player === PLAYER ? 1 : -1;
    placeCluster(world, b.x + 7 * dir, b.y - 4 * dir, 'gold', 3, bases, 4.5);
  }
}

/**
 * Stone mines.
 *
 * Stone is the mid-game resource: nothing in the opening spends it, and its
 * sinks are the defensive buildings you reach for once the first raid has
 * landed. So it is placed to be *found*, not to be stumbled over. Each player
 * gets one guaranteed cluster, but further out than their starting gold (11
 * tiles against gold's 7) and on the far side of the base, so walking a villager
 * to it is a small decision rather than something that happens by accident on
 * the way to the berries.
 *
 * The rest sits in the contested middle in clusters of three or four. Counted in
 * nodes the map ends up with slightly fewer stone than gold and a small fraction
 * of the trees, which is the intended scarcity ordering: wood is everywhere,
 * gold is worth a fight, stone is worth a walk and a fight.
 */
function scatterStone(world, bases) {
  const { rng } = world;
  for (let i = 0; i < scaled(6); i++) {
    const cx = rng.int(10, MAP_W - 11);
    const cy = rng.int(10, MAP_H - 11);
    placeCluster(world, cx, cy, 'stone', rng.int(3, 4), bases, NEUTRAL_MIN_BASE_DIST + 2);
  }
  // Three nodes at fourteen tiles rather than four at ten. Stone is the
  // resource you go and get once the first raid has told you that you need
  // walls, so the starting mine should be a decision with a walk attached.
  for (const b of bases) {
    const dir = b.player === PLAYER ? 1 : -1;
    placeCluster(world, b.x - 5 * dir, b.y + 14 * dir, 'stone', 3, bases, 6.5);
  }
}

/** Neutral berry patches, so a long game has food worth walking out for. */
function scatterBerries(world, bases) {
  const { rng } = world;
  for (let i = 0; i < scaled(6); i++) {
    const cx = rng.int(10, MAP_W - 11);
    const cy = rng.int(10, MAP_H - 11);
    placeCluster(world, cx, cy, 'berry', rng.int(3, 5), bases, NEUTRAL_MIN_BASE_DIST);
  }
}

// --- Rock outcrops ----------------------------------------------------------
//
// The map has been perfectly flat since it was written, and flatness is the
// thing a screenshot of it shows first: a green sheet with objects standing on
// it, no horizon, nothing to walk around. The art for the fix has been sitting
// in the atlas the whole time — forty-eight cliff frames, sixteen neighbour
// masks by three variants, baked at every boot — drawn by render.js's
// drawCliffs() off `world.cliff`, a grid that nothing has ever written to. So
// this is not new art and not a new renderer; it is the writer that was never
// hooked up.
//
// WHAT A CLIFF IS, MECHANICALLY. Impassable terrain, exactly like water:
// BLOCK_TERRAIN in the block grid, so A* routes around it, buildings refuse to
// sit on it and walls cannot be drawn through it. There is no elevation model
// and units do not climb — a cliff is a wall the map came with. That is the
// whole feature, and it is deliberately the whole feature: real elevation would
// mean height in the projection, ramps, and a pathfinder that knows about both.
//
// WHAT IT IS FOR. Ground you cannot walk over is what turns an open field into
// a place with routes through it. A raid has to commit to one side of an
// outcrop, an army can be met at the gap rather than in the open, and a wall
// only has to cover the ground between two rocks instead of the whole frontage.
//
// COVERAGE. About 2.5% of the map, in a dozen-odd blobs. That number was picked
// by looking at it: at 1% the rock reads as litter, and past 5% the map starts
// feeling like a maze and the AI's approach paths get long enough to change the
// pacing everything else is tuned around.
const CLIFF_BLOBS = Math.max(6, Math.round(scaled(12)));
// No rock within this many tiles of a Town Center. Fifteen clears the base, the
// starting woodline and the near gold, so an outcrop can never be the reason an
// opening does not work. The two bases are 85 tiles apart, so this costs the
// middle of the map nothing.
const CLIFF_MIN_BASE_DIST = 15;

function scatterCliffs(world, bases) {
  const { rng } = world;
  const W = world.width;
  const H = world.height;
  // createWorld allocates it; a regenerated map must clear it rather than
  // accumulate the last one's rock.
  if (!world.cliff || world.cliff.length !== W * H) world.cliff = new Uint8Array(W * H);
  else world.cliff.fill(0);

  for (let i = 0; i < CLIFF_BLOBS; i++) {
    // Four tiles in from the edge. A blob that touches the border would draw
    // its faces against the out-of-bounds sea, which is not a picture the
    // terrain bake is set up to make sense of.
    const cx = rng.int(4, W - 5);
    const cy = rng.int(4, H - 5);
    growOutcrop(world, cx, cy, rng.int(5, 16), bases);
  }

  stampCliffTerrain(world);
}

/**
 * Grow one outcrop from a seed tile by repeated random walk.
 *
 * A blob rather than a disc, and a walk rather than a radius, because a disc of
 * rock in this projection is a diamond, and a map dotted with diamonds looks
 * placed rather than eroded. Walking outward from a seed and claiming whatever
 * it steps on gives the ragged, slightly linear shapes that read as a ridge.
 *
 * Every candidate tile is checked against the base exclusion, the map edge and
 * the water, and then — the expensive one — against whether claiming it would
 * cut the map in two. See cutsTheMap().
 */
function growOutcrop(world, cx, cy, size, bases) {
  const { rng } = world;
  let x = cx;
  let y = cy;
  for (let n = 0; n < size * 4 && n < 90; n++) {
    if (claimable(world, x, y, bases) && !cutsTheMap(world, x, y, bases)) {
      world.cliff[y * world.width + x] = 1;
      setBlocked(world, x, y, BLOCK_TERRAIN);
      size--;
      if (size <= 0) return;
    }
    // A step of one tile on one axis. dirVec would give a smooth heading and
    // this deliberately does not want one: four-way steps keep the blob on the
    // grid the cliff mask is drawn from, so the faces meet cleanly.
    const d = rng.int(0, 3);
    x += d === 0 ? 1 : d === 1 ? -1 : 0;
    y += d === 2 ? 1 : d === 3 ? -1 : 0;
    if (x < 4 || y < 4 || x >= world.width - 4 || y >= world.height - 4) return;
  }
}

/** May a cliff stand on this tile at all? Cheap tests only — see cutsTheMap. */
function claimable(world, x, y, bases) {
  if (!inBounds(world, x, y)) return false;
  const i = y * world.width + x;
  if (world.cliff[i]) return false;
  // Water is already impassable and a cliff drawn into a lake would be a rock
  // standing in the sea with no shoreline under it.
  if (world.terrain[i] === TERRAIN.WATER) return false;
  if (world.blocked[i] !== 0) return false;
  for (const b of bases) {
    const dx = x - b.x;
    const dy = y - b.y;
    if (dx * dx + dy * dy < CLIFF_MIN_BASE_DIST * CLIFF_MIN_BASE_DIST) return false;
  }
  return true;
}

/**
 * Would blocking this tile disconnect the two bases?
 *
 * THIS CHECK IS NOT OPTIONAL AND IT IS WHY THIS FEATURE IS SAFE. A random walk
 * that happens to close the last gap between two ridges produces a map where
 * one player simply cannot reach the other: no raids, no waves, no victory
 * condition reachable, and a ten-minute match that ends in a timeout with two
 * untouched economies. It would happen rarely — which is worse than often,
 * because it would happen to a player and not to us.
 *
 * So: claim the tile provisionally, flood fill from one Town Center, and put it
 * back if the other one is no longer reachable. A flood over 9216 tiles is a
 * few tens of microseconds and this runs at most a few hundred times during
 * generation, once per match.
 *
 * The flood is a plain queue over the block grid — no diagonals, matching the
 * pathfinder's own connectivity — and it deliberately does NOT use findPath:
 * this asks whether ground is connected at all, which is a cheaper question
 * than the route, and it must stay answerable before any unit exists.
 */
function cutsTheMap(world, x, y, bases) {
  const W = world.width;
  const H = world.height;
  const i = y * W + x;
  const was = world.blocked[i];
  world.blocked[i] = BLOCK_TERRAIN;

  const from = bases[0];
  const to = bases[1];
  const seen = new Uint8Array(W * H);
  // Reused across the whole generation would be faster; allocated per call is
  // 9KB of short-lived typed array a few hundred times, which is nothing beside
  // the rest of map generation and keeps this function pure.
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  const start = from.y * W + from.x;
  queue[tail++] = start;
  seen[start] = 1;
  let reached = false;
  while (head < tail) {
    const cur = queue[head++];
    const ux = cur % W;
    const uy = (cur - ux) / W;
    if (ux === to.x && uy === to.y) { reached = true; break; }
    for (let k = 0; k < 4; k++) {
      const nx = ux + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const ny = uy + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (seen[ni]) continue;
      // A closed gate is passable-in-principle ground for this question: gates
      // do not exist during map generation, but reading the grid rather than
      // testing for zero keeps this honest if that ever changes.
      if (world.blocked[ni] !== 0) continue;
      seen[ni] = 1;
      queue[tail++] = ni;
    }
  }

  world.blocked[i] = was;
  return !reached;
}

/**
 * Dry the ground out under and around the rock.
 *
 * Grass running right up to the foot of a cliff and stopping dead is the tell
 * that the rock was pasted on afterwards — which it was. A tile of dirt under
 * every cliff and a scatter of it on the tiles immediately around gives the
 * outcrop a bit of scree to sit in, and the terrain bake's own transition
 * washes then do the blending for free.
 */
function stampCliffTerrain(world) {
  const { rng } = world;
  const W = world.width;
  const H = world.height;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (world.cliff[i]) {
        world.terrain[i] = TERRAIN.DIRT;
        continue;
      }
      if (world.terrain[i] === TERRAIN.WATER) continue;
      // Adjacent to rock, two thirds of the time. Not always, or the scree is
      // a neat one-tile border — which is the diamond outline again.
      let near = false;
      for (let k = 0; k < 4 && !near; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (world.cliff[ny * W + nx]) near = true;
      }
      if (near && rng.chance(0.66)) world.terrain[i] = TERRAIN.DIRT;
    }
  }
}

function placeCluster(world, cx, cy, type, count, bases, minBaseDist) {
  const { rng } = world;
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < count * 14) {
    attempts++;
    const x = Math.round(cx + rng.range(-1.6, 1.6));
    const y = Math.round(cy + rng.range(-1.6, 1.6));
    if (!freeSpot(world, x, y, bases, minBaseDist)) continue;
    spawnResource(world, type, x, y);
    placed++;
  }
}

function buildBase(world, base) {
  const { player, x, y } = base;

  // Clear the ground the Town Center and its immediate surroundings need.
  clearArea(world, x, y, 3.2);

  const tc = spawnBuilding(world, 'towncenter', player, x, y);

  // Berries: the opening food source, placed just off the Town Center, plus a
  // second patch a little further out. Food is finite — with only the opening
  // patch both economies run dry around the six minute mark and armies decay
  // into archers, which cost no food.
  //
  // Eleven bushes held 2200 food, which fed a whole match on its own and made
  // the Farm — the renewable food source the wood economy is supposed to feed
  // into — something you never had to build. Seven is enough to open on and
  // run out with, which is the point at which farms become a decision.
  const dir = player === PLAYER ? 1 : -1;
  placeCluster(world, x - 5 * dir, y + 3 * dir, 'berry', 4, [], 0);
  placeCluster(world, x + 4 * dir, y + 7 * dir, 'berry', 3, [], 0);

  // Three starting villagers, fanned out in front of the Town Center.
  const spawned = [];
  for (let i = 0; i < 3; i++) {
    // These coordinates are NOT rounded to tiles — they are the villagers'
    // exact starting positions, handed straight to spawnUnit. Computed through
    // Math.cos they would differ in the last bit between engines, which means
    // two peers in a lockstep match would start the game with their villagers
    // at measurably different places, before a single order is given. A literal
    // table removes the whole class of problem: index 6 of 64 is ~0.59 rad
    // (the old 0.6) and the enemy's 3.7 rad is 21 sixty-fourths further round.
    const d = dirVec((player === PLAYER ? 6 : 38) + Math.round((DIR_COUNT * i) / 3));
    const ux = x + d[0] * 2.6;
    const uy = y + d[1] * 2.6;
    spawned.push(spawnUnit(world, 'villager', player, ux, uy));
  }

  return { tc, villagers: spawned };
}

function clearArea(world, cx, cy, r) {
  const r2 = r * r;
  // Remove resource nodes overlapping the area so the base is not walled in.
  for (const e of world.resources.slice()) {
    const dx = e.x - cx;
    const dy = e.y - cy;
    if (dx * dx + dy * dy <= r2) {
      const tx = Math.floor(e.x);
      const ty = Math.floor(e.y);
      world.blocked[ty * MAP_W + tx] = 0;
      world.occupant[ty * MAP_W + tx] = 0;
      const i = world.resources.indexOf(e);
      if (i >= 0) world.resources.splice(i, 1);
      world.entities.delete(e.id);
      e.dead = true;
    }
  }
  // And flatten water, which would otherwise be unbuildable.
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (!inBounds(world, x, y)) continue;
      const i = y * MAP_W + x;
      if (world.terrain[i] === TERRAIN.WATER) {
        world.terrain[i] = TERRAIN.GRASS;
        world.blocked[i] = 0;
      }
    }
  }
}
