// Do V8, SpiderMonkey and JavaScriptCore agree on this simulation, to the bit?
//
//   node tests/crossengine.browser.mjs [--ticks 6000]
//
// THIS IS THE HIGHEST-CONSEQUENCE QUESTION IN THE MULTIPLAYER PLAN, and it is
// the one that cannot be answered by reasoning. tests/determinism.test.mjs
// proves the simulation does not depend on the Math functions ECMA-262 leaves
// implementation-defined — but it proves it inside one engine, by substituting
// alternative implementations. That is a model of a second engine, not a second
// engine.
//
// What is left is a spec claim: that +, -, *, / and Math.sqrt are pinned to
// correctly-rounded IEEE-754, and floor/ceil/round/abs/min/max/imul to exact
// definitions, on every conforming engine. If that reading is wrong for even
// one operation — or if some optimiser fuses a multiply-add into an FMA with
// different rounding — deterministic lockstep is not available and the fallback
// is fixed-point arithmetic across the whole simulation. That is weeks of work,
// and it is much better to find out now than after the netcode is written.
//
// So: run the identical module graph in three engines and compare a hash per
// tick. WebKit here is JavaScriptCore, which is the engine iOS Safari uses —
// not the same build, but the same engine, and by far the closest thing to an
// iPhone that a Linux container can offer. A real device should still be
// checked once before any public lobby.
//
// A mismatch prints the tick where the engines first disagreed. Because the
// hash covers every field a decision reads, that tick number plus a seed is
// enough to reproduce it in Node and bisect it down to an operation.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright-core';
import { serve, CHROMIUM } from './harness.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const TICKS = Number(arg('ticks', 6000));
const SEEDS = [4242, 99];

// Chromium comes from harness.mjs, which knows the three places it might be;
// the other two came from `playwright install` and are found by playwright-core's
// own registry.
const ENGINES = [
  { name: 'chromium (V8)', type: chromium, opts: { executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-dev-shm-usage'] } },
  { name: 'firefox (SpiderMonkey)', type: firefox, opts: {} },
  { name: 'webkit (JavaScriptCore)', type: webkit, opts: {} },
];

const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
};

/** Run the harness inside one engine and return { seed: hashVector } as arrays. */
async function vectorsFor(engine, port) {
  const browser = await engine.type.launch(engine.opts);
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    // A bare page on the static server, so the module graph resolves exactly as
    // it does for a player loading the game.
    await page.goto(`http://127.0.0.1:${port}/tests/blank.html`, { waitUntil: 'load' });
    const out = await page.evaluate(async ([seeds, ticks]) => {
      const h = await import('/tests/simharness.mjs');
      const res = {};
      for (const seed of seeds) {
        // runVector with no perturbation: the engine's own arithmetic, nothing
        // substituted. That is the whole point here.
        res[seed] = Array.from(h.runVector(seed, {}, ticks));
      }
      return res;
    }, [SEEDS, TICKS]);
    if (errors.length) throw new Error(`page errors: ${errors.slice(0, 2).join(' | ')}`);
    return out;
  } finally {
    await browser.close();
  }
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const { server, port } = await serve();
const results = {};
try {
  for (const engine of ENGINES) {
    process.stdout.write(`  running ${engine.name} ... `);
    try {
      const t0 = Date.now();
      results[engine.name] = await vectorsFor(engine, port);
      console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.log('FAILED');
      check(`${engine.name} runs the simulation`, false, String(e.message).slice(0, 160));
    }
  }
} finally {
  server.close();
}

// --- Can this test fail? -----------------------------------------------------
//
// Everything above is worthless if the comparison cannot detect a difference —
// and that is not paranoia, it is the third time in this work that a green run
// turned out to be measuring nothing (an empty world, then an unreachable
// perturbation). So before believing agreement, make one engine deliberately
// disagree and require the comparison to catch it.
async function canaryDivergence(engine, port) {
  const browser = await engine.type.launch(engine.opts);
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/tests/blank.html`, { waitUntil: 'load' });
    return await page.evaluate(async ([seed, ticks]) => {
      const h = await import('/tests/simharness.mjs');
      const clean = Array.from(h.runVector(seed, {}, ticks));
      // Perturb one multiplication deep in the sim by a single ulp, the way a
      // non-conforming engine would. Nothing else changes.
      const realSqrt = Math.sqrt;
      let n = 0;
      Math.sqrt = (x) => { n++; const r = realSqrt(x); return r === 0 ? r : r * (1 + Number.EPSILON); };
      let dirty;
      try { dirty = Array.from(h.runVector(seed, {}, ticks)); } finally { Math.sqrt = realSqrt; }
      let at = -1;
      for (let i = 0; i < clean.length; i++) if (clean[i] !== dirty[i]) { at = i; break; }
      return { at, sqrtCalls: n };
    }, [SEEDS[0], 400]);
  } finally {
    await browser.close();
  }
}

const { server: s2, port: p2 } = await serve();
try {
  const canary = await canaryDivergence(ENGINES[0], p2);
  check('the comparison can actually detect a divergence',
    canary.at >= 0,
    canary.at >= 0
      ? `caught a one-ulp sqrt perturbation at tick ${canary.at} (${canary.sqrtCalls} sqrt calls)`
      : `a perturbed sqrt produced an IDENTICAL run over 400 ticks (${canary.sqrtCalls} sqrt calls) — this test proves nothing`);
} finally {
  s2.close();
}

const names = Object.keys(results);
console.log(`\n${names.length} engine(s) produced vectors over ${TICKS} ticks (${(TICKS / 20 / 60).toFixed(1)} simulated minutes)\n`);

if (names.length < 2) {
  check('at least two engines available to compare', false,
    `only ${names.join(', ') || 'none'} ran — this test proves nothing with one engine`);
} else {
  const base = names[0];
  for (const seed of SEEDS) {
    const a = results[base][seed];
    check(`${base} produced a non-trivial vector for seed ${seed}`,
      Array.isArray(a) && a.length === TICKS && new Set(a).size > TICKS / 10,
      `${a ? a.length : 0} hashes, ${a ? new Set(a).size : 0} distinct`);
    for (const other of names.slice(1)) {
      const b = results[other][seed];
      const at = firstDiff(a, b);
      check(`seed ${seed}: ${other} matches ${base}`, at === -1,
        at === -1 ? 'bit-identical for the whole run'
          : `diverged at tick ${at} (${(at / 20).toFixed(1)}s) — ${base}=${a[at]} ${other}=${b[at]}`);
    }
  }
}

console.log('');
if (failures.length) {
  console.log(`${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nA divergence here means an operation this simulation relies on is NOT');
  console.log('identical across engines. Deterministic lockstep cannot be built on it as');
  console.log('written; reproduce the tick in Node and bisect to the operation.');
  process.exit(1);
}
console.log('every engine agreed, every tick, every seed');
