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
  isWallType, isGateType,
} from '../core/constants.js';
import { EV } from '../core/events.js';
import { ownedBy, forEachNear, edgeDist2, removeEntity } from '../core/world.js';

import * as economy from '../systems/economy.js';
import * as unitAI from '../systems/unitAI.js';
import * as tech from '../systems/tech.js';
import * as alloc from '../systems/allocation.js';
import * as market from '../systems/market.js';
import {
  stanceOf, garrisonCapacity, garrisonCount, isGarrisoned, nearestShelter,
  ungarrisonAll,
} from '../systems/combat.js';

import { createMinimap, miniToGrid } from './minimap.js';
import { createPortraits } from './portraits.js';
import {
  selectedEntities, setSelection, clearSelection, selectionSignature,
} from './selection.js';
import { perfBegin, perfEnd } from '../core/perf.js';

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

// How fast a resource counter catches up with the stockpile behind it, as the
// time constant of an exponential approach. 0.10s means a ten-food drop-off
// rolls over in about a fifth of a second and a 275-wood Town Center counts
// down in a little over half of one — long enough to read as *spending*, short
// enough that the digits are never still moving by the time a thumb has
// travelled to the next button. See updateResources.
const RES_TAU = 0.10;
// Under half a unit from home, stop easing and land. An exponential never
// actually arrives, and a bar that reads 249 for the rest of the match because
// it is asymptotically approaching 250 is worse than no animation at all.
const RES_SNAP = 0.5;

// A rally point this close to something workable *is* an order to work it.
// Must match unitAI's RALLY_SNAP: the HUD's job below is to say out loud what
// the unit AI has already decided, and a HUD that disagrees with the sim is
// worse than no HUD at all.
const RALLY_SNAP = 1.5;

// The text fallback behind every chip and queue slot.
//
// It used to be the whole of the HUD's vocabulary for the roster — see the
// header of ui/portraits.js for why that was the loudest prototype signal in
// the game — and it is now what a type shows only when the atlas has no art for
// it. Kept, rather than deleted, precisely because that case is a roster entry
// somebody has added without a sprite yet, and a chip with nothing in it is
// worse than a chip with three letters in it. The near-collisions the review
// found (MIL militia against MLL mill against MIN mining camp) no longer matter
// on a screen where every one of them is a picture.
//
// THE ONE RULE THIS TABLE HAS. The fallback for a type that is not listed is
// `type.slice(0, 3).toUpperCase()`, and that default is not merely ugly, it can
// be *wrong*: 'archeryrange' auto-abbreviates to ARC, which is already the
// archer's code — so a Feudal player selecting a Range and looking at the unit
// training in it would read ARC twice and be told nothing by either. A silent
// duplicate is the failure mode to design against, because both chips still
// look fine on their own. So every type whose first three letters collide with
// another entry is named here explicitly, and the codes below are the words
// players already use out loud: a Range is RNG, a Siege Workshop is SGE.
//
// The eleven types added with the military buildings are all listed even where
// the default would have been harmless (UNI, KNT), because a table that only
// carries the awkward cases is a table the next person has to re-derive.
const ABBR = {
  villager: 'VIL', militia: 'MIL', archer: 'ARC',
  spearman: 'SPR', scout: 'CAV', ram: 'RAM',
  // The Feudal and Castle roster. SKR/SCP rather than SKI/SCO: the scout is
  // already CAV, but 'skirmisher' and 'scorpion' would otherwise both sit one
  // letter from 'scout' in a 10px font, which is not a distinction a thumb-speed
  // glance can make.
  skirmisher: 'SKR', knight: 'KNT', mangonel: 'MNG', scorpion: 'SCP',
  monk: 'MNK',
  towncenter: 'TC', house: 'HSE', barracks: 'BRK', mill: 'MLL',
  lumbercamp: 'LMB', miningcamp: 'MIN', market: 'MKT',
  // The six military and research buildings. RNG resolves the archer collision
  // described above; SMT and SGE keep the Blacksmith away from BRK (barracks)
  // and the Siege Workshop away from anything beginning SI. MON against the
  // monk's MNK differs in two of three letters, which is the margin every other
  // pair in this table keeps.
  archeryrange: 'RNG', stable: 'STB', blacksmith: 'SMT',
  siegeworkshop: 'SGE', university: 'UNI', monastery: 'MON',
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

/**
 * The order units are listed in when several buildings are selected at once.
 *
 * UNIT_STATS' own key order, which is not an arbitrary choice: constants.js
 * writes the roster out in the order a player meets it — villager, the two
 * Dark Age infantry, the archer, the scout, then siege, then the Castle Age
 * additions and the monk last — and every building's `trains` array is already
 * written in that same order. So sorting a merged list by this map reproduces
 * each building's own ordering exactly when only one is selected, and produces
 * the one obvious interleaving when several are: a Barracks plus an Archery
 * Range reads Militia, Spearman, Archer, Skirmisher, not whichever building the
 * box-select happened to touch first.
 *
 * That last point is the whole reason this is not "concatenate in selection
 * order". Selection order comes out of a Set and shifts with how the player
 * dragged the box; a panel whose buttons move between two identical selections
 * is a panel you cannot build muscle memory on.
 */
const UNIT_RANK = new Map(Object.keys(UNIT_STATS).map((t, i) => [t, i]));

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

// Below this many pixels of free band — viewport less the top bar, the bottom
// bar and the safe areas — the HUD stops trying to show everything at once and
// drops the minimap. Measured: a 360x640 phone with a Town Center selected has
// ~230px of band, which is a dock (50), a minimap (116) and 60px of map. The
// minimap has a full-screen alternative in pan-and-pinch; the dock does not.
const TIGHT_BAND = 320;
// How far a finger may slide on the minimap before it is a scrub rather than a
// tap. Well under the map's own gesture slop: this control is 116px square and
// wants to be responsive, it just must not fire before the finger settles.
const MINI_DRAG_SLOP = 6;

export function createHud(scene, world, audio = null) {
  const doc = document;
  const win = window;
  /**
   * The click of a HUD control.
   *
   * Every control in this file goes through one of three doors — cmdButton(),
   * a dock button, or a sheet's own buttons — so this is called in three places
   * rather than sixty, and a control added tomorrow gets its click for free by
   * using the same helpers. It is a no-op with no engine and a no-op while the
   * context is locked, which is the state the browser harness plays the whole
   * match in.
   */
  const click = () => { if (audio) audio.play('buttonTap'); };
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
    jobNote: doc.getElementById('job-note'),
    stack: doc.getElementById('hud-stack'),
    sheets: doc.getElementById('hud-sheets'),
    dock: doc.getElementById('hud-dock'),
    buildQueue: doc.getElementById('build-queue'),
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
    helpOpen: false,
    resignArm: 0,           // performance.now() of the first Resign tap
    allocOpen: false,
    marketOpen: false,
    marketSig: '',
    placeSig: '',            // placement bar signature (see refreshPlaceBar)
    liveMarket: null,        // { rows } — the trade sheet
    placedThisArm: 0,        // foundations put down since the type was armed
    bqSig: '',               // build-queue strip signature
    allocSig: '',            // allocation readout signature
    idleLast: -1,            // id of the idle villager the button last showed
    liveJob: null,           // { list, node } — the "where is this going" line
    liveGarrison: null,      // { list, node } — the "how many are inside" line
    selSig: '',
    cmdSig: '',
    resSig: '',
    // What the resource bar is currently *reading*, which trails the stockpile
    // by up to half a second while it rolls. Never read by anything that
    // decides whether the player can afford something — see updateResources.
    resShown: { food: NaN, wood: NaN, gold: NaN, stone: NaN },
    idleSig: '',
    minimapAcc: 0,
    hudH: 108,               // measured height of the bottom bar
    topH: 48,                // measured height of the resource bar
    band: -1,                // free vertical space between the two (see syncBand)
    sheetOpen: false,        // is anything open over the map (see syncSheetOpen)
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
    liveAlloc: null,         // { rows, tally, toggle } — the allocation sheet
    liveResearch: null,      // { building, fill, label, slots } — research bar
    liveRack: null,          // the train rack, which scrolls and so needs a fade
    liveBars: [],            // { kind, list, bar, fill, text } — hp and stock rows
    destroyed: false,
  };

  // --- Extra markup (owned here, not in index.html) -------------------------
  //
  // The transient sheets all live in one container inside the thumb stack, so
  // they stack with the build queue, the minimap and the dock rather than being
  // positioned against the bottom of the screen one at a time. Before this they
  // each carried their own copy of `bottom: calc(safe-b + hud-h + 8px)`, which
  // is four places to forget when anything below them changes height.

  const sheets = dom.sheets || root;

  const buildMenu = el('div', 'build-menu');
  buildMenu.id = 'build-menu';
  buildMenu.hidden = true;
  sheets.appendChild(buildMenu);

  const allocSheet = el('div', 'alloc-sheet');
  allocSheet.id = 'alloc-sheet';
  allocSheet.hidden = true;
  sheets.appendChild(allocSheet);

  const marketSheet = el('div', 'market-sheet');
  marketSheet.id = 'market-sheet';
  marketSheet.hidden = true;
  sheets.appendChild(marketSheet);

  // The placement bar lives at the TOP, not in the thumb stack with the other
  // sheets — the only control in the HUD that does.
  //
  // It was measured sitting exactly on top of the thing it describes. Placement
  // opens with the ghost at screen y=422 and the bar occupied y=387..445: an
  // opaque panel with a gold border, its centre six pixels from the ghost's.
  // And it is worse than a one-frame collision, because the ghost tracks
  // finger.y - 62 for the whole gesture, so the only band in which a player can
  // both hold the phone and see what they are placing was the sixty pixels
  // between the bar and the dock — higher and the ghost is behind the bar,
  // lower and the finger is on the minimap, which teleports the camera.
  //
  // Everything in the bar is read, not aimed: a name, a count, a hint and a
  // Cancel. The top strip is already the read-never-tapped region of this HUD
  // (see the note in index.html), which is exactly what this is, and moving it
  // there hands back 58px of contiguous map in the middle of the screen —
  // measured HUD coverage while placing drops from 48.8% to 42.0%.
  const placeBar = el('div', 'place-bar place-top');
  placeBar.id = 'place-bar';
  placeBar.hidden = true;
  root.appendChild(placeBar);

  // Same shape as the placement bar on purpose: the game already teaches "a bar
  // across the bottom means the next tap on the map is spoken for".
  const attackBar = el('div', 'place-bar attack');
  attackBar.id = 'attack-bar';
  attackBar.hidden = true;
  sheets.appendChild(attackBar);

  const menuSheet = el('div', 'menu-sheet');
  menuSheet.id = 'menu-sheet';
  menuSheet.hidden = true;
  sheets.appendChild(menuSheet);

  // The rules. Same shell as the menu sheet — it is the same kind of thing, a
  // scrolling column of text over the map — and a sheet rather than a modal so
  // that the player can still see the game they are reading about.
  const helpSheet = el('div', 'menu-sheet help-sheet');
  helpSheet.id = 'help-sheet';
  helpSheet.hidden = true;
  sheets.appendChild(helpSheet);

  // --- The dock -------------------------------------------------------------
  //
  // Four equal targets across the bottom of the map, in the arc a right thumb
  // sweeps without the hand moving. Built here rather than in index.html
  // because three of the four are stateful (the drag mode, the idle count, the
  // allocation manager's on/off) and the fourth opens a sheet this module owns.

  function dockButton(id, glyph, label, aria) {
    const b = el('button', 'dock-btn');
    b.id = id;
    b.type = 'button';
    b.setAttribute('aria-label', aria || label);
    b.appendChild(el('span', 'glyph', glyph));
    b.appendChild(el('span', 'lbl', label));
    if (dom.dock) dom.dock.appendChild(b);
    return b;
  }

  const modeChip = el('button', 'mode-chip dock-btn');
  modeChip.id = 'mode-chip';
  modeChip.type = 'button';
  modeChip.setAttribute('aria-label', 'One-finger gesture mode');
  if (dom.dock) dom.dock.appendChild(modeChip);

  const idleBtn = dockButton('btn-idle', '', 'Idle', 'Idle villagers — tap to visit the next one');
  idleBtn.classList.add('idle');
  idleBtn.textContent = '';
  const idleCount = el('span', 'count', '0');
  idleBtn.appendChild(idleCount);
  idleBtn.appendChild(el('span', 'lbl', 'Idle'));

  const jobsBtn = dockButton('btn-jobs', '⚖', 'Jobs', 'Villager jobs — set what share works each resource');
  const menuBtn = dockButton('btn-menu', '☰', 'Menu', 'Menu');

  dom.idleBtn = idleBtn;
  dom.idleCount = idleCount;
  dom.jobsBtn = jobsBtn;
  dom.menuBtn = menuBtn;

  // The floating controls (mode chip, idle button, build menu, placement bar)
  // sit just above the bottom bar. Its height depends on what is selected, so
  // measure it rather than guessing with a magic number.
  const bottomBar = root.querySelector('.hud-bottom');
  let sizeObserver = null;
  if (bottomBar && typeof ResizeObserver === 'function') {
    sizeObserver = new ResizeObserver((entries) => {
      // offsetHeight, not contentRect + 12. The 12 was the bar's 6px of padding
      // top and bottom written out as a magic number, which stopped being true
      // in landscape (4 and 4, hud.css) and never included the bottom safe-area
      // inset that lives in the same padding. The border-box height is the
      // thing every consumer actually wants, and it cannot drift from the
      // stylesheet.
      const h = Math.round(entries[0].target.offsetHeight);
      root.style.setProperty('--hud-h', `${h}px`);
      state.hudH = h;
      syncBand();
    });
    sizeObserver.observe(bottomBar);
  }

  /**
   * How much vertical room the HUD has to work with, and how much map is left.
   *
   * `vh` units are the wrong ruler for anything inside this overlay: they
   * measure the viewport, and by the time a sheet opens the top bar, the dock,
   * the minimap and the bottom bar have already spent most of it. A sheet
   * capped at 52vh on a 360x640 phone asked for 333px of a band that was 240px
   * wide and simply hung off the top of the screen, out of reach — its own
   * scroller only owned the part that was on screen, so scrolling could not
   * bring the title back.
   *
   * --band is the real number: viewport minus the safe areas, the top bar and
   * the bottom bar. Every ceiling in the stylesheet is expressed against it,
   * and `.is-tight` lets the layout give up an ornament (the minimap) rather
   * than give up reachability when even the band is small.
   */
  function syncBand() {
    const vh = win.innerHeight || 0;
    if (!vh) return;
    // --hud-h is a border-box height and already carries the bottom safe-area
    // inset (it is part of the bar's own padding); --topbar-h does not carry
    // the top one, because .hud-top is offset by it rather than padded with it.
    const band = Math.max(0, vh - safeInset() - (state.topH || 48) - (state.hudH || 114));
    if (band === state.band) return;
    state.band = band;
    root.style.setProperty('--band', `${band}px`);
    // Below this the dock, the minimap and a sheet cannot all be on screen and
    // still leave a map worth looking at. The minimap is the one that goes: it
    // is a convenience with a full-screen alternative (pan and pinch), while
    // the dock is the only way to reach Jobs, the menu and the idle villagers.
    root.classList.toggle('is-tight', band < TIGHT_BAND);
  }

  /**
   * Has the player asked for less movement?
   *
   * The stylesheet already honours this wholesale — the last rule in hud.css
   * turns off every animation and transition inside the HUD — so anything done
   * in CSS is covered for free. This is for the one piece of motion that is not
   * CSS and cannot be: the rolling resource counters are computed in JS and a
   * stylesheet has no way to reach them. Queried live rather than cached
   * because the setting can be changed while the game is running, and a player
   * who turns it on mid-match means it now.
   */
  const motionQuery = typeof win.matchMedia === 'function'
    ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reducedMotion() {
    return !!(motionQuery && motionQuery.matches);
  }

  /** env(safe-area-inset-top) as a number, via the value the stylesheet resolved. */
  function safeInset() {
    const v = getComputedStyle(root).getPropertyValue('--safe-t');
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
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
      state.topH = h;
      syncBand();
      // Also on the document element, because the end card lives outside the
      // HUD overlay and its "Results" pill has to tuck under the same bar.
      doc.documentElement.style.setProperty('--topbar-h', `${h}px`);
    });
    topObserver.observe(topBar);
  }

  // --- Minimap --------------------------------------------------------------

  const minimap = dom.minimap ? createMinimap(dom.minimap, world) : null;

  // --- Portraits ------------------------------------------------------------

  const portraits = createPortraits(scene);

  /**
   * The picture of a type, for a chip or a queue slot — or its three letters
   * when there is no picture to be had.
   *
   * `cls` is the class the text fallback wears, because the two callers style
   * their fallback differently ('badge' in the selection panel, 'ab' in the
   * queues) and the portrait itself is styled once, by its own class.
   */
  function typeIcon(kind, type, player, cls) {
    const art = portraits.element(kind, type, player);
    if (art) return art;
    return el('span', cls, ABBR[type] || type.slice(0, 3).toUpperCase());
  }

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

  /**
   * The age-up card.
   *
   * Advancing the age used to be the quietest event in the game. It went out as
   * a plain `info` toast — the same styling as "Halted" and "Sound on" — while
   * "Population capped" got a red border, so the single most important
   * strategic milestone in a match was quieter than a routine nag. And nothing
   * said what had just happened: Stone Walls, a Watch Tower, a Market and four
   * blacksmith upgrades flip from grey to live in the build menu at that
   * instant, and a player who does not open the menu in the next minute never
   * finds out.
   *
   * So it borrows the under-attack alert's shape — full width, its own colour,
   * a heading and a sub-line — in gold rather than red, and it lists what
   * opened. The list is derived from the same two tables the build menu and the
   * research panel read (ageForBuilding, TECHS[].age), so it cannot go stale
   * when a building or an upgrade is added.
   *
   * Four seconds rather than the alert's five and a bit: it is news, not a
   * summons, and there is nothing to reach for.
   */
  const AGE_CARD_MS = 4000;

  function ageUnlocks(age) {
    const out = [];
    for (const type of BUILDABLE) {
      const s = BUILDING_STATS[type];
      if (!s) continue;
      if (tech.ageForBuilding(type) === age) out.push(s.name);
    }
    let techs = 0;
    for (const id of Object.keys(tech.TECHS)) {
      const t = tech.TECHS[id];
      // The next age-up is not an unlock, it is the next rung of the same
      // ladder, and listing it here reads as though it were free.
      if (t.advancesTo !== undefined) continue;
      if (t.age === age) techs++;
    }
    return { buildings: out, techs };
  }

  function ageCard(age) {
    if (!dom.toasts) return null;
    const now = performance.now();
    // The card supersedes the chatter the way the alert does — an age-up
    // arrives in the middle of "Training Villager" and should not queue behind
    // it — but never an alert. Being raided while advancing is still the more
    // urgent of the two facts.
    for (const t of state.toasts.slice()) if (!t.alert) killToast(t);

    const { buildings, techs } = ageUnlocks(age);
    const node = el('div', 'toast agecard');
    node.setAttribute('role', 'status');
    const line = el('span', 'line');
    line.appendChild(el('span', 'crest', '⌂'));
    line.appendChild(doc.createTextNode(`${tech.ageName(age)}`));
    node.appendChild(line);
    const bits = [];
    if (buildings.length) bits.push(buildings.join(', '));
    if (techs) bits.push(`${techs} new upgrade${techs === 1 ? '' : 's'}`);
    node.appendChild(el('span', 'sub',
      bits.length ? `Now available: ${bits.join(' · ')}` : 'Every building of yours is tougher'));

    dom.toasts.appendChild(node);
    dom.toasts.classList.add('wide');
    const rec = { node, at: now, ttl: AGE_CARD_MS, alert: true, milestone: true };
    pushToast(rec);
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
    // The stack goes back to being a narrow corner box the moment the last
    // full-width card leaves it, or every toast for the rest of the match
    // covers half the map.
    if (rec.milestone && dom.toasts && !state.toasts.some((t) => t.milestone)) {
      dom.toasts.classList.remove('wide');
    }
  }

  function tickToasts(now) {
    for (const rec of state.toasts.slice()) {
      if (now - rec.at > (rec.ttl || TOAST_MS)) killToast(rec);
    }
    if (state.alarmUntil && now > state.alarmUntil) {
      state.alarmUntil = 0;
      if (dom.minimapWrap) dom.minimapWrap.classList.remove('alarm');
    portraits.destroy();
    }
  }

  // --- The coach ------------------------------------------------------------
  //
  // Four lines, fired off world time, that carry a new player through the first
  // ninety seconds of a match.
  //
  // This exists because of a measurement, not a hunch: starting a match and
  // giving no input for sixty simulated seconds used to change nothing at all —
  // no resource moved, no toast fired, three villagers sat idle and the screen
  // at t=60s was pixel-identical to the screen at t=0. The starting villagers
  // now work (see putToWork in core/mapgen.js), which fixes the *economy*; this
  // fixes the silence. Between them a player who does nothing sees a game that
  // is visibly running and is told, in order, the four things that stop it
  // running out.
  //
  // Two rules, both of which the lines below obey:
  //
  //   It never fires on a resumed match. Somebody twelve minutes into a game
  //   does not need to be told what a villager is, and the save carries no
  //   record of what they were told the first time. `fresh` is decided once,
  //   here, from the clock the restored world came back with.
  //
  //   It never tells the player to do something they have already done. Every
  //   line carries a `still` predicate that is asked at the moment it would
  //   fire, so a player who queued villagers at eight seconds is not told to
  //   train villagers at fifteen, and one who is already in the Feudal Age is
  //   not told to advance to it.
  //
  // Tone follows the rest of the HUD's vocabulary: teaching is 'info', and the
  // only line that earns 'warn' is the one that is a problem right now.
  const COACH = [
    {
      at: 3,
      text: 'Tap a villager, then tap the berries',
      tone: 'info',
      // Only worth saying while the player has issued no orders of their own.
      // The selection being empty is the honest test for "has not touched
      // anything yet" — the first thing any tap on this game does is select.
      still: () => world.selection.size === 0,
    },
    {
      at: 15,
      text: 'Select the Town Center to train more villagers',
      tone: 'info',
      still: () => {
        const tcs = ownedBy(world, PLAYER, 'building', 'towncenter');
        // Already training, or already past the three you started with: the
        // player has worked it out and does not need the hint.
        if (tcs.some((b) => (b.queue || []).length > 0)) return false;
        return ownedBy(world, PLAYER, 'unit', 'villager').length <= 3;
      },
    },
    {
      at: 40,
      text: 'Population capped — tap Build and put down a house',
      tone: 'warn',
      still: () => {
        const p = world.players[PLAYER];
        if (p.pop < p.popCap) return false;
        // A house already going up is the answer to this line; saying it
        // anyway is nagging somebody who is mid-fix.
        return ownedBy(world, PLAYER, 'building', 'house').length === 0;
      },
    },
    {
      at: 90,
      text: 'Select the Town Center and advance the age',
      tone: 'info',
      still: () => {
        if (tech.currentAge(world, PLAYER) > 0) return false;
        return !ownedBy(world, PLAYER, 'building', 'towncenter')
          .some((b) => (b.research || []).length > 0);
      },
    },
  ];

  // A resumed match comes back with its clock, so a non-zero time at the moment
  // the HUD is built means this player has been here before.
  const coachFresh = world.time < 0.5;
  let coachAt = 0;

  function tickCoach() {
    if (!coachFresh || world.over) return;
    while (coachAt < COACH.length && world.time >= COACH[coachAt].at) {
      const line = COACH[coachAt];
      coachAt++;
      let wanted = true;
      try {
        wanted = line.still();
      } catch (_) {
        // A predicate that throws is a bug in the predicate, not a reason to
        // withhold the whole coach — but it is also not a reason to shout.
        wanted = false;
      }
      if (!wanted) continue;
      toast(line.text, line.tone);
      return; // never two coaching lines in one frame
    }
  }

  // --- Resource bar ---------------------------------------------------------

  function setRes(node, value) {
    if (!node) return;
    const span = node.querySelector('span');
    if (span && span.textContent !== value) span.textContent = value;
  }

  /**
   * The stockpiles, rolled rather than jumped.
   *
   * A villager banking ten wood used to replace 250 with 260 between one frame
   * and the next, and the eye reads that as the number having always said 260 —
   * so the single most continuous thing in the game, the income the whole match
   * is about, was invisible unless you happened to be staring at the bar. A
   * counter that *travels* the ten is the difference: motion in the corner of
   * the eye is what tells a player the economy is alive without asking them to
   * look away from the map.
   *
   * The roll is presentation only. Every affordability check in this file reads
   * `p.resources` directly, so a button un-greys the instant the wood actually
   * lands and never waits for the digits to catch up — the HUD may take half a
   * second to finish saying something, but it must never be half a second wrong
   * about what you can buy.
   */
  function updateResources(dt) {
    const p = world.players[PLAYER];
    const age = tech.currentAge(world, PLAYER);

    // exp(-dt/TAU), not a fixed fraction per frame: the roll has to take the
    // same length of time on a 60Hz phone and a 120Hz one.
    const instant = !Number.isFinite(dt) || dt <= 0 || reducedMotion();
    const k = instant ? 0 : Math.exp(-dt / RES_TAU);
    const shown = state.resShown;
    let rising = '';
    for (const key of RES_ORDER) {
      const target = Math.max(0, Math.floor(p.resources[key] || 0));
      let v = shown[key];
      if (!Number.isFinite(v)) {
        v = target;                       // first paint: start where we are
      } else if (Math.abs(target - v) < RES_SNAP) {
        v = target;                       // close enough — land, do not creep
      } else {
        if (target > v) rising += key[0]; // income arriving, worth saying so
        v = target + (v - target) * k;
      }
      shown[key] = v;
    }

    let sig = '';
    for (const key of RES_ORDER) sig += `${Math.floor(shown[key])}/`;
    // `rising` is in the signature because the glow has to be taken off again
    // at the end of a roll that did not happen to change the last digit.
    sig += `${p.pop}/${p.popCap}/${age}/${rising}`;
    if (sig === state.resSig) return;
    state.resSig = sig;
    for (const key of RES_ORDER) {
      setRes(dom[key], String(Math.floor(shown[key])));
      if (dom[key]) dom[key].classList.toggle('rising', rising.includes(key[0]));
    }
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
    // NOTHING SELECTED IS THE COMMONEST STATE IN THE GAME, and it used to cost
    // 108px of a 844px phone — two panels at their 96px floor, holding one
    // sentence of advice and one sentence saying there was nothing to say. That
    // is 13% of the screen, permanently, for no information, on top of the dock
    // and the minimap. The bar now collapses to a single quiet line and gives
    // the map back; `is-idle` is what the stylesheet keys the collapse off.
    root.classList.toggle('is-idle', sel.length === 0);
    if (sel.length === 0) {
      const empty = el('div', 'sel-empty', 'Nothing selected.');
      // Keep this honest about the gesture model: with an empty selection a
      // one-finger drag pans, and the box needs a hold first.
      empty.appendChild(el('small', 'sel-hint', 'Tap a unit · drag to look around · hold then drag to box-select'));
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
      chip.appendChild(typeIcon(g.list[0].kind, g.type, g.player, 'badge'));
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
    // chosen for the player by the sim, so the HUD has to say which one it
    // picked or the Lumber Camp they just paid 100 wood for is invisible.
    //
    // The line itself lives outside this panel, across the full width of the
    // bottom bar (see #job-note in index.html) — inside a 151px column it had
    // to ellipsise the destination, which is the only part of the sentence
    // worth printing.
    const workers = sel.filter((e) => e.player === PLAYER && e.type === 'villager');
    if (workers.length && dom.jobNote) {
      state.liveJob = { list: workers, node: dom.jobNote };
    } else if (dom.jobNote) {
      dom.jobNote.hidden = true;
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

  /**
   * One command button.
   *
   * `icon` takes a node (a portrait, or the three-letter fallback) and puts it
   * ahead of the label; `subCls` lets a caller word its sub-line as something
   * other than a price, which is what the locked entries need — see trainCard.
   * Both exist so that the train cards go through this door rather than growing
   * a second, subtly different button factory beside it.
   */
  function cmdButton(label, {
    cls = '', cost = null, onTap, disabled = false,
    sub = null, subCls = 'cost', icon = null, aria = null,
  } = {}) {
    const b = el('button', `cbtn ${cls}`);
    if (aria) b.setAttribute('aria-label', aria);
    if (icon) b.appendChild(icon);
    b.appendChild(el('span', 'label', label));
    if (cost) {
      const c = costNode(cost);
      b.appendChild(c);
      state.liveCosts.push({ el: b, cost });
    } else if (sub) {
      b.appendChild(el('span', subCls, sub));
    }
    if (disabled) b.disabled = true;
    if (onTap) {
      b.addEventListener('click', (ev) => { ev.stopPropagation(); click(); onTap(); });
    }
    return b;
  }

  function renderCommands() {
    const panel = dom.cmdPanel;
    if (!panel) return;
    panel.textContent = '';
    state.liveCosts = [];
    state.liveQueue = null;
    state.liveResearch = null;
    state.liveRack = null;

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
    //
    // Full width, because it is the only verb a villager has. Measured on a
    // 390px phone, selecting one villager put Build at 50x44 — the smallest
    // button on the screen — under a hundred and fifty pixels of stance
    // buttons belonging to a unit whose default stance is No Attack and which
    // never fights. The stances now come off entirely for a villager-only
    // selection (see below) and the button that opens the whole build tree
    // takes the row it was always worth.
    if (villagers.length) {
      panel.appendChild(cmdButton('Build', {
        cls: 'primary wide',
        sub: `${villagers.length} villager${villagers.length === 1 ? '' : 's'}`,
        aria: `Open the build menu for ${villagers.length} villagers.`,
        onTap: () => toggleBuildMenu(),
      }));
    }

    // Production buildings: train.
    const trainers = buildings.filter((b) => b.trains && b.trains.length);
    const focus = focusedTrainer(trainers);
    if (trainers.length) {
      renderTrainRack(panel, trainers);
      renderQueue(panel, focus, trainers);
      renderRallyNote(panel, trainers, focus);
    }

    // The Market. A sheet rather than six buttons in this panel: a trade is two
    // numbers and two decisions per resource, which is three rows of controls,
    // and the command panel is already the most crowded 150px on the screen.
    const stall = buildings.find((b) => b.type === 'market');
    if (stall) {
      panel.appendChild(cmdButton('Trade', {
        cls: 'primary market',
        sub: 'buy and sell',
        aria: 'Open the market. Buy and sell resources for gold.',
        onTap: () => toggleMarket(true),
      }));
    }

    // Research. Preferring the building that also trains keeps the Town
    // Center's age-up and the Barracks' blacksmith line on the same panel as
    // the units they are for; a Mill or a Lumber Camp trains nothing and is
    // picked up by the fallback. With several trainers in hand it is the
    // focused one that gets asked first, so the research list and the queue
    // block above it are always talking about the same building.
    const researcher =
      (focus && tech.techsAt(focus.type).length ? focus : null) ||
      trainers.find((b) => tech.techsAt(b.type).length > 0) ||
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
    //
    // Not for a selection that is nothing but villagers. Four segments over
    // ~150px of a 390px screen is the largest block in the panel, and for a
    // villager every one of them is a setting about fighting: it opens on No
    // Attack, it has no attack worth the name, and a player who moves it off No
    // Attack has made their economy worse. There is one case where a villager's
    // stance genuinely matters — mixed in with soldiers, where the group order
    // has to mean one thing — and that case still shows the row.
    if (units.length && units.length !== villagers.length) renderStances(panel, units);
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

  // --- Training ---------------------------------------------------------------
  //
  // WHAT A SELECTION CAN TRAIN, NOT WHAT ITS FIRST BUILDING CAN.
  //
  // This used to be `buildings.find((b) => b.trains && b.trains.length)` — one
  // building, whichever the selection happened to yield first, and everything
  // else in hand silently offering nothing. With a Barracks and a Town Center
  // that was a rare annoyance. With six military buildings it is the normal
  // case: box-select your base to queue an army and the panel shows you two
  // infantry and pretends the Archery Range, the Stable, the Siege Workshop and
  // the Monastery you also caught do not exist. Worse, it is *silent* about it
  // — nothing on screen says a building was dropped, so the player concludes
  // the Stable does not work.
  //
  // So the roster is merged across every trainer in hand, de-duplicated (two
  // Barracks offer one Militia button, not two) and sorted into the canonical
  // roster order (see UNIT_RANK). One tap trains at the least-busy building
  // that can make the thing, which is what the player means by selecting three
  // Barracks and tapping Militia three times.

  /**
   * Every unit the selection could train: one entry per type, in roster order,
   * each carrying the buildings that could make it.
   */
  function trainingRoster(trainers) {
    const byType = new Map();
    for (const b of trainers) {
      for (const t of b.trains || []) {
        // A `trains` entry with no stats block is a roster name that has not
        // landed yet — the same forward-declaration BUILDABLE relies on. Skip
        // it rather than drawing a button that cannot be costed.
        if (!UNIT_STATS[t]) continue;
        let rec = byType.get(t);
        if (!rec) byType.set(t, (rec = { type: t, from: [] }));
        rec.from.push(b);
      }
    }
    const rank = (t) => (UNIT_RANK.has(t) ? UNIT_RANK.get(t) : UNIT_RANK.size);
    return [...byType.values()].sort((a, b) => rank(a.type) - rank(b.type));
  }

  /**
   * Which of these buildings should take the order.
   *
   * The shortest queue, ties broken by id so the answer never depends on how
   * the selection was made. Three Barracks and three taps on Militia puts one
   * in each rather than three in the first — a building that is already two
   * deep would deliver the third militia a minute late, and the player picked
   * up three Barracks precisely so that it would not.
   */
  function pickTrainer(list) {
    let best = null;
    for (const b of list) {
      if (!b || b.dead || !b.complete) continue;
      const n = (b.queue || []).length;
      if (!best || n < best.n || (n === best.n && b.id < best.b.id)) best = { b, n };
    }
    return best ? best.b : null;
  }

  /**
   * The building the queue block, the rally line and the research list are
   * about when several are in hand.
   *
   * The one that will finish something soonest, because "what is coming out
   * next" is the question a queue readout exists to answer. It hands over
   * naturally: the building it names is the one that pops, and the moment it
   * does the next-soonest takes the block. With nothing training anywhere it
   * falls back to the lowest id, which is stable across re-renders.
   */
  function focusedTrainer(trainers) {
    let best = null;
    for (const b of trainers) {
      const head = (b.queue || [])[0];
      if (!head) continue;
      const left = Number.isFinite(head.remaining) ? head.remaining : Infinity;
      if (!best || left < best.left || (left === best.left && b.id < best.b.id)) {
        best = { b, left };
      }
    }
    if (best) return best.b;
    let idle = null;
    for (const b of trainers) if (!idle || b.id < idle.id) idle = b;
    return idle;
  }

  /**
   * One train card: the picture, the name, and either the price or the age it
   * is waiting for.
   *
   * THE LOCKED HALF IS THE POINT. A Feudal Stable can train a scout and cannot
   * yet train a Knight (AGE_UNITS in tech.js), and the obvious implementation —
   * list only what is trainable — teaches the player that the Stable they just
   * paid 175 wood for makes one cheap horseman and nothing else. The build menu
   * settled this argument for buildings a while ago and the reasoning carries
   * over word for word: the reason to spend 600 food and 200 gold on the Castle
   * Age is the things it buys, and a panel that only reveals them afterwards
   * asks for that decision blind. So a locked unit is shown, greyed, with the
   * age where its cost would be, and tapping it says why out loud — the same
   * dashed cool wash and the same sentence the build menu uses, because they
   * are the same fact about the same tech tree.
   */
  function trainCard(entry) {
    const type = entry.type;
    const s = UNIT_STATS[type];
    const reason = tech.unitLockReason(world, PLAYER, type);
    if (reason) {
      const need = tech.ageForUnit(type);
      return cmdButton(s.name, {
        cls: 'train locked',
        icon: typeIcon('unit', type, PLAYER, 'ab'),
        // The age replaces the price, exactly as in the build menu: what a
        // Knight costs is not the question you have while you cannot make one.
        sub: tech.AGE_SHORT[need] ? `${tech.AGE_SHORT[need]} Age` : 'later',
        subCls: 'cost need',
        aria: `${s.name}. Locked — ${reason}.`,
        onTap: () => {
          toast(`${s.name} — ${reason.toLowerCase()}`, 'warn');
          flashAge();
        },
      });
    }
    const where = entry.from.length > 1
      ? ` Trains at whichever of your ${entry.from.length} buildings is free.`
      : '';
    return cmdButton(s.name, {
      cls: 'train',
      cost: s.cost,
      icon: typeIcon('unit', type, PLAYER, 'ab'),
      aria: `Train a ${s.name}.${where}`,
      // Resolved at tap time, not at render time: the queues move between the
      // two and the whole value of "least busy" is that it is current.
      onTap: () => {
        const b = pickTrainer(entry.from);
        if (b) train(b, type);
      },
    });
  }

  /**
   * The rack the cards live in — a bounded, scrolling box rather than more
   * panel.
   *
   * THIS IS THE SCREEN BUDGET SPEAKING. A Barracks, an Archery Range and a
   * Stable is six cards; add a Siege Workshop and a Monastery and it is ten,
   * and at two per row that is five rows — 250px, more than the entire command
   * panel is allowed (min(30dvh, 240px)). Left to grow, the fix for the .find()
   * bug would have handed back the screen the HUD pass fought to reclaim, and
   * the queue, the rally line and the research buttons would all have gone
   * below a fold nobody scrolls to.
   *
   * Three rows is the ceiling: six cards, which is the realistic worst case
   * (all three Feudal military buildings at once) shown whole, and anything
   * beyond it scrolls inside the rack with the fade the rest of the HUD uses to
   * say so. The panel underneath keeps its shape whatever is selected, which is
   * worth more than seeing card seven without a swipe.
   */
  function renderTrainRack(panel, trainers) {
    const roster = trainingRoster(trainers);
    if (!roster.length) return;
    const rack = el('div', 'train-rack');
    rack.setAttribute('role', 'group');
    rack.setAttribute('aria-label', trainers.length > 1
      ? `Train — ${roster.length} units across ${trainers.length} buildings`
      : 'Train');
    for (const entry of roster) rack.appendChild(trainCard(entry));
    rack.addEventListener('scroll', () => markCut(rack), { passive: true });
    panel.appendChild(rack);
    // Measured once the panel is complete (see markAllCut), never per frame:
    // scrollHeight forces layout.
    state.liveRack = rack;
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
   *
   * @param {Element}  panel
   * @param {object[]} list  every production building in hand
   * @param {object}   b     the focused one, whose rally the line describes
   *
   * One line for the whole group, not one per building: a rally tap sets the
   * point on every producer selected (see setRally in ui/input.js), so in the
   * ordinary case they all agree and repeating that three times would be three
   * rows of a panel that has none to spare. They can only disagree when the
   * points were set under two different selections, and that case gets said out
   * loud rather than papered over — a HUD showing one flag for three buildings
   * that are aimed at three places is lying about where the army will muster.
   */
  function renderRallyNote(panel, list, b) {
    const note = el('div', 'cmd-note rally-note');
    note.appendChild(el('i', 'flag', '⚑'));
    const key = (p) => (p ? `${p.x.toFixed(2)},${p.y.toFixed(2)}` : '-');
    const agreed = list.every((x) => key(x.rally) === key(b.rally));
    if (!agreed) {
      note.classList.add('is-mixed');
      note.appendChild(doc.createTextNode(
        `Rally points differ across ${list.length} buildings — tap the map to set them all`));
    } else if (b.rally) {
      // Worded against the whole group, so a Town Center picked up alongside a
      // Barracks still says "Villagers will gather food here".
      const r = rallyText(world, list, b.rally);
      note.classList.add(`is-${r.kind}`);
      note.appendChild(doc.createTextNode(r.text));
    } else {
      note.classList.add('is-hint');
      note.appendChild(doc.createTextNode('Tap a resource to rally onto it'));
    }
    panel.appendChild(note);
  }

  function progressOf(b) {
    if (typeof economy.buildProgressOf === 'function') return economy.buildProgressOf(b);
    const total = b.buildTime || 1;
    return Math.max(0, Math.min(1, (b.buildProgress || 0) / total));
  }

  // --- Training queue ---------------------------------------------------------
  //
  // A production building answers three questions and the old row answered one
  // of them. "What is coming out of here" is the question a player asks while
  // deciding whether to tap Militia again, and a progress bar with no name on it
  // cannot answer it; "how many are behind it" is the question that decides
  // whether the answer is worth waiting for; and the queue entries have to be
  // cancellable with a thumb, which 26px squares are not.
  //
  // Cancelling refunds in full (economy.cancelTrain), so — unlike Demolish —
  // one tap does it. There is nothing to protect the player from: the cost is
  // back before the toast has faded, and the alternative, an arm-then-confirm on
  // a button pressed mostly by accident-correction, is two taps to undo one.

  /**
   * @param {Element}  panel
   * @param {object}   b     the building this block is about (see focusedTrainer)
   * @param {object[]} list  every trainer in hand, for the "elsewhere" line
   *
   * ONE BLOCK, EVEN WITH SIX BUILDINGS IN HAND. A queue readout per selected
   * building would be five rows of ninety pixels for a selection whose whole
   * point was to fill them all, and the questions it answers — what is coming
   * out next, how long, what can I cancel — are singular questions with one
   * answer. So the block follows the building that will finish soonest, names
   * it when the answer could be ambiguous, and adds one line accounting for
   * everything queued at the others, which is the only thing the player would
   * otherwise have no way to see.
   */
  function renderQueue(panel, b, list = [b]) {
    if (!b) return;
    const row = el('div', 'queue');
    const head = el('div', 'qhead');
    const what = el('span', 'what');
    const behind = el('span', 'behind');
    const eta = el('span', 'eta');
    head.appendChild(what);
    head.appendChild(behind);
    head.appendChild(eta);
    row.appendChild(head);

    // Which building is being talked about. Only when there is more than one
    // trainer in hand: on a lone Barracks it is a label saying "Barracks" over
    // a panel whose header already says Barracks.
    // It needs no refresh: the focus can only change when a queue changes
    // length, and that is in commandSignature, so the whole panel is rebuilt.
    if (list.length > 1) row.appendChild(el('div', 'qwho', displayName(b)));

    const prog = el('div', 'qprog');
    const fill = el('i');
    prog.appendChild(fill);
    row.appendChild(prog);

    const slots = el('div', 'qslots');
    row.appendChild(slots);
    panel.appendChild(row);
    state.liveQueue = {
      building: b, others: list.filter((x) => x !== b),
      fill, slots, what, behind, eta, drawn: -1, drawnType: '',
    };

    // What is queued at the buildings this block is not about. Without it the
    // three taps a player just spent on a second Barracks vanish from the HUD
    // entirely, which reads exactly like three taps that did nothing.
    if (state.liveQueue.others.length) {
      state.liveQueue.elsewhere = el('div', 'cmd-note queue-elsewhere');
      panel.appendChild(state.liveQueue.elsewhere);
    }
    refreshQueue();
  }

  function refreshQueue() {
    const q = state.liveQueue;
    if (!q || !q.building || q.building.dead) return;
    const queue = q.building.queue || [];
    const p = typeof economy.trainProgress === 'function' ? economy.trainProgress(q.building) : 0;
    q.fill.style.width = `${(p * 100).toFixed(1)}%`;

    const head = queue[0];
    const name = head ? (UNIT_STATS[head.type] ? UNIT_STATS[head.type].name : head.type) : '';
    const whatText = head ? `Training ${name}` : 'Not training';
    if (q.what.textContent !== whatText) q.what.textContent = whatText;
    const behindText = queue.length > 1
      ? `+${queue.length - 1} waiting`
      : head ? 'last in the queue' : '';
    if (q.behind.textContent !== behindText) q.behind.textContent = behindText;
    const etaText = head ? `${Math.max(0, Math.ceil(head.remaining))}s` : '';
    if (q.eta.textContent !== etaText) q.eta.textContent = etaText;

    if (q.elsewhere) {
      let n = 0;
      let busy = 0;
      for (const o of q.others) {
        if (o.dead) continue;
        const len = (o.queue || []).length;
        n += len;
        if (len) busy++;
      }
      const text = n
        ? `+${n} more queued at ${busy} other building${busy === 1 ? '' : 's'}`
        : `${q.others.length} other building${q.others.length === 1 ? '' : 's'} idle`;
      if (q.elsewhere.textContent !== text) q.elsewhere.textContent = text;
      q.elsewhere.classList.toggle('is-quiet', n === 0);
    }

    // Rebuild the chips only when the queue actually changes shape — this runs
    // every frame, and the head's type matters as well as the length (cancel the
    // Militia at the front of Militia/Archer and the count is unchanged).
    const type = queue.map((e) => e.type).join(',');
    if (q.drawn !== queue.length || q.drawnType !== type) {
      q.drawn = queue.length;
      q.drawnType = type;
      q.slots.textContent = '';
      queue.forEach((entry, i) => {
        const s = el('button', `qslot ${i === 0 ? 'head' : ''}`);
        const uname = UNIT_STATS[entry.type] ? UNIT_STATS[entry.type].name : entry.type;
        s.appendChild(typeIcon('unit', entry.type, PLAYER, 'ab'));
        s.appendChild(el('span', 'x', '×'));
        s.title = `Cancel ${uname} — cost refunded`;
        s.setAttribute('aria-label', `Cancel ${uname}, number ${i + 1} in the queue. The cost is refunded.`);
        s.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (typeof economy.cancelTrain !== 'function') return;
          if (economy.cancelTrain(world, q.building, i)) {
            toast(`${uname} cancelled — cost refunded`, 'info');
            state.cmdSig = ''; // force a re-render
          }
        });
        q.slots.appendChild(s);
      });
      if (queue.length === 0) {
        q.slots.appendChild(el('span', 'qempty', 'Nothing queued — tap a unit above'));
      }
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
    // Same shell as the training queue — name on top, bar under it, cancellable
    // chips below — so a player learns one pattern and reads both.
    const head = el('div', 'qhead');
    const label = el('span', 'qlabel');
    head.appendChild(label);
    row.appendChild(head);
    const prog = el('div', 'qprog');
    const fill = el('i');
    prog.appendChild(fill);
    row.appendChild(prog);
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
    const name = head && tech.TECHS[head.id]
      ? `Researching ${tech.TECHS[head.id].name}` : '';
    if (q.label.textContent !== name) q.label.textContent = name;

    if (q.drawn !== queue.length) {
      q.drawn = queue.length;
      q.slots.textContent = '';
      queue.forEach((entry, i) => {
        const t = tech.TECHS[entry.id];
        const s = el('button', `qslot ${i === 0 ? 'head' : ''}`);
        s.appendChild(el('span', 'ab', (t ? t.name : entry.id).slice(0, 3).toUpperCase()));
        s.appendChild(el('span', 'x', '×'));
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
    if (open) {
      // One sheet at a time. They share the same slot above the dock, and two
      // of them open at once is 60% of the screen with the map behind it.
      toggleAlloc(false);
      toggleMenu(false);
      toggleMarket(false);
      closeHelp();
      renderBuildMenu();
      markCut(buildMenu);
    } else {
      state.liveBuild = []; // stop refreshing buttons nobody can see
    }
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

    // Bottom-anchored sheet, so the shelves are laid out bottom-up.
    //
    // The menu grows upward from just above the dock, which means the LAST row
    // in the document is the one nearest the thumb and the first row is the one
    // furthest from it. It used to be written top-down like a page: House, Farm
    // and Mill — the three buildings a player puts down in the first two
    // minutes and keeps putting down for the rest of the match — sat at the top,
    // the hardest place on a 390x844 phone to reach, and Close, which is
    // pressed once and never matters, sat at the bottom under the thumb.
    //
    // Reversed, the Dark Age shelf lands in the thumb's arc, each later age is
    // one shelf further away in the same order it becomes relevant, and Close
    // goes to the top where it is still perfectly findable and no longer in the
    // way. The headings keep the reading order sensible on the way up.
    const cancel = el('button', 'cbtn danger');
    cancel.appendChild(el('span', 'label', 'Close'));
    cancel.addEventListener('click', (ev) => { ev.stopPropagation(); toggleBuildMenu(false); });
    buildMenu.appendChild(cancel);

    for (let age = shelves.length - 1; age >= 0; age--) {
      const shelf = shelves[age];
      if (!shelf.length) continue;
      const locked = age > myAge;
      const title = el('div', `title ${locked ? 'locked' : ''}`,
        locked ? `${AGE_HEADINGS[age]} — locked` : AGE_HEADINGS[age]);
      buildMenu.appendChild(title);
      for (const entry of shelf) buildMenu.appendChild(buildButton(entry, locked));
    }
    // Scroll to the bottom, where the Dark Age shelf now is. A scroller that
    // opens at the top would put the reachable end off screen, which is the
    // whole problem this reordering is solving.
    buildMenu.scrollTop = buildMenu.scrollHeight;
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

  // --- Build queue strip ------------------------------------------------------
  //
  // What the batch looks like once it is down. See the build queue section in
  // economy.js for why the order is remembered at all; this is the half the
  // player can see and undo.

  function refreshBuildQueue() {
    const strip = dom.buildQueue;
    if (!strip || typeof economy.buildQueue !== 'function') return;
    const list = economy.buildQueue(world, PLAYER);
    // Progress is in the signature so the "42%" on the leading chip stays live,
    // rounded to 5% so the strip is not rebuilt sixty times a second.
    // The length leads the signature so that an empty queue is "0|" and not the
    // empty string — which is also the sentinel the events use to force a
    // rebuild, and the collision left the strip on screen holding chips for
    // sites that had already been built.
    const sig = `${list.length}|` + list
      .map((b) => `${b.id}:${Math.round(progressOf(b) * 20)}`)
      .join(',');
    if (sig === state.bqSig) return;
    state.bqSig = sig;

    strip.textContent = '';
    strip.hidden = list.length === 0;
    if (!list.length) return;

    strip.appendChild(el('div', 'qtitle', `Build queue · tap to cancel`));
    list.forEach((b, i) => {
      const name = displayName(b);
      const chip = el('button', `bq-chip ${i === 0 ? 'head' : ''}`);
      chip.appendChild(typeIcon('building', b.type, PLAYER, 'ab'));
      chip.appendChild(el('span', 'n', `${Math.round(progressOf(b) * 100)}%`));
      chip.appendChild(el('span', 'x', '×'));
      chip.title = `Cancel the queued ${name} — cost refunded`;
      chip.setAttribute('aria-label',
        `Cancel the queued ${name}, number ${i + 1} of ${list.length}. The cost is refunded.`);
      chip.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (typeof economy.cancelQueued !== 'function') return;
        if (economy.cancelQueued(world, PLAYER, i)) {
          toast(`${name} cancelled — cost refunded`, 'info');
          state.bqSig = '';
          state.cmdSig = '';
          state.selSig = '';
        }
      });
      strip.appendChild(chip);
    });

    if (list.length > 1) {
      const clear = el('button', 'clear', 'Clear');
      clear.setAttribute('aria-label',
        `Cancel all ${list.length} queued sites. Every cost is refunded.`);
      clear.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const n = economy.clearBuildQueue(world, PLAYER);
        if (n) toast(`${n} sites cancelled — costs refunded`, 'info');
        state.bqSig = '';
        state.cmdSig = '';
        state.selSig = '';
      });
      strip.appendChild(clear);
    }
  }

  // --- Placement mode -------------------------------------------------------
  //
  // BATCH BY DEFAULT. Arming a type used to be spent by the first tap, so a row
  // of five houses was five trips through Build -> House -> aim -> lift: twenty
  // gestures, fifteen of which were the same three. It now stays armed until the
  // player says otherwise, every tap puts another foundation down and joins the
  // build queue, and the builders work through that queue by themselves (see
  // onJobFinished in unitAI.js). The bar counts what has been placed and its
  // button becomes Done once there is something to be done with — "Cancel" is
  // the wrong word for a button that cannot take back the four houses you have
  // already paid for, and the strip below it is where those are undone.
  //
  // This is the same contract the wall drag already had — one arming, many
  // foundations — so the two now read as one feature rather than as a special
  // case for walls.

  function renderPlaceBar() {
    const type = state.placement;
    if (!type) {
      placeBar.hidden = true;
      placeBar.textContent = '';
      root.classList.remove('placing');
      root.style.removeProperty('--placebar-h');
      return;
    }
    const s = BUILDING_STATS[type];
    const name = s ? s.name : type;
    const n = state.placedThisArm;
    const poor = !!(s && !affordable(world, PLAYER, s.cost));
    placeBar.textContent = '';
    const head = el('div', 'head');
    head.appendChild(el('span', 'name', n ? `${name} ×${n} placed` : `Place ${name}`));
    // WHAT IT COSTS, WHILE IT COSTS IT. The price is on the build-menu button,
    // and arming the mode closes the build menu — so the figure vanished at
    // exactly the moment the player started spending it, one tap at a time,
    // through a batch that stays armed until they say stop.
    if (s && s.cost) head.appendChild(costNode(s.cost));
    const txt = el('div', 'txt');
    txt.appendChild(head);
    // A gate is a wall piece but not a run: it goes down one at a time (see
    // wallType in ui/input.js), so it must not be advertised as draggable.
    txt.appendChild(el('small', null, poor
      ? `Not enough ${RES_LABEL[missingResource(world, PLAYER, s.cost)] || 'resources'} for the next one`
      : isWallType(type) && !isGateType(type)
        ? 'Drag to draw a run — two fingers to cancel'
        : n
          ? 'Keep tapping to queue more'
          : 'Drag to aim — lift to place'));
    placeBar.appendChild(txt);
    const done = el('button', n ? 'primary' : 'danger', n ? 'Done' : 'Cancel');
    done.setAttribute('aria-label', n
      ? `Stop placing. ${n} ${name} already queued.`
      : `Stop placing the ${name}.`);
    done.addEventListener('click', (ev) => { ev.stopPropagation(); setPlacementMode(null); });
    placeBar.appendChild(done);
    placeBar.hidden = false;
    placeBar.classList.toggle('is-poor', poor);
    root.classList.add('placing');
    // The toast stack sits directly under the resource bar and the bar has just
    // taken that space, so it is measured and handed over rather than guessed
    // at — the bar is one line tall for a house and two for a wall run.
    root.style.setProperty('--placebar-h', `${placeBar.offsetHeight + 6}px`);
  }

  function setPlacementMode(typeOrNull) {
    const next = typeOrNull || null;
    const changed = next !== state.placement;
    state.placement = next;
    if (changed) state.placedThisArm = 0;
    toggleBuildMenu(false);
    // Placement also claims the next tap, so it cannot coexist with an armed
    // attack-move. (Only when arming: setPlacementMode(null) must not recurse.)
    if (state.placement) setAttackArmed(false, { quiet: true });
    renderPlaceBar();
    if (state.placement && changed) {
      const s = BUILDING_STATS[state.placement];
      toast(`Placing ${s ? s.name : state.placement}`, 'info');
    }
  }

  /**
   * The input layer telling us a foundation went down. Called once per site —
   * including once per segment of a wall run — so the bar's count and the queue
   * strip agree with what is actually on the ground.
   */
  function onFoundationPlaced(n = 1) {
    state.placedThisArm += n;
    state.bqSig = '';
    renderPlaceBar();
    refreshBuildQueue();
  }

  function getPlacementType() { return state.placement; }

  /**
   * Keep the placement bar telling the truth, once a frame.
   *
   * It used to be drawn only when the mode was armed and when a foundation
   * landed, so it read "Place House" all the way through a batch that had run
   * the player out of wood four houses ago — the one line on screen dedicated
   * to the thing they were doing, and it never mentioned the reason it had
   * stopped working. The cost belongs here for the same reason: it is shown in
   * the build menu, which arming the mode closes, so the moment the number
   * starts to matter is the moment it disappears.
   *
   * And placement disarms itself when there is nobody left to build, exactly as
   * attack-move already disarms when the last soldier dies. Otherwise a player
   * whose villagers have been raided goes on buying foundations that nothing
   * will ever come to.
   */
  function refreshPlaceBar() {
    if (!state.placement) return;
    if (!anyVillager()) {
      setPlacementMode(null);
      toast('No villagers left to build — placement cancelled', 'warn');
      return;
    }
    const sig = `${state.placement}:${state.placedThisArm}:${affordable(world, PLAYER, BUILDING_STATS[state.placement] && BUILDING_STATS[state.placement].cost) ? 1 : 0}`;
    if (sig === state.placeSig) return;
    state.placeSig = sig;
    renderPlaceBar();
  }

  function anyVillager() {
    for (const u of world.units) {
      if (!u.dead && u.player === PLAYER && u.type === 'villager') return true;
    }
    return false;
  }

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

    // The two armed modes both claim the next tap; only one may be live. And
    // the bar lives in the same slot as the sheets, so a sheet left open under
    // it stacked another ~58px onto a column that is already the tightest thing
    // on the screen — the one case where "the HUD is over everything" was the
    // HUD arguing with itself.
    setPlacementMode(null);
    toggleBuildMenu(false);
    toggleAlloc(false);
    toggleMarket(false);
    toggleMenu(false);
    closeHelp();

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

  /**
   * The idle count, live — and quiet rather than absent when it is zero.
   *
   * The button used to be hidden at zero. A control that appears and vanishes
   * under a thumb is worse than one that dims: it is the neighbouring buttons
   * that suffer, because they slide sideways to fill the gap and the next tap
   * lands on whatever moved into that spot. It also throws away the one piece
   * of information a well-run economy most wants confirmed — that the answer is
   * still nought. So it keeps its place in the dock, loses the pulse and the
   * gold, and says "none".
   */
  function updateIdle() {
    const list = idleVillagers();
    const sig = String(list.length);
    if (sig === state.idleSig) return;
    state.idleSig = sig;
    if (dom.idleCount) dom.idleCount.textContent = list.length ? sig : '0';
    if (dom.idleBtn) {
      dom.idleBtn.classList.toggle('is-zero', list.length === 0);
      const lbl = dom.idleBtn.querySelector('.lbl');
      if (lbl) lbl.textContent = list.length === 1 ? 'idle' : list.length ? 'idle' : 'none idle';
      dom.idleBtn.setAttribute('aria-label', list.length
        ? `${list.length} idle villager${list.length === 1 ? '' : 's'} — tap to visit the next one`
        : 'No idle villagers');
    }
  }

  /**
   * Visit the next idle villager: select it and put the camera on it.
   *
   * The cursor is the *id of the last one shown*, not an index into the list.
   * An index is wrong the moment the list changes underneath it, which is
   * constantly — the villager you just looked at stops being idle the instant
   * you give it a job, every other entry shifts down one, and tapping the button
   * three times shows you the same two villagers. Anchoring on the id means the
   * cycle continues from where it was however much the list has churned, and
   * falls back to the front when the anchor has gone.
   */
  function cycleIdle() {
    const list = idleVillagers();
    if (!list.length) {
      toast('No idle villagers', 'info');
      return;
    }
    list.sort((a, b) => a.id - b.id);
    const at = list.findIndex((u) => u.id === state.idleLast);
    const v = list[(at + 1) % list.length];
    state.idleLast = v.id;
    setSelection(world, [v]);
    centerOnGrid(v.x, v.y);
    if (list.length > 1) {
      toast(`Idle villager ${((at + 1) % list.length) + 1} of ${list.length}`, 'info');
    }
  }

  // --- Menu sheet -----------------------------------------------------------

  function renderMenuSheet() {
    menuSheet.textContent = '';
    const add = (label, fn, cls) => {
      const b = el('button', cls || null, label);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        click();
        fn();
        toggleMenu(false);
      });
      menuSheet.appendChild(b);
      return b;
    };
    // First row, above everything, because a player who has opened this menu
    // looking for help has nowhere else to look. The rules were written on the
    // boot card and became unreachable the instant the match started — the one
    // screen in the game that explains the game was behind a collapsed
    // <details> a player saw once and never again.
    add('How to play', () => openHelp(), 'menu-help');
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
    renderSoundControls();
    renderResign();
  }

  /**
   * Resign, last in the sheet and armed before it fires.
   *
   * The same arm-then-confirm Demolish uses, for the same reason and with the
   * same wording, because this is the most destructive button in the game: it
   * ends the match. It is last rather than first so that a thumb reaching for
   * "Clear selection" cannot land on it, and it does not close the sheet on the
   * first tap — the confirm has to be somewhere the player is already looking.
   */
  function renderResign() {
    menuSheet.appendChild(el('div', 'menu-head', 'Match'));
    const b = el('button', 'menu-resign');
    const paint = () => {
      const armed = state.resignArm && performance.now() - state.resignArm < DEMOLISH_ARM_MS;
      b.textContent = armed ? 'Confirm — resign the match' : 'Resign';
      b.classList.toggle('armed', !!armed);
      b.setAttribute('aria-label', armed
        ? 'Confirm resignation. The match ends now and counts as a defeat.'
        : 'Resign the match. Asks to confirm.');
    };
    paint();
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      click();
      if (!(state.resignArm && performance.now() - state.resignArm < DEMOLISH_ARM_MS)) {
        state.resignArm = performance.now();
        paint();
        toast('Resign the match? Tap again', 'warn');
        return;
      }
      state.resignArm = 0;
      toggleMenu(false);
      if (scene && typeof scene.resign === 'function') scene.resign();
    });
    menuSheet.appendChild(b);
  }

  /**
   * The rules, in a sheet, cloned from the boot card's list.
   *
   * Cloned rather than restated: index.html owns the words, this owns where
   * they appear, and the day somebody adds a line about walls there is exactly
   * one place to add it. The boot card is hidden but still in the document
   * during a match, so the source list is always there to copy.
   */
  function openHelp() {
    helpSheet.textContent = '';
    const head = el('div', 'menu-head', 'How to play');
    helpSheet.appendChild(head);
    const src = doc.getElementById('help-list');
    if (src) {
      helpSheet.appendChild(src.cloneNode(true)).removeAttribute('id');
    } else {
      helpSheet.appendChild(el('div', 'cmd-note', 'The rules are on the start screen.'));
    }
    const close = el('button', 'primary', 'Got it');
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      click();
      closeHelp();
    });
    helpSheet.appendChild(close);
    helpSheet.hidden = false;
    state.helpOpen = true;
    markCut(helpSheet);
  }

  function closeHelp() {
    helpSheet.hidden = true;
    helpSheet.textContent = '';
    state.helpOpen = false;
  }

  // --- Sound ------------------------------------------------------------------
  //
  // Mute and two volumes, in the menu sheet, because that is where a player
  // looks for a setting and because the dock has no room for a fifth button.
  //
  // Mute is a full-width toggle with a state word on it, exactly like the
  // allocation manager's on/off — a control that silences the game has to be
  // findable in one glance and reversible in one tap. The two sliders sit under
  // it and are separate on purpose: "the music is too loud" and "the game is too
  // loud" are different complaints, and a single volume answers neither of them.
  //
  // Nothing here has to be persisted by hand. The engine writes mute and all
  // three volumes to localStorage on every setter (see the preferences note in
  // src/audio/README.md), so a player who turns the music down finds it down
  // tomorrow.

  function soundSlider(label, aria, get, set) {
    const row = el('div', 'sound-row');
    row.appendChild(el('span', 'who', label));
    const slider = doc.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '5';
    slider.value = String(Math.round(get() * 100));
    slider.setAttribute('aria-label', aria);
    const pct = el('span', 'pct', `${slider.value}%`);
    slider.addEventListener('input', (ev) => {
      ev.stopPropagation();
      const v = Number(slider.value);
      set(v / 100);
      slider.style.setProperty('--fill', `${v}%`);
      pct.textContent = `${v}%`;
    });
    // The slider owns its own drag outright, exactly as the job sliders do.
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove']) {
      slider.addEventListener(t, (ev) => ev.stopPropagation());
    }
    slider.style.setProperty('--fill', `${slider.value}%`);
    row.appendChild(slider);
    row.appendChild(pct);
    return row;
  }

  function renderSoundControls() {
    if (!audio) return;
    menuSheet.appendChild(el('div', 'menu-head', 'Sound'));

    const mute = el('button', 'alloc-toggle sound-mute');
    mute.appendChild(el('span', null, 'Sound'));
    const stateLbl = el('span', 'state');
    mute.appendChild(stateLbl);
    const paint = () => {
      const off = audio.isMuted();
      stateLbl.textContent = off ? 'MUTED' : 'ON';
      mute.classList.toggle('on', !off);
      mute.setAttribute('aria-pressed', off ? 'true' : 'false');
      mute.setAttribute('aria-label', off ? 'Sound is muted. Tap to unmute.' : 'Sound is on. Tap to mute.');
    };
    paint();
    mute.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const off = audio.toggleMuted();
      paint();
      // The click plays *after* the toggle, so unmuting is confirmed by the
      // sound of the button that unmuted it and muting is confirmed by silence.
      if (!off) click();
      toast(off ? 'Sound off' : 'Sound on', 'info');
    });
    menuSheet.appendChild(mute);

    menuSheet.appendChild(soundSlider('Effects', 'Sound effects volume',
      () => audio.getSfxVolume(), (v) => audio.setSfxVolume(v)));
    menuSheet.appendChild(soundSlider('Music', 'Music volume',
      () => audio.getMusicVolume(), (v) => audio.setMusicVolume(v)));
  }

  function toggleMenu(force) {
    const open = force === undefined ? !state.menuOpen : force;
    state.menuOpen = open;
    menuSheet.hidden = !open;
    if (open) {
      toggleAlloc(false);
      toggleBuildMenu(false);
      toggleMarket(false);
      closeHelp();
      // A resignation armed in a previous visit to this sheet must not still be
      // armed when it is opened again — the arm is a promise about the *next*
      // tap, and reopening the menu is not that tap.
      state.resignArm = 0;
      renderMenuSheet();
      markCut(menuSheet);
    }
  }

  // --- Villager allocation manager --------------------------------------------
  //
  // The sliders. The algorithm behind them is systems/allocation.js; everything
  // here is about making four percentages draggable with a thumb and making the
  // result visible enough to trust.
  //
  // Three things earn their space. The on/off is first and full width, because a
  // system that moves your villagers without being asked has to be one tap from
  // being stopped. Each row carries a live "4 / 5" beside its percentage — the
  // number actually working against the number the split asks for — which is the
  // only way to see the manager working without counting villagers on the map,
  // and it is what makes the deadband legible rather than looking like a bug
  // ("it says 4 of 5 and nothing is happening" is answered by the note at the
  // bottom). And a resource the map can no longer offer is greyed with its share
  // struck through, so "my stone slider does nothing" has an answer on screen.

  const ALLOC_LABEL = { food: 'Food', wood: 'Wood', gold: 'Gold', stone: 'Stone' };

  function renderAllocSheet() {
    allocSheet.textContent = '';
    state.allocSig = '';
    const rows = [];

    const head = el('div', 'head');
    head.appendChild(el('span', null, 'Villager jobs'));
    const tally = el('span', 'tally');
    head.appendChild(tally);
    allocSheet.appendChild(head);

    const toggle = el('button', 'alloc-toggle');
    toggle.appendChild(el('span', null, 'Assign villagers for me'));
    const stateLbl = el('span', 'state', 'OFF');
    toggle.appendChild(stateLbl);
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const on = alloc.setAllocationOn(world, PLAYER, !alloc.isAllocationOn(world, PLAYER));
      toast(on
        ? 'Villagers will be assigned to match the split'
        : 'Manual control — villagers stay where they are', 'info');
      state.allocSig = '';
      refreshAlloc();
    });
    allocSheet.appendChild(toggle);

    for (const res of alloc.ALLOC_ORDER) {
      const row = el('div', 'alloc-row');
      row.dataset.res = res;
      const who = el('span', 'who');
      who.appendChild(el('i', `ico ico-${res}`));
      who.appendChild(doc.createTextNode(ALLOC_LABEL[res]));
      row.appendChild(who);

      const slider = doc.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      // Fives, not ones. A thumb cannot resolve one percent on a 150px track,
      // and nobody has ever wanted 37% of their villagers on gold — snapping to
      // fives makes every drag land on a number the player meant.
      slider.step = '5';
      slider.id = `alloc-${res}`;
      slider.setAttribute('aria-label', `${ALLOC_LABEL[res]} share of villagers`);
      slider.addEventListener('input', (ev) => {
        ev.stopPropagation();
        alloc.setSplit(world, PLAYER, res, Number(slider.value));
        state.allocSig = '';
        refreshAlloc();
      });
      // The slider owns its own drag outright; nothing about it may reach the
      // map underneath (the map's handler is on the canvas, but the pointerup
      // listener is on window, so stopping propagation here is belt and braces).
      for (const t of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove']) {
        slider.addEventListener(t, (ev) => ev.stopPropagation());
      }
      row.appendChild(slider);

      const pct = el('span', 'pct');
      const pctNum = doc.createTextNode('0%');
      pct.appendChild(pctNum);
      const count = el('small');
      pct.appendChild(count);
      row.appendChild(pct);

      allocSheet.appendChild(row);
      rows.push({ res, row, slider, pct, pctNum, count });
    }

    const why = el('div', 'why',
      'Idle villagers are placed first, then whoever is nearest the work. ' +
      'A line that is one villager out is left alone — walking someone across ' +
      'the base costs more than it earns.');
    allocSheet.appendChild(why);

    const foot = el('div', 'foot');
    const reset = el('button', null, 'Even split');
    reset.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // 25/25/25/25 rather than the opening ratio: "Even" is the one split a
      // player can predict before tapping it, and the opening ratio is already
      // where they started.
      for (const res of alloc.ALLOC_ORDER) alloc.setSplit(world, PLAYER, res, 25);
      state.allocSig = '';
      refreshAlloc();
    });
    const close = el('button', null, 'Close');
    close.addEventListener('click', (ev) => { ev.stopPropagation(); toggleAlloc(false); });
    foot.appendChild(reset);
    foot.appendChild(close);
    allocSheet.appendChild(foot);

    state.liveAlloc = { rows, tally, toggle, stateLbl };
    refreshAlloc();
  }

  function refreshAlloc() {
    const live = state.liveAlloc;
    if (!live || allocSheet.hidden) return;
    const c = alloc.allocationCounts(world, PLAYER);
    const sig = `${c.on}|${JSON.stringify(c.split)}|${JSON.stringify(c.assigned)}|` +
      `${JSON.stringify(c.desired)}|${c.idle}|${c.total}|${c.available.join('')}`;
    if (sig === state.allocSig) return;
    state.allocSig = sig;

    live.tally.textContent = c.idle
      ? `${c.total} villagers · ${c.idle} idle`
      : `${c.total} villagers`;
    live.toggle.classList.toggle('on', c.on);
    live.stateLbl.textContent = c.on ? 'ON' : 'OFF';

    for (const r of live.rows) {
      const gone = !c.available.includes(r.res);
      const pctv = c.split[r.res];
      if (Number(r.slider.value) !== pctv) r.slider.value = String(pctv);
      r.slider.style.setProperty('--fill', `${pctv}%`);
      r.pctNum.textContent = `${pctv}%`;
      r.count.textContent = gone ? 'none left' : `${c.assigned[r.res]} / ${c.desired[r.res]}`;
      r.pct.classList.toggle('short', !gone && c.assigned[r.res] < c.desired[r.res]);
      r.row.classList.toggle('gone', gone);
    }
  }

  function toggleAlloc(force) {
    const open = force === undefined ? !state.allocOpen : force;
    state.allocOpen = open;
    allocSheet.hidden = !open;
    if (dom.jobsBtn) dom.jobsBtn.classList.toggle('on', open);
    if (open) {
      toggleMenu(false);
      toggleBuildMenu(false);
      toggleMarket(false);
      closeHelp();
      setAttackArmed(false, { quiet: true });
      renderAllocSheet();
      markCut(allocSheet);
    }
  }

  // --- The Market -------------------------------------------------------------
  //
  // Three rows, one per tradeable resource, each carrying the two numbers that
  // decide the trade — what a hundred of it costs to buy, and what a hundred of
  // it fetches to sell — and two large buttons a long way apart.
  //
  // THE MIS-TAP PROBLEM. Buy and Sell are opposites with the same shape, sitting
  // next to each other, operated by a thumb that covers both. Four things keep
  // them apart, and they are all in service of the same rule: a stray tap must
  // either do nothing, or do something the player can see they did not mean.
  //
  //   * They are on opposite sides of the row with a gap between them wide
  //     enough that a thumb centred on one cannot reach the other.
  //   * They are different colours and different words — Buy is the cool one and
  //     names a *cost*, Sell is the gold one and names a *gain* — and each
  //     prints its own gold figure, so the button says what it is about to do
  //     rather than which direction it points.
  //   * A trade that cannot happen is disabled outright rather than merely
  //     greyed, so tapping it is a no-op rather than a refusal toast.
  //   * Every trade that does happen raises a toast naming both sides of it, so
  //     a mis-tap is legible the instant it lands rather than three minutes
  //     later when the gold is gone.

  const MARKET_LABEL = { food: 'Food', wood: 'Wood', stone: 'Stone' };

  function renderMarketSheet() {
    marketSheet.textContent = '';
    state.marketSig = '';
    const rows = [];

    const head = el('div', 'head');
    head.appendChild(el('span', null, 'Market'));
    const gold = el('span', 'gold');
    head.appendChild(gold);
    marketSheet.appendChild(head);

    for (const res of market.TRADED) {
      const row = el('div', 'market-row');
      row.dataset.res = res;

      const who = el('span', 'who');
      who.appendChild(el('i', `ico ico-${res}`));
      who.appendChild(el('b', null, MARKET_LABEL[res] || res));
      const stock = el('small', 'stock');
      who.appendChild(stock);
      row.appendChild(who);

      // Buy on the left, sell on the right, with the price between them: the
      // number both buttons are about, in the one place a thumb never covers.
      const buy = el('button', 'trade buy');
      buy.type = 'button';
      buy.appendChild(el('span', 'verb', 'Buy'));
      const buyCost = el('span', 'gold');
      buy.appendChild(buyCost);
      buy.addEventListener('click', (ev) => { ev.stopPropagation(); click(); trade('buy', res); });
      row.appendChild(buy);

      const mid = el('span', 'lot');
      mid.appendChild(el('b', null, `${market.TRADE_LOT}`));
      mid.appendChild(el('small', null, MARKET_LABEL[res] || res));
      row.appendChild(mid);

      const sell = el('button', 'trade sell');
      sell.type = 'button';
      sell.appendChild(el('span', 'verb', 'Sell'));
      const sellGold = el('span', 'gold');
      sell.appendChild(sellGold);
      sell.addEventListener('click', (ev) => { ev.stopPropagation(); click(); trade('sell', res); });
      row.appendChild(sell);

      marketSheet.appendChild(row);
      rows.push({ res, row, buy, sell, buyCost, sellGold, stock });
    }

    marketSheet.appendChild(el('div', 'why',
      `Selling drops a price by ${market.PRICE_STEP} gold and buying raises it. ` +
      `A sale pays ${Math.round(market.COMMISSION * 100)}% less than the price — ` +
      'that commission is the market’s cut, and it is why trading is the ' +
      'expensive way to get a resource.'));

    const foot = el('div', 'foot');
    const close = el('button', null, 'Close');
    close.addEventListener('click', (ev) => { ev.stopPropagation(); toggleMarket(false); });
    foot.appendChild(close);
    marketSheet.appendChild(foot);

    state.liveMarket = { rows, gold };
    refreshMarket();
  }

  function refreshMarket() {
    const live = state.liveMarket;
    if (!live || marketSheet.hidden) return;
    const opts = market.tradeOptions(world, PLAYER);
    const purse = Math.floor(world.players[PLAYER].resources.gold || 0);
    const sig = `${purse}|` + opts.map((o) =>
      `${o.res}:${o.cost}:${o.value}:${o.have}:${o.canBuy ? 1 : 0}${o.canSell ? 1 : 0}`).join(',');
    if (sig === state.marketSig) return;
    state.marketSig = sig;

    live.gold.textContent = `${purse} gold`;
    for (const r of live.rows) {
      const o = opts.find((x) => x.res === r.res);
      if (!o) continue;
      r.buyCost.textContent = `${o.cost}g`;
      r.sellGold.textContent = `+${o.value}g`;
      r.stock.textContent = `${o.have} in store`;
      r.buy.disabled = !o.canBuy;
      r.sell.disabled = !o.canSell;
      r.buy.setAttribute('aria-label',
        `Buy ${o.lot} ${MARKET_LABEL[o.res]} for ${o.cost} gold.` +
        (o.buyRefusal ? ` ${o.buyRefusal}.` : ''));
      r.sell.setAttribute('aria-label',
        `Sell ${o.lot} ${MARKET_LABEL[o.res]} for ${o.value} gold.` +
        (o.sellRefusal ? ` ${o.sellRefusal}.` : ''));
      r.row.classList.toggle('rich', o.have >= market.TRADE_LOT);
    }
  }

  function trade(side, res) {
    const before = market.tradeOptions(world, PLAYER).find((o) => o.res === res);
    const ok = side === 'buy' ? market.buy(world, PLAYER, res) : market.sell(world, PLAYER, res);
    if (!ok) return;
    const name = (MARKET_LABEL[res] || res).toLowerCase();
    toast(side === 'buy'
      ? `Bought ${market.TRADE_LOT} ${name} for ${before.cost} gold`
      : `Sold ${market.TRADE_LOT} ${name} for ${before.value} gold`, 'info');
    state.marketSig = '';
    state.resSig = '';
    refreshMarket();
  }

  function toggleMarket(force) {
    const open = force === undefined ? !state.marketOpen : force;
    state.marketOpen = open;
    marketSheet.hidden = !open;
    if (open) {
      toggleAlloc(false);
      toggleMenu(false);
      toggleBuildMenu(false);
      closeHelp();
      setAttackArmed(false, { quiet: true });
      renderMarketSheet();
      markCut(marketSheet);
    } else {
      state.liveMarket = null;
    }
  }

  // --- Gesture-mode chip ----------------------------------------------------
  // Shows — and lets you lock — what a one-finger drag does right now.

  function renderModeChip() {
    const inp = state.input;
    const pref = inp ? inp.getDragPreference() : 'auto';
    const eff = inp ? inp.effectiveDragMode() : 'pan';
    // WHILE PLACEMENT IS ARMED THIS BUTTON ENDS IT.
    //
    // The bar that explains what you are placing is pinned to the top of the
    // screen, deliberately — the middle of the screen is where the ghost is and
    // where the player is aiming. But that put the one control that ends the
    // mode in the top-right corner, which index.html's own design note calls
    // out as a place a one-handed thumb cannot reach without re-gripping. And
    // this chip has nothing to say while placing: placement owns the drag, so
    // "what does a drag do" is already answered.
    //
    // So the dock — the designated thumb zone, four buttons wide, always in the
    // same place — grows a Done for as long as there is something to be done
    // with. The bar keeps its own button too; they do the same thing.
    const armed = !!state.placement;
    const sig = armed ? `place:${state.placement}:${state.placedThisArm}` : `${pref}:${eff}`;
    if (modeChip.dataset.sig === sig) return;
    modeChip.dataset.sig = sig;
    modeChip.textContent = '';
    modeChip.classList.toggle('is-done', armed);
    if (armed) {
      const n = state.placedThisArm;
      modeChip.appendChild(el('span', 'glyph', '✓'));
      modeChip.appendChild(el('span', 'lbl', n ? `Done ×${n}` : 'Cancel'));
      modeChip.setAttribute('aria-label', n
        ? `Stop placing. ${n} already queued.`
        : 'Stop placing.');
      modeChip.classList.remove('is-box');
      return;
    }
    modeChip.removeAttribute('aria-label');
    modeChip.appendChild(el('span', 'glyph', eff === 'box' ? '⬚' : '✥'));
    modeChip.appendChild(el('span', 'lbl', eff === 'box' ? 'Select' : 'Pan'));
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
    if (world.selection.size === 0) {
      toggleBuildMenu(false);
      toggleMarket(false);
    }
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
    ageCard(p && p.age !== undefined ? p.age : tech.currentAge(world, PLAYER));
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

  // A foundation finishing, being cancelled or being destroyed all change the
  // build queue strip, and none of them changes the selection.
  off.push(world.events.on(EV.BUILT, () => { state.bqSig = ''; }));
  off.push(world.events.on(EV.REMOVED, () => { state.bqSig = ''; }));

  // Buttons.
  const onIdle = (ev) => { ev.stopPropagation(); click(); cycleIdle(); };
  if (dom.idleBtn) dom.idleBtn.addEventListener('click', onIdle);

  const onMenu = (ev) => { ev.stopPropagation(); click(); toggleMenu(); };
  if (dom.menuBtn) dom.menuBtn.addEventListener('click', onMenu);

  const onJobs = (ev) => { ev.stopPropagation(); click(); toggleAlloc(); };
  if (dom.jobsBtn) dom.jobsBtn.addEventListener('click', onJobs);

  const onChip = (ev) => {
    ev.stopPropagation();
    click();
    // While placement is armed this button is Done — see renderModeChip.
    if (state.placement) {
      setPlacementMode(null);
      return;
    }
    if (state.input && state.input.cycleDragPreference) {
      const next = state.input.cycleDragPreference();
      toast(next === 'auto' ? 'Drag: automatic' : next === 'box' ? 'Drag: box-select' : 'Drag: pan camera', 'info');
      modeChip.dataset.sig = '';
    }
  };
  modeChip.addEventListener('click', onChip);

  // --- Minimap interaction --------------------------------------------------

  let miniDragging = false;
  let miniStart = null;

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

  // THE JUMP HAPPENS ON RELEASE, NOT ON TOUCH. The minimap is 116px square and
  // sits six pixels above the dock, so overshooting the top of a dock button by
  // a thumb's width used to teleport the camera across the map before the
  // finger had even settled — no threshold, no undo, and the player's hand was
  // nowhere near where they now were. Pressing and dragging still scrubs the
  // camera live, which is the one case where following the finger is the point;
  // a press that never moves resolves when it lifts, and a press that slides
  // off onto the dock resolves nowhere.
  let miniMoved = false;
  const onMiniDown = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    miniDragging = true;
    miniMoved = false;
    miniStart = { x: ev.clientX, y: ev.clientY };
    click();
    if (dom.minimap.setPointerCapture) {
      try { dom.minimap.setPointerCapture(ev.pointerId); } catch (_) { /* fine */ }
    }
  };
  const onMiniMove = (ev) => {
    if (!miniDragging) return;
    ev.preventDefault();
    if (!miniMoved && miniStart &&
        Math.hypot(ev.clientX - miniStart.x, ev.clientY - miniStart.y) <= MINI_DRAG_SLOP) return;
    miniMoved = true;
    miniJump(ev);
  };
  const onMiniUp = (ev) => {
    if (miniDragging && !miniMoved && ev && Number.isFinite(ev.clientX) &&
        inside(dom.minimap, ev.clientX, ev.clientY)) {
      miniJump(ev);
    }
    miniDragging = false;
    miniStart = null;
  };

  /** Is this client point still over `node`? */
  function inside(node, x, y) {
    const r = node.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  if (dom.minimap) {
    dom.minimap.addEventListener('pointerdown', onMiniDown);
    dom.minimap.addEventListener('pointermove', onMiniMove);
    dom.minimap.addEventListener('pointerup', onMiniUp);
    dom.minimap.addEventListener('pointercancel', () => { miniDragging = false; miniStart = null; });
  }

  // Tapping the map (never the HUD) closes any transient sheet.
  const gameRoot = doc.getElementById('game-root');
  const onDocDown = (ev) => {
    if (menuSheet.hidden && buildMenu.hidden && allocSheet.hidden && marketSheet.hidden
      && helpSheet.hidden) return;
    if (!gameRoot || !gameRoot.contains(ev.target)) return;
    toggleMenu(false);
    toggleBuildMenu(false);
    toggleAlloc(false);
    toggleMarket(false);
    closeHelp();
  };
  document.addEventListener('pointerdown', onDocDown, true);

  // --- Frame ---------------------------------------------------------------

  function update(dt) {
    if (state.destroyed) return;
    const now = performance.now();
    const _tDom = perfBegin('hud.dom');

    updateResources(dt);
    updateIdle();
    tickToasts(now);
    tickCoach();

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
      // The panels just changed shape, which is the only moment their "there is
      // more below" state can change without somebody scrolling.
      markAllCut();
    } else {
      refreshQueue();
      refreshResearchQueue();
    }
    refreshAffordability();
    refreshBuildQueue();
    refreshAlloc();
    refreshMarket();

    refreshPlaceBar();
    renderModeChip();
    syncSheetOpen();
    perfEnd('hud.dom', _tDom);

    state.minimapAcc += dt;
    if (minimap && state.minimapAcc >= 1 / MINIMAP_HZ) {
      state.minimapAcc = 0;
      const _t = perfBegin('hud.minimap');
      minimap.draw(camera());
      perfEnd('hud.minimap', _t);
    }
  }

  /**
   * Tell the stylesheet whether anything is open over the map.
   *
   * A sheet is 300-440px tall and it sits in a column that already holds the
   * minimap (116), the dock (50) and the build queue, above a bottom bar that
   * is another 110-250. Measured with the menu open on a 390x844 phone, the
   * player could see six pixels of map at the top of the screen and six more
   * between the sheet and the dock. That is not a HUD over a game any more.
   *
   * So while a sheet is up, the two ornaments in the column stand down: the
   * minimap (pinch and pan reach everywhere it does) and the build queue strip
   * (it is a progress readout, and the thing in front of you is a decision).
   * The dock stays, because it is how the sheet gets closed.
   */
  function syncSheetOpen() {
    const open = !buildMenu.hidden || !allocSheet.hidden || !marketSheet.hidden ||
      !menuSheet.hidden || !helpSheet.hidden || !attackBar.hidden;
    if (open === state.sheetOpen) return;
    state.sheetOpen = open;
    root.classList.toggle('sheet-open', open);
  }

  // --- Scroll fades -----------------------------------------------------------
  //
  // Three panels in this HUD scroll — the command panel, the build menu and the
  // menu sheet — and none of them said so. Measured on a Barracks with the
  // blacksmith line available, the command panel held 479px of buttons in
  // 336px of box: the bottom row was cut off mid-button with no scrollbar (iOS
  // does not paint one until you touch it), no fade and no gradient, so it read
  // as a panel that had been clipped rather than one that had more in it. A
  // player who never scrolls never finds Fletching.
  //
  // The fade is a sticky pseudo-element (see .is-cut in hud.css) and it is
  // toggled rather than always on, because a permanent gradient over the last
  // row would dim the bottom button of a panel that is *already* fully shown —
  // which is most panels, most of the time. The measurement it needs
  // (scrollHeight against clientHeight) forces layout, so it is taken when the
  // panel is rebuilt and when it is scrolled, never per frame.
  const SCROLLERS = [];

  function watchScroller(node) {
    if (!node) return;
    SCROLLERS.push(node);
    node.addEventListener('scroll', () => markCut(node), { passive: true });
  }

  function markCut(node) {
    if (!node) return;
    const cut = node.scrollHeight - node.scrollTop - node.clientHeight > 4;
    node.classList.toggle('is-cut', cut);
  }

  function markAllCut() {
    for (const n of SCROLLERS) markCut(n);
    // The train rack is rebuilt with the command panel, so it cannot join
    // SCROLLERS — that list is permanent and would grow by one node per
    // re-render for the life of the match. It carries its own scroll listener
    // (see renderTrainRack) and is measured here, with everything else.
    if (state.liveRack) markCut(state.liveRack);
  }

  watchScroller(dom.cmdPanel);
  watchScroller(buildMenu);
  watchScroller(menuSheet);
  watchScroller(helpSheet);
  // These two scroll for exactly the same reason and were simply left out, so
  // on any phone where the allocation sheet did not fit — a 640px screen, every
  // landscape — the "Even split" and "Close" buttons sat below the fold with
  // nothing on screen to suggest there was a fold.
  watchScroller(allocSheet);
  watchScroller(marketSheet);
  watchScroller(dom.selPanel);

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
    win.removeEventListener('resize', onResize);
    win.removeEventListener('orientationchange', onResize);
    root.classList.remove('is-tight');
    root.classList.remove('sheet-open');
    root.style.removeProperty('--band');
    root.style.removeProperty('--hud-h');
    root.style.removeProperty('--topbar-h');
    root.style.removeProperty('--placebar-h');
    root.classList.remove('placing');
    if (dom.toasts) dom.toasts.classList.remove('wide');
    doc.documentElement.style.removeProperty('--topbar-h');
    for (const fn of off) { try { fn(); } catch (_) { /* already gone */ } }
    if (dom.idleBtn) dom.idleBtn.removeEventListener('click', onIdle);
    if (dom.menuBtn) dom.menuBtn.removeEventListener('click', onMenu);
    if (dom.jobsBtn) dom.jobsBtn.removeEventListener('click', onJobs);
    modeChip.removeEventListener('click', onChip);
    if (dom.minimap) {
      dom.minimap.removeEventListener('pointerdown', onMiniDown);
      dom.minimap.removeEventListener('pointermove', onMiniMove);
      dom.minimap.removeEventListener('pointerup', onMiniUp);
      dom.minimap.removeEventListener('pointercancel', onMiniUp);
    }
    document.removeEventListener('pointerdown', onDocDown, true);
    if (dom.minimapWrap) dom.minimapWrap.classList.remove('alarm');
    for (const n of [modeChip, idleBtn, jobsBtn, menuBtn,
      buildMenu, allocSheet, marketSheet, placeBar, attackBar, menuSheet,
      helpSheet]) n.remove();
    if (dom.selPanel) dom.selPanel.textContent = '';
    if (dom.cmdPanel) dom.cmdPanel.textContent = '';
    if (dom.jobNote) { dom.jobNote.textContent = ''; dom.jobNote.hidden = true; }
    if (dom.buildQueue) { dom.buildQueue.textContent = ''; dom.buildQueue.hidden = true; }
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
    // The input layer reports every foundation it lands so the placement bar's
    // count and the queue strip stay honest without polling.
    onFoundationPlaced,
    placedThisArm: () => state.placedThisArm,
    toggleAlloc,
    toggleMenu,
    toggleMarket,
    cycleIdle,
    flashRes,
    underAttackAlert,
    // The age-up card, for tests/touchui.browser.mjs's layout sweep: it is the
    // only full-width thing the toast stack ever holds and it must be measured.
    _ageCard: ageCard,
    alertCount: () => state.alerts,
    /**
     * How much of the canvas the HUD is sitting on, in CSS px.
     *
     * The map is drawn across the whole viewport but only the middle of it is
     * visible: the resource bar covers the top and the dock, the minimap and
     * the bottom bar cover a much deeper strip at the bottom. Everything that
     * aims the camera used the geometric centre of the canvas, which on the
     * reference phone is ~115px below the centre of the part you can see — so
     * "centre on Town Center", the minimap jump and the idle-villager button
     * all put their target underneath the dock, which is also exactly where
     * the player's thumb is. The input layer offsets by this instead.
     */
    viewInsets: () => ({ top: state.topH || 0, bottom: state.hudH || 0 }),
    attachInput(input) { state.input = input; modeChip.dataset.sig = ''; },
    _dom: dom,
    _minimap: minimap,
  };

  // The band also moves when the window does — a rotate, a keyboard, a browser
  // chrome bar sliding away — and neither ResizeObserver fires for that on its
  // own when the bars happen to keep their height.
  const onResize = () => syncBand();
  win.addEventListener('resize', onResize);
  win.addEventListener('orientationchange', onResize);

  // First paint.
  syncBand();
  updateResources();
  updateIdle();
  renderSelection();
  renderCommands();
  refreshBuildQueue();
  renderModeChip();
  markAllCut();
  if (minimap) minimap.draw(camera());

  return api;
}
