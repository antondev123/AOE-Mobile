// Shared constants: projection, balance, and visual tuning.
// Every system reads from here — do not hardcode these numbers elsewhere.

// --- Isometric projection ---------------------------------------------------
// A tile is a diamond TILE_W wide and TILE_H tall on screen.
export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;

// --- Map --------------------------------------------------------------------
//
// AoE2's smallest two-player map is 120x120. 96 is the largest square that still
// keeps a *two-player* match honest on a phone: the A* grid is 9216 tiles (four
// times the old 48x48, still well inside the search budget in pathfinding.js),
// the baked terrain is 6272x3168 world pixels, and the two bases end up ~85 tiles
// apart — about 75 seconds of marching for a militia, which is the point. At 48
// the enemy's first wave was on top of you before you had finished walling your
// wood line, and there was nowhere to expand to because the whole map was your
// two starting corners touching in the middle.
//
// THESE ARE DEFAULTS, NOT THE MAP. They were `MAP_W`/`MAP_H` and were imported
// directly by a dozen files, which is why a match had exactly one possible size.
// The world carries its own `width`/`height` now and everything that draws,
// paths, bins or indexes must read those. The rename is the enforcement: a site
// that still wants the constant has to say `DEFAULT_` out loud, and a site that
// forgot to be updated throws a ReferenceError at import rather than quietly
// laying out a 192-tile map on a 96-tile grid — which does not crash, it just
// makes half the world invisible to the spatial index.
export const DEFAULT_MAP_W = 96;
export const DEFAULT_MAP_H = 96;

/** Most seats a match can have. Eight is AoE2's, and the atlas budget's. */
export const MAX_PLAYERS = 8;

/**
 * How big a map should be for a given number of players.
 *
 * Area per player is held at what two players get on 96x96, because that is the
 * figure everything else in this file was tuned against: the walk to the middle,
 * how long a militia takes to cross, how much wood is inside a base's pocket,
 * and how far apart `BASE_OFFSET` puts two town centers. Scaling area linearly
 * with the roster keeps all of that true at any seat count — eight players get
 * four times the tiles of two, and each of them still opens on the same amount
 * of ground.
 *
 * Rounded to a multiple of 8 so both bucket grids in core/world.js divide evenly
 * (4 tiles a cell for the mixed index, 2 for the units-only one), and capped at
 * 192: past that the terrain bake and the per-player fog masks start costing
 * more than a phone has, and the far corners are further away than a ten-minute
 * match can reach anyway.
 *
 *   2 -> 96   3 -> 120   4 -> 136   5 -> 152   6 -> 168   7 -> 176   8 -> 192
 */
export function mapSizeFor(playerCount) {
  const n = Math.max(2, Math.min(MAX_PLAYERS, playerCount | 0));
  const side = DEFAULT_MAP_W * Math.sqrt(n / 2);
  return Math.max(DEFAULT_MAP_W, Math.min(192, Math.round(side / 8) * 8));
}

export const TERRAIN = {
  GRASS: 0,
  DIRT: 1,
  WATER: 2,
  SAND: 3,
};

// --- Players ----------------------------------------------------------------
//
// PLAYER and ENEMY are seat *numbers*, and they survive only as the default
// two-seat roster's names — for mapgen's fallback, for tests that want to say
// "the other one", and for the single-player skirmish. Nothing that draws or
// decides should use them to mean "me": the local seat is ME in
// core/viewpoint.js, and with eight seats "the enemy" is a question about teams
// rather than a constant. See core/teams.js.
export const PLAYER = 0;
export const ENEMY = 1;

// Eight colours, and every one of them has to survive three hostile conditions:
// a 160x160 minimap where a player is three pixels, the fog's dimming, and a
// phone screen outdoors. So they are picked around the hue circle at high
// chroma, avoiding the two hues the map itself already owns — the grass greens
// and the sand/dirt tans — which is why there is no green and no brown here.
//
// The first two are unchanged. A 1v1 must look exactly as it always has, and
// blue-against-red is the one pairing every RTS player already reads without
// being told.
export const PLAYER_COLORS = [
  0x3d8bfd, // 1 blue
  0xe03131, // 2 red
  0xf4b400, // 3 gold
  0xa64dd6, // 4 purple
  0x18b3a8, // 5 teal
  0xff7a1a, // 6 orange
  0xf06fb0, // 7 pink
  0xd8dee9, // 8 grey
];
// The shaded half of every sprite, and the minimap's incomplete-building fill.
// Each is its colour taken down in value and slightly in chroma, rather than
// blended toward black, so a unit reads as one material lit from one side.
export const PLAYER_COLORS_DARK = [
  0x1f5fbf, // 1
  0x9c1c1c, // 2
  0xa87a06, // 3
  0x6f2f95, // 4
  0x0d7a72, // 5
  0xb04f07, // 6
  0xa8447a, // 7
  0x8d94a1, // 8
];

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
// --- Armour classes ---------------------------------------------------------
//
// AoE2's counter system is not "cavalry is strong": it is a table of *bonuses*
// keyed by what you are and what you are hitting. Every unit carries an
// `armorClass` — the thing it counts as when it is being hit — and BONUS_DAMAGE
// below says what each attacker adds against each class. That indirection is
// what lets a new unit slot into the triangle by declaring one string, instead
// of every existing unit growing a clause about it.
export const ARMOR_CLASS = {
  VILLAGER: 'villager',
  INFANTRY: 'infantry',
  ARCHER: 'archer',
  CAVALRY: 'cavalry',
  SIEGE: 'siege',
  BUILDING: 'building',
};
// A unit whose stats block forgets to say. Infantry is the safe default: it is
// the class the most bonuses point at, so a missing declaration makes a unit
// slightly *weaker* than intended rather than accidentally immune to the whole
// counter table.
export const DEFAULT_ARMOR_CLASS = ARMOR_CLASS.INFANTRY;
// Buildings do not live in UNIT_STATS and BUILDING_STATS belongs to another
// pass, so masonry is classified here rather than per building.
export const BUILDING_ARMOR_CLASS = ARMOR_CLASS.BUILDING;

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
    // Its own class, deliberately, so that "archers beat infantry" does not
    // quietly also mean "archers massacre villagers". A raid on a wood line is
    // already one-sided; it does not need a damage bonus on top.
    armorClass: ARMOR_CLASS.VILLAGER,
    lineOfSight: 4,
  },
  militia: {
    name: 'Militia',
    hp: 45, speed: 1.1, radius: 0.36,
    attack: 6, range: 0.7, attackCooldown: 1.1, armor: 1,
    cost: { food: 60, wood: 0, gold: 20 },
    buildTime: 22,
    pop: 1,
    armorClass: ARMOR_CLASS.INFANTRY,
    lineOfSight: 4,
    military: true,
  },
  // The anti-cavalry pike. Cheap, slow, and almost useless on its own: 4 attack
  // against a militia's 6 is a losing trade in every fight except the one it is
  // for. That is the point — a counter unit that is also fine in a straight
  // brawl is not a counter, it is just a better unit, and the player never has
  // to look at what the enemy fielded.
  spearman: {
    name: 'Spearman',
    hp: 45, speed: 1.0, radius: 0.34,
    attack: 4, range: 0.9, attackCooldown: 1.4, armor: 0,
    cost: { food: 35, wood: 25, gold: 0 },
    buildTime: 20,
    pop: 1,
    armorClass: ARMOR_CLASS.INFANTRY,
    lineOfSight: 4,
    military: true,
  },
  archer: {
    name: 'Archer',
    hp: 32, speed: 1.2, radius: 0.32,
    attack: 5, range: 4.5, attackCooldown: 1.5, armor: 0,
    cost: { food: 0, wood: 25, gold: 45 },
    buildTime: 24,
    pop: 1,
    projectile: true,
    armorClass: ARMOR_CLASS.ARCHER,
    // Six, not five: the one hard rule the fog imposes is that a unit must see
    // further than it shoots (range 4.5), or it auto-acquires targets its owner
    // cannot see. See the invariant test in tests/military.test.mjs.
    lineOfSight: 6,
    military: true,
  },
  // The scout/knight line. Fast and tough rather than hard-hitting: 1.7 tiles a
  // second is half again a militia's pace, which is what makes cavalry the unit
  // that reaches an archer line before it has fired four volleys, and the unit
  // that arrives at a raid on the far gold while it is still happening.
  scout: {
    name: 'Scout Cavalry',
    hp: 60, speed: 1.7, radius: 0.4,
    attack: 5, range: 0.8, attackCooldown: 1.3, armor: 1,
    cost: { food: 80, wood: 0, gold: 0 },
    buildTime: 26,
    pop: 1,
    armorClass: ARMOR_CLASS.CAVALRY,
    // Seven. A scout that cannot see further than everything else is not a
    // scout, and with fog of war this is the unit a player actually opens the
    // map with.
    lineOfSight: 7,
    military: true,
  },
  // Siege. A battering ram is not a soldier: 3 attack means it cannot kill
  // anything that moves, and 200 hitpoints behind 4 armour means very little
  // that moves can kill it quickly either. Its whole existence is the +40
  // against masonry below, which turns a Town Center from a two-minute chore
  // into a thirty-second one.
  ram: {
    name: 'Battering Ram',
    hp: 200, speed: 0.65, radius: 0.5,
    attack: 3, range: 1.2, attackCooldown: 3.0, armor: 4,
    cost: { food: 0, wood: 160, gold: 75 },
    buildTime: 36,
    // Two, not one. A ram is a siege engine crewed by several men and it should
    // cost more of the army it travels with than a spearman does.
    pop: 2,
    armorClass: ARMOR_CLASS.SIEGE,
    // Three, as in AoE2. A ram is blind and slow and is meant to be escorted;
    // still comfortably past its own 1.2 reach.
    lineOfSight: 3,
    military: true,
  },
};

/**
 * Damage bonuses, attacker unit type -> target armour class.
 *
 * Read at the moment of the swing and added to `attack` *before* armour is
 * subtracted, so the formula stays the one number a player can do in their
 * head: max(MIN_DAMAGE, attack + bonus - armor).
 *
 * The three numbers that carry the counter triangle are the spearman's +12
 * against cavalry, the scout's +5 against archers and the archer's +4 against
 * infantry. Two of those three are not AoE2's — AoE2's archers and cavalry beat
 * infantry and archers respectively through *movement*: kiting, and closing
 * distance faster than a bow can fire. Neither of those exists on a phone. There
 * is no kiting AI, there is no per-unit micro, and a player giving a group order
 * with one thumb is never going to pull five archers back a tile at a time. So
 * the counters that AoE2 gets for free out of its control scheme are paid for
 * here in the bonus table, where they are legible: tap a unit, read the number,
 * know what it is for. The spearman's +12 *is* AoE2's (+15 vs cavalry, trimmed
 * because a scout here has 60 hitpoints rather than a knight's 100).
 *
 * The +2..+4 against siege is the other half of "siege is not a soldier": a ram
 * left unescorted is meant to die to whatever finds it.
 */
export const BONUS_DAMAGE = {
  spearman: { cavalry: 12, siege: 4 },
  scout: { archer: 5, siege: 2 },
  archer: { infantry: 4, siege: 2 },
  militia: { siege: 3 },
  // 3 + 40 against a 900-hitpoint Town Center is 21 swings, a minute of work
  // for one ram — long enough that the defender gets to answer it, short enough
  // that bringing two is a plan.
  ram: { building: 40 },
};

/** Every unit type that counts as an army, in table order. */
export const MILITARY_TYPES = Object.keys(UNIT_STATS).filter((t) => UNIT_STATS[t].military);

/** Is this unit type a soldier rather than a worker? */
export function isMilitaryType(type) {
  const s = UNIT_STATS[type];
  return !!(s && s.military);
}

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
    // Four units at one building, and two of them do not belong here.
    //
    // The Archery Range, the Stable and the Siege Workshop are named in
    // tech.js's age tables and in BUILDABLE, but they are landing from another
    // pass. Until they do, a roster that only the barracks can reach is a
    // roster nobody can play with: the counter triangle needs cavalry on the
    // map for spearmen to mean anything, and an enemy AI that cannot train a
    // scout cannot be made to respond to an archer mass. The archer was already
    // here as exactly this stopgap; the scout joins it on the same terms. Both
    // move to their proper buildings the day those exist — see
    // HANDOFF-military.md, which lists the one-line change.
    //
    // The ram is deliberately *not* here. A barracks building a siege engine is
    // a step too far, and unlike cavalry the ram's absence costs the counter
    // triangle nothing.
    trains: ['militia', 'spearman', 'archer', 'scout'],
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

  // --- The Market: where a surplus becomes something else ---------------------
  //
  // AoE2's costs exactly: 175 wood, which is a Barracks, and that is the right
  // comparison to make a player weigh — the Market is the second building you
  // choose in the Feudal Age, against more soldiers.
  //
  // 3x3 rather than AoE2's 4x4. The footprint rule on this map is that anything
  // wider than three tiles is a building the AI (and, on a 390px screen, the
  // player) struggles to find ground for, which is why the Castle is the only
  // 4x4 in the game and why it costs 250 stone to be one. A Market a player
  // cannot place is a Market a player does not build.
  //
  // No dropoff. A Market that banked resources would be a Town Center with a
  // trade menu, and the walk it saved would quietly become the reason to build
  // one — which is not what it is for. See systems/market.js.
  market: {
    name: 'Market',
    hp: 600, fw: 3, fh: 3,
    cost: { food: 0, wood: 175, gold: 0, stone: 0 },
    // AoE2 spends 60 seconds on it. 40 is the same fraction of a ten-minute
    // match, and it is deliberately slower than the Barracks it competes with:
    // the Market pays out for the rest of the game, so it should cost you the
    // window it goes up in.
    buildTime: 40,
    trains: [],
    lineOfSight: 6,
  },

  // --- Defences: what stone is actually for -----------------------------------
  //
  // Until this pass stone was a resource with no sink. Two ten-minute
  // simulations both ended with 150 stone in the bank — the exact figure both
  // players started with, untouched, because nothing in the game cost any. The
  // five buildings below are the sink, and they are AoE2's five: the wooden
  // fence you throw up in the Dark Age, the stone wall and the tower that follow
  // it, the gates that make either wall a wall you can live behind, and the
  // Castle at the end of the line.
  //
  // COSTS. AoE2's own numbers wherever the economy can carry them (a palisade is
  // 2 wood, a stone wall is 5 stone, a stone gate is 30 stone — those are exact),
  // and cut where it cannot. The two that are cut are the Watch Tower (125 stone
  // + 25 wood in AoE2) and the Castle (650 stone). Measured against the shipped
  // economy: a villager on stone banks roughly 0.7 stone a second including its
  // walk, so AoE2's 650 is fifteen villager-minutes — longer than the whole
  // match. 250 is about four minutes of two villagers on a mine, which is a
  // project you commit to in the Castle Age and not a number you look at once
  // and dismiss. The opening 150 stone buys a tower, or thirty wall segments, or
  // most of a Castle's first instalment: enough that the first stone mine is a
  // decision rather than a formality, which is exactly what the comment on
  // STARTING_RESOURCES has always promised and could not previously deliver.
  //
  // FOOTPRINTS. Every wall piece is 1x1, so a run of them tiles the grid with no
  // gaps; the Castle is AoE2's 4x4. Nothing here is 2x2, because a 2x2 "wall"
  // cannot turn a corner without leaving a hole.
  //
  // `wall: true` marks a piece that joins up with its neighbours — see
  // wallMaskAt() in core/world.js, which picks the connected sprite from which
  // of the four axis neighbours are also walls. `gate: true` additionally marks
  // a piece that is passable for its owner; see the block-grid note in world.js.
  palisade: {
    name: 'Palisade',
    // 250 hp in AoE2 against a 900-hp house; here a house is 320, so the same
    // ratio lands at 90. Five militia chew through a segment in about three
    // seconds, which is the point of a palisade: it buys you the time to react
    // to a drush, it does not stop one.
    hp: 90, fw: 1, fh: 1,
    cost: { food: 0, wood: 2, gold: 0, stone: 0 },
    // AoE2 builds a palisade in 6 seconds and that is nearly the compressed
    // figure already, so it barely moves: what matters is that a long run is
    // paid for in villager-seconds, and 4s x 20 segments is 80 of them.
    buildTime: 4,
    trains: [],
    lineOfSight: 2,
    wall: true,
  },
  palisadegate: {
    name: 'Palisade Gate',
    hp: 130, fw: 1, fh: 1,
    cost: { food: 0, wood: 20, gold: 0, stone: 0 },
    buildTime: 8,
    trains: [],
    lineOfSight: 3,
    wall: true,
    gate: true,
  },
  stonewall: {
    name: 'Stone Wall',
    // AoE2's stone wall has 1800 hp against its 1800-hp house — an even trade
    // that does not survive being compressed here, where a house is 320. 420 is
    // the number that makes the wall do its job: five militia need fifteen
    // seconds a segment, so a raiding party has to commit to breaking in and you
    // have that long to answer it. Much less and the wall is decoration; much
    // more and there is no way through it in a ten-minute match.
    hp: 420, fw: 1, fh: 1,
    cost: { food: 0, wood: 0, gold: 0, stone: 5 },
    buildTime: 8,
    trains: [],
    lineOfSight: 2,
    wall: true,
  },
  stonegate: {
    name: 'Stone Gate',
    // Deliberately the toughest thing on the wall line: a gate is the hole in
    // your defences and the tile every attacker walks to first.
    hp: 520, fw: 1, fh: 1,
    cost: { food: 0, wood: 0, gold: 0, stone: 30 },
    buildTime: 16,
    trains: [],
    lineOfSight: 3,
    wall: true,
    gate: true,
  },
  watchtower: {
    name: 'Watch Tower',
    hp: 380, fw: 1, fh: 1,
    cost: { food: 0, wood: 25, gold: 0, stone: 100 },
    buildTime: 22,
    trains: [],
    // Nine tiles of sight from a one-tile footprint is the whole reason to plant
    // one on a hill or beside a forward gold: an archer sees 6, so a tower is
    // half again as far and it never has to be told to look.
    lineOfSight: 9,
    // --- The shooting half (see HANDOFF-walls.md) ---------------------------
    // A tower out-ranges an archer by half a tile and hits harder than one, but
    // swings at less than half the rate, so it beats a scout and loses to a
    // committed push — which is what a tower is for.
    attack: 6,
    attackRange: 7,
    attackCooldown: 2.0,
    projectile: true,
    garrisonCapacity: 5,
  },
  castle: {
    name: 'Castle',
    // AoE2's Castle is 4800 hp and 4x4. The footprint is exact; the hitpoints
    // are the same 0.3 compression every other building here carries, which
    // leaves it at five Town Centers' worth of masonry — the one building on the
    // map an early army simply cannot remove.
    hp: 1500, fw: 4, fh: 4,
    cost: { food: 0, wood: 0, gold: 0, stone: 250 },
    // Ninety seconds with one villager, twenty-two with four. AoE2 spends 200s
    // on it; the compression factor everything else uses would give 80, and the
    // extra ten are deliberate — a Castle should be a thing you see going up
    // from across the map with time to do something about it.
    buildTime: 90,
    trains: ['militia', 'archer'],
    // A Castle is a drop-off for everything, like a Town Center. That is not
    // AoE2 (which reserves the honour for the Town Center), and it is here on
    // purpose: 250 stone is a forward base, and a forward base that cannot bank
    // the gold it was planted on is an ornament.
    dropoff: ['food', 'wood', 'gold', 'stone'],
    // Twelve tiles from a 4x4 footprint sees about a fifth of the way across the
    // map. On its own that is worth the stone: a Castle on the middle gold is a
    // permanent answer to "where is his army".
    lineOfSight: 12,
    attack: 12,
    attackRange: 9,
    attackCooldown: 2.0,
    projectile: true,
    // AoE2 garrisons 20 in a Castle and adds an arrow per body. Ten is the
    // figure for an army this size: filling it is a real decision about where
    // ten soldiers are, and it triples the Castle's volley rather than making it
    // unanswerable.
    garrisonCapacity: 10,
  },
};

/** Is this building type a wall piece that joins up with its neighbours? */
export function isWallType(type) {
  const s = BUILDING_STATS[type];
  return !!(s && s.wall);
}

/** Is this building type a gate — a wall piece its owner may walk through? */
export function isGateType(type) {
  const s = BUILDING_STATS[type];
  return !!(s && s.gate);
}

/**
 * The wall line a piece belongs to: 'palisade', 'stone', or null.
 *
 * Used to decide which segments a gate may be cut into. A Palisade Gate belongs
 * in a palisade and a Stone Gate in a stone wall; letting either replace the
 * other would be a way to launder 20 wood into a stone wall segment.
 */
export function wallFamily(type) {
  if (!isWallType(type)) return null;
  return type.startsWith('palisade') ? 'palisade' : 'stone';
}

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
  // Dark Age.
  'palisade', 'palisadegate', 'palisadewall',
  // Feudal Age. The wall and its gate sit next to each other because they are
  // placed in the same breath: you draw a run and then put the door in it.
  'stonewall', 'stonegate', 'watchtower',
  'archeryrange', 'stable', 'blacksmith', 'market',
  'tower', 'wall', 'gate',
  // Castle Age.
  'castle',
  'siegeworkshop', 'university', 'monastery', 'keep',
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

// --- Line of sight ----------------------------------------------------------
// Moved here from the top of systems/vision.js, where they lived only because
// this file was owned by a parallel pass at the time (see HANDOFF-vision.md).
// Every unit now states its own `lineOfSight` in UNIT_STATS and every building
// states one in BUILDING_STATS; these two are the fallbacks for an entry that
// forgets, and vision.js does no derivation of its own any more.
//
// THE INVARIANT, which was the whole reason the derivation existed: a unit's
// line of sight must be strictly greater than its attack range. A unit that
// out-ranges its own vision auto-acquires and fires at things its owner cannot
// see — arrows leaving a bow aimed at empty black ground. It is now checked by
// hand per entry and asserted for the whole table in tests/military.test.mjs.
export const DEFAULT_UNIT_LOS = 4;
export const DEFAULT_BUILDING_LOS = 3;

// --- Stances ----------------------------------------------------------------
//
// AoE2's four, and they mean here exactly what they mean there:
//
//   aggressive   attack anything you see, chase it, stay where the chase ends
//   defensive    attack anything you see, chase it a little, then walk back to
//                where you were standing when it started
//   standGround  attack only what walks into your reach; never take a step
//   noAttack     never acquire a target at all
//
// A stance is a property of the *unit*, not of the order, so it survives every
// move, attack and attack-move the player gives — which is what makes it worth
// setting on a phone, where re-issuing it per order would be unusable.
export const STANCE = {
  AGGRESSIVE: 'aggressive',
  DEFENSIVE: 'defensive',
  STAND_GROUND: 'standGround',
  NO_ATTACK: 'noAttack',
};
/** Order the HUD lists them in — least passive first, as AoE2 does. */
export const STANCE_ORDER = [
  STANCE.AGGRESSIVE, STANCE.DEFENSIVE, STANCE.STAND_GROUND, STANCE.NO_ATTACK,
];
export const STANCE_LABEL = {
  [STANCE.AGGRESSIVE]: 'Aggressive',
  [STANCE.DEFENSIVE]: 'Defensive',
  [STANCE.STAND_GROUND]: 'Stand Ground',
  [STANCE.NO_ATTACK]: 'No Attack',
};
/** One line of what each stance actually does, for the button's sub-label. */
export const STANCE_BLURB = {
  [STANCE.AGGRESSIVE]: 'Chase what you see',
  [STANCE.DEFENSIVE]: 'Chase, then return',
  [STANCE.STAND_GROUND]: 'Hold the spot',
  [STANCE.NO_ATTACK]: 'Never fight back',
};
export const DEFAULT_STANCE = STANCE.AGGRESSIVE;
// A villager that defends itself is a villager that dies. AoE2 puts them on
// No Attack for the same reason, and the panic-and-run behaviour in combat.js is
// the behaviour that keeps them alive.
export const VILLAGER_STANCE = STANCE.NO_ATTACK;
// How far each stance will chase, measured from where the engagement started.
// Aggressive keeps the leash the game has always used; Defensive is deliberately
// short — a defensive line that chases seven tiles is not holding anything, it
// is being pulled apart one unit at a time, which is the oldest trick in RTS.
export const STANCE_LEASH = {
  [STANCE.AGGRESSIVE]: CHASE_LEASH,
  [STANCE.DEFENSIVE]: 4.0,
  [STANCE.STAND_GROUND]: 0,
  [STANCE.NO_ATTACK]: 0,
};

// --- Formations -------------------------------------------------------------
//
// A formation is only ever applied when a *group* is given a destination: it
// decides which unit walks to which slot, and nothing else. There is no
// per-frame formation keeping, no rotation, no lock-step — those cost a pass
// over every unit every step and buy a look, not a behaviour.
export const FORMATION = { LINE: 'line', BOX: 'box', SPREAD: 'spread' };
export const FORMATION_ORDER = [FORMATION.LINE, FORMATION.BOX, FORMATION.SPREAD];
export const FORMATION_LABEL = {
  [FORMATION.LINE]: 'Line',
  [FORMATION.BOX]: 'Box',
  [FORMATION.SPREAD]: 'Spread',
};
export const FORMATION_BLURB = {
  [FORMATION.LINE]: 'Ranks facing the way you sent them',
  [FORMATION.BOX]: 'Tough units outside, ranged inside',
  [FORMATION.SPREAD]: 'Loose, against area damage',
};
export const DEFAULT_FORMATION = FORMATION.LINE;
// Tile spacing between neighbouring slots. One tile is shoulder to shoulder for
// units with a 0.32-0.4 radius; the spread figure is a little over two, which is
// far enough that one mangonel shot cannot reach two bodies.
export const FORMATION_SPACING = 1.0;
export const SPREAD_SPACING = 2.2;

// --- Garrison ---------------------------------------------------------------
//
// A garrisoned unit is off the map and out of every system's loop, but it is
// still yours: it still costs population, it still heals, and — as in AoE2 — it
// still adds an arrow to whatever it is standing inside.
//
// Capacity comes from BUILDING_STATS.garrisonCapacity where the building
// declares one (the tower and the Castle do). This table is the fallback for
// buildings that do not, which today means the Town Center.
export const GARRISON_CAPACITY_FALLBACK = { towncenter: 10 };
// Hit points a garrisoned unit regains per second. Deliberately slow: 1.5/s
// takes a militia from one hitpoint to full in half a minute, so pulling a
// wounded army into the Town Center is a decision that costs you the army for
// long enough to matter, not a free heal between waves.
export const GARRISON_HEAL_PER_SEC = 1.5;
// What one garrisoned body adds to the building's volley. A Town Center with
// five villagers inside throws five arrows at 4 damage: enough to make raiding
// a defended town expensive, nowhere near enough to replace an army.
export const GARRISON_ARROW_DAMAGE = 4;
// A building with a garrison but no `attack` of its own — the Town Center —
// shoots on this beat and at this reach. AoE2's Town Center fires every ~2s at
// 6 tiles.
export const GARRISON_VOLLEY_COOLDOWN = 2.0;
export const GARRISON_DEFAULT_RANGE = 6.0;

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
//
// THESE TWO MUST STAY EQUAL. A pointer that travels more than TAP_SLOP is not a
// tap; a pointer that travels more than DRAG_BOX_THRESHOLD starts a drag. When
// they were 12 and 14 the two pixels between them belonged to neither: a press
// released after 13px of travel had never entered pan or box (onMove returns
// below the drag floor, so the mode was still 'tap') and then failed the tap
// test on the way up. Nothing happened at all — no order, no selection, no
// sound — and 13px is 2.4mm, which is exactly where a thumb lands on a moving
// bus or at the far end of a one-handed reach. A gap here is invisible in code
// review and reads in the hand as "the game ignored me".
//
// 16px (2.9mm on a 390px phone) is a deliberate loosening from 12 on top of
// closing the gap: it is still less than a quarter of the 34px pick radius, so
// it cannot make two neighbouring things ambiguous, and it forgives the wobble
// of tapping while walking.
export const TAP_SLOP = 16;
// Drag-box selection only begins after the pointer exceeds this.
export const DRAG_BOX_THRESHOLD = 16;
// A press shorter than this is a tap.
export const TAP_TIME_MS = 300;
// Fat-finger radius: tapping selects the best entity within this many screen px.
export const TAP_PICK_RADIUS = 34;
// The same radius, for a tap that is giving an *order* rather than choosing
// something. Much tighter on purpose. 34px at ZOOM_MIN is a disc covering ~11
// tiles, and with your own troops ranked first a "move over there" aimed at
// bare ground beside your army landed on the army instead — which replaced the
// selection, issued nothing and said nothing. When something is already in
// hand, aim should decide; the fat finger has already done its job.
export const ORDER_PICK_RADIUS = 18;
