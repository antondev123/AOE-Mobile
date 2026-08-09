// Per-frame CPU profiler.
//
// No Phaser imports: this is core, and the systems that call it have to keep
// running under Node.
//
// WHY THIS EXISTS
// ---------------
// The only machine this project can measure itself on is a headless Chromium
// running `--use-gl=swiftshader` — software rasterisation, no GPU at all. That
// makes every wall-clock frame number a statement about a CPU pretending to be
// a graphics card, and a mid-range Android phone has a real one. Fill rate and
// overdraw there are enormously cheaper than they are here; JavaScript is
// roughly the same speed.
//
// So the numbers this file collects are the ones that *transfer*: how many
// milliseconds of JavaScript each phase of a frame costs, how many Game Objects
// the renderer touched, and how many bytes the frame allocated. A frame that is
// cheap by those measures is cheap on a phone whatever swiftshader says about
// it. See tests/perf.browser.mjs, which asserts exactly these and deliberately
// does not assert a wall-clock budget.
//
// COST WHEN OFF
// -------------
// Two function calls and a boolean test per phase per frame, about sixteen of
// them, and no allocation on any path once a slot exists. That is inside the
// noise of a 16ms budget, which is the point: instrumentation you have to take
// out before you ship is instrumentation that lies about the build you ship.

const now = () =>
  (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// How many frames of history each slot keeps. 240 is four seconds at 60Hz —
// long enough that a median means something and short enough that a spike
// twenty seconds ago is not still being reported as typical.
const HISTORY = 240;

let enabled = false;

/** name -> { total, calls, frame, hist, n, max } */
const slots = new Map();

function slotFor(name) {
  let s = slots.get(name);
  if (!s) {
    s = {
      name,
      frame: 0,          // accumulated within the current frame
      hist: new Float64Array(HISTORY),
      n: 0,              // frames recorded (saturates the ring)
      w: 0,              // write cursor
      calls: 0,
      max: 0,
    };
    slots.set(name, s);
  }
  return s;
}

/**
 * Turn profiling on or off. Off by default, so a shipped build pays only the
 * boolean test. Turning it on clears whatever was collected before, because a
 * profile that spans the frame you pressed the button is not a profile.
 */
export function perfEnable(on = true) {
  enabled = !!on;
  if (enabled) perfReset();
}

export function perfEnabled() {
  return enabled;
}

export function perfReset() {
  for (const s of slots.values()) {
    s.frame = 0;
    s.n = 0;
    s.w = 0;
    s.calls = 0;
    s.max = 0;
    s.hist.fill(0);
  }
}

/** Start timing a phase. Returns a token to hand back to perfEnd. */
export function perfBegin(name) {
  if (!enabled) return 0;
  slotFor(name);
  return now();
}

/** Finish timing a phase started with perfBegin. */
export function perfEnd(name, t0) {
  if (!enabled || t0 === 0) return;
  const s = slotFor(name);
  s.frame += now() - t0;
  s.calls++;
}

/**
 * Record a plain number for this frame — object counts, sprite counts, draw
 * calls. Summed within a frame, exactly like a duration.
 */
export function perfCount(name, v) {
  if (!enabled) return;
  const s = slotFor(name);
  s.frame += v;
  s.calls++;
}

/**
 * Close the current frame: every slot's accumulator moves into its history and
 * resets. Called once from the scene's update, at the very top, so the numbers
 * a frame reports are that frame's.
 */
export function perfFrame() {
  if (!enabled) return;
  for (const s of slots.values()) {
    s.hist[s.w] = s.frame;
    s.w = (s.w + 1) % HISTORY;
    if (s.n < HISTORY) s.n++;
    if (s.frame > s.max) s.max = s.frame;
    s.frame = 0;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

/**
 * Median / p95 / mean / max per slot, over the frames in history.
 *
 * `skip` drops the first N recorded frames, which is how the boot frames — the
 * terrain bake, the first fog upload, the HUD's first full layout — are kept out
 * of a steady-state number. They are real costs but they are not the frame the
 * player spends the match in.
 */
export function perfReport(skip = 0) {
  const out = {};
  for (const s of slots.values()) {
    const n = s.n;
    if (!n) continue;
    // Oldest-first ordering out of the ring.
    const start = n < HISTORY ? 0 : s.w;
    const vals = [];
    for (let i = skip; i < n; i++) vals.push(s.hist[(start + i) % HISTORY]);
    if (!vals.length) continue;
    const sorted = vals.slice().sort((a, b) => a - b);
    let sum = 0;
    for (const v of vals) sum += v;
    out[s.name] = {
      frames: vals.length,
      mean: sum / vals.length,
      // The low quartile. On a shared build machine a process is descheduled
      // mid-frame, and that time is charged to whichever phase was running — so
      // contention can only ever *add* to one of these samples, never subtract.
      // That makes a low percentile the best available estimator of what the
      // work actually costs, and the only one stable enough to assert on. A
      // genuine regression raises it along with everything else.
      p25: percentile(sorted, 0.25),
      median: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted[sorted.length - 1],
    };
  }
  return out;
}

export const perf = {
  enable: perfEnable,
  enabled: perfEnabled,
  reset: perfReset,
  begin: perfBegin,
  end: perfEnd,
  count: perfCount,
  frame: perfFrame,
  report: perfReport,
};
