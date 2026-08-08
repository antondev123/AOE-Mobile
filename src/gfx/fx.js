// Visual effects: floating text, sparks, gather chips, dust, command pings,
// death puffs and in-flight projectiles.
//
// Everything is pooled and updated from one flat particle array — no
// allocations per frame, no Phaser tweens (which allocate and churn).
// FX subscribe to the event bus, so they work regardless of which system
// emitted the event.

import { EV } from '../core/events.js';
import { HALF_W, HALF_H } from '../core/constants.js';
import { ATLAS, unitFrame } from './textures.js';

const RES_COLOR = { food: 0xe8524a, wood: 0xc98a45, gold: 0xf5c333 };
const CMD_COLOR = { move: 0x4ade80, attack: 0xf05252, gather: 0xfacc15, rally: 0x60a5fa };

const MAX_PARTICLES = 220;
const MAX_TEXTS = 18;

export function createFx(scene, world, opts) {
  const depthOf = opts.depthFor;
  const camera = opts.camera;
  const origins = opts.origins;

  // --- pools ---------------------------------------------------------------
  const parts = [];       // active particles
  const freeParts = [];   // recycled particle records
  const spritePool = [];  // idle Phaser images
  let spriteCount = 0;

  const texts = [];       // { obj, life, maxLife, vy, wx, wy }
  const textPool = [];

  const projSprites = [];

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

  function floatText(str, wx, wy, color, big) {
    if (texts.length >= MAX_TEXTS) return;
    let t = textPool.pop();
    if (!t) {
      const obj = scene.add.text(0, 0, '', {
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        fontSize: '15px',
        fontStyle: '700',
        color: '#ffffff',
        stroke: '#100c07',
        strokeThickness: 4,
      });
      obj.setOrigin(0.5, 1);
      t = { obj };
    }
    const o = t.obj;
    o.setVisible(true);
    o.setText(str);
    o.setFontSize(big ? 17 : 14);
    o.setColor(typeof color === 'string' ? color : `#${(color >>> 0).toString(16).padStart(6, '0')}`);
    o.setDepth(900000);
    o.setPosition(wx, wy);
    o.setAlpha(1);
    t.x = wx;
    t.y = wy;
    t.life = 0;
    t.max = 1.05;
    texts.push(t);
  }

  // --- world helpers -------------------------------------------------------

  function wx(gx, gy) { return (gx - gy) * HALF_W; }
  function wy(gx, gy) { return (gx + gy) * HALF_H; }

  /** Where a floating label should sit relative to an entity's ground point. */
  function entityAnchorY(e) {
    if (!e) return 0;
    if (e.kind === 'building') return -((e.fw || 2) >= 3 ? 120 : 80);
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

  function sparks(gx, gy, n, tint) {
    const x = wx(gx, gy);
    const y = wy(gx, gy) - 16;
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

  function dust(gx, gy, n, tint) {
    const x = wx(gx, gy);
    const y = wy(gx, gy);
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

  on(EV.DAMAGE, (p) => {
    const t = p && p.target;
    if (!t || t.dead) return;
    sparks(t.x, t.y, t.kind === 'building' ? 3 : 4, t.kind === 'building' ? 0xd8c9a0 : 0xffd27a);
    if (p.amount >= 1 && texts.length < MAX_TEXTS - 6) {
      floatText(`-${Math.round(p.amount)}`, wx(t.x, t.y), wy(t.x, t.y) + entityAnchorY(t), 0xff8f8f);
    }
  });

  on(EV.GATHER_TICK, (p) => {
    const n = p && p.node;
    const u = p && p.unit;
    if (!n) return;
    if (Math.random() < 0.55) {
      chips(n.x, n.y, u ? u.x : n.x, u ? u.y : n.y - 1, p.type);
    }
  });

  on(EV.DEPOSIT, (p) => {
    const b = p && p.building;
    if (!b) return;
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
    floatText(String(p.text), wx(p.gx, p.gy), wy(p.gx, p.gy) - 22, p.color || 0xffffff, true);
  });

  on(EV.COMMAND_FX, (p) => {
    if (!p) return;
    commandPing(p.gx, p.gy, p.kind);
  });

  on(EV.BUILT, (p) => {
    if (p && p.building) builtPulse(p.building);
  });

  on(EV.PROJECTILE, (p) => {
    const f = p && p.from;
    if (!f) return;
    sparks(f.x, f.y, 1, 0xfff0c0);
  });

  on(EV.DEATH, (p) => {
    const e = p && p.entity;
    if (!e) return;
    const x = wx(e.x, e.y);
    const y = wy(e.x, e.y);
    if (e.kind === 'unit') {
      // A corpse that tips over and fades — the player sees who died and where.
      spawn(unitFrame(e.type, e.player, false), x, y, {
        life: 1.1,
        vy: -4,
        s0: 1, s1: 0.92,
        a0: 0.95, a1: 0,
        rot: 0,
        vr: 70,
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
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      let s = projSprites[i];
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
    }
    for (let i = list.length; i < projSprites.length; i++) {
      if (projSprites[i].visible) projSprites[i].setVisible(false);
    }
  }

  // --- per-frame -----------------------------------------------------------

  let dustTimer = 0;

  function update(dt) {
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
      s.setPosition(p.x, p.y);
      s.setScale(p.s0 + (p.s1 - p.s0) * t);
      s.setAlpha(p.a0 + (p.a1 - p.a0) * t);
      if (p.vr) s.setAngle(p.rot);
    }

    for (let i = texts.length - 1; i >= 0; i--) {
      const tx = texts[i];
      tx.life += dt;
      const t = tx.life / tx.max;
      if (t >= 1) {
        tx.obj.setVisible(false);
        texts.splice(i, 1);
        textPool.push(tx);
        continue;
      }
      tx.y -= 26 * dt;
      tx.obj.setPosition(tx.x, tx.y);
      tx.obj.setAlpha(t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
      // Keep world-space text a constant size on screen at any zoom.
      tx.obj.setScale(1 / camera.zoom);
    }

    // Footfall dust for moving units, rate-limited across the whole army.
    dustTimer -= dt;
    if (dustTimer <= 0) {
      dustTimer = 0.09;
      const units = world.units;
      const view = opts.viewRect;
      let emitted = 0;
      for (let i = 0; i < units.length && emitted < 3; i++) {
        const u = units[(i + (world.tick || 0)) % units.length];
        if (!u || u.state !== 'move') continue;
        const px = (u.x - u.y) * HALF_W;
        const py = (u.x + u.y) * HALF_H;
        if (view && (px < view.x || px > view.r || py < view.y || py > view.b)) continue;
        if (Math.random() < 0.35) {
          dust(u.x, u.y, 1);
          emitted++;
        }
      }
    }

    syncProjectiles();
  }

  function destroy() {
    for (const off of offs) off();
    offs.length = 0;
    for (const p of parts) p.spr.destroy();
    parts.length = 0;
    for (const s of spritePool) s.destroy();
    spritePool.length = 0;
    for (const t of texts) t.obj.destroy();
    texts.length = 0;
    for (const t of textPool) t.obj.destroy();
    textPool.length = 0;
    for (const s of projSprites) s.destroy();
    projSprites.length = 0;
  }

  return { update, destroy, floatText, commandPing, dust, sparks };
}
