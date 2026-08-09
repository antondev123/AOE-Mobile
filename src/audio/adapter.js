// The one place that knows both the event bus and the sound catalogue.
//
// `src/audio/` is a device the game plays, exactly as `gfx/fx.js` is a device
// the game draws with: nothing in it subscribes to anything. This module is the
// wiring the README asks for — one subscription per event, one cue per
// subscription, and nothing else. Keeping it out of both halves means the audio
// engine stays testable with no game and the simulation stays testable with no
// sound.
//
// No Phaser imports. It is given a world and an audio engine and it does the
// rest, which is also what lets a headless test drive it against the silent stub.
//
// WHAT IS DELIBERATELY NOT WIRED
// ------------------------------
// `EV.TOAST`. Every warn-tone toast the game raises is already accompanied by
// EV.INSUFFICIENT or EV.POP_CAPPED, so wiring it too would produce two `invalid`
// buzzes for one refusal.
//
// `EV.GATHER_TICK` is wired without any rate limiting of its own, which looks
// wrong and is not: a gather tick fires once per *unit banked*, so forty
// villagers on a woodline is a few hundred a second. The engine's per-cue merge
// window (90-110ms for the gather cues) folds those into one louder voice each,
// which is both the correct sound and the reason the call site does not need a
// timer. See the catalogue table in README.md.

import { PLAYER, UNIT_STATS, BUILDING_STATS } from '../core/constants.js';
import { EV } from '../core/events.js';

/**
 * Subscribe an audio engine to a world.
 *
 * @param {object} world
 * @param {object} audio  from createAudio(); the silent stub is fine
 * @param {object} [opts] { playerId } — whose side the listener is on
 * @returns {{ destroy: () => void }}
 */
export function createAudioAdapter(world, audio, opts = {}) {
  if (!world || !world.events || !audio) return { destroy() {} };
  const me = opts.playerId === undefined ? PLAYER : opts.playerId;
  const off = [];
  const on = (type, fn) => off.push(world.events.on(type, fn));

  const at = (e) => (e ? { x: e.x, y: e.y } : undefined);
  const mine = (p) => p && (p.player === me || p.playerId === me);

  // --- Work ------------------------------------------------------------------

  // Which cue a gather tick makes is a question about the *node*, not about the
  // villager: a farm is a sickle in wheat, a stone mine is the same pick as gold
  // but heavier, and a bush is a rustle.
  on(EV.GATHER_TICK, (p) => {
    if (!p || !p.node) return;
    const n = p.node;
    if (n.kind === 'building') {
      audio.play('farm', at(n));
      return;
    }
    if (n.type === 'tree') audio.play('chop', at(n));
    else if (n.type === 'berry') audio.play('forage', at(n));
    else if (n.type === 'gold') audio.play('mine', at(n));
    // Stone is the gold pick pitched down a tone. Same gesture, heavier rock —
    // which is exactly the relationship the two resources have.
    else if (n.type === 'stone') audio.play('mine', { x: n.x, y: n.y, rate: 0.9 });
  });

  on(EV.DEPOSIT, (p) => {
    if (p && p.building) audio.play('deposit', at(p.building));
  });

  on(EV.NODE_DEPLETED, (p) => {
    if (p && p.node) audio.play('nodeDepleted', at(p.node));
  });

  // --- Building --------------------------------------------------------------

  on(EV.FOUNDATION, (p) => {
    // Non-positional, and the player's own only: the peg-into-soil blip is the
    // confirmation of a tap, so it must not fire for the enemy AI putting down
    // its ninth house across the map.
    if (p && p.building && p.building.player === me) audio.play('placeFoundation');
  });

  on(EV.BUILD_TICK, (p) => {
    if (p && p.building) audio.play('hammer', at(p.building));
  });

  on(EV.BUILT, (p) => {
    if (p && p.building) audio.play('buildComplete', at(p.building));
  });

  // --- Fighting --------------------------------------------------------------

  on(EV.PROJECTILE, (p) => {
    const from = p && (p.from || p.entity);
    if (from) audio.play('arrowLoose', at(from));
  });

  on(EV.DAMAGE, (p) => {
    if (!p) return;
    const target = p.target || p.entity;
    const attacker = p.entity && p.entity !== target ? p.entity : p.attacker;
    if (!target) return;
    // A tower and a Castle throw arrows too, and both declare `projectile` in
    // BUILDING_STATS rather than in UNIT_STATS — so the test is against whatever
    // the attacker actually is, not against the assumption that it is a unit.
    const stats = attacker
      ? (attacker.kind === 'building' ? BUILDING_STATS : UNIT_STATS)[attacker.type]
      : null;
    audio.play(stats && stats.projectile ? 'arrowHit' : 'meleeHit', at(target));
  });

  on(EV.DEATH, (p) => {
    const e = p && p.entity;
    if (!e) return;
    if (e.kind === 'unit') audio.play('unitDeath', at(e));
    else if (e.kind === 'building') audio.play('buildingDestroyed', at(e));
    // A tree falling over is EV.NODE_DEPLETED's business, not this one's.
  });

  on(EV.UNDER_ATTACK, (p) => {
    if (!mine(p)) return;
    audio.play('underAttack');
    // The alarm has to cut through, and the music bed is the only thing in the
    // mix competing with it for the same low-mid space.
    audio.duckMusic(1.2);
  });

  // --- Production and the HUD -------------------------------------------------

  on(EV.TRAINED, (p) => {
    if (!p || !p.building || p.building.player !== me) return;
    audio.play(p.unitType === 'villager' ? 'villagerTrained' : 'unitTrained');
  });

  on(EV.INSUFFICIENT, (p) => {
    if (!p || p.player === undefined || mine(p)) audio.play('invalid');
  });
  on(EV.POP_CAPPED, (p) => {
    if (!p || p.player === undefined || mine(p)) audio.play('invalid');
  });

  on(EV.SELECTION, (p) => {
    if (p && p.ids && p.ids.length) audio.play('select');
  });

  on(EV.COMMAND_FX, () => audio.play('commandAck'));

  // The age fanfare. EV.AGE_ADVANCE did not exist when the audio module was
  // written (see "Hooks the codebase does not have yet" in README.md); the tech
  // tree added it, and this is the trigger it was waiting for.
  on(EV.AGE_ADVANCE, (p) => {
    if (mine(p)) audio.play('ageAdvance');
  });

  // A trade is a small, definite thing the player did on purpose, and it moves
  // two stockpiles at once — the coin tinkle in `deposit` is exactly the right
  // sound for it and saves the catalogue a cue it does not need.
  on(EV.TRADE, (p) => {
    if (mine(p)) audio.play('deposit');
  });

  on(EV.GAME_OVER, (p) => {
    audio.play(p && p.winner === me ? 'victory' : 'defeat');
    audio.stopMusic();
  });

  return {
    destroy() {
      for (const fn of off) {
        try { fn(); } catch { /* the bus was already cleared */ }
      }
      off.length = 0;
    },
  };
}

export default createAudioAdapter;
