// Shared constants: projection, balance, and visual tuning.
// Every system reads from here — do not hardcode these numbers elsewhere.

// --- Isometric projection ---------------------------------------------------
// A tile is a diamond TILE_W wide and TILE_H tall on screen.
export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;

// --- Map --------------------------------------------------------------------
export const MAP_W = 48;
export const MAP_H = 48;

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
export const RES = { FOOD: 'food', WOOD: 'wood', GOLD: 'gold' };

export const STARTING_RESOURCES = { food: 250, wood: 250, gold: 150 };

// Villager carry capacity per resource trip.
export const CARRY_CAPACITY = 10;
// Units of resource harvested per second while gathering.
export const GATHER_RATE = { food: 0.55, wood: 0.5, gold: 0.45 };

// How much a node holds before it is exhausted.
// Gold is deliberately the scarcest: only soldiers cost it, so a rich vein just
// banks thousands of unspendable coins. Food is the early bottleneck but has to
// last, or both economies drift into all-archer armies once the berries die.
export const NODE_AMOUNT = { tree: 100, berry: 200, gold: 320 };

// --- Population -------------------------------------------------------------
export const POP_PER_HOUSE = 5;
export const START_POP_CAP = 10;
export const MAX_POP_CAP = 50;

// --- Unit / building stats --------------------------------------------------
// speed is in tiles/second. range/radius in tiles.
export const UNIT_STATS = {
  villager: {
    name: 'Villager',
    hp: 30, speed: 1.5, radius: 0.32,
    attack: 3, range: 0.6, attackCooldown: 1.2, armor: 0,
    cost: { food: 50, wood: 0, gold: 0 },
    buildTime: 8,
    pop: 1,
  },
  militia: {
    name: 'Militia',
    hp: 45, speed: 1.25, radius: 0.36,
    attack: 6, range: 0.7, attackCooldown: 1.1, armor: 1,
    cost: { food: 60, wood: 0, gold: 20 },
    buildTime: 11,
    pop: 1,
  },
  archer: {
    name: 'Archer',
    hp: 32, speed: 1.35, radius: 0.32,
    attack: 5, range: 4.5, attackCooldown: 1.5, armor: 0,
    cost: { food: 0, wood: 25, gold: 45 },
    buildTime: 12,
    pop: 1,
    projectile: true,
  },
};

export const BUILDING_STATS = {
  towncenter: {
    name: 'Town Center',
    hp: 900, fw: 3, fh: 3,
    cost: { food: 0, wood: 275, gold: 0 },
    buildTime: 30,
    trains: ['villager'],
    dropoff: ['food', 'wood', 'gold'],
    popBonus: 5,
    lineOfSight: 8,
  },
  house: {
    name: 'House',
    hp: 320, fw: 2, fh: 2,
    cost: { food: 0, wood: 25, gold: 0 },
    buildTime: 10,
    trains: [],
    popBonus: POP_PER_HOUSE,
    lineOfSight: 4,
  },
  barracks: {
    name: 'Barracks',
    hp: 700, fw: 3, fh: 3,
    cost: { food: 0, wood: 175, gold: 0 },
    buildTime: 20,
    trains: ['militia', 'archer'],
    lineOfSight: 5,
  },
  farm: {
    name: 'Farm',
    hp: 120, fw: 2, fh: 2,
    cost: { food: 0, wood: 60, gold: 0 },
    buildTime: 8,
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
    buildTime: 12,
    trains: [],
    dropoff: ['food'],
    lineOfSight: 4,
  },
};

// Buildings a villager may place.
export const BUILDABLE = ['house', 'farm', 'barracks', 'mill', 'towncenter'];

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
// of trees, but only four berry bushes and one gold — you cannot read your own
// opening. 0.7 shows ~337 tiles, which puts food, wood and gold on screen at
// once, the way an AoE2 start is meant to be read.
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
