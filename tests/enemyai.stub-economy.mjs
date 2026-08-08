// Stand-in for src/systems/economy.js — test-only, see enemyai.loader.mjs.
// Implements the documented contract: canAfford / queueTrain / placeFoundation
// / updateEconomy, with resource deduction, training queues and pop reservation.

import { UNIT_STATS, BUILDING_STATS } from '../src/core/constants.js';
import {
  canPlace, spawnBuilding, spawnUnit, recomputePop, isBlocked,
} from '../src/core/world.js';
import { EV } from '../src/core/events.js';

export function canAfford(world, playerId, cost) {
  const p = world.players[playerId];
  if (!p || !cost) return false;
  for (const k of ['food', 'wood', 'gold', 'stone']) {
    if ((cost[k] || 0) > (p.resources[k] || 0)) return false;
  }
  return true;
}

function spend(world, playerId, cost) {
  const p = world.players[playerId];
  for (const k of ['food', 'wood', 'gold', 'stone']) {
    p.resources[k] = (p.resources[k] || 0) - (cost[k] || 0);
  }
}

export function queueTrain(world, building, unitType) {
  if (!building || building.dead || !building.complete) return false;
  if (!building.trains || !building.trains.includes(unitType)) return false;
  const s = UNIT_STATS[unitType];
  if (!s) return false;
  const p = world.players[building.player];
  recomputePop(world, building.player);
  if (p.pop + (s.pop || 1) > p.popCap) {
    world.events.emit(EV.POP_CAPPED, { player: building.player });
    return false;
  }
  if (!canAfford(world, building.player, s.cost)) {
    world.events.emit(EV.INSUFFICIENT, { player: building.player });
    return false;
  }
  spend(world, building.player, s.cost);
  building.queue.push({ type: unitType, remaining: s.buildTime });
  recomputePop(world, building.player);
  return true;
}

export function placeFoundation(world, playerId, type, gx, gy) {
  const s = BUILDING_STATS[type];
  if (!s) return null;
  if (!canPlace(world, gx, gy, s.fw, s.fh)) return null;
  if (!canAfford(world, playerId, s.cost)) return null;
  spend(world, playerId, s.cost);
  const b = spawnBuilding(world, type, playerId, gx, gy, { complete: false });
  world.events.emit(EV.FOUNDATION, { building: b });
  return b;
}

function freeTileNear(world, b) {
  const r = Math.max(b.fw, b.fh) / 2 + 0.5;
  for (let ring = 0; ring < 5; ring++) {
    for (let a = 0; a < 12; a++) {
      const ang = (Math.PI * 2 * a) / 12;
      const x = b.x + Math.cos(ang) * (r + ring);
      const y = b.y + Math.sin(ang) * (r + ring);
      if (x < 1 || y < 1 || x >= world.width - 1 || y >= world.height - 1) continue;
      if (!isBlocked(world, Math.floor(x), Math.floor(y))) return { x, y };
    }
  }
  return { x: b.x, y: b.y };
}

export function updateEconomy(world, dt) {
  for (const b of world.buildings.slice()) {
    if (b.dead || !b.complete || !b.queue || !b.queue.length) continue;
    const job = b.queue[0];
    job.remaining -= dt;
    if (job.remaining > 0) continue;
    b.queue.shift();
    const at = freeTileNear(world, b);
    const u = spawnUnit(world, job.type, b.player, at.x, at.y);
    world.events.emit(EV.TRAINED, { building: b, unitType: job.type, unit: u });
    recomputePop(world, b.player);
  }
  for (const p of world.players) recomputePop(world, p.id);
}
