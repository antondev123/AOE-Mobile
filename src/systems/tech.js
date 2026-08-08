// Tech: ages, building unlocks, and the research that sits behind both.
//
// This module owns three things that the rest of the game only ever *reads*:
//
//   1. What age each player is in, and what advancing costs.
//   2. Which building types that age has unlocked.
//   3. Which upgrades a player has finished, and what they add up to — a gather
//      multiplier per resource, an attack bonus and an armour bonus per unit
//      class, and a building-hitpoint scale.
//
// Everything is per *player* and permanent. A researched tech is a fact about
// the player, never a stat copied onto a unit, which is the whole reason a
// Forging finished at 6:00 makes the militia standing in the enemy's base at
// 6:00 hit harder — exactly as it does in AoE2. The alternative (stamping the
// bonus onto units as they are trained) is the classic bug where an upgrade
// silently only applies to whatever you build next, and the army you already
// paid for is the army that dies.
//
// No Phaser imports: this runs headlessly under Node (see tests/tech.test.mjs).
//
// --- Where the per-step work happens ----------------------------------------
// updateResearch() is called from economy.js's updateEconomy(), not from the
// scene. Research is production: it sits in a queue on a building and ticks
// down exactly like a training queue, so it belongs on the same beat, and
// routing it through economy keeps the scene's system list unchanged.

import {
  BUILDING_STATS, UNIT_STATS, RES, GATHER_RATE, PLAYER,
} from '../core/constants.js';
import { EV } from '../core/events.js';
// The stockpile primitives live in economy.js and economy.js imports this
// module back for updateResearch(), so the two are a cycle. That is safe here
// and only here: both sides are `export function` declarations, which are
// hoisted and fully initialised before either module body runs, and neither
// module *calls* across the cycle at import time. Keep the import list down to
// these three so the cycle stays shallow and obvious.
import { canAfford, pay, refund } from './economy.js';

// --- Ages -------------------------------------------------------------------
//
// Three ages, not AoE2's four. Imperial is missing on purpose: this match runs
// ten minutes, and a fourth age would be a tier nobody ever reaches — a menu
// entry that exists to be greyed out. Dark / Feudal / Castle is the arc a real
// AoE2 skirmish actually plays through in its first twenty minutes, compressed.

export const AGE = { DARK: 0, FEUDAL: 1, CASTLE: 2 };
export const MAX_AGE = AGE.CASTLE;

export const AGE_NAMES = ['Dark Age', 'Feudal Age', 'Castle Age'];
/** Short form for the top bar, where there is room for about six characters. */
export const AGE_SHORT = ['Dark', 'Feudal', 'Castle'];

export function ageName(age) {
  return AGE_NAMES[age] || AGE_NAMES[0];
}

// --- Building unlocks -------------------------------------------------------
//
// AoE2's own age assignment, with one deliberate deviation and one omission.
//
// BARRACKS IS DARK AGE. It is in AoE2 — the Barracks and the Militia are both
// Dark Age things, and the drush is the oldest opening in the game — and the
// brief's suggested table had it in Feudal. Moving it would not have been more
// faithful, it would have been less: it would also have pushed the enemy AI's
// first barracks (105s) and its first wave (170s) out past the age-up, which is
// the pacing the whole game is tuned and tested around. So: Dark.
//
// FORWARD-DECLARED KEYS. Several types below do not exist in BUILDING_STATS
// yet — the Castle, the walls, the tower, the Market and the military buildings
// are landing from another pass. They are named here anyway, and every list is
// filtered against the keys that actually exist (see unlockedTypes), so a name
// that is not a building yet is simply skipped and slots in by itself the
// moment it appears. Nothing here throws on an unknown key, and nothing here
// needs editing when one arrives.
export const AGE_UNLOCKS = {
  [AGE.DARK]: [
    'towncenter', 'house', 'mill', 'lumbercamp', 'miningcamp', 'farm',
    // The palisade is Dark Age in AoE2: it is a wooden fence, the thing you
    // throw up in the opening to slow a drush down. Two spellings because the
    // pass adding it has not named its key yet.
    'palisade', 'palisadewall',
    'barracks',
  ],
  [AGE.FEUDAL]: [
    'archeryrange', 'stable', 'market', 'blacksmith',
    'watchtower', 'tower', 'stonewall', 'wall', 'gate',
  ],
  [AGE.CASTLE]: [
    'castle', 'siegeworkshop', 'university', 'monastery', 'keep',
  ],
};

/**
 * The age a building type needs, for a type nobody listed above.
 *
 * The failure mode matters more than the answer. A building whose key we did
 * not guess must never end up permanently unbuildable — a locked entry with no
 * age that ever unlocks it is a dead button, and worse, it is invisible in
 * testing because everything still "works". So an unknown type defaults to Dark
 * Age (always buildable) with one exception: anything that costs stone. In AoE2
 * stone buys towers, walls and the Castle, and every one of those is post-Dark,
 * so a stone cost is a reliable tell that the thing is not a Dark Age building.
 * Being one age too generous with an unrecognised Castle is a much smaller sin
 * than locking it out of the game.
 */
function inferredAge(type) {
  const s = BUILDING_STATS[type];
  if (s && s.cost && (s.cost.stone || 0) > 0) return AGE.FEUDAL;
  return AGE.DARK;
}

// Built once from AGE_UNLOCKS, then consulted per lookup — the build menu asks
// for this once per button per render, so it must not be a table walk.
//
// It is rebuilt lazily whenever the building table changes underneath it. The
// entry count alone is not a sufficient signal (an add and a remove in the same
// session net to zero), so ageForBuilding also rebuilds on the one case the
// count misses: a type that exists in BUILDING_STATS but is not in the map. A
// stale *extra* entry, for a building that has gone away, is harmless — nobody
// can place a building that does not exist.
let unlockCache = null;
let unlockCacheSize = -1;

function unlockTable() {
  const size = Object.keys(BUILDING_STATS).length;
  if (unlockCache && unlockCacheSize === size) return unlockCache;
  const map = new Map();
  for (const age of [AGE.DARK, AGE.FEUDAL, AGE.CASTLE]) {
    for (const type of AGE_UNLOCKS[age]) {
      if (!BUILDING_STATS[type]) continue;   // not a building (yet) — skip it
      if (!map.has(type)) map.set(type, age);
    }
  }
  for (const type of Object.keys(BUILDING_STATS)) {
    if (!map.has(type)) map.set(type, inferredAge(type));
  }
  unlockCache = map;
  unlockCacheSize = size;
  return map;
}

/** The age `type` becomes buildable in. Dark for anything unrecognised. */
export function ageForBuilding(type) {
  let map = unlockTable();
  if (!map.has(type) && BUILDING_STATS[type]) {
    unlockCache = null;                 // a building appeared that the map predates
    map = unlockTable();
  }
  return map.get(type) ?? AGE.DARK;
}

/** Has `playerId` reached the age that unlocks `type`? */
export function isUnlocked(world, playerId, type) {
  return currentAge(world, playerId) >= ageForBuilding(type);
}

/**
 * The sentence explaining why a locked building is locked, or null when it is
 * not. Worded as the HUD says it out loud, so the build menu, the placement
 * ghost and the refusal toast can never tell three different stories.
 */
export function lockReason(world, playerId, type) {
  if (isUnlocked(world, playerId, type)) return null;
  const s = BUILDING_STATS[type];
  return `${(s && s.name) || type} needs the ${ageName(ageForBuilding(type))}`;
}

/** Every existing building type unlocked for this player, in table order. */
export function unlockedTypes(world, playerId) {
  const age = currentAge(world, playerId);
  const out = [];
  for (const [type, need] of unlockTable()) {
    // The BUILDING_STATS test is not redundant: the map may carry an entry for
    // a type that has since gone away, and a type nobody can spawn must never
    // be reported as unlocked.
    if (need <= age && BUILDING_STATS[type]) out.push(type);
  }
  return out;
}

// --- The tech table ---------------------------------------------------------
//
// COSTS are AoE2's, unrounded. Resource *costs* in this game have always been
// AoE2's real numbers (a house is 25 wood, a barracks is 175, a militia is
// 60 food and 20 gold); it is the *times* that are compressed. Keeping that
// split here means a player who knows AoE2 already knows what a Bow Saw costs.
//
// TIMES are compressed by roughly 0.4, the same factor the building and train
// times in constants.js use. AoE2 researches Double-Bit Axe in 50 seconds
// against a forty-minute match; 20 here is the same fraction of a ten-minute
// one.
//
// The two AGE-UP costs are the exception, and are cut from AoE2's 500 food and
// 800 food + 200 gold. Measured against the shipped economy — a villager banks
// about 0.75 resources a second including its walk, and a player on a good
// opening has 10-12 villagers with roughly half of them on food by three
// minutes — AoE2's 500 lands the Feudal Age at about 5:30 of a ten-minute
// match, which is past the point where it can pay for anything. 400 and
// 600+200 put the two age-ups at roughly 3:30 and 7:00 on a good opening, so
// both are decisions you make during the game rather than trophies you collect
// at the end of it.
//
// `at` is a *preference list* of building types, not one type: the first entry
// that exists in BUILDING_STATS wins. Fletching belongs at a Blacksmith and
// says so, but until a Blacksmith exists it is offered at the Barracks — and
// the day a Blacksmith lands it moves there by itself, with no edit here.

export const TECHS = {
  // --- Ages ---------------------------------------------------------------
  feudal_age: {
    name: 'Feudal Age',
    blurb: 'Advance the age',
    at: ['towncenter'],
    age: AGE.DARK,
    cost: { food: 400 },
    time: 50,
    advancesTo: AGE.FEUDAL,
  },
  castle_age: {
    name: 'Castle Age',
    blurb: 'Advance the age',
    at: ['towncenter'],
    age: AGE.FEUDAL,
    requires: 'feudal_age',
    cost: { food: 600, gold: 200 },
    time: 65,
    advancesTo: AGE.CASTLE,
  },

  // --- Farming and food (Mill) --------------------------------------------
  horsecollar: {
    name: 'Horse Collar',
    blurb: '+15% food gathering',
    at: ['mill'],
    age: AGE.FEUDAL,
    cost: { food: 75, wood: 75 },
    time: 20,
    gather: { food: 0.15 },
  },
  heavyplough: {
    name: 'Heavy Plough',
    blurb: '+15% food gathering',
    at: ['mill'],
    age: AGE.CASTLE,
    requires: 'horsecollar',
    cost: { food: 125, wood: 125 },
    time: 28,
    gather: { food: 0.15 },
  },

  // --- Wood (Lumber Camp) --------------------------------------------------
  // The wood line is the strongest economic upgrade in AoE2 and it is here too:
  // 20% a tier rather than 15%, because wood pays for houses, farms, camps and
  // every building in the game, so a wood bonus compounds into all of them.
  doublebitaxe: {
    name: 'Double-Bit Axe',
    blurb: '+20% wood gathering',
    at: ['lumbercamp'],
    age: AGE.FEUDAL,
    cost: { food: 100, wood: 50 },
    time: 20,
    gather: { wood: 0.20 },
  },
  bowsaw: {
    name: 'Bow Saw',
    blurb: '+20% wood gathering',
    at: ['lumbercamp'],
    age: AGE.CASTLE,
    requires: 'doublebitaxe',
    cost: { food: 150, wood: 100 },
    time: 28,
    gather: { wood: 0.20 },
  },

  // --- Gold and stone (Mining Camp) ---------------------------------------
  goldmining: {
    name: 'Gold Mining',
    blurb: '+15% gold gathering',
    at: ['miningcamp'],
    age: AGE.FEUDAL,
    cost: { food: 100, wood: 75 },
    time: 20,
    gather: { gold: 0.15 },
  },
  goldshaftmining: {
    name: 'Gold Shaft Mining',
    blurb: '+15% gold gathering',
    at: ['miningcamp'],
    age: AGE.CASTLE,
    requires: 'goldmining',
    cost: { food: 200, wood: 150 },
    time: 30,
    gather: { gold: 0.15 },
  },
  stonemining: {
    name: 'Stone Mining',
    blurb: '+15% stone gathering',
    at: ['miningcamp'],
    age: AGE.FEUDAL,
    cost: { food: 100, wood: 75 },
    time: 20,
    gather: { stone: 0.15 },
  },
  stoneshaftmining: {
    name: 'Stone Shaft Mining',
    blurb: '+15% stone gathering',
    at: ['miningcamp'],
    age: AGE.CASTLE,
    requires: 'stonemining',
    cost: { food: 200, wood: 150 },
    time: 30,
    gather: { stone: 0.15 },
  },

  // --- Attack (Blacksmith, or the Barracks until one exists) --------------
  //
  // +1 a tier looks small against a militia's 6 attack until you remember that
  // damage is `attack - armour` floored at MIN_DAMAGE. A militia hitting an
  // armoured militia does 6 - 1 = 5; Forging makes that 6, which is a 20% swing
  // in a straight fight, and it applies to every soldier you own at once. That
  // is why AoE2's blacksmith numbers are +1 and not +3, and it is why the same
  // +1 is right here even though everything else has been compressed.
  forging: {
    name: 'Forging',
    blurb: '+1 melee attack',
    at: ['blacksmith', 'barracks'],
    age: AGE.FEUDAL,
    cost: { food: 150 },
    time: 24,
    attack: { melee: 1 },
  },
  ironcasting: {
    name: 'Iron Casting',
    blurb: '+1 melee attack',
    at: ['blacksmith', 'barracks'],
    age: AGE.CASTLE,
    requires: 'forging',
    cost: { food: 220, gold: 120 },
    time: 32,
    attack: { melee: 1 },
  },
  fletching: {
    name: 'Fletching',
    blurb: '+1 ranged attack',
    at: ['blacksmith', 'archeryrange', 'barracks'],
    age: AGE.FEUDAL,
    cost: { food: 100, gold: 50 },
    time: 24,
    attack: { ranged: 1 },
  },
  bodkinarrow: {
    name: 'Bodkin Arrow',
    blurb: '+1 ranged attack',
    at: ['blacksmith', 'archeryrange', 'barracks'],
    age: AGE.CASTLE,
    requires: 'fletching',
    cost: { food: 200, gold: 100 },
    time: 32,
    attack: { ranged: 1 },
  },

  // --- Armour --------------------------------------------------------------
  scalemail: {
    name: 'Scale Mail',
    blurb: '+1 melee armour',
    at: ['blacksmith', 'barracks'],
    age: AGE.FEUDAL,
    cost: { food: 100 },
    time: 24,
    armor: { melee: 1 },
  },
  chainmail: {
    name: 'Chain Mail',
    blurb: '+1 melee armour',
    at: ['blacksmith', 'barracks'],
    age: AGE.CASTLE,
    requires: 'scalemail',
    cost: { food: 200, gold: 100 },
    time: 32,
    armor: { melee: 1 },
  },
  paddedarcher: {
    name: 'Padded Archer Armour',
    blurb: '+1 ranged armour',
    at: ['blacksmith', 'archeryrange', 'barracks'],
    age: AGE.FEUDAL,
    cost: { food: 100 },
    time: 24,
    armor: { ranged: 1 },
  },
  leatherarcher: {
    name: 'Leather Archer Armour',
    blurb: '+1 ranged armour',
    at: ['blacksmith', 'archeryrange', 'barracks'],
    age: AGE.CASTLE,
    requires: 'paddedarcher',
    cost: { food: 150, gold: 150 },
    time: 32,
    armor: { ranged: 1 },
  },
};

/** Every tech id, in table order. Stable, so the HUD lists them consistently. */
export const TECH_IDS = Object.keys(TECHS);

/**
 * Which building type actually offers this tech right now: the first entry of
 * its `at` list that exists in BUILDING_STATS. Null if none of them do — which
 * is how a tech quietly waits for its building to be added instead of throwing.
 */
export function researchBuildingFor(techId) {
  const t = TECHS[techId];
  if (!t) return null;
  for (const type of t.at) {
    if (BUILDING_STATS[type]) return type;
  }
  return null;
}

/** Every tech researched at buildings of `type`, in table order. */
export function techsAt(type) {
  const out = [];
  for (const id of TECH_IDS) {
    if (researchBuildingFor(id) === type) out.push(id);
  }
  return out;
}

// --- Unit classes -----------------------------------------------------------
//
// Derived from UNIT_STATS rather than written out, so a Knight or a Spearman
// added by another pass is classified — and therefore upgraded — without a line
// changing here. Three classes:
//   worker  anything the Town Center trains (villagers). No combat upgrades;
//           its upgrades are the gathering ones, which are per-resource.
//   ranged  anything that throws something (`projectile: true`).
//   melee   everything else, which in AoE2 terms is infantry, cavalry and the
//           things Forging and Scale Mail cover.

function workerTypes() {
  const tc = BUILDING_STATS.towncenter;
  const set = new Set(['villager']);
  for (const t of (tc && tc.trains) || []) set.add(t);
  return set;
}

export function unitClass(unitType) {
  const s = UNIT_STATS[unitType];
  if (!s) return null;
  if (workerTypes().has(unitType)) return 'worker';
  return s.projectile ? 'ranged' : 'melee';
}

// --- Per-player state -------------------------------------------------------
//
// Lazily attached to the world, because world.js is not this module's to edit
// and a system that needs a field on the world should be able to add it without
// the world knowing the system exists.

function techState(world) {
  if (!world._tech) {
    world._tech = world.players.map(() => ({
      age: AGE.DARK,
      done: new Set(),
      // Cached totals, recomputed whenever `done` changes. Combat asks for the
      // attack bonus on every single swing, so this must not be a table walk.
      totals: emptyTotals(),
    }));
  }
  // A world whose player list grew (never happens today, but the cost of being
  // wrong is a crash) gets the missing slots filled in.
  while (world._tech.length < world.players.length) {
    world._tech.push({ age: AGE.DARK, done: new Set(), totals: emptyTotals() });
  }
  return world._tech;
}

function emptyTotals() {
  return {
    gather: { food: 0, wood: 0, gold: 0, stone: 0 },
    attack: { melee: 0, ranged: 0, worker: 0 },
    armor: { melee: 0, ranged: 0, worker: 0 },
  };
}

function playerTech(world, playerId) {
  const st = techState(world);
  return st[playerId] || null;
}

function recomputeTotals(pt) {
  const t = emptyTotals();
  for (const id of pt.done) {
    const tech = TECHS[id];
    if (!tech) continue;
    if (tech.gather) for (const k of Object.keys(tech.gather)) t.gather[k] = (t.gather[k] || 0) + tech.gather[k];
    if (tech.attack) for (const k of Object.keys(tech.attack)) t.attack[k] = (t.attack[k] || 0) + tech.attack[k];
    if (tech.armor) for (const k of Object.keys(tech.armor)) t.armor[k] = (t.armor[k] || 0) + tech.armor[k];
  }
  pt.totals = t;
}

/** The age `playerId` is currently in. */
export function currentAge(world, playerId) {
  const pt = playerTech(world, playerId);
  return pt ? pt.age : AGE.DARK;
}

/** Has this player finished `techId`? The permanent, idempotent record. */
export function hasTech(world, playerId, techId) {
  const pt = playerTech(world, playerId);
  return !!(pt && pt.done.has(techId));
}

/** Every tech this player has finished, in table order. Read-only. */
export function researchedTechs(world, playerId) {
  const pt = playerTech(world, playerId);
  if (!pt) return [];
  return TECH_IDS.filter((id) => pt.done.has(id));
}

// --- Effects the rest of the game reads -------------------------------------

/**
 * Gathering multiplier for a resource: 1.0 with nothing researched, 1.15 with
 * Horse Collar, 1.30 with Heavy Plough on top. Additive between tiers rather
 * than multiplicative, which is AoE2's own rule and keeps the arithmetic a
 * player can do in their head.
 */
export function gatherMultiplier(world, playerId, resourceType) {
  const pt = playerTech(world, playerId);
  if (!pt) return 1;
  return 1 + (pt.totals.gather[resourceType] || 0);
}

/** Attack a unit actually swings with: its base stat plus its class's line. */
export function attackBonus(world, unit) {
  if (!unit || unit.player === null || unit.player === undefined) return 0;
  const pt = playerTech(world, unit.player);
  if (!pt) return 0;
  const cls = unitClass(unit.type);
  return cls ? (pt.totals.attack[cls] || 0) : 0;
}

/** Armour a unit actually soaks with: its base stat plus its class's line. */
export function armorBonus(world, entity) {
  if (!entity || entity.kind !== 'unit') return 0;
  if (entity.player === null || entity.player === undefined) return 0;
  const pt = playerTech(world, entity.player);
  if (!pt) return 0;
  const cls = unitClass(entity.type);
  return cls ? (pt.totals.armor[cls] || 0) : 0;
}

// --- The age's universal buff ----------------------------------------------
//
// AoE2 does not hand you a stat sheet when you age up, but it does quietly make
// your town harder to knock over: Town Centers and towers gain hitpoints with
// the age, and the Masonry/Architecture line exists to make that explicit. The
// same thing here, as one number: every building of yours gets +15% maximum
// hitpoints in the Feudal Age and +30% in the Castle Age, applied to what is
// already standing as well as to what you build next.
//
// Why hitpoints and not, say, a flat gather bonus: aging up already costs 400
// food, which is eight villagers you did not train, and the payoff is a menu of
// upgrades you then have to pay for *again*. Something has to land the instant
// the age does or the age-up feels like buying a shopping list. Building hp is
// the right something because it is the one buff that helps the player who is
// behind — the one being attacked while they save for it — rather than the one
// already ahead.
const AGE_HP_SCALE = [1.0, 1.15, 1.30];

export function buildingHpScale(world, playerId) {
  return AGE_HP_SCALE[currentAge(world, playerId)] ?? 1;
}

/**
 * Set a building's maxHp to its base times its owner's age scale, keeping its
 * current damage as a fraction. Idempotent: calling it twice does nothing the
 * second time, so it is safe from anywhere.
 *
 * Exported because economy.js applies it to a foundation the moment it is
 * placed — a Town Center started in the Castle Age must be a Castle Age Town
 * Center, not a Dark Age one that gets upgraded when the next age lands.
 */
export function applyAgeHp(world, building) {
  if (!building || building.dead || building.kind !== 'building') return building;
  const s = BUILDING_STATS[building.type];
  if (!s) return building;
  const want = Math.round(s.hp * buildingHpScale(world, building.player));
  const have = building.maxHp || s.hp;
  if (want === have) return building;
  const frac = have > 0 ? Math.max(0, Math.min(1, building.hp / have)) : 1;
  building.maxHp = want;
  building.hp = Math.max(1, Math.round(want * frac));
  return building;
}

function applyAgeHpToAll(world, playerId) {
  for (const b of world.buildings) {
    if (b.dead || b.player !== playerId) continue;
    applyAgeHp(world, b);
  }
}

// --- Research queue ---------------------------------------------------------
//
// A building researches one thing at a time and may have more waiting behind
// it, which is exactly the shape of the training queue in economy.js — same
// { remaining, total } entries, same head-of-queue tick, same full refund on
// cancel. It is deliberately a *separate* array (`building.research`) rather
// than sharing `building.queue`, for one hard reason: world.js's recomputePop
// counts every entry in `queue` as a reserved population point. Putting a
// Bow Saw in there would silently cost the player a villager's worth of pop
// for the twenty-eight seconds it takes to research, and stall a housed-tight
// economy for no visible reason.

/** How many researches may be stacked at one building. */
export const MAX_RESEARCH_QUEUE = 3;

function researchQueue(building) {
  if (!building.research) building.research = [];
  return building.research;
}

/** Is this tech in *any* of this player's queues right now? */
export function isResearching(world, playerId, techId) {
  for (const b of world.buildings) {
    if (b.dead || b.player !== playerId || !b.research) continue;
    for (const e of b.research) if (e.id === techId) return true;
  }
  return false;
}

/** The tech a building is working on right now, or null. */
export function researchInProgress(building) {
  const q = building && building.research;
  return q && q.length ? q[0] : null;
}

/** Progress 0..1 of whatever a building is researching (0 when idle). */
export function researchProgress(building) {
  const head = researchInProgress(building);
  if (!head) return 0;
  const total = head.total || (TECHS[head.id] && TECHS[head.id].time) || 1;
  return Math.max(0, Math.min(1, 1 - head.remaining / total));
}

/**
 * Why a player cannot start `techId` at `building` right now, or null when they
 * can. One function, so the HUD's greyed-out reason, the AI's "should I bother"
 * test and queueResearch's own refusal are always the same rule.
 *
 * `building` is optional: pass it to include the "wrong building" and "queue is
 * full" checks, omit it to ask the player-level question only.
 */
export function researchRefusal(world, playerId, techId, building = null, opts = {}) {
  const t = TECHS[techId];
  if (!t) return 'No such technology';
  const pt = playerTech(world, playerId);
  if (!pt) return 'No such player';

  if (pt.done.has(techId)) return 'Already researched';
  if (t.requires && !pt.done.has(t.requires)) {
    return `Needs ${TECHS[t.requires].name}`;
  }
  if (pt.age < t.age) return `Needs the ${ageName(t.age)}`;
  if (t.advancesTo !== undefined && pt.age >= t.advancesTo) return 'Already researched';
  if (isResearching(world, playerId, techId)) return 'Already under way';

  if (building) {
    if (building.dead || building.kind !== 'building') return 'No such building';
    if (building.player !== playerId) return 'Not your building';
    if (!building.complete) return 'Still under construction';
    if (researchBuildingFor(techId) !== building.type) {
      const at = researchBuildingFor(techId);
      const s = at && BUILDING_STATS[at];
      return s ? `Researched at the ${s.name}` : 'Not researched here';
    }
    if (researchQueue(building).length >= MAX_RESEARCH_QUEUE) return 'Queue is full';
  }

  if (!opts.skipCost && !affordable(world, playerId, t.cost)) return 'Not enough resources';
  return null;
}

function affordable(world, playerId, cost) {
  return canAfford(world, playerId, cost);
}

/**
 * Start (or queue) a research at a building. Charges the cost now and refunds
 * it in full on cancel, exactly as training does.
 *
 * Returns true when it was queued. Every refusal path is silent for the enemy
 * AI and toasted for the human, on the same rule placeFoundation uses: an AI
 * evaluates dozens of these a minute and its failures are not the player's news.
 */
export function queueResearch(world, building, techId) {
  if (!building || building.dead || building.kind !== 'building') return false;
  const playerId = building.player;
  const t = TECHS[techId];
  if (!t) return false;

  const why = researchRefusal(world, playerId, techId, building);
  if (why) {
    if (playerId === PLAYER) world.events.emit(EV.TOAST, { text: why, tone: 'warn' });
    return false;
  }
  if (!pay(world, playerId, t.cost, `research:${techId}`)) return false;

  researchQueue(building).push({ id: techId, remaining: t.time, total: t.time });
  world.events.emit(EV.RESEARCH_START, {
    player: playerId, playerId, building, tech: techId, name: t.name,
  });
  if (playerId === PLAYER) {
    world.events.emit(EV.TOAST, {
      text: t.advancesTo !== undefined ? `Advancing to the ${t.name}` : `Researching ${t.name}`,
      tone: 'info',
    });
  }
  return true;
}

/** Cancel a queued research and refund it in full. */
export function cancelResearch(world, building, index) {
  const q = building && building.research;
  if (!q || !q.length) return false;
  const i = index === undefined ? q.length - 1 : index;
  if (i < 0 || i >= q.length) return false;
  const [entry] = q.splice(i, 1);
  const t = TECHS[entry.id];
  if (t) refund(world, building.player, t.cost, `cancel:${entry.id}`);
  return true;
}

/**
 * Finish a tech for a player. The one place `done` is ever written, and the
 * only place an age is ever raised.
 *
 * Idempotent by construction: a tech already in the set returns false and
 * changes nothing, so a duplicate completion (two buildings that somehow both
 * finished it, a save reloaded, a test calling it twice) can never double an
 * effect or re-emit an age-up.
 */
export function completeResearch(world, playerId, techId, building = null) {
  const pt = playerTech(world, playerId);
  const t = TECHS[techId];
  if (!pt || !t) return false;
  if (pt.done.has(techId)) return false;

  pt.done.add(techId);
  recomputeTotals(pt);

  world.events.emit(EV.RESEARCH_DONE, {
    player: playerId, playerId, building, tech: techId, name: t.name,
  });

  if (t.advancesTo !== undefined && t.advancesTo > pt.age) {
    pt.age = t.advancesTo;
    // Every building the player owns, standing or half-built, gains the age's
    // hitpoints at the instant the age lands.
    applyAgeHpToAll(world, playerId);
    world.events.emit(EV.AGE_ADVANCE, { player: playerId, playerId, age: pt.age });
    if (playerId === PLAYER) {
      world.events.emit(EV.TOAST, { text: `You have advanced to the ${ageName(pt.age)}!`, tone: 'info' });
    }
  } else if (playerId === PLAYER) {
    world.events.emit(EV.TOAST, { text: `${t.name} researched`, tone: 'info' });
  }
  return true;
}

/**
 * Advance every research queue by `dt`. Called once per fixed sim step from
 * economy.js's updateEconomy — see the note at the top of this file.
 */
export function updateResearch(world, dt) {
  techState(world); // make sure the per-player record exists before anything reads it
  for (const b of world.buildings) {
    if (b.dead || !b.research || b.research.length === 0) continue;
    if (!b.complete) continue;               // a bombed-out site does not research
    const head = b.research[0];
    head.remaining -= dt;
    if (head.remaining > 0) continue;
    const over = -head.remaining;
    b.research.shift();
    completeResearch(world, b.player, head.id, b);
    // Carry the overshoot into the next entry so a queue keeps its cadence,
    // exactly as the training queue does.
    if (b.research.length > 0) b.research[0].remaining -= over;
  }
}

// --- Read-only helpers for the HUD and the AI -------------------------------

/**
 * Everything a selected building can offer, ready to render: one entry per
 * tech, including the ones that are done or out of reach, because a player has
 * to be able to see what a Mill is *for* before they can decide to build one.
 *
 * status is one of:
 *   'done'      already researched, permanently
 *   'active'    in this building's queue right now
 *   'ready'     affordable and startable
 *   'poor'      allowed, but the stockpile is short
 *   'locked'    the wrong age, or a prerequisite is missing
 *
 * `gate` says *which* of those two locked it — 'age' or 'prereq' — and the HUD
 * treats them very differently. An age-locked tech is shown, because the list
 * of things the next age buys is the argument for paying for it. A
 * prerequisite-locked one is hidden, because it is the same upgrade line one
 * step further along: it appears in the very slot its predecessor vacates, so
 * nothing is concealed, and showing all four tiers at once doubled the height
 * of the Barracks panel for no information.
 */
export function researchOptions(world, playerId, building) {
  if (!building || building.dead || building.kind !== 'building') return [];
  const out = [];
  for (const id of techsAt(building.type)) {
    const t = TECHS[id];
    let status;
    let reason = null;
    let gate = null;
    if (hasTech(world, playerId, id) ||
        (t.advancesTo !== undefined && currentAge(world, playerId) >= t.advancesTo)) {
      status = 'done';
    } else if ((building.research || []).some((e) => e.id === id)) {
      status = 'active';
    } else {
      const hard = researchRefusal(world, playerId, id, building, { skipCost: true });
      if (hard) {
        status = 'locked';
        reason = hard;
        // Order matters and mirrors researchRefusal's: a tech that is behind
        // both a prerequisite and an age is reported as behind the
        // prerequisite, because that is the step the player takes next.
        if (t.requires && !hasTech(world, playerId, t.requires)) gate = 'prereq';
        else if (currentAge(world, playerId) < t.age) gate = 'age';
      } else if (!affordable(world, playerId, t.cost)) {
        status = 'poor';
        reason = 'Not enough resources';
      } else {
        status = 'ready';
      }
    }
    out.push({ id, tech: t, name: t.name, blurb: t.blurb, cost: t.cost, status, reason, gate });
  }
  return out;
}

/**
 * The next age-up tech for a player, or null in the Castle Age. Used by the HUD
 * to put "Advance to the Feudal Age" at the top of the Town Center panel and by
 * the enemy AI to decide whether to bother.
 */
export function nextAgeTech(world, playerId) {
  const age = currentAge(world, playerId);
  for (const id of TECH_IDS) {
    const t = TECHS[id];
    if (t.advancesTo === age + 1) return id;
  }
  return null;
}

/**
 * The rate GATHER_RATE would give, times this player's upgrades. Exported so a
 * test (or the AI) can ask "what is my food line actually worth now" without
 * reaching into the totals table.
 */
export function baseGatherRate(resourceType) {
  return GATHER_RATE[resourceType] || 0.5;
}

/** Every resource key the gather upgrades know about. */
export const UPGRADABLE_RESOURCES = [RES.FOOD, RES.WOOD, RES.GOLD, RES.STONE];
