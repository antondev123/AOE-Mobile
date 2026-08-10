// Procedural texture generation.
//
// There are no art assets: every pixel is drawn at runtime with a Phaser
// Graphics object, baked to a canvas, and packed into ONE atlas texture. The
// single atlas matters a lot for performance — hundreds of sprites drawn from
// the same texture batch into a handful of draw calls, whereas hundreds of
// standalone textures would break the batch on every sprite.
//
// Everything here runs once, during scene create.

import { makeRng } from '../core/rng.js';
import {
  TILE_W, TILE_H, HALF_W, HALF_H, PLAYER_COLORS, PLAYER_COLORS_DARK,
  BUILDING_STATS,
} from '../core/constants.js';

export const ATLAS = 'aoe-gfx';

// Terrain diamonds are baked 1px larger than a tile and blitted 1px up-left, so
// neighbouring tiles overlap and antialiased seams never show through.
export const TILE_TEX_W = TILE_W + 2;
export const TILE_TEX_H = TILE_H + 2;
export const TILE_TEX_OFF_X = -1;
export const TILE_TEX_OFF_Y = -1;

const OUT = 0x161009; // universal dark outline — what makes shapes read at 390px

// ---------------------------------------------------------------------------
// THE LIGHT
// ---------------------------------------------------------------------------
//
// There was no light model in this file at all, and that flatness — one black
// outline of one weight around everything, no gradients, no ambient occlusion,
// no bounce — is the second-loudest "programmer art" tell after the tile grid.
// Phaser's Graphics has no gradient fill, so a gradient here has to be built out
// of stacked bands or stacked translucent shapes; that is what the helpers below
// do, and it is why they exist rather than every call site rolling its own.
//
// ONE DIRECTION, AND WHICH ONE. The file used to claim upper-left in one comment
// and upper-right in another, and the drawings split the difference: every piece
// of *architecture* (isoBox, isoRoof, isoCylinder, prism — which is to say every
// building, every wall and every gate) lights the right-hand face and shades the
// left, while the *resources* (tree, gold, the rock decal) put their highlight
// up and to the left. Architecture is far more surface area and far more code,
// so the resources move: the sun in this world is up and to the RIGHT, roughly
// 40 degrees above the horizon, and every solid in this file now says so.
//
// The three terms that come out of that, in the order they matter:
//
//   KEY      the lit plane. Faces whose normal points up-right take `shade(c,
//            +KEY_LIFT)`, faces pointing down-left take `shade(c, -SHADE_DROP)`,
//            and a face pointing at the camera sits between them. Three values
//            on every prism, never two: two values on a curve reads as a folded
//            box, and two on a box reads as a sticker.
//   RIM      a warm bounce along the lit silhouette edge. Real skies are not the
//            only light source — the ground throws warm light back up — and one
//            pixel of warm on the sunward edge of a helmet does more to unflatten
//            a 40px figure than any amount of interior shading.
//   CONTACT  a soft dark ellipse where the object meets the ground, offset a
//            little down-LEFT (away from the sun). Without it every sprite in
//            the game is a sticker floating a millimetre above the map. It has
//            to be soft — a hard ellipse is a second sticker.
//
// The unit sprites are mirrored by the renderer for four of the eight facings
// (see FACE_FLIP in render.js), so a rim light baked on a unit's left edge shows
// up on its right for half the compass. That is a real inaccuracy and it is the
// right trade: the alternative is eight drawn facings, which quadruples the unit
// half of the atlas to fix something invisible on a body 40 screen pixels tall.
// Buildings, walls, terrain and resources are never mirrored, so for everything
// that holds still the light is exactly consistent.
const KEY_LIFT = 0.16;   // how much a sunward face is lifted
const SHADE_DROP = 0.2;  // how much a shaded face is dropped
const RIM = 0xffe6b4;    // warm bounce; always drawn at low alpha, never solid
const SKY = 0xbcd4ee;    // cool sky fill, for the top planes of cold materials

const SKIN = 0xf0c69c;
const STEEL = 0xc3ccd6;
const STEEL_D = 0x7e8894;
const WOOD = 0x9a6b38;
const WOOD_D = 0x6a4522;
const PLASTER = 0xe6d8b8;
const PLASTER_D = 0xbfae8b;

// ---------------------------------------------------------------------------
// THE COLOUR BUDGET
// ---------------------------------------------------------------------------
//
// A whole-game review failed this art on one sentence: "team colour has eaten
// the units". Six of the ten combat types were blue lumps at the zoom the game
// is actually played at, and the proof was sitting in the same frame — the monk
// was the only unit anybody could name at a glance, precisely because it is the
// only one that was allowed to keep its own colour. The moment a unit is made
// of something, it becomes readable.
//
// So there is a budget now, and it is enforced rather than intended:
// tests/art.browser.mjs bakes each unit for both players, XORs the two frames,
// and fails the run if the pixels that changed are more than a quarter of the
// body. That measurement is exact — team colour is *by definition* the set of
// pixels that move when the player changes — and it needs no threshold on
// "blueness" to tune. The old roster measured 26-31% on four of the ten and 1-2%
// on all three siege engines, which is both halves of the same mistake: the
// infantry were painted, and you could not tell whose mangonel was about to hit
// your Town Center.
//
// WHERE THE COLOUR IS ALLOWED TO GO. Four places, and no others:
//
//   PLUME / CREST   on the helmet. High, small, and above the press of bodies
//                   in a melee, which is the one part of a soldier that is
//                   never occluded by the soldier in front.
//   SHIELD FACE     but only a division of it — a half, a chevron, a border.
//                   A shield painted edge to edge in one flat colour is the
//                   single largest saturated field a 40px figure can carry, and
//                   it is what turned the skirmisher into "a blue circle".
//   PENNON / BANNER on a shaft: the spearman's pennon under the head, the
//                   engines' masthead flag, the knight's lance bands.
//   A BAND          one strip of surcoat, one painted panel, one saddle cloth.
//                   Strips read as livery. Fields read as paint.
//
// EVERYTHING ELSE IS A MATERIAL. These are the materials, and each one is
// carrying an identity as well as a colour: the militia is the one in mail, the
// spearman is the one in quilted linen, the skirmisher is the one in leather,
// the archer is the one in forest cloth. Four bodies that used to be the same
// rounded rectangle in the same blue are now four different substances, and
// substance survives being shrunk far better than a decal does.
const MAIL = 0x9aa1ac;      // riveted mail: cooler and flatter than plate
const MAIL_D = 0x676e79;
const GAMBESON = 0xcbb289;  // quilted linen, undyed — the spearman's armour
const GAMBESON_D = 0x9a8259;
const LEATHER = 0x8a6236;   // the skirmisher's jerkin and every strap in the game
const LEATHER_D = 0x5d4123;
const FOREST = 0x5f6b40;    // the archer's cloth: a colour that hides in a wood
const FOREST_D = 0x414a2b;
const HORSE_BAY = 0x7c5233; // the scout's pony
const HORSE_BAY_D = 0x593a24;
const HORSE_GREY = 0x8f8880; // the knight's destrier — a warm grey, not steel
const HORSE_GREY_D = 0x635c54;

/**
 * A shield, divided per bend — the team colour on one diagonal half of the
 * face, the shield's own material on the other.
 *
 * The shield is the one shape a foot soldier carries that is big enough to hold
 * ownership across a battlefield, and therefore the one most likely to eat the
 * unit: painted edge to edge it is the largest saturated field a 40-pixel figure
 * can have, and that is exactly what turned the skirmisher into "a blue circle".
 * Halving it keeps all of the loudness and costs half the paint.
 *
 * A DIAGONAL division rather than a vertical one, for two reasons. Vertically
 * split, a round shield reads as a circle with a bite out of it and the eye
 * reassembles it into "a blue disc" anyway; split corner to corner it reads as a
 * *device*, which is what a shield actually carries. And the renderer mirrors
 * these sprites for four of the eight facings, so a vertical split would flip
 * sides half the time and look like two different shields — a diagonal one
 * mirrors into the other diagonal, which reads as the same heraldry seen from
 * the other side.
 *
 * `pts` is the outline of the face in drawing order. Everything here works off
 * that polygon, so the same function serves the militia's round disc, the
 * skirmisher's tall oval and the knight's heater.
 */
function shieldFace(g, pts, cx, cy, col, own) {
  g.fillStyle(own, 1);
  g.fillPoints(pts, true, true);
  // The half above the corner-to-corner diagonal. Clipping is done by hand
  // because Phaser's Graphics has no clip: each outline vertex is kept if it is
  // on the team side of the line, and the two crossings are interpolated, which
  // is a polygon-halving in eight lines and exact.
  const side = (p) => (p.x - cx) * 0.55 + (p.y - cy) * 1;
  const half = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) half.push(a);
    if ((sa <= 0) !== (sb <= 0)) {
      const t = sa / (sa - sb);
      half.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  if (half.length > 2) {
    g.fillStyle(col, 1);
    g.fillPoints(half, true, true);
  }
}

/** The outline of an ellipse, as the polygon shieldFace wants. */
function ellipsePts(cx, cy, rx, ry, n = 20) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n;
    out.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return out;
}

// --- small colour helpers ---------------------------------------------------

export function shade(c, f) {
  let r = (c >> 16) & 255;
  let g = (c >> 8) & 255;
  let b = c & 255;
  if (f >= 0) {
    r += (255 - r) * f;
    g += (255 - g) * f;
    b += (255 - b) * f;
  } else {
    const k = 1 + f;
    r *= k;
    g *= k;
    b *= k;
  }
  return (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b);
}

function clamp255(v) {
  v = Math.round(v);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Mix two packed colours, `t` of the way from a to b.
 *
 * `shade` can only move a colour towards white or towards black, which is fine
 * for a lit face of the same material and wrong for anything where the light
 * itself is coloured — warm sun on cool stone, cool sky on warm timber. Those
 * need a real mix, and having one here keeps the hue shifts consistent instead
 * of every draw function inventing its own near-white.
 */
function mix(a, b, t) {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  return (clamp255(ar + (((b >> 16) & 255) - ar) * t) << 16)
    | (clamp255(ag + (((b >> 8) & 255) - ag) * t) << 8)
    | clamp255(ab + ((b & 255) - ab) * t);
}

/** The sunward face of a solid, and the face turned away from the sun. */
function lit(c) {
  return mix(shade(c, KEY_LIFT), RIM, 0.1);
}
function dim(c) {
  // Shadowed faces cool as well as darken: skylight is blue, and a shadow that
  // is only "the same colour but darker" is the flattest thing a palette can do.
  return mix(shade(c, -SHADE_DROP), 0x3a4a66, 0.12);
}

/**
 * A soft contact shadow on the ground under something, offset away from the
 * sun (down and a little left).
 *
 * Four stacked ellipses rather than one: Graphics cannot feather an edge, so
 * the falloff has to be built out of rings, and four is where a 30px shadow
 * stops showing its steps. `strength` scales the whole thing — a villager casts
 * less than a Town Center.
 */
function contactShadow(g, x, y, w, h, strength = 1) {
  const cx = x - w * 0.06;
  for (let i = 4; i >= 1; i--) {
    const t = i / 4;
    g.fillStyle(0x0a0d14, 0.075 * strength);
    g.fillEllipse(cx, y + h * 0.1, w * (0.55 + t * 0.55), h * (0.55 + t * 0.55));
  }
}

/**
 * A warm bounce along one edge, drawn as a translucent stroke just inside the
 * silhouette. Call it *after* the dark outline, so the rim sits between the
 * outline and the fill the way a real highlight does.
 */
function rimLine(g, ax, ay, bx, by, w = 1.6, a = 0.5) {
  g.lineStyle(w, RIM, a);
  g.beginPath();
  g.moveTo(ax, ay);
  g.lineTo(bx, by);
  g.strokePath();
}

/**
 * The outline weight for an edge, by which way it faces.
 *
 * A uniform black keyline of one weight around every shape is the classic
 * flat-vector look, and it is most of why this game's sprites read as decals.
 * Real ink varies: heavy where the form turns away from the light, light or
 * absent where it turns into it. `outline(g, sunward)` picks the pair.
 */
function outline(g, sunward, w = 2.2) {
  if (sunward) g.lineStyle(w * 0.7, mix(OUT, 0x6a5a3c, 0.35), 0.85);
  else g.lineStyle(w, OUT, 1);
}

// --- frame-name helpers (the renderer calls these) --------------------------

export function terrainFrame(terrainId, variant) {
  return `t${terrainId}_${variant}`;
}
/**
 * One frame of a unit's animation. `back` picks the front or back drawing (the
 * renderer mirrors those two into eight facings) and `pose` is an id from the
 * POSE table further down — 'i' idle, 'w0'..'w2' the walk, 'g'/'b' work, 'a'
 * the swing, 'd' the death. Defaulting to the idle pose keeps every existing
 * caller that only wants "a picture of a militia" working unchanged.
 */
export function unitFrame(type, player, back, pose = 'i') {
  return `u_${type}_${player}_${back ? 'b' : 'f'}_${pose}`;
}
/**
 * A building's sprite, optionally one of several drawings of the same building.
 *
 * THE PROBLEM THIS SOLVES is the one the review put hardest: "eight
 * pixel-identical red-roofed houses in one frame — same roof, same wall, same
 * flag in the same corner. This is the frame a player stares at for twenty
 * minutes." A base is mostly housing, so the house sprite is not one sprite
 * among forty; it is the *texture of the screen*, and one drawing repeated eight
 * times reads as wallpaper rather than as a town.
 *
 * `variant` is an optional trailing argument and defaults to 0, which returns
 * exactly the frame name this function has always returned and exactly the
 * drawing it has always named — so every existing call site keeps working
 * untouched, and the extra drawings only appear once the renderer starts
 * passing something. What it should pass is a STABLE PER-ENTITY value, not a
 * random one: a house that redraws itself as a different house when it leaves
 * and re-enters the camera is worse than eight identical houses. The building's
 * id is exactly such a value and it survives a save (`b.id % 4`).
 *
 * Types with no variants ignore the argument entirely, so the renderer can pass
 * a hash unconditionally for every building without a table of its own.
 */
export function buildingFrame(type, player, variant = 0) {
  const n = BUILDING_VARIANTS[type] || 1;
  const v = n > 1 ? ((variant % n) + n) % n : 0;
  return v ? `b_${type}_${player}_v${v}` : `b_${type}_${player}`;
}
/**
 * How many drawings exist of each building. Anything absent has exactly one.
 *
 * Only the house is here, and that is a budget decision rather than a
 * preference. A house is a 136x100 frame and there are two players, so each
 * extra house drawing costs 27k atlas pixels; the atlas is a 2048 sheet with
 * about 300k pixels of headroom, and three extra houses spend a quarter of what
 * is left. There is exactly one building the player sees eight of at once, and
 * this is the one — the Town Center, the Mill and the military halls are
 * singletons or near enough, and a second drawing of a building you own one of
 * buys nothing at all.
 */
export const BUILDING_VARIANTS = { house: 4 };
/**
 * A wall segment, keyed by the four-bit neighbour mask from core/world.js
 * (1 = north, 2 = east, 4 = south, 8 = west). Sixteen frames per wall type per
 * player: a lone post, two straight runs, four corners, four tees, one cross,
 * and the four stubs that have exactly one neighbour.
 *
 * Every case is drawn rather than derived, because a wall's whole job is to look
 * like one continuous structure. Rotating a single sprite cannot do it — in this
 * projection the two grid axes run in different screen directions and are lit
 * differently, so an east-west run and a north-south run are not the same
 * picture turned round.
 */
export function wallFrame(type, player, mask) {
  return `w_${type}_${player}_${mask & 15}`;
}
/** A gate, by the axis it stands across (0 = along +x, 1 = along +y) and state. */
export function gateFrame(type, player, axis, open) {
  return `g_${type}_${player}_${axis ? 'y' : 'x'}${open ? 'o' : 'c'}`;
}
/** Farms have three harvest stages; stage 0 shares the generic building name. */
export function farmFrame(player, stage) {
  return stage ? `b_farm${stage}_${player}` : `b_farm_${player}`;
}
export function foundationFrame(fw, player) {
  return `fd_${fw}_${player}`;
}
export function farmFoundationFrame(player) {
  return `fd_farm_${player}`;
}
/**
 * The timber cage that stands around a building site, by footprint width. Not
 * team coloured: scaffolding is scaffolding, the foundation under it already
 * carries the pennants, and one set of four frames serves both players.
 */
export function scaffoldFrame(fw) {
  return `sc_${fw}`;
}
/**
 * A cliff tile, keyed by which of its four neighbours are also cliff
 * (1 = +x, 2 = +y, 4 = -x, 8 = -y).
 *
 * Two faces of the block can be seen by this camera — the +x and +y ones — and
 * they are only drawn where that neighbour is open ground. The other two bits
 * matter just as much though, and for a subtler reason: they decide whether the
 * *top* edge is outlined. Outline every tile's whole top diamond and a cliff
 * range is a row of paving slabs with the grid drawn on it, which is precisely
 * how this feature fails. Outline only the edges that face open air and the
 * same tiles weld into one plateau with a rocky rim.
 */
export function cliffFrame(variant, mask) {
  return `cf_${variant}_${mask & 15}`;
}
/** Scattered ground decal, baked into the terrain. See DETAIL_VARIANTS. */
export function detailFrame(i) {
  return `dt_${i}`;
}
export function resourceFrame(type, variant) {
  return `r_${type}_${variant}`;
}
export function markerFrame(player) {
  return `mk_team_${player}`;
}
/** Out-of-bounds sea, 0 = shore shallows .. OCEAN_LEVELS-1 = open deep. */
export function oceanFrame(level) {
  return `oc_${level}`;
}
/**
 * One tongue of a higher-priority terrain reaching across an edge, drawn white
 * so the bake can tint it with whatever ground is bleeding over. Edge order
 * matches the diamond's corners: 0 = top-right (neighbour -y), 1 = bottom-right
 * (+x), 2 = bottom-left (+y), 3 = top-left (-x).
 *
 * `variant` is new and defaults to 0, so the existing single-argument call in
 * render.js keeps working unchanged — but a boundary that runs for twenty tiles
 * with the same tongue stamped on every one of them is a boundary with a
 * pattern in it, and a pattern is exactly what a transition exists to destroy.
 * Pass a per-tile hash (mod EDGE_BLEND_VARIANTS) and the same twenty tiles stop
 * rhyming. See the note above buildEdgeBlends.
 */
export function edgeBlendFrame(edge, variant = 0) {
  return `eb_${edge}_${variant % EDGE_BLEND_VARIANTS}`;
}
export const EDGE_BLEND_VARIANTS = 4;
/**
 * Surf line laid along one edge of a coastal land tile. Same variant story as
 * edgeBlendFrame: one drawn wave repeated down a shoreline reads as corrugated
 * iron, four do not.
 */
export function shoreFrame(edge, variant = 0) {
  return `sh_${edge}_${variant % SHORE_VARIANTS}`;
}
export const SHORE_VARIANTS = 4;
/**
 * One frame of the water's surface animation: caustics and glints, drawn white
 * over transparency so the renderer can lay it over a water tile, tint it and
 * cycle it. The water tiles themselves are baked into the static terrain
 * RenderTexture and cannot move; this is the layer that can.
 */
export function waterFrame(i) {
  return `wa_${i % WATER_ANIM_FRAMES}`;
}
export const WATER_ANIM_FRAMES = 4;
/**
 * One frame of a chimney plume: smoke rising, spreading and thinning, drawn on
 * transparency so the renderer can stack it over a building that never moves.
 *
 * WHY THIS IS AN OVERLAY AND NOT A SECOND BUILDING FRAME. "Nothing on the map
 * moves" was a review finding, and the honest fix for a windmill is four bakes
 * of the whole windmill; for a chimney it is not, because smoke is ADDITIVE.
 * The Blacksmith's own frame keeps the first two puffs leaving the flue, and
 * this plume continues upward from where those stop — so the building looks
 * exactly as it does today with the overlay switched off, and looks alive with
 * it switched on. That property is what makes it affordable: four frames of
 * 52x64 is 13k of atlas against the 44k a sail-less second Mill body would
 * cost, and it needs no fallback path in the renderer at all.
 *
 * HOW TO DRIVE IT. One sprite per smoking building, positioned at the entity's
 * world position plus the offset in CHIMNEY for its type, depth just above the
 * building, frame `smokeFrame((t * SMOKE_FPS) | 0)`. The four frames are one
 * full cycle of the plume — puff five is puff one reborn at the flue — so it
 * loops seamlessly at any speed. SMOKE_FPS is deliberately slow: smoke that
 * cycles faster than about five frames a second stops reading as drift and
 * starts reading as a flicker, which is worse than a static plume.
 */
export function smokeFrame(i) {
  return `fx_smoke_${((i % SMOKE_FRAMES) + SMOKE_FRAMES) % SMOKE_FRAMES}`;
}
export const SMOKE_FRAMES = 4;
export const SMOKE_FPS = 4.5;
/**
 * Where a plume leaves each building, in pixels from the entity's own world
 * position — which is the point the renderer already puts the sprite on, so
 * these are the numbers to add and nothing has to be derived from the frame
 * box. `scale` is what the plume should be drawn at: a forge flue throws a
 * column, a cottage hearth throws a wisp, and one frame set at two scales is
 * cheaper and more consistent than two frame sets.
 *
 * Only the Blacksmith is worth turning on by itself; the houses are listed
 * because a base with two or three of them smoking gently is the difference
 * between a settlement and a diorama, and they cost nothing extra to add.
 */
export const CHIMNEY = {
  blacksmith: { dx: 4, dy: -134, scale: 1 },
  house: { dx: 11, dy: -62, scale: 0.5 },      // variant 0
  house_v2: { dx: -20, dy: -68, scale: 0.45 }, // the two-storey town house
};
/** Big soft ellipse used to break up large flat regions at bake time. */
export const BLOB_FRAME = 'tr_blob';

// Grass, dirt, water, sand. Grass and dirt carry the map, so they get the most
// variants: on a 96x96 map a four-variant grass repeats every couple of screens
// and the eye finds the repeat long before it finds anything else.
//
// Grass went 7 -> 11 and dirt 6 -> 9 in the presentation pass, and sand 4 -> 6.
// A terrain frame is 66x34 — 2244 pixels, about a twentieth of one 3x3 building
// — so tile variety is the cheapest art in this file by a wide margin, and it
// covers more of the screen than everything else put together. What the extra
// variants buy is not more *detail*; it is more low-frequency variation: each
// one carries a soft swell of light in a different direction (see `swell`
// below), so a sheet of grass reads as ground that undulates rather than as one
// flat sheet with blades stamped on it.
export const TERRAIN_VARIANTS = [11, 9, 4, 6];
/**
 * How many drawings there are of each resource node.
 *
 * TREES WENT 3 -> 6, and of everything in this file that is the change with the
 * largest number of instances behind it: a map carries a couple of thousand
 * trees, they cover more of the screen than every building put together, and
 * the review's line was "roughly forty trees and about two silhouettes — same
 * broccoli canopy, same trunk, same hue, same black outline". Three variants
 * that differed only by a scale factor and a lean were, correctly, two
 * silhouettes.
 *
 * The six are now six *species* rather than six jitters: a round oak, a
 * conifer, a birch, a low spreading oak, a dead snag and a poplar. Each has its
 * own frame box, its own trunk, its own green and — the part that actually does
 * the work — its own outline. A tree costs about 3.5k atlas pixels, a
 * fortieth of one house, so this is the cheapest variety in the file by a long
 * way and there was no reason to have been buying so little of it.
 *
 * THE ORDER IS LOAD-BEARING. core/world.js currently rolls `variant` as
 * `floor(rng() * 3)` — a hardcoded 3 — and render.js takes it modulo this
 * count, so until that is widened only slots 0, 1 and 2 are ever placed on a
 * map. The three most different silhouettes are therefore in those slots (round
 * / conifer / birch), so the map gets most of the benefit with no change
 * outside this file at all, and slots 3-5 come alive the moment the roll does.
 */
export const RESOURCE_VARIANTS = { tree: 6, berry: 2, gold: 3, stone: 3 };

/**
 * Scattered ground decals. These are *not* per-tile texture: they are placed
 * every few tiles by the terrain bake, so what they add is incident — a rock
 * here, a flower patch there — rather than another layer of noise on every
 * diamond, which is the failure mode that makes procedural ground look like
 * static. Index order is meaningful; see DETAIL_FOR_TERRAIN in render.js.
 */
export const DETAIL_VARIANTS = 7;
// Every decal is drawn in the same box with the same anchor, so the terrain
// bake can place one from a tile centre without consulting the origins map.
export const DETAIL_BOX = { w: 34, h: 24, ax: 17, ay: 18 };

/** How tall a cliff stands above the ground it interrupts, in screen pixels. */
export const CLIFF_H = 30;
export const CLIFF_VARIANTS = 3;

// --- The number font ---------------------------------------------------------
//
// Every floating label the game draws is a number with a sign on it: `-12` off a
// blow that landed, `+15` off a load coming home. They used to be Phaser Text
// objects, and each one of those carries its own canvas-backed texture — so a
// melee with a dozen numbers over it cost a dozen extra texture binds, which is
// a dozen extra draw calls, and a fresh canvas rasterisation and GPU upload
// every time a number was born. Measured on the stress scenario that was the
// difference between 18 and 37 draw calls a frame, for eighteen sprites' worth
// of information.
//
// Baking the twelve glyphs into the atlas puts them in the same batch as every
// other quad in the game: a four-digit number is four more quads on a batch that
// is already several hundred, and the draw call count does not move at all.
//
// They are baked at GLYPH_PX and drawn smaller — the labels want 12 to 17 screen
// pixels — so what the GPU samples is a supersampled glyph rather than a
// magnified one. Baked white over a dark outline, so the renderer can tint the
// number itself (red for your losses, warm white for theirs) and have the
// outline stay dark.
export const GLYPHS = '0123456789+-';
export const GLYPH_PX = 28;
/** Frame name for one glyph. '+' and '-' cannot go in a frame key verbatim. */
export function glyphFrame(ch) {
  return ch === '+' ? 'gl_plus' : ch === '-' ? 'gl_minus' : `gl_${ch}`;
}
/**
 * Advance width of each glyph in baked pixels, and the common baseline offset.
 * Filled in by buildTextures, because only the browser knows what the system
 * font actually measures.
 */
export const GLYPH_METRICS = { advance: new Map(), height: 0, baseline: 0 };

// How many tiles of sea are actually tiled around the island before the flat
// deep-water fill takes over. The last ramp colour equals the fill, so the
// changeover is invisible.
export const TERRAIN_BORDER = 8;
export const OCEAN_LEVELS = 6;
// Everything outside the tiled border is painted this colour in one op.
export const OCEAN_DEEP = 0x0d2740;

/**
 * Build every texture and pack it into a single atlas.
 * Returns { atlas, origins: Map<frame, {w,h,ox,oy}> }.
 */
export function buildTextures(scene) {
  // 2048, up from 1024. The walls are what pushed it over: sixteen connected
  // variants per wall type per player is sixty-four extra frames, and with the
  // Castle's 4x4 body and the gates the atlas needs about 1.4M pixels of the
  // 4.2M a 2048 sheet holds — against the 1.05M a 1024 sheet has in total.
  // Splitting into two atlases was the alternative and it is the worse one: a
  // second texture breaks the sprite batch every time the renderer alternates
  // between a wall and anything else, which on a walled base is every few
  // sprites. 16MB of texture memory buys back the single draw call.
  const SIZE = 2048;
  if (scene.textures.exists(ATLAS)) scene.textures.remove(ATLAS);
  const canvasTex = scene.textures.createCanvas(ATLAS, SIZE, SIZE);
  const ctx = canvasTex.getContext();
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const rng = makeRng(0x5eed11);

  const origins = new Map();
  // The next unused scanline. Shelves are opened downwards from here; see the
  // packing loop below.
  const shelf = { y: 1 };
  const TMP = '__aoe_gfx_tmp';

  /**
   * Queue one sprite for packing. (ax, ay) is the pixel inside the sprite that
   * should sit on the entity's world position — stored as an origin fraction.
   * Nothing is drawn until every frame is known, so the packer can order them
   * tallest-first; a shelf packer fed in declaration order wastes close to half
   * the atlas on part-empty rows.
   */
  const queued = [];
  function put(name, w, h, ax, ay, drawFn) {
    queued.push({ name, w, h, ax, ay, drawFn });
  }

  /**
   * Queue a frame painted straight onto a 2D context rather than through a
   * Phaser Graphics. Everything in this file is vector art and belongs in the
   * Graphics path; the exception is text, which only the browser's font stack
   * can draw. Packing is identical either way.
   */
  function putCanvas(name, w, h, ax, ay, paintFn) {
    queued.push({ name, w, h, ax, ay, paintFn });
  }

  buildBuildings(put);
  buildWalls(put);
  buildFoundations(put);
  buildScaffolds(put);
  buildResources(put, rng);
  buildUnits(put);
  buildTerrain(put, rng);
  buildDetails(put, rng);
  buildCliffs(put, rng);
  buildMarkers(put);
  buildFx(put);
  buildGlyphs(putCanvas, ctx);

  // Stable sort by descending height: ties keep declaration order, so the same
  // build always produces the same atlas.
  queued.forEach((q, i) => { q._i = i; });
  queued.sort((a, b) => (b.h - a.h) || (a._i - b._i));

  // --- packing ---------------------------------------------------------------
  //
  // Shelf packing, but every open shelf is a candidate rather than only the
  // newest one. Because the queue is sorted tallest-first, any frame still to be
  // placed fits the height of every shelf already opened, so the search reduces
  // to "some shelf with horizontal room left" — and the effect is that the
  // ragged tail every row ends with gets filled in by the small frames at the
  // end of the queue instead of being thrown away.
  //
  // WHICH shelf barely matters, and that is worth writing down so nobody spends
  // an afternoon on it twice. Searching oldest-first drops a short frame into a
  // tall shelf and looks like it must be wasteful; searching newest-first is a
  // best fit and looks like it must be better. Measured on this sheet the two
  // differ by two scanlines out of sixteen hundred, because the queue is sorted
  // by height and consecutive frames therefore already have near-identical
  // heights — the shelves are uniform whichever end you start from. What is
  // left over is the one-pixel gaps (about 130k pixels) and the ragged tail of
  // each row, and neither is worth a smarter packer at this scale.
  //
  // The cost is O(frames x shelves): sixty-odd shelves against a thousand
  // frames is fifty thousand integer compares once at boot, which does not show
  // up next to the thousand canvas rasterisations happening alongside it.
  const shelves = [];
  const lost = [];
  let usedPx = 0;

  for (const q of queued) {
    let sh = null;
    for (let i = 0; i < shelves.length; i++) {
      const s = shelves[i];
      if (q.h <= s.h && s.x + q.w + 1 <= SIZE) { sh = s; break; }
    }
    if (sh === null) {
      // A new shelf under everything opened so far. This is the one place the
      // sheet can run out, and it must fail here rather than pretend.
      if (shelf.y + q.h + 1 > SIZE) {
        lost.push(q);
        continue;
      }
      sh = { y: shelf.y, x: 1, h: q.h };
      shelves.push(sh);
      shelf.y += q.h + 1;
    }

    if (q.paintFn) {
      // Painted in place. The atlas context is already at the right spot, and a
      // round trip through a temporary texture would only cost a canvas.
      ctx.save();
      ctx.translate(sh.x, sh.y);
      q.paintFn(ctx);
      ctx.restore();
    } else {
      g.clear();
      q.drawFn(g);
      if (scene.textures.exists(TMP)) scene.textures.remove(TMP);
      g.generateTexture(TMP, q.w, q.h);
      const src = scene.textures.get(TMP).getSourceImage();
      ctx.drawImage(src, sh.x, sh.y);
      scene.textures.remove(TMP);
    }
    // Registered only now that the frame is known to have landed inside the
    // sheet. THE OLD CODE REGISTERED IT REGARDLESS, and that is worth spelling
    // out because of how quietly it failed: past y=2048 `ctx.drawImage` clips
    // to the canvas and draws nothing, while `canvasTex.add` and `origins.set`
    // still record the frame — so every `has(frame)` fallback in render.js was
    // satisfied by a frame containing no pixels, and an overflowing sprite
    // rendered as *nothing at all*, with no error, no warning that anybody
    // reads, and no fallback to the art that does exist.
    canvasTex.add(q.name, 0, sh.x, sh.y, q.w, q.h);
    origins.set(q.name, { w: q.w, h: q.h, ox: q.ax / q.w, oy: q.ay / q.h });
    sh.x += q.w + 1;
    usedPx += q.w * q.h;
  }

  const budget = SIZE * SIZE;
  if (lost.length) {
    const overPx = lost.reduce((n, q) => n + q.w * q.h, 0);
    const names = lost.slice(0, 6).map((q) => q.name).join(', ');
    throw new Error(
      `[gfx] atlas overflow: ${lost.length} of ${queued.length} frames did not fit `
      + `in the ${SIZE}x${SIZE} sheet — ${overPx} pixels over budget `
      + `(${(overPx / 1e3).toFixed(1)}k, ${((overPx / budget) * 100).toFixed(2)}% of the sheet). `
      + `Placed ${usedPx} px of ${budget} (${((usedPx / budget) * 100).toFixed(1)}%) in `
      + `${shelves.length} shelves. Lost: ${names}${lost.length > 6 ? ', ...' : ''}. `
      + 'Shrink a frame box, drop a variant, or raise SIZE — but do not ignore this: '
      + 'an unregistered frame renders as nothing.',
    );
  }
  // The budget, at info level, every boot. It is the only number that says how
  // much room the next piece of art has, and a number nobody prints is a number
  // nobody knows until it is already too late.
  const packedPx = shelf.y * SIZE;
  console.info(
    `[gfx] atlas ${SIZE}x${SIZE}: ${queued.length} frames, `
    + `${(usedPx / 1e6).toFixed(3)}M px drawn (${((usedPx / budget) * 100).toFixed(1)}% of `
    + `${(budget / 1e6).toFixed(2)}M), packed to y=${shelf.y} `
    + `(${((packedPx / budget) * 100).toFixed(1)}% of the sheet occupied, `
    + `${((usedPx / Math.max(1, packedPx)) * 100).toFixed(1)}% packing efficiency), `
    + `${((budget - packedPx) / 1e6).toFixed(2)}M px of headroom left`,
  );

  canvasTex.refresh();
  g.destroy();

  return { atlas: ATLAS, origins };
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

function diamondPts(w, h) {
  return [
    { x: w / 2, y: 0 },
    { x: w, y: h / 2 },
    { x: w / 2, y: h },
    { x: 0, y: h / 2 },
  ];
}

/** Uniform-ish random point inside the tile diamond, `inset` from the edge. */
function inDiamond(rng, w, h, inset) {
  for (let i = 0; i < 24; i++) {
    const a = rng() * 2 - 1;
    const b = rng() * 2 - 1;
    if (Math.abs(a) + Math.abs(b) <= 1 - inset) {
      return { x: w / 2 + (a * w) / 2, y: h / 2 + (b * h) / 2 };
    }
  }
  return { x: w / 2, y: h / 2 };
}

// ---------------------------------------------------------------------------
// THE GROUND, AND WHY IT LOOKED LIKE GRAPH PAPER
// ---------------------------------------------------------------------------
//
// Terrain is most of the screen, so it is most of the impression, and it was
// failing in three separate ways at once. All three are fixed here and all three
// are worth naming, because each of them is a mistake that is easy to make again:
//
// 1. THE GRID. Every tile drew a faint stroke around its own diamond — a helper
//    literally called `edgeTint`, whose comment said it existed "so the iso grid
//    is legible". That is backwards. The grid is a fact about the simulation, not
//    about the world; drawing it turns a meadow into a sheet of graph paper, and
//    at the zoom this game is played at the lines were the single loudest thing
//    on screen. It is gone. The water tiles were worse still: they carried a
//    bright `shade(base, 0.45)` stroke right round the diamond, so a pond was a
//    stack of blue floor tiles with the grout picked out.
//
//    Killing the strokes is not enough on its own, because the *fill* leaves a
//    grid too. Tiles are baked one pixel larger than a tile and blitted a pixel
//    up-left so they overlap; where they overlap, the antialiased rim of the
//    diamond — partial alpha — composites over the neighbour that was drawn
//    before it, and a partial-alpha edge over an opaque interior is a visible
//    seam whichever colours are involved. So `fillTile` now strokes the diamond
//    in its own fill colour before anything else goes on top, which drives the
//    rim to full opacity and buries it under the neighbour's overlap. That one
//    line is the difference between "tiled ground" and "ground".
//
// 2. THE STAIRCASE. Where two terrains met, the boundary was the diamond grid
//    itself: a perfect zigzag of 64x32 steps, with a soft airbrush over it that
//    hid none of it. Terrain does not have corners. buildEdgeBlends now draws a
//    real intrusion — an opaque tongue of the neighbouring ground with an
//    irregular, lobed inner boundary that reaches past the tile's own corners,
//    breaking up into speckle as it goes — and there are four variants of each
//    edge so a long boundary does not repeat.
//
// 3. FLATNESS. Every tile was a flat plate of one colour with marks on it, so a
//    field of grass was a field of flat plates. Each variant now carries a soft
//    `swell` of light in a variant-specific direction, which costs one more
//    ellipse at bake time and reads, across a dozen tiles, as ground that rises
//    and falls. That plus the wider variant count (11 grass, 9 dirt, 6 sand) is
//    what stops a hillside being one sheet of green.
//
// Variants still sit close together in value on purpose: spread them out and the
// map turns into a visible quilt of alternating diamonds, which is the failure
// mode on the *other* side of this one.
const GRASS = [
  0x537d38, 0x55803a, 0x4f7935, 0x577f3c, 0x5c8140, 0x4d7534, 0x59823c,
  // Four more, added with the swell pass. The hue wanders a little further than
  // the original seven — a touch of olive, a touch of blue-green — because a
  // meadow is not one dye lot, and at this spacing the eye reads the spread as
  // grass rather than as different terrain.
  0x51803e, 0x5b7c33, 0x4b7331, 0x5e8543,
];
const DIRT = [
  0x8a6a45, 0x866742, 0x8e6e49, 0x876b47, 0x8b6c48, 0x836540,
  0x8f7150, 0x806040, 0x92714b,
];
// Deliberately darker than they were. The shallow band around a pond is no
// longer painted by the water tile at all — it is the edge blend the *land*
// receives (see TERRAIN_BASE below), so the tiles themselves are free to be the
// deep part, and a pond finally has a bottom instead of being one flat blue.
const WATER = [0x276a9a, 0x266795, 0x286d9d, 0x256898];
const SAND = [0xd5bf82, 0xd1bb7e, 0xd8c288, 0xd3bd80, 0xdcc78e, 0xcdb679];

/**
 * One representative colour per terrain id, used to tint the edge-blend tongue
 * that this terrain pushes across its boundaries.
 *
 * Water's entry is NOT the water tile colour, and that is the whole shoreline.
 * Water outranks everything in TERRAIN_PRIORITY, so the tile that receives
 * water's tongue is always a land tile at the water's edge — which is exactly
 * where shallows belong. Tint that tongue with a bright shelf blue and every
 * pond and every river in the game gets a lit rim that shelves down into the
 * darker tiles behind it, at a cost of zero extra frames and zero extra draws.
 */
export const TERRAIN_BASE = [GRASS[0], DIRT[0], 0x35789f, SAND[0]];
// Which terrain bleeds over which. A tile only ever receives the wash of a
// *higher* priority neighbour, so each boundary is drawn exactly once.
export const TERRAIN_PRIORITY = [0, 1, 3, 2]; // grass < dirt < sand < water

// Sea ramp from the shoreline outwards. The last entry must equal OCEAN_DEEP.
const OCEAN_RAMP = [0x2a6d92, 0x235f83, 0x1d5273, 0x184460, 0x123449, OCEAN_DEEP];

function buildTerrain(put, rng) {
  const W = TILE_TEX_W;
  const H = TILE_TEX_H;
  const pts = diamondPts(W, H);

  GRASS.forEach((base, i) => {
    put(terrainFrame(0, i), W, H, 0, 0, (g) => {
      fillTile(g, pts, base);
      swell(g, W, H, base, i, 0.028);
      blotches(g, rng, W, H, base, 6, 0.075);
      // Grass tufts read as texture even when the tile is only ~20px on screen.
      // Two tones of them, the paler one drawn second and slightly shorter, so a
      // tuft has a lit side and a shaded side instead of being a single hair.
      for (let k = 0; k < 7; k++) {
        const p = inDiamond(rng, W, H, 0.3);
        const lean = rng.range(-1.6, 1.6);
        g.lineStyle(1, shade(base, -0.28), 0.4);
        g.beginPath();
        g.moveTo(p.x, p.y + 1);
        g.lineTo(p.x + lean, p.y - 3);
        g.strokePath();
        g.lineStyle(1, shade(base, 0.24), 0.5);
        g.beginPath();
        g.moveTo(p.x + 0.7, p.y + 0.6);
        g.lineTo(p.x + lean + 0.7, p.y - 2.6);
        g.strokePath();
      }
      if (i === 3 || i === 9) {
        // one variant carries a small flower cluster
        for (let k = 0; k < 3; k++) {
          const p = inDiamond(rng, W, H, 0.35);
          g.fillStyle(rng.chance(0.5) ? 0xe8e0b0 : 0xd8a8bc, 0.6);
          g.fillCircle(p.x, p.y - 1, 1.2);
        }
      }
      if (i === 4 || i === 8) {
        // Sun-bleached patch: where the field is thinning to dry stalks. The
        // hue shift is small and the shape is soft, so a run of these reads as
        // one meadow drying out rather than as a different terrain type.
        for (let k = 0; k < 3; k++) {
          const p = inDiamond(rng, W, H, 0.24);
          g.fillStyle(0xa39750, 0.24);
          g.fillEllipse(p.x, p.y, rng.range(11, 19), rng.range(5, 9));
        }
        g.lineStyle(1, 0xbcae6a, 0.5);
        for (let k = 0; k < 5; k++) {
          const p = inDiamond(rng, W, H, 0.3);
          g.beginPath();
          g.moveTo(p.x, p.y + 1);
          g.lineTo(p.x + rng.range(-1.8, 1.8), p.y - 3.6);
          g.strokePath();
        }
      }
      if (i === 5 || i === 10) {
        // Deep, damp grass: darker mottling and a denser stand of blades.
        for (let k = 0; k < 3; k++) {
          const p = inDiamond(rng, W, H, 0.24);
          g.fillStyle(0x2f5a26, 0.2);
          g.fillEllipse(p.x, p.y, rng.range(9, 16), rng.range(4, 8));
        }
        g.lineStyle(1, shade(base, 0.3), 0.5);
        for (let k = 0; k < 8; k++) {
          const p = inDiamond(rng, W, H, 0.26);
          g.beginPath();
          g.moveTo(p.x, p.y + 1);
          g.lineTo(p.x + rng.range(-2, 2), p.y - 4.4);
          g.strokePath();
        }
      }
      if (i === 6) {
        // Clover: tiny paired dots, the smallest legible mark on a tile.
        for (let k = 0; k < 7; k++) {
          const p = inDiamond(rng, W, H, 0.3);
          g.fillStyle(0x6d9a4a, 0.55);
          g.fillCircle(p.x, p.y, 1.4);
          g.fillCircle(p.x + 2.2, p.y + 0.8, 1.1);
        }
      }
      if (i === 7) {
        // A bare scuff worn through to the soil. One tile in eleven, so it is
        // incident rather than another texture — the thing that stops a lawn
        // being a lawn is a patch where the lawn has stopped.
        for (let k = 0; k < 2; k++) {
          const p = inDiamond(rng, W, H, 0.3);
          g.fillStyle(0x6f6034, 0.3);
          g.fillEllipse(p.x, p.y, rng.range(12, 18), rng.range(6, 9));
          g.fillStyle(0x7d6c3c, 0.22);
          g.fillEllipse(p.x + 1.5, p.y - 0.8, rng.range(7, 11), rng.range(3.5, 5.5));
        }
      }
    });
  });

  DIRT.forEach((base, i) => {
    put(terrainFrame(1, i), W, H, 0, 0, (g) => {
      fillTile(g, pts, base);
      swell(g, W, H, base, i + 3, 0.026);
      blotches(g, rng, W, H, base, 7, 0.1);
      // Pebbles. Variant 3 trades some of them for dry cracks and a stray
      // weed, so a wide sheet of dirt is not the same five stones over and
      // over — the flat-dirt regions were the quilt's dullest half. Each stone
      // is now a shadow, a body and a lit cap rather than two flat ellipses;
      // at three pixels across that is the whole difference between a pebble
      // and a smudge.
      const stones = i === 3 ? 2 : i === 6 ? 3 : 5;
      for (let k = 0; k < stones; k++) {
        const p = inDiamond(rng, W, H, 0.32);
        const rw = rng.range(2.5, 4.5);
        const rh = rng.range(1.8, 2.8);
        g.fillStyle(0x2a2118, 0.22);
        g.fillEllipse(p.x - 0.8, p.y + 1.2, rw * 1.1, rh * 0.9);
        g.fillStyle(shade(base, -0.3), 0.85);
        g.fillEllipse(p.x, p.y, rw, rh);
        g.fillStyle(shade(base, 0.28), 0.8);
        g.fillEllipse(p.x + 0.5, p.y - 0.7, rw * 0.5, rh * 0.5);
      }
      if (i === 3) {
        g.lineStyle(1, shade(base, -0.34), 0.45);
        for (let k = 0; k < 3; k++) {
          const p = inDiamond(rng, W, H, 0.34);
          g.beginPath();
          g.moveTo(p.x - 4, p.y);
          g.lineTo(p.x, p.y + rng.range(-1.4, 1.4));
          g.lineTo(p.x + 5, p.y + rng.range(-1.2, 1.2));
          g.strokePath();
        }
        g.lineStyle(1, 0x6f7b40, 0.5);
        for (let k = 0; k < 3; k++) {
          const p = inDiamond(rng, W, H, 0.4);
          g.beginPath();
          g.moveTo(p.x, p.y + 1);
          g.lineTo(p.x + rng.range(-1.4, 1.4), p.y - 3.4);
          g.strokePath();
        }
      }
      if (i === 4) {
        // Cart ruts, running along the grid's north-east axis so a run of them
        // lines up into a track rather than crossing itself.
        g.lineStyle(2.4, shade(base, -0.24), 0.6);
        for (const off of [-4, 3]) {
          g.beginPath();
          g.moveTo(2, H / 2 + off);
          g.lineTo(W - 2, H / 2 + off - 1);
          g.strokePath();
        }
        g.lineStyle(1, shade(base, 0.18), 0.45);
        g.beginPath();
        g.moveTo(2, H / 2 - 5);
        g.lineTo(W - 2, H / 2 - 6);
        g.strokePath();
      }
      if (i === 5 || i === 8) {
        // Gravel: a scatter of small chips rather than five big stones.
        for (let k = 0; k < 14; k++) {
          const p = inDiamond(rng, W, H, 0.28);
          g.fillStyle(rng.chance(0.5) ? shade(base, -0.28) : shade(base, 0.2), 0.7);
          g.fillEllipse(p.x, p.y, rng.range(1.4, 2.6), rng.range(1, 1.8));
        }
      }
      if (i === 7) {
        // Cracked, sun-baked mud: a polygonal crazing rather than the three
        // straight fissures variant 3 gets.
        g.lineStyle(1.1, shade(base, -0.38), 0.4);
        for (let k = 0; k < 5; k++) {
          const p = inDiamond(rng, W, H, 0.3);
          const a = rng.range(0, Math.PI);
          g.beginPath();
          g.moveTo(p.x - Math.cos(a) * 5, p.y - Math.sin(a) * 2.4);
          g.lineTo(p.x, p.y);
          g.lineTo(p.x + Math.cos(a + 1.9) * 5, p.y + Math.sin(a + 1.9) * 2.4);
          g.strokePath();
        }
      }
    });
  });

  WATER.forEach((base, i) => {
    put(terrainFrame(2, i), W, H, 0, 0, (g) => {
      fillTile(g, pts, base);
      // Depth, built as a stack rather than a step. Graphics has no gradient
      // fill, so five nested ellipses at low alpha is the gradient: the middle
      // of a body of water is a good deal darker than its rim, and the falloff
      // has to be smooth or the tile reads as a blue plate with a blue coin on
      // it — which is what the single 0.55-alpha ellipse here used to do.
      for (let k = 5; k >= 1; k--) {
        const t = k / 5;
        g.fillStyle(shade(base, -0.34), 0.16);
        g.fillEllipse(W / 2, H / 2, W * 0.86 * t, H * 0.86 * t);
      }
      // Ripples: a dark trough with a lit crest just above it, so the surface
      // has a direction to it. Deliberately low-contrast — the bright, animated
      // glints live in the wa_* frames the renderer lays on top, and baking
      // them here as well would double them up wherever the two agree.
      for (let k = 0; k < 3; k++) {
        const p = inDiamond(rng, W, H, 0.4);
        g.lineStyle(1.6, shade(base, -0.3), 0.4);
        g.beginPath();
        g.moveTo(p.x - 5, p.y + 1);
        g.lineTo(p.x - 1.5, p.y - 0.4);
        g.lineTo(p.x + 2, p.y + 1);
        g.lineTo(p.x + 5.5, p.y - 0.4);
        g.strokePath();
        g.lineStyle(1.3, shade(base, 0.34), 0.4);
        g.beginPath();
        g.moveTo(p.x - 5, p.y);
        g.lineTo(p.x - 1.5, p.y - 1.4);
        g.lineTo(p.x + 2, p.y);
        g.lineTo(p.x + 5.5, p.y - 1.4);
        g.strokePath();
      }
    });
  });

  SAND.forEach((base, i) => {
    put(terrainFrame(3, i), W, H, 0, 0, (g) => {
      fillTile(g, pts, base);
      swell(g, W, H, base, i + 5, 0.022);
      blotches(g, rng, W, H, base, 5, 0.08);
      for (let k = 0; k < 8; k++) {
        const p = inDiamond(rng, W, H, 0.34);
        g.fillStyle(shade(base, -0.22), 0.55);
        g.fillCircle(p.x, p.y, 0.9);
      }
      if (i === 4) {
        // Wind ripples, running along one grid axis so a beach reads as combed
        // rather than as static.
        g.lineStyle(1.2, shade(base, -0.16), 0.4);
        for (let k = -2; k <= 2; k++) {
          g.beginPath();
          g.moveTo(3, H / 2 + k * 4.5);
          g.lineTo(W - 3, H / 2 + k * 4.5 - 2);
          g.strokePath();
        }
      }
      if (i === 5) {
        // Shell grit and a couple of larger pebbles washed up.
        for (let k = 0; k < 3; k++) {
          const p = inDiamond(rng, W, H, 0.34);
          g.fillStyle(shade(base, -0.3), 0.6);
          g.fillEllipse(p.x, p.y + 0.6, 3.2, 2);
          g.fillStyle(shade(base, 0.34), 0.75);
          g.fillEllipse(p.x + 0.4, p.y - 0.3, 2, 1.2);
        }
      }
    });
  });

  buildOcean(put, rng);
  buildEdgeBlends(put, rng);
  buildShores(put, rng);
  buildWaterAnim(put, rng);

  // Big soft ellipse, drawn tinted and very faint over the baked ground so
  // large single-terrain regions get slow, map-scale variation instead of
  // reading as one flat sheet. Costs nothing per frame: it is baked in.
  put(BLOB_FRAME, 168, 100, 84, 50, (g) => {
    for (let i = 7; i >= 1; i--) {
      g.fillStyle(0xffffff, 0.085);
      g.fillEllipse(84, 50, (158 * i) / 7, (94 * i) / 7);
    }
  });

  // White diamond used for placement / hover highlights (tinted at runtime).
  put('tile_hi', W, H, 0, 0, (g) => {
    g.fillStyle(0xffffff, 0.32);
    g.fillPoints(diamondPts(W, H), true, true);
    g.lineStyle(2, 0xffffff, 1);
    g.strokePoints(diamondPts(W - 3, H - 3).map((p) => ({ x: p.x + 1.5, y: p.y + 1.5 })), true, true);
  });
}

/**
 * Fill a tile diamond, and drive its antialiased rim to full opacity.
 *
 * The stroke is the important half and it is not decoration: see note 1 at the
 * top of this section. `fillPoints` leaves the diamond's boundary at partial
 * alpha, tiles overlap by a pixel or two, and a partial-alpha edge composited
 * over an opaque neighbour is a seam — which, repeated across a hundred tiles,
 * is the grid. Stroking the same path in the same colour first makes the rim
 * solid, so the overlap has nothing to reveal.
 */
function fillTile(g, pts, base) {
  g.fillStyle(base, 1);
  g.fillPoints(pts, true, true);
  g.lineStyle(2, base, 1);
  g.strokePoints(pts, true, true);
}

function blotches(g, rng, W, H, base, n, amt) {
  for (let k = 0; k < n; k++) {
    const p = inDiamond(rng, W, H, 0.14);
    g.fillStyle(rng.chance(0.5) ? shade(base, amt) : shade(base, -amt), 0.5);
    g.fillEllipse(p.x, p.y, rng.range(9, 20), rng.range(4.5, 9));
  }
}

/**
 * A soft swell of light across the tile, leaning in a variant-specific
 * direction.
 *
 * This is the cheapest possible substitute for a heightfield: no two adjacent
 * tiles lean the same way, so a sheet of one terrain acquires slow variation
 * instead of being one flat plate repeated.
 *
 * TWO THINGS ABOUT THE NUMBERS, both learned the hard way by looking at the
 * result. First, the ellipses are much LARGER than the tile and centred well
 * outside it, so what falls inside the diamond is a slice of a broad gradient —
 * a ramp. Sized to the tile instead, the same code puts a bright blob in the
 * middle of every diamond, which does not read as an undulation; it reads as a
 * spotlight per tile, and it draws the grid more clearly than the stroke this
 * whole pass removed. Second, the amplitude is tiny (four per cent) and stays
 * tiny, because every pixel of value difference between one tile and the next
 * lands exactly on the tile boundary, and value differences on a boundary are
 * the definition of a quilt. Anything the player should actually notice at
 * map scale belongs in the BLOB pass in render.js, which is six tiles wide and
 * does not respect the grid at all.
 *
 * `dir` is an integer; consecutive variants get consecutive directions round the
 * compass, which guarantees neighbouring variants never agree.
 */
function swell(g, W, H, base, dir, amt) {
  const a = (Math.PI * 2 * (dir % 8)) / 8 + 0.4;
  const ox = Math.cos(a) * W * 0.85;
  const oy = Math.sin(a) * H * 0.85;
  for (let k = 4; k >= 1; k--) {
    const t = k / 4;
    g.fillStyle(shade(base, amt), 0.055);
    g.fillEllipse(W / 2 + ox, H / 2 + oy, W * 2.1 * t, H * 2.1 * t);
    g.fillStyle(shade(base, -amt), 0.05);
    g.fillEllipse(W / 2 - ox, H / 2 - oy, W * 2.1 * t, H * 2.1 * t);
  }
}

// --- out-of-bounds sea -------------------------------------------------------
//
// The map is a diamond, so its bounding box has four empty corners; at the
// opening camera that showed as a dead black band across the top. Rather than
// fight the geometry, the world now ends in open water: a tiled shelf that
// deepens away from the coast and then hands off to one flat fill. All of it is
// baked into the same terrain RenderTextures, so the surround costs nothing per
// frame.

function buildOcean(put, rng) {
  const W = TILE_TEX_W;
  const H = TILE_TEX_H;
  const pts = diamondPts(W, H);
  // Indexed off OCEAN_LEVELS rather than the ramp, so the renderer can never
  // ask for a depth frame that was not generated.
  for (let i = 0; i < OCEAN_LEVELS; i++) {
    const base = OCEAN_RAMP[Math.min(i, OCEAN_RAMP.length - 1)];
    const deep = i / (OCEAN_LEVELS - 1);
    put(oceanFrame(i), W, H, 0, 0, (g) => {
      fillTile(g, pts, base);
      // The outermost ring must be perfectly flat: it butts onto the solid
      // fill, and any detail there would draw the eye to the changeover.
      if (i === OCEAN_LEVELS - 1) return;
      for (let k = 4; k >= 1; k--) {
        g.fillStyle(shade(base, -0.24), 0.13 * (1 - deep * 0.6));
        g.fillEllipse(W / 2, H / 2, W * 0.8 * (k / 4), H * 0.8 * (k / 4));
      }
      if (i <= 2) {
        g.lineStyle(1.5, shade(base, 0.3), 0.42 - i * 0.12);
        for (let k = 0; k < 2; k++) {
          const p = inDiamond(rng, W, H, 0.42);
          g.beginPath();
          g.moveTo(p.x - 5, p.y);
          g.lineTo(p.x - 1.5, p.y - 1.4);
          g.lineTo(p.x + 2, p.y);
          g.lineTo(p.x + 5.5, p.y - 1.4);
          g.strokePath();
        }
      }
    });
  }
}

/** The four diamond corners, in the order the edge indices walk them. */
function diamondCorners(W, H) {
  return [
    { x: W / 2, y: 0 },
    { x: W, y: H / 2 },
    { x: W / 2, y: H },
    { x: 0, y: H / 2 },
  ];
}

function towards(p, c, t) {
  return { x: p.x + (c.x - p.x) * t, y: p.y + (c.y - p.y) * t };
}

/**
 * Real terrain transitions.
 *
 * WHAT WAS WRONG. Two terrains met along the tile grid: a perfect 64x32 zigzag,
 * with a three-band airbrush laid over it that softened the colour without
 * moving the boundary an inch. Softening a straight line gives a soft straight
 * line. What kills a staircase is a boundary that does not follow it — one that
 * bulges past the corners in some places and pulls back short of the edge in
 * others, so the eye cannot find the 64x32 rhythm underneath.
 *
 * WHAT THIS DRAWS. For one edge of the diamond, an intruding tongue of the
 * neighbour's ground, in three layers:
 *
 *   the tongue    an opaque polygon that follows the tile edge on the outside
 *                 and an irregular lobed curve on the inside, sampled from two
 *                 out-of-phase sines so it is smooth rather than jagged — soil
 *                 creeps, it does not have teeth. It deliberately runs a little
 *                 PAST both corners, which is what makes the tongue on one edge
 *                 interlock with the tongue on the next one instead of leaving
 *                 a notch at every corner.
 *   the fringe    a second, fainter lobed band beyond the tongue, reaching
 *                 roughly twice as deep and completely out of phase with it, so
 *                 the boundary has two scales of irregularity rather than one.
 *   the speckle   scattered ellipses past the fringe, thinning out with depth.
 *                 This is the part the old version had, and on its own it is a
 *                 dusting, not a transition.
 *
 * WHY GREY AND NOT ONLY WHITE. The frame is tinted with the neighbour's base
 * colour, so white comes out as flat neighbour-colour with no texture in it at
 * all — a plastic sheen next to ground that has stones and blades on it. Tint
 * is a multiply, so anything darker than white comes out as a *darker shade of
 * the neighbour*: mottling the tongue with a few greys gives the intruding
 * ground its own value texture for free. Nothing can be made brighter than the
 * tint, which is why the shore foam lives in its own frames.
 *
 * FOUR VARIANTS. One drawn tongue stamped along a fifty-tile boundary is a
 * pattern, and a pattern is what this exists to destroy. Each variant shifts the
 * phase and the amplitude of both sines. See edgeBlendFrame.
 */
function buildEdgeBlends(put, rng) {
  const W = TILE_TEX_W;
  const H = TILE_TEX_H;
  const corners = diamondCorners(W, H);
  const C = { x: W / 2, y: H / 2 };
  const STEPS = 14;

  for (let e = 0; e < 4; e++) {
    const P = corners[e];
    const Q = corners[(e + 1) % 4];
    for (let v = 0; v < EDGE_BLEND_VARIANTS; v++) {
      // Phases are derived from the edge and the variant rather than drawn from
      // the rng, so the tongue on edge 1 is not a rotation of the tongue on
      // edge 0 — two neighbouring tiles very often receive blends on adjacent
      // edges, and if those matched the corner between them would show.
      const ph0 = e * 1.7 + v * 2.3;
      const ph1 = e * 0.9 + v * 3.1 + 1.1;
      const amp = 0.055 + (v % 2) * 0.02;

      // The inner boundary of a band, as a polyline from P's end to Q's end.
      // `base` is how far in the band reaches at rest and `k` scales the wobble.
      const inner = (base, k, phase) => {
        const out = [];
        for (let s = 0; s <= STEPS; s++) {
          const u = s / STEPS;
          const d = base
            + Math.sin(u * 5.4 + phase) * amp * k
            + Math.sin(u * 11.9 + phase * 1.7) * amp * k * 0.45;
          // Overshoot the corners a little (u is stretched past 0 and 1) so the
          // tongue laps round onto the neighbouring edges and no notch is left
          // where two blends meet.
          const eu = -0.06 + u * 1.12;
          const onEdge = { x: P.x + (Q.x - P.x) * eu, y: P.y + (Q.y - P.y) * eu };
          // The floor is negative on purpose: the outer lip is allowed to spill
          // a little past the tile edge, where the frame clips it. Floor it at
          // zero instead and the tongue stops a hair short of the edge all the
          // way along, which puts a one-pixel line of the host terrain round
          // every boundary — a new grid line, drawn by the code that exists to
          // remove one.
          out.push(towards(onEdge, C, Math.max(-0.05, d)));
        }
        return out;
      };
      put(edgeBlendFrame(e, v), W, H, 0, 0, (g) => {
        // 1. the tongue — opaque, so the intruding ground actually replaces the
        //    ground underneath rather than washing over it.
        //
        //    Its OUTER boundary wobbles too, and that is not symmetry for its
        //    own sake. This frame is drawn on the tile that is being intruded
        //    upon, so its outer lip lies exactly along the tile edge — which
        //    means a boundary whose inner side is organic and whose outer side
        //    is the lip still draws one perfectly straight 64x32 zigzag, and
        //    the eye finds a straight line next to a wiggly one instantly. It
        //    shows up worst on water, where a bright shelf against dark water
        //    was a staircase picked out in the highest contrast on the map.
        //    Letting the lip pull back inside the tile in places lets the host
        //    ground poke through into the gap, and the waterline breaks up.
        const outer = inner(0.045, 0.9, ph1 + 2.4);
        const t1 = inner(0.30, 1, ph0);
        g.fillStyle(0xffffff, 1);
        g.fillPoints([...outer, ...t1.slice().reverse()], true, true);
        // Value texture inside the tongue, in greys: after the tint these are
        // darker shades of the intruding terrain, which is what keeps it from
        // reading as a decal of flat colour.
        for (let k = 0; k < 7; k++) {
          const u = rng.range(0, 1);
          const onEdge = { x: P.x + (Q.x - P.x) * u, y: P.y + (Q.y - P.y) * u };
          const p = towards(onEdge, C, rng.range(0.04, 0.26));
          g.fillStyle(rng.chance(0.5) ? 0xc8c8c8 : 0xe4e4e4, 0.55);
          g.fillEllipse(p.x, p.y, rng.range(5, 11), rng.range(2.4, 4.6));
        }

        // 2. the fringe — out of phase with the tongue and reaching further, so
        //    the boundary wobbles at two scales.
        const t2 = inner(0.52, 1.6, ph1);
        g.fillStyle(0xffffff, 0.5);
        g.fillPoints([...t1, ...t2.slice().reverse()], true, true);

        // 3. the speckle — the ground breaking up as it runs out.
        for (let k = 0; k < 20; k++) {
          const u = rng.range(-0.02, 1.02);
          const vv = rng.range(0.42, 0.9);
          const onEdge = { x: P.x + (Q.x - P.x) * u, y: P.y + (Q.y - P.y) * u };
          const p = towards(onEdge, C, vv);
          g.fillStyle(0xffffff, 0.42 * (1 - (vv - 0.42) / 0.5));
          g.fillEllipse(p.x, p.y, rng.range(2.5, 6), rng.range(1.4, 3));
        }
      });
    }
  }
}

/**
 * Surf along one edge of a coastal tile: a hard wet line at the water's edge, a
 * broken foam crest a little up the beach, and a scatter of dying bubbles past
 * that.
 *
 * These are drawn white and tinted pale, so unlike the edge blends they can be
 * *brighter* than anything under them — which is why foam has to live here and
 * not in the transition frames. Four variants for the same reason those have
 * four: an identical wave stamped along thirty tiles of coast is corrugated
 * iron, and a coast is the one boundary a player's eye follows all the way.
 */
function buildShores(put, rng) {
  const W = TILE_TEX_W;
  const H = TILE_TEX_H;
  const corners = diamondCorners(W, H);
  const C = { x: W / 2, y: H / 2 };
  for (let e = 0; e < 4; e++) {
    const P = corners[e];
    const Q = corners[(e + 1) % 4];
    const at = (u, t) => towards(
      { x: P.x + (Q.x - P.x) * u, y: P.y + (Q.y - P.y) * u }, C, t,
    );
    for (let v = 0; v < SHORE_VARIANTS; v++) {
      const ph = e * 1.3 + v * 2.7;
      put(shoreFrame(e, v), W, H, 0, 0, (g) => {
        // The wet band: solid at the waterline, its inner edge wandering.
        const band = [];
        for (let s = 0; s <= 10; s++) {
          const u = -0.04 + (s / 10) * 1.08;
          band.push(at(u, 0.16 + Math.sin(u * 6.1 + ph) * 0.05));
        }
        g.fillStyle(0xffffff, 0.34);
        g.fillPoints([at(-0.04, 0.03), at(1.04, 0.03), ...band.slice().reverse()], true, true);
        // The waterline itself.
        g.lineStyle(2.4, 0xffffff, 0.85);
        g.beginPath();
        g.moveTo(at(-0.04, 0.05).x, at(-0.04, 0.05).y);
        g.lineTo(at(1.04, 0.05).x, at(1.04, 0.05).y);
        g.strokePath();
        // Broken foam crests further up the beach: three short arcs at
        // variant-dependent positions, so no two coastal tiles rhyme.
        g.lineStyle(1.8, 0xffffff, 0.6);
        for (let k = 0; k < 3; k++) {
          const u0 = 0.06 + k * 0.3 + (v % 2) * 0.08;
          const d = 0.22 + Math.sin(k * 2.1 + ph) * 0.07;
          g.beginPath();
          g.moveTo(at(u0, d).x, at(u0, d).y);
          g.lineTo(at(u0 + 0.09, d - 0.04).x, at(u0 + 0.09, d - 0.04).y);
          g.lineTo(at(u0 + 0.18, d).x, at(u0 + 0.18, d).y);
          g.strokePath();
        }
        // Dying bubbles.
        for (let k = 0; k < 7; k++) {
          const u = rng.range(0, 1);
          const d = rng.range(0.26, 0.46);
          const p = at(u, d);
          g.fillStyle(0xffffff, 0.4 * (1 - (d - 0.26) / 0.22));
          g.fillEllipse(p.x, p.y, rng.range(2, 4.5), rng.range(1.2, 2.2));
        }
      });
    }
  }
}

/**
 * The water's moving surface, as a short overlay cycle.
 *
 * Water tiles are baked into the static terrain RenderTexture with everything
 * else — that is what makes a 96x96 map cost nothing per frame — so the tiles
 * themselves can never move. These four frames are the part that can: caustic
 * threads and glints on transparency, meant to be laid over a water tile at low
 * alpha and stepped a few times a second. Frame k is the same surface a quarter
 * of a cycle later, so the threads drift steadily in one direction rather than
 * flickering between four unrelated pictures — a cycle that does not *travel*
 * reads as television static, which is worse than no animation at all.
 */
function buildWaterAnim(put, rng) {
  const W = TILE_TEX_W;
  const H = TILE_TEX_H;
  // Fixed thread positions, shared by all four frames; only the phase moves.
  const threads = [];
  for (let k = 0; k < 7; k++) {
    threads.push({
      x: rng.range(6, W - 6),
      y: rng.range(5, H - 5),
      len: rng.range(7, 14),
      amp: rng.range(0.8, 2.0),
      sp: rng.range(0.7, 1.5),
    });
  }
  for (let f = 0; f < WATER_ANIM_FRAMES; f++) {
    const phase = (Math.PI * 2 * f) / WATER_ANIM_FRAMES;
    put(waterFrame(f), W, H, 0, 0, (g) => {
      for (const t of threads) {
        // Drift along the +x screen axis and wrap, so the whole surface travels.
        const dx = ((t.x + (f * W) / (WATER_ANIM_FRAMES * 2)) % (W - 8)) + 4;
        const y = t.y + Math.sin(phase * t.sp) * t.amp;
        // Only inside the diamond, or the glints spill onto the neighbouring
        // land tile and the pond gets a halo.
        const inside = Math.abs(dx - W / 2) / (W / 2) + Math.abs(y - H / 2) / (H / 2);
        if (inside > 0.82) continue;
        const a = 0.16 + 0.14 * (1 + Math.sin(phase * 2 + t.sp * 3)) * 0.5;
        g.lineStyle(1.7, 0xffffff, a);
        g.beginPath();
        g.moveTo(dx - t.len / 2, y);
        g.lineTo(dx - t.len / 6, y - 1.3);
        g.lineTo(dx + t.len / 6, y);
        g.lineTo(dx + t.len / 2, y - 1.3);
        g.strokePath();
      }
      // One brighter glint per frame, moving round the tile, which is what
      // makes the cycle read as sunlight on moving water rather than as noise.
      const ga = phase + 0.6;
      const gx = W / 2 + Math.cos(ga) * W * 0.2;
      const gy = H / 2 + Math.sin(ga) * H * 0.2;
      g.fillStyle(0xffffff, 0.3);
      g.fillEllipse(gx, gy, 7, 2.6);
      g.fillStyle(0xffffff, 0.5);
      g.fillEllipse(gx, gy, 3.4, 1.4);
    });
  }
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------
//
// ANIMATION, AND WHAT IT IS ALLOWED TO COST
// -----------------------------------------
// Every unit needs to read as walking, working, swinging and dying, and every
// frame of that has to come out of the same atlas as everything else or the
// batch breaks. Three decisions keep the sheet small enough for a phone:
//
// 1. TWO DRAWN FACINGS, EIGHT SEEN. A front pose and a back pose per unit; the
//    renderer mirrors horizontally for the four facings that point right (see
//    FACE_BACK / FACE_FLIP in render.js). Isometric characters mirror cleanly
//    left/right because the projection is symmetric about the screen's vertical
//    axis — the light does not move when you flip a figure, only the shading of
//    a *tilted plane* would, and none of these bodies has one. Drawing eight
//    real facings would quadruple the unit half of the atlas to buy a difference
//    nobody can see at 40 screen pixels tall.
//
// 2. ONE PARAMETRIC POSE, NOT ONE DRAWING PER FRAME. Each unit is drawn once,
//    from a pose record of five numbers: two leg angles, the upper body's offset
//    from the hips, and one `swing` that every unit interprets in terms of its
//    own weapon (the villager rotates the axe about its hand, the spearman
//    thrusts along the shaft, the archer pulls or releases the string, the ram
//    slides its log). A skeleton with more joints would let us draw anything and
//    would also turn six units into six rigs to maintain, for detail that is
//    below the resolution the player actually sees.
//
// 3. ACTIONS THAT ARE THE SAME MOTION GET THE SAME POSES. A villager attacking
//    swings the axe it gathers with, so `attack` reuses the gather pair rather
//    than adding two frames per unit per team for a thing villagers do badly
//    and rarely.
//
// 4. POSE COUNT IS SPENT WHERE THE MOTION IS. The walk used to be three drawings
//    played [w0, w1, w2, w1] — a four-beat cycle in which two of the four beats
//    are the same picture, which is exactly the reason units read as sliding
//    rather than walking. It is six drawings now, played straight through, for
//    everything with legs.
//
//    SIX, AND WHY NOT MORE OR FEWER. The rig is two leg angles, a body offset
//    and a weapon phase — no knees. Drive the legs from `A*sin(phase)` with the
//    two legs exactly out of step and you cannot get more than *four* distinct
//    drawings out of a cycle, because sin(60 degrees) equals sin(120 degrees)
//    and the two poses come out identical; the sixth and fifth beats are wasted
//    atlas. Giving the trailing leg a small phase lead — which is what double
//    support actually is, both feet down for a moment either side of contact —
//    breaks every tie and gets six genuinely different pictures out of the same
//    four numbers. That is the whole of the walk improvement, and it costs data,
//    not code.
//
//    Cavalry gets four (a gallop is a shorter, snappier cycle and the horse's
//    barrel hides most of the leg travel anyway) and the wheeled engines get
//    three, because what animates on those is a wheel and three phases of a
//    spoke pattern is a rotation.
//
// The result is 13 poses for the villager, 11 for a foot soldier or a monk, 9
// for a rider and 8 for an engine — x2 facings x2 teams.

const UNIT_BOX = {
  villager: { w: 36, h: 51, cx: 18, ft: 46 },
  // Box heights leave a few pixels of air above the tallest thing each unit
  // draws in any pose — a plume, a spear point, a rider's helmet. Get this
  // wrong and the clipping only shows up in one pose out of ten, which is
  // exactly the kind of bug a contact sheet catches and a play session does
  // not. tests/art.browser.mjs prints every pose of every unit for this reason.
  militia: { w: 46, h: 61, cx: 23, ft: 56 },
  // Taller than the militia purely to fit the spear: the shaft rises well above
  // the head, and that vertical line over a body the player already recognises
  // as infantry is the whole of the spearman's silhouette.
  spearman: { w: 46, h: 72, cx: 22, ft: 62 },
  // Wider and taller than the others on purpose: the archer's whole identity is
  // the bow arc hanging off its left and the arrow fan off its right, and both
  // need room outside the body to read at phone size. (Cut from 54x64 once the
  // contact sheet showed seven columns and six rows of empty pixels on every
  // one of its frames; at forty-four frames per team that emptiness was 23k
  // pixels of atlas, which is most of a monk.)
  archer: { w: 44, h: 56, cx: 24, ft: 52 },
  // The only unit on the map wider than it is tall. That, not the rider, is what
  // makes cavalry findable in a crowd at 0.7 zoom without reading a label.
  scout: { w: 60, h: 66, cx: 29, ft: 58 },
  // A machine, not a man: no head, no limbs, no tunic. A player has to know at a
  // glance that the thing crawling at their Town Center cannot be answered by
  // trading blows with it.
  ram: { w: 68, h: 62, cx: 34, ft: 55 },

  // --- the new roster --------------------------------------------------------
  //
  // Five bodies, and between them they have to say four things a player must
  // never have to tap to find out: which of these is a cheap missile trooper,
  // which is the heavy cavalry that ends games, which two are engines that
  // cannot answer a charge, and which one cannot fight at all.
  //
  // A skirmisher is a light infantryman with a bundle of javelins and a wicker
  // shield — no bow arc anywhere on it, because the bow arc is the archer's and
  // two missile units that both read "archer" is worse than one.
  skirmisher: { w: 46, h: 62, cx: 23, ft: 54 },
  // A barded warhorse. Taller and heavier than the scout in every dimension:
  // the scout is a pony with a man in a cap, this is a wall of steel with a
  // lance over it, and the difference has to survive the two of them standing
  // next to each other.
  knight: { w: 63, h: 71, cx: 31, ft: 62 },
  // Both engines are wider than they are tall and both sit low, like the ram —
  // that is the family they belong to, and the family is the first read. What
  // separates them from each other is the throwing gear on top: the mangonel's
  // arm rakes back over its own axle and its bucket is a bowl, the scorpion's
  // is a flat horizontal bow with a bolt already in the groove.
  // THE THREE ENGINES ARE THREE MASSES, and that is the whole of what tells
  // them apart at play zoom. The review that failed this art called them "three
  // identical brown carts", and it was right — they were all the same low
  // horizontal slab, and no amount of detail on top of a shared outline fixes
  // that, because at 0.7 zoom on a phone there is no detail, only outline.
  //
  //   ram        LOW and BROAD. A shed with a log under it: one long horizontal
  //              roof, nothing above it.
  //   mangonel   TALL. The arm stands up at rest with a stone in the bowl, so
  //              the silhouette is a steep diagonal with a ball on top — the
  //              only shape like it in the game. It costs ten pixels of box
  //              height per frame and it is the best ten pixels in this file.
  //   scorpion   LOWEST and FLATTEST. A bolt trough on two small wheels, with
  //              a painted mantlet at the crew end. It sits a third lower than
  //              the ram and half the height of the mangonel.
  //
  // The three tops now sit at roughly 40, 52 and 66 pixels above the ground,
  // which is a spread you can see in a thumbnail.
  mangonel: { w: 70, h: 77, cx: 35, ft: 69 },
  scorpion: { w: 64, h: 54, cx: 32, ft: 43 },
  // The narrowest body in the game, and deliberately the plainest: a robe to
  // the ground, a cowl, and both hands on a book. No weapon, no helmet, no
  // shield, nothing on the shoulders — a monk has to read as a non-combatant
  // from its outline alone, at any zoom, in the middle of a melee.
  monk: { w: 37, h: 56, cx: 17, ft: 52 },
};

/**
 * The pose table. `la`/`lb` are the two leg angles in radians (positive swings
 * the foot forward, i.e. to screen right), `bx`/`by` offset the upper body from
 * the hips, and `swing` is the weapon phase — negative is wound up, positive is
 * following through.
 *
 * Death is two poses rather than one because a single slumped drawing rotated
 * flat reads as a sprite that fell over. d0 is the stagger — weight going back,
 * weapon arm flung out — and d1 is the crumple, knees folded under the body and
 * the weapon dropped. The renderer plays d0 for a beat, then d1 while rotating
 * the whole sprite about its feet and fading it out, which is what makes a death
 * read as a death and not as a despawn.
 */
/**
 * One beat of the six-drawing walk.
 *
 * `k` is the beat, 0..5. The near leg swings as A*sin(phase); the far leg swings
 * as -A*sin(phase + LEAD), and that small lead is what makes six distinct
 * drawings possible at all — see point 4 in the section header. It is also what
 * a walk really does: for a moment either side of every footfall both feet are
 * on the ground, and the trailing one has not finished pushing off.
 *
 * The body rises and falls twice per stride (once per footfall), which is why
 * `by` keys off |sin| rather than sin, and it drifts a pixel or so forward and
 * back over the weight-bearing foot, which is `bx`.
 */
function walkPose(k, n = 6) {
  const ph = (Math.PI * 2 * k) / n;
  const LEAD = 0.38;
  const sw = Math.sin(ph);
  const near = Math.sin(ph);
  const far = -Math.sin(ph + LEAD);
  return {
    la: 0.60 * near,
    lb: 0.60 * far,
    bx: 0.62 * sw,
    // Low at the footfalls, high through the passing beats. The cosine term is
    // small and asymmetric on purpose: the body is still rising just after a
    // footfall and already falling just before the next one, so beats 1 and 2
    // of each half-stride — which share a leg angle — are told apart by a
    // pixel of height as well. Without it those two beats differ only in the
    // trailing leg and the cycle reads a beat shorter than it is.
    by: 1.5 - 2.7 * Math.abs(sw) - 0.7 * Math.cos(ph),
    swing: -0.17 * sw,
  };
}

const POSE = {
  i: { la: 0.12, lb: -0.12, bx: 0, by: 0, swing: 0 },
  w0: walkPose(0),
  w1: walkPose(1),
  w2: walkPose(2),
  w3: walkPose(3),
  w4: walkPose(4),
  w5: walkPose(5),
  // The four-beat gallop the riders use. Same generator, fewer samples: a
  // cantering horse's legs travel further and faster than a man's, so four
  // widely-spaced drawings read better than six closely-spaced ones, and the
  // barrel of the horse hides the middle of the stride anyway.
  c0: walkPose(0, 4),
  c1: walkPose(1, 4),
  c2: walkPose(2, 4),
  c3: walkPose(3, 4),
  g0: { la: 0.22, lb: -0.30, bx: -1.6, by: -1.2, swing: -1.05 },
  g1: { la: 0.30, lb: -0.34, bx: 2.6, by: 2.6, swing: 0.85 },
  b0: { la: 0.16, lb: -0.20, bx: -1.0, by: -0.6, swing: -0.72 },
  b1: { la: 0.18, lb: -0.22, bx: 1.6, by: 1.8, swing: 0.34 },
  a0: { la: 0.36, lb: -0.44, bx: -2.2, by: -1.0, swing: -0.95 },
  a1: { la: 0.10, lb: -0.64, bx: 3.6, by: 1.4, swing: 0.82 },
  // The monk's two working poses: h0 is the book raised and the free hand out,
  // h1 is the hand lowered with the blessing given. Named apart from the
  // villager's gather pair on purpose — they are the same *slot* in the
  // animation table but a completely different motion, and sharing g0/g1 would
  // have the monk chopping at the man it is healing.
  h0: { la: 0.10, lb: -0.14, bx: -0.8, by: -1.4, swing: -0.7 },
  h1: { la: 0.14, lb: -0.18, bx: 0.8, by: 0.6, swing: 0.5 },
  d0: { la: 0.78, lb: -0.32, bx: -3.4, by: -1.5, swing: -0.55 },
  d1: { la: 1.26, lb: -1.08, bx: -1.2, by: 9.5, swing: 1.5, dead: true },
};

const WALK6 = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5'];
const GALLOP4 = ['c0', 'c1', 'c2', 'c3'];
const ENGINE3 = ['w0', 'w2', 'w4'];

const WORKER_POSES = ['i', ...WALK6, 'g0', 'g1', 'b0', 'b1', 'd0', 'd1'];
const SOLDIER_POSES = ['i', ...WALK6, 'a0', 'a1', 'd0', 'd1'];
const RIDER_POSES = ['i', ...GALLOP4, 'a0', 'a1', 'd0', 'd1'];
const ENGINE_POSES = ['i', ...ENGINE3, 'a0', 'a1', 'd0', 'd1'];
const MONK_POSES = ['i', ...WALK6, 'h0', 'h1', 'd0', 'd1'];

// Which pose each simulation state plays, and in what order. `deposit` is a walk
// because a villager carrying wood home is walking; `gather` and `build` differ
// so that a construction site does not look like a woodline.
const WORKER_ANIM = {
  idle: ['i'],
  move: WALK6,
  deposit: WALK6,
  gather: ['g0', 'g1'],
  build: ['b0', 'b1'],
  attack: ['g0', 'g1'],
  die: ['d0', 'd1'],
};
const SOLDIER_ANIM = {
  idle: ['i'],
  move: WALK6,
  deposit: WALK6,
  gather: ['i'],
  build: ['i'],
  attack: ['a0', 'a1'],
  die: ['d0', 'd1'],
};
const RIDER_ANIM = {
  idle: ['i'],
  move: GALLOP4,
  deposit: GALLOP4,
  gather: ['i'],
  build: ['i'],
  attack: ['a0', 'a1'],
  die: ['d0', 'd1'],
};
const ENGINE_ANIM = {
  idle: ['i'],
  move: ENGINE3,
  deposit: ENGINE3,
  gather: ['i'],
  build: ['i'],
  attack: ['a0', 'a1'],
  die: ['d0', 'd1'],
};
// A monk never attacks — `attack` is here only because the renderer will ask
// for it if the simulation ever puts one in that state, and answering with the
// heal is far better than answering with a swing the unit cannot make.
const MONK_ANIM = {
  idle: ['i'],
  move: WALK6,
  deposit: WALK6,
  gather: ['h0', 'h1'],
  build: ['i'],
  attack: ['h0', 'h1'],
  heal: ['h0', 'h1'],
  die: ['d0', 'd1'],
};

const UNIT_ANIM = {
  villager: WORKER_ANIM,
  militia: SOLDIER_ANIM,
  spearman: SOLDIER_ANIM,
  archer: SOLDIER_ANIM,
  skirmisher: SOLDIER_ANIM,
  scout: RIDER_ANIM,
  knight: RIDER_ANIM,
  ram: ENGINE_ANIM,
  mangonel: ENGINE_ANIM,
  scorpion: ENGINE_ANIM,
  monk: MONK_ANIM,
};

/** Which pose list each unit type bakes. Must agree with UNIT_ANIM above. */
const UNIT_POSES = {
  villager: WORKER_POSES,
  militia: SOLDIER_POSES,
  spearman: SOLDIER_POSES,
  archer: SOLDIER_POSES,
  skirmisher: SOLDIER_POSES,
  scout: RIDER_POSES,
  knight: RIDER_POSES,
  ram: ENGINE_POSES,
  mangonel: ENGINE_POSES,
  scorpion: ENGINE_POSES,
  monk: MONK_POSES,
};

/**
 * The animation table for a unit type: state name -> ordered list of pose ids.
 * Unknown types fall back to the villager's, matching unitFrameFor()'s art
 * fallback in render.js, so a type nobody has drawn yet animates rather than
 * freezing mid-stride.
 */
export function unitAnim(type) {
  return UNIT_ANIM[type] || WORKER_ANIM;
}

/**
 * Type -> draw function. THIS TABLE IS WHAT THE BAKE ITERATES: a unit type that
 * is missing from it bakes no frames at all, and render.js's fallback chain then
 * quietly draws it as a villager — a mangonel that looks like a peasant, with no
 * error anywhere. Adding a type means adding it here, to UNIT_BOX, to UNIT_POSES
 * and to UNIT_ANIM; the four are checked against each other by assertUnitArt().
 */
const UNIT_DRAW = {
  villager: drawVillager,
  militia: drawMilitia,
  spearman: drawSpearman,
  archer: drawArcher,
  skirmisher: drawSkirmisher,
  scout: drawScout,
  knight: drawKnight,
  ram: drawRam,
  mangonel: drawMangonel,
  scorpion: drawScorpion,
  monk: drawMonk,
};

/**
 * The four unit tables have to agree, and nothing used to check that they did.
 *
 * The failure is silent in every direction. A type in UNIT_DRAW with no
 * UNIT_BOX throws an unhelpful TypeError deep in the bake. A type in UNIT_ANIM
 * with no UNIT_DRAW bakes nothing and renders as a villager. Worst of all, an
 * animation naming a pose that is not in the type's UNIT_POSES list bakes a
 * cycle with a hole in it: render.js falls the missing beat back to the idle
 * frame, so the unit walks, walks, stands, walks — which looks like a physics
 * bug rather than a missing frame, and is why this is a hard error.
 */
function assertUnitArt() {
  const bad = [];
  for (const type of Object.keys(UNIT_DRAW)) {
    if (!UNIT_BOX[type]) bad.push(`${type}: in UNIT_DRAW with no UNIT_BOX`);
    if (!UNIT_POSES[type]) bad.push(`${type}: in UNIT_DRAW with no UNIT_POSES`);
    if (!UNIT_ANIM[type]) bad.push(`${type}: in UNIT_DRAW with no UNIT_ANIM`);
  }
  for (const type of Object.keys(UNIT_ANIM)) {
    if (!UNIT_DRAW[type]) bad.push(`${type}: animated but never drawn`);
    const poses = new Set(UNIT_POSES[type] || []);
    for (const [state, seq] of Object.entries(UNIT_ANIM[type] || {})) {
      for (const id of seq) {
        if (!POSE[id]) bad.push(`${type}.${state}: pose '${id}' is not in POSE`);
        else if (!poses.has(id)) bad.push(`${type}.${state}: pose '${id}' is never baked`);
      }
    }
  }
  if (bad.length) throw new Error(`[gfx] unit art tables disagree — ${bad.join('; ')}`);
}

function buildUnits(put) {
  assertUnitArt();
  for (let p = 0; p < PLAYER_COLORS.length; p++) {
    const col = PLAYER_COLORS[p];
    const dark = PLAYER_COLORS_DARK[p];
    for (const type of Object.keys(UNIT_DRAW)) {
      const box = UNIT_BOX[type];
      const draw = UNIT_DRAW[type];
      const poses = UNIT_POSES[type];
      for (const id of poses) {
        const P = POSE[id];
        for (const back of [false, true]) {
          put(unitFrame(type, p, back, id), box.w, box.h, box.cx, box.ft, (g) => {
            // Every unit stands on the ground now. The team ellipse the renderer
            // puts under a unit is drawn *below* the body sprite, so a shadow
            // baked here lands on top of it — which is why this is a very soft,
            // very wide wash rather than a hard ellipse: it has to read as the
            // body occluding the light without dirtying the coloured disc that
            // makes the unit findable in the first place. A dead unit gets none
            // of it, because the renderer rotates the whole sprite flat about
            // its feet and a shadow that rotates with the body is a black wing.
            if (!P.dead) {
              contactShadow(g, box.cx + P.bx * 0.4, box.ft - 1,
                box.w * 0.42, box.h * 0.11, 0.85);
            }
            draw(g, col, dark, back, P);
          });
        }
      }
    }
  }
}

// --- pose primitives --------------------------------------------------------

/** A rotation about (ox, oy), as a point mapper. Used to swing weapons. */
function pivot(ox, oy, ang) {
  const s = Math.sin(ang);
  const c = Math.cos(ang);
  return (x, y) => ({
    x: ox + (x - ox) * c - (y - oy) * s,
    y: oy + (x - ox) * s + (y - oy) * c,
  });
}

/** Outlined stroke: the dark line first, the colour inside it. */
function stick(g, ax, ay, bx, by, w, col) {
  g.lineStyle(w + 2.2, OUT, 1);
  g.beginPath();
  g.moveTo(ax, ay);
  g.lineTo(bx, by);
  g.strokePath();
  g.lineStyle(w, col, 1);
  g.beginPath();
  g.moveTo(ax, ay);
  g.lineTo(bx, by);
  g.strokePath();
}

/**
 * Two legs swung by the pose. Drawn as outlined limbs with a boot on the end
 * rather than as the pair of upright rectangles this used to be: a rectangle
 * cannot swing, and the swing is most of what says "this unit is moving".
 */
function legPair(g, cx, ft, col, P, w = 4.6, len = 12) {
  const hipY = ft - len;
  const boot = 0x3b2c1c;
  // Back leg first so the near one overlaps it at the hip.
  const order = P.la >= P.lb ? [[-1, P.lb], [1, P.la]] : [[1, P.la], [-1, P.lb]];
  for (const [side, ang] of order) {
    const hx = cx + side * (w * 0.55);
    const fx = hx + Math.sin(ang) * len;
    const fy = hipY + Math.cos(ang) * len;
    stick(g, hx, hipY, fx, fy, w, col);
    g.fillStyle(OUT, 1);
    g.fillEllipse(fx + Math.sin(ang) * 1.5, fy + 0.6, w + 4.4, 5.4);
    g.fillStyle(boot, 1);
    g.fillEllipse(fx + Math.sin(ang) * 1.5, fy + 0.2, w + 2.8, 4);
  }
}

function head(g, x, y, r, back) {
  g.fillStyle(SKIN, 1);
  g.fillCircle(x, y, r);
  g.lineStyle(1.6, OUT, 1);
  g.strokeCircle(x, y, r);
  if (!back) {
    g.fillStyle(OUT, 1);
    g.fillCircle(x - 2, y - 0.3, 1);
    g.fillCircle(x + 2, y - 0.3, 1);
  }
}

// Villager: small, narrow shoulders, straw hat, carries a tool. Reads as
// "civilian" purely from silhouette.
function drawVillager(g, col, dark, back, P) {
  const { cx, ft } = UNIT_BOX.villager;
  const LINEN = 0xe6d7b2;
  const bx = cx + P.bx;
  const by = ft + P.by;

  legPair(g, cx, ft, 0x7a5c3b, P);

  // torso
  g.fillStyle(LINEN, 1);
  g.fillRoundedRect(bx - 9, by - 31, 18, 20, 4);
  g.fillStyle(col, 1);
  g.fillRoundedRect(bx - 9, by - 31, 18, 8, 4); // team yoke
  g.fillStyle(dark, 1);
  g.fillRect(bx - 9, by - 17, 18, 3.5); // belt
  g.lineStyle(2, OUT, 1);
  g.strokeRoundedRect(bx - 9, by - 31, 18, 20, 4);

  // off arm — trails the swing, so the whole body reads as one motion
  const offA = -P.swing * 0.45;
  const oh = { x: bx - 10.3, y: by - 16.5 };
  const R0 = pivot(bx - 10, by - 28, offA);
  const oe = R0(oh.x, oh.y);
  stick(g, bx - 10, by - 28, oe.x, oe.y, 4, LINEN);
  g.fillStyle(SKIN, 1);
  g.fillCircle(oe.x, oe.y, 2.4);

  head(g, bx, by - 36, 5.5, back);

  // straw hat
  g.fillStyle(0xdcb45f, 1);
  g.fillEllipse(bx, by - 38.6, back ? 19 : 17, 6);
  g.fillEllipse(bx, by - 41.4, 10, 7);
  g.lineStyle(1.5, OUT, 1);
  g.strokeEllipse(bx, by - 38.6, back ? 19 : 17, 6);
  if (!back) g.strokeEllipse(bx, by - 41.4, 10, 7);

  if (back) {
    // shoulder pack, so the back pose is not just a faceless front pose
    g.fillStyle(0xb08b57, 1);
    g.fillRoundedRect(bx - 6, by - 28, 12, 11, 3);
    g.lineStyle(1.6, OUT, 1);
    g.strokeRoundedRect(bx - 6, by - 28, 12, 11, 3);
  }

  // axe, swung about the hand
  const hx = bx + 7;
  const hy = by - 18;
  const R = pivot(hx, hy, P.swing);
  const tip = R(bx + 12.5, by - 37);
  stick(g, hx, hy, tip.x, tip.y, 2.6, WOOD);
  const axe = [R(bx + 9.5, by - 40), R(bx + 17, by - 36.5), R(bx + 11.5, by - 33)];
  g.fillStyle(STEEL, 1);
  g.fillPoints(axe, true, true);
  g.lineStyle(1.6, OUT, 1);
  g.strokePoints(axe, true, true);
  g.fillStyle(SKIN, 1);
  g.fillCircle(hx, hy, 2.4);
}

// Militia: broad, helmeted, round shield left, sword raised right.
function drawMilitia(g, col, dark, back, P) {
  const { cx, ft } = UNIT_BOX.militia;
  const bx = cx + P.bx;
  const by = ft + P.by;

  legPair(g, cx, ft, MAIL_D, P, 5.4, 13);

  // Torso — a mail hauberk under a steel breastplate. It used to be a flat
  // rectangle of team colour with a small steel plate on it, which is most of
  // why the militia, the spearman and the archer were the same blue lump: a
  // body is the biggest field on a figure and it must be made of something.
  // Mail is drawn as three values plus a stipple of rings, because a single
  // grey rounded rectangle is only a different flat colour, not a different
  // material.
  g.fillStyle(MAIL, 1);
  g.fillRoundedRect(bx - 12, by - 34, 24, 23, 5);
  g.fillStyle(dim(MAIL), 1);
  g.fillRoundedRect(bx - 12, by - 34, 9, 23, 5);
  g.fillStyle(lit(MAIL), 1);
  g.fillRoundedRect(bx + 6, by - 33, 6, 21, 4);
  g.lineStyle(0.9, MAIL_D, 0.55);
  for (let r = 0; r < 5; r++) {
    g.beginPath();
    g.moveTo(bx - 11, by - 31 + r * 4.2);
    g.lineTo(bx + 11, by - 31 + r * 4.2);
    g.strokePath();
  }
  g.fillStyle(STEEL, 1);
  g.fillRoundedRect(bx - 7, by - 27, 14, 12, 3); // breastplate
  g.fillStyle(lit(STEEL), 1);
  g.fillRoundedRect(bx + 1, by - 26, 5, 10, 2);
  g.fillStyle(STEEL_D, 1);
  g.fillRect(bx - 7, by - 17, 14, 2.5);
  // The livery band: one strip of surcoat across the chest, under the plate.
  // A strip reads as a uniform; a field reads as paint.
  g.fillStyle(col, 1);
  g.fillRect(bx - 12, by - 33.5, 24, 5);
  g.fillStyle(dark, 1);
  g.fillRect(bx - 12, by - 29.5, 24, 1.6);
  g.lineStyle(2.2, OUT, 1);
  g.strokeRoundedRect(bx - 12, by - 34, 24, 23, 5);
  g.strokeRoundedRect(bx - 7, by - 27, 14, 12, 3);
  rimLine(g, bx + 11, by - 31, bx + 11, by - 13, 1.5, 0.45);

  head(g, bx, by - 39, 5.5, back);

  // helmet: dome + face slit
  g.fillStyle(STEEL, 1);
  g.fillEllipse(bx, by - 41, 15, 13);
  g.fillRect(bx - 7.5, by - 41, 15, 4);
  g.lineStyle(1.8, OUT, 1);
  g.strokeEllipse(bx, by - 41, 15, 13);
  if (!back) {
    g.fillStyle(OUT, 1);
    g.fillRect(bx - 5, by - 38.5, 10, 2.4);
    g.fillRect(bx - 1.2, by - 39.5, 2.4, 5);
  }
  // team plume
  g.fillStyle(col, 1);
  g.fillEllipse(bx, by - 47.5, 6, 9);
  g.lineStyle(1.5, OUT, 1);
  g.strokeEllipse(bx, by - 47.5, 6, 9);

  // Shield (front pose: at the side; back pose: slung across the back). It
  // pushes forward as the sword comes back, which is how a guard reads.
  //
  // A round steel-rimmed board, half team colour and half limewashed white,
  // with a steel boss in the middle. Painted all over in the team's colour —
  // which is what it used to be — this disc alone was a tenth of the whole
  // figure, and it is the reason a militia and a skirmisher across a battle
  // read as the same object: two blobs of the same blue at the same height.
  const sx = (back ? bx : bx - 13.5) - P.swing * 1.6;
  const sy = (back ? by - 25 : by - 24);
  const sr = back ? 9.5 : 9;
  const board = ellipsePts(sx, sy, sr, sr);
  g.fillStyle(OUT, 1);
  g.fillCircle(sx, sy, sr + 1.4);
  shieldFace(g, board, sx, sy, col, 0xe8e2d2);
  g.lineStyle(2.4, OUT, 1);
  g.strokeCircle(sx, sy, sr);
  g.fillStyle(STEEL_D, 1);
  g.fillCircle(sx, sy, 3.4);
  g.fillStyle(STEEL, 1);
  g.fillCircle(sx + 0.7, sy - 0.7, 2.2);
  g.lineStyle(1.4, OUT, 1);
  g.strokeCircle(sx, sy, 3.4);
  g.lineStyle(1.4, STEEL_D, 0.9);
  g.strokeCircle(sx, sy, sr - 1.6);

  // sword, swung about the fist
  const hx = bx + 12;
  const hy = by - 27;
  const R = pivot(hx, hy, P.swing);
  const tip = R(bx + 17, by - 45);
  const g0 = R(bx + 8.5, by - 27.5);
  const g1 = R(bx + 15.5, by - 25.5);
  stick(g, hx, hy, tip.x, tip.y, 3.2, STEEL);
  stick(g, g0.x, g0.y, g1.x, g1.y, 1.8, 0xd8a840);
}

/**
 * Spearman. Same helmet and tunic family as the militia — a spearman is the
 * militia line's cousin and should group with it — with one silhouette cue
 * doing all the work: a shaft taller than the man, held at an angle, with a
 * visible leaf point. The attack is a *thrust* rather than a swing, which is
 * both what a spear does and what tells the two units apart in a melee.
 */
function drawSpearman(g, col, dark, back, P) {
  const { cx, ft } = UNIT_BOX.spearman;
  const bx = cx + P.bx;
  const by = ft + P.by;

  legPair(g, cx, ft, LEATHER_D, P, 5, 13);

  // Butt of the spear passes behind the body. The wind-up is a short draw and
  // the thrust is a long one, deliberately: pulling the shaft back far enough
  // to balance the lunge buries the point behind the man's own head, and the
  // point is the entire silhouette.
  const push = P.swing * (P.swing < 0 ? 4.5 : 13);
  const sx0 = bx - 9 + push;
  const sy0 = by - 4 + push * 0.28;
  const sx1 = bx + 12 + push;
  const sy1 = by - 50 + push * 0.28;

  stick(g, sx0, sy0, sx1, sy1, 2.8, WOOD);

  // Torso — a quilted gambeson in undyed linen, which is what a cheap
  // spearman actually wore and, much more to the point here, what makes him a
  // DIFFERENT COLOUR from the militia beside him. He used to be the same
  // rounded rectangle of team colour with horizontal lines ruled across it, and
  // at play zoom the lines are invisible: two units, one blue lump each.
  // The quilting is drawn as alternating raised and sunken bands rather than as
  // ruled lines, so it survives being shrunk to a fifth of this size.
  g.fillStyle(GAMBESON, 1);
  g.fillRoundedRect(bx - 10, by - 33, 20, 22, 5);
  g.fillStyle(dim(GAMBESON), 1);
  g.fillRoundedRect(bx - 10, by - 33, 8, 22, 5);
  for (let i = 0; i < 4; i++) {
    g.fillStyle(shade(GAMBESON_D, 0.1), 0.75);
    g.fillRect(bx - 10, by - 31 + i * 5.2, 20, 2.2);
  }
  g.fillStyle(LEATHER_D, 1);
  g.fillRect(bx - 10, by - 17, 20, 3.2);
  g.lineStyle(2.2, OUT, 1);
  g.strokeRoundedRect(bx - 10, by - 33, 20, 22, 5);
  rimLine(g, bx + 9, by - 31, bx + 9, by - 13, 1.5, 0.45);
  // The livery: a diagonal sash from the shoulder to the belt. One strip, on
  // the sunward side, where the spear arm does not cross it.
  g.fillStyle(col, 1);
  g.fillPoints([
    { x: bx - 8, y: by - 33 }, { x: bx - 2.5, y: by - 33 },
    { x: bx + 10, y: by - 18 }, { x: bx + 10, y: by - 23.5 },
  ], true, true);
  g.fillStyle(dark, 1);
  g.fillPoints([
    { x: bx - 5, y: by - 33 }, { x: bx - 2.5, y: by - 33 },
    { x: bx + 10, y: by - 18 }, { x: bx + 10, y: by - 20.5 },
  ], true, true);

  head(g, bx, by - 38, 5.4, back);

  // kettle hat: a wide brim, against the militia's smooth dome
  g.fillStyle(STEEL, 1);
  g.fillEllipse(bx, by - 41.5, 12, 10);
  g.fillEllipse(bx, by - 39, 20, 5.5);
  g.fillStyle(lit(STEEL), 1);
  g.fillEllipse(bx + 3, by - 42.5, 5, 4);
  g.lineStyle(1.8, OUT, 1);
  g.strokeEllipse(bx, by - 41.5, 12, 10);
  g.strokeEllipse(bx, by - 39, 20, 5.5);

  // Both hands on the shaft.
  g.fillStyle(SKIN, 1);
  g.fillCircle(bx - 3.5 + push, by - 20 + push * 0.28, 2.6);
  g.fillCircle(bx + 5 + push, by - 33 + push * 0.28, 2.6);
  g.lineStyle(1.2, OUT, 1);
  g.strokeCircle(bx - 3.5 + push, by - 20 + push * 0.28, 2.6);
  g.strokeCircle(bx + 5 + push, by - 33 + push * 0.28, 2.6);

  // The point: a long steel leaf with a collar, the tallest thing on the unit.
  const ux = (sx1 - sx0);
  const uy = (sy1 - sy0);
  const ul = Math.hypot(ux, uy) || 1;
  const nx = ux / ul;
  const ny = uy / ul;
  const px = -ny;
  const py = nx;
  const tipX = sx1 + nx * 9;
  const tipY = sy1 + ny * 9;
  const leaf = [
    { x: tipX, y: tipY },
    { x: sx1 + px * 3.4, y: sy1 + py * 3.4 },
    { x: sx1 - nx * 3, y: sy1 - ny * 3 },
    { x: sx1 - px * 3.4, y: sy1 - py * 3.4 },
  ];
  g.fillStyle(STEEL, 1);
  g.fillPoints(leaf, true, true);
  g.fillStyle(lit(STEEL), 1);
  g.fillPoints([leaf[0], leaf[1], leaf[2]], true, true);
  g.lineStyle(1.7, OUT, 1);
  g.strokePoints(leaf, true, true);

  // The pennon, knotted to the shaft just under the collar and streaming back.
  //
  // This is where the spearman's whole team colour lives now, and it is the
  // best place on any foot soldier to put it: forty-eight pixels above the
  // ground, clear of every body in the melee, on the one part of the sprite
  // that is already the unit's identity. A blue tunic in a press of bodies is
  // one more blue tunic; a blue flag on a stick above the press is visible from
  // the other side of the screen, and it says "spear line" at the same time as
  // it says "mine".
  //
  // WHERE IT IS TIED matters more than what it looks like. The first attempt
  // knotted it seven pixels below the collar and let it hang nine pixels down
  // the shaft, which put the whole flag on top of the kettle hat: at play size
  // the spearman came out wearing a blue bonnet. It is tied four pixels below
  // the collar now and streams UP the shaft, so every pixel of it sits above
  // the crown of the helmet with clear sky behind it.
  const cX = sx1 - nx * 4;
  const cY = sy1 - ny * 4;
  const flag = [
    { x: cX, y: cY },
    { x: cX - px * 12 + nx * 1, y: cY - py * 12 + ny * 1 },
    { x: cX - px * 10 + nx * 4.5, y: cY - py * 10 + ny * 4.5 },
    { x: cX + nx * 3.5, y: cY + ny * 3.5 },
  ];
  g.fillStyle(col, 1);
  g.fillPoints(flag, true, true);
  g.fillStyle(dark, 1);
  g.fillPoints([flag[1], flag[2], {
    x: cX - px * 5 + nx * 2, y: cY - py * 5 + ny * 2,
  }], true, true);
  g.lineStyle(1.4, OUT, 1);
  g.strokePoints(flag, true, true);
  g.fillStyle(LEATHER_D, 1);
  g.fillCircle(cX, cY, 1.8);
}

// Archer. The old one was a coloured body with a 1px bow line and vanished
// next to the militia at 1x. Three things carry it now, and each of them is
// legible on its own: a bow arc taller than the archer's own head, a fan of
// fletched arrows over the right shoulder, and a hood with a sharp forward
// peak (against the militia's round helmet dome).
function drawArcher(g, col, dark, back, P) {
  const { cx, ft } = UNIT_BOX.archer;
  const bx = cx + P.bx;
  const by = ft + P.by;
  // How far the string is pulled. Only a wound-up pose draws it: an archer
  // standing about, or walking, carries the bow slack with nothing nocked, and
  // the difference between that and the drawn bow is what makes a volley
  // visible from across the map.
  const drawn = Math.max(0, Math.min(1, -P.swing));

  legPair(g, cx, ft, LEATHER_D, P, 4.2, 12);

  // --- quiver, behind the body ---------------------------------------------
  // The fletchings are team coloured. Four little flecks is a tiny amount of
  // paint and it lands in the one place the eye is already going — the fan of
  // arrows is half the archer's silhouette — so it buys ownership at almost no
  // cost to the budget.
  const qx = bx + 9;
  const qy = by - 32;
  for (let i = 0; i < 4; i++) {
    const a = -0.5 + i * 0.22;
    const tipX = qx + Math.sin(a) * 17;
    const tipY = qy - Math.cos(a) * 17;
    stick(g, qx, qy, tipX, tipY, 1.7, WOOD);
    g.fillStyle(OUT, 1);
    g.fillCircle(tipX, tipY, 2.8);
    g.fillStyle(i % 2 ? col : 0xf2ecda, 1);
    g.fillCircle(tipX, tipY, 1.8);
  }
  g.fillStyle(LEATHER, 1);
  g.fillRoundedRect(qx - 5, qy - 6, 10, 21, 3);
  g.lineStyle(1.9, OUT, 1);
  g.strokeRoundedRect(qx - 5, qy - 6, 10, 21, 3);
  g.fillStyle(shade(LEATHER, 0.3), 1);
  g.fillRect(qx - 5, qy + 3, 10, 3);

  // --- slim tunic, in forest cloth -----------------------------------------
  // Not team colour. An archer painted in the team's colour from the knees to
  // the crown of the hood is a coloured blob with a wire arc beside it, and the
  // arc — which is the entire identity of the unit — is the first thing that
  // gets lost against it. Dressed in a green that belongs to the woodline, the
  // bow reads as a separate object and the archer reads as an archer.
  g.fillStyle(FOREST, 1);
  g.fillRoundedRect(bx - 7.5, by - 31, 15, 20, 4);
  g.fillStyle(dim(FOREST), 1);
  g.fillRoundedRect(bx - 7.5, by - 31, 6, 20, 3);
  g.fillStyle(LEATHER_D, 1);
  g.fillRect(bx - 7.5, by - 16, 15, 3.2);
  g.lineStyle(2, OUT, 1);
  g.strokeRoundedRect(bx - 7.5, by - 31, 15, 20, 4);
  rimLine(g, bx + 6.5, by - 29, bx + 6.5, by - 18, 1.4, 0.4);
  // The livery: a chevron across the chest, pointing up. It sits above the
  // belt and below the cape, which is the only band of tunic the baldric, the
  // bow arm and the quiver all leave clear.
  g.fillStyle(col, 1);
  g.fillPoints([
    { x: bx - 7.5, y: by - 22 }, { x: bx, y: by - 27 },
    { x: bx + 7.5, y: by - 22 }, { x: bx + 7.5, y: by - 18.5 },
    { x: bx, y: by - 23.5 }, { x: bx - 7.5, y: by - 18.5 },
  ], true, true);
  // quiver baldric, corner to corner across the chest
  g.lineStyle(3.4, LEATHER, 1);
  g.beginPath();
  g.moveTo(bx - 7, by - 18);
  g.lineTo(bx + 7.5, by - 30);
  g.strokePath();
  g.lineStyle(0.9, shade(LEATHER, 0.35), 0.8);
  g.beginPath();
  g.moveTo(bx - 7, by - 19);
  g.lineTo(bx + 7.5, by - 31);
  g.strokePath();

  head(g, bx, by - 35, 5.2, back);

  // --- hood with a forward peak --------------------------------------------
  const hood = [
    { x: bx - 8.5, y: by - 32 },
    { x: bx - 10, y: by - 40 },
    { x: bx - 3.5, y: by - 47.5 },
    { x: bx + 5, y: by - 43.5 },
    { x: bx + 8.5, y: by - 36 },
    { x: bx + 7.5, y: by - 31 },
  ];
  g.fillStyle(back ? FOREST : FOREST_D, 1);
  g.fillPoints(hood, true, true);
  g.fillStyle(lit(FOREST), 1);
  g.fillPoints([hood[2], hood[3], hood[4], { x: bx + 1, y: by - 40 }], true, true);
  g.lineStyle(2, OUT, 1);
  g.strokePoints(hood, true, true);
  // shoulder cape, so the hood does not float
  const cape = [
    { x: bx - 10, y: by - 30 },
    { x: bx - 7.5, y: by - 34.5 },
    { x: bx + 7.5, y: by - 34.5 },
    { x: bx + 10, y: by - 30 },
  ];
  g.fillStyle(back ? FOREST : FOREST_D, 1);
  g.fillPoints(cape, true, true);
  // A band of team colour along the cape's lower edge. High on the body,
  // horizontal, and never covered by the bow arm.
  g.fillStyle(col, 1);
  g.fillPoints([
    cape[0], cape[3], { x: cape[3].x - 0.8, y: cape[3].y - 2.6 },
    { x: cape[0].x + 0.8, y: cape[0].y - 2.6 },
  ], true, true);
  g.lineStyle(1.7, OUT, 1);
  g.strokePoints(cape, true, true);
  if (!back) {
    g.fillStyle(SKIN, 1);
    g.fillEllipse(bx - 0.5, by - 35.5, 9.5, 7.5);
    g.fillStyle(OUT, 1);
    g.fillCircle(bx - 2.6, by - 36, 1.1);
    g.fillCircle(bx + 1.8, by - 36, 1.1);
  }

  // --- bow, in front of everything -----------------------------------------
  // Tall enough that the arc alone identifies the unit in a mixed crowd. The
  // bow arm straightens as the string is drawn, so a firing archer leans into
  // the shot rather than holding one shape for the whole cooldown.
  const bowX = bx - 10 - drawn * 2.5;
  const bowY = by - 27;
  const r = 16;
  const a0 = Math.PI * 0.58;
  const a1 = Math.PI * 1.42;
  const e0 = { x: bowX + Math.cos(a0) * r, y: bowY + Math.sin(a0) * r };
  const e1 = { x: bowX + Math.cos(a1) * r, y: bowY + Math.sin(a1) * r };
  g.lineStyle(6.2, OUT, 1);
  g.beginPath();
  g.arc(bowX, bowY, r, a0, a1, false);
  g.strokePath();
  g.lineStyle(3.4, WOOD, 1);
  g.beginPath();
  g.arc(bowX, bowY, r, a0, a1, false);
  g.strokePath();
  g.lineStyle(1.6, shade(WOOD, 0.3), 0.8);
  g.beginPath();
  g.arc(bowX, bowY, r + 1, a0 + 0.25, a1 - 0.25, false);
  g.strokePath();
  // horn nocks at the limb tips
  g.fillStyle(OUT, 1);
  g.fillCircle(e0.x, e0.y, 2.4);
  g.fillCircle(e1.x, e1.y, 2.4);
  // grip
  g.fillStyle(0x3c2b16, 1);
  g.fillRect(bowX - r - 2.5, bowY - 4, 5.5, 8);
  g.lineStyle(1.4, OUT, 1);
  g.strokeRect(bowX - r - 2.5, bowY - 4, 5.5, 8);
  // The string runs between the limb tips — a straight chord at rest, and a V
  // pulled back to the hand while the bow is drawn.
  const nock = { x: bowX + Math.cos(a0) * r + drawn * 13, y: bowY };
  g.lineStyle(2.4, OUT, 0.55);
  g.beginPath();
  g.moveTo(e0.x, e0.y);
  g.lineTo(nock.x, nock.y);
  g.lineTo(e1.x, e1.y);
  g.strokePath();
  g.lineStyle(1.3, 0xf4eedd, 1);
  g.beginPath();
  g.moveTo(e0.x, e0.y);
  g.lineTo(nock.x, nock.y);
  g.lineTo(e1.x, e1.y);
  g.strokePath();
  if (drawn > 0.35) {
    // The nocked arrow, only while there is one on the string. It reaches past
    // the grip, which is what says the bow is at full draw.
    stick(g, bowX - r - 3, bowY - 1, nock.x + 2, bowY - 1, 1.3, 0xd8b070);
    g.fillStyle(0xe6ebf0, 1);
    g.fillTriangle(bowX - r - 3, bowY - 3.6, bowX - r - 9, bowY - 1, bowX - r - 3, bowY + 1.6);
    g.lineStyle(1.2, OUT, 1);
    g.strokeTriangle(bowX - r - 3, bowY - 3.6, bowX - r - 9, bowY - 1, bowX - r - 3, bowY + 1.6);
  }
  // draw hand on the string
  g.fillStyle(SKIN, 1);
  g.fillCircle(nock.x + 1.5, nock.y, 2.6);
  g.lineStyle(1.2, OUT, 1);
  g.strokeCircle(nock.x + 1.5, nock.y, 2.6);
}

/**
 * Scout Cavalry — a horse, first and last.
 *
 * Four legs and a long barrel: this is the only unit wider than it is tall, and
 * that is the read. The rider sits small and low so the horse keeps the
 * silhouette, and the team colour lives on the rider's surcoat and the saddle
 * cloth rather than on the animal, because a blue horse is a toy and a blue
 * blanket on a bay horse is a livery.
 */
function drawScout(g, col, dark, back, P) {
  const { cx, ft } = UNIT_BOX.scout;
  const HIDE = HORSE_BAY;
  const HIDE_D = HORSE_BAY_D;
  const MANE = 0x35251a;
  const bx = cx + P.bx;
  const by = ft + P.by;
  // Fore and hind legs swing in opposition, which is what a canter looks like
  // from the side and costs nothing extra to say.
  const legs = [
    { x: bx - 13, a: P.la },
    { x: bx - 9, a: P.lb * 0.8 },
    { x: bx + 10, a: -P.lb },
    { x: bx + 14, a: -P.la * 0.8 },
  ];
  const hipY = by - 14;
  for (const l of legs) {
    const fx = l.x + Math.sin(l.a) * 14;
    const fy = hipY + Math.cos(l.a) * 14;
    stick(g, l.x, hipY, fx, fy, 4, l.x > bx ? HIDE : HIDE_D);
    g.fillStyle(OUT, 1);
    g.fillEllipse(fx, fy + 1, 7.5, 4.6);
    g.fillStyle(0x2c2019, 1);
    g.fillEllipse(fx, fy + 0.6, 5.5, 3.2);
  }

  // Barrel and hindquarters.
  g.fillStyle(HIDE, 1);
  g.fillRoundedRect(bx - 17, by - 27, 34, 15, 7);
  g.fillStyle(HIDE_D, 1);
  g.fillRoundedRect(bx - 17, by - 17, 34, 5, 3);
  g.lineStyle(2.2, OUT, 1);
  g.strokeRoundedRect(bx - 17, by - 27, 34, 15, 7);
  g.fillStyle(shade(HIDE, 0.18), 1);
  g.fillRoundedRect(bx - 12, by - 26, 22, 4, 2);

  // Tail, streaming behind the near hip. Drawn as three tapering strands
  // rather than one bar: a single thick line off the back of a horse reads as
  // a plank nailed to it.
  for (let k = 0; k < 3; k++) {
    const spread = (k - 1) * 2.4;
    stick(g, bx - 16, by - 25,
      bx - 22 - k * 1.6 + P.la * 2, by - 14 + spread, 2.2 - k * 0.4, MANE);
  }

  // Neck and head, up and forward. Drawn last on the near side so the head
  // never disappears behind the rider.
  const neckX = bx + 15;
  const neckY = by - 25;
  const headX = neckX + 8;
  const headY = neckY - 12;
  stick(g, neckX, neckY, headX, headY, 7.5, HIDE);
  g.fillStyle(HIDE, 1);
  g.fillRoundedRect(headX - 4, headY - 6, 13, 8, 3);
  g.lineStyle(1.9, OUT, 1);
  g.strokeRoundedRect(headX - 4, headY - 6, 13, 8, 3);
  g.fillStyle(OUT, 1);
  g.fillTriangle(headX - 3, headY - 6, headX - 1, headY - 12, headX + 1.5, headY - 6);
  if (!back) {
    g.fillStyle(OUT, 1);
    g.fillCircle(headX + 2, headY - 2.6, 1.2);
  }
  // Mane along the neck.
  g.lineStyle(3.4, MANE, 1);
  g.beginPath();
  g.moveTo(neckX - 1, neckY - 2);
  g.lineTo(headX - 2, headY - 4);
  g.strokePath();

  // Saddle cloth, then the rider.
  const rx = bx - 1;
  const ry = by - 26;
  g.fillStyle(dark, 1);
  g.fillPoints([
    { x: rx - 10, y: ry }, { x: rx + 10, y: ry },
    { x: rx + 7, y: ry + 9 }, { x: rx - 7, y: ry + 9 },
  ], true, true);
  g.lineStyle(1.6, OUT, 1);
  g.strokePoints([
    { x: rx - 10, y: ry }, { x: rx + 10, y: ry },
    { x: rx + 7, y: ry + 9 }, { x: rx - 7, y: ry + 9 },
  ], true, true);

  // Rider legs, one visible, gripping the barrel.
  stick(g, rx + 1, ry - 4, rx + 3, ry + 6, 3.6, 0x5a4a38);
  // Rider torso: a leather riding coat, not a team-coloured jersey. The scout
  // and the knight stand next to each other constantly and the pair have to
  // separate at a glance — a man in soft leather on a bay pony against a man in
  // plate on a grey destrier does that far harder than "the same rider, bigger".
  g.fillStyle(LEATHER, 1);
  g.fillRoundedRect(rx - 6, ry - 19, 13, 16, 4);
  g.fillStyle(dim(LEATHER), 1);
  g.fillRoundedRect(rx - 6, ry - 19, 5, 16, 3);
  g.fillStyle(shade(LEATHER, 0.2), 1);
  g.fillRoundedRect(rx - 6, ry - 19, 13, 4, 3);
  // One band of livery across the chest, and a second on the shoulder.
  g.fillStyle(col, 1);
  g.fillRect(rx - 6, ry - 14, 13, 4.4);
  g.fillStyle(dark, 1);
  g.fillRect(rx - 6, ry - 10.4, 13, 1.4);
  g.lineStyle(2, OUT, 1);
  g.strokeRoundedRect(rx - 6, ry - 19, 13, 16, 4);
  rimLine(g, rx + 6, ry - 17, rx + 6, ry - 5, 1.3, 0.4);
  head(g, rx, ry - 24, 4.6, back);
  // A skullcap rather than a full helm: at this size a helmet as big as the
  // head turns the rider into a featureless ball, and the rider's job is to be
  // small enough that the horse keeps the silhouette.
  g.fillStyle(STEEL, 1);
  g.fillEllipse(rx, ry - 26.4, 10.5, 7.5);
  g.lineStyle(1.5, OUT, 1);
  g.strokeEllipse(rx, ry - 26.4, 10.5, 7.5);
  g.fillStyle(col, 1);
  g.fillTriangle(rx - 1, ry - 30, rx + 8, ry - 28.5, rx - 1, ry - 26.5);
  g.lineStyle(1.2, OUT, 1);
  g.strokeTriangle(rx - 1, ry - 30, rx + 8, ry - 28.5, rx - 1, ry - 26.5);

  // Sabre, swung about the rider's fist: a guard, then a blade that bends
  // back, so it is a cavalry sword and not a length of pipe.
  const hx = rx + 7;
  const hy = ry - 12;
  const R = pivot(hx, hy, P.swing);
  const mid = R(rx + 11, ry - 21);
  const tip = R(rx + 18, ry - 28);
  stick(g, hx, hy, mid.x, mid.y, 2.6, STEEL);
  stick(g, mid.x, mid.y, tip.x, tip.y, 2.2, STEEL);
  const guard0 = R(rx + 3.5, ry - 13);
  const guard1 = R(rx + 10.5, ry - 11);
  stick(g, guard0.x, guard0.y, guard1.x, guard1.y, 1.6, 0xd8a840);
  g.fillStyle(SKIN, 1);
  g.fillCircle(hx, hy, 2.4);
}

/**
 * Battering ram — a machine, and it must never read as "a big soldier".
 *
 * A low timber frame on four wheels, a pitched shed roof of planks over it, and
 * a suspended log swinging on two ropes. No head, no limbs, no team-coloured
 * tunic: ownership is a pennant on the roof ridge, which is the only place on
 * this unit team colour can go without making it look like a person in a
 * uniform. The `swing` pose slides the log along its own axis, so the attack is
 * a battering stroke rather than a swung arm.
 */
function drawRam(g, col, dark, back, P) {
  const { cx, ft } = UNIT_BOX.ram;
  const FRAME = 0x7a5630;
  const FRAME_D = 0x54391e;
  const PLANK = 0x8f6737;
  const bx = cx + P.bx;
  const by = ft + P.by;

  // Wheels. They turn with the walk pose, which is the only way a machine can
  // say "I am moving" — there are no legs to swing.
  const spin = P.la * 1.6;
  for (const [wx0, wy0, rr] of [[bx - 20, by - 6, 7], [bx + 18, by - 6, 7.5]]) {
    g.fillStyle(OUT, 1);
    g.fillCircle(wx0, wy0, rr + 1.6);
    g.fillStyle(FRAME_D, 1);
    g.fillCircle(wx0, wy0, rr);
    g.fillStyle(shade(FRAME, 0.12), 1);
    g.fillCircle(wx0, wy0, rr * 0.4);
    g.lineStyle(1.6, OUT, 0.85);
    for (let k = 0; k < 4; k++) {
      const a = spin + (Math.PI / 4) * k;
      g.beginPath();
      g.moveTo(wx0 - Math.cos(a) * rr, wy0 - Math.sin(a) * rr);
      g.lineTo(wx0 + Math.cos(a) * rr, wy0 + Math.sin(a) * rr);
      g.strokePath();
    }
  }

  // Chassis beam.
  g.fillStyle(FRAME_D, 1);
  g.fillRect(bx - 24, by - 14, 48, 6);
  g.lineStyle(2, OUT, 1);
  g.strokeRect(bx - 24, by - 14, 48, 6);

  // The log, suspended and sliding along its axis with the swing.
  const push = P.swing * 11;
  const logY = by - 22;
  const lx0 = bx - 20 + push;
  const lx1 = bx + 22 + push;
  g.lineStyle(1.8, OUT, 0.8);
  for (const rxp of [bx - 12, bx + 10]) {
    g.beginPath();
    g.moveTo(rxp, by - 36);
    g.lineTo(rxp + push * 0.5, logY - 3);
    g.strokePath();
  }
  g.fillStyle(OUT, 1);
  g.fillRoundedRect(lx0 - 2, logY - 7.6, (lx1 - lx0) + 4, 15.2, 7);
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(lx0, logY - 6, lx1 - lx0, 12, 6);
  g.fillStyle(WOOD, 1);
  g.fillRoundedRect(lx0 + 2, logY - 5.5, lx1 - lx0 - 6, 5, 2.5);
  if (!back) {
    // Iron head on the striking end. Only from the front: seen from behind the
    // machine, the head is at the far end and what is nearest to the camera is
    // the open tail the crew stands in — see below.
    g.fillStyle(STEEL_D, 1);
    g.fillRoundedRect(lx1 - 9, logY - 6.5, 10, 13, 4);
    g.lineStyle(1.6, OUT, 1);
    g.strokeRoundedRect(lx1 - 9, logY - 6.5, 10, 13, 4);
    g.fillStyle(STEEL, 1);
    g.fillRect(lx1 - 7, logY - 4.5, 6, 3);
  } else {
    // The sawn butt of the log, with the rope collar wound round it. Same
    // object, the other end of it.
    g.fillStyle(shade(WOOD_D, 0.16), 1);
    g.fillEllipse(lx0 + 1, logY, 8, 12);
    g.lineStyle(1.5, OUT, 1);
    g.strokeEllipse(lx0 + 1, logY, 8, 12);
    g.lineStyle(1.4, 0xbca87c, 0.9);
    for (const dy of [-3.5, 0, 3.5]) {
      g.beginPath();
      g.moveTo(lx0 + 3, logY + dy);
      g.lineTo(lx0 + 12, logY + dy);
      g.strokePath();
    }
  }

  // Roof: two rafters and a plank shed, low and broad — this is the whole of
  // the ram's silhouette, and it is deliberately the flattest of the three
  // engines. Nothing stands above the ridge except a short pennant staff.
  const ridgeY = by - 40;
  g.fillStyle(PLANK, 1);
  g.fillPoints([
    { x: bx - 26, y: by - 26 }, { x: bx, y: ridgeY },
    { x: bx + 26, y: by - 26 }, { x: bx + 26, y: by - 22 },
    { x: bx, y: ridgeY + 4 }, { x: bx - 26, y: by - 22 },
  ], true, true);
  g.lineStyle(2.2, OUT, 1);
  g.strokePoints([
    { x: bx - 26, y: by - 26 }, { x: bx, y: ridgeY },
    { x: bx + 26, y: by - 26 }, { x: bx + 26, y: by - 22 },
    { x: bx, y: ridgeY + 4 }, { x: bx - 26, y: by - 22 },
  ], true, true);
  g.lineStyle(1.2, FRAME_D, 0.8);
  for (let k = 1; k <= 3; k++) {
    const t = k / 4;
    g.beginPath();
    g.moveTo(bx - 26 + 26 * t, by - 26 - (by - 26 - ridgeY) * t);
    g.lineTo(bx - 26 + 26 * t, by - 22 - (by - 26 - ridgeY) * t);
    g.strokePath();
  }
  // The painted eave board. A siege engine's share of the colour budget has to
  // be proportionate to its size the same way an infantryman's is — a ram
  // carrying nothing but a twelve-pixel flag is a ram whose owner is a guess,
  // and in a mixed siege line "whose engine is that" is the single most
  // expensive question a player can be unable to answer. A board along the
  // whole eave is the largest flat run on the machine and reads at any zoom.
  g.fillStyle(col, 1);
  g.fillPoints([
    { x: bx - 20, y: by - 26 }, { x: bx + 20, y: by - 26 },
    { x: bx + 20, y: by - 22 }, { x: bx - 20, y: by - 22 },
  ], true, true);
  g.fillStyle(dark, 1);
  g.fillRect(bx - 20, by - 23.4, 40, 1.6);
  g.lineStyle(1.6, OUT, 1);
  g.beginPath();
  g.moveTo(bx - 26, by - 26);
  g.lineTo(bx + 26, by - 26);
  g.strokePath();

  // Uprights, so the roof is carried rather than floating.
  for (const ux of [bx - 22, bx + 20]) {
    g.fillStyle(FRAME, 1);
    g.fillRect(ux - 2.5, by - 26, 5, 13);
    g.lineStyle(1.6, OUT, 1);
    g.strokeRect(ux - 2.5, by - 26, 5, 13);
  }

  if (back) {
    // Seen from behind: the open tail of the shed, with the crew's step under
    // it and a painted tailboard across the top. This is what makes the back
    // drawing a different picture rather than the same one twice — the three
    // engines all used to bake identical front and back rows, which meant an
    // army marching north had its catapults pointing south.
    g.fillStyle(0x241b10, 1);
    g.fillPoints([
      { x: bx - 24, y: by - 24 }, { x: bx - 8, y: by - 24 },
      { x: bx - 8, y: by - 12 }, { x: bx - 24, y: by - 12 },
    ], true, true);
    g.lineStyle(1.8, OUT, 1);
    g.strokePoints([
      { x: bx - 24, y: by - 24 }, { x: bx - 8, y: by - 24 },
      { x: bx - 8, y: by - 12 }, { x: bx - 24, y: by - 12 },
    ], true, true);
    g.fillStyle(col, 1);
    g.fillRect(bx - 24, by - 24, 16, 3.4);
    g.fillStyle(FRAME, 1);
    g.fillRect(bx - 26, by - 12, 20, 3.4);
    g.lineStyle(1.4, OUT, 1);
    g.strokeRect(bx - 26, by - 12, 20, 3.4);
  }

  // Team pennant on the ridge. Short — this engine's job is to be the low one.
  stick(g, bx, ridgeY, bx, ridgeY - 11, 1.8, 0x6a5334);
  g.fillStyle(col, 1);
  g.fillTriangle(bx, ridgeY - 11, bx + 12, ridgeY - 8, bx, ridgeY - 5);
  g.lineStyle(1.4, OUT, 1);
  g.strokeTriangle(bx, ridgeY - 11, bx + 12, ridgeY - 8, bx, ridgeY - 5);
  g.fillStyle(dark, 1);
  g.fillTriangle(bx, ridgeY - 9.4, bx + 6, ridgeY - 8, bx, ridgeY - 6.6);
}

/**
 * Skirmisher — a light infantryman with javelins.
 *
 * The one thing this unit must not do is read as an archer, and the archer's
 * whole identity is an arc. So there is no bow anywhere on it: what it carries
 * is a fist of javelins held upright in the off hand and one cocked back over
 * the shoulder, plus a large oval wicker shield that nothing else on the map
 * has (the militia's is a round steel-bossed disc, half the area). A bundle of
 * vertical sticks on one side and an oval on the other is a different shape
 * from an arc at any size, which is the entire reason the unit is drawn this
 * way rather than as "an archer in cheaper clothes".
 */
function drawSkirmisher(g, col, dark, back, P) {
  const { cx, ft } = UNIT_BOX.skirmisher;
  const WICKER = 0xbe9a5e;
  const JERKIN = 0x77542f;
  // A russet homespun tunic under the jerkin. Not team colour, and not the
  // spearman's oat linen or the archer's forest green either: the four foot
  // soldiers are told apart by material before anything else, and four
  // distinguishable cloths is the cheapest way to buy that.
  const TUNIC = 0xa8724a;
  const bx = cx + P.bx;
  const by = ft + P.by;
  // How far back the throwing arm is cocked. Only a wound-up pose shows it;
  // walking, the javelin rides on the shoulder.
  const cock = Math.max(0, Math.min(1, -P.swing));

  legPair(g, cx, ft, 0x6a5c44, P, 4.4, 12);

  // --- the spare javelins, behind the body ---------------------------------
  // Held as a sheaf in the shield hand, points up. Three shafts at slightly
  // different angles so it reads as a bundle rather than as one thick pole.
  for (let i = 0; i < 3; i++) {
    const a = -0.26 + i * 0.2;
    const rootX = bx - 9;
    const rootY = by - 15;
    const tipX = rootX + Math.sin(a) * 26;
    const tipY = rootY - Math.cos(a) * 26;
    stick(g, rootX, rootY, tipX, tipY, 1.7, WOOD);
    g.fillStyle(STEEL, 1);
    g.fillTriangle(tipX - 2.2, tipY + 2.6, tipX, tipY - 4.4, tipX + 2.2, tipY + 2.6);
    g.lineStyle(1.1, OUT, 1);
    g.strokeTriangle(tipX - 2.2, tipY + 2.6, tipX, tipY - 4.4, tipX + 2.2, tipY + 2.6);
  }

  // --- short tunic over a leather jerkin ------------------------------------
  g.fillStyle(TUNIC, 1);
  g.fillRoundedRect(bx - 8, by - 30, 16, 19, 4);
  g.fillStyle(dim(TUNIC), 1);
  g.fillRoundedRect(bx - 8, by - 30, 7, 19, 3);
  g.fillStyle(JERKIN, 1);
  g.fillRoundedRect(bx - 8, by - 26, 16, 8, 2.5);
  g.fillStyle(shade(JERKIN, 0.22), 1);
  g.fillRect(bx - 8, by - 25, 16, 2);
  g.fillStyle(LEATHER_D, 1);
  g.fillRect(bx - 8, by - 16, 16, 3);
  g.lineStyle(2, OUT, 1);
  g.strokeRoundedRect(bx - 8, by - 30, 16, 19, 4);
  rimLine(g, bx + 7, by - 28, bx + 7, by - 13, 1.4, 0.45);

  head(g, bx, by - 34, 5.2, back);

  // A soft cap with a feather rather than a helmet: cheap troops, and it keeps
  // the head small so the shield and the sheaf dominate.
  g.fillStyle(JERKIN, 1);
  g.fillEllipse(bx, by - 37.4, 13, 8);
  g.fillStyle(shade(JERKIN, 0.2), 1);
  g.fillEllipse(bx + 1.6, by - 38.6, 7, 4);
  g.lineStyle(1.6, OUT, 1);
  g.strokeEllipse(bx, by - 37.4, 13, 8);
  g.lineStyle(2.6, OUT, 1);
  g.beginPath();
  g.moveTo(bx + 4, by - 39);
  g.lineTo(bx + 11, by - 46);
  g.strokePath();
  g.lineStyle(1.4, col, 1);
  g.beginPath();
  g.moveTo(bx + 4, by - 39);
  g.lineTo(bx + 11, by - 46);
  g.strokePath();

  // --- the wicker shield, on the near arm -----------------------------------
  const sx = (back ? bx + 1 : bx - 11) - P.swing * 1.4;
  const sy = by - 22;
  g.fillStyle(OUT, 1);
  g.fillEllipse(sx, sy, 20, 27);
  g.fillStyle(WICKER, 1);
  g.fillEllipse(sx, sy, 17, 24);
  g.fillStyle(shade(WICKER, 0.2), 1);
  g.fillEllipse(sx - 1.5, sy - 2.5, 10, 14);
  // Woven bands — the texture that says wicker rather than plank or steel.
  g.lineStyle(1.1, shade(WICKER, -0.32), 0.8);
  for (let k = -2; k <= 2; k++) {
    g.beginPath();
    g.moveTo(sx - 8, sy + k * 5);
    g.lineTo(sx + 8, sy + k * 5);
    g.strokePath();
  }
  // The device painted on the shield, and the whole argument of this pass in
  // one object.
  //
  // The shield used to be a broad vertical bar of team colour with a team
  // roundel on top of it, covering most of the face; the review's verdict was
  // that the skirmisher "reads as a blue circle", and it was right — this
  // shield is the largest single field on any foot soldier in the game, and
  // filling it with the player's colour makes the player's colour the unit.
  // What is painted on it now is a CHEVRON: two strokes of livery over bare
  // wicker. It is about a fifth of the paint, it is still the loudest mark on
  // the figure, and — because a chevron is a shape rather than a fill — it
  // survives at play size as a mark on a shield instead of dissolving into one
  // more coloured blob.
  g.lineStyle(4.4, col, 1);
  g.beginPath();
  g.moveTo(sx - 9, sy - 1);
  g.lineTo(sx, sy - 10);
  g.lineTo(sx + 9, sy - 1);
  g.strokePath();
  g.lineStyle(1.3, dark, 0.8);
  g.beginPath();
  g.moveTo(sx - 9, sy + 1.2);
  g.lineTo(sx, sy - 7.8);
  g.lineTo(sx + 9, sy + 1.2);
  g.strokePath();
  // A hide-bound rim and an iron boss, so the shield is a made object.
  g.fillStyle(OUT, 1);
  g.fillEllipse(sx, sy + 7, 8.4, 8.4);
  g.fillStyle(STEEL_D, 1);
  g.fillEllipse(sx, sy + 7, 6.6, 6.6);
  g.fillStyle(lit(STEEL), 1);
  g.fillEllipse(sx + 1.2, sy + 5.8, 2.8, 2.8);
  g.lineStyle(2.2, JERKIN, 0.95);
  g.strokeEllipse(sx, sy, 15.6, 22.4);

  // --- the javelin in hand, cocked and thrown --------------------------------
  const hx = bx + 8;
  const hy = by - 27;
  const R = pivot(hx, hy, P.swing * 1.35);
  const tail = R(bx + 1 - cock * 8, by - 22);
  const tip = R(bx + 24, by - 33);
  stick(g, tail.x, tail.y, tip.x, tip.y, 2.2, WOOD);
  const dx = tip.x - tail.x;
  const dy = tip.y - tail.y;
  const l = Math.hypot(dx, dy) || 1;
  const nx = dx / l;
  const ny = dy / l;
  const head0 = [
    { x: tip.x + nx * 6, y: tip.y + ny * 6 },
    { x: tip.x - ny * 2.8, y: tip.y + nx * 2.8 },
    { x: tip.x + ny * 2.8, y: tip.y - nx * 2.8 },
  ];
  g.fillStyle(STEEL, 1);
  g.fillPoints(head0, true, true);
  g.lineStyle(1.5, OUT, 1);
  g.strokePoints(head0, true, true);
  g.fillStyle(SKIN, 1);
  g.fillCircle(hx, hy, 2.5);
  g.lineStyle(1.1, OUT, 1);
  g.strokeCircle(hx, hy, 2.5);
}

/**
 * Knight — the heavy cavalry, and it has to be told apart from the scout at a
 * glance because one of them loses to spearmen and the other one wins games.
 *
 * Everything is bigger and harder: a grey destrier instead of a bay pony, a
 * caparison in team colour hanging past the horse's knees where the scout has a
 * bare hide and a saddle cloth, a rider in plate with a great helm and a plume,
 * and — the read that carries at any zoom — a couched lance running the whole
 * length of the sprite at a shallow angle, with a conical vamplate behind the
 * point. The scout's sabre is a short curve inside its own outline; the lance
 * leaves it.
 */
function drawKnight(g, col, dark, back, P) {
  const { cx, ft } = UNIT_BOX.knight;
  // A warm-grey dapple, NOT steel. The rider is in plate and the horse is
  // armoured too, and when both were the same cool grey the pair fused into one
  // slab with legs — you could not see where the animal stopped and the man
  // began. Warming the hide by a few points of red separates them at a glance
  // and still reads as a grey destrier rather than a bay.
  const HIDE = HORSE_GREY;
  const HIDE_D = HORSE_GREY_D;
  const MANE = 0x2c2b31;
  const bx = cx + P.bx;
  const by = ft + P.by;

  // Legs, fore and hind in opposition, exactly as the scout's. Barded: a steel
  // plate over the shoulder of each leg, which is most of what makes them read
  // as heavy rather than merely dark.
  const legs = [
    { x: bx - 14, a: P.la },
    { x: bx - 9, a: P.lb * 0.8 },
    { x: bx + 10, a: -P.lb },
    { x: bx + 15, a: -P.la * 0.8 },
  ];
  const hipY = by - 15;
  for (const l of legs) {
    const fx = l.x + Math.sin(l.a) * 15;
    const fy = hipY + Math.cos(l.a) * 15;
    stick(g, l.x, hipY, fx, fy, 4.6, l.x > bx ? HIDE : HIDE_D);
    g.fillStyle(OUT, 1);
    g.fillEllipse(fx, fy + 1, 9, 5.2);
    g.fillStyle(0x2c2019, 1);
    g.fillEllipse(fx, fy + 0.6, 6.6, 3.4);
  }

  // Barrel and hindquarters — bigger than the scout's in every direction,
  // because the two of them will stand side by side and "a bigger horse" has to
  // be the first thing a player sees.
  g.fillStyle(HIDE, 1);
  g.fillRoundedRect(bx - 19, by - 30, 38, 17, 8);
  g.fillStyle(HIDE_D, 1);
  g.fillRoundedRect(bx - 19, by - 19, 38, 6, 3);
  g.lineStyle(2.4, OUT, 1);
  g.strokeRoundedRect(bx - 19, by - 30, 38, 17, 8);
  g.fillStyle(lit(HIDE), 1);
  g.fillRoundedRect(bx - 13, by - 29, 23, 4, 2);

  // Tail, plaited short the way a warhorse's is.
  for (let k = 0; k < 3; k++) {
    stick(g, bx - 18, by - 27,
      bx - 23 - k * 1.4 + P.la * 2, by - 17 + (k - 1) * 2.2, 2.4 - k * 0.4, MANE);
  }

  // The caparison, and the single loudest thing this pass changed.
  //
  // It used to be a skirt of solid team colour hanging the full depth of the
  // barrel, and the review's sentence about it is worth keeping verbatim: the
  // knight was "a slightly larger blue lump because its entire horse is painted
  // team colour". That was true, and it was the most expensive kind of true —
  // the knight is the unit that ends games, the one a player most needs to spot
  // coming, and it had no shape of its own left to spot.
  //
  // What hangs there now is a CLOTH, in the linen the rest of the army is made
  // of, with the livery on its hem and its edge: a deep band along the
  // scalloped bottom and a narrow one at the top, which is exactly how a real
  // caparison is trimmed and about a fifth of the paint. The horse underneath
  // shows through as a grey destrier, the barding on its shoulders reads as
  // steel, and the outline of the animal — which is what says "cavalry" from
  // across the map — is back.
  //
  // The hem stops ABOVE the knee, and that has not changed: hung any lower it
  // covers the tops of all four legs, and a galloping horse whose legs only show
  // for seven pixels is a box that slides. The pose sheet made that obvious and
  // nothing else would have.
  const CAPARISON = 0xd8cdb2;
  const capTop = by - 26;
  const hem = [];
  for (let k = 0; k <= 7; k++) {
    hem.push({ x: bx - 17 + k * 4.9, y: by - 14 + (k % 2 ? 2.2 : 0) });
  }
  const capOutline = [
    { x: bx - 17, y: capTop }, { x: bx + 17, y: capTop },
    ...hem.slice().reverse(),
  ];
  g.fillStyle(CAPARISON, 1);
  g.fillPoints(capOutline, true, true);
  g.fillStyle(dim(CAPARISON), 1);
  g.fillPoints([
    { x: bx - 17, y: capTop }, { x: bx - 4, y: capTop },
    ...hem.slice(0, 4).reverse(),
  ], true, true);
  // The trim: livery along the hem, where it is lowest on the sprite and least
  // likely to be occluded by the rider, and a thin course at the top.
  g.fillStyle(col, 1);
  g.fillPoints([
    { x: bx - 17, y: by - 20 }, { x: bx + 17, y: by - 20 },
    ...hem.slice().reverse(),
  ], true, true);
  g.fillStyle(dark, 1);
  g.fillPoints([
    { x: bx - 17, y: by - 16.5 }, { x: bx + 17, y: by - 16.5 },
    ...hem.slice().reverse(),
  ], true, true);
  g.fillStyle(col, 1);
  g.fillRect(bx - 17, capTop, 34, 2.6);
  g.lineStyle(1.8, OUT, 1);
  g.strokePoints(capOutline, true, true);
  rimLine(g, bx + 16, capTop + 2, bx + 16, by - 15, 1.5, 0.4);

  // Neck and head under a steel chanfron.
  const neckX = bx + 14;
  const neckY = by - 28;
  const headX = neckX + 7;
  const headY = neckY - 12;
  stick(g, neckX, neckY, headX, headY, 8.5, HIDE);
  g.fillStyle(STEEL_D, 1);
  g.fillRoundedRect(headX - 5, headY - 6, 14, 9, 3);
  g.lineStyle(2, OUT, 1);
  g.strokeRoundedRect(headX - 5, headY - 6, 14, 9, 3);
  g.fillStyle(STEEL, 1);
  g.fillRect(headX - 3, headY - 5, 10, 2.4);
  g.fillStyle(OUT, 1);
  g.fillTriangle(headX - 4, headY - 6, headX - 2, headY - 12, headX + 0.5, headY - 6);
  if (!back) {
    g.fillStyle(OUT, 1);
    g.fillCircle(headX + 3, headY - 2.4, 1.2);
  }
  g.lineStyle(3.6, MANE, 1);
  g.beginPath();
  g.moveTo(neckX - 2, neckY - 3);
  g.lineTo(headX - 3, headY - 4);
  g.strokePath();

  // The rider: plate over a surcoat, seated deep. Everything above is measured
  // from `ry` so the whole man can be dropped a pixel without unpicking it —
  // the crest is the tallest thing on the unit and the box has four pixels to
  // spare over it, which is the sort of margin that only survives if it is
  // controlled from one number.
  const rx = bx - 2;
  const ry = by - 28;
  stick(g, rx + 3, ry - 3, rx + 5, ry + 8, 4, STEEL_D);
  g.fillStyle(STEEL, 1);
  g.fillRoundedRect(rx - 8, ry - 19, 16, 17, 5);
  g.fillStyle(dim(STEEL), 1);
  g.fillRoundedRect(rx - 8, ry - 19, 6, 17, 4);
  // Fluting on the breastplate: three shallow ridges, which is the difference
  // between "a man in plate" and "a grey rectangle with pauldrons".
  g.lineStyle(1, mix(STEEL_D, 0x3a4a66, 0.2), 0.7);
  for (const t of [-3, 0.5, 4]) {
    g.beginPath();
    g.moveTo(rx + t, ry - 17);
    g.lineTo(rx + t, ry - 3);
    g.strokePath();
  }
  // The surcoat: one band across the chest rather than the top half of the
  // man. The crest above it and the caparison below it are both livery too, and
  // three small marks stacked up the sprite carry ownership further than one
  // large one — they survive being half-occluded, which in a cavalry charge is
  // the normal case.
  g.fillStyle(col, 1);
  g.fillRect(rx - 8, ry - 13.5, 16, 5);
  g.fillStyle(dark, 1);
  g.fillRect(rx - 8, ry - 9.5, 16, 1.6);
  g.fillStyle(lit(STEEL), 1);
  g.fillRoundedRect(rx + 3.5, ry - 7.5, 4, 5, 2);
  g.lineStyle(2.2, OUT, 1);
  g.strokeRoundedRect(rx - 8, ry - 19, 16, 17, 5);
  // Pauldrons.
  g.fillStyle(STEEL, 1);
  g.fillEllipse(rx - 8, ry - 17, 8, 6.5);
  g.fillEllipse(rx + 8, ry - 17, 8, 6.5);
  g.lineStyle(1.6, OUT, 1);
  g.strokeEllipse(rx - 8, ry - 17, 8, 6.5);
  g.strokeEllipse(rx + 8, ry - 17, 8, 6.5);
  rimLine(g, rx + 6, ry - 19, rx + 11, ry - 16, 1.6, 0.5);

  // Great helm: a steel bucket with a slit, not a face. The scout has a visible
  // face under a cap; "man" against "anonymous steel" is one more thing keeping
  // the two riders apart at a glance.
  const hy = ry - 25;
  g.fillStyle(STEEL, 1);
  g.fillRoundedRect(rx - 6.5, hy - 5, 13, 13, 4);
  g.fillStyle(lit(STEEL), 1);
  g.fillRoundedRect(rx + 1.5, hy - 4, 4.5, 11, 2);
  g.lineStyle(2, OUT, 1);
  g.strokeRoundedRect(rx - 6.5, hy - 5, 13, 13, 4);
  if (!back) {
    g.fillStyle(OUT, 1);
    g.fillRect(rx - 5, hy - 0.5, 10, 2.4);
    g.fillRect(rx - 1, hy - 2.5, 2, 6);
  }
  // A horsehair crest lying back over the helm rather than a tall plume: the
  // same amount of team colour, six pixels less height, and the box has no six
  // pixels to give.
  const crest = [
    { x: rx + 4, y: hy - 6 },
    { x: rx - 1, y: hy - 11 },
    { x: rx - 9, y: hy - 9 },
    { x: rx - 12, y: hy - 3 },
    { x: rx - 6, y: hy - 5 },
  ];
  g.fillStyle(col, 1);
  g.fillPoints(crest, true, true);
  g.fillStyle(dark, 1);
  g.fillPoints([crest[2], crest[3], crest[4]], true, true);
  g.lineStyle(1.6, OUT, 1);
  g.strokePoints(crest, true, true);

  // The lance, couched under the arm. It runs off the front of the body — a
  // shape that leaves the silhouette is the one guaranteed to be visible in a
  // press of bodies — but it stops inside the frame box, because a lance point
  // clipped by the atlas is a lance point that is simply gone.
  const gx = rx + 7;
  const gy = ry - 11;
  const R = pivot(gx, gy, P.swing * 0.45);
  const butt = R(rx - 9, gy + 4);
  const tip = R(rx + 27, gy - 10);
  g.lineStyle(6.4, OUT, 1);
  g.beginPath();
  g.moveTo(butt.x, butt.y);
  g.lineTo(tip.x, tip.y);
  g.strokePath();
  g.lineStyle(4, WOOD, 1);
  g.beginPath();
  g.moveTo(butt.x, butt.y);
  g.lineTo(tip.x, tip.y);
  g.strokePath();
  // Spiral livery bands, so the lance is a knight's and not a fence rail.
  g.lineStyle(3, col, 1);
  for (const t of [0.34, 0.56, 0.78]) {
    const px = butt.x + (tip.x - butt.x) * t;
    const py = butt.y + (tip.y - butt.y) * t;
    g.beginPath();
    g.moveTo(px - 1.4, py - 1.4);
    g.lineTo(px + 1.4, py + 1.4);
    g.strokePath();
  }
  // Vamplate: the cone that guards the hand.
  const vp = R(rx + 7, gy - 4);
  g.fillStyle(STEEL_D, 1);
  g.fillEllipse(vp.x, vp.y, 8, 9.5);
  g.lineStyle(1.5, OUT, 1);
  g.strokeEllipse(vp.x, vp.y, 8, 9.5);
  g.fillStyle(lit(STEEL), 1);
  g.fillEllipse(vp.x + 1.2, vp.y - 1.5, 3.2, 3.8);
  // The point.
  const ux = tip.x - butt.x;
  const uy = tip.y - butt.y;
  const ul = Math.hypot(ux, uy) || 1;
  const nx = ux / ul;
  const ny = uy / ul;
  const pt = [
    { x: tip.x + nx * 7, y: tip.y + ny * 7 },
    { x: tip.x - ny * 2.8, y: tip.y + nx * 2.8 },
    { x: tip.x + ny * 2.8, y: tip.y - nx * 2.8 },
  ];
  g.fillStyle(STEEL, 1);
  g.fillPoints(pt, true, true);
  g.lineStyle(1.6, OUT, 1);
  g.strokePoints(pt, true, true);
}

/**
 * Mangonel — a stone-thrower, and the reason `splashRadius` exists.
 *
 * Same family as the ram: low, wide, wheeled, no head and no limbs, so a player
 * knows immediately that it is a machine. What separates it from the ram is
 * everything above the chassis. The ram has a shed roof and a swinging log; the
 * mangonel is open, and carries one heavy arm raked back over its own axle with
 * a bowl on the end and a padded crossbeam for it to slam into. That arm, and
 * the boulder sitting in it, is the silhouette — a diagonal with a ball on the
 * top, which nothing else in the game makes.
 *
 * `swing` winds the arm down against its ropes and then throws it: negative is
 * loaded and low, positive is released and standing almost upright, which is
 * where the boulder leaves.
 */
function drawMangonel(g, col, dark, back, P) {
  const { cx, ft } = UNIT_BOX.mangonel;
  const FRAME = 0x7a5630;
  const FRAME_D = 0x54391e;
  const bx = cx + P.bx;
  const by = ft + P.by;

  // --- WHICH WAY THE MACHINE IS POINTING ------------------------------------
  //
  // The review's sharpest line about the siege engines was "the front-row and
  // back-row contact sheets are identical — an army moving right has its
  // catapults pointing left", and it was correct: the `back` flag moved a
  // winch drum and changed a crossbeam's width, which is a detail, not a
  // facing. A machine is a long rigid object and the ONE thing that says which
  // way it is going is the direction its long axis lies in.
  //
  // In this projection that direction is known exactly. render.js draws the
  // front sprite for the three facings that come towards the camera and the
  // back sprite for the three that go away (FACE_BACK/FACE_FLIP there), and
  // the canonical member of each of those sets is down-right and up-right
  // respectively — which are the two tile diagonals, one screen pixel of drop
  // for every two of run. So the chassis rakes DOWN to the right when the
  // engine is coming at you and UP to the right when it is driving away, and
  // everything bolted to the chassis rakes with it.
  //
  // RAKE is 0.3 rather than the true 0.515 of the tile diagonal, and that is a
  // frame-box decision rather than a fudge: the full slope drops the tail
  // wheel thirteen pixels below the foot line, the box has seven, and buying
  // those six pixels back costs 14k of atlas on thirty-two frames. At 0.3 the
  // difference between the two drawings is sixteen pixels of attitude across
  // the machine, which is more than enough to read at play size — the test is
  // whether the two contact-sheet rows look like the same object, and they no
  // longer do.
  const rake = back ? -0.3 : 0.3;
  /** The y of a point `dx` along the machine from its centre. */
  const RY = (dx) => by + rake * dx;

  // Wheels, spinning with the walk pose — the only way a machine says it moves.
  // The near wheel sits lower than the far one now, which is the first thing
  // that says the axle is not parallel to the screen.
  const spin = P.la * 1.6;
  for (const [wx0, wy0, rr] of [
    [bx - 21, RY(-21) - 7, back ? 8.5 : 8], [bx + 19, RY(19) - 7, back ? 8 : 8.5]]) {
    g.fillStyle(OUT, 1);
    g.fillCircle(wx0, wy0, rr + 1.8);
    g.fillStyle(FRAME_D, 1);
    g.fillCircle(wx0, wy0, rr);
    g.fillStyle(shade(FRAME, 0.12), 1);
    g.fillCircle(wx0, wy0, rr * 0.38);
    g.lineStyle(1.6, OUT, 0.85);
    for (let k = 0; k < 4; k++) {
      const a = spin + (Math.PI / 4) * k;
      g.beginPath();
      g.moveTo(wx0 - Math.cos(a) * rr, wy0 - Math.sin(a) * rr);
      g.lineTo(wx0 + Math.cos(a) * rr, wy0 + Math.sin(a) * rr);
      g.strokePath();
    }
  }

  // Chassis: two rails and the cross members between them, with the machine's
  // livery painted along the flank. That painted rail is the engine's share of
  // the colour budget — fifty pixels of team colour on a fifty-pixel-long
  // machine, against the twelve-pixel pennant it used to carry and nothing
  // else. A player has to be able to answer "whose mangonel is that" from the
  // far side of a siege line, and a flag on a mast is exactly the thing that
  // disappears behind the building being knocked down.
  //
  // Drawn as a raked parallelogram rather than as a rectangle, because a
  // rectangle is exactly what made the two facings the same picture.
  const rail = (x0, x1, top, h) => [
    { x: bx + x0, y: RY(x0) + top },
    { x: bx + x1, y: RY(x1) + top },
    { x: bx + x1, y: RY(x1) + top + h },
    { x: bx + x0, y: RY(x0) + top + h },
  ];
  g.fillStyle(FRAME_D, 1);
  g.fillPoints(rail(-26, 26, -16, 7), true, true);
  g.fillStyle(FRAME, 1);
  g.fillPoints(rail(-26, 26, -16, 2.6), true, true);
  g.lineStyle(2.2, OUT, 1);
  g.strokePoints(rail(-26, 26, -16, 7), true, true);
  g.fillStyle(col, 1);
  g.fillPoints(rail(-24, 24, -14.6, 4.4), true, true);
  g.fillStyle(dark, 1);
  g.fillPoints(rail(-24, 24, -11.4, 1.4), true, true);

  // The A-frame uprights that carry the arm's axle, and the axle itself.
  const axX = bx + 2;
  // The axle sits LOW, and that is a measurement rather than a taste. The arm
  // rotates about it, so its height plus the arm's length plus the bowl on the
  // end is exactly how far the sprite reaches, and the frame box has 70 pixels
  // above the unit's feet. The first version put the axle at by-32 with a
  // 40-pixel arm and the whole throwing gear was sliced off by the top of the
  // box in every pose but the wound-up one — invisible in play, obvious the
  // moment the pose sheet was printed, which is what the pose sheet is for.
  const axY = RY(2) - 23;
  for (const sgn of [-1, 1]) {
    stick(g, axX + sgn * 11, RY(2 + sgn * 11) - 14, axX, axY, 4.4,
      sgn > 0 ? FRAME : FRAME_D);
  }
  g.fillStyle(OUT, 1);
  g.fillCircle(axX, axY, 6);
  g.fillStyle(STEEL_D, 1);
  g.fillCircle(axX, axY, 4.2);

  // The padded crossbeam the arm slams into, up at the front. Seen from behind
  // it is at the far end of the machine, so it is drawn narrower and a little
  // higher — the cheapest honest way to say "further away" in a projection
  // that has no perspective.
  if (back) {
    const bt = RY(18) - 30;
    g.fillStyle(OUT, 1);
    g.fillRoundedRect(bx + 14, bt, 9, 20, 3);
    g.fillStyle(FRAME_D, 1);
    g.fillRoundedRect(bx + 15.2, bt + 1.2, 6.6, 17.6, 2.4);
  } else {
    const bt = RY(18) - 36;
    g.fillStyle(OUT, 1);
    g.fillRoundedRect(bx + 12, bt, 12, 22, 4);
    g.fillStyle(FRAME, 1);
    g.fillRoundedRect(bx + 13.5, bt + 1.5, 9, 19, 3);
    g.fillStyle(0x8a6a3c, 1);
    g.fillRoundedRect(bx + 13, bt - 1, 10, 6, 3);
  }

  // The twisted skein of rope that powers it: two coils either side of the axle.
  for (const sgn of [-1, 1]) {
    g.fillStyle(OUT, 1);
    g.fillEllipse(axX + sgn * 9, axY + 2, 12, 10);
    g.fillStyle(0xbca87c, 1);
    g.fillEllipse(axX + sgn * 9, axY + 2, 9.5, 7.6);
    g.lineStyle(1, shade(0xbca87c, -0.35), 0.85);
    for (let k = -1; k <= 1; k++) {
      g.beginPath();
      g.moveTo(axX + sgn * 9 - 4, axY + 2 + k * 2.4);
      g.lineTo(axX + sgn * 9 + 4, axY + 2 + k * 2.4 - 1);
      g.strokePath();
    }
  }

  // --- the arm, and the whole identity of this unit -------------------------
  //
  // THE ARM STANDS UP AT REST. That one decision is what stops this machine
  // from being the third of "three identical brown carts": at rest it used to
  // rake back flat over its own tail, which put its entire mass inside the same
  // low horizontal slab the ram and the scorpion occupy, and no amount of
  // detail rescues three objects that share an outline. Standing, it makes a
  // steep diagonal with a stone on the end of it — a shape nothing else in the
  // game makes, and one that survives being twenty pixels tall.
  //
  // It is also what a loaded engine looks like between shots, which is the
  // state it is in for almost all of its life. `swing` swings it about the
  // axle from there: wound down and back over the tail to load, then snapped
  // forward against the crossbeam as the stone leaves.
  const rel = (P.swing + 1) * 0.5; // 0 = fully wound, 1 = fully thrown
  const armA = -1.75 + P.swing * 0.9;
  const armLen = 32;
  const tipX = axX + Math.cos(armA) * armLen;
  const tipY = axY + Math.sin(armA) * armLen;
  stick(g, axX, axY, tipX, tipY, 6, FRAME);
  g.lineStyle(1.4, RIM, 0.35);
  g.beginPath();
  g.moveTo(axX + 2, axY - 2);
  g.lineTo(tipX + 2, tipY - 2);
  g.strokePath();

  // The bowl on the end, and a stone in it while the arm is still loaded.
  const bowl = [
    { x: tipX - 8, y: tipY - 3 },
    { x: tipX + 8, y: tipY - 3 },
    { x: tipX + 5, y: tipY + 7 },
    { x: tipX - 5, y: tipY + 7 },
  ];
  g.fillStyle(FRAME_D, 1);
  g.fillPoints(bowl, true, true);
  g.lineStyle(2, OUT, 1);
  g.strokePoints(bowl, true, true);
  if (rel < 0.75) {
    g.fillStyle(OUT, 1);
    g.fillCircle(tipX, tipY - 4, 7.6);
    g.fillStyle(0x7b8490, 1);
    g.fillCircle(tipX, tipY - 4, 6.4);
    g.fillStyle(0x9ca6b3, 1);
    g.fillCircle(tipX + 1.6, tipY - 6, 3.4);
  }

  if (back) {
    // The tail of the machine, which is what is nearest the camera when the
    // engine is pointing away: the windlass the crew hauls the arm down with,
    // its rope running up to the arm, and the ratchet pawl on the drum.
    const wx0 = bx - 20;
    const wy0 = RY(-20) - 21;
    g.lineStyle(2.6, OUT, 0.75);
    g.beginPath();
    g.moveTo(wx0, wy0);
    g.lineTo(axX + Math.cos(armA) * 14, axY + Math.sin(armA) * 14);
    g.strokePath();
    g.lineStyle(1.3, 0xdccfa8, 0.95);
    g.beginPath();
    g.moveTo(wx0, wy0);
    g.lineTo(axX + Math.cos(armA) * 14, axY + Math.sin(armA) * 14);
    g.strokePath();
    g.fillStyle(OUT, 1);
    g.fillCircle(wx0, wy0, 7.2);
    g.fillStyle(WOOD_D, 1);
    g.fillCircle(wx0, wy0, 5.8);
    g.fillStyle(shade(WOOD, 0.1), 1);
    g.fillCircle(wx0 + 1.2, wy0 - 1.4, 2.6);
    // Three bars across the drum and a crank handle off the side. Without them
    // this is a brown circle at wheel height and the machine appears to have
    // grown a third wheel — which is exactly what the first version looked like.
    g.lineStyle(1.4, OUT, 0.8);
    for (let k = 0; k < 3; k++) {
      const a = 0.4 + (Math.PI / 3) * k;
      g.beginPath();
      g.moveTo(wx0 - Math.cos(a) * 5.6, wy0 - Math.sin(a) * 5.6);
      g.lineTo(wx0 + Math.cos(a) * 5.6, wy0 + Math.sin(a) * 5.6);
      g.strokePath();
    }
    g.lineStyle(3.4, OUT, 1);
    g.beginPath();
    g.moveTo(wx0, wy0);
    g.lineTo(wx0 - 9, wy0 - 8);
    g.strokePath();
    g.lineStyle(1.8, STEEL_D, 1);
    g.beginPath();
    g.moveTo(wx0, wy0);
    g.lineTo(wx0 - 9, wy0 - 8);
    g.strokePath();
  } else {
    // A rack of spare shot on the chassis, on the near flank.
    for (const [ox, oy] of [[-19, -19], [-12, -19], [-15.5, -25]]) {
      g.fillStyle(OUT, 1);
      g.fillCircle(bx + ox, RY(ox) + oy, 5);
      g.fillStyle(0x6f7883, 1);
      g.fillCircle(bx + ox, RY(ox) + oy, 4);
      g.fillStyle(0x99a3af, 1);
      g.fillCircle(bx + ox + 1, RY(ox) + oy - 1.2, 2);
    }
  }

  // The masthead pennant, on a staff at the front rail.
  const py0 = RY(24);
  stick(g, bx + 24, py0 - 16, bx + 24, py0 - 44, 1.8, 0x6a5334);
  g.fillStyle(col, 1);
  g.fillTriangle(bx + 24, py0 - 44, bx + 35, py0 - 40.5, bx + 24, py0 - 37);
  g.lineStyle(1.4, OUT, 1);
  g.strokeTriangle(bx + 24, py0 - 44, bx + 35, py0 - 40.5, bx + 24, py0 - 37);
  g.fillStyle(dark, 1);
  g.fillTriangle(bx + 24, py0 - 42, bx + 30, py0 - 40.4, bx + 24, py0 - 39);
}

/**
 * Scorpion — a bolt thrower.
 *
 * The third member of the engine family and the flattest: where the mangonel
 * reaches up with a raking arm, this one reaches *sideways*. A horizontal bow
 * across the front, wider than the chassis it sits on, with a bolt already in
 * the groove pointing straight out. Low, wide and cruciform, against the
 * mangonel's tall diagonal — that difference has to survive both of them
 * sitting in the same siege line.
 */
function drawScorpion(g, col, dark, back, P) {
  const { cx, ft } = UNIT_BOX.scorpion;
  const FRAME = 0x7a5630;
  const FRAME_D = 0x54391e;
  const bx = cx + P.bx;
  const by = ft + P.by;
  // How far the string is drawn. Wound up = loaded and ready; released = the
  // string has snapped forward and the bolt has gone.
  const drawn = Math.max(0, Math.min(1, -P.swing));
  // Seen from behind, the bow is at the far end of the machine and the crew's
  // mantlet is at the near one, so the bow is drawn foreshortened and the
  // mantlet is drawn large. Nothing else about the engine changes — it is the
  // same object from the other side, not a different one.
  const far = back ? 0.72 : 1;
  // ...and it rakes the other way. See the long note in drawMangonel: the
  // direction a machine's long axis lies in IS its facing, and both engines
  // used to lie flat along the screen in both drawings, which is why the two
  // contact-sheet rows were the same picture. Down-right coming towards you,
  // up-right driving away.
  //
  // The pivot is eight pixels forward of centre rather than at the middle, and
  // that is arithmetic on the frame box rather than taste: raked about its
  // centre this engine's tail wheel drops below the bottom of its box in one
  // drawing and its bow limb rises out of the top in the other. Pivoting where
  // the mass is keeps both inside a box that only grew by two pixels.
  const rake = back ? -0.26 : 0.26;
  const RY = (dx) => by + rake * (dx - 8);

  // Two small wheels — a scorpion is a cart, not a siege tower.
  const spin = P.la * 1.8;
  for (const [wx0, wy0, rr] of [
    [bx - 16, RY(-16) - 5.5, back ? 6.5 : 6],
    [bx + 15, RY(15) - 5.5, back ? 6 : 6.5]]) {
    g.fillStyle(OUT, 1);
    g.fillCircle(wx0, wy0, rr + 1.6);
    g.fillStyle(FRAME_D, 1);
    g.fillCircle(wx0, wy0, rr);
    g.lineStyle(1.5, OUT, 0.85);
    for (let k = 0; k < 3; k++) {
      const a = spin + (Math.PI / 3) * k;
      g.beginPath();
      g.moveTo(wx0 - Math.cos(a) * rr, wy0 - Math.sin(a) * rr);
      g.lineTo(wx0 + Math.cos(a) * rr, wy0 + Math.sin(a) * rr);
      g.strokePath();
    }
  }

  // A splayed trestle carrying the stock. Short: this engine's whole job is to
  // be the LOW one. Its top sits about forty pixels above the ground against
  // the ram's fifty and the mangonel's sixty-five, and that spread is what
  // stops the three of them reading as one cart drawn three times.
  for (const sgn of [-1, 1]) {
    stick(g, bx + sgn * 13, RY(sgn * 13) - 7, bx + sgn * 5, RY(sgn * 5) - 16, 4,
      sgn > 0 ? FRAME : FRAME_D);
  }
  // Every long member of this machine is a raked parallelogram now, not a
  // rectangle: `beam` is the one place that conversion lives.
  const beam = (x0, x1, top, h) => [
    { x: bx + x0, y: RY(x0) + top },
    { x: bx + x1, y: RY(x1) + top },
    { x: bx + x1, y: RY(x1) + top + h },
    { x: bx + x0, y: RY(x0) + top + h },
  ];
  g.fillStyle(FRAME_D, 1);
  g.fillPoints(beam(-16, 16, -11, 5), true, true);
  g.lineStyle(1.8, OUT, 1);
  g.strokePoints(beam(-16, 16, -11, 5), true, true);

  // The stock: a squared beam running fore and aft, with the groove on top.
  /** The stock's own y at `dx` along it. */
  const SY = (dx) => RY(dx) - 20;
  g.fillStyle(OUT, 1);
  g.fillPoints(beam(-21, 25, -25, 11), true, true);
  g.fillStyle(FRAME, 1);
  g.fillPoints(beam(-19.5, 23.5, -23.5, 8), true, true);
  g.fillStyle(shade(FRAME, 0.2), 1);
  g.fillPoints(beam(-18, 22, -22.5, 2.4), true, true);
  g.fillStyle(FRAME_D, 1);
  g.fillPoints(beam(-18, 22, -20.6, 2.2), true, true);
  // The windlass at the back, which is what a crew winds. From behind it is
  // the nearest thing on the machine, so it gets its crank and its rope.
  g.fillStyle(OUT, 1);
  g.fillCircle(bx - 21, SY(-21), back ? 7.6 : 6.4);
  g.fillStyle(WOOD_D, 1);
  g.fillCircle(bx - 21, SY(-21), back ? 6.2 : 5);
  g.lineStyle(1.8, STEEL_D, 1);
  g.beginPath();
  g.moveTo(bx - 21, SY(-21));
  g.lineTo(bx - 27, SY(-27) - 5);
  g.strokePath();

  // --- the bow: the whole read ---------------------------------------------
  //
  // Two limbs sweeping out from a central case, well past the width of the
  // chassis. The limbs BULGE FORWARD and the string runs straight between their
  // tips, which is what a strung bow looks like and — much more to the point —
  // what stops this from being a vertical bar. The first version drew the limbs
  // as straight segments; on screen a straight vertical line with a straight
  // white line beside it is a flagpole, not a weapon, and no amount of detail
  // on the chassis rescued it. A curve is the whole difference.
  const bowX = bx + 11;
  const bowY = SY(11) - 2;
  const span = 16 * far;
  for (const sgn of [-1, 1]) {
    // A gentle sweep, not a curl. The bulge used to reach eight pixels forward
    // over a sixteen-pixel limb, and with a six-pixel outline on it the two
    // limbs met in the middle and the bow came out as a brown blob with a
    // white V beside it. Half the bulge and a thinner line is a bow.
    const arcPts = [
      { x: bowX + 1, y: bowY + sgn * 2 * far },
      { x: bowX + 4.5, y: bowY + sgn * 7 * far },
      { x: bowX + 5, y: bowY + sgn * 12 * far },
      { x: bowX + 3, y: bowY + sgn * span },
    ];
    g.lineStyle(5, OUT, 1);
    g.strokePoints(arcPts, false, false);
    g.lineStyle(2.6, WOOD, 1);
    g.strokePoints(arcPts, false, false);
    g.lineStyle(1, shade(WOOD, 0.3), 0.75);
    g.strokePoints(arcPts.map((p) => ({ x: p.x + 1, y: p.y })), false, false);
    // Horn nock at the limb tip.
    g.fillStyle(OUT, 1);
    g.fillCircle(bowX + 3, bowY + sgn * span, 2.6);
    g.fillStyle(STEEL_D, 1);
    g.fillCircle(bowX + 3, bowY + sgn * span, 1.6);
  }
  // The case the limbs are socketed into. Small and wooden — a big steel block
  // here reads as a hammer head sitting on the machine.
  g.fillStyle(OUT, 1);
  g.fillRoundedRect(bowX - 2, bowY - 7, 9, 14, 3);
  g.fillStyle(FRAME_D, 1);
  g.fillRoundedRect(bowX - 0.8, bowY - 5.8, 6.6, 11.6, 2.4);
  g.fillStyle(STEEL_D, 1);
  g.fillRect(bowX - 0.5, bowY - 2, 6, 4);

  // The string, and the bolt. A scorpion at rest is a scorpion that is loaded —
  // it is only ever standing about because it has nothing to shoot at yet — so
  // the bolt is drawn in every pose, and what `swing` moves is how far back the
  // string has hauled it.
  const nockX = bowX - 2 - drawn * 16;
  g.lineStyle(2.4, OUT, 0.55);
  g.beginPath();
  g.moveTo(bowX + 3, bowY - span);
  g.lineTo(nockX, bowY);
  g.lineTo(bowX + 3, bowY + span);
  g.strokePath();
  g.lineStyle(1.3, 0xf4eedd, 0.95);
  g.beginPath();
  g.moveTo(bowX + 3, bowY - span);
  g.lineTo(nockX, bowY);
  g.lineTo(bowX + 3, bowY + span);
  g.strokePath();
  stick(g, nockX, bowY, bowX + 15 * far, bowY, 2.2, 0xd8b070);
  g.fillStyle(0xe6ebf0, 1);
  g.fillTriangle(bowX + 14 * far, bowY - 3.4, bowX + 23 * far, bowY, bowX + 14 * far, bowY + 3.4);
  g.lineStyle(1.3, OUT, 1);
  g.strokeTriangle(bowX + 14 * far, bowY - 3.4, bowX + 23 * far, bowY,
    bowX + 14 * far, bowY + 3.4);
  g.fillStyle(0xf2f2f2, 1);
  g.fillTriangle(nockX, bowY - 3.4, nockX + 6, bowY, nockX, bowY + 3.4);

  // --- the mantlet: the crew's shield, and the engine's livery --------------
  //
  // A plank screen standing at the winding end, painted in the team's colour.
  // It does three jobs at once, which is why it is here rather than another
  // flag: it is a piece of real siege equipment, it puts mass at the low tail
  // end so the machine reads as a wedge rather than a rectangle, and it is the
  // engine's share of the colour budget — an object as big as a mangonel that
  // carries twelve pixels of ownership is an object nobody can claim.
  //
  // Drawn LAST, because from behind it is the nearest thing on the machine and
  // must overlap the stock; and drawn wider in the back pose for the same
  // reason.
  const mw = back ? 10.5 : 7;
  const mx = bx - 22;
  const mTop = SY(-22) - 11;
  const mH = 20;
  // A pavise, not a placard: the top is arched, the bottom is a plain plank
  // rail and there are two iron straps across the face. Those three marks are
  // the difference between "a shield" and "a coloured rectangle", and a
  // coloured rectangle is exactly the failure this whole pass is about.
  const face = [
    { x: mx - mw, y: mTop + 4 },
    { x: mx - mw * 0.55, y: mTop },
    { x: mx + mw * 0.55, y: mTop },
    { x: mx + mw, y: mTop + 4 },
    { x: mx + mw, y: mTop + mH },
    { x: mx - mw, y: mTop + mH },
  ];
  g.fillStyle(OUT, 1);
  g.fillPoints(face.map((q) => ({
    x: mx + (q.x - mx) * 1.2, y: mTop + (q.y - mTop) * 1.06 - 1.2,
  })), true, true);
  g.fillStyle(col, 1);
  g.fillPoints(face, true, true);
  g.fillStyle(dark, 1);
  g.fillPoints([
    face[0], { x: mx - mw * 0.55, y: mTop },
    { x: mx - mw * 0.55, y: mTop + mH }, face[5],
  ], true, true);
  // Plank joints, an iron strap top and bottom, and a bare timber sill.
  g.lineStyle(1, shade(dark, -0.25), 0.75);
  for (let k = 1; k < (back ? 4 : 3); k++) {
    const px2 = mx - mw + (mw * 2 * k) / (back ? 4 : 3);
    g.beginPath();
    g.moveTo(px2, mTop + 2);
    g.lineTo(px2, mTop + mH - 1);
    g.strokePath();
  }
  g.fillStyle(STEEL_D, 1);
  g.fillRect(mx - mw, mTop + 5.5, mw * 2, 2.2);
  g.fillStyle(FRAME_D, 1);
  g.fillRect(mx - mw, mTop + mH - 4, mw * 2, 4);
  g.fillStyle(STEEL, 1);
  g.fillCircle(mx + mw * 0.25, mTop + 13, 2.4);
  g.lineStyle(1.8, OUT, 1);
  g.strokePoints(face, true, true);
  rimLine(g, mx + mw - 1, mTop + 5, mx + mw - 1, mTop + mH - 2, 1.4, 0.45);

  // A short staff on the mantlet's top edge with the pennant on it, so the
  // engine still reads as owned when the mantlet is behind a wall.
  //
  // SHORT is the operative word. The first version put a twelve-pixel staff on
  // here and the flag became the tallest thing on the machine — which is
  // exactly backwards, because "the low one" is this engine's entire job in the
  // siege line, and it was also two pixels outside the top of its own frame
  // box. It clears the bow limbs by a pixel and no more.
  stick(g, mx, mTop, mx, mTop - 7, 1.7, 0x6a5334);
  g.fillStyle(col, 1);
  g.fillTriangle(mx, mTop - 7, mx + 9, mTop - 4.6, mx, mTop - 2.2);
  g.lineStyle(1.3, OUT, 1);
  g.strokeTriangle(mx, mTop - 7, mx + 9, mTop - 4.6, mx, mTop - 2.2);
}

/**
 * Monk — the one unit in the game that cannot fight, and it has to look like it.
 *
 * Everything a soldier has is deliberately absent: no helmet, no shield, no
 * weapon, nothing on the shoulders, no visible legs. What is there instead is a
 * robe that reaches the ground — a single tapering trapezoid where every other
 * humanoid on the map is a torso on two legs — a deep cowl, a knotted rope
 * girdle, and both hands on a book. The outline is a bell with a hood on it, and
 * a player who has never been told what a monk is will still not expect it to
 * hit anything.
 *
 * Team colour goes on a stole down the front of the robe rather than on the robe
 * itself: a monk in bright blue is a soldier in a dress, and the whole design
 * depends on the cloth reading as undyed wool.
 */
function drawMonk(g, col, dark, back, P) {
  const { cx, ft } = UNIT_BOX.monk;
  const WOOL = 0xd9cfb4;
  const WOOL_D = 0xa89c7c;
  const bx = cx + P.bx;
  const by = ft + P.by;
  // The hem sways with the stride instead of legs swinging: the walk still
  // reads, but nothing about the body says "infantry".
  const sway = P.la * 3.4;

  // Sandalled feet, only just showing under the hem — enough to tell which way
  // the stride is going, not enough to make legs part of the silhouette.
  for (const [side, ang] of [[-1, P.lb], [1, P.la]]) {
    const fx = bx + side * 3 + Math.sin(ang) * 4.5;
    g.fillStyle(OUT, 1);
    g.fillEllipse(fx, ft - 1.5, 8.4, 4.6);
    g.fillStyle(0x6b563a, 1);
    g.fillEllipse(fx, ft - 2.2, 6.6, 3.2);
  }

  // The robe: one trapezoid from the shoulders to the floor.
  const robe = [
    { x: bx - 8, y: by - 34 },
    { x: bx + 8, y: by - 34 },
    { x: bx + 12 + sway * 0.5, y: ft - 3 },
    { x: bx - 12 + sway * 0.5, y: ft - 3 },
  ];
  g.fillStyle(WOOL, 1);
  g.fillPoints(robe, true, true);
  // The shaded half, and a warm rim down the sunward edge: a big flat cloth
  // shape is the easiest thing in this file to make look like paper, and two
  // tones plus a rim is what stops it.
  g.fillStyle(WOOL_D, 1);
  g.fillPoints([
    robe[0], { x: bx - 2, y: by - 34 },
    { x: bx - 2 + sway * 0.5, y: ft - 3 }, robe[3],
  ], true, true);
  g.lineStyle(2, OUT, 1);
  g.strokePoints(robe, true, true);
  rimLine(g, bx + 7, by - 32, bx + 11 + sway * 0.5, ft - 5, 1.6, 0.5);
  // Folds, hanging from the girdle.
  g.lineStyle(1.1, WOOL_D, 0.75);
  for (const t of [-0.45, 0, 0.45]) {
    g.beginPath();
    g.moveTo(bx + t * 9, by - 20);
    g.lineTo(bx + t * 13 + sway * 0.5, ft - 5);
    g.strokePath();
  }

  // Rope girdle with the three knots, which is a monk's whole uniform.
  g.lineStyle(2.6, 0xbfa571, 1);
  g.beginPath();
  g.moveTo(bx - 8, by - 21);
  g.lineTo(bx + 8, by - 21);
  g.strokePath();
  g.lineStyle(1.8, 0xbfa571, 1);
  g.beginPath();
  g.moveTo(bx + 5, by - 21);
  g.lineTo(bx + 6.5, by - 9);
  g.strokePath();
  for (const ky of [-16, -12.5, -9]) {
    g.fillStyle(0x9d8452, 1);
    g.fillCircle(bx + 6, by + ky, 1.6);
  }

  // The stole. It hangs BELOW the girdle, not over the chest, because the book
  // is held at the chest and covers everything there: the first version put two
  // colour bands on the shoulders and the book turned them into a blue rectangle
  // peeping out either side, which read as a satchel. Below the knot it is a
  // single clean strip and it is the only saturated colour on the unit.
  g.fillStyle(col, 1);
  g.fillRect(bx - 2.4, by - 20, 4.8, 14);
  g.fillStyle(dark, 1);
  g.fillRect(bx - 2.4, by - 8, 4.8, 2.4);

  head(g, bx, by - 38, 5, back);

  // The cowl. A deep hood with a peak that overhangs the face, drawn as one
  // shape so it reads at any size, plus a shoulder cape under it.
  const cape = [
    { x: bx - 11, y: by - 30 },
    { x: bx - 9, y: by - 36 },
    { x: bx + 9, y: by - 36 },
    { x: bx + 11, y: by - 30 },
  ];
  g.fillStyle(WOOL_D, 1);
  g.fillPoints(cape, true, true);
  // A band of team colour along the lower edge of the mantle, which is the one
  // place on the upper body the book never covers.
  g.fillStyle(col, 1);
  g.fillPoints([
    cape[0], { x: cape[3].x, y: cape[3].y },
    { x: cape[3].x - 0.8, y: cape[3].y - 3 }, { x: cape[0].x + 0.8, y: cape[0].y - 3 },
  ], true, true);
  g.lineStyle(1.8, OUT, 1);
  g.strokePoints(cape, true, true);
  const hood = [
    { x: bx - 8, y: by - 34 },
    { x: bx - 8.5, y: by - 42 },
    { x: bx - 2, y: by - 47.5 },
    { x: bx + 6, y: by - 44 },
    { x: bx + 8.5, y: by - 37 },
    { x: bx + 7.5, y: by - 33 },
  ];
  g.fillStyle(WOOL, 1);
  g.fillPoints(hood, true, true);
  g.fillStyle(WOOL_D, 1);
  g.fillPoints([
    hood[0], hood[1], { x: bx - 2, y: by - 47.5 }, { x: bx - 2, y: by - 33 },
  ], true, true);
  g.lineStyle(2, OUT, 1);
  g.strokePoints(hood, true, true);
  rimLine(g, bx + 5, by - 44, bx + 8, by - 34, 1.5, 0.45);
  if (!back) {
    // Face in shadow under the peak — a monk's face is never lit, which is one
    // more thing separating it from every other body on the field.
    g.fillStyle(0x3f3628, 1);
    g.fillEllipse(bx + 0.5, by - 38.5, 10, 8);
    g.fillStyle(shade(SKIN, -0.32), 1);
    g.fillEllipse(bx + 1, by - 38, 7.5, 6);
    g.fillStyle(OUT, 1);
    g.fillCircle(bx - 1, by - 38.6, 1);
    g.fillCircle(bx + 3, by - 38.6, 1);
  }

  // The book, held in both hands and raised as the blessing is given. The
  // `swing` phase carries it: wound back it is at the chest, following through
  // it is up and out, which is the healing gesture.
  const lift = P.swing;
  const kx = bx + 3 + lift * 5;
  const ky = by - 24 - lift * 7;
  g.fillStyle(OUT, 1);
  g.fillPoints([
    { x: kx - 9, y: ky - 1 }, { x: kx, y: ky - 6 },
    { x: kx + 9, y: ky - 1 }, { x: kx, y: ky + 5 },
  ], true, true);
  g.fillStyle(0x8a2f2a, 1);
  g.fillPoints([
    { x: kx - 7.5, y: ky - 1 }, { x: kx, y: ky - 4.6 },
    { x: kx + 7.5, y: ky - 1 }, { x: kx, y: ky + 3.4 },
  ], true, true);
  g.fillStyle(0xf2ecd8, 1);
  g.fillPoints([
    { x: kx - 6.5, y: ky - 1.6 }, { x: kx - 0.6, y: ky - 4.4 },
    { x: kx - 0.6, y: ky + 1.6 },
  ], true, true);
  g.fillStyle(0xe2dbc4, 1);
  g.fillPoints([
    { x: kx + 6.5, y: ky - 1.6 }, { x: kx + 0.6, y: ky - 4.4 },
    { x: kx + 0.6, y: ky + 1.6 },
  ], true, true);
  g.fillStyle(SKIN, 1);
  g.fillCircle(kx - 7, ky + 1.5, 2.4);
  g.fillCircle(kx + 7, ky + 1.5, 2.4);
  g.lineStyle(1.1, OUT, 1);
  g.strokeCircle(kx - 7, ky + 1.5, 2.4);
  g.strokeCircle(kx + 7, ky + 1.5, 2.4);
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

// `h` is tuned so the drawing reaches within a few px of the texture's top
// edge — the renderer hangs health bars off the sprite's top, so slack here
// shows up as a bar floating in mid-air.
const BSPEC = {
  towncenter: { fw: 3, fh: 3, w: 200, h: 236 },
  // Four houses, and each one gets its own frame box because each one is a
  // different shape — see BUILDING_VARIANTS and drawHouse. `w`/`h` here is
  // variant 0's box and stays exactly what it always was, so the default
  // drawing is byte-for-byte the one that shipped.
  house: {
    fw: 2,
    fh: 2,
    w: 136,
    h: 100,
    // Every box is at least 136 wide whatever the building on it does, because
    // the paved platform under it is the full 2x2 footprint and a narrower box
    // clips the paving, not the house. Height is the free dimension.
    vbox: [null, { w: 136, h: 94 }, { w: 136, h: 120 }, { w: 140, h: 102 }],
  },
  barracks: { fw: 3, fh: 3, wallH: 38, roofH: 24, crenels: true, w: 200, h: 164 },

  // --- the six that were falling through to the generic plaster box ----------
  //
  // Archery Range, Stable, Blacksmith, Siege Workshop, University and Monastery
  // are all 3x3, all cost within a few tens of wood of each other, and are all
  // built in the same part of a base — so of every readability problem in this
  // file, telling these apart is the hardest and the one that matters most. Six
  // buildings that share a silhouette are six buildings the player has to tap.
  //
  // The rule each of them is drawn to: ONE shape, above the roofline, that
  // nothing else in the game makes. Not a decal on a wall, not a colour, not a
  // different roof pitch — a shape in the outline, because at 0.7 zoom on a
  // 390px phone, with half the building behind a tree and a fog edge across the
  // rest, the outline is all there is.
  //
  //   Archery Range  a straw target butt: a disc on legs, standing on the
  //                  ground clear of the hall. The only circle at ground level.
  //   Stable         a black stall mouth with a horse's head coming out of it,
  //                  under the widest roof of the six.
  //   Blacksmith     one tall thin chimney with smoke on it, over a low hut.
  //                  A vertical spike where the others are horizontal.
  //   Siege Workshop an open timber gantry — an A-frame taller than the roof it
  //                  straddles, with a block and tackle hanging in the gap, and
  //                  a half-built engine's wheel under it.
  //   University     a dome. There is no other dome; the Mill's cap is a cone,
  //                  which is a different shape at any size.
  //   Monastery      a bell tower: a tall square shaft with an open belfry and
  //                  a cross, well above everything around it.
  //
  // fw/fh here MUST match BUILDING_STATS — nothing used to check, and a mismatch
  // silently makes the placement ghost disagree with the finished sprite. See
  // assertFootprints(), which now fails the bake if these drift.
  archeryrange: { fw: 3, fh: 3, range: true, w: 200, h: 142 },
  stable: { fw: 3, fh: 3, stable: true, w: 200, h: 142 },
  blacksmith: { fw: 3, fh: 3, smith: true, w: 200, h: 196 },
  siegeworkshop: { fw: 3, fh: 3, siege: true, w: 200, h: 161 },
  university: { fw: 3, fh: 3, university: true, w: 200, h: 193 },
  monastery: { fw: 3, fh: 3, monastery: true, w: 200, h: 189 },
  // --- the three drop-offs, and why they no longer share a body -------------
  //
  // They used to: one 2x2 plaster-and-timber box under one team-blue hip roof,
  // separated only by a prop the size of a postage stamp tucked against the
  // near wall. Measured at the zoom this game is actually played at, that prop
  // was about a quarter of the sprite, sat low, and was half hidden by the wall
  // in front of it — so a base with a Mill, a Lumber Camp and a Mining Camp in
  // it read as the same building three times, and the only way to tell them
  // apart was to tap each one.
  //
  // The fix is not a bigger decal. It is three different *shapes*, chosen so
  // that the difference survives being shrunk to a thumbnail, being seen from
  // any angle, and having its lower half hidden behind a tree:
  //
  //   Mill        a tall round tower with a conical cap and four sails.
  //               Vertical, curved, and the only thing on the map with a
  //               rotating machine bolted to it.
  //   Lumber Camp an open-sided timber shelter: four posts, a lean-to roof at
  //               a visible slant, and daylight through the middle of it.
  //               Horizontal, low, and see-through.
  //   Mining Camp a pit-head. A low rubble hut with a tall A-frame headframe
  //               and a winch wheel over the shaft mouth. A triangle spike.
  //
  // Roof colour is no longer carrying ownership for any of them, because all
  // three now have a shape to carry it instead; the team colour is on flags and
  // painted bands, which is where it stays legible without making every roof in
  // a base the same blue.
  mill: { fw: 2, fh: 2, mill: true, w: 136, h: 163 },
  farm: { fw: 2, fh: 2, w: 136, h: 96, stages: 3 },
  lumbercamp: { fw: 2, fh: 2, lumber: true, w: 136, h: 116 },
  miningcamp: { fw: 2, fh: 2, mine: true, w: 136, h: 139 },
  // The Market. Two striped awnings over a trestle of goods, in front of a low
  // plaster hall. Stripes are the whole design: there is nothing else striped
  // anywhere on this map, so a Market is identifiable at any zoom, from any
  // angle, and with its lower half behind a tree — which is the same test the
  // three drop-offs above had to pass. Deliberately *low* as well, so it never
  // competes with the Mill's tower or the Town Center's mast for the eye.
  market: { fw: 3, fh: 3, market: true, w: 200, h: 146 },
  // The two stone buildings that shoot. Both are drawn tall on purpose: a
  // defensive building whose silhouette does not clear the houses around it is a
  // defensive building the player forgets they own.
  watchtower: { fw: 1, fh: 1, tower: true, w: 72, h: 110 },
  castle: { fw: 4, fh: 4, castle: true, w: 280, h: 250 },
};

// The Town Center's roof is deliberately neither team colour. Packed bases put
// five house roofs against it, and when everything was the same blue the whole
// base read as one continuous mass; a warm tile roof separates the building the
// game revolves around from the housing around it at any zoom. Team identity
// moves onto the eave fascia, the door awning, the corner banners and the
// gonfalon on the mast — all of which stay loud.
const TILE_ROOF = 0xcb7c3a;
const TILE_ROOF_D = 0x8e4f20;
const STONE = 0xa8a294;
const STONE_D = 0x7c766a;

/**
 * Every BSPEC footprint must agree with the simulation's.
 *
 * Nothing else in the codebase cross-checks these. A BSPEC with the wrong fw/fh
 * still bakes, still packs and still draws — it just draws a building whose
 * platform is a different size from the tiles it occupies, so the placement
 * ghost and the finished sprite disagree, and the player is told they cannot
 * build somewhere that looks empty. That is a bug you find by squinting at a
 * screenshot, which is to say one you find months late; so it is a hard failure
 * at bake time instead, and the message names the pair.
 *
 * A missing BUILDING_STATS entry is fine and deliberately not an error: art may
 * be baked for something the rules do not carry yet. The reverse — a building
 * the rules know about with no art — is caught by drawBuilding's fallthrough.
 */
function assertFootprints() {
  const bad = [];
  for (const type of Object.keys(BSPEC)) {
    const stats = BUILDING_STATS[type];
    if (!stats) continue;
    const s = BSPEC[type];
    if (s.fw !== stats.fw || s.fh !== stats.fh) {
      bad.push(`${type}: BSPEC ${s.fw}x${s.fh} vs BUILDING_STATS ${stats.fw}x${stats.fh}`);
    }
  }
  if (bad.length) {
    throw new Error(`[gfx] building footprint mismatch — ${bad.join('; ')}`);
  }
}

function buildBuildings(put) {
  assertFootprints();
  for (let p = 0; p < PLAYER_COLORS.length; p++) {
    const col = PLAYER_COLORS[p];
    const dark = PLAYER_COLORS_DARK[p];
    for (const type of Object.keys(BSPEC)) {
      const s = BSPEC[type];
      const baseHH = (s.fw + s.fh) * (HALF_H / 2);
      const ax = s.w / 2;
      const ay = s.h - 6 - baseHH;
      if (type === 'farm') {
        for (let stage = 0; stage < s.stages; stage++) {
          put(farmFrame(p, stage), s.w, s.h, ax, ay, (g) =>
            drawFarm(g, s, ax, ay, col, dark, stage));
        }
      } else {
        // Every variant of a building gets its own box. Sharing one would mean
        // sizing it for the tallest drawing and then wasting that headroom on
        // every other — which on the house, the most-repeated frame in the
        // atlas, is exactly the pixels the variants are being paid for with.
        const nv = BUILDING_VARIANTS[type] || 1;
        for (let v = 0; v < nv; v++) {
          const box = (s.vbox && s.vbox[v]) || s;
          const vax = box.w / 2;
          const vay = box.h - 6 - baseHH;
          put(buildingFrame(type, p, v), box.w, box.h, vax, vay, (g) =>
            drawBuilding(g, type, s, vax, vay, col, dark, v));
        }
      }
    }
  }
}

/**
 * The ground the building stands on: an fw x fh block of packed stone.
 *
 * Now with the thing every sprite in this file was missing — a soft shadow on
 * the ground around it, thrown away from the sun. A building without one is a
 * sticker laid on the map; the same building with one is standing on it, and it
 * costs four ellipses at bake time and nothing at all per frame. The paving is
 * also lit now rather than flat: the north-east half catches the key, the
 * south-west half sits in the building's own ambient occlusion, and the stroke
 * round the rim is heavy on the shaded side and warm-and-thin on the lit one.
 */
function platform(g, cx, cy, hw, hh, stepped) {
  const base = [
    { x: cx, y: cy - hh },
    { x: cx + hw, y: cy },
    { x: cx, y: cy + hh },
    { x: cx - hw, y: cy },
  ];
  contactShadow(g, cx, cy + hh * 0.18, hw * 1.5, hh * 1.5, 1.15);
  g.fillStyle(0x5e5648, 1);
  g.fillPoints(base.map((p) => ({ x: p.x, y: p.y + 4 })), true, true);
  g.fillStyle(0x8d8271, 1);
  g.fillPoints(base, true, true);
  // Lit half and shaded half of the paving, split along the grid's other axis.
  g.fillStyle(lit(0x8d8271), 0.5);
  g.fillPoints([
    { x: cx, y: cy - hh }, { x: cx + hw, y: cy }, { x: cx, y: cy + hh },
  ], true, true);
  g.fillStyle(dim(0x8d8271), 0.45);
  g.fillPoints([
    { x: cx, y: cy - hh }, { x: cx - hw, y: cy }, { x: cx, y: cy + hh },
  ], true, true);
  g.lineStyle(2.5, OUT, 1);
  g.strokePoints(base, true, true);
  rimLine(g, cx, cy - hh + 1, cx + hw - 1, cy, 1.6, 0.35);
  if (stepped) {
    // A second, inset course. Reads as a raised dais and adds a little more
    // mass to the Town Center's base without widening its footprint.
    const inner = base.map((p) => ({
      x: cx + (p.x - cx) * 0.86,
      y: cy + (p.y - cy) * 0.86 - 3,
    }));
    g.fillStyle(shade(0x8d8271, 0.12), 1);
    g.fillPoints(inner, true, true);
    g.lineStyle(2, OUT, 0.9);
    g.strokePoints(inner, true, true);
  }
  return base;
}

function drawBuilding(g, type, s, cx, cy, col, colDark, variant = 0) {
  if (type === 'towncenter') {
    drawTownCenter(g, s, cx, cy, col, colDark);
    return;
  }
  if (type === 'house') {
    drawHouse(g, s, cx, cy, col, colDark, variant);
    return;
  }
  if (s.tower) {
    drawWatchTower(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.castle) {
    drawCastle(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.mill) {
    drawMill(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.lumber) {
    drawLumberCamp(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.mine) {
    drawMiningCamp(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.market) {
    drawMarket(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.range) {
    drawArcheryRange(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.stable) {
    drawStable(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.smith) {
    drawBlacksmith(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.siege) {
    drawSiegeWorkshop(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.university) {
    drawUniversity(g, s, cx, cy, col, colDark);
    return;
  }
  if (s.monastery) {
    drawMonastery(g, s, cx, cy, col, colDark);
    return;
  }

  // Footprint diamond: an fw x fh block spans (fw+fh) half-tiles each way.
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);

  platform(g, cx, cy, hw, hh, false);

  const iw = hw * 0.78;
  const ih = hh * 0.78;
  isoBox(g, cx, cy, iw, ih, s.wallH, PLASTER, PLASTER_D, shade(PLASTER, 0.1));

  // Timber framing on the two visible walls.
  timbers(g, cx, cy, iw, ih, s.wallH);

  const topY = cy - s.wallH;
  isoRoof(g, cx, topY, iw * 1.14, ih * 1.14, s.roofH, col, colDark);

  if (s.crenels) crenellations(g, cx, topY, iw * 1.14, ih * 1.14, col, colDark);

  // Door on the south-facing wall.
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(cx - 7, cy + ih - s.wallH + 2, 14, s.wallH - 6, 3);
  g.lineStyle(2, OUT, 1);
  g.strokeRoundedRect(cx - 7, cy + ih - s.wallH + 2, 14, s.wallH - 6, 3);
  g.fillStyle(0xdcc36a, 1);
  g.fillCircle(cx + 4, cy + ih - s.wallH / 2, 1.6);

  if (type === 'barracks') {
    // crossed swords, painted on the wall
    g.lineStyle(3.4, OUT, 1);
    g.beginPath();
    g.moveTo(cx - 26, cy + 4);
    g.lineTo(cx - 12, cy - 10);
    g.moveTo(cx - 26, cy - 10);
    g.lineTo(cx - 12, cy + 4);
    g.strokePath();
    g.lineStyle(1.8, STEEL, 1);
    g.beginPath();
    g.moveTo(cx - 26, cy + 4);
    g.lineTo(cx - 12, cy - 10);
    g.moveTo(cx - 26, cy - 10);
    g.lineTo(cx - 12, cy + 4);
    g.strokePath();
  }

  banner(g, cx + iw * 0.72, cy + 3, col, colDark, 26);
}

// ---------------------------------------------------------------------------
// The three drop-offs
// ---------------------------------------------------------------------------

/**
 * A tapered cylinder in this projection: two ellipses and the sheet between
 * them. Nothing else in the game is round, which is most of the reason the Mill
 * is now findable — a curve in a world of flat planes is visible at a glance
 * even when it is twenty pixels tall.
 *
 * Shaded in three vertical bands rather than two, because two bands on a curve
 * reads as a folded box. Light from the upper right, like everything else.
 */
function isoCylinder(g, cx, cyBase, rBase, rTop, h, base, top) {
  const ryB = rBase * 0.5;
  const ryT = rTop * 0.5;
  const yT = cyBase - h;
  const body = [
    { x: cx - rBase, y: cyBase },
    { x: cx - rTop, y: yT },
    { x: cx + rTop, y: yT },
    { x: cx + rBase, y: cyBase },
  ];
  g.fillStyle(shade(base, -0.22), 1);
  g.fillPoints(body, true, true);
  // Lit band, right of centre.
  g.fillStyle(base, 1);
  g.fillPoints([
    { x: cx - rBase * 0.25, y: cyBase },
    { x: cx - rTop * 0.25, y: yT },
    { x: cx + rTop, y: yT },
    { x: cx + rBase, y: cyBase },
  ], true, true);
  g.fillStyle(shade(base, 0.16), 1);
  g.fillPoints([
    { x: cx + rBase * 0.35, y: cyBase },
    { x: cx + rTop * 0.35, y: yT },
    { x: cx + rTop * 0.82, y: yT },
    { x: cx + rBase * 0.82, y: cyBase },
  ], true, true);
  // Bottom curve, then the outline, then the lid.
  g.fillStyle(shade(base, -0.22), 1);
  g.fillEllipse(cx, cyBase, rBase * 2, ryB * 2);
  g.lineStyle(2.4, OUT, 1);
  g.beginPath();
  g.moveTo(cx - rBase, cyBase);
  g.lineTo(cx - rTop, yT);
  g.moveTo(cx + rBase, cyBase);
  g.lineTo(cx + rTop, yT);
  g.strokePath();
  g.lineStyle(2.4, OUT, 1);
  g.beginPath();
  g.arc(cx, cyBase, rBase, 0, Math.PI, false);
  g.strokePath();
  g.fillStyle(top, 1);
  g.fillEllipse(cx, yT, rTop * 2, ryT * 2);
  g.lineStyle(2.2, OUT, 1);
  g.strokeEllipse(cx, yT, rTop * 2, ryT * 2);
  return { yT, ryT };
}

/**
 * The Mill: a tower mill, and the tallest thing in an early base after the
 * Town Center.
 *
 * Everything about it is vertical and round against a map of low horizontal
 * boxes, and the sails put a shape at the top of it that no roof can imitate.
 * The sails are drawn as open lattice frames, not solid vanes, so the tower
 * and the sky show through them — a solid disc at this size just reads as a
 * second roof.
 */
function drawMill(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, false);

  // A stone plinth so the tower is founded on something.
  isoCylinder(g, cx, cy + 3, hw * 0.5, hw * 0.46, 9, STONE, shade(STONE, 0.18));

  const H = 76;
  const rBase = hw * 0.44;
  const rTop = hw * 0.31;
  const { yT } = isoCylinder(g, cx, cy - 5, rBase, rTop, H, PLASTER, shade(PLASTER, 0.12));

  // Courses around the tower — horizontal, so they curve the eye round it.
  g.lineStyle(1.1, PLASTER_D, 0.5);
  for (let k = 1; k <= 4; k++) {
    const t = k / 5;
    const r = rBase + (rTop - rBase) * t;
    const y = cy - 5 - H * t;
    g.beginPath();
    g.arc(cx, y, r, 0.15, Math.PI - 0.15, false);
    g.strokePath();
  }

  // Door and a shuttered window.
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(cx - 7, cy - 27, 14, 24, 3);
  g.lineStyle(2, OUT, 1);
  g.strokeRoundedRect(cx - 7, cy - 27, 14, 24, 3);
  g.fillStyle(0xdcc36a, 1);
  g.fillCircle(cx + 4, cy - 15, 1.6);
  g.fillStyle(shade(WOOD_D, 0.2), 1);
  g.fillRect(cx - 5, cy - 52, 10, 9);
  g.lineStyle(1.6, OUT, 1);
  g.strokeRect(cx - 5, cy - 52, 10, 9);

  // A painted band under the cap, which is where this building keeps its team
  // colour now that its roof is not blue.
  g.fillStyle(colDark, 1);
  g.fillRect(cx - rTop, yT - 5, rTop * 2, 6);
  g.fillStyle(col, 1);
  g.fillRect(cx - rTop, yT - 5, rTop * 2, 3);
  g.lineStyle(1.6, OUT, 1);
  g.strokeRect(cx - rTop, yT - 5, rTop * 2, 6);

  // Conical cap.
  const apex = yT - 30;
  g.fillStyle(shade(WOOD_D, -0.15), 1);
  g.fillPoints([
    { x: cx - rTop - 3, y: yT }, { x: cx, y: apex }, { x: cx + rTop + 3, y: yT },
  ], true, true);
  g.fillStyle(WOOD_D, 1);
  g.fillPoints([
    { x: cx, y: yT + 2 }, { x: cx, y: apex }, { x: cx + rTop + 3, y: yT },
  ], true, true);
  g.lineStyle(2.4, OUT, 1);
  g.strokePoints([
    { x: cx - rTop - 3, y: yT }, { x: cx, y: apex }, { x: cx + rTop + 3, y: yT },
  ], true, true);
  g.lineStyle(1, shade(WOOD_D, 0.25), 0.6);
  for (let k = 1; k <= 3; k++) {
    const t = k / 4;
    g.beginPath();
    g.moveTo(cx - (rTop + 3) * (1 - t), yT - (yT - apex) * t);
    g.lineTo(cx + (rTop + 3) * (1 - t), yT - (yT - apex) * t);
    g.strokePath();
  }

  // The sails. Hub on the front of the cap, four lattice arms.
  const hubX = cx + 2;
  const hubY = yT - 16;
  const R = 34;
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI / 2) * i + 0.42;
    const ux = Math.cos(a);
    const uy = Math.sin(a) * 0.72;
    const tipX = hubX + ux * R;
    const tipY = hubY + uy * R;
    // The two rails of the frame, offset either side of the arm's axis.
    const px = -uy * 3.2;
    const py = ux * 3.2;
    g.lineStyle(3.4, OUT, 1);
    g.beginPath();
    g.moveTo(hubX + px, hubY + py);
    g.lineTo(tipX + px, tipY + py);
    g.moveTo(hubX - px, hubY - py);
    g.lineTo(tipX - px, tipY - py);
    g.strokePath();
    g.lineStyle(1.8, 0xd9c79a, 1);
    g.beginPath();
    g.moveTo(hubX + px, hubY + py);
    g.lineTo(tipX + px, tipY + py);
    g.moveTo(hubX - px, hubY - py);
    g.lineTo(tipX - px, tipY - py);
    g.strokePath();
    // Rungs.
    g.lineStyle(1.4, 0xbca97c, 0.95);
    for (let k = 1; k <= 4; k++) {
      const t = k / 5;
      const mx = hubX + ux * R * t;
      const my = hubY + uy * R * t;
      g.beginPath();
      g.moveTo(mx + px, my + py);
      g.lineTo(mx - px, my - py);
      g.strokePath();
    }
  }
  g.fillStyle(OUT, 1);
  g.fillCircle(hubX, hubY, 5.4);
  g.fillStyle(STEEL_D, 1);
  g.fillCircle(hubX, hubY, 3.6);

  // Sack of grain and a flag at the foot, so the ground level says "food".
  const sx = cx - hw * 0.72;
  const sy = cy + hh * 0.3;
  for (const [dx, dy, r] of [[0, 0, 7], [9, 2, 6]]) {
    g.fillStyle(OUT, 1);
    g.fillEllipse(sx + dx, sy + dy, r * 2 + 3, r * 2.3);
    g.fillStyle(0xc0a469, 1);
    g.fillEllipse(sx + dx, sy + dy, r * 2, r * 1.9);
    g.fillStyle(0xd8c48c, 1);
    g.fillEllipse(sx + dx + r * 0.3, sy + dy - r * 0.4, r * 0.9, r * 0.7);
    g.lineStyle(1.2, shade(0xc0a469, -0.35), 0.8);
    g.beginPath();
    g.moveTo(sx + dx - r * 0.6, sy + dy - r * 0.9);
    g.lineTo(sx + dx + r * 0.6, sy + dy - r * 0.8);
    g.strokePath();
  }
  banner(g, cx + hw * 0.74, cy + 4, col, colDark, 26);
}

/**
 * The Lumber Camp: an open-sided shelter, and the only building on the map you
 * can see through.
 *
 * Four posts and a lean-to roof at a visible slant — no walls at all. The gap
 * between the roof and the ground is the read: at any zoom there is daylight
 * through the middle of this building and none through any other, and the roof
 * plane is tilted where every other roof in the game is symmetrical. What
 * stands under it is the work: stacked trunks, a trestle with a log on it, and
 * a two-man saw.
 */
function drawLumberCamp(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, false);

  const iw = hw * 0.86;
  const ih = hh * 0.86;
  const N = { x: cx, y: cy - ih };
  const E = { x: cx + iw, y: cy };
  const S = { x: cx, y: cy + ih };
  const W = { x: cx - iw, y: cy };
  // The lean: the back post is a third taller than the front one.
  const hN = 52;
  const hE = 42;
  const hW = 42;
  const hS = 32;
  const post = (p, h) => {
    g.fillStyle(WOOD_D, 1);
    g.fillRect(p.x - 3.4, p.y - h, 6.8, h);
    g.lineStyle(2, OUT, 1);
    g.strokeRect(p.x - 3.4, p.y - h, 6.8, h);
    g.fillStyle(shade(WOOD, 0.1), 1);
    g.fillRect(p.x + 0.6, p.y - h + 1, 2.2, h - 2);
  };

  // Back posts and the log stacks first: the near posts have to overlap them.
  post(N, hN);
  post(W, hW);

  // Stacked trunks under the shelter.
  const logRow = (ox, oy, n, r) => {
    for (let i = 0; i < n; i++) {
      const x = ox + i * (r * 2.1);
      g.fillStyle(OUT, 1);
      g.fillCircle(x, oy, r + 1.6);
      g.fillStyle(WOOD_D, 1);
      g.fillCircle(x, oy, r);
      g.fillStyle(0xc59a5f, 1);
      g.fillCircle(x + r * 0.18, oy - r * 0.2, r * 0.62);
      g.lineStyle(1, shade(WOOD_D, -0.15), 0.9);
      g.strokeCircle(x + r * 0.18, oy - r * 0.2, r * 0.3);
    }
  };
  logRow(cx - 26, cy - 4, 4, 6.5);
  logRow(cx - 19, cy - 15, 3, 6.5);

  // A trestle with a log across it, mid-cut, and the saw standing in the kerf.
  const tx = cx + 16;
  const ty = cy + 6;
  g.lineStyle(3, OUT, 1);
  g.beginPath();
  g.moveTo(tx - 9, ty);
  g.lineTo(tx - 3, ty - 13);
  g.moveTo(tx + 3, ty);
  g.lineTo(tx - 3, ty - 13);
  g.moveTo(tx + 6, ty);
  g.lineTo(tx + 12, ty - 13);
  g.moveTo(tx + 18, ty);
  g.lineTo(tx + 12, ty - 13);
  g.strokePath();
  g.lineStyle(1.6, WOOD, 1);
  g.beginPath();
  g.moveTo(tx - 9, ty);
  g.lineTo(tx - 3, ty - 13);
  g.moveTo(tx + 3, ty);
  g.lineTo(tx - 3, ty - 13);
  g.moveTo(tx + 6, ty);
  g.lineTo(tx + 12, ty - 13);
  g.moveTo(tx + 18, ty);
  g.lineTo(tx + 12, ty - 13);
  g.strokePath();
  g.fillStyle(OUT, 1);
  g.fillRoundedRect(tx - 12, ty - 21, 30, 10, 5);
  g.fillStyle(WOOD, 1);
  g.fillRoundedRect(tx - 10.5, ty - 20, 27, 7.4, 3.7);
  g.fillStyle(shade(WOOD, 0.22), 1);
  g.fillRect(tx - 9, ty - 19.4, 24, 2.4);
  stick(g, tx + 2, ty - 21, tx + 9, ty - 36, 2, STEEL);
  g.lineStyle(1.2, STEEL_D, 1);
  for (let k = 1; k <= 4; k++) {
    const t = k / 5;
    g.beginPath();
    g.moveTo(tx + 2 + 7 * t, ty - 21 - 15 * t);
    g.lineTo(tx + 4.4 + 7 * t, ty - 20 - 15 * t);
    g.strokePath();
  }

  post(E, hE);
  post(S, hS);

  // The roof: one tilted plane, with a thickness edge along the two near sides
  // so it does not read as a flat sticker.
  const rN = { x: N.x, y: N.y - hN };
  const rE = { x: E.x, y: E.y - hE };
  const rS = { x: S.x, y: S.y - hS };
  const rW = { x: W.x, y: W.y - hW };
  const plane = [rN, rE, rS, rW];
  const eave = 5;
  g.fillStyle(shade(WOOD_D, -0.25), 1);
  g.fillPoints([
    rW, rS, rE,
    { x: rE.x, y: rE.y + eave }, { x: rS.x, y: rS.y + eave }, { x: rW.x, y: rW.y + eave },
  ], true, true);
  g.fillStyle(0x8a6338, 1);
  g.fillPoints(plane, true, true);
  // Planks running down the slope.
  g.lineStyle(1.2, shade(0x8a6338, -0.34), 0.65);
  for (let k = 1; k <= 5; k++) {
    const t = k / 6;
    g.beginPath();
    g.moveTo(rW.x + (rN.x - rW.x) * t, rW.y + (rN.y - rW.y) * t);
    g.lineTo(rS.x + (rE.x - rS.x) * t, rS.y + (rE.y - rS.y) * t);
    g.strokePath();
  }
  g.lineStyle(1.4, shade(0x8a6338, 0.22), 0.5);
  g.beginPath();
  g.moveTo(rW.x, rW.y);
  g.lineTo(rN.x, rN.y);
  g.lineTo(rE.x, rE.y);
  g.strokePath();
  g.lineStyle(2.4, OUT, 1);
  g.strokePoints(plane, true, true);

  // An axe left in a chopping block by the front post, and the pennant on the
  // tall back post.
  g.fillStyle(WOOD_D, 1);
  g.fillEllipse(cx - hw * 0.66, cy + hh * 0.36, 15, 7);
  g.fillStyle(0xc59a5f, 1);
  g.fillEllipse(cx - hw * 0.66, cy + hh * 0.36 - 1.4, 11, 4.6);
  g.lineStyle(1.8, OUT, 1);
  g.strokeEllipse(cx - hw * 0.66, cy + hh * 0.36, 15, 7);
  stick(g, cx - hw * 0.66, cy + hh * 0.36 - 2, cx - hw * 0.66 - 7, cy + hh * 0.36 - 17, 2.2, WOOD);
  const axeHead = [
    { x: cx - hw * 0.66 - 9, y: cy + hh * 0.36 - 21 },
    { x: cx - hw * 0.66 - 1, y: cy + hh * 0.36 - 20 },
    { x: cx - hw * 0.66 - 6, y: cy + hh * 0.36 - 14 },
  ];
  g.fillStyle(STEEL, 1);
  g.fillPoints(axeHead, true, true);
  g.lineStyle(1.6, OUT, 1);
  g.strokePoints(axeHead, true, true);

  stick(g, rN.x, rN.y, rN.x, rN.y - 20, 2, 0x6a5334);
  g.fillStyle(col, 1);
  g.fillTriangle(rN.x, rN.y - 20, rN.x + 14, rN.y - 16, rN.x, rN.y - 11);
  g.lineStyle(1.6, OUT, 1);
  g.strokeTriangle(rN.x, rN.y - 20, rN.x + 14, rN.y - 16, rN.x, rN.y - 11);
}

/**
 * The Mining Camp: a pit-head.
 *
 * A low hut of rubble stone with a tall timber headframe over the shaft — two
 * raking legs, a winch wheel at the peak and a rope going down into a hole in
 * the ground. The silhouette is a triangle standing on a flat, which is the
 * opposite of both the Mill's round tower and the Lumber Camp's horizontal
 * slab, and it is a shape no roof in the game makes.
 *
 * It is stone and iron throughout — no plaster, no timber framing, no thatch —
 * so it reads as a different *material* as well as a different shape.
 */
function drawMiningCamp(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, false);

  // The shaft mouth, cut into the platform, with a timber collar.
  const shx = cx + hw * 0.16;
  const shy = cy + hh * 0.12;
  g.fillStyle(0x3a3226, 1);
  g.fillEllipse(shx, shy, 34, 17);
  g.fillStyle(0x0d0b07, 1);
  g.fillEllipse(shx, shy, 27, 13);
  g.lineStyle(2.2, OUT, 1);
  g.strokeEllipse(shx, shy, 34, 17);

  // The hut: low rubble walls, a plank lean-to roof, no plaster anywhere.
  const hutX = cx - hw * 0.48;
  const hutY = cy - hh * 0.14;
  const hiw = hw * 0.42;
  const hih = hh * 0.42;
  const wallH = 22;
  isoBox(g, hutX, hutY, hiw, hih, wallH, 0x8d8578, 0x9c9486, shade(0x9c9486, 0.14));
  // Rubble courses: short broken lines rather than the timber frame the other
  // buildings wear.
  g.lineStyle(1.1, 0x6a6357, 0.7);
  for (let k = 1; k <= 3; k++) {
    const y = hutY - (wallH * k) / 4;
    g.beginPath();
    g.moveTo(hutX - hiw, y);
    g.lineTo(hutX, y + hih);
    g.lineTo(hutX + hiw, y);
    g.strokePath();
  }
  g.fillStyle(0x2a231a, 1);
  g.fillRect(hutX - 6, hutY + hih - wallH + 2, 12, wallH - 4);
  g.lineStyle(1.8, OUT, 1);
  g.strokeRect(hutX - 6, hutY + hih - wallH + 2, 12, wallH - 4);
  // Plank lean-to over the hut.
  const rT = hutY - wallH;
  const roof = [
    { x: hutX - hiw - 4, y: rT - 2 },
    { x: hutX, y: rT + hih + 2 },
    { x: hutX + hiw + 4, y: rT - 12 },
    { x: hutX, y: rT - hih - 12 },
  ];
  g.fillStyle(0x6f5330, 1);
  g.fillPoints(roof, true, true);
  g.lineStyle(1.2, shade(0x6f5330, -0.3), 0.7);
  for (let k = 1; k <= 4; k++) {
    const t = k / 5;
    g.beginPath();
    g.moveTo(roof[0].x + (roof[3].x - roof[0].x) * t, roof[0].y + (roof[3].y - roof[0].y) * t);
    g.lineTo(roof[1].x + (roof[2].x - roof[1].x) * t, roof[1].y + (roof[2].y - roof[1].y) * t);
    g.strokePath();
  }
  g.lineStyle(2.2, OUT, 1);
  g.strokePoints(roof, true, true);

  // The headframe. Two raking legs from the far and near sides of the shaft,
  // meeting over its centre.
  const peakY = shy - 84;
  const legs = [
    { x: shx - 26, y: shy + 8 },
    { x: shx + 26, y: shy + 8 },
    { x: shx - 6, y: shy - 12 },
  ];
  for (const l of legs) {
    stick(g, l.x, l.y, shx, peakY, 3.4, 0x7b5a33);
  }
  // Cross braces, at two heights, on the pair of legs facing the camera.
  for (const t of [0.34, 0.64]) {
    const ax = legs[0].x + (shx - legs[0].x) * t;
    const ay = legs[0].y + (peakY - legs[0].y) * t;
    const bx = legs[1].x + (shx - legs[1].x) * t;
    const by = legs[1].y + (peakY - legs[1].y) * t;
    stick(g, ax, ay, bx, by, 2, 0x7b5a33);
  }
  // Diagonals, so the frame is braced rather than just three sticks.
  stick(g, legs[0].x + (shx - legs[0].x) * 0.34, legs[0].y + (peakY - legs[0].y) * 0.34,
    legs[1].x + (shx - legs[1].x) * 0.64, legs[1].y + (peakY - legs[1].y) * 0.64, 1.5, 0x7b5a33);

  // The winch wheel and its rope.
  g.fillStyle(OUT, 1);
  g.fillCircle(shx, peakY + 6, 10.5);
  g.fillStyle(0x6a6357, 1);
  g.fillCircle(shx, peakY + 6, 8.6);
  g.fillStyle(0x9c9486, 1);
  g.fillCircle(shx + 1, peakY + 5, 5.4);
  g.lineStyle(1.5, OUT, 1);
  for (let k = 0; k < 4; k++) {
    const a = (Math.PI / 4) * k + 0.3;
    g.beginPath();
    g.moveTo(shx - Math.cos(a) * 8, peakY + 6 - Math.sin(a) * 8);
    g.lineTo(shx + Math.cos(a) * 8, peakY + 6 + Math.sin(a) * 8);
    g.strokePath();
  }
  g.fillStyle(STEEL_D, 1);
  g.fillCircle(shx, peakY + 6, 2.2);
  g.lineStyle(1.6, 0x2a231a, 0.9);
  g.beginPath();
  g.moveTo(shx - 9, peakY + 8);
  g.lineTo(shx - 9, shy - 12);
  g.strokePath();
  // The bucket on the end of it, hanging over the shaft.
  g.fillStyle(OUT, 1);
  g.fillRoundedRect(shx - 15, shy - 14, 13, 12, 2.5);
  g.fillStyle(0x5f4a2c, 1);
  g.fillRoundedRect(shx - 14, shy - 13, 11, 10, 2);
  g.fillStyle(STEEL_D, 1);
  g.fillRect(shx - 14, shy - 9, 11, 2);
  g.fillStyle(0x8d99a6, 1);
  g.fillCircle(shx - 10, shy - 11.5, 2.2);
  g.fillStyle(0xf5c333, 1);
  g.fillCircle(shx - 6.5, shy - 11, 2);

  // Ore heaped beside the shaft: grey rock, one gold nugget, one pale stone.
  const bx = cx - hw * 0.12;
  const by = cy + hh * 0.52;
  const heap = [{ x: bx - 7, y: by - 1 }, { x: bx + 6, y: by }, { x: bx, y: by - 8 }];
  g.fillStyle(OUT, 1);
  for (const hp of heap) g.fillCircle(hp.x, hp.y, 7.4);
  g.fillStyle(0x6a747f, 1);
  for (const hp of heap) g.fillCircle(hp.x, hp.y, 6);
  g.fillStyle(0x8d99a6, 1);
  for (const hp of heap) g.fillCircle(hp.x + 1.4, hp.y - 1.8, 4);
  g.fillStyle(0xf5c333, 1);
  g.fillCircle(bx + 2, by - 11, 2.6);
  g.fillStyle(0xd8e2ec, 1);
  g.fillCircle(bx - 5, by - 9, 2.4);

  // Team pennant at the peak of the frame — the highest point, so ownership is
  // readable even when the hut is behind a tree.
  stick(g, shx, peakY, shx, peakY - 16, 2, 0x6a5334);
  g.fillStyle(col, 1);
  g.fillTriangle(shx, peakY - 16, shx + 14, peakY - 12, shx, peakY - 7);
  g.lineStyle(1.6, OUT, 1);
  g.strokeTriangle(shx, peakY - 16, shx + 14, peakY - 12, shx, peakY - 7);
  g.fillStyle(colDark, 1);
  g.fillTriangle(shx, peakY - 13.5, shx + 7, peakY - 11.6, shx, peakY - 9.6);
}

// ---------------------------------------------------------------------------
// The Market
// ---------------------------------------------------------------------------
//
// A low plaster hall at the back, two striped awnings on poles in front of it,
// and a trestle of goods under them. The stripes do all the work: nothing else
// on this map is striped, so a Market survives the two tests the drop-offs had
// to pass — shrunk to a thumbnail, and with its lower half behind a tree.
//
// It is drawn deliberately *wide and low* rather than tall. The tall silhouettes
// are all spoken for (the Mill's tower, the Town Center's mast, the tower and
// the Castle), and a fourth one would start a crowd; a broad flat shape with a
// bright roofline is the gap in the base's skyline that nothing else fills.

/** One awning: an iso quad in two colours, striped along its slope. */
function awning(g, cx, cy, hw, hh, lift, a, b) {
  const W = { x: cx - hw, y: cy + lift * 0.35 };
  const S = { x: cx, y: cy + hh + lift * 0.5 };
  const E = { x: cx + hw, y: cy + lift * 0.35 };
  const N = { x: cx, y: cy - hh };
  const quad = [W, S, E, N];
  g.fillStyle(a, 1);
  g.fillPoints(quad, true, true);
  // Stripes run from the ridge (N-E edge) down to the eave (W-S edge), which is
  // the direction a real awning's cloth runs and the direction that reads as
  // fabric rather than as a chequerboard.
  g.fillStyle(b, 1);
  for (let k = 0; k < 4; k++) {
    const t0 = k / 4 + 0.02;
    const t1 = t0 + 0.11;
    const p = (from, to, t) => ({
      x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t,
    });
    g.fillPoints([
      p(W, S, t0), p(W, S, t1), p(N, E, t1), p(N, E, t0),
    ], true, true);
  }
  g.lineStyle(2.2, OUT, 1);
  g.strokePoints(quad, true, true);
  return quad;
}

function drawMarket(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, false);

  // The hall at the back: plaster and timber, like a house, under thatch. Not
  // the Town Center's warm tile and not a team roof — the tile is the one thing
  // the Town Center owns outright on this map (see the note above drawTownCenter)
  // and a second building wearing it would cost the base its landmark.
  const THATCH = 0x9a8850;
  const THATCH_D = 0x6a5c31;
  const hallX = cx - hw * 0.18;
  const hallY = cy - hh * 0.34;
  const hiw = hw * 0.52;
  const hih = hh * 0.52;
  const wallH = 26;
  isoBox(g, hallX, hallY, hiw, hih, wallH, PLASTER, PLASTER_D, shade(PLASTER, 0.1));
  timbers(g, hallX, hallY, hiw, hih, wallH);
  isoRoof(g, hallX, hallY - wallH, hiw * 1.16, hih * 1.16, 15, THATCH, THATCH_D);
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(hallX - 6, hallY + hih - wallH + 3, 12, wallH - 7, 2.5);
  g.lineStyle(1.8, OUT, 1);
  g.strokeRoundedRect(hallX - 6, hallY + hih - wallH + 3, 12, wallH - 7, 2.5);

  // Two stalls in front, the near one lower and to the right so they overlap
  // and read as a row rather than as one wide tent.
  const stalls = [
    { x: cx - hw * 0.46, y: cy + hh * 0.22, w: hw * 0.58, a: 0xe8e0d0, b: col },
    { x: cx + hw * 0.38, y: cy + hh * 0.5, w: hw * 0.54, a: 0xe8e0d0, b: colDark },
  ];
  for (const st of stalls) {
    const top = st.y - 34;
    // Four poles, drawn before the cloth so the cloth sits on them.
    stick(g, st.x - st.w * 0.8, st.y + 6, st.x - st.w * 0.8, top + 6, 2.2, 0x7b5a33);
    stick(g, st.x + st.w * 0.8, st.y + 6, st.x + st.w * 0.8, top + 6, 2.2, 0x7b5a33);
    // The trestle table under it: a plank on two crossed legs.
    g.fillStyle(OUT, 1);
    g.fillEllipse(st.x, st.y + 4, st.w * 1.5, st.w * 0.44);
    g.fillStyle(WOOD, 1);
    g.fillEllipse(st.x, st.y + 2.5, st.w * 1.4, st.w * 0.4);
    g.fillStyle(shade(WOOD, 0.16), 1);
    g.fillEllipse(st.x - 1, st.y + 1, st.w * 1.15, st.w * 0.3);
    // Goods on it: a sack of grain, a stack of planks, a pale stone block and
    // one coin, so all three tradeable things and the money are on the counter.
    g.fillStyle(OUT, 1);
    g.fillCircle(st.x - st.w * 0.42, st.y - 4, 6.6);
    g.fillStyle(0xd9c489, 1);
    g.fillCircle(st.x - st.w * 0.42, st.y - 4.8, 5.2);
    g.fillStyle(OUT, 1);
    g.fillRect(st.x - 6, st.y - 9, 15, 8);
    g.fillStyle(WOOD, 1);
    g.fillRect(st.x - 5, st.y - 8, 13, 3);
    g.fillStyle(shade(WOOD, 0.2), 1);
    g.fillRect(st.x - 5, st.y - 4.5, 13, 3);
    g.fillStyle(OUT, 1);
    g.fillRect(st.x + st.w * 0.4 - 5, st.y - 9, 11, 9);
    g.fillStyle(0xc9c2b2, 1);
    g.fillRect(st.x + st.w * 0.4 - 4, st.y - 8, 9, 7);
    g.fillStyle(0xf5c333, 1);
    g.fillCircle(st.x + st.w * 0.72, st.y - 2, 2.6);
    g.lineStyle(1.2, OUT, 1);
    g.strokeCircle(st.x + st.w * 0.72, st.y - 2, 2.6);
    // The cloth last, over the top of all of it.
    awning(g, st.x, top, st.w, st.w * 0.36, 9, st.a, st.b);
  }

  // A pair of scales on the hall's gable — the one decal that says *trade*
  // rather than "shop", and the only place a straight vertical line survives at
  // this size.
  const sx = hallX + hiw * 0.62;
  const sy = hallY - wallH - 6;
  stick(g, sx, sy + 12, sx, sy - 6, 1.8, 0x6a5334);
  stick(g, sx - 9, sy - 4, sx + 9, sy - 4, 1.6, 0x6a5334);
  for (const dx of [-9, 9]) {
    g.lineStyle(1.2, OUT, 1);
    g.beginPath();
    g.moveTo(sx + dx, sy - 4);
    g.lineTo(sx + dx, sy + 1);
    g.strokePath();
    g.fillStyle(OUT, 1);
    g.fillEllipse(sx + dx, sy + 2.5, 9, 4);
    g.fillStyle(0xf5c333, 1);
    g.fillEllipse(sx + dx, sy + 2, 7, 3);
  }

  banner(g, cx + hw * 0.78, cy + hh * 0.1, col, colDark, 24);
}
// ---------------------------------------------------------------------------
// The six military and research buildings
// ---------------------------------------------------------------------------
//
// See the block in BSPEC for what each of these has to say in silhouette and
// why. Everything below shares one skeleton — platform, body, roof, one big
// identifying shape, a banner — and differs only in that identifying shape,
// which is deliberate: a base wants to look like a base, so the family
// resemblance is as much the job as the difference.

/**
 * A dome, in this projection: half an ellipsoid sitting on a drum.
 *
 * Built the same way isoCylinder is — a silhouette in the shaded tone, a lit
 * lobe over it offset towards the sun, a bright specular near the top-right and
 * a warm rim along the sunward limb — because Graphics has no radial gradient
 * and a two-tone dome reads as a folded paper hat. The horizontal courses are
 * what turn it from a circle into a curved surface; without them the eye has
 * nothing to follow round it.
 */
function isoDome(g, cx, cyBase, r, h, base) {
  const N = 15;
  const arc = (k) => {
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const a = Math.PI + (Math.PI * i) / N;
      pts.push({ x: cx + Math.cos(a) * r * k, y: cyBase + Math.sin(a) * h * k });
    }
    return pts;
  };
  const shell = arc(1);
  g.fillStyle(dim(base), 1);
  g.fillPoints(shell, true, true);
  // The lit lobe: the same dome shrunk and pushed up-right, which is what the
  // terminator on a sphere lit from that direction actually looks like.
  g.fillStyle(base, 1);
  g.fillPoints(arc(0.88).map((p) => ({ x: p.x + r * 0.11, y: p.y - h * 0.07 })), true, true);
  g.fillStyle(lit(base), 1);
  g.fillPoints(arc(0.6).map((p) => ({ x: p.x + r * 0.28, y: p.y - h * 0.16 })), true, true);
  g.fillStyle(mix(lit(base), 0xffffff, 0.45), 0.7);
  g.fillEllipse(cx + r * 0.34, cyBase - h * 0.62, r * 0.3, h * 0.26);
  // Courses.
  g.lineStyle(1, dim(base), 0.45);
  for (let k = 1; k <= 3; k++) {
    const t = k / 4;
    g.beginPath();
    const pts = arc(1 - t * 0.05);
    for (let i = 0; i <= N; i++) {
      const p = { x: pts[i].x, y: pts[i].y * (1 - 0) };
      const yy = cyBase - (cyBase - p.y) * (1 - t * 0.9);
      if (i === 0) g.moveTo(p.x * (1 - t * 0.3) + cx * t * 0.3, yy);
      else g.lineTo(p.x * (1 - t * 0.3) + cx * t * 0.3, yy);
    }
    g.strokePath();
  }
  g.lineStyle(2.4, OUT, 1);
  g.strokePoints(shell, false, false);
  // Warm bounce along the sunward limb.
  g.lineStyle(1.6, RIM, 0.4);
  g.beginPath();
  const s = arc(0.96);
  for (let i = Math.floor(N * 0.5); i <= N; i++) {
    if (i === Math.floor(N * 0.5)) g.moveTo(s[i].x, s[i].y);
    else g.lineTo(s[i].x, s[i].y);
  }
  g.strokePath();
}

/**
 * A curl of smoke leaving a chimney: `n` shrinking, drifting puffs.
 *
 * `n` defaults to four, which is what every existing caller wants. The
 * Blacksmith asks for two, because its plume continues into the animated
 * overlay frames and a tall static curl underneath them would read as two
 * separate columns of smoke rather than one.
 */
function smokeCurl(g, x, y, n = 4) {
  for (let k = 0; k < n; k++) {
    const t = k / 3;
    const px = x + Math.sin(k * 1.4) * 5 + t * 7;
    const py = y - k * 8 - 3;
    g.fillStyle(0xe8e2d6, 0.34 - t * 0.16);
    g.fillEllipse(px, py, 13 - t * 3, 9 - t * 2);
    g.fillStyle(0xffffff, 0.2 - t * 0.1);
    g.fillEllipse(px + 1.5, py - 1.5, 7 - t * 2, 4.5 - t);
  }
}

// ---------------------------------------------------------------------------
// THE THREE MILITARY HALLS, AND WHY THEY ARE NOW THREE SHAPES
// ---------------------------------------------------------------------------
//
// The review was blunt and it was right: "The Archery Range and the Stable are
// the same building. Same footprint, same roof pitch, same cream wall, same
// fence run, same grey pad, same banner position. The difference is a ~20px
// target decal versus a ~20px shape in the doorway. These are the two buildings
// a player most needs to tell apart. Blacksmith is a third instance of the same
// shed."
//
// Every word of that was true, and the reason is structural rather than lazy:
// all three were a centred diamond of the same proportions under the same
// gableRoof, because a centred diamond was the only plan isoBox could make.
// They could differ in size and in what was glued to them, and that is exactly
// the class of difference that dies at 0.7 zoom behind a tree.
//
// So the three now occupy their 3x3 pad in three incompatible ways. This is the
// design, and it is deliberately statable in one word each:
//
//   ARCHERY RANGE   A BAR. One long narrow hall pushed hard against the far
//                   edge, two and a half tiles by less than one, with its whole
//                   front open. Two thirds of the pad is empty ground with a
//                   shooting line across it and a target butt at the end.
//                   Long, low, and mostly not there.
//   STABLE          AN L. Two low ranges meeting at the far corner, with two
//                   ridges running at right angles to each other — the only
//                   building in the game whose plan is not convex — wrapped
//                   round a railed paddock with a horse standing in it.
//   BLACKSMITH      A POINT. A small square block barely a fifth of the pad,
//                   with the tallest, thinnest chimney on the map over it and a
//                   charcoal lean-to beside it. Almost all of its silhouette is
//                   vertical, and none of it is roof.
//
// A bar, an L and a point. Those read as different buildings at thumbnail size,
// through fog, with half of each behind a tree — which is the test, and which
// no decal has ever passed.
//
// The identifying props all stay (the butt, the horse, the anvil and the forge
// glow) because they are what confirms the guess the silhouette already made.
// They are no longer being asked to make it.

/**
 * The Archery Range: a bar.
 *
 * The hall is a strip along the far edge with no front wall at all — a run of
 * posts over a band of pure shadow, with bows racked in it. What that buys is
 * not detail, it is a HOLE: the only other building on the map you can see
 * daylight through is the Lumber Camp, which is 2x2 and half this length. In
 * front of it the pad is deliberately, conspicuously empty except for the
 * shooting line and the butt, because emptiness is a silhouette too, and no
 * other 3x3 building leaves two thirds of its own paving bare.
 */
function drawArcheryRange(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, false);

  // The strip. 2.65 tiles along u, 0.85 across it — the most extreme aspect
  // ratio of any building in the game, and the whole point of the drawing.
  const u0 = -1.35;
  const u1 = 1.3;
  const v0 = -1.35;
  const v1 = -0.5;
  const wallH = 24;

  isoBlock(g, cx, cy, u0, v0, u1, v1, wallH, PLASTER, PLASTER_D, shade(PLASTER, 0.1));

  // The open front: the entire +v face replaced by shadow, with posts standing
  // in it. Drawn over the block's own wall rather than instead of it, so the
  // footing line and the outline stay exactly where isoBlock put them.
  const fW = gpt(cx, cy, u0, v1);
  const fS = gpt(cx, cy, u1, v1);
  const bay = [
    fW, fS, { x: fS.x, y: fS.y - wallH + 4 }, { x: fW.x, y: fW.y - wallH + 4 },
  ];
  g.fillStyle(0x241d13, 1);
  g.fillPoints(bay, true, true);
  g.lineStyle(2, OUT, 1);
  g.strokePoints(bay, true, true);
  for (let k = 0; k <= 5; k++) {
    const t = k / 5;
    const px = fW.x + (fS.x - fW.x) * t;
    const py = fW.y + (fS.y - fW.y) * t;
    g.fillStyle(WOOD_D, 1);
    g.fillRect(px - 2.4, py - wallH + 3, 4.8, wallH - 3);
    g.lineStyle(1.5, OUT, 1);
    g.strokeRect(px - 2.4, py - wallH + 3, 4.8, wallH - 3);
    rimLine(g, px + 2, py - wallH + 4, px + 2, py - 2, 1.2, 0.35);
  }
  // Bows on the rack, just legible in the shadow between the posts.
  g.lineStyle(2.2, WOOD, 0.9);
  for (let k = 0; k < 4; k++) {
    const t = 0.13 + k * 0.24;
    const px = fW.x + (fS.x - fW.x) * t;
    const py = fW.y + (fS.y - fW.y) * t;
    g.beginPath();
    g.arc(px + 5, py - wallH * 0.55, 7, -1.1, 1.1, false);
    g.strokePath();
  }

  // A long shallow ridge running the length of the strip. Shallow because a
  // steep roof on a 2.6-tile building is a barn, and this has to stay low
  // enough that the Blacksmith's chimney beside it is unmistakably taller.
  blockRoof(g, cx, cy - wallH, u0, v0, u1, v1, 16, col, colDark, 'u', 0.12);

  // The shooting line, straight across the empty ground.
  fenceRun(g, gpt(cx, cy, -1.25, 0.2), gpt(cx, cy, 0.95, 0.2), false);

  // The butt. Still the only circle at ground level in the game, still doing
  // the confirming — but no longer doing the identifying on its own.
  const bt = gpt(cx, cy, 0.75, 1.15);
  const tx = bt.x;
  const ty = bt.y;
  contactShadow(g, tx, ty + 2, 30, 12, 1);
  g.lineStyle(4.6, OUT, 1);
  g.beginPath();
  g.moveTo(tx - 8, ty);
  g.lineTo(tx - 2, ty - 20);
  g.moveTo(tx + 8, ty);
  g.lineTo(tx + 2, ty - 20);
  g.strokePath();
  g.lineStyle(2.4, WOOD_D, 1);
  g.beginPath();
  g.moveTo(tx - 8, ty);
  g.lineTo(tx - 2, ty - 20);
  g.moveTo(tx + 8, ty);
  g.lineTo(tx + 2, ty - 20);
  g.strokePath();
  const R = 18;
  g.fillStyle(OUT, 1);
  g.fillEllipse(tx, ty - 29, R * 2 + 5, R * 2 + 5);
  g.fillStyle(0xcaa960, 1);
  g.fillEllipse(tx, ty - 29, R * 2, R * 2);
  g.fillStyle(lit(0xcaa960), 1);
  g.fillEllipse(tx - 1.5, ty - 31, R * 1.6, R * 1.6);
  g.fillStyle(0xf2ece0, 1);
  g.fillCircle(tx, ty - 29, R * 0.68);
  g.fillStyle(0xc03a34, 1);
  g.fillCircle(tx, ty - 29, R * 0.44);
  g.fillStyle(0xf2ece0, 1);
  g.fillCircle(tx, ty - 29, R * 0.2);
  g.lineStyle(2, OUT, 1);
  g.strokeCircle(tx, ty - 29, R);
  g.lineStyle(1.2, OUT, 0.55);
  g.strokeCircle(tx, ty - 29, R * 0.68);
  g.strokeCircle(tx, ty - 29, R * 0.44);
  for (const [ox, oy] of [[-7, -3], [4, -8], [1, 4]]) {
    stick(g, tx + ox, ty - 29 + oy, tx + ox - 11, ty - 29 + oy - 4, 1.7, 0xd8b070);
    g.fillStyle(0xf2f2f2, 1);
    g.fillTriangle(
      tx + ox - 11, ty - 29 + oy - 7,
      tx + ox - 16, ty - 29 + oy - 3,
      tx + ox - 10, ty - 29 + oy - 1,
    );
  }
  // A barrel of spare shafts on the shooting line. A loose fan of sticks was
  // tried first and read as a broom leaning on nothing — anything standing on
  // open paving needs a base the eye can put on the ground.
  const bl = gpt(cx, cy, -0.55, 0.45);
  contactShadow(g, bl.x, bl.y + 1, 18, 8, 0.9);
  for (let k = -2; k <= 2; k++) {
    stick(g, bl.x + k * 2, bl.y - 12, bl.x + k * 3.4, bl.y - 30, 1.6, 0xc9a86a);
    g.fillStyle(0xf2f2f2, 0.9);
    g.fillTriangle(
      bl.x + k * 3.4 - 2.5, bl.y - 30,
      bl.x + k * 3.4 + 2.5, bl.y - 30,
      bl.x + k * 3.4, bl.y - 35,
    );
  }
  g.fillStyle(OUT, 1);
  g.fillRect(bl.x - 9, bl.y - 15, 18, 15);
  g.fillStyle(0x6d4c29, 1);
  g.fillRect(bl.x - 8, bl.y - 14, 16, 14);
  g.fillStyle(0x8a6337, 1);
  g.fillRect(bl.x - 8, bl.y - 14, 6, 14);
  g.lineStyle(1.6, shade(STEEL_D, -0.2), 0.9);
  g.beginPath();
  g.moveTo(bl.x - 8, bl.y - 10);
  g.lineTo(bl.x + 8, bl.y - 10);
  g.moveTo(bl.x - 8, bl.y - 4);
  g.lineTo(bl.x + 8, bl.y - 4);
  g.strokePath();

  banner(g, cx - hw * 0.8, cy + hh * 0.12, col, colDark, 26);
}

/**
 * The Stable: an L round a paddock.
 *
 * Two low ranges meeting at the north corner, so there are two ridges on this
 * building and they run at RIGHT ANGLES to each other. That is a thing no other
 * roof in the game does, it survives to any size, and it is visible from every
 * direction — unlike a horse's head in a doorway, which is visible from one and
 * disappears the moment a unit walks in front of the door.
 *
 * The rest of the pad is a railed paddock with a horse standing loose in it.
 * A horse OUTSIDE the building rather than framed in a hole in it is worth far
 * more: it is on open paving with grass behind it, it is the full animal rather
 * than a head, and nothing occludes it.
 */
function drawStable(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  const HIDE = 0x7c5233;
  const BOARD = 0xb08c5c; // board-and-batten: a stable is a wooden building
  platform(g, cx, cy, hw, hh, false);

  const wallH = 25;
  // Range A, along the far edge; range B comes forward down the shaded side.
  // Drawn in that order because depth in this projection is u + v and B's
  // centre is nearer the camera — the same rule every overlapping pair in this
  // file obeys.
  const A = { u0: -1.35, v0: -1.35, u1: 0.15, v1: -0.45 };
  const B = { u0: -1.35, v0: -0.45, u1: -0.45, v1: 1.2 };

  const battens = (r) => {
    g.lineStyle(1.2, 0x7a5a33, 0.7);
    for (let k = 1; k <= 7; k++) {
      const t = k / 8;
      const p = gpt(cx, cy, r.u0 + (r.u1 - r.u0) * t, r.v1);
      const q = gpt(cx, cy, r.u1, r.v0 + (r.v1 - r.v0) * t);
      for (const z of [p, q]) {
        g.beginPath();
        g.moveTo(z.x, z.y);
        g.lineTo(z.x, z.y - wallH);
        g.strokePath();
      }
    }
  };

  isoBlock(g, cx, cy, A.u0, A.v0, A.u1, A.v1, wallH, BOARD, shade(BOARD, 0.08),
    shade(BOARD, 0.16));
  battens(A);
  // Stall doors along range A's open front: two dark mouths with half-doors.
  for (const t of [0.24, 0.62]) {
    const p = gpt(cx, cy, A.u0 + (A.u1 - A.u0) * t, A.v1);
    g.fillStyle(0x1a140c, 1);
    g.fillRect(p.x - 9, p.y - wallH + 3, 18, wallH - 3);
    g.lineStyle(2, OUT, 1);
    g.strokeRect(p.x - 9, p.y - wallH + 3, 18, wallH - 3);
    g.fillStyle(WOOD_D, 1);
    g.fillRect(p.x - 9, p.y - 10, 18, 10);
    g.lineStyle(1.6, OUT, 1);
    g.strokeRect(p.x - 9, p.y - 10, 18, 10);
    rimLine(g, p.x + 8, p.y - 10, p.x + 8, p.y - 1, 1.2, 0.3);
  }
  blockRoof(g, cx, cy - wallH, A.u0, A.v0, A.u1, A.v1, 15, col, colDark, 'u', 0.12);

  isoBlock(g, cx, cy, B.u0, B.v0, B.u1, B.v1, wallH, BOARD, shade(BOARD, 0.08),
    shade(BOARD, 0.16));
  battens(B);
  // The tack room door on the wing, facing down-right.
  const bd = gpt(cx, cy, B.u1, B.v0 + (B.v1 - B.v0) * 0.55);
  g.fillStyle(0x1a140c, 1);
  g.fillRect(bd.x - 7, bd.y - wallH + 4, 14, wallH - 4);
  g.lineStyle(1.8, OUT, 1);
  g.strokeRect(bd.x - 7, bd.y - wallH + 4, 14, wallH - 4);
  blockRoof(g, cx, cy - wallH, B.u0, B.v0, B.u1, B.v1, 15, col, colDark, 'v', 0.12);

  // The paddock: rails along the two pad edges that face the camera.
  fenceRun(g, gpt(cx, cy, 1.32, -0.4), gpt(cx, cy, 1.32, 1.32), false);
  fenceRun(g, gpt(cx, cy, 1.32, 1.32), gpt(cx, cy, -0.35, 1.32), false);

  // The horse. Side-on, standing, about thirty pixels nose to tail — big enough
  // that the animal itself is the read at play zoom, which the old head in a
  // doorway never was.
  const h = gpt(cx, cy, 0.75, 0.35);
  const hx = h.x;
  const hy = h.y;
  contactShadow(g, hx, hy, 34, 12, 1);
  // Legs first, behind the body. Four of them, paired near and far, with the
  // far pair a shade darker so the animal has depth rather than four sticks in
  // a row.
  const legs = [[-9.5, 0], [-6, 1], [6.5, 0], [10, 1]];
  g.lineStyle(4.6, OUT, 1);
  g.beginPath();
  for (const [dx] of legs) {
    g.moveTo(hx + dx, hy - 17);
    g.lineTo(hx + dx * 1.1, hy);
  }
  g.strokePath();
  for (const [dx, far] of legs) {
    g.lineStyle(2.8, far ? shade(HIDE, -0.32) : shade(HIDE, -0.12), 1);
    g.beginPath();
    g.moveTo(hx + dx, hy - 17);
    g.lineTo(hx + dx * 1.1, hy);
    g.strokePath();
  }
  // Barrel, haunch and shoulder as one silhouette. Three overlapping masses
  // rather than one capsule: a horse drawn as a rounded rectangle on four
  // sticks is a llama, which is what the first attempt at this looked like, and
  // the difference is entirely in the round haunch at the back and the
  // shoulder mass under a neck that comes forward rather than straight up.
  const body = () => {
    g.fillRoundedRect(hx - 13, hy - 25, 26, 12, 5);
    g.fillCircle(hx - 10, hy - 20, 7.5);
    g.fillCircle(hx + 9, hy - 20.5, 6.8);
  };
  g.fillStyle(OUT, 1);
  g.lineStyle(3.6, OUT, 1);
  body();
  g.fillStyle(HIDE, 1);
  g.fillRoundedRect(hx - 12.4, hy - 24.4, 24.8, 10.8, 4.4);
  g.fillCircle(hx - 10, hy - 20, 6.9);
  g.fillCircle(hx + 9, hy - 20.5, 6.2);
  g.fillStyle(shade(HIDE, 0.16), 1);
  g.fillRoundedRect(hx - 10, hy - 24, 20, 4.5, 2.4);

  // Neck forward and up at about forty degrees, and a long head on the end of
  // it. The angle is the whole animal: vertical reads as a camelid, horizontal
  // reads as grazing, and forty degrees reads as a horse standing at ease.
  stick(g, hx + 8, hy - 23, hx + 19, hy - 33, 9, HIDE);
  g.fillStyle(OUT, 1);
  g.fillRoundedRect(hx + 16, hy - 39, 17, 9, 4);
  g.fillStyle(HIDE, 1);
  g.fillRoundedRect(hx + 17, hy - 38, 15.4, 7.2, 3.2);
  g.fillStyle(shade(HIDE, -0.25), 1);
  g.fillRoundedRect(hx + 27, hy - 36.5, 6, 5, 2.4);
  g.fillStyle(OUT, 1);
  g.fillTriangle(hx + 17, hy - 38, hx + 18.5, hy - 44, hx + 21.5, hy - 38);
  // Mane, along the crest of the neck.
  g.lineStyle(3.4, 0x35251a, 1);
  g.beginPath();
  g.moveTo(hx + 8, hy - 26);
  g.lineTo(hx + 18, hy - 37);
  g.strokePath();
  g.fillStyle(OUT, 1);
  g.fillCircle(hx + 23, hy - 35.5, 1.5);
  rimLine(g, hx + 19, hy - 38, hx + 31, hy - 35, 1.4, 0.4);
  // Tail, falling off the haunch.
  g.lineStyle(5, OUT, 1);
  g.beginPath();
  g.moveTo(hx - 14, hy - 24);
  g.lineTo(hx - 19, hy - 10);
  g.strokePath();
  g.lineStyle(3.2, 0x35251a, 1);
  g.beginPath();
  g.moveTo(hx - 14, hy - 24);
  g.lineTo(hx - 19, hy - 10);
  g.strokePath();

  // Hay and a trough against the wing.
  const hax = cx - hw * 0.3;
  const hay = cy + hh * 0.72;
  contactShadow(g, hax, hay + 2, 22, 9, 1);
  g.fillStyle(OUT, 1);
  g.fillRoundedRect(hax - 13, hay - 15, 26, 16, 3);
  g.fillStyle(0xd6b464, 1);
  g.fillRoundedRect(hax - 11.5, hay - 13.5, 23, 13, 2.5);
  g.fillStyle(lit(0xd6b464), 1);
  g.fillRect(hax - 10, hay - 12.5, 20, 4);
  g.lineStyle(1.1, 0x9d803f, 0.8);
  for (const t of [0.32, 0.68]) {
    g.beginPath();
    g.moveTo(hax - 11.5 + 23 * t, hay - 13.5);
    g.lineTo(hax - 11.5 + 23 * t, hay - 0.5);
    g.strokePath();
  }

  banner(g, cx + hw * 0.2, cy - hh * 0.62, col, colDark, 24);
}

/**
 * The Blacksmith: a point.
 *
 * A small square block — barely a fifth of the paving it stands on — carrying
 * the tallest, thinnest chimney in the game, with a charcoal lean-to against
 * its sunward side. Where the Range is horizontal and the Stable is bent, this
 * is a spike: nearly all of what the eye gets is a vertical line with smoke
 * coming off it, and there is more empty pad around it than there is building.
 *
 * The forge mouth still glows and still throws warm light onto the paving,
 * which makes this the only building on the map that emits light, and the anvil
 * on its stump still says what the glow is for.
 */
function drawBlacksmith(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  const BRICK = 0x8d5a44;
  platform(g, cx, cy, hw, hh, false);

  // The charcoal store, first because it stands further from the camera than
  // the forge block. Four posts and a timber lean-to with a heap of charcoal
  // under it — open-sided, so it is a dark hole rather than a second mass, and
  // small enough that it never competes with the chimney. The first version of
  // this was a stone-roofed shed the size of the forge itself and it read as a
  // sheet of paper leaning against the building.
  const cu0 = 0.5;
  const cu1 = 1.2;
  const cv0 = -1.15;
  const cv1 = -0.45;
  const heap = gpt(cx, cy, (cu0 + cu1) / 2, (cv0 + cv1) / 2 + 0.15);
  g.fillStyle(0x1c1a19, 1);
  g.fillEllipse(heap.x, heap.y - 4, 30, 12);
  g.fillStyle(0x33302d, 1);
  g.fillEllipse(heap.x + 2, heap.y - 8, 22, 9);
  g.fillStyle(0x46413a, 0.85);
  g.fillEllipse(heap.x + 4, heap.y - 11, 10, 4);
  for (const [pu, pv] of [[cu0, cv0], [cu1, cv0], [cu0, cv1], [cu1, cv1]]) {
    const p = gpt(cx, cy, pu, pv);
    g.fillStyle(OUT, 1);
    g.fillRect(p.x - 3, p.y - 24, 6, 24);
    g.fillStyle(WOOD_D, 1);
    g.fillRect(p.x - 2, p.y - 23, 4, 23);
  }
  shedRoof(g, cx, cy, cu0, cv0, cu1, cv1, 30, 22, WOOD, WOOD_D, 0.16);

  // The forge block. 1.3 tiles square on a 3-tile pad: the smallest body of any
  // 3x3 building in the game, and that is the measurement doing the work.
  const u0 = -0.9;
  const u1 = 0.4;
  const v0 = -0.9;
  const v1 = 0.4;
  const wallH = 32;
  isoBlock(g, cx, cy, u0, v0, u1, v1, wallH, STONE, shade(STONE, 0.08),
    shade(STONE, 0.18));
  // Rubble coursing, not timber framing: the smithy is the one workshop that
  // has to be fireproof, and stone says so without a caption.
  const cW = gpt(cx, cy, u0, v1);
  const cS = gpt(cx, cy, u1, v1);
  const cE = gpt(cx, cy, u1, v0);
  g.lineStyle(1.1, STONE_D, 0.6);
  for (let k = 1; k <= 4; k++) {
    const y = (wallH * k) / 5;
    g.beginPath();
    g.moveTo(cW.x, cW.y - y);
    g.lineTo(cS.x, cS.y - y);
    g.lineTo(cE.x, cE.y - y);
    g.strokePath();
  }
  blockRoof(g, cx, cy - wallH, u0, v0, u1, v1, 13, col, colDark, 'v', 0.1);

  // The forge mouth, low in the shaded wall, with its light on the paving.
  const fp = gpt(cx, cy, u0 + (u1 - u0) * 0.62, v1);
  const fx = fp.x;
  const fy = fp.y;
  g.fillStyle(0xff9a2e, 0.16);
  g.fillEllipse(fx + 4, fy + 12, 54, 24);
  g.fillStyle(0xffc054, 0.13);
  g.fillEllipse(fx + 3, fy + 9, 36, 16);
  g.fillStyle(OUT, 1);
  g.fillRoundedRect(fx - 10, fy - 23, 21, 22, 4);
  g.fillStyle(0x5c1c0e, 1);
  g.fillRoundedRect(fx - 8.5, fy - 21.5, 18, 19, 3);
  g.fillStyle(0xd2431a, 1);
  g.fillRoundedRect(fx - 6.5, fy - 17, 14, 13, 3);
  g.fillStyle(0xff9a2e, 1);
  g.fillEllipse(fx + 0.5, fy - 10, 11, 8);
  g.fillStyle(0xffe6a0, 1);
  g.fillEllipse(fx + 0.5, fy - 10, 6, 4.4);

  // THE CHIMNEY. Set at the shaded corner where nothing overlaps it, and drawn
  // deliberately narrow: at play zoom this is roughly four pixels wide and
  // seventy tall, and a four-pixel vertical that clears every roof around it is
  // findable across a whole base in a way that no wide mass ever is.
  const cn = gpt(cx, cy, u0 + 0.12, v0 + 0.12);
  const chx = cn.x;
  const chBase = cn.y - wallH + 6;
  const chTop = chBase - 62;
  g.fillStyle(dim(BRICK), 1);
  g.fillRect(chx - 10, chTop, 20, chBase - chTop);
  g.fillStyle(BRICK, 1);
  g.fillRect(chx - 2, chTop, 12, chBase - chTop);
  g.fillStyle(lit(BRICK), 1);
  g.fillRect(chx + 4, chTop, 5, chBase - chTop);
  g.lineStyle(2.2, OUT, 1);
  g.strokeRect(chx - 10, chTop, 20, chBase - chTop);
  g.lineStyle(1, shade(BRICK, -0.3), 0.55);
  for (let k = 1; k * 7 < chBase - chTop; k++) {
    g.beginPath();
    g.moveTo(chx - 10, chTop + k * 7);
    g.lineTo(chx + 10, chTop + k * 7);
    g.strokePath();
  }
  g.fillStyle(shade(BRICK, -0.1), 1);
  g.fillRect(chx - 13, chTop - 7, 26, 8);
  g.lineStyle(2, OUT, 1);
  g.strokeRect(chx - 13, chTop - 7, 26, 8);
  g.fillStyle(0x120d08, 1);
  g.fillRect(chx - 8, chTop - 6, 16, 3);
  rimLine(g, chx + 9, chTop - 5, chx + 9, chBase - 2, 1.6, 0.4);
  // The first few feet of smoke are baked in, so the building is never a
  // chimney with nothing coming out of it. Everything above this is the
  // animated plume — see FX_SMOKE_FRAMES.
  smokeCurl(g, chx + 2, chTop - 8, 2);

  // Anvil on a stump, out on the paving where it cannot be missed.
  const av = gpt(cx, cy, 1.3, 0.4);
  const ax = av.x;
  const ay = av.y;
  contactShadow(g, ax, ay + 1, 22, 9, 1);
  g.fillStyle(0x6b4a28, 1);
  g.fillRect(ax - 8, ay - 12, 16, 12);
  g.fillStyle(0x8a663c, 1);
  g.fillEllipse(ax, ay - 12, 16, 6);
  g.lineStyle(1.8, OUT, 1);
  g.strokeRect(ax - 8, ay - 12, 16, 12);
  g.strokeEllipse(ax, ay - 12, 16, 6);
  const anv = [
    { x: ax - 13, y: ay - 20 }, { x: ax + 9, y: ay - 20 },
    { x: ax + 14, y: ay - 17.5 }, { x: ax + 8, y: ay - 16 },
    { x: ax + 5, y: ay - 13 }, { x: ax + 7, y: ay - 11 },
    { x: ax - 8, y: ay - 11 }, { x: ax - 6, y: ay - 13 },
    { x: ax - 9, y: ay - 16 }, { x: ax - 13, y: ay - 17.5 },
  ];
  g.fillStyle(STEEL_D, 1);
  g.fillPoints(anv, true, true);
  g.lineStyle(2, OUT, 1);
  g.strokePoints(anv, true, true);
  g.fillStyle(STEEL, 1);
  g.fillRect(ax - 12, ay - 19.5, 20, 2.4);
  stick(g, ax - 16, ay - 1, ax - 9, ay - 18, 2.2, WOOD);
  g.fillStyle(STEEL_D, 1);
  g.fillRoundedRect(ax - 13, ay - 24, 10, 5, 1.6);
  g.lineStyle(1.4, OUT, 1);
  g.strokeRoundedRect(ax - 13, ay - 24, 10, 5, 1.6);

  // The slack tub, standing well clear of the anvil.
  const st = gpt(cx, cy, -0.5, 1.2);
  contactShadow(g, st.x, st.y + 1, 16, 7, 0.9);
  g.fillStyle(OUT, 1);
  g.fillRect(st.x - 8, st.y - 13, 16, 13);
  g.fillStyle(0x5f4426, 1);
  g.fillRect(st.x - 7, st.y - 12, 14, 12);
  g.fillStyle(0x7c5a30, 1);
  g.fillRect(st.x - 7, st.y - 12, 5, 12);
  g.fillStyle(0x3f5a63, 1);
  g.fillEllipse(st.x, st.y - 12.5, 14, 5.5);
  g.lineStyle(1.5, OUT, 1);
  g.strokeEllipse(st.x, st.y - 12.5, 14, 5.5);

  banner(g, cx - hw * 0.78, cy + hh * 0.1, col, colDark, 26);
}

/**
 * The Siege Workshop.
 *
 * An open timber gantry — two raking A-frames carrying a ridge beam, with a
 * block and tackle swinging in the gap — straddling a half-built engine. No
 * walls at all, like the Lumber Camp, but where that is a low flat slab this is
 * a tall triangle with a rope hanging in it, and the finished half of the
 * engine underneath is a wheel taller than a man.
 */
function drawSiegeWorkshop(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  const BEAM = 0x8a6134;
  const BEAM_D = 0x5d3f1e;
  platform(g, cx, cy, hw, hh, false);

  // Two A-frames, one behind the engine and one in front of it, so the machine
  // sits *inside* the gantry rather than beside it.
  //
  // Both feet of a frame stand at the same screen height, which is not what an
  // isometric grid line does and is deliberate. Rake them along a grid axis and
  // the two legs get different lengths and different angles; two of those, plus
  // a ridge beam, plus a hanging tackle, and the result is a heap of sticks with
  // no shape in it — which is exactly what the first attempt looked like. A
  // symmetric A is a letter the eye already knows, it survives being twenty
  // pixels tall, and nothing else on this map makes one.
  const H = 76;
  const frame = (fx, fy, spread, near) => {
    const apex = { x: fx, y: fy - H };
    const woodC = near ? BEAM : BEAM_D;
    for (const sgn of [-1, 1]) {
      const foot = { x: fx + sgn * spread, y: fy };
      g.lineStyle(9.5, OUT, 1);
      g.beginPath();
      g.moveTo(foot.x, foot.y);
      g.lineTo(apex.x, apex.y);
      g.strokePath();
      g.lineStyle(6, woodC, 1);
      g.beginPath();
      g.moveTo(foot.x, foot.y);
      g.lineTo(apex.x, apex.y);
      g.strokePath();
      // A foot block, so the leg stands on something instead of ending in air.
      g.fillStyle(OUT, 1);
      g.fillEllipse(foot.x, foot.y, 15, 7);
      g.fillStyle(shade(woodC, -0.2), 1);
      g.fillEllipse(foot.x, foot.y - 1, 12, 5);
      if (sgn > 0) rimLine(g, foot.x + 2, foot.y - 3, apex.x + 2, apex.y + 4, 1.8, 0.42);
    }
    // Collar tie, level, a third of the way down: the crossbar of the A.
    const tieY = fy - H * 0.46;
    const tieX = spread * 0.46;
    g.lineStyle(7.5, OUT, 1);
    g.beginPath();
    g.moveTo(fx - tieX, tieY);
    g.lineTo(fx + tieX, tieY);
    g.strokePath();
    g.lineStyle(4.4, woodC, 1);
    g.beginPath();
    g.moveTo(fx - tieX, tieY);
    g.lineTo(fx + tieX, tieY);
    g.strokePath();
    return apex;
  };

  const backApex = frame(cx - hw * 0.26, cy - hh * 0.5, hw * 0.5, false);

  // The ridge beam between the two apexes, and the tackle hanging off it.
  const frontApexX = cx + hw * 0.26;
  const frontApexY = cy + hh * 0.5 - H;
  g.lineStyle(9, OUT, 1);
  g.beginPath();
  g.moveTo(backApex.x, backApex.y);
  g.lineTo(frontApexX, frontApexY);
  g.strokePath();
  g.lineStyle(5.5, BEAM, 1);
  g.beginPath();
  g.moveTo(backApex.x, backApex.y);
  g.lineTo(frontApexX, frontApexY);
  g.strokePath();

  // Block and tackle: a pulley on the beam, two falls of rope, a hook.
  const px = (backApex.x + frontApexX) / 2;
  const py = (backApex.y + frontApexY) / 2 + 3;
  g.fillStyle(OUT, 1);
  g.fillCircle(px, py, 6);
  g.fillStyle(WOOD, 1);
  g.fillCircle(px, py, 4.4);
  g.fillStyle(STEEL_D, 1);
  g.fillCircle(px, py, 1.6);
  g.lineStyle(2.4, OUT, 0.85);
  g.beginPath();
  g.moveTo(px - 3, py + 4);
  g.lineTo(px - 3, py + 30);
  g.moveTo(px + 3, py + 4);
  g.lineTo(px + 3, py + 30);
  g.strokePath();
  g.lineStyle(1.2, 0xcbb98c, 1);
  g.beginPath();
  g.moveTo(px - 3, py + 4);
  g.lineTo(px - 3, py + 30);
  g.moveTo(px + 3, py + 4);
  g.lineTo(px + 3, py + 30);
  g.strokePath();
  g.lineStyle(2.6, STEEL_D, 1);
  g.beginPath();
  g.arc(px, py + 34, 5, -0.4, 3.4, false);
  g.strokePath();

  // The engine under construction: one big spoked wheel, a throwing arm half
  // pinned, and a stack of squared timber waiting to become the other half.
  const wx = cx + hw * 0.2;
  const wy = cy + hh * 0.42;
  const R = 20;
  contactShadow(g, wx, wy + 2, 46, 18, 1);
  g.fillStyle(OUT, 1);
  g.fillCircle(wx, wy - R * 0.55, R + 2.4);
  g.fillStyle(0x5d3f1e, 1);
  g.fillCircle(wx, wy - R * 0.55, R);
  g.fillStyle(shade(0x8a6134, 0.06), 1);
  g.fillCircle(wx, wy - R * 0.55, R - 5);
  g.fillStyle(0x3d2a13, 1);
  g.fillCircle(wx, wy - R * 0.55, R - 8.5);
  g.lineStyle(3, 0x5d3f1e, 1);
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 6) * k + 0.3;
    g.beginPath();
    g.moveTo(wx - Math.cos(a) * (R - 2), wy - R * 0.55 - Math.sin(a) * (R - 2));
    g.lineTo(wx + Math.cos(a) * (R - 2), wy - R * 0.55 + Math.sin(a) * (R - 2));
    g.strokePath();
  }
  g.fillStyle(STEEL_D, 1);
  g.fillCircle(wx, wy - R * 0.55, 4);
  g.lineStyle(1.6, OUT, 1);
  g.strokeCircle(wx, wy - R * 0.55, 4);
  g.lineStyle(2, RIM, 0.32);
  g.beginPath();
  g.arc(wx, wy - R * 0.55, R - 1.5, -1.9, -0.3, false);
  g.strokePath();

  // The chassis the wheel is pinned to: a short squared beam with the axle
  // through it and a second wheel started on the far side. Kept low and short
  // on purpose — an earlier version had a full throwing arm raking right across
  // the gantry, and one more long diagonal in a picture already made of long
  // diagonals is what turned this building into a woodpile.
  g.fillStyle(OUT, 1);
  g.fillRoundedRect(wx - 30, wy - R * 0.55 - 6, 46, 13, 4);
  g.fillStyle(BEAM_D, 1);
  g.fillRoundedRect(wx - 28.5, wy - R * 0.55 - 4.5, 43, 10, 3);
  g.fillStyle(BEAM, 1);
  g.fillRect(wx - 27, wy - R * 0.55 - 3.5, 40, 3.4);

  // Timber stack and a stone shot, so the yard reads as a place work happens.
  const sx = cx - hw * 0.6;
  const sy = cy + hh * 0.5;
  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < 3 - r; k++) {
      const lx = sx + k * 11 + r * 5.5;
      const ly = sy - r * 9;
      g.fillStyle(OUT, 1);
      g.fillCircle(lx, ly, 6.2);
      g.fillStyle(WOOD_D, 1);
      g.fillCircle(lx, ly, 5);
      g.fillStyle(0xc59a5f, 1);
      g.fillCircle(lx + 1, ly - 1, 3);
    }
  }
  const bx = cx + hw * 0.62;
  const by = cy + hh * 0.5;
  contactShadow(g, bx, by + 1, 20, 8, 1);
  g.fillStyle(OUT, 1);
  g.fillCircle(bx, by - 8, 10);
  g.fillStyle(0x7b8490, 1);
  g.fillCircle(bx, by - 8, 8.6);
  g.fillStyle(0x9ca6b3, 1);
  g.fillCircle(bx + 1.6, by - 10, 5);

  frame(frontApexX, cy + hh * 0.5, hw * 0.5, true);

  banner(g, cx - hw * 0.5, cy + hh * 0.62, col, colDark, 28);
}

/**
 * The University.
 *
 * A dome, and there is no other dome in the game — the Mill's cap is a cone,
 * which stays a different shape however small it gets. Under it a drum on an
 * arcaded base, with a lantern and a weathervane on top so the profile is
 * dome-plus-pinnacle rather than dome-alone, and a shelf of books and an
 * armillary sphere on the paving to say what goes on inside.
 */
function drawUniversity(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  const ASHLAR = 0xd8d0bd;
  platform(g, cx, cy, hw, hh, true);

  // The arcaded base: a low block with a run of round-headed arches on the two
  // faces the camera can see. Arches are the second cue — nothing else in the
  // game has a repeated curve at wall height.
  const iw = hw * 0.74;
  const ih = hh * 0.74;
  const wallH = 34;
  isoBox(g, cx, cy, iw, ih, wallH, ASHLAR, shade(ASHLAR, 0.06), shade(ASHLAR, 0.16));
  const arches = (from, to, n, shadow) => {
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const px = from.x + (to.x - from.x) * t;
      const py = from.y + (to.y - from.y) * t;
      g.fillStyle(shadow, 1);
      g.fillRoundedRect(px - 5, py - wallH + 7, 10, wallH - 9, 5);
      g.lineStyle(1.5, OUT, 0.9);
      g.strokeRoundedRect(px - 5, py - wallH + 7, 10, wallH - 9, 5);
    }
  };
  arches({ x: cx - iw, y: cy }, { x: cx, y: cy + ih }, 3, 0x352f24);
  arches({ x: cx, y: cy + ih }, { x: cx + iw, y: cy }, 3, 0x433c2e);

  // A cornice, then the drum.
  const topY = cy - wallH;
  g.fillStyle(shade(ASHLAR, 0.2), 1);
  g.fillPoints([
    { x: cx, y: topY - ih * 1.05 }, { x: cx + iw * 1.05, y: topY },
    { x: cx, y: topY + ih * 1.05 }, { x: cx - iw * 1.05, y: topY },
  ], true, true);
  g.lineStyle(2.2, OUT, 1);
  g.strokePoints([
    { x: cx, y: topY - ih * 1.05 }, { x: cx + iw * 1.05, y: topY },
    { x: cx, y: topY + ih * 1.05 }, { x: cx - iw * 1.05, y: topY },
  ], true, true);

  const drumR = iw * 0.6;
  const { yT } = isoCylinder(g, cx, topY + 4, drumR, drumR * 0.96, 26,
    ASHLAR, shade(ASHLAR, 0.14));
  // Round-headed windows round the drum.
  for (let k = -1; k <= 1; k++) {
    const wxp = cx + k * drumR * 0.52;
    g.fillStyle(0x2e3a4a, 1);
    g.fillRoundedRect(wxp - 3.6, yT + 5, 7.2, 14, 3.6);
    g.lineStyle(1.4, OUT, 1);
    g.strokeRoundedRect(wxp - 3.6, yT + 5, 7.2, 14, 3.6);
  }
  // A band of team colour where the drum meets the dome — the University's roof
  // is stone and stays stone, so ownership lives on a painted string course.
  g.fillStyle(colDark, 1);
  g.fillRect(cx - drumR * 0.98, yT - 4, drumR * 1.96, 6);
  g.fillStyle(col, 1);
  g.fillRect(cx - drumR * 0.98, yT - 4, drumR * 1.96, 3);
  g.lineStyle(1.6, OUT, 1);
  g.strokeRect(cx - drumR * 0.98, yT - 4, drumR * 1.96, 6);

  isoDome(g, cx, yT - 3, drumR * 0.99, 40, 0xbfc7cf);

  // Lantern and finial on the crown.
  const lanY = yT - 43;
  g.fillStyle(shade(ASHLAR, 0.1), 1);
  g.fillRect(cx - 7, lanY - 13, 14, 14);
  g.lineStyle(1.8, OUT, 1);
  g.strokeRect(cx - 7, lanY - 13, 14, 14);
  g.fillStyle(0x2e3a4a, 1);
  g.fillRect(cx - 4, lanY - 10, 8, 9);
  g.fillStyle(shade(ASHLAR, 0.24), 1);
  g.fillPoints([
    { x: cx - 9, y: lanY - 13 }, { x: cx, y: lanY - 22 }, { x: cx + 9, y: lanY - 13 },
  ], true, true);
  g.lineStyle(1.8, OUT, 1);
  g.strokePoints([
    { x: cx - 9, y: lanY - 13 }, { x: cx, y: lanY - 22 }, { x: cx + 9, y: lanY - 13 },
  ], true, true);
  stick(g, cx, lanY - 21, cx, lanY - 31, 1.8, 0xd8b23c);
  g.fillStyle(0xf0c94a, 1);
  g.fillCircle(cx, lanY - 33, 3.4);
  g.lineStyle(1.3, OUT, 1);
  g.strokeCircle(cx, lanY - 33, 3.4);

  // An armillary sphere on a stand out on the paving: three rings and an axis,
  // which is a shape nothing else in the game makes and reads even tiny.
  const ax = cx + hw * 0.56;
  const ay = cy + hh * 0.44;
  contactShadow(g, ax, ay + 1, 20, 8, 1);
  stick(g, ax, ay, ax, ay - 14, 3, WOOD_D);
  g.lineStyle(3.2, OUT, 1);
  g.strokeCircle(ax, ay - 24, 10);
  g.lineStyle(1.7, 0xd8b23c, 1);
  g.strokeCircle(ax, ay - 24, 10);
  g.lineStyle(2.6, OUT, 1);
  g.strokeEllipse(ax, ay - 24, 20, 8);
  g.strokeEllipse(ax, ay - 24, 8, 20);
  g.lineStyle(1.4, 0xd8b23c, 1);
  g.strokeEllipse(ax, ay - 24, 20, 8);
  g.strokeEllipse(ax, ay - 24, 8, 20);

  // A lectern with an open book, at the foot of the steps.
  const bx = cx - hw * 0.56;
  const by = cy + hh * 0.4;
  contactShadow(g, bx, by + 1, 20, 8, 1);
  stick(g, bx, by, bx, by - 12, 3.4, WOOD_D);
  g.fillStyle(OUT, 1);
  g.fillPoints([
    { x: bx - 13, y: by - 14 }, { x: bx, y: by - 19 },
    { x: bx + 13, y: by - 14 }, { x: bx, y: by - 10 },
  ], true, true);
  g.fillStyle(0xf2ecd8, 1);
  g.fillPoints([
    { x: bx - 11, y: by - 14.4 }, { x: bx - 0.8, y: by - 18 },
    { x: bx - 0.8, y: by - 11.6 },
  ], true, true);
  g.fillStyle(0xe2dbc4, 1);
  g.fillPoints([
    { x: bx + 11, y: by - 14.4 }, { x: bx + 0.8, y: by - 18 },
    { x: bx + 0.8, y: by - 11.6 },
  ], true, true);

  banner(g, cx - hw * 0.82, cy + hh * 0.06, col, colDark, 26);
}

/**
 * The Monastery.
 *
 * A bell tower — a tall square shaft with an open belfry, a pyramid cap and a
 * cross — standing beside a low chapel. It is the tallest thing in a base after
 * the Town Center and the only building with a cross on it, and the belfry
 * opening is a hole in the silhouette near the top, which nothing else has.
 */
function drawMonastery(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  const LIME = 0xeae0cc;
  const SLATE = 0x5a6472;
  platform(g, cx, cy, hw, hh, false);

  // The chapel: a low limewashed nave, pushed to the south-east so the tower
  // has clear sky above it.
  const nx = cx + hw * 0.22;
  const ny = cy + hh * 0.16;
  const iw = hw * 0.52;
  const ih = hh * 0.52;
  const wallH = 26;
  isoBox(g, nx, ny, iw, ih, wallH, LIME, shade(LIME, 0.05), shade(LIME, 0.14));
  // Round-headed windows down the nave wall.
  for (let k = 0; k < 3; k++) {
    const t = (k + 0.5) / 3;
    const px = nx + iw * t;
    const py = ny + ih - ih * t;
    g.fillStyle(0x2b3547, 1);
    g.fillRoundedRect(px - 3, py - wallH + 6, 6, 13, 3);
    g.lineStyle(1.3, OUT, 0.9);
    g.strokeRoundedRect(px - 3, py - wallH + 6, 6, 13, 3);
  }
  gableRoof(g, nx, ny - wallH, iw * 1.18, ih * 1.18, 18, col, colDark);

  // The tower. Four courses of ashlar, then the belfry, then the cap.
  const tx = cx - hw * 0.42;
  const ty = cy + hh * 0.06;
  const tw = 26;
  const td = 13;
  const TH = 92;
  const top = ty - TH;
  // Left face, right face, top — by hand rather than through isoBox, because
  // the tower is a square shaft on a diamond footprint and wants its own
  // proportions.
  const shaft = (yTop, yBot) => {
    g.fillStyle(dim(LIME), 1);
    g.fillPoints([
      { x: tx - tw, y: yBot - td }, { x: tx, y: yBot },
      { x: tx, y: yTop }, { x: tx - tw, y: yTop - td },
    ], true, true);
    g.fillStyle(lit(LIME), 1);
    g.fillPoints([
      { x: tx + tw, y: yBot - td }, { x: tx, y: yBot },
      { x: tx, y: yTop }, { x: tx + tw, y: yTop - td },
    ], true, true);
    g.lineStyle(2.4, OUT, 1);
    g.strokePoints([
      { x: tx - tw, y: yBot - td }, { x: tx, y: yBot },
      { x: tx + tw, y: yBot - td }, { x: tx + tw, y: yTop - td },
      { x: tx, y: yTop }, { x: tx - tw, y: yTop - td },
    ], true, true);
    g.lineStyle(2, OUT, 1);
    g.beginPath();
    g.moveTo(tx, yBot);
    g.lineTo(tx, yTop);
    g.strokePath();
    rimLine(g, tx + tw - 1, yTop - td + 1, tx + tw - 1, yBot - td - 1, 1.8, 0.42);
  };
  shaft(top + 34, ty);
  // String courses, so the shaft has scale.
  g.lineStyle(1.4, shade(LIME, -0.22), 0.6);
  for (const f of [0.34, 0.62]) {
    const y = ty - (ty - (top + 34)) * f;
    g.beginPath();
    g.moveTo(tx - tw, y - td);
    g.lineTo(tx, y);
    g.lineTo(tx + tw, y - td);
    g.strokePath();
  }
  // A tall lancet in the shaft.
  g.fillStyle(0x2b3547, 1);
  g.fillRoundedRect(tx - 5, ty - 44, 10, 20, 5);
  g.lineStyle(1.5, OUT, 1);
  g.strokeRoundedRect(tx - 5, ty - 44, 10, 20, 5);

  // The belfry: an open stage, so there is a hole in the silhouette. This is
  // the single detail that separates the tower from a chimney or a mast.
  const bTop = top + 8;
  const bBot = top + 34;
  g.fillStyle(0x171208, 1);
  g.fillPoints([
    { x: tx - tw, y: bBot - td }, { x: tx, y: bBot },
    { x: tx + tw, y: bBot - td }, { x: tx + tw, y: bTop - td },
    { x: tx, y: bTop }, { x: tx - tw, y: bTop - td },
  ], true, true);
  // The bell hanging in it, and its headstock.
  g.lineStyle(2.4, OUT, 1);
  g.beginPath();
  g.moveTo(tx - 12, bTop + 4);
  g.lineTo(tx + 12, bTop + 4);
  g.strokePath();
  const bell = [
    { x: tx - 8, y: bBot - 6 }, { x: tx - 6, y: bTop + 12 },
    { x: tx - 2.5, y: bTop + 7 }, { x: tx + 2.5, y: bTop + 7 },
    { x: tx + 6, y: bTop + 12 }, { x: tx + 8, y: bBot - 6 },
  ];
  g.fillStyle(0x8a6a2c, 1);
  g.fillPoints(bell, true, true);
  g.fillStyle(0xc9a54a, 1);
  g.fillPoints(bell.map((p) => ({ x: p.x + 2, y: p.y - 1 })), true, true);
  g.lineStyle(1.8, OUT, 1);
  g.strokePoints(bell, true, true);
  g.fillStyle(0x6b5220, 1);
  g.fillEllipse(tx, bBot - 6, 17, 5);
  g.lineStyle(1.6, OUT, 1);
  g.strokeEllipse(tx, bBot - 6, 17, 5);
  // Corner posts of the stage, drawn last so the bell sits behind them.
  for (const sgn of [-1, 1]) {
    g.fillStyle(LIME, 1);
    g.fillRect(tx + sgn * tw - (sgn > 0 ? 5 : 0), bTop - td, 5, bBot - bTop);
    g.lineStyle(1.8, OUT, 1);
    g.strokeRect(tx + sgn * tw - (sgn > 0 ? 5 : 0), bTop - td, 5, bBot - bTop);
  }

  // Pyramid cap in slate, then the cross.
  const apex = bTop - 34;
  g.fillStyle(dim(SLATE), 1);
  g.fillPoints([
    { x: tx - tw - 3, y: bTop - td }, { x: tx, y: bTop + 2 }, { x: tx, y: apex },
  ], true, true);
  g.fillStyle(lit(SLATE), 1);
  g.fillPoints([
    { x: tx + tw + 3, y: bTop - td }, { x: tx, y: bTop + 2 }, { x: tx, y: apex },
  ], true, true);
  g.fillStyle(shade(SLATE, 0.1), 1);
  g.fillPoints([
    { x: tx - tw - 3, y: bTop - td }, { x: tx, y: bTop - td * 2 },
    { x: tx + tw + 3, y: bTop - td }, { x: tx, y: apex },
  ], true, true);
  g.lineStyle(2.4, OUT, 1);
  g.strokePoints([
    { x: tx - tw - 3, y: bTop - td }, { x: tx, y: bTop + 2 },
    { x: tx + tw + 3, y: bTop - td }, { x: tx, y: apex },
  ], true, true);
  rimLine(g, tx + tw + 2, bTop - td, tx, apex, 1.6, 0.4);

  stick(g, tx, apex + 2, tx, apex - 16, 2.4, 0xd8b23c);
  g.lineStyle(4.6, OUT, 1);
  g.beginPath();
  g.moveTo(tx - 6, apex - 11);
  g.lineTo(tx + 6, apex - 11);
  g.strokePath();
  g.lineStyle(2.4, 0xf0c94a, 1);
  g.beginPath();
  g.moveTo(tx - 6, apex - 11);
  g.lineTo(tx + 6, apex - 11);
  g.strokePath();

  // A cloister well and a herb bed on the paving, so the yard is a monastery's
  // yard and not a parade ground.
  const wx = cx + hw * 0.02;
  const wy = cy + hh * 0.66;
  contactShadow(g, wx, wy + 1, 26, 11, 1);
  g.fillStyle(STONE_D, 1);
  g.fillEllipse(wx, wy - 6, 26, 12);
  g.fillStyle(STONE, 1);
  g.fillEllipse(wx, wy - 8, 26, 12);
  g.fillStyle(0x120d08, 1);
  g.fillEllipse(wx, wy - 8.5, 18, 8);
  g.lineStyle(1.9, OUT, 1);
  g.strokeEllipse(wx, wy - 8, 26, 12);
  stick(g, wx - 10, wy - 12, wx - 10, wy - 28, 2.2, WOOD_D);
  stick(g, wx + 10, wy - 12, wx + 10, wy - 28, 2.2, WOOD_D);
  stick(g, wx - 11, wy - 28, wx + 11, wy - 28, 2.6, WOOD);

  banner(g, cx + hw * 0.66, cy + hh * 0.3, col, colDark, 24);
}


// ---------------------------------------------------------------------------
// Town Center — must survive being ringed by houses at radius 2
// ---------------------------------------------------------------------------
//
// Four separate cues, so losing any one of them to occlusion is survivable:
// a warm tile roof nothing else on the map wears, a stone keep raised well
// above house ridge height, a mast whose gonfalon clears every neighbouring
// roof, and a broad team-coloured fascia under the eaves.

function drawTownCenter(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, true);

  const iw = hw * 0.8;
  const ih = hh * 0.8;
  const wallH = 50;
  isoBox(g, cx, cy, iw, ih, wallH, PLASTER, PLASTER_D, shade(PLASTER, 0.1));
  timbers(g, cx, cy, iw, ih, wallH);

  // Stone piers at the three visible corners: more mass at ground level, and
  // something that still says "Town Center" if only the base is showing.
  for (const [px, py] of [[cx - iw, cy], [cx, cy + ih], [cx + iw, cy]]) {
    g.fillStyle(STONE, 1);
    g.fillRect(px - 5, py - wallH, 10, wallH);
    g.lineStyle(2, OUT, 1);
    g.strokeRect(px - 5, py - wallH, 10, wallH);
    g.fillStyle(STONE_D, 0.7);
    for (let k = 1; k < 4; k++) {
      g.fillRect(px - 5, py - (wallH * k) / 4, 10, 1.6);
    }
  }

  const topY = cy - wallH;
  isoRoof(g, cx, topY, iw * 1.16, ih * 1.16, 32, TILE_ROOF, TILE_ROOF_D, col, colDark, 8);

  // Door, under a team-coloured awning.
  const doorTop = cy + ih - wallH + 6;
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(cx - 9, doorTop, 18, wallH - 10, 3);
  g.lineStyle(2.2, OUT, 1);
  g.strokeRoundedRect(cx - 9, doorTop, 18, wallH - 10, 3);
  g.fillStyle(0xdcc36a, 1);
  g.fillCircle(cx + 5, doorTop + (wallH - 10) / 2, 1.8);
  const awning = [
    { x: cx - 14, y: doorTop - 1 },
    { x: cx + 14, y: doorTop - 1 },
    { x: cx + 10, y: doorTop - 8 },
    { x: cx - 10, y: doorTop - 8 },
  ];
  g.fillStyle(col, 1);
  g.fillPoints(awning, true, true);
  g.lineStyle(1.8, OUT, 1);
  g.strokePoints(awning, true, true);

  // Raised stone keep.
  const kw = iw * 0.46;
  const kh = ih * 0.46;
  const kBase = topY - 4;
  const keepH = 34;
  isoBox(g, cx, kBase, kw, kh, keepH, STONE, STONE_D, shade(STONE, 0.16));
  const kTop = kBase - keepH;
  // arrow slits
  g.fillStyle(OUT, 0.85);
  g.fillRect(cx - 9, kBase - keepH + 8, 3, 11);
  g.fillRect(cx + 6, kBase - keepH + 8, 3, 11);
  isoRoof(g, cx, kTop, kw * 1.36, kh * 1.36, 26, TILE_ROOF, TILE_ROOF_D, col, colDark, 5);

  // The mast. Its whole job is to be visible when the walls are not.
  const apexY = kTop - kh * 1.36 - 26;
  mast(g, cx, apexY + 8, col, colDark, 50);

  banner(g, cx - hw * 0.6, cy + 4, col, colDark, 36);
  banner(g, cx + hw * 0.6, cy + 4, col, colDark, 36);
}

/** Pole, crossbar and a big symmetric gonfalon — reads from right across the map. */
function mast(g, x, y, col, colDark, h) {
  const top = y - h;
  g.lineStyle(4.6, OUT, 1);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x, top);
  g.strokePath();
  g.lineStyle(2.4, 0x6a5334, 1);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x, top);
  g.strokePath();
  // finial
  g.fillStyle(0xf0cf62, 1);
  g.fillCircle(x, top - 3, 3.6);
  g.lineStyle(1.6, OUT, 1);
  g.strokeCircle(x, top - 3, 3.6);
  // crossbar
  g.lineStyle(3.4, OUT, 1);
  g.beginPath();
  g.moveTo(x - 13, top + 3);
  g.lineTo(x + 13, top + 3);
  g.strokePath();
  g.lineStyle(1.6, 0x6a5334, 1);
  g.beginPath();
  g.moveTo(x - 13, top + 3);
  g.lineTo(x + 13, top + 3);
  g.strokePath();
  // gonfalon, swallow-tailed
  const t = top + 4;
  const flag = [
    { x: x - 12, y: t },
    { x: x + 12, y: t },
    { x: x + 12, y: t + 20 },
    { x: x + 6, y: t + 15 },
    { x: x, y: t + 22 },
    { x: x - 6, y: t + 15 },
    { x: x - 12, y: t + 20 },
  ];
  g.fillStyle(col, 1);
  g.fillPoints(flag, true, true);
  g.lineStyle(2, OUT, 1);
  g.strokePoints(flag, true, true);
  g.fillStyle(colDark, 1);
  g.fillRect(x - 12, t + 6, 24, 4);
  g.fillStyle(shade(col, 0.5), 0.85);
  g.fillCircle(x, t + 4, 3);
}

// ---------------------------------------------------------------------------
// House — low, gabled, subordinate
// ---------------------------------------------------------------------------
//
// Keeps a full team-coloured roof slope (ownership has to stay instant), but
// the pyramid is gone: a ridge roof with a plaster gable end and a thatch cap
// breaks the "one continuous mass of identical roofs" the reviewer hit, and
// the whole thing is 25px shorter than it was.

// ---------------------------------------------------------------------------
// THE FOUR HOUSES
// ---------------------------------------------------------------------------
//
// "Eight pixel-identical red-roofed houses in one frame — same roof, same wall,
// same flag in the same corner. This is the frame a player stares at for twenty
// minutes." That is the whole brief, and it is worth being precise about why
// one house drawing is a worse problem than one Blacksmith drawing: a base has
// one Blacksmith and eight houses, so the house sprite is not an object on the
// screen, it is the screen's TEXTURE. Repetition at that density stops reading
// as "several of the same building" and starts reading as a tiled background,
// which is the exact impression the review reported.
//
// FOUR THINGS VARY, and they are listed in the order the eye notices them.
// Anything further down this list, on its own, is invisible at 0.7 zoom:
//
//   1. THE ROOFLINE. Which way the ridge runs, and whether there is a ridge at
//      all. v0's ridge runs down-left to up-right; v1's runs the other way, so
//      the two are mirror images in the one line that dominates a small
//      building's silhouette. v2 is two storeys and v3 has two roofs at
//      different heights. Nothing else changes an outline this much.
//   2. THE HEIGHT AND FOOTPRINT. 60px, 48px, 80px and 57px of building above
//      the ground line, over a square, a long strip, a narrow tower and an L.
//      A row of these has a skyline; a row of v0 has a comb.
//   3. THE ROOF MATERIAL, and this is where team colour gets rebudgeted. Two of
//      the four keep a fully team-coloured roof, so ownership is still instant
//      at a glance; the other two wear thatch and terracotta and carry their
//      team colour on a gable board, a door, shutters and a banner instead. A
//      base of eight then reads as a settlement with a couple of painted roofs
//      in it, rather than as one continuous sheet of blue.
//   4. THE CLUTTER, and where the flag is. A woodpile, a water butt, a hand
//      cart, a garden fence — and the banner in a different corner on each,
//      because "same flag in the same corner" was called out by name.
//
// WHAT DOES NOT VARY: the plaster, the timber, the light, the outline weights
// and the paving. Four houses that share materials read as one village. Four
// houses that share nothing read as four games.

/** Straw. Warm, desaturated, and deliberately not near any team colour. */
const THATCH = 0xc9a961;
const THATCH_D = 0x8f7338;
/** Fired clay. The Town Center's roof tile, reused so the palette stays small. */
const CLAY = 0xb9683a;
const CLAY_D = 0x81421f;

function drawHouse(g, s, cx, cy, col, colDark, variant = 0) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, false);

  if (variant === 1) { drawHouseLong(g, cx, cy, hw, hh, col, colDark); return; }
  if (variant === 2) { drawHouseTall(g, cx, cy, hw, hh, col, colDark); return; }
  if (variant === 3) { drawHouseFarm(g, cx, cy, hw, hh, col, colDark); return; }

  // --- variant 0: the timber-framed cottage --------------------------------
  //
  // Unchanged, on purpose. It is the house every screenshot of this game has in
  // it and the one the other three are read against, so it is the one that must
  // not move; the variety is bought by adding, not by rewriting.
  const iw = hw * 0.76;
  const ih = hh * 0.76;
  const wallH = 22;
  isoBox(g, cx, cy, iw, ih, wallH, PLASTER, PLASTER_D, shade(PLASTER, 0.1));
  timbers(g, cx, cy, iw, ih, wallH);

  // Door on the south wall.
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(cx - 5.5, cy + ih - wallH + 3, 11, wallH - 5, 2.5);
  g.lineStyle(1.8, OUT, 1);
  g.strokeRoundedRect(cx - 5.5, cy + ih - wallH + 3, 11, wallH - 5, 2.5);

  gableRoof(g, cx, cy - wallH, iw * 1.14, ih * 1.14, 20, col, colDark);
  banner(g, cx + iw * 0.85, cy + 3, col, colDark, 18);
}

/**
 * Variant 1: the thatched longhouse.
 *
 * A strip rather than a square — two and a bit tiles along the grid's u axis
 * and barely one across it — under a shallow thatch roof whose ridge therefore
 * runs the OTHER WAY from variant 0's. That is the single most valuable thing
 * in this drawing: on a 40-pixel building the ridge is the longest straight
 * line in the silhouette, and two buildings whose longest line goes in opposite
 * directions can never be confused, however similar everything else is.
 *
 * It is also the lowest of the four by fifteen pixels, and it wears no team
 * colour on the roof at all. Ownership is carried by the painted gable board
 * across the sunward end — a strip of colour up in the roofline where nothing
 * occludes it — plus the door and a banner at the low end.
 */
function drawHouseLong(g, cx, cy, hw, hh, col, colDark) {
  const u0 = -0.98;
  const u1 = 0.9;
  const v0 = -0.46;
  const v1 = 0.4;
  const wallH = 18;
  const DAUB = 0xdccaa4; // mud daub: yellower and dirtier than town plaster

  isoBlock(g, cx, cy, u0, v0, u1, v1, wallH, DAUB, shade(DAUB, 0.04), shade(DAUB, 0.1));
  // Cruck framing: heavy curved timbers at intervals down the long wall, which
  // is what a building of this age and shape actually looks like and, more
  // usefully, what stops a long blank wall from reading as a shipping crate.
  for (let k = 0; k <= 3; k++) {
    const u = u0 + ((u1 - u0) * k) / 3;
    const a = gpt(cx, cy, u, v1);
    g.lineStyle(3, WOOD_D, 0.85);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(a.x, a.y - wallH);
    g.strokePath();
  }
  // The door: a black opening with a painted lintel over it. A team-coloured
  // door *panel* was tried first and at play size it read as a flag someone had
  // dropped against the wall — a saturated rectangle in the middle of a pale
  // wall is a shape, not a door. A dark hole with a coloured beam above it is
  // both, and it costs the same eight pixels of colour.
  const d = gpt(cx, cy, (u0 + u1) * 0.5 + 0.1, v1);
  g.fillStyle(0x1d160e, 1);
  g.fillRect(d.x - 5, d.y - wallH + 3, 10, wallH - 3);
  g.lineStyle(1.6, OUT, 1);
  g.strokeRect(d.x - 5, d.y - wallH + 3, 10, wallH - 3);
  g.fillStyle(colDark, 1);
  g.fillRect(d.x - 7, d.y - wallH + 0.5, 14, 4);
  g.fillStyle(col, 1);
  g.fillRect(d.x - 7, d.y - wallH + 0.5, 14, 2.4);
  g.lineStyle(1.4, OUT, 1);
  g.strokeRect(d.x - 7, d.y - wallH + 0.5, 14, 4);

  const R = blockRoof(g, cx, cy - wallH, u0, v0, u1, v1, 16,
    THATCH, THATCH_D, 'u', 0.09);
  // Thatch is not tiles: it wants a thick soft ridge rather than a capped one,
  // and a couple of tufts breaking the line. Drawn over blockRoof's ridge cap.
  g.lineStyle(7, OUT, 0.9);
  g.beginPath();
  g.moveTo(R.R0.x, R.R0.y + 1);
  g.lineTo(R.R1.x, R.R1.y + 1);
  g.strokePath();
  g.lineStyle(4.6, THATCH_D, 1);
  g.beginPath();
  g.moveTo(R.R0.x, R.R0.y + 1);
  g.lineTo(R.R1.x, R.R1.y + 1);
  g.strokePath();
  g.lineStyle(2, mix(THATCH, RIM, 0.3), 0.8);
  g.beginPath();
  g.moveTo(R.R0.x + 1, R.R0.y);
  g.lineTo(R.R1.x - 1, R.R1.y);
  g.strokePath();
  // Moss along the eave of the shaded slope, where rain sits. One green stain
  // on a straw roof does more for "somebody lives here" than any amount of
  // extra thatch texture, but it has to be at the edge — in the middle of the
  // plane it reads as a hole in the drawing, which is what the first try was.
  g.fillStyle(0x5f7340, 0.4);
  g.fillEllipse(cx - 26, cy - wallH - 3, 26, 6);

  // The painted bargeboards on the sunward gable: this house's whole allowance
  // of team colour, carried as two strokes down the rake of the roof rather
  // than as a field. Up in the roofline, where in a packed base nothing stands
  // in front of it — and the reason this variant can afford to wear thatch.
  const gE = gpt(cx, cy - wallH, u1 + 0.09, v0 - 0.09);
  const gS = gpt(cx, cy - wallH, u1 + 0.09, v1 + 0.09);
  const apex = { x: (gE.x + gS.x) / 2, y: (gE.y + gS.y) / 2 - 16 };
  g.lineStyle(5, OUT, 1);
  g.beginPath();
  g.moveTo(gE.x, gE.y);
  g.lineTo(apex.x, apex.y);
  g.lineTo(gS.x, gS.y);
  g.strokePath();
  g.lineStyle(3, col, 1);
  g.beginPath();
  g.moveTo(gE.x, gE.y);
  g.lineTo(apex.x, apex.y);
  g.lineTo(gS.x, gS.y);
  g.strokePath();
  g.lineStyle(1.2, shade(col, 0.35), 0.7);
  g.beginPath();
  g.moveTo(gE.x - 1, gE.y - 1);
  g.lineTo(apex.x, apex.y - 2);
  g.strokePath();

  // A woodpile against the shaded end, and the flag at the far corner — a
  // different corner from every other variant.
  const wx = cx - hw * 0.66;
  const wy = cy + hh * 0.3;
  contactShadow(g, wx, wy + 1, 22, 9, 0.9);
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 4 - r; k++) {
      const px = wx - 8 + k * 5.4 + r * 2.7;
      const py = wy - 4 - r * 5;
      g.fillStyle(OUT, 1);
      g.fillCircle(px, py, 3.2);
      g.fillStyle(0x7d5a30, 1);
      g.fillCircle(px, py, 2.4);
      g.fillStyle(0xc2a06a, 1);
      g.fillCircle(px + 0.5, py - 0.6, 1.2);
    }
  }
  banner(g, cx - 6, cy + hh * 0.86, col, colDark, 20);
}

/**
 * Variant 2: the two-storey town house.
 *
 * The tall one. A narrow plan — barely one tile square — carrying two storeys
 * with the upper one JETTIED out over the lower, which puts a step in the
 * silhouette halfway up that nothing else in the game has. Roofed in fired
 * clay, steeply, so the outline is a narrow spike rather than a wide tent.
 *
 * This is the variant that gives a row of houses a skyline. Eight copies of
 * variant 0 are eight identical bumps; two or three of these among them and the
 * base has a shape. Its team colour is on the shutters, the door and a banner
 * carried high on the jetty, where in a packed base it clears the roofs of its
 * neighbours — which is more visible ownership than variant 0's roof gets once
 * something is built in front of it.
 */
function drawHouseTall(g, cx, cy, hw, hh, col, colDark) {
  const a = 0.5;   // ground floor
  const b = 0.63;  // the jetty overhangs it
  const h1 = 21;
  const h2 = 20;

  isoBlock(g, cx, cy, -a, -a, a, a, h1, PLASTER_D, PLASTER, shade(PLASTER, 0.08));
  // Ground floor in exposed stone: a town house has a rubble base and a timber
  // top, and the two materials stacked are half of why it reads as two storeys
  // rather than as one tall box.
  g.lineStyle(1, STONE_D, 0.5);
  for (let k = 1; k <= 3; k++) {
    const y = cy - (h1 * k) / 4;
    g.beginPath();
    g.moveTo(cx - a * 2 * HALF_W, y);
    g.lineTo(cx, y + a * 2 * HALF_H);
    g.lineTo(cx + a * 2 * HALF_W, y);
    g.strokePath();
  }
  // The door, deep in the shadow of the jetty above it.
  const dS = gpt(cx, cy, a, a);
  g.fillStyle(0x241d13, 1);
  g.fillRoundedRect(dS.x - 6, dS.y - h1 + 1, 12, h1 - 1, 2.5);
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(dS.x - 5, dS.y - h1 + 2, 10, h1 - 2, 2);
  g.fillStyle(col, 1);
  g.fillRect(dS.x - 3.6, dS.y - h1 + 3.2, 7.2, h1 - 5);

  // The jetty. Drawn as a block whose ground plane is the top of the first
  // storey, then the joist ends that carry it picked out underneath — those
  // five dark ticks are what say "this floor is hanging in the air".
  const upper = isoBlock(g, cx, cy - h1, -b, -b, b, b, h2,
    PLASTER, shade(PLASTER, 0.06), shade(PLASTER, 0.12));
  timbers(g, cx, cy - h1, b * 2 * HALF_W, b * 2 * HALF_H, h2);
  g.fillStyle(shade(WOOD_D, -0.2), 1);
  for (let k = 1; k <= 4; k++) {
    const t = k / 5;
    const p = { x: upper.W.x + (upper.S.x - upper.W.x) * t, y: upper.W.y + (upper.S.y - upper.W.y) * t };
    const q = { x: upper.S.x + (upper.E.x - upper.S.x) * t, y: upper.S.y + (upper.E.y - upper.S.y) * t };
    g.fillRect(p.x - 2, p.y - 1, 4, 4);
    g.fillRect(q.x - 2, q.y - 1, 4, 4);
  }

  // Shuttered windows on the jetty, in team colour. Small, high, and repeated —
  // three of them together carry more ownership than one big painted panel and
  // cost a fraction of the sprite.
  for (const t of [0.3, 0.7]) {
    const p = gpt(cx, cy - h1, -b + b * 2 * t, b);
    g.fillStyle(OUT, 1);
    g.fillRect(p.x - 6, p.y - h2 + 4, 12, 9);
    g.fillStyle(0x2b2116, 1);
    g.fillRect(p.x - 4.8, p.y - h2 + 5, 9.6, 7);
    g.fillStyle(col, 1);
    g.fillRect(p.x - 6, p.y - h2 + 4, 2.6, 9);
    g.fillRect(p.x + 3.4, p.y - h2 + 4, 2.6, 9);
    g.lineStyle(1.4, OUT, 1);
    g.strokeRect(p.x - 6, p.y - h2 + 4, 12, 9);
  }

  blockRoof(g, cx, cy - h1 - h2, -b, -b, b, b, 22, CLAY, CLAY_D, 'v', 0.1);
  // Chimney against the shaded slope, tall and thin.
  g.fillStyle(0x8a6a55, 1);
  g.fillRect(cx - 24, cy - h1 - h2 - 24, 7, 18);
  g.lineStyle(1.8, OUT, 1);
  g.strokeRect(cx - 24, cy - h1 - h2 - 24, 7, 18);
  g.fillStyle(0x5f483a, 1);
  g.fillRect(cx - 25.4, cy - h1 - h2 - 27, 9.8, 3);

  banner(g, cx + b * 2 * HALF_W - 2, cy - h1 + 4, col, colDark, 22);
}

/**
 * Variant 3: the farmstead.
 *
 * An L: a gabled house along one grid axis with a lower lean-to byre along the
 * other, wrapping a yard. This is the only house in the set whose FOOTPRINT is
 * not convex, and a plan with a notch in it is unmistakable from above at any
 * size — it is also the one that makes a cluster of houses look like a village
 * that grew rather than a row that was placed.
 *
 * It keeps a fully team-coloured roof on the main range, so that between this
 * and variant 0 half of any group of houses still shouts whose they are.
 */
function drawHouseFarm(g, cx, cy, hw, hh, col, colDark) {
  // The main range, across the back.
  const mu0 = -0.98;
  const mu1 = 0.2;
  const mv0 = -0.95;
  const mv1 = -0.05;
  const wallH = 17;
  // The byre wing, coming forward down the shaded side. Drawn after the main
  // range because it is nearer the camera: in this projection depth is u+v, and
  // every pair of overlapping pieces in this file is ordered by it.
  const bu0 = -0.98;
  const bu1 = -0.24;
  const bv0 = -0.05;
  const bv1 = 0.82;

  isoBlock(g, cx, cy, mu0, mv0, mu1, mv1, wallH, PLASTER, PLASTER_D, shade(PLASTER, 0.1));
  const mS = gpt(cx, cy, mu1, mv1);
  const mW = gpt(cx, cy, mu0, mv1);
  g.lineStyle(2.4, WOOD_D, 0.85);
  for (let k = 1; k <= 3; k++) {
    const t = k / 4;
    const p = { x: mW.x + (mS.x - mW.x) * t, y: mW.y + (mS.y - mW.y) * t };
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x, p.y - wallH);
    g.strokePath();
  }
  const md = gpt(cx, cy, mu1 - 0.3, mv1);
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(md.x - 5, md.y - wallH + 2, 10, wallH - 3, 2);
  g.lineStyle(1.7, OUT, 1);
  g.strokeRoundedRect(md.x - 5, md.y - wallH + 2, 10, wallH - 3, 2);
  blockRoof(g, cx, cy - wallH, mu0, mv0, mu1, mv1, 12, col, colDark, 'u', 0.13);

  // The byre: lower walls, a mono-pitch roof in thatch, and open at the front
  // so there is a dark bay in the middle of the house. That hole is worth as
  // much to the silhouette as the L is.
  const byreH = 13;
  isoBlock(g, cx, cy, bu0, bv0, bu1, bv1, byreH,
    shade(PLASTER, -0.06), PLASTER_D, shade(PLASTER, 0.06));
  const oS = gpt(cx, cy, bu1, bv1);
  const oE = gpt(cx, cy, bu1, bv0);
  g.fillStyle(0x241d13, 1);
  g.fillPoints([
    oS, oE, { x: oE.x, y: oE.y - byreH + 2 }, { x: oS.x, y: oS.y - byreH + 2 },
  ], true, true);
  g.lineStyle(1.8, OUT, 1);
  g.strokePoints([
    oS, oE, { x: oE.x, y: oE.y - byreH + 2 }, { x: oS.x, y: oS.y - byreH + 2 },
  ], true, true);
  shedRoof(g, cx, cy, bu0, bv0, bu1, bv1, byreH + 12, byreH + 1,
    THATCH, THATCH_D, 0.14);

  // The yard: a water butt under the eaves and a hand cart tipped on its shafts.
  const bx = cx + hw * 0.3;
  const by = cy + hh * 0.42;
  contactShadow(g, bx, by + 1, 16, 7, 0.9);
  g.fillStyle(OUT, 1);
  g.fillRect(bx - 7, by - 14, 14, 14);
  g.fillStyle(0x6d4c29, 1);
  g.fillRect(bx - 6, by - 13, 12, 13);
  g.fillStyle(0x8a6337, 1);
  g.fillRect(bx - 6, by - 13, 5, 13);
  g.fillStyle(0x4c6d7a, 1);
  g.fillEllipse(bx, by - 13.5, 12, 5);
  g.lineStyle(1.6, OUT, 1);
  g.strokeEllipse(bx, by - 13.5, 12, 5);
  g.lineStyle(1.4, STEEL_D, 0.9);
  g.beginPath();
  g.moveTo(bx - 6, by - 9);
  g.lineTo(bx + 6, by - 9);
  g.moveTo(bx - 6, by - 3);
  g.lineTo(bx + 6, by - 3);
  g.strokePath();

  fenceRun(g,
    { x: cx + hw * 0.06, y: cy + hh * 0.72 },
    { x: cx + hw * 0.74, y: cy + hh * 0.26 }, true);
  banner(g, cx - hw * 0.5, cy + hh * 0.56, col, colDark, 22);
}

/**
 * Ridge roof over a diamond footprint. The ridge runs along the grid's
 * north-east axis, which leaves exactly two faces facing the camera: the
 * south-east slope, and the triangular gable end on the south-west.
 */
function gableRoof(g, cx, cy, hw, hh, h, col, colDark) {
  const N = { x: cx, y: cy - hh };
  const E = { x: cx + hw, y: cy };
  const S = { x: cx, y: cy + hh };
  const W = { x: cx - hw, y: cy };
  const R1 = { x: cx + hw / 2, y: cy - hh / 2 - h }; // ridge, NE end
  const R2 = { x: cx - hw / 2, y: cy + hh / 2 - h }; // ridge, SW end

  // eave lip
  g.fillStyle(shade(colDark, -0.3), 1);
  g.fillPoints([
    { x: W.x, y: W.y }, { x: S.x, y: S.y }, { x: E.x, y: E.y },
    { x: E.x, y: E.y + 3 }, { x: S.x, y: S.y + 3 }, { x: W.x, y: W.y + 3 },
  ], true, true);

  // south-east slope — the one plane on this roof that faces the sun.
  const slope = [S, E, R1, R2];
  g.fillStyle(lit(col), 1);
  g.fillPoints(slope, true, true);
  // Graded down the pitch: the eave sees less sky than the ridge does.
  for (let k = 0; k < 3; k++) {
    const t0 = k / 3;
    const t1 = (k + 1) / 3;
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    g.fillStyle(0x1a1a24, 0.07 * (1 - k / 3));
    g.fillPoints([
      lerp(S, R2, t0), lerp(E, R1, t0), lerp(E, R1, t1), lerp(S, R2, t1),
    ], true, true);
  }
  outline(g, true, 2.2);
  g.strokePoints(slope, true, true);
  outline(g, false, 2.2);
  g.beginPath();
  g.moveTo(S.x, S.y);
  g.lineTo(E.x, E.y);
  g.strokePath();
  rimLine(g, R2.x, R2.y + 1, R1.x, R1.y + 1, 2, 0.45);
  g.lineStyle(1.1, shade(col, -0.4), 0.42);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    g.beginPath();
    g.moveTo(S.x + (R2.x - S.x) * t, S.y + (R2.y - S.y) * t);
    g.lineTo(E.x + (R1.x - E.x) * t, E.y + (R1.y - E.y) * t);
    g.strokePath();
  }

  // south-west gable end: plaster with timber bracing
  const gable = [W, S, R2];
  g.fillStyle(PLASTER, 1);
  g.fillPoints(gable, true, true);
  g.lineStyle(2.4, WOOD_D, 0.9);
  g.beginPath();
  g.moveTo(W.x + 3, W.y - 1);
  g.lineTo(R2.x, R2.y + 4);
  g.moveTo(S.x - 2, S.y - 2);
  g.lineTo(R2.x, R2.y + 4);
  g.strokePath();
  g.lineStyle(2.2, OUT, 1);
  g.strokePoints(gable, true, true);
  // loft opening
  const mx = (W.x + S.x) / 2;
  const my = (W.y + S.y) / 2;
  g.fillStyle(0x3b2c1c, 1);
  g.fillEllipse((mx + R2.x) / 2, (my + R2.y) / 2 + 1, 7, 6);

  // thatch cap along the ridge
  g.lineStyle(5.5, OUT, 1);
  g.beginPath();
  g.moveTo(R2.x, R2.y);
  g.lineTo(R1.x, R1.y);
  g.strokePath();
  g.lineStyle(3.2, 0xd8b96b, 1);
  g.beginPath();
  g.moveTo(R2.x, R2.y);
  g.lineTo(R1.x, R1.y);
  g.strokePath();

  // chimney, a little more silhouette for free
  const chx = R2.x + (R1.x - R2.x) * 0.68;
  const chy = R2.y + (R1.y - R2.y) * 0.68;
  g.fillStyle(0x8a6a55, 1);
  g.fillRect(chx - 3.2, chy - 11, 6.4, 12);
  g.lineStyle(1.7, OUT, 1);
  g.strokeRect(chx - 3.2, chy - 11, 6.4, 12);
  g.fillStyle(0x5f483a, 1);
  g.fillRect(chx - 4.2, chy - 13, 8.4, 2.6);
}

// ---------------------------------------------------------------------------
// Farm — a flat tilled plot, never confusable with a house
// ---------------------------------------------------------------------------
//
// stage 0 = fresh (full gold crop), 1 = worked (half the rows cut),
// 2 = spent (grey stubble on cracked soil). The colour swing from gold to grey
// is the point: which farms are worked out has to be readable without tapping.

const FARM_STAGE = [
  { soil: 0x5c4020, crop: 0xe8bd35, lit: 0xfbe388, dark: 0x9a761b, tufts: 10 },
  { soil: 0x604a2b, crop: 0xb8993f, lit: 0xd2b96a, dark: 0x846718, tufts: 5 },
  { soil: 0x6f6455, crop: 0x9d9578, lit: 0xb6ae92, dark: 0x6e6850, tufts: 2 },
];

function drawFarm(g, s, cx, cy, col, colDark, stage) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  const P = FARM_STAGE[stage] || FARM_STAGE[0];
  const spent = stage === 2;

  const corners = [
    { x: cx, y: cy - hh },   // N
    { x: cx + hw, y: cy },   // E
    { x: cx, y: cy + hh },   // S
    { x: cx - hw, y: cy },   // W
  ];

  // Back fence first, so the northern rails sit behind the crop.
  fenceRun(g, corners[3], corners[0], spent);
  fenceRun(g, corners[0], corners[1], spent);

  // Tilled soil.
  g.fillStyle(shade(P.soil, -0.35), 1);
  g.fillPoints(corners.map((p) => ({ x: p.x, y: p.y + 3 })), true, true);
  g.fillStyle(P.soil, 1);
  g.fillPoints(corners, true, true);
  g.lineStyle(2.5, OUT, 1);
  g.strokePoints(corners, true, true);

  // Crop rows, running along the grid's north-east axis.
  const rows = 7;
  for (let i = 1; i <= rows; i++) {
    const t = i / (rows + 1);
    const x0 = cx - hw + hw * t;
    const y0 = cy + hh * t;
    const x1 = cx + hw * t;
    const y1 = cy - hh + hh * t;
    // furrow trench
    g.lineStyle(6.4, shade(P.soil, -0.34), 1);
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.strokePath();
    // Stage 1 cuts every other row right back to stubble, so a half-worked
    // farm differs from a fresh one in layout as well as in hue.
    const cut = spent || (stage === 1 && i % 2 === 0);
    if (cut) {
      // stubble: short broken bristles on bare soil, no standing crop
      g.lineStyle(1.4, P.crop, 0.8);
      for (let k = 0; k < 9; k++) {
        const u = (k + 0.4) / 9;
        const px = x0 + (x1 - x0) * u;
        const py = y0 + (y1 - y0) * u - 2;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + (k % 2 ? 1 : -1), py - 2.4);
        g.strokePath();
      }
    } else {
      g.lineStyle(5.6, P.dark, 1);
      g.beginPath();
      g.moveTo(x0 + 2, y0 - 2.5);
      g.lineTo(x1 - 2, y1 - 2.5);
      g.strokePath();
      g.lineStyle(4, P.crop, 1);
      g.beginPath();
      g.moveTo(x0 + 2, y0 - 4);
      g.lineTo(x1 - 2, y1 - 4);
      g.strokePath();
      g.lineStyle(1.4, P.lit, 0.85);
      g.beginPath();
      g.moveTo(x0 + 3, y0 - 5.4);
      g.lineTo(x1 - 3, y1 - 5.4);
      g.strokePath();
      // Ears standing proud of the row, alternating sides. Without these the
      // rows read as laid planks rather than as a crop.
      const tufts = P.tufts;
      for (let k = 0; k < tufts; k++) {
        const u = (k + 0.5) / tufts;
        const px = x0 + (x1 - x0) * u;
        const py = y0 + (y1 - y0) * u - 5;
        const lean = k % 2 ? 1.6 : -1.6;
        g.lineStyle(1.6, P.dark, 1);
        g.beginPath();
        g.moveTo(px, py + 1);
        g.lineTo(px + lean, py - 4.6);
        g.strokePath();
        g.lineStyle(1.5, P.lit, 1);
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + lean, py - 5);
        g.strokePath();
      }
    }
  }

  if (spent) {
    // dry cracks and loose straw, so a worked-out farm reads as abandoned
    g.lineStyle(1.2, shade(P.soil, -0.4), 0.6);
    for (let k = 0; k < 5; k++) {
      const px = cx - 34 + k * 17;
      const py = cy - 8 + (k % 3) * 9;
      g.beginPath();
      g.moveTo(px - 6, py);
      g.lineTo(px, py + 2.5);
      g.lineTo(px + 7, py - 1.5);
      g.strokePath();
    }
  }

  // Front fence.
  fenceRun(g, corners[3], corners[2], spent);
  fenceRun(g, corners[2], corners[1], spent);

  // Team pennant on the north post — the only loud colour on the plot, which
  // is what keeps a farm from competing with the buildings around it.
  const post = corners[0];
  g.lineStyle(3, OUT, 1);
  g.beginPath();
  g.moveTo(post.x, post.y);
  g.lineTo(post.x, post.y - 22);
  g.strokePath();
  g.lineStyle(1.5, 0x6a5334, 1);
  g.beginPath();
  g.moveTo(post.x, post.y);
  g.lineTo(post.x, post.y - 22);
  g.strokePath();
  const flagCol = spent ? shade(colDark, -0.32) : col;
  g.fillStyle(flagCol, 1);
  g.fillTriangle(post.x, post.y - 22, post.x + 12, post.y - 18, post.x, post.y - 13);
  g.lineStyle(1.6, OUT, 1);
  g.strokeTriangle(post.x, post.y - 22, post.x + 12, post.y - 18, post.x, post.y - 13);
}

/** Low post-and-rail run between two footprint corners. */
function fenceRun(g, a, b, weathered) {
  const wood = weathered ? 0x7d7361 : 0x8a6337;
  const H = 8;
  g.lineStyle(3.2, OUT, 1);
  g.beginPath();
  g.moveTo(a.x, a.y - H);
  g.lineTo(b.x, b.y - H);
  g.moveTo(a.x, a.y - H * 0.42);
  g.lineTo(b.x, b.y - H * 0.42);
  g.strokePath();
  g.lineStyle(1.6, wood, 1);
  g.beginPath();
  g.moveTo(a.x, a.y - H);
  g.lineTo(b.x, b.y - H);
  g.moveTo(a.x, a.y - H * 0.42);
  g.lineTo(b.x, b.y - H * 0.42);
  g.strokePath();
  for (const t of [0, 0.5, 1]) {
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    g.fillStyle(OUT, 1);
    g.fillRect(px - 2, py - H - 1.5, 4, H + 2);
    g.fillStyle(wood, 1);
    g.fillRect(px - 1.2, py - H - 0.8, 2.4, H + 1);
  }
}

/**
 * An isometric box: two visible wall faces plus the flat top.
 *
 * THREE values, never two, and they are not arbitrary. The sun in this world is
 * up and to the right (see THE LIGHT at the top of the file), so the south-east
 * face takes the key, the south-west face is turned away from it and takes both
 * a drop in value and a shift towards the blue of skylight, and the roof plane
 * — pointing straight up at the sky — is the brightest of the three. Two values
 * make a box look like a folded sheet of paper; the third is what gives it mass.
 *
 * Three more things happen here that did not before, and between them they are
 * most of the difference between "vector art" and "a building":
 *
 *   AMBIENT OCCLUSION. Light does not reach into the corner where two walls
 *   meet, nor into the last few pixels where a wall meets the ground. Two very
 *   soft dark bands, one down the vertical corner and one along each footing.
 *
 *   A GRADED WALL. Real walls are darker at the bottom, where less of the sky
 *   is visible to them. Four low-alpha bands up each face, since Graphics has no
 *   gradient fill.
 *
 *   A VARIED OUTLINE. Heavy black on the shaded silhouette, thin and warm on the
 *   lit one. A single black keyline of one weight around everything is the
 *   classic flat-vector tell, and it was around everything in this file.
 */
function isoBox(g, cx, cy, hw, hh, h, faceL, faceR, top) {
  const bW = { x: cx - hw, y: cy };
  const bS = { x: cx, y: cy + hh };
  const bE = { x: cx + hw, y: cy };
  const bN = { x: cx, y: cy - hh };

  const left = [bW, bS, { x: bS.x, y: bS.y - h }, { x: bW.x, y: bW.y - h }];
  const right = [bS, bE, { x: bE.x, y: bE.y - h }, { x: bS.x, y: bS.y - h }];
  const topFace = [
    { x: bN.x, y: bN.y - h },
    { x: bE.x, y: bE.y - h },
    { x: bS.x, y: bS.y - h },
    { x: bW.x, y: bW.y - h },
  ];

  g.fillStyle(dim(faceL), 1);
  g.fillPoints(left, true, true);
  g.fillStyle(lit(faceR), 1);
  g.fillPoints(right, true, true);
  g.fillStyle(mix(top, SKY, 0.1), 1);
  g.fillPoints(topFace, true, true);

  // Value grading up each wall: darkest at the footing, lightest under the eave.
  for (let k = 0; k < 4; k++) {
    const t0 = (k / 4) * h;
    const t1 = ((k + 1) / 4) * h;
    const a = 0.09 * (1 - k / 4);
    g.fillStyle(0x1a1a24, a);
    g.fillPoints([
      { x: bW.x, y: bW.y - t0 }, { x: bS.x, y: bS.y - t0 },
      { x: bS.x, y: bS.y - t1 }, { x: bW.x, y: bW.y - t1 },
    ], true, true);
    g.fillPoints([
      { x: bS.x, y: bS.y - t0 }, { x: bE.x, y: bE.y - t0 },
      { x: bE.x, y: bE.y - t1 }, { x: bS.x, y: bS.y - t1 },
    ], true, true);
  }
  // Occlusion in the inside corner where the two walls meet.
  g.lineStyle(6, 0x171a22, 0.14);
  g.beginPath();
  g.moveTo(bS.x, bS.y);
  g.lineTo(bS.x, bS.y - h);
  g.strokePath();
  g.lineStyle(3, 0x171a22, 0.16);
  g.beginPath();
  g.moveTo(bS.x, bS.y);
  g.lineTo(bS.x, bS.y - h);
  g.strokePath();

  outline(g, false, 2.2);
  g.strokePoints(left, true, true);
  g.strokePoints(topFace, true, true);
  outline(g, true, 2.2);
  g.strokePoints(right, true, true);
  outline(g, false, 2.2);
  // The two edges that must stay heavy whatever else happens: the footing, and
  // the vertical corner nearest the camera. Those are the shape.
  g.beginPath();
  g.moveTo(bW.x, bW.y);
  g.lineTo(bS.x, bS.y);
  g.lineTo(bE.x, bE.y);
  g.moveTo(bS.x, bS.y);
  g.lineTo(bS.x, bS.y - h);
  g.strokePath();
  // Warm bounce along the sunward eave and the sunward corner.
  rimLine(g, bE.x - 1, bE.y - h + 1, bS.x, bS.y - h + 1, 1.8, 0.4);
  rimLine(g, bE.x - 1, bE.y - h + 2, bE.x - 1, bE.y - 2, 1.6, 0.32);
}

function timbers(g, cx, cy, hw, hh, h) {
  g.lineStyle(2.6, WOOD_D, 0.85);
  for (let i = 1; i <= 2; i++) {
    const t = i / 3;
    const lx = cx - hw + hw * t;
    const ly = cy + hh * t;
    g.beginPath();
    g.moveTo(lx, ly);
    g.lineTo(lx, ly - h);
    g.strokePath();
    const rx = cx + hw * t;
    const ry = cy + hh - hh * t;
    g.beginPath();
    g.moveTo(rx, ry);
    g.lineTo(rx, ry - h);
    g.strokePath();
  }
}

// ---------------------------------------------------------------------------
// RECTANGULAR MASS: buildings that are not square
// ---------------------------------------------------------------------------
//
// Every drawn building in this file up to now has been a diamond: isoBox takes
// a half-width and a half-height and produces a plan that is always SQUARE in
// grid terms, because the only thing that can vary is how big the diamond is.
// That single limitation is most of why the Archery Range, the Stable and the
// Blacksmith were "the same shed three times" — they could differ in how much
// of the pad they filled and in what was stuck on top, but never in their
// PROPORTION, and proportion is the first thing the eye reads and the last
// thing that survives being shrunk.
//
// The review was precise about it: "the difference is a ~20px target decal
// versus a ~20px shape in the doorway. These are the two buildings a player
// most needs to tell apart." A decal cannot fix that, and neither can a colour.
// What fixes it is a long low hall being a genuinely different SHAPE from an
// L-shaped yard, which is a genuinely different shape from a small block with a
// tall stack on it — and all three of those need a plan that is a rectangle of
// arbitrary aspect, placed anywhere on the pad, rather than a centred diamond.
//
// So: footprint-local coordinates. (u, v) are tiles along the grid's two axes,
// measured from the building's centre, so a 3x3 pad spans u and v in
// [-1.5, +1.5] and a piece of building is a rectangle in that space. `gpt`
// converts one to screen pixels, and everything below is written in terms of it.
//
// WHICH FACES ARE VISIBLE, once and for all, so nothing has to work it out
// again: the camera is south of the map, so the two faces of any block that
// can be seen are the one pointing along +u (down-RIGHT on screen, and toward
// the sun, so it takes the key) and the one pointing along +v (down-LEFT, away
// from the sun, so it takes the drop and the sky-blue shift). That is exactly
// the split isoBox already uses; these helpers keep it.

/** A footprint-local grid point (u, v in tiles from the centre) in pixels. */
function gpt(cx, cy, u, v) {
  return { x: cx + (u - v) * HALF_W, y: cy + (u + v) * HALF_H };
}

/**
 * A rectangular block standing on the footprint, from grid corner (u0, v0) to
 * (u1, v1), `h` pixels tall.
 *
 * The isoBox that already exists is this function with u0 = v0 = -a and
 * u1 = v1 = a; it is kept as it is because a dozen buildings call it and its
 * shading has been tuned against real screenshots, and this is the same shading
 * with the square constraint lifted.
 */
function isoBlock(g, cx, cy, u0, v0, u1, v1, h, faceL, faceR, top) {
  const N = gpt(cx, cy, u0, v0);
  const E = gpt(cx, cy, u1, v0);
  const S = gpt(cx, cy, u1, v1);
  const W = gpt(cx, cy, u0, v1);
  const up = (p) => ({ x: p.x, y: p.y - h });

  const left = [W, S, up(S), up(W)];     // faces +v: away from the sun
  const right = [S, E, up(E), up(S)];    // faces +u: into the sun
  const roof = [up(N), up(E), up(S), up(W)];

  g.fillStyle(dim(faceL), 1);
  g.fillPoints(left, true, true);
  g.fillStyle(lit(faceR), 1);
  g.fillPoints(right, true, true);
  g.fillStyle(mix(top, SKY, 0.1), 1);
  g.fillPoints(roof, true, true);

  // Value grading up both walls — darkest at the footing, where least sky
  // reaches them. Four bands, because Graphics has no gradient fill.
  for (let k = 0; k < 4; k++) {
    const t0 = (k / 4) * h;
    const t1 = ((k + 1) / 4) * h;
    g.fillStyle(0x1a1a24, 0.09 * (1 - k / 4));
    const band = (a, b) => g.fillPoints([
      { x: a.x, y: a.y - t0 }, { x: b.x, y: b.y - t0 },
      { x: b.x, y: b.y - t1 }, { x: a.x, y: a.y - t1 },
    ], true, true);
    band(W, S);
    band(S, E);
  }
  // Occlusion down the inside corner where the two visible walls meet.
  g.lineStyle(6, 0x171a22, 0.14);
  g.beginPath();
  g.moveTo(S.x, S.y);
  g.lineTo(S.x, S.y - h);
  g.strokePath();

  outline(g, false, 2.2);
  g.strokePoints(left, true, true);
  g.strokePoints(roof, true, true);
  outline(g, true, 2.2);
  g.strokePoints(right, true, true);
  outline(g, false, 2.2);
  g.beginPath();
  g.moveTo(W.x, W.y);
  g.lineTo(S.x, S.y);
  g.lineTo(E.x, E.y);
  g.moveTo(S.x, S.y);
  g.lineTo(S.x, S.y - h);
  g.strokePath();
  rimLine(g, E.x - 1, E.y - h + 1, S.x, S.y - h + 1, 1.8, 0.4);
  rimLine(g, E.x - 1, E.y - h + 2, E.x - 1, E.y - 2, 1.6, 0.32);
  return { N, E, S, W, up };
}

/**
 * A ridge roof over a rectangular block, with the ridge running along whichever
 * grid axis is given.
 *
 * `axis` is 'u' or 'v', and the choice is a design decision rather than a
 * detail: a roof whose ridge runs along u presents its shaded slope and its
 * SUNWARD gable end to the camera, and one running along v presents its lit
 * slope and its shaded gable. Two buildings with the same plan and different
 * ridge axes therefore look nothing alike, which is a whole extra axis of
 * difference for no extra pixels. `over` extends the eaves past the walls in
 * tiles — a deep overhang says thatch and a farmyard, a tight one says a town.
 *
 * Returns the two ridge ends, because callers want to hang things off them.
 */
function blockRoof(g, cx, cy, u0, v0, u1, v1, h, col, colDark, axis, over = 0.12) {
  const a0 = u0 - over;
  const a1 = u1 + over;
  const b0 = v0 - over;
  const b1 = v1 + over;
  const P = (u, v) => gpt(cx, cy, u, v);
  let slope;
  let gable;
  let R0;
  let R1;
  let lit0;
  if (axis === 'u') {
    const vm = (b0 + b1) / 2;
    R0 = { ...P(a0, vm), y: P(a0, vm).y - h };
    R1 = { ...P(a1, vm), y: P(a1, vm).y - h };
    slope = [P(a0, b1), P(a1, b1), R1, R0]; // the +v plane: shaded
    gable = [P(a1, b0), P(a1, b1), R1];     // the +u end: sunward
    lit0 = false;
  } else {
    const um = (a0 + a1) / 2;
    R0 = { ...P(um, b0), y: P(um, b0).y - h };
    R1 = { ...P(um, b1), y: P(um, b1).y - h };
    slope = [P(a1, b0), P(a1, b1), R1, R0]; // the +u plane: sunward
    gable = [P(a0, b1), P(a1, b1), R1];     // the +v end: shaded
    lit0 = true;
  }

  // Eave lip: a few pixels of shadowed thickness under the roof edge, which is
  // what stops a roof reading as a sheet of coloured paper laid on the walls.
  g.fillStyle(shade(colDark, -0.3), 1);
  g.fillPoints([...slope.slice(0, 2).map((p) => ({ x: p.x, y: p.y + 3 })),
    slope[1], slope[0]], true, true);

  g.fillStyle(lit0 ? lit(col) : dim(col), 1);
  g.fillPoints(slope, true, true);
  // Graded down the pitch: an eave sees less sky than a ridge does.
  const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  for (let k = 0; k < 3; k++) {
    g.fillStyle(0x1a1a24, 0.07 * (1 - k / 3));
    g.fillPoints([
      lerp(slope[0], slope[3], k / 3), lerp(slope[1], slope[2], k / 3),
      lerp(slope[1], slope[2], (k + 1) / 3), lerp(slope[0], slope[3], (k + 1) / 3),
    ], true, true);
  }
  g.lineStyle(1.1, shade(col, -0.4), 0.42);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    g.beginPath();
    const p = lerp(slope[0], slope[3], t);
    const q = lerp(slope[1], slope[2], t);
    g.moveTo(p.x, p.y);
    g.lineTo(q.x, q.y);
    g.strokePath();
  }
  outline(g, lit0, 2.2);
  g.strokePoints(slope, true, true);

  // The gable end, in plaster with a brace across it.
  g.fillStyle(lit0 ? PLASTER_D : PLASTER, 1);
  g.fillPoints(gable, true, true);
  g.lineStyle(2.2, WOOD_D, 0.85);
  g.beginPath();
  g.moveTo(gable[0].x + 2, gable[0].y - 1);
  g.lineTo(gable[2].x, gable[2].y + 4);
  g.moveTo(gable[1].x - 2, gable[1].y - 1);
  g.lineTo(gable[2].x, gable[2].y + 4);
  g.strokePath();
  g.lineStyle(2.2, OUT, 1);
  g.strokePoints(gable, true, true);

  // A capped ridge, and a warm bounce along it. The ridge is the top edge of
  // the silhouette, so it is where the light has to land.
  g.lineStyle(5, OUT, 1);
  g.beginPath();
  g.moveTo(R0.x, R0.y);
  g.lineTo(R1.x, R1.y);
  g.strokePath();
  g.lineStyle(2.8, shade(colDark, -0.15), 1);
  g.beginPath();
  g.moveTo(R0.x, R0.y);
  g.lineTo(R1.x, R1.y);
  g.strokePath();
  rimLine(g, R0.x, R0.y + 1, R1.x, R1.y + 1, 2, 0.45);
  return { R0, R1 };
}

/**
 * A mono-pitch (lean-to) roof over a rectangle: high along the v0 edge, falling
 * towards the camera to v1.
 *
 * One plane and two triangular ends, and that is the whole point of it — a shed
 * roof has no ridge, so its silhouette is a wedge rather than a tent, and a
 * building wearing one cannot be mistaken for a building wearing a gable even
 * when both are the same size in the same place.
 */
function shedRoof(g, cx, cy, u0, v0, u1, v1, hi, lo, col, colDark, over = 0.14) {
  const a0 = u0 - over;
  const a1 = u1 + over;
  const b0 = v0 - over;
  const b1 = v1 + over;
  const P = (u, v) => gpt(cx, cy, u, v);
  const HW = { ...P(a0, b0) };
  const HE = { ...P(a1, b0) };
  const LW = { ...P(a0, b1) };
  const LE = { ...P(a1, b1) };
  HW.y -= hi; HE.y -= hi; LW.y -= lo; LE.y -= lo;
  const plane = [LW, LE, HE, HW];

  g.fillStyle(shade(colDark, -0.3), 1);
  g.fillPoints([LW, LE, { x: LE.x, y: LE.y + 3.5 }, { x: LW.x, y: LW.y + 3.5 }], true, true);
  g.fillStyle(mix(col, SKY, 0.08), 1);
  g.fillPoints(plane, true, true);
  const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  for (let k = 0; k < 3; k++) {
    g.fillStyle(0x1a1a24, 0.06 * (1 - k / 3));
    g.fillPoints([
      lerp(LW, HW, k / 3), lerp(LE, HE, k / 3),
      lerp(LE, HE, (k + 1) / 3), lerp(LW, HW, (k + 1) / 3),
    ], true, true);
  }
  g.lineStyle(1.1, shade(col, -0.4), 0.4);
  for (let i = 1; i <= 3; i++) {
    const p = lerp(LW, HW, i / 4);
    const q = lerp(LE, HE, i / 4);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(q.x, q.y);
    g.strokePath();
  }
  // The sunward end of the wedge, which is the piece that gives it thickness.
  g.fillStyle(dim(colDark), 1);
  g.fillPoints([LE, HE, { x: HE.x, y: HE.y + 4 }, { x: LE.x, y: LE.y + 4 }], true, true);
  outline(g, false, 2.2);
  g.strokePoints(plane, true, true);
  rimLine(g, HW.x, HW.y + 1, HE.x, HE.y + 1, 2, 0.4);
  return { HW, HE, LW, LE };
}

/**
 * Hip roof as a pyramid; the two south faces are all the camera can see.
 * `fasciaCol` hangs a band of team colour under the eaves — that is how the
 * Town Center keeps loud ownership while wearing a non-team roof.
 */
function isoRoof(g, cx, cy, hw, hh, h, col, colDark, fasciaCol, fasciaDark, fasciaH) {
  const W = { x: cx - hw, y: cy };
  const S = { x: cx, y: cy + hh };
  const E = { x: cx + hw, y: cy };
  const apex = { x: cx, y: cy - hh - h };

  if (fasciaCol !== undefined && fasciaCol !== null) {
    const fh = fasciaH || 6;
    const band = [
      W, S, E,
      { x: E.x, y: E.y + fh },
      { x: S.x, y: S.y + fh },
      { x: W.x, y: W.y + fh },
    ];
    g.fillStyle(fasciaDark || shade(fasciaCol, -0.2), 1);
    g.fillPoints(band, true, true);
    g.fillStyle(fasciaCol, 1);
    g.fillPoints([
      W, S, E,
      { x: E.x, y: E.y + fh * 0.6 },
      { x: S.x, y: S.y + fh * 0.6 },
      { x: W.x, y: W.y + fh * 0.6 },
    ], true, true);
    g.lineStyle(2, OUT, 1);
    g.strokePoints(band, true, true);
  }

  // eaves
  const eave = [
    { x: cx, y: cy - hh },
    E,
    S,
    W,
  ];
  g.fillStyle(shade(colDark, -0.25), 1);
  g.fillPoints(eave.map((p) => ({ x: p.x, y: p.y + 3 })), true, true);

  const left = [W, S, apex];
  const right = [S, E, apex];
  g.fillStyle(dim(col), 1);
  g.fillPoints(left, true, true);
  g.fillStyle(lit(col), 1);
  g.fillPoints(right, true, true);
  // The hip between the two slopes catches the light along its whole length —
  // it is the one edge on a pyramid roof that faces the sun square on, and one
  // warm line down it does more for the read than any amount of shingle detail.
  outline(g, false, 2.4);
  g.strokePoints(left, true, true);
  outline(g, true, 2.4);
  g.strokePoints(right, true, true);
  outline(g, false, 2.4);
  g.beginPath();
  g.moveTo(W.x, W.y);
  g.lineTo(S.x, S.y);
  g.lineTo(E.x, E.y);
  g.strokePath();
  rimLine(g, S.x, S.y - 1, apex.x, apex.y + 1, 2, 0.45);
  rimLine(g, E.x - 1, E.y, apex.x, apex.y + 1, 1.6, 0.3);

  // shingle lines, faint
  g.lineStyle(1.1, shade(col, -0.4), 0.4);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    g.beginPath();
    g.moveTo(W.x + (apex.x - W.x) * t, W.y + (apex.y - W.y) * t);
    g.lineTo(S.x + (apex.x - S.x) * t, S.y + (apex.y - S.y) * t);
    g.lineTo(E.x + (apex.x - E.x) * t, E.y + (apex.y - E.y) * t);
    g.strokePath();
  }
}

function crenellations(g, cx, cy, hw, hh, col, colDark) {
  for (let i = 0; i < 4; i++) {
    const t = 0.18 + i * 0.22;
    const lx = cx - hw + hw * t;
    const ly = cy + hh * t;
    const rx = cx + hw - hw * t;
    const ry = cy + hh * t;
    g.fillStyle(shade(PLASTER, -0.05), 1);
    g.fillRect(lx - 3, ly - 9, 6, 9);
    g.fillRect(rx - 3, ry - 9, 6, 9);
    g.lineStyle(1.6, OUT, 1);
    g.strokeRect(lx - 3, ly - 9, 6, 9);
    g.strokeRect(rx - 3, ry - 9, 6, 9);
  }
}

/** Team banner on a pole — the loudest possible ownership cue. */
function banner(g, x, y, col, colDark, h) {
  g.lineStyle(3.4, OUT, 1);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x, y - h);
  g.strokePath();
  g.lineStyle(1.7, 0x6a5334, 1);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x, y - h);
  g.strokePath();
  const flag = [
    { x: x, y: y - h },
    { x: x + 15, y: y - h + 4 },
    { x: x + 11, y: y - h + 9 },
    { x: x + 15, y: y - h + 14 },
    { x: x, y: y - h + 13 },
  ];
  g.fillStyle(col, 1);
  g.fillPoints(flag, true, true);
  g.lineStyle(1.8, OUT, 1);
  g.strokePoints(flag, true, true);
  g.fillStyle(shade(col, 0.35), 0.7);
  g.fillRect(x + 1, y - h + 2, 5, 3);
}

// ---------------------------------------------------------------------------
// Walls, gates, and the two stone buildings that shoot
// ---------------------------------------------------------------------------
//
// WHY SIXTEEN FRAMES. A wall only reads as a wall if its segments join. Drawing
// each one as an independent block gives a dotted line of huts, which is the
// single most obvious way this feature could fail, so the connection is baked
// into the art: a segment's frame is chosen by which of its four axis
// neighbours are also walls (core/world.js owns the mask), and each of the
// sixteen cases is drawn — post alone, four stubs, two straight runs, four
// corners, four tees, one cross.
//
// The pieces are assembled from one primitive: an isometric prism running from
// the tile centre out to the middle of one tile edge. A segment is a stack of
// those, one per connected direction, plus a post at the junction. Because every
// limb ends exactly on the shared edge between two tiles, the limb of one
// segment meets the limb of its neighbour with no gap and no overlap — at any
// zoom, on any of the sixteen cases, without a single hand-placed pixel.

/**
 * Half-edge vectors: tile centre to the middle of each of the four tile edges,
 * in screen pixels. Index order matches the wall mask in core/world.js
 * (0 = north/-y, 1 = east/+x, 2 = south/+y, 3 = west/-x); the two must not
 * drift apart or a wall will grow limbs in the wrong directions.
 */
const WALL_DIR = [
  { x: HALF_W / 2, y: -HALF_H / 2 },
  { x: HALF_W / 2, y: HALF_H / 2 },
  { x: -HALF_W / 2, y: HALF_H / 2 },
  { x: -HALF_W / 2, y: -HALF_H / 2 },
];

// Wall texture boxes. `ay` is the pixel the tile centre sits on; it has to leave
// room above for the tallest thing drawn (a gate tower and its finial), or the
// health bar the renderer hangs off the sprite's top edge floats in the sky.
//
// These were 80x76 and 80x92 and both were far too generous — a wall segment
// reaches half a tile in each grid direction, which is 16 screen pixels each
// way, so the widest case (the cross) is under fifty pixels across and the
// remaining thirty were empty. Sixty-four wall frames and sixteen gate frames
// paid for that emptiness twice over, once per team: measured against the packed
// sheet the two boxes were throwing away 204k pixels, which is five per cent of
// the whole atlas and about four 3x3 buildings' worth of art. They are cut to
// the measured content plus a four-pixel margin for the rim light and the
// contact shadow, and the margin is deliberately named here so the next person
// to add a finial knows how much room they have before something clips.
// Two boxes, not one. A stone wall is taller and thicker than a palisade and
// fills nearly every pixel of the shared 52x65 box; a palisade rattles around
// inside it with three empty columns each side and six empty scanlines on top.
// At sixteen masks per type per player that emptiness was 17k of atlas — most
// of a tree set — bought for nothing. Origins carry the anchor, so a per-type
// box costs the renderer nothing at all.
const WALL_TEX = { w: 52, h: 65, ax: 26, ay: 51 };
const WALL_TEX_PALISADE = { w: 48, h: 59, ax: 24, ay: 46 };
const GATE_TEX = { w: 74, h: 81, ax: 34, ay: 63 };

const PAL_WOOD = { left: 0x7c5326, right: 0x9a6b38, top: 0xb2854c };
const PAL_STONE = { left: 0x7c766a, right: 0x9c9689, top: 0xbcb6a6 };

/**
 * An isometric prism: a parallelogram base swept up by `H`.
 *
 * The four side faces are painted back-to-front by the screen y of their base
 * edge, then the top. That is a painter's sort over a convex box, which is
 * exact — no face can partly occlude another — and it costs a four-element sort
 * that runs once at bake time and never again.
 */
function prism(g, cx, cy, vx, vy, px, py, H, pal, ow = 1.6) {
  const base = [
    { x: cx + px, y: cy + py },
    { x: cx + vx + px, y: cy + vy + py },
    { x: cx + vx - px, y: cy + vy - py },
    { x: cx - px, y: cy - py },
  ];
  const top = base.map((b) => ({ x: b.x, y: b.y - H }));
  const faces = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    faces.push({
      my: (base[i].y + base[j].y) / 2,
      mx: (base[i].x + base[j].x) / 2,
      quad: [base[i], base[j], top[j], top[i]],
    });
  }
  faces.sort((a, b) => a.my - b.my);
  for (const f of faces) {
    // Which way this face is turned decides its value, its outline and whether
    // it gets a warm bounce down its sunward edge — see THE LIGHT at the top of
    // the file. Sixty-four wall frames and sixteen gate frames come through
    // here, so this one branch is most of the lighting on a walled base.
    const sunward = f.mx >= cx + vx / 2;
    g.fillStyle(sunward ? lit(pal.right) : dim(pal.left), 1);
    g.fillPoints(f.quad, true, true);
    // Darker at the footing, in three bands. Masonry is never one flat value
    // from the ground to the parapet, and a wall that is reads as cardboard.
    for (let k = 0; k < 3; k++) {
      const t0 = (k / 3) * H;
      const t1 = ((k + 1) / 3) * H;
      g.fillStyle(0x171a22, 0.075 * (1 - k / 3));
      g.fillPoints([
        { x: f.quad[0].x, y: f.quad[0].y - t0 }, { x: f.quad[1].x, y: f.quad[1].y - t0 },
        { x: f.quad[1].x, y: f.quad[1].y - t1 }, { x: f.quad[0].x, y: f.quad[0].y - t1 },
      ], true, true);
    }
    outline(g, sunward, ow);
    g.strokePoints(f.quad, true, true);
    if (sunward) {
      rimLine(g, f.quad[3].x, f.quad[3].y + 1, f.quad[2].x, f.quad[2].y + 1, 1.4, 0.34);
    }
  }
  // The top plane looks straight up at the sky, so it is the coolest and the
  // brightest thing on the prism.
  g.fillStyle(mix(pal.top, SKY, 0.12), 1);
  g.fillPoints(top, true, true);
  outline(g, false, ow + 0.2);
  g.strokePoints(top, true, true);
  return { base, top };
}

/** A prism centred on a point, given its two in-plane half-extents. */
function box(g, x, y, a, b, H, pal, outline) {
  return prism(g, x - a.x, y - a.y, a.x * 2, a.y * 2, b.x, b.y, H, pal, outline);
}

/** The base edge of a limb that faces the camera, for surface detail. */
function nearEdge(cx, cy, vx, vy, px, py) {
  const s = py >= 0 ? 1 : -1;
  return [
    { x: cx + px * s, y: cy + py * s },
    { x: cx + vx + px * s, y: cy + vy + py * s },
  ];
}

const WALL_SPEC = {
  palisade: {
    pal: PAL_WOOD, height: 22, postH: 28, thick: 0.30, post: 0.48,
    // Sharpened stakes: the palisade's silhouette is what tells it apart from a
    // stone wall at the zoom a phone actually plays at, long before the colour
    // does.
    stakes: true,
  },
  stonewall: {
    pal: PAL_STONE, height: 27, postH: 33, thick: 0.42, post: 0.60,
    courses: true,
  },
};

function drawWallSegment(g, cx, cy, mask, spec, col, colDark) {
  const t = spec.thick;
  // Limbs first, post second: the post then sits proud of the joins, which is
  // what makes a corner read as a corner and not as two planks crossing.
  for (let d = 0; d < 4; d++) {
    if (!(mask & (1 << d))) continue;
    const v = WALL_DIR[d];
    const per = WALL_DIR[(d + 1) % 4];
    const px = per.x * t;
    const py = per.y * t;
    prism(g, cx, cy, v.x, v.y, px, py, spec.height, spec.pal);
    const [e0, e1] = nearEdge(cx, cy, v.x, v.y, px, py);
    if (spec.courses) {
      // Two mortar courses along the face.
      g.lineStyle(1.1, shade(spec.pal.left, -0.3), 0.55);
      for (const f of [0.34, 0.68]) {
        g.beginPath();
        g.moveTo(e0.x, e0.y - spec.height * f);
        g.lineTo(e1.x, e1.y - spec.height * f);
        g.strokePath();
      }
    } else {
      // Log seams.
      g.lineStyle(1.1, shade(spec.pal.left, -0.32), 0.7);
      for (let k = 1; k <= 3; k++) {
        const u = k / 4;
        const x = e0.x + (e1.x - e0.x) * u;
        const y = e0.y + (e1.y - e0.y) * u;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x, y - spec.height);
        g.strokePath();
      }
    }
  }

  // The post, with a band of team colour under its cap. The band is the same
  // idea as the Town Center's eave fascia and it exists for the same reason: a
  // wall has no roof to colour, and a contested border where you cannot tell
  // whose wall is whose is unreadable. It is a band rather than a flag on every
  // segment because a flag on every segment is a picket fence — a thirty-tile
  // run drew thirty pennants and the eye could not find the ends.
  const a = { x: WALL_DIR[1].x * spec.post, y: WALL_DIR[1].y * spec.post };
  const b = { x: WALL_DIR[2].x * spec.post * 0.5, y: WALL_DIR[2].y * spec.post * 0.5 };
  const bandH = 5;
  box(g, cx, cy, a, b, spec.postH - bandH, spec.pal);
  box(g, cx, cy - (spec.postH - bandH), a, b, bandH,
    { left: colDark, right: col, top: shade(col, 0.28) });

  const topY = cy - spec.postH;
  if (spec.stakes) {
    // Three points along the post cap.
    g.fillStyle(shade(spec.pal.top, 0.18), 1);
    for (const dx of [-6, 0, 6]) {
      g.fillTriangle(cx + dx - 3, topY + 1, cx + dx + 3, topY + 1, cx + dx, topY - 6);
      g.lineStyle(1.3, OUT, 1);
      g.strokeTriangle(cx + dx - 3, topY + 1, cx + dx + 3, topY + 1, cx + dx, topY - 6);
    }
  } else {
    // Crenellations.
    g.fillStyle(shade(spec.pal.top, 0.1), 1);
    for (const dx of [-7, 0, 7]) {
      g.fillRect(cx + dx - 2.6, topY - 5, 5.2, 6);
      g.lineStyle(1.3, OUT, 1);
      g.strokeRect(cx + dx - 2.6, topY - 5, 5.2, 6);
    }
  }

  // A pennant marks the places worth marking: the ends of a run, a lone post,
  // and the tees and crosses where two walls meet. Exactly two neighbours means
  // "middle of a run or a plain corner", which is most of a wall and gets none.
  const neighbours = ((mask >> 0) & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
  if (neighbours !== 2) {
    g.lineStyle(2.2, OUT, 1);
    g.beginPath();
    g.moveTo(cx + 9, topY - 4);
    g.lineTo(cx + 9, topY - 16);
    g.strokePath();
    g.fillStyle(col, 1);
    g.fillTriangle(cx + 9, topY - 16, cx + 18, topY - 13, cx + 9, topY - 9);
    g.lineStyle(1.2, OUT, 1);
    g.strokeTriangle(cx + 9, topY - 16, cx + 18, topY - 13, cx + 9, topY - 9);
  }
}

/**
 * A gate: two towers straddling the wall line with a doorway between them.
 *
 * `axis` is the direction the *wall* runs (0 = along +x, 1 = along +y), so the
 * towers stand at the two tile edges the wall continues through and the opening
 * faces the other way — which is the way a unit crosses. Open swings the leaves
 * back against the towers; shut brings them together across the gap. That
 * boolean is the same one the block grid reads, so what the player sees is
 * literally whether the tile is passable.
 */
function drawGate(g, cx, cy, axis, open, spec, col, colDark) {
  const along = axis === 0 ? [1, 3] : [0, 2];
  const across = axis === 0 ? [0, 2] : [1, 3];
  const towerH = spec.postH + 12;
  const A = WALL_DIR[along[0]];
  const B = WALL_DIR[across[0]];
  const half = { x: A.x * 0.34, y: A.y * 0.34 };
  const wide = { x: B.x * 0.5, y: B.y * 0.5 };

  // The doorway, drawn first so the towers overlap its ends.
  //
  // Open and shut have to be told apart at a glance from across a base, so the
  // difference is a whole shape and not a tint: shut is a slab of oak filling
  // the arch to above wall height, open is an empty threshold with the two
  // leaves folded flat against the towers and a shadow on the ground where the
  // slab was. A player glancing at their wall must be able to see which of
  // their gates is standing open.
  const gap = spec.height + 8;
  const p0 = { x: cx + WALL_DIR[along[0]].x * 0.66, y: cy + WALL_DIR[along[0]].y * 0.66 };
  const p1 = { x: cx + WALL_DIR[along[1]].x * 0.66, y: cy + WALL_DIR[along[1]].y * 0.66 };
  const across0 = { x: WALL_DIR[across[0]].x * 0.16, y: WALL_DIR[across[0]].y * 0.16 };

  if (open) {
    // The threshold: a dark strip of packed earth between the towers, so the
    // gap reads as ground you can walk on rather than as a missing sprite.
    g.fillStyle(0x2a2118, 0.55);
    g.fillPoints([
      { x: p0.x + across0.x, y: p0.y + across0.y },
      { x: p1.x + across0.x, y: p1.y + across0.y },
      { x: p1.x - across0.x, y: p1.y - across0.y },
      { x: p0.x - across0.x, y: p0.y - across0.y },
    ], true, true);
    // Leaves folded back against the towers.
    for (const p of [p0, p1]) {
      const q = { x: cx + (p.x - cx) * 0.55, y: cy + (p.y - cy) * 0.55 };
      const leaf = [
        { x: p.x, y: p.y }, { x: q.x, y: q.y },
        { x: q.x, y: q.y - gap * 0.8 }, { x: p.x, y: p.y - gap * 0.8 },
      ];
      g.fillStyle(WOOD_D, 1);
      g.fillPoints(leaf, true, true);
      g.lineStyle(1.6, OUT, 1);
      g.strokePoints(leaf, true, true);
    }
  } else {
    // A slab with thickness: the front face, a lit top edge, and iron banding.
    const door = [
      { x: p0.x, y: p0.y }, { x: p1.x, y: p1.y },
      { x: p1.x, y: p1.y - gap }, { x: p0.x, y: p0.y - gap },
    ];
    g.fillStyle(WOOD, 1);
    g.fillPoints(door, true, true);
    g.fillStyle(shade(WOOD, 0.22), 1);
    g.fillPoints([
      { x: p0.x, y: p0.y - gap }, { x: p1.x, y: p1.y - gap },
      { x: p1.x, y: p1.y - gap + 4 }, { x: p0.x, y: p0.y - gap + 4 },
    ], true, true);
    g.lineStyle(2.2, OUT, 1);
    g.strokePoints(door, true, true);
    // Plank seams down the leaf, then two iron straps across it.
    g.lineStyle(1.1, WOOD_D, 0.85);
    for (const f of [0.25, 0.5, 0.75]) {
      const x = p0.x + (p1.x - p0.x) * f;
      const y = p0.y + (p1.y - p0.y) * f;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y - gap);
      g.strokePath();
    }
    g.lineStyle(2.4, STEEL_D, 0.95);
    for (const f of [0.28, 0.68]) {
      g.beginPath();
      g.moveTo(p0.x, p0.y - gap * f);
      g.lineTo(p1.x, p1.y - gap * f);
      g.strokePath();
    }
    g.fillStyle(0xdcc36a, 1);
    g.fillCircle((p0.x + p1.x) / 2, (p0.y + p1.y) / 2 - gap * 0.48, 2.4);
    g.lineStyle(1, OUT, 1);
    g.strokeCircle((p0.x + p1.x) / 2, (p0.y + p1.y) / 2 - gap * 0.48, 2.4);
  }

  // Towers, far one first.
  const posts = [
    { x: cx + WALL_DIR[along[0]].x, y: cy + WALL_DIR[along[0]].y },
    { x: cx + WALL_DIR[along[1]].x, y: cy + WALL_DIR[along[1]].y },
  ].sort((a, b) => a.y - b.y);
  for (const p of posts) {
    box(g, p.x, p.y, half, wide, towerH, spec.pal);
    const ty = p.y - towerH;
    g.fillStyle(shade(spec.pal.top, 0.1), 1);
    g.fillRect(p.x - 8, ty - 5, 16, 6);
    g.lineStyle(1.4, OUT, 1);
    g.strokeRect(p.x - 8, ty - 5, 16, 6);
  }
  // Banner on the nearer tower.
  const near = posts[posts.length - 1];
  banner(g, near.x + 6, near.y - towerH + 4, col, colDark, 18);
}

function buildWalls(put) {
  for (let p = 0; p < PLAYER_COLORS.length; p++) {
    const col = PLAYER_COLORS[p];
    const dark = PLAYER_COLORS_DARK[p];
    for (const type of Object.keys(WALL_SPEC)) {
      const spec = WALL_SPEC[type];
      const T = type === 'palisade' ? WALL_TEX_PALISADE : WALL_TEX;
      for (let mask = 0; mask < 16; mask++) {
        put(wallFrame(type, p, mask), T.w, T.h, T.ax, T.ay,
          (g) => drawWallSegment(g, T.ax, T.ay, mask, spec, col, dark));
      }
    }
    // Each gate borrows the wall family it belongs to, so a stone gate in a
    // stone wall is the same masonry with a door in it.
    for (const [gateType, wallType] of [['palisadegate', 'palisade'], ['stonegate', 'stonewall']]) {
      const spec = WALL_SPEC[wallType];
      for (let axis = 0; axis < 2; axis++) {
        for (const open of [false, true]) {
          put(gateFrame(gateType, p, axis, open), GATE_TEX.w, GATE_TEX.h,
            GATE_TEX.ax, GATE_TEX.ay,
            (g) => drawGate(g, GATE_TEX.ax, GATE_TEX.ay, axis, open, spec, col, dark));
        }
      }
    }
  }
}

/**
 * The Watch Tower: one tile of footprint and a great deal of height.
 *
 * Everything about it is vertical, because that is the only axis a 1x1 building
 * has to work with. A battered stone base, a shaft with arrow slits, a
 * corbelled parapet that overhangs it, and a shingled cap — read from bottom to
 * top, that outline is unlike anything else on the map even when only the top
 * third of it is showing over a treeline.
 */
function drawWatchTower(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, false);

  const baseA = { x: WALL_DIR[1].x * 0.82, y: WALL_DIR[1].y * 0.82 };
  const baseB = { x: WALL_DIR[2].x * 0.82, y: WALL_DIR[2].y * 0.82 };
  const shaftH = 46;
  box(g, cx, cy, baseA, baseB, 10, PAL_STONE, 2);
  const midA = { x: baseA.x * 0.82, y: baseA.y * 0.82 };
  const midB = { x: baseB.x * 0.82, y: baseB.y * 0.82 };
  box(g, cx, cy - 10, midA, midB, shaftH, PAL_STONE, 2);

  const topY = cy - 10 - shaftH;
  // Arrow slits.
  g.fillStyle(OUT, 0.9);
  g.fillRect(cx - 8, topY + 12, 3, 10);
  g.fillRect(cx + 5, topY + 12, 3, 10);

  // Overhanging parapet, wider than the shaft.
  const capA = { x: baseA.x * 1.06, y: baseA.y * 1.06 };
  const capB = { x: baseB.x * 1.06, y: baseB.y * 1.06 };
  box(g, cx, topY, capA, capB, 12, PAL_STONE, 2);
  const parY = topY - 12;
  g.fillStyle(shade(PAL_STONE.top, 0.1), 1);
  for (const dx of [-13, -4, 5, 14]) {
    g.fillRect(cx + dx - 3, parY - 6, 6, 7);
    g.lineStyle(1.4, OUT, 1);
    g.strokeRect(cx + dx - 3, parY - 6, 6, 7);
  }
  // Shingled cap and a lookout's pennant.
  isoRoof(g, cx, parY - 5, 17, 9, 16, col, colDark);
  banner(g, cx + 13, cy + 2, col, colDark, 22);
}

/**
 * The Castle: 4x4, and it has to look like 250 stone.
 *
 * Four corner towers, a curtain wall between them and a keep standing above the
 * lot. The corner towers are what carry it — they give the silhouette four
 * vertical spikes that nothing else in the game has, so a Castle is recognisable
 * from the minimap-sized end of the zoom range and through a gap in a forest.
 */
function drawCastle(g, s, cx, cy, col, colDark) {
  const hw = (s.fw + s.fh) * (HALF_W / 2);
  const hh = (s.fw + s.fh) * (HALF_H / 2);
  platform(g, cx, cy, hw, hh, true);

  const iw = hw * 0.86;
  const ih = hh * 0.86;
  const wallH = 44;
  isoBox(g, cx, cy, iw, ih, wallH, STONE, STONE_D, shade(STONE, 0.18));
  // Courses across the curtain, so 44 pixels of flat grey reads as masonry.
  g.lineStyle(1.2, STONE_D, 0.5);
  for (let k = 1; k <= 4; k++) {
    const y = cy - (wallH * k) / 5;
    g.beginPath();
    g.moveTo(cx - iw, y);
    g.lineTo(cx, y + ih);
    g.lineTo(cx + iw, y);
    g.strokePath();
  }
  const topY = cy - wallH;
  crenellations(g, cx, topY, iw, ih, col, colDark);

  // Gatehouse on the south face.
  const doorTop = cy + ih - wallH + 10;
  g.fillStyle(WOOD_D, 1);
  g.fillRoundedRect(cx - 12, doorTop, 24, wallH - 14, 3);
  g.lineStyle(2.4, OUT, 1);
  g.strokeRoundedRect(cx - 12, doorTop, 24, wallH - 14, 3);
  g.lineStyle(1.8, STEEL_D, 0.85);
  for (let k = 1; k <= 3; k++) {
    g.beginPath();
    g.moveTo(cx - 12, doorTop + (wallH - 14) * (k / 4));
    g.lineTo(cx + 12, doorTop + (wallH - 14) * (k / 4));
    g.strokePath();
  }

  // Four corner towers, painted back to front.
  const towerH = 74;
  const corners = [
    { x: cx, y: cy - hh * 0.92 },
    { x: cx - hw * 0.92, y: cy },
    { x: cx + hw * 0.92, y: cy },
    { x: cx, y: cy + hh * 0.92 },
  ].sort((a, b) => a.y - b.y);
  const tA = { x: WALL_DIR[1].x * 0.9, y: WALL_DIR[1].y * 0.9 };
  const tB = { x: WALL_DIR[2].x * 0.9, y: WALL_DIR[2].y * 0.9 };
  for (const c of corners) {
    box(g, c.x, c.y, tA, tB, towerH, PAL_STONE, 2.2);
    const ty = c.y - towerH;
    g.fillStyle(OUT, 0.85);
    g.fillRect(c.x - 2, ty + 16, 3.4, 11);
    for (const dx of [-11, -2, 7]) {
      g.fillStyle(shade(PAL_STONE.top, 0.12), 1);
      g.fillRect(c.x + dx, ty - 6, 6, 7);
      g.lineStyle(1.4, OUT, 1);
      g.strokeRect(c.x + dx, ty - 6, 6, 7);
    }
    isoRoof(g, c.x, ty - 6, 15, 8, 15, col, colDark);
  }

  // The keep, standing above the curtain, with the standard on top of it.
  const kw = iw * 0.4;
  const kh = ih * 0.4;
  const keepH = 40;
  isoBox(g, cx, topY - 2, kw, kh, keepH, STONE, STONE_D, shade(STONE, 0.2));
  const kTop = topY - 2 - keepH;
  g.fillStyle(OUT, 0.85);
  g.fillRect(cx - 10, kTop + 12, 3.4, 12);
  g.fillRect(cx + 7, kTop + 12, 3.4, 12);
  isoRoof(g, cx, kTop, kw * 1.3, kh * 1.3, 24, TILE_ROOF, TILE_ROOF_D, col, colDark, 6);
  mast(g, cx, kTop - kh * 1.3 - 18, col, colDark, 44);

  banner(g, cx - hw * 0.5, cy + hh * 0.42, col, colDark, 30);
  banner(g, cx + hw * 0.5, cy + hh * 0.42, col, colDark, 30);
}

// --- foundations ------------------------------------------------------------

function buildFoundations(put) {
  for (let p = 0; p < PLAYER_COLORS.length; p++) {
    // 1 for a wall segment, 4 for the Castle. Before these existed the renderer
    // clamped every footprint into the 2-wide frame, which drew a wall under
    // construction as a site four times its own size and a Castle site as
    // something smaller than a Barracks.
    for (const fw of [1, 2, 3, 4]) {
      const hw = fw * HALF_W;
      const hh = fw * HALF_H;
      const w = hw * 2 + 12;
      const h = hh * 2 + 22;
      const ax = w / 2;
      const ay = h - 6 - hh;
      put(foundationFrame(fw, p), w, h, ax, ay, (g) =>
        drawFoundation(g, ax, ay, hw, hh, PLAYER_COLORS[p], PLAYER_COLORS_DARK[p]));
    }
    // A farm under construction is ground being broken, not a timber frame.
    const hw = 2 * HALF_W;
    const hh = 2 * HALF_H;
    const w = hw * 2 + 12;
    const h = hh * 2 + 30;
    put(farmFoundationFrame(p), w, h, w / 2, h - 6 - hh, (g) =>
      drawFarmFoundation(g, w / 2, h - 6 - hh, hw, hh, PLAYER_COLORS[p]));
  }
}

/** Ploughed but unsown: furrow trenches, marker stakes, a barrow of seed. */
function drawFarmFoundation(g, cx, cy, hw, hh, col) {
  const pts = [
    { x: cx, y: cy - hh },
    { x: cx + hw, y: cy },
    { x: cx, y: cy + hh },
    { x: cx - hw, y: cy },
  ];
  g.fillStyle(0x4b3519, 1);
  g.fillPoints(pts.map((p) => ({ x: p.x, y: p.y + 3 })), true, true);
  g.fillStyle(0x63482a, 1);
  g.fillPoints(pts, true, true);
  g.lineStyle(2.5, OUT, 0.9);
  g.strokePoints(pts, true, true);

  for (let i = 1; i <= 7; i++) {
    const t = i / 8;
    g.lineStyle(5.5, 0x4a3419, 0.95);
    g.beginPath();
    g.moveTo(cx - hw + hw * t, cy + hh * t);
    g.lineTo(cx + hw * t, cy - hh + hh * t);
    g.strokePath();
    g.lineStyle(1.6, 0x7a5b34, 0.8);
    g.beginPath();
    g.moveTo(cx - hw + hw * t + 2, cy + hh * t - 3);
    g.lineTo(cx + hw * t - 2, cy - hh + hh * t - 3);
    g.strokePath();
  }

  for (const p of pts) {
    g.lineStyle(3.2, OUT, 1);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x, p.y - 13);
    g.strokePath();
    g.lineStyle(1.6, 0x6a5334, 1);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x, p.y - 13);
    g.strokePath();
    g.fillStyle(col, 1);
    g.fillTriangle(p.x, p.y - 13, p.x + 7, p.y - 10.5, p.x, p.y - 8);
    g.lineStyle(1.3, OUT, 1);
    g.strokeTriangle(p.x, p.y - 13, p.x + 7, p.y - 10.5, p.x, p.y - 8);
  }
  // string line between the stakes
  g.lineStyle(1, 0xe6dcc0, 0.55);
  g.strokePoints(pts.map((p) => ({ x: p.x, y: p.y - 11 })), true, true);
}

function drawFoundation(g, cx, cy, hw, hh, col, colDark) {
  const pts = [
    { x: cx, y: cy - hh },
    { x: cx + hw, y: cy },
    { x: cx, y: cy + hh },
    { x: cx - hw, y: cy },
  ];
  g.fillStyle(0x7a6547, 1);
  g.fillPoints(pts, true, true);
  g.lineStyle(2.5, OUT, 0.85);
  g.strokePoints(pts, true, true);

  // planks laid out along the footprint
  g.lineStyle(3.2, WOOD_D, 0.95);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    g.beginPath();
    g.moveTo(cx - hw + hw * t, cy + hh * t);
    g.lineTo(cx + hw * t, cy - hh + hh * t);
    g.strokePath();
  }
  g.lineStyle(1.4, shade(WOOD, 0.2), 0.6);
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    g.beginPath();
    g.moveTo(cx - hw + hw * t, cy + hh * t - 1);
    g.lineTo(cx + hw * t, cy - hh + hh * t - 1);
    g.strokePath();
  }

  // corner stakes with team pennants
  for (const p of pts) {
    g.lineStyle(3.2, OUT, 1);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x, p.y - 14);
    g.strokePath();
    g.lineStyle(1.6, 0x6a5334, 1);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x, p.y - 14);
    g.strokePath();
    g.fillStyle(col, 1);
    g.fillTriangle(p.x, p.y - 14, p.x + 8, p.y - 11, p.x, p.y - 8);
    g.lineStyle(1.3, OUT, 1);
    g.strokeTriangle(p.x, p.y - 14, p.x + 8, p.y - 11, p.x, p.y - 8);
  }
}

// ---------------------------------------------------------------------------
// Resource nodes
// ---------------------------------------------------------------------------

/**
 * The frame box each tree variant is drawn in.
 *
 * One shared box for all six was the first thing tried and it is what keeps a
 * set of trees looking like one tree: a box big enough for a poplar forces the
 * spreading oak to be drawn small in the middle of it, and a box wide enough
 * for the oak wastes a third of every conifer's frame. Sizing each variant to
 * its own drawing is both cheaper in atlas pixels AND the thing that lets the
 * silhouettes actually differ in proportion — a 38x88 column and a 66x56 dome
 * cannot be mistaken for each other at any zoom, and two 52x66 boxes almost
 * always can.
 *
 * `ft` is the foot: the pixel that sits on the tile the tree occupies.
 */
const TREE_TEX = [
  { w: 54, h: 68, cx: 27, ft: 62 }, // 0 round oak
  { w: 46, h: 86, cx: 23, ft: 80 }, // 1 conifer
  { w: 48, h: 84, cx: 24, ft: 78 }, // 2 birch
  { w: 68, h: 58, cx: 34, ft: 52 }, // 3 spreading oak
  { w: 54, h: 72, cx: 27, ft: 66 }, // 4 dead snag
  { w: 38, h: 88, cx: 19, ft: 82 }, // 5 poplar
];

const RES_TEX = {
  berry: { w: 46, h: 40, cx: 23, ft: 34 },
  gold: { w: 48, h: 42, cx: 24, ft: 36 },
  // Taller and wider than the gold vein on purpose. At 0.7 zoom on a 390px
  // phone the two are four pixels apart in silhouette, so the difference has to
  // be carried by more than colour: a stone mine is a stack of blocky boulders
  // that stands proud of the ground, gold is a low scatter of rubble.
  stone: { w: 50, h: 46, cx: 25, ft: 40 },
};

function buildResources(put, rng) {
  for (let v = 0; v < RESOURCE_VARIANTS.tree; v++) {
    const t = TREE_TEX[v];
    put(resourceFrame('tree', v), t.w, t.h, t.cx, t.ft, (g) => drawTree(g, t, v, rng));
  }
  const b = RES_TEX.berry;
  for (let v = 0; v < RESOURCE_VARIANTS.berry; v++) {
    put(resourceFrame('berry', v), b.w, b.h, b.cx, b.ft, (g) => drawBerry(g, b, v, rng));
  }
  const go = RES_TEX.gold;
  for (let v = 0; v < RESOURCE_VARIANTS.gold; v++) {
    put(resourceFrame('gold', v), go.w, go.h, go.cx, go.ft, (g) => drawGold(g, go, v, rng));
  }
  const st = RES_TEX.stone;
  for (let v = 0; v < RESOURCE_VARIANTS.stone; v++) {
    put(resourceFrame('stone', v), st.w, st.h, st.cx, st.ft, (g) => drawStone(g, st, v, rng));
  }
  // Stump left behind when a tree is chopped out.
  put('r_stump_0', 30, 22, 15, 17, (g) => {
    groundShadow(g, 15, 17, 22, 9);
    g.fillStyle(0x7c5a34, 1);
    g.fillEllipse(15, 9, 18, 8);
    g.fillRect(6, 9, 18, 7);
    g.fillStyle(0x5c4023, 1);
    g.fillEllipse(15, 16, 18, 6);
    g.lineStyle(1.8, OUT, 1);
    g.strokeEllipse(15, 9, 18, 8);
    g.fillStyle(0xa07a4a, 1);
    g.fillEllipse(15, 8.6, 12, 5);
  });
}

/**
 * The shadow a resource node throws. Now the same soft, sun-aware wash every
 * other object in the file uses rather than two hard ellipses — a shadow with a
 * visible edge is a second silhouette, and a tree with one reads as a sticker
 * of a tree on a mat.
 */
function groundShadow(g, x, y, w, h) {
  contactShadow(g, x, y, w, h, 1.25);
}

// ---------------------------------------------------------------------------
// TREES: six species, not six jitters
// ---------------------------------------------------------------------------
//
// There is more tree on the screen of this game than anything else, and until
// now there was one drawing of it — the same three-circle broccoli canopy on
// the same brown post, taken 14% smaller and leant 1.6px left for "variant 1".
// A forest built out of that reads as a repeating tile pattern, which is
// exactly what the review saw: forty trees, two silhouettes.
//
// WHAT MAKES A TREE VARIANT WORK, in the order the eye gets to it:
//
//   1. THE OUTLINE. At 0.7 zoom a tree is about thirty screen pixels of dark
//      green against light green grass, so the outline is 90% of the read. A
//      cone, a dome, a wide low disc, a bare fork and a narrow column are five
//      different outlines; three circles at three sizes are one.
//   2. THE PROPORTION. Tall-and-narrow versus wide-and-low survives being shrunk
//      to a minimap dot. This is why each variant gets its own frame box (see
//      TREE_TEX) rather than sharing one.
//   3. THE HUE. Only third, and only ever a shift — a conifer is blue-green, a
//      birch and a poplar are yellow-green, an oak is warm mid-green. Woods are
//      not monochrome and a mixed stand of three greens looks like a wood
//      rather than like a colour ramp.
//
// One rule holds across all six, because it is what makes them a set rather
// than five unrelated objects: the same dark keyline, the same sun from the
// upper right, the same soft contact shadow, and canopy mass built as a filled
// silhouette first with a lit lobe pushed up-right into it. That shared grammar
// is what lets a birch stand next to a pine without either looking imported.

/**
 * A canopy blob group: silhouette, body, lit lobe, and one specular.
 *
 * Broken out because all four leafy variants want it and because doing the
 * shading in one place is what keeps six trees looking like the same world.
 * `blobs` is a list of {x, y, r}; `base` is the species' own green.
 */
function canopy(g, blobs, base, specAt) {
  g.fillStyle(OUT, 1);
  for (const b of blobs) g.fillCircle(b.x, b.y, b.r + 1.8);
  g.fillStyle(shade(base, -0.22), 1);
  for (const b of blobs) g.fillCircle(b.x, b.y, b.r);
  g.fillStyle(base, 1);
  for (const b of blobs) g.fillCircle(b.x + b.r * 0.16, b.y - b.r * 0.2, b.r * 0.74);
  g.fillStyle(shade(base, 0.16), 0.85);
  for (const b of blobs) g.fillCircle(b.x + b.r * 0.3, b.y - b.r * 0.36, b.r * 0.38);
  if (specAt) {
    g.fillStyle(mix(shade(base, 0.4), RIM, 0.35), 0.7);
    g.fillCircle(specAt.x, specAt.y, specAt.r);
  }
}

/** A tapering trunk from (x, base) up to (x + lean, base - h), with bark. */
function trunk(g, x, base, h, wBot, wTop, lean, col) {
  const pts = [
    { x: x - wBot / 2, y: base },
    { x: x + lean - wTop / 2, y: base - h },
    { x: x + lean + wTop / 2, y: base - h },
    { x: x + wBot / 2, y: base },
  ];
  g.fillStyle(OUT, 1);
  g.fillPoints(pts.map((p, i) => ({
    x: p.x + (i === 0 || i === 1 ? -1.6 : 1.6), y: p.y,
  })), true, true);
  g.fillStyle(shade(col, -0.28), 1);
  g.fillPoints(pts, true, true);
  g.fillStyle(col, 1);
  g.fillPoints([
    { x: x + wBot * 0.05, y: base },
    { x: x + lean + wTop * 0.05, y: base - h },
    pts[2], pts[3],
  ], true, true);
  rimLine(g, x + wBot / 2 - 0.8, base - 2, x + lean + wTop / 2 - 0.8, base - h + 2, 1.3, 0.3);
}

/** One limb of a bare tree: a tapering stroke that forks at the end. */
function bough(g, x, y, ang, len, w, col, depth) {
  const ex = x + Math.cos(ang) * len;
  const ey = y + Math.sin(ang) * len;
  g.lineStyle(w + 2, OUT, 1);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(ex, ey);
  g.strokePath();
  g.lineStyle(w, col, 1);
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(ex, ey);
  g.strokePath();
  if (depth > 0) {
    bough(g, ex, ey, ang - 0.5 - depth * 0.1, len * 0.62, w * 0.6, col, depth - 1);
    bough(g, ex, ey, ang + 0.45 + depth * 0.08, len * 0.58, w * 0.6, col, depth - 1);
  }
}

function drawTree(g, t, v, rng) {
  const { cx, ft } = t;

  // --- 0. the round oak: the tree this file already had, tightened up --------
  //
  // Kept in slot 0 deliberately. It is the commonest tree on the map and the
  // one every screenshot of this game has in it, so it is the one variant that
  // should not change out from under a player. What it does gain is a canopy
  // built from five blobs instead of three, with two of them small and pushed
  // out to break the perfect dome — the old outline was a circle with two
  // bumps, and a circle is the single most repetitive silhouette available.
  if (v === 0) {
    groundShadow(g, cx, ft - 1, 27, 10);
    trunk(g, cx, ft, 24, 8, 6, 0.5, 0x6f4c2a);
    canopy(g, [
      { x: cx - 10, y: ft - 30, r: 11.5 },
      { x: cx + 10, y: ft - 31, r: 11 },
      { x: cx + 1, y: ft - 40, r: 13.5 },
      { x: cx - 13, y: ft - 40, r: 7 },
      { x: cx + 12, y: ft - 42, r: 6.5 },
    ], 0x3f7a3a, { x: cx + 8, y: ft - 47, r: 3 });
    return;
  }

  // --- 1. the conifer: the only cone in the wood -----------------------------
  //
  // Four stacked skirts rather than one triangle, because a single triangle is
  // a road sign and a stack of skirts is a spruce. Each skirt is drawn as a
  // shallow arc of points with a serrated lower edge, so the outline has teeth
  // in it at the size the player sees — a smooth-sided cone at 30px reads as a
  // solid wedge and loses the whole species.
  if (v === 1) {
    const NEEDLE = 0x2f5b3f; // blue-green: the coldest foliage on the map
    groundShadow(g, cx, ft - 1, 24, 9);
    trunk(g, cx, ft, 16, 8, 6, 0, 0x5c4327);
    // Bottom skirt first, so each one overlaps the one above it the way real
    // branches shingle downwards; the topmost is the tree's tip, drawn last and
    // sharpest. There is no separate spike on top: a leader drawn over the
    // finished crown reads as an aerial, not as a tree.
    for (let k = 0; k < 5; k++) {
      const t0 = k / 4;
      const yBot = ft - 10 - t0 * 44;
      const halfW = 19.5 - t0 * 15;
      const rise = 13 + t0 * 10;
      const teeth = [];
      const N = 7;
      for (let i = 0; i <= N; i++) {
        const s = i / N;
        teeth.push({
          x: cx - halfW + halfW * 2 * s,
          y: yBot - (i % 2 ? 4.5 : 0) * (1 - t0 * 0.6) - Math.abs(s - 0.5) * 4,
        });
      }
      const skirt = [{ x: cx, y: yBot - rise }, ...teeth];
      g.fillStyle(OUT, 1);
      g.fillPoints(skirt.map((p) => ({
        x: cx + (p.x - cx) * 1.1, y: p.y + (p.y < yBot - rise * 0.6 ? -1.8 : 1.8),
      })), true, true);
      g.fillStyle(shade(NEEDLE, -0.24), 1);
      g.fillPoints(skirt, true, true);
      // Lit half: the same skirt pulled in on its shaded side. Cheaper than a
      // real clip and indistinguishable from one at this size.
      g.fillStyle(NEEDLE, 1);
      g.fillPoints(skirt.map((p) => ({
        x: cx + (p.x - cx) * (p.x > cx ? 0.92 : 0.3) + 1.5, y: p.y - 1.2,
      })), true, true);
      g.fillStyle(shade(NEEDLE, 0.2), 0.75);
      g.fillTriangle(cx + 1.5, yBot - rise * 0.85, cx + halfW * 0.62, yBot - 3, cx + 1.5, yBot - 4);
    }
    return;
  }

  // --- 2. the birch: pale trunk, airy crown ---------------------------------
  //
  // The one tree in the set whose TRUNK is the identifying mark rather than its
  // canopy: a near-white bar with black scars on it, tall and bare for most of
  // its length. Against dark green grass a pale vertical is the highest-contrast
  // thing a tree can offer, and it survives to a much smaller size than any
  // canopy shape does. The crown is deliberately sparse and high — five small
  // clusters with sky between them, not a solid mass.
  if (v === 2) {
    const LEAF = 0x6f9c3c; // yellow-green
    groundShadow(g, cx, ft - 1, 20, 8);
    // Warm off-white, not white. The first version used 0xdfd9cc and at the one
    // tree in three the map generator currently places it turned a wood into a
    // picket fence: a near-white vertical is the highest-contrast mark on this
    // palette, and forty of them in one frame is all the eye sees. Dropped a
    // shade and narrowed by a fifth, it still reads as birch and stops
    // shouting over the canopy it belongs to.
    const BARK = 0xcbc2b0;
    g.fillStyle(OUT, 1);
    g.fillPoints([
      { x: cx - 4.6, y: ft }, { x: cx - 1.4, y: ft - 52 },
      { x: cx + 3.8, y: ft - 52 }, { x: cx + 4.6, y: ft },
    ], true, true);
    g.fillStyle(shade(BARK, -0.26), 1);
    g.fillPoints([
      { x: cx - 3.2, y: ft }, { x: cx - 0.8, y: ft - 51 },
      { x: cx + 2.4, y: ft - 51 }, { x: cx + 3.2, y: ft },
    ], true, true);
    g.fillStyle(BARK, 1);
    g.fillPoints([
      { x: cx - 0.4, y: ft }, { x: cx + 0.5, y: ft - 51 },
      { x: cx + 2.4, y: ft - 51 }, { x: cx + 3.2, y: ft },
    ], true, true);
    // The scars. Five short dark dashes, alternating sides.
    g.fillStyle(0x3a352c, 0.9);
    for (let k = 0; k < 5; k++) {
      const yy = ft - 8 - k * 9;
      g.fillRect(cx - 2.8 + (k % 2 ? 2.9 : 0), yy, 3, 2);
    }
    // Two boughs lifting out of the top of the trunk into the crown.
    bough(g, cx + 1, ft - 48, -2.5, 12, 2.4, shade(BARK, -0.3), 0);
    bough(g, cx + 2, ft - 48, -0.7, 11, 2.4, shade(BARK, -0.3), 0);
    canopy(g, [
      { x: cx - 9, y: ft - 58, r: 8 },
      { x: cx + 9, y: ft - 57, r: 7.5 },
      { x: cx, y: ft - 66, r: 9.5 },
      { x: cx - 4, y: ft - 51, r: 5.5 },
      { x: cx + 8, y: ft - 68, r: 5 },
    ], LEAF, { x: cx + 5, y: ft - 71, r: 2.6 });
    return;
  }

  // --- 3. the spreading oak: wide and low ------------------------------------
  //
  // A mature field oak: short thick trunk that forks low, and a crown far wider
  // than it is tall. This is the variant that changes the *proportion* of the
  // forest — put next to the conifer it is the same tree turned on its side,
  // and a stand containing both stops looking like a repeated stamp
  // immediately. Its frame box is wider than it is tall, which no other
  // resource in the game is.
  if (v === 3) {
    groundShadow(g, cx, ft - 1, 38, 12);
    trunk(g, cx, ft, 15, 11, 8, 0, 0x6b4a2c);
    bough(g, cx - 1, ft - 13, -2.5, 12, 4.5, 0x6b4a2c, 0);
    bough(g, cx + 1, ft - 13, -0.6, 13, 4.5, 0x6b4a2c, 0);
    canopy(g, [
      { x: cx - 20, y: ft - 24, r: 10 },
      { x: cx + 20, y: ft - 24, r: 9.5 },
      { x: cx - 8, y: ft - 30, r: 13 },
      { x: cx + 9, y: ft - 31, r: 12.5 },
      { x: cx + 1, y: ft - 36, r: 10 },
    ], 0x4d7f2f, { x: cx + 10, y: ft - 40, r: 3.2 });
    return;
  }

  // --- 4. the dead snag: no canopy at all ------------------------------------
  //
  // The most valuable variant in the set and the cheapest, because it is the
  // only one that is not a green blob: a grey forked skeleton, mostly holes.
  // One of these every dozen trees does more to break up a wood than any amount
  // of jitter applied to the other five, precisely because it is not a
  // variation on them — it is a hole in the pattern.
  if (v === 4) {
    const DEAD = 0x8a7c66;
    groundShadow(g, cx, ft - 1, 22, 9);
    trunk(g, cx, ft, 30, 10, 6, -1, DEAD);
    bough(g, cx - 1, ft - 28, -2.35, 17, 4.4, DEAD, 2);
    bough(g, cx + 1, ft - 26, -0.72, 16, 4.2, DEAD, 2);
    bough(g, cx - 2, ft - 20, -2.9, 11, 3.2, DEAD, 1);
    // A stub where a limb came off, and the split that killed it.
    g.fillStyle(0x40372a, 1);
    g.fillEllipse(cx + 4, ft - 22, 5, 4);
    g.lineStyle(1.4, 0x40372a, 0.8);
    g.beginPath();
    g.moveTo(cx - 1, ft - 4);
    g.lineTo(cx + 0.5, ft - 24);
    g.strokePath();
    return;
  }

  // --- 5. the poplar: a green column ----------------------------------------
  //
  // Two tiles wide and five tall in feel, if not in fact: the narrowest thing
  // on the map. Drawn as a stack of small blobs down a central spine rather
  // than as one long ellipse, so the edge is ragged — a smooth capsule reads as
  // a bush someone stretched.
  const POP = 0x5f8b34;
  groundShadow(g, cx, ft - 1, 18, 7);
  trunk(g, cx, ft, 20, 7, 5, 0, 0x64492c);
  const col = [];
  for (let k = 0; k < 7; k++) {
    const s = k / 6;
    col.push({
      x: cx + (k % 2 ? 2.6 : -2.6) * (1 - s * 0.5),
      y: ft - 16 - k * 9.5,
      r: 10.5 - Math.abs(s - 0.35) * 8.5,
    });
  }
  canopy(g, col, POP, { x: cx + 3, y: ft - 74, r: 2.4 });
}

function drawBerry(g, b, v, rng) {
  const { cx, ft } = b;
  groundShadow(g, cx, ft - 1, 26, 9);
  const mounds = v === 0
    ? [{ x: cx - 7, y: ft - 8, r: 9 }, { x: cx + 7, y: ft - 8, r: 8.5 }, { x: cx, y: ft - 14, r: 10.5 }]
    : [{ x: cx - 8, y: ft - 7, r: 8 }, { x: cx + 6, y: ft - 10, r: 10 }, { x: cx, y: ft - 13, r: 9 }];
  g.fillStyle(OUT, 1);
  for (const m of mounds) g.fillCircle(m.x, m.y, m.r + 1.8);
  g.fillStyle(0x3d7a3c, 1);
  for (const m of mounds) g.fillCircle(m.x, m.y, m.r);
  g.fillStyle(0x4f9448, 1);
  for (const m of mounds) g.fillCircle(m.x + m.r * 0.2, m.y - m.r * 0.25, m.r * 0.68);
  // berries
  const spots = [[-9, -10], [-3, -16], [4, -13], [10, -9], [-1, -6], [7, -18], [-8, -3]];
  for (const [dx, dy] of spots) {
    g.fillStyle(0x8f1f26, 1);
    g.fillCircle(cx + dx, ft + dy, 2.7);
    g.fillStyle(0xe0343d, 1);
    g.fillCircle(cx + dx, ft + dy, 2.1);
    g.fillStyle(0xff8b8b, 0.9);
    g.fillCircle(cx + dx - 0.7, ft + dy - 0.8, 0.8);
  }
}

function drawGold(g, go, v, rng) {
  const { cx, ft } = go;
  groundShadow(g, cx, ft - 1, 28, 10);
  const rocks = [
    { x: cx - 9, y: ft - 7, w: 18, h: 14 },
    { x: cx + 8, y: ft - 6, w: 16, h: 12 },
    { x: cx + (v === 1 ? -2 : 1), y: ft - 15, w: 20, h: 15 },
  ];
  for (const r of rocks) {
    const pts = [
      { x: r.x - r.w / 2, y: r.y + r.h / 2 },
      { x: r.x - r.w / 2.6, y: r.y - r.h / 2 },
      { x: r.x + r.w / 3.2, y: r.y - r.h / 2.1 },
      { x: r.x + r.w / 2, y: r.y + r.h / 3 },
      { x: r.x + r.w / 5, y: r.y + r.h / 2 },
    ];
    g.fillStyle(0x8b8b93, 1);
    g.fillPoints(pts, true, true);
    g.fillStyle(0xa9a9b2, 1);
    g.fillPoints(pts.map((p) => ({ x: p.x + 1, y: p.y - 1.5 })), true, true);
    g.fillStyle(mix(0xc4c4cd, RIM, 0.3), 0.75);
    g.fillPoints(pts.map((p) => ({ x: p.x + 2.4, y: p.y - 3 })), true, true);
    g.lineStyle(2, OUT, 1);
    g.strokePoints(pts, true, true);
  }
  // gold veins — bright and unmistakable
  const veins = [[-10, -9], [-5, -13], [6, -16], [11, -8], [2, -6], [-2, -18]];
  for (const [dx, dy] of veins) {
    g.fillStyle(0x8a6a12, 1);
    g.fillCircle(cx + dx, ft + dy, 3.1);
    g.fillStyle(0xf5c333, 1);
    g.fillCircle(cx + dx, ft + dy, 2.3);
    g.fillStyle(0xfff0a8, 1);
    g.fillCircle(cx + dx - 0.7, ft + dy - 0.8, 1);
  }
}

/**
 * A stone mine: a cluster of squared-off grey boulders with a chiselled face.
 *
 * The whole job of this drawing is to not be the gold vein. Gold reads warm —
 * grey rubble carrying bright yellow spots of ore, lit like a scatter of
 * pebbles. Stone reads cool and heavy: bluish slate, no warm hue anywhere in
 * the palette, boulders drawn as isometric *blocks* with a flat top face rather
 * than as lumps, and one exposed quarry face of pale rock instead of glinting
 * specks. At a glance across a minimap-sized sprite the cue is the silhouette
 * (stacked cubes against a low mound) before it is ever the colour.
 */
function drawStone(g, st, v, rng) {
  const { cx, ft } = st;
  groundShadow(g, cx, ft - 1, 30, 11);

  // Cool slate, deliberately with no warm component: side by side with the gold
  // vein's rocks (0x8b8b93, which carries a faint violet) this reads bluer and
  // darker, and never picks up the yellow.
  const FACE_L = 0x707d8a;
  const FACE_R = 0x5b6774;
  const TOP = 0x94a2af;
  const CHIP = 0xc3cedb;

  // Three blocks: two squat ones on the ground and one perched across them, so
  // the cluster has a stepped profile rather than a single blob.
  const blocks = [
    { x: cx - 10, y: ft - 5, hw: 10, hh: 5, h: 11 },
    { x: cx + 9, y: ft - 4, hw: 9, hh: 4.5, h: 9 },
    { x: cx + (v === 1 ? -3 : 2), y: ft - 13, hw: 9, hh: 4.5, h: 12 },
  ];
  // v === 2 shoulders the top block over to the other side, so a cluster of
  // three mines beside each other does not look like one sprite stamped thrice.
  if (v === 2) blocks[2].x = cx - 6;

  for (const b of blocks) {
    const topY = b.y - b.h;
    const top = [
      { x: b.x, y: topY - b.hh },
      { x: b.x + b.hw, y: topY },
      { x: b.x, y: topY + b.hh },
      { x: b.x - b.hw, y: topY },
    ];
    // Left and right walls, drawn as quads hanging off the top diamond.
    g.fillStyle(FACE_L, 1);
    g.fillPoints([
      { x: b.x - b.hw, y: topY },
      { x: b.x, y: topY + b.hh },
      { x: b.x, y: topY + b.hh + b.h },
      { x: b.x - b.hw, y: topY + b.h },
    ], true, true);
    g.fillStyle(FACE_R, 1);
    g.fillPoints([
      { x: b.x + b.hw, y: topY },
      { x: b.x, y: topY + b.hh },
      { x: b.x, y: topY + b.hh + b.h },
      { x: b.x + b.hw, y: topY + b.h },
    ], true, true);
    g.fillStyle(TOP, 1);
    g.fillPoints(top, true, true);
    g.lineStyle(2, OUT, 1);
    g.strokePoints(top, true, true);
    g.beginPath();
    g.moveTo(b.x - b.hw, topY);
    g.lineTo(b.x - b.hw, topY + b.h);
    g.lineTo(b.x, topY + b.hh + b.h);
    g.lineTo(b.x + b.hw, topY + b.h);
    g.lineTo(b.x + b.hw, topY);
    g.strokePath();
  }

  // The quarried face: a few pale chips knocked off the rock, cool white rather
  // than the gold vein's yellow, so the two never read as the same material.
  const chips = [[-12, -12], [-7, -7], [8, -9], [12, -6], [0, -20], [-4, -16]];
  for (const [dx, dy] of chips) {
    g.fillStyle(CHIP, 0.9);
    g.fillTriangle(
      cx + dx, ft + dy,
      cx + dx + 3.4, ft + dy + 1.2,
      cx + dx + 0.8, ft + dy + 3.4,
    );
  }
}

// ---------------------------------------------------------------------------
// Ground detail and cliffs
// ---------------------------------------------------------------------------
//
// WHY DECALS AND NOT MORE TILE VARIANTS. Adding a rock to a tile variant means
// every hundredth tile is that rock, in the same place, at the same angle, and
// the eye finds the grid. These are separate sprites the bake scatters between
// tile centres, so a rock can sit anywhere, including across a seam, and the
// distribution can be sparse — which is the actual difference between "detail"
// and "noise". They are baked into the terrain RenderTextures with everything
// else, so a thousand of them cost nothing per frame.

function buildDetails(put, rng) {
  const W = DETAIL_BOX.w;
  const H = DETAIL_BOX.h;
  const cx = DETAIL_BOX.ax;
  const cy = DETAIL_BOX.ay;

  // 0 — a cluster of grey stones. Light from the upper right, like every other
  // solid object in the game.
  put(detailFrame(0), W, H, cx, cy, (g) => {
    const rocks = [[-6, -1, 6, 4], [3, -2, 7.5, 5], [-1, -6, 5, 3.4]];
    for (const [dx, dy, rw, rh] of rocks) {
      g.fillStyle(OUT, 0.9);
      g.fillEllipse(cx + dx, cy + dy + 1, rw * 2 + 3, rh * 2 + 3);
      g.fillStyle(0x736c62, 1);
      g.fillEllipse(cx + dx, cy + dy, rw * 2, rh * 2);
      g.fillStyle(0x9a9387, 1);
      g.fillEllipse(cx + dx + rw * 0.35, cy + dy - rh * 0.4, rw, rh);
      g.fillStyle(mix(0xb8b1a3, RIM, 0.3), 0.7);
      g.fillEllipse(cx + dx + rw * 0.6, cy + dy - rh * 0.7, rw * 0.45, rh * 0.4);
    }
  });

  // 1 — flowers. Small, pale, and only ever a handful: a field of them reads as
  // a rash rather than as a meadow.
  put(detailFrame(1), W, H, cx, cy, (g) => {
    for (let k = 0; k < 6; k++) {
      const dx = rng.range(-11, 11);
      const dy = rng.range(-6, 2);
      g.lineStyle(1, 0x4f7a35, 0.8);
      g.beginPath();
      g.moveTo(cx + dx, cy + dy);
      g.lineTo(cx + dx + rng.range(-1, 1), cy + dy - 4);
      g.strokePath();
      const col = k % 3 === 0 ? 0xf2ecd2 : k % 3 === 1 ? 0xe7a9c0 : 0xf0d675;
      g.fillStyle(0x3a3324, 0.5);
      g.fillCircle(cx + dx, cy + dy - 4.4, 2.2);
      g.fillStyle(col, 1);
      g.fillCircle(cx + dx, cy + dy - 5, 1.8);
    }
  });

  // 2 — a tussock of long grass.
  put(detailFrame(2), W, H, cx, cy, (g) => {
    for (let k = 0; k < 11; k++) {
      const dx = rng.range(-9, 9);
      const lean = rng.range(-3.5, 3.5);
      const hgt = rng.range(5, 10);
      g.lineStyle(1.8, 0x33501f, 0.85);
      g.beginPath();
      g.moveTo(cx + dx, cy);
      g.lineTo(cx + dx + lean, cy - hgt);
      g.strokePath();
      g.lineStyle(1, 0x74a24a, 0.9);
      g.beginPath();
      g.moveTo(cx + dx, cy - 1);
      g.lineTo(cx + dx + lean, cy - hgt);
      g.strokePath();
    }
  });

  // 3 — a fallen branch. The only long straight thing on open ground, which is
  // why one every few screens is worth a frame.
  put(detailFrame(3), W, H, cx, cy, (g) => {
    stick(g, cx - 13, cy - 1, cx + 12, cy - 5, 2.6, 0x6f5330);
    stick(g, cx + 2, cy - 4, cx + 8, cy - 10, 1.8, 0x6f5330);
    stick(g, cx - 5, cy - 2, cx - 10, cy - 7, 1.6, 0x6f5330);
  });

  // 4 — pebble scatter, for dirt and sand.
  put(detailFrame(4), W, H, cx, cy, (g) => {
    for (let k = 0; k < 9; k++) {
      const dx = rng.range(-13, 13);
      const dy = rng.range(-5, 2);
      const r = rng.range(1.2, 2.6);
      g.fillStyle(0x5c5347, 0.7);
      g.fillEllipse(cx + dx, cy + dy + 0.8, r * 2.4, r * 1.6);
      g.fillStyle(0x9d9385, 1);
      g.fillEllipse(cx + dx, cy + dy, r * 2, r * 1.3);
      g.fillStyle(0xc0b6a4, 0.9);
      g.fillEllipse(cx + dx + r * 0.4, cy + dy - r * 0.35, r, r * 0.6);
    }
  });

  // 5 — a dry shrub, for the arid ground.
  put(detailFrame(5), W, H, cx, cy, (g) => {
    for (let k = 0; k < 7; k++) {
      const a = -Math.PI / 2 + rng.range(-1.1, 1.1);
      stick(g, cx, cy, cx + Math.cos(a) * 9, cy + Math.sin(a) * 9, 1.5, 0x8a7546);
    }
    g.fillStyle(0x9c8a55, 0.7);
    g.fillEllipse(cx, cy - 6, 15, 8);
  });

  // 6 — reeds: tall, thin, and dark, for the water's edge.
  put(detailFrame(6), W, H, cx, cy, (g) => {
    for (let k = 0; k < 8; k++) {
      const dx = rng.range(-8, 8);
      const hgt = rng.range(8, 15);
      const lean = rng.range(-2, 2);
      stick(g, cx + dx, cy, cx + dx + lean, cy - hgt, 1.2, 0x4b6b33);
      g.fillStyle(0x7a5f2c, 1);
      g.fillEllipse(cx + dx + lean, cy - hgt - 1, 2.4, 4.4);
    }
  });
}

/**
 * Cliffs.
 *
 * A cliff is one tile of impassable ground raised CLIFF_H pixels, so it does
 * two things at once: it reads as terrain the player cannot cross, and it gives
 * a flat map an actual horizon line to break up. Only the two faces the camera
 * can see are drawn, and only where the neighbour on that side is not itself a
 * cliff — so a run of cliff tiles is one rock mass with a single silhouette,
 * not a row of separate blocks with seams down them.
 *
 * The strata are horizontal because horizontal is the one direction nothing else
 * in this projection uses: every wall, roof and fence line runs along a grid
 * axis and therefore at 26 degrees to the screen, and a band that runs flat
 * across is instantly a different *material* rather than another built thing.
 *
 * THE ROCK IS NOT GREY.
 *
 * That is the single biggest thing this pass changed, and it is worth writing
 * down because it is invisible in code review and obvious in a screenshot. The
 * old palette was a desaturated neutral — 0x8e8b80 over 0x6f6a5f over 0x5a564d
 * — sitting on a map made entirely of warm greens and ochres, and no amount of
 * texture drawn on top of a wrong hue will fix it: the outcrop read as poured
 * concrete before the first stratum went down, because concrete is exactly what
 * neutral grey next to warm green looks like. Real rock in a grassland is a warm
 * buff, iron-stained, greyer than the sand tiles but pulled the same way off
 * neutral. CLIFF_STONE is that, and every plane on a cliff is now derived from
 * it through the light model rather than being three hand-picked greys.
 *
 * The three planes, and why they sit where they do:
 *
 *   TOP     a horizontal plane. At a sun 40 degrees up it is the best-lit
 *           surface on the map, and it is also the only one taking the whole
 *           dome of the sky, so it is lifted hard and warmed with a little RIM.
 *   FACE_R  the sunward vertical (the +x face). lit(), taken off a base that is
 *           already dropped, because a vertical surface at this sun angle
 *           receives well under half what the plateau above it does. Lighting a
 *           vertical face with the same lift as a horizontal one is how you get
 *           a cliff that looks like a photograph of a cliff with the contrast
 *           slider at zero.
 *   FACE_L  the shaded vertical (the +y face). dim(), which cools as it darkens.
 *
 * The old three were at luma 140 / 107 / 87. The two *faces* were within twenty
 * per cent of each other, which meant the corner where they meet — the one
 * place in the whole drawing where a cliff can prove it is a solid and not a
 * shape — had almost no value break across it. The new three are roughly
 * 150 / 134 / 78, and the corner does the work now. Note which pair moved
 * apart: the plateau and the sunward face are nearly the same value, and that
 * is not a mistake. A vertical surface aimed at a sun 40 degrees up receives
 * about as much beam as a horizontal one does; what separates them is the sky,
 * and the sky is worth ten per cent, not fifty. The contrast that has to exist
 * is between the two *faces*, and it does.
 *
 * The stone *mine* is still neutral grey (PAL_STONE, up in the resources), and
 * that is also deliberate. Two different rocks on one map want to be told apart
 * without a label: quarried blocks are cool and squared, natural outcrop is warm
 * and broken. Making them the same colour would have been the tidier decision
 * and the worse one.
 */
// How warm is warm enough? The test that settled it: hold the stone next to
// SAND[0] (0xd5bf82, red minus blue = 83) and GRASS[0] (0x537d38, r-b = 27).
// The first attempt at this used r-b = 27 and still photographed as concrete,
// because at the value a lit rock plane sits at, a hue that weak is washed out
// by its own brightness. CLIFF_STONE is r-b = 60: clearly not sand, clearly not
// neutral, and it survives being lifted to the plateau's value.
const CLIFF_STONE = 0x9d8b64;
const CLIFF_TOP = mix(CLIFF_STONE, RIM, 0.12);
const CLIFF_FACE_BASE = shade(CLIFF_STONE, -0.3);
const CLIFF_FACE_R = lit(CLIFF_FACE_BASE);
const CLIFF_FACE_L = dim(CLIFF_FACE_BASE);
// Lichen and soil. The greens are lifted off the GRASS ramp and the browns off
// DIRT rather than being invented, so what grows on the rock and what stains it
// are the same substances as the ground round its foot. This is the cheapest
// single thing that makes an outcrop belong to a map instead of sitting on it,
// and it is why the plateau — which for a big mass is nearly all of what the
// player sees — is no longer one flat fill.
const CLIFF_MOSS = [0x6a7a44, 0x5b7139, 0x74814a];
const CLIFF_SOIL = [0x8a6a45, 0x7d5f3c];

/**
 * A drawn edge that is not a ruled line.
 *
 * Pinned at both endpoints — those are shared with the neighbouring tile and
 * have to meet it exactly, or a run of cliffs grows a visible stitch at every
 * boundary — and pushed a pixel or two off true in between.
 *
 * This turned out to be the cheapest large improvement in the whole cliff pass,
 * and it is not about texture at all. With the palette fixed and the faces lit,
 * a single tile still photographed as a cardboard carton, and the reason was
 * the outline: four perfectly straight edges meeting at four sharp corners is
 * the definition of a manufactured box, and no amount of stratum drawn inside
 * one will argue with it. Two pixels of wobble on the same four edges and the
 * thing is a rock.
 */
function roughLine(g, p, q, amp, rng, n = 4) {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  g.beginPath();
  g.moveTo(p.x, p.y);
  for (let k = 1; k < n; k++) {
    const t = k / n;
    const j = rng.range(-amp, amp);
    g.lineTo(p.x + dx * t + nx * j, p.y + dy * t + ny * j);
  }
  g.lineTo(q.x, q.y);
  g.strokePath();
}

function buildCliffs(put, rng) {
  // Half a pixel wider than a real tile in each direction, for the same reason
  // the terrain diamonds are baked oversized: two antialiased polygon edges
  // butted against each other do not add up to an opaque pixel, and the hairline
  // of background that shows through draws the tile grid straight onto what is
  // supposed to be one continuous rock face. Overlapping neighbours hides it,
  // and the depth sort makes the overlap invisible.
  const hw = HALF_W + 1.2;
  const hh = HALF_H + 0.6;
  const w = TILE_W + 8;
  // Measured, not guessed: the tallest cliff frame reaches CLIFF_H above the
  // tile's north corner and the deepest reaches the south corner, so the box is
  // that plus four pixels of margin. It used to carry eighteen, which across
  // forty-eight frames was 48k pixels — a whole unit type's animation, spent on
  // air.
  const h = TILE_H + CLIFF_H + 8;
  const ax = w / 2;
  const ay = h - 5 - hh;
  for (let v = 0; v < CLIFF_VARIANTS; v++) {
    for (let mask = 0; mask < 16; mask++) {
      put(cliffFrame(v, mask), w, h, ax, ay, (g) =>
        drawCliff(g, ax, ay, hw, hh, mask, v, rng));
    }
  }
}

function drawCliff(g, cx, cy, hw, hh, mask, v, rng) {
  const N = { x: cx, y: cy - hh };
  const E = { x: cx + hw, y: cy };
  const S = { x: cx, y: cy + hh };
  const W = { x: cx - hw, y: cy };
  const up = (p) => ({ x: p.x, y: p.y - CLIFF_H });
  const openX = !(mask & 1);
  const openY = !(mask & 2);
  const tx = cx - hw; // top-left of the tile's bounding box, for inDiamond()
  const ty = cy - hh - CLIFF_H;

  // The ground shadow the whole mass throws, offset away from the sun. This was
  // one hard black ellipse, which under the biggest solid on the map is a second
  // silhouette competing with the rock's own; contactShadow() stacks four and
  // feathers, which is what the rest of the file does and what this always
  // should have.
  if (openX || openY) contactShadow(g, cx, cy + hh * 0.24, hw * 1.55, hh * 1.5, 0.95);

  // Each visible face has a vertical corner at either end, and those are the
  // last thing that can give the game away: draw them unconditionally and a run
  // of cliff tiles gets a seam at every tile boundary, which is a stack of
  // crates. A corner is only drawn where the neighbour *along that face* is
  // open ground, so a run has verticals at its two ends and nowhere else.
  const wall = (a, b, sunward, capA, capB) => {
    const face = sunward ? CLIFF_FACE_R : CLIFF_FACE_L;
    // Everything on a face is placed in (u, t): `u` runs along the base from a
    // to b, `t` runs up the face from the ground to the rim. Both are in tile
    // units, so a mark at u = 0.5 sits mid-tile whichever of the two faces it
    // is on and whichever way that face runs across the screen.
    const at = (u, t) => ({
      x: a.x + (b.x - a.x) * u,
      y: a.y + (b.y - a.y) * u - CLIFF_H * t,
    });
    const band = (t0, t1, c, alpha = 1) => {
      g.fillStyle(c, alpha);
      g.fillPoints([at(0, t0), at(1, t0), at(1, t1), at(0, t1)], true, true);
    };
    /**
     * The boundary of a bed: `t` at both ends, wobbling in between.
     *
     * Pinned at u = 0 and u = 1 so the bed carries across a tile join and meets
     * its neighbour exactly — that continuity is the whole reason a run of
     * tiles reads as one outcrop. Wobbled everywhere else because a bedding
     * plane drawn as a ruled line, at this scale, is a plank; the amplitude is
     * two and a half pixels, which is small enough to stay a rock edge and
     * large enough to be visible at all, and the first attempt at this used
     * under one pixel and might as well have been straight.
     */
    const seamPts = (t, amp) => {
      const pts = [at(0, t)];
      for (let k = 1; k < 5; k++) pts.push(at(k / 5, t + rng.range(-amp, amp)));
      pts.push(at(1, t));
      return pts;
    };
    const bed = (t0, t1, c, alpha, amp) => {
      const lo = seamPts(t0, amp);
      const hi = seamPts(t1, amp);
      hi.reverse();
      g.fillStyle(c, alpha);
      g.fillPoints(lo.concat(hi), true, true);
      return lo;
    };

    band(0, 1, face);
    // HOW MUCH STRATA A THIRTY-PIXEL FACE WILL TAKE: not much.
    //
    // The version before this one drew five beds at up to +/- 0.17 value across
    // the full width of the face, with hard straight boundaries. Photographed,
    // that is not sedimentary rock, it is board-and-batten siding — five clean
    // stripes of alternating tone is a *manufactured* surface, and swapping the
    // old corrugation for it was trading one machined material for another. A
    // face this size has room for two value shapes that are actually read, so
    // there are two: one dark bed low down and one pale bed above the middle,
    // both with broken edges and both at a third of the contrast. Everything
    // else on the face is a mark rather than a tone.
    bed(0.17, 0.33, shade(face, -0.09), 0.85, 0.05);
    bed(0.52, 0.66, shade(face, 0.11), 0.8, 0.055);
    // Ambient occlusion at the foot, as a four-step ramp rather than one dark
    // band. The old face had a hard-edged shaded block across its bottom 28 per
    // cent, and a hard edge at a constant height is read as a course of masonry
    // — a plinth — which is the exact opposite of what it was for. The matching
    // two steps at the top are the other half of the same argument: the rock
    // nearest the rim sees the most sky.
    for (let k = 0; k < 4; k++) band(-0.02, 0.05 + k * 0.07, shade(face, -0.52), 0.1);
    for (let k = 0; k < 2; k++) band(0.98 - k * 0.13, 1.01, mix(face, RIM, 0.3), 0.1);

    // A crack along the underside of each bed. Thin, low alpha, and drawn on the
    // *bottom* edge only: mark both edges of a band and it becomes a moulding.
    for (const t of [0.17, 0.52]) {
      g.lineStyle(1.2, shade(face, -0.42), 0.5);
      g.strokePoints(seamPts(t, 0.045), false, false);
    }

    // FACETS. A rock face is not a plane, it is several dozen small planes at
    // slightly different angles, and that — not the strata — is what the eye
    // actually uses to tell stone from stucco. Three quads of nudged value,
    // shaped and placed from the bake rng so no two of the forty-eight frames
    // carry the same ones. That last part matters more than the facets do: the
    // old face was a pure function of `v`, so a nine-tile ridge was three
    // drawings shown three times each, and the repeat was more visible than
    // anything drawn inside it.
    for (let k = 0; k < 3; k++) {
      const u0 = rng.range(-0.05, 0.62);
      const t0 = rng.range(0.08, 0.6);
      const du = rng.range(0.26, 0.5);
      const dt = rng.range(0.18, 0.36);
      g.fillStyle(shade(face, rng.chance(0.5) ? 0.14 : -0.15), 0.5);
      g.fillPoints([
        at(u0, t0),
        at(u0 + du, t0 + rng.range(-0.07, 0.07)),
        at(u0 + du * rng.range(0.5, 1), t0 + dt),
        at(u0 + rng.range(-0.06, 0.06), t0 + dt * rng.range(0.5, 1)),
      ], true, true);
    }

    // Vertical jointing, kept away from u = 0 and u = 1. A joint that lands on
    // a tile edge is a seam between two crates; a joint at u = 0.4 is rock. It
    // leans slightly, because a plumb-vertical line in an isometric drawing is
    // the one thing that never occurs naturally — and it is drawn as a *groove*,
    // dark on one side and catching light on the other, because a single dark
    // line is a scratch and two lines side by side are a channel cut into
    // something with thickness.
    for (let k = 0, n = rng.int(1, 2); k < n; k++) {
      const u = rng.range(0.22, 0.74);
      const t0 = rng.range(0, 0.22);
      const t1 = t0 + rng.range(0.42, 0.74);
      const skew = rng.range(-0.05, 0.05);
      const path = (du) => [
        at(u + du, t0), at(u + skew + du, (t0 + t1) / 2), at(u + skew * 0.4 + du, t1),
      ];
      g.lineStyle(1.5, mix(shade(face, -0.5), 0x2b2822, 0.45), 0.5);
      g.strokePoints(path(0), false, false);
      g.lineStyle(1, shade(face, 0.2), 0.35);
      g.strokePoints(path(0.045), false, false);
    }

    // ONE RECESS. A face built only out of value *bands* has no events on it —
    // it is a gradient with stripes, and the eye finds nothing to land on. A
    // single dark wedge where the rock has broken back under an overhang does
    // more than three more strata would, because it is the only place on the
    // face where the surface is not the surface. The lit lip above it is half
    // the effect: a hole with a bright edge over it reads as depth, a hole
    // without one reads as a stain.
    //
    // It is a WEDGE, and the first attempt at it was a rectangle with a bright
    // line over the top. That is a window. Four-sided, level, evenly lit and
    // sitting a third of the way up a wall — the eye had no choice, and every
    // cliff in the game grew a row of little doors. A hollow in rock tapers.
    {
      const u = rng.range(0.16, 0.6);
      const t = rng.range(0.3, 0.62);
      const w0 = rng.range(0.16, 0.3);
      const h0 = rng.range(0.1, 0.18);
      g.fillStyle(mix(shade(face, -0.5), OUT, 0.25), 0.5);
      g.fillPoints([
        at(u, t + h0), at(u + w0 * 0.55, t + h0 * 1.1), at(u + w0, t + h0 * 0.2),
        at(u + w0 * 0.5, t - h0 * 0.25),
      ], true, true);
      g.lineStyle(1.2, mix(shade(face, 0.3), RIM, 0.25), 0.42);
      g.beginPath();
      g.moveTo(at(u + w0 * 0.1, t + h0 * 1.05).x, at(u + w0 * 0.1, t + h0 * 1.05).y);
      g.lineTo(at(u + w0 * 0.62, t + h0 * 1.2).x, at(u + w0 * 0.62, t + h0 * 1.2).y);
      g.strokePath();
    }

    // SCREE. The old version put one or two 13px boulders on the base line of
    // every face, at positions fixed by `v`, and the result along a ridge was a
    // row of identical dark bumps — a scalloped skirt, or the feet of a
    // caterpillar track. What a cliff actually has at its foot is talus: rock
    // that came off the face, piling *against* it, small and many and unequal.
    // So the chips are drawn mostly above the base line rather than sitting on
    // it, sized over a 3x range, and only two or three of them get big enough
    // to carry a highlight.
    //
    // They also cluster. Talus does not distribute itself evenly along a cliff;
    // it piles where the face has shed, so the chips are drawn around one or two
    // seed points rather than at independent random positions. Evenly spread,
    // even at random sizes, they come out as a row of bumps — a scalloped skirt
    // — and that is what the previous version's fixed boulders looked like along
    // a ridge.
    for (let c = 0, heaps = rng.int(1, 2); c < heaps; c++) {
      const u0 = rng.range(0.12, 0.88);
      for (let k = 0, n = rng.int(3, 5); k < n; k++) {
        const u = u0 + rng.range(-0.16, 0.16);
        const t = rng.range(0.012, 0.12);
        const r = rng.range(1.8, 5.2);
        const p = at(u, t);
        // A thinner ring of ink than a unit gets. Half a dozen chips each with
        // a full-weight outline pile up into one black smear at the foot of the
        // cliff, which reads as the rock standing in mud.
        g.fillStyle(OUT, 0.55);
        g.fillEllipse(p.x, p.y + 0.6, r * 2.2 + 1.4, r * 1.5 + 1.4);
        g.fillStyle(shade(face, rng.range(-0.24, -0.02)), 1);
        g.fillEllipse(p.x, p.y, r * 2.2, r * 1.5);
        if (r > 3.6) {
          // Catchlight up-and-right, like every other solid in this file.
          g.fillStyle(shade(face, 0.16), 0.9);
          g.fillEllipse(p.x + r * 0.4, p.y - r * 0.35, r * 1.1, r * 0.55);
        }
      }
    }

    // THE RIM.
    //
    // The top two or three pixels of a rock face are the whole reason a cliff
    // reads as a solid rather than as a shape cut out of paper. That strip is
    // the silhouette against the sky: it takes the sun almost edge-on, it takes
    // the entire dome of skylight, and it is where the ground's own warm bounce
    // arrives from below. Every other object in this file got one in the last
    // pass and the cliffs — the biggest solids on the map — got nothing.
    //
    // It is drawn HERE, on the face, and not on the plateau edge, which is the
    // mistake worth recording: the plateau polygon's boundary *is* the top of
    // the face, so a highlight painted along it lands on the horizontal plane,
    // where it reads as a bright hem on a tablecloth. Two pixels lower it lands
    // on the vertical plane and reads as light catching an edge. Same line, two
    // pixels apart, completely different picture. The sunward face gets the warm
    // one at full strength; the shaded face still faces the sky even though it
    // has turned away from the sun, so it gets a narrower, cooler version.
    const r0 = at(0, 1);
    const r1 = at(1, 1);
    if (sunward) {
      rimLine(g, r0.x, r0.y + 2.4, r1.x, r1.y + 2.4, 1.8, 0.55);
    } else {
      g.lineStyle(1.4, mix(RIM, SKY, 0.6), 0.32);
      g.beginPath();
      g.moveTo(r0.x, r0.y + 2.2);
      g.lineTo(r1.x, r1.y + 2.2);
      g.strokePath();
    }

    // The exposed silhouette: the ground line always, the two vertical corners
    // only where this face actually ends. The top edge is left to the plateau,
    // which draws it once.
    outline(g, false, 2.2);
    roughLine(g, a, b, 1.3, rng, 5);
    for (const [c, on] of [[a, capA], [b, capB]]) {
      if (!on) continue;
      roughLine(g, up(c), c, 1.2, rng, 4);
    }
    // A corner that is a hard black line on both sides is a folded piece of
    // card. The sunward face gets a warm bounce down its own vertical edges,
    // just inside the ink, so the turn reads as a turn.
    if (sunward) {
      for (const [c, on] of [[a, capA], [b, capB]]) {
        if (!on) continue;
        rimLine(g, c.x - 1, c.y - 1.5, up(c).x - 1, up(c).y + 1, 1.4, 0.28);
      }
    }
  };

  // +y face, away from the light. It runs W -> S: the W end is shared with the
  // -x neighbour, the S end with the +x one.
  if (openY) wall(W, S, false, !(mask & 4), !(mask & 1));
  // +x face, lit. It runs S -> E: S is shared with +y, E with -y.
  if (openX) wall(S, E, true, !(mask & 2), !(mask & 8));

  // The plateau.
  const top = [up(N), up(E), up(S), up(W)];
  // Flat and untouched by the light direction, deliberately: a horizontal plane
  // is lit evenly whatever angle the sun is at, and shading the northern half of
  // each tile — which is what this used to do — stamps a visible chevron into
  // every diamond and turns a plateau into a tiled floor.
  //
  // "Unshaded" is not the same as "unmarked", though, and that is where the old
  // plateau went wrong: one flat fill with nine speckle ellipses on it is a
  // sheet of grey card with dust on it. What goes on instead is the same three
  // layers the ground tiles use — a slow swell far larger than the tile, then
  // marks, then incident — none of which respects the diamond.
  g.fillStyle(CLIFF_TOP, 1);
  g.fillPoints(top, true, true);
  swell(g, TILE_W, TILE_H, CLIFF_TOP, v * 3 + (mask & 3), 0.06);

  // CLINTS. Weathered bedrock breaks into big flat slabs with joints between
  // them, and slabs are the largest shape available on a plane that is not
  // allowed to be shaded. Two or three per tile, each a quadrilateral of nudged
  // value with a dark joint down one side and a hairline catch on the other,
  // drawn oversized and clipped by nothing — they run off the diamond, which is
  // the point. A mark that stops inside the tile draws the tile.
  for (let k = 0, n = rng.int(2, 3); k < n; k++) {
    const p = inDiamond(rng, TILE_W, TILE_H, -0.15);
    const w0 = rng.range(16, 30);
    const h0 = rng.range(7, 14);
    const sk = rng.range(-0.5, 0.5);
    const q = [
      { x: tx + p.x - w0 / 2, y: ty + p.y - h0 / 2 + sk * 3 },
      { x: tx + p.x + w0 / 2, y: ty + p.y - h0 / 2 - sk * 3 },
      { x: tx + p.x + w0 / 2 + sk * 4, y: ty + p.y + h0 / 2 },
      { x: tx + p.x - w0 / 2 + sk * 2, y: ty + p.y + h0 / 2 + sk * 2 },
    ];
    g.fillStyle(shade(CLIFF_TOP, rng.chance(0.5) ? 0.09 : -0.1), 0.55);
    g.fillPoints(q, true, true);
    g.lineStyle(1.2, shade(CLIFF_TOP, -0.38), 0.5);
    g.beginPath();
    g.moveTo(q[3].x, q[3].y);
    g.lineTo(q[2].x, q[2].y);
    g.lineTo(q[1].x, q[1].y);
    g.strokePath();
    g.lineStyle(1, shade(CLIFF_TOP, 0.2), 0.4);
    g.beginPath();
    g.moveTo(q[0].x, q[0].y);
    g.lineTo(q[1].x, q[1].y);
    g.strokePath();
  }

  // SOIL AND LICHEN, and this is the part that does the most work of anything
  // in the function.
  //
  // For a big outcrop nearly every tile the player sees is plateau — the faces
  // are one tile deep round the edge and the top is all the rest — so whatever
  // the top does is what a cliff looks like from across the map. One flat fill
  // with nine speckles on it is a concrete slab however good the faces are, and
  // that is what a third of the screen was. What breaks it is not more noise; it
  // is the map's own colours arriving on the rock: turf caught in the hollows
  // and iron-brown staining where water runs off. Coverage is deliberately high
  // — call it a quarter of the tile — because at a quarter it reads as an
  // outcrop weathering into a grassland, and at a tenth it reads as dirt on a
  // clean surface.
  for (let k = 0, n = rng.int(3, 5); k < n; k++) {
    const p = inDiamond(rng, TILE_W, TILE_H, 0.02);
    const soil = rng.chance(0.38);
    const col = rng.pick(soil ? CLIFF_SOIL : CLIFF_MOSS);
    const s = rng.range(0.7, 1.35);
    for (let j = 0; j < 4; j++) {
      g.fillStyle(col, rng.range(0.22, soil ? 0.34 : 0.52));
      g.fillEllipse(tx + p.x + rng.range(-7, 7) * s, ty + p.y + rng.range(-3.5, 3.5) * s,
        rng.range(9, 20) * s, rng.range(4, 9) * s);
    }
    // A few blades standing up out of the turf, drawn exactly the way the grass
    // tiles draw theirs — dark stroke, paler stroke a hair to the right. Three
    // of these on a patch of green is the difference between "lichen stain" and
    // "something is growing here", and something growing on the rock is the last
    // step of tying it to the map. Sparse on purpose: a plateau the player can
    // mistake for walkable grass is a worse bug than a plateau that is dull.
    if (soil) continue;
    for (let j = 0, m = rng.int(2, 4); j < m; j++) {
      const bx = tx + p.x + rng.range(-8, 8) * s;
      const by = ty + p.y + rng.range(-3, 3) * s;
      const lean = rng.range(-1.4, 1.4);
      g.lineStyle(1, shade(col, -0.3), 0.6);
      g.beginPath();
      g.moveTo(bx, by + 1);
      g.lineTo(bx + lean, by - 3.2);
      g.strokePath();
      g.lineStyle(1, shade(col, 0.3), 0.55);
      g.beginPath();
      g.moveTo(bx + 0.7, by + 0.6);
      g.lineTo(bx + lean + 0.7, by - 2.7);
      g.strokePath();
    }
  }
  // Loose stones lying on the shelf, each with its own tiny sunward catchlight.
  // Three pixels of highlight on a five-pixel pebble is what stops the top plane
  // being a plane.
  for (let k = 0, n = rng.int(2, 4); k < n; k++) {
    const p = inDiamond(rng, TILE_W, TILE_H, 0.26);
    const r = rng.range(1.8, 3.6);
    g.fillStyle(shade(CLIFF_TOP, -0.34), 0.7);
    g.fillEllipse(tx + p.x, ty + p.y + 0.7, r * 2.4, r * 1.5);
    g.fillStyle(shade(CLIFF_TOP, -0.06), 1);
    g.fillEllipse(tx + p.x, ty + p.y, r * 2.2, r * 1.3);
    g.fillStyle(mix(shade(CLIFF_TOP, 0.2), RIM, 0.2), 1);
    g.fillEllipse(tx + p.x + r * 0.4, ty + p.y - r * 0.35, r * 1, r * 0.55);
  }

  // Outline only the edges that face open air, and put a broken lip on them so
  // the rim is rock rather than a drawn line.
  //
  // `brink` marks the two edges that actually have a drop under them — the tops
  // of the two drawn faces. Those get a narrow pale strip just inside the ink:
  // rock at a break is freshly exposed and has not weathered down to the colour
  // of the shelf behind it. The warm highlight that belongs to those edges is
  // NOT here; it is two pixels lower, on the face, drawn by wall(). See the note
  // there — it is the difference between light catching an edge and a bright hem
  // sewn onto a tablecloth.
  const edges = [
    [up(E), up(S), mask & 1, 1],
    [up(S), up(W), mask & 2, 1],
    [up(W), up(N), mask & 4, 0],
    [up(N), up(E), mask & 8, 0],
  ];
  for (const [a, b, joined, brink] of edges) {
    if (joined) continue;
    if (brink) {
      const inx = (cx - (a.x + b.x) / 2) * 0.085;
      const iny = (cy - CLIFF_H - (a.y + b.y) / 2) * 0.085;
      g.fillStyle(shade(CLIFF_TOP, 0.12), 0.6);
      g.fillPoints([a, b, { x: b.x + inx, y: b.y + iny }, { x: a.x + inx, y: a.y + iny }],
        true, true);
    }
    g.lineStyle(2.4, OUT, 1);
    roughLine(g, a, b, 1.15, rng, 5);
    // Chips knocked out of the rim, drawn inward so neighbouring tiles still
    // meet exactly at the shared corners. Sizes and positions now come off the
    // rng: three evenly spaced identical triangles per edge scalloped every
    // plateau in the game into the same pinking-shear zigzag.
    for (let k = 0, n = rng.int(2, 4); k < n; k++) {
      const t = rng.range(0.1, 0.82);
      const d = rng.range(0.1, 0.2);
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const inx = (cx - px) * rng.range(0.07, 0.15);
      const iny = (cy - CLIFF_H - py) * rng.range(0.07, 0.15);
      g.fillStyle(shade(CLIFF_TOP, rng.range(0.1, 0.26)), 1);
      g.fillTriangle(px, py, px + inx * 2, py + iny * 2,
        px + (b.x - a.x) * d, py + (b.y - a.y) * d);
    }
  }
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------
//
// One open cage of poles per footprint width, drawn *in front* of the building
// going up inside it. Open is the whole point: a solid hoarding would hide the
// progress the crop is there to show, and the player would be back to reading a
// number. Corner poles, two rings of ledgers, a brace on each visible face and a
// ladder — every one of those is a diagonal or a horizontal against a building
// made almost entirely of big flat planes, which is why a site is recognisable
// as a site at any zoom and from any direction.

const SCAFFOLD_POLE = 0x9a7442;
const SCAFFOLD_POLE_D = 0x6b4c25;

function buildScaffolds(put) {
  for (const fw of [1, 2, 3, 4]) {
    const hw = fw * HALF_W;
    const hh = fw * HALF_H;
    const H = 34 + fw * 13;
    // The cage reaches exactly hw either side of the tile centre and exactly H
    // above it, so the box is that plus a four-pixel margin. It used to carry
    // twelve pixels of air on every side, which on the 4x4 frame alone is eight
    // thousand wasted pixels — see the note on WALL_TEX about what that costs
    // once a frame is baked per footprint and per team.
    const w = hw * 2 + 8;
    const h = hh * 2 + H + 8;
    const ax = w / 2;
    const ay = h - 4 - hh;
    put(scaffoldFrame(fw), w, h, ax, ay, (g) => drawScaffold(g, ax, ay, hw, hh, H));
  }
}

function drawScaffold(g, cx, cy, hw, hh, H) {
  const N = { x: cx, y: cy - hh };
  const E = { x: cx + hw, y: cy };
  const S = { x: cx, y: cy + hh };
  const W = { x: cx - hw, y: cy };
  const up = (p, k) => ({ x: p.x, y: p.y - H * k });

  const pole = (p) => {
    stick(g, p.x, p.y, p.x, p.y - H, 3, SCAFFOLD_POLE);
    // Lashing at the head of each pole.
    g.fillStyle(0x3d2c18, 1);
    g.fillRect(p.x - 3, p.y - H + 3, 6, 2.2);
  };
  const ledger = (a, b, k) => {
    const p = up(a, k);
    const q = up(b, k);
    stick(g, p.x, p.y, q.x, q.y, 2.2, SCAFFOLD_POLE_D);
  };

  // Far side first, so the near poles overlap it.
  pole(N);
  ledger(W, N, 0.5);
  ledger(N, E, 0.5);
  ledger(W, N, 0.92);
  ledger(N, E, 0.92);
  pole(W);
  pole(E);

  // Braces on the two faces the camera can see.
  stick(g, W.x, W.y, S.x, S.y - H * 0.92, 2, SCAFFOLD_POLE_D);
  stick(g, E.x, E.y, S.x, S.y - H * 0.92, 2, SCAFFOLD_POLE_D);

  ledger(W, S, 0.5);
  ledger(S, E, 0.5);

  // Plank walkway around the near two faces, at the upper ledger.
  for (const [a, b] of [[W, S], [S, E]]) {
    const p = up(a, 0.92);
    const q = up(b, 0.92);
    const deck = [
      { x: p.x, y: p.y }, { x: q.x, y: q.y },
      { x: q.x, y: q.y + 4 }, { x: p.x, y: p.y + 4 },
    ];
    g.fillStyle(0xb08a52, 1);
    g.fillPoints(deck, true, true);
    g.lineStyle(1.6, OUT, 1);
    g.strokePoints(deck, true, true);
  }
  ledger(W, S, 0.92);
  ledger(S, E, 0.92);
  pole(S);

  // Ladder against the south-east face.
  const lx = S.x + hw * 0.34;
  const ly = S.y - hh * 0.34;
  const topX = lx + 5;
  const topY = ly - H * 0.98;
  stick(g, lx - 3, ly, topX - 3, topY, 1.8, SCAFFOLD_POLE);
  stick(g, lx + 3, ly, topX + 3, topY, 1.8, SCAFFOLD_POLE);
  g.lineStyle(1.6, SCAFFOLD_POLE_D, 1);
  for (let k = 1; k <= 5; k++) {
    const t = k / 6;
    const x = lx + (topX - lx) * t;
    const y = ly + (topY - ly) * t;
    g.beginPath();
    g.moveTo(x - 3.4, y);
    g.lineTo(x + 3.4, y);
    g.strokePath();
  }

  // Loose planks stacked at the west corner: something on the ground as well
  // as in the air, and a second silhouette cue at ground level for a site whose
  // cage is hidden behind the building it surrounds.
  for (let k = 0; k < 3; k++) {
    const px = W.x + 8 + k * 2;
    const py = W.y - k * 3;
    g.fillStyle(0xa87f49, 1);
    g.fillPoints([
      { x: px, y: py }, { x: px + 16, y: py + 8 },
      { x: px + 16, y: py + 11 }, { x: px, y: py + 3 },
    ], true, true);
    g.lineStyle(1.4, OUT, 1);
    g.strokePoints([
      { x: px, y: py }, { x: px + 16, y: py + 8 },
      { x: px + 16, y: py + 11 }, { x: px, y: py + 3 },
    ], true, true);
  }
}

// ---------------------------------------------------------------------------
// Unit ground markers + selection
// ---------------------------------------------------------------------------

function buildMarkers(put) {
  // The team ellipse under each unit. This single element does more for
  // small-screen readability than anything else on the unit.
  for (let p = 0; p < PLAYER_COLORS.length; p++) {
    const col = PLAYER_COLORS[p];
    const dark = PLAYER_COLORS_DARK[p];
    put(markerFrame(p), 40, 26, 20, 13, (g) => {
      // The unit's contact shadow lives here rather than on the body sprite,
      // and it has to, because the body is drawn ON TOP of this disc: a shadow
      // baked into the body would sit over the team colour and muddy the one
      // element that makes a 30-pixel unit findable on a phone. Down here it is
      // under everything, it is soft, and it is offset away from the sun like
      // every other shadow in the file — which is what stops a unit looking
      // like a sticker laid on the map.
      contactShadow(g, 20, 15, 30, 15, 1.2);
      g.fillStyle(0x000000, 0.18);
      g.fillEllipse(20, 14.5, 31, 15);
      g.fillStyle(OUT, 0.9);
      g.fillEllipse(18, 11, 28, 14);
      g.fillStyle(dark, 1);
      g.fillEllipse(18, 11, 25, 12);
      g.fillStyle(col, 1);
      g.fillEllipse(18, 10.4, 20, 9);
      g.fillStyle(shade(col, 0.45), 0.65);
      g.fillEllipse(18, 8.8, 12, 4);
    });
  }

  // Selection ring. Drawn white so one frame serves every relationship — the
  // renderer tints it gold for your own, red for a hostile, blue for anything
  // else — with the dark under-stroke dark enough to survive being multiplied
  // by any of them. The four ticks are what separate it at a glance from the
  // team ellipse it sits on: an ellipse inside an ellipse is a fat outline, an
  // ellipse with marks at the compass points is a *reticle*.
  put('mk_sel', 48, 30, 24, 15, (g) => {
    g.lineStyle(5.5, 0x120f0a, 0.7);
    g.strokeEllipse(24, 15, 37, 18.5);
    g.lineStyle(3, 0xffffff, 1);
    g.strokeEllipse(24, 15, 37, 18.5);
    g.lineStyle(1.3, 0xffffff, 0.5);
    g.strokeEllipse(24, 15, 31, 15);
    g.fillStyle(0x120f0a, 0.8);
    for (const [dx, dy] of [[-18.5, 0], [18.5, 0], [0, -9.2], [0, 9.2]]) {
      g.fillCircle(24 + dx, 15 + dy, 3.2);
    }
    g.fillStyle(0xffffff, 1);
    for (const [dx, dy] of [[-18.5, 0], [18.5, 0], [0, -9.2], [0, 9.2]]) {
      g.fillCircle(24 + dx, 15 + dy, 2.2);
    }
  });

  // The ring that swells out of the selection once a second.
  put('mk_sel_halo', 48, 30, 24, 15, (g) => {
    g.lineStyle(2.6, 0xffffff, 1);
    g.strokeEllipse(24, 15, 37, 18.5);
  });
}

// ---------------------------------------------------------------------------
// FX bits
// ---------------------------------------------------------------------------

/**
 * Bake the twelve glyphs the floating labels need. See GLYPHS above for why
 * these are in the atlas at all rather than being Phaser Text.
 *
 * `measure` is the atlas's own context, borrowed only for its font metrics: the
 * cell each glyph is packed into has to be exactly as wide as the browser will
 * draw it, or the layout in fx.js would be spacing letters against numbers this
 * file guessed at.
 */
function buildGlyphs(putCanvas, measure) {
  const FONT = `700 ${GLYPH_PX}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  // The outline is what makes a number legible over grass, over a roof and over
  // a fog edge alike; without it a light number vanishes on sand and a dark one
  // vanishes in a forest. Four baked pixels is the same weight the Text version
  // used, scaled up with the glyph.
  const STROKE = 5;
  const PAD = Math.ceil(STROKE / 2) + 1;

  measure.save();
  measure.font = FONT;
  const m = measure.measureText('0');
  // actualBoundingBox* is what the glyph really covers; the font's declared
  // ascent leaves a band of empty pixels above every number, and at this scale
  // that band is a third of the cell.
  const ascent = Math.ceil(m.actualBoundingBoxAscent || GLYPH_PX * 0.72);
  const descent = Math.ceil(m.actualBoundingBoxDescent || 0);
  const cellH = ascent + descent + PAD * 2;
  const baseline = ascent + PAD;
  const advances = [];
  for (const ch of GLYPHS) advances.push(Math.ceil(measure.measureText(ch).width));
  measure.restore();

  GLYPH_METRICS.height = cellH;
  GLYPH_METRICS.baseline = baseline;

  [...GLYPHS].forEach((ch, i) => {
    const adv = advances[i];
    const cellW = adv + PAD * 2;
    GLYPH_METRICS.advance.set(ch, adv);
    // Anchored on the glyph's horizontal centre and on the baseline, so fx.js
    // lays a string out by advancing a cursor and never has to know a cell size.
    putCanvas(glyphFrame(ch), cellW, cellH, cellW / 2, baseline, (c) => {
      c.font = FONT;
      c.textAlign = 'center';
      c.textBaseline = 'alphabetic';
      c.lineJoin = 'round';
      c.miterLimit = 2;
      c.lineWidth = STROKE;
      c.strokeStyle = '#100c07';
      c.strokeText(ch, cellW / 2, baseline);
      c.fillStyle = '#ffffff';
      c.fillText(ch, cellW / 2, baseline);
    });
  });
}

/**
 * The FX sheet.
 *
 * Everything that flies used to be `fx_arrow`, which meant a mangonel's boulder
 * and a monk's blessing were both a fletched shaft — the two loudest events in
 * a battle, drawn as the quietest one. The frames below are the missing
 * vocabulary, and they are cheap: the whole set is under thirty thousand pixels,
 * a hundredth of the sheet.
 *
 * Anything meant to be tinted at runtime is drawn white or near-white, because
 * tint is a multiply and nothing can be made brighter than what is baked. The
 * boulder and the bolt are the exceptions — they are objects with their own
 * material, not washes of light, and they should look the same whoever fired
 * them.
 */
function buildFx(put) {
  // --- the chimney plume ----------------------------------------------------
  //
  // Five puffs on one shared lifecycle, offset a fifth of a cycle apart, and
  // the frame index advances the whole set by a quarter of that fifth. Because
  // the fifth puff's phase is the first puff's plus one, the fourth frame runs
  // straight back into the first with nothing jumping — a loop that has to be
  // crossfaded is a loop that was built wrong.
  //
  // Each puff grows, drifts to the sunward side and fades as it climbs, which
  // is the whole of what makes a column of ellipses read as smoke rather than
  // as a string of beads. It fades IN over the first fifth of its life too:
  // without that, a puff appears at full opacity out of nothing at the flue,
  // and the eye catches the pop every cycle.
  const SW = 52;
  const SH = 66;
  for (let f = 0; f < SMOKE_FRAMES; f++) {
    put(smokeFrame(f), SW, SH, 15, SH - 2, (g) => {
      for (let k = 0; k < 5; k++) {
        const t = ((k + f / SMOKE_FRAMES) / 5) % 1;
        const x = 15 + t * 21 + Math.sin(t * 5.2) * 3.5;
        const y = SH - 4 - t * 58;
        const r = 4.5 + t * 10;
        const a = 0.4 * Math.min(1, t * 5) * (1 - t) ** 0.75;
        g.fillStyle(0xe8e2d6, a);
        g.fillEllipse(x, y, r * 2, r * 1.5);
        g.fillStyle(0xffffff, a * 0.55);
        g.fillEllipse(x + r * 0.24, y - r * 0.28, r * 1.05, r * 0.75);
      }
    });
  }

  put('fx_spark', 20, 20, 10, 10, (g) => {
    g.fillStyle(0xffffff, 1);
    const pts = [];
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i;
      const r = i % 2 === 0 ? 9.5 : 3.4;
      pts.push({ x: 10 + Math.cos(a) * r, y: 10 + Math.sin(a) * r });
    }
    g.fillPoints(pts, true, true);
  });

  put('fx_puff', 24, 24, 12, 12, (g) => {
    g.fillStyle(0xffffff, 0.28);
    g.fillCircle(12, 12, 11);
    g.fillStyle(0xffffff, 0.42);
    g.fillCircle(12, 12, 8);
    g.fillStyle(0xffffff, 0.75);
    g.fillCircle(12, 12, 4.5);
  });

  put('fx_chip', 8, 8, 4, 4, (g) => {
    g.fillStyle(0x000000, 0.55);
    g.fillRoundedRect(0.5, 0.5, 7, 7, 1.5);
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(1.5, 1.5, 5, 5, 1.2);
  });

  put('fx_arrow', 26, 10, 13, 5, (g) => {
    g.lineStyle(4, OUT, 1);
    g.beginPath();
    g.moveTo(3, 5);
    g.lineTo(21, 5);
    g.strokePath();
    g.lineStyle(2, 0xd8b070, 1);
    g.beginPath();
    g.moveTo(3, 5);
    g.lineTo(21, 5);
    g.strokePath();
    g.fillStyle(0xe6ebf0, 1);
    g.fillTriangle(19, 1.5, 25.5, 5, 19, 8.5);
    g.lineStyle(1.2, OUT, 1);
    g.strokeTriangle(19, 1.5, 25.5, 5, 19, 8.5);
    g.fillStyle(0xf2f2f2, 1);
    g.fillTriangle(0.5, 1, 6, 5, 0.5, 9);
  });

  // Iso ring used for command pings and "built" pulses (tinted at runtime).
  put('fx_ring', 68, 38, 34, 19, (g) => {
    g.lineStyle(6, 0x000000, 0.28);
    g.strokeEllipse(34, 19, 56, 28);
    g.lineStyle(4, 0xffffff, 1);
    g.strokeEllipse(34, 19, 56, 28);
  });

  // The marker standing on a rally point. Anchored at the foot of the pole so
  // it plants on the ground rather than hovering over it, and drawn white so
  // the renderer can tint it.
  put('fx_flag', 24, 40, 5, 37, (g) => {
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(7, 37, 16, 7);
    stick(g, 5, 36, 5, 5, 2.2, 0xffffff);
    g.fillStyle(0x120f0a, 1);
    g.fillPoints([
      { x: 4, y: 4 }, { x: 22, y: 10 }, { x: 4, y: 17 },
    ], true, true);
    g.fillStyle(0xffffff, 1);
    g.fillPoints([
      { x: 5.5, y: 6 }, { x: 19, y: 10.4 }, { x: 5.5, y: 15 },
    ], true, true);
  });

  // Chevron used inside the move ping.
  put('fx_dot', 14, 14, 7, 7, (g) => {
    g.fillStyle(0x000000, 0.35);
    g.fillCircle(7, 7.6, 5.6);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(7, 7, 5);
  });

  // --- the new projectiles ---------------------------------------------------

  // The mangonel's boulder. Round, heavy, lit from the upper right like every
  // other solid in the game, with a couple of chipped facets so it tumbles
  // legibly when the renderer spins it. Anchored dead centre for that reason.
  put('fx_boulder', 22, 22, 11, 11, (g) => {
    g.fillStyle(OUT, 1);
    g.fillCircle(11, 11, 10);
    g.fillStyle(0x6b7480, 1);
    g.fillCircle(11, 11, 8.6);
    g.fillStyle(0x848d9a, 1);
    g.fillCircle(12, 9.6, 6.4);
    g.fillStyle(0xa3adba, 1);
    g.fillCircle(13, 8.4, 3.4);
    g.fillStyle(0x525a66, 1);
    g.fillTriangle(5, 14, 10, 16, 6, 10);
    g.fillTriangle(14, 17, 18, 13, 17, 17);
  });

  // The scorpion's bolt: a heavier, shorter, iron-headed shaft than the arrow,
  // with a flat pair of vanes rather than a feather. It has to be different from
  // fx_arrow in flight or the two engines' fire reads as one.
  put('fx_bolt', 30, 10, 15, 5, (g) => {
    g.lineStyle(5, OUT, 1);
    g.beginPath();
    g.moveTo(4, 5);
    g.lineTo(23, 5);
    g.strokePath();
    g.lineStyle(3, 0xb08a52, 1);
    g.beginPath();
    g.moveTo(4, 5);
    g.lineTo(23, 5);
    g.strokePath();
    g.fillStyle(0x5a626e, 1);
    g.fillTriangle(20, 0.5, 29.5, 5, 20, 9.5);
    g.lineStyle(1.3, OUT, 1);
    g.strokeTriangle(20, 0.5, 29.5, 5, 20, 9.5);
    g.fillStyle(0x9aa4b0, 1);
    g.fillTriangle(21, 3, 26.5, 5, 21, 6);
    // Flat vanes.
    g.fillStyle(0xd8d2c2, 1);
    g.fillPoints([{ x: 0.5, y: 1 }, { x: 7, y: 4 }, { x: 7, y: 6 }, { x: 0.5, y: 9 }],
      true, true);
    g.lineStyle(1.1, OUT, 1);
    g.strokePoints([{ x: 0.5, y: 1 }, { x: 7, y: 4 }, { x: 7, y: 6 }, { x: 0.5, y: 9 }],
      true, true);
  });

  // --- the new washes --------------------------------------------------------

  // Smoke. Bigger, lumpier and much softer than fx_puff, which is a hit spark's
  // worth of dust; this is what comes off a burning building or the wheels of a
  // siege engine, and it wants to be scaled up and faded out over a second or
  // two. Four overlapping lobes rather than concentric circles, so a stack of
  // them at different rotations never shows a ring.
  put('fx_smoke', 40, 40, 20, 20, (g) => {
    const lobes = [[20, 21, 15], [13, 17, 11], [27, 18, 10], [21, 13, 9]];
    for (const [x, y, r] of lobes) {
      g.fillStyle(0xffffff, 0.16);
      g.fillCircle(x, y, r);
    }
    for (const [x, y, r] of lobes) {
      g.fillStyle(0xffffff, 0.2);
      g.fillCircle(x - 1, y - 1.5, r * 0.66);
    }
    g.fillStyle(0xffffff, 0.28);
    g.fillCircle(19, 17, 6);
  });

  // Flame. Drawn as a teardrop with a hot core, in three layers from a deep
  // ember through orange to a near-white heart — NOT white-to-be-tinted, because
  // a fire that takes a tint is a fire somebody will accidentally make blue, and
  // the one thing a flame has to be is the same colour every time. Anchored at
  // its base so it can be planted on a roof rather than floating over one.
  put('fx_flame', 22, 32, 11, 30, (g) => {
    const tongue = (w, h, col, a) => {
      g.fillStyle(col, a);
      g.fillPoints([
        { x: 11, y: 30 },
        { x: 11 - w, y: 30 - h * 0.42 },
        { x: 11 - w * 0.5, y: 30 - h * 0.82 },
        { x: 11, y: 30 - h },
        { x: 11 + w * 0.5, y: 30 - h * 0.82 },
        { x: 11 + w, y: 30 - h * 0.42 },
      ], true, true);
    };
    tongue(10, 29, 0xc23a12, 0.85);
    tongue(7.4, 23, 0xf07c1e, 0.95);
    tongue(4.6, 15, 0xffd86a, 1);
  });

  // The monk's heal: a warm ring of light with a cross inside it, which is the
  // one symbol on the map that means "this is help, not harm". White so the
  // renderer can tint it — a gold for a heal that landed, a paler wash for a
  // heal in progress.
  put('fx_heal', 30, 30, 15, 15, (g) => {
    g.lineStyle(4.5, 0xffffff, 0.22);
    g.strokeCircle(15, 15, 12);
    g.lineStyle(2, 0xffffff, 0.55);
    g.strokeCircle(15, 15, 12);
    g.fillStyle(0xffffff, 0.18);
    g.fillCircle(15, 15, 10);
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(12.4, 6, 5.2, 18, 1.6);
    g.fillRoundedRect(6, 12.4, 18, 5.2, 1.6);
  });
}
