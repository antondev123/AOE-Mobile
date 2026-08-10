// Shared selection helpers for the HUD and the input layer.
//
// `world.selection` is the single source of truth (a Set of entity ids). Every
// mutation goes through here so EV.SELECTION is emitted exactly once and stale
// ids are pruned in one place.

import { EV } from '../core/events.js';
// The local player's seat, as a live binding — see src/core/viewpoint.js for
// why this is imported under the old name instead of threading a parameter.
import { ME as PLAYER } from '../core/viewpoint.js';

/** Live entities that are currently selected (dead/removed ids are dropped). */
export function selectedEntities(world) {
  const out = [];
  for (const id of world.selection) {
    const e = world.entities.get(id);
    if (e && !e.dead) out.push(e);
    else world.selection.delete(id);
  }
  return out;
}

export function selectedUnits(world) {
  return selectedEntities(world).filter((e) => e.kind === 'unit');
}

export function selectedBuildings(world) {
  return selectedEntities(world).filter((e) => e.kind === 'building');
}

/** True if the player owns anything currently selected. */
export function hasOwnSelection(world, playerId = PLAYER) {
  for (const e of selectedEntities(world)) if (e.player === playerId) return true;
  return false;
}

function sameSet(set, entities) {
  if (set.size !== entities.length) return false;
  for (const e of entities) if (!set.has(e.id)) return false;
  return true;
}

/**
 * Replace the selection. No-ops (and emits nothing) when the selection is
 * already exactly this, so the HUD does not thrash on repeated taps.
 */
export function setSelection(world, entities) {
  const list = (entities || []).filter((e) => e && !e.dead);
  if (sameSet(world.selection, list)) return false;
  world.selection.clear();
  for (const e of list) world.selection.add(e.id);
  emitSelection(world);
  return true;
}

export function addToSelection(world, entities) {
  let changed = false;
  for (const e of entities || []) {
    if (!e || e.dead || world.selection.has(e.id)) continue;
    world.selection.add(e.id);
    changed = true;
  }
  if (changed) emitSelection(world);
  return changed;
}

export function clearSelection(world) {
  if (world.selection.size === 0) return false;
  world.selection.clear();
  emitSelection(world);
  return true;
}

export function emitSelection(world) {
  world.events.emit(EV.SELECTION, { ids: Array.from(world.selection) });
}

/**
 * A cheap string that changes whenever anything the selection panel draws
 * changes. Lets the HUD skip DOM work on most frames.
 */
export function selectionSignature(world) {
  const es = selectedEntities(world);
  if (es.length === 0) return '-';
  let s = `${es.length}`;
  for (const e of es) {
    // Resource nodes have no hp at all and farms have both hp and a stock, so
    // the signature buckets whichever of the two the entity actually carries.
    // Left as a raw hp ratio it read `NaN` for every bush, which is exactly the
    // value the panel then printed at the player.
    s += `|${e.id}:${e.type}:${bucket(e.hp, e.maxHp)}:${bucket(e.amount, e.maxAmount)}`;
    if (e.kind === 'building') {
      s += `:${e.complete ? 1 : 0}:${e.queue ? e.queue.length : 0}`;
    }
  }
  return s;
}

/** A 0-20 bucket of value/max, or '-' when this entity has no such pair. */
function bucket(v, max) {
  if (!Number.isFinite(v) || !Number.isFinite(max) || max <= 0) return '-';
  return String(Math.ceil((v / max) * 20));
}
