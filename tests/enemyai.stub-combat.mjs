// Stand-in for src/systems/combat.js — test-only, see enemyai.loader.mjs.
// Melee/ranged damage resolution with no projectile travel; enough to make
// attack waves actually kill things so the AI's wave lifecycle is exercised.

import { MIN_DAMAGE } from '../src/core/constants.js';
import { removeEntity, edgeDist } from '../src/core/world.js';
import { EV } from '../src/core/events.js';

export function updateCombat(world, dt) {
  for (const u of world.units.slice()) {
    if (u.dead) continue;
    if (u.cooldown > 0) u.cooldown -= dt;
    const t = u.target;
    if (!t || t.dead) {
      u.target = null;
      continue;
    }
    if (edgeDist(t, u.x, u.y) > u.range + 0.35) continue;
    if (u.cooldown > 0) continue;
    u.cooldown = u.attackCooldown;
    const dmg = Math.max(MIN_DAMAGE, u.attack - (t.armor || 0));
    t.hp -= dmg;
    world.events.emit(EV.DAMAGE, { entity: u, target: t, amount: dmg });
    if (t.hp <= 0) {
      world.events.emit(EV.DEATH, { entity: t, killer: u });
      removeEntity(world, t);
      u.target = null;
    }
  }
}
