// The DOM HUD: resource bar, minimap, selection + command panels, build menu,
// placement bar, toasts and the idle-villager button.
//
// Everything lives in the HTML overlay declared in index.html; anything extra
// this module needs it creates itself (build menu, placement bar, gesture-mode
// chip, menu sheet) so the markup stays owned in one place.
//
//   createHud(scene, world) -> { update, destroy, toast, setPlacementMode, ... }
//
// The HUD never mutates the simulation directly: it calls the economy/unitAI
// systems, and it reads world state. Selection changes go through ui/selection.js.

import {
  PLAYER, BUILDABLE, UNIT_STATS, BUILDING_STATS, MAP_W, MAP_H, HALF_W, HALF_H,
} from '../core/constants.js';
import { EV } from '../core/events.js';
import { ownedBy } from '../core/world.js';

import * as economy from '../systems/economy.js';
import * as unitAI from '../systems/unitAI.js';

import { createMinimap, miniToGrid } from './minimap.js';
import {
  selectedEntities, setSelection, clearSelection, selectionSignature,
} from './selection.js';

const MINIMAP_HZ = 10;
const TOAST_MS = 2400;
const TOAST_MAX = 3;
const TOAST_REPEAT_MS = 1600;

const ABBR = {
  villager: 'VIL', militia: 'MIL', archer: 'ARC',
  towncenter: 'TC', house: 'HSE', barracks: 'BRK', mill: 'MLL',
};
const RES_LABEL = { food: 'food', wood: 'wood', gold: 'gold' };

const MILITARY = new Set(['militia', 'archer']);
export function isMilitary(u) { return u.kind === 'unit' && MILITARY.has(u.type); }

function statsOf(e) {
  return e.kind === 'building' ? BUILDING_STATS[e.type] : UNIT_STATS[e.type];
}
function displayName(e) {
  const s = statsOf(e);
  return (s && s.name) || e.type;
}

/** canAfford, but tolerant of an economy module that has not landed yet. */
function affordable(world, playerId, cost) {
  if (typeof economy.canAfford === 'function') {
    return economy.canAfford(world, playerId, cost);
  }
  const r = world.players[playerId].resources;
  for (const k of Object.keys(cost || {})) if ((cost[k] || 0) > (r[k] || 0)) return false;
  return true;
}

/** Which resource is short, for a precise "Not enough wood" toast. */
function missingResource(world, playerId, cost) {
  const r = world.players[playerId].resources;
  for (const k of ['wood', 'food', 'gold']) {
    if ((cost && cost[k] || 0) > (r[k] || 0)) return k;
  }
  return null;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Cost markup: "25 wood" with the matching pip. */
function costNode(cost) {
  const box = el('span', 'cost');
  let any = false;
  for (const k of ['food', 'wood', 'gold']) {
    const v = cost && cost[k];
    if (!v) continue;
    any = true;
    const b = el('b');
    b.appendChild(el('i', `ico ico-${k}`));
    b.appendChild(document.createTextNode(String(v)));
    box.appendChild(b);
  }
  if (!any) box.appendChild(el('b', null, 'free'));
  return box;
}

export function createHud(scene, world) {
  const doc = document;
  const root = doc.getElementById('hud');
  const dom = {
    root,
    food: doc.getElementById('res-food'),
    wood: doc.getElementById('res-wood'),
    gold: doc.getElementById('res-gold'),
    pop: doc.getElementById('res-pop'),
    toasts: doc.getElementById('toasts'),
    selPanel: doc.getElementById('sel-panel'),
    cmdPanel: doc.getElementById('cmd-panel'),
    idleWrap: doc.getElementById('idle-vill'),
    idleBtn: doc.getElementById('btn-idle'),
    idleCount: doc.getElementById('idle-count'),
    menuBtn: doc.getElementById('btn-menu'),
    minimap: doc.getElementById('minimap'),
  };

  const state = {
    input: null,             // set by createInput via attachInput()
    placement: null,         // building type currently being placed
    buildMenuOpen: false,
    menuOpen: false,
    selSig: '',
    cmdSig: '',
    resSig: '',
    idleSig: '',
    minimapAcc: 0,
    idleCycle: 0,
    lastToast: new Map(),
    toasts: [],
    // Elements refreshed every frame without a re-render.
    liveCosts: [],           // { el, cost }
    liveQueue: null,         // { building, bar, label }
    liveHp: [],              // { el, entity, fill }
    destroyed: false,
  };

  // --- Extra markup (owned here, not in index.html) -------------------------

  const modeChip = el('button', 'mode-chip tappable');
  modeChip.id = 'mode-chip';
  modeChip.setAttribute('aria-label', 'One-finger gesture mode');
  root.appendChild(modeChip);

  const buildMenu = el('div', 'build-menu');
  buildMenu.id = 'build-menu';
  buildMenu.hidden = true;
  root.appendChild(buildMenu);

  const placeBar = el('div', 'place-bar');
  placeBar.id = 'place-bar';
  placeBar.hidden = true;
  root.appendChild(placeBar);

  const menuSheet = el('div', 'menu-sheet');
  menuSheet.id = 'menu-sheet';
  menuSheet.hidden = true;
  root.appendChild(menuSheet);

  // The floating controls (mode chip, idle button, build menu, placement bar)
  // sit just above the bottom bar. Its height depends on what is selected, so
  // measure it rather than guessing with a magic number.
  const bottomBar = root.querySelector('.hud-bottom');
  let sizeObserver = null;
  if (bottomBar && typeof ResizeObserver === 'function') {
    sizeObserver = new ResizeObserver((entries) => {
      const h = Math.round(entries[0].contentRect.height + 12);
      root.style.setProperty('--hud-h', `${h}px`);
    });
    sizeObserver.observe(bottomBar);
  }

  // --- Minimap --------------------------------------------------------------

  const minimap = dom.minimap ? createMinimap(dom.minimap, world) : null;

  // --- Camera helpers -------------------------------------------------------

  function camera() {
    return (state.input && state.input.camera) || scene.cameras.main;
  }

  function centerOnGrid(gx, gy) {
    if (state.input && state.input.centerOnGrid) state.input.centerOnGrid(gx, gy);
    else if (scene.cameras && scene.cameras.main) {
      // Fallback: iso projection inline so the HUD works without the input layer.
      scene.cameras.main.centerOn((gx - gy) * HALF_W, (gx + gy) * HALF_H);
    }
  }

  // --- Toasts ---------------------------------------------------------------

  function toast(text, tone = 'info') {
    if (!dom.toasts || !text) return;
    const now = performance.now();
    const last = state.lastToast.get(text) || 0;
    if (now - last < TOAST_REPEAT_MS) return; // never spam the same line
    state.lastToast.set(text, now);

    const node = el('div', `toast ${tone === 'warn' ? 'warn' : ''}`, text);
    dom.toasts.appendChild(node);
    const rec = { node, at: now };
    state.toasts.push(rec);
    while (state.toasts.length > TOAST_MAX) killToast(state.toasts[0]);
  }

  function killToast(rec) {
    const i = state.toasts.indexOf(rec);
    if (i >= 0) state.toasts.splice(i, 1);
    rec.node.classList.add('out');
    setTimeout(() => rec.node.remove(), 280);
  }

  function tickToasts(now) {
    for (const rec of state.toasts.slice()) {
      if (now - rec.at > TOAST_MS) killToast(rec);
    }
  }

  // --- Resource bar ---------------------------------------------------------

  function setRes(node, value) {
    if (!node) return;
    const span = node.querySelector('span');
    if (span && span.textContent !== value) span.textContent = value;
  }

  function updateResources() {
    const p = world.players[PLAYER];
    const sig = `${p.resources.food | 0}/${p.resources.wood | 0}/${p.resources.gold | 0}/${p.pop}/${p.popCap}`;
    if (sig === state.resSig) return;
    state.resSig = sig;
    setRes(dom.food, String(Math.floor(p.resources.food)));
    setRes(dom.wood, String(Math.floor(p.resources.wood)));
    setRes(dom.gold, String(Math.floor(p.resources.gold)));
    setRes(dom.pop, `${p.pop}/${p.popCap}`);
    if (dom.pop) dom.pop.classList.toggle('low', p.pop >= p.popCap);
  }

  const RES_NODE = { food: () => dom.food, wood: () => dom.wood, gold: () => dom.gold };

  function flashRes(kinds) {
    for (const k of kinds) {
      const node = RES_NODE[k] && RES_NODE[k]();
      if (!node) continue;
      node.classList.remove('flash');
      // Force a reflow so the animation restarts on a repeat failure.
      void node.offsetWidth;
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 1000);
    }
  }

  // --- Selection panel ------------------------------------------------------

  function renderSelection() {
    const panel = dom.selPanel;
    if (!panel) return;
    panel.textContent = '';
    state.liveHp = [];

    const sel = selectedEntities(world);
    if (sel.length === 0) {
      const empty = el('div', 'sel-empty', 'Nothing selected.');
      empty.appendChild(el('small', 'sel-hint', 'Tap a unit to select. Drag to box-select.'));
      panel.appendChild(empty);
      return;
    }

    // Group by type so a big army reads as "12 Militia" not 12 identical icons.
    const groups = new Map();
    for (const e of sel) {
      const key = `${e.player}:${e.type}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { type: e.type, player: e.player, list: [] }));
      g.list.push(e);
    }

    const head = el('div', 'sel-head');
    const lead = sel[0];
    head.appendChild(el('span', 'sel-title',
      sel.length === 1 ? displayName(lead) : `${sel.length} selected`));
    const clear = el('button', 'sel-clear', '×');
    clear.setAttribute('aria-label', 'Clear selection');
    clear.addEventListener('click', () => { clearSelection(world); });
    head.appendChild(clear);
    panel.appendChild(head);

    const chips = el('div', 'sel-chips');
    for (const g of groups.values()) {
      const own = g.player === PLAYER;
      const chip = el('button', `chip ${own ? '' : g.player == null ? 'neutral' : 'foe'}`);
      chip.appendChild(el('span', 'badge', ABBR[g.type] || g.type.slice(0, 3).toUpperCase()));
      chip.appendChild(el('span', 'n', g.list.length > 1 ? `×${g.list.length}` : displayName(g.list[0]).slice(0, 8)));
      chip.title = `${displayName(g.list[0])} ×${g.list.length}`;
      // Tapping a group narrows the selection to just that type (AoE2 habit).
      chip.addEventListener('click', () => {
        if (groups.size > 1 || g.list.length !== sel.length) setSelection(world, g.list);
      });
      chips.appendChild(chip);
    }
    panel.appendChild(chips);

    // Health: one bar for a single entity, an aggregate for a group.
    const bar = el('div', 'hpbar');
    const fill = el('i');
    bar.appendChild(fill);
    panel.appendChild(bar);
    const text = el('div', 'hp-text');
    panel.appendChild(text);
    state.liveHp.push({ list: sel, bar, fill, text });
    refreshHp();
  }

  function refreshHp() {
    for (const h of state.liveHp) {
      let hp = 0;
      let max = 0;
      for (const e of h.list) {
        if (e.dead) continue;
        hp += e.hp;
        max += e.maxHp;
      }
      const frac = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
      h.fill.style.width = `${(frac * 100).toFixed(1)}%`;
      h.bar.classList.toggle('mid', frac <= 0.6 && frac > 0.3);
      h.bar.classList.toggle('low', frac <= 0.3);
      h.text.textContent = `${Math.ceil(hp)} / ${Math.ceil(max)} hp`;
    }
  }

  // --- Command panel --------------------------------------------------------

  function cmdButton(label, { cls = '', cost = null, onTap, disabled = false, sub = null } = {}) {
    const b = el('button', `cbtn ${cls}`);
    b.appendChild(el('span', 'label', label));
    if (cost) {
      const c = costNode(cost);
      b.appendChild(c);
      state.liveCosts.push({ el: b, cost });
    } else if (sub) {
      b.appendChild(el('span', 'cost', sub));
    }
    if (disabled) b.disabled = true;
    if (onTap) b.addEventListener('click', (ev) => { ev.stopPropagation(); onTap(); });
    return b;
  }

  function renderCommands() {
    const panel = dom.cmdPanel;
    if (!panel) return;
    panel.textContent = '';
    state.liveCosts = [];
    state.liveQueue = null;

    const sel = selectedEntities(world);
    const own = sel.filter((e) => e.player === PLAYER);
    const units = own.filter((e) => e.kind === 'unit');
    const villagers = units.filter((u) => u.type === 'villager');
    const buildings = own.filter((e) => e.kind === 'building' && e.complete);

    if (own.length === 0) {
      if (sel.length) {
        const e = sel[0];
        panel.appendChild(el('div', 'cmd-note',
          e.kind === 'resource'
            ? `${displayName(e) || e.type} — ${Math.ceil(e.amount)} left`
            : 'Enemy — select your own units to give orders.'));
      } else {
        panel.appendChild(el('div', 'cmd-note', 'Select a unit or building for orders.'));
      }
      return;
    }

    // Villagers: build.
    if (villagers.length) {
      panel.appendChild(cmdButton('Build', {
        cls: 'primary',
        sub: `${villagers.length} vill`,
        onTap: () => toggleBuildMenu(),
      }));
    }

    // Production buildings: train.
    const trainer = buildings.find((b) => b.trains && b.trains.length);
    if (trainer) {
      for (const t of trainer.trains) {
        const s = UNIT_STATS[t];
        if (!s) continue;
        panel.appendChild(cmdButton(s.name, {
          cost: s.cost,
          onTap: () => train(trainer, t),
        }));
      }
      renderQueue(panel, trainer);
    }

    // Stop always available to units.
    if (units.length) {
      panel.appendChild(cmdButton('Stop', {
        cls: 'danger',
        sub: 'halt',
        onTap: () => {
          command(units, { type: 'stop' });
          toast('Halted', 'info');
        },
      }));
    }

    // A foundation under construction: show progress + let villagers finish it.
    const site = own.find((e) => e.kind === 'building' && !e.complete);
    if (site) {
      const pct = Math.round(progressOf(site) * 100);
      panel.appendChild(el('div', 'cmd-note', `${displayName(site)} under construction — ${pct}%`));
    }

    refreshAffordability();
  }

  function progressOf(b) {
    if (typeof economy.buildProgressOf === 'function') return economy.buildProgressOf(b);
    const total = b.buildTime || 1;
    return Math.max(0, Math.min(1, (b.buildProgress || 0) / total));
  }

  function renderQueue(panel, b) {
    const row = el('div', 'queue');
    const prog = el('div', 'qprog');
    const fill = el('i');
    prog.appendChild(fill);
    row.appendChild(prog);

    const slots = el('div', 'qslots');
    row.appendChild(slots);
    panel.appendChild(row);
    state.liveQueue = { building: b, fill, slots, drawn: -1 };
    refreshQueue();
  }

  function refreshQueue() {
    const q = state.liveQueue;
    if (!q || !q.building || q.building.dead) return;
    const queue = q.building.queue || [];
    const p = typeof economy.trainProgress === 'function' ? economy.trainProgress(q.building) : 0;
    q.fill.style.width = `${(p * 100).toFixed(1)}%`;

    if (q.drawn !== queue.length) {
      q.drawn = queue.length;
      q.slots.textContent = '';
      queue.forEach((entry, i) => {
        const s = el('button', `qslot ${i === 0 ? 'head' : ''}`,
          ABBR[entry.type] ? ABBR[entry.type].slice(0, 1) : entry.type.slice(0, 1).toUpperCase());
        s.title = `Cancel ${entry.type}`;
        s.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (typeof economy.cancelTrain === 'function') {
            economy.cancelTrain(world, q.building, i);
            toast('Cancelled', 'info');
            state.cmdSig = ''; // force a re-render
          }
        });
        q.slots.appendChild(s);
      });
      if (queue.length === 0) q.slots.appendChild(el('span', 'cmd-note', 'idle'));
    }
  }

  function refreshAffordability() {
    for (const c of state.liveCosts) {
      const ok = affordable(world, PLAYER, c.cost);
      c.el.classList.toggle('off', !ok);
    }
  }

  function train(building, unitType) {
    const s = UNIT_STATS[unitType];
    if (!affordable(world, PLAYER, s.cost)) {
      const miss = missingResource(world, PLAYER, s.cost);
      toast(miss ? `Not enough ${RES_LABEL[miss]}` : 'Not enough resources', 'warn');
      flashRes(miss ? [miss] : ['food', 'wood', 'gold']);
      return;
    }
    if (typeof economy.queueTrain !== 'function') return;
    if (economy.queueTrain(world, building, unitType)) {
      toast(`Training ${s.name}`, 'info');
      state.cmdSig = '';
    }
  }

  function command(units, order) {
    if (typeof unitAI.commandUnits === 'function') unitAI.commandUnits(world, units, order);
  }

  // --- Build menu -----------------------------------------------------------

  function toggleBuildMenu(force) {
    const open = force === undefined ? !state.buildMenuOpen : force;
    state.buildMenuOpen = open;
    buildMenu.hidden = !open;
    if (open) renderBuildMenu();
  }

  function renderBuildMenu() {
    buildMenu.textContent = '';
    buildMenu.appendChild(el('div', 'title', 'Build'));
    for (const type of BUILDABLE) {
      const s = BUILDING_STATS[type];
      if (!s) continue;
      const ok = affordable(world, PLAYER, s.cost);
      const b = el('button', `cbtn ${ok ? '' : 'off'}`);
      b.appendChild(el('span', 'label', s.name));
      b.appendChild(costNode(s.cost));
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!affordable(world, PLAYER, s.cost)) {
          const miss = missingResource(world, PLAYER, s.cost);
          toast(miss ? `Not enough ${RES_LABEL[miss]}` : 'Not enough resources', 'warn');
          flashRes(miss ? [miss] : ['food', 'wood', 'gold']);
          return;
        }
        setPlacementMode(type);
      });
      buildMenu.appendChild(b);
    }
    const cancel = el('button', 'cbtn danger');
    cancel.appendChild(el('span', 'label', 'Close'));
    cancel.addEventListener('click', (ev) => { ev.stopPropagation(); toggleBuildMenu(false); });
    buildMenu.appendChild(cancel);
  }

  // --- Placement mode -------------------------------------------------------

  function setPlacementMode(typeOrNull) {
    state.placement = typeOrNull || null;
    toggleBuildMenu(false);
    if (!state.placement) {
      placeBar.hidden = true;
      placeBar.textContent = '';
      return;
    }
    const s = BUILDING_STATS[state.placement];
    placeBar.textContent = '';
    const txt = el('div', 'txt', `Place ${s ? s.name : state.placement}`);
    txt.appendChild(el('small', null, 'Drag to aim — lift to place'));
    placeBar.appendChild(txt);
    const cancel = el('button', 'danger', 'Cancel');
    cancel.addEventListener('click', (ev) => { ev.stopPropagation(); setPlacementMode(null); });
    placeBar.appendChild(cancel);
    placeBar.hidden = false;
    toast(`Placing ${s ? s.name : state.placement}`, 'info');
  }

  function getPlacementType() { return state.placement; }

  // --- Idle villagers -------------------------------------------------------

  function idleVillagers() {
    const out = [];
    for (const u of ownedBy(world, PLAYER, 'unit', 'villager')) {
      if (typeof unitAI.isIdle === 'function' ? unitAI.isIdle(u) : (!u.task && u.state === 'idle')) {
        out.push(u);
      }
    }
    return out;
  }

  function updateIdle() {
    const list = idleVillagers();
    const sig = String(list.length);
    if (sig === state.idleSig) return;
    state.idleSig = sig;
    if (dom.idleCount) dom.idleCount.textContent = sig;
    if (dom.idleWrap) dom.idleWrap.hidden = list.length === 0;
  }

  function cycleIdle() {
    const list = idleVillagers();
    if (!list.length) {
      toast('No idle villagers', 'info');
      return;
    }
    list.sort((a, b) => a.id - b.id);
    state.idleCycle = (state.idleCycle + 1) % list.length;
    const v = list[state.idleCycle];
    setSelection(world, [v]);
    centerOnGrid(v.x, v.y);
  }

  // --- Menu sheet -----------------------------------------------------------

  function renderMenuSheet() {
    menuSheet.textContent = '';
    const add = (label, fn) => {
      const b = el('button', null, label);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
        toggleMenu(false);
      });
      menuSheet.appendChild(b);
    };
    add('Centre on Town Center', () => {
      const tc = ownedBy(world, PLAYER, 'building', 'towncenter')[0];
      if (tc) { centerOnGrid(tc.x, tc.y); setSelection(world, [tc]); }
      else toast('No Town Center left', 'warn');
    });
    add('Select all villagers', () => {
      const v = ownedBy(world, PLAYER, 'unit', 'villager');
      if (v.length) { setSelection(world, v); toast(`${v.length} villagers`, 'info'); }
      else toast('No villagers', 'warn');
    });
    add('Select all military', () => {
      const m = ownedBy(world, PLAYER, 'unit').filter(isMilitary);
      if (m.length) { setSelection(world, m); toast(`${m.length} soldiers`, 'info'); }
      else toast('No soldiers yet', 'warn');
    });
    add('Clear selection', () => clearSelection(world));
  }

  function toggleMenu(force) {
    const open = force === undefined ? !state.menuOpen : force;
    state.menuOpen = open;
    menuSheet.hidden = !open;
    if (open) renderMenuSheet();
  }

  // --- Gesture-mode chip ----------------------------------------------------
  // Shows — and lets you lock — what a one-finger drag does right now.

  function renderModeChip() {
    const inp = state.input;
    const pref = inp ? inp.getDragPreference() : 'auto';
    const eff = inp ? inp.effectiveDragMode() : 'pan';
    const sig = `${pref}:${eff}`;
    if (modeChip.dataset.sig === sig) return;
    modeChip.dataset.sig = sig;
    modeChip.textContent = '';
    modeChip.appendChild(el('span', 'glyph', eff === 'box' ? '⬚' : '✥'));
    modeChip.appendChild(el('span', 'txt', eff === 'box' ? 'Select' : 'Pan'));
    if (pref === 'auto') modeChip.appendChild(el('span', 'auto', 'AUTO'));
    modeChip.classList.toggle('is-box', eff === 'box');
  }

  // --- Wiring ---------------------------------------------------------------

  const off = [];

  off.push(world.events.on(EV.TOAST, (p) => toast(p && p.text, p && p.tone)));

  off.push(world.events.on(EV.INSUFFICIENT, (p) => {
    if (p && p.player !== undefined && p.player !== PLAYER) return;
    const miss = p && p.cost ? missingResource(world, PLAYER, p.cost) : null;
    toast(miss ? `Not enough ${RES_LABEL[miss]}` : 'Not enough resources', 'warn');
    flashRes(miss ? [miss] : ['food', 'wood', 'gold']);
  }));

  off.push(world.events.on(EV.POP_CAPPED, (p) => {
    if (p && p.player !== undefined && p.player !== PLAYER) return;
    toast('Population capped — build a house', 'warn');
    if (dom.pop) {
      dom.pop.classList.remove('flash');
      void dom.pop.offsetWidth;
      dom.pop.classList.add('flash');
      setTimeout(() => dom.pop.classList.remove('flash'), 1000);
    }
  }));

  off.push(world.events.on(EV.SELECTION, () => {
    // Re-render on the next update() rather than synchronously, so a burst of
    // selection changes in one frame costs one layout.
    state.selSig = '';
    state.cmdSig = '';
    if (world.selection.size === 0) toggleBuildMenu(false);
  }));

  off.push(world.events.on(EV.FOUNDATION, () => { state.cmdSig = ''; }));
  off.push(world.events.on(EV.BUILT, () => { state.cmdSig = ''; }));
  off.push(world.events.on(EV.TRAINED, () => { state.cmdSig = ''; }));

  // Buttons.
  const onIdle = (ev) => { ev.stopPropagation(); cycleIdle(); };
  if (dom.idleBtn) dom.idleBtn.addEventListener('click', onIdle);

  const onMenu = (ev) => { ev.stopPropagation(); toggleMenu(); };
  if (dom.menuBtn) dom.menuBtn.addEventListener('click', onMenu);

  const onChip = (ev) => {
    ev.stopPropagation();
    if (state.input && state.input.cycleDragPreference) {
      const next = state.input.cycleDragPreference();
      toast(next === 'auto' ? 'Drag: automatic' : next === 'box' ? 'Drag: box-select' : 'Drag: pan camera', 'info');
      modeChip.dataset.sig = '';
    }
  };
  modeChip.addEventListener('click', onChip);

  // --- Minimap interaction --------------------------------------------------

  let miniDragging = false;

  function miniJump(ev) {
    if (!dom.minimap || !minimap) return;
    const r = dom.minimap.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * minimap.size;
    const py = ((ev.clientY - r.top) / r.height) * minimap.size;
    const g = miniToGrid(px, py, minimap.size);
    centerOnGrid(
      Math.max(0, Math.min(MAP_W, g.x)),
      Math.max(0, Math.min(MAP_H, g.y)),
    );
  }

  const onMiniDown = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    miniDragging = true;
    if (dom.minimap.setPointerCapture) {
      try { dom.minimap.setPointerCapture(ev.pointerId); } catch (_) { /* fine */ }
    }
    miniJump(ev);
  };
  const onMiniMove = (ev) => {
    if (!miniDragging) return;
    ev.preventDefault();
    miniJump(ev);
  };
  const onMiniUp = () => { miniDragging = false; };

  if (dom.minimap) {
    dom.minimap.addEventListener('pointerdown', onMiniDown);
    dom.minimap.addEventListener('pointermove', onMiniMove);
    dom.minimap.addEventListener('pointerup', onMiniUp);
    dom.minimap.addEventListener('pointercancel', onMiniUp);
  }

  // Tapping the map (never the HUD) closes any transient sheet.
  const gameRoot = doc.getElementById('game-root');
  const onDocDown = (ev) => {
    if (menuSheet.hidden && buildMenu.hidden) return;
    if (!gameRoot || !gameRoot.contains(ev.target)) return;
    toggleMenu(false);
    toggleBuildMenu(false);
  };
  document.addEventListener('pointerdown', onDocDown, true);

  // --- Frame ---------------------------------------------------------------

  function update(dt) {
    if (state.destroyed) return;
    const now = performance.now();

    updateResources();
    updateIdle();
    tickToasts(now);

    const sig = selectionSignature(world);
    if (sig !== state.selSig) {
      state.selSig = sig;
      renderSelection();
    } else {
      refreshHp();
    }

    // The command panel depends on which types are selected, not on hp, so it
    // re-renders far less often than the selection panel.
    const csig = commandSignature();
    if (csig !== state.cmdSig) {
      state.cmdSig = csig;
      renderCommands();
      if (state.buildMenuOpen) renderBuildMenu();
    } else {
      refreshQueue();
      refreshAffordability();
    }

    renderModeChip();

    state.minimapAcc += dt;
    if (minimap && state.minimapAcc >= 1 / MINIMAP_HZ) {
      state.minimapAcc = 0;
      minimap.draw(camera());
    }
  }

  function commandSignature() {
    const sel = selectedEntities(world);
    if (!sel.length) return '-';
    let types = new Set();
    let n = 0;
    let q = '';
    for (const e of sel) {
      if (e.player !== PLAYER) { types.add(`x${e.kind}`); continue; }
      types.add(`${e.kind}:${e.type}:${e.complete === false ? 'f' : 'c'}`);
      n++;
      if (e.kind === 'building') q += `|${e.id}:${(e.queue || []).length}`;
    }
    return `${n}/${Array.from(types).sort().join(',')}${q}`;
  }

  function destroy() {
    state.destroyed = true;
    if (sizeObserver) sizeObserver.disconnect();
    root.style.removeProperty('--hud-h');
    for (const fn of off) { try { fn(); } catch (_) { /* already gone */ } }
    if (dom.idleBtn) dom.idleBtn.removeEventListener('click', onIdle);
    if (dom.menuBtn) dom.menuBtn.removeEventListener('click', onMenu);
    modeChip.removeEventListener('click', onChip);
    if (dom.minimap) {
      dom.minimap.removeEventListener('pointerdown', onMiniDown);
      dom.minimap.removeEventListener('pointermove', onMiniMove);
      dom.minimap.removeEventListener('pointerup', onMiniUp);
      dom.minimap.removeEventListener('pointercancel', onMiniUp);
    }
    document.removeEventListener('pointerdown', onDocDown, true);
    for (const n of [modeChip, buildMenu, placeBar, menuSheet]) n.remove();
    if (dom.selPanel) dom.selPanel.textContent = '';
    if (dom.cmdPanel) dom.cmdPanel.textContent = '';
    for (const rec of state.toasts.slice()) rec.node.remove();
    state.toasts.length = 0;
  }

  const api = {
    update,
    destroy,
    toast,
    setPlacementMode,
    // Extras the input layer and tests use.
    getPlacementType,
    cycleIdle,
    flashRes,
    attachInput(input) { state.input = input; modeChip.dataset.sig = ''; },
    _dom: dom,
  };

  // First paint.
  updateResources();
  renderSelection();
  renderCommands();
  renderModeChip();
  if (minimap) minimap.draw(camera());

  return api;
}
