// Minimal synchronous event bus.
//
// Systems communicate through this rather than reaching into each other, so
// each system can be developed and tested on its own. Handlers run in
// registration order, synchronously, during whichever system emitted.

export class EventBus {
  constructor() {
    this.handlers = new Map();
  }

  on(type, fn) {
    let list = this.handlers.get(type);
    if (!list) this.handlers.set(type, (list = []));
    list.push(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    const list = this.handlers.get(type);
    if (!list) return;
    // Iterate a copy: handlers may unsubscribe or emit during dispatch.
    for (const fn of list.slice()) fn(payload);
  }

  clear() {
    this.handlers.clear();
  }
}

/**
 * Event names. Payload shapes are documented here — this is the contract
 * between systems, keep it accurate.
 */
export const EV = {
  // { entity } — an entity was added to the world
  SPAWN: 'spawn',
  // { entity, killer } — hp hit zero, entity still present this frame
  DEATH: 'death',
  // { entity } — entity removed from the world, do not dereference after
  REMOVED: 'removed',

  // { entity, target, amount } — damage actually applied (post-armor)
  DAMAGE: 'damage',
  // { from, to } — a projectile was launched
  PROJECTILE: 'projectile',

  // { unit, node, type, amount } — a gather tick landed
  GATHER_TICK: 'gatherTick',
  // { unit, building, type, amount } — resources banked at a dropoff
  DEPOSIT: 'deposit',
  // { node } — resource node ran dry
  NODE_DEPLETED: 'nodeDepleted',

  // { player, type, amount, reason }
  RESOURCE_CHANGE: 'resourceChange',
  // { player } — could not afford something the player asked for
  INSUFFICIENT: 'insufficient',
  // { player } — tried to train past the population cap
  POP_CAPPED: 'popCapped',

  // { building, unitType } — training finished, unit spawned
  TRAINED: 'trained',
  // { building } — construction finished
  BUILT: 'built',
  // { building, builder } — foundation placed
  FOUNDATION: 'foundation',

  // { ids } — the player's selection changed
  SELECTION: 'selection',
  // { text, gx, gy, color } — request a floating world-space label
  FLOAT_TEXT: 'floatText',
  // { text, tone } — request a HUD toast ('info' | 'warn')
  TOAST: 'toast',
  // { gx, gy, kind } — a command was issued, show a marker ('move'|'attack'|'gather')
  COMMAND_FX: 'commandFx',

  // { winner } — the match ended
  GAME_OVER: 'gameOver',
};
