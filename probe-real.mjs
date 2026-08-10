// Two shipped AIs, the exact system order GameScene.simStep uses.
import { createWorld, reindex, recomputePop } from './src/core/world.js';
import { generateMap } from './src/core/mapgen.js';
import { createEnemyAI } from './src/systems/enemyAI.js';
import { updateUnits } from './src/systems/unitAI.js';
import { updateCombat } from './src/systems/combat.js';
import { updateEconomy } from './src/systems/economy.js';
import { updateAllocation } from './src/systems/allocation.js';
import { SIM_DT } from './src/core/constants.js';
import { EV } from './src/core/events.js';
import { currentAge } from './src/systems/tech.js';

for (const seed of [4242, 99]) {
  const w = createWorld(seed);
  generateMap(w);
  for (let p = 0; p < w.players.length; p++) recomputePop(w, p);
  const ais = [createEnemyAI(w, 0), createEnemyAI(w, 1)];
  let kills = 0;
  const killsAt = [];
  w.events.on(EV.DEATH, (p) => { if (p && p.entity && p.entity.kind === 'unit') kills++; });
  const MIN = 30;
  for (let i = 0; i < 20 * 60 * MIN; i++) {
    for (const u of w.units) { u.px = u.x; u.py = u.y; }
    reindex(w);
    updateAllocation(w, SIM_DT);
    updateUnits(w, SIM_DT);
    updateCombat(w, SIM_DT);
    updateEconomy(w, SIM_DT);
    for (const ai of ais) ai.update(SIM_DT);
    w.vision.update();
    w.time += SIM_DT; w.tick++;
    if (i % (20 * 300) === 0 && i) killsAt.push(`${(w.time / 60) | 0}m:${kills}`);
    if (w.over) break;
  }
  const tally = (p) => {
    const m = new Map();
    for (const e of w.buildings) if (!e.dead && e.player === p) m.set(e.type, (m.get(e.type) || 0) + 1);
    return [...m.entries()].sort().map(([t, n]) => `${t}x${n}`).join(' ');
  };
  const units = (p) => {
    const m = new Map();
    for (const e of w.units) if (!e.dead && e.player === p) m.set(e.type, (m.get(e.type) || 0) + 1);
    return [...m.entries()].sort().map(([t, n]) => `${t}x${n}`).join(' ');
  };
  console.log(`\n=== seed ${seed}: ${(w.time / 60).toFixed(1)} min, over=${w.over} winner=${w.winner} ===`);
  console.log(`total unit deaths: ${kills}   over time: ${killsAt.join(' ')}`);
  console.log(`ages: p0=${currentAge(w, 0)} p1=${currentAge(w, 1)}`);
  console.log(`p0 bld: ${tally(0)}`);
  console.log(`p0 uni: ${units(0)}`);
  console.log(`p1 bld: ${tally(1)}`);
  console.log(`p1 uni: ${units(1)}`);
}
