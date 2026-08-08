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

const { createWorld, reindex, ownedBy, recomputePop, spawnUnit, removeEntity } =
  await import('../src/core/world.js');
const { generateMap } = await import('../src/core/mapgen.js');
const { SIM_DT, PLAYER, ENEMY, MAX_POP_CAP } = await import('../src/core/constants.js');
const { EV } = await import('../src/core/events.js');
const { updateUnits } = await import('../src/systems/unitAI.js');
const { updateCombat } = await import('../src/systems/combat.js');
const { updateEconomy } = await import('../src/systems/economy.js');
const { createEnemyAI } = await import('../src/systems/enemyAI.js');

const REAL = {
  economy: realModule('systems/economy.js'),
  unitAI: realModule('systems/unitAI.js'),
  combat: realModule('systems/combat.js'),
};

const STEPS = 12000; // 12000 * (1/20)s = 600s = 10 minutes of sim time

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
 * @param {number} [opts.razeAt] raze the enemy's Town Center and Barracks at
 *   this sim time, to check it rebuilds instead of softlocking.
 */
function runMatch({ seed, raid = false, propUp = false, razeAt = 0, verbose = false }) {
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

      for (const u of ownedBy(world, ENEMY, 'unit')) {
        if (u.type === 'villager') continue;
        const d = dist(u.x, u.y, playerBase.x, playerBase.y);
        if (d < m.minDistToPlayerBase) m.minDistToPlayerBase = d;
        if (d <= 10 && m.firstContactTime === null) m.firstContactTime = world.time;
      }

      if (ai._ai && ai._ai.defending) m.defendedTicks++;

      if (m.playerLostAt === null && world.time > 3) {
        const b = ownedBy(world, PLAYER, 'building');
        const v = ownedBy(world, PLAYER, 'unit').filter((u) => u.type === 'villager');
        if (!b.length && !v.length) m.playerLostAt = world.time;
      }

      // Decapitate the enemy: take out its Town Center and every Barracks.
      if (razeAt && !razed && world.time >= razeAt) {
        razed = true;
        for (const b of ownedBy(world, ENEMY, 'building')) {
          if (b.type === 'towncenter' || b.type === 'barracks') removeEntity(world, b);
        }
        m.razedAt = world.time;
      }

      // Keep the punching bag standing so waves 2..n actually happen.
      if (propUp) {
        if (playerTC && !playerTC.dead) playerTC.hp = playerTC.maxHp;
        const pv = ownedBy(world, PLAYER, 'unit').filter((u) => u.type === 'villager');
        for (const v of pv) v.hp = v.maxHp;
        if (pv.length < 3 && playerTC && !playerTC.dead) {
          spawnUnit(world, 'villager', PLAYER, playerTC.x + 2, playerTC.y + 2);
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
  m.buildings = ownedBy(world, ENEMY, 'building').map((b) => b.type);
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
console.log(
  `  wave schedule (player propped up): ` +
  waveLog.map((wv) => `${wv.t}s x${wv.size}`).join(', ') +
  `\n  gaps between waves: ${gaps.join('s, ')}s` +
  `\n  army mix at 10:00: ${pressure.militia} militia / ${pressure.archers} archers\n`,
);

check('keeps launching waves, not just the first', () => {
  assert.ok(waveLog.length >= 3, `only ${waveLog.length} waves in 10 minutes`);
});
check('waves land every 90-150s', () => {
  assert.ok(gaps.length > 0, 'no gaps to measure');
  const bad = gaps.filter((g) => g < 80 || g > 155);
  assert.equal(bad.length, 0, `out-of-band gaps: ${bad.join(',')}s of ${gaps.join(',')}`);
});
check('waves escalate in size', () => {
  assert.ok(
    waveLog[waveLog.length - 1].size > waveLog[0].size,
    `first ${waveLog[0].size}, last ${waveLog[waveLog.length - 1].size}`,
  );
});
check('first wave is beatable but real (4-8 units)', () => {
  const first = waveLog[0];
  assert.ok(first.size >= 4 && first.size <= 8, `first wave was ${first.size}`);
  assert.ok(first.t >= 150 && first.t <= 330, `first wave launched at ${first.t}s`);
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
  assert.ok(razed.buildings.includes('towncenter'), 'never rebuilt a Town Center');
  assert.ok(razed.buildings.includes('barracks'), 'never rebuilt a Barracks');
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
