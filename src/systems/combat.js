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
//
// world.projectiles is owned here and only read by the renderer.

import {
  UNIT_STATS, AGGRO_RANGE, CHASE_LEASH, PROJECTILE_SPEED, MIN_DAMAGE,
} from '../core/constants.js';
import { EV } from '../core/events.js';
import {
  edgeDist, edgeDist2, forEachNear, isHostile, removeEntity, findNearestGlobal,
} from '../core/world.js';
import { dist, dirIndex } from '../core/iso.js';

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

/**
 * Apply one hit. `amount` is raw damage; armour is subtracted here and the
 * result is floored at MIN_DAMAGE so heavy armour never makes a unit immune.
 * Returns the damage actually dealt.
 */
export function applyDamage(world, attacker, target, amount) {
  if (!target || target.dead || !world.entities.has(target.id)) return 0;
  const armor = target.armor || 0;
  const dealt = Math.max(MIN_DAMAGE, Math.round((amount || 0) - armor));

  target.hp -= dealt;
  target.lastHitAt = world.time;
  target.lastHitBy = attacker || null;
  world.events.emit(EV.DAMAGE, { entity: attacker || null, target, amount: dealt });

  if (target.hp <= 0) {
    target.hp = 0;
    kill(world, target, attacker || null);
    return dealt;
  }
  reactToDamage(world, attacker, target);
  return dealt;
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
  const strayed =
    dist(u.x, u.y, u.postX, u.postY) > CHASE_LEASH ||
    edgeDist(u.target, u.postX, u.postY) > CHASE_LEASH;
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
    applyDamage(world, u, target, u.attack);
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
    damage: u.attack,
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

function acquire(world, u, dt) {
  // Villagers never pick fights.
  if (isVillager(u) || !(u.attack > 0) || u.fleeing) return;
  // Busy under an order — leave it alone. (A unit unitAI has parked as 'idle'
  // is fair game even if it still carries a spent task object.)
  if (u.task && u.state !== 'idle') return;

  u._acqTimer = (u._acqTimer || 0) - dt;
  if (u._acqTimer > 0) return;
  u._acqTimer = ACQUIRE_INTERVAL + phaseOf(u) * ACQUIRE_INTERVAL;

  let best = null;
  let bestScore = Infinity;
  forEachNear(world, u.x, u.y, AGGRO_RANGE, (e) => {
    if (!canAttack(u, e)) return;
    // Prefer live threats over masonry: buildings are pushed to the back.
    const bias = e.kind === 'building' ? AGGRO_RANGE * AGGRO_RANGE : 0;
    const score = edgeDist2(e, u.x, u.y) + bias;
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  });

  if (best) engage(u, best, true);
}
