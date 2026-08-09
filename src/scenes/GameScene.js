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
import { updateAllocation } from '../systems/allocation.js';
import { updateUnits, commandUnits } from '../systems/unitAI.js';
import { updateCombat } from '../systems/combat.js';
import { createEnemyAI } from '../systems/enemyAI.js';
import { visionStats } from '../systems/vision.js';
import { createInput } from '../ui/input.js';
import { createHud } from '../ui/hud.js';
import { reindex } from '../core/world.js';
import { perf, perfBegin, perfEnd, perfFrame, perfCount } from '../core/perf.js';

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
    // Seed the fog before anything is drawn. Without this the first frame or
    // two render against an all-unexplored mask, which reads as the game
    // booting to a black screen and then blinking your base into existence.
    world.vision.update();

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
      // Fog of war, for the console: masks, remembered objects and the timing
      // counters (see visionStats in systems/vision.js).
      vision: world.vision,
      visionStats,
      // The CPU profiler. Off unless something turns it on; see core/perf.js
      // for why the numbers it collects are the ones worth quoting.
      perf,
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
    const _t = perfBegin('sim');
    // How many fixed steps landed in this frame. On a device holding 60fps that
    // is 0 or 1; on a machine drawing at 20fps it is three, and without this
    // count the profile would report three steps' work as the cost of one.
    perfCount('sim.steps', 1);

    // Positions from the previous step, so rendering can interpolate.
    for (const u of world.units) {
      u.px = u.x;
      u.py = u.y;
    }

    const _tIdx = perfBegin('sim.reindex');
    reindex(world);
    perfEnd('sim.reindex', _tIdx);
    // Before the units move, not after: the allocation manager issues ordinary
    // gather orders, and an order given at the top of a step is walked in the
    // same step — exactly as a player's tap is (see commandUnits). Ticking it
    // afterwards would cost every re-task a step of standing still.
    const _tAlloc = perfBegin('sim.allocation');
    updateAllocation(world, dt);
    perfEnd('sim.allocation', _tAlloc);
    const _tUnits = perfBegin('sim.units');
    updateUnits(world, dt);
    perfEnd('sim.units', _tUnits);
    const _tCombat = perfBegin('sim.combat');
    updateCombat(world, dt);
    perfEnd('sim.combat', _tCombat);
    const _tEcon = perfBegin('sim.economy');
    updateEconomy(world, dt);
    perfEnd('sim.economy', _tEcon);
    const _tAI = perfBegin('sim.enemyAI');
    this.enemyAI.update(dt);
    perfEnd('sim.enemyAI', _tAI);
    // Vision last, after everything has finished moving, dying and being built,
    // so the masks the renderer reads this frame describe the world the player
    // is about to be shown rather than the one at the top of the step.
    const _tVis = perfBegin('sim.vision');
    world.vision.update();
    perfEnd('sim.vision', _tVis);

    world.time += dt;
    world.tick++;

    this.checkVictory();
    perfEnd('sim', _t);
  }

  update(time, delta) {
    perfFrame();
    const _tFrame = perfBegin('scene.update');
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
    const _tInput = perfBegin('input');
    this.input2.update(dtSec);
    perfEnd('input', _tInput);
    const _tRender = perfBegin('render');
    this.renderer.update(this.alpha, dtSec);
    perfEnd('render', _tRender);
    const _tHud = perfBegin('hud');
    this.hud.update(dtSec);
    perfEnd('hud', _tHud);
    perfEnd('scene.update', _tFrame);
  }

  /**
   * You lose when you have no buildings and no villagers left to rebuild.
   *
   * Written as a scan rather than as three list comprehensions, because it runs
   * every sim step for every player: the readable version allocated four arrays
   * of up to two hundred entities twenty times a second, all of it to answer two
   * yes/no questions that stop the moment they find their first hit.
   */
  checkVictory() {
    const world = this.world;
    if (world.over) return;
    for (const p of world.players) {
      if (p.defeated) continue;
      let canRecover = false;
      for (const id of p.owned) {
        const e = world.entities.get(id);
        if (!e || e.dead) continue;
        if (e.kind === 'building' || (e.kind === 'unit' && e.type === 'villager')) {
          canRecover = true;
          break;
        }
      }
      if (!canRecover && world.time > 3) p.defeated = true;
    }
    let alive = null;
    let aliveCount = 0;
    for (const p of world.players) {
      if (p.defeated) continue;
      aliveCount++;
      alive = p;
    }
    if (aliveCount === 1) {
      world.over = true;
      world.winner = alive.id;
      world.events.emit(EV.GAME_OVER, { winner: alive.id });
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
    if (this.world) {
      if (this.world.vision) this.world.vision.destroy();
      this.world.events.clear();
    }
  }
}
