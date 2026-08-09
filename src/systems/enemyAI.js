// Enemy AI — plays an AoE2-style opening, then escalating attack waves.
//
// Contract:  createEnemyAI(world, playerId) -> { update(dt) }
//
// `update(dt)` is called once per fixed sim step (20 Hz) from GameScene.simStep.
// Per-step work is deliberately trivial: everything interesting runs on a
// 0.5 s "think" cadence, and the expensive villager rebalance on a 2 s cadence.
//
// No Phaser imports — this module is pure logic and runs headlessly under Node.
// Every random draw goes through `world.rng`, never Math.random, so a seed
// reproduces a match exactly.
//
// The shape of the game it plays:
//
//   0:00  3 villagers -> 2 berries / 1 wood, TC trains villagers non-stop
//   0:00  first House the moment wood allows (the TC alone only gives 5 pop)
//   ~1:30 gold assignment opens up so military is affordable
//   ~1:45 Barracks; Mill if the berries are a long walk
//   ~3:00 Farms, once the berries within working range thin out — and from then
//         on continuously, because a farm is spent as fast as it is worked
//   ~2:00 militia + archers train continuously, aiming at 2:1 melee:ranged
//   ~2:55 first wave: 5 units, sent as one group at a soft edge of your base
//         (it lands on your town around 3:45)
//   then  a wave every 90-125 s, +2 units each wave, capped at 16
//
// Measured over eight seeds: 4-5 waves in ten minutes, gaps 95-120 s, every
// wave reaching the player's town. A wave that gets wiped costs it ~135 s of
// rebuilding before the next one, which is the intended punishment for the
// player fighting back.
//
// It never busy-waits: every "I want X" has a cooldown and a bounded search,
// and a wiped-out wave puts it back into an economy-rebuilding posture.

import {
  UNIT_STATS, BUILDING_STATS, MAX_POP_CAP, RES, PLAYER,
  MILITARY_TYPES as ROSTER, BONUS_DAMAGE,
} from '../core/constants.js';
import { EV } from '../core/events.js';
import {
  ownedBy, findNearestGlobal, forEachNear, canPlace,
} from '../core/world.js';
import {
  canAfford, queueTrain, placeFoundation, cancelFoundation,
  isGatherableBuilding, gatherableBuildings,
} from './economy.js';
import { findPath } from './pathfinding.js';
import { commandUnits, isIdle } from './unitAI.js';
import { armorClassOf, isGarrisoned, garrisonCapacity, garrisonCount, ungarrisonAll } from './combat.js';
import {
  AGE, TECHS, currentAge, hasTech, techsAt, queueResearch, researchRefusal,
  nextAgeTech,
} from './tech.js';
import { hyp, dirVec, DIR_COUNT } from '../core/iso.js';

// --- Tuning -----------------------------------------------------------------

const THINK_PERIOD = 0.5;      // seconds of sim time between decision passes
const REBALANCE_PERIOD = 2.0;  // seconds between villager re-assignment passes

// --- The order budget -------------------------------------------------------
//
// Handing a unit an order is not free: commandUnits() plans a path for it, and
// unitAI grants a *fresh* immediate A* allowance to every order it is given
// (IMMEDIATE_SEARCHES_PER_ORDER, 48) precisely so that a player's tap always
// registers on the step it was made. A player taps once. This AI does not: when
// a wave launches it hands sixteen soldiers a single group order across
// eighty-five tiles of map, and sixteen full-map A* searches land inside one
// fixed step.
//
// Measured, ten minutes on each of five seeds: `sim.enemyAI` sat at 0.03ms mean
// and spiked to 22.5ms on the steps a wave went out — 1.4ms of pathfinding per
// soldier, all of it charged to one step. The whole 60fps frame is 16.7ms, so
// every wave launch was a guaranteed dropped frame, and so, more quietly, was
// every villager rebalance that re-tasked eight workers at once.
//
// The work is not avoidable and it is not wasted; it simply must not all land on
// one step. So every order this AI issues goes into a queue and is dispatched a
// few units at a time, once per *sim step* rather than once per think — so the
// backlog drains at 40-60 units a second and a sixteen-soldier wave is fully
// under way a third of a second after it is ordered, which is well inside the
// time the first man takes to walk out of the staging point.
//
// Three is the budget because three cross-map searches measured 3-4ms, which is
// a quarter of the frame and leaves the rest of the simulation its own room. It
// also has to be high enough that a think can never enqueue faster than the ten
// steps behind it can drain: the largest single pass the AI makes is one order
// per villager (24) plus one per soldier (26 at the cap), and thirty a think
// covers it.
const ORDERS_PER_STEP = 2;

// Villager cap.
//
// The old figure (16) was derived from "food is finite: 6 nodes x 150 = 900".
// Both halves of that were wrong. Measured on the shipped mapgen across seeds,
// the map carries 37-45 berry nodes of 200 (7400-9000 food), of which 3800-6600
// sits within this AI's own 26-tile scan — about seven times the assumed budget.
// And food is no longer finite at all: a Farm converts 60 wood into 300 food,
// against 39000-44000 wood standing in trees.
//
// So food does not set the cap any more; population does — but not the engine's
// any more either. MAX_POP_CAP is now 200 (AoE2's default), and this AI does not
// try to fill it: MAX_HOUSES below holds it to a 50-pop economy, which is the
// shape of opening that is actually tested. A wave tops out at MAX_WAVE_SIZE
// (16) and the AI wants a standing army of roughly that plus replacements — call
// it 26 pop — to keep launching full-sized waves while absorbing losses. 50 - 26
// = 24 villagers, which is also about what this economy can keep employed: ~10
// on food (2-3 farms running), ~8 on wood (farms and houses to pay for) and ~6
// on gold. Growing past that is the enemy AI upgrade's job, not this pass's.
const MAX_VILLAGERS = 24;
// ...but not before there is a Barracks. Villagers arrive faster than houses do,
// and an economy booming to 24 keeps pushing "we are 2 off the cap, build a
// house" in front of the Barracks, which pushed the first wave from ~4:15 out to
// ~6:00. 16 is the old cap and the opening it produces is the tested one.
const PRE_BARRACKS_VILLAGERS = 16;
// TC(5) + 9 x 5 = 50 pop. This is the AI's own ceiling, not the engine's (see
// MAX_VILLAGERS above): the pop cap is 200, and stopping here is a deliberate
// choice about how large an economy this opening knows how to run.
const MAX_HOUSES = 9;
const FOOD_SCAN = 26;          // how far out we count food still in the ground

// Farms. FARM_SCAN is the radius that counts as "berries we can actually work
// without a 17-second walk each way", and is deliberately much tighter than
// FOOD_SCAN: the cliff the player hits is local exhaustion, not map-wide.
const FARM_SCAN = 14;
const FARM_BERRY_FLOOR = 1200; // berries left inside FARM_SCAN before we farm
const FARM_MIN_VILLAGERS = 5;  // don't spend the opening's wood on fields
const FARM_WOOD_RESERVE = 30;  // always leave enough wood for the next House
const FARM_FOOD_CEILING = 2000; // banked food above which another field is waste
const MAX_FARMS = 8;

const BARRACKS_TIME = 105;     // earliest barracks (seconds)
const BARRACKS2_TIME = 330;    // second barracks, for wave escalation
const MILL_MIN_WALK = 5.0;     // build a Mill if berries are further than this

// Population the Town Center may not take once there is somewhere to train
// soldiers.
//
// Two producers draw on one population cap and the Town Center wins every race:
// it trains in 16 seconds against a militia's 22, and manageTraining asks it
// first, so every slot a house opens is a villager before the Barracks has
// looked at it. Left alone that ends exactly one way, and it is the way the
// smoke run kept catching: four minutes, 25/25, a finished Barracks and
// twenty-five villagers.
//
// Two slots per military building is one unit in the queue and one on the way
// out of it, capped so that a second Barracks does not quietly stop the economy.
// It is only ever charged while there is a wave's worth of army still missing
// (see armyTarget), so an AI that already has its soldiers goes straight back to
// making villagers.
const MILITARY_POP_PER_TRAINER = 2;
const MAX_MILITARY_POP_RESERVE = 5;

// Population headroom a House is started at.
//
// Two was the figure for a base whose only consumer was the Town Center, and it
// is still right there: one villager every sixteen seconds against a House that
// adds five in twenty. It is badly wrong the moment a Barracks is also standing,
// because then the cap is being eaten from two queues at once and the AI spends
// most of the fourth minute sitting on a full one — which is the other half of
// how a pop-capped AI ends up with no army. Six is a wave and a half of slack,
// and a House is 25 wood, which is the cheapest thing on the list to be wrong
// about in this direction.
const HOUSE_BUFFER = 2;
const HOUSE_BUFFER_BOOMING = 3;   // ...once the economy is large enough to spend it
const HOUSE_BUFFER_MILITARY = 6;  // ...once soldiers are competing for the same cap

// Forward drop-offs (Lumber Camp / Mining Camp).
//
// A villager's income is set by its round trip, not by its gather rate. A full
// pack is 10 resources and a villager walks 1.35 tiles/second, so every tile of
// haul costs about 1.5 seconds of every trip. At CAMP_MIN_WALK the round trip is
// spending ~13 seconds walking against ~8 seconds working — the villager is more
// than half idle — and a 100-wood camp beside the node pays that back inside two
// minutes of one worker. Below it the camp is worse than the walk, which is why
// this is a threshold and not "build one per woodline".
//
// Measured against the map generator: a base's starting woodline and gold are
// both inside 8 tiles, so this never fires in the opening. It starts firing
// around the four minute mark, when the near trees are stumps and the workforce
// has drifted out to the second woodline — which is exactly the moment a human
// player notices their wood has quietly stopped growing.
const CAMP_MIN_WALK = 9.0;
// Not before the economy can spare a builder, and never with the wood that the
// next House or field is waiting on. A camp is an optimisation; being housed is
// not.
const CAMP_MIN_VILLAGERS = 6;
const CAMP_WOOD_RESERVE = 120;
// Enough to cover the woodlines a base actually works, and no more: past this
// the AI is spending wood on buildings instead of on the army the wood is for.
const MAX_LUMBER_CAMPS = 3;
const MAX_MINING_CAMPS = 2;

const FIRST_WAVE_TIME = 170;   // earliest first attack
const FIRST_WAVE_SIZE = 5;
const WAVE_SIZE_STEP = 2;
const MAX_WAVE_SIZE = 16;
// Waves are scheduled from the moment one *launches*, not from when it dies,
// so pressure arrives on a predictable ~90-125 s beat whatever happens out
// there. A wave that has been grinding for 80 s without finishing the job
// comes home rather than feeding itself in one unit at a time.
const WAVE_INTERVAL_MIN = 90;
const WAVE_INTERVAL_MAX = 125;
const WAVE_REGROUP_AFTER_LOSS = 135; // longer pause after a wave is wiped
const WAVE_TIMEOUT = 80;
const WAVE_BREATHER = 15;      // minimum regroup before the next launch

const STAGING_DIST = 5.5;      // rally point, tiles from the TC toward the foe
const DEFEND_RADIUS = 13;      // hostiles this close to home trigger defence
const DEFEND_CLEAR_TIME = 12;  // all-clear delay before resuming offence
const STUCK_WINDOW = 1.5;      // seconds between motion samples
const STUCK_DIST = 0.4;        // moved less than this while "moving" = jammed
const BUILD_RETRY_DELAY = 6;   // no infinite placement retries
const FOUNDATION_STALL = 60;   // abandon a foundation nobody is finishing
// Ground searches allowed in one think. Each one that gets far enough costs up
// to MAX_REACH_CHECKS path queries, so this is what stops a base with three
// things it wants and no room for any of them turning a think into a frame drop.
// Two is enough to fall past a single unsiteable type to the thing behind it,
// which is the whole point of the wishlist.
const SPOT_SEARCHES_PER_THINK = 2;
// Path checks spent proving a candidate site is actually walkable to, per band.
// The far band gets fewer because it is the fallback: a site sixteen tiles out
// that we cannot prove is reachable is still better than no building at all, and
// the fallback path already covers it.
const MAX_REACH_CHECKS = 8;
const FAR_REACH_CHECKS = 4;

// Every soldier in the game, read off UNIT_STATS rather than written out, so a
// unit added to the roster is one this AI trains, counts, waves and defends
// with, with no edit here. (It was a literal two-element list; that list is
// exactly how an AI ends up still massing militia three units after the game
// grew a counter system.)
const MILITARY_TYPES = ROSTER.slice();

// --- Composition -------------------------------------------------------------
//
// The AI has to answer what the player fielded, not just build "some army".
// Two knobs do the whole job:
//
//   COUNTER_WEIGHT   how hard the observed enemy mix pulls the next unit choice.
//                    High enough that massing one unit is punished, low enough
//                    that the AI never chases a composition it has already been
//                    beaten by — a bot that perfectly counters last minute's
//                    army is a bot that always fights the last battle.
//   MIX_CEILING      no single type may exceed this share of the army, however
//                    good the counter maths says it is. This is the important
//                    one: a pure-spearman army loses to anything that is not
//                    cavalry, and an AI that reasons only from counters walks
//                    into that every time the player shows it two knights.
const COUNTER_WEIGHT = 2.2;
const MIX_CEILING = 0.55;
// What the AI builds when it has seen nothing of the player at all — the fog
// means that is the normal state early on. AoE2's own default opening mix:
// mostly infantry, a third archers, a scout out front.
const DEFAULT_MIX = { militia: 0.45, archer: 0.35, scout: 0.2 };
// Wood the army is never allowed to spend.
//
// Two of the five units cost wood, where the old two-unit roster had one, and
// that turned out to matter more than it sounds. The wood line is what pays for
// Houses — and the AI stalls harder on being housed than on anything else — so
// a mix that quietly drinks 25 wood a soldier has to be held back from the last
// of it. Sixty is two Houses and change.
const MILITARY_WOOD_RESERVE = 60;
// ...and more than that while the Town Center is the only building that can
// bank wood at all. A decapitated base with 91 wood is a base that can afford
// neither a Town Center (275) nor the Lumber Camp (100) that would let it earn
// one: every villager sent to the trees fills its pack, finds nowhere to put it
// and stands there, and the AI holds a thousand food for the rest of the match
// while it starves for timber. chooseBuilding already knows how to climb out of
// that hole; this is what stops it falling in.
const REBUILD_WOOD_FLOAT = 100;

// A raid this close to the Town Center puts villagers inside it rather than
// running them in circles around it. Generous — by the time a scout is eight
// tiles from the TC the villagers on that side are already dead if they walk.
const GARRISON_PANIC_RADIUS = 11;
// Villagers stay inside for at least this long after the last sign of trouble.
// Shorter and the AI empties the Town Center into the raid that is still
// standing there; much longer and it is idling its economy for free.
const GARRISON_HOLD = 8;

// --- Tech (ages and upgrades) -----------------------------------------------
//
// The AI has to age up, and it has to buy the gathering upgrades, for one
// reason: a human who does both and an AI that does neither are not playing the
// same game by minute six. Double-Bit Axe and Bow Saw together are +40% wood
// forever; against an opponent who never buys them that is a second lumber camp
// out of thin air, and the waves that wood pays for stop arriving.
//
// The schedule is deliberately behind what a good human manages, not level with
// it. This AI is the opposition in a ten-minute skirmish, not a ladder bot: it
// should punish a player who ignores the tech tree and lose to one who uses it
// well.
//
// These two clocks are the *earliest* the AI will consider it, not when it
// happens. Measured over five seeds of a full ten-minute match, the age-up
// actually lands at 5:30-8:00 for the Feudal Age and 8:15-9:30 for the Castle,
// because the money gate below binds long before the clock does — the Town
// Center is training villagers non-stop and the barracks is training soldiers,
// so 400 spare food takes a while to appear. That is the right shape: a human
// who *chooses* to stop making villagers for forty seconds gets there first,
// which is exactly the trade the age is supposed to be.
const FEUDAL_AGE_TIME = 255;
const CASTLE_AGE_TIME = 495;
const AGE_UP_VILLAGERS = 10;
const AGE_UP_VILLAGERS_CASTLE = 18;
// A 400-food age-up is eight villagers the Town Center did not train. This
// reserve is what stops it being taken out of the food the barracks is queued
// on: the AI banks the cost *plus* a working float before it commits.
const AGE_UP_RESERVE = { food: 90, wood: 0, gold: 40, stone: 0 };
// 140 food of reserve and a twelve-villager gate were the first try, and they
// pushed the Feudal Age past 5:40 on every seed and past 8:00 on one. 90 and 10
// is the same idea with the brakes eased: the age lands around 5:30, the AI
// still never goes broke for it, and the only measured cost was one wave in one
// seed out of five — which is the trade the upgrades then pay back.
// The same idea, smaller, for the upgrades themselves. An upgrade is always
// worth having eventually and never worth going broke for this minute.
const TECH_RESERVE = { food: 120, wood: 90, gold: 80, stone: 0 };

// Which drop-off buildings get shopped, in the order their upgrades pay off.
// Wood first because it compounds into every building the AI wants next; food
// second because it feeds the villagers doing the chopping; gold and stone last
// because only soldiers and (later) defences spend them.
const ECO_RESEARCH_BUILDINGS = ['lumbercamp', 'mill', 'miningcamp'];
// Military upgrades come out of the same purse as the next wave, so they wait
// until there is an army for them to improve.
const MILITARY_RESEARCH_BUILDINGS = ['blacksmith', 'archeryrange', 'barracks'];
const MILITARY_TECH_MIN_ARMY = 6;
// One think in four. Nothing here is expensive, but nothing here changes in
// half a second either, and the pass walks every building the AI owns.
const TECH_THINK_EVERY = 4;

// --- Small guards -----------------------------------------------------------

function live(e) {
  return !!e && !e.dead;
}

function liveIn(world, e) {
  return !!e && !e.dead && world.entities.has(e.id);
}

function dist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function isMilitary(u) {
  return live(u) && u.kind === 'unit' && MILITARY_TYPES.includes(u.type);
}

// Candidate offsets for building placement, in two bands. Built once.
//
// The near band is where a building *belongs*: at least 3.2 tiles from the
// anchor so the AI never builds on top of itself, at most eleven so the base
// stays one base. The far band is only ever reached when the near one has
// nothing at all — and that is not the rare accident it sounds like. Measured
// over 24 seeds of the shipped mapgen, two enemy bases were ringed tightly
// enough by forest that no 5x5 clearing existed within eleven tiles of the Town
// Center for the whole opening. Both spent a hundred seconds asking for a
// Barracks, banking six hundred wood, and reached four minutes with no soldiers.
//
// `stride` is what makes the sweep both complete and spread out. Walking the
// offsets in distance order would put every building on the same side of the
// base; walking them by a stride coprime with the band's length visits every
// candidate exactly once, in an order that fans around the anchor. The old code
// used a fixed stride of 7 and stopped after 90 tries, which sampled about a
// quarter of the near band — the direct cause of the hundred seconds above.
function placementBand(min, max) {
  const offsets = [];
  const r = Math.ceil(max);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= min && d <= max) offsets.push({ dx, dy, d });
    }
  }
  offsets.sort((a, b) => a.d - b.d);
  let stride = 1;
  for (const s of [7, 11, 13, 17, 19, 23, 29, 31, 37]) {
    if (offsets.length % s !== 0) { stride = s; break; }
  }
  return { offsets, stride };
}
const PLACEMENT_NEAR = placementBand(3.2, 11);
const PLACEMENT_FAR = placementBand(11, 17);

// ---------------------------------------------------------------------------

class EnemyAI {
  constructor(world, playerId) {
    this.world = world;
    this.id = playerId;
    this.foeId = playerId === PLAYER ? 1 : PLAYER;

    this.acc = 0;
    this.rebalanceAcc = 0;
    this.think = 0;

    // Villager assignments: unitId -> { res, nodeId }
    this.jobs = new Map();
    // Villagers pulled off gathering to construct something: unitId -> true
    this.builders = new Set();

    // Orders waiting to be handed to unitAI, oldest first, and the index that
    // says which unit is waiting on which of them. See ORDERS_PER_STEP.
    this.orderQueue = [];      // [{ ids: [unitId], order }]
    this.orderPending = new Map(); // unitId -> the queue entry holding it

    // Nearest reachable node of each resource, refreshed once per think.
    this.available = { food: null, wood: null, gold: null };
    this.home = null;          // last known base centre, survives TC loss
    this.staging = null;       // rally point for fresh soldiers

    this.pending = null;       // { type, entity, since, progress }
    this.abandoned = new Set(); // foundation ids nobody could ever reach
    this.badSpots = [];        // sites that proved unreachable, never retried
    // Per *type* rather than one global gate: a Barracks that cannot be sited
    // must back itself off without taking the House behind it down with it. The
    // single `buildBlockedUntil` this replaces is precisely why a base with no
    // room for a 3x3 stopped building anything at all.
    this.blockedUntil = new Map();
    this.placeCursor = 0;

    this.wave = null;          // { ids, target, launchedAt, size }
    this.waveNumber = 0;
    this.nextWaveTime = FIRST_WAVE_TIME;
    this.lostLastWave = false;

    // Stuck-watchdog bookkeeping: unitId -> { x, y, t, strikes }
    this.motion = new Map();

    this.lastDamageTime = -999;
    this.lastDamageAt = null;
    this.defendingUntil = -999;

    // Observability, also used by the headless test.
    this.stats = {
      errors: 0,
      lastError: null,
      housesStarted: 0,
      barracksStarted: 0,
      millsStarted: 0,
      farmsStarted: 0,
      lumberCampsStarted: 0,
      miningCampsStarted: 0,
      villagersQueued: 0,
      militaryQueued: 0,
      techsResearched: 0,
      // One entry per age-up *started*: { t, age }. Started rather than
      // finished, because the interesting question in a test is "did it decide
      // to", and the sixty-five seconds it then spends researching are the
      // engine's business, not the AI's.
      ageUps: [],
      wavesLaunched: 0,
      wavesWiped: 0,
      wavesReachedBase: 0,
      minDistToFoeBase: Infinity,
      lastWaveSize: 0,
      // One entry per launch: { t, size, militia, archers, afterLoss }
      waveLog: [],
    };

    // Cheap "am I being attacked" signal. Combat emits DAMAGE synchronously.
    if (world.events && typeof world.events.on === 'function') {
      world.events.on(EV.DAMAGE, (p) => {
        if (!p) return;
        const victim = p.target || p.entity;
        if (!victim || victim.player !== this.id) return;
        this.lastDamageTime = world.time;
        this.lastDamageAt = { x: victim.x, y: victim.y };
      });
    }
  }

  // --- entry point ---------------------------------------------------------

  update(dt) {
    const w = this.world;
    if (!w || w.over) return;
    const me = w.players && w.players[this.id];
    if (!me || me.defeated) return;

    // Every step, before the think: the backlog is what makes the think cheap,
    // and a step that skips draining it is a step the wave stands still for.
    try {
      this.dispatchOrders();
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = err && err.stack ? err.stack : String(err);
    }

    this.acc += dt;
    if (this.acc < THINK_PERIOD) return;
    const step = this.acc;
    this.acc = 0;
    this.think++;

    try {
      this.tick(step);
    } catch (err) {
      // A single bad frame must never end the match. Record it loudly instead.
      this.stats.errors++;
      this.stats.lastError = err && err.stack ? err.stack : String(err);
      if (this.stats.errors === 1 && typeof console !== 'undefined') {
        console.warn('[enemyAI] error in think():', err);
      }
    }
  }

  tick(step) {
    this.refreshHome();
    this.refreshAvailability();
    this.trackWaveProgress();
    this.assessThreat();

    this.rebalanceAcc += step;
    const doRebalance = this.rebalanceAcc >= REBALANCE_PERIOD;
    if (doRebalance) this.rebalanceAcc = 0;

    this.watchStuck();
    this.ungarrisonWhenClear();
    this.manageConstruction();
    this.manageVillagers(doRebalance);
    this.manageTraining();
    // After training, deliberately. Villagers and soldiers are the things that
    // win the match; an upgrade only makes them better, so it may never take
    // the food a unit was about to be queued on (see TECH_RESERVE).
    if (this.think % TECH_THINK_EVERY === 0) this.manageTech();
    this.manageArmy();
  }

  /**
   * Crowd watchdog.
   *
   * Units that are walking but not actually moving — head-on jams in a
   * corridor, a pile-up on a drop-off tile — would otherwise sit there for the
   * rest of the match with a full load of gold and freeze a whole resource
   * line. Two consecutive 1.5 s windows of "state says move, position says no"
   * and we shove the unit sideways and let it re-task from scratch.
   *
   * Bounded work: one pass over our own units per think, no allocation.
   */
  watchStuck() {
    const w = this.world;
    const units = this.myUnits();
    const seen = new Set();

    for (const u of units) {
      seen.add(u.id);
      let rec = this.motion.get(u.id);
      if (!rec) {
        this.motion.set(u.id, { x: u.x, y: u.y, t: w.time, strikes: 0 });
        continue;
      }
      if (w.time - rec.t < STUCK_WINDOW) continue;
      const moved = dist(u.x, u.y, rec.x, rec.y);
      // Only 'move' counts: gathering, building and fighting are meant to be
      // stationary.
      if (u.state === 'move' && moved < STUCK_DIST) rec.strikes++;
      else rec.strikes = 0;
      rec.x = u.x;
      rec.y = u.y;
      rec.t = w.time;
      if (rec.strikes >= 2) {
        rec.strikes = 0;
        this.unstick(u);
      }
    }

    if (this.motion.size > units.length * 2) {
      for (const id of Array.from(this.motion.keys())) {
        if (!seen.has(id)) this.motion.delete(id);
      }
    }
  }

  /** Break a jam: drop the task, sidestep, and let the next pass re-task. */
  unstick(u) {
    const w = this.world;
    this.jobs.delete(u.id);
    this.builders.delete(u.id);
    if (this.wave) {
      const i = this.wave.ids.indexOf(u.id);
      if (i >= 0) this.wave.ids.splice(i, 1);
    }
    // A short hop at a seeded random angle, onto ground we know is open.
    for (let i = 0; i < 6; i++) {
      // A seeded direction from the literal table rather than a seeded angle
      // through cos/sin, which are not identical across engines.
      const d = dirVec(w.rng.int(0, DIR_COUNT - 1));
      const gx = Math.round(u.x + d[0] * 2.5);
      const gy = Math.round(u.y + d[1] * 2.5);
      if (gx < 1 || gy < 1 || gx >= w.width - 1 || gy >= w.height - 1) continue;
      if (!canPlace(w, gx + 0.5, gy + 0.5, 1, 1)) continue;
      this.command([u], { type: 'stop' });
      this.command([u], { type: 'move', gx: gx + 0.5, gy: gy + 0.5 });
      return;
    }
    this.command([u], { type: 'stop' });
  }

  // --- base bookkeeping ----------------------------------------------------

  myUnits(type = null) {
    return ownedBy(this.world, this.id, 'unit', type);
  }

  myBuildings(type = null) {
    return ownedBy(this.world, this.id, 'building', type);
  }

  townCenter() {
    const tcs = this.myBuildings('towncenter');
    if (!tcs.length) return null;
    return tcs.find((b) => b.complete) || tcs[0];
  }

  /** Base centre: TC if we have one, else our buildings, else our units. */
  refreshHome() {
    const tc = this.townCenter();
    if (tc) {
      this.home = { x: tc.x, y: tc.y };
    } else {
      const bs = this.myBuildings();
      const us = this.myUnits();
      const pool = bs.length ? bs : us;
      if (pool.length) {
        let sx = 0;
        let sy = 0;
        for (const e of pool) {
          sx += e.x;
          sy += e.y;
        }
        this.home = { x: sx / pool.length, y: sy / pool.length };
      }
    }
    if (!this.home) this.home = { x: this.world.width / 2, y: this.world.height / 2 };

    if (!this.staging || !this.stagingStillGood()) this.staging = this.computeStaging();
  }

  foeBase() {
    const w = this.world;
    const tc = ownedBy(w, this.foeId, 'building', 'towncenter')[0];
    if (tc) return { x: tc.x, y: tc.y };
    const bs = ownedBy(w, this.foeId, 'building');
    if (bs.length) return { x: bs[0].x, y: bs[0].y };
    const us = ownedBy(w, this.foeId, 'unit');
    if (us.length) return { x: us[0].x, y: us[0].y };
    // Mirror of our own corner, as a last resort.
    return { x: w.width - this.home.x, y: w.height - this.home.y };
  }

  stagingStillGood() {
    const s = this.staging;
    if (!s) return false;
    return dist(s.x, s.y, this.home.x, this.home.y) < STAGING_DIST + 4;
  }

  /** A muster point a few tiles from the TC on the side facing the enemy. */
  computeStaging() {
    const w = this.world;
    const home = this.home;
    const foe = this.foeBase();
    let vx = foe.x - home.x;
    let vy = foe.y - home.y;
    const len = hyp(vx, vy) || 1;
    vx /= len;
    vy /= len;
    // Walk outward from the TC and take the last open tile we find.
    let best = { x: home.x, y: home.y };
    for (let r = 2.5; r <= STAGING_DIST; r += 1) {
      const gx = Math.round(home.x + vx * r);
      const gy = Math.round(home.y + vy * r);
      if (gx < 1 || gy < 1 || gx >= w.width - 1 || gy >= w.height - 1) break;
      if (!canPlace(w, gx + 0.5, gy + 0.5, 1, 1)) continue;
      best = { x: gx + 0.5, y: gy + 0.5 };
    }
    return best;
  }

  /** Population actually committed: live units plus everything queued. */
  popState() {
    const p = this.world.players[this.id];
    let pop = 0;
    for (const u of this.myUnits()) pop += (UNIT_STATS[u.type] || { pop: 1 }).pop || 1;
    let queued = 0;
    for (const b of this.myBuildings()) queued += b.queue ? b.queue.length : 0;
    const cap = p ? p.popCap : 0;
    return { pop, queued, used: pop + queued, cap, room: cap - pop - queued };
  }

  res() {
    const p = this.world.players[this.id];
    // Stone is carried in the fallback so `r.stone` is a number everywhere,
    // even before a Town Center exists. Nothing this AI can build spends it yet
    // — its sinks (castle, towers, stone walls) belong to a later system — so it
    // is bookkeeping only, and the villager split below stays three-way on
    // purpose rather than quietly parking workers on a resource with no use.
    return (p && p.resources) || { food: 0, wood: 0, gold: 0, stone: 0 };
  }

  afford(cost) {
    try {
      return !!canAfford(this.world, this.id, cost);
    } catch {
      return false;
    }
  }

  // --- construction --------------------------------------------------------

  /**
   * One building at a time. Decide what we want, find ground for it, put a
   * villager on it, and let go once it is up (or clearly never going to be).
   */
  manageConstruction() {
    const w = this.world;

    // Track the in-flight foundation.
    if (this.pending) {
      const f = this.pending.entity;
      const progress = f ? (f.buildProgress || 0) : 0;
      if (progress > this.pending.progress + 1e-6) {
        this.pending.progress = progress;
        this.pending.since = w.time;     // it is moving; reset the stall clock
      }
      if (f && !liveIn(w, f)) {
        this.pending = null;             // it died mid-build
      } else if (f && f.complete) {
        this.pending = null;             // done
      } else if (w.time - this.pending.since > FOUNDATION_STALL) {
        // Nobody can reach it. Tear the site down — refunding what it cost and
        // freeing the ground — and blacklist the spot. Leaving the husk standing
        // used to suppress the whole type forever: an unreachable Barracks
        // foundation meant `anyOf('barracks') === 1`, so the AI never placed
        // another one and never trained a single soldier for the rest of a
        // ten-minute match.
        this.abandoned.add(f && f.id);
        this.badSpots.push({ x: f.x, y: f.y });
        if (this.badSpots.length > 12) this.badSpots.shift();
        try { cancelFoundation(w, f); } catch { /* keep playing */ }
        this.pending = null;
        this.releaseBuilders();
      } else if (f) {
        this.staffConstruction(f);
        return;
      } else {
        this.pending = null;
      }
    }

    if (!this.pending) this.releaseBuilders();

    // Anything of ours half-built that we did not start (or lost track of)?
    const orphan = this.myBuildings().find(
      (b) => !b.complete && !b.dead && !this.abandoned.has(b.id),
    );
    if (orphan) {
      this.pending = {
        type: orphan.type, entity: orphan, since: w.time,
        progress: orphan.buildProgress || 0,
      };
      this.staffConstruction(orphan);
      return;
    }

    if (!this.myUnits('villager').length) return;

    // Walk the wishlist and put down the best thing we can actually pay for and
    // find ground for. Falling through is the whole point: the old code asked
    // for one type and, when that type had nowhere to go, built *nothing* for
    // BUILD_RETRY_DELAY and then asked for the same impossible thing again.
    let searches = 0;
    for (const wish of this.buildingWishlist()) {
      if (searches >= SPOT_SEARCHES_PER_THINK) break;
      if (w.time < (this.blockedUntil.get(wish.type) || 0)) continue;
      const stats = BUILDING_STATS[wish.type];
      // Not "return" — a House we can afford beats a Barracks we cannot, and
      // the one case where saving up must block everything (rebuilding a lost
      // Town Center) is handled by that wishlist having nothing else in it.
      if (!stats || !this.afford(stats.cost)) continue;

      searches++;
      const spot = this.findBuildSpot(wish.type, wish.anchor || this.home);
      if (spot && this.startBuilding(wish.type, spot)) return;
      // No ground for this one right now. Back *this type* off and try the next.
      this.blockedUntil.set(wish.type, w.time + BUILD_RETRY_DELAY);
    }
  }

  /** Place a foundation, count it, and put builders on it. */
  startBuilding(type, spot) {
    const w = this.world;
    let foundation = null;
    try {
      foundation = placeFoundation(w, this.id, type, spot.gx, spot.gy);
    } catch {
      foundation = null;
    }
    if (!foundation || typeof foundation !== 'object') {
      // Some economy implementations return a bool; look the foundation up.
      foundation = findNearestGlobal(
        w, spot.gx, spot.gy, this.myBuildings(),
        (b) => !b.complete && b.type === type,
      );
    }
    if (!foundation) return false;

    if (type === 'house') this.stats.housesStarted++;
    else if (type === 'barracks') this.stats.barracksStarted++;
    else if (type === 'mill') this.stats.millsStarted++;
    else if (type === 'farm') this.stats.farmsStarted++;
    else if (type === 'lumbercamp') this.stats.lumberCampsStarted++;
    else if (type === 'miningcamp') this.stats.miningCampsStarted++;

    this.pending = {
      type, entity: foundation, since: w.time,
      progress: foundation.buildProgress || 0,
    };
    this.staffConstruction(foundation);
    return true;
  }

  /**
   * What the base wants built, best first: [{ type, anchor }].
   *
   * This used to answer with a single type, and the difference turned out to be
   * whether the AI fields an army at all. A type it wants but cannot *site* — a
   * Barracks needing a clear 5x5 in a base ringed by forest — took the entire
   * construction pass down with it: no House went up behind it, no field, no
   * camp, for as long as the ground stayed unavailable. Measured over 24 seeds,
   * two bases spent a hundred seconds of the opening in exactly that state and
   * reached four minutes pop-capped, six hundred wood in the bank, no soldiers.
   *
   * A list lets manageConstruction fall through to the next thing it *can* put
   * down, which is what a human does without noticing they are doing it.
   */
  buildingWishlist() {
    const w = this.world;
    const p = w.players[this.id];
    const pop = this.popState();
    const buildings = this.myBuildings();
    const complete = (t) => buildings.some((b) => b.type === t && b.complete);
    const anyOf = (t) => buildings.filter((b) => b.type === t).length;
    const villagers = this.myUnits('villager').length;
    const out = [];
    const wish = (type, anchor = null) => out.push({ type, anchor });

    // 0. No Town Center? Rebuilding it is everything, if we still have a builder.
    //    This list is returned on its own: nothing else may be built out of the
    //    money the Town Center is being saved for.
    const noTC = !buildings.some((b) => b.type === 'towncenter');
    if (noTC && villagers > 0) {
      // What matters here is not "have a drop-off" but "have a drop-off for the
      // resource the Town Center costs" — and a Town Center is 275 wood. With
      // only a Mill standing, every villager sent to the trees fills its pack,
      // finds nowhere to put it, and stands there: the AI can hold a thousand
      // food and still never rebuild, which is exactly what a decapitated base
      // did before the Lumber Camp existed.
      //
      // So: a Lumber Camp first, at 100 wood — a third of a Town Center, and the
      // only building that turns standing timber back into a bank balance. A
      // Mill second, so food can be banked and villagers replaced. Both are
      // strictly cheaper than the thing being saved for, so neither delays it.
      const takes = (res) =>
        buildings.some((b) => b.complete && b.dropoff && b.dropoff.includes(res));
      if (!takes(RES.WOOD) && anyOf('lumbercamp') === 0 && this.hasNodeFor(RES.WOOD)) {
        wish('lumbercamp', this.campAnchorFor(this.available.wood));
      }
      if (!takes(RES.FOOD) && anyOf('mill') === 0 && this.hasNodeFor(RES.FOOD)) {
        wish('mill', this.millAnchor());
      }
      wish('towncenter');
      return out;
    }

    // 1. Houses, always ahead of the cap. Getting housed is the classic stall.
    // The MAX_POP_CAP test no longer stops anything on its own — MAX_HOUSES does
    // — but it stays as the honest engine-level guard, so an AI that is ever
    // allowed to build past nine houses still stops at 200 instead of pouring
    // wood into houses that raise nothing.
    const housed = pop.cap >= MAX_POP_CAP;
    const roomy = !housed && anyOf('house') < MAX_HOUSES;
    if (roomy && pop.room <= this.houseBuffer(villagers)) wish('house');

    // 1b. Starving: the berries in reach are gone and the larder is nearly
    //     empty. A field beats a barracks we could not staff anyway.
    if (this.wantsFarm() && this.foodStarving()) wish('farm');

    // 2. Barracks, once the economy is on its feet.
    if (w.time >= BARRACKS_TIME && villagers >= 5 && anyOf('barracks') === 0) {
      wish('barracks');
    }

    // 3. Mill, if the berries are a real walk from the drop-off.
    if (complete('barracks') && anyOf('mill') === 0 && this.millWorthIt()) {
      wish('mill', this.millAnchor());
    }

    // 3a. Forward drop-offs. This sits ahead of farms because it is the cheaper
    //     fix for the same complaint: a farm converts wood into food, a camp
    //     converts a walk into everything. It is gated hard enough (see
    //     campWanted) that it can never take the wood a House or a field needs.
    const camp = this.campWanted();
    if (camp) wish(camp.type, camp.anchor);

    // 3b. Farms, from the moment the local berries thin out and for the rest of
    //     the match — a farm is consumed as fast as it is worked, so this is a
    //     standing order, not a one-off building.
    if (this.wantsFarm()) wish('farm');

    // 4. Second barracks to feed bigger waves.
    if (w.time >= BARRACKS2_TIME && anyOf('barracks') === 1 && villagers >= 12 &&
        p.resources.wood >= BUILDING_STATS.barracks.cost.wood + 80) {
      wish('barracks');
    }

    return out;
  }

  /** Population headroom below which the next House goes up. See HOUSE_BUFFER. */
  houseBuffer(villagers) {
    if (this.militaryPopReserve() > 0) return HOUSE_BUFFER_MILITARY;
    return villagers >= 8 ? HOUSE_BUFFER_BOOMING : HOUSE_BUFFER;
  }

  // --- farms ---------------------------------------------------------------

  /** Berries still standing inside comfortable working range of home. */
  berriesNearby(radius = FARM_SCAN) {
    let total = 0;
    for (const n of this.world.resources) {
      if (n.dead || n.resourceType !== RES.FOOD || n.amount <= 0) continue;
      if (dist(n.x, n.y, this.home.x, this.home.y) > radius) continue;
      total += n.amount;
    }
    return total;
  }

  /** Farms of ours that are standing — foundations included, they are coming. */
  myFarms() {
    return this.myBuildings('farm');
  }

  /** Food left in our finished farms. */
  farmStock() {
    let total = 0;
    for (const b of gatherableBuildings(this.world, this.id)) total += b.amount || 0;
    return total;
  }

  /** Do we have anywhere to bank food? A farm with no drop-off is wood binned. */
  hasFoodDropoff() {
    return this.myBuildings().some(
      (b) => b.complete && !b.dead && b.dropoff && b.dropoff.includes(RES.FOOD),
    );
  }

  /**
   * How many fields we want running right now.
   *
   * A villager pulls ~0.9 food/second including the walk, so one 300-food farm
   * is about five minutes of one villager. Keeping roughly three fields per four
   * food villagers means there is always one being worked and one being built,
   * which is what stops the AI hitting the same 4:00 cliff the player does.
   */
  farmTarget() {
    let onFood = 0;
    for (const j of this.jobs.values()) if (j.res === RES.FOOD) onFood++;
    const want = Math.ceil(Math.max(2, onFood) * 0.75);
    return Math.min(MAX_FARMS, want);
  }

  foodStarving() {
    const r = this.res();
    return (r.food || 0) < 120 && this.berriesNearby() < 200 && this.farmStock() < 100;
  }

  /** Should the next building be a field? */
  wantsFarm() {
    const r = this.res();
    if (this.myUnits('villager').length < FARM_MIN_VILLAGERS) return false;
    if (!this.hasFoodDropoff()) return false;
    if ((r.wood || 0) < BUILDING_STATS.farm.cost.wood + FARM_WOOD_RESERVE) return false;
    if (this.myFarms().length >= this.farmTarget()) return false;
    // Berries in reach are still worth walking to — no need to spend wood yet.
    if (this.berriesNearby() >= FARM_BERRY_FLOOR) return false;

    // Swimming in food *and* there is still a bush worth walking to: another
    // field would be wood better spent on units. Once the last local bush is
    // gone the stockpile stops being the question — without fields the food line
    // decays into 25-tile round trips, which is exactly the cliff we are here to
    // remove — so from then on we farm regardless of what is banked.
    const berry = this.nearestBerry();
    const walk = berry ? dist(berry.x, berry.y, this.home.x, this.home.y) : Infinity;
    if ((r.food || 0) > FARM_FOOD_CEILING && walk <= FARM_SCAN) return false;
    return true;
  }

  nearestBerry() {
    return findNearestGlobal(
      this.world, this.home.x, this.home.y, this.world.resources,
      (r) => r.resourceType === RES.FOOD && r.amount > 0,
    );
  }

  millWorthIt() {
    const berry = this.nearestBerry();
    if (!berry) return false;
    return dist(berry.x, berry.y, this.home.x, this.home.y) > MILL_MIN_WALK;
  }

  millAnchor() {
    const berry = this.nearestBerry();
    if (!berry) return this.home;
    // Sit the mill between the berries and home, favouring the berries.
    return {
      x: berry.x * 0.65 + this.home.x * 0.35,
      y: berry.y * 0.65 + this.home.y * 0.35,
    };
  }

  // --- forward drop-offs ---------------------------------------------------

  /**
   * How far a load taken from `node` has to be carried, given what we have
   * standing. Zero when we own nothing that will take it — that is the "no
   * drop-off at all" case, which is chooseBuilding's problem, not this one's.
   */
  haulFrom(node, resType) {
    let best = Infinity;
    for (const b of this.myBuildings()) {
      if (!b.complete || b.dead || !b.dropoff || !b.dropoff.includes(resType)) continue;
      const d = dist(b.x, b.y, node.x, node.y);
      if (d < best) best = d;
    }
    return best === Infinity ? 0 : best;
  }

  /**
   * The longest haul our own workforce is currently paying for `resType`.
   *
   * Deliberately measured from the nodes villagers are *actually assigned to*
   * rather than from the map: "there is a tree 20 tiles away" is not a problem,
   * "four of my villagers are walking to it" is. That also makes the camp land
   * where the work is, because the node that justified it is the anchor.
   */
  worstHaul(resType) {
    let worst = 0;
    let node = null;
    for (const j of this.jobs.values()) {
      if (j.res !== resType) continue;
      const n = this.world.entities.get(j.nodeId);
      if (!n || n.dead || !(n.amount > 0)) continue;
      const d = this.haulFrom(n, resType);
      if (d > worst) { worst = d; node = n; }
    }
    return { dist: worst, node };
  }

  /**
   * Should the next building be a forward drop-off, and beside what?
   * Returns { type, anchor } or null.
   */
  campWanted() {
    if (this.myUnits('villager').length < CAMP_MIN_VILLAGERS) return null;
    const cost = BUILDING_STATS.lumbercamp.cost.wood;
    if ((this.res().wood || 0) < cost + CAMP_WOOD_RESERVE) return null;

    const wood = this.worstHaul(RES.WOOD);
    if (wood.node && wood.dist >= CAMP_MIN_WALK &&
        this.myBuildings('lumbercamp').length < MAX_LUMBER_CAMPS) {
      return { type: 'lumbercamp', anchor: this.campAnchorFor(wood.node) };
    }
    // Gold and stone share the Mining Camp, so whichever line is walking further
    // is the one that justifies it — and the camp then shortens both.
    const gold = this.worstHaul(RES.GOLD);
    const stone = this.worstHaul(RES.STONE);
    const dig = stone.dist > gold.dist ? stone : gold;
    if (dig.node && dig.dist >= CAMP_MIN_WALK &&
        this.myBuildings('miningcamp').length < MAX_MINING_CAMPS) {
      return { type: 'miningcamp', anchor: this.campAnchorFor(dig.node) };
    }
    return null;
  }

  /**
   * Anchor a camp near the node it is for. findBuildSpot prefers ground 3.2 to
   * 11 tiles from its anchor (PLACEMENT_NEAR, which exists so the AI never
   * builds on top of itself), so anchoring exactly on the node would put
   * the camp anywhere in a ring around it. Pulling the anchor a quarter of the
   * way back toward home biases that ring onto the near side of the resource,
   * which is the side the villagers are walking from anyway.
   */
  campAnchorFor(node) {
    return {
      x: node.x * 0.75 + this.home.x * 0.25,
      y: node.y * 0.75 + this.home.y * 0.25,
    };
  }

  /**
   * Find ground for a building near `anchor`.
   *
   * The key rule: we require a one-tile clear margin all around the footprint
   * (by asking canPlace for a footprint two tiles larger). That single check
   * guarantees the AI can never wall itself in or seal its own Town Center —
   * every building it plants keeps a walkable corridor around it.
   *
   * The near band is swept *entire* — every one of its ~350 candidates — and
   * only then does the far band get a look. That completeness is the fix for the
   * defect described on PLACEMENT_NEAR: the old scan took 90 samples with a
   * fixed stride, which is about a quarter of the band, and a base with only
   * two or three legal 5x5 clearings in it failed to find any of them for a
   * hundred seconds at a stretch. Sweeping the lot costs ~350 canPlace calls,
   * which is a few tens of microseconds and happens at most twice per think.
   *
   * A clearing being *open* is not the same as it being *reachable*: a 5x5 hole
   * in the middle of the forest passes every canPlace test and then swallows the
   * build order, because the builders can never walk to it. So the handful of
   * candidates that survive the cheap tests are path-checked from home — that is
   * the expensive half, and it stays bounded — and anywhere a foundation has
   * already stalled is struck off for good.
   */
  findBuildSpot(type, anchor) {
    const s = BUILDING_STATS[type];
    if (!s) return null;
    // Deterministic rotating start point, shared by both bands so successive
    // buildings fan around the base instead of stacking on one side.
    this.placeCursor = (this.placeCursor + this.world.rng.int(1, 17)) % 4096;
    return this.scanBand(s, anchor, PLACEMENT_NEAR, MAX_REACH_CHECKS)
      || this.scanBand(s, anchor, PLACEMENT_FAR, FAR_REACH_CHECKS);
  }

  /** Sweep one placement band for ground `s` fits on. See findBuildSpot. */
  scanBand(s, anchor, band, reachBudget) {
    const w = this.world;
    const n = band.offsets.length;
    if (!n) return null;
    let checks = 0;
    let fallback = null;
    let i = this.placeCursor % n;
    for (let tried = 0; tried < n; tried++, i = (i + band.stride) % n) {
      const off = band.offsets[i];
      const gx = Math.round(anchor.x + off.dx);
      const gy = Math.round(anchor.y + off.dy);
      if (gx < 2 || gy < 2 || gx > w.width - 3 || gy > w.height - 3) continue;
      // Footprint itself must be clear...
      if (!canPlace(w, gx, gy, s.fw, s.fh)) continue;
      // ...and so must a one-tile ring around it, so we never self-wall.
      if (!canPlace(w, gx, gy, s.fw + 2, s.fh + 2)) continue;
      if (this.isBadSpot(gx, gy)) continue;
      if (checks >= reachBudget) {
        // Out of path budget: remember the first plausible site and stop.
        fallback = fallback || { gx, gy };
        break;
      }
      checks++;
      if (!this.reachableFromHome(gx, gy)) {
        fallback = fallback || { gx, gy };
        continue;
      }
      return { gx, gy };
    }
    return fallback;
  }

  isBadSpot(gx, gy) {
    for (const s of this.badSpots) if (dist(s.x, s.y, gx, gy) < 2.5) return true;
    return false;
  }

  /** Can a villager actually walk from the base to this site? */
  reachableFromHome(gx, gy) {
    try {
      const p = findPath(this.world, this.home.x, this.home.y, gx + 0.5, gy + 0.5, {
        smooth: false,
      });
      return !!(p && p.length && !p.partial);
    } catch {
      return true; // never let a pathfinder hiccup stop us building
    }
  }

  /** Put the right number of villagers on a foundation and keep them there. */
  staffConstruction(foundation) {
    if (!liveIn(this.world, foundation)) return;
    const heavy = foundation.type === 'barracks' || foundation.type === 'towncenter';
    const want = heavy ? 2 : 1;

    // Drop builders that died or wandered off the roster.
    for (const id of Array.from(this.builders)) {
      const e = this.world.entities.get(id);
      if (!e || e.dead || e.type !== 'villager') this.builders.delete(id);
    }

    const current = Array.from(this.builders)
      .map((id) => this.world.entities.get(id))
      .filter((u) => live(u));

    const order = {
      type: 'build',
      target: foundation,
      gx: foundation.x,
      gy: foundation.y,
    };

    if (current.length < want) {
      const pool = this.myUnits('villager')
        .filter((u) => !this.builders.has(u.id))
        .sort((a, b) =>
          dist(a.x, a.y, foundation.x, foundation.y) -
          dist(b.x, b.y, foundation.x, foundation.y));
      const recruits = pool.slice(0, want - current.length);
      for (const u of recruits) {
        this.builders.add(u.id);
        this.jobs.delete(u.id);
        current.push(u);
      }
      // A recruit is mid-gather, so it is *not* idle — it must be re-ordered
      // unconditionally or it will happily chop wood forever.
      if (recruits.length) this.command(recruits, order);
    }

    // Existing builders only get nudged once they fall idle; re-issuing every
    // pass would restart their build task and stall construction outright.
    const slack = current.filter((u) => this.idle(u));
    if (slack.length) this.command(slack, order);
  }

  releaseBuilders() {
    if (!this.builders.size) return;
    this.builders.clear(); // manageVillagers will hand them a resource next pass
  }

  // --- economy -------------------------------------------------------------

  /**
   * Desired villager split across food / wood / gold for the current phase.
   *
   * Three ways, not four. Stone is a real resource the AI can gather and bank,
   * but nothing it can build spends any — the castle, towers and stone walls
   * that need it belong to a later system. Putting villagers on it now would be
   * strictly worse than leaving them on wood, so it is left out of the split
   * entirely rather than given a zero weight that a scarcity nudge could later
   * push off zero by accident.
   */
  desiredSplit() {
    const w = this.world;
    const r = this.res();
    const hasBarracks = this.myBuildings('barracks').length > 0;
    const wantsMilitary = hasBarracks || (this.pending && this.pending.type === 'barracks');

    let food;
    let wood;
    let gold;
    if (wantsMilitary) {
      food = 0.42; wood = 0.28; gold = 0.30;
    } else if (w.time >= 80) {
      food = 0.46; wood = 0.39; gold = 0.15;   // start banking gold pre-barracks
    } else {
      food = 0.58; wood = 0.42; gold = 0.0;    // food-heavy opening
    }

    // Scarcity nudges — react when a stockpile is about to block us.
    const shift = (from, to, amt) => {
      const take = Math.min(from.v, amt);
      from.v -= take;
      to.v += take;
    };
    const F = { v: food };
    const W = { v: wood };
    const G = { v: gold };
    if (r.wood < 60) shift(F, W, 0.12);
    if (r.food < 60) shift(W, F, 0.12);
    if (wantsMilitary && r.gold < 60) shift(F, G, 0.10);
    if (r.gold > 400) shift(G, F, 0.15);
    if (r.wood > 500) shift(W, F, 0.10);

    return { food: F.v, wood: W.v, gold: G.v };
  }

  /**
   * Refresh, once per think, which resources we can actually reach.
   *
   * This has to agree with pickNode's radius: "there is gold somewhere on the
   * map" is useless if it is a 40-tile walk, and treating it as available made
   * the whole workforce fall through to wood.
   */
  refreshAvailability() {
    this.available = {
      food: this.pickNode(RES.FOOD, this.home.x, this.home.y),
      wood: this.pickNode(RES.WOOD, this.home.x, this.home.y),
      gold: this.pickNode(RES.GOLD, this.home.x, this.home.y),
    };
  }

  hasNodeFor(resType) {
    return !!(this.available && this.available[resType]);
  }

  /**
   * Best node of `resType` for a villager at (x,y): near, and not crowded.
   * Our own finished farms count as food nodes and are scored the same way, so
   * a field beside the Town Center naturally beats a bush across the map.
   */
  pickNode(resType, x, y) {
    const w = this.world;
    let best = null;
    let bestScore = Infinity;
    const consider = (n) => {
      if (n.dead || n.resourceType !== resType || !(n.amount > 0)) return;
      const d = dist(n.x, n.y, x, y);
      if (d > 30) return;
      // Spread out: each villager already on a node costs it 1.2 tiles of appeal.
      const score = d + (n.workers || 0) * 1.2 + (this.claimCount(n.id) * 1.2);
      if (score < bestScore) {
        bestScore = score;
        best = n;
      }
    };
    for (const n of w.resources) consider(n);
    if (resType === RES.FOOD) {
      for (const b of w.buildings) {
        if (b.player !== this.id || !isGatherableBuilding(b)) continue;
        consider(b);
      }
    }
    return best;
  }

  claimCount(nodeId) {
    let c = 0;
    for (const j of this.jobs.values()) if (j.nodeId === nodeId) c++;
    return c;
  }

  idle(u) {
    if (!live(u)) return false;
    // A unit with an order still in the queue is not idle, it is a unit whose
    // order has not been handed over yet. Without this every pass that asks
    // "who has nothing to do" would re-order the whole backlog, and the queue
    // would churn instead of draining.
    if (this.orderPending.has(u.id)) return false;
    try {
      return !!isIdle(u);
    } catch {
      return u.state === 'idle' && !u.task;
    }
  }

  /**
   * Ask for an order. It goes out within a step or three — see ORDERS_PER_STEP.
   *
   * Every order this AI gives comes through here, which is what makes one budget
   * enough to cover all of them.
   */
  command(units, order) {
    if (!units || !units.length || !order) return;
    const list = units.filter((u) => live(u));
    if (!list.length) return;
    // A unit given a new order drops out of whatever it was still waiting on:
    // the latest instruction is the one that meant something, and issuing a
    // superseded one first would make the unit visibly change its mind.
    for (const u of list) this.dropPending(u.id);
    const entry = { ids: list.map((u) => u.id), order };
    this.orderQueue.push(entry);
    for (const id of entry.ids) this.orderPending.set(id, entry);
  }

  /**
   * Is this unit already holding an order we have not handed over yet?
   *
   * Anything that re-issues the *same* standing order every think — the
   * defensive recall, the evacuation — has to ask this, not just `idle`. Every
   * fresh order supersedes the pending one and goes to the *back* of the queue,
   * so a pass that re-orders forty units every half second would push the last
   * of them backwards forever and they would never move at all.
   */
  awaitingOrder(u) {
    return !!u && this.orderPending.has(u.id);
  }

  dropPending(id) {
    const entry = this.orderPending.get(id);
    if (!entry) return;
    this.orderPending.delete(id);
    const i = entry.ids.indexOf(id);
    if (i >= 0) entry.ids.splice(i, 1);
  }

  /**
   * Hand at most ORDERS_PER_STEP units their orders. Called once per sim step.
   *
   * Units are taken off the front of the oldest entry, so a group order is
   * issued in the order the group was listed and a later order never overtakes
   * an earlier one. Splitting a group across steps is exact for the verbs the AI
   * actually gives in bulk — attack, gather, build and garrison are all
   * per-unit loops inside unitAI — and for the one verb where it is not (`move`
   * assigns formation slots across whichever units it is handed), the AI's group
   * moves are short walks to a staging point a few tiles away, where a slot is a
   * couple of feet either way.
   */
  dispatchOrders() {
    let budget = ORDERS_PER_STEP;
    while (budget > 0 && this.orderQueue.length) {
      const entry = this.orderQueue[0];
      const batch = [];
      while (batch.length < budget && entry.ids.length) {
        const id = entry.ids.shift();
        this.orderPending.delete(id);
        const u = this.world.entities.get(id);
        // A unit that died while it waited costs nothing and is simply dropped.
        if (live(u)) batch.push(u);
      }
      if (!entry.ids.length) this.orderQueue.shift();
      if (!batch.length) continue;
      budget -= batch.length;
      try {
        commandUnits(this.world, batch, entry.order);
      } catch {
        /* a system still under construction must not take the match down */
      }
    }
  }

  assign(v, resType) {
    const node = this.pickNode(resType, v.x, v.y);
    if (!node) return false;
    this.jobs.set(v.id, { res: resType, nodeId: node.id });
    this.command([v], {
      type: 'gather',
      target: node,
      gx: node.x,
      gy: node.y,
      resource: resType,
    });
    return true;
  }

  manageVillagers(doRebalance) {
    const w = this.world;
    // A garrisoned villager is not on the map: it cannot be given a job, and
    // handing it one would leave a phantom worker booked onto a bush nobody is
    // standing at, which is how the rebalance starves a real resource.
    const villagers = this.myUnits('villager').filter((v) => !isGarrisoned(v));
    if (!villagers.length) {
      this.jobs.clear();
      return;
    }

    // Villagers flee to the Town Center while the base is being raided.
    if (this.defending && this.threat) {
      this.evacuate(villagers);
      return;
    }

    // Forget jobs for villagers that are gone.
    for (const id of Array.from(this.jobs.keys())) {
      const e = w.entities.get(id);
      if (!e || e.dead) this.jobs.delete(id);
    }

    const free = villagers.filter((v) => !this.builders.has(v.id));

    // 1. Anyone unemployed, idle, or working a dead/dry node gets a new job.
    for (const v of free) {
      const job = this.jobs.get(v.id);
      const node = job ? w.entities.get(job.nodeId) : null;
      const nodeGone = !node || node.dead || node.amount <= 0;
      if (!job || nodeGone || this.idle(v)) {
        let res = job ? job.res : null;
        if (res && !this.hasNodeFor(res)) res = null;
        if (!res) res = this.neediestResource(free);
        if (!this.assign(v, res)) {
          // That node vanished between the scan and the order. Fall back down
          // the priority list rather than to a fixed one — defaulting to wood
          // is how an AI ends up with 5000 wood and no gold.
          for (const alt of this.byNeed(free)) {
            if (alt !== res && this.assign(v, alt)) break;
          }
        }
      }
    }

    if (!doRebalance) return;

    // 2. Slow rebalance toward the phase split — at most two swaps per pass so
    //    the workforce drifts rather than thrashing.
    const split = this.desiredSplit();
    const counts = { food: 0, wood: 0, gold: 0 };
    for (const v of free) {
      const j = this.jobs.get(v.id);
      if (j && counts[j.res] !== undefined) counts[j.res]++;
    }
    const n = free.length;
    const want = {
      food: Math.round(split.food * n),
      wood: Math.round(split.wood * n),
      gold: Math.round(split.gold * n),
    };
    // Never leave food entirely unmanned, and never send anyone to a resource
    // that has no nodes left on the map.
    for (const k of ['food', 'wood', 'gold']) if (!this.hasNodeFor(k)) want[k] = 0;
    if (want.food === 0 && this.hasNodeFor(RES.FOOD)) want.food = 1;

    let swaps = 0;
    for (let attempt = 0; attempt < 6 && swaps < 2; attempt++) {
      let over = null;
      let under = null;
      for (const k of ['food', 'wood', 'gold']) {
        if (counts[k] - want[k] >= 1 &&
            (!over || counts[k] - want[k] > counts[over] - want[over])) over = k;
        if (want[k] - counts[k] >= 1 &&
            (!under || want[k] - counts[k] > want[under] - counts[under])) under = k;
      }
      if (!over || !under) break;

      const target = this.pickNode(under, this.home.x, this.home.y);
      if (!target) {
        // Cannot staff that resource after all — drop its quota and consider
        // the next-neediest instead of abandoning the whole rebalance.
        want[under] = 0;
        continue;
      }
      const movers = free
        .filter((v) => {
          const j = this.jobs.get(v.id);
          return j && j.res === over;
        })
        .sort((a, b) =>
          dist(a.x, a.y, target.x, target.y) - dist(b.x, b.y, target.x, target.y));
      if (!movers.length) {
        want[under] = counts[under];
        continue;
      }
      if (!this.assign(movers[0], under)) {
        want[under] = 0;
        continue;
      }
      counts[over]--;
      counts[under]++;
      swaps++;
    }
  }

  /** Resources we can reach, neediest first. */
  byNeed(free) {
    const split = this.desiredSplit();
    const counts = { food: 0, wood: 0, gold: 0 };
    for (const v of free) {
      const j = this.jobs.get(v.id);
      if (j && counts[j.res] !== undefined) counts[j.res]++;
    }
    const n = Math.max(1, free.length);
    return ['food', 'wood', 'gold']
      .filter((k) => this.hasNodeFor(k))
      .sort((a, b) => (split[b] * n - counts[b]) - (split[a] * n - counts[a]));
  }

  neediestResource(free) {
    return this.byNeed(free)[0] || RES.WOOD;
  }

  /**
   * The town is being raided: get the villagers off the field.
   *
   * Running them to the Town Center — which is what this used to do — is only
   * half of what AoE2 players actually do, and it is the half that does not
   * work: a villager standing *beside* a Town Center is still a villager a
   * scout can kill, and a crowd of them milling on the doorstep is the single
   * easiest thing in the game to farm. AoE2's answer is the bell: everybody
   * inside, where they are untouchable, healing, and — because a garrisoned
   * body is an extra arrow (see combat.js) — where they turn the Town Center
   * into the thing that kills the raider.
   *
   * A villager already inside stays inside; ungarrisonWhenClear() lets them out
   * again the moment the raid has been quiet for GARRISON_HOLD seconds, which
   * is the other half of getting this right. An AI that garrisons and forgets
   * has simply deleted its own economy.
   */
  evacuate(villagers) {
    const safe = this.home;
    const shelters = this.myBuildings().filter(
      (b) => b.complete && !b.dead && garrisonCapacity(b) > garrisonCount(b),
    );
    this.garrisonUntil = this.world.time + GARRISON_HOLD;

    for (const v of villagers) {
      if (isGarrisoned(v) || this.awaitingOrder(v)) continue;
      // Only re-order villagers actually near the fighting.
      if (this.threat && dist(v.x, v.y, this.threat.x, this.threat.y) > DEFEND_RADIUS) continue;

      // Close enough to the shelter to reach it before the raider reaches them.
      const shelter = shelters.length
        ? shelters.reduce((a, b) =>
          (dist(b.x, b.y, v.x, v.y) < dist(a.x, a.y, v.x, v.y) ? b : a))
        : null;
      if (shelter && dist(v.x, v.y, shelter.x, shelter.y) <= GARRISON_PANIC_RADIUS) {
        this.jobs.delete(v.id);
        this.command([v], { type: 'garrison', target: shelter });
        continue;
      }
      // Too far to shelter, or nowhere with room left: the old behaviour, which
      // is still the right one for a villager out at the far gold.
      if (dist(v.x, v.y, safe.x, safe.y) < 3) continue;
      this.jobs.delete(v.id);
      this.command([v], { type: 'move', gx: safe.x, gy: safe.y });
    }
  }

  /**
   * Ring the all-clear. Called every think, not only while defending, because
   * the state that has to end is "villagers are inside" — and that outlives the
   * raid that caused it by exactly GARRISON_HOLD seconds.
   */
  ungarrisonWhenClear() {
    if (!this.garrisonUntil) return;
    if (this.defending || this.world.time < this.garrisonUntil) return;
    this.garrisonUntil = 0;
    for (const b of this.myBuildings()) {
      if (garrisonCount(b) > 0) ungarrisonAll(this.world, b);
    }
  }

  // --- training ------------------------------------------------------------

  /**
   * Food we could plausibly walk to: berries in the ground plus whatever is
   * still standing in our own fields.
   */
  foodInGround() {
    let total = 0;
    for (const n of this.world.resources) {
      if (n.dead || n.resourceType !== RES.FOOD || n.amount <= 0) continue;
      if (dist(n.x, n.y, this.home.x, this.home.y) > FOOD_SCAN) continue;
      total += n.amount;
    }
    return total + this.farmStock();
  }

  /**
   * Food we could *make*: banked wood, at 60 wood to a 300-food field. Only
   * counted while we still have somewhere to bank the harvest.
   */
  farmPotential() {
    if (!this.hasFoodDropoff()) return 0;
    const s = BUILDING_STATS.farm;
    const spare = Math.max(0, (this.res().wood || 0) - FARM_WOOD_RESERVE);
    return Math.floor(spare / s.cost.wood) * s.provides.amount;
  }

  /**
   * How many villagers this economy can actually support.
   *
   * Before farms existed this shrank as the berries ran out, because they were
   * the only food on the map. They are not: a field turns 60 wood into 300 food,
   * so as long as there is wood banked and a drop-off standing the workforce
   * keeps growing. The throttle only bites when food *and* wood are both gone.
   */
  villagerTarget() {
    const r = this.res();
    const hasBarracks = this.myBuildings('barracks').some((b) => b.complete);
    if (!hasBarracks) return PRE_BARRACKS_VILLAGERS;
    const budget = (r.food || 0) + this.foodInGround() + this.farmPotential();
    if (budget < 200) return 8;
    if (budget < 450) return 11;
    return MAX_VILLAGERS;
  }

  /** Every completed building of ours that can put a soldier on the map. */
  militaryTrainers() {
    return this.myBuildings().filter(
      (b) => b.complete && !b.dead && (b.trains || []).some((t) => MILITARY_TYPES.includes(t)),
    );
  }

  /** Soldiers the next wave wants, standing plus queued. */
  armyTarget() {
    const needed = Math.min(
      MAX_WAVE_SIZE,
      FIRST_WAVE_SIZE + this.waveNumber * WAVE_SIZE_STEP,
    );
    // Plus a couple, so the AI is still training while a wave is out rather than
    // starting from nothing every time one leaves.
    return needed + 2;
  }

  /**
   * Population the Town Center is not allowed to take. See the note on
   * MILITARY_POP_PER_TRAINER.
   *
   * Charged only while there is somewhere to train soldiers *and* the army is
   * short of what the next wave wants. A reserve held open past that point is
   * just an idle Town Center, and an AI that has its sixteen soldiers should be
   * making villagers again.
   */
  militaryPopReserve() {
    const trainers = this.militaryTrainers().length;
    if (!trainers) return 0;
    const census = this.armyCensus();
    let army = 0;
    for (const t of MILITARY_TYPES) army += census[t] || 0;
    if (army >= this.armyTarget()) return 0;
    return Math.min(MAX_MILITARY_POP_RESERVE, trainers * MILITARY_POP_PER_TRAINER);
  }

  manageTraining() {
    const pop = this.popState();
    const r = this.res();
    const villagers = this.myUnits('villager').length;
    const villTarget = this.villagerTarget();

    // Town Center: villagers, non-stop, while pop and food allow — but never
    // into the last few slots once soldiers are competing for the same cap.
    const reserve = this.militaryPopReserve();
    const tc = this.townCenter();
    if (tc && tc.complete && !tc.dead) {
      const queued = tc.queue ? tc.queue.length : 0;
      if (pop.room > reserve && queued < 2 && villagers + queued < villTarget &&
          this.afford(UNIT_STATS.villager.cost)) {
        this.train(tc, 'villager');
      }
    }

    // Military buildings: whatever the counter maths says, at whichever of them
    // can make it. The list is every building we own that trains a soldier, so
    // an Archery Range or a Stable landing from another pass is picked up with
    // no edit — see militaryTrainers().
    const barracks = this.militaryTrainers();
    if (!barracks.length) return;

    const have = this.armyCensus();
    for (const b of barracks) {
      const state = this.popState();
      if (state.room <= 0) break;
      if ((b.queue ? b.queue.length : 0) >= 2) continue;

      const type = this.chooseUnit(b, have, r, villagers < villTarget);
      if (!type) continue;
      if (this.train(b, type)) have[type] = (have[type] || 0) + 1;
    }
  }

  /** Everything we have or have queued, by type. The AI's own order of battle. */
  armyCensus() {
    const out = {};
    for (const t of MILITARY_TYPES) out[t] = 0;
    for (const u of this.myUnits()) {
      if (isMilitary(u)) out[u.type] = (out[u.type] || 0) + 1;
    }
    for (const b of this.myBuildings()) {
      for (const q of b.queue || []) {
        if (q && out[q.type] !== undefined) out[q.type]++;
      }
    }
    return out;
  }

  /**
   * What the *player* has on the field, by armour class, as far as we know.
   *
   * "As far as we know" is doing real work here: the AI reads the world
   * directly, so this is still perfect information (HANDOFF-vision.md item 2
   * remains open). What it is not is *stale* — the mix is recomputed every time
   * a unit is queued, so a player who switches to knights is answered within a
   * couple of production cycles rather than at the next wave.
   */
  foeArmorMix() {
    const mix = {};
    let total = 0;
    for (const u of ownedBy(this.world, this.foeId, 'unit')) {
      if (!isMilitary(u) || isGarrisoned(u)) continue;
      const cls = armorClassOf(u);
      mix[cls] = (mix[cls] || 0) + 1;
      total++;
    }
    return { mix, total };
  }

  /**
   * Score a unit type against what the enemy is fielding.
   *
   * The score is the average bonus damage this type would land across the
   * enemy's actual army, normalised — so a spearman scores highly against a
   * cavalry mass and zero against archers, which is precisely the judgement the
   * bonus table already encodes. Nothing is hardcoded about which unit counters
   * which; adding a unit to BONUS_DAMAGE is all it takes to be reasoned about.
   */
  counterScore(type, foe) {
    if (!foe.total) return 0;
    const table = BONUS_DAMAGE[type];
    if (!table) return 0;
    let sum = 0;
    for (const cls of Object.keys(foe.mix)) sum += (table[cls] || 0) * foe.mix[cls];
    return sum / foe.total;
  }

  /**
   * The next soldier out of this building.
   *
   * Three filters, in the order they matter:
   *   1. it has to be something this building trains and we can pay for;
   *   2. no type may pass MIX_CEILING of the army — the guard against building
   *      a perfect counter to one thing and losing to everything else;
   *   3. among what is left, the best answer to what the player has, with the
   *      default opening mix as the tiebreaker so a blind AI (which, with fog,
   *      is the normal early state) still builds a sensible spread.
   */
  chooseUnit(building, have, r, wantMoreVillagers) {
    const foe = this.foeArmorMix();
    const total = Object.values(have).reduce((a, b) => a + b, 0);
    // When food dries up the mix has to drift toward whatever does not eat —
    // the archer is the only soldier that costs no food at all.
    const foodTight = (r.food || 0) < 120 && this.foodInGround() < 150;

    let best = null;
    let bestScore = -Infinity;
    for (const type of building.trains || []) {
      if (!MILITARY_TYPES.includes(type)) continue;
      const cost = UNIT_STATS[type] && UNIT_STATS[type].cost;
      if (!cost) continue;
      if (!this.affordUnit(type, r)) continue;
      // Never spend the food the Town Center is queued on while we are still
      // growing the economy that pays for all of this.
      if (wantMoreVillagers && (cost.food || 0) > 0 &&
          r.food < (cost.food || 0) + UNIT_STATS.villager.cost.food) continue;
      if (foodTight && (cost.food || 0) > 0) continue;
      // The same rule for the other resource a soldier can drink. See
      // MILITARY_WOOD_RESERVE: an army is worth nothing if it costs the base
      // the House it was about to build, or the ability to stand back up.
      if ((cost.wood || 0) > 0 && r.wood < (cost.wood || 0) + this.woodReserve()) continue;
      // The ceiling. Only bites once there is an army to be lopsided about.
      if (total >= 4 && (have[type] || 0) / total >= MIX_CEILING) continue;

      const score = (DEFAULT_MIX[type] || 0.1)
        + COUNTER_WEIGHT * this.counterScore(type, foe)
        // Spread: a type we already have plenty of is worth a little less, which
        // is what keeps the mix a mix on a map where we have seen no enemy.
        - (total > 0 ? (have[type] || 0) / total : 0);
      if (score > bestScore) {
        bestScore = score;
        best = type;
      }
    }
    // Everything was priced out by the food guard — take whatever we can pay
    // for rather than leaving the building idle, which is how an AI ends up
    // with 900 wood and no army.
    if (!best) {
      for (const type of building.trains || []) {
        if (!MILITARY_TYPES.includes(type)) continue;
        if (!this.affordUnit(type, r)) continue;
        const cost = UNIT_STATS[type].cost;
        if (foodTight && (cost.food || 0) > 0) continue;
        if ((cost.wood || 0) > 0 && r.wood < (cost.wood || 0) + this.woodReserve()) continue;
        return type;
      }
    }
    return best;
  }

  /**
   * Wood that must survive whatever we are about to buy.
   *
   * Larger while the Town Center is the only thing that can bank a load of
   * timber, because losing it in that state is unrecoverable rather than merely
   * expensive — see REBUILD_WOOD_FLOAT.
   */
  woodReserve() {
    const banked = this.myBuildings().some(
      (b) => b.complete && !b.dead && b.type !== 'towncenter' &&
        b.dropoff && b.dropoff.includes(RES.WOOD),
    );
    return banked ? MILITARY_WOOD_RESERVE : Math.max(MILITARY_WOOD_RESERVE, REBUILD_WOOD_FLOAT);
  }

  // --- tech ----------------------------------------------------------------

  /**
   * Can we pay for this and still have a working float left over?
   *
   * Plain affordability is the wrong test for an upgrade. Bow Saw at exactly
   * 150 food and 100 wood leaves the AI with nothing, and the next thing that
   * happens is a Town Center with an empty queue and a house it cannot start —
   * an upgrade that stalls production for forty seconds has cost more than it
   * gave. `reserve` is what has to survive the purchase.
   */
  affordWithReserve(cost, reserve) {
    const r = this.res();
    for (const k of ['food', 'wood', 'gold', 'stone']) {
      const need = (cost && cost[k]) || 0;
      if (!need) continue;
      if ((r[k] || 0) < need + ((reserve && reserve[k]) || 0)) return false;
    }
    return this.afford(cost);
  }

  /** Queue a research, counting it. Never throws out of the think pass. */
  research(building, techId) {
    if (!liveIn(this.world, building) || !building.complete) return false;
    let ok = false;
    try {
      ok = queueResearch(this.world, building, techId) !== false;
    } catch {
      return false;
    }
    if (!ok) return false;
    this.stats.techsResearched++;
    const t = TECHS[techId];
    if (t && t.advancesTo !== undefined) {
      this.stats.ageUps.push({ t: Math.round(this.world.time), age: t.advancesTo });
    }
    return true;
  }

  /** Is anyone on our books actually assigned to this resource right now? */
  workingOn(resType) {
    for (const j of this.jobs.values()) if (j.res === resType) return true;
    return false;
  }

  /** A completed building of `type` with nothing in its research slot. */
  freeResearcher(type) {
    for (const b of this.myBuildings(type)) {
      if (!b.complete || b.dead) continue;
      if ((b.research || []).length === 0) return b;
    }
    return null;
  }

  /**
   * The first tech at `building` that is legal, wanted, and leaves a float.
   * TECHS is declared in the order a player would buy it — Feudal tier before
   * Castle tier, and prerequisites before what they unlock — so first-legal is
   * also the sensible order, with no priority table to keep in sync.
   */
  nextTechAt(building, reserve) {
    for (const id of techsAt(building.type)) {
      const t = TECHS[id];
      if (!t || t.advancesTo !== undefined) continue;   // ages are handled above
      if (hasTech(this.world, this.id, id)) continue;
      if (researchRefusal(this.world, this.id, id, building, { skipCost: true })) continue;
      // A gathering upgrade on a resource nobody is working is just a bill.
      // This AI runs a three-way food/wood/gold split and never posts anyone on
      // stone (see res()), so Stone Mining would be 100 food and 75 wood spent
      // on a rate that multiplies zero. The test is against the live job board
      // rather than a hardcoded exclusion, so the day the split grows a fourth
      // leg the upgrade starts being bought by itself.
      if (t.gather && !Object.keys(t.gather).some((k) => this.workingOn(k))) continue;
      if (!this.affordWithReserve(t.cost, reserve)) continue;
      return id;
    }
    return null;
  }

  /**
   * Age up on a schedule, then shop the upgrades. One purchase per pass: the
   * reserve test is evaluated against the stockpile as it is *now*, and firing
   * three researches in the same think would spend the same food three times
   * over as far as that test is concerned.
   */
  manageTech() {
    const w = this.world;

    // 1. The age. It gates everything else, so it goes first and it is the one
    //    purchase allowed to be expensive.
    const ageId = nextAgeTech(w, this.id);
    if (ageId) {
      const t = TECHS[ageId];
      const tc = this.freeResearcher('towncenter');
      const due = t.advancesTo === AGE.FEUDAL ? FEUDAL_AGE_TIME : CASTLE_AGE_TIME;
      const need = t.advancesTo === AGE.FEUDAL ? AGE_UP_VILLAGERS : AGE_UP_VILLAGERS_CASTLE;
      if (tc && w.time >= due && this.myUnits('villager').length >= need &&
          this.affordWithReserve(t.cost, AGE_UP_RESERVE)) {
        if (this.research(tc, ageId)) return;
      }
    }

    // 2. Economy upgrades, at whichever drop-off is free.
    for (const type of ECO_RESEARCH_BUILDINGS) {
      const b = this.freeResearcher(type);
      if (!b) continue;
      const id = this.nextTechAt(b, TECH_RESERVE);
      if (id && this.research(b, id)) return;
    }

    // 3. Blacksmith line, once there is an army worth improving. Behind the
    //    economy on purpose: +1 attack on four militia is worth less than the
    //    wood that pays for the next eight.
    const army = this.myUnits().filter(isMilitary).length;
    if (army < MILITARY_TECH_MIN_ARMY) return;
    for (const type of MILITARY_RESEARCH_BUILDINGS) {
      const b = this.freeResearcher(type);
      if (!b) continue;
      const id = this.nextTechAt(b, TECH_RESERVE);
      if (id && this.research(b, id)) return;
    }
  }

  affordUnit(type, r) {
    const c = UNIT_STATS[type] && UNIT_STATS[type].cost;
    if (!c) return false;
    if (!this.afford(c)) return false;
    // Belt-and-braces in case economy's canAfford is not yet strict.
    return (r.food || 0) >= (c.food || 0) && (r.wood || 0) >= (c.wood || 0) &&
           (r.gold || 0) >= (c.gold || 0);
  }

  train(building, type) {
    if (!liveIn(this.world, building) || !building.complete) return false;
    try {
      const ok = queueTrain(this.world, building, type);
      if (ok === false) return false;
    } catch {
      return false;
    }
    if (type === 'villager') this.stats.villagersQueued++;
    else this.stats.militaryQueued++;
    return true;
  }

  // --- threat / defence ----------------------------------------------------

  assessThreat() {
    const w = this.world;
    let count = 0;
    let sx = 0;
    let sy = 0;
    forEachNear(w, this.home.x, this.home.y, DEFEND_RADIUS, (e) => {
      if (e.kind !== 'unit' || e.player !== this.foeId) return;
      count++;
      sx += e.x;
      sy += e.y;
    });

    const recentlyHurt = w.time - this.lastDamageTime < 6;
    if (count > 0 && (count >= 2 || recentlyHurt)) {
      this.defendingUntil = w.time + DEFEND_CLEAR_TIME;
      this.threat = { x: sx / count, y: sy / count, count };
    } else if (count > 0 && this.defending) {
      this.threat = { x: sx / count, y: sy / count, count };
    } else if (w.time > this.defendingUntil) {
      this.threat = null;
    }
    this.defending = w.time <= this.defendingUntil;
  }

  // --- army & waves --------------------------------------------------------

  manageArmy() {
    const w = this.world;
    // Soldiers sheltering inside a tower are still ours and still count for
    // population, but they are not on the field and cannot be waved anywhere.
    const army = this.myUnits().filter((u) => isMilitary(u) && !isGarrisoned(u));

    if (this.defending) {
      // Everything comes home, including whatever is mid-attack.
      const point = this.threat || this.home;
      const rally = army.filter((u) => !this.awaitingOrder(u) &&
        (this.idle(u) || dist(u.x, u.y, point.x, point.y) > 16));
      if (rally.length) {
        this.command(rally, { type: 'attack', gx: point.x, gy: point.y, target: this.nearestFoeNear(point) });
      }
      if (this.wave) {
        this.wave = null;
        this.nextWaveTime = Math.max(this.nextWaveTime, w.time + 45);
      }
      return;
    }

    const inWave = new Set(this.wave ? this.wave.ids : []);
    const reserves = army.filter((u) => !inWave.has(u.id));

    // Fresh soldiers gather at the staging point instead of trickling out.
    const s = this.staging || this.home;
    const strays = reserves.filter(
      (u) => this.idle(u) && dist(u.x, u.y, s.x, s.y) > 3.0,
    );
    if (strays.length) this.command(strays, { type: 'move', gx: s.x, gy: s.y });

    // Keep the barracks rally on the staging point too, for whatever honours it.
    for (const b of this.myBuildings('barracks')) {
      if (!b.rally || dist(b.rally.x || b.rally.gx || 0, b.rally.y || b.rally.gy || 0, s.x, s.y) > 2) {
        b.rally = { x: s.x, y: s.y, gx: s.x, gy: s.y };
      }
    }

    if (this.wave) {
      this.driveWave();
      return;
    }

    // Launch conditions: it is time, and we have a real squad — never dribs.
    const needed = Math.min(
      MAX_WAVE_SIZE,
      FIRST_WAVE_SIZE + this.waveNumber * WAVE_SIZE_STEP,
    );
    const readyAt = reserves.filter((u) => dist(u.x, u.y, s.x, s.y) <= 9);
    if (w.time >= this.nextWaveTime && readyAt.length >= needed) {
      this.launchWave(readyAt.slice(0, Math.max(needed, Math.min(readyAt.length, MAX_WAVE_SIZE))));
    }
  }

  nearestFoeNear(point) {
    return findNearestGlobal(
      this.world, point.x, point.y,
      ownedBy(this.world, this.foeId, 'unit'),
      () => true,
    );
  }

  /**
   * Pick where the wave goes. Villagers and buildings both count; whatever is
   * furthest from the defender's standing army wins, so the group naturally
   * walks into the soft edge of the base rather than the front door.
   */
  chooseWaveTarget(from) {
    const w = this.world;
    const foeUnits = ownedBy(w, this.foeId, 'unit');
    const foeBuildings = ownedBy(w, this.foeId, 'building');

    // Defender centroid, from their soldiers only.
    let dx = 0;
    let dy = 0;
    let dn = 0;
    for (const u of foeUnits) {
      if (!MILITARY_TYPES.includes(u.type)) continue;
      dx += u.x;
      dy += u.y;
      dn++;
    }
    const guard = dn ? { x: dx / dn, y: dy / dn } : null;

    const candidates = [];
    for (const u of foeUnits) if (u.type === 'villager') candidates.push({ e: u, bonus: 1.5 });
    for (const b of foeBuildings) {
      const bonus = b.type === 'towncenter' ? 0.5 : b.trains && b.trains.length ? 1.2 : 0.8;
      candidates.push({ e: b, bonus });
    }
    if (!candidates.length) return null;

    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const approach = dist(from.x, from.y, c.e.x, c.e.y);
      const exposure = guard ? dist(c.e.x, c.e.y, guard.x, guard.y) : 10;
      // Close to us, far from their army, and juicy.
      const score = c.bonus * 6 + Math.min(exposure, 16) * 0.9 - approach * 0.35;
      if (score > bestScore) {
        bestScore = score;
        best = c.e;
      }
    }
    return best;
  }

  launchWave(units) {
    const w = this.world;
    if (!units.length) return;
    const from = units.reduce(
      (a, u) => ({ x: a.x + u.x / units.length, y: a.y + u.y / units.length }),
      { x: 0, y: 0 },
    );
    const target = this.chooseWaveTarget(from);
    if (!target) {
      // Nothing left to hit; try again shortly.
      this.nextWaveTime = w.time + 20;
      return;
    }

    this.wave = {
      ids: units.map((u) => u.id),
      target,
      launchedAt: w.time,
      lastOrder: w.time,
      size: units.length,
    };
    this.waveNumber++;
    this.stats.wavesLaunched++;
    this.stats.lastWaveSize = units.length;
    let mel = 0;
    for (const u of units) if (u.type === 'militia') mel++;
    this.stats.waveLog.push({
      t: Math.round(w.time), size: units.length,
      militia: mel, archers: units.length - mel,
      // True when the previous wave died out there, so this one waited for a
      // full rebuild rather than keeping the normal beat.
      afterLoss: this.lostLastWave,
    });
    this.lostLastWave = false;
    // Schedule the next beat from this launch, so the cadence is steady.
    this.nextWaveTime = w.time + this.waveInterval();
    this.command(units, { type: 'attack', target, gx: target.x, gy: target.y });
  }

  driveWave() {
    const w = this.world;
    const wave = this.wave;
    const alive = wave.ids
      .map((id) => w.entities.get(id))
      .filter((u) => isMilitary(u));
    wave.ids = alive.map((u) => u.id);

    if (!alive.length) {
      // Wiped. Back to building economy and army before trying again, harder.
      this.wave = null;
      this.stats.wavesWiped++;
      this.lostLastWave = true;
      this.nextWaveTime = w.time + WAVE_REGROUP_AFTER_LOSS;
      return;
    }

    // Bled out — pull the survivors home rather than feeding them in.
    if (alive.length <= Math.max(1, Math.floor(wave.size * 0.3)) && wave.size >= 4) {
      const s = this.staging || this.home;
      this.command(alive, { type: 'move', gx: s.x, gy: s.y });
      this.wave = null;
      this.lostLastWave = true;
      this.nextWaveTime = w.time + WAVE_REGROUP_AFTER_LOSS;
      return;
    }

    if (w.time - wave.launchedAt > WAVE_TIMEOUT) {
      // Grinding without result — come home. The next wave stays on the beat
      // set at launch; only a wipe earns a longer pause.
      const s = this.staging || this.home;
      this.command(alive, { type: 'move', gx: s.x, gy: s.y });
      this.wave = null;
      this.nextWaveTime = Math.max(this.nextWaveTime, w.time + WAVE_BREATHER);
      return;
    }

    // Retarget when the current objective dies.
    if (!liveIn(w, wave.target)) {
      const cx = alive.reduce((a, u) => a + u.x, 0) / alive.length;
      const cy = alive.reduce((a, u) => a + u.y, 0) / alive.length;
      const next = this.chooseWaveTarget({ x: cx, y: cy });
      if (!next) {
        // Nothing of theirs left standing anywhere. Regroup and look again.
        this.wave = null;
        this.nextWaveTime = Math.max(this.nextWaveTime, w.time + WAVE_BREATHER);
        return;
      }
      wave.target = next;
      wave.lastOrder = w.time;
      this.command(alive, { type: 'attack', target: next, gx: next.x, gy: next.y });
      return;
    }

    // Re-issue every couple of seconds to anyone who has gone idle, so the
    // group keeps moving as one instead of stalling on a pathing hiccup.
    if (w.time - wave.lastOrder > 2.5) {
      const slack = alive.filter((u) => this.idle(u));
      if (slack.length) {
        this.command(slack, {
          type: 'attack', target: wave.target, gx: wave.target.x, gy: wave.target.y,
        });
      }
      wave.lastOrder = w.time;
    }
  }

  waveInterval() {
    return this.world.rng.range(WAVE_INTERVAL_MIN, WAVE_INTERVAL_MAX);
  }

  /** Record how close our soldiers actually get to the enemy base. */
  trackWaveProgress() {
    const w = this.world;
    const foe = this.foeBase();
    let min = Infinity;
    for (const u of this.myUnits()) {
      if (!isMilitary(u)) continue;
      const d = dist(u.x, u.y, foe.x, foe.y);
      if (d < min) min = d;
    }
    if (min < this.stats.minDistToFoeBase) this.stats.minDistToFoeBase = min;
    if (this.wave && !this.wave.arrived && min <= 10) {
      this.wave.arrived = true;
      this.stats.wavesReachedBase++;
    }
  }

  // --- Save and load --------------------------------------------------------
  //
  // The AI's own memory is not derivable from the board, and a resumed match
  // that starts it from scratch is not the same game: the wave clock would reset
  // to FIRST_WAVE_TIME, every villager's job would be re-decided from nothing,
  // the escalation count would go back to zero and the squad already walking
  // across the map would be disowned mid-march.
  //
  // Entities are written as ids and looked back up on the way in, so anything
  // that died between the save and the load simply drops out — which is the same
  // thing that happens to it during an ordinary match.

  serialize() {
    return {
      think: this.think,
      acc: this.acc,
      rebalanceAcc: this.rebalanceAcc,
      jobs: Array.from(this.jobs.entries()),
      builders: Array.from(this.builders),
      home: this.home ? { ...this.home } : null,
      staging: this.staging ? { ...this.staging } : null,
      pending: this.pending
        ? {
          type: this.pending.type,
          entity: this.pending.entity ? this.pending.entity.id : 0,
          since: this.pending.since,
          progress: this.pending.progress,
        }
        : null,
      abandoned: Array.from(this.abandoned),
      badSpots: this.badSpots.map((s) => ({ x: s.x, y: s.y })),
      blockedUntil: Array.from(this.blockedUntil.entries()),
      placeCursor: this.placeCursor,
      wave: this.wave
        ? {
          ids: this.wave.ids.slice(),
          target: this.wave.target ? this.wave.target.id : 0,
          launchedAt: this.wave.launchedAt,
          lastOrder: this.wave.lastOrder,
          size: this.wave.size,
          arrived: !!this.wave.arrived,
        }
        : null,
      waveNumber: this.waveNumber,
      nextWaveTime: this.nextWaveTime,
      lostLastWave: this.lostLastWave,
      motion: Array.from(this.motion.entries()).map(([id, r]) => [id, { ...r }]),
      lastDamageTime: this.lastDamageTime,
      lastDamageAt: this.lastDamageAt ? { ...this.lastDamageAt } : null,
      defendingUntil: this.defendingUntil,
      garrisonUntil: this.garrisonUntil || 0,
      stats: JSON.parse(JSON.stringify(this.stats)),
      // The dispatch backlog goes with it, orders and all. Dropping it would
      // silently cancel whatever the AI asked for in the last tenth of a second
      // — most visibly the launch order of a wave saved on the step it left.
      orderQueue: this.orderQueue.map((e) => ({
        ids: e.ids.slice(), order: packOrder(e.order),
      })),
    };
  }

  restore(data) {
    if (!data) return;
    const w = this.world;
    const live_ = (id) => {
      const e = w.entities.get(id);
      return e && !e.dead ? e : null;
    };
    this.think = data.think || 0;
    this.acc = data.acc || 0;
    this.rebalanceAcc = data.rebalanceAcc || 0;
    this.jobs = new Map((data.jobs || []).filter(([id]) => live_(id)));
    this.builders = new Set((data.builders || []).filter((id) => live_(id)));
    if (data.home) this.home = { ...data.home };
    if (data.staging) this.staging = { ...data.staging };
    this.pending = null;
    if (data.pending) {
      const f = live_(data.pending.entity);
      if (f && !f.complete) {
        this.pending = {
          type: data.pending.type, entity: f,
          since: data.pending.since, progress: data.pending.progress || 0,
        };
      }
    }
    this.abandoned = new Set(data.abandoned || []);
    this.badSpots = (data.badSpots || []).map((s) => ({ x: s.x, y: s.y }));
    this.blockedUntil = new Map(data.blockedUntil || []);
    this.placeCursor = data.placeCursor || 0;
    this.wave = null;
    if (data.wave) {
      const ids = (data.wave.ids || []).filter((id) => live_(id));
      const target = live_(data.wave.target);
      // A wave whose whole squad or whose objective died while the game was
      // closed is not a wave any more. driveWave would reach the same verdict on
      // its next pass; reaching it here keeps the restored state self-consistent.
      if (ids.length && target) {
        this.wave = {
          ids,
          target,
          launchedAt: data.wave.launchedAt,
          lastOrder: data.wave.lastOrder,
          size: data.wave.size,
          arrived: !!data.wave.arrived,
        };
      }
    }
    this.waveNumber = data.waveNumber || 0;
    this.nextWaveTime = Number.isFinite(data.nextWaveTime)
      ? data.nextWaveTime : FIRST_WAVE_TIME;
    this.lostLastWave = !!data.lostLastWave;
    this.motion = new Map(
      (data.motion || []).filter(([id]) => live_(id)).map(([id, r]) => [id, { ...r }]),
    );
    this.lastDamageTime = Number.isFinite(data.lastDamageTime) ? data.lastDamageTime : -999;
    this.lastDamageAt = data.lastDamageAt ? { ...data.lastDamageAt } : null;
    this.defendingUntil = Number.isFinite(data.defendingUntil) ? data.defendingUntil : -999;
    this.garrisonUntil = data.garrisonUntil || 0;
    if (data.stats) Object.assign(this.stats, data.stats);
    // minDistToFoeBase is Infinity until a soldier has walked somewhere, and
    // Infinity does not survive JSON — it comes back as null.
    if (this.stats.minDistToFoeBase === null) this.stats.minDistToFoeBase = Infinity;

    this.orderQueue = [];
    this.orderPending = new Map();
    for (const e of data.orderQueue || []) {
      const ids = (e.ids || []).filter((id) => live_(id));
      const order = unpackOrder(w, e.order);
      if (!ids.length || !order) continue;
      const entry = { ids, order };
      this.orderQueue.push(entry);
      for (const id of ids) this.orderPending.set(id, entry);
    }
  }
}

/**
 * An order is a small plain object that may name an entity. Only `target` ever
 * does, so the pair below is two lines rather than a general graph walk.
 */
function packOrder(order) {
  if (!order) return null;
  const out = { ...order };
  if (out.target) out.target = out.target.id;
  return out;
}

function unpackOrder(world, rec) {
  if (!rec) return null;
  const out = { ...rec };
  if (out.target) {
    const e = world.entities.get(out.target);
    if (!e || e.dead) return null;   // the order was about something now gone
    out.target = e;
  }
  return out;
}

/**
 * Create the enemy AI for `playerId`.
 * @returns {{ update: (dt: number) => void }}
 */
export function createEnemyAI(world, playerId) {
  const ai = new EnemyAI(world, playerId);
  return {
    update: (dt) => ai.update(dt),
    // Everything the AI remembers, for src/core/save.js. Call restore() after
    // the world it belongs to has been rebuilt: it looks entities up by id.
    serialize: () => ai.serialize(),
    restore: (data) => ai.restore(data),
    // Not part of the contract — exposed for the headless test and debugging.
    _ai: ai,
    get stats() {
      return ai.stats;
    },
  };
}

export default createEnemyAI;
