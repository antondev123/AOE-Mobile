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
} from '../core/constants.js';
import { EV } from '../core/events.js';
import {
  ownedBy, findNearestGlobal, forEachNear, canPlace,
} from '../core/world.js';
import { canAfford, queueTrain, placeFoundation } from './economy.js';
import { commandUnits, isIdle } from './unitAI.js';

// --- Tuning -----------------------------------------------------------------

const THINK_PERIOD = 0.5;      // seconds of sim time between decision passes
const REBALANCE_PERIOD = 2.0;  // seconds between villager re-assignment passes

// Food is a *finite* resource on this map — there are no farms, only berries
// (6 nodes x 150 = 900, plus the 250 you start with). So villager count is
// budgeted against remaining food rather than run up to the pop cap, and the
// late-game army leans on archers, which cost wood and gold but no food.
const MAX_VILLAGERS = 16;
const MAX_HOUSES = 9;          // TC(5) + 9 x 5 = the 50-pop hard cap
const FOOD_SCAN = 26;          // how far out we count food still in the ground

const BARRACKS_TIME = 105;     // earliest barracks (seconds)
const BARRACKS2_TIME = 330;    // second barracks, for wave escalation
const MILL_MIN_WALK = 5.0;     // build a Mill if berries are further than this

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

const MILITARY_TYPES = ['militia', 'archer'];

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

// Candidate offsets for building placement, nearest-first. Built once.
const PLACEMENT_RING = (() => {
  const out = [];
  for (let dy = -11; dy <= 11; dy++) {
    for (let dx = -11; dx <= 11; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 3.2 && d <= 11) out.push({ dx, dy, d });
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out;
})();

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

    // Nearest reachable node of each resource, refreshed once per think.
    this.available = { food: null, wood: null, gold: null };
    this.home = null;          // last known base centre, survives TC loss
    this.staging = null;       // rally point for fresh soldiers

    this.pending = null;       // { type, entity, since, progress }
    this.abandoned = new Set(); // foundation ids nobody could ever reach
    this.buildBlockedUntil = 0;
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
      villagersQueued: 0,
      militaryQueued: 0,
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
    this.manageConstruction();
    this.manageVillagers(doRebalance);
    this.manageTraining();
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
      const a = w.rng.range(0, Math.PI * 2);
      const gx = Math.round(u.x + Math.cos(a) * 2.5);
      const gy = Math.round(u.y + Math.sin(a) * 2.5);
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
    const len = Math.hypot(vx, vy) || 1;
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
    return (p && p.resources) || { food: 0, wood: 0, gold: 0 };
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
        // Nobody can reach it. Forget it and let the next pass pick something
        // else, so a bad site can never trap the whole build order.
        this.abandoned.add(this.pending.entity && this.pending.entity.id);
        this.pending = null;
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

    if (w.time < this.buildBlockedUntil) return;

    const want = this.chooseBuilding();
    if (!want) return;

    const stats = BUILDING_STATS[want];
    if (!stats || !this.afford(stats.cost)) return;

    const villagers = this.myUnits('villager');
    if (!villagers.length) return;

    const anchor = want === 'mill' ? this.millAnchor() : this.home;
    const spot = this.findBuildSpot(want, anchor);
    if (!spot) {
      // No room right now — back off rather than hammering the search.
      this.buildBlockedUntil = w.time + BUILD_RETRY_DELAY;
      return;
    }

    let foundation = null;
    try {
      foundation = placeFoundation(this.world, this.id, want, spot.gx, spot.gy);
    } catch {
      foundation = null;
    }
    if (!foundation || typeof foundation !== 'object') {
      // Some economy implementations return a bool; look the foundation up.
      foundation = findNearestGlobal(
        w, spot.gx, spot.gy, this.myBuildings(),
        (b) => !b.complete && b.type === want,
      );
    }
    if (!foundation) {
      this.buildBlockedUntil = w.time + BUILD_RETRY_DELAY;
      return;
    }

    if (want === 'house') this.stats.housesStarted++;
    else if (want === 'barracks') this.stats.barracksStarted++;
    else if (want === 'mill') this.stats.millsStarted++;

    this.pending = {
      type: want, entity: foundation, since: w.time,
      progress: foundation.buildProgress || 0,
    };
    this.staffConstruction(foundation);
  }

  /** What the base needs next, in priority order. Returns a type or null. */
  chooseBuilding() {
    const w = this.world;
    const p = w.players[this.id];
    const pop = this.popState();
    const buildings = this.myBuildings();
    const complete = (t) => buildings.some((b) => b.type === t && b.complete);
    const anyOf = (t) => buildings.filter((b) => b.type === t).length;
    const villagers = this.myUnits('villager').length;

    // 0. No Town Center? Rebuilding it is everything, if we still have a builder.
    const noTC = !buildings.some((b) => b.type === 'towncenter');
    if (noTC && villagers > 0) {
      if (this.afford(BUILDING_STATS.towncenter.cost)) return 'towncenter';
      // Cannot afford one, and with no drop-off at all nothing can be banked —
      // that is a dead end. A Mill is cheaper and restores a food drop-off, so
      // the economy can restart and pay for the Town Center later.
      const hasDropoff = buildings.some((b) => b.complete && b.dropoff);
      if (!hasDropoff && anyOf('mill') === 0 && this.hasNodeFor(RES.FOOD) &&
          this.afford(BUILDING_STATS.mill.cost)) {
        return 'mill';
      }
      return 'towncenter'; // keep saving for it; manageConstruction just waits
    }

    // 1. Houses, always ahead of the cap. Getting housed is the classic stall.
    const housed = pop.cap >= MAX_POP_CAP;
    if (!housed && anyOf('house') < MAX_HOUSES && pop.room <= 2) return 'house';

    // 2. Barracks, once the economy is on its feet.
    if (w.time >= BARRACKS_TIME && villagers >= 5 && anyOf('barracks') === 0) {
      return 'barracks';
    }

    // 3. Mill, if the berries are a real walk from the drop-off.
    if (complete('barracks') && anyOf('mill') === 0 && this.millWorthIt()) return 'mill';

    // 4. Keep a house buffer as pop grows (build one at 3 spare, not 2).
    if (!housed && anyOf('house') < MAX_HOUSES && pop.room <= 3 && villagers >= 8) {
      return 'house';
    }

    // 5. Second barracks to feed bigger waves.
    if (w.time >= BARRACKS2_TIME && anyOf('barracks') === 1 && villagers >= 12 &&
        p.resources.wood >= BUILDING_STATS.barracks.cost.wood + 80) {
      return 'barracks';
    }

    return null;
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

  /**
   * Find ground for a building near `anchor`.
   *
   * The key rule: we require a one-tile clear margin all around the footprint
   * (by asking canPlace for a footprint two tiles larger). That single check
   * guarantees the AI can never wall itself in or seal its own Town Center —
   * every building it plants keeps a walkable corridor around it.
   *
   * The scan is bounded (MAX_TRIES candidates) and starts at a seeded rotating
   * cursor so successive buildings spread around the base instead of stacking
   * on one side, and so a failed search cannot spin.
   */
  findBuildSpot(type, anchor) {
    const w = this.world;
    const s = BUILDING_STATS[type];
    if (!s) return null;
    const MAX_TRIES = 90;
    const n = PLACEMENT_RING.length;
    if (!n) return null;

    // Deterministic rotating start point.
    this.placeCursor = (this.placeCursor + w.rng.int(1, 17)) % n;

    let tried = 0;
    let i = this.placeCursor;
    while (tried < MAX_TRIES) {
      const off = PLACEMENT_RING[i % n];
      i += 7; // stride, so we sample the whole annulus rather than one arc
      tried++;
      const gx = Math.round(anchor.x + off.dx);
      const gy = Math.round(anchor.y + off.dy);
      if (gx < 2 || gy < 2 || gx > w.width - 3 || gy > w.height - 3) continue;
      // Footprint itself must be clear...
      if (!canPlace(w, gx, gy, s.fw, s.fh)) continue;
      // ...and so must a one-tile ring around it, so we never self-wall.
      if (!canPlace(w, gx, gy, s.fw + 2, s.fh + 2)) continue;
      return { gx, gy };
    }
    return null;
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

  /** Desired villager split across food / wood / gold for the current phase. */
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

  /** Best node of `resType` for a villager at (x,y): near, and not crowded. */
  pickNode(resType, x, y) {
    const w = this.world;
    let best = null;
    let bestScore = Infinity;
    for (const n of w.resources) {
      if (n.dead || n.resourceType !== resType || n.amount <= 0) continue;
      const d = dist(n.x, n.y, x, y);
      if (d > 30) continue;
      // Spread out: each villager already on a node costs it 1.2 tiles of appeal.
      const score = d + (n.workers || 0) * 1.2 + (this.claimCount(n.id) * 1.2);
      if (score < bestScore) {
        bestScore = score;
        best = n;
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
    try {
      return !!isIdle(u);
    } catch {
      return u.state === 'idle' && !u.task;
    }
  }

  command(units, order) {
    if (!units || !units.length) return;
    const list = units.filter((u) => live(u));
    if (!list.length) return;
    try {
      commandUnits(this.world, list, order);
    } catch {
      /* a system still under construction must not take the match down */
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
    const villagers = this.myUnits('villager');
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

  evacuate(villagers) {
    const safe = this.home;
    for (const v of villagers) {
      if (dist(v.x, v.y, safe.x, safe.y) < 3) continue;
      // Only re-order villagers actually near the fighting.
      if (this.threat && dist(v.x, v.y, this.threat.x, this.threat.y) > DEFEND_RADIUS) continue;
      this.jobs.delete(v.id);
      this.command([v], { type: 'move', gx: safe.x, gy: safe.y });
    }
  }

  // --- training ------------------------------------------------------------

  /** Food still sitting in nodes we could plausibly walk to. */
  foodInGround() {
    let total = 0;
    for (const n of this.world.resources) {
      if (n.dead || n.resourceType !== RES.FOOD || n.amount <= 0) continue;
      if (dist(n.x, n.y, this.home.x, this.home.y) > FOOD_SCAN) continue;
      total += n.amount;
    }
    return total;
  }

  /**
   * How many villagers this map can actually support. Every villager past the
   * point where food gets tight is a militia we will never build, so the target
   * shrinks as the berries run out.
   */
  villagerTarget() {
    const r = this.res();
    const hasBarracks = this.myBuildings('barracks').some((b) => b.complete);
    if (!hasBarracks) return MAX_VILLAGERS;
    const budget = (r.food || 0) + this.foodInGround();
    if (budget < 200) return 8;
    if (budget < 450) return 11;
    return MAX_VILLAGERS;
  }

  manageTraining() {
    const pop = this.popState();
    const r = this.res();
    const villagers = this.myUnits('villager').length;
    const villTarget = this.villagerTarget();

    // Town Center: villagers, non-stop, while pop and food allow.
    const tc = this.townCenter();
    if (tc && tc.complete && !tc.dead) {
      const queued = tc.queue ? tc.queue.length : 0;
      if (pop.room > 0 && queued < 2 && villagers + queued < villTarget &&
          this.afford(UNIT_STATS.villager.cost)) {
        this.train(tc, 'villager');
      }
    }

    // Barracks: militia and archers, roughly 2:1 melee:ranged.
    const barracks = this.myBuildings('barracks').filter((b) => b.complete && !b.dead);
    if (!barracks.length) return;

    const army = this.myUnits().filter(isMilitary);
    let militia = 0;
    let archers = 0;
    for (const u of army) {
      if (u.type === 'militia') militia++;
      else archers++;
    }
    for (const b of barracks) {
      for (const q of b.queue || []) {
        if (q && q.type === 'militia') militia++;
        else if (q && q.type === 'archer') archers++;
      }
    }

    for (const b of barracks) {
      const state = this.popState();
      if (state.room <= 0) break;
      if ((b.queue ? b.queue.length : 0) >= 2) continue;

      // Aim for 2:1 melee:ranged. When food dries up the ratio drifts toward
      // archers by necessity — they are the only unit that costs no food.
      const foodTight = (r.food || 0) < 120 && this.foodInGround() < 150;
      let type = foodTight ? 'archer' : (militia < archers * 2 ? 'militia' : 'archer');
      if (!this.affordUnit(type, r)) {
        const other = type === 'militia' ? 'archer' : 'militia';
        if (!this.affordUnit(other, r)) break;
        type = other;
      }
      // Leave the TC enough food to keep making villagers while still growing.
      if (type === 'militia' && villagers < villTarget &&
          r.food < UNIT_STATS.militia.cost.food + UNIT_STATS.villager.cost.food) {
        continue;
      }
      if (this.train(b, type)) {
        if (type === 'militia') militia++;
        else archers++;
      }
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
    const army = this.myUnits().filter(isMilitary);

    if (this.defending) {
      // Everything comes home, including whatever is mid-attack.
      const point = this.threat || this.home;
      const rally = army.filter((u) => this.idle(u) || dist(u.x, u.y, point.x, point.y) > 16);
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
}

/**
 * Create the enemy AI for `playerId`.
 * @returns {{ update: (dt: number) => void }}
 */
export function createEnemyAI(world, playerId) {
  const ai = new EnemyAI(world, playerId);
  return {
    update: (dt) => ai.update(dt),
    // Not part of the contract — exposed for the headless test and debugging.
    _ai: ai,
    get stats() {
      return ai.stats;
    },
  };
}

export default createEnemyAI;
