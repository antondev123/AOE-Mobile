// Headless 10-minute skirmish, driving the same systems GameScene.simStep()
// drives: reindex -> updateUnits -> updateCombat -> updateEconomy -> enemyAI.
//
//   node tests/enemyai.test.mjs
//
// If src/systems/{economy,unitAI,combat}.js are not written yet, the loader
// hook in enemyai.loader.mjs substitutes local stubs so the enemy AI can still
// be verified end to end. The test itself is identical either way — when the
// real modules land, re-run and it exercises them.

import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

register('./enemyai.loader.mjs', import.meta.url);

const SRC = new URL('../src/', import.meta.url);
const realModule = (rel) => existsSync(fileURLToPath(new URL(rel, SRC)));

const { createWorld, reindex, ownedBy, recomputePop, spawnUnit, spawnBuilding, removeEntity } =
  await import('../src/core/world.js');
const { generateMap } = await import('../src/core/mapgen.js');
const { SIM_DT, PLAYER, ENEMY, MAX_POP_CAP } = await import('../src/core/constants.js');
const { EV } = await import('../src/core/events.js');
const { updateUnits } = await import('../src/systems/unitAI.js');
const { updateCombat } = await import('../src/systems/combat.js');
const { updateEconomy } = await import('../src/systems/economy.js');
const { createEnemyAI } = await import('../src/systems/enemyAI.js');

// Which modules the run actually used. ENEMYAI_STUBS=1 forces the stubs even
// when the real files are present (see enemyai.loader.mjs).
const FORCED = !!process.env.ENEMYAI_STUBS;
const REAL = {
  economy: !FORCED && realModule('systems/economy.js'),
  unitAI: !FORCED && realModule('systems/unitAI.js'),
  combat: !FORCED && realModule('systems/combat.js'),
};

const STEPS = 12000; // 12000 * (1/20)s = 600s = 10 minutes of sim time
// How close an enemy soldier has to be to the player's Town Center to count as
// "there is a war on in my town". Twelve tiles is the width of a base.
const PRESSURE_RADIUS = 12;

/** A value that must be identical for two matches on the same seed. */
function fingerprint(r) {
  return JSON.stringify({
    vill: r.endVillagers,
    army: r.endArmy,
    militia: r.militia,
    archers: r.archers,
    buildings: r.buildings.slice().sort(),
    waves: r.stats.waveLog,
    reached: r.stats.wavesReachedBase,
    res: Object.fromEntries(
      Object.entries(r.world.players[ENEMY].resources).map(([k, v]) => [k, Math.round(v)]),
    ),
  });
}

// --- tiny harness -----------------------------------------------------------

let failures = 0;
const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push(['PASS', name, '']);
  } catch (err) {
    failures++;
    checks.push(['FAIL', name, err.message.split('\n')[0]]);
  }
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

// --- the run ----------------------------------------------------------------

/**
 * @param {object} opts
 * @param {number} opts.seed
 * @param {boolean} [opts.raid] send a scripted player raid at the enemy base,
 *   to exercise the AI's defensive recall.
 * @param {boolean} [opts.propUp] keep the player's town alive all match, so the
 *   full wave schedule can be observed instead of ending at the first kill.
 *
 *   IT REBUILDS THE TOWN CENTER RATHER THAN MAKING IT INVULNERABLE, and the
 *   difference is not cosmetic. The AI's push now presses until it stops making
 *   progress and comes home when it does (see WAVE_KILL_EXTENSION in
 *   enemyAI.js), so a punchbag that cannot be destroyed is a punchbag that
 *   teaches it nothing: measured against the old immortal Town Center, the AI
 *   launched twice in ten minutes and stood outside a building it could not
 *   dent for three of them. A town that falls and is put straight back up is the
 *   thing the test was always trying to be — a player who keeps losing buildings
 *   and keeps rebuilding — and it exercises the retarget, the kill extension and
 *   the reinforcement flow that a real match runs on.
 * @param {number} [opts.razeAt] raze the enemy's Town Center and Barracks at
 *   this sim time, to check it rebuilds instead of softlocking.
 * @param {number} [opts.starveAt] strip every berry within STARVE_RADIUS of the
 *   enemy Town Center at this sim time — the 4:00 food cliff, forced. With farms
 *   the AI has to trade wood for food and keep growing; without them it stalls.
 */
function runMatch({
  seed, raid = false, propUp = false, razeAt = 0, starveAt = 0, verbose = false,
}) {
  const world = createWorld(seed);
  generateMap(world);
  recomputePop(world, PLAYER);
  recomputePop(world, ENEMY);

  const ai = createEnemyAI(world, ENEMY);

  const m = {
    seed,
    villagersTrained: 0,
    militaryTrained: 0,
    built: {},
    popViolations: [],
    maxPop: 0,
    minDistToPlayerBase: Infinity,
    firstContactTime: null,
    playerLostAt: null,
    defendedTicks: 0,
    timeline: [],
    thrown: null,
  };

  world.events.on(EV.TRAINED, (p) => {
    const u = p && (p.unit || p.entity);
    const type = (p && p.unitType) || (u && u.type);
    const owner = (p && p.building && p.building.player) ?? (u && u.player);
    if (owner !== ENEMY) return;
    if (type === 'villager') m.villagersTrained++;
    else m.militaryTrained++;
  });
  world.events.on(EV.BUILT, (p) => {
    const b = p && p.building;
    if (!b || b.player !== ENEMY) return;
    m.built[b.type] = (m.built[b.type] || 0) + 1;
  });

  const startVillagers = ownedBy(world, ENEMY, 'unit', 'villager').length;
  const playerTC = ownedBy(world, PLAYER, 'building', 'towncenter')[0];
  const playerBase = playerTC ? { x: playerTC.x, y: playerTC.y } : { x: 9, y: 9 };

  let raided = false;
  let razed = false;
  let starved = false;
  const STARVE_RADIUS = 20;
  m.minFoodAfterStarve = Infinity;
  m.farmFood = 0;
  world.events.on(EV.GATHER_TICK, (p) => {
    // Food harvested out of a field rather than out of the ground.
    if (!p || !p.node || p.node.kind !== 'building') return;
    if (!p.unit || p.unit.player !== ENEMY) return;
    m.farmFood += p.amount;
  });

  try {
    for (let step = 0; step < STEPS; step++) {
      for (const u of world.units) {
        u.px = u.x;
        u.py = u.y;
      }

      reindex(world);
      updateUnits(world, SIM_DT);
      updateCombat(world, SIM_DT);
      updateEconomy(world, SIM_DT);
      ai.update(SIM_DT);

      world.time += SIM_DT;
      world.tick++;

      // --- observation -----------------------------------------------------
      const p = world.players[ENEMY];
      let pop = 0;
      for (const u of ownedBy(world, ENEMY, 'unit')) pop += 1;
      for (const b of ownedBy(world, ENEMY, 'building')) pop += b.queue ? b.queue.length : 0;
      if (pop > m.maxPop) m.maxPop = pop;
      if (pop > p.popCap) {
        m.popViolations.push({ t: +world.time.toFixed(1), pop, cap: p.popCap });
      }

      let near = false;
      for (const u of ownedBy(world, ENEMY, 'unit')) {
        if (u.type === 'villager') continue;
        const d = dist(u.x, u.y, playerBase.x, playerBase.y);
        if (d < m.minDistToPlayerBase) m.minDistToPlayerBase = d;
        if (d <= PRESSURE_RADIUS) near = true;
        if (d <= 10 && m.firstContactTime === null) m.firstContactTime = world.time;
      }
      // Pressure, measured where the player actually feels it: how long the AI
      // ever leaves their town alone once it has arrived there for the first
      // time. This is what the wave-cadence check used to stand in for, and it
      // stopped standing in for it when a push started staying to finish the
      // job — see the check itself.
      if (near) {
        m.lastNear = world.time;
      } else if (m.lastNear !== undefined) {
        const quiet = world.time - m.lastNear;
        if (quiet > (m.maxQuiet || 0)) m.maxQuiet = quiet;
      }

      if (ai._ai && ai._ai.defending) m.defendedTicks++;

      if (m.playerLostAt === null && world.time > 3) {
        const b = ownedBy(world, PLAYER, 'building');
        const v = ownedBy(world, PLAYER, 'unit').filter((u) => u.type === 'villager');
        if (!b.length && !v.length) m.playerLostAt = world.time;
      }

      // Force the food cliff: every berry near the enemy base disappears.
      if (starveAt && !starved && world.time >= starveAt) {
        starved = true;
        const tc = ownedBy(world, ENEMY, 'building', 'towncenter')[0];
        const at = tc ? { x: tc.x, y: tc.y } : { x: 39, y: 39 };
        for (const n of world.resources.slice()) {
          if (n.resourceType !== 'food') continue;
          if (dist(n.x, n.y, at.x, at.y) > STARVE_RADIUS) continue;
          removeEntity(world, n);
        }
        m.starvedAt = world.time;
      }
      if (starved) {
        m.minFoodAfterStarve = Math.min(
          m.minFoodAfterStarve, world.players[ENEMY].resources.food,
        );
      }

      // Decapitate the enemy: take out its Town Center and every Barracks.
      if (razeAt && !razed && world.time >= razeAt) {
        razed = true;
        for (const b of ownedBy(world, ENEMY, 'building')) {
          if (b.type === 'towncenter' || b.type === 'barracks') removeEntity(world, b);
        }
        m.razedAt = world.time;
      }

      // Keep the punching bag standing so waves 2..n actually happen: let the
      // town be destroyed, and put it straight back up. See the note on propUp.
      if (propUp) {
        const tc = ownedBy(world, PLAYER, 'building', 'towncenter')[0];
        if (!tc) {
          try {
            spawnBuilding(world, 'towncenter', PLAYER, playerBase.x, playerBase.y);
            m.propRebuilds = (m.propRebuilds || 0) + 1;
          } catch { /* ground taken this step; try again on the next one */ }
        }
        const pv = ownedBy(world, PLAYER, 'unit').filter((u) => u.type === 'villager');
        if (pv.length < 3) {
          spawnUnit(world, 'villager', PLAYER, playerBase.x + 2, playerBase.y + 2);
        }
      }

      // A scripted counter-attack, to prove the AI recalls and defends.
      if (raid && !raided && world.time >= 300) {
        raided = true;
        const tc = ownedBy(world, ENEMY, 'building', 'towncenter')[0];
        if (tc) {
          for (let i = 0; i < 4; i++) {
            spawnUnit(world, 'militia', PLAYER, tc.x - 6 + i * 0.7, tc.y - 6);
          }
        }
      }

      if (verbose && step % 1200 === 1199) {
        m.timeline.push({
          t: Math.round(world.time),
          vill: ownedBy(world, ENEMY, 'unit', 'villager').length,
          army: ownedBy(world, ENEMY, 'unit').filter((u) => u.type !== 'villager').length,
          pop: `${pop}/${p.popCap}`,
          f: Math.round(p.resources.food),
          w: Math.round(p.resources.wood),
          g: Math.round(p.resources.gold),
          bld: ownedBy(world, ENEMY, 'building')
            .map((b) => b.type[0] + (b.complete ? '' : '~')).sort().join(''),
          waves: ai.stats.wavesLaunched,
        });
      }
    }
  } catch (err) {
    m.thrown = err;
  }

  m.startVillagers = startVillagers;
  m.endVillagers = ownedBy(world, ENEMY, 'unit', 'villager').length;
  m.endArmy = ownedBy(world, ENEMY, 'unit').filter((u) => u.type !== 'villager').length;
  m.militia = ownedBy(world, ENEMY, 'unit', 'militia').length;
  m.archers = ownedBy(world, ENEMY, 'unit', 'archer').length;
  // The whole army by type. Two counters used to be enough because there were
  // two units; the roster is nine wide now, and "militia and archers" is no
  // longer a description of anything — a report that only names those two
  // cannot show whether the AI ever built the Archery Range or the Stable the
  // Barracks stopped standing in for.
  m.armyMix = {};
  for (const u of ownedBy(world, ENEMY, 'unit')) {
    if (u.type === 'villager') continue;
    m.armyMix[u.type] = (m.armyMix[u.type] || 0) + 1;
  }
  m.buildings = ownedBy(world, ENEMY, 'building').map((b) => b.type);
  m.endFood = world.players[ENEMY].resources.food;
  m.endWood = world.players[ENEMY].resources.wood;
  m.stats = ai.stats;
  m.popCap = world.players[ENEMY].popCap;
  m.world = world;
  return m;
}

// --- fingerprint sub-process mode -------------------------------------------
//
// Determinism has to be measured across processes, not inside one: world.js
// keeps `nextId` in a module-level global that createWorld() never resets, so
// the second match in a process starts numbering entities where the first left
// off — and both combat.js (phaseOf) and unitAI.js (stack tie-break) derive
// behaviour from u.id. Same seed, same process, different match. See the
// report at the end of this file.
const fpArg = process.argv.indexOf('--fingerprint');
if (fpArg >= 0) {
  const seed = Number(process.argv[fpArg + 1]);
  process.stdout.write(fingerprint(runMatch({ seed })));
  process.exit(0);
}

// --- main -------------------------------------------------------------------

const mode = Object.entries(REAL)
  .map(([k, v]) => `${k}=${v ? 'real' : 'STUB'}`)
  .join(' ');
console.log(`enemyAI 10-minute headless skirmish   [${mode}]\n`);

const main = runMatch({ seed: 12345, verbose: true });

console.log('  t(s)  vill  army   pop     food  wood  gold  buildings   waves');
for (const r of main.timeline) {
  console.log(
    `  ${String(r.t).padStart(4)}  ${String(r.vill).padStart(4)}  ` +
    `${String(r.army).padStart(4)}  ${r.pop.padStart(6)}  ` +
    `${String(r.f).padStart(5)} ${String(r.w).padStart(5)} ${String(r.g).padStart(5)}  ` +
    `${r.bld.padEnd(10)}  ${r.waves}`,
  );
}

const s = main.stats;
console.log(
  `\n  built: ${JSON.stringify(main.built)}` +
  `\n  villagers ${main.startVillagers} -> ${main.endVillagers} (${main.villagersTrained} trained)` +
  `\n  military trained: ${main.militaryTrained}, alive at 10:00: ${main.endArmy}` +
  `\n  waves launched: ${s.wavesLaunched} (sizes step ${s.lastWaveSize} last), reached base: ${s.wavesReachedBase}, wiped: ${s.wavesWiped}` +
  `\n  closest approach to player TC: ${main.minDistToPlayerBase.toFixed(1)} tiles` +
  `  first contact: ${main.firstContactTime === null ? 'never' : main.firstContactTime.toFixed(0) + 's'}` +
  `\n  peak pop ${main.maxPop}/${main.popCap} (cap max ${MAX_POP_CAP})` +
  `\n  passive player wiped out at: ${main.playerLostAt === null ? 'survived 10:00' : main.playerLostAt.toFixed(0) + 's'}\n`,
);

check('never throws out of update()', () => {
  assert.equal(main.thrown, null, main.thrown && main.thrown.stack);
});
check('never swallowed an internal error', () => {
  assert.equal(s.errors, 0, `${s.errors} internal errors, first: ${s.lastError}`);
});
check('trained more villagers than it started with', () => {
  assert.ok(main.villagersTrained > 0, 'trained no villagers');
  assert.ok(
    main.endVillagers > main.startVillagers,
    `ended with ${main.endVillagers}, started with ${main.startVillagers}`,
  );
});
check('built at least one house', () => {
  assert.ok((main.built.house || 0) >= 1, `houses built: ${main.built.house || 0}`);
});
check('built a barracks', () => {
  assert.ok((main.built.barracks || 0) >= 1, `barracks built: ${main.built.barracks || 0}`);
});
check('never exceeded its population cap', () => {
  assert.equal(
    main.popViolations.length, 0,
    `first violation: ${JSON.stringify(main.popViolations[0])}`,
  );
});
check('produced military units', () => {
  assert.ok(main.militaryTrained > 0, 'no militia or archers were trained');
});
check('launched at least one attack wave', () => {
  assert.ok(s.wavesLaunched >= 1, `waves launched: ${s.wavesLaunched}`);
});
check('a wave reached the player base', () => {
  assert.ok(
    s.wavesReachedBase >= 1 && main.minDistToPlayerBase <= 10,
    `reached=${s.wavesReachedBase} closest=${main.minDistToPlayerBase.toFixed(1)}`,
  );
});
check('attacked as a group, not one unit at a time', () => {
  assert.ok(s.lastWaveSize >= 4, `last wave size ${s.lastWaveSize}`);
});
check('kept building — base is visibly growing', () => {
  assert.ok(main.buildings.length >= 4, `only ${main.buildings.length} buildings standing`);
});
check('is deterministic for a given seed (fresh process each time)', () => {
  const self = fileURLToPath(import.meta.url);
  const fp = (seed) =>
    execFileSync(process.execPath, [self, '--fingerprint', String(seed)], {
      encoding: 'utf8',
    });
  const a = fp(4242);
  const b = fp(4242);
  assert.ok(a.length > 2, 'fingerprint sub-process produced nothing');
  assert.equal(a, b);
});
// Diagnostic, not an assertion: replaying the same seed *within one process*
// currently diverges, and the cause is in core, not here — see the note in the
// fingerprint block above. Printed so it is visible if/when core is fixed.
{
  const a = runMatch({ seed: 4242 });
  const b = runMatch({ seed: 4242 });
  const same = fingerprint(a) === fingerprint(b);
  console.log(
    `  note: same-seed replay inside one process ${same ? 'matches' : 'DIVERGES'}` +
    `${same ? '' : ' — world.js `nextId` is a module global that createWorld() ' +
      'does not reset, and combat.js/unitAI.js derive per-unit behaviour from ' +
      'u.id. Affects "Play again" in the browser too.'}`,
  );
}

// Wave schedule: keep the player standing so waves 2..n happen, and check the
// cadence and escalation the design promises.
const pressure = runMatch({ seed: 12345, propUp: true });
const waveLog = pressure.stats.waveLog;
const gaps = waveLog.slice(1).map((wv, i) => wv.t - waveLog[i].t);
const asMix = (mix) =>
  Object.entries(mix || {}).map(([t, n]) => `${n} ${t}`).join(' + ') || 'nothing';
const pushLog = pressure.stats.pushLog;
console.log(
  `  wave schedule (player propped up): ` +
  waveLog.map((wv) => `${wv.t}s x${wv.size}${wv.reinforcement ? '+' : ''} (${asMix(wv.mix)})`).join(', ') +
  `\n  gaps between dispatches: ${gaps.join('s, ')}s` +
  `\n  pushes that ended: ` +
  (pushLog.map((p) => `${p.t}s peak ${p.peak}, ${p.kills} razed, ${p.left} home`).join('; ') ||
    'none — the first one never had to come home') +
  `\n  biggest force committed at once: ${pressure.stats.maxPushPeak}` +
  `, objectives razed: ${pressure.stats.objectivesRazed}` +
  ` (the punchbag rebuilt its Town Center ${pressure.propRebuilds || 0} times)` +
  `\n  longest quiet spell in the player's town after first contact: ` +
  `${Math.round(pressure.maxQuiet || 0)}s` +
  `\n  army at 10:00: ${asMix(pressure.armyMix)}` +
  `\n  buildings started: ${JSON.stringify(pressure.stats.started)}` +
  `\n  ages reached: ${JSON.stringify(pressure.stats.ageUps)}\n`,
);

check('keeps launching waves, not just the first', () => {
  assert.ok(waveLog.length >= 3, `only ${waveLog.length} waves in 10 minutes`);
});
// This used to be "waves land every 90-150s", measured off the dispatch log, and
// that measurement stopped meaning what it was written to mean.
//
// It was a proxy for "the player is never left alone for long", and it was a
// good proxy while every wave was a round trip: the squad walked over, was
// beaten off or ran out of clock, walked home, and the next one left on the
// beat. A push now *stays* while it is destroying things (WAVE_KILL_EXTENSION in
// enemyAI.js) and is reinforced where it stands rather than being replaced from
// home, so a gap between dispatches is no longer a gap in pressure — it is
// usually the opposite, a squad that is still standing in the player's town and
// did not need replacing.
//
// So the pressure is measured where the player feels it instead: how long the
// enemy is ever absent from their town, once it has turned up there at all. Two
// minutes is the bar, which is under the old 90-125 s cadence plus the walk, and
// the dispatch gaps are still checked, at a ceiling loose enough to allow a push
// that is winning and tight enough to catch one that has quietly stopped.
check('never leaves the player alone for long once it has arrived', () => {
  assert.ok(pressure.firstContactTime !== null, 'never reached the player at all');
  assert.ok(
    (pressure.maxQuiet || 0) <= 120,
    `left the player alone for ${Math.round(pressure.maxQuiet)}s`,
  );
  const bad = gaps.filter((g) => g > 240);
  assert.equal(bad.length, 0, `dispatch gaps of ${bad.join(',')}s among ${gaps.join(',')}`);
});
// ...and this used to be "waves escalate in size", off the same log.
//
// Escalation is now a property of the *push* rather than of the dispatch: the
// AI commits everything above its home guard and then feeds the fight, so a
// twenty-strong assault shows up in the dispatch log as a nine and three fours.
// stats.pushLog records what was actually standing in front of the player at
// once, which is the number the original check was reaching for.
check('commits more of its army as the match goes on', () => {
  const first = waveLog[0].size;
  assert.ok(
    pressure.stats.maxPushPeak >= first * 2,
    `first wave was ${first} and the biggest force it ever had in the field ` +
    `at once was ${pressure.stats.maxPushPeak}`,
  );
});
check('pushes destroy things rather than bouncing off', () => {
  assert.ok(
    pressure.stats.objectivesRazed >= 2,
    `razed ${pressure.stats.objectivesRazed} of the objectives it was sent after`,
  );
});
// The regression this whole pass exists to prevent. The Barracks trains militia
// and spearmen and nothing else now: the archer moved to the Archery Range and
// the scout to the Stable, and both of those units are Feudal Age besides. So an
// AI that ages up and does not follow it with one of those two buildings fields
// an infantry-only army for the entire match — no ranged unit, no cavalry, and
// no answer to a player who masses either.
//
// A word on the margin, because this check is tighter than it looks. Seed 12345
// is one of the slower food starts the AI has been measured on: it commits to
// the Feudal Age at about 8:05, stands in it a minute later, and the Archery
// Range follows within the minute after that — inside the last ninety seconds of
// the match. That is close to the worst case; over six seeds of a twelve-minute
// run the age lands at 6:20-9:20, the Range is always up, five seeds add a
// Blacksmith and four add a Stable. If this check starts failing, look first at
// what has delayed the age-up (see the age-up push in enemyAI.js) rather than at
// the build order behind it.
check('follows the Feudal Age with the arm the Barracks no longer trains', () => {
  const feudal = s.ageUps.find((a) => a.age === 1);
  assert.ok(feudal, `never reached the Feudal Age: ${JSON.stringify(s.ageUps)}`);
  const started = s.started || {};
  const arms = (started.archeryrange || 0) + (started.stable || 0);
  assert.ok(
    arms >= 1,
    `Feudal Age at ${feudal.t}s but no Archery Range or Stable — started ` +
    `${JSON.stringify(started)}`,
  );
});
check('first wave is beatable but real (4-8 units)', () => {
  const first = waveLog[0];
  assert.ok(first.size >= 4 && first.size <= 8, `first wave was ${first.size}`);
  assert.ok(first.t >= 150 && first.t <= 330, `first wave launched at ${first.t}s`);
});

// Food: the AI must not walk off the same 4:00 cliff the player was falling
// off. Berries near its base are deleted outright at 3:00; from then on the only
// food within reach is what it grows.
const starved = runMatch({ seed: 12345, propUp: true, starveAt: 180 });
console.log(
  `  starved at ${Math.round(starved.starvedAt)}s (every berry within 20 tiles removed): ` +
  `farms started ${starved.stats.farmsStarted}, ` +
  `${Math.round(starved.farmFood)} food harvested from fields, ` +
  `villagers ${starved.startVillagers} -> ${starved.endVillagers}, ` +
  `army ${starved.endArmy}, food low-water ${Math.round(starved.minFoodAfterStarve)}, ` +
  `ends with ${Math.round(starved.endFood)} food / ${Math.round(starved.endWood)} wood\n`,
);

check('builds farms when the berries near its base run out', () => {
  assert.equal(starved.thrown, null, starved.thrown && starved.thrown.stack);
  assert.equal(starved.stats.errors, 0, starved.stats.lastError);
  assert.ok(starved.stats.farmsStarted >= 2, `only ${starved.stats.farmsStarted} farms started`);
  assert.ok(
    starved.farmFood >= 200,
    `only ${Math.round(starved.farmFood)} food actually came out of the fields`,
  );
});
check('does not starve once its berries are gone', () => {
  // Still growing, still fighting, still eating: no cliff.
  assert.ok(
    starved.endVillagers >= starved.startVillagers + 8,
    `villager count collapsed to ${starved.endVillagers}`,
  );
  assert.ok(starved.militaryTrained >= 8, `only ${starved.militaryTrained} soldiers trained`);
  assert.ok(starved.endFood > 100, `ended on ${Math.round(starved.endFood)} food`);
});
check('with farms it comfortably passes the old 16-villager cap', () => {
  assert.ok(
    main.endVillagers > 16 && starved.endVillagers > 16,
    `normal run ${main.endVillagers}, starved run ${starved.endVillagers}`,
  );
});

// Robustness: take away its Town Center and Barracks mid-match.
const razed = runMatch({ seed: 12345, razeAt: 250 });
console.log(
  `  after razing its TC + barracks at ${Math.round(razed.razedAt)}s it ended with: ` +
  `${razed.buildings.slice().sort().join(', ') || 'nothing'}\n`,
);
check('rebuilds after its Town Center and Barracks are destroyed', () => {
  assert.equal(razed.thrown, null, razed.thrown && razed.thrown.stack);
  assert.equal(razed.stats.errors, 0, razed.stats.lastError);
  // It must never sit on enough wood for a rebuild without placing one.
  const wood = razed.world.players[ENEMY].resources.wood;
  assert.ok(
    razed.buildings.includes('towncenter') || wood < 275,
    `idled on ${Math.round(wood)} wood without rebuilding a Town Center`,
  );
  if (REAL.economy && REAL.unitAI) {
    assert.ok(razed.buildings.includes('towncenter'), 'never rebuilt a Town Center');
    assert.ok(razed.buildings.includes('barracks'), 'never rebuilt a Barracks');
  }
});

// Defence: script a player raid into the enemy base and confirm the AI reacts.
const defence = runMatch({ seed: 777, raid: true });
check('defends its base when raided (and still does not throw)', () => {
  assert.equal(defence.thrown, null, defence.thrown && defence.thrown.stack);
  assert.equal(defence.stats.errors, 0, defence.stats.lastError);
  assert.ok(defence.defendedTicks > 0, 'never entered a defensive posture');
});

// --- report -----------------------------------------------------------------

console.log('');
for (const [status, name, detail] of checks) {
  console.log(`  ${status === 'PASS' ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
console.log(`\n${checks.length - failures}/${checks.length} checks passed\n`);
process.exit(failures ? 1 : 0);
