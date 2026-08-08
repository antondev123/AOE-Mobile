// Shared constants: projection, balance, and visual tuning.
// Every system reads from here — do not hardcode these numbers elsewhere.

// --- Isometric projection ---------------------------------------------------
// A tile is a diamond TILE_W wide and TILE_H tall on screen.
export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;

// --- Map --------------------------------------------------------------------
// AoE2's smallest two-player map is 120x120. 96 is the largest square that
// still keeps this honest on a phone: the A* grid is 9216 tiles (four times the
// old 48x48, still well inside the search budget in pathfinding.js), the baked
// terrain is 6272x3168 world pixels, and the two bases end up ~85 tiles apart —
// about 75 seconds of marching for a militia, which is the point. At 48 the
// enemy's first wave was on top of you before you had finished walling your
// wood line, and there was nowhere to expand to because the whole map was your
// two starting corners touching in the middle.
export const MAP_W = 96;
export const MAP_H = 96;

export const TERRAIN = {
  GRASS: 0,
  DIRT: 1,
  WATER: 2,
  SAND: 3,
};

// --- Players ----------------------------------------------------------------
export const PLAYER = 0;
export const ENEMY = 1;

export const PLAYER_COLORS = [0x3d8bfd, 0xe03131];
export const PLAYER_COLORS_DARK = [0x1f5fbf, 0x9c1c1c];

// --- Resources --------------------------------------------------------------
export const RES = { FOOD: 'food', WOOD: 'wood', GOLD: 'gold', STONE: 'stone' };

// AoE2 opens most starts on 200 stone. 150 is the compressed-skirmish figure:
// this match is ten minutes rather than forty, and stone has exactly one job —
// paying for the defensive buildings a later system adds — so a start that
// covers roughly one of them, with the rest quarried, keeps the first stone
// mine a decision rather than a formality.
export const STARTING_RESOURCES = { food: 250, wood: 250, gold: 150, stone: 150 };

// Villager carry capacity per resource trip.
export const CARRY_CAPACITY = 10;
// Relative harvest speeds, NOT units per second. economy.js scales these by its
// own GATHER_SPEED multiplier. The ordering is AoE2's: food fastest, then wood,
// then the two things you dig out of the ground, with stone the slowest of all
// (it is the scarcest and the most defensive). What a player actually sees at
// the shipped GATHER_SPEED, measured beside a Town Center: a full 10-unit pack
// takes 7.3s on berries, 8.0s on wood, 8.9s on gold and 9.5s on stone, and a
// round trip of 3-4 tiles each way adds ~5s on top. Change the ratios here;
// change the absolute pace in economy.js.
export const GATHER_RATE = { food: 0.55, wood: 0.5, gold: 0.45, stone: 0.42 };

// How much a node holds before it is exhausted.
// Gold is deliberately scarce: only soldiers cost it, so a rich vein just banks
// thousands of unspendable coins. Food is the early bottleneck but has to last,
// or both economies drift into all-archer armies once the berries die. Stone is
// scarcer still — a mine is two thirds of a gold vein — because its sinks are
// few and expensive, and a stone mine you have to walk out and take is a much
// better reason to leave your base than one more bush.
export const NODE_AMOUNT = { tree: 100, berry: 200, gold: 320, stone: 220 };

// --- Population -------------------------------------------------------------
export const POP_PER_HOUSE = 5;
// There is no separate starting cap: the population cap is always the sum of
// what your standing buildings provide, so a lone Town Center opens you at 3/5
// and housing up is the first thing you do. That is the AoE2 dark-age opening.
//
// 200 is AoE2's default cap. It is a *ceiling*, not a target: reaching it needs
// 39 houses, which nobody builds in a ten-minute skirmish. What it buys is that
// the cap stops being the thing that ends the game — on the 96x96 map there is
// room for two 100-unit armies to meet, and the old 50 turned that fight into
// an accounting error long before either economy ran out.
export const MAX_POP_CAP = 200;

// --- Unit / building stats --------------------------------------------------
// speed is in tiles/second. range/radius in tiles.
//
// PACING. Everything below was retuned in one pass with GATHER_SPEED in
// economy.js, and the three numbers only make sense together. The old tuning
// was an arcade compression of AoE2: a pack filled in 3 seconds, a villager
// trained in 8, and a house went up in 10, which meant the first four minutes
// were a clicking exercise with no gap in which to decide anything.
//
// The rhythm now: a villager banks a load roughly every 13 seconds, so three
// starting villagers earn about 2.3 resources/second between them, and a 50-food
// villager is ~22 seconds of that economy. Train times are set just under what
// the economy can pay for, so a Town Center left on repeat stays busy rather
// than idling on an empty stockpile — which is the failure mode a slower game
// invites and the reason training could not simply be left where it was.
//
// Movement is only ~10% slower. It is the one number that must not be halved:
// walking is dead time, and doubling it would have paid for the extra thinking
// room with boredom instead of with decisions.
export const UNIT_STATS = {
  villager: {
    name: 'Villager',
    hp: 30, speed: 1.35, radius: 0.32,
    attack: 3, range: 0.6, attackCooldown: 1.2, armor: 0,
    cost: { food: 50, wood: 0, gold: 0 },
    // AoE2 trains a villager in 25s. 16 is that, scaled to a ten-minute match:
    // the opening Town Center can turn 250 starting food into five villagers in
    // 80 seconds, which is the same shape of opening, an age compressed.
    buildTime: 16,
    pop: 1,
  },
  militia: {
    name: 'Militia',
    hp: 45, speed: 1.1, radius: 0.36,
    attack: 6, range: 0.7, attackCooldown: 1.1, armor: 1,
    cost: { food: 60, wood: 0, gold: 20 },
    buildTime: 22,
    pop: 1,
  },
  archer: {
    name: 'Archer',
    hp: 32, speed: 1.2, radius: 0.32,
    attack: 5, range: 4.5, attackCooldown: 1.5, armor: 0,
    cost: { food: 0, wood: 25, gold: 45 },
    buildTime: 24,
    pop: 1,
    projectile: true,
  },
};

export const BUILDING_STATS = {
  towncenter: {
    name: 'Town Center',
    hp: 900, fw: 3, fh: 3,
    cost: { food: 0, wood: 275, gold: 0 },
    buildTime: 60,
    trains: ['villager'],
    // The Town Center takes everything. Every other drop-off exists to save a
    // walk, never to unlock a resource.
    dropoff: ['food', 'wood', 'gold', 'stone'],
    popBonus: 5,
    lineOfSight: 8,
  },
  house: {
    name: 'House',
    hp: 320, fw: 2, fh: 2,
    cost: { food: 0, wood: 25, gold: 0 },
    buildTime: 20,
    trains: [],
    popBonus: POP_PER_HOUSE,
    lineOfSight: 4,
  },
  barracks: {
    name: 'Barracks',
    hp: 700, fw: 3, fh: 3,
    cost: { food: 0, wood: 175, gold: 0 },
    buildTime: 38,
    trains: ['militia', 'archer'],
    lineOfSight: 5,
  },
  farm: {
    name: 'Farm',
    hp: 120, fw: 2, fh: 2,
    cost: { food: 0, wood: 60, gold: 0 },
    // 15 seconds, which is AoE2's farm build time exactly — the one number that
    // needed no compressing, because a field has to be replaceable the moment
    // it runs out or the food line stalls on the rebuild.
    buildTime: 15,
    trains: [],
    lineOfSight: 2,
    // A farm is a building you gather food from until it is exhausted, then
    // rebuild. It is what stops food being a cliff once the berries die, and
    // it is the sink that gives late-game wood somewhere to go.
    provides: { type: 'food', amount: 300 },
  },
  mill: {
    name: 'Mill',
    hp: 400, fw: 2, fh: 2,
    cost: { food: 0, wood: 100, gold: 0 },
    buildTime: 24,
    trains: [],
    dropoff: ['food'],
    lineOfSight: 4,
  },
  // --- Forward drop-offs ----------------------------------------------------
  //
  // The Lumber Camp and the Mining Camp are AoE2's answer to the one thing that
  // silently ruins an economy: the walk. A villager's income is capped by its
  // round trip, and on a 96x96 map the woodline you are working at minute six is
  // fifteen tiles from the Town Center — which is twenty-two seconds of walking
  // for eight seconds of chopping. Planting a camp beside the trees turns that
  // back into a two-tile hop, and villagers pick the nearer drop-off by
  // themselves (see nearestDropoff in economy.js), so the building is the whole
  // order: no re-tasking, no micromanagement.
  //
  // Both cost AoE2's 100 wood, both are 2x2 so they tuck into a woodline or a
  // gold patch without needing a clearing, and both go up in 18 seconds —
  // deliberately the fastest buildings in the game after a farm, because a camp
  // is a thing you build *in reaction to* a walk that has already got too long,
  // and a slow one would be answering a question the player has stopped asking.
  lumbercamp: {
    name: 'Lumber Camp',
    hp: 380, fw: 2, fh: 2,
    cost: { food: 0, wood: 100, gold: 0 },
    buildTime: 18,
    trains: [],
    dropoff: ['wood'],
    lineOfSight: 4,
  },
  miningcamp: {
    name: 'Mining Camp',
    hp: 380, fw: 2, fh: 2,
    cost: { food: 0, wood: 100, gold: 0 },
    buildTime: 18,
    trains: [],
    // One building for both things you dig out of the ground, exactly as in
    // AoE2. Gold and stone sit in the same kind of place on the map, and asking
    // a player to plant two separate huts on one hillside is bookkeeping, not a
    // decision.
    dropoff: ['gold', 'stone'],
    lineOfSight: 4,
  },
};

// Buildings a villager may place, in the order the build menu lists them.
//
// This is the *candidate* list, not the available one. Two filters run over it:
//
//   * anything with no entry in BUILDING_STATS is skipped outright, so a name
//     below that is not a building yet costs nothing and slots itself in the
//     moment one is added;
//   * what survives is gated by age (systems/tech.js, AGE_UNLOCKS), which is
//     what actually decides whether the player may place it today.
//
// The second half of the list is deliberately forward-declared: the Castle, the
// walls, the tower, the Market and the military buildings are landing from
// another pass, and naming them here — with the two or three plausible keys
// each, since their spelling is not settled — means the build menu, the age
// gating and the placement rules all pick them up with no edit. An unrecognised
// key is inert; a duplicate is impossible because BUILDING_STATS has one entry
// per building whatever it is called.
export const BUILDABLE = [
  // Standing today.
  'house', 'farm', 'mill', 'lumbercamp', 'miningcamp', 'barracks', 'towncenter',
  // Dark Age, expected.
  'palisade', 'palisadewall',
  // Feudal Age, expected.
  'archeryrange', 'stable', 'blacksmith', 'market',
  'watchtower', 'tower', 'stonewall', 'wall', 'gate',
  // Castle Age, expected.
  'castle', 'siegeworkshop', 'university', 'monastery', 'keep',
];

// Villagers contribute this much build progress per second (per builder).
export const BUILD_RATE = 1.0;

// --- Combat -----------------------------------------------------------------
// Units auto-acquire hostile targets within this radius while idle/standing.
export const AGGRO_RANGE = 5.0;
// Once engaged, a unit chases at most this far from where it started.
export const CHASE_LEASH = 7.0;
export const PROJECTILE_SPEED = 9.0; // tiles/sec
export const MIN_DAMAGE = 1;

// --- Simulation -------------------------------------------------------------
// Fixed logic step. Rendering interpolates between steps.
export const SIM_HZ = 20;
export const SIM_DT = 1 / SIM_HZ;
// Never advance more than this many sim steps in one frame (spiral guard).
export const MAX_STEPS_PER_FRAME = 5;

// --- Camera / view ----------------------------------------------------------
export const ZOOM_MIN = 0.55;
export const ZOOM_MAX = 1.9;
// At 1.0 a phone sees ~229 tiles: your Town Center, three villagers and a wall
// of trees, but typically only four berry bushes and one gold — too tight to
// read your own opening. 0.7 shows ~337 tiles, enough for your base and the
// resources around it. Exactly which resources land on screen varies by seed.
export const ZOOM_DEFAULT = 0.7;

// --- Input tuning (touch-first) --------------------------------------------
// A pointer that moves less than this (screen px) counts as a tap, not a drag.
export const TAP_SLOP = 12;
// A press shorter than this is a tap.
export const TAP_TIME_MS = 300;
// Drag-box selection only begins after the pointer exceeds this.
export const DRAG_BOX_THRESHOLD = 14;
// Fat-finger radius: tapping selects the best entity within this many screen px.
export const TAP_PICK_RADIUS = 34;
