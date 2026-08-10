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
//   healTarget  the friendly unit a support unit is currently mending, or null.
//               Written here, read by the HUD and the FX layer; see the healing
//               section at the bottom of this file
//   stance      'aggressive' | 'defensive' | 'standGround' | 'noAttack'. Absent
//               on a unit nobody has set one on; read it through stanceOf(),
//               never directly, so the default is applied in one place
//   garrisonedIn the building this unit is sheltering inside, or null. A
//               garrisoned unit is not in world.units at all — see the garrison
//               section — so nothing in this file's main loop ever sees one
//
// world.projectiles is owned here and only read by the renderer.
//
// --- Siege: splash, and the hole in the middle of a siege engine's range -----
// Two mechanics that only siege uses, both declared per unit type in
// constants.js and both no-ops for everything that does not declare them:
//
//   splashRadius / splashFalloff — the shot hurts everything near where it
//     LANDS, friend and foe alike. See applySplash().
//   minRange — the engine cannot depress its arm far enough to hit what is
//     standing on top of it. See minAttackReach() and tooClose().
//
// A unit with neither field pays two property reads and behaves exactly as it
// did before either existed.
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
  UNIT_STATS, BUILDING_STATS, TERRAIN, AGGRO_RANGE, CHASE_LEASH,
  PROJECTILE_SPEED, MIN_DAMAGE,
  BONUS_DAMAGE, DEFAULT_ARMOR_CLASS, BUILDING_ARMOR_CLASS,
  STANCE, DEFAULT_STANCE, VILLAGER_STANCE, STANCE_LEASH,
  GARRISON_CAPACITY_FALLBACK, GARRISON_HEAL_PER_SEC, GARRISON_ARROW_DAMAGE,
  GARRISON_VOLLEY_COOLDOWN, GARRISON_DEFAULT_RANGE,
} from '../core/constants.js';
import { EV } from '../core/events.js';
import {
  edgeDist, edgeDist2, forEachNear, isHostile, removeEntity, findNearestGlobal,
  inBounds, isBlocked, snapshotUnits,
} from '../core/world.js';
import { dist, dirIndex, hyp } from '../core/iso.js';
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

/**
 * The distance below which `attacker` cannot bring its weapon to bear at all,
 * surface to surface. Zero for everything that does not declare a `minRange`,
 * which is every unit in the game except the two siege engines.
 *
 * Built the same way attackReach is — the declared figure plus both radii — so
 * that the two bounds are measured against the same edgeDist2 in the same
 * units. The reach a player reads off the unit card is the gap between the two
 * bodies, not the gap between their centres, at both ends of the band.
 *
 * BUILDINGS ARE EXEMPT, and this is the whole reason the target is inspected
 * rather than only the attacker. A mangonel's minimum range is a fact about the
 * arc a counterweight throws a boulder on — it cannot drop one on the man
 * standing against its wheel. A wall is not a man standing against the wheel:
 * it is thirty feet of masonry the engine has been rolled up to, and the shot
 * that matters is the one fired point blank into it. Applying the minimum to
 * masonry would mean a mangonel parked against a Town Center could not hit the
 * Town Center, which is not a balance decision anybody would defend out loud —
 * it is the unit failing to do the one thing its name promises. AoE2 makes the
 * same exemption for the same reason.
 */
export function minAttackReach(attacker, target) {
  if (!attacker || attacker.kind !== 'unit') return 0;
  const s = UNIT_STATS[attacker.type];
  const min = s && s.minRange;
  if (!(min > 0)) return 0;
  if (!target || target.kind !== 'unit') return 0;
  return min + (attacker.radius || 0) + (target.radius || 0);
}

/**
 * Is `target` *underneath* `attacker` — inside the minimum range, where the
 * weapon is useless? Pure, and false for anything without a minimum range.
 *
 * Separate from inRange() because the two answers mean different things to the
 * caller: out of range means walk closer, too close means walk away. unitAI
 * reads this directly to decide which (see backAway there).
 */
export function tooClose(attacker, target) {
  if (!attacker || !target) return false;
  const min = minAttackReach(attacker, target);
  if (min <= 0) return false;
  return edgeDist2(target, attacker.x, attacker.y) < min * min;
}

/** Is `target` close enough for `attacker` to hit right now? Pure. */
export function inRange(attacker, target) {
  if (!attacker || !target) return false;
  if (attacker.dead || target.dead) return false;
  const reach = attackReach(attacker, target);
  if (edgeDist2(target, attacker.x, attacker.y) > reach * reach) return false;
  // The band has a floor as well as a ceiling. Everything that reads "can I
  // swing right now" goes through this one predicate — the swing gate in
  // updateCombat, unitAI's approach, the leash, the Stand Ground filter — so
  // putting the minimum here is what makes a siege engine with a spearman on
  // its face genuinely unable to fire, rather than unable to fire in the two
  // places somebody remembered to check.
  return !tooClose(attacker, target);
}

/** May `attacker` attack `target` at all (alive, hostile, attackable)? Pure. */
export function canAttack(world, attacker, target) {
  if (!attacker || !target || attacker === target) return false;
  if (attacker.dead || target.dead) return false;
  if (attacker.kind !== 'unit') return false;       // buildings do not fight back
  if (!(attacker.attack > 0)) return false;
  if (!(attacker.hp > 0)) return false;
  if (target.kind !== 'unit' && target.kind !== 'building') return false;
  if (!(target.hp > 0)) return false;
  return isHostile(world, attacker, target);
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

/**
 * What `e` counts as when it is being hit. Units declare it in UNIT_STATS;
 * masonry is all one class, decided here rather than per building so that
 * BUILDING_STATS — which belongs to another pass — needs no field for it.
 */
export function armorClassOf(e) {
  if (!e) return DEFAULT_ARMOR_CLASS;
  if (e.kind === 'building') return BUILDING_ARMOR_CLASS;
  const s = UNIT_STATS[e.type];
  return (s && s.armorClass) || DEFAULT_ARMOR_CLASS;
}

/**
 * The counter system, in one lookup: what `attacker` adds against what
 * `target` is. Two object reads, no allocation — it runs on every swing and
 * on every arrow.
 */
export function bonusDamage(attacker, target) {
  if (!attacker || !target) return 0;
  const table = BONUS_DAMAGE[attacker.type];
  if (!table) return 0;
  return table[armorClassOf(target)] || 0;
}

/**
 * What this unit actually swings with: base attack, plus its class's blacksmith
 * line, plus whatever the counter table says about the thing in front of it.
 *
 * `target` is optional. Called without one this is the unit's *sheet* attack —
 * which is what the HUD and the tech tests want — and called with one it is the
 * number that actually lands. Every real swing passes the target, so a
 * spearman's +12 against cavalry is applied at exactly the same moment, and by
 * exactly the same rule, as Forging's +1.
 */
export function effectiveAttack(world, unit, target = null) {
  if (!unit) return 0;
  return (unit.attack || 0) + attackBonus(world, unit) + bonusDamage(unit, target);
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
  if (attacker && !isHostile(world, attacker, target)) return false;

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
  if (!isHostile(world, attacker, victim)) return;
  if (world.time - (victim._helpAt ?? -Infinity) < HELP_INTERVAL) return;
  victim._helpAt = world.time;

  forEachNear(world, victim.x, victim.y, HELP_RADIUS, (e) => {
    if (e === victim || e.kind !== 'unit') return;
    if (e.player !== victim.player) return;
    if (isVillager(e) || e.fleeing) return;
    if (e.target) return;                        // already in a fight
    if (e.task && e.state !== 'idle') return;    // under orders — do not hijack
    if (!canAttack(world, e, attacker)) return;
    // Answering a cry for help is still auto-acquisition: the same two gates
    // apply. A Stand Ground unit holds its spot however loudly its neighbour
    // shouts, a No Attack unit never joins, and nobody charges something their
    // side cannot see.
    const stance = stanceOf(e);
    if (stance === STANCE.NO_ATTACK) return;
    if (stance === STANCE.STAND_GROUND && !inRange(e, attacker)) return;
    if (!canSee(world, e, attacker)) return;
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
  if (!attacker || attacker.dead || !isHostile(world, attacker, target)) return;

  if (isVillager(target)) {
    // Villagers do not trade with soldiers. If the player explicitly ordered
    // this villager to fight, respect that; otherwise panic.
    if (!target.target) startFleeing(world, target, attacker);
    return;
  }
  // A soldier shot from out of aggro range charges whoever shot it, unless it
  // is already busy with an order. Retaliation is auto-acquisition too, so it
  // obeys the stance and the fog: a Stand Ground unit shot from six tiles away
  // takes it rather than abandoning its post, and nothing charges an attacker
  // hidden in the dark — which is precisely the tower or the archer you have
  // not scouted yet.
  if (!target.target && !target.task && canAttack(world, target, attacker)) {
    const stance = stanceOf(target);
    if (stance === STANCE.NO_ATTACK) return;
    if (stance === STANCE.STAND_GROUND && !inRange(target, attacker)) return;
    if (!canSee(world, target, attacker)) return;
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
  const d = hyp(dx, dy) || 1;
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
    const stance = stanceOf(u);
    // Stand Ground is a leash of zero and means it: leashSnapped never drops a
    // target the unit can hit from where it stands, so the unit fights whatever
    // walks in and abandons it the step it walks out. No special case anywhere
    // else in the file.
    if (stance === STANCE.STAND_GROUND) {
      u.postLeash = 0;
      return;
    }
    // The leash has to be able to reach what was picked. The stance's figure is
    // the floor, not the rule: a unit that deliberately chose a target at the
    // edge of its scan must be allowed to walk to it and swing, or it would
    // oscillate between acquiring and trudging home.
    const leash = STANCE_LEASH[stance] ?? CHASE_LEASH;
    u.postLeash = Math.max(leash, edgeDist(target, u.x, u.y) + LEASH_MARGIN);
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

// Reused by updateCombat, which is not re-entrant. See the note in unitAI.js.
const STEP_SCRATCH = [];

export function updateCombat(world, dt) {
  if (!world.projectiles) world.projectiles = [];

  // Snapshot: kills splice world.units mid-loop. The buffer is reused between
  // steps — see snapshotUnits in core/world.js.
  const units = snapshotUnits(world, STEP_SCRATCH);
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

    if (u.target && !canAttack(world, u, u.target)) dropTarget(u, false);

    // Support units mend instead of fighting. Everything below this line is
    // about swinging at something, and a monk does none of it: canAttack has
    // already refused it a target (attack is 0), acquire would refuse it one
    // again, and fire would have nothing to fire. Taking it out of the loop
    // here says that in one place rather than three.
    if (healRateOf(u) > 0) {
      updateHealer(world, u, dt);
      continue;
    }

    // Whether a snapped leash walks the unit home is the difference between
    // Aggressive and Defensive: an aggressive unit holds the ground it took, a
    // defensive one goes back to the post it was covering. See returnsToPost.
    if (u.target && u.autoTarget && leashSnapped(u)) dropTarget(u, returnsToPost(u));
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

  // Buildings heal what is sheltering in them and throw their volley. After the
  // units, deliberately: a garrison arrow is loosed at the world the soldiers
  // have already finished moving through.
  updateBuildings(world, dt);
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
    applyDamage(world, u, target, effectiveAttack(world, u, target));
  }
}

function isRanged(u) {
  // Range alone is not the test — a unit is ranged only if it throws something.
  const s = UNIT_STATS[u.type];
  return !!(s && s.projectile);
}

/** The splash this unit's shot carries, or null. Two property reads. */
function splashOf(u) {
  if (!u || u.kind !== 'unit') return null;
  const s = UNIT_STATS[u.type];
  if (!s || !(s.splashRadius > 0)) return null;
  return { radius: s.splashRadius, falloff: s.splashFalloff || 0 };
}

function launchProjectile(world, u, target, damage) {
  const splash = splashOf(u);
  const d = dist(u.x, u.y, target.x, target.y);
  const p = {
    x: u.x,
    y: u.y,
    tx: target.x,
    ty: target.y,
    // A SPLASH WEAPON IS AIMED AT A PLACE, NOT AT A BODY, and that is why the
    // target field is deliberately left empty here. `target` is what
    // updateProjectiles homes on: an arrow leans after the archer's quarry as
    // it walks, which is right for a bow and wrong for a counterweight the crew
    // wound up eight seconds ago. A mangonel picks a spot on the ground, throws
    // a rock at it, and hits whatever is standing there when it lands.
    //
    // Everything that makes the unit interesting falls out of that one line.
    // Ordering a hit on a moving target and watching the boulder land behind it
    // is the skill; a unit that walks out of the blast has genuinely dodged it;
    // and both SPREAD formation and the minimum range above mean something,
    // because both are about *where bodies are standing* rather than about who
    // was aimed at. The renderer needs no change either — fx.js already falls
    // back to tx/ty when a projectile has no target, so the boulder is drawn
    // flying at the ground it is actually flying at.
    target: splash ? null : target,
    // Who the crew were shooting AT, all the same: a direct hit is a direct hit
    // and takes the full number, undiminished by falloff. See applySplash.
    aimedAt: target,
    splashRadius: splash ? splash.radius : 0,
    splashFalloff: splash ? splash.falloff : 0,
    // Snapshotted at launch, not at impact: an arrow already in the air was
    // loosed by the bow the archer had at the time. Flight is under a second,
    // so the difference is invisible — but "the arrow carries its damage" is
    // the rule the projectile struct already implied, and changing it here
    // would make a Fletching finishing mid-volley retroactively strengthen
    // arrows that had already left. The counter bonus is snapshotted with it and
    // for the same reason: the arrow was aimed at *this* target.
    //
    // A splash shot is the one exception, and it has to be: the counter bonus
    // is a fact about the thing being hit, and this shot is about to hit five
    // different things. So it carries the *sheet* number — base attack plus the
    // blacksmith line, both of which are facts about the crew — and each body
    // in the blast has its own bonus added at impact. The direct target ends up
    // with exactly the number it would have got either way, which is the point:
    // nothing about the ordinary case changes.
    damage: damage === undefined
      ? effectiveAttack(world, u, splash ? null : target)
      : damage,
    owner: u,
    speed: PROJECTILE_SPEED,
    elapsed: 0,
    duration: Math.max(0.05, d / PROJECTILE_SPEED),
  };
  world.projectiles.push(p);
  world.events.emit(EV.PROJECTILE, { from: u, to: target });
  return p;
}

// --- Area of effect ---------------------------------------------------------
//
// Reused between impacts. Splash is rare — one mangonel shot every four seconds
// — but this is the same rule the rest of the file plays by: the steady state
// allocates nothing. See snapshotUnits in core/world.js for the same trick.
const SPLASH_SCRATCH = [];

/**
 * The boulder lands. Everything standing near the crater takes a share of it.
 *
 * FRIENDLY FIRE IS ON, ON PURPOSE, and it is not a detail — it is the entire
 * balancing weight of the mangonel and the reason the unit is allowed to exist
 * at 14 attack with a seven-tile reach. A siege engine that only hurt the enemy
 * would be a better archer than an archer: you would build eight of them, put
 * them in the middle of the army, and never think about them again. Because it
 * hurts your own line too, a mangonel is a unit you have to *place* — behind
 * the melee, off the flank, never in the middle — and a mass of them cannot
 * simply be sent forward with everything else. constants.js says so out loud in
 * the unit's own comment; this function is where that promise is kept.
 *
 * The sweep is over units AND buildings: a shot into a crowd at the gate should
 * chip the gate, and a shot at the gate should catch the crowd at it. Resources
 * are left alone — a boulder does not fell a tree, and letting it would mean a
 * stray shot silently deleting a player's woodline.
 *
 * WHAT SCALES AND WHAT DOES NOT. Damage runs linearly from the full number at
 * the impact point down to `splashFalloff` of it at the rim, measured surface to
 * surface (edgeDist), so a big building caught by its corner takes the same
 * share a unit standing at that corner would. The one body exempt from the
 * falloff is the one the crew were aiming at — a direct hit is a direct hit —
 * and the one body exempt from the blast entirely is the firing unit itself,
 * because a mangonel that could kill itself with its own shot at minimum range
 * is a bug wearing a mechanic's clothes.
 *
 * DETERMINISM. The sweep is collected first and then sorted by ascending id
 * before a single point of damage is applied. Order matters and is not
 * cosmetic: a kill inside the loop emits EV.DEATH, may raise an alert, may
 * start a villager fleeing, and removeEntity walks world.units clearing
 * references — so two peers that damaged the same five bodies in different
 * orders would end the tick with different worlds. forEachNear's bucket walk is
 * already deterministic given identical inputs, but it is deterministic by
 * *coincidence of layout*: it depends on the bucket grid, which depends on the
 * map size. Sorting by id costs one sort of five elements per shot and makes
 * the ordering a property of the simulation rather than of the index.
 */
function applySplash(world, p) {
  const r = p.splashRadius;
  if (!(r > 0)) return;
  const hits = SPLASH_SCRATCH;
  hits.length = 0;

  forEachNear(world, p.x, p.y, r, (e) => {
    if (e.kind !== 'unit' && e.kind !== 'building') return;
    if (e.dead || !(e.hp > 0)) return;
    // Never the crew that threw it. Everyone else, whoever they belong to.
    if (e === p.owner) return;
    hits.push(e);
  });
  if (!hits.length) return;
  hits.sort(byId);

  const falloff = p.splashFalloff;
  for (let i = 0; i < hits.length; i++) {
    const e = hits[i];
    // A body that died to an earlier hit in this same blast is gone; it must not
    // be hit again on the way out.
    if (e.dead || !world.entities.has(e.id)) continue;
    let share = 1;
    if (e !== p.aimedAt) {
      // Linear from 1 at the centre to `falloff` at the rim. Clamped because a
      // building's edge distance can sit a hair outside the radius the sweep
      // accepted it at.
      const t = Math.min(1, edgeDist(e, p.x, p.y) / r);
      share = 1 + (falloff - 1) * t;
    }
    // The counter bonus is added here rather than snapshotted at launch, per the
    // note in launchProjectile: this shot is hitting several different things
    // and each of them is a different armour class.
    applyDamage(world, p.owner, e, (p.damage + bonusDamage(p.owner, e)) * share);
  }
  hits.length = 0;
}

function byId(a, b) {
  return a.id - b.id;
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
    const d = hyp(dx, dy);
    const step = p.speed * dt;

    if (d <= step || p.elapsed > p.duration + PROJECTILE_MAX_OVERTIME) {
      p.x = p.tx;
      p.y = p.ty;
      if (p.splashRadius > 0) applySplash(world, p);
      else if (p.target) applyDamage(world, p.owner, p.target, p.damage);
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
 * MAY THIS UNIT'S OWNER SEE THAT?
 *
 * The one rule auto-acquisition has to obey once there is a fog: a unit only
 * ever picks a fight with something its side can actually see. Before this, a
 * militia (line of sight 4) auto-acquired at ENGAGE_RANGE — 7.5 tiles — so it
 * opened fire on enemies that were invisible to the player, and what the player
 * saw was a target ring and a stream of arrows aimed at empty black ground.
 * An archer, seeing 6 and engaging at 7.5, did the same. See HANDOFF-vision.md.
 *
 * This is deliberately *not* applied to a target the player picked by hand:
 * `orderAttack` sets `target` directly, and an explicit order on something the
 * player selected while it was visible keeps working as it walks into the dark.
 * That is AoE2's rule too — you may chase what you saw, you may not shoot at
 * what you never saw.
 *
 * A world with no vision system (an isolated unit test) sees everything, so
 * nothing here depends on the fog having been built.
 */
export function canSee(world, u, e) {
  const v = world && world.vision;
  if (!v || typeof v.entityVisible !== 'function') return true;
  if (u.player === null || u.player === undefined) return true;
  return v.entityVisible(u.player, e);
}

/**
 * The stance this unit is playing, defaulted rather than stored.
 *
 * world.js stamps no `stance` field at spawn (it is not this pass's file), so
 * every read goes through here and an un-stanced unit gets the right default:
 * soldiers hold ground aggressively, villagers never fight at all. Setting a
 * stance is what writes the field, so an untouched army behaves exactly as it
 * always did.
 */
export function stanceOf(u) {
  if (!u || u.kind !== 'unit') return DEFAULT_STANCE;
  if (u.stance && STANCE_LEASH[u.stance] !== undefined) return u.stance;
  return isVillager(u) ? VILLAGER_STANCE : DEFAULT_STANCE;
}

/**
 * Put a unit on a stance. Anything the new stance forbids is dropped at once —
 * switching to No Attack while mid-swing has to stop the swing, or the control
 * is a label rather than an order.
 */
export function setStance(u, stance) {
  if (!u || u.kind !== 'unit') return false;
  if (STANCE_LEASH[stance] === undefined) return false;
  u.stance = stance;
  if (stance === STANCE.NO_ATTACK && u.autoTarget) dropTarget(u, false);
  // Stand Ground keeps a fight it can reach from where it stands and abandons
  // one it would have to walk to; leashSnapped does exactly that with a leash
  // of zero, so re-anchoring the post here is the whole implementation.
  if (stance === STANCE.STAND_GROUND && u.autoTarget) {
    u.postX = u.x;
    u.postY = u.y;
    u.postLeash = 0;
  }
  return true;
}

/** Does a snapped leash send this unit back to where the fight started? */
function returnsToPost(u) {
  const s = stanceOf(u);
  return s === STANCE.DEFENSIVE || s === STANCE.STAND_GROUND;
}

/**
 * How far this unit looks for a fight right now.
 *
 * A unit with no job, and a unit deliberately attack-moving, both hold ground
 * actively (ENGAGE_RANGE). A unit parked mid-order only spares AGGRO_RANGE for
 * its surroundings, so ordinary traffic near a border does not start wars.
 *
 * The two passive stances cut it down to something they can honour: a Stand
 * Ground unit that acquired at seven tiles would either have to walk (which it
 * must not) or immediately drop the target (which looks broken), and a
 * Defensive unit that acquired past its own leash would chase and turn round in
 * the same breath. Both scan roughly as far as they are willing to act.
 */
function acquireRange(u, stance) {
  if (stance === STANCE.NO_ATTACK) return 0;
  const reach = (u.range || 0) + (u.radius || 0);
  if (stance === STANCE.STAND_GROUND) return reach + 1.0;
  if (stance === STANCE.DEFENSIVE) {
    return Math.max(reach + 1.0, STANCE_LEASH[STANCE.DEFENSIVE]);
  }
  // NEVER SCAN LESS FAR THAN YOU CAN SHOOT.
  //
  // The two passive stances above have always taken `reach + 1.0` as a floor;
  // the aggressive and attack-move cases returned a flat constant, which was
  // right for every unit that existed when it was written — an archer reaches
  // 4.5 + 0.32 and ENGAGE_RANGE is 7.5, so the constant was always the larger.
  //
  // Siege broke that. A mangonel reaches 7.0 + 0.46 + its target's radius, or
  // 7.82 against a militia, which is *further than the scan*. That leaves a
  // live band between 7.5 and 7.82 where the engine can hit something it will
  // never look for, and it is not a theoretical band: measured, a mangonel that
  // killed its ordered target went idle with seven more militia standing 7.52
  // tiles away and never fired again for the rest of the match. Two hundred and
  // ninety-five resources of siege engine, sat down 0.02 tiles outside its own
  // attention span.
  //
  // A floor rather than a replacement, so nothing that used to scan 7.5 now
  // scans less, and a unit parked mid-order still only spares AGGRO_RANGE for
  // its surroundings unless its own weapon reaches further than that.
  if (isAttackMoving(u)) return Math.max(reach + 1.0, ENGAGE_RANGE);
  return Math.max(reach + 1.0, u.task ? AGGRO_RANGE : ENGAGE_RANGE);
}

function acquire(world, u, dt) {
  // Villagers never pick fights.
  if (isVillager(u) || !(u.attack > 0) || u.fleeing) return;
  const stance = stanceOf(u);
  if (stance === STANCE.NO_ATTACK) return;
  // Busy under an order — leave it alone. (A unit unitAI has parked as 'idle'
  // is fair game even if it still carries a spent task object.) An attack-move
  // is the exception: engaging what it passes is the entire point of the order.
  if (u.task && u.state !== 'idle' && !isAttackMoving(u)) return;

  u._acqTimer = (u._acqTimer || 0) - dt;
  if (u._acqTimer > 0) return;
  u._acqTimer = ACQUIRE_INTERVAL + phaseOf(u) * ACQUIRE_INTERVAL;

  const range = acquireRange(u, stance);
  if (range <= 0) return;
  const standing = stance === STANCE.STAND_GROUND;
  let best = null;
  let bestScore = Infinity;
  forEachNear(world, u.x, u.y, range, (e) => {
    if (!canAttack(world, u, e)) return;
    // The fog gate. Never auto-acquire what your side cannot see.
    if (!canSee(world, u, e)) return;
    // Stand Ground fights only what has walked into its reach — it may not take
    // a single step, so a target it cannot hit from here is not a target.
    if (standing && !inRange(u, e)) return;
    // THE FLOOR ON THE SCAN. acquireRange() below is a ceiling and always has
    // been; a siege engine has a floor as well, and picking a fight it cannot
    // start is worse than picking none. Without this a mangonel with a militia
    // in its face would target the militia, refuse to fire (inRange is false),
    // and — because a target is what unitAI's back-away is driven by — spend the
    // fight walking backwards from a man it chose over the archer line it could
    // actually have hit six tiles away. Something already inside the minimum is
    // not this unit's problem; its escort's, or its legs'.
    if (tooClose(u, e)) return;
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

// --- Garrison ---------------------------------------------------------------
//
// A garrisoned unit is lifted out of `world.units` but left in `world.entities`
// and in its owner's `owned` set. That one asymmetry is the whole feature:
//
//   * every per-step loop in the game — movement, combat, separation, the
//     spatial index, the renderer, the fog's viewer sweep — walks world.units,
//     so the unit stops moving, stops being drawn, stops being shot at and
//     stops lighting the map, with no per-system opt-out to remember;
//   * recomputePop() in world.js walks `owned`, so it keeps costing population,
//     which is exactly AoE2's rule and the reason garrisoning is a real choice
//     rather than free storage.
//
// The building side is `building.garrison`, an array of live unit entities.
// Capacity comes from BUILDING_STATS.garrisonCapacity where the building
// declares one (the Watch Tower and the Castle do), and from the fallback table
// in constants.js where it does not (the Town Center).

/** Per-world garrison bookkeeping: one EV.REMOVED subscription, made lazily. */
const GARRISON_CTX = new WeakMap();

function garrisonCtx(world) {
  let ctx = GARRISON_CTX.get(world);
  if (ctx) return ctx;
  ctx = { hooked: true };
  GARRISON_CTX.set(world, ctx);
  world.events.on(EV.REMOVED, (p) => {
    const b = p && p.entity;
    if (!b) return;
    // A unit removed while it was inside something must not leave a corpse on
    // the building's roll: garrisonCount() is what the HUD prints and what the
    // volley is sized from, and a dead body would keep firing arrows.
    if (b.kind === 'unit') {
      const host = b.garrisonedIn;
      if (host && host.garrison) {
        const i = host.garrison.indexOf(b);
        if (i >= 0) host.garrison.splice(i, 1);
      }
      b.garrisonedIn = null;
      return;
    }
    if (b.kind !== 'building') return;
    if (!b.garrison || !b.garrison.length) return;
    // The building is gone. AoE2 kills what was inside it; this ejects it
    // instead, wounded and standing in the rubble. Losing a Town Center is
    // already the worst thing that can happen to a player on a phone, and
    // silently deleting the eight villagers they sheltered in it turns a
    // setback into an unrecoverable one with no visible cause.
    ungarrisonAll(world, b, { force: true });
  });
  return ctx;
}

/** How many bodies this building can hold. 0 means it is not a shelter. */
export function garrisonCapacity(building) {
  if (!building || building.kind !== 'building') return 0;
  const s = BUILDING_STATS[building.type];
  const declared = s && s.garrisonCapacity;
  const cap = declared === undefined
    ? GARRISON_CAPACITY_FALLBACK[building.type]
    : declared;
  return cap > 0 ? cap | 0 : 0;
}

/** Bodies currently inside. */
export function garrisonCount(building) {
  return building && building.garrison ? building.garrison.length : 0;
}

/** Is this unit currently inside something? */
export function isGarrisoned(u) {
  return !!(u && u.garrisonedIn && !u.garrisonedIn.dead);
}

/** Why `unit` may not enter `building` right now, or null when it may. */
export function garrisonRefusal(world, unit, building) {
  if (!unit || unit.dead || unit.kind !== 'unit') return 'No such unit';
  if (isGarrisoned(unit)) return 'Already garrisoned';
  if (!building || building.dead || building.kind !== 'building') return 'No such building';
  if (!building.complete) return 'Still under construction';
  if (building.player !== unit.player) return 'Not your building';
  const cap = garrisonCapacity(building);
  if (cap <= 0) return `The ${(BUILDING_STATS[building.type] || {}).name || building.type} holds nobody`;
  if (garrisonCount(building) >= cap) return 'Full';
  return null;
}

export function canGarrison(world, unit, building) {
  return garrisonRefusal(world, unit, building) === null;
}

/**
 * Put a unit inside a building. Returns true when it went in.
 *
 * Everything the unit was doing is dropped: a garrisoned unit with a live task
 * would resume walking the instant it came out somewhere else entirely.
 */
export function garrisonUnit(world, unit, building) {
  if (garrisonRefusal(world, unit, building)) return false;
  garrisonCtx(world);

  if (!building.garrison) building.garrison = [];
  building.garrison.push(unit);
  unit.garrisonedIn = building;
  unit.task = null;
  unit.target = null;
  unit.autoTarget = false;
  unit._autoFor = null;
  unit.path = null;
  unit.pathIndex = 0;
  unit.dest = null;
  unit.vx = 0;
  unit.vy = 0;
  unit.returnTo = null;
  unit.fleeing = false;
  unit.state = 'garrisoned';
  // Off the map: out of world.units, out of the selection, out of every loop.
  const i = world.units.indexOf(unit);
  if (i >= 0) world.units.splice(i, 1);
  world.selection.delete(unit.id);

  world.events.emit(EV.GARRISON, { building, unit, player: unit.player });
  return true;
}

/**
 * A free tile to step out onto. Rings outward from the footprint, so a full
 * Town Center empties into the ground around it rather than stacking everybody
 * on one square.
 */
function exitTile(world, building, ring) {
  const ox = Math.floor(building.x - building.fw / 2);
  const oy = Math.floor(building.y - building.fh / 2);
  for (let y = oy - ring; y < oy + building.fh + ring; y++) {
    for (let x = ox - ring; x < ox + building.fw + ring; x++) {
      const onRing =
        x === ox - ring || x === ox + building.fw + ring - 1 ||
        y === oy - ring || y === oy + building.fh + ring - 1;
      if (!onRing) continue;
      if (!inBounds(world, x, y)) continue;
      if (isBlocked(world, x, y)) continue;
      if (world.terrain[y * world.width + x] === TERRAIN.WATER) continue;
      return { x: x + 0.5, y: y + 0.5 };
    }
  }
  return null;
}

/**
 * Take a unit back out. `force` puts it out even with nowhere to stand (a
 * building being destroyed under it), because the alternative is deleting it.
 */
export function ungarrisonUnit(world, unit, { force = false } = {}) {
  const b = unit && unit.garrisonedIn;
  if (!b) return false;

  let spot = null;
  for (let ring = 1; ring <= 6 && !spot; ring++) spot = exitTile(world, b, ring);
  if (!spot && !force) return false;

  const list = b.garrison || [];
  const i = list.indexOf(unit);
  if (i >= 0) list.splice(i, 1);
  unit.garrisonedIn = null;

  if (spot) {
    unit.x = spot.x;
    unit.y = spot.y;
  }
  unit.px = unit.x;
  unit.py = unit.y;
  unit.state = 'idle';
  if (!world.units.includes(unit)) world.units.push(unit);

  world.events.emit(EV.UNGARRISON, { building: b, unit, player: unit.player });
  return true;
}

/** Empty a building. The HUD's one-tap control, and what a demolition does. */
export function ungarrisonAll(world, building, opts = {}) {
  if (!building || !building.garrison) return 0;
  let n = 0;
  for (const u of building.garrison.slice()) {
    if (ungarrisonUnit(world, u, opts)) n++;
  }
  return n;
}

/**
 * The building a unit should walk into, given a point the player tapped or a
 * unit that wants shelter: the nearest of its owner's shelters with room.
 */
export function nearestShelter(world, unit, x = unit.x, y = unit.y) {
  return findNearestGlobal(world, x, y, world.buildings, (b) =>
    b.player === unit.player && b.complete && !b.dead &&
    garrisonCapacity(b) > garrisonCount(b));
}

// --- Buildings that shoot ---------------------------------------------------
//
// Two sources of arrows, added together, exactly as AoE2 does it:
//
//   the building's own — a Watch Tower or a Castle declares `attack`,
//   `attackRange` and `attackCooldown` in BUILDING_STATS (that half of the
//   table belongs to the walls pass; this reads it and does nothing if it is
//   absent, so a tower shoots the day its stats land with no edit here);
//
//   one per garrisoned body — which is what makes a Town Center full of
//   villagers a real answer to a raid, and the reason garrisoning is the most
//   AoE2-authentic defensive move in the game.
//
// A garrison arrow is worth GARRISON_ARROW_DAMAGE whoever threw it: an archer
// inside a Town Center is firing through an arrow slit, not standing in a
// field, and making the volley depend on *which* units are inside would be a
// stat nobody can see from outside the building.

function buildingWeapon(b) {
  const s = BUILDING_STATS[b.type] || {};
  const own = s.attack > 0 ? 1 : 0;
  const garrison = garrisonCount(b);
  const arrows = own + garrison;
  if (arrows <= 0) return null;
  return {
    arrows,
    ownDamage: s.attack || 0,
    range: s.attackRange || GARRISON_DEFAULT_RANGE,
    cooldown: s.attackCooldown || GARRISON_VOLLEY_COOLDOWN,
    own,
  };
}

/**
 * Heal what is sheltering, and throw whatever the building has at whatever it
 * can see. Called once per step from updateCombat.
 */
function updateBuildings(world, dt) {
  for (const b of world.buildings) {
    if (b.dead || !b.complete) continue;
    const inside = b.garrison;
    if (inside && inside.length) {
      for (const u of inside) {
        if (u.dead || u.hp >= u.maxHp) continue;
        u.hp = Math.min(u.maxHp, u.hp + GARRISON_HEAL_PER_SEC * dt);
      }
    }

    const w = buildingWeapon(b);
    if (!w) continue;
    b.cooldown = Math.max(0, (b.cooldown || 0) - dt);
    if (b.cooldown > 0) continue;

    // Nearest hostiles first, capped at the number of arrows we have. Units
    // only: a building shooting at another building is a siege, not a volley.
    const seen = [];
    forEachNear(world, b.x, b.y, w.range + Math.max(b.fw, b.fh) / 2, (e) => {
      if (e.kind !== 'unit' || e.dead || !(e.hp > 0)) return;
      if (!isHostile(world, b, e)) return;
      if (edgeDist2(e, b.x, b.y) > w.range * w.range) return;
      // The same fog rule the units obey: a building does not shoot what its
      // owner cannot see.
      if (!canSee(world, b, e)) return;
      seen.push(e);
    });
    if (!seen.length) continue;
    seen.sort((p, q) => edgeDist2(p, b.x, b.y) - edgeDist2(q, b.x, b.y));

    b.cooldown = w.cooldown;
    b.attackAnim = Math.min(0.4, w.cooldown * 0.45);
    for (let i = 0; i < w.arrows; i++) {
      // Spread over what is there and then double up on the nearest, which is
      // both what a defender wants and what stops eleven arrows chasing one
      // scout that is already dead.
      const target = seen[i < seen.length ? i : 0];
      const damage = i < w.own ? w.ownDamage : GARRISON_ARROW_DAMAGE;
      launchProjectile(world, b, target, damage);
    }
  }
}

// --- Healing ----------------------------------------------------------------
//
// The monk is the first unit in the game that is not a worker and not a
// soldier, and healing is the whole of what it does. Three rules carry it, and
// all three are refusals:
//
//   IT NEVER ACQUIRES A TARGET. Not "rarely" and not "only when attacked" —
//   never. canAttack() already refuses any attacker whose `attack` is not
//   greater than zero, and the monk's is exactly 0, so the gate was in place
//   before this section existed and every path into a fight goes through it:
//   auto-acquisition, retaliation, answering a cry for help, and a target the
//   player set by hand (updateCombat drops any target canAttack refuses on the
//   very next step). There is deliberately no second check here — a rule
//   enforced in two places is a rule with two ways to rot. See the monk test in
//   tests/siege.test.mjs, which asserts it from the outside.
//
//   IT HEALS STANDING STILL. A monk walking with the army mends nobody; it has
//   to stop. This is AoE2's rule and it is what keeps 2 hp/s from being simply
//   free — the cost of healing is the tempo you give up standing in a field
//   doing it, and a monk that healed while running would make retreating
//   strictly better than fighting. `state === 'move'` is unitAI's own word for
//   "this unit is walking", so the two systems cannot disagree about it.
//
//   IT NEVER OVERHEALS. Capped at the patient's maxHp, which is the field
//   world.js stamps at spawn and the same one the garrison heal above respects.
//
// WHO GETS MENDED. The most wounded friendly unit in reach, by hitpoints
// missing rather than by hitpoints left. Those pick different patients — a
// knight at 60 of 100 is missing more than an archer at 12 of 32 — and missing
// hitpoints is the right one because it is the measure of what the healing is
// actually worth. Hitpoints restored are hitpoints restored whoever is standing
// under them; picking the nearly-dead archer instead would spend the same two a
// second on a body that is going to be missing 20 fewer of them in ten seconds'
// time, and would leave the knight — 40 hitpoints and 75 food and 75 gold of
// it — wounded for the whole fight.
//
// Ties break on ascending id, which matters for exactly one reason: two
// villagers hurt for the same amount is the ordinary case, not the exotic one,
// and a peer that picked a different one of them would fork the match.

// How often a healer emits EV.HEAL. Healing is continuous and a glow is not —
// the same argument HAMMER_PERIOD makes about hammer blows in unitAI.js. Half a
// second is four pulses per swing of a militia's sword: enough that the FX
// layer reads as a steady mending, few enough that a dozen monks in a stack do
// not put 240 events a second on the bus.
const HEAL_PULSE = 0.5;

/** Hitpoints per second this unit restores, or 0. Two property reads. */
export function healRateOf(u) {
  if (!u || u.kind !== 'unit') return 0;
  const s = UNIT_STATS[u.type];
  const rate = s && s.heal;
  return rate > 0 ? rate : 0;
}

/** How far this unit can mend from. Zero for anything that cannot mend. */
export function healRange(u) {
  if (!u || u.kind !== 'unit') return 0;
  const s = UNIT_STATS[u.type];
  return (s && s.healRange) || 0;
}

/**
 * The friendly unit this healer should be looking after right now: the one
 * missing the most hitpoints within reach, or null when nobody nearby is hurt.
 *
 * Exported because the HUD wants to draw the link and the enemy AI wants to
 * know whether its monks have anything to do; both are read-only questions and
 * this is pure.
 */
export function findPatient(world, healer) {
  const range = healRange(healer);
  if (!(range > 0)) return null;
  let best = null;
  let bestMissing = 0;
  forEachNear(world, healer.x, healer.y, range, (e) => {
    if (e === healer || e.kind !== 'unit' || e.dead) return;
    // Friendly only, and "friendly" is the same player rather than "not
    // hostile": an unowned body belongs to nobody and is nobody's to mend.
    if (e.player === null || e.player === undefined) return;
    if (e.player !== healer.player) return;
    const missing = (e.maxHp || 0) - e.hp;
    if (!(missing > 0)) return;
    // Strictly greater, then ascending id — a total order over the candidates,
    // so the answer does not depend on the order forEachNear happened to walk
    // its buckets in.
    if (missing > bestMissing || (missing === bestMissing && best && e.id < best.id)) {
      bestMissing = missing;
      best = e;
    }
  });
  return best;
}

/**
 * One step of a support unit's life. Called from updateCombat in place of
 * everything a soldier does.
 */
function updateHealer(world, u, dt) {
  const rate = healRateOf(u);
  // Walking, panicking, or dead on its feet: no mending. The flee check is not
  // decoration — a monk chased off by cavalry is running, and a monk that
  // healed while running would never have to stop.
  if (rate <= 0 || u.state === 'move' || u.fleeing) {
    u.healTarget = null;
    return;
  }

  const patient = findPatient(world, u);
  u.healTarget = patient;
  if (!patient) {
    u._healPulse = 0;
    u._healPulsed = 0;
    return;
  }

  faceTarget(u, patient);
  const before = patient.hp;
  patient.hp = Math.min(patient.maxHp, patient.hp + rate * dt);
  const healed = patient.hp - before;
  if (healed <= 0) return;

  // Pulsed rather than emitted every step: see HEAL_PULSE.
  u._healPulsed = (u._healPulsed || 0) + healed;
  u._healPulse = (u._healPulse || 0) + dt;
  if (u._healPulse < HEAL_PULSE) return;
  const amount = u._healPulsed;
  u._healPulse = 0;
  u._healPulsed = 0;
  world.events.emit(EV.HEAL, { entity: u, target: patient, amount });
}
