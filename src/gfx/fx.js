// Visual effects: floating text, sparks, gather chips, dust, command pings,
// death puffs and in-flight projectiles.
//
// Everything is pooled and updated from one flat particle array — no
// allocations per frame, no Phaser tweens (which allocate and churn).
// FX subscribe to the event bus, so they work regardless of which system
// emitted the event.

import { EV } from '../core/events.js';
import { HALF_W, HALF_H } from '../core/constants.js';
// The local seat, as a live binding — see core/viewpoint.js.
import { ME as PLAYER } from '../core/viewpoint.js';
import {
  ATLAS, unitFrame, glyphFrame, GLYPH_METRICS, GLYPH_PX,
} from './textures.js';
import { perfCount } from '../core/perf.js';

const RES_COLOR = { food: 0xe8524a, wood: 0xc98a45, gold: 0xf5c333, stone: 0x9aa7b4 };
const CMD_COLOR = { move: 0x4ade80, attack: 0xf05252, gather: 0xfacc15, rally: 0x60a5fa };

const MAX_PARTICLES = 220;
const MAX_TEXTS = 18;
// A number is never longer than this. `-999` is four; anything that wants more
// is a number nobody is reading off a battlefield anyway.
const MAX_GLYPHS = 5;

// --- Load shedding -----------------------------------------------------------
//
// Effects are the first thing that should give way when a frame is in trouble,
// and the last thing that should be cut when it is not. Everything below scales
// with how much of the effect budget is already committed, so a skirmish looks
// exactly as it always did and only a hundred-a-side melee — where a third of
// the sparks land on top of each other anyway — thins out.
//
// The trigger is the particle pool's own occupancy, not a frame time: frame
// time is a lagging, noisy signal that would make the effects flicker between
// full and thinned, whereas "how many particles are already alive" is exact,
// free to read, and is the thing that actually costs.
//
// Below LOAD_SOFT the game is at full detail. Between LOAD_SOFT and LOAD_HARD
// spawn counts fall off linearly to a third. Above LOAD_HARD only the effects
// that carry information a player acts on — the hit sparks, the death, the
// floating number — still fire, and the purely atmospheric ones (footfall dust,
// the dust puff under a blow) stop.
const LOAD_SOFT = 0.45;
const LOAD_HARD = 0.85;

export function createFx(scene, world, opts) {
  const depthOf = opts.depthFor;
  const camera = opts.camera;
  const origins = opts.origins;

  // --- pools ---------------------------------------------------------------
  const parts = [];       // active particles
  const freeParts = [];   // recycled particle records
  const spritePool = [];  // idle Phaser images
  let spriteCount = 0;

  // Floating labels. Each one is a run of pooled glyph sprites out of the atlas
  // rather than a Phaser Text — see GLYPHS in textures.js for the draw-call
  // arithmetic that bought.
  const texts = [];       // { glyphs: [], n, w, x, y, life, max, rise, alpha, tint }
  const textPool = [];
  const glyphPool = [];

  const projSprites = [];

  // How full the effect budget is, 0..1. Read by every recipe below.
  function load() {
    return parts.length / MAX_PARTICLES;
  }

  /**
   * Scale a spawn count by the current load. Never returns 0 for a request of 1:
   * an effect that exists at all must not blink out of existence at the load
   * threshold, because that is exactly when the player is looking at it.
   */
  function scaled(n) {
    const l = load();
    if (l <= LOAD_SOFT) return n;
    const k = l >= LOAD_HARD
      ? 0.34
      : 1 - ((l - LOAD_SOFT) / (LOAD_HARD - LOAD_SOFT)) * 0.66;
    return Math.max(1, Math.round(n * k));
  }

  /** True when the frame has no room left for purely atmospheric effects. */
  function saturated() {
    return load() >= LOAD_HARD;
  }

  function getSprite() {
    let s = spritePool.pop();
    if (!s) {
      s = scene.add.image(0, 0, ATLAS, 'fx_puff');
      s.setOrigin(0.5, 0.5);
      spriteCount++;
    }
    s.setVisible(true);
    s.setAngle(0);
    s.setBlendMode(Phaser.BlendModes.NORMAL);
    return s;
  }

  function releaseSprite(s) {
    s.setVisible(false);
    s.clearTint();
    s.setAlpha(1);
    s.setScale(1);
    if (s.isCropped) s.setCrop();
    spritePool.push(s);
  }

  function spawn(frame, wx, wy, cfg) {
    if (parts.length >= MAX_PARTICLES) {
      // Recycle the oldest rather than growing without bound.
      const old = parts.shift();
      releaseSprite(old.spr);
      freeParts.push(old);
    }
    const p = freeParts.pop() || {};
    const s = getSprite();
    s.setTexture(ATLAS, frame);
    // Frames carry their own anchor (a corpse must stand on its feet, a puff
    // must be centred), so re-apply it every time the frame changes.
    const o = origins && origins.get(frame);
    s.setOrigin(o ? o.ox : 0.5, o ? o.oy : 0.5);
    p.spr = s;
    p.x = wx;
    p.y = wy;
    p.vx = cfg.vx || 0;
    p.vy = cfg.vy || 0;
    p.ax = cfg.ax || 0;
    p.ay = cfg.ay || 0;
    p.life = 0;
    p.max = cfg.life || 0.5;
    p.s0 = cfg.s0 !== undefined ? cfg.s0 : 1;
    p.s1 = cfg.s1 !== undefined ? cfg.s1 : p.s0;
    p.a0 = cfg.a0 !== undefined ? cfg.a0 : 1;
    p.a1 = cfg.a1 !== undefined ? cfg.a1 : 0;
    p.rot = cfg.rot || 0;
    p.vr = cfg.vr || 0;
    // `hold` keeps a particle at full alpha for this fraction of its life before
    // the fade starts. A corpse that begins fading the instant it falls is a
    // corpse the player never sees; one that lies there and *then* goes is the
    // difference between a death and a despawn.
    p.hold = cfg.hold || 0;
    // An optional single frame change partway through, for two-pose sequences.
    p.swapAt = cfg.swapAt !== undefined ? cfg.swapAt : -1;
    p.swapFrame = cfg.swapFrame || null;
    p.swapped = false;
    p.depth = cfg.depth !== undefined ? cfg.depth : depthOf(0, 0, 900);
    p.flipX = !!cfg.flipX;
    s.setDepth(p.depth);
    s.setPosition(wx, wy);
    s.setScale(p.s0);
    s.setAlpha(p.a0);
    s.setAngle(p.rot);
    s.setFlipX(p.flipX);
    if (cfg.tint !== undefined && cfg.tint !== null) s.setTint(cfg.tint);
    else s.clearTint();
    if (cfg.blend) s.setBlendMode(cfg.blend);
    parts.push(p);
    return p;
  }

  // --- floating text -------------------------------------------------------

  function getGlyph() {
    let s = glyphPool.pop();
    if (!s) {
      s = scene.add.image(0, 0, ATLAS, glyphFrame('0'));
      s.setDepth(900000);
    }
    s.setVisible(true);
    return s;
  }

  function releaseText(t) {
    for (let i = 0; i < t.n; i++) {
      const s = t.glyphs[i];
      s.setVisible(false);
      glyphPool.push(s);
      t.glyphs[i] = null;
    }
    t.n = 0;
  }

  /**
   * Lay a short number out of baked glyphs.
   *
   * The layout is done once, at spawn, in baked-pixel units; the per-frame work
   * is then one position and one alpha per glyph, exactly as it was for the
   * single Text object this replaced. `px` is the screen height the label wants,
   * which the glyphs are scaled down to — see GLYPHS in textures.js.
   */
  function floatText(str, wx, wy, color, big, small) {
    if (texts.length >= MAX_TEXTS) return;
    const s = String(str);
    let t = textPool.pop();
    if (!t) t = { glyphs: new Array(MAX_GLYPHS).fill(null), n: 0 };

    const px = big ? 17 : small ? 12 : 14;
    const scale = px / GLYPH_PX;
    let width = 0;
    let n = 0;
    for (let i = 0; i < s.length && n < MAX_GLYPHS; i++) {
      const adv = GLYPH_METRICS.advance.get(s[i]);
      if (adv === undefined) continue;   // nothing in the font for it; skip
      width += adv;
      n++;
    }
    if (n === 0) {
      textPool.push(t);
      return;
    }

    const tint = typeof color === 'string' ? 0xffffff : (color >>> 0);
    let cursor = -width / 2;
    let k = 0;
    for (let i = 0; i < s.length && k < n; i++) {
      const ch = s[i];
      const adv = GLYPH_METRICS.advance.get(ch);
      if (adv === undefined) continue;
      const g = getGlyph();
      g.setTexture(ATLAS, glyphFrame(ch));
      g.setTint(tint);
      // Every glyph is anchored on its own baseline, so a run of them sits on
      // one line whatever mix of digits and signs it is made of.
      const o = origins && origins.get(glyphFrame(ch));
      if (o) g.setOrigin(o.ox, o.oy);
      t.glyphs[k] = g;
      // Offset from the label's anchor, in baked pixels. Scaling happens once
      // per frame in update(), against the camera zoom.
      g._dx = (cursor + adv / 2) * scale;
      cursor += adv;
      k++;
    }
    t.n = n;
    t.scale = scale;
    t.x = wx;
    t.y = wy;
    t.life = 0;
    // A damage number is a glance, not a label: short life and a small rise, so
    // it is gone before the next swing lands and never queues up a column of
    // stale digits over a unit.
    t.max = small ? 0.72 : 1.05;
    t.rise = small ? 19 : 26;
    t.alpha = small ? 0.9 : 1;
    texts.push(t);
  }

  // --- world helpers -------------------------------------------------------

  function wx(gx, gy) { return (gx - gy) * HALF_W; }
  function wy(gx, gy) { return (gx + gy) * HALF_H; }

  // --- fog gate ------------------------------------------------------------
  //
  // Effects are information. Sparks where two enemy armies are grinding each
  // other down, a dust ring where a building finished, a floating -12: all of
  // it tells you exactly what is happening in a corner of the map you cannot
  // see, and it is the classic way a fog of war ends up leaking. Every recipe
  // below that fires from a *world position* asks this first.
  //
  // The mask is read straight off the vision system each time rather than
  // cached, because effects are spawned from events and the events arrive
  // between frames.
  const visMask = world.vision ? world.vision.state(PLAYER).visible : null;

  const MW = world.width;
  const MH = world.height;

  function lit(gx, gy) {
    if (!visMask) return true;
    const tx = gx | 0;
    const ty = gy | 0;
    if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return false;
    return visMask[ty * MW + tx] === 1;
  }

  /** A building is lit if any tile of its footprint is. */
  function litEntity(e) {
    if (!visMask || !e) return true;
    if (e.kind === 'building' && e.tiles) {
      for (const [tx, ty] of e.tiles) {
        if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) continue;
        if (visMask[ty * MW + tx]) return true;
      }
      return false;
    }
    return lit(e.x, e.y);
  }

  /** Where a floating label should sit relative to an entity's ground point. */
  function entityAnchorY(e) {
    if (!e) return 0;
    // A farm is a flat field: hanging its labels at house height would leave
    // them floating in empty sky above the crop.
    if (e.kind === 'building' && e.type === 'farm') return -44;
    if (e.kind === 'building') {
      if (e.type === 'towncenter') return -150; // clears the mast
      return -((e.fw || 2) >= 3 ? 115 : 70);
    }
    if (e.kind === 'resource') return -34;
    return -48;
  }

  /** South corner of a building's footprint — visible, not buried in the roof. */
  function frontOf(e) {
    if (e && e.kind === 'building') {
      return { x: e.x + (e.fw || 2) * 0.45, y: e.y + (e.fh || 2) * 0.45 };
    }
    return { x: e ? e.x : 0, y: e ? e.y : 0 };
  }

  // --- effect recipes ------------------------------------------------------

  function sparks(gx, gy, count, tint) {
    const x = wx(gx, gy);
    const y = wy(gx, gy) - 16;
    const n = scaled(count);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 70;
      spawn('fx_spark', x, y, {
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp * 0.6 - 30,
        ay: 220,
        life: 0.28 + Math.random() * 0.16,
        s0: 0.55, s1: 0.1,
        a0: 1, a1: 0,
        tint,
        depth: depthOf(gx, gy, 700),
        blend: Phaser.BlendModes.ADD,
      });
    }
  }

  function dust(gx, gy, count, tint) {
    const x = wx(gx, gy);
    const y = wy(gx, gy);
    const n = scaled(count);
    for (let i = 0; i < n; i++) {
      spawn('fx_puff', x + (Math.random() - 0.5) * 10, y + (Math.random() - 0.5) * 5, {
        vx: (Math.random() - 0.5) * 26,
        vy: -8 - Math.random() * 14,
        life: 0.45 + Math.random() * 0.3,
        s0: 0.22, s1: 0.8,
        a0: 0.5, a1: 0,
        tint: tint === undefined ? 0xcfc2a4 : tint,
        depth: depthOf(gx, gy, -2),
      });
    }
  }

  /** Chips flying off a resource node toward the villager working it. */
  function chips(gx, gy, toGx, toGy, type) {
    const x = wx(gx, gy);
    const y = wy(gx, gy) - 18;
    const dx = wx(toGx, toGy) - x;
    const dy = wy(toGx, toGy) - y;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = 0; i < 3; i++) {
      spawn('fx_chip', x, y, {
        vx: (dx / len) * 46 + (Math.random() - 0.5) * 55,
        vy: (dy / len) * 46 - 45 - Math.random() * 30,
        ay: 260,
        life: 0.42 + Math.random() * 0.18,
        s0: 1, s1: 0.7,
        a0: 1, a1: 0.1,
        rot: Math.random() * 360,
        vr: (Math.random() - 0.5) * 720,
        tint: RES_COLOR[type] || 0xffffff,
        depth: depthOf(gx, gy, 700),
      });
    }
  }

  function commandPing(gx, gy, kind) {
    const x = wx(gx, gy);
    const y = wy(gx, gy);
    const tint = CMD_COLOR[kind] || CMD_COLOR.move;
    spawn('fx_ring', x, y, {
      life: 0.6,
      s0: 0.3, s1: 1.35,
      a0: 1, a1: 0,
      tint,
      depth: depthOf(gx, gy, 620),
    });
    spawn('fx_ring', x, y, {
      life: 0.85,
      s0: 0.12, s1: 0.9,
      a0: 0.9, a1: 0,
      tint,
      depth: depthOf(gx, gy, 621),
    });
    spawn('fx_dot', x, y, {
      life: 0.55,
      s0: 1.6, s1: 0.2,
      a0: 1, a1: 0,
      tint,
      depth: depthOf(gx, gy, 622),
    });
  }

  function builtPulse(b) {
    const f = frontOf(b);
    const x = wx(f.x, f.y);
    const y = wy(f.x, f.y);
    const scale = Math.max(b.fw || 2, 2) / 2;
    spawn('fx_ring', x, y, {
      life: 0.7,
      s0: 0.5 * scale, s1: 1.5 * scale,
      a0: 0.95, a1: 0,
      tint: 0xffe08a,
      depth: depthOf(f.x, f.y, 620),
    });
    for (let i = 0; i < 10; i++) {
      const a = (Math.PI * 2 * i) / 10;
      dust(b.x + Math.cos(a) * (b.fw || 2) * 0.5, b.y + Math.sin(a) * (b.fh || 2) * 0.5, 1);
    }
  }

  // --- event wiring --------------------------------------------------------

  const offs = [];
  const on = (ev, fn) => offs.push(world.events.on(ev, fn));

  // One number per target per DAMAGE_TEXT_GAP seconds. Without this a
  // twenty-a-side melee stacks eight numbers on top of each other over the same
  // three tiles and the screen turns into a spreadsheet — the numbers stop being
  // information about *this* hit and become a texture. Rate-limited, they read
  // as punctuation on the fight.
  const DAMAGE_TEXT_GAP = 0.32;
  // The three damage colours. Green and red are the same pair the health bars
  // use for own and enemy, so the whole combat display speaks one language;
  // they are lifted a couple of steps in brightness because a five-pixel glyph
  // needs more contrast against grass than a bar with a black surround does.
  const DAMAGE_DEALT = 0x8df09a;
  const DAMAGE_TAKEN = 0xff8272;
  const DAMAGE_OTHER = 0xffe9c9;
  const lastNumberAt = new Map();
  let numberClock = 0;

  on(EV.DAMAGE, (p) => {
    const t = p && p.target;
    if (!t || t.dead) return;
    if (!litEntity(t)) return;
    sparks(t.x, t.y, t.kind === 'building' ? 3 : 4, t.kind === 'building' ? 0xd8c9a0 : 0xffd27a);
    // A puff of dust at the feet on every landed blow. Sparks alone say "metal
    // hit metal"; the dust is what makes it land on the ground the fight is
    // standing on. First thing to go when the budget is full: in a melee dense
    // enough to saturate it, every one of these lands under somebody's feet
    // where nothing of it can be seen.
    if (t.kind !== 'resource' && !saturated() && Math.random() < 0.7) {
      dust(t.x, t.y, 1, t.kind === 'building' ? 0xbdae94 : 0xc9bda3);
    }
    if (p.amount < 1) return;
    const prev = lastNumberAt.get(t.id);
    if (prev !== undefined && numberClock - prev < DAMAGE_TEXT_GAP) return;
    lastNumberAt.set(t.id, numberClock);
    if (texts.length >= MAX_TEXTS - 6) return;
    // Coloured by WHO SWUNG, not by who was hit.
    //
    // These used to be red over your own casualties and a warm white over
    // everything else, which is nearly the right idea and reads as one colour
    // at speed: a warm white number is what every floating number in every game
    // looks like, so a melee produced a cloud of pale digits and the only way
    // to tell whether you were winning it was to read them. Green for a blow
    // you landed and red for one you took is a distinction the eye makes
    // without stopping — the balance of colour over a fight *is* the score, and
    // a player can read it while doing something else.
    //
    // Off the dealer rather than the target because those two questions come
    // apart: an enemy ram hitting a neutral tree, or two AI players fighting
    // each other in view, are neither your win nor your loss and get the old
    // neutral wash.
    const src = p.entity;
    const dealt = src && src.player === PLAYER;
    const taken = t.player === PLAYER;
    const tint = dealt ? DAMAGE_DEALT : taken ? DAMAGE_TAKEN : DAMAGE_OTHER;
    floatText(`-${Math.round(p.amount)}`, wx(t.x, t.y), wy(t.x, t.y) + entityAnchorY(t),
      tint, false, true);
  });

  on(EV.GATHER_TICK, (p) => {
    const n = p && p.node;
    const u = p && p.unit;
    if (!n) return;
    if (!lit(n.x, n.y)) return;
    if (Math.random() < 0.55) {
      chips(n.x, n.y, u ? u.x : n.x, u ? u.y : n.y - 1, p.type);
    }
  });

  on(EV.DEPOSIT, (p) => {
    const b = p && p.building;
    if (!b) return;
    if (!litEntity(b)) return;
    const amt = Math.round(p.amount || 0);
    if (amt <= 0) return;
    floatText(`+${amt}`, wx(b.x, b.y), wy(b.x, b.y) + entityAnchorY(b),
      RES_COLOR[p.type] || 0xffffff, true);
    // Ring at the drop-off doorway (or the villager), not buried under the roof.
    const at = p.unit && !p.unit.dead ? p.unit : frontOf(b);
    spawn('fx_ring', wx(at.x, at.y), wy(at.x, at.y), {
      life: 0.45,
      s0: 0.3, s1: 0.95,
      a0: 0.85, a1: 0,
      tint: RES_COLOR[p.type] || 0xffffff,
      depth: depthOf(at.x, at.y, 620),
    });
  });

  on(EV.FLOAT_TEXT, (p) => {
    if (!p) return;
    if (!lit(p.gx, p.gy)) return;
    floatText(String(p.text), wx(p.gx, p.gy), wy(p.gx, p.gy) - 22, p.color || 0xffffff, true);
  });

  on(EV.COMMAND_FX, (p) => {
    if (!p) return;
    commandPing(p.gx, p.gy, p.kind);
  });

  on(EV.BUILT, (p) => {
    if (p && p.building && litEntity(p.building)) builtPulse(p.building);
  });

  on(EV.PROJECTILE, (p) => {
    const f = p && p.from;
    if (!f) return;
    if (!lit(f.x, f.y)) return;
    sparks(f.x, f.y, 1, 0xfff0c0);
  });

  on(EV.DEATH, (p) => {
    const e = p && p.entity;
    if (!e) return;
    if (!litEntity(e)) return;
    const x = wx(e.x, e.y);
    const y = wy(e.x, e.y);
    if (e.kind === 'unit') {
      // A death in three beats: the stagger, the fall, and the body lying there
      // long enough to be seen before it goes.
      //
      // The two death poses do the work a rotation cannot — knees folding,
      // weapon dropping — and the rotation does the work a pose cannot, which
      // is the actual topple. Together they read as a man going down. The body
      // then holds at full opacity for most of its life and fades at the end,
      // so a fight leaves a field of casualties for a couple of seconds rather
      // than a series of blinks.
      const pl = e.player === 1 ? 1 : 0;
      // Fall away from whatever killed it when the killer is known, so a line
      // of troops cut down by one volley all tip the same way.
      const k = p.killer;
      const away = k ? Math.sign((e.x - k.x) + (e.y - k.y)) : 1;
      spawn(unitFrame(e.type, pl, false, 'd0'), x, y, {
        life: 1.9,
        vy: -3,
        s0: 1, s1: 0.96,
        a0: 1, a1: 0,
        hold: 0.62,
        rot: 0,
        vr: (away >= 0 ? 46 : -46),
        swapAt: 0.22,
        swapFrame: unitFrame(e.type, pl, false, 'd1'),
        depth: depthOf(e.x, e.y, -4),
      });
      dust(e.x, e.y, 5, 0xb8a689);
      sparks(e.x, e.y, 3, 0xff6b6b);
    } else if (e.kind === 'building') {
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * (e.fw || 2) * 0.6;
        dust(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r, 1, 0xa89880);
      }
      spawn('fx_ring', x, y, {
        life: 0.8,
        s0: 0.4, s1: 1.6,
        a0: 0.8, a1: 0,
        tint: 0x9a8a72,
        depth: depthOf(e.x, e.y, 620),
      });
    } else if (e.kind === 'resource') {
      dust(e.x, e.y, 4, 0xbba97f);
    }
  });

  // --- projectiles ---------------------------------------------------------

  function syncProjectiles() {
    const list = world.projectiles || [];
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      // An arrow arcing out of the dark would draw a line straight back to an
      // archer you are not supposed to know about, so an arrow in fog simply is
      // not drawn. Sprites are packed down rather than skipped in place, or the
      // hidden ones would leave gaps in the pool that the tail loop re-shows.
      if (!lit(pr.x, pr.y)) continue;
      let s = projSprites[n];
      if (!s) {
        s = scene.add.image(0, 0, ATLAS, 'fx_arrow');
        s.setOrigin(0.5, 0.5);
        projSprites.push(s);
      }
      // Prefer the projectile's own position; fall back to interpolating
      // start -> target with its elapsed/duration if the sim keeps x/y static.
      let gx = pr.x;
      let gy = pr.y;
      let tx = pr.tx;
      let ty = pr.ty;
      if (pr.target && !pr.target.dead) {
        tx = pr.target.x;
        ty = pr.target.y;
      }
      const dur = pr.duration || 0;
      const t = dur > 0 ? Math.min(1, (pr.elapsed || 0) / dur) : 0;
      const dx = tx - gx;
      const dy = ty - gy;
      // Slight ballistic arc so arrows read as thrown, not slid.
      const arc = dur > 0 ? Math.sin(Math.PI * t) * Math.min(22, dur * 26) : 0;
      const px = (gx - gy) * HALF_W;
      const py = (gx + gy) * HALF_H - arc;
      const sdx = (dx - dy) * HALF_W;
      const sdy = (dx + dy) * HALF_H;
      s.setVisible(true);
      s.setPosition(px, py);
      s.setRotation(Math.atan2(sdy, sdx));
      s.setDepth(depthOf(gx, gy, 800));
      n++;
    }
    for (let i = n; i < projSprites.length; i++) {
      if (projSprites[i].visible) projSprites[i].setVisible(false);
    }
    return n;
  }

  // --- per-frame -----------------------------------------------------------

  let dustTimer = 0;

  function update(dt) {
    numberClock += dt;
    if (lastNumberAt.size > 96) lastNumberAt.clear();

    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life += dt;
      const t = p.life / p.max;
      if (t >= 1) {
        releaseSprite(p.spr);
        parts.splice(i, 1);
        freeParts.push(p);
        continue;
      }
      p.vx += p.ax * dt;
      p.vy += p.ay * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const s = p.spr;
      if (!p.swapped && p.swapAt >= 0 && p.life >= p.swapAt) {
        p.swapped = true;
        s.setTexture(ATLAS, p.swapFrame);
        const o = origins && origins.get(p.swapFrame);
        s.setOrigin(o ? o.ox : 0.5, o ? o.oy : 0.5);
      }
      s.setPosition(p.x, p.y);
      s.setScale(p.s0 + (p.s1 - p.s0) * t);
      const at = p.hold ? Math.max(0, (t - p.hold) / (1 - p.hold)) : t;
      s.setAlpha(p.a0 + (p.a1 - p.a0) * at);
      if (p.vr) s.setAngle(p.rot);
    }

    // Keep world-space labels a constant size on screen at any zoom.
    const invZoom = 1 / camera.zoom;
    for (let i = texts.length - 1; i >= 0; i--) {
      const tx = texts[i];
      tx.life += dt;
      const t = tx.life / tx.max;
      if (t >= 1) {
        releaseText(tx);
        texts.splice(i, 1);
        textPool.push(tx);
        continue;
      }
      tx.y -= (tx.rise || 26) * dt;
      const a = (tx.alpha === undefined ? 1 : tx.alpha)
        * (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
      const sc = tx.scale * invZoom;
      for (let k = 0; k < tx.n; k++) {
        const g = tx.glyphs[k];
        g.setPosition(tx.x + g._dx * invZoom, tx.y);
        g.setAlpha(a);
        g.setScale(sc);
      }
    }

    // Footfall dust for moving units, rate-limited across the whole army — and
    // dropped entirely once the budget is full, since a fight at that density
    // is already standing in a cloud of its own.
    dustTimer -= dt;
    if (dustTimer <= 0 && !saturated()) {
      dustTimer = 0.09;
      const units = world.units;
      const view = opts.viewRect;
      let emitted = 0;
      for (let i = 0; i < units.length && emitted < 3; i++) {
        const u = units[(i + (world.tick || 0)) % units.length];
        if (!u || u.state !== 'move') continue;
        if (!lit(u.x, u.y)) continue;
        const px = (u.x - u.y) * HALF_W;
        const py = (u.x + u.y) * HALF_H;
        if (view && (px < view.x || px > view.r || py < view.y || py > view.b)) continue;
        if (Math.random() < 0.35) {
          dust(u.x, u.y, 1);
          emitted++;
        }
      }
    }

    const arrows = syncProjectiles();

    // Effect sprites are Game Objects like any other and belong in the frame's
    // object count; leaving them out would let the effect budget grow without
    // ever showing up in the number that guards it.
    let glyphs = 0;
    for (let i = 0; i < texts.length; i++) glyphs += texts[i].n;
    perfCount('objects', parts.length + glyphs + arrows);
  }

  function destroy() {
    for (const off of offs) off();
    offs.length = 0;
    for (const p of parts) p.spr.destroy();
    parts.length = 0;
    for (const s of spritePool) s.destroy();
    spritePool.length = 0;
    for (const t of texts) releaseText(t);
    texts.length = 0;
    textPool.length = 0;
    for (const s of glyphPool) s.destroy();
    glyphPool.length = 0;
    for (const s of projSprites) s.destroy();
    projSprites.length = 0;
  }

  return { update, destroy, floatText, commandPing, dust, sparks };
}
