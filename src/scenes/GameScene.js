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
import { serializeGame, restoreGame, writeSave, clearSave } from '../core/save.js';

import { createRenderer } from '../gfx/render.js';
import { updateEconomy } from '../systems/economy.js';
import { updateAllocation } from '../systems/allocation.js';
import { updateUnits, commandUnits } from '../systems/unitAI.js';
import { updateCombat } from '../systems/combat.js';
import { createEnemyAI } from '../systems/enemyAI.js';
import { visionStats } from '../systems/vision.js';
import { createInput } from '../ui/input.js';
import { createHud } from '../ui/hud.js';
import { createAudio } from '../audio/sound.js';
import { createAudioAdapter } from '../audio/adapter.js';
import { reindex } from '../core/world.js';
import { perf, perfBegin, perfEnd, perfFrame, perfCount } from '../core/perf.js';

// How much real time passes between autosaves.
//
// Thirty seconds is a compromise between two costs that pull opposite ways.
// Serialising a four-hundred-second match measures 436kB of JSON and 13.6ms of
// CPU on this machine, which on a mid-range phone is a couple of dropped
// frames; and the other cost is how much of a match a player loses when the OS
// kills the tab, which at this interval is at most half a minute of play. The
// hitch is paid twice a minute and the loss is bounded — the other way round,
// with a five-minute interval, the hitch is invisible and the game occasionally
// eats five minutes of somebody's afternoon.
//
// The save that actually matters is not on this clock at all: it is the one
// taken on `visibilitychange`, which is the last moment a page reliably gets
// before a phone browser is suspended or destroyed.
const AUTOSAVE_SECONDS = 30;

export class GameScene extends Phaser.Scene {
  constructor() {
    super('game');
  }

  init(data) {
    this.seed = (data && data.seed) || Math.floor(Math.random() * 1e9);
    // A payload from src/core/save.js, already version-checked by whoever read
    // it out of storage. Null for a fresh skirmish.
    this.resumeFrom = (data && data.resume) || null;
  }

  create() {
    let world = null;
    let restored = null;
    if (this.resumeFrom) {
      try {
        restored = restoreGame(this.resumeFrom);
        world = restored.world;
        this.seed = world.seed;
      } catch (err) {
        // A save that survived the version check and then failed to build is a
        // bug, not a player error. Say so and start a fresh match rather than
        // leaving them on a dead boot card.
        console.warn('[save] could not resume, starting a new match:', err);
        clearSave();
        restored = null;
        world = null;
      }
    }
    if (!world) {
      world = createWorld(this.seed);
      generateMap(world);
      recomputePop(world, PLAYER);
      recomputePop(world, ENEMY);
    }
    this.world = world;
    this.resumeFrom = null;
    // Seed the fog before anything is drawn. Without this the first frame or
    // two render against an all-unexplored mask, which reads as the game
    // booting to a black screen and then blinking your base into existence.
    // On a resumed match this is also where the visible mask and the viewer
    // cache — the two parts of the fog that are derived rather than saved — are
    // rebuilt from where the units are standing.
    world.vision.update();

    this.renderer = createRenderer(this, world);
    // Audio before the HUD, because the HUD plays the button clicks.
    //
    // Seeded off the match, so cue-to-cue variation and the music generator
    // replay with the seed the way everything else does. The engine attaches its
    // own one-shot gesture listeners (autoUnlock) and stays silent until one of
    // them fires — which is why the browser harness, which boots with
    // ?autostart and never gestures, hears nothing and logs nothing.
    this.audio = createAudio({ seed: this.seed });
    this.audioAdapter = createAudioAdapter(world, this.audio, { playerId: PLAYER });
    this.hud = createHud(this, world, this.audio);
    this.input2 = createInput(this, world, this.renderer, this.hud);
    this.enemyAI = createEnemyAI(world, ENEMY);
    if (restored && restored.ai) this.enemyAI.restore(restored.ai);

    // Expose for the headless test harness and for debugging in the console.
    window.__game = {
      scene: this,
      world,
      renderer: this.renderer,
      hud: this.hud,
      input: this.input2,
      audio: this.audio,
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
      // Saving, for the console and for tests/save.browser.mjs.
      save: () => this.saveNow('manual'),
      serialize: () => this.snapshotSave(),
    };

    this.accumulator = 0;
    this.alpha = 0;
    this.autosaveAcc = 0;

    world.events.on(EV.GAME_OVER, ({ winner }) => this.onGameOver(winner));

    // Centre the camera where the player left it, or on their Town Center.
    const view = restored && restored.view;
    if (view && this.renderer.centerOn) {
      this.renderer.centerOn(view.x, view.y);
      if (view.zoom && this.renderer.camera) this.renderer.camera.setZoom(view.zoom);
    } else {
      const tc = ownedBy(world, PLAYER, 'building', 'towncenter')[0];
      if (tc && this.renderer.centerOn) this.renderer.centerOn(tc.x, tc.y);
    }

    // The save that matters. A phone browser gets `visibilitychange` when the
    // player switches apps, locks the screen or pulls down the task switcher,
    // and that is the last event it is guaranteed to see — everything after it
    // is at the operating system's discretion. `pagehide` covers the ordinary
    // navigation case, which fires on iOS where `unload` does not.
    this.onHide = () => {
      if (document.visibilityState === 'hidden') this.saveNow('hidden');
    };
    this.onPageHide = () => this.saveNow('pagehide');
    document.addEventListener('visibilitychange', this.onHide);
    window.addEventListener('pagehide', this.onPageHide);

    this.events.on('shutdown', () => this.teardown());
  }

  // --- Saving ---------------------------------------------------------------

  /** The whole match as a payload, scene state included. */
  snapshotSave() {
    const cam = this.renderer && this.renderer.camera;
    let view = null;
    if (cam && this.renderer.screenToGrid) {
      const c = this.renderer.screenToGrid(cam.width / 2, cam.height / 2);
      if (c) view = { x: c.x, y: c.y, zoom: cam.zoom };
    }
    return serializeGame(this.world, {
      ai: this.enemyAI && this.enemyAI.serialize ? this.enemyAI.serialize() : null,
      view,
    });
  }

  /**
   * Write the match to local storage. Never throws and never interrupts play:
   * a save that cannot be written (private mode, a full quota) is a save the
   * boot card will not offer, which is the correct visible outcome.
   */
  saveNow(reason = 'auto') {
    if (!this.world || this.world.over || this.saved === 'gone') return null;
    try {
      const res = writeSave(this.snapshotSave());
      this.lastSave = { at: Date.now(), reason, ...res };
      if (!res.ok && !this.warnedSave) {
        this.warnedSave = true;
        console.warn(`[save] ${res.error}`);
      }
      return res;
    } catch (err) {
      if (!this.warnedSave) {
        this.warnedSave = true;
        console.warn('[save] could not write the match:', err);
      }
      return null;
    }
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

    // The listener is the middle of the screen in grid coordinates, and it is
    // fed *before* update() because update() is where the engine reaps voices
    // and advances the music scheduler — a cue played this frame should be
    // panned against where the camera is now, not where it was last frame. Both
    // run every frame whether or not the simulation stepped: while the game is
    // paused or over, a tail still has to be allowed to finish.
    const _tAudio = perfBegin('audio');
    const cam = this.renderer.camera;
    const c = this.renderer.screenToGrid(cam.width / 2, cam.height / 2);
    if (c) this.audio.setListener(c.x, c.y, cam.zoom);
    this.audio.update(dtSec);
    perfEnd('audio', _tAudio);

    // Autosave on the wall clock rather than on simulation time, because what
    // it is protecting against — the browser being killed — happens in wall
    // time. A paused or backgrounded tab does not accumulate frames here, and
    // does not need to: the visibilitychange handler has already saved it.
    this.autosaveAcc += dtSec;
    if (this.autosaveAcc >= AUTOSAVE_SECONDS) {
      this.autosaveAcc = 0;
      this.saveNow('auto');
    }
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
    // A finished match is not resumable, so the save goes with it. Leaving it
    // behind would put "Resume match" on the boot card and drop the player back
    // into a game that is already over.
    this.saved = 'gone';
    clearSave();

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
    if (this.onHide) document.removeEventListener('visibilitychange', this.onHide);
    if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide);
    this.onHide = null;
    this.onPageHide = null;
    if (this.input2) this.input2.destroy();
    if (this.renderer) this.renderer.destroy();
    if (this.hud) this.hud.destroy();
    if (this.audioAdapter) this.audioAdapter.destroy();
    if (this.audio) this.audio.destroy();
    if (this.world) {
      if (this.world.vision) this.world.vision.destroy();
      this.world.events.clear();
    }
  }
}
