// Combat: everything that happens once a unit is in range of something it hates.
//
// Owns attack cooldowns, damage + armour, projectiles, death, auto-acquisition
// and leashing. It deliberately does NOT move units or path — unitAI.js owns
// movement and the task FSM; this system only sets `unit.target` and lets unitAI
// walk the unit in. No Phaser imports: this runs headlessly under Node.
//
// Fields this system reads/writes on a unit:
//   target      entity being attacked (may be set by input/unitAI too)
//   cooldown    seconds until the next swing
//   attackAnim  seconds of swing left; the renderer plays an attack pose while > 0
//   facing      set to look at the target while attacking
//   postX/postY where an auto-acquired engagement started (leash anchor)
//   autoTarget  true when this system picked the target (leashed); player-ordered
//               targets are never leashed
//   returnTo    {x,y} set when a leash snaps — unitAI may walk the unit home
//   fleeing / fleeUntil / fleeTo / fleeFrom
//               villager panic flags; unitAI may act on them
//   lastHitAt / lastHitBy
//               for hp-bar flash and retaliation
//   postLeash   how far this particular engagement may be chased (see engage)
//   attackMove  true while the unit is under an attack-move order — see below
//
// world.projectiles is owned here and only read by the renderer.
//
// --- Attack-move -------------------------------------------------------------
// A unit is "attack-moving" when either `unit.attackMove` is true or its task is
// flagged (`task.type === 'attackMove'` or `task.attackMove === true`). Such a
// unit keeps auto-acquiring *while it walks*, at the wider ENGAGE_RANGE, instead
// of only when it is standing still. Orders are unitAI's to create; this system
// only reads the flag, so an attack-move order can be added there without
// touching combat. See isAttackMoving().
//
// --- Alerts ------------------------------------------------------------------
// Any damage landing on an owned entity may raise EV.UNDER_ATTACK. That is an
// alert, not a damage log: it is throttled per player *and* per locality here,
// so a sustained beating produces a handful of events, never one per hit.
// It is also *filtered for relevance* — the alarm means "something you are not
// looking after is being attacked at home", not "a unit you sent into a fight
// is taking damage, as you intended". See alertRelevant().

import {
  UNIT_STATS, AGGRO_RANGE, CHASE_LEASH, PROJECTILE_SPEED, MIN_DAMAGE,
} from '../core/constants.js';
import { EV } from '../core/events.js';
import {
  edgeDist, edgeDist2, forEachNear, isHostile, removeEntity, findNearestGlobal,
} from '../core/world.js';
import { dist, dirIndex } from '../core/iso.js';
import { attackBonus, armorBonus } from './tech.js';

// --- Tuning (feel) ----------------------------------------------------------
// How long the swing pose is held, as a fraction of the attack cooldown.
const SWING_FRACTION = 0.45;
const SWING_MAX = 0.4;
// Up to this fraction of a cooldown is added to a unit's first swing of an
// engagement, so a squad does not land every blow on the same frame.
const STAGGER_FRACTION = 0.35;
// A unit that has not swung for this long re-staggers when it next engages.
const STAGGER_IDLE_TIME = 1.5;
// How often an idle unit looks around for something to fight (seconds).
const ACQUIRE_INTERVAL = 0.2;
// Arrows steer this hard toward a moving target (per second, exponential-ish).
const PROJECTILE_HOMING = 4.0;
// Safety valve so a stray arrow can never live forever.
const PROJECTILE_MAX_OVERTIME = 1.5;
// How long a panicked villager keeps running.
const FLEE_TIME = 4.0;
// How far a fleeing villager runs when it has no Town Center to hide in.
const FLEE_DISTANCE = 6.0;

/**
 * How far a soldier that is *not* under orders looks for a fight.
 *
 * AGGRO_RANGE (5.0) is the range a unit busy with an order spares for its
 * surroundings. On its own it produced the standoff the playtest found: two
 * armies parked 5.5 tiles apart both had "nothing in range" and stood in lines
 * staring at each other. A soldier with nothing else to do is not that passive —
 * it holds ground *actively*, which is what ENGAGE_RANGE is. It is deliberately
 * wider than an archer's 4.5 reach (so an idle archer never gets shot by
 * something it is choosing to ignore) and wider than CHASE_LEASH is long.
 * Attack-moving units use it too.
 */
export const ENGAGE_RANGE = 7.5;
// Soldiers this close to one of their own things being hit join the fight. This
// is the other half of the standoff fix: an army must never watch a comrade die
// a few tiles away.
const HELP_RADIUS = 8.0;
// One call for help per victim per this many seconds — a beating must not turn
// into a per-hit broadcast.
const HELP_INTERVAL = 1.0;
// An engagement may always be chased this much further than the distance it was
// acquired at. Without it a unit that spots something at the edge of
// ENGAGE_RANGE would snap its leash the moment it stepped off its post.
const LEASH_MARGIN = 1.5;

// --- Alert throttling (feel) ------------------------------------------------
// AoE2 fires roughly one "under attack" per area per 10-20 seconds. These three
// numbers reproduce that: a locality stays quiet for ALERT_LOCAL_WINDOW after it
// alerts, and no player gets two alerts closer together than ALERT_MIN_GAP
// however many separate fights are running.
const ALERT_LOCAL_RADIUS = 10.0;
const ALERT_LOCAL_WINDOW = 18.0;
const ALERT_MIN_GAP = 4.0;
// Bounded memory: only the most recent localities are remembered.
const ALERT_SITES_MAX = 8;
// How close to one of your own buildings counts as "at home". Measured to the
// nearest owned building's footprint, not to the Town Center: a lumber camp on
// the far treeline is your territory too, which is the whole reason this is not
// a radius around the TC. Generous, because the signal it has to separate is
// "a few tiles from a house" versus "inside the enemy base 35 tiles away".
const ALERT_HOME_RADIUS = 14.0;

// --- Pure predicates (imported by unitAI — keep cheap and side-effect free) --

/**
 * Distance, surface to surface, at which `attacker` can hit `target`.
 * Buildings are measured to their footprint edge, so a melee unit attacking a
 * 3x3 Town Center stops at the wall rather than trying to reach the centre.
 */
export function attackReach(attacker, target) {
  const r = attacker.range || 0;
  const ar = attacker.radius || 0;
  // edgeDist2 already subtracts a building's half-footprint.
  const tr = target.kind === 'unit' ? (target.radius || 0) : 0;
  return r + ar + tr;
}

/** Is `target` close enough for `attacker` to hit right now? Pure. */
export function inRange(attacker, target) {
  if (!attacker || !target) return false;
  if (attacker.dead || target.dead) return false;
  const reach = attackReach(attacker, target);
  return edgeDist2(target, attacker.x, attacker.y) <= reach * reach;
}

/** May `attacker` attack `target` at all (alive, hostile, attackable)? Pure. */
export function canAttack(attacker, target) {
  if (!attacker || !target || attacker === target) return false;
  if (attacker.dead || target.dead) return false;
  if (attacker.kind !== 'unit') return false;       // buildings do not fight back
  if (!(attacker.attack > 0)) return false;
  if (!(attacker.hp > 0)) return false;
  if (target.kind !== 'unit' && target.kind !== 'building') return false;
  if (!(target.hp > 0)) return false;
  return isHostile(attacker, target);
}

// --- Damage -----------------------------------------------------------------
//
// UPGRADES ARE READ AT THE MOMENT OF THE SWING, never copied onto a unit.
//
// `unit.attack` and `unit.armor` are the base stats world.js stamped at spawn
// and they are left exactly as they were; the blacksmith lines are looked up
// per hit from the *player's* researched set (systems/tech.js). That is the
// whole reason a Forging finished while your army is in the enemy's base makes
// that army hit harder immediately, which is how AoE2 works and is the one
// thing an upgrade system has to get right. The alternative — adding the bonus
// to `unit.attack` when the tech lands — looks equivalent and is not: it has to
// remember to walk every live unit, it double-applies if it ever runs twice,
// and it silently misses anything trained during the research.
//
// The lookup is two object reads off a cached per-player total, so doing it on
// every swing costs nothing measurable next to the target search that preceded
// it.

/** What this unit actually swings with: base attack plus its class's line. */
export function effectiveAttack(world, unit) {
  if (!unit) return 0;
  return (unit.attack || 0) + attackBonus(world, unit);
}

/** What this entity actually soaks with: base armour plus its class's line. */
export function effectiveArmor(world, entity) {
  if (!entity) return 0;
  return (entity.armor || 0) + armorBonus(world, entity);
}

/**
 * Apply one hit. `amount` is raw damage; armour is subtracted here and the
 * result is floored at MIN_DAMAGE so heavy armour never makes a unit immune.
 * Returns the damage actually dealt.
 */
export function applyDamage(world, attacker, target, amount) {
  if (!target || target.dead || !world.entities.has(target.id)) return 0;
  const armor = effectiveArmor(world, target);
  const dealt = Math.max(MIN_DAMAGE, Math.round((amount || 0) - armor));

  target.hp -= dealt;
  target.lastHitAt = world.time;
  target.lastHitBy = attacker || null;
  world.events.emit(EV.DAMAGE, { entity: attacker || null, target, amount: dealt });

  // Both of these fire even on the killing blow: losing a villager is exactly
  // the moment you need to be told, and the neighbours need to react to it.
  raiseAlert(world, attacker, target);
  callForHelp(world, attacker, target);

  if (target.hp <= 0) {
    target.hp = 0;
    kill(world, target, attacker || null);
    return dealt;
  }
  reactToDamage(world, attacker, target);
  return dealt;
}

// --- Under-attack alerts ----------------------------------------------------

// Per-world alert bookkeeping, kept off the world object so nothing else has to
// know it exists: { [playerId]: { last, sites: [{x, y, at}] } }.
const ALERTS = new WeakMap();

function alertState(world, playerId) {
  let byPlayer = ALERTS.get(world);
  if (!byPlayer) ALERTS.set(world, (byPlayer = new Map()));
  let st = byPlayer.get(playerId);
  if (!st) byPlayer.set(playerId, (st = { last: -Infinity, sites: [] }));
  return st;
}

/**
 * Is this unit carrying out an offensive order the player gave it?
 *
 * Three shapes, because an ordered fight looks slightly different depending on
 * where in it the unit is:
 *   - attack-move (isAttackMoving): the order *is* "go and fight".
 *   - a target the player set: unitAI's orderAttack assigns `target` directly,
 *     which is precisely what leaves `autoTarget` false. An auto-acquired
 *     target always has `autoTarget` true, so this separates the two.
 *   - an 'attack' task whose target has just died: unitAI flags its
 *     auto-acquired attack tasks `auto: true`, so an unflagged one is a player
 *     order still in progress even for the frame where `target` is null.
 */
function isOnOffensive(u) {
  if (!u || u.kind !== 'unit') return false;
  if (isAttackMoving(u)) return true;
  if (u.target && !u.autoTarget) return true;
  const t = u.task;
  return !!(t && t.type === 'attack' && !t.auto);
}

/**
 * Is `e` standing in the part of the map its owner is actually looking after?
 *
 * "Home" is the neighbourhood of any building you own — main base, forward
 * tower, or a mining camp out at the far gold. A player with no buildings left
 * has no home to be away from, so nothing is ever filtered out for them.
 */
function nearOwnTerritory(world, e) {
  const player = e.player;
  let any = false;
  for (const b of world.buildings) {
    if (b.dead || b.player !== player) continue;
    any = true;
    if (edgeDist2(b, e.x, e.y) <= ALERT_HOME_RADIUS * ALERT_HOME_RADIUS) return true;
  }
  return !any;
}

/**
 * Is this hit worth interrupting the player for?
 *
 * The alarm means "something you are *not* looking after is being attacked at
 * home". Without this filter it meant "damage happened", and a playtest found
 * 8 of 9 alerts in a won match were the player's own archers taking hits inside
 * the enemy base they had been ordered to assault — each one a siren whose
 * "tap to jump there" flew the camera to the enemy's Town Center. An alarm that
 * cries wolf eight times out of nine is worse than none, because the ninth one
 * (the real raid) gets ignored with the rest.
 *
 * Two signals, combined rather than used alone:
 *   offensive — did the player deliberately send this unit into this fight? A
 *               unit taking damage where you ordered it to fight is the plan
 *               working, not news.
 *   home      — is it near something of yours? Distance from the Town Center
 *               alone would be wrong: it would silence a villager being picked
 *               off at a far gold vein, which is exactly the raid you must hear
 *               about. Proximity to *any* owned building keeps that loud.
 *
 * The rule, by what is being hit:
 *   - buildings: always. A building is never anywhere by accident and cannot
 *     be sent to fight, so nothing about it is ever "the plan working".
 *   - villagers: always, unless you ordered this one to attack something away
 *     from your territory. A villager picked off at a far gold vein is exactly
 *     the raid you must hear about, which is why the test is proximity to any
 *     building of yours and not a radius around the Town Center.
 *   - soldiers: only when standing in your territory with no offensive order.
 *     An idle guard jumped by a raider warns you; an army trading blows where
 *     you sent it does not, because you are already looking at it.
 */
function alertRelevant(world, target) {
  if (target.kind !== 'unit') return true;
  const offensive = isOnOffensive(target);
  // Note the cheap paths: the storm of hits an assault generates is answered by
  // `offensive` alone, with no territory scan at all.
  if (isVillager(target)) return !offensive || nearOwnTerritory(world, target);
  return !offensive && nearOwnTerritory(world, target);
}

/**
 * Raise EV.UNDER_ATTACK for the owner of `target`, if the throttles and the
 * relevance filter allow it.
 *
 * Three gates, all required:
 *   locality  — a site that has already alerted stays quiet for
 *               ALERT_LOCAL_WINDOW, so a Town Center being ground down for a
 *               minute produces ~3 alerts rather than ~60. The window is not
 *               refreshed by further hits: a genuinely sustained siege *should*
 *               re-warn you every so often.
 *   rate      — no player hears two alerts within ALERT_MIN_GAP, so a wave
 *               hitting three things at once is one warning, not three.
 *   relevance — see alertRelevant(): the hit has to be something the player is
 *               not already doing on purpose.
 *
 * Relevance is checked last, and an irrelevant hit records nothing. Failing it
 * must not spend the locality window or the rate budget, or an assault on the
 * enemy base would go on silencing the raid back home.
 */
function raiseAlert(world, attacker, target) {
  const player = target.player;
  if (player === null || player === undefined) return false;
  // Only an enemy attacking you is an alarm.
  if (attacker && !isHostile(attacker, target)) return false;

  const st = alertState(world, player);
  const now = world.time;
  const sites = st.sites;

  for (let i = sites.length - 1; i >= 0; i--) {
    const s = sites[i];
    if (now - s.at > ALERT_LOCAL_WINDOW) { sites.splice(i, 1); continue; }
    const dx = s.x - target.x;
    const dy = s.y - target.y;
    if (dx * dx + dy * dy <= ALERT_LOCAL_RADIUS * ALERT_LOCAL_RADIUS) return false;
  }
  if (now - st.last < ALERT_MIN_GAP) return false;
  if (!alertRelevant(world, target)) return false;

  st.last = now;
  sites.push({ x: target.x, y: target.y, at: now });
  if (sites.length > ALERT_SITES_MAX) sites.shift();

  world.events.emit(EV.UNDER_ATTACK, {
    player, entity: target, gx: target.x, gy: target.y,
  });
  return true;
}

/**
 * Something of yours is being hit: soldiers standing around it pile in.
 *
 * This is what stops an army watching a single unit die between the lines.
 * Units that are actually busy with an order are left alone — an attack order
 * is not silently rewritten by whatever gets hit nearby.
 */
function callForHelp(world, attacker, victim) {
  if (!attacker || attacker.dead) return;
  if (victim.player === null || victim.player === undefined) return;
  if (!isHostile(attacker, victim)) return;
  if (world.time - (victim._helpAt ?? -Infinity) < HELP_INTERVAL) return;
  victim._helpAt = world.time;

  forEachNear(world, victim.x, victim.y, HELP_RADIUS, (e) => {
    if (e === victim || e.kind !== 'unit') return;
    if (e.player !== victim.player) return;
    if (isVillager(e) || e.fleeing) return;
    if (e.target) return;                        // already in a fight
    if (e.task && e.state !== 'idle') return;    // under orders — do not hijack
    if (!canAttack(e, attacker)) return;
    engage(e, attacker, true);
  });
}

function kill(world, e, killer) {
  if (e.dead || !world.entities.has(e.id)) return;
  e.hp = 0;
  if (e.kind === 'unit') {
    e.state = 'dead';
    e.target = null;
    e.path = null;
  }
  // The entity is still in the world here, per the EV.DEATH contract, so the
  // renderer can grab its position and play a death moment on the way out.
  world.events.emit(EV.DEATH, { entity: e, killer: killer || null });
  removeEntity(world, e);
}

/** Being hit makes soldiers angry and villagers scared. */
function reactToDamage(world, attacker, target) {
  if (target.kind !== 'unit') return;
  if (!attacker || attacker.dead || !isHostile(attacker, target)) return;

  if (isVillager(target)) {
    // Villagers do not trade with soldiers. If the player explicitly ordered
    // this villager to fight, respect that; otherwise panic.
    if (!target.target) startFleeing(world, target, attacker);
    return;
  }
  // A soldier shot from out of aggro range charges whoever shot it, unless it
  // is already busy with an order.
  if (!target.target && !target.task && canAttack(target, attacker)) {
    engage(target, attacker, true);
  }
}

function isVillager(u) {
  return u.type === 'villager';
}

function startFleeing(world, v, threat) {
  v.fleeing = true;
  v.fleeUntil = world.time + FLEE_TIME;
  v.fleeFrom = threat;
  v.target = null;

  const tc = findNearestGlobal(
    world, v.x, v.y, world.buildings,
    (b) => b.player === v.player && b.type === 'towncenter' && b.complete,
  );
  if (tc) {
    v.fleeTo = { x: tc.x, y: tc.y };
    return;
  }
  // No home to run to: just run directly away from the threat.
  let dx = v.x - threat.x;
  let dy = v.y - threat.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  v.fleeTo = {
    x: clamp(v.x + dx * FLEE_DISTANCE, 0, world.width - 1),
    y: clamp(v.y + dy * FLEE_DISTANCE, 0, world.height - 1),
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- Targeting --------------------------------------------------------------

function engage(u, target, auto) {
  u.target = target;
  u.autoTarget = !!auto;
  u._autoFor = auto ? target : null;
  if (auto) {
    u.postX = u.x;
    u.postY = u.y;
    // The leash has to be able to reach what was picked. CHASE_LEASH is the
    // floor, not the rule: a unit that deliberately chose a target at the edge
    // of ENGAGE_RANGE must be allowed to walk to it and swing, or it would
    // oscillate between acquiring and trudging home.
    u.postLeash = Math.max(CHASE_LEASH, edgeDist(target, u.x, u.y) + LEASH_MARGIN);
  }
}

function dropTarget(u, returnHome) {
  if (returnHome && u.postX !== undefined) {
    u.returnTo = { x: u.postX, y: u.postY };
  }
  u.target = null;
  u.autoTarget = false;
  u._autoFor = null;
}

/**
 * A deterministic 0..1 phase per unit, so squads stagger identically on every
 * replay of a seed without disturbing the shared world RNG stream.
 */
function phaseOf(u) {
  return ((Math.imul(u.id, 2654435761) >>> 0) % 1000) / 1000;
}

// --- Main update ------------------------------------------------------------

export function updateCombat(world, dt) {
  if (!world.projectiles) world.projectiles = [];

  // Snapshot: kills splice world.units mid-loop.
  const units = world.units.slice();
  for (const u of units) {
    if (u.dead) continue;

    if (u.cooldown > 0) u.cooldown = Math.max(0, u.cooldown - dt);
    if (u.attackAnim > 0) u.attackAnim = Math.max(0, u.attackAnim - dt);
    if (u.fleeing && world.time >= (u.fleeUntil || 0)) {
      u.fleeing = false;
      u.fleeTo = null;
      u.fleeFrom = null;
    }

    // A target set by the player or unitAI clears the leash: explicit orders
    // are never leashed.
    if (u.autoTarget && u._autoFor !== u.target) {
      u.autoTarget = false;
      u._autoFor = null;
    }

    if (u.target && !canAttack(u, u.target)) dropTarget(u, false);
    if (u.target && u.autoTarget && leashSnapped(u)) dropTarget(u, true);
    if (!u.target) acquire(world, u, dt);
    if (!u.target) continue;

    faceTarget(u, u.target);
    if (!inRange(u, u.target)) continue; // unitAI walks it in

    // First swing of an engagement is nudged off the beat.
    if (u.cooldown <= 0 && world.time - (u._lastSwing ?? -Infinity) > STAGGER_IDLE_TIME) {
      u.cooldown = phaseOf(u) * STAGGER_FRACTION * u.attackCooldown;
      u._lastSwing = world.time;
      if (u.cooldown > 0) continue;
    }
    if (u.cooldown > 0) continue;

    fire(world, u, u.target);
  }

  updateProjectiles(world, dt);
}

function leashSnapped(u) {
  if (u.postX === undefined) return false;
  const leash = u.postLeash || CHASE_LEASH;
  const strayed =
    dist(u.x, u.y, u.postX, u.postY) > leash ||
    edgeDist(u.target, u.postX, u.postY) > leash;
  // Never abandon a target it can hit this very moment — finish the kill.
  return strayed && !inRange(u, u.target);
}

function faceTarget(u, t) {
  const dx = t.x - u.x;
  const dy = t.y - u.y;
  if (dx !== 0 || dy !== 0) u.facing = dirIndex(dx, dy);
}

function fire(world, u, target) {
  u.cooldown = u.attackCooldown;
  u._lastSwing = world.time;
  u.attackAnim = Math.min(SWING_MAX, u.attackCooldown * SWING_FRACTION);

  if (isRanged(u)) {
    launchProjectile(world, u, target);
  } else {
    applyDamage(world, u, target, effectiveAttack(world, u));
  }
}

function isRanged(u) {
  // Range alone is not the test — a unit is ranged only if it throws something.
  const s = UNIT_STATS[u.type];
  return !!(s && s.projectile);
}

function launchProjectile(world, u, target) {
  const d = dist(u.x, u.y, target.x, target.y);
  const p = {
    x: u.x,
    y: u.y,
    tx: target.x,
    ty: target.y,
    target,
    // Snapshotted at launch, not at impact: an arrow already in the air was
    // loosed by the bow the archer had at the time. Flight is under a second,
    // so the difference is invisible — but "the arrow carries its damage" is
    // the rule the projectile struct already implied, and changing it here
    // would make a Fletching finishing mid-volley retroactively strengthen
    // arrows that had already left.
    damage: effectiveAttack(world, u),
    owner: u,
    speed: PROJECTILE_SPEED,
    elapsed: 0,
    duration: Math.max(0.05, d / PROJECTILE_SPEED),
  };
  world.projectiles.push(p);
  world.events.emit(EV.PROJECTILE, { from: u, to: target });
  return p;
}

function updateProjectiles(world, dt) {
  const list = world.projectiles;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];

    // Target died mid-flight: the arrow keeps going and simply does nothing.
    if (p.target && (p.target.dead || !world.entities.has(p.target.id))) p.target = null;

    if (p.target) {
      const k = Math.min(1, dt * PROJECTILE_HOMING);
      p.tx += (p.target.x - p.tx) * k;
      p.ty += (p.target.y - p.ty) * k;
    }

    p.elapsed += dt;
    const dx = p.tx - p.x;
    const dy = p.ty - p.y;
    const d = Math.hypot(dx, dy);
    const step = p.speed * dt;

    if (d <= step || p.elapsed > p.duration + PROJECTILE_MAX_OVERTIME) {
      p.x = p.tx;
      p.y = p.ty;
      if (p.target) applyDamage(world, p.owner, p.target, p.damage);
      list.splice(i, 1);
      continue;
    }
    p.x += (dx / d) * step;
    p.y += (dy / d) * step;
  }
}

// --- Auto-acquisition -------------------------------------------------------

/**
 * Is this unit under an attack-move order? See the note at the top of the file.
 * unitAI sets the flag; combat only reads it, so the two can land separately.
 */
export function isAttackMoving(u) {
  if (!u) return false;
  if (u.attackMove) return true;
  const t = u.task;
  return !!(t && (t.type === 'attackMove' || t.attackMove));
}

/**
 * How far this unit looks for a fight right now.
 *
 * A unit with no job, and a unit deliberately attack-moving, both hold ground
 * actively (ENGAGE_RANGE). A unit parked mid-order only spares AGGRO_RANGE for
 * its surroundings, so ordinary traffic near a border does not start wars.
 */
function acquireRange(u) {
  if (isAttackMoving(u)) return ENGAGE_RANGE;
  return u.task ? AGGRO_RANGE : ENGAGE_RANGE;
}

function acquire(world, u, dt) {
  // Villagers never pick fights.
  if (isVillager(u) || !(u.attack > 0) || u.fleeing) return;
  // Busy under an order — leave it alone. (A unit unitAI has parked as 'idle'
  // is fair game even if it still carries a spent task object.) An attack-move
  // is the exception: engaging what it passes is the entire point of the order.
  if (u.task && u.state !== 'idle' && !isAttackMoving(u)) return;

  u._acqTimer = (u._acqTimer || 0) - dt;
  if (u._acqTimer > 0) return;
  u._acqTimer = ACQUIRE_INTERVAL + phaseOf(u) * ACQUIRE_INTERVAL;

  const range = acquireRange(u);
  let best = null;
  let bestScore = Infinity;
  forEachNear(world, u.x, u.y, range, (e) => {
    if (!canAttack(u, e)) return;
    // Prefer live threats over masonry: buildings are pushed to the back.
    const bias = e.kind === 'building' ? range * range : 0;
    const score = edgeDist2(e, u.x, u.y) + bias;
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  });

  if (best) engage(u, best, true);
}
