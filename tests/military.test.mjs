// Headless tests for the military layer: the counter triangle, stances,
// formations, garrisoning, and the fog rule that governs all of it.
//
//   node tests/military.test.mjs
//
// Everything runs on a blank world — no mapgen — so no fight is ever decided by
// where the generator happened to put a tree. The sim is stepped exactly the
// way GameScene.simStep() does it, vision included, because since the fog
// landed *vision is part of combat*: a unit that cannot see a target cannot
// pick one, and a harness that skips world.vision.update() is a harness in
// which nothing ever fights.
//
// The five things this file exists to hold down, in the order they would hurt
// if they broke:
//
//   1. The counters are real. Spearmen beat cavalry, cavalry beat archers,
//      archers beat infantry — proved by fighting equal-cost armies, not by
//      reading the bonus table back to itself.
//   2. Each stance behaves differently. A stance that is only a label is worse
//      than no stance, because the player has been told a lie about their army.
//   3. Nothing auto-attacks through fog. This is the bug the fog pass found and
//      handed over; it must not come back.
//   4. Garrisoning keeps the population honest and heals. A unit that is off the
//      map but still costs pop is a very specific accounting claim.
//   5. An upgrade applies to units that were already alive. Inherited from
//      tech.js and re-asserted here, because the counter bonus now rides in the
//      same arithmetic and could easily have displaced it.

import {
  SIM_DT, PLAYER, ENEMY, UNIT_STATS, BONUS_DAMAGE, MIN_DAMAGE,
  STANCE, FORMATION, ARMOR_CLASS, MILITARY_TYPES,
  GARRISON_ARROW_DAMAGE,
} from '../src/core/constants.js';
import {
  createWorld, spawnUnit, spawnBuilding, reindex, recomputePop, ownedBy,
} from '../src/core/world.js';
import {
  updateCombat, applyDamage, effectiveAttack, bonusDamage, armorClassOf,
  stanceOf, setStance, garrisonUnit, ungarrisonUnit, ungarrisonAll,
  garrisonCount, garrisonCapacity, isGarrisoned, canSee,
} from '../src/systems/combat.js';
import { commandUnits, updateUnits } from '../src/systems/unitAI.js';
import { updateEconomy } from '../src/systems/economy.js';
import { unitLineOfSight } from '../src/systems/vision.js';
import { completeResearch } from '../src/systems/tech.js';

// --- Micro test framework ---------------------------------------------------

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'expected equal'}: ${a} !== ${b}`);
}

// --- Sim harness ------------------------------------------------------------

/** An empty grass field. No mapgen: nothing here is about terrain. */
function field(seed = 90210) {
  const w = createWorld(seed);
  reindex(w);
  return w;
}

/** One fixed step, in GameScene.simStep()'s order, vision included. */
function step(world, n = 1) {
  for (let i = 0; i < n; i++) {
    for (const u of world.units) { u.px = u.x; u.py = u.y; }
    reindex(world);
    updateUnits(world, SIM_DT);
    updateCombat(world, SIM_DT);
    updateEconomy(world, SIM_DT);
    world.vision.update();
    world.time += SIM_DT;
    world.tick++;
  }
}

function stepUntil(world, maxSteps, pred) {
  for (let i = 0; i < maxSteps; i++) {
    if (pred()) return i;
    step(world);
  }
  return pred() ? maxSteps : -1;
}

const alive = (list) => list.filter((u) => !u.dead).length;

// ===========================================================================
// 1. The counter triangle
// ===========================================================================
//
// Equal *cost*, not equal numbers. That is the only comparison that means
// anything: a spearman is 60 resources and a scout is 80, so four spearmen and
// three scouts are the same purchase, and if the four do not win the counter is
// decoration. Both sides are given an attack-move at the other, which is the
// order a player actually issues, and the fight is run until one side is gone.

function costOf(type) {
  const c = UNIT_STATS[type].cost;
  return (c.food || 0) + (c.wood || 0) + (c.gold || 0);
}

/**
 * Fight `budget` resources of one type against `budget` of another on open
 * ground. Returns both survivor counts.
 */
function equalCostFight(typeA, typeB, budget = 480, maxSeconds = 100) {
  const w = field();
  const nA = Math.max(1, Math.round(budget / costOf(typeA)));
  const nB = Math.max(1, Math.round(budget / costOf(typeB)));
  const ax = 20;
  const bx = 32;
  const A = [];
  const B = [];
  // Two blocks facing each other down a lane, spaced a tile apart so nothing is
  // decided by separation steering shoving somebody out of the fight.
  for (let i = 0; i < nA; i++) A.push(spawnUnit(w, typeA, PLAYER, ax, 30 + i));
  for (let i = 0; i < nB; i++) B.push(spawnUnit(w, typeB, ENEMY, bx, 30 + i));
  recomputePop(w, PLAYER);
  recomputePop(w, ENEMY);
  reindex(w);
  w.vision.update();

  commandUnits(w, A, { type: 'attackMove', gx: bx, gy: 30 + (nB - 1) / 2 });
  commandUnits(w, B, { type: 'attackMove', gx: ax, gy: 30 + (nA - 1) / 2 });

  stepUntil(w, Math.round(maxSeconds / SIM_DT), () => alive(A) === 0 || alive(B) === 0);
  return { w, A, B, nA, nB, aLeft: alive(A), bLeft: alive(B) };
}

test('spearmen beat cavalry for the same money', () => {
  const r = equalCostFight('spearman', 'scout');
  assert(
    r.aLeft > 0 && r.bLeft === 0,
    `${r.nA} spearmen vs ${r.nB} scouts ended ${r.aLeft} v ${r.bLeft}`,
  );
});

test('cavalry beat archers for the same money', () => {
  const r = equalCostFight('scout', 'archer');
  assert(
    r.aLeft > 0 && r.bLeft === 0,
    `${r.nA} scouts vs ${r.nB} archers ended ${r.aLeft} v ${r.bLeft}`,
  );
});

test('archers beat infantry for the same money', () => {
  const r = equalCostFight('archer', 'militia');
  assert(
    r.aLeft > 0 && r.bLeft === 0,
    `${r.nA} archers vs ${r.nB} militia ended ${r.aLeft} v ${r.bLeft}`,
  );
});

test('the triangle closes: each counter loses to the one that counters it', () => {
  // The other three corners, run the other way round, so a unit that simply
  // beats everything would be caught here rather than looking like three
  // separate successes above.
  const spearVsArcher = equalCostFight('spearman', 'archer');
  assert(spearVsArcher.aLeft === 0,
    `spearmen should lose to archers, ended ${spearVsArcher.aLeft} v ${spearVsArcher.bLeft}`);
  const archerVsScout = equalCostFight('archer', 'scout');
  assert(archerVsScout.aLeft === 0,
    `archers should lose to cavalry, ended ${archerVsScout.aLeft} v ${archerVsScout.bLeft}`);
});

test('the bonus is applied at the swing, not baked into the unit', () => {
  const w = field();
  const spear = spawnUnit(w, 'spearman', PLAYER, 10, 10);
  const horse = spawnUnit(w, 'scout', ENEMY, 10.9, 10);
  const foot = spawnUnit(w, 'militia', ENEMY, 10, 10.9);

  eq(spear.attack, UNIT_STATS.spearman.attack, 'the sheet stat is untouched');
  eq(effectiveAttack(w, spear), UNIT_STATS.spearman.attack, 'and so is the sheet reading');
  eq(bonusDamage(spear, horse), BONUS_DAMAGE.spearman.cavalry, 'anti-cavalry, against cavalry');
  eq(bonusDamage(spear, foot), 0, 'and nothing at all against infantry');
  eq(
    effectiveAttack(w, spear, horse),
    UNIT_STATS.spearman.attack + BONUS_DAMAGE.spearman.cavalry,
    'the same swing is worth more against the thing it counters',
  );
});

test('damage is max(MIN_DAMAGE, attack + bonus - armour)', () => {
  const w = field();
  const spear = spawnUnit(w, 'spearman', PLAYER, 10, 10);
  const horse = spawnUnit(w, 'scout', ENEMY, 10.9, 10);
  const before = horse.hp;
  const dealt = applyDamage(w, spear, horse, effectiveAttack(w, spear, horse));
  eq(
    dealt,
    UNIT_STATS.spearman.attack + BONUS_DAMAGE.spearman.cavalry - UNIT_STATS.scout.armor,
    'attack plus bonus minus armour',
  );
  eq(horse.hp, before - dealt, 'and that is what came off');

  // The floor. A ram's 4 armour soaks more than a militia swings.
  const ram = spawnUnit(w, 'ram', ENEMY, 12, 10);
  const weak = spawnUnit(w, 'villager', PLAYER, 12.5, 10);
  assert(
    applyDamage(w, weak, ram, effectiveAttack(w, weak, ram)) === MIN_DAMAGE,
    'heavy armour never makes anything immune',
  );
});

test('siege exists to knock buildings down and nothing else', () => {
  const w = field();
  const ram = spawnUnit(w, 'ram', PLAYER, 10, 10);
  const tc = spawnBuilding(w, 'towncenter', ENEMY, 20, 20);
  const foot = spawnUnit(w, 'militia', ENEMY, 10.9, 10);
  assert(
    bonusDamage(ram, tc) > 10 * effectiveAttack(w, ram, foot),
    'a ram is an order of magnitude better against masonry than against men',
  );
  eq(armorClassOf(tc), ARMOR_CLASS.BUILDING, 'masonry is its own armour class');
});

test('every unit sees further than it shoots', () => {
  // The invariant HANDOFF-vision.md handed over when DEFAULT_UNIT_LOS and
  // LOS_RANGE_MARGIN moved into constants.js. It used to be guaranteed by a
  // derivation; now the values are written out per unit, so it is guaranteed by
  // this. A unit that out-ranges its own sight auto-acquires targets its owner
  // cannot see, which is the ugliest thing a fog can do.
  for (const type of Object.keys(UNIT_STATS)) {
    const s = UNIT_STATS[type];
    assert(
      unitLineOfSight(type) > s.range,
      `${type} shoots ${s.range} tiles but sees only ${unitLineOfSight(type)}`,
    );
  }
});

test('every soldier declares an armour class, and the roster knows who is one', () => {
  for (const type of MILITARY_TYPES) {
    assert(UNIT_STATS[type].armorClass, `${type} has no armourClass`);
    assert(UNIT_STATS[type].attack > 0, `${type} is in the roster but cannot fight`);
  }
  assert(MILITARY_TYPES.length >= 5, `only ${MILITARY_TYPES.length} unit types in the roster`);
  assert(!MILITARY_TYPES.includes('villager'), 'a villager is not a soldier');
});

// ===========================================================================
// 2. Fog: nothing auto-attacks what its side cannot see
// ===========================================================================

test('a unit does not auto-acquire a target hidden by fog', () => {
  const w = field();
  // Six tiles: inside ENGAGE_RANGE (7.5) and well inside AGGRO_RANGE's reach of
  // the acquisition scan, but two tiles past a militia's line of sight of 4.
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const foe = spawnUnit(w, 'villager', ENEMY, 16, 10);
  foe.hp = foe.maxHp = 100000;
  reindex(w);
  w.vision.update();

  assert(!canSee(w, m, foe), 'the militia genuinely cannot see it');
  step(w, 40); // two seconds of looking
  eq(m.target, null, 'and so it never picks it as a target');
  eq(foe.hp, foe.maxHp, 'and never lands a blow on it');

  // Now give the army eyes. A scout sees 7, and vision is shared across the
  // player's whole side — so the militia may now legally engage what the scout
  // is lighting, exactly as in AoE2.
  spawnUnit(w, 'scout', PLAYER, 10, 10);
  step(w, 40);
  eq(m.target, foe, 'with something of ours lighting the ground, it engages');
});

test('a soldier shot out of the dark does not charge into it', () => {
  const w = field();
  const sniper = spawnUnit(w, 'archer', ENEMY, 10, 10);
  sniper.range = 9;                        // outranges what the victim can see
  const victim = spawnUnit(w, 'militia', PLAYER, 18, 10);
  reindex(w);
  w.vision.update();

  stepUntil(w, 400, () => victim.hp < victim.maxHp);
  assert(victim.hp < victim.maxHp, 'the sniper is hitting it');
  eq(victim.target, null, 'but there is nothing there to charge');
});

test('a player-ordered attack still works on a target that walks into fog', () => {
  const w = field();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const foe = spawnUnit(w, 'villager', ENEMY, 11, 10);
  foe.hp = foe.maxHp = 100000;
  reindex(w);
  w.vision.update();

  commandUnits(w, [m], { type: 'attack', target: foe });
  eq(m.target, foe, 'the order lands');
  eq(m.autoTarget, false, 'and it is an order, not an acquisition');
  step(w, 20);
  eq(m.target, foe, 'an explicit order is not second-guessed by the fog');
});

// ===========================================================================
// 3. Stances
// ===========================================================================

test('villagers default to No Attack and soldiers to Aggressive', () => {
  const w = field();
  eq(stanceOf(spawnUnit(w, 'villager', PLAYER, 10, 10)), STANCE.NO_ATTACK);
  eq(stanceOf(spawnUnit(w, 'militia', PLAYER, 11, 10)), STANCE.AGGRESSIVE);
  eq(stanceOf(spawnUnit(w, 'archer', PLAYER, 12, 10)), STANCE.AGGRESSIVE);
});

test('No Attack never acquires, even with an enemy in its face', () => {
  const w = field();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  setStance(m, STANCE.NO_ATTACK);
  const foe = spawnUnit(w, 'villager', ENEMY, 10.9, 10);
  foe.hp = foe.maxHp = 100000;
  reindex(w);
  w.vision.update();

  step(w, 60);
  eq(m.target, null, 'no target, ever');
  eq(foe.hp, foe.maxHp, 'and not a scratch on the enemy');
});

test('Stand Ground fights what walks in and never takes a step', () => {
  const w = field();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  setStance(m, STANCE.STAND_GROUND);
  // Three tiles: inside its line of sight, outside its reach.
  const foe = spawnUnit(w, 'villager', ENEMY, 13, 10);
  foe.hp = foe.maxHp = 100000;
  reindex(w);
  w.vision.update();

  step(w, 40);
  eq(m.target, null, 'a target it cannot hit from here is not a target');
  eq(m.x, 10, 'and it has not moved a tile');

  // Walk the enemy into its reach.
  foe.x = 10.9;
  step(w, 40);
  eq(m.target, foe, 'what comes to it, it fights');
  assert(foe.hp < foe.maxHp, 'and it is actually swinging');
  eq(m.x, 10, 'still without moving');

  // ...and the moment the target steps back out, it lets go rather than chase.
  foe.x = 14;
  step(w, 20);
  eq(m.target, null, 'it does not follow');
  eq(m.x, 10, 'it is still exactly where it was put');
});

test('Defensive chases, then walks back to the post it was covering', () => {
  const w = field();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  setStance(m, STANCE.DEFENSIVE);
  const foe = spawnUnit(w, 'villager', ENEMY, 12, 10);
  foe.hp = foe.maxHp = 100000;
  reindex(w);
  w.vision.update();

  const got = stepUntil(w, 60, () => m.target === foe);
  assert(got >= 0, 'it engages something two tiles away');

  // The quarry runs. The leash snaps, and a defensive unit goes home.
  foe.x = 30;
  stepUntil(w, 400, () => Math.hypot(m.x - 10, m.y - 10) < 0.6 && !m.target);
  assert(
    Math.hypot(m.x - 10, m.y - 10) < 0.6,
    `defensive unit ended ${Math.hypot(m.x - 10, m.y - 10).toFixed(2)} tiles from its post`,
  );
});

test('Aggressive keeps the ground it took', () => {
  const w = field();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  eq(stanceOf(m), STANCE.AGGRESSIVE, 'the default');
  const foe = spawnUnit(w, 'villager', ENEMY, 12, 10);
  foe.hp = foe.maxHp = 100000;
  reindex(w);
  w.vision.update();

  stepUntil(w, 60, () => m.target === foe);
  foe.x = 30;
  stepUntil(w, 300, () => !m.target);
  step(w, 60);
  assert(
    Math.hypot(m.x - 10, m.y - 10) > 1.0,
    'an aggressive unit does not trudge home — that is what Defensive is for',
  );
});

test('a stance is a property of the unit, and switching it takes effect at once', () => {
  const w = field();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const foe = spawnUnit(w, 'villager', ENEMY, 10.9, 10);
  foe.hp = foe.maxHp = 100000;
  reindex(w);
  w.vision.update();

  stepUntil(w, 60, () => m.target === foe);
  assert(m.target, 'engaged');
  commandUnits(w, [m], { type: 'stance', stance: STANCE.NO_ATTACK });
  eq(m.target, null, 'switching to No Attack drops the fight in the same breath');
  step(w, 40);
  eq(m.target, null, 'and it stays dropped');
});

// ===========================================================================
// 4. Formations
// ===========================================================================

/** Extent of a group along and across its direction of travel. */
function spreadOf(units, dirX, dirY) {
  let cx = 0;
  let cy = 0;
  for (const u of units) { cx += u.x; cy += u.y; }
  cx /= units.length;
  cy /= units.length;
  let along = 0;
  let across = 0;
  for (const u of units) {
    const dx = u.x - cx;
    const dy = u.y - cy;
    along = Math.max(along, Math.abs(dx * dirX + dy * dirY));
    across = Math.max(across, Math.abs(dx * -dirY + dy * dirX));
  }
  return { along, across, cx, cy };
}

function marchTo(w, units, gx, gy, formation) {
  commandUnits(w, units, { type: 'formation', formation });
  commandUnits(w, units, { type: 'move', gx, gy });
  stepUntil(w, 900, () => units.every((u) => u.state === 'idle'));
}

test('a Line formation arrives in ranks, wider than it is deep', () => {
  const w = field();
  const units = [];
  for (let i = 0; i < 12; i++) units.push(spawnUnit(w, 'militia', PLAYER, 10 + (i % 4), 10 + Math.floor(i / 4)));
  reindex(w);
  marchTo(w, units, 30, 11.5, FORMATION.LINE);

  const s = spreadOf(units, 1, 0);
  assert(
    s.across > s.along,
    `line arrived ${s.across.toFixed(2)} wide by ${s.along.toFixed(2)} deep`,
  );
  assert(Math.hypot(s.cx - 30, s.cy - 11.5) < 3, 'and it arrived where it was sent');
});

test('a Box formation puts the ranged units inside and the tough ones out', () => {
  const w = field();
  const melee = [];
  const shooters = [];
  for (let i = 0; i < 12; i++) melee.push(spawnUnit(w, 'militia', PLAYER, 10 + (i % 4), 10 + Math.floor(i / 4)));
  for (let i = 0; i < 4; i++) shooters.push(spawnUnit(w, 'archer', PLAYER, 10 + i, 14));
  const units = melee.concat(shooters);
  reindex(w);
  marchTo(w, units, 30, 12, FORMATION.BOX);

  const s = spreadOf(units, 1, 0);
  const mean = (list) =>
    list.reduce((a, u) => a + Math.hypot(u.x - s.cx, u.y - s.cy), 0) / list.length;
  assert(
    mean(shooters) < mean(melee),
    `archers averaged ${mean(shooters).toFixed(2)} from the centre, militia ${mean(melee).toFixed(2)}`,
  );
});

test('a Spread formation stands further apart than a Line', () => {
  const nearest = (units) => {
    let total = 0;
    for (const u of units) {
      let best = Infinity;
      for (const v of units) {
        if (v === u) continue;
        best = Math.min(best, Math.hypot(u.x - v.x, u.y - v.y));
      }
      total += best;
    }
    return total / units.length;
  };

  const build = (formation) => {
    const w = field();
    const units = [];
    for (let i = 0; i < 12; i++) {
      units.push(spawnUnit(w, 'militia', PLAYER, 10 + (i % 4), 10 + Math.floor(i / 4)));
    }
    reindex(w);
    marchTo(w, units, 30, 11.5, formation);
    return nearest(units);
  };

  const line = build(FORMATION.LINE);
  const spread = build(FORMATION.SPREAD);
  assert(
    spread > line * 1.4,
    `spread averaged ${spread.toFixed(2)} tiles apart against a line's ${line.toFixed(2)}`,
  );
});

test('a group arrives as a body, not as a conga line', () => {
  const w = field();
  const units = [];
  for (let i = 0; i < 16; i++) units.push(spawnUnit(w, 'militia', PLAYER, 10 + (i % 4), 10 + Math.floor(i / 4)));
  reindex(w);
  marchTo(w, units, 34, 12, FORMATION.LINE);
  const s = spreadOf(units, 1, 0);
  // Sixteen units in ranks of seven is at most three deep and four wide either
  // side of centre; anything much past that is a queue, not a formation.
  assert(s.along < 4.5, `group arrived ${s.along.toFixed(2)} tiles deep`);
});

// ===========================================================================
// 5. Garrison
// ===========================================================================

test('garrisoning takes a unit off the map but not off the population', () => {
  const w = field();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 20, 20);
  const troops = [];
  for (let i = 0; i < 3; i++) troops.push(spawnUnit(w, 'militia', PLAYER, 18, 19 + i));
  recomputePop(w, PLAYER);
  reindex(w);

  const popBefore = w.players[PLAYER].pop;
  eq(popBefore, 3, 'three bodies, three population');

  for (const u of troops) assert(garrisonUnit(w, u, tc), 'went in');
  recomputePop(w, PLAYER);

  eq(garrisonCount(tc), 3, 'the Town Center is holding three');
  eq(w.players[PLAYER].pop, popBefore, 'and they still cost exactly what they did');
  for (const u of troops) {
    assert(!w.units.includes(u), 'off the map');
    assert(w.entities.has(u.id), 'but still in the world');
    assert(isGarrisoned(u), 'and it knows where it is');
  }
  assert(ownedBy(w, PLAYER, 'unit').length === 3, 'still three units owned');

  // ...and back out again.
  eq(ungarrisonAll(w, tc), 3, 'all three came out');
  recomputePop(w, PLAYER);
  eq(garrisonCount(tc), 0, 'the building is empty');
  eq(w.players[PLAYER].pop, popBefore, 'population unchanged by the round trip');
  for (const u of troops) {
    assert(w.units.includes(u), 'back on the map');
    assert(!isGarrisoned(u), 'and free');
    assert(Math.hypot(u.x - tc.x, u.y - tc.y) < 5, 'standing beside the building it left');
  }
});

test('a garrisoned unit heals, slowly', () => {
  const w = field();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 20, 20);
  const m = spawnUnit(w, 'militia', PLAYER, 18, 20);
  m.hp = 5;
  reindex(w);
  garrisonUnit(w, m, tc);

  step(w, 20); // one second
  assert(m.hp > 5, `no healing at all (hp ${m.hp})`);
  assert(m.hp < m.maxHp, 'and it is not an instant repair');

  step(w, 20 * 60);
  eq(m.hp, m.maxHp, 'a minute inside is a full recovery');
});

test('a garrison order walks the unit in by itself', () => {
  const w = field();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 20, 20);
  const v = spawnUnit(w, 'villager', PLAYER, 26, 20);
  recomputePop(w, PLAYER);
  reindex(w);

  commandUnits(w, [v], { type: 'garrison', target: tc });
  const took = stepUntil(w, 600, () => isGarrisoned(v));
  assert(took >= 0, 'the villager never got inside');
  eq(garrisonCount(tc), 1, 'and it is the one in there');
});

test('a full building refuses, and capacity is what the stats say', () => {
  const w = field();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 20, 20);
  const cap = garrisonCapacity(tc);
  assert(cap > 0, 'a Town Center is a shelter');

  const troops = [];
  for (let i = 0; i < cap + 2; i++) troops.push(spawnUnit(w, 'militia', PLAYER, 16, 14 + i * 0.6));
  reindex(w);
  let inside = 0;
  for (const u of troops) if (garrisonUnit(w, u, tc)) inside++;
  eq(inside, cap, 'exactly capacity got in');
  eq(garrisonCount(tc), cap, 'and the building agrees');
});

test('every garrisoned body is one more arrow in the volley', () => {
  const shoot = (bodies) => {
    const w = field();
    const tc = spawnBuilding(w, 'towncenter', PLAYER, 20, 20);
    for (let i = 0; i < bodies; i++) {
      garrisonUnit(w, spawnUnit(w, 'villager', PLAYER, 18, 19 + i * 0.5), tc);
    }
    // A target parked in the open, two tiles off the wall and well inside the
    // Town Center's reach. Huge hitpoints, so the measurement is of arrows in
    // the air rather than of how fast it dies.
    const foe = spawnUnit(w, 'militia', ENEMY, 24, 20);
    foe.hp = foe.maxHp = 100000;
    reindex(w);
    w.vision.update();
    step(w, 20 * 6);
    return foe.maxHp - foe.hp;
  };

  const none = shoot(0);
  const one = shoot(1);
  const four = shoot(4);
  eq(none, 0, 'an empty Town Center throws nothing');
  assert(one > 0, 'one villager inside makes it shoot at all');
  assert(
    four > one * 2,
    `four bodies did ${four} damage against one body's ${one} — the volley does not scale`,
  );
  assert(one >= GARRISON_ARROW_DAMAGE, 'and an arrow is worth what the constant says');
});

test('a building does not shoot what its owner cannot see', () => {
  const w = field();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 20, 20);
  garrisonUnit(w, spawnUnit(w, 'villager', PLAYER, 18, 20), tc);
  reindex(w);
  w.vision.update();

  // A Town Center sees 9 (8 plus half its 3x3 footprint) and the default
  // garrison volley reaches 6, so there is no position where it can shoot
  // blind. Prove the gate directly instead: an entity the mask does not cover.
  const foe = spawnUnit(w, 'militia', ENEMY, 24, 20);
  foe.hp = foe.maxHp = 100000;
  const mask = w.vision.state(PLAYER).visible;
  const tile = Math.floor(foe.y) * w.width + Math.floor(foe.x);
  assert(mask[tile] === 1, 'the ground the foe stands on is lit');
  step(w, 40);
  assert(foe.hp < foe.maxHp, 'so it is shot');

  const hpLit = foe.hp;
  // Blind the mask over the target and confirm the volley stops. (Nothing in
  // the game writes the mask by hand; this is a test reaching in to isolate the
  // one rule under examination.)
  const patch = () => { mask[tile] = 0; };
  patch();
  for (let i = 0; i < 40; i++) { step(w, 1); patch(); }
  eq(foe.hp, hpLit, 'blind, the building holds its fire');
});

test('garrisoned units are ejected rather than deleted when the building falls', () => {
  const w = field();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 20, 20);
  const troops = [];
  for (let i = 0; i < 3; i++) troops.push(spawnUnit(w, 'militia', PLAYER, 18, 19 + i));
  recomputePop(w, PLAYER);
  reindex(w);
  for (const u of troops) garrisonUnit(w, u, tc);

  const foe = spawnUnit(w, 'ram', ENEMY, 24, 20);
  applyDamage(w, foe, tc, 100000);
  assert(tc.dead, 'the Town Center is down');

  recomputePop(w, PLAYER);
  for (const u of troops) {
    assert(!u.dead, 'the garrison survives the building');
    assert(!isGarrisoned(u), 'and is back on the map');
    assert(w.units.includes(u), 'in world.units, where every system can see it');
  }
  eq(w.players[PLAYER].pop, 3, 'population is still honest afterwards');
});

// ===========================================================================
// 6. Attack-move
// ===========================================================================

test('attack-move stops for a fight and then carries on', () => {
  const w = field();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const foe = spawnUnit(w, 'villager', ENEMY, 16, 10);
  reindex(w);
  w.vision.update();

  commandUnits(w, [m], { type: 'attackMove', gx: 30, gy: 10 });
  const engaged = stepUntil(w, 600, () => m.target === foe);
  assert(engaged >= 0, 'it stopped for what it met');
  stepUntil(w, 600, () => foe.dead);
  assert(foe.dead, 'and finished it');
  const arrived = stepUntil(w, 1200, () => m.state === 'idle' && Math.abs(m.x - 30) < 1.5);
  assert(arrived >= 0, `it never resumed — ended at ${m.x.toFixed(1)}`);
});

test('attack-move under No Attack is just a march', () => {
  const w = field();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  setStance(m, STANCE.NO_ATTACK);
  const foe = spawnUnit(w, 'villager', ENEMY, 16, 10);
  foe.hp = foe.maxHp = 100000;
  reindex(w);
  w.vision.update();

  commandUnits(w, [m], { type: 'attackMove', gx: 30, gy: 10 });
  stepUntil(w, 1200, () => m.state === 'idle' && Math.abs(m.x - 30) < 1.5);
  eq(foe.hp, foe.maxHp, 'it walked past without a swing');
  assert(Math.abs(m.x - 30) < 1.5, 'and it got where it was sent');
});

// ===========================================================================
// 7. Upgrades still reach units that were already alive
// ===========================================================================

test('a military upgrade applies to an army that is already standing', () => {
  const w = field();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const foe = spawnUnit(w, 'scout', ENEMY, 10.9, 10);
  foe.hp = foe.maxHp = 100000;

  const before = effectiveAttack(w, m, foe);
  const dealtBefore = applyDamage(w, m, foe, before);

  assert(completeResearch(w, PLAYER, 'forging'), 'Forging finished');

  const after = effectiveAttack(w, m, foe);
  eq(after, before + 1, 'the unit that was already alive swings harder');
  eq(m.attack, UNIT_STATS.militia.attack, 'without its sheet stat being rewritten');
  const dealtAfter = applyDamage(w, m, foe, after);
  eq(dealtAfter, dealtBefore + 1, 'and the extra actually lands');
});

test('an upgrade and a counter bonus stack, and neither displaces the other', () => {
  const w = field();
  const spear = spawnUnit(w, 'spearman', PLAYER, 10, 10);
  const horse = spawnUnit(w, 'scout', ENEMY, 10.9, 10);
  completeResearch(w, PLAYER, 'forging');
  eq(
    effectiveAttack(w, spear, horse),
    UNIT_STATS.spearman.attack + 1 + BONUS_DAMAGE.spearman.cavalry,
    'base + Forging + anti-cavalry',
  );
  // The enemy's spearmen are unaffected: research is a fact about a player.
  const theirs = spawnUnit(w, 'spearman', ENEMY, 12, 10);
  eq(
    effectiveAttack(w, theirs, spawnUnit(w, 'scout', PLAYER, 12.9, 10)),
    UNIT_STATS.spearman.attack + BONUS_DAMAGE.spearman.cavalry,
    'their spearmen never bought Forging',
  );
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
  process.exit(1);
}
