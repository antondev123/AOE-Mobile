// The one gameplay scene. It owns the fixed-timestep loop and wires the
// independent systems together; it deliberately contains no game rules itself.
//
// Module contract (each system is developed and tested on its own):
//   gfx/render.js       createRenderer(scene, world) -> { update(alpha, dt), destroy(), ... }
//   systems/economy.js  updateEconomy(world, dt)
//   systems/unitAI.js   updateUnits(world, dt)
//   systems/combat.js   updateCombat(world, dt)
//   systems/enemyAI.js  createEnemyAI(world, playerId) -> { update(dt) }
//   ui/input.js         createInput(scene, world, renderer, hud) -> { update(dt), destroy() }
//   ui/hud.js           createHud(scene, world) -> { update(dt), destroy(), ... }

import { createWorld, ownedBy, recomputePop } from '../core/world.js';
import { generateMap } from '../core/mapgen.js';
import { SIM_DT, MAX_STEPS_PER_FRAME, PLAYER, ENEMY } from '../core/constants.js';
import { EV } from '../core/events.js';

import { createRenderer } from '../gfx/render.js';
import { updateEconomy } from '../systems/economy.js';
import { updateUnits, commandUnits } from '../systems/unitAI.js';
import { updateCombat } from '../systems/combat.js';
import { createEnemyAI } from '../systems/enemyAI.js';
import { createInput } from '../ui/input.js';
import { createHud } from '../ui/hud.js';
import { reindex } from '../core/world.js';

export class GameScene extends Phaser.Scene {
  constructor() {
    super('game');
  }

  init(data) {
    this.seed = (data && data.seed) || Math.floor(Math.random() * 1e9);
  }

  create() {
    const world = createWorld(this.seed);
    this.world = world;
    generateMap(world);
    recomputePop(world, PLAYER);
    recomputePop(world, ENEMY);

    this.renderer = createRenderer(this, world);
    this.hud = createHud(this, world);
    this.input2 = createInput(this, world, this.renderer, this.hud);
    this.enemyAI = createEnemyAI(world, ENEMY);

    // Expose for the headless test harness and for debugging in the console.
    window.__game = {
      scene: this,
      world,
      renderer: this.renderer,
      hud: this.hud,
      input: this.input2,
      // Advance the simulation by n fixed steps without waiting for frames.
      step: (n = 1) => {
        for (let i = 0; i < n; i++) this.simStep();
      },
      // Issue orders from the console or from the test harness.
      command: (units, order) => commandUnits(world, units, order),
    };

    this.accumulator = 0;
    this.alpha = 0;

    world.events.on(EV.GAME_OVER, ({ winner }) => this.onGameOver(winner));

    // Centre the camera on the player's Town Center.
    const tc = ownedBy(world, PLAYER, 'building', 'towncenter')[0];
    if (tc && this.renderer.centerOn) this.renderer.centerOn(tc.x, tc.y);

    this.events.on('shutdown', () => this.teardown());
  }

  /** One fixed logic step. All game rules advance here, never in update(). */
  simStep() {
    const world = this.world;
    if (world.over) return;
    const dt = SIM_DT;

    // Positions from the previous step, so rendering can interpolate.
    for (const u of world.units) {
      u.px = u.x;
      u.py = u.y;
    }

    reindex(world);
    updateUnits(world, dt);
    updateCombat(world, dt);
    updateEconomy(world, dt);
    this.enemyAI.update(dt);

    world.time += dt;
    world.tick++;

    this.checkVictory();
  }

  update(time, delta) {
    const dtSec = Math.min(delta, 250) / 1000;
    this.accumulator += dtSec;

    let steps = 0;
    while (this.accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      this.simStep();
      this.accumulator -= SIM_DT;
      steps++;
    }
    // If we blew the step budget, drop the backlog rather than spiralling.
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    this.alpha = this.accumulator / SIM_DT;
    this.input2.update(dtSec);
    this.renderer.update(this.alpha, dtSec);
    this.hud.update(dtSec);
  }

  checkVictory() {
    const world = this.world;
    if (world.over) return;
    // You lose when you have no buildings and no villagers left to rebuild.
    for (const p of world.players) {
      if (p.defeated) continue;
      const buildings = ownedBy(world, p.id, 'building');
      const units = ownedBy(world, p.id, 'unit');
      const canRecover =
        buildings.length > 0 || units.some((u) => u.type === 'villager');
      if (!canRecover && world.time > 3) {
        p.defeated = true;
      }
    }
    const alive = world.players.filter((p) => !p.defeated);
    if (alive.length === 1) {
      world.over = true;
      world.winner = alive[0].id;
      world.events.emit(EV.GAME_OVER, { winner: alive[0].id });
    }
  }

  onGameOver(winner) {
    const card = document.getElementById('endcard');
    const title = document.getElementById('end-title');
    const sub = document.getElementById('end-sub');
    if (!card) return;
    const won = winner === PLAYER;
    title.textContent = won ? 'Victory' : 'Defeat';
    title.className = won ? 'win' : 'lose';
    const mins = Math.floor(this.world.time / 60);
    const secs = Math.floor(this.world.time % 60);
    sub.textContent = won
      ? `You razed the enemy in ${mins}m ${secs}s.`
      : `Your settlement fell after ${mins}m ${secs}s.`;
    card.hidden = false;
  }

  teardown() {
    if (this.input2) this.input2.destroy();
    if (this.renderer) this.renderer.destroy();
    if (this.hud) this.hud.destroy();
    if (this.world) this.world.events.clear();
  }
}
