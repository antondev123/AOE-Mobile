// Headless tests for src/systems/tech.js — ages, unlocks and upgrades.
//
//   node tests/tech.test.mjs
//
// Everything here runs on a blank world (no mapgen) with hand-placed entities,
// because every claim being made is about arithmetic, not about where the map
// generator happened to put a bush. No Phaser, no DOM.
//
// The five things this file exists to hold down, in the order they would hurt
// if they broke:
//
//   1. An economic upgrade actually raises the *measured* gather rate — not the
//      multiplier, the resources a villager banks in a fixed number of steps.
//   2. A military upgrade raises damage dealt by units that were already alive
//      when it finished. Applying an upgrade only to newly trained units is the
//      classic silent bug and it is invisible unless a test walks a live unit
//      through it.
//   3. Researching the same thing twice is a no-op and does not charge twice.
//   4. Aging up actually deducts what it says it costs.
//   5. Buildings are gated by age, and the gate refuses placement rather than
//      merely hiding a button.

import assert from 'node:assert/strict';

import {
  createWorld, spawnUnit, spawnBuilding, spawnResource, recomputePop, reindex,
} from '../src/core/world.js';
import { EV } from '../src/core/events.js';
import {
  SIM_DT, PLAYER, ENEMY, RES, BUILDING_STATS, UNIT_STATS, CARRY_CAPACITY,
  MIN_DAMAGE,
} from '../src/core/constants.js';
import {
  gatherTick, gatherRateFor, updateEconomy, placeFoundation, canPlaceReachable,
  placementRefusal, canAfford,
} from '../src/systems/economy.js';
import { applyDamage, effectiveAttack, effectiveArmor } from '../src/systems/combat.js';
import {
  AGE, AGE_NAMES, AGE_SHORT, TECHS, TECH_IDS,
  currentAge, ageName, hasTech, researchedTechs,
  ageForBuilding, isUnlocked, lockReason, unlockedTypes,
  techsAt, researchBuildingFor, researchOptions, researchProgress,
  queueResearch, cancelResearch, completeResearch, updateResearch,
  gatherMultiplier, attackBonus, armorBonus, buildingHpScale, applyAgeHp,
  unitClass, nextAgeTech, researchRefusal, isResearching, MAX_RESEARCH_QUEUE,
} from '../src/systems/tech.js';

// --- tiny harness -----------------------------------------------------------

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err && err.message}`);
  }
}

// --- fixtures ---------------------------------------------------------------

function blankWorld() {
  const w = createWorld(31337);
  reindex(w);
  return w;
}

/** A Town Center, a Mill, a Lumber Camp, a Mining Camp and a Barracks. */
function techWorld({ rich = true } = {}) {
  const w = blankWorld();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 10, 10);
  const mill = spawnBuilding(w, 'mill', PLAYER, 16, 10);
  const lumber = spawnBuilding(w, 'lumbercamp', PLAYER, 20, 10);
  const mining = spawnBuilding(w, 'miningcamp', PLAYER, 24, 10);
  const barracks = spawnBuilding(w, 'barracks', PLAYER, 28, 10);
  // The Blacksmith is where the ten attack/armour techs actually live. They
  // spent a long time falling back to the Barracks because no Blacksmith
  // existed; now that one does, a test that wants "a building with plenty of
  // research" has to ask for the right building.
  const blacksmith = spawnBuilding(w, 'blacksmith', PLAYER, 32, 10);
  if (rich) {
    // Enough of everything that "can you afford it" is never the thing under
    // test unless a test says so.
    w.players[PLAYER].resources = { food: 9000, wood: 9000, gold: 9000, stone: 9000 };
  }
  recomputePop(w, PLAYER);
  reindex(w);
  return { w, tc, mill, lumber, mining, barracks, blacksmith, p: w.players[PLAYER] };
}

function record(world, type) {
  const seen = [];
  world.events.on(type, (payload) => seen.push(payload));
  return seen;
}

/** Run research (and training) forward for `seconds` of sim time. */
function run(world, seconds) {
  const steps = Math.ceil(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    updateEconomy(world, SIM_DT);
    world.time += SIM_DT;
  }
}

/** Finish a tech immediately, the way a fast-forward would. */
function grant(world, playerId, techId) {
  return completeResearch(world, playerId, techId);
}

/** Total of a cost object, so "did the bill land" is one number. */
function spent(before, after) {
  const out = {};
  for (const k of ['food', 'wood', 'gold', 'stone']) {
    out[k] = (before[k] || 0) - (after[k] || 0);
  }
  return out;
}

// ===========================================================================
// 1. Ages
// ===========================================================================

test('everyone starts in the Dark Age', () => {
  const { w } = techWorld();
  assert.equal(currentAge(w, PLAYER), AGE.DARK);
  assert.equal(currentAge(w, ENEMY), AGE.DARK);
  assert.equal(ageName(AGE.DARK), 'Dark Age');
  assert.equal(AGE_NAMES.length, 3, 'three ages, not four — Imperial is out of scope');
  assert.equal(AGE_SHORT.length, 3);
});

test('the age-up costs are actually deducted', () => {
  const { w, tc, p } = techWorld();
  const before = { ...p.resources };
  assert.equal(queueResearch(w, tc, 'feudal_age'), true);
  const after = { ...p.resources };
  const bill = spent(before, after);
  assert.deepEqual(bill, {
    food: TECHS.feudal_age.cost.food || 0,
    wood: TECHS.feudal_age.cost.wood || 0,
    gold: TECHS.feudal_age.cost.gold || 0,
    stone: TECHS.feudal_age.cost.stone || 0,
  }, 'the stockpile pays the advertised price the moment it is queued');
  assert.ok(bill.food > 0, 'the Feudal Age costs food');
});

test('an age-up you cannot afford is refused and charges nothing', () => {
  const { w, tc, p } = techWorld({ rich: false });
  p.resources = { food: 10, wood: 10, gold: 10, stone: 10 };
  const before = { ...p.resources };
  assert.equal(queueResearch(w, tc, 'feudal_age'), false);
  assert.deepEqual(p.resources, before);
  assert.equal(currentAge(w, PLAYER), AGE.DARK);
});

test('advancing takes real time, occupies the Town Center, and shows progress', () => {
  const { w, tc } = techWorld();
  queueResearch(w, tc, 'feudal_age');

  assert.equal(tc.research.length, 1, 'the Town Center is occupied by the age-up');
  assert.equal(researchProgress(tc), 0);

  run(w, TECHS.feudal_age.time / 2);
  const half = researchProgress(tc);
  assert.ok(half > 0.4 && half < 0.6, `halfway progress should be ~0.5, got ${half}`);
  assert.equal(currentAge(w, PLAYER), AGE.DARK, 'still Dark until it finishes');

  // While it is under way the slot is taken: a second age-up cannot start.
  assert.equal(isResearching(w, PLAYER, 'feudal_age'), true);
  assert.match(String(researchRefusal(w, PLAYER, 'feudal_age', tc)), /under way/i);

  run(w, TECHS.feudal_age.time / 2 + 1);
  assert.equal(currentAge(w, PLAYER), AGE.FEUDAL);
  assert.equal(tc.research.length, 0, 'the Town Center is free again');
  assert.equal(researchProgress(tc), 0);
});

test('advancing emits AGE_ADVANCE, RESEARCH_START and RESEARCH_DONE', () => {
  const { w, tc } = techWorld();
  const starts = record(w, EV.RESEARCH_START);
  const dones = record(w, EV.RESEARCH_DONE);
  const ages = record(w, EV.AGE_ADVANCE);
  const toasts = record(w, EV.TOAST);

  queueResearch(w, tc, 'feudal_age');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].tech, 'feudal_age');
  assert.equal(starts[0].player, PLAYER);

  run(w, TECHS.feudal_age.time + 1);
  assert.equal(dones.length, 1);
  assert.equal(dones[0].tech, 'feudal_age');
  assert.equal(ages.length, 1);
  assert.deepEqual({ player: ages[0].player, age: ages[0].age }, { player: PLAYER, age: AGE.FEUDAL });
  assert.ok(toasts.some((t) => /Feudal Age/i.test(t.text)), 'the player is told out loud');
});

test('the Castle Age needs the Feudal Age first', () => {
  const { w, tc } = techWorld();
  assert.match(String(researchRefusal(w, PLAYER, 'castle_age', tc)), /Feudal/i);
  assert.equal(queueResearch(w, tc, 'castle_age'), false);

  grant(w, PLAYER, 'feudal_age');
  assert.equal(currentAge(w, PLAYER), AGE.FEUDAL);
  assert.equal(researchRefusal(w, PLAYER, 'castle_age', tc), null);
  assert.equal(queueResearch(w, tc, 'castle_age'), true);
  run(w, TECHS.castle_age.time + 1);
  assert.equal(currentAge(w, PLAYER), AGE.CASTLE);
  assert.equal(nextAgeTech(w, PLAYER), null, 'nothing left to advance to');
});

test('the age is per player — the enemy does not ride along', () => {
  const { w, tc } = techWorld();
  grant(w, PLAYER, 'feudal_age');
  assert.equal(currentAge(w, PLAYER), AGE.FEUDAL);
  assert.equal(currentAge(w, ENEMY), AGE.DARK);
  assert.equal(hasTech(w, ENEMY, 'feudal_age'), false);
  assert.ok(tc);
});

test('aging up scales building hitpoints, for what is already standing', () => {
  const { w, tc, mill } = techWorld();
  const baseTc = BUILDING_STATS.towncenter.hp;
  assert.equal(tc.maxHp, baseTc);
  assert.equal(buildingHpScale(w, PLAYER), 1);

  // Wound the mill so the scaling has a fraction to preserve.
  mill.hp = Math.round(mill.maxHp * 0.5);

  grant(w, PLAYER, 'feudal_age');
  assert.ok(tc.maxHp > baseTc, `Feudal Town Center should be tougher, got ${tc.maxHp}`);
  assert.equal(tc.hp, tc.maxHp, 'an undamaged building stays undamaged');
  assert.ok(Math.abs(mill.hp / mill.maxHp - 0.5) < 0.02,
    'a wounded building keeps its wound as a fraction, it is not healed by the age');

  const feudalTc = tc.maxHp;
  grant(w, PLAYER, 'castle_age');
  assert.ok(tc.maxHp > feudalTc, 'and again in the Castle Age');
});

test('a building placed after an age-up is born at the new age scale', () => {
  const { w } = techWorld();
  grant(w, PLAYER, 'feudal_age');
  const f = placeFoundation(w, PLAYER, 'house', 40, 40);
  assert.ok(f, 'placement succeeded');
  assert.equal(f.maxHp, Math.round(BUILDING_STATS.house.hp * buildingHpScale(w, PLAYER)));
  // applyAgeHp is idempotent — calling it again changes nothing.
  const before = { hp: f.hp, maxHp: f.maxHp };
  applyAgeHp(w, f);
  applyAgeHp(w, f);
  assert.deepEqual({ hp: f.hp, maxHp: f.maxHp }, before);
});

// ===========================================================================
// 2. Building unlocks per age
// ===========================================================================

test('the Dark Age opens the economy and the barracks, and nothing else', () => {
  const { w } = techWorld();
  for (const t of ['towncenter', 'house', 'mill', 'lumbercamp', 'miningcamp', 'farm', 'barracks']) {
    assert.equal(ageForBuilding(t), AGE.DARK, `${t} is a Dark Age building`);
    assert.equal(isUnlocked(w, PLAYER, t), true, `${t} should be buildable at the start`);
    assert.equal(lockReason(w, PLAYER, t), null);
  }
});

test('unlock lists skip building types that do not exist yet', () => {
  const { w } = techWorld();
  const types = unlockedTypes(w, PLAYER);
  for (const t of types) {
    assert.ok(BUILDING_STATS[t], `unlockedTypes returned "${t}", which is not a building`);
  }
  // The forward-declared names in the table must not leak out as real types.
  // 'keep' and 'market' are still only names; nothing may report them buildable.
  for (const ghost of ['keep', 'market', 'siegeworkshop', 'palisadewall']) {
    assert.equal(types.includes(ghost), false, `${ghost} is not a building yet`);
  }
  // The Castle and the stone wall are real buildings now, and they are gated by
  // age rather than by existence — a Dark Age player has neither, and that is
  // the age table doing its job rather than the type being missing.
  assert.ok(BUILDING_STATS.castle && BUILDING_STATS.stonewall);
  assert.equal(types.includes('castle'), false);
  assert.equal(types.includes('stonewall'), false);
  // The palisade is Dark Age, so it *is* in the list from the first second.
  assert.equal(types.includes('palisade'), true);
});

test('an unknown building type is never permanently locked out', () => {
  // The safe failure mode: a key nobody predicted defaults to Dark Age rather
  // than to an age that does not exist, so a building added later is at worst
  // available too early — never a dead button.
  assert.equal(ageForBuilding('definitelynotabuilding'), AGE.DARK);
});

test('a building added later slots into its age with no edit to the tables', () => {
  // The whole unlock design rests on this: another pass is adding the Castle,
  // the walls and the tower, and when their BUILDING_STATS entries land they
  // must be age-gated correctly without anyone touching tech.js. Simulate that
  // by adding one here — the same thing that pass will do — and check the
  // gating picks it up.
  const key = 'castle';
  const existed = Object.prototype.hasOwnProperty.call(BUILDING_STATS, key);
  if (existed) {
    // It has already landed. Then the claim is simply that it is Castle Age.
    assert.equal(ageForBuilding(key), AGE.CASTLE);
    return;
  }
  BUILDING_STATS[key] = {
    name: 'Castle', hp: 4800, fw: 4, fh: 4,
    cost: { food: 0, wood: 0, gold: 0, stone: 650 },
    buildTime: 80, trains: [], lineOfSight: 8,
  };
  try {
    const { w } = techWorld();
    assert.equal(ageForBuilding(key), AGE.CASTLE, 'named in the Castle Age table');
    assert.equal(isUnlocked(w, PLAYER, key), false);
    assert.match(String(lockReason(w, PLAYER, key)), /Castle .* Castle Age/);
    assert.equal(unlockedTypes(w, PLAYER).includes(key), false);

    grant(w, PLAYER, 'feudal_age');
    assert.equal(isUnlocked(w, PLAYER, key), false, 'Feudal is not enough');
    grant(w, PLAYER, 'castle_age');
    assert.equal(isUnlocked(w, PLAYER, key), true);
    assert.equal(lockReason(w, PLAYER, key), null);
    assert.equal(unlockedTypes(w, PLAYER).includes(key), true);
  } finally {
    delete BUILDING_STATS[key];
  }
});

test('a stone-costing building nobody named still lands after the Dark Age', () => {
  const key = '__unnamed_stone_thing__';
  BUILDING_STATS[key] = {
    name: 'Watch Post', hp: 500, fw: 1, fh: 1,
    cost: { food: 0, wood: 0, gold: 0, stone: 125 },
    buildTime: 20, trains: [],
  };
  try {
    const { w } = techWorld();
    assert.equal(ageForBuilding(key), AGE.FEUDAL,
      'stone is the tell: in AoE2 nothing you pay stone for is a Dark Age building');
    assert.equal(isUnlocked(w, PLAYER, key), false);
    grant(w, PLAYER, 'feudal_age');
    assert.equal(isUnlocked(w, PLAYER, key), true);
  } finally {
    delete BUILDING_STATS[key];
  }
});

test('a locked building is refused at placement, with the age in the message', () => {
  const { w } = techWorld();
  // Synthesise the gate rather than depending on another pass having landed a
  // Feudal building yet: whatever the table says needs Feudal, must behave.
  const feudalType = Object.keys(BUILDING_STATS)
    .find((t) => ageForBuilding(t) === AGE.FEUDAL);
  if (!feudalType) {
    // No Feudal building exists in this build. Assert the rule directly instead,
    // so this test still means something before the other pass lands.
    assert.match(String(lockReason(w, PLAYER, 'barracks')), /^$|^null$/);
    assert.equal(lockReason(w, PLAYER, 'barracks'), null);
    return;
  }
  const why = lockReason(w, PLAYER, feudalType);
  assert.ok(why && /Feudal Age/.test(why), `expected an age message, got ${why}`);
  assert.equal(canPlaceReachable(w, PLAYER, feudalType, 40, 40), false);
  assert.equal(placementRefusal(w, PLAYER, feudalType, 40, 40), why,
    'the ghost and the toast say the same sentence');

  const toasts = record(w, EV.TOAST);
  const before = { ...w.players[PLAYER].resources };
  assert.equal(placeFoundation(w, PLAYER, feudalType, 40, 40), null);
  assert.deepEqual(w.players[PLAYER].resources, before, 'a refused placement charges nothing');
  assert.ok(toasts.some((t) => /Feudal Age/.test(t.text)));

  grant(w, PLAYER, 'feudal_age');
  assert.equal(lockReason(w, PLAYER, feudalType), null, 'aging up unlocks it');
});

// ===========================================================================
// 3. Economic upgrades
// ===========================================================================

test('an economic upgrade raises the measured gather rate, not just a number', () => {
  const w = blankWorld();
  spawnBuilding(w, 'lumbercamp', PLAYER, 10, 10);
  w.players[PLAYER].resources = { food: 9000, wood: 9000, gold: 9000, stone: 9000 };
  const tree = spawnResource(w, 'tree', 14, 10);
  const vil = spawnUnit(w, 'villager', PLAYER, 13, 10);
  reindex(w);

  // Measure: how much wood does one villager pull out of a tree in ten seconds?
  const chopFor = (seconds) => {
    vil.carrying = { type: null, amount: 0 };
    vil.gatherProgress = 0;
    tree.amount = tree.maxAmount;
    const steps = Math.ceil(seconds / SIM_DT);
    let got = 0;
    for (let i = 0; i < steps; i++) {
      // Empty the pack every step so CARRY_CAPACITY never caps the measurement.
      gatherTick(w, vil, tree, SIM_DT);
      got += vil.carrying.amount;
      vil.carrying = { type: null, amount: 0 };
    }
    return got;
  };

  const plain = chopFor(10);
  assert.ok(plain > 0, 'the villager chopped something to begin with');
  assert.equal(gatherMultiplier(w, PLAYER, RES.WOOD), 1);

  grant(w, PLAYER, 'doublebitaxe');
  const boost = TECHS.doublebitaxe.gather.wood;
  assert.ok(Math.abs(gatherMultiplier(w, PLAYER, RES.WOOD) - (1 + boost)) < 1e-9);

  const upgraded = chopFor(10);
  assert.ok(upgraded > plain,
    `Double-Bit Axe must actually chop faster: ${plain} -> ${upgraded}`);
  // Within a unit either way of the advertised percentage — the loop banks
  // whole units, so a fractional remainder is expected and is not a bug.
  const expected = plain * (1 + boost);
  assert.ok(Math.abs(upgraded - expected) <= 2,
    `expected about ${expected.toFixed(1)} wood, got ${upgraded}`);

  // Second tier stacks additively, AoE2-style.
  grant(w, PLAYER, 'bowsaw');
  assert.ok(Math.abs(gatherMultiplier(w, PLAYER, RES.WOOD) - (1 + boost * 2)) < 1e-9);
  assert.ok(chopFor(10) > upgraded, 'and Bow Saw on top is faster again');
});

test('gatherRateFor is player-aware and defaults to the base rate', () => {
  const { w } = techWorld();
  const base = gatherRateFor(RES.FOOD);
  assert.equal(gatherRateFor(RES.FOOD, w, PLAYER), base, 'nothing researched yet');
  grant(w, PLAYER, 'horsecollar');
  const boosted = gatherRateFor(RES.FOOD, w, PLAYER);
  assert.ok(boosted > base, `${base} -> ${boosted}`);
  assert.equal(gatherRateFor(RES.FOOD), base, 'no player given, no upgrade applied');
  assert.equal(gatherRateFor(RES.FOOD, w, ENEMY), base, 'and it is per player');
});

test('each economic line only touches its own resource', () => {
  const { w } = techWorld();
  grant(w, PLAYER, 'horsecollar');
  assert.ok(gatherMultiplier(w, PLAYER, RES.FOOD) > 1);
  for (const r of [RES.WOOD, RES.GOLD, RES.STONE]) {
    assert.equal(gatherMultiplier(w, PLAYER, r), 1, `${r} should be untouched by Horse Collar`);
  }
  grant(w, PLAYER, 'goldmining');
  assert.ok(gatherMultiplier(w, PLAYER, RES.GOLD) > 1);
  assert.equal(gatherMultiplier(w, PLAYER, RES.STONE), 1,
    'gold and stone are separate techs even though they share a building');
});

test('economic upgrades sit at the drop-off building they belong to', () => {
  assert.equal(researchBuildingFor('horsecollar'), 'mill');
  assert.equal(researchBuildingFor('heavyplough'), 'mill');
  assert.equal(researchBuildingFor('doublebitaxe'), 'lumbercamp');
  assert.equal(researchBuildingFor('bowsaw'), 'lumbercamp');
  for (const id of ['goldmining', 'goldshaftmining', 'stonemining', 'stoneshaftmining']) {
    assert.equal(researchBuildingFor(id), 'miningcamp');
  }
  assert.ok(techsAt('mill').includes('horsecollar'));
  assert.ok(!techsAt('barracks').includes('horsecollar'));
});

// ===========================================================================
// 4. Military upgrades
// ===========================================================================

/** Hit `target` once with `attacker` and report the damage the sim applied. */
function oneHit(world, attacker, target) {
  const before = target.hp;
  applyDamage(world, attacker, target, effectiveAttack(world, attacker));
  return before - target.hp;
}

test('a military upgrade raises damage dealt by units that were ALREADY alive', () => {
  const w = blankWorld();
  w.players[PLAYER].resources = { food: 9000, wood: 9000, gold: 9000, stone: 9000 };
  const attacker = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const victim = spawnUnit(w, 'militia', ENEMY, 11, 10);
  victim.maxHp = victim.hp = 100000;   // a punching bag, so nothing dies mid-test
  reindex(w);

  const plain = oneHit(w, attacker, victim);
  assert.ok(plain > 0);

  // The upgrade lands while this exact militia is standing in the field.
  grant(w, PLAYER, 'forging');

  const upgraded = oneHit(w, attacker, victim);
  assert.equal(upgraded, plain + TECHS.forging.attack.melee,
    `Forging must help the militia that is already alive: ${plain} -> ${upgraded}`);
  assert.equal(attacker.attack, UNIT_STATS.militia.attack,
    'the base stat on the unit is left alone — the bonus is a property of the player');
});

test('armour upgrades reduce damage taken by units already alive', () => {
  const w = blankWorld();
  const attacker = spawnUnit(w, 'militia', ENEMY, 10, 10);
  const victim = spawnUnit(w, 'militia', PLAYER, 11, 10);
  victim.maxHp = victim.hp = 100000;
  reindex(w);

  const plain = oneHit(w, attacker, victim);
  grant(w, PLAYER, 'scalemail');
  const soaked = oneHit(w, attacker, victim);
  assert.equal(soaked, plain - TECHS.scalemail.armor.melee,
    `Scale Mail must soak a point: ${plain} -> ${soaked}`);
  assert.equal(victim.armor, UNIT_STATS.militia.armor, 'base armour untouched');
  assert.equal(effectiveArmor(w, victim), UNIT_STATS.militia.armor + 1);
});

test('attack and armour upgrades are class-specific', () => {
  const w = blankWorld();
  const militia = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const archer = spawnUnit(w, 'archer', PLAYER, 11, 10);
  const villager = spawnUnit(w, 'villager', PLAYER, 12, 10);
  reindex(w);

  assert.equal(unitClass('militia'), 'melee');
  assert.equal(unitClass('archer'), 'ranged');
  assert.equal(unitClass('villager'), 'worker');

  grant(w, PLAYER, 'forging');
  assert.equal(attackBonus(w, militia), 1);
  assert.equal(attackBonus(w, archer), 0, 'Forging is not an archer upgrade');
  assert.equal(attackBonus(w, villager), 0);

  grant(w, PLAYER, 'fletching');
  assert.equal(attackBonus(w, archer), 1);
  assert.equal(attackBonus(w, militia), 1, 'still just the one melee tier');

  grant(w, PLAYER, 'paddedarcher');
  assert.equal(armorBonus(w, archer), 1);
  assert.equal(armorBonus(w, militia), 0);
});

test('upgrades are per player — the enemy is not upgraded by your blacksmith', () => {
  const w = blankWorld();
  const mine = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const theirs = spawnUnit(w, 'militia', ENEMY, 11, 10);
  reindex(w);
  grant(w, PLAYER, 'forging');
  assert.equal(attackBonus(w, mine), 1);
  assert.equal(attackBonus(w, theirs), 0);
});

test('damage still floors at MIN_DAMAGE however much armour is stacked', () => {
  const w = blankWorld();
  const attacker = spawnUnit(w, 'villager', ENEMY, 10, 10);   // 3 attack
  const victim = spawnUnit(w, 'militia', PLAYER, 11, 10);
  victim.maxHp = victim.hp = 100000;
  reindex(w);
  grant(w, PLAYER, 'scalemail');
  grant(w, PLAYER, 'chainmail');
  const dealt = oneHit(w, attacker, victim);
  assert.ok(dealt >= MIN_DAMAGE, `armour must never make a unit immune, got ${dealt}`);
});

// ===========================================================================
// 5. Research mechanics
// ===========================================================================

test('researching the same tech twice is a no-op and does not charge twice', () => {
  const { w, lumber, p } = techWorld();
  grant(w, PLAYER, 'feudal_age');

  const before = { ...p.resources };
  assert.equal(queueResearch(w, lumber, 'doublebitaxe'), true);
  const afterFirst = { ...p.resources };
  const bill = spent(before, afterFirst);
  assert.ok(bill.food > 0 || bill.wood > 0);

  // Queued but not finished: a second request must be refused, not stacked.
  assert.equal(queueResearch(w, lumber, 'doublebitaxe'), false);
  assert.deepEqual(p.resources, afterFirst, 'the second attempt charged nothing');
  assert.equal(lumber.research.length, 1);

  run(w, TECHS.doublebitaxe.time + 1);
  assert.equal(hasTech(w, PLAYER, 'doublebitaxe'), true);
  const afterDone = { ...p.resources };
  const mult = gatherMultiplier(w, PLAYER, RES.WOOD);

  // Finished: a third request must be refused, charge nothing, and above all
  // must not apply the bonus a second time.
  assert.equal(queueResearch(w, lumber, 'doublebitaxe'), false);
  assert.equal(completeResearch(w, PLAYER, 'doublebitaxe'), false,
    'completeResearch is idempotent even when called directly');
  assert.deepEqual(p.resources, afterDone);
  assert.equal(gatherMultiplier(w, PLAYER, RES.WOOD), mult, 'the effect did not double');
  assert.equal(researchedTechs(w, PLAYER).filter((t) => t === 'doublebitaxe').length, 1);
});

test('an age-up cannot be researched twice either', () => {
  const { w, tc, p } = techWorld();
  grant(w, PLAYER, 'feudal_age');
  const before = { ...p.resources };
  assert.equal(queueResearch(w, tc, 'feudal_age'), false);
  assert.deepEqual(p.resources, before);
  assert.equal(currentAge(w, PLAYER), AGE.FEUDAL, 'and the age did not jump');
});

test('a building researches one thing at a time but may queue more', () => {
  const { w, mining } = techWorld();
  grant(w, PLAYER, 'feudal_age');
  assert.equal(queueResearch(w, mining, 'goldmining'), true);
  assert.equal(queueResearch(w, mining, 'stonemining'), true);
  assert.equal(mining.research.length, 2);
  assert.equal(researchProgress(mining) < 1, true);

  run(w, TECHS.goldmining.time + 0.5);
  assert.equal(hasTech(w, PLAYER, 'goldmining'), true);
  assert.equal(hasTech(w, PLAYER, 'stonemining'), false, 'the second one is still going');
  assert.equal(mining.research.length, 1);

  run(w, TECHS.stonemining.time + 1);
  assert.equal(hasTech(w, PLAYER, 'stonemining'), true);
  assert.equal(mining.research.length, 0);
});

test('the research queue is capped', () => {
  const { w, blacksmith } = techWorld();
  grant(w, PLAYER, 'feudal_age');
  const available = techsAt('blacksmith')
    .filter((id) => researchRefusal(w, PLAYER, id, blacksmith) === null);
  assert.ok(available.length > MAX_RESEARCH_QUEUE,
    'this test needs more available techs than the cap');
  let queued = 0;
  for (const id of available) {
    if (queueResearch(w, blacksmith, id)) queued++;
  }
  assert.equal(queued, MAX_RESEARCH_QUEUE);
  assert.equal(blacksmith.research.length, MAX_RESEARCH_QUEUE);
});

test('research does not reserve population the way training does', () => {
  const { w, tc, p } = techWorld();
  recomputePop(w, PLAYER);
  const pop = p.pop;
  queueResearch(w, tc, 'feudal_age');
  recomputePop(w, PLAYER);
  assert.equal(p.pop, pop,
    'a research in the queue must not eat a population slot — see the note in tech.js');
});

test('cancelling a research refunds it in full', () => {
  const { w, mill, p } = techWorld();
  grant(w, PLAYER, 'feudal_age');
  const before = { ...p.resources };
  queueResearch(w, mill, 'horsecollar');
  assert.notDeepEqual(p.resources, before);
  assert.equal(cancelResearch(w, mill, 0), true);
  assert.deepEqual(p.resources, before, 'full refund, as cancelling training gives');
  assert.equal(mill.research.length, 0);
  assert.equal(hasTech(w, PLAYER, 'horsecollar'), false);
});

test('a tech is refused at the wrong building, and says where it belongs', () => {
  const { w, mill, lumber } = techWorld();
  grant(w, PLAYER, 'feudal_age');
  const why = researchRefusal(w, PLAYER, 'doublebitaxe', mill);
  assert.match(String(why), /Lumber Camp/i);
  assert.equal(queueResearch(w, mill, 'doublebitaxe'), false);
  assert.equal(queueResearch(w, lumber, 'doublebitaxe'), true);
});

test('a tech is refused at an unfinished building', () => {
  const { w } = techWorld();
  grant(w, PLAYER, 'feudal_age');
  const site = placeFoundation(w, PLAYER, 'mill', 40, 40);
  assert.ok(site && !site.complete);
  assert.match(String(researchRefusal(w, PLAYER, 'horsecollar', site)), /construction/i);
  assert.equal(queueResearch(w, site, 'horsecollar'), false);
});

test('the age gate on techs is real', () => {
  const { w, lumber, mill } = techWorld();
  assert.match(String(researchRefusal(w, PLAYER, 'doublebitaxe', lumber)), /Feudal Age/);
  assert.equal(queueResearch(w, lumber, 'doublebitaxe'), false);
  grant(w, PLAYER, 'feudal_age');
  assert.equal(researchRefusal(w, PLAYER, 'doublebitaxe', lumber), null);
  // Castle-tier is still out of reach, and says so as a prerequisite first.
  assert.match(String(researchRefusal(w, PLAYER, 'heavyplough', mill)), /Horse Collar/i);
  grant(w, PLAYER, 'horsecollar');
  assert.match(String(researchRefusal(w, PLAYER, 'heavyplough', mill)), /Castle Age/);
});

test('researchOptions describes every tech at a building, done ones included', () => {
  const { w, lumber } = techWorld();
  let opts = researchOptions(w, PLAYER, lumber);
  assert.equal(opts.length, techsAt('lumbercamp').length);
  assert.deepEqual(opts.map((o) => o.status), ['locked', 'locked']);
  assert.ok(opts[0].reason, 'a locked option carries the reason it is locked');
  assert.ok(opts[0].blurb, 'and what it would do, so the age-up can be judged');

  grant(w, PLAYER, 'feudal_age');
  opts = researchOptions(w, PLAYER, lumber);
  assert.equal(opts[0].status, 'ready');

  queueResearch(w, lumber, 'doublebitaxe');
  assert.equal(researchOptions(w, PLAYER, lumber)[0].status, 'active');

  run(w, TECHS.doublebitaxe.time + 1);
  assert.equal(researchOptions(w, PLAYER, lumber)[0].status, 'done');
});

test('researchOptions separates an age lock from a prerequisite lock', () => {
  // The HUD shows the first and folds away the second, so getting these the
  // wrong way round either hides what the next age buys or fills a phone panel
  // with four tiers of the same upgrade line.
  const { w, lumber } = techWorld();
  let byId = Object.fromEntries(researchOptions(w, PLAYER, lumber).map((o) => [o.id, o]));
  assert.equal(byId.doublebitaxe.gate, 'age', 'tier one is behind the Feudal Age');
  assert.equal(byId.bowsaw.gate, 'prereq',
    'tier two is behind tier one, even though it is also behind the Castle Age');

  grant(w, PLAYER, 'feudal_age');
  grant(w, PLAYER, 'doublebitaxe');
  byId = Object.fromEntries(researchOptions(w, PLAYER, lumber).map((o) => [o.id, o]));
  assert.equal(byId.doublebitaxe.status, 'done');
  assert.equal(byId.bowsaw.gate, 'age', 'with its prerequisite done, only the age is left');

  grant(w, PLAYER, 'castle_age');
  byId = Object.fromEntries(researchOptions(w, PLAYER, lumber).map((o) => [o.id, o]));
  assert.equal(byId.bowsaw.gate, null);
  assert.equal(byId.bowsaw.status, 'ready');
});

test('researchOptions marks affordable-but-broke as poor, not locked', () => {
  const { w, lumber, p } = techWorld();
  grant(w, PLAYER, 'feudal_age');
  p.resources = { food: 0, wood: 0, gold: 0, stone: 0 };
  const opt = researchOptions(w, PLAYER, lumber)[0];
  assert.equal(opt.status, 'poor');
  assert.match(String(opt.reason), /resources/i);
  assert.equal(canAfford(w, PLAYER, opt.cost), false);
});

test('a destroyed building loses its queue but the player keeps what finished', () => {
  const { w, lumber } = techWorld();
  grant(w, PLAYER, 'feudal_age');
  queueResearch(w, lumber, 'doublebitaxe');
  run(w, TECHS.doublebitaxe.time + 1);
  assert.equal(hasTech(w, PLAYER, 'doublebitaxe'), true);

  queueResearch(w, lumber, 'bowsaw');
  lumber.dead = true;                       // razed mid-research
  run(w, TECHS.bowsaw.time + 1);
  assert.equal(hasTech(w, PLAYER, 'bowsaw'), false, 'a razed camp finishes nothing');
  assert.equal(hasTech(w, PLAYER, 'doublebitaxe'), true, 'but what was done stays done');
  assert.ok(gatherMultiplier(w, PLAYER, RES.WOOD) > 1);
});

test('updateResearch is safe to call on a world nobody has researched in', () => {
  const w = blankWorld();
  updateResearch(w, SIM_DT);
  assert.equal(currentAge(w, PLAYER), AGE.DARK);
  assert.equal(researchedTechs(w, PLAYER).length, 0);
});

test('every tech in the table is well-formed and reachable', () => {
  for (const id of TECH_IDS) {
    const t = TECHS[id];
    assert.ok(t.name, `${id} has a name`);
    assert.ok(Array.isArray(t.at) && t.at.length, `${id} names a building`);
    assert.ok(t.time > 0, `${id} takes time`);
    assert.ok(t.cost && Object.keys(t.cost).length, `${id} costs something`);
    assert.ok(t.age >= AGE.DARK && t.age <= AGE.CASTLE, `${id} has a sane age`);
    if (t.requires) {
      assert.ok(TECHS[t.requires], `${id} requires a real tech`);
      assert.ok(TECHS[t.requires].age <= t.age, `${id} cannot precede its prerequisite`);
    }
    assert.ok(researchBuildingFor(id), `${id} has a building that exists today`);
    assert.ok(t.blurb || t.advancesTo !== undefined, `${id} explains itself in the HUD`);
  }
  // Every carry-capacity assumption in the gather test above still holds.
  assert.ok(CARRY_CAPACITY > 0);
});

// --- summary ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err && f.err.stack}`);
  process.exit(1);
}
