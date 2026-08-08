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
  MILITARY_TYPES, STANCE_ORDER, STANCE_LABEL, STANCE_BLURB,
  FORMATION_ORDER, FORMATION_LABEL, FORMATION_BLURB, DEFAULT_FORMATION,
} from '../core/constants.js';
import { EV } from '../core/events.js';
import { ownedBy, forEachNear, edgeDist2, removeEntity } from '../core/world.js';

import * as economy from '../systems/economy.js';
import * as unitAI from '../systems/unitAI.js';
import * as tech from '../systems/tech.js';
import {
  stanceOf, garrisonCapacity, garrisonCount, isGarrisoned, nearestShelter,
  ungarrisonAll,
} from '../systems/combat.js';

import { createMinimap, miniToGrid } from './minimap.js';
import {
  selectedEntities, setSelection, clearSelection, selectionSignature,
} from './selection.js';

const MINIMAP_HZ = 10;
const TOAST_MS = 2400;
// Two, not three. The stack sits over the top-left of the map, which is where
// your own base tends to be, and three of them plus an alert blanketed the
// Town Center the player was being told to go and look at.
const TOAST_MAX = 2;
const TOAST_REPEAT_MS = 1600;
// An under-attack alert lives longer than a routine toast — it is a thing you
// are meant to *reach for*, and 2.4s is not enough time to see it and tap it.
const ALERT_MS = 5200;
// Combat.js throttles these properly; this is only a floor so a mis-behaving
// emitter can never machine-gun the DOM.
const ALERT_MIN_MS = 1200;
// How long the minimap frame keeps flashing after an alert.
const ALERT_GLOW_MS = 5000;

// Demolish is destructive and irreversible, so the button arms on the first tap
// and only destroys on the second — the same arm-then-confirm the game already
// teaches with attack-move and building placement. The armed state expires on
// its own so a forgotten arm cannot be spent by a tap thirty seconds later.
const DEMOLISH_ARM_MS = 4000;

// A rally point this close to something workable *is* an order to work it.
// Must match unitAI's RALLY_SNAP: the HUD's job below is to say out loud what
// the unit AI has already decided, and a HUD that disagrees with the sim is
// worse than no HUD at all.
const RALLY_SNAP = 1.5;

const ABBR = {
  villager: 'VIL', militia: 'MIL', archer: 'ARC',
  spearman: 'SPR', scout: 'CAV', ram: 'RAM',
  towncenter: 'TC', house: 'HSE', barracks: 'BRK', mill: 'MLL',
  lumbercamp: 'LMB', miningcamp: 'MIN',
  berry: 'BSH', tree: 'TRE', gold: 'GLD', stone: 'STN',
};
// The build menu lists the whole tech tree, locked entries included, and on a
// 390px screen that is a lot of buttons. Grouping them under their age turns a
// scrolling wall into three short shelves, and the shelf heading is also the
// answer to "when do I get this".
const AGE_HEADINGS = ['Dark Age', 'Feudal Age', 'Castle Age'];
const RES_LABEL = { food: 'food', wood: 'wood', gold: 'gold', stone: 'stone' };
// Display order for costs, the resource bar and "not enough X" flashes. One
// list, so the four resources can never appear in a different order in two
// places on the same screen.
const RES_ORDER = ['food', 'wood', 'gold', 'stone'];
// Resource nodes have no stats block, so they need their own display names —
// "berry" in the selection header reads like a bug, "Berry Bush" reads like AoE.
const NODE_NAME = {
  berry: 'Berry Bush', tree: 'Tree', gold: 'Gold Vein', stone: 'Stone Mine',
};

// Derived from UNIT_STATS rather than written out, so a unit added to the roster
// is a soldier here — selectable by "select all military", eligible for
// attack-move, counted in the stance panel — the moment it declares itself one.
const MILITARY = new Set(MILITARY_TYPES);
export function isMilitary(u) { return u.kind === 'unit' && MILITARY.has(u.type); }

function statsOf(e) {
  return e.kind === 'building' ? BUILDING_STATS[e.type] : UNIT_STATS[e.type];
}
function displayName(e) {
  if (e.kind === 'resource') return NODE_NAME[e.type] || e.type;
  const s = statsOf(e);
  return (s && s.name) || e.type;
}

/**
 * Does this entity have a health bar worth drawing? Resource nodes carry
 * `amount`/`maxAmount` and no hp at all, and rendering the hp row for them
 * printed "NaN / NaN hp" under an empty (so: red, so: alarming) bar.
 */
function hasHp(e) {
  return Number.isFinite(e.hp) && Number.isFinite(e.maxHp) && e.maxHp > 0;
}

/**
 * What is left in a harvestable thing — a bush, a tree, a gold vein, or one of
 * your farms, which is a building that carries a stock as well as hp. Null for
 * everything else. This is the number a player wants the instant they tap a
 * resource: "how much more food is in there", not "how many hit points".
 */
function stockOf(e) {
  if (!e || !Number.isFinite(e.amount)) return null;
  const max = Number.isFinite(e.maxAmount) && e.maxAmount > 0 ? e.maxAmount : e.amount;
  if (!(max > 0)) return null;
  const s = statsOf(e);
  const res = e.resourceType || (s && s.provides && s.provides.type) || 'food';
  return { amount: Math.max(0, e.amount), max, res };
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
  // Wood first: it is the resource almost everything you can place costs, so
  // naming it before food gives the right answer for the common case.
  for (const k of ['wood', 'food', 'gold', 'stone']) {
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

/**
 * "Your Town Center is under attack!" — AoE2 names the thing, because the name
 * is the whole message: losing a villager and losing your Town Center call for
 * completely different reactions.
 */
export function underAttackText(e) {
  if (!e) return 'You are under attack!';
  if (e.kind === 'unit' && e.type === 'villager') return 'Your villagers are under attack!';
  return `Your ${displayName(e)} is under attack!`;
}

/**
 * What a rally point will actually make a newly trained unit do.
 *
 * This mirrors unitAI.rallyOrder() deliberately: a rally that lands on (or
 * within RALLY_SNAP of) a resource node, one of your finished farms, or one of
 * your foundations is a *work* order, not a walk. The HUD has to be able to
 * name that outcome — "rally set" alone tells the player nothing about the one
 * thing that makes rallies worth using on a phone.
 *
 * Returns { kind: 'gather' | 'build' | 'move', target } — never null for a
 * well-formed rally.
 */
export function rallyIntent(world, playerId, rally) {
  if (!rally || typeof rally.x !== 'number') return null;
  let best = null;
  let bestD = Infinity;
  const consider = (e, kind) => {
    const d = edgeDist2(e, rally.x, rally.y);
    if (d > RALLY_SNAP * RALLY_SNAP || d >= bestD) return;
    bestD = d;
    best = { kind, target: e };
  };
  forEachNear(world, rally.x, rally.y, RALLY_SNAP, (e) => {
    if (e.dead) return;
    if (e.kind === 'resource') {
      if (e.amount > 0) consider(e, 'gather');
      return;
    }
    if (e.kind !== 'building' || e.player !== playerId) return;
    if (!e.complete) consider(e, 'build');
    else if (typeof economy.isGatherableBuilding === 'function' && economy.isGatherableBuilding(e)) {
      consider(e, 'gather');
    }
  });
  return best || { kind: 'move', target: null };
}

/**
 * One sentence naming what a rally will do, for the buildings that will produce
 * into it. Used both by the confirmation toast when the rally is set and by the
 * note under a selected production building, so the tap and the panel can never
 * tell the player two different stories.
 *
 * Only villagers get work orders out of a rally (unitAI's rule), so a barracks
 * rallied onto a bush honestly says its soldiers will muster there.
 */
export function rallyText(world, producers, rally) {
  const list = Array.isArray(producers) ? producers : [producers];
  const intent = rallyIntent(world, PLAYER, rally) || { kind: 'move', target: null };
  const trainsVillagers = list.some((b) => (b.trains || []).includes('villager'));

  if (trainsVillagers && intent.kind === 'gather') {
    const res = intent.target.resourceType || 'food';
    return { kind: 'gather', text: `Villagers will gather ${RES_LABEL[res] || res} here` };
  }
  if (trainsVillagers && intent.kind === 'build') {
    return { kind: 'build', text: `Villagers will help build the ${displayName(intent.target)}` };
  }
  if (trainsVillagers) return { kind: 'move', text: 'New villagers will wait here' };
  return { kind: 'move', text: 'New soldiers will muster here' };
}

/** Cost markup: "25 wood" with the matching pip. */
function costNode(cost) {
  const box = el('span', 'cost');
  let any = false;
  for (const k of RES_ORDER) {
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
  // If the overlay markup is missing, fall back to a detached root so a broken
  // page still boots into a playable (if chrome-less) game rather than throwing.
  const root = doc.getElementById('hud') || doc.createElement('div');
  const dom = {
    root,
    food: doc.getElementById('res-food'),
    wood: doc.getElementById('res-wood'),
    gold: doc.getElementById('res-gold'),
    stone: doc.getElementById('res-stone'),
    pop: doc.getElementById('res-pop'),
    age: doc.getElementById('res-age'),
    toasts: doc.getElementById('toasts'),
    selPanel: doc.getElementById('sel-panel'),
    cmdPanel: doc.getElementById('cmd-panel'),
    idleWrap: doc.getElementById('idle-vill'),
    idleBtn: doc.getElementById('btn-idle'),
    idleCount: doc.getElementById('idle-count'),
    menuBtn: doc.getElementById('btn-menu'),
    minimap: doc.getElementById('minimap'),
    minimapWrap: doc.getElementById('minimap-wrap'),
  };

  const state = {
    input: null,             // set by createInput via attachInput()
    placement: null,         // building type currently being placed
    attackArmed: false,      // next map tap is an attack-move
    demolishArm: null,       // { key, at } — demolish armed for exactly this set
    buildMenuOpen: false,
    menuOpen: false,
    liveJob: null,           // { list, node } — the "where is this going" line
    liveGarrison: null,      // { list, node } — the "how many are inside" line
    selSig: '',
    cmdSig: '',
    resSig: '',
    idleSig: '',
    minimapAcc: 0,
    idleCycle: 0,
    lastToast: new Map(),
    toasts: [],
    lastAlert: -Infinity,    // performance.now() of the last under-attack alert
    alarmUntil: 0,           // minimap keeps flashing until this
    alerts: 0,               // how many alerts this match (tests read it)
    // Elements refreshed every frame without a re-render.
    liveCosts: [],           // { el, cost } — command panel
    liveBuild: [],           // { el, cost } — build menu sheet
    liveQueue: null,         // { building, bar, label }
    liveResearch: null,      // { building, fill, label, slots } — research bar
    liveBars: [],            // { kind, list, bar, fill, text } — hp and stock rows
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

  // Same shape as the placement bar on purpose: the game already teaches "a bar
  // across the bottom means the next tap on the map is spoken for".
  const attackBar = el('div', 'place-bar attack');
  attackBar.id = 'attack-bar';
  attackBar.hidden = true;
  root.appendChild(attackBar);

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

  // The top bar is measured for the same reason: the resource bar wraps to a
  // second line once the stockpiles get big enough (see .res-bar in hud.css),
  // and the toast stack is positioned directly under it. A fixed offset would
  // put a toast over the food counter for the second half of a long match.
  let topObserver = null;
  const topBar = root.querySelector('.hud-top');
  if (topBar && typeof ResizeObserver === 'function') {
    topObserver = new ResizeObserver((entries) => {
      const h = Math.round(entries[0].contentRect.height + 14);
      root.style.setProperty('--topbar-h', `${h}px`);
    });
    topObserver.observe(topBar);
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

  function activeAlert() {
    for (const t of state.toasts) if (t.alert) return t;
    return null;
  }

  function toast(text, tone = 'info') {
    if (!dom.toasts || !text) return;
    // While an alert is up it owns the corner — but only against *chatter*.
    //
    // "Training Villager", "Halted", "3 units selected" describe something that
    // already happened and will still be true in five seconds; they are not
    // worth a line of map at the one moment the player has to see the map, and
    // stacking them under the alert is what buried the base it pointed at.
    //
    // A warn-tone toast is the opposite kind of message: it is the *only*
    // record that something the player just asked for did not happen. Swallow
    // "Cannot build there" and placement stays armed with nothing but a red
    // ghost to explain it; swallow "Not enough wood" or "That would trap your
    // villagers" and the tap simply appears to do nothing. So warnings get
    // through, and the toast cap (TOAST_MAX) keeps it to the alert plus one —
    // the alert is never the toast that gets retired (see pushToast).
    if (activeAlert() && tone !== 'warn') return;
    const now = performance.now();
    // -Infinity, not 0: performance.now() is small for the first second and a
    // half of the page's life, and defaulting to 0 swallowed every toast raised
    // in it — including the first orders of the match.
    const last = state.lastToast.has(text) ? state.lastToast.get(text) : -Infinity;
    if (now - last < TOAST_REPEAT_MS) return; // never spam the same line
    if (state.lastToast.size > 64) state.lastToast.clear(); // bounded memory
    state.lastToast.set(text, now);

    // A toast lives longer (TOAST_MS) than the window that suppresses repeats
    // of it (TOAST_REPEAT_MS), so a line raised again in the gap between the two
    // used to put a second, identical copy of itself on the map — two "That
    // would seal in your Town Center" boxes stacked over the base they are
    // about. The same sentence is never worth saying twice at once: refresh the
    // one already up instead, which also keeps it on screen for the repeat.
    for (const rec of state.toasts) {
      if (!rec.alert && rec.node.textContent === text) {
        rec.at = now;
        return;
      }
    }

    const node = el('div', `toast ${tone === 'warn' ? 'warn' : ''}`, text);
    dom.toasts.appendChild(node);
    pushToast({ node, at: now, ttl: TOAST_MS });
  }

  /**
   * The urgent one. Reads nothing like the economy toasts — red, pulsing, named
   * — and it is tappable: on a phone the whole value of the alert is that it
   * takes you to the fight. Hunting for it by dragging the map loses the game.
   */
  function underAttackAlert(entity, gx, gy) {
    if (!dom.toasts) return null;
    const now = performance.now();
    if (now - state.lastAlert < ALERT_MIN_MS) return null;
    state.lastAlert = now;
    state.alerts++;

    // The alert supersedes the stack rather than joining it: everything already
    // up goes, including any earlier alert (a second raid replaces the first —
    // two red boxes are not twice as urgent, they are twice as much map gone).
    for (const t of state.toasts.slice()) killToast(t);

    const node = el('button', 'toast alert');
    node.type = 'button';
    // Toasts are aria-live="polite"; this one interrupts.
    node.setAttribute('role', 'alert');
    node.setAttribute('aria-label', `${underAttackText(entity)} Tap to jump there.`);
    const line = el('span', 'line');
    line.appendChild(el('span', 'siren', '⚔'));
    line.appendChild(document.createTextNode(underAttackText(entity)));
    node.appendChild(line);
    node.appendChild(el('span', 'sub', 'Tap to jump there'));

    const rec = { node, at: now, ttl: ALERT_MS, alert: true };
    node.addEventListener('click', (ev) => {
      ev.stopPropagation();
      centerOnGrid(gx, gy);
      killToast(rec);
    });

    dom.toasts.appendChild(node);
    pushToast(rec);

    if (minimap && minimap.ping) minimap.ping(gx, gy);
    if (dom.minimapWrap) {
      state.alarmUntil = now + ALERT_GLOW_MS;
      dom.minimapWrap.classList.add('alarm');
    }
    return rec;
  }

  function pushToast(rec) {
    state.toasts.push(rec);
    // Over budget: retire the oldest *routine* toast first. An alert must never
    // be pushed off the screen by "Training Villager".
    while (state.toasts.length > TOAST_MAX) {
      const victim = state.toasts.find((t) => !t.alert) || state.toasts[0];
      if (victim === rec) break;
      killToast(victim);
    }
  }

  function killToast(rec) {
    const i = state.toasts.indexOf(rec);
    if (i < 0) return;
    state.toasts.splice(i, 1);
    rec.node.classList.add('out');
    setTimeout(() => rec.node.remove(), 280);
  }

  function tickToasts(now) {
    for (const rec of state.toasts.slice()) {
      if (now - rec.at > (rec.ttl || TOAST_MS)) killToast(rec);
    }
    if (state.alarmUntil && now > state.alarmUntil) {
      state.alarmUntil = 0;
      if (dom.minimapWrap) dom.minimapWrap.classList.remove('alarm');
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
    const age = tech.currentAge(world, PLAYER);
    let sig = '';
    for (const k of RES_ORDER) sig += `${p.resources[k] | 0}/`;
    sig += `${p.pop}/${p.popCap}/${age}`;
    if (sig === state.resSig) return;
    state.resSig = sig;
    for (const k of RES_ORDER) setRes(dom[k], String(Math.floor(p.resources[k] || 0)));
    setRes(dom.pop, `${p.pop}/${p.popCap}`);
    if (dom.pop) dom.pop.classList.toggle('low', p.pop >= p.popCap);
    if (dom.age) {
      setRes(dom.age, tech.AGE_SHORT[age] || tech.AGE_SHORT[0]);
      dom.age.title = tech.ageName(age);
      dom.age.dataset.age = String(age);
    }
  }

  const RES_NODE = {
    food: () => dom.food, wood: () => dom.wood,
    gold: () => dom.gold, stone: () => dom.stone,
  };

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
    state.liveBars = [];
    state.liveJob = null;
    state.liveGarrison = null;

    const sel = selectedEntities(world);
    if (sel.length === 0) {
      const empty = el('div', 'sel-empty', 'Nothing selected.');
      // Keep this honest about the gesture model: with an empty selection a
      // one-finger drag pans, and the box needs a hold first.
      empty.appendChild(el('small', 'sel-hint', 'Tap a unit. Drag to look around. Hold, then drag, to box-select.'));
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
      // The header already names a lone selection — do not say it twice.
      if (groups.size > 1 || g.list.length > 1) {
        chip.appendChild(el('span', 'n', `×${g.list.length}`));
      }
      chip.title = `${displayName(g.list[0])} ×${g.list.length}`;
      // Tapping a group narrows the selection to just that type (AoE2 habit).
      chip.addEventListener('click', () => {
        if (groups.size > 1 || g.list.length !== sel.length) setSelection(world, g.list);
      });
      chips.appendChild(chip);
    }
    panel.appendChild(chips);

    // Health: one bar for a single entity, an aggregate for a group. Only for
    // things that actually have health — a bush does not, and a bar is a claim.
    const living = sel.filter(hasHp);
    if (living.length) addBar(panel, 'hp', living);

    // And what is left in anything harvestable. A farm has both, in that order:
    // it can be burned down *and* eaten out, and the player needs both numbers.
    const stocked = sel.filter((e) => stockOf(e));
    if (stocked.length) addBar(panel, 'stock', stocked);

    // Where this villager's load is going. See jobNoteText: the drop-off is
    // chosen for the player by the sim, so the panel has to say which one it
    // picked or the Lumber Camp they just paid 100 wood for is invisible.
    const workers = sel.filter((e) => e.player === PLAYER && e.type === 'villager');
    if (workers.length) {
      const note = el('div', 'job-note');
      panel.appendChild(note);
      state.liveJob = { list: workers, node: note };
    }

    // How many bodies are inside, and how many more will fit. This is the only
    // way the player can see a garrison at all — the units are off the map by
    // design — so it is a live row rather than a line drawn once.
    const shelters = sel.filter((e) => e.player === PLAYER && garrisonCapacity(e) > 0);
    if (shelters.length) {
      const note = el('div', 'garrison-note');
      panel.appendChild(note);
      state.liveGarrison = { list: shelters, node: note };
    }

    refreshBars();
  }

  /**
   * One line naming what the selected villagers are doing and, crucially, where
   * they are banking it.
   *
   * The drop-off is the one decision in the economy the game makes on the
   * player's behalf every single trip (economy.nearestDropoff), and it is the
   * decision a Lumber Camp or a Mining Camp exists to change. Without this line
   * the only evidence that a new camp did anything is that the wood counter goes
   * up slightly faster, which nobody can see. Returns '' when there is nothing
   * worth saying, and the caller hides the row.
   */
  function jobNoteText(list) {
    const live = list.filter((u) => !u.dead);
    if (!live.length) return '';

    // Every drop-off the group is currently routed to, named once each.
    const drops = [];
    for (const u of live) {
      const t = u.task;
      const b = t && t.type === 'gather' ? t.building : null;
      if (!b || b.dead) continue;
      const name = displayName(b);
      if (!drops.includes(name)) drops.push(name);
    }

    if (live.length === 1) {
      const u = live[0];
      const t = u.task;
      const carrying = u.carrying && u.carrying.amount > 0 ? u.carrying : null;
      if (t && t.type === 'build' && t.building && !t.building.dead) {
        return `Building the ${displayName(t.building)}`;
      }
      if (t && t.type === 'gather') {
        if (t.stage === 'toDrop' && drops.length) {
          const load = carrying
            ? `${Math.floor(carrying.amount)} ${RES_LABEL[carrying.type] || carrying.type}`
            : 'a load';
          return `Hauling ${load} to the ${drops[0]}`;
        }
        const res = (t.node && t.node.resourceType) || (carrying && carrying.type);
        const what = res ? RES_LABEL[res] || res : 'resources';
        // Name the drop-off it *will* use, not the one it used last, by asking
        // the same function the villager will ask when its pack fills.
        const drop = res ? economy.nearestDropoff(world, PLAYER, u.x, u.y, res) : null;
        return drop ? `Gathering ${what} → ${displayName(drop)}` : `Gathering ${what}`;
      }
      return carrying
        ? `Carrying ${Math.floor(carrying.amount)} ${RES_LABEL[carrying.type] || carrying.type}`
        : '';
    }

    if (!drops.length) return '';
    return `Dropping off at: ${drops.join(', ')}`;
  }

  function addBar(panel, kind, list) {
    const bar = el('div', `hpbar ${kind === 'stock' ? 'stock' : ''}`);
    const fill = el('i');
    bar.appendChild(fill);
    panel.appendChild(bar);
    const text = el('div', 'hp-text');
    panel.appendChild(text);
    state.liveBars.push({ kind, list, bar, fill, text });
  }

  function refreshBars() {
    for (const h of state.liveBars) {
      let val = 0;
      let max = 0;
      let res = null;
      for (const e of h.list) {
        if (e.dead) continue;
        if (h.kind === 'stock') {
          const s = stockOf(e);
          if (!s) continue;
          val += s.amount;
          max += s.max;
          if (res === null) res = s.res;
          else if (res !== s.res) res = 'mixed';
        } else {
          val += e.hp;
          max += e.maxHp;
        }
      }
      const frac = max > 0 ? Math.max(0, Math.min(1, val / max)) : 0;
      h.fill.style.width = `${(frac * 100).toFixed(1)}%`;
      h.bar.classList.toggle('mid', frac <= 0.6 && frac > 0.3);
      h.bar.classList.toggle('low', frac <= 0.3);
      h.text.textContent = h.kind === 'stock'
        ? `${Math.ceil(val)} / ${Math.ceil(max)} ${res && res !== 'mixed' ? RES_LABEL[res] || res : 'resources'} left`
        : `${Math.ceil(val)} / ${Math.ceil(max)} hp`;
    }

    if (state.liveJob) {
      const text = jobNoteText(state.liveJob.list);
      if (state.liveJob.node.textContent !== text) state.liveJob.node.textContent = text;
      state.liveJob.node.hidden = text === '';
    }

    if (state.liveGarrison) {
      let inside = 0;
      let cap = 0;
      for (const b of state.liveGarrison.list) {
        if (b.dead) continue;
        inside += garrisonCount(b);
        cap += garrisonCapacity(b);
      }
      const text = `Garrison ${inside} / ${cap}`;
      const node = state.liveGarrison.node;
      if (node.textContent !== text) node.textContent = text;
      node.classList.toggle('manned', inside > 0);
      node.classList.toggle('full', cap > 0 && inside >= cap);
    }
  }

  // --- Command panel --------------------------------------------------------

  function cmdButton(label, { cls = '', cost = null, onTap, disabled = false, sub = null, aria = null } = {}) {
    const b = el('button', `cbtn ${cls}`);
    if (aria) b.setAttribute('aria-label', aria);
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
    state.liveResearch = null;

    const sel = selectedEntities(world);
    const own = sel.filter((e) => e.player === PLAYER);
    const units = own.filter((e) => e.kind === 'unit');
    const villagers = units.filter((u) => u.type === 'villager');
    const military = units.filter(isMilitary);
    const buildings = own.filter((e) => e.kind === 'building' && e.complete);

    // An armed attack-move belongs to the troops that were in hand when it was
    // armed. Lose them and the armed tap would fire into the void, so drop it.
    if (state.attackArmed && !military.length) setAttackArmed(false, { quiet: true });

    if (own.length === 0) {
      if (sel.length) {
        const e = sel[0];
        const stock = stockOf(e);
        panel.appendChild(el('div', 'cmd-note',
          stock
            ? `${displayName(e)} — ${Math.ceil(stock.amount)} ${RES_LABEL[stock.res] || stock.res} left`
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
      renderRallyNote(panel, trainer);
    }

    // Research. Preferring the building that also trains keeps the Town
    // Center's age-up and the Barracks' blacksmith line on the same panel as
    // the units they are for; a Mill or a Lumber Camp trains nothing and is
    // picked up by the fallback.
    const researcher =
      (trainer && tech.techsAt(trainer.type).length ? trainer : null) ||
      buildings.find((b) => tech.techsAt(b.type).length > 0);
    if (researcher) renderResearch(panel, researcher);

    // Attack-move: the one order a phone had no way to give. It arms the next
    // tap on the map rather than asking for a second gesture nobody would find.
    if (military.length) {
      // The label never changes: it names the mode, and the lit state plus the
      // bar say whether it is on. (Tapping it again still turns it off.)
      panel.appendChild(cmdButton('Attack-move', {
        cls: `attack ${state.attackArmed ? 'armed' : ''}`,
        sub: state.attackArmed ? 'tap a spot' : `${military.length} ready`,
        onTap: () => setAttackArmed(!state.attackArmed),
      }));
    }

    // Garrison. AoE2 gives this to a right-click on a building; a phone has no
    // right-click and no modifier, so it is a button that means "go inside the
    // nearest shelter of yours that has room". That is the order a player
    // actually wants under fire — they are not choosing *which* Town Center,
    // they are getting their villagers off the field before the scouts arrive.
    if (units.length) {
      // First unit that has somewhere to go decides whether the button exists;
      // the order itself re-asks per unit, so a mixed group still each find
      // their own nearest shelter.
      let shelter = null;
      for (const u of units) {
        shelter = nearestShelter(world, u);
        if (shelter) break;
      }
      if (shelter) {
        panel.appendChild(cmdButton('Garrison', {
          cls: 'garrison',
          sub: `${units.length} in`,
          aria: `Send ${units.length} units into the nearest ${displayName(shelter)}.`,
          onTap: () => {
            command(units, { type: 'garrison' });
            toast(`Garrisoning ${units.length}`, 'info');
          },
        }));
      }
    }

    // ...and the way back out, on the building. One tap empties it: picking
    // individuals out of a building you cannot see inside is a menu nobody
    // wants on a 390px screen, and "everybody out" is what an alarm calls for.
    const shelters = buildings.filter((b) => garrisonCount(b) > 0);
    if (shelters.length) {
      const inside = shelters.reduce((n, b) => n + garrisonCount(b), 0);
      panel.appendChild(cmdButton('Ungarrison', {
        cls: 'garrison out',
        sub: `${inside} out`,
        aria: `Turn out all ${inside} units garrisoned here.`,
        onTap: () => {
          let n = 0;
          for (const b of shelters) n += ungarrisonAll(world, b);
          toast(n ? `${n} came out` : 'Nowhere to stand', n ? 'info' : 'warn');
          state.cmdSig = '';
        },
      }));
    }

    // Stance and formation. Both are unit *settings* rather than orders, which
    // is why they sit below the verbs: you set them once and every order after
    // that obeys them.
    if (units.length) renderStances(panel, units);
    if (military.length > 1) renderFormations(panel, military);

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

    // A foundation under construction: show progress + let villagers finish it,
    // or take the site back.
    const site = own.find((e) => e.kind === 'building' && !e.complete);
    if (site) {
      const pct = Math.round(progressOf(site) * 100);
      panel.appendChild(el('div', 'cmd-note', `${displayName(site)} under construction — ${pct}%`));
      panel.appendChild(cmdButton('Cancel', {
        cls: 'danger',
        sub: 'full refund',
        aria: `Cancel the ${displayName(site)} under construction. The cost is refunded.`,
        onTap: () => cancelSite(site),
      }));
    }

    // Demolish, last and on its own: the only irreversible thing in the panel.
    if (buildings.length) renderDemolish(panel, buildings);

    refreshAffordability();
  }

  // --- Stance and formation --------------------------------------------------
  //
  // Two rows of segmented buttons, the live one lit. They are rows rather than a
  // single cycling button on purpose: a cycler hides three of the four choices
  // and makes "put these on Stand Ground" a game of tap-and-check, which is
  // exactly the interaction a player is trying to avoid in the second before a
  // raid lands. Every segment is a full 44px tall (see .segrow in hud.css), so
  // four of them still fit across a 390px phone.
  //
  // Mixed selections show nothing lit and set all of them on the first tap,
  // which is the only unambiguous answer to "what is this group's stance".

  function segRow(panel, { title, options, current, onPick }) {
    const wrap = el('div', 'segrow');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', title);
    for (const o of options) {
      const on = o.id === current;
      const b = el('button', `seg ${on ? 'on' : ''}`);
      b.type = 'button';
      b.appendChild(el('span', 'label', o.label));
      b.appendChild(el('span', 'blurb', o.blurb || ''));
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('aria-label', `${title}: ${o.label}. ${o.blurb || ''}`.trim());
      b.title = o.blurb || o.label;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); onPick(o.id); });
      wrap.appendChild(b);
    }
    panel.appendChild(wrap);
  }

  /** The one value shared by every unit in the list, or null when they differ. */
  function shared(list, read) {
    let v = null;
    for (const u of list) {
      const x = read(u);
      if (v === null) v = x;
      else if (v !== x) return null;
    }
    return v;
  }

  function renderStances(panel, units) {
    segRow(panel, {
      title: 'Stance',
      current: shared(units, stanceOf),
      options: STANCE_ORDER.map((id) => ({
        id, label: STANCE_LABEL[id], blurb: STANCE_BLURB[id],
      })),
      onPick: (id) => {
        command(units, { type: 'stance', stance: id });
        toast(`${STANCE_LABEL[id]}: ${STANCE_BLURB[id].toLowerCase()}`, 'info');
        state.cmdSig = '';
      },
    });
  }

  function renderFormations(panel, units) {
    segRow(panel, {
      title: 'Formation',
      current: shared(units, (u) => u.formation || DEFAULT_FORMATION),
      options: FORMATION_ORDER.map((id) => ({
        id, label: FORMATION_LABEL[id], blurb: FORMATION_BLURB[id],
      })),
      onPick: (id) => {
        command(units, { type: 'formation', formation: id });
        toast(`${FORMATION_LABEL[id]} formation`, 'info');
        state.cmdSig = '';
      },
    });
  }

  // --- Cancel a foundation ---------------------------------------------------
  // The other half of Demolish, and deliberately not the same button. A
  // foundation is a site with a receipt on it: economy.cancelFoundation() hands
  // the wood straight back and nothing that was built is lost, because nothing
  // has been built. So it needs no arm-then-confirm — that ceremony is there to
  // protect you from destroying something, and there is nothing here to destroy.
  // Without it the only way out of a misplaced site was to finish paying for it
  // in villager-seconds and then demolish it for nothing.

  function cancelSite(b) {
    if (!b || b.dead || b.kind !== 'building' || b.player !== PLAYER || b.complete) return;
    if (typeof economy.cancelFoundation !== 'function') return;
    const what = displayName(b);
    if (!economy.cancelFoundation(world, b)) return;
    toast(`${what} cancelled — cost refunded`, 'info');
    state.cmdSig = '';
    state.selSig = '';
  }

  // --- Demolish -------------------------------------------------------------
  // AoE2 has the delete key and a confirmation dialog behind it, and it is an
  // ordinary part of play: you delete a misplaced house or a wall you no longer
  // want. Here it is also the only way out of a base you have walled yourself
  // into — without it, a house put down in the wrong spot is permanent, and a
  // ring of them around your own villagers is unrecoverable.
  //
  // No refund, as in AoE2. A partial refund would turn "wall yourself in" into
  // a resource-shuffling exploit and, more to the point, would make the button
  // something you might tap speculatively — which is exactly what it must not be.

  function demolishKey(list) {
    return list.map((b) => b.id).sort((a, b) => a - b).join(',');
  }

  /** Is demolish armed for exactly this set of buildings, and still fresh? */
  function demolishArmedFor(list) {
    const arm = state.demolishArm;
    if (!arm) return false;
    if (performance.now() - arm.at > DEMOLISH_ARM_MS) return false;
    return arm.key === demolishKey(list);
  }

  function setDemolishArm(list) {
    state.demolishArm = list ? { key: demolishKey(list), at: performance.now() } : null;
    state.cmdSig = ''; // the button must redraw as armed/idle immediately
  }

  function renderDemolish(panel, list) {
    const armed = demolishArmedFor(list);
    const what = list.length === 1 ? displayName(list[0]) : `${list.length} buildings`;
    panel.appendChild(cmdButton(armed ? 'Confirm' : 'Demolish', {
      cls: `demolish ${armed ? 'armed' : ''}`,
      sub: armed ? 'destroy it' : 'no refund',
      aria: armed
        ? `Confirm: destroy ${what}. This cannot be undone.`
        : `Demolish ${what}. Asks to confirm.`,
      onTap: () => demolishTap(list),
    }));
  }

  function demolishTap(list) {
    if (!demolishArmedFor(list)) {
      setDemolishArm(list);
      const what = list.length === 1 ? displayName(list[0]) : `${list.length} buildings`;
      toast(`Demolish ${what}? Tap again`, 'warn');
      return;
    }
    setDemolishArm(null);
    demolish(list);
  }

  /**
   * Destroy our own finished buildings. removeEntity does all the bookkeeping —
   * frees the footprint tiles (which is the whole point here), drops the id from
   * the owner's set, clears any task or target pointing at it, recomputes the
   * population cap and emits EV.REMOVED — so there is nothing to undo by hand.
   */
  function demolish(list) {
    const targets = list.filter((b) =>
      b && !b.dead && b.kind === 'building' && b.player === PLAYER && b.complete);
    if (!targets.length) return;
    const what = targets.length === 1 ? displayName(targets[0]) : `${targets.length} buildings`;
    for (const b of targets) removeEntity(world, b);
    toast(`${what} demolished`, 'warn');
    state.cmdSig = '';
    state.selSig = '';
  }

  /**
   * The line under a production building that says what its rally will do —
   * and, when it has none, that tapping a resource is how you set one.
   *
   * This is the discoverability half of rally-to-resource: the behaviour is
   * worth nothing if the player never learns the tap exists.
   */
  function renderRallyNote(panel, b) {
    const note = el('div', 'cmd-note rally-note');
    if (b.rally) {
      const r = rallyText(world, [b], b.rally);
      note.classList.add(`is-${r.kind}`);
      note.appendChild(el('i', 'flag', '⚑'));
      note.appendChild(doc.createTextNode(r.text));
    } else {
      note.classList.add('is-hint');
      note.appendChild(el('i', 'flag', '⚑'));
      note.appendChild(doc.createTextNode('Tap a resource to rally onto it'));
    }
    panel.appendChild(note);
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

  // --- Research ---------------------------------------------------------------
  //
  // A research button has to answer three questions at a glance — what is it,
  // what does it cost, what does it *do* — and the third one is the one every
  // RTS on a small screen drops. "Bow Saw, 150 food 100 wood" tells a player
  // nothing; "+20% wood gathering" tells them everything, and is the difference
  // between an upgrade tab that gets used and one that gets ignored. So every
  // button carries its effect line, and the greyed ones carry the reason they
  // are grey instead of it — an upgrade you cannot buy raises exactly one
  // question, and it is "why not".

  /** Word the sub-line under a research button for its current status. */
  function researchSub(opt) {
    if (opt.status === 'done') return 'researched';
    if (opt.status === 'active') return 'researching…';
    return opt.reason || opt.blurb || '';
  }

  function renderResearch(panel, b) {
    const all = tech.researchOptions(world, PLAYER, b);
    if (!all.length) return;

    // Later tiers of a line the player has not started are folded away — see
    // the note on `gate` in tech.js. Four full-width buttons is already most of
    // a phone panel; eight was two thirds of the screen.
    const options = all.filter((o) => o.gate !== 'prereq');
    const folded = all.length - options.length;

    // In-progress first, with its own bar: it is the thing that is happening.
    if ((b.research || []).length) renderResearchQueue(panel, b);

    for (const opt of options) {
      const usable = opt.status === 'ready' || opt.status === 'poor';
      const isAge = opt.tech && opt.tech.advancesTo !== undefined;
      const btn = el('button',
        `cbtn research is-${opt.status}${isAge ? ' is-age' : ''}${opt.status === 'poor' ? ' off' : ''}`);
      btn.appendChild(el('span', 'label', opt.name));
      // The effect line goes on anything the player could actually buy — which
      // includes the ones they cannot afford *yet*, because "+20% wood" is
      // precisely the argument for saving up for it. A button that is grey for
      // a structural reason (done, running, wrong age) prints that reason
      // instead: there is only one question left about it and it is not "what
      // does this do".
      if (usable) btn.appendChild(el('span', 'blurb', opt.blurb || ''));
      if (usable) {
        btn.appendChild(costNode(opt.cost));
        // Only 'poor' entries join the live affordability refresh; 'ready' ones
        // are re-evaluated by it too, so a button un-greys the instant the food
        // lands rather than on the next panel re-render.
        state.liveCosts.push({ el: btn, cost: opt.cost });
      } else {
        btn.appendChild(el('span', 'cost', researchSub(opt)));
      }
      if (usable && opt.blurb && opt.status === 'poor') {
        btn.title = `${opt.blurb} — ${opt.reason}`;
      } else if (opt.blurb) {
        btn.title = opt.blurb;
      }
      btn.setAttribute('aria-label',
        `${opt.name}. ${opt.blurb || ''} ${researchSub(opt)}`.trim());

      if (!usable) {
        // Not disabled — tapped, it explains itself. A dead button on a phone
        // is indistinguishable from a missed tap.
        btn.classList.add('off');
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          toast(`${opt.name}: ${researchSub(opt)}`, opt.status === 'done' ? 'info' : 'warn');
        });
      } else {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          startResearch(b, opt);
        });
      }
      panel.appendChild(btn);
    }

    // Say that the folded ones exist. Without this line a player who finishes
    // Forging is surprised by a button appearing, and one who never finishes it
    // never learns the line goes further.
    if (folded > 0) {
      panel.appendChild(el('div', 'cmd-note research-more',
        folded === 1
          ? 'One further upgrade unlocks behind these'
          : `${folded} further upgrades unlock behind these`));
    }
  }

  function startResearch(building, opt) {
    if (!affordable(world, PLAYER, opt.cost)) {
      const miss = missingResource(world, PLAYER, opt.cost);
      toast(miss ? `Not enough ${RES_LABEL[miss]}` : 'Not enough resources', 'warn');
      flashRes(miss ? [miss] : RES_ORDER);
      return;
    }
    if (typeof tech.queueResearch !== 'function') return;
    // tech.queueResearch raises its own toast on both success and refusal, so
    // this only has to force the panel to redraw with the new queue.
    if (tech.queueResearch(world, building, opt.id)) state.cmdSig = '';
  }

  function renderResearchQueue(panel, b) {
    const row = el('div', 'queue research-queue');
    const prog = el('div', 'qprog');
    const fill = el('i');
    prog.appendChild(fill);
    row.appendChild(prog);
    const label = el('span', 'qlabel');
    row.appendChild(label);
    const slots = el('div', 'qslots');
    row.appendChild(slots);
    panel.appendChild(row);
    state.liveResearch = { building: b, fill, label, slots, drawn: -1 };
    refreshResearchQueue();
  }

  function refreshResearchQueue() {
    const q = state.liveResearch;
    if (!q || !q.building || q.building.dead) return;
    const queue = q.building.research || [];
    q.fill.style.width = `${(tech.researchProgress(q.building) * 100).toFixed(1)}%`;
    const head = queue[0];
    const name = head && tech.TECHS[head.id] ? tech.TECHS[head.id].name : '';
    if (q.label.textContent !== name) q.label.textContent = name;

    if (q.drawn !== queue.length) {
      q.drawn = queue.length;
      q.slots.textContent = '';
      queue.forEach((entry, i) => {
        const t = tech.TECHS[entry.id];
        const s = el('button', `qslot ${i === 0 ? 'head' : ''}`,
          (t ? t.name : entry.id).slice(0, 1).toUpperCase());
        s.title = `Cancel ${t ? t.name : entry.id} — full refund`;
        s.setAttribute('aria-label', `Cancel ${t ? t.name : entry.id}. The cost is refunded.`);
        s.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (typeof tech.cancelResearch !== 'function') return;
          if (tech.cancelResearch(world, q.building, i)) {
            toast(`${t ? t.name : 'Research'} cancelled — cost refunded`, 'info');
            state.cmdSig = '';
          }
        });
        q.slots.appendChild(s);
      });
    }
  }

  /**
   * Keep every costed button honest as the stockpile moves. Both panels are
   * refreshed every frame: a button that still says "too expensive" a second
   * after the wood landed is the kind of thing that makes a HUD feel dead.
   */
  function refreshAffordability() {
    for (const c of state.liveCosts) c.el.classList.toggle('off', !affordable(world, PLAYER, c.cost));
    for (const c of state.liveBuild) c.el.classList.toggle('off', !affordable(world, PLAYER, c.cost));
  }

  function train(building, unitType) {
    const s = UNIT_STATS[unitType];
    if (!affordable(world, PLAYER, s.cost)) {
      const miss = missingResource(world, PLAYER, s.cost);
      toast(miss ? `Not enough ${RES_LABEL[miss]}` : 'Not enough resources', 'warn');
      flashRes(miss ? [miss] : RES_ORDER);
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
    else state.liveBuild = []; // stop refreshing buttons nobody can see
  }

  /**
   * The build menu, grouped by age, with the locked entries *shown* rather than
   * hidden.
   *
   * Hiding them is the obvious implementation and it is the wrong one. The
   * whole reason a player spends 400 food on the Feudal Age is the things it
   * buys, and a menu that only reveals those things afterwards asks them to
   * make that decision blind — the age-up reads as a tax rather than a
   * purchase. So every building in the game is listed from the first minute,
   * greyed, with the age it needs printed where its cost would go, and tapping
   * one says so out loud. That is also the cheapest possible tutorial for the
   * tech tree: the menu *is* the tree.
   *
   * Types with no entry in BUILDING_STATS are skipped, so the forward-declared
   * names in BUILDABLE cost nothing until the buildings behind them exist.
   */
  function renderBuildMenu() {
    buildMenu.textContent = '';
    state.liveBuild = [];
    const myAge = tech.currentAge(world, PLAYER);

    // Bucket by required age, keeping BUILDABLE's order inside each bucket.
    const shelves = [[], [], []];
    for (const type of BUILDABLE) {
      const s = BUILDING_STATS[type];
      if (!s) continue;
      const need = tech.ageForBuilding(type);
      (shelves[need] || shelves[0]).push({ type, s, need });
    }

    for (let age = 0; age < shelves.length; age++) {
      const shelf = shelves[age];
      if (!shelf.length) continue;
      const locked = age > myAge;
      const title = el('div', `title ${locked ? 'locked' : ''}`,
        locked ? `${AGE_HEADINGS[age]} — locked` : AGE_HEADINGS[age]);
      buildMenu.appendChild(title);
      for (const entry of shelf) buildMenu.appendChild(buildButton(entry, locked));
    }

    const cancel = el('button', 'cbtn danger');
    cancel.appendChild(el('span', 'label', 'Close'));
    cancel.addEventListener('click', (ev) => { ev.stopPropagation(); toggleBuildMenu(false); });
    buildMenu.appendChild(cancel);
  }

  function buildButton({ type, s, need }, locked) {
    const b = el('button', `cbtn ${locked ? 'locked' : ''}`);
    b.appendChild(el('span', 'label', s.name));
    if (locked) {
      // The age replaces the cost, not joins it: what a Castle costs is not the
      // question you have while you cannot build one.
      // "Castle — CASTLE" reads like a stutter; "Castle — CASTLE AGE" reads as
      // the tier it is waiting for, which is the question being answered.
      b.appendChild(el('span', 'cost need',
        tech.AGE_SHORT[need] ? `${tech.AGE_SHORT[need]} Age` : 'later'));
      b.setAttribute('aria-label', `${s.name}. Locked until the ${tech.ageName(need)}.`);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toast(tech.lockReason(world, PLAYER, type) || `${s.name} is locked`, 'warn');
        flashAge();
      });
      return b;
    }
    // Only unlocked buttons join the affordability refresh — a locked one is
    // already grey for a different and more important reason.
    state.liveBuild.push({ el: b, cost: s.cost });
    b.classList.toggle('off', !affordable(world, PLAYER, s.cost));
    b.appendChild(costNode(s.cost));
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!affordable(world, PLAYER, s.cost)) {
        const miss = missingResource(world, PLAYER, s.cost);
        toast(miss ? `Not enough ${RES_LABEL[miss]}` : 'Not enough resources', 'warn');
        flashRes(miss ? [miss] : RES_ORDER);
        return;
      }
      setPlacementMode(type);
    });
    return b;
  }

  /** Point at the age chip, the way flashRes points at a resource counter. */
  function flashAge() {
    if (!dom.age) return;
    dom.age.classList.remove('flash');
    void dom.age.offsetWidth;
    dom.age.classList.add('flash');
    setTimeout(() => dom.age.classList.remove('flash'), 1000);
  }

  // --- Placement mode -------------------------------------------------------

  function setPlacementMode(typeOrNull) {
    state.placement = typeOrNull || null;
    toggleBuildMenu(false);
    // Placement also claims the next tap, so it cannot coexist with an armed
    // attack-move. (Only when arming: setPlacementMode(null) must not recurse.)
    if (state.placement) setAttackArmed(false, { quiet: true });
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

  // --- Attack-move arming ---------------------------------------------------
  // "Advance to here and fight what you meet" is a two-part order: a verb and a
  // place. On a phone the verb has to be a button and the place has to be the
  // next tap — exactly how placing a building already works — because there is
  // no modifier key to hold and no second mouse button to press.
  //
  // It is one-shot: the order goes out and the mode disarms, so an ordinary
  // move order is never one tap further away than it was before.

  function setAttackArmed(on, opts = {}) {
    const want = !!on;
    if (want === state.attackArmed) return;
    state.attackArmed = want;
    state.cmdSig = ''; // the button has to redraw as armed/idle immediately

    if (!want) {
      attackBar.hidden = true;
      attackBar.textContent = '';
      return;
    }

    // The two armed modes both claim the next tap; only one may be live.
    setPlacementMode(null);
    toggleBuildMenu(false);

    attackBar.textContent = '';
    const txt = el('div', 'txt', 'Attack-move armed');
    txt.appendChild(el('small', null, 'Tap where to advance — they fight what they meet'));
    attackBar.appendChild(txt);
    const cancel = el('button', 'danger', 'Cancel');
    cancel.addEventListener('click', (ev) => { ev.stopPropagation(); setAttackArmed(false); });
    attackBar.appendChild(cancel);
    attackBar.hidden = false;
    if (!opts.quiet) toast('Attack-move: tap where to advance', 'info');
  }

  function isAttackArmed() { return state.attackArmed; }

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
    // ownedBy() still returns garrisoned units — they are yours and they still
    // cost population — but they are not on the map, so selecting them would
    // put a panel full of units the player cannot see or order in front of them.
    add('Select all villagers', () => {
      const v = ownedBy(world, PLAYER, 'unit', 'villager').filter((u) => !isGarrisoned(u));
      if (v.length) { setSelection(world, v); toast(`${v.length} villagers`, 'info'); }
      else toast('No villagers', 'warn');
    });
    add('Select all military', () => {
      const m = ownedBy(world, PLAYER, 'unit').filter((u) => isMilitary(u) && !isGarrisoned(u));
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

  // The alert AoE2 is built around. combat.js throttles it to roughly one per
  // area per 10-20s, so anything that arrives here is worth interrupting for.
  off.push(world.events.on(EV.UNDER_ATTACK, (p) => {
    if (!p || p.player !== PLAYER) return;
    underAttackAlert(p.entity, p.gx, p.gy);
  }));

  off.push(world.events.on(EV.INSUFFICIENT, (p) => {
    if (p && p.player !== undefined && p.player !== PLAYER) return;
    const miss = p && p.cost ? missingResource(world, PLAYER, p.cost) : null;
    toast(miss ? `Not enough ${RES_LABEL[miss]}` : 'Not enough resources', 'warn');
    flashRes(miss ? [miss] : RES_ORDER);
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
    // An arm belongs to the buildings that were in hand when it was armed;
    // changing the selection must never carry it over to something else.
    state.demolishArm = null;
    if (world.selection.size === 0) toggleBuildMenu(false);
  }));

  // An age-up changes the whole build menu (three shelves' worth of locked
  // buttons become live) as well as the command panel, so it is the one event
  // that forces both to redraw regardless of what is selected.
  off.push(world.events.on(EV.AGE_ADVANCE, (p) => {
    if (p && p.player !== undefined && p.player !== PLAYER) return;
    state.cmdSig = '';
    state.resSig = '';
    if (state.buildMenuOpen) renderBuildMenu();
    flashAge();
  }));
  off.push(world.events.on(EV.RESEARCH_DONE, (p) => {
    if (p && p.player !== undefined && p.player !== PLAYER) return;
    state.cmdSig = '';
  }));
  off.push(world.events.on(EV.RESEARCH_START, (p) => {
    if (p && p.player !== undefined && p.player !== PLAYER) return;
    state.cmdSig = '';
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

    // A demolish arm that was never confirmed lapses back to safe on its own.
    if (state.demolishArm && now - state.demolishArm.at > DEMOLISH_ARM_MS) {
      state.demolishArm = null;
      state.cmdSig = '';
    }

    const sig = selectionSignature(world);
    if (sig !== state.selSig) {
      state.selSig = sig;
      renderSelection();
    } else {
      refreshBars();
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
      refreshResearchQueue();
    }
    refreshAffordability();

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
      // Stance and formation decide which segment is lit, and both change
      // without the selection changing — a unit dropped to No Attack by an
      // order, a group whose formation was just set. Cheap: two string reads
      // per selected unit, and the panel only re-renders when they differ.
      if (e.kind === 'unit') q += `|${stanceOf(e)}${e.formation || ''}`;
      // The rally is in here so the note that names what it will do refreshes
      // the moment the player moves it.
      if (e.kind === 'building') {
        q += `|${e.id}:${(e.queue || []).length}`;
        // The research queue length is in here for the same reason the training
        // queue is: starting or cancelling one changes which buttons the panel
        // must draw, and there is no event for "the queue got shorter".
        q += `r${(e.research || []).length}`;
        q += e.rally ? `@${e.rally.x.toFixed(1)},${e.rally.y.toFixed(1)}` : '@-';
        // The Ungarrison button appears and disappears with the garrison.
        q += `g${garrisonCount(e)}`;
      }
    }
    // The age and the number of finished techs both change what the research
    // buttons say (locked -> ready, ready -> researched), and both change
    // without the selection changing.
    const t = `+a${tech.currentAge(world, PLAYER)}` +
      `t${tech.researchedTechs(world, PLAYER).length}`;
    return `${n}/${Array.from(types).sort().join(',')}${q}${t}` +
      `${state.attackArmed ? '+am' : ''}${state.demolishArm ? '+dm' : ''}`;
  }

  function destroy() {
    state.destroyed = true;
    if (sizeObserver) sizeObserver.disconnect();
    if (topObserver) topObserver.disconnect();
    root.style.removeProperty('--hud-h');
    root.style.removeProperty('--topbar-h');
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
    if (dom.minimapWrap) dom.minimapWrap.classList.remove('alarm');
    for (const n of [modeChip, buildMenu, placeBar, attackBar, menuSheet]) n.remove();
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
    setAttackArmed,
    isAttackArmed,
    isDemolishArmed: () => !!state.demolishArm &&
      performance.now() - state.demolishArm.at <= DEMOLISH_ARM_MS,
    cycleIdle,
    flashRes,
    underAttackAlert,
    alertCount: () => state.alerts,
    attachInput(input) { state.input = input; modeChip.dataset.sig = ''; },
    _dom: dom,
    _minimap: minimap,
  };

  // First paint.
  updateResources();
  renderSelection();
  renderCommands();
  renderModeChip();
  if (minimap) minimap.draw(camera());

  return api;
}
