// Saving and resuming a match.
//
// The interesting assertion in this file is not "the same number of villagers
// came back". It is that a restored world and the world it was taken from are
// the *same simulation*: step both of them forward for a minute and every
// entity is in the same place, holding the same job, with the same resources
// banked and the same fog on the map. That is a much stronger statement than
// equivalence at the moment of the load, and it is the one that catches a save
// that forgot the RNG state, or the id counter, or the order of a set.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWorld, reindex, ownedBy, recomputePop, removeEntity, spawnUnit,
} from '../src/core/world.js';
import { generateMap } from '../src/core/mapgen.js';
import { SIM_DT, PLAYER, ENEMY } from '../src/core/constants.js';
import { updateUnits, commandUnits } from '../src/systems/unitAI.js';
import { updateCombat } from '../src/systems/combat.js';
import { garrisonUnit } from '../src/systems/combat.js';
import { updateEconomy, buildQueue, placeFoundation, enqueueFoundation } from '../src/systems/economy.js';
import { updateAllocation, setAllocationOn, setSplit, allocationState } from '../src/systems/allocation.js';
import { createEnemyAI } from '../src/systems/enemyAI.js';
import { currentAge, hasTech, researchedTechs, queueResearch } from '../src/systems/tech.js';
import {
  SAVE_VERSION, serializeGame, restoreGame, bytesToB64, b64ToBytes,
  readSave, writeSave, clearSave, saveInfo,
} from '../src/core/save.js';

// --- A match to save ---------------------------------------------------------

function newMatch(seed) {
  const world = createWorld(seed);
  generateMap(world);
  recomputePop(world, PLAYER);
  recomputePop(world, ENEMY);
  world.vision.update();
  const ai = createEnemyAI(world, ENEMY);
  return { world, ai };
}

/** One fixed step, in GameScene.simStep's order. */
function step(world, ai) {
  for (const u of world.units) { u.px = u.x; u.py = u.y; }
  reindex(world);
  updateAllocation(world, SIM_DT);
  updateUnits(world, SIM_DT);
  updateCombat(world, SIM_DT);
  updateEconomy(world, SIM_DT);
  if (ai) ai.update(SIM_DT);
  world.vision.update();
  world.time += SIM_DT;
  world.tick++;
}

function run(world, ai, steps) {
  for (let i = 0; i < steps; i++) step(world, ai);
}

/**
 * Set the player side going too, so the save under test carries live villager
 * tasks, a build queue, a training queue and an allocation manager rather than
 * three villagers standing still.
 */
function busyPlayer(world) {
  const mine = ownedBy(world, PLAYER, 'unit');
  for (const u of mine) {
    let best = null;
    let bestD = Infinity;
    for (const n of world.resources) {
      const d = (n.x - u.x) ** 2 + (n.y - u.y) ** 2;
      if (d < bestD) { bestD = d; best = n; }
    }
    if (best) commandUnits(world, [u], { type: 'gather', target: best, gx: best.x, gy: best.y });
  }
  setAllocationOn(world, PLAYER, true);
  setSplit(world, PLAYER, 'wood', 40);
}

/**
 * A fingerprint of everything a player can see about the simulation.
 *
 * Positions to four decimals rather than exactly: this compares two independent
 * runs of identical float arithmetic, which *is* bit-identical, but a rounded
 * comparison fails just as loudly on a real divergence and produces a diff a
 * human can read instead of a wall of seventeen-digit numbers.
 */
function fingerprint(world) {
  const ents = [];
  for (const e of world.entities.values()) {
    ents.push([
      e.id, e.kind, e.type, e.player,
      e.x.toFixed(4), e.y.toFixed(4),
      e.hp === undefined ? '-' : Math.round(e.hp),
      e.state || '-',
      e.amount === undefined ? '-' : Math.round(e.amount),
      e.carrying ? `${e.carrying.type || '-'}:${Math.floor(e.carrying.amount || 0)}` : '-',
      e.task ? `${e.task.type}:${e.task.stage || '-'}:${taskRef(e.task)}` : '-',
      e.target ? e.target.id : 0,
      e.queue ? e.queue.map((q) => `${q.type}@${q.remaining.toFixed(2)}`).join('+') : '-',
      e.research ? e.research.map((r) => `${r.id}@${r.remaining.toFixed(2)}`).join('+') : '-',
      e.buildProgress === undefined ? '-' : e.buildProgress.toFixed(3),
      e.garrison ? e.garrison.map((u) => u.id).join('/') : '-',
    ].join(','));
  }
  return {
    time: world.time.toFixed(3),
    tick: world.tick,
    nextId: world.nextId,
    rng: world.rng.getState(),
    over: world.over,
    winner: world.winner,
    players: world.players.map((p) => ({
      res: Object.fromEntries(
        Object.entries(p.resources).map(([k, v]) => [k, Math.round(v * 1000) / 1000]),
      ),
      pop: p.pop,
      popCap: p.popCap,
      defeated: p.defeated,
      owned: Array.from(p.owned).join(','),
    })),
    // Not sorted: the *order* of these lists is part of the simulation, because
    // several passes iterate them and stop at their first hit.
    entities: ents.join('|'),
    units: world.units.map((u) => u.id).join(','),
    buildings: world.buildings.map((b) => b.id).join(','),
    resources: world.resources.map((r) => r.id).join(','),
    ages: world.players.map((p) => currentAge(world, p.id)),
    techs: world.players.map((p) => researchedTechs(world, p.id).join(',')),
    buildQueues: world.players.map((p) => buildQueue(world, p.id).map((b) => b.id).join(',')),
    explored: world.players.map((p) => {
      const ex = world.vision.state(p.id).explored;
      let n = 0;
      for (let i = 0; i < ex.length; i++) n += ex[i];
      return n;
    }),
    visible: world.players.map((p) => {
      const vis = world.vision.state(p.id).visible;
      let n = 0;
      for (let i = 0; i < vis.length; i++) n += vis[i];
      return n;
    }),
    memory: world.players.map((p) => world.vision.state(p.id).memory.length),
    blocked: (() => {
      let n = 0;
      for (let i = 0; i < world.blocked.length; i++) n += world.blocked[i] ? 1 : 0;
      return n;
    })(),
  };
}

function taskRef(t) {
  const e = t.node || t.building || t.target;
  return e && e.id ? e.id : 0;
}

// --- base64 ------------------------------------------------------------------

test('the byte codec round-trips every length and every byte value', () => {
  for (let len = 0; len < 8; len++) {
    const src = new Uint8Array(len);
    for (let i = 0; i < len; i++) src[i] = (i * 37 + 11) & 255;
    const back = b64ToBytes(bytesToB64(src));
    assert.deepEqual(Array.from(back), Array.from(src), `length ${len}`);
  }
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  assert.deepEqual(Array.from(b64ToBytes(bytesToB64(all))), Array.from(all));
});

// --- equivalence at the moment of the load -----------------------------------

test('a restored world is equivalent to the world it was saved from', () => {
  const { world, ai } = newMatch(9182);
  busyPlayer(world);
  run(world, ai, 2600);   // 130 seconds: houses up, villagers working, fog open

  // The state under test has to actually contain the things being asserted.
  assert.ok(world.units.length > 6, `only ${world.units.length} units in the fixture`);
  assert.ok(world.buildings.length > 2, `only ${world.buildings.length} buildings`);
  assert.ok(world.units.some((u) => u.task), 'no unit is holding a task');
  assert.ok(world.buildings.some((b) => (b.queue || []).length), 'nothing is training');

  const before = fingerprint(world);
  const payload = JSON.parse(JSON.stringify(
    serializeGame(world, { ai: ai.serialize(), view: { x: 5, y: 6, zoom: 0.7 } }),
  ));
  const { world: loaded, ai: aiData, view } = restoreGame(payload);
  const loadedAI = createEnemyAI(loaded, ENEMY);
  loadedAI.restore(aiData);
  // Vision's visible mask and viewer cache are deliberately rebuilt rather than
  // stored, and the first update after a load is where that happens.
  loaded.vision.update();

  assert.deepEqual(view, { x: 5, y: 6, zoom: 0.7 });
  assert.deepEqual(fingerprint(loaded), before);
});

test('references between entities come back as the same objects, not copies', () => {
  const { world, ai } = newMatch(4242);
  busyPlayer(world);
  run(world, ai, 1800);

  const payload = JSON.parse(JSON.stringify(serializeGame(world, { ai: ai.serialize() })));
  const { world: loaded } = restoreGame(payload);

  let checked = 0;
  for (const u of loaded.units) {
    const t = u.task;
    if (t) {
      for (const key of ['node', 'building', 'target']) {
        const ref = t[key];
        if (!ref) continue;
        checked++;
        assert.equal(loaded.entities.get(ref.id), ref,
          `task.${key} on unit ${u.id} is a copy, not the live entity`);
      }
    }
    if (u.target) {
      checked++;
      assert.equal(loaded.entities.get(u.target.id), u.target, 'unit.target is a copy');
    }
  }
  for (const b of loaded.buildings) {
    for (const g of b.garrison || []) {
      checked++;
      assert.equal(loaded.entities.get(g.id), g, 'a garrisoned unit is a copy');
    }
  }
  assert.ok(checked > 0, 'the fixture held no cross-entity references to check');
});

test('the occupancy grid is rebuilt, not stored, and agrees with the entities', () => {
  const { world, ai } = newMatch(777);
  busyPlayer(world);
  run(world, ai, 2000);

  const payload = JSON.parse(JSON.stringify(serializeGame(world, { ai: ai.serialize() })));
  const { world: loaded } = restoreGame(payload);

  assert.deepEqual(Array.from(loaded.terrain), Array.from(world.terrain));
  assert.deepEqual(Array.from(loaded.blocked), Array.from(world.blocked));
  assert.deepEqual(Array.from(loaded.occupant), Array.from(world.occupant));
  assert.deepEqual(Array.from(loaded.gateOwner), Array.from(world.gateOwner));
});

// --- the real assertion: the two keep in step --------------------------------

test('a loaded game continues identically, tick for tick', () => {
  const { world, ai } = newMatch(31868);
  busyPlayer(world);
  run(world, ai, 2400);

  const payload = JSON.parse(JSON.stringify(serializeGame(world, { ai: ai.serialize() })));
  const { world: loaded, ai: aiData } = restoreGame(payload);
  const loadedAI = createEnemyAI(loaded, ENEMY);
  loadedAI.restore(aiData);
  loaded.vision.update();

  // Two more minutes on each. Long enough that the enemy AI thinks 240 times,
  // launches from its restored wave clock, re-tasks villagers off exhausted
  // nodes and spends RNG draws on placement and wave intervals — every one of
  // which diverges immediately if the generator state or the id counter was not
  // carried across.
  const STEPS = 2400;
  for (let i = 0; i < STEPS; i++) {
    step(world, ai);
    step(loaded, loadedAI);
    if (i % 400 === 399 || i === STEPS - 1) {
      assert.deepEqual(fingerprint(loaded), fingerprint(world),
        `diverged ${i + 1} steps after the load`);
    }
  }
  // ...and it has to have been a match worth comparing.
  assert.ok(loaded.time > 240, `only reached ${loaded.time.toFixed(0)}s`);
  assert.ok(loaded.nextId > world.entities.size, 'nothing was spawned after the load');
});

test('a save taken mid-fight continues identically', () => {
  const { world, ai } = newMatch(5150);
  busyPlayer(world);
  run(world, ai, 1200);

  // Stage a brawl in the middle of the enemy's town so combat, projectiles,
  // damage and deaths are all live across the save boundary.
  const tc = ownedBy(world, ENEMY, 'building', 'towncenter')[0];
  const mine = [];
  for (let i = 0; i < 8; i++) {
    mine.push(spawnUnit(world, i % 2 ? 'militia' : 'archer', PLAYER,
      tc.x - 4 + (i % 4) * 0.9, tc.y - 4 + Math.floor(i / 4) * 0.9));
  }
  world.players[PLAYER].popCap = 100;
  commandUnits(world, mine, { type: 'attackMove', x: tc.x, y: tc.y });
  run(world, ai, 400);
  assert.ok(world.projectiles.length + world.units.filter((u) => u.state === 'attack').length > 0,
    'the fixture is not actually fighting');

  const payload = JSON.parse(JSON.stringify(serializeGame(world, { ai: ai.serialize() })));
  const { world: loaded, ai: aiData } = restoreGame(payload);
  const loadedAI = createEnemyAI(loaded, ENEMY);
  loadedAI.restore(aiData);
  loaded.vision.update();

  for (let i = 0; i < 900; i++) {
    step(world, ai);
    step(loaded, loadedAI);
  }
  assert.deepEqual(fingerprint(loaded), fingerprint(world));
});

// --- versioning --------------------------------------------------------------

test('a save from an incompatible version is refused, not half-loaded', () => {
  const { world, ai } = newMatch(1234);
  run(world, ai, 200);
  const payload = JSON.parse(JSON.stringify(serializeGame(world, { ai: ai.serialize() })));

  payload.v = SAVE_VERSION + 1;
  assert.throws(() => restoreGame(payload), /version/i);
  payload.v = SAVE_VERSION - 1;
  assert.throws(() => restoreGame(payload), /version/i);
  delete payload.v;
  assert.throws(() => restoreGame(payload), /version/i);

  assert.throws(() => restoreGame(null), /empty/i);
  assert.throws(() => restoreGame({ v: SAVE_VERSION }), /entities/i);

  // A map size this build does not play is refused for the same reason, and
  // before a single entity has been built out of it.
  const wrongMap = JSON.parse(JSON.stringify(serializeGame(world)));
  wrongMap.width = 48;
  assert.throws(() => restoreGame(wrongMap), /48x/);
});

test('storage refuses an incompatible payload with a sentence, and offers nothing', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    clearSave();
    assert.equal(saveInfo(), null, 'offered a resume with nothing stored');

    const { world, ai } = newMatch(2468);
    run(world, ai, 600);
    const written = writeSave(serializeGame(world, { ai: ai.serialize() }));
    assert.ok(written.ok, written.error);

    const info = saveInfo();
    assert.ok(info && !info.error, 'a fresh save was not offered');
    assert.equal(info.time, Math.floor(world.time));
    assert.match(info.label, /^\d+m \d\ds$/);

    // Now age it out from under the build.
    const raw = JSON.parse(store.get('aos.save.v1'));
    raw.v = 0;
    store.set('aos.save.v1', JSON.stringify(raw));
    const stale = readSave();
    assert.equal(stale.data, null);
    assert.match(stale.error, /older version/i);
    assert.match(saveInfo().error, /older version/i);

    store.set('aos.save.v1', '{not json');
    assert.match(readSave().error, /corrupt/i);

    // A finished match is not offered at all — there is nothing to resume.
    world.over = true;
    world.winner = PLAYER;
    writeSave(serializeGame(world, { ai: ai.serialize() }));
    assert.equal(saveInfo(), null);

    clearSave();
    assert.equal(saveInfo(), null);
  } finally {
    delete globalThis.localStorage;
  }
});

test('nothing throws when there is no local storage at all', () => {
  assert.equal(typeof localStorage, 'undefined');
  assert.equal(saveInfo(), null);
  assert.equal(readSave().data, null);
  assert.equal(writeSave({ v: SAVE_VERSION }).ok, false);
  clearSave();
});

// --- the awkward corners -----------------------------------------------------

test('a build queue, a research queue and a garrison all survive the trip', () => {
  const { world, ai } = newMatch(60606);
  busyPlayer(world);
  run(world, ai, 1400);

  // A queued row of houses the player asked for in one breath.
  const tc = ownedBy(world, PLAYER, 'building', 'towncenter')[0];
  world.players[PLAYER].resources.wood = 900;
  world.players[PLAYER].resources.food = 900;
  let placed = 0;
  for (let dy = -8; dy <= 8 && placed < 3; dy++) {
    for (let dx = -8; dx <= 8 && placed < 3; dx++) {
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) continue;
      const b = placeFoundation(world, PLAYER, 'house',
        Math.round(tc.x) + dx, Math.round(tc.y) + dy);
      if (b) { enqueueFoundation(world, b); placed++; }
    }
  }
  assert.ok(placed >= 1, 'could not place a queued foundation for the fixture');

  // Somebody inside the Town Center.
  const vill = ownedBy(world, PLAYER, 'unit', 'villager')[0];
  assert.ok(garrisonUnit(world, vill, tc), 'could not garrison a villager for the fixture');

  const beforeQueue = buildQueue(world, PLAYER).map((b) => b.id);
  const beforeGarrison = tc.garrison.map((u) => u.id);
  assert.ok(beforeGarrison.length >= 1);
  assert.ok(!world.units.includes(vill), 'a garrisoned unit should be off the unit list');

  const payload = JSON.parse(JSON.stringify(serializeGame(world, { ai: ai.serialize() })));
  const { world: loaded } = restoreGame(payload);

  assert.deepEqual(buildQueue(loaded, PLAYER).map((b) => b.id), beforeQueue);
  const loadedTC = loaded.entities.get(tc.id);
  assert.deepEqual(loadedTC.garrison.map((u) => u.id), beforeGarrison);
  assert.ok(loaded.entities.has(vill.id), 'the garrisoned villager was lost');
  assert.ok(!loaded.units.includes(loaded.entities.get(vill.id)),
    'the garrisoned villager came back onto the map');
  assert.ok(loaded.players[PLAYER].owned.has(vill.id), 'it stopped being owned');
});

test('tech, fog and the allocation manager come back exactly', () => {
  const { world, ai } = newMatch(13131);
  busyPlayer(world);
  const tc = ownedBy(world, PLAYER, 'building', 'towncenter')[0];
  world.players[PLAYER].resources.food = 2000;
  assert.ok(queueResearch(world, tc, 'feudal_age'), 'could not start an age-up');
  run(world, ai, 1400);
  assert.equal(currentAge(world, PLAYER), 1, 'the fixture never reached the Feudal Age');

  const beforeHp = tc.maxHp;
  const beforeAlloc = allocationState(world, PLAYER);
  const beforeExplored = Array.from(world.vision.state(PLAYER).explored);

  // Make the memory rather than hope for it.
  //
  // This used to assert that 1400 steps of ordinary villager work had left
  // something remembered, and on the seed it was written against it had. That
  // is a coincidence, not a fixture: memory is written at the instant a tile
  // stops being visible, so whether any exists depends entirely on whether some
  // unit happened to walk away from something it had uncovered — and the day
  // the map generator changed (rock outcrops moved every resource on this seed)
  // this test failed for a reason that had nothing to do with saving or
  // loading. A test whose subject is "does memory round-trip" must not be able
  // to fail because of where the berries landed.
  //
  // So: walk a villager out to bare ground and back. Out uncovers tiles it has
  // never seen; back conceals them again, which is exactly the moment vision.js
  // writes a snapshot. Assert it worked before relying on it.
  const walker = ownedBy(world, PLAYER, 'unit')[0];
  const home = { x: walker.x, y: walker.y };
  commandUnits(world, [walker], { type: 'move', gx: walker.x + 12, gy: walker.y + 12 });
  run(world, ai, 400);
  commandUnits(world, [walker], { type: 'move', gx: home.x, gy: home.y });
  run(world, ai, 400);

  const beforeMemory = world.vision.state(PLAYER).memory.length;
  assert.ok(beforeMemory > 0,
    'the fixture was supposed to create memory by walking a unit out and back');

  const payload = JSON.parse(JSON.stringify(serializeGame(world, { ai: ai.serialize() })));
  const { world: loaded } = restoreGame(payload);
  loaded.vision.update();

  assert.equal(currentAge(loaded, PLAYER), 1);
  assert.ok(hasTech(loaded, PLAYER, 'feudal_age'));
  // The age's building-hitpoint scale is baked into what was saved. A load that
  // replayed the age-up would apply it a second time.
  assert.equal(loaded.entities.get(tc.id).maxHp, beforeHp);

  const la = allocationState(loaded, PLAYER);
  assert.equal(la.on, beforeAlloc.on);
  assert.deepEqual(la.split, beforeAlloc.split);
  assert.equal(la.moves, beforeAlloc.moves);

  assert.deepEqual(Array.from(loaded.vision.state(PLAYER).explored), beforeExplored);
  assert.equal(loaded.vision.state(PLAYER).memory.length, beforeMemory);
  // The visible mask is derived, and the first update after a load is where it
  // is derived — so it has to agree with a from-scratch recompute.
  const scratch = loaded.vision.recomputeFromScratch(PLAYER);
  assert.deepEqual(
    Array.from(loaded.vision.state(PLAYER).visible), Array.from(scratch.visible),
  );
});

test('an entity that died between the save and the load leaves no dangling reference', () => {
  const { world, ai } = newMatch(24680);
  busyPlayer(world);
  run(world, ai, 1600);

  const payload = JSON.parse(JSON.stringify(serializeGame(world, { ai: ai.serialize() })));
  // Delete a resource node from the payload without touching anything that
  // points at it — which is what a hand-edited or truncated save looks like.
  const victim = payload.resources[Math.floor(payload.resources.length / 2)];
  payload.entities = payload.entities.filter((e) => e.id !== victim);
  payload.resources = payload.resources.filter((id) => id !== victim);
  for (const p of payload.players) p.owned = p.owned.filter((id) => id !== victim);

  const { world: loaded } = restoreGame(payload);
  assert.ok(!loaded.entities.has(victim));
  for (const u of loaded.units) {
    const t = u.task;
    if (t && t.node) assert.ok(loaded.entities.has(t.node.id), 'a task points at a ghost');
    if (u.target) assert.ok(loaded.entities.has(u.target.id), 'a target points at a ghost');
  }
  // ...and it still runs.
  const loadedAI = createEnemyAI(loaded, ENEMY);
  loadedAI.restore(payload.ai);
  run(loaded, loadedAI, 200);
  assert.equal(loadedAI.stats.errors, 0, loadedAI.stats.lastError);
});

test('a save is small enough to live in localStorage', () => {
  const { world, ai } = newMatch(8080);
  busyPlayer(world);
  run(world, ai, 4000);
  const text = JSON.stringify(serializeGame(world, { ai: ai.serialize() }));
  // The 5MB localStorage quota is the real limit, and UTF-16 storage doubles
  // this figure on the way in. Half a megabyte of text is a comfortable
  // fraction of it and leaves room for a match that runs much longer than this
  // one; anything approaching the quota means the resource nodes have stopped
  // being packed the way they are here.
  assert.ok(text.length < 1_400_000,
    `save is ${(text.length / 1024).toFixed(0)}kB, which is too close to the quota`);
  assert.ok(text.length > 20_000, 'suspiciously small — did the entities get written?');
});

test('a razed match still saves and reloads', () => {
  const { world, ai } = newMatch(31415);
  busyPlayer(world);
  run(world, ai, 1600);
  // Take out everything the enemy owns except its villagers, mid-think.
  for (const b of ownedBy(world, ENEMY, 'building')) removeEntity(world, b);
  run(world, ai, 100);

  const payload = JSON.parse(JSON.stringify(serializeGame(world, { ai: ai.serialize() })));
  const { world: loaded, ai: aiData } = restoreGame(payload);
  const loadedAI = createEnemyAI(loaded, ENEMY);
  loadedAI.restore(aiData);
  loaded.vision.update();

  for (let i = 0; i < 600; i++) {
    step(world, ai);
    step(loaded, loadedAI);
  }
  assert.deepEqual(fingerprint(loaded), fingerprint(world));
  assert.equal(loadedAI.stats.errors, 0, loadedAI.stats.lastError);
});
