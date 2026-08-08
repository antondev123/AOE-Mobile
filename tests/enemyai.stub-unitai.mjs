// Stand-in for src/systems/unitAI.js, used ONLY by tests/enemyai.test.mjs and
// ONLY while the real module does not exist yet (see enemyai.loader.mjs).
//
// It implements the documented contract — commandUnits / isIdle / updateUnits —
// with straight-line movement and no pathfinding. That is enough to exercise
// the enemy AI end to end: villagers gather and build, soldiers walk to a
// staging point and attack. Once the real unitAI.js lands the loader stops
// redirecting and the same test runs against it unchanged.

import {
  CARRY_CAPACITY, GATHER_RATE, BUILD_RATE, AGGRO_RANGE,
} from '../src/core/constants.js';
import {
  findNearestGlobal, removeEntity, applyPopBonus, edgeDist, isHostile, forEachNear,
} from '../src/core/world.js';
import { EV } from '../src/core/events.js';

export function isIdle(u) {
  return !!u && !u.dead && !u.task;
}

export function commandUnits(world, units, order) {
  if (!order || !units) return;
  for (const u of units) {
    if (!u || u.dead || u.kind !== 'unit') continue;
    switch (order.type) {
      case 'stop':
        u.task = null;
        u.target = null;
        u.state = 'idle';
        break;
      case 'move':
        u.task = { type: 'move', gx: order.gx, gy: order.gy };
        u.target = null;
        break;
      case 'gather':
        if (order.target && !order.target.dead) {
          u.task = { type: 'gather', node: order.target };
        } else {
          u.task = { type: 'move', gx: order.gx, gy: order.gy };
        }
        break;
      case 'build':
        if (order.target && !order.target.dead) {
          u.task = { type: 'build', building: order.target };
        }
        break;
      case 'attack':
        u.task = order.target && !order.target.dead
          ? { type: 'attack', target: order.target, gx: order.gx, gy: order.gy }
          : { type: 'move', gx: order.gx, gy: order.gy };
        break;
      default:
        break;
    }
  }
}

function stepToward(u, tx, ty, dt) {
  const dx = tx - u.x;
  const dy = ty - u.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return 0;
  const move = Math.min(d, u.speed * dt);
  u.x += (dx / d) * move;
  u.y += (dy / d) * move;
  u.state = 'move';
  return d - move;
}

function dropoffFor(world, u, resType) {
  return findNearestGlobal(
    world, u.x, u.y, world.buildings,
    (b) => b.player === u.player && b.complete && b.dropoff && b.dropoff.includes(resType),
  );
}

export function updateUnits(world, dt) {
  // Recompute node crowding so the AI's spread-out heuristic has real input.
  for (const n of world.resources) n.workers = 0;
  for (const u of world.units) {
    if (u.task && u.task.type === 'gather' && u.task.node && !u.task.node.dead) {
      u.task.node.workers++;
    }
  }

  for (const u of world.units.slice()) {
    if (u.dead) continue;
    if (u.cooldown > 0) u.cooldown -= dt;
    const t = u.task;
    if (!t) {
      u.state = 'idle';
      // Idle units defend themselves.
      if (!u.target) {
        let found = null;
        forEachNear(world, u.x, u.y, AGGRO_RANGE, (e) => {
          if (found || e.kind === 'resource') return;
          if (e.player === null || e.player === undefined) return;
          if (!isHostile(u, e)) return;
          if (e.kind === 'building' && u.type === 'villager') return;
          found = e;
        });
        if (found) u.target = found;
      }
      continue;
    }

    switch (t.type) {
      case 'move': {
        const left = stepToward(u, t.gx, t.gy, dt);
        if (left <= 0.25) {
          u.task = null;
          u.state = 'idle';
        }
        break;
      }
      case 'gather': {
        const node = t.node;
        if (!node || node.dead || node.amount <= 0) {
          u.task = null;
          u.state = 'idle';
          break;
        }
        const rt = node.resourceType;
        if (u.carrying.amount >= CARRY_CAPACITY) {
          const drop = dropoffFor(world, u, rt);
          if (!drop) {
            u.carrying.amount = 0;
            break;
          }
          u.state = 'deposit';
          if (edgeDist(drop, u.x, u.y) > 1.2) {
            stepToward(u, drop.x, drop.y, dt);
          } else {
            const p = world.players[u.player];
            p.resources[rt] = (p.resources[rt] || 0) + u.carrying.amount;
            world.events.emit(EV.DEPOSIT, {
              unit: u, building: drop, type: rt, amount: u.carrying.amount,
            });
            u.carrying.amount = 0;
            u.carrying.type = null;
          }
          break;
        }
        if (edgeDist(node, u.x, u.y) > 1.0) {
          stepToward(u, node.x, node.y, dt);
          break;
        }
        u.state = 'gather';
        const got = Math.min(GATHER_RATE[rt] * dt, node.amount);
        node.amount -= got;
        u.carrying.type = rt;
        u.carrying.amount += got;
        if (node.amount <= 0) {
          world.events.emit(EV.NODE_DEPLETED, { node });
          removeEntity(world, node);
        }
        break;
      }
      case 'build': {
        const b = t.building;
        if (!b || b.dead || b.complete) {
          u.task = null;
          u.state = 'idle';
          break;
        }
        if (edgeDist(b, u.x, u.y) > 1.3) {
          stepToward(u, b.x, b.y, dt);
          break;
        }
        u.state = 'build';
        b.buildProgress += BUILD_RATE * dt;
        b.hp = Math.min(b.maxHp, Math.max(1, b.maxHp * (b.buildProgress / b.buildTime)));
        if (b.buildProgress >= b.buildTime) {
          b.complete = true;
          b.state = 'idle';
          b.hp = b.maxHp;
          applyPopBonus(world, b.player);
          world.events.emit(EV.BUILT, { building: b });
          u.task = null;
          u.state = 'idle';
        }
        break;
      }
      case 'attack': {
        const tgt = t.target;
        if (!tgt || tgt.dead) {
          u.task = null;
          u.target = null;
          u.state = 'idle';
          break;
        }
        if (edgeDist(tgt, u.x, u.y) > u.range) {
          u.target = null;
          stepToward(u, tgt.x, tgt.y, dt);
        } else {
          u.target = tgt;
          u.state = 'attack';
        }
        break;
      }
      default:
        u.task = null;
        break;
    }
  }
}
