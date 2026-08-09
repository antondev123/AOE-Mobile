// Little pictures of things, cut out of the sprite atlas.
//
// The HUD used to name everything on it with a three-letter code — VIL, MIL,
// SPR, CAV, RAM, MLL, MIN, BSH — while twelve pixels above it the map drew the
// actual, genuinely distinct sprites those codes stood for. That is the single
// loudest "this is a prototype" signal the game had: a mixed army rendered as
// `MIL x3 SPR x3 ARC x2 CAV x2 RAM x2`, three of the codes near-collided (MIL
// militia, MLL mill, MIN mining camp) and one of them, CAV, did not even match
// the label under it ("Scout Cavalry"). src/gfx/textures.js is four thousand
// lines of drawn art and the HUD used none of it.
//
// So: one small canvas per type, cut out of the atlas the renderer is already
// using, cached. There are about thirteen of them in the whole game — six unit
// types, six or seven buildings and four resource nodes — so the cache is
// bounded by the roster and is built lazily, one entry the first time a chip of
// that type is drawn.
//
// WHY A CANVAS AND NOT A CSS SPRITE
// ---------------------------------
// A background-position crop out of the atlas would need no JavaScript at all,
// and it cannot work here: the atlas is a *canvas texture* built at runtime by
// Phaser, it has no URL, and its frame rectangles are decided by a shelf packer
// at boot. Turning it into a data URL would mean a 2048x2048 PNG encode — about
// 16MB of pixels — during scene create, on a phone, to draw thirteen 32px
// pictures. A drawImage per type into a 36px canvas is a rounding error by
// comparison, and each one is done once.
//
// Nothing here throws or logs when a frame is missing. The caller keeps its
// text fallback for exactly that case: a roster entry that has no art yet
// should show its name, not a blank hole or a console error.

import { ATLAS, unitFrame, buildingFrame, wallFrame, farmFrame, resourceFrame } from '../gfx/textures.js';
import { PLAYER } from '../core/constants.js';
import { isWallType } from '../core/constants.js';

// Rendered size of a portrait, in CSS pixels before the device ratio.
//
// The chips it drops into are 44x46 with a count and a badge to fit around it,
// which leaves about 24px of height for the picture. It is drawn at 32 and
// displayed at 24 so it stays crisp on a DPR-2 phone without asking the atlas
// for a second, larger set of frames.
export const PORTRAIT_PX = 32;

// A building is drawn at its full footprint width — a Town Center is 96px of
// atlas — so fitting one into the same box as a villager would leave the
// villager a quarter of the height and the Town Center touching all four
// edges. Each family gets its own fill factor instead, so a chip of any type
// reads at about the same visual weight.
const FILL = { unit: 0.94, building: 0.86, resource: 0.9 };

/**
 * Build a portrait cache against a live scene.
 *
 * `scene` is only ever used to reach the atlas texture; nothing here draws into
 * the game, and the whole module falls away to nulls when the atlas is absent
 * (a stripped-down harness scene, a boot that failed before textures).
 */
export function createPortraits(scene) {
  const cache = new Map();
  let atlas = null;
  try {
    atlas = scene && scene.textures && scene.textures.exists(ATLAS)
      ? scene.textures.get(ATLAS) : null;
  } catch (_) {
    atlas = null;
  }

  /** The atlas frame name for one kind of thing, or null if it has none. */
  function frameNameFor(kind, type, player) {
    const p = player === undefined || player === null ? PLAYER : player;
    if (kind === 'unit') return unitFrame(type, p, false, 'i');
    if (kind === 'resource') return resourceFrame(type, 0);
    if (kind === 'building') {
      // Two building families do not follow the plain b_<type>_<player> name:
      // walls are keyed by their neighbour mask, and a farm's stage 0 is the
      // generic name. Ask for the shapes that read best at 24px — a wall
      // segment running east-west, and a freshly sown field.
      if (isWallType(type)) return wallFrame(type, p, 0b1010);
      if (type === 'farm') return farmFrame(p, 0);
      return buildingFrame(type, p);
    }
    return null;
  }

  /**
   * A canvas holding the picture of one type, or null when there is no art for
   * it. Cached by kind+type+player: the same militia portrait is reused by the
   * selection chip, the training queue slot and anything else that asks.
   */
  function portrait(kind, type, player) {
    const p = player === undefined || player === null ? PLAYER : player;
    const key = `${kind}:${type}:${p}`;
    if (cache.has(key)) return cache.get(key);
    let out = null;
    try {
      out = cut(frameNameFor(kind, type, p), FILL[kind] || 0.9);
    } catch (_) {
      out = null;
    }
    cache.set(key, out);
    return out;
  }

  /** Copy one atlas frame into its own canvas, scaled to fit PORTRAIT_PX. */
  function cut(name, fill) {
    if (!atlas || !name) return null;
    const frame = atlas.frames && atlas.frames[name];
    if (!frame) return null;
    const src = frame.source && frame.source.image;
    if (!src) return null;
    const sw = frame.cutWidth;
    const sh = frame.cutHeight;
    if (!(sw > 0) || !(sh > 0)) return null;

    const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
    const size = Math.round(PORTRAIT_PX * dpr);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Fit inside the box, keeping the sprite's proportions. Buildings are wider
    // than they are tall in this projection and units are the other way round,
    // so this is a genuine two-axis fit rather than a scale on one of them.
    const k = (size * fill) / Math.max(sw, sh);
    const dw = sw * k;
    const dh = sh * k;
    // Anchored to the bottom of the box, not the middle. Everything in this
    // atlas is drawn standing on the ground, and a row of chips whose subjects
    // share a floor reads as a row of things; centred, a tall Town Center and a
    // short berry bush float at unrelated heights.
    const dx = (size - dw) / 2;
    const dy = size - dh - size * 0.04;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, frame.cutX, frame.cutY, sw, sh, dx, dy, dw, dh);
    return canvas;
  }

  /**
   * An <i> holding the portrait for an entity type, or null.
   *
   * Returning the element rather than a URL keeps the canvas itself in the
   * cache — the same canvas node cannot be in two places at once, so what goes
   * into the DOM is a fresh <i> with the cached canvas *copied* into a CSS
   * background via toDataURL, computed once per type on first use.
   */
  function element(kind, type, player) {
    const url = dataUrl(kind, type, player);
    if (!url) return null;
    const i = document.createElement('i');
    i.className = 'portrait';
    i.style.backgroundImage = `url(${url})`;
    return i;
  }

  const urls = new Map();
  function dataUrl(kind, type, player) {
    const p = player === undefined || player === null ? PLAYER : player;
    const key = `${kind}:${type}:${p}`;
    if (urls.has(key)) return urls.get(key);
    const c = portrait(kind, type, p);
    let url = null;
    try {
      // 32x32 (64x64 at DPR 2) of PNG is around 1-2kB. Thirteen of them is
      // less than a single one of the game's own toasts costs in DOM.
      url = c ? c.toDataURL('image/png') : null;
    } catch (_) {
      url = null;
    }
    urls.set(key, url);
    return url;
  }

  function destroy() {
    cache.clear();
    urls.clear();
  }

  return { portrait, element, dataUrl, destroy, available: () => !!atlas };
}
