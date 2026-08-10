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
//   ~2:30 Lumber Camp — half for the haul, half because a base whose only wood
//         drop-off is its Town Center cannot rebuild after losing it
//   ~3:00 Farms, once the berries within working range thin out — and from then
//         on continuously, because a farm is spent as fast as it is worked
//   ~2:00 militia + spearmen train continuously (the Barracks trains nothing
//         else now), aiming at whatever the counter table says
//   ~2:55 first wave: 5 units, sent as one group at the softest thing it can
//         actually break — a lumber camp, a mill, a field (it lands around 3:45)
//   then  a dispatch every 75-105 s. The trigger size escalates by 2 a wave up
//         to 16, but what *goes* is everything at the staging point above the
//         home guard, so a thirty-strong army attacks with twenty-four of it.
//   ~7:00 Feudal Age (6:20-9:20 across seeds), and immediately the building that
//         turns it into units: an Archery Range or a Stable, whichever answers
//         what the player has been seen fielding. Then the Blacksmith, then the
//         second of the two arms.
//   ~9:00 Castle Age (8:10-11:10, on five seeds out of six): Knights out of the
//         Stable, and a Siege Workshop for the scorpions, rams and mangonels
//         that finish a town the waves keep bouncing off. Which of those it
//         actually builds is decided by militaryTrainers()'s ordering and by
//         ROSTER_TARGET; before those existed the answer was "none of them,
//         ever", because the Barracks emptied the purse on militia first.
//
// Both ages are *saved up for* rather than waited for — see the age-up push
// under AGE_PUSH_VILLAGERS. Before it existed the Feudal Age landed at 8:40 and
// the Castle Age did not land at all, because the economy consumed its own
// surplus at exactly the rate it produced it, and everything above from 7:00
// onwards was content no player ever saw.
//
// A note on why the Feudal Age matters so much more than it used to. The archer
// and the scout used to be Barracks units, so a single 175-wood building put all
// three arms on the map in the Dark Age. They are Archery Range and Stable units
// now, and both are Feudal — so until the age-up this AI's army is genuinely,
// correctly infantry-only, and the age-up is the moment its composition problem
// becomes solvable. An AI that never built the second building would field
// militia and spearmen for ten minutes; see buildingWishlist.
//
// --- What a wave is, and why it is not a round trip any more -----------------
//
// A "wave" used to be a squad that walked over, hit something, and walked back
// on a clock. Measured with two of these AIs facing each other for thirty
// minutes on the review's own seeds, that produced: ten waves each, no winner,
// and — the number that matters — *one destroyed building between the two of
// them*, 550 and 322 points of damage against a Town Center's 900 hitpoints.
// Three things caused it and all three are gone:
//
//   * every wave was sent after a villager (chooseWaveTarget scored one at 1.5
//     against a Town Center's 0.5). A villager runs away and is replaced in
//     sixteen seconds. See the TARGET_* table;
//   * a wave was capped at sixteen while the army stood at forty-one. See
//     MAX_WAVE_SIZE and homeGuard();
//   * the recall clock was the march plus half again, and the march is 77-85 s
//     of an 85-tile map, so a squad arrived with thirty seconds of fighting in
//     hand and was called home standing in the enemy's town at full strength.
//     See WAVE_FIGHT_TIME.
//
// What a push does now: it commits everything above the home guard, walks in
// attack-moving so it fights what it meets, chops the objective once the ground
// around it is clear, is *reinforced where it stands* when the next beat comes
// round, and stays as long as it keeps destroying things. Sixty seconds without
// a kill, or bleeding below a third of its peak strength, and it comes home.
//
// Measured over six seeds of two shipped AIs, thirty minutes each: a winner
// every time, at 18.3, 18.6, 20.7, 21.9, 22.6 and 29.0 minutes, with the loser
// ground down first — economy raided from the sixth minute, Town Center down
// around the twentieth — rather than deleted.
//
// It never busy-waits: every "I want X" has a cooldown and a bounded search,
// and a wiped-out wave puts it back into an economy-rebuilding posture. And it
// always attacks eventually: PUSH_PATIENCE lowers the launch bar the further
// behind its own schedule it falls, because a gate the AI can never satisfy is
// worse than no gate at all.

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
  nextAgeTech, unitUnlocked, ageForUnit,
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
// try to fill it: MAX_HOUSES below holds it to a 65-pop economy, which is the
// shape of opening that is actually tested. A wave tops out at MAX_WAVE_SIZE
// (16) and the AI wants a standing army of roughly that plus replacements — call
// it 26 pop — to keep launching full-sized waves while absorbing losses, which
// leaves 24 villagers with room to spare. Twenty-four is also about what this
// economy can keep employed: ~13 on food (3-4 farms running), ~6 on wood (farms
// and houses to pay for) and ~4 on gold.
const MAX_VILLAGERS = 24;
// ...but not before there is a Barracks. Villagers arrive faster than houses do,
// and an economy booming to 24 keeps pushing "we are 2 off the cap, build a
// house" in front of the Barracks, which pushed the first wave from ~4:15 out to
// ~6:00. 16 is the old cap and the opening it produces is the tested one.
const PRE_BARRACKS_VILLAGERS = 16;
// TC(5) + 12 x 5 = 65 pop. This is the AI's own ceiling, not the engine's (see
// MAX_VILLAGERS above): the pop cap is 200, and stopping here is a deliberate
// choice about how large an economy this opening knows how to run.
//
// Nine houses (50 pop) was that choice while the roster was three units wide,
// and the Castle Age is what broke it. 24 villagers and a full-sized army of
// militia and spearmen *is* fifty population, so the AI arrived in the Castle
// Age with no room to put a Knight in: measured over six seeds, the Castle Age
// landed on five of them and not one trained a single Castle Age unit, because
// every slot had already been filled with the cheapest thing the Barracks made.
// Three more houses are 75 wood and fifteen population, which is the room the
// last three minutes of a match need to look different from the first three.
const MAX_HOUSES = 12;
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

// --- The rest of the build order --------------------------------------------
//
// Everything below arrived with the tech tree that split the Barracks up. Until
// that pass one 175-wood building put all three arms on the map and the build
// order could stop at "a Barracks, then a second Barracks"; it cannot now. The
// Barracks trains militia and spearmen and nothing else, so an AI that builds
// only Barracks fields an infantry-only army for the whole match — no ranged
// unit, no cavalry, nothing that answers a player who masses either.
//
// THE FIRST LUMBER CAMP, as a matter of course rather than as the haul
// optimisation campWanted() treats it as. Two reasons, and the second is the one
// that made it a wishlist entry:
//
//   * income. It is the first building in every real AoE2 build order for a
//     reason — the woodline is what every other building is priced in, and 100
//     wood back into a shorter round trip is the cheapest compounding purchase
//     on the list.
//   * insurance, and this is not theoretical. While the Town Center is the only
//     building that can bank a log, losing it is *unrecoverable*: every villager
//     sent to the trees fills its pack, finds nowhere to put it and stands
//     there, and the only building that fixes that costs 100 wood the AI can no
//     longer earn. Measured before this entry existed, on the raze-at-250s
//     scenario in tests/enemyai.test.mjs: the AI was left holding 82 wood, sat
//     on it for the remaining six minutes, banked 1200 food it could not spend
//     and never rebuilt anything. A camp standing before the raid is the whole
//     difference, and it is 100 wood the AI was going to spend on a camp anyway.
//
// 150s puts it after the Barracks (105s) rather than in front of the opening,
// and eight villagers is the point at which the workforce is large enough that
// a shorter haul is worth more than one more House.
const LUMBER_CAMP_TIME = 150;
const LUMBER_CAMP_VILLAGERS = 8;
// Wood that must survive the purchase, per building. This is the answer to the
// standing objection against putting any of these ahead of the economy in the
// wishlist: an entry that only fires with the float still in the bank cannot be
// accused of taking the wood the next House (25) or field (60) was waiting on.
//
// The camp's own float is one field's worth and no more, deliberately. It is
// the entry that has to fire *early* to be worth anything at all — a camp built
// at 5:00 is a camp bought after the walk it was meant to shorten, and the
// insurance half of the argument only pays if the camp is standing before the
// raid rather than after it. Measured on the raze-at-250s scenario across five
// seeds: at a float of 60 the camp landed in time on one seed in five, and at 30
// it landed on four.
const LUMBER_CAMP_WOOD_FLOAT = 30;
// The Feudal military building — an Archery Range or a Stable, whichever
// answers what we can see (see nextArmBuilding).
//
// It is gated on the *age* and not on a clock, because the age is the clock: an
// archer, a skirmisher and a scout are all Feudal units now (AGE_UNITS in
// tech.js), so before the age-up there is nothing for either building to train
// and the AI's army is correctly infantry-only. Measured across seeds the
// Feudal Age lands at 5:30-8:00, so this is a fifth-minute decision, which is
// where a competent player puts it: the age-up, then the building that turns
// the age into units, then the upgrades.
//
// Ten villagers is the same gate the age-up itself uses (AGE_UP_VILLAGERS), so
// this can never be the thing that stops the economy growing; the wood float is
// what keeps it from taking the food line's timber. Sixty rather than the camp's
// thirty because this one does not have to be early to be worth having — by the
// time the age lands the AI is banking wood in the low hundreds, and measured
// across five seeds the tighter float bought nothing: the Range went up within a
// few seconds of the same moment either way.
const ARM_BUILDING_VILLAGERS = 10;
// Thirty, and the number is not free-floating: it has to leave this entry's
// total bar (175 + 30 = 205) *below* the bar of every entry that sits behind it
// in the wishlist, or the list order is a lie. The forward camp at 3d asks for
// 220 (100 + CAMP_WOOD_RESERVE), and at a float of 60 the Range asked for 235 —
// so in the fifteen-wood window between them the AI reliably put up a third
// Lumber Camp instead of the building it was supposedly prioritising. Measured
// on seed 12345: three Lumber Camps, no Archery Range, ten minutes.
const ARM_BUILDING_WOOD_FLOAT = 30;
// Wood below which saving for the first arm is a bad trade — see the wishlist.
// A hundred is about forty seconds of this economy's wood income away from the
// 205 the building costs, which is a wait the food line can absorb; from fifty
// it would be a minute and a half of no fields.
const ARM_SAVING_FLOOR = 100;
// The *second* arm — a Stable behind an Archery Range or the other way round —
// is a third military building drawing on one population cap and one purse, so
// it waits for an economy that can carry it. Fourteen villagers and a float of
// 160 is roughly "the first one is paid off and the next House is not waiting".
const ARM2_BUILDING_VILLAGERS = 14;
const ARM2_BUILDING_WOOD_FLOAT = 160;
// The two arms the Barracks used to stand in for, in the order they are
// *considered* — nextArmBuilding scores them, so this is not a priority list,
// only the set. The Barracks is not in it: it has its own clock (it is the Dark
// Age opening and comes 150 seconds before either of these can train anything),
// and the Siege Workshop is not either — it is not an arm you counter with, it
// is a building-breaker, and it has its own entry with its own gates.
const ARM_BUILDINGS = ['archeryrange', 'stable'];

// The named per-type counters in `stats`, for the handful of types a test or a
// report asks about by name. Everything else is counted in `stats.started`,
// which is keyed by type and needs no maintenance — see startBuilding.
const STARTED_STAT = {
  house: 'housesStarted',
  barracks: 'barracksStarted',
  mill: 'millsStarted',
  farm: 'farmsStarted',
  lumbercamp: 'lumberCampsStarted',
  miningcamp: 'miningCampsStarted',
};
// The Blacksmith. Behind an army, exactly as manageTech's own military-upgrade
// gate is (MILITARY_TECH_MIN_ARMY): +1 attack on four militia is worth less than
// the wood that pays for the next eight. It is 150 wood for a building that
// trains nothing at all, and the only reason it is worth that is the ten
// attack/armour techs that now live there and nowhere else.
const BLACKSMITH_VILLAGERS = 12;
const BLACKSMITH_WOOD_FLOAT = 100;
// Castle Age. The Siege Workshop is the answer to a player who has walled up or
// whose Town Center the waves keep bouncing off, and it is the last building on
// the list: 200 wood, and everything it trains walks at half an army's pace.
// Sixteen villagers is an economy that is genuinely finished with the buildings
// in front of this one — measured, the Castle Age lands at 8:10-11:10, so in a
// ten-minute match this is the last thing the AI ever starts and in a
// twelve-minute one it has two or three minutes of scorpions out of it.
const SIEGE_VILLAGERS = 16;
// Sixty, not the 160 this started at. The bar has to clear the same test every
// other entry ahead of the fields does — it must be reachable by a bank that the
// House and the field are also drinking from — and 360 wood never was: measured
// over six seeds, the Castle Age landed on five of them and not one ever bought
// a Siege Workshop, because the late-game wood bank oscillates between about 100
// and 400 and every peak was spent on the next field before it got there. 260 is
// still two Houses and two fields clear of the building's own price.
const SIEGE_WOOD_FLOAT = 60;
// The University is gated on there being a tech to research there at all (see
// the wishlist), so these are the numbers for the day one lands rather than a
// prediction that it will. Eighteen villagers is past this AI's own booming
// target and 200 of float is a full building in reserve: a research-only
// building is the last thing a ten-minute match has time for.
const UNIVERSITY_VILLAGERS = 18;
const UNIVERSITY_WOOD_FLOAT = 200;

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
// The size at which a wave stops *escalating*. It is a trigger, not a cap: see
// launchWave and homeGuard — everything at the staging point above the home
// guard goes, so a thirty-strong army attacks with twenty-four of it.
//
// It used to be a cap, and that was one of the three reasons two of these AIs
// could not finish a match in thirty minutes. Measured, seed 4242, minute 25:
// both sides stood on forty-one soldiers at the population ceiling and sent
// sixteen. A third of an army walking into a whole one loses, comes home, and
// is replaced by production — which is a stalemate machine, not an attack.
const MAX_WAVE_SIZE = 16;
// Waves are scheduled from the moment one *launches*, not from when it dies,
// so pressure arrives on a predictable ~90-125 s beat whatever happens out
// there. When the beat comes round and a push is still fighting, the fresh
// soldiers reinforce it instead of waiting for it to come home (see
// reinforceWave), so this is the cadence of *dispatches*, not of round trips.
const WAVE_INTERVAL_MIN = 75;
const WAVE_INTERVAL_MAX = 105;
const WAVE_REGROUP_AFTER_LOSS = 135; // longer pause after a wave is wiped
// The march budget floor. Eighty seconds was measured against a militia (1.1
// tiles/second) crossing the ~85 tiles between the two bases, which is 77
// seconds of walking; anything slower than a militia did not arrive at all,
// which is why marchBudget() computes the walk per wave rather than holding one
// number. This is only the floor for a raid on something close by.
const WAVE_MARCH_MIN = 80;
// --- How long a push presses ------------------------------------------------
//
// THE OLD RULE WAS A FLAT CLOCK FROM LAUNCH, AND IT IS WHY NOTHING WAS EVER
// DESTROYED. The budget was march x 1.5, capped at 150 s, and the march alone is
// 77-85 s — so a wave arrived with thirty seconds of fighting in hand and was
// called home in the middle of the enemy's town. Traced on seed 4242, six waves:
// three ended on the clock while standing 3-6 tiles from their objective with
// 13-16 of their 16 men alive. Thirty minutes of that produced 550 points of
// damage to buildings, one destroyed building between the two sides, and no
// winner.
//
// So the budget is now the walk *plus* a fight, and the fight is measured from
// the moment the push is committed rather than shared with the march:
//   WAVE_FIGHT_TIME       seconds of fighting bought at launch. 75 s is about
//                         four buildings' worth of chopping for a mid-sized
//                         squad (a militia does 5.5 damage a second and a
//                         Barracks has 700 hitpoints), or one real battle.
//   WAVE_KILL_EXTENSION   every objective the push actually destroys buys it a
//                         fresh window of this length. There is deliberately no
//                         ceiling on top of that: a push that is taking a base
//                         apart one building a minute should stay until the base
//                         is gone, and the moment it stops making progress the
//                         window runs out and it walks home. That is the whole
//                         bound — sixty seconds without a kill — and it is a
//                         better one than a clock, because it is measured in
//                         results rather than in patience.
const WAVE_FIGHT_TIME = 75;
const WAVE_KILL_EXTENSION = 90;
// Survivors below this share of the largest the push ever *simultaneously* was:
// come home rather than feed the rest in.
//
// Against the total ever committed rather than the peak, a push that is fed
// three men at a time for four minutes is judged against a number that never
// existed, and a healthy fifteen-strong front reads as the wreckage of a
// forty-man army and is called home mid-siege.
const WAVE_BLED_SHARE = 0.3;
const WAVE_BREATHER = 15;      // minimum regroup before the next launch

// --- The home guard ---------------------------------------------------------
//
// Soldiers that stay behind when the rest commits. Without them "send everything
// above the guard" means "send everything", and the first raid to arrive walks
// into an empty base — which is a different way to lose a match, not a fix.
//
// It is a share rather than a number so that it never gets in the way of the
// opening: below HOME_GUARD_FROM the AI keeps nobody back at all, because an
// army of five that keeps two at home launches a wave of three, and the first
// wave is the one thing about this AI's schedule that is already right.
const HOME_GUARD_FROM = 8;
const HOME_GUARD_SHARE = 0.25;
const HOME_GUARD_MIN = 2;
const HOME_GUARD_MAX = 6;
// Fresh soldiers join a push that is already out, but never as a trickle: two
// men walking eighty tiles into a fight arrive as two casualties. Below this
// they wait at the staging point for the next dispatch.
//
// And never into a push that is going to be recalled before they get there —
// see reinforceWave. A push only earns reinforcements by destroying something;
// one that has been sitting outside a base achieving nothing is one the army
// should be regrouping at home instead of feeding, four men at a time.
const REINFORCE_MIN = 4;
// However far off a full-sized wave is, the AI attacks anyway once it is this
// far past its own schedule — first with a halved bar, then with whatever it
// has.
//
// THIS IS THE MOST IMPORTANT SAFETY RULE IN THE FILE. Every gate above is a
// reason not to attack yet, and a set of reasons not to attack yet is exactly
// how an AI ends up holding its whole army at home for ten minutes. A gate the
// AI can never satisfy is worse than no gate at all, so the schedule always
// wins in the end.
const PUSH_PATIENCE = 45;

// --- Breaking things --------------------------------------------------------
//
// How close the push has to be to its objective before it stops walking and
// starts chopping, and how clear of enemy soldiers the ground has to be first.
//
// The two orders are genuinely different and the difference is not cosmetic. An
// ordered attack (unitAI's orderAttack) sets `target` directly, which is what
// tells combat.js the order came from outside — and a unit under one neither
// auto-acquires, nor answers callForHelp, nor retaliates (reactToDamage bails on
// `target.task`). Twenty soldiers ordered onto a Town Center will chop it while
// twenty defenders kill them one at a time without a single swing back. So the
// push attack-*moves* while there is anything alive to fight, and only switches
// to chopping the building once the ground around it is clear.
const SIEGE_RANGE = 8;         // near enough the objective to start on it
const SIEGE_ENGAGE = 14;       // ...and near enough to count as "arrived" at all
const SIEGE_CLEAR_RADIUS = 10; // enemy soldiers inside this keep it fighting
// ...unless the front outnumbers them by this much, in which case the handful
// still standing is the escort's problem and the building comes down now. An
// undefended base is the easy case; a base with two men left in it should not
// be able to keep a twenty-strong push nibbling houses on auto-acquire for the
// rest of its budget, which is what an absolute "no enemies at all" rule did.
const SIEGE_OVERWHELM = 4;
const SIEGE_MODE_HOLD = 5;     // seconds between posture changes (no flapping)
// Where the push walks to. Straight at the objective's centre is a tile inside a
// building footprint, which no unit can stand on; a couple of tiles back along
// the line it approached from is ground it can.
const SIEGE_STANDOFF = 2.5;
// Units that go straight for the building whatever else is happening. See
// orderPush: a ram in an attack-move is a ram in a duel it cannot win.
const BREAKERS = ['ram'];

// What the push goes for, best first. The scores are multiplied by
// TARGET_WEIGHT below and then traded off against how exposed the thing is and
// how far away it is, exactly as before.
//
// THE ORDER HERE IS THE MATCH'S WIN CONDITION, and it used to be upside down. A
// player is defeated when they own no building that can train anything
// (GameScene.checkVictory), and the old table scored a villager at 1.5 against a
// Town Center's 0.5 — so on seed 4242 every one of the six traced waves was sent
// after a villager. A villager runs away (combat.js startFleeing), is replaced
// in sixteen seconds, and leads the squad on a tour of the map; a Barracks does
// none of those things. Villagers are not neglected by this change, they are
// killed on the way in: the push attack-moves, and combat.js's own auto-acquire
// puts units ahead of masonry, so a squad standing in a working base kills the
// workers first and starts on the walls afterwards.
const TARGET_TOWNCENTER = 3.4; // trains villagers, and losing it is unrecoverable
const TARGET_TRAINER = 3.0;    // a Barracks, Range, Stable or Siege Workshop
const TARGET_ECONOMY = 1.4;    // a drop-off or a field: this is the raid
const TARGET_OTHER = 0.7;      // houses and the rest
const TARGET_VILLAGER = 1.2;   // only reachable once nothing of theirs stands
const TARGET_WEIGHT = 6;
// ...and the same table for a squad too small to break a base, which is every
// squad before about the eighth minute.
//
// Sending five men at a Town Center guarded by five men is a donation. Sending
// them at the lumber camp out at the second woodline is the oldest opening in
// the genre: the camp is 380 hitpoints against the Town Center's 900, it is
// usually outside the defender's standing army, and the workers around it are
// killed on the way in by combat.js's own acquisition. Measured before this
// existed, on the three review seeds: the first permanent damage either side
// took landed at 14.6, 16.8 and 8.8 minutes, because every wave before then had
// been thrown at the front door and bounced.
const RAID_SQUAD = 8;
// Trainers left standing at or below which every push stops raiding and goes
// for the throat, whatever its size. A player is defeated when the last
// building that can train something falls, so an opponent down to one or two of
// them is one push from losing — and a push that spends that moment burning
// their fifteenth farm is a push that gives them the time to rebuild. Measured
// without this: on seed 99 the loser's first building fell at 10:30 and its Town
// Center at 25:18, and almost all of the fifteen minutes in between went on
// fields, houses and drop-offs.
const FINISH_THEM_TRAINERS = 1;
const FINISH_WEIGHT = 2;
const RAID_TOWNCENTER = 1.0;
const RAID_TRAINER = 1.2;
const RAID_ECONOMY = 3.0;
const RAID_OTHER = 0.9;

const STAGING_DIST = 5.5;      // rally point, tiles from the TC toward the foe
const DEFEND_RADIUS = 13;      // hostiles this close to home trigger defence
const DEFEND_CLEAR_TIME = 12;  // all-clear delay before resuming offence
// How badly the home guard has to be outnumbered before a push is abandoned to
// come and help.
//
// It used to be that *any* trouble at home cancelled the attack outright — two
// hostiles inside DEFEND_RADIUS dropped the wave, wherever it was, and added
// forty-five seconds to the clock. With two of these AIs on a map that is a
// mutual cancellation machine: traced on seed 4242, two of six pushes were
// called off within 43 s of leaving, one of them after nine seconds, because a
// scout was standing in the wood line. Both sides spend the match walking their
// armies backwards and forwards and neither ever arrives.
//
// So the home guard answers the raid, and the push only turns round for a threat
// the guard is actually losing to. The trade is deliberate: two AIs that both
// keep pressing are a race, and a race has a winner.
const RECALL_OUTNUMBERED = 1.25;
const STUCK_WINDOW = 1.5;      // seconds between motion samples
const STUCK_DIST = 0.4;        // moved less than this while "moving" = jammed
const BUILD_RETRY_DELAY = 6;   // no infinite placement retries
// Build time at or above which a foundation gets two villagers. See
// staffConstruction: the Barracks is 38s and is the cheapest thing that has
// always been worth a pair.
const HEAVY_BUILD_TIME = 36;
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
const MIX_CEILING = 0.4;
// ...and a ceiling on how much the counter maths may ever be worth, which is
// the knob that was missing.
//
// counterScore is an average of the bonus damage table, so a player fielding a
// third archers hands the skirmisher 1.3 points and COUNTER_WEIGHT turns that
// into 2.9 — against a base preference gap of 0.23 between the archer and the
// skirmisher. The counter did not tilt the decision, it *was* the decision, and
// two of these AIs facing each other counter-spiral into the two worst units in
// the game: measured on seed 1337, thirty minutes, both armies ended as
// spearmen and skirmishers (4 and 3 attack), neither could kill the other and
// neither could dent a building — 1146 and 1447 points of damage between them in
// half an hour.
//
// Capped, the counter is worth about two ranks in the preference table: enough
// that massing knights is answered with spearmen, not enough that it erases
// everything else. The spread term in chooseUnit then does the rest — once a
// type is past a third of the army it starts losing to its own alternatives —
// so the army settles into a mix with a bias rather than a monoculture.
const COUNTER_CAP = 0.6;
// What the AI builds when it has seen nothing of the player at all — the fog
// means that is the normal state early on. AoE2's own default opening mix:
// mostly infantry, a third archers, a scout out front.
//
// READ THESE AS PREFERENCES WITHIN ONE BUILDING'S ROSTER, not as shares of the
// army. chooseUnit only ever compares the entries belonging to the same
// building's `trains` list — the Barracks weighs militia against spearman, the
// Archery Range weighs archer against skirmisher — so what matters is the
// ordering inside each group and the size of the gap, which is what a counter
// score (COUNTER_WEIGHT x the bonus table) has to overcome to change the AI's
// mind. Anything not named here falls to 0.1 in chooseUnit, which is the "I
// will build this only when the counter maths tells me to" weight.
//
// Barracks. Militia is the generalist and the opening body; the spearman is
// left at the default because it is deliberately bad in a straight fight (4
// attack against a militia's 6) and should only ever be picked when there is
// cavalry on the map for its +12 to land on.
//
// Archery Range. The archer at 0.35 is the arm this building exists for and is
// good against two of the three classes. The skirmisher sits low on purpose:
// 3 attack loses to everything that is not an archer, so it must arrive as an
// *answer* (its +4 vs the archer class, worth 8.8 through COUNTER_WEIGHT when
// the player has massed them) rather than as a habit.
//
// Stable. The scout keeps its old 0.2 — it is a Feudal harasser, not a line
// unit. The knight is the highest weight in the table because it is the Castle
// Age payoff for having taken this building at all: 100 hitpoints and 10 attack
// is the hardest body in the game, and an AI that reached the Castle Age with a
// Stable standing should be spending its gold here. The age gate in chooseUnit
// is what stops that weight putting knights on the map in the Feudal Age.
//
// Siege Workshop. THE RAM IS FIRST NOW, and the reordering is the difference
// between a match that ends and one that does not. A player is defeated when
// they own no building that trains anything, and measured, three rams take a
// Town Center in 26 seconds against three militia's 56 — the ram is not a
// flavour unit in this game, it is the win condition with legs. The mangonel is
// second and no longer near-zero: the judgement that its splash hurts our own
// line more than it hurts theirs was made against a mangonel whose scan was
// capped below its own reach, so it sat idle after killing whatever it was
// pointed at. That is fixed (combat.js acquireRange), and the measurement on the
// repaired unit is 8 clumped militia dead in 90 s where 7 of 8 used to survive.
// The scorpion is last of the three: cheapest and best against bodies, which is
// what the Barracks is already for.
//
// Where these three are held in check is ROSTER_TARGET, not here — a weight
// alone would have the Siege Workshop building nothing but rams forever.
const DEFAULT_MIX = {
  militia: 0.45,
  archer: 0.35,
  scout: 0.2,
  skirmisher: 0.12,
  knight: 0.4,
  ram: 0.5,
  mangonel: 0.35,
  scorpion: 0.25,
};
// How many of a type the army wants standing at once. Anything not named here
// is unlimited and is governed by MIX_CEILING alone.
//
// This exists because the siege engines need a *standing order* rather than a
// preference. The spread term in chooseUnit is divided by the size of the whole
// army, so at thirty soldiers it is worth a thirtieth of a point and the
// highest-weighted siege unit would win every single decision the Siege Workshop
// ever made. Two rams and two mangonels is the escort a push wants; a third of
// either is 2 more population and 160 more wood spent on something that walks at
// half the army's pace. Because `have` counts live units and queued ones, this
// is self-replacing: lose the rams on a push and the Workshop starts on the next
// pair the same think.
const ROSTER_TARGET = { ram: 2, mangonel: 2, scorpion: 3 };
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
// happens: the money gate binds long before the clock does, because the Town
// Center trains villagers non-stop and the Barracks trains soldiers, so 400
// spare food takes a while to appear. What changed with the new tech tree is how
// much that lateness costs. It used to buy an age whose unlocks this AI barely
// used; it now buys the Archery Range, the Stable, the Knight and the Siege
// Workshop, which is to say the entire second half of the game — so the AI
// stopped waiting for a surplus and started saving for one. See the age-up push
// under AGE_PUSH_VILLAGERS, and expect the Feudal Age at 6:20-9:20 and the
// Castle Age at 8:10-11:10, measured over six seeds of a twelve-minute match.
//
// The Castle clock is 7:00 rather than the 8:15 it started at, and it is there
// to be non-binding: on every measured seed the Feudal Age lands after it, so
// the AI starts saving for the Castle the moment it can and the *money* decides,
// which is the honest gate. A clock that fires after the thing it gates is a
// clock that only ever adds a delay nobody chose.
const FEUDAL_AGE_TIME = 255;
const CASTLE_AGE_TIME = 420;
const AGE_UP_VILLAGERS = 10;
const AGE_UP_VILLAGERS_CASTLE = 18;
// --- The age-up push --------------------------------------------------------
//
// The villager count the workforce stops at while an age-up is due and unpaid.
// This is the single change that got this AI into the Castle Age at all.
//
// The clocks above are the *earliest* the AI will consider an age; what actually
// decided when it happened was money, and the money never arrived. Measured over
// twelve minutes on seed 4242, minute by minute: gross food income 150-500 a
// minute, and training spending 170-290 of it — every minute, all match. The
// Town Center trains a villager every 16 seconds and a villager is 50 food,
// which is 190 food a minute on its own, so the economy was consuming its own
// surplus at exactly the rate it produced it and a 400-food age-up was simply
// never reachable. The Feudal Age landed at 8:39. The Castle Age did not land at
// all, on either of two seeds, and every unit and building behind it — the
// Knight, the mangonel, the scorpion, the Siege Workshop, the Monastery — was
// content no player would ever see.
//
// So the AI does what a player does and stops growing to click up. Fourteen
// villagers plus the six or seven soldiers it has by then is about twenty
// population, which is the shape of an AoE2 Feudal age-up; twenty villagers for
// the Castle. It is deliberately expressed as a *cap on the workforce* rather
// than as "pause the Town Center", because a cap cannot deadlock: an AI that has
// not reached the cap keeps booming, and one that has stops spending 190 food a
// minute on itself until the age is bought. Below the cap nothing changes at
// all, which is why the opening is untouched.
const AGE_PUSH_VILLAGERS = 14;
const AGE_PUSH_VILLAGERS_CASTLE = 20;
// ...and both halves of the hold only engage once this fraction of the age's
// food bill is already in the bank.
//
// The fraction is doing two jobs. The first is safety: an economy that never
// gets there is never held back at all, so the starvation scenario in
// tests/enemyai.test.mjs — every berry near the base deleted at 3:00 — cannot
// freeze the workforce, which an earlier clock-based version of this did for
// seven minutes straight.
//
// The second is that stopping villager production early is a *losing* trade, not
// a neutral one. A villager costs 50 food and pays it back in about seventy
// seconds, so pausing the Town Center three minutes from an age-up buys the age
// one minute sooner and costs three villagers' worth of income for the rest of
// the match — measured at 0.4, seed 12345's Feudal Age went *backwards* by
// eighty seconds. Seven tenths is close enough that the pause is thirty to forty
// seconds and the payback question does not arise.
const AGE_PUSH_FOOD_START = 0.7;
// The second half of the push: the last stretch of the saving is done with the
// soldiers' food as well.
//
// Capping the workforce alone was not enough and the measurement says exactly
// why. With the Town Center held at fourteen villagers the stockpile climbed to
// 419 food — nine short of the 490 an age-up plus its reserve costs — and then
// sat there for two full minutes, because a militia is 60 food and a spearman is
// 35 and the Barracks was eating the surplus at precisely the rate the food line
// produced it. Nine food short, for two minutes, is the whole Castle Age.
//
// So above this fraction of the bill, soldiers stop eating too. It is a fraction
// rather than a flag because the cost of the hold is soldiers not built, and
// that cost has to be *bounded*: from three quarters paid, the rest arrives in
// fifteen to twenty-five seconds of this economy, which is at most one body out
// of the next wave — while from zero it would be two minutes and the wave
// schedule would visibly stutter. Below the fraction nothing is held back.
//
// Three quarters and not a half, and the difference is the quarter measured on
// the schedule: at 0.5 the hold ran for over a minute on the slower seeds and
// the AI launched two waves in ten minutes instead of three, with a 205-second
// hole in the middle. Pressure that does not arrive costs the player more than
// an age-up that arrives late. It sits just above AGE_PUSH_FOOD_START, so the
// Town Center is always the first producer to be asked to stop and the army is
// the last.
const AGE_PUSH_FOOD_HOLD = 0.75;
// ...and however far off the money is, the push gives up after this long and the
// AI goes back to playing normally.
//
// Without a bound the workforce cap is a deadlock waiting for a bad map: the
// starvation scenario in tests/enemyai.test.mjs deletes every berry near the
// base at 3:00, the 400 food never arrives, and the AI sat frozen at fourteen
// villagers for the remaining seven minutes. An AI that has decided to age up
// and cannot must go back to growing, or it has traded the match for a decision
// it could not carry out. Ninety seconds is longer than any push that has ever
// succeeded needed; past that the answer is not "hold on a little longer", it is
// "this economy cannot pay for it yet".
const AGE_PUSH_MAX_HOLD = 90;
// The same idea for the *research* hold, which is the cheap half of saving up:
// two hundred seconds, because not buying an upgrade costs the AI a little
// damage while not training villagers costs it the economy, and because a
// 600-food Castle Age genuinely takes longer than ninety seconds to save out of
// a mid-game surplus. Measured on seed 777 with both holds on the short clock:
// the Feudal Age landed at 6:22, the ninety seconds expired, the whole Castle
// Age fund went on Feudal-tier upgrades within the minute, and the AI finished
// twelve minutes still in the Feudal Age.
const AGE_SAVING_MAX_HOLD = 200;
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
// Banked gold at which villagers start coming off the mine, and at which the
// last of them do. See desiredSplit — the short version is that this AI spent
// 250 gold of the 1100 it dug in a twelve-minute match, and the diggers were
// the food villagers the age-up needed.
const GOLD_COMFORTABLE = 250;
const GOLD_SATURATED = 450;
// Military upgrades come out of the same purse as the next wave, so they wait
// until there is an army for them to improve.
//
// Order is priority, and the first two entries are where the work is. Every one
// of the ten attack/armour techs names the Blacksmith first in its `at` list, so
// now that the building exists researchBuildingFor() sends all ten there and
// techsAt('archeryrange') and techsAt('barracks') are both empty — which is
// exactly why the Blacksmith had to enter the build order below. The last two
// entries are not dead weight: `at` is a preference list, so if the Blacksmith
// ever goes away (or a tech is added that names the Range first) they pick the
// research back up with no edit here. The University is listed for the same
// reason and is inert today — nothing in TECHS names it yet.
const MILITARY_RESEARCH_BUILDINGS = ['blacksmith', 'university', 'archeryrange', 'barracks'];
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
    // { age, since }: which age-up the workforce is currently being held back
    // for, and when that hold started. See ageUpPushCap.
    this.agePush = null;
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
      // Every foundation started, keyed by building type. The named counters
      // above are a subset kept for the tests that ask for them by name.
      started: {},
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
      // One entry per push that ended: { t, peak, kills, left }. A push is a
      // launch plus every reinforcement that joined it, so this is the honest
      // record of how much of the army was ever committed at once and what it
      // achieved — which the per-dispatch waveLog above cannot show.
      pushLog: [],
      // The same two numbers for the push that is still out, which pushLog by
      // definition cannot carry: the largest force ever committed at once, and
      // the number of objectives destroyed. A push that is winning does not end
      // — it is reinforced where it stands — so an AI that is doing the right
      // thing can finish a match with an empty pushLog.
      maxPushPeak: 0,
      objectivesRazed: 0,
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

    // Two counters, and the second is the one that will still be right next
    // time the building table grows. The named fields are the observability
    // contract (tests/enemyai.test.mjs reads farmsStarted; the smoke report
    // prints the rest) and they stay; `started` is the same tally keyed by type,
    // so an Archery Range, a Stable or anything else added later is counted
    // without an edit here. The if/else chain this replaces silently dropped
    // every type nobody had thought of — which is a poor way to find out that
    // the AI has stopped building something.
    this.stats.started[type] = (this.stats.started[type] || 0) + 1;
    const named = STARTED_STAT[type];
    if (named) this.stats[named]++;

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

    const wood = p.resources.wood || 0;
    const age = currentAge(w, this.id);

    // 3a. The first Lumber Camp, on the clock rather than on the haul. See
    //     LUMBER_CAMP_TIME: this is half income and half the one insurance
    //     policy a base with a single wood drop-off cannot do without.
    if (w.time >= LUMBER_CAMP_TIME && villagers >= LUMBER_CAMP_VILLAGERS &&
        anyOf('lumbercamp') === 0 && this.hasNodeFor(RES.WOOD) &&
        wood >= BUILDING_STATS.lumbercamp.cost.wood + LUMBER_CAMP_WOOD_FLOAT) {
      wish('lumbercamp', this.campAnchorFor(this.available.wood));
    }

    // 3b. The Feudal military building, and the most important entry added
    //     since the tech tree split the Barracks up. Without it the AI trains
    //     militia and spearmen for the whole match: the archer moved to the
    //     Archery Range and the scout to the Stable, so an AI that owns neither
    //     has no ranged unit, no cavalry, and nothing to answer either with.
    //
    //     Ahead of the farms and the forward camps below on purpose. A farm is
    //     60 wood and wantsFarm() is a standing order that is true again within
    //     a minute of being satisfied, so an entry sitting behind it only gets
    //     its turn in the gaps — which is how "the AI never built an Archery
    //     Range" happens without anybody writing that rule down. The wood float
    //     (ARM_BUILDING_WOOD_FLOAT, on top of the building's own 175) is what
    //     makes that safe: this can only fire with the next House and the next
    //     two fields still paid for.
    const arm = this.nextArmBuilding(anyOf);
    const firstArm = anyOf('archeryrange') + anyOf('stable') === 0;
    let savingForArm = false;
    if (arm && age >= AGE.FEUDAL && complete('barracks')) {
      const needVills = firstArm ? ARM_BUILDING_VILLAGERS : ARM2_BUILDING_VILLAGERS;
      const float = firstArm ? ARM_BUILDING_WOOD_FLOAT : ARM2_BUILDING_WOOD_FLOAT;
      const price = BUILDING_STATS[arm].cost.wood + float;
      if (villagers >= needVills) {
        if (wood >= price) wish(arm);
        // Not there yet, but close enough that saving is a matter of seconds
        // rather than of minutes: hold the fields back until it is paid for.
        //
        // This is the one place the wishlist saves up instead of spending on the
        // cheapest thing it wants, and it is here because the field is a
        // *standing* order. wantsFarm() goes true again within a minute of every
        // field that goes up, so 60 wood at a time is skimmed off the top
        // forever and a 205-wood building is never reached — which is exactly
        // what seed 12345 did: it spent the whole Feudal Age putting up its
        // eleventh field and finished the match with no ranged unit at all. A
        // player does the opposite without thinking about it: you stop making
        // farms for thirty seconds and you put the Range down.
        //
        // Bounded three ways, because starving the food line is the worse
        // failure: only the first arm earns it (a second is a luxury), only
        // above ARM_SAVING_FLOOR (below that the wait is minutes, not seconds),
        // and never while the type is backed off for want of ground — that last
        // one is the release valve that stops an Archery Range nobody can site
        // from quietly cancelling the farms for the rest of the match.
        else if (firstArm && wood >= ARM_SAVING_FLOOR &&
                 w.time >= (this.blockedUntil.get(arm) || 0)) savingForArm = true;
      }
    }

    // 3c. The Blacksmith, once there is an army the ten attack/armour techs can
    //     improve. It trains nothing, so it is pure upgrade money and it sits
    //     behind the building that puts a second arm on the map — but ahead of
    //     the fields, for the same standing-order reason as above.
    if (age >= AGE.FEUDAL && anyOf('blacksmith') === 0 && techsAt('blacksmith').length &&
        villagers >= BLACKSMITH_VILLAGERS && this.armySize() >= MILITARY_TECH_MIN_ARMY &&
        wood >= BUILDING_STATS.blacksmith.cost.wood + BLACKSMITH_WOOD_FLOAT) {
      wish('blacksmith');
    }

    // 3d. Castle Age. The Siege Workshop is the escalation for a base the waves
    //    cannot finish: a ram's +40 against masonry turns a 900-hitpoint Town
    //    Center from a two-minute chore into a thirty-second one, and that is
    //    the difference between a wave that razes a town and a wave that is
    //    still hitting a house when the march budget calls it home. It carries
    //    the heaviest gates on the list — Castle Age, sixteen villagers, an army
    //    already standing and 260 wood in the bank — because everything it
    //    trains is slow enough to arrive after the wave it left with.
    //
    //    It still sits *ahead* of the fields, for the reason the Archery Range
    //    does: wantsFarm() is a standing order that comes back true within a
    //    minute of every field, so 60 wood at a time is skimmed off the top
    //    forever and a 200-wood building behind it is never reached. Measured
    //    with this entry last on the list: the Castle Age landed at 9:09 and the
    //    AI spent the following three minutes putting up its thirteenth farm.
    if (age >= AGE.CASTLE && anyOf('siegeworkshop') === 0 &&
        villagers >= SIEGE_VILLAGERS && this.armySize() >= MILITARY_TECH_MIN_ARMY &&
        wood >= BUILDING_STATS.siegeworkshop.cost.wood + SIEGE_WOOD_FLOAT) {
      wish('siegeworkshop');
    }

    // 3e. The University, the day it is worth anything. Nothing in TECHS names it
    //    yet — every tech that exists is researched at a Town Center, a Mill, a
    //    Lumber Camp, a Mining Camp or a Blacksmith — so techsAt('university')
    //    is empty and this never fires. That is the honest answer rather than a
    //    missing entry: 200 wood for a building that would offer this AI nothing
    //    to research is 200 wood spent on scenery. Written as a test against the
    //    tech table rather than as a comment saying "add this later", so the day
    //    Ballistics or Masonry lands there the AI starts building one by itself
    //    — the same trick the `at` preference lists in tech.js are built on.
    if (age >= AGE.CASTLE && anyOf('university') === 0 && techsAt('university').length &&
        villagers >= UNIVERSITY_VILLAGERS &&
        wood >= BUILDING_STATS.university.cost.wood + UNIVERSITY_WOOD_FLOAT) {
      wish('university');
    }

    // 3f. Forward drop-offs. This sits ahead of farms because it is the cheaper
    //     fix for the same complaint: a farm converts wood into food, a camp
    //     converts a walk into everything. It is gated hard enough (see
    //     campWanted) that it can never take the wood a House or a field needs.
    const camp = this.campWanted();
    if (camp) wish(camp.type, camp.anchor);

    // 3g. Farms, from the moment the local berries thin out and for the rest of
    //     the match — a farm is consumed as fast as it is worked, so this is a
    //     standing order, not a one-off building. Suspended for the few seconds
    //     it takes to pay for the first Archery Range or Stable; see above, and
    //     note that the *starving* case at 1b is ahead of all of this and is
    //     never suspended.
    if (this.wantsFarm() && !savingForArm) wish('farm');

    // 4. Second barracks to feed bigger waves — but never while an arm we do not
    //    own is buildable, which is the ordering the old code got wrong for free
    //    when the Barracks was the only military building there was.
    //
    //    Both cost 175 wood and both add one production queue. The difference is
    //    that the second Barracks adds another queue making the same two units,
    //    and the Archery Range or Stable adds a queue making units this AI
    //    currently cannot put on the map at all. Measured on seed 12345 with
    //    this clause missing: the AI banked its way to 255 wood at 8:10, spent
    //    it on a second Barracks nine seconds before the Feudal Age landed, and
    //    then needed another eighty seconds to afford the Archery Range — so the
    //    match ended with eleven militia, ten spearmen and no ranged unit at all.
    //    Before the age-up the clause is inert (neither arm can train anything
    //    yet), so the old 330s escalation is untouched.
    //    The second half of the clause is the same thought about the sixty
    //    seconds *before* the age lands. An age-up already in the research queue
    //    is paid for and arrives in well under a minute, and the Archery Range
    //    it unlocks cannot be placed until it does — so wood spent on a second
    //    Barracks in that window is wood spent nine seconds before it had a
    //    strictly better home. That is not a hypothetical either: it is exactly
    //    what seed 12345 did.
    const armMissing = ARM_BUILDINGS.some((t) => BUILDING_STATS[t] && anyOf(t) === 0);
    const armPending = (age >= AGE.FEUDAL || this.ageUpInProgress()) && armMissing;
    if (w.time >= BARRACKS2_TIME && anyOf('barracks') === 1 && villagers >= 12 &&
        !armPending && wood >= BUILDING_STATS.barracks.cost.wood + 80) {
      wish('barracks');
    }

    // NO MONASTERY, deliberately. The monk is the one unit in the game with
    // `military: false`, and every piece of army machinery in this file reads
    // MILITARY_TYPES: militaryTrainers() would not count a Monastery as a
    // producer, armyCensus() would not count a monk, and manageArmy() would
    // leave one standing at the staging point for the rest of the match while
    // the wave-size arithmetic ignored it. A 175-wood building whose output
    // this AI cannot command is worse than no building, and healing wants a
    // "keep the monk behind the line" behaviour that does not exist here yet.
    // The unit and the building are both fine; it is the AI that is not ready,
    // and pretending otherwise would break the wave census to no benefit.

    return out;
  }

  /**
   * Which of the two Feudal arms to put down next: 'archeryrange', 'stable', or
   * null when both are standing (or being built).
   *
   * The choice is made by the same counter machinery that picks the next unit,
   * rather than by a hardcoded preference: each candidate is scored by the best
   * its roster can do against what the player is actually fielding, with the
   * default-mix weight as the tiebreaker. So a blind AI takes the Archery Range
   * first — the archer is the generalist arm and answers two of the three
   * armour classes — a player massing archers is answered with a Range for its
   * skirmishers, and a Stable follows as the second building, becoming the
   * obvious first pick again the moment the Castle Age puts a Knight in it.
   *
   * Units the current age forbids are skipped, so a Feudal Stable is judged on
   * the scout it can actually train and not on the Knight it cannot.
   */
  nextArmBuilding(anyOf) {
    let best = null;
    let bestScore = -Infinity;
    const foe = this.foeArmorMix();
    for (const type of ARM_BUILDINGS) {
      if (!BUILDING_STATS[type] || anyOf(type) > 0) continue;
      let score = -Infinity;
      for (const t of BUILDING_STATS[type].trains || []) {
        if (!MILITARY_TYPES.includes(t)) continue;
        if (!unitUnlocked(this.world, this.id, t)) continue;
        const s = (DEFAULT_MIX[t] || 0.1) +
          Math.min(COUNTER_CAP, COUNTER_WEIGHT * this.counterScore(t, foe));
        if (s > score) score = s;
      }
      if (score > bestScore) {
        bestScore = score;
        best = type;
      }
    }
    return bestScore === -Infinity ? null : best;
  }

  /** Soldiers of ours standing on the map. Not queued — see armyCensus. */
  armySize() {
    return this.myUnits().filter(isMilitary).length;
  }

  /**
   * Is an age-up sitting in one of our research queues right now?
   *
   * "Have we decided to age up" rather than "are we in the next age": the cost
   * has already left the stockpile and the age lands in fifty seconds, so
   * anything the next age unlocks is a better home for spare wood than anything
   * this one does. Read off the queue rather than remembered in a field so a
   * loaded save, where the AI's own memory of starting it is gone but the
   * research is still ticking, gives the same answer.
   */
  ageUpInProgress() {
    for (const b of this.myBuildings()) {
      for (const e of b.research || []) {
        const t = e && TECHS[e.id];
        if (t && t.advancesTo !== undefined) return true;
      }
    }
    return false;
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
    // Two builders on anything slow, one on everything else — read off the
    // build time rather than off a list of two type names. The old test named
    // the Barracks and the Town Center, which were the only slow buildings that
    // existed; the Archery Range, the Stable, the Blacksmith and the Siege
    // Workshop are all 38-50 seconds and would every one of them have been
    // built by a single villager, which is 45 seconds of one worker for a
    // building the wave schedule is waiting on.
    //
    // The threshold sits just under the Barracks' 38s, so it covers every 3x3
    // military and research building and leaves the Mill (24s), the camps (18s)
    // and the farms (15s) on one builder, where a second would only be two
    // villagers walking to save eight seconds.
    const s = BUILDING_STATS[foundation.type];
    const want = (s && (s.buildTime || 0) >= HEAVY_BUILD_TIME) ? 2 : 1;

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
    // Any building that trains a soldier, standing or still a foundation — the
    // gold-heavy split is a reaction to "we are about to start paying for an
    // army", and an Archery Range going up says that exactly as loudly as a
    // Barracks does. (Archers and knights are the two most gold-hungry units in
    // the game, so if anything the Range and the Stable say it louder.)
    const trainsSoldiers = (t) => {
      const s = BUILDING_STATS[t];
      return !!s && (s.trains || []).some((u) => MILITARY_TYPES.includes(u));
    };
    const wantsMilitary = this.myBuildings().some((b) => !b.dead && trainsSoldiers(b.type)) ||
      !!(this.pending && trainsSoldiers(this.pending.type));

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
    // GOLD IS THE RESOURCE THIS AI SYSTEMATICALLY OVER-MINES, and it costs it
    // the age-up. Measured over a twelve-minute match on seed 4242: 1100 gold
    // came out of the ground and 250 of it was ever spent, so the stockpile
    // climbed to 856 and three or four villagers spent the whole match digging
    // money nobody needed. Those same villagers on food are ~110 food a minute,
    // which is most of the surplus the 400-food age-up was waiting for — the AI
    // was not short of food, it was short of *people on food*.
    //
    // The 0.30 gold share was set when the Barracks trained the archer (45 gold
    // a body) and the roster was three units wide. The Barracks trains militia
    // (20 gold) and the spearman (none at all) now, so Dark Age gold demand is
    // barely a third of what this split was drawn for, and the money only starts
    // being worth digging again when a Range or a Stable is standing.
    //
    // Two steps rather than one so the workforce drains back gradually: at 250
    // banked there is a wave's worth of soldiers paid for and half the diggers
    // can go; at 450 there is a Castle Age (200 gold) and a wave on top of it,
    // and the rest can go. Both are thresholds on the *stockpile*, so the moment
    // knights and archers start drinking it the villagers walk back.
    //
    // Both thresholds move up by whatever an age-up we are currently saving for
    // is going to want. Gold that is already spoken for is not surplus, and
    // forgetting that is how the AI reached ten minutes holding 798 food, 227
    // gold and no Castle Age: the 200-gold half of the bill kept being mined
    // away by archers while the villagers who would have replaced it had been
    // sent to the berries by this very rule.
    const spoken = this.ageUpGoldBill();
    if (r.gold > GOLD_COMFORTABLE + spoken) shift(G, F, 0.15);
    if (r.gold > GOLD_SATURATED + spoken) shift(G, F, 0.15);
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
    // "Somewhere to train a soldier", not "a Barracks". The two meant the same
    // thing while the Barracks was the only military building in the game; now
    // an AI that lost its Barracks but still owns an Archery Range would have
    // been thrown back to the 16-villager opening cap with a full-sized army
    // still to feed. militaryTrainers() answers the question that was always
    // being asked.
    if (!this.militaryTrainers().length) return PRE_BARRACKS_VILLAGERS;
    const budget = (r.food || 0) + this.foodInGround() + this.farmPotential();
    let target = MAX_VILLAGERS;
    if (budget < 200) target = 8;
    else if (budget < 450) target = 11;
    // ...and no further while an age-up is due and unpaid. See AGE_PUSH_VILLAGERS.
    const push = this.ageUpPushCap();
    return push === null ? target : Math.min(target, push);
  }

  /**
   * The age-up this AI is currently saving for, or null when it is not saving
   * for one. The tech object, so the caller can read the bill off it.
   *
   * "Due and unpaid" is three separate things and all three matter:
   *   * the clock has come round (FEUDAL_AGE_TIME / CASTLE_AGE_TIME) and the
   *     age's own villager gate is met, so this is an age the AI actually
   *     intends to take rather than one it will get to eventually;
   *   * it cannot pay for it yet — the moment it can, manageTech buys it on the
   *     same pass and every hold below lifts by itself;
   *   * it has not already bought it. An age-up ticking down in a research queue
   *     is paid for, and holding anything back while it researches would be
   *     fifty seconds of not playing for nothing.
   *
   * Also stamps when the saving started, which is what the two deadlines below
   * are measured from. Stamped once per age and never restarted for the same
   * one, so a push that is not working expires instead of holding the AI down
   * for the rest of the match.
   */
  ageUpWanted() {
    const w = this.world;
    const id = nextAgeTech(w, this.id);
    if (!id) return null;
    const t = TECHS[id];
    if (!t) return null;
    const feudal = t.advancesTo === AGE.FEUDAL;
    const due = feudal ? FEUDAL_AGE_TIME : CASTLE_AGE_TIME;
    const need = feudal ? AGE_UP_VILLAGERS : AGE_UP_VILLAGERS_CASTLE;
    if (w.time < due) return null;
    if (this.myUnits('villager').length < need) return null;
    if (this.ageUpInProgress()) return null;
    if (this.affordWithReserve(t.cost, AGE_UP_RESERVE)) return null;
    if (!this.agePush || this.agePush.age !== t.advancesTo) {
      this.agePush = { age: t.advancesTo, since: w.time };
    }
    return t;
  }

  /** How long we have been saving for the current age-up. */
  ageSavingFor() {
    return this.agePush ? this.world.time - this.agePush.since : 0;
  }

  /**
   * The villager count to stop at because an age-up is waiting on the food, or
   * null when nothing is.
   *
   * Gated on the *bill*, not on a clock, and that is what makes it safe. A Town
   * Center that is not training is an economy that is not growing, so this may
   * never become a state the AI can be stuck in: it only engages once the
   * stockpile has already climbed past AGE_PUSH_FOOD_START of what the age
   * costs, which is evidence that the saving is working. On a map where the food
   * never arrives — the starvation scenario in tests/enemyai.test.mjs deletes
   * every berry near the base at 3:00 — the stockpile never gets there, the cap
   * never engages, and the AI goes on booming. With an earlier version of this
   * gated on a clock instead, that test finished with fourteen villagers and the
   * workforce frozen for seven minutes.
   */
  ageUpPushCap() {
    const t = this.ageUpWanted();
    if (!t) return null;
    if (!this.ageSavingPast(AGE_PUSH_FOOD_START)) return null;
    return t.advancesTo === AGE.FEUDAL ? AGE_PUSH_VILLAGERS : AGE_PUSH_VILLAGERS_CASTLE;
  }

  /** Is this fraction of the age-up's food bill already banked? */
  ageSavingPast(fraction) {
    const t = this.ageUpWanted();
    if (!t) return false;
    const bill = (t.cost.food || 0) + (AGE_UP_RESERVE.food || 0);
    return (this.res().food || 0) >= bill * fraction;
  }

  /**
   * Gold the age-up we are saving for is going to want, or 0 when we are not
   * saving for one. Read by desiredSplit, which must not send the last of the
   * miners to the berries while 200 gold of the bill is still in the ground.
   */
  ageUpGoldBill() {
    const t = this.ageUpWanted();
    if (!t) return 0;
    return (t.cost.gold || 0) + (AGE_UP_RESERVE.gold || 0);
  }

  /**
   * Are we close enough to an age-up that the army should stop eating? See
   * AGE_PUSH_FOOD_HOLD. False whenever there is no age being saved for, which
   * is most of the match.
   */
  ageSavingBitesArmy() {
    if (!this.ageUpWanted()) return false;
    // The one hold that keeps a clock, and it keeps it for the wave schedule
    // rather than for the economy: a wave that does not go out because there
    // were two soldiers missing is the most visible thing this AI can get wrong.
    if (this.ageSavingFor() > AGE_PUSH_MAX_HOLD) return false;
    return this.ageSavingPast(AGE_PUSH_FOOD_HOLD);
  }

  /** Every completed building of ours that can put a soldier on the map. */
  /**
   * Every finished building of ours that trains a soldier, **most expensive
   * roster first**.
   *
   * The order is the fix for "half the roster is never built", and the
   * measurement is unambiguous. Instrumented over twenty-five minutes on seed
   * 4242, the Siege Workshop's unit choice came back `null` on 418 of 421 passes
   * and the Stable's on 925 of 932: `ram: cannot afford wood` 573 times,
   * `knight: cannot afford food` 633 times, `mangonel: cannot afford wood+gold`
   * 578 times. The AI was not declining to build them, it was permanently broke
   * — because this list used to come back in *build order*, so the Barracks got
   * first refusal on the purse every think, spent it on a 60-food militia, and
   * the Castle Age buildings behind it saw an empty bank forever. Twenty-five
   * minutes of that is 47 militia, 29 archers, one knight and no siege at all.
   *
   * Sorting by the age of the best unit a building trains puts the Siege
   * Workshop and the Stable at the front of the queue, where a player would put
   * them: buy the expensive thing first and spend what is left on bodies. Ties
   * break on entity id so the order is total and stable — two Barracks must not
   * swap places between two identical matches.
   */
  militaryTrainers() {
    const list = this.myBuildings().filter(
      (b) => b.complete && !b.dead && (b.trains || []).some((t) => MILITARY_TYPES.includes(t)),
    );
    const tier = (b) => {
      let best = -1;
      for (const t of b.trains || []) {
        if (!MILITARY_TYPES.includes(t)) continue;
        const a = ageForUnit(t);
        if (a > best) best = a;
      }
      return best;
    };
    return list.sort((a, b) => tier(b) - tier(a) || a.id - b.id);
  }

  /** Soldiers the next wave wants, standing plus queued. */
  armyTarget() {
    const needed = Math.min(
      MAX_WAVE_SIZE,
      FIRST_WAVE_SIZE + this.waveNumber * WAVE_SIZE_STEP,
    );
    // Plus the home guard, which by definition does not go, plus a couple so the
    // AI is still training while a push is out rather than starting from nothing
    // every time one leaves.
    return needed + this.homeGuard(this.armySize()) + 2;
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

    // While an age-up is being saved for, the army stops growing past what the
    // next wave actually wants.
    //
    // Nothing otherwise stops this loop except the population cap, so the AI
    // fills every slot its houses open with whatever is cheapest — measured,
    // twenty-six soldiers against an armyTarget of eighteen — and the eight
    // extra are paid for out of the same food the age-up is waiting on. Eight
    // militia are 480 food, which is a Feudal Age, and on the seeds where the
    // Castle Age never arrived at all this was where it went: 250-350 food a
    // minute of soldiers the wave schedule had not asked for.
    //
    // Two things keep this from becoming the wave-cadence bug it looks like.
    // It only applies while there is an age to save for, so the ordinary state
    // of the match is unaffected; and what it counts is the soldiers *at home*,
    // because the squad currently out on a wave is spent whatever happens to it.
    // Counting the wave instead was measured at three waves in twelve minutes
    // with a two-hundred-second hole in the middle — the producer stood idle for
    // the whole attack and had nothing ready when the next one was due.
    if (this.ageUpWanted() && this.ageSavingFor() <= AGE_SAVING_MAX_HOLD) {
      const away = new Set(this.wave ? this.wave.ids : []);
      let athome = 0;
      for (const u of this.myUnits()) if (isMilitary(u) && !away.has(u.id)) athome++;
      for (const b of this.myBuildings()) {
        for (const q of b.queue || []) if (q && MILITARY_TYPES.includes(q.type)) athome++;
      }
      if (athome >= this.armyTarget()) return;
    }

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
   * Four filters, in the order they matter:
   *   0. the age has to allow it. A Feudal Stable trains a scout and not a
   *      Knight (AGE_UNITS in tech.js), and economy.queueTrain refuses anything
   *      else with a toast — so without this test the AI would ask for a Knight
   *      every think from the moment it owned a Stable, be refused every time,
   *      and paper the player's screen with someone else's error messages;
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
    // When food dries up the mix has to drift toward whatever does not eat.
    // That used to be the archer alone; the roster now has four food-free
    // soldiers (archer, ram, mangonel, scorpion), which is one more reason the
    // Archery Range is worth owning before the berries run out.
    const foodTight = (r.food || 0) < 120 && this.foodInGround() < 150;
    // The last stretch of an age-up is paid for out of the army's food as well
    // as the Town Center's. Bounded and rare — see AGE_PUSH_FOOD_HOLD — and it
    // does not stop the Archery Range or the Siege Workshop making the units
    // that cost no food, which is most of the reason to own them.
    const savingForAge = this.ageSavingBitesArmy();

    let best = null;
    let bestScore = -Infinity;
    for (const type of building.trains || []) {
      if (!MILITARY_TYPES.includes(type)) continue;
      if (!unitUnlocked(this.world, this.id, type)) continue;
      const cost = UNIT_STATS[type] && UNIT_STATS[type].cost;
      if (!cost) continue;
      if (!this.affordUnit(type, r)) continue;
      // Never spend the food the Town Center is queued on while we are still
      // growing the economy that pays for all of this.
      if (wantMoreVillagers && (cost.food || 0) > 0 &&
          r.food < (cost.food || 0) + UNIT_STATS.villager.cost.food) continue;
      if ((foodTight || savingForAge) && (cost.food || 0) > 0) continue;
      // The same rule for the other resource a soldier can drink. See
      // MILITARY_WOOD_RESERVE: an army is worth nothing if it costs the base
      // the House it was about to build, or the ability to stand back up.
      if ((cost.wood || 0) > 0 && r.wood < (cost.wood || 0) + this.woodReserve()) continue;
      // The ceiling. Only bites once there is an army to be lopsided about.
      if (total >= 4 && (have[type] || 0) / total >= MIX_CEILING) continue;
      // ...and the standing target, for the handful of types that need one. See
      // ROSTER_TARGET: MIX_CEILING is a share of the whole army, which a two-ram
      // escort never comes close to, so without this the Siege Workshop would
      // build rams and nothing else for the rest of the match.
      if (ROSTER_TARGET[type] !== undefined && (have[type] || 0) >= ROSTER_TARGET[type]) continue;

      // A type with a standing target is worth less the closer it is to it,
      // which is what interleaves the Siege Workshop's roster instead of having
      // it build two rams and then two mangonels. Measured with a flat weight:
      // the Workshop built rams until the pair was standing, and the day one
      // died it built another — so the mangonel, which is the better of the two
      // against an army, never appeared at all.
      const room = ROSTER_TARGET[type] === undefined
        ? 1 : 1 - (have[type] || 0) / ROSTER_TARGET[type];
      const score = (DEFAULT_MIX[type] || 0.1) * room
        + Math.min(COUNTER_CAP, COUNTER_WEIGHT * this.counterScore(type, foe))
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
        if (!unitUnlocked(this.world, this.id, type)) continue;
        if (!this.affordUnit(type, r)) continue;
        const cost = UNIT_STATS[type].cost;
        if ((foodTight || savingForAge) && (cost.food || 0) > 0) continue;
        if ((cost.wood || 0) > 0 && r.wood < (cost.wood || 0) + this.woodReserve()) continue;
        if (ROSTER_TARGET[type] !== undefined && (have[type] || 0) >= ROSTER_TARGET[type]) continue;
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

    // 1b. ...and while we are saving for one, nothing else is bought at all.
    //
    //     The age was already "first" in this pass, and first was not enough: it
    //     is also the most expensive thing on the list by a factor of three, so
    //     every cheaper upgrade behind it kept skimming the food off the top and
    //     the total never arrived. Measured on seed 4242 after the Feudal Age
    //     landed: 175, 150, 300 and 100 food of Feudal-tier upgrades bought in
    //     four consecutive minutes while the stockpile sat between 120 and 190,
    //     and the 600-food Castle Age never happened on any seed. Forging is
    //     worth +1 attack; the Castle Age is worth the Knight, the Siege
    //     Workshop and everything in them.
    //
    //     Bounded by the same three tests as the workforce cap — clock, villager
    //     gate, not already bought — so an AI that is not saving for anything
    //     shops exactly as it did before.
    //     The research hold gets a much longer leash than the workforce cap
    //     above it, and it can afford one: not buying Forging costs the AI +1
    //     attack, while not training villagers costs it the economy. Two
    //     hundred seconds is long enough to save for a 600-food Castle Age out
    //     of a mid-game surplus, which the ninety-second cap is not — measured
    //     on seed 777, whose Feudal Age lands at 6:22 and which then spent its
    //     entire Castle Age fund on Feudal upgrades the moment the short clock
    //     expired, and never aged again.
    if (this.ageUpWanted() && this.ageSavingFor() <= AGE_SAVING_MAX_HOLD) return;

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

    const inWave = new Set(this.wave ? this.wave.ids : []);
    const reserves = army.filter((u) => !inWave.has(u.id));
    const s = this.staging || this.home;

    if (this.defending) {
      // The home guard — everything not committed to the push — answers.
      const point = this.threat || this.home;
      const rally = reserves.filter((u) => !this.awaitingOrder(u) &&
        (this.idle(u) || dist(u.x, u.y, point.x, point.y) > 16));
      if (rally.length) {
        this.command(rally, { type: 'attack', gx: point.x, gy: point.y, target: this.nearestFoeNear(point) });
      }
      // The push turns round only for a raid the guard is losing to. See
      // RECALL_OUTNUMBERED: cancelling an attack because something is standing
      // in the wood line is how two of these AIs spend a match walking their
      // armies past each other in opposite directions.
      if (this.wave && this.overrunAtHome(reserves)) {
        this.recallWave(w.time + WAVE_BREATHER);
        return;
      }
      if (!this.wave) return;   // nothing out there to keep driving
    } else {
      // Fresh soldiers gather at the staging point instead of trickling out.
      const strays = reserves.filter(
        (u) => this.idle(u) && dist(u.x, u.y, s.x, s.y) > 3.0,
      );
      if (strays.length) this.command(strays, { type: 'move', gx: s.x, gy: s.y });
    }

    // Keep every military building's rally on the staging point too, for
    // whatever honours it. Hardcoding 'barracks' here meant a Stable's cavalry
    // came out of the door with no rally at all and waited for manageArmy to
    // notice them the slow way, one strays-pass at a time.
    for (const b of this.militaryTrainers()) {
      if (!b.rally || dist(b.rally.x || b.rally.gx || 0, b.rally.y || b.rally.gy || 0, s.x, s.y) > 2) {
        b.rally = { x: s.x, y: s.y, gx: s.x, gy: s.y };
      }
    }

    if (this.wave) {
      this.driveWave();
      // A push that is still out when the next beat comes round is reinforced
      // rather than left to finish alone — see reinforceWave.
      if (this.wave && !this.defending) this.reinforceWave(reserves);
      return;
    }
    if (this.defending) return;

    // Launch conditions: it is time, and we have a real squad — never dribs.
    const readyAt = reserves.filter((u) => dist(u.x, u.y, s.x, s.y) <= 9);
    const overdue = w.time - this.nextWaveTime;
    if (overdue < 0) return;
    const guard = overdue >= PUSH_PATIENCE * 2 ? 0 : this.homeGuard(army.length);
    const commit = readyAt.length - guard;
    if (commit >= this.waveBar(overdue)) this.launchWave(readyAt.slice(0, commit));
  }

  /**
   * How many soldiers a launch needs at the staging point, over and above the
   * home guard.
   *
   * The first term is the escalation the design promises — five, then seven,
   * then nine, up to MAX_WAVE_SIZE. The rest is the release valve, and it is not
   * optional: everything else in this file is a reason to wait, and an AI that
   * can always find one holds its army at home for the whole match. Past
   * PUSH_PATIENCE the bar halves; past twice it the AI attacks with whatever is
   * standing there, guard and all. See PUSH_PATIENCE.
   */
  waveBar(overdue) {
    const full = Math.min(
      MAX_WAVE_SIZE,
      FIRST_WAVE_SIZE + this.waveNumber * WAVE_SIZE_STEP,
    );
    if (overdue < PUSH_PATIENCE) return full;
    if (overdue < PUSH_PATIENCE * 2) return Math.max(FIRST_WAVE_SIZE, Math.ceil(full * 0.5));
    return 3;
  }

  /** Soldiers kept back to answer a raid. See HOME_GUARD_SHARE. */
  homeGuard(armySize) {
    if (armySize < HOME_GUARD_FROM) return 0;
    const want = Math.round(armySize * HOME_GUARD_SHARE);
    return Math.min(HOME_GUARD_MAX, Math.max(HOME_GUARD_MIN, want));
  }

  /** Is the raid at home bigger than what is left to meet it? */
  overrunAtHome(reserves) {
    const t = this.threat;
    if (!t) return false;
    return t.count >= Math.max(2, reserves.length * RECALL_OUTNUMBERED);
  }

  /** Call the push home and put the next one on the clock. */
  recallWave(nextAt, wiped = false) {
    const w = this.world;
    const wave = this.wave;
    this.wave = null;
    if (!wave) return;
    if (wiped) {
      this.stats.wavesWiped++;
      this.lostLastWave = true;
    }
    const alive = wave.ids.map((id) => w.entities.get(id)).filter((u) => isMilitary(u));
    this.stats.pushLog.push({
      t: Math.round(w.time), peak: wave.peak || wave.size,
      kills: wave.kills || 0, left: alive.length,
    });
    if (alive.length) {
      const s = this.staging || this.home;
      this.command(alive, { type: 'move', gx: s.x, gy: s.y });
    }
    this.nextWaveTime = Math.max(this.nextWaveTime, nextAt);
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
  chooseWaveTarget(from, raiding = false) {
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

    // Buildings, weighted by what losing one actually costs them — see the
    // TARGET_* table. Villagers are the fallback and nothing else: they are the
    // one candidate that runs away, and a squad sent after one spends its whole
    // budget walking. They still die in numbers, because the push attack-moves
    // into the middle of the base and combat.js puts bodies ahead of masonry.
    // How close they are to being out of the match. See FINISH_THEM_TRAINERS.
    let trainers = 0;
    for (const b of foeBuildings) {
      const st = BUILDING_STATS[b.type];
      if (!b.dead && st && (st.trains || []).length) trainers++;
    }
    const finishing = trainers > 0 && trainers <= FINISH_THEM_TRAINERS;
    const candidates = [];
    for (const b of foeBuildings) {
      if (b.dead) continue;
      let bonus = this.targetWeight(b, raiding && !finishing);
      if (finishing) {
        const st = BUILDING_STATS[b.type];
        if (st && (st.trains || []).length) bonus *= FINISH_WEIGHT;
      }
      candidates.push({ e: b, bonus });
    }
    if (!candidates.length) {
      for (const u of foeUnits) {
        if (u.type === 'villager' && !isGarrisoned(u)) {
          candidates.push({ e: u, bonus: TARGET_VILLAGER });
        }
      }
    }
    if (!candidates.length) return null;

    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const approach = dist(from.x, from.y, c.e.x, c.e.y);
      const exposure = guard ? dist(c.e.x, c.e.y, guard.x, guard.y) : 10;
      // Close to us, far from their army, and juicy — with "juicy" now able to
      // outvote the other two rather than being drowned by them. At the old
      // coefficients a farm on the far side of the base beat the Barracks in the
      // middle of it by six points of exposure, which is how a push that razed
      // nine houses and eight fields left the one building that was keeping its
      // owner in the match standing.
      const score = c.bonus * TARGET_WEIGHT + Math.min(exposure, 16) * 0.5 - approach * 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = c.e;
      }
    }
    return best;
  }

  /** What breaking this building is worth to us. See the TARGET_* table. */
  targetWeight(b, raiding = false) {
    const s = BUILDING_STATS[b.type];
    const eco = (b.dropoff && b.dropoff.length) || b.type === 'farm';
    const trains = !!s && (s.trains || []).some((t) => MILITARY_TYPES.includes(t));
    if (raiding) {
      if (b.type === 'towncenter') return RAID_TOWNCENTER;
      if (trains) return RAID_TRAINER;
      return eco ? RAID_ECONOMY : RAID_OTHER;
    }
    if (b.type === 'towncenter') return TARGET_TOWNCENTER;
    if (trains) return TARGET_TRAINER;
    return eco ? TARGET_ECONOMY : TARGET_OTHER;
  }

  launchWave(units) {
    const w = this.world;
    if (!units.length) return;
    const from = units.reduce(
      (a, u) => ({ x: a.x + u.x / units.length, y: a.y + u.y / units.length }),
      { x: 0, y: 0 },
    );
    // A squad this small cannot break a base and should not be thrown at one.
    // See RAID_SQUAD.
    const raiding = units.length < RAID_SQUAD;
    const target = this.chooseWaveTarget(from, raiding);
    if (!target) {
      // Nothing left to hit; try again shortly.
      this.nextWaveTime = w.time + 20;
      return;
    }

    this.wave = {
      ids: units.map((u) => u.id),
      target,
      raiding,
      launchedAt: w.time,
      lastOrder: w.time,
      size: units.length,
      // The posture the push is in — 'advance' (attack-move, fight what you
      // meet) or 'siege' (chop the objective). See driveWave.
      mode: null,
      modeSince: w.time,
      peak: units.length,
      // Objectives destroyed. The only thing that buys a push more time.
      kills: 0,
      // Absolute time this push is written off at: the walk the squad actually
      // has to make, at the pace of its slowest member, plus a fight. Extended
      // by every objective it destroys. See WAVE_FIGHT_TIME.
      deadline: w.time + this.marchBudget(units, from, target) + WAVE_FIGHT_TIME,
    };
    this.waveNumber++;
    this.stats.wavesLaunched++;
    this.stats.lastWaveSize = units.length;
    // What actually walked out of the gate, by type.
    //
    // This used to be two numbers, `militia` and "everything else, called
    // archers" — which was true of a two-unit roster and became a lie the moment
    // there were nine. A wave of five spearmen was logged as four archers, which
    // is precisely the sort of report that lets a regression like "the AI has
    // not trained a ranged unit in six minutes" sit unnoticed in the test output.
    //
    // Built by walking MILITARY_TYPES rather than the squad, so the key order is
    // the roster's order in every log line — the wave log goes into the
    // determinism fingerprint, and key order is part of what JSON.stringify
    // compares. Types with nobody in them are left out so the line stays short.
    this.logDispatch(units);
    // Schedule the next beat from this launch, so the cadence is steady.
    this.nextWaveTime = w.time + this.waveInterval();
    this.wave.mode = 'advance';
    this.orderPush(units, this.wave, 'advance');
  }

  /** One line in the wave log per dispatch — a launch or a reinforcement. */
  logDispatch(units) {
    const mix = {};
    for (const t of MILITARY_TYPES) {
      let n = 0;
      for (const u of units) if (u.type === t) n++;
      if (n) mix[t] = n;
    }
    this.stats.waveLog.push({
      t: Math.round(this.world.time), size: units.length, mix,
      // Kept beside the mix because the wave report has always printed them:
      // both are now honest counts of their own type rather than a split.
      militia: mix.militia || 0, archers: mix.archer || 0,
      // True when the previous wave died out there, so this one waited for a
      // full rebuild rather than keeping the normal beat.
      afterLoss: this.lostLastWave,
      // True when these men joined a push that was already fighting.
      reinforcement: !!this.wave && this.wave.launchedAt !== this.world.time,
    });
    this.lostLastWave = false;
  }

  /**
   * Feed a push that is still fighting when the next beat comes round.
   *
   * The alternative — which is what this AI did — is that the whole producer
   * output sits at the staging point until the squad already out there gives up
   * and walks eighty tiles home. Measured on seed 4242 at minute 25: forty-one
   * soldiers standing at home and sixteen in the field. Reinforcing keeps one
   * front instead of two half-armies, and keeps the dispatch cadence honest:
   * every entry in the wave log is still a group of soldiers leaving on
   * schedule, it is simply joining a fight rather than starting one.
   */
  reinforceWave(reserves) {
    const w = this.world;
    const wave = this.wave;
    if (w.time < this.nextWaveTime) return;
    const s = this.staging || this.home;
    const guard = this.homeGuard(this.armySize());
    const readyAt = reserves.filter((u) => dist(u.x, u.y, s.x, s.y) <= 9);
    const spare = readyAt.length - guard;
    if (spare < REINFORCE_MIN) return;
    const squad = readyAt.slice(0, spare);

    const from = squad.reduce(
      (a, u) => ({ x: a.x + u.x / squad.length, y: a.y + u.y / squad.length }),
      { x: 0, y: 0 },
    );
    const march = this.marchBudget(squad, from, wave.target);
    // A push that has destroyed nothing does not get fed. Its budget is about to
    // run out, these men would arrive after it had walked home, and four at a
    // time across eighty tiles is the "feeding them in one unit at a time"
    // failure the wave system exists to avoid. They stay and the next launch
    // goes out as one group.
    if (!wave.kills && w.time + march > wave.deadline) return;

    for (const u of squad) wave.ids.push(u.id);
    wave.size += squad.length;
    // Enough men have now gone that this is an assault, not a raid.
    if (wave.ids.length >= RAID_SQUAD) wave.raiding = false;
    // Fresh troops buy the push the time to arrive, and a fight when they do —
    // but only a push that is winning gets the fight as well as the walk.
    wave.deadline = Math.max(
      wave.deadline, w.time + march + (wave.kills ? WAVE_FIGHT_TIME : 0),
    );
    this.stats.lastWaveSize = squad.length;
    this.logDispatch(squad);
    this.nextWaveTime = w.time + this.waveInterval();
    this.command(squad, { type: 'attackMove', ...this.pushGoal(wave) });
  }

  /**
   * Where a push walks to: a couple of tiles short of the objective, on our side
   * of it. The objective's own centre tile is inside a building footprint and
   * nothing can stand on it.
   *
   * Taken off our own base rather than off the squad's current position on
   * purpose — the answer has to be the same every time it is asked, or every
   * re-issue sends the squad to a slightly different tile and the whole group
   * spends the fight re-pathing.
   */
  pushGoal(wave) {
    const t = wave.target;
    const home = this.staging || this.home;
    let vx = home.x - t.x;
    let vy = home.y - t.y;
    const len = hyp(vx, vy);
    if (!(len > 0.001)) return { gx: t.x, gy: t.y };
    vx /= len;
    vy /= len;
    return { gx: t.x + vx * SIEGE_STANDOFF, gy: t.y + vy * SIEGE_STANDOFF };
  }

  /**
   * Put a squad in one of the push's two postures.
   *
   *   advance  attack-move at the objective. Units stop for whatever they meet,
   *            combat.js does the acquiring, and they carry on afterwards.
   *   siege    an ordered attack on the objective itself, which is the only way
   *            the AI gets to choose *what* falls — combat.js's own acquisition
   *            deliberately puts buildings last, so a squad left to itself
   *            chews on the nearest house rather than the Barracks that keeps
   *            the enemy in the match.
   *
   * The posture is never held for less than SIEGE_MODE_HOLD, because switching
   * costs every unit in the squad a re-order, and a defender walking in and out
   * of SIEGE_CLEAR_RADIUS would otherwise flap the whole army twice a second.
   */
  orderPush(units, wave, mode) {
    if (!units.length) return;
    const t = wave.target;
    const siege = { type: 'attack', target: t, gx: t.x, gy: t.y };
    if (mode === 'siege') {
      this.command(units, siege);
      return;
    }
    // Advancing, but the wall-breakers that have arrived start on the wall.
    //
    // A ram is not a soldier — 3 attack, 3-second swing — and putting one in an
    // attack-move means a 160-wood siege engine walking up to a militia to lose
    // a duel it cannot win. Its +40 against masonry is the entire unit, and it
    // is the one thing on the roster that finishes a Town Center in half a
    // minute. So the moment it is in reach of the objective it hits the
    // objective, whatever is going on around it; the escort is what the rest of
    // the squad is for.
    const breaking = [];
    const marching = [];
    for (const u of units) {
      if (BREAKERS.includes(u.type) && dist(u.x, u.y, t.x, t.y) <= SIEGE_ENGAGE) breaking.push(u);
      else marching.push(u);
    }
    if (breaking.length) this.command(breaking, siege);
    if (marching.length) this.command(marching, { type: 'attackMove', ...this.pushGoal(wave) });
  }

  /** Buildings of theirs that can still train something. See checkVictory. */
  foeTrainers() {
    let n = 0;
    for (const b of ownedBy(this.world, this.foeId, 'building')) {
      if (b.dead) continue;
      const s = BUILDING_STATS[b.type];
      if (s && (s.trains || []).length) n++;
    }
    return n;
  }

  /** Enemy soldiers within `r` of a point — what keeps a push out of siege mode. */
  foeSoldiersNear(point, r) {
    let n = 0;
    forEachNear(this.world, point.x, point.y, r, (e) => {
      if (e.kind !== 'unit' || e.player !== this.foeId) return;
      if (!MILITARY_TYPES.includes(e.type) || isGarrisoned(e)) return;
      n++;
    });
    return n;
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
      this.recallWave(w.time + WAVE_REGROUP_AFTER_LOSS, true);
      return;
    }

    wave.peak = Math.max(wave.peak || 0, alive.length);
    if (wave.peak > this.stats.maxPushPeak) this.stats.maxPushPeak = wave.peak;

    // "They are one building from losing the match, and this squad is the one
    // taking it down."
    //
    // Both halves matter. A trainer count alone is not an endgame — for the
    // first two minutes of every match the enemy owns a Town Center and nothing
    // else — so the push also has to have destroyed something itself. Without
    // that clause a squad parked outside an untouched base reads as a squad
    // about to win, and never comes home at all: measured, that is exactly what
    // it did, and the AI launched twice in ten minutes.
    //
    // What it buys is the two recalls below. Walking eighty tiles home from in
    // front of the last Barracks hands its owner the ninety seconds they need to
    // put up another one, and then the same squad has to walk back — which is
    // how a side that had been winning since the eighth minute took until the
    // twenty-sixth to finish. It stays bounded either way: the remnant takes the
    // last trainer down, or it is wiped doing it.
    const finishing = this.foeTrainers() <= FINISH_THEM_TRAINERS &&
      wave.kills > 0 && alive.length >= 3;

    // Bled out — pull the survivors home rather than feeding them in. The next
    // dispatch stays on the beat set at launch: only a wave that died to the
    // last man buys the defender a full rebuild cycle.
    if (!finishing &&
        alive.length <= Math.max(1, Math.floor(wave.peak * WAVE_BLED_SHARE)) && wave.peak >= 4) {
      this.lostLastWave = true;
      this.recallWave(w.time + WAVE_BREATHER);
      return;
    }

    if (w.time > wave.deadline) {
      // Out of budget — come home. The next wave stays on the beat set at
      // launch; only a wipe earns a longer pause. (Unless it is finishing them,
      // as above.)
      if (!finishing) {
        this.recallWave(w.time + WAVE_BREATHER);
        return;
      }
      wave.deadline = w.time + WAVE_FIGHT_TIME;
    }

    // The vanguard: whoever has actually arrived. Everything below is decided
    // from them and not from the squad's average position, and that distinction
    // is worth a paragraph because getting it wrong cost the AI every siege it
    // ever started. A reinforcement dispatched on the beat is eighty tiles
    // behind the front; average it in and the "are we there yet" test reads 51
    // tiles when the men doing the fighting are standing on the Town Center.
    // Traced on seed 1337, that is exactly what happened: the vanguard reached
    // 13 tiles, the reinforcement left home, and the push spent the rest of its
    // budget believing it was still on the road.
    const target = wave.target;
    const front = alive.filter((u) => dist(u.x, u.y, target.x, target.y) <= SIEGE_ENGAGE);
    const rear = alive.filter((u) => dist(u.x, u.y, target.x, target.y) > SIEGE_ENGAGE);
    const centre = (front.length ? front : alive).reduce(
      (a, u, _i, arr) => ({ x: a.x + u.x / arr.length, y: a.y + u.y / arr.length }),
      { x: 0, y: 0 },
    );

    // The objective fell. That is the one thing that buys more time — a push
    // that is taking a base apart is not on a clock, a push that is bouncing
    // off it is.
    if (!liveIn(w, target)) {
      wave.kills++;
      this.stats.objectivesRazed++;
      wave.deadline = Math.max(wave.deadline, w.time + WAVE_KILL_EXTENSION);
      const next = this.chooseWaveTarget(centre, wave.raiding);
      if (!next) {
        // Nothing of theirs left standing anywhere. Regroup and look again.
        this.recallWave(w.time + WAVE_BREATHER);
        return;
      }
      wave.target = next;
      wave.mode = 'advance';
      wave.modeSince = w.time;
      wave.lastOrder = w.time;
      this.orderPush(alive, wave, 'advance');
      return;
    }

    // Posture. The vanguard chops the objective once it is on top of it and
    // nothing is left to shoot at it; everyone else is still marching, and a
    // marching unit is always attack-moving so that it fights what it meets.
    const defenders = this.foeSoldiersNear(target, SIEGE_CLEAR_RADIUS);
    const want = (front.length >= 2 &&
      dist(centre.x, centre.y, target.x, target.y) <= SIEGE_RANGE &&
      defenders * SIEGE_OVERWHELM <= front.length) ? 'siege' : 'advance';
    if (want !== wave.mode && w.time - wave.modeSince >= SIEGE_MODE_HOLD) {
      wave.mode = want;
      wave.modeSince = w.time;
      wave.lastOrder = w.time;
      this.orderPush(front, wave, want);
      if (rear.length) this.orderPush(rear, wave, 'advance');
      return;
    }

    // Re-issue every couple of seconds to anyone who has gone idle, so the
    // group keeps moving as one instead of stalling on a pathing hiccup.
    if (w.time - wave.lastOrder > 2.5) {
      const slack = alive.filter((u) => this.idle(u));
      if (slack.length) {
        const near = slack.filter((u) => dist(u.x, u.y, target.x, target.y) <= SIEGE_ENGAGE);
        const far = slack.filter((u) => dist(u.x, u.y, target.x, target.y) > SIEGE_ENGAGE);
        if (near.length) this.orderPush(near, wave, wave.mode === 'siege' ? 'siege' : 'advance');
        if (far.length) this.orderPush(far, wave, 'advance');
      }
      wave.lastOrder = w.time;
    }
  }

  waveInterval() {
    return this.world.rng.range(WAVE_INTERVAL_MIN, WAVE_INTERVAL_MAX);
  }

  /**
   * How long this particular squad needs just to *get there*, at the pace of its
   * slowest member — the walk, before any of the fighting.
   *
   * Measuring it per push rather than holding one number is what stops the recall
   * firing on units that are simply still walking: the roster spans 1.7 tiles a
   * second (a scout) down to 0.6 (a mangonel), so one flat figure cannot be right
   * for two of them at once, and the figure that was right for a militia was five
   * seconds short for the spearman the Barracks trains today. A quarter is added
   * for the pathing around a base and the stragglers; the *fight* is a separate
   * budget on top (WAVE_FIGHT_TIME), which is the whole point of the split.
   */
  marchBudget(units, from, target) {
    let slowest = Infinity;
    for (const u of units) {
      const s = UNIT_STATS[u.type];
      const v = s && s.speed > 0 ? s.speed : 1;
      if (v < slowest) slowest = v;
    }
    if (!Number.isFinite(slowest) || slowest <= 0) slowest = 1;
    const march = dist(from.x, from.y, target.x, target.y) / slowest;
    return Math.max(WAVE_MARCH_MIN, march * 1.25);
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
          peak: this.wave.peak,
          kills: this.wave.kills || 0,
          raiding: !!this.wave.raiding,
          mode: this.wave.mode || null,
          modeSince: this.wave.modeSince,
          deadline: this.wave.deadline,
          arrived: !!this.wave.arrived,
        }
        : null,
      agePush: this.agePush ? { ...this.agePush } : null,
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
          peak: data.wave.peak || data.wave.size,
          kills: data.wave.kills || 0,
          raiding: !!data.wave.raiding,
          mode: data.wave.mode || null,
          modeSince: Number.isFinite(data.wave.modeSince)
            ? data.wave.modeSince : data.wave.launchedAt,
          // A save written before a push carried an absolute deadline comes back
          // with the old flat timeout measured from launch, which is the
          // behaviour it was saved under.
          deadline: Number.isFinite(data.wave.deadline)
            ? data.wave.deadline
            : data.wave.launchedAt +
              (Number.isFinite(data.wave.timeout) ? data.wave.timeout : WAVE_MARCH_MIN),
          arrived: !!data.wave.arrived,
        };
      }
    }
    this.agePush = data.agePush ? { ...data.agePush } : null;
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
