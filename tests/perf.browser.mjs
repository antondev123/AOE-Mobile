// The performance guard.
//
//   node tests/perf.browser.mjs [--frames 240] [--verbose]
//
// WHAT THIS MEASURES, AND WHY IT IS NOT A FRAME-TIME BUDGET
// --------------------------------------------------------
// Every browser test in this repo runs Chromium with `--use-gl=swiftshader`:
// software rasterisation, no GPU whatsoever. The target device is a mid-range
// Android phone, which has a real one. The two machines are not comparable in
// the way that matters most to a renderer — fill rate. Blending a screen full
// of alpha-heavy quads costs a swiftshader frame tens of milliseconds and costs
// an Adreno 6xx a fraction of one, while the JavaScript on either side of that
// runs at broadly similar speed.
//
// So a wall-clock assertion here would be a statement about this build machine
// and nothing else. Tighten it and you fail honest work; loosen it until it
// passes and you have asserted nothing. Either way it does not answer the
// question anybody is asking, which is whether the game holds 60fps on a phone.
//
// This test therefore asserts the four things that *do* transfer:
//
//   1. CPU milliseconds per frame, per phase, from the profiler in
//      core/perf.js. JavaScript is JavaScript; a phone's big core is within a
//      small factor of this machine's, and the phases are named so a regression
//      says which system caused it.
//   2. Draw calls per frame. One atlas means one batch; the number only rises
//      when something breaks the batch, and a broken batch is expensive on
//      every GPU ever made.
//   3. Game Objects touched per frame. This is the scene graph's per-frame
//      walk, the quad count, and the transform work, all in one integer, and it
//      is the number the view cull exists to hold down.
//   4. Bytes allocated per frame. Steady-state garbage is the difference
//      between a smooth 60 and a 60 with a hitch in it every few seconds, and
//      it is completely invisible to a median frame time.
//
// The wall-clock number is still printed, clearly labelled as a swiftshader
// number, because it is useful for spotting a change of an order of magnitude.
// It is not asserted on.
//
// The scenario is deliberately the worst honest frame in the game: 160-odd
// units, two armies in contact so combat, damage numbers, sparks, corpses and
// projectiles are all live, villagers still gathering, fog updating every step
// because a hundred units are crossing tile boundaries, the minimap redrawing
// at its full rate and the HUD holding a live selection.

import { pathToFileURL } from 'node:url';
import { boot } from './harness.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const FRAMES = Number(arg('frames', 240));
const VERBOSE = args.includes('--verbose');

const failures = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
}

// --- Budgets ---------------------------------------------------------------
//
// Every one of these is set against a measurement, with headroom stated. The
// reference is the profile in CHANGELOG.md's Performance section.
//
// THE MEASUREMENT THE FRAME BUDGET IS MADE OF
// -------------------------------------------
// A rendered frame here takes 40-60ms, because swiftshader is doing the
// rasterising. The simulation still runs at its fixed 20Hz, so *three* fixed
// steps land inside one of these frames — where a device actually holding 60fps
// would take at most one. Reading the raw per-frame sim number off this machine
// therefore triples it.
//
// So the budget is built out of the two pieces that do transfer, and put back
// together the way a 60fps frame would be:
//
//   per-frame work   input + render + hud, which happen once a frame wherever
//                    the game runs
//   per-step work    one fixed simulation step, of which a 60fps frame does one
//                    at most (20Hz sim, 60Hz display: two frames in three do
//                    none at all)
//
// `projected` below is the sum: the CPU cost of the worst kind of frame a phone
// at 60fps can have, which is a frame that both draws and steps.
//
// WHICH INSTRUMENT ASSERTS WHAT
// -----------------------------
// This runs inside a Chromium spending forty milliseconds a frame in a software
// rasteriser, on a build box that may be doing other things. A process
// descheduled mid-frame charges that time to whatever phase was running, so the
// mean and the p95 of any phase here move by fifty per cent with the weather —
// measured at 4.5ms projected on an idle box and 6.5ms on a loaded one, for
// identical code.
//
// Two things follow. First, the *simulation's* cost is asserted by
// tests/simperf.test.mjs instead, which runs the same battle with no browser at
// all and moves by under five per cent between runs. That is the instrument for
// catching a small regression. Second, what is asserted here is the drawing
// half — input, render, HUD — using the low quartile of each phase, because
// contention can only add to a sample and never subtract from it (see p25 in
// core/perf.js).
//
// The per-frame drawing half measured 1.5-1.7ms at the low quartile with 216
// units in a pitched battle. 3.5ms is more than double, which is the margin a
// mid-range phone's slower core needs, and it is a quarter of the 16.7ms frame
// — leaving the sim step, the browser's compositor, the WebGL driver and the
// audio graph the rest.
const DRAW_CPU_MS = 3.5;
// The same three phases at the p95: the frames where the fog texture is
// re-uploaded or the minimap redraws. Those are allowed to be dearer, but not so
// much dearer that one of them drops a frame on its own. Measured at 2-4ms.
const DRAW_CPU_P95_MS = 8.0;
// Draw calls. One atlas is one batch; everything above that is a texture bind
// somebody has forced. Measured at 37 before this pass and 16 after — the
// difference is the floating damage numbers, which were Phaser Text objects
// carrying a canvas texture apiece, and the baked terrain chunks, which are one
// texture each and were all being submitted whether or not the camera could see
// them. What is left is the visible terrain chunks, the fog quad, the two
// overlay Graphics and the sprite batch. 24 leaves room for a deeper zoom-out
// reaching more chunks and fails the moment a per-sprite texture comes back.
// 30, raised from 24, and the reason is written down here rather than left as a
// number somebody nudged.
//
// The old figure was set when the only things in the display list were the
// visible terrain chunks, the fog quad, two overlay Graphics and one sprite
// batch, and its stated purpose was to "fail the moment a per-sprite texture
// comes back". It has since been failed by something that is not that: rock
// outcrops are a new depth-sorted terrain layer, drawn as sprites because a
// unit has to be able to walk in front of one and behind another, and measuring
// the stress scenario with and without them puts their cost at 3.8 calls.
//
// Raising a budget because the thing under it got slower is usually how a
// budget dies, so the real invariant it was proxying for is now asserted
// directly, one check below: exactly one sprite texture in the display list. A
// per-sprite texture cannot come back without failing that, whatever this
// number is set to. What is left here is a coarse ceiling on how many times the
// batch may be flushed, and 30 against a measured 25.7 leaves the same
// proportional headroom 24 left against 16.
const DRAW_CALLS = 30;
// Textures the display list is allowed to reference: the one procedural atlas,
// the fog canvas, and the baked terrain chunks (one RenderTexture each, which is
// the whole point of chunking them). Anything else is a sprite that has brought
// its own texture along, which is the regression that actually matters.
const SPRITE_TEXTURES = 1;
// Game Objects touched per frame: sprites positioned, plus live particles,
// glyphs and arrows. The camera at the default zoom on a 390px phone holds about
// 26x14 tiles, so this counts a couple of hundred visible bodies and their
// ground markers, the terrain under them and whatever the fight is throwing
// about — and it must never count the map's 1900 trees, or the memory ghosts of
// the ones the player has walked past. Measured at 560-670 either side of this
// pass with 216 units on screen; the number did not fall because it was already
// culled, and it did not rise much either, even though a `-12` is now three
// quads instead of one Text. 900 fails if the view cull is ever lost.
const OBJECTS = 900;
// Bytes of garbage per frame in the steady state, as measured by V8's sampling
// allocation profiler. Not zero, and it never will be: Phaser allocates inside
// its own batcher and its input plumbing, and the simulation legitimately
// allocates a path array on the steps where somebody re-plans. What matters is
// that nothing allocates *per entity per frame*, which is the thing that turns
// into a visible hitch. Measured at 1.2-2.0kB/frame both before and after this
// pass — the frame loop was already clean, and the pass kept it that way while
// removing the per-unit frame-name strings and the two per-step unit snapshots.
// 6kB is the ceiling; at 60fps that is 360kB/s, a young-generation collection
// every several seconds, and those are sub-millisecond.
const BYTES_PER_FRAME = 6 * 1024;

// --- The scenario ----------------------------------------------------------
//
// Exported so a future test can stage the same fight without copying it.
export const STRESS = ({ armySize }) => {
  const g = window.__game;
  const w = g.world;
  const W = window.__world;
  const tc = [...w.players[0].owned].map((id) => w.entities.get(id))
    .find((e) => e && e.type === 'towncenter');
  const gx = Math.round(tc.x);
  const gy = Math.round(tc.y);

  // Two armies drawn up facing each other, a few tiles apart, so they close and
  // are in contact within a second of the sim running.
  const mine = [];
  const theirs = [];
  const kinds = ['militia', 'spearman', 'archer', 'scout'];
  for (let i = 0; i < armySize; i++) {
    const col = i % 10;
    const row = Math.floor(i / 10);
    mine.push(W.spawnUnit(w, kinds[i % kinds.length], 0,
      gx - 5 + col * 0.9, gy + 4 + row * 0.9));
    theirs.push(W.spawnUnit(w, kinds[(i + 2) % kinds.length], 1,
      gx - 5 + col * 0.9, gy + 12 + row * 0.9));
  }
  // Villagers, so the gather loop, the carry indicators and the deposit
  // effects are all in the frame too.
  for (let i = 0; i < 40; i++) {
    W.spawnUnit(w, 'villager', 0, gx - 8 + (i % 8) * 0.8, gy - 8 + Math.floor(i / 8) * 0.8);
  }
  w.players[0].popCap = 400;
  w.players[1].popCap = 400;

  // Send them at each other. attackMove is the order that keeps both the walk
  // and the fight live for the whole run rather than resolving into a standoff.
  g.command(mine, { type: 'attackMove', x: gx - 1, y: gy + 16 });
  g.command(theirs, { type: 'attackMove', x: gx - 1, y: gy + 2 });

  // A live selection, so the HUD's selection panel and its health bars are
  // being refreshed every frame rather than short-circuiting on an empty one.
  w.selection.clear();
  for (let i = 0; i < 12; i++) w.selection.add(mine[i].id);
  w.events.emit('selection', { ids: [...w.selection] });

  g.renderer.centerOn(gx - 1, gy + 8);
  g.renderer.camera.setZoom(0.7);
  return { gx, gy };
};

/** Let the page run for `frames` animation frames. Returns the wall deltas. */
export const RUN_FRAMES = async (frames) => {
  const out = [];
  let last = performance.now();
  await new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      const now = performance.now();
      out.push(now - last);
      last = now;
      if (++n >= frames) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return out;
};

/** Run the game for `frames` frames with the profiler on, and report. */
export const MEASURE = async (frames) => {
  const g = window.__game;
  const gl = g.scene.game.renderer.gl;

  let calls = 0;
  const de = gl.drawElements.bind(gl);
  const da = gl.drawArrays.bind(gl);
  gl.drawElements = (...a) => { calls++; return de(...a); };
  gl.drawArrays = (...a) => { calls++; return da(...a); };

  const mem = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
  if (window.gc) window.gc();

  const unitsAtStart = g.world.units.length;
  g.perf.enable(true);
  const heap0 = mem();
  const wall = await window.__runFrames(frames);
  const heap1 = mem();
  g.perf.enable(false);
  gl.drawElements = de;
  gl.drawArrays = da;

  // The first 30 frames are the scenario settling: the terrain chunks under the
  // new camera position are baked on the first of them, the armies have not met
  // yet, and the HUD is doing its one full layout. Everything after that is the
  // frame the player actually lives in.
  const SKIP = 30;
  const report = g.perf.report(SKIP);
  const kept = wall.slice(SKIP).sort((a, b) => a - b);

  return {
    unitsAtStart,
    units: g.world.units.length,
    projectiles: g.world.projectiles.length,
    slots: report,
    drawCallsPerFrame: calls / wall.length,
    wallMedianMs: kept[Math.floor(kept.length / 2)],
    wallP95Ms: kept[Math.floor(kept.length * 0.95)],
    // Heap growth over the window. Printed as a cross-check only: it moves by a
    // factor of two between identical runs, because what it really measures is
    // where the collector happened to run, and it cannot tell garbage from
    // something the game legitimately kept. The number asserted on comes from
    // the sampling profiler, which measures allocation directly.
    heapGrowthPerFrame: heap1 > heap0 ? (heap1 - heap0) / wall.length : 0,
    frames: wall.length,
    displayObjects: g.scene.children ? g.scene.children.list.length : 0,
  };
};

const ms = (v) => `${v.toFixed(2)}ms`;

const run = async () => {
  const h = await boot({
    // Byte-accurate heap readings and a collector we can drive, so "bytes
    // allocated per frame" is a measurement rather than a guess at the size of
    // Chrome's 100kB reporting buckets.
    args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
  });
  const { page, errors } = h;

  try {
    await page.evaluate(async () => {
      window.__world = await import('/src/core/world.js');
    });

    await page.exposeFunction('__unused', () => {});
    await page.evaluate(`window.__runFrames = ${RUN_FRAMES.toString()}`);

    const at = await page.evaluate(STRESS, { armySize: 85 });
    // Let the armies close and the fight start before the window opens.
    await page.waitForTimeout(1500);

    // Timing first, with no profiler attached. V8's allocation sampler adds
    // several milliseconds a frame of its own, and a CPU budget measured with an
    // instrument sitting on the scales is not a CPU budget.
    const p = await page.evaluate(MEASURE, FRAMES);

    // What textures the display list actually references, split by object kind.
    // Cheap, and taken once after the stress window rather than per frame — a
    // sprite that brought its own texture along is a structural fact about the
    // renderer, not something that comes and goes between frames.
    const textures = await page.evaluate(() => {
      const scene = window.__phaser.scene.scenes[0];
      const sprite = new Set();
      let images = 0;
      for (const o of scene.children.list) {
        if (!o.visible) continue;
        if (o.type !== 'Image' && o.type !== 'Sprite') continue;
        images++;
        if (o.texture && o.texture.key) sprite.add(o.texture.key);
      }
      return { sprite: [...sprite], images };
    });

    // Then a second, shorter window for allocation. Measured with the sampling
    // allocation profiler rather than by watching usedJSHeapSize: the heap
    // reading is a function of when the collector last ran and swings by a
    // factor of two between identical runs, whereas this samples every Nth byte
    // allocated and can say *where* it came from.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 2048 });
    const allocFrames = await page.evaluate(
      (n) => window.__runFrames(n).then((w) => w.length), 150,
    );
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    await cdp.send('HeapProfiler.disable');

    const sites = new Map();
    let allocated = 0;
    (function walk(node) {
      const self = node.selfSize || 0;
      if (self) {
        const cf = node.callFrame;
        const url = String(cf.url).replace(/^https?:\/\/[^/]+/, '') || '(native)';
        const key = `${cf.functionName || '(anon)'} ${url}:${cf.lineNumber + 1}`;
        sites.set(key, (sites.get(key) || 0) + self);
        allocated += self;
      }
      for (const c of node.children || []) walk(c);
    }(profile.head));
    p.bytesPerFrame = allocated / allocFrames;
    p.topSites = [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([k, v]) => [k, v / allocFrames]);

    const slot = (name) => p.slots[name] || { median: 0, p95: 0, mean: 0, max: 0 };
    const order = [
      'scene.update', 'sim', 'sim.reindex', 'sim.allocation', 'sim.units',
      'sim.units.act', 'sim.units.separate', 'sim.combat', 'sim.economy', 'sim.enemyAI', 'sim.vision',
      'input', 'render', 'render.terrain', 'render.cliffs', 'render.resources',
      'render.buildings', 'render.units', 'render.memory', 'render.fog',
      'render.fx', 'hud', 'hud.dom', 'hud.minimap', 'audio',
    ];

    console.log(`\n  stress: ${p.unitsAtStart} units at the top of the window, ` +
      `${p.units} still alive at the end, battle at ${at.gx},${at.gy}, ` +
      `${p.projectiles} projectiles in flight, ${p.displayObjects} display objects\n`);
    console.log('  phase                 median      p95      max');
    for (const name of order) {
      const s = p.slots[name];
      if (!s) continue;
      if (!VERBOSE && s.median < 0.005 && s.p95 < 0.02) continue;
      console.log(`  ${name.padEnd(20)} ${ms(s.median).padStart(8)} ` +
        `${ms(s.p95).padStart(8)} ${ms(s.max).padStart(8)}`);
    }
    // Rebuild a 60fps frame out of the pieces. See the budget notes above.
    const steps = slot('sim.steps').mean || 1;
    const simPerStep = slot('sim').mean / steps;
    const drawCpu = slot('input').p25 + slot('render').p25 + slot('hud').p25;
    const drawCpuMean = slot('input').mean + slot('render').mean + slot('hud').mean;
    const drawCpuP95 = slot('input').p95 + slot('render').p95 + slot('hud').p95;

    const objects = slot('objects');
    console.log(`\n  fixed steps per rendered frame here: ${steps.toFixed(2)} ` +
      `(a phone at 60fps does at most 1)`);
    console.log(`  one sim step           ${ms(simPerStep)}` +
      '   <- asserted by tests/simperf.test.mjs, which measures it quietly');
    console.log(`  draw + hud + input     ${ms(drawCpu)} low quartile, ` +
      `${ms(drawCpuMean)} mean, ${ms(drawCpuP95)} p95`);
    console.log(`  projected 60fps frame  ${ms(drawCpu + simPerStep)}` +
      '   <- one draw plus at most one sim step: the CPU number that transfers');
    console.log(`\n  objects touched/frame  median ${objects.median.toFixed(0)}` +
      `  p95 ${objects.p95.toFixed(0)}  max ${objects.max.toFixed(0)}`);
    console.log(`  draw calls/frame       ${p.drawCallsPerFrame.toFixed(1)}`);
    console.log(`  allocation/frame       ${(p.bytesPerFrame / 1024).toFixed(1)}kB sampled` +
      `  (heap growth ${(p.heapGrowthPerFrame / 1024).toFixed(1)}kB, noisy)`);
    console.log(`  wall clock             median ${ms(p.wallMedianMs)}  ` +
      `p95 ${ms(p.wallP95Ms)}   <- swiftshader, no GPU: not a phone number`);
    if (VERBOSE) {
      console.log('\n  where the garbage comes from:');
      for (const [site, bytes] of p.topSites) {
        console.log(`  ${bytes.toFixed(0).padStart(6)} B/frame  ${site}`);
      }
    }
    console.log('');

    check('the stress scenario really is 150+ units', p.units >= 150,
      `${p.unitsAtStart} at the top, ${p.units} left at the end`);

    check('drawing a frame stays inside a quarter of the 60fps budget',
      drawCpu < DRAW_CPU_MS, `${ms(drawCpu)} low quartile, budget ${DRAW_CPU_MS}ms`);
    check('the expensive frames do not drop one on their own',
      drawCpuP95 < DRAW_CPU_P95_MS, `${ms(drawCpuP95)} p95, budget ${DRAW_CPU_P95_MS}ms`);
    check('the batch is not being broken per sprite',
      p.drawCallsPerFrame < DRAW_CALLS, `${p.drawCallsPerFrame.toFixed(1)} calls`);
    // The invariant the call count was standing in for. Every Image in the
    // display list must come out of the one atlas; RenderTextures (the terrain
    // chunks) and the fog Container are counted separately because they are
    // supposed to have their own.
    check('every sprite still comes from the one atlas',
      textures.sprite.length === SPRITE_TEXTURES,
      textures.sprite.length === SPRITE_TEXTURES
        ? `${textures.images} images, all from ${textures.sprite[0]}`
        : `expected 1 sprite texture, found ${textures.sprite.length}: ${textures.sprite.join(', ')}`);
    check('only what the camera can see is drawn',
      objects.p95 < OBJECTS, `${objects.p95.toFixed(0)} objects touched, budget ${OBJECTS}`);
    check('the frame loop is not making garbage',
      p.bytesPerFrame > 0 && p.bytesPerFrame < BYTES_PER_FRAME,
      `${(p.bytesPerFrame / 1024).toFixed(1)}kB/frame, budget ${(BYTES_PER_FRAME / 1024).toFixed(0)}kB`);

    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await h.close();
  }

  console.log('');
  if (failures.length) {
    console.log(`${failures.length} failure(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('performance guard passed\n');
};

// STRESS and MEASURE are exported so another harness can stage the same fight
// (the allocation profiler does), which means this file can be imported — so it
// only runs itself when it is the thing that was invoked.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
