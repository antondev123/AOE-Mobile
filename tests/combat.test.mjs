// Headless tests for systems/combat.js. Run: node tests/combat.test.mjs
//
// unitAI.js is being written concurrently, so units are driven here by setting
// positions and targets directly — nothing in this file imports unitAI.

import {
  createWorld, spawnUnit, spawnBuilding, reindex, tileIndex,
} from '../src/core/world.js';
import {
  SIM_DT, PLAYER, ENEMY, MIN_DAMAGE, CHASE_LEASH, AGGRO_RANGE, UNIT_STATS,
  PROJECTILE_SPEED,
} from '../src/core/constants.js';
import { EV } from '../src/core/events.js';
import {
  updateCombat, applyDamage, canAttack, inRange, isAttackMoving, ENGAGE_RANGE,
} from '../src/systems/combat.js';
// Pure naming helper; importing the HUD module headlessly touches no DOM.
import { underAttackText } from '../src/ui/hud.js';

// --- tiny harness -----------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'expected equal'}: ${a} !== ${b}`);
}

/** One sim step, mirroring GameScene.simStep minus the other systems. */
function step(world, n = 1) {
  for (let i = 0; i < n; i++) {
    reindex(world);
    updateCombat(world, SIM_DT);
    world.time += SIM_DT;
    world.tick++;
  }
}
/** Steps until `pred` or `max` steps; returns the step count used. */
function stepUntil(world, pred, max = 400) {
  let n = 0;
  while (n < max && !pred()) {
    step(world);
    n++;
  }
  return n;
}
function fresh() {
  return createWorld(4242);
}

// --- inRange / canAttack ----------------------------------------------------

test('canAttack: hostile units only, no friendly fire, no resources', () => {
  const w = fresh();
  const mine = spawnUnit(w, 'militia', PLAYER, 5, 5);
  const friend = spawnUnit(w, 'villager', PLAYER, 5.5, 5);
  const foe = spawnUnit(w, 'villager', ENEMY, 5.5, 5);
  const tree = w.resources[0] || null;

  assert(canAttack(mine, foe), 'should attack an enemy unit');
  assert(!canAttack(mine, friend), 'must not attack an ally');
  assert(!canAttack(mine, mine), 'must not attack itself');
  assert(!canAttack(foe, foe), 'self check both ways');
  if (tree) assert(!canAttack(mine, tree), 'must not attack resources');
  const foeTc = spawnBuilding(w, 'towncenter', ENEMY, 20, 20);
  assert(canAttack(mine, foeTc), 'buildings are attackable');
  assert(!canAttack(foeTc, mine), 'buildings do not fight back');
});

test('inRange: melee reaches a 3x3 Town Center by its edge, not its centre', () => {
  const w = fresh();
  const tc = spawnBuilding(w, 'towncenter', ENEMY, 20, 20);
  // Stand just outside the west wall of the footprint.
  const m = spawnUnit(w, 'militia', PLAYER, tc.x - tc.fw / 2 - 0.5, tc.y);
  assert(inRange(m, tc), 'melee unit at the wall should be in range');
  // The same unit could not reach a *unit* standing on the Town Center's centre.
  const dummy = spawnUnit(w, 'villager', ENEMY, tc.x, tc.y);
  assert(!inRange(m, dummy), 'the centre itself is far out of melee reach');

  const far = spawnUnit(w, 'militia', PLAYER, tc.x - tc.fw / 2 - 4, tc.y);
  assert(!inRange(far, tc), 'four tiles from the wall is out of melee range');
});

test('inRange: archers out-range melee', () => {
  const w = fresh();
  const a = spawnUnit(w, 'archer', PLAYER, 10, 10);
  const m = spawnUnit(w, 'militia', ENEMY, 14, 10);
  assert(inRange(a, m), 'archer reaches 4 tiles');
  assert(!inRange(m, a), 'militia does not');
});

// --- damage / armour --------------------------------------------------------

test('armour reduces damage but never below MIN_DAMAGE', () => {
  const w = fresh();
  const attacker = spawnUnit(w, 'militia', PLAYER, 1, 1);
  const target = spawnUnit(w, 'militia', ENEMY, 2, 1); // armor 1

  const dealt = applyDamage(w, attacker, target, 6);
  eq(dealt, 5, 'militia armour 1 shaves one point off a 6 hit');
  eq(target.hp, UNIT_STATS.militia.hp - 5, 'hp reduced by the post-armour amount');

  const tiny = applyDamage(w, attacker, target, 0);
  eq(tiny, MIN_DAMAGE, 'a 0 damage hit still lands MIN_DAMAGE');

  target.armor = 999;
  const chipped = applyDamage(w, attacker, target, 6);
  eq(chipped, MIN_DAMAGE, 'huge armour is floored at MIN_DAMAGE, never immune');
});

test('EV.DAMAGE reports the post-armour amount', () => {
  const w = fresh();
  const a = spawnUnit(w, 'militia', PLAYER, 1, 1);
  const t = spawnUnit(w, 'militia', ENEMY, 2, 1);
  const seen = [];
  w.events.on(EV.DAMAGE, (p) => seen.push(p));
  applyDamage(w, a, t, 6);
  eq(seen.length, 1, 'one damage event');
  eq(seen[0].amount, 5, 'post-armour amount');
  eq(seen[0].entity, a, 'attacker in payload');
  eq(seen[0].target, t, 'target in payload');
});

// --- melee resolution -------------------------------------------------------

test('a militia kills a villager in a bounded number of steps', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const v = spawnUnit(w, 'villager', ENEMY, 10.9, 10);
  m.target = v;
  assert(inRange(m, v), 'set up in range');

  const steps = stepUntil(w, () => v.dead, 400);
  assert(v.dead, `villager should die (took ${steps} steps)`);
  // 30hp / 6dmg = 5 swings at 1.1s => ~5.5s + stagger. Must not grind.
  const secs = steps * SIM_DT;
  assert(secs < 9, `fight resolves in seconds, took ${secs.toFixed(1)}s`);
  assert(secs > 2, `and is not instant, took ${secs.toFixed(1)}s`);
});

test('a militia beats a villager comfortably in a mutual fight', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const v = spawnUnit(w, 'villager', ENEMY, 10.9, 10);
  m.target = v;
  v.target = m; // player-ordered villager: it fights back
  stepUntil(w, () => v.dead || m.dead, 400);
  assert(v.dead && !m.dead, 'militia wins');
  assert(m.hp > m.maxHp * 0.6, `and wins comfortably (hp ${m.hp}/${m.maxHp})`);
});

test('cooldowns are staggered so a squad does not hit on one frame', () => {
  const w = fresh();
  const foe = spawnUnit(w, 'militia', ENEMY, 10, 10);
  foe.hp = foe.maxHp = 100000;
  const squad = [];
  for (let i = 0; i < 4; i++) {
    const m = spawnUnit(w, 'militia', PLAYER, 10.9 + i * 0.001, 10);
    m.target = foe;
    squad.push(m);
  }
  const hitTicks = [];
  w.events.on(EV.DAMAGE, () => hitTicks.push(w.tick));
  step(w, 40);
  assert(hitTicks.length >= 4, 'everyone swung');
  eq(new Set(hitTicks.slice(0, 4)).size > 1, true, 'first swings land on different ticks');
});

test('attackAnim is set on a swing and decays', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const v = spawnUnit(w, 'villager', ENEMY, 10.9, 10);
  v.hp = v.maxHp = 100000;
  m.target = v;
  stepUntil(w, () => m.attackAnim > 0, 60);
  assert(m.attackAnim > 0, 'swing pose set for the renderer');
  const first = m.attackAnim;
  step(w);
  assert(m.attackAnim < first, 'and it decays');
  assert(m.cooldown > 0, 'cooldown reset after firing');
});

// --- death / cleanup --------------------------------------------------------

test('a dead unit leaves world.units, world.entities and its owner set', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const v = spawnUnit(w, 'villager', ENEMY, 10.9, 10);
  const deaths = [];
  w.events.on(EV.DEATH, (p) => deaths.push(p));
  m.target = v;
  stepUntil(w, () => v.dead, 400);

  eq(deaths.length, 1, 'one death event');
  eq(deaths[0].entity, v, 'death payload carries the victim');
  eq(deaths[0].killer, m, 'and the killer');
  eq(w.units.includes(v), false, 'removed from world.units');
  eq(w.entities.has(v.id), false, 'removed from world.entities');
  eq(w.players[ENEMY].owned.has(v.id), false, "removed from the owner's owned set");
  eq(m.target, null, 'attacker dropped the dead target');
});

// --- projectiles ------------------------------------------------------------

test("an archer's projectile spawns, travels and lands damage", () => {
  const w = fresh();
  const a = spawnUnit(w, 'archer', PLAYER, 10, 10);
  const m = spawnUnit(w, 'militia', ENEMY, 14, 10);
  a.target = m;

  const launched = [];
  w.events.on(EV.PROJECTILE, (p) => launched.push(p));

  stepUntil(w, () => w.projectiles.length > 0, 60);
  eq(w.projectiles.length, 1, 'one arrow in flight');
  eq(launched.length, 1, 'EV.PROJECTILE emitted');
  const p = w.projectiles[0];
  eq(p.owner, a, 'owner is the archer');
  eq(p.target, m, 'target recorded');
  // It launched from the archer and has flown at most one step so far.
  assert(p.x >= a.x && p.x - a.x <= PROJECTILE_SPEED * SIM_DT + 1e-9, 'launched from the archer');
  assert(Math.abs(p.y - a.y) < 1e-9, 'flying straight down the line');
  assert(p.x < m.x, 'not there yet');
  eq(m.hp, m.maxHp, 'no damage yet — the arrow is still in the air');

  const startX = p.x;
  step(w);
  assert(p.x > startX, 'arrow advances toward the target');
  assert(p.x <= m.x + 0.001, 'and does not overshoot');

  stepUntil(w, () => m.hp < m.maxHp, 60);
  eq(m.hp, m.maxHp - (UNIT_STATS.archer.attack - UNIT_STATS.militia.armor), 'arrow damage landed');
  eq(w.projectiles.length, 0, 'arrow consumed on impact');
});

test('an arrow homes onto a moving target', () => {
  const w = fresh();
  const a = spawnUnit(w, 'archer', PLAYER, 10, 10);
  const m = spawnUnit(w, 'militia', ENEMY, 14, 10);
  a.target = m;
  stepUntil(w, () => w.projectiles.length > 0, 60);
  // The militia sidesteps while the arrow is in the air.
  m.y = 12;
  const hit = stepUntil(w, () => m.hp < m.maxHp, 120);
  assert(m.hp < m.maxHp, `arrow still connected after ${hit} steps`);
});

test('a target dying mid-flight does not break the arrow', () => {
  const w = fresh();
  const a = spawnUnit(w, 'archer', PLAYER, 10, 10);
  const m = spawnUnit(w, 'militia', ENEMY, 14, 10);
  a.target = m;
  stepUntil(w, () => w.projectiles.length > 0, 60);
  eq(w.projectiles.length, 1, 'arrow away');

  // Something else kills the militia while the arrow is still flying.
  applyDamage(w, null, m, 10000);
  assert(m.dead, 'target died mid-flight');
  eq(w.projectiles[0].target, m, 'arrow still points at the corpse this frame');

  step(w, 60);
  eq(w.projectiles.length, 0, 'arrow landed somewhere and was cleaned up');
  eq(w.units.includes(m), false, 'corpse gone');
});

// --- buildings --------------------------------------------------------------

test('a destroyed building frees its footprint in world.blocked', () => {
  const w = fresh();
  const house = spawnBuilding(w, 'house', ENEMY, 20, 20);
  for (const [tx, ty] of house.tiles) {
    eq(w.blocked[tileIndex(w, tx, ty)], 1, 'footprint blocked while standing');
  }
  const m = spawnUnit(w, 'militia', PLAYER, house.x - house.fw / 2 - 0.5, house.y);
  m.target = house;
  assert(inRange(m, house), 'militia is at the wall');

  const steps = stepUntil(w, () => house.dead, 3000);
  assert(house.dead, `house razed in ${steps} steps`);
  for (const [tx, ty] of house.tiles) {
    eq(w.blocked[tileIndex(w, tx, ty)], 0, 'footprint freed after destruction');
    eq(w.occupant[tileIndex(w, tx, ty)], 0, 'occupant cleared');
  }
  eq(w.buildings.includes(house), false, 'removed from world.buildings');
  eq(w.players[ENEMY].owned.has(house.id), false, 'removed from owned set');
});

test('buildings take full damage (no armour field) and cannot be over-killed', () => {
  const w = fresh();
  const b = spawnBuilding(w, 'barracks', ENEMY, 25, 25);
  const a = spawnUnit(w, 'militia', PLAYER, 25, 25);
  eq(applyDamage(w, a, b, 6), 6, 'no armour on buildings');
  applyDamage(w, a, b, 100000);
  assert(b.dead, 'destroyed');
  eq(applyDamage(w, a, b, 10), 0, 'further hits on a dead building are no-ops');
});

// --- auto-acquisition / leashing -------------------------------------------

test('an idle soldier auto-acquires a hostile inside AGGRO_RANGE', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const v = spawnUnit(w, 'villager', ENEMY, 10 + AGGRO_RANGE - 1, 10);
  step(w);
  eq(m.target, v, 'target acquired');
  eq(m.autoTarget, true, 'flagged as auto so it can be leashed');
  eq(m.postX, 10, 'leash anchored where it engaged');
});

test('nothing is acquired beyond AGGRO_RANGE', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  spawnUnit(w, 'villager', ENEMY, 10 + AGGRO_RANGE + 3, 10);
  step(w, 5);
  eq(m.target, null, 'too far to notice');
});

test('villagers never auto-attack and flee when struck', () => {
  const w = fresh();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 6, 6);
  const v = spawnUnit(w, 'villager', PLAYER, 15, 15);
  const foe = spawnUnit(w, 'militia', ENEMY, 16, 15);
  step(w, 3);
  eq(v.target, null, 'villager did not pick a fight');
  assert(foe.target === v, 'the militia, however, did');

  stepUntil(w, () => v.fleeing, 80);
  eq(v.fleeing, true, 'villager panics when hit');
  eq(v.target, null, 'and is not trading blows');
  assert(v.fleeTo && v.fleeTo.x === tc.x && v.fleeTo.y === tc.y, 'runs for the Town Center');
  assert(v.fleeUntil > w.time - 1, 'flee flag has a deadline unitAI can honour');
});

test('a soldier shot from out of aggro range charges the shooter', () => {
  const w = fresh();
  const a = spawnUnit(w, 'archer', ENEMY, 10, 10);
  a.range = AGGRO_RANGE + 4; // a sniper, well outside what the militia can notice
  const m = spawnUnit(w, 'militia', PLAYER, 10 + AGGRO_RANGE + 2, 10);
  a.target = m;
  assert(!inRange(m, a), 'militia cannot see or reach the archer');
  assert(inRange(a, m), 'but the archer can hit it');
  stepUntil(w, () => m.hp < m.maxHp, 200);
  eq(m.target, a, 'retaliates against whoever shot it');
  eq(m.autoTarget, true, 'and that chase is leashed');
});

test('leashing drops an auto-acquired target beyond CHASE_LEASH', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const v = spawnUnit(w, 'villager', ENEMY, 12, 10);
  v.hp = v.maxHp = 100000;
  step(w);
  eq(m.target, v, 'acquired');

  // The villager runs away across the map (unitAI would have walked the
  // militia after it; here we only care that the leash snaps).
  v.x = 10 + CHASE_LEASH + 5;
  step(w, 2);
  eq(m.target, null, 'target dropped past the leash');
  eq(m.autoTarget, false, 'auto flag cleared');
  assert(m.returnTo && m.returnTo.x === 10 && m.returnTo.y === 10, 'told to return to its post');

  // It must not re-acquire the same runaway from its post.
  step(w, 5);
  eq(m.target, null, 'stays home');
});

test('a unit chasing but still swinging keeps its target at the leash edge', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const v = spawnUnit(w, 'villager', ENEMY, 12, 10);
  v.hp = v.maxHp = 100000;
  step(w);
  eq(m.target, v, 'acquired');
  // Both moved well past the leash, but they are toe to toe: finish the kill.
  m.x = 10 + CHASE_LEASH + 4;
  v.x = m.x + 0.9;
  step(w);
  eq(m.target, v, 'does not disengage from a target it is currently hitting');
});

test('player-ordered attacks are never leashed', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const v = spawnUnit(w, 'villager', ENEMY, 12, 10);
  v.hp = v.maxHp = 100000;
  step(w);
  eq(m.target, v, 'auto-acquired first');

  // The player now explicitly re-issues the attack on the same unit.
  m.target = v;
  m.autoTarget = false;
  v.x = 10 + CHASE_LEASH + 20;
  step(w, 5);
  eq(m.target, v, 'explicit order survives any distance');
});

test('an auto target that becomes invalid is dropped', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const v = spawnUnit(w, 'villager', ENEMY, 12, 10);
  step(w);
  eq(m.target, v, 'acquired');
  v.player = PLAYER; // defected
  step(w);
  eq(m.target, null, 'no longer hostile, target dropped');
});

// --- feel ------------------------------------------------------------------

test('an archer kiting a militia wins; standing still it loses', () => {
  // Archer vs militia toe to toe: the militia should win.
  {
    const w = fresh();
    const a = spawnUnit(w, 'archer', PLAYER, 10, 10);
    const m = spawnUnit(w, 'militia', ENEMY, 10.9, 10);
    a.target = m;
    m.target = a;
    stepUntil(w, () => a.dead || m.dead, 800);
    assert(a.dead && !m.dead, 'melee wins the brawl it got into');
  }
  // Archer holding its range: the militia never lands a blow.
  {
    const w = fresh();
    const a = spawnUnit(w, 'archer', PLAYER, 10, 10);
    const m = spawnUnit(w, 'militia', ENEMY, 14, 10);
    a.target = m;
    m.target = a;
    const steps = stepUntil(w, () => m.dead, 800);
    assert(m.dead, `archer kills from range in ${steps} steps`);
    eq(a.hp, a.maxHp, 'without taking a scratch');
  }
});

test('hp drops in legible chunks, not a trickle', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const v = spawnUnit(w, 'villager', ENEMY, 10.9, 10);
  m.target = v;
  const amounts = [];
  w.events.on(EV.DAMAGE, (p) => amounts.push(p.amount));
  stepUntil(w, () => v.dead, 400);
  assert(amounts.length <= 6, `few, large hits (${amounts.length} swings)`);
  assert(amounts.every((a) => a >= v.maxHp * 0.15), 'each hit is a visible chunk');
});

// --- under-attack alerts ----------------------------------------------------
//
// B1 from the playtest: a full match produced zero alerts, so a player lost
// three villagers and a Town Center with no feedback at all. These tests pin
// down both halves of the contract: it fires, and it stays an alert rather than
// becoming a damage log.

test('EV.UNDER_ATTACK fires when one of your units is hit', () => {
  const w = fresh();
  const v = spawnUnit(w, 'villager', PLAYER, 12, 9);
  spawnUnit(w, 'militia', ENEMY, 12.9, 9);
  const seen = [];
  w.events.on(EV.UNDER_ATTACK, (p) => seen.push(p));

  stepUntil(w, () => seen.length > 0, 200);
  eq(seen.length, 1, 'exactly one alert for the first blow');
  eq(seen[0].player, PLAYER, 'addressed to the victim’s owner');
  eq(seen[0].entity, v, 'and names the thing being hit');
  eq(seen[0].gx, 12, 'carries the grid position so the HUD can jump there');
  eq(seen[0].gy, 9, 'both axes');
  assert(v.hp < v.maxHp, 'it really was damage that triggered it');
});

test('EV.UNDER_ATTACK fires for buildings too, and even on a killing blow', () => {
  const w = fresh();
  const house = spawnBuilding(w, 'house', PLAYER, 20, 20);
  const foe = spawnUnit(w, 'militia', ENEMY, 20, 20);
  const seen = [];
  w.events.on(EV.UNDER_ATTACK, (p) => seen.push(p));

  applyDamage(w, foe, house, 1);
  eq(seen.length, 1, 'a building being hit is an alert');
  eq(seen[0].entity, house, 'the building is named');

  // A killing blow is the moment you most need telling.
  const w2 = fresh();
  const v = spawnUnit(w2, 'villager', PLAYER, 8, 8);
  const killer = spawnUnit(w2, 'militia', ENEMY, 8.9, 8);
  const seen2 = [];
  w2.events.on(EV.UNDER_ATTACK, (p) => seen2.push(p));
  applyDamage(w2, killer, v, 100000);
  assert(v.dead, 'villager died in one hit');
  eq(seen2.length, 1, 'the death still raised the alarm');
});

test('the alert is per player, not player-0 only — the HUD filters, not combat', () => {
  const w = fresh();
  const foeVill = spawnUnit(w, 'villager', ENEMY, 30, 30);
  const mine = spawnUnit(w, 'militia', PLAYER, 30.9, 30);
  const seen = [];
  w.events.on(EV.UNDER_ATTACK, (p) => seen.push(p));
  applyDamage(w, mine, foeVill, 1);
  eq(seen.length, 1, 'the AI’s things raise alerts as well');
  eq(seen[0].player, ENEMY, 'tagged with the owner');
});

test('nothing unowned, and no friendly fire, ever raises an alert', () => {
  const w = fresh();
  const a = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const b = spawnUnit(w, 'villager', PLAYER, 11, 10);
  const seen = [];
  w.events.on(EV.UNDER_ATTACK, (p) => seen.push(p));
  applyDamage(w, a, b, 3); // same player: not an attack, whatever caused it
  eq(seen.length, 0, 'your own units hurting each other is not an alarm');
});

test('a sustained beating produces a handful of alerts, not one per hit', () => {
  const w = fresh();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 20, 20);
  tc.hp = tc.maxHp = 1000000; // it must survive the whole minute
  spawnUnit(w, 'militia', ENEMY, 17.5, 20);

  const alerts = [];
  const hits = [];
  w.events.on(EV.UNDER_ATTACK, (p) => alerts.push(p));
  w.events.on(EV.DAMAGE, (p) => hits.push(p));

  step(w, 60 * 20); // a full minute of being ground down

  assert(hits.length > 40, `the beating landed (${hits.length} hits)`);
  assert(alerts.length >= 2, `a minute-long siege re-warns you (${alerts.length})`);
  assert(alerts.length <= 6, `but it is an alert, not a log (${alerts.length})`);
  assert(alerts.length < hits.length / 8, 'orders of magnitude fewer than hits');
});

test('alerts are throttled per player and per locality', () => {
  const w = fresh();
  // A distant attacker so nothing auto-engages while we drive damage by hand.
  const foe = spawnUnit(w, 'militia', ENEMY, 45, 45);
  const near = spawnUnit(w, 'villager', PLAYER, 5, 5);
  const far = spawnUnit(w, 'villager', PLAYER, 30, 30);
  near.hp = near.maxHp = 100000;
  far.hp = far.maxHp = 100000;

  const seen = [];
  w.events.on(EV.UNDER_ATTACK, (p) => seen.push(p));

  applyDamage(w, foe, near, 1);
  eq(seen.length, 1, 'first blow warns you');

  applyDamage(w, foe, far, 1);
  eq(seen.length, 1, 'a second front in the same breath is still one warning');

  step(w, 5 * 20); // past the per-player rate gate
  applyDamage(w, foe, far, 1);
  eq(seen.length, 2, 'a genuinely separate front does get its own warning');
  assert(Math.hypot(seen[1].gx - 30, seen[1].gy - 30) < 0.001, 'pointing at the new fight');

  applyDamage(w, foe, near, 1);
  eq(seen.length, 2, 'and the first locality stays quiet inside its window');

  step(w, 20 * 20); // ~25s in: the first locality's window has lapsed
  applyDamage(w, foe, near, 1);
  eq(seen.length, 3, 'a raid that is still going does eventually re-warn');
});

test('the alert names the thing, the way AoE2 does', () => {
  const w = fresh();
  const tc = spawnBuilding(w, 'towncenter', PLAYER, 20, 20);
  const v = spawnUnit(w, 'villager', PLAYER, 10, 10);
  const m = spawnUnit(w, 'militia', PLAYER, 11, 10);
  eq(underAttackText(tc), 'Your Town Center is under attack!', 'buildings by name');
  eq(underAttackText(v), 'Your villagers are under attack!', 'villagers, plural, as AoE2 says it');
  eq(underAttackText(m), 'Your Militia is under attack!', 'soldiers by name');
});

// --- alert relevance --------------------------------------------------------
//
// Second playtest: a won match delivered 9 alerts, of which 8 were the player's
// own archers taking hits inside the enemy base they had been ordered to storm,
// each one a siren whose "tap to jump there" flew the camera to the *enemy*
// Town Center. That trains a player to ignore the alarm, so the one real
// warning is lost too. The alarm means "something you are not looking after is
// being attacked at home". These tests pin the rule down from both sides.

/** Only the human player's alerts — the AI raises its own and the HUD filters. */
function watchAlerts(w) {
  const seen = [];
  w.events.on(EV.UNDER_ATTACK, (p) => { if (p.player === PLAYER) seen.push(p); });
  return seen;
}
/** A home base far from where the fighting in these tests happens. */
function homeBase(w) {
  return spawnBuilding(w, 'towncenter', PLAYER, 6, 6);
}

test('an army you ordered into the enemy base never raises the alarm', () => {
  const w = fresh();
  homeBase(w);
  const foeTc = spawnBuilding(w, 'towncenter', ENEMY, 40, 40);
  foeTc.hp = foeTc.maxHp = 1000000;
  const seen = watchAlerts(w);

  const archers = [];
  for (let i = 0; i < 4; i++) {
    const a = spawnUnit(w, 'archer', PLAYER, 36, 38 + i * 0.6);
    a.hp = a.maxHp = 100000;
    // Exactly what unitAI.orderAttack does for a player-ordered attack: the
    // task carries no `auto` flag and `target` is set directly, which is what
    // leaves autoTarget false.
    a.task = { type: 'attack', target: foeTc };
    a.target = foeTc;
    archers.push(a);
  }
  const defenders = [];
  for (let i = 0; i < 3; i++) defenders.push(spawnUnit(w, 'militia', ENEMY, 41, 38 + i));

  // ~40 seconds of the assault going as planned, well past every throttle.
  let hits = 0;
  for (let t = 0; t < 40; t++) {
    for (const a of archers) { applyDamage(w, defenders[t % 3], a, 3); hits++; }
    step(w, 20);
  }
  assert(hits > 100, `the army really was being shot at (${hits} hits)`);
  eq(seen.length, 0, `an assault you ordered is not news (${seen.length} alerts)`);
});

test('an attack-moving army taking fire in the field stays silent', () => {
  const w = fresh();
  homeBase(w);
  const seen = watchAlerts(w);
  const m = spawnUnit(w, 'militia', PLAYER, 30, 30);
  m.hp = m.maxHp = 100000;
  m.task = { type: 'move', gx: 40, gy: 40, attackMove: true };
  m.state = 'move';
  assert(isAttackMoving(m), 'flag recognised');
  const foe = spawnUnit(w, 'militia', ENEMY, 30.9, 30);

  applyDamage(w, foe, m, 3);
  eq(seen.length, 0, 'you sent it out to fight and it is fighting');

  // The same army marching out through the edge of your own territory: still
  // your order, still silent. Distance is not what makes an ordered fight
  // expected — the order is. A first cut that let "offensive but near home"
  // through put four midfield battles back on the HUD in a real match.
  const w2 = fresh();
  spawnBuilding(w2, 'towncenter', PLAYER, 20, 20);
  const seen2 = watchAlerts(w2);
  const out = spawnUnit(w2, 'militia', PLAYER, 26, 20);
  out.hp = out.maxHp = 100000;
  out.task = { type: 'move', gx: 40, gy: 20, attackMove: true };
  out.state = 'move';
  applyDamage(w2, spawnUnit(w2, 'militia', ENEMY, 26.9, 20), out, 3);
  eq(seen2.length, 0, 'an ordered fight is expected wherever it happens');
});

test('the silence survives the ordered target dying mid-assault', () => {
  const w = fresh();
  homeBase(w);
  const seen = watchAlerts(w);
  const a = spawnUnit(w, 'archer', PLAYER, 38, 38);
  a.hp = a.maxHp = 100000;
  const foe = spawnUnit(w, 'militia', ENEMY, 39, 38);
  // The building it was sent to kill is gone; combat auto-acquired the next
  // defender, so nothing on the unit says "ordered" any more. Distance from
  // everything the player owns is what has to carry this case.
  a.task = { type: 'attack', target: foe, auto: true };
  a.target = foe;
  a.autoTarget = true;
  a._autoFor = foe;

  applyDamage(w, foe, a, 3);
  eq(seen.length, 0, 'still deep in the enemy base, still not a home emergency');
});

test('a soldier far from anything you own is not a home emergency', () => {
  const w = fresh();
  homeBase(w);
  const seen = watchAlerts(w);
  const m = spawnUnit(w, 'militia', PLAYER, 38, 38);
  m.hp = m.maxHp = 100000;
  const foe = spawnUnit(w, 'militia', ENEMY, 38.9, 38);
  applyDamage(w, foe, m, 3);
  eq(seen.length, 0, 'a skirmish out in the field is not the alarm’s job');
});

test('a villager picked off at a far gold vein is still an emergency', () => {
  const w = fresh();
  const tc = homeBase(w);
  const seen = watchAlerts(w);
  const v = spawnUnit(w, 'villager', PLAYER, 38, 38);
  v.task = { type: 'gather', node: null, building: null, stage: 'toNode', stand: null };
  v.state = 'gather';
  assert(
    Math.hypot(v.x - tc.x, v.y - tc.y) > 30,
    'the vein really is miles from home — this is the case a TC radius would silence',
  );
  const foe = spawnUnit(w, 'militia', ENEMY, 38.9, 38);

  applyDamage(w, foe, v, 3);
  eq(seen.length, 1, 'losing villagers is how you lose games; distance is no excuse');
  eq(seen[0].entity, v, 'and it names the villager, not the fight');
});

test('a building is loud wherever it stands', () => {
  const w = fresh();
  homeBase(w);
  const seen = watchAlerts(w);
  const outpost = spawnBuilding(w, 'house', PLAYER, 40, 40);
  const foe = spawnUnit(w, 'militia', ENEMY, 41.6, 40);
  applyDamage(w, foe, outpost, 3);
  eq(seen.length, 1, 'a building of yours being hit is always news');
  eq(seen[0].entity, outpost, 'and it is the building that is named');
});

test('an idle soldier jumped at home still raises the alarm', () => {
  const w = fresh();
  spawnBuilding(w, 'towncenter', PLAYER, 20, 20);
  const seen = watchAlerts(w);
  const guard = spawnUnit(w, 'militia', PLAYER, 22.5, 20);
  guard.state = 'idle';
  const raider = spawnUnit(w, 'militia', ENEMY, 23.4, 20);

  applyDamage(w, raider, guard, 3);
  eq(seen.length, 1, 'a raider jumping the guard at your TC is exactly the alarm');
  eq(seen[0].entity, guard, 'the guard is named');
});

test('a soldier already auto-defending at home is still worth a warning', () => {
  const w = fresh();
  spawnBuilding(w, 'towncenter', PLAYER, 20, 20);
  const seen = watchAlerts(w);
  const guard = spawnUnit(w, 'militia', PLAYER, 22.5, 20);
  const raider = spawnUnit(w, 'militia', ENEMY, 23.4, 20);
  // What engage(auto) leaves behind: fighting back is not an order you gave.
  guard.target = raider;
  guard.autoTarget = true;
  guard._autoFor = raider;

  applyDamage(w, raider, guard, 3);
  eq(seen.length, 1, 'auto-retaliation at home is defence, not an assault you chose');
});

test('a fight abroad never spends the alert budget owed to home', () => {
  const w = fresh();
  homeBase(w);
  const seen = watchAlerts(w);
  const v = spawnUnit(w, 'villager', PLAYER, 8, 6);
  v.hp = v.maxHp = 100000;
  const foeTc = spawnBuilding(w, 'towncenter', ENEMY, 40, 40);
  foeTc.hp = foeTc.maxHp = 1000000;
  const army = spawnUnit(w, 'archer', PLAYER, 37, 40);
  army.hp = army.maxHp = 100000;
  army.task = { type: 'attack', target: foeTc };
  army.target = foeTc;
  const defender = spawnUnit(w, 'militia', ENEMY, 38, 40);
  const raider = spawnUnit(w, 'militia', ENEMY, 8.9, 6);

  // A storm abroad, then a single blow at home in the very same instant.
  for (let i = 0; i < 30; i++) applyDamage(w, defender, army, 2);
  eq(seen.length, 0, 'the storm abroad said nothing');
  applyDamage(w, raider, v, 2);
  eq(seen.length, 1, 'and the raid at home is heard at once, not four seconds later');
  eq(seen[0].entity, v, 'pointing at the villager, not the assault');
  assert(Math.hypot(seen[0].gx - 8, seen[0].gy - 6) < 0.001, 'tap-to-jump goes home');
});

// --- the standoff (finding #2) ----------------------------------------------

test('two idle armies do not stand in lines staring at each other', () => {
  // The critic swept the gap: engaged at 4.5 tiles, frozen at 5.5. Sweep it.
  for (let gap = 4.0; gap <= 7.0 + 1e-9; gap += 0.25) {
    const w = fresh();
    const mine = [];
    const foes = [];
    for (let i = 0; i < 4; i++) {
      mine.push(spawnUnit(w, 'militia', PLAYER, 10, 8 + i));
      foes.push(spawnUnit(w, 'militia', ENEMY, 10 + gap, 8 + i));
    }
    step(w, 20); // one second of looking at each other
    const idle = [...mine, ...foes].filter((u) => !u.target).length;
    eq(idle, 0, `${gap.toFixed(2)} tiles apart: ${idle} soldiers did nothing`);
  }
});

test('an army does not watch a comrade die a few tiles away', () => {
  const w = fresh();
  const v = spawnUnit(w, 'villager', PLAYER, 20, 20);
  const foe = spawnUnit(w, 'militia', ENEMY, 20.9, 20);
  // Far enough that the guard genuinely cannot notice the attacker itself.
  const guard = spawnUnit(w, 'militia', PLAYER, 20, 12.3);
  assert(
    Math.hypot(foe.x - guard.x, foe.y - guard.y) > ENGAGE_RANGE,
    'the attacker is outside what the guard can see on its own',
  );

  stepUntil(w, () => v.hp < v.maxHp, 200);
  eq(guard.target, foe, 'a comrade being cut down pulls the guard in');
  eq(guard.autoTarget, true, 'and that response is still leashed');
});

test('villagers are never dragged into a fight by any of this', () => {
  const w = fresh();
  const v1 = spawnUnit(w, 'villager', PLAYER, 20, 20);
  const v2 = spawnUnit(w, 'villager', PLAYER, 21, 20);
  spawnUnit(w, 'militia', ENEMY, 20.9, 20);
  stepUntil(w, () => v1.hp < v1.maxHp || v2.hp < v2.maxHp, 200);
  step(w, 20);
  eq(v1.target, null, 'the victim does not trade blows');
  eq(v2.target, null, 'nor does the one standing next to it');
  assert(v1.fleeing || v2.fleeing, 'they run, as before');
});

test('a target spotted at the edge of vigilance can actually be reached', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  const v = spawnUnit(w, 'villager', ENEMY, 10 + ENGAGE_RANGE - 0.2, 10);
  v.hp = v.maxHp = 100000;
  step(w);
  eq(m.target, v, 'acquired at the edge of vigilance');
  // Walk it in by hand (unitAI is not running here). If the leash snapped on
  // the way the unit would trudge home and re-acquire forever.
  for (let i = 0; i < 9; i++) {
    m.x += 0.7;
    step(w);
    eq(m.target, v, `still committed after ${i + 1} paces`);
  }
});

// --- attack-move -------------------------------------------------------------
// combat.js only reads the flag; creating the order is unitAI's job. Both the
// task-shaped and the unit-shaped forms are honoured so the two can land in
// either order.

test('a plain move order still marches past a fight', () => {
  const w = fresh();
  const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
  m.task = { type: 'move', gx: 30, gy: 10 };
  m.state = 'move';
  spawnUnit(w, 'villager', ENEMY, 13, 10);
  step(w, 10);
  eq(m.target, null, 'a repositioning army is not hijacked on the way');
});

test('an attack-moving soldier engages what it passes', () => {
  for (const mark of [
    (u) => { u.task = { type: 'move', gx: 30, gy: 10, attackMove: true }; },
    (u) => { u.task = { type: 'attackMove', gx: 30, gy: 10 }; },
    (u) => { u.task = { type: 'move', gx: 30, gy: 10 }; u.attackMove = true; },
  ]) {
    const w = fresh();
    const m = spawnUnit(w, 'militia', PLAYER, 10, 10);
    mark(m);
    m.state = 'move';
    const v = spawnUnit(w, 'villager', ENEMY, 13, 10);
    assert(isAttackMoving(m), 'flag recognised');
    step(w, 10);
    eq(m.target, v, 'engaged what it walked past');
    eq(m.autoTarget, true, 'and it is a leashed engagement, not an order');
  }
});

test('an attack-move reaches further than a unit parked mid-order', () => {
  const w = fresh();
  const parked = spawnUnit(w, 'militia', PLAYER, 10, 10);
  parked.task = { type: 'move', gx: 30, gy: 10 };
  parked.state = 'idle'; // unitAI parks units mid-order with a spent task
  spawnUnit(w, 'villager', ENEMY, 10 + AGGRO_RANGE + 1, 10);
  step(w, 10);
  eq(parked.target, null, 'a parked unit only spares AGGRO_RANGE for the world');

  parked.task.attackMove = true;
  step(w, 10);
  assert(parked.target, 'the same unit attack-moving does notice');
});

// --- report -----------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
