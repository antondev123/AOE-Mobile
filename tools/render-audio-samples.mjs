// Render the procedural audio engine to .wav files.
//
// The game ships no audio assets on purpose (see src/audio/README.md): every
// cue is synthesized at runtime from oscillators and noise beds. That is right
// for the deploy and awkward for review, because there is nothing to listen to
// without running a match and triggering the event yourself.
//
// This tool closes that gap. It boots the real engine in headless Chromium
// against an OfflineAudioContext and renders faster than real time, so what
// lands on disk went through the actual catalogue recipes, the actual voice
// mixer, and the actual master limiter — not a reimplementation that could
// drift from the shipped code.
//
//   node tools/render-audio-samples.mjs [--out DIR] [--seed N] [--music SECONDS]
//
// Nothing here is imported by the game; it is a review aid.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

// The engine's own defaults are what a player actually hears, so renders use
// them unchanged rather than pushing to full scale. Files are therefore quieter
// than a normalised sample pack — that is the point.
function parseArgs(argv) {
  const args = { out: path.join(ROOT, 'audio-samples'), seed: 0xa0d10, music: 45 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--music') args.music = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/**
 * Static server for the repo, plus one synthetic page. The page has to be
 * same-origin with the modules it imports, so file:// is not an option and a
 * blank about:blank tab cannot import them either.
 */
function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (urlPath === '/' || urlPath === '/__render.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end('<!doctype html><meta charset="utf-8"><title>audio render</title>');
      return;
    }
    const file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// --- in-page renderer -------------------------------------------------------
//
// Everything below runs inside Chromium. It is passed as a string because it
// needs the page's OfflineAudioContext, and it returns plain arrays of samples
// which Node then encodes — sending floats out is cheaper than sending an
// encoded WAV back through a JSON bridge as base64.

async function installRenderer(page, origin, seed) {
  await page.evaluate(
    async ({ origin, seed }) => {
      const { createAudio } = await import(`${origin}/src/audio/sound.js`);
      const { SOUND_NAMES, SOUNDS } = await import(`${origin}/src/audio/catalogue.js`);

      const SR = 48000;
      const QUANTUM = 128;

      // Offline contexts report state 'suspended' until rendering starts, and
      // the engine deliberately drops any cue scheduled while the context is
      // not running (otherwise everything queued before the first user gesture
      // would fire at once on unlock). For rendering we are the gesture, so the
      // flag is forced on the throwaway context. The engine is untouched.
      function offline(seconds, channels = 2) {
        const ctx = new OfflineAudioContext(channels, Math.ceil(SR * seconds), SR);
        Object.defineProperty(ctx, 'state', { get: () => 'running', configurable: true });
        return ctx;
      }

      /**
       * Schedule callbacks at wall-clock offsets inside an offline render.
       * This is the only way to make the engine's ctx.currentTime advance —
       * without it every play() lands at time 0 and the whole timeline stacks.
       *
       * Callbacks are collected rather than suspended as they arrive, because
       * suspend() only stops on render-quantum boundaries and refuses a second
       * suspend on a boundary it already holds. Twelve villagers chopping on
       * one frame is exactly the case we want to render, so events are bucketed
       * by quantum and each bucket gets a single suspend.
       */
      function timeline(ctx) {
        const slots = new Map();
        return {
          at(time, fn) {
            const frame = Math.max(0, Math.round((time * SR) / QUANTUM) * QUANTUM);
            let list = slots.get(frame);
            if (!list) slots.set(frame, (list = []));
            list.push(fn);
          },
          /** Register the suspends. Must run before startRendering(). */
          flush() {
            for (const [frame, list] of [...slots.entries()].sort((a, b) => a[0] - b[0])) {
              if (frame === 0) {
                for (const fn of list) fn();
                continue;
              }
              ctx.suspend(frame / SR).then(() => {
                for (const fn of list) fn();
                ctx.resume();
              });
            }
          },
        };
      }

      function channels(buf) {
        const out = [];
        for (let c = 0; c < buf.numberOfChannels; c++) {
          out.push(Array.from(buf.getChannelData(c)));
        }
        return out;
      }

      /** Trim to the audible span, with a little air either side. */
      function trim(data, { head = 0.015, tail = 0.12, floor = 0.0002 } = {}) {
        const n = data[0].length;
        let last = 0;
        let first = n;
        for (let c = 0; c < data.length; c++) {
          const ch = data[c];
          for (let i = 0; i < n; i++) {
            if (Math.abs(ch[i]) > floor) {
              if (i < first) first = i;
              if (i > last) last = i;
            }
          }
        }
        if (first >= n) return data.map((ch) => ch.slice(0, Math.floor(SR * 0.05)));
        const a = Math.max(0, first - Math.floor(SR * head));
        const b = Math.min(n, last + Math.floor(SR * tail));
        return data.map((ch) => ch.slice(a, b));
      }

      function peak(data) {
        let p = 0;
        for (const ch of data) for (const s of ch) if (Math.abs(s) > p) p = Math.abs(s);
        return p;
      }

      function rms(data) {
        let sum = 0;
        let n = 0;
        for (const ch of data) {
          for (const s of ch) {
            sum += s * s;
            n++;
          }
        }
        return n ? Math.sqrt(sum / n) : 0;
      }

      /**
       * Build an engine over a throwaway offline context. storageKey is unique
       * per render so a stray localStorage preference cannot change the output.
       */
      function engine(ctx, extra = {}) {
        return createAudio({
          ctx,
          autoUnlock: false,
          storageKey: `__render_${Math.random().toString(36).slice(2)}`,
          seed,
          ...extra,
        });
      }

      // How long the head of every render is given over to settling the master
      // limiter, and where the audible content therefore starts.
      //
      // Chromium's DynamicsCompressorNode comes up fully reduced and only opens
      // after roughly one release period of signal, so the very first cue
      // through a freshly built graph renders about 12 dB down — measurably, and
      // identically, every time. Rendering a cue on its own would therefore
      // capture the engine in a state a player only hears once per session
      // rather than the level that cue actually sits at in a match.
      //
      // So every render fires a throwaway hit first, lets the limiter open, and
      // the primer is sliced off before the file is written. (The engine-side
      // quiet-first-sound is a separate matter, noted in the run summary.)
      const PRIME_AT = 0;
      const CONTENT_AT = 2.6;   // clear of the longest cue's 2.1 s tail
      const SLICE_AT = 2.5;     // keep 100 ms of pre-roll ahead of the content

      /** Fire the primer and hand back a timeline pre-offset to the content. */
      function primed(ctx, audio) {
        const tl = timeline(ctx);
        tl.at(PRIME_AT, () => audio.play('buildingDestroyed'));
        return {
          at: (time, fn) => tl.at(CONTENT_AT + time, fn),
          flush: () => tl.flush(),
        };
      }

      /** Drop the primer and its silence from a rendered buffer. */
      function afterPrimer(data) {
        const start = Math.floor(SLICE_AT * SR);
        return data.map((ch) => ch.slice(start));
      }

      window.__audio = {
        names: SOUND_NAMES.slice(),
        meta: SOUND_NAMES.reduce((acc, n) => {
          const d = SOUNDS[n];
          acc[n] = {
            gain: d.gain,
            priority: d.priority === undefined ? 1 : d.priority,
            coalesce: d.coalesce === undefined ? 0.06 : d.coalesce,
            maxVoices: d.maxVoices || 3,
            positional: d.positional !== false,
          };
          return acc;
        }, {}),

        /** One instance of one cue, trimmed to its natural length. */
        async cue(name, seconds = 6) {
          const ctx = offline(CONTENT_AT + seconds);
          const audio = engine(ctx);
          const tl = primed(ctx, audio);
          tl.at(0, () => audio.play(name));
          tl.flush();
          const data = trim(afterPrimer(channels(await ctx.startRendering())));
          return { data, sampleRate: SR, peak: peak(data), rms: rms(data) };
        },

        /**
         * The same cue fired repeatedly, spaced far enough apart to dodge its
         * own coalesce window. Shows the per-voice pitch and noise-offset
         * variation that stops a worked resource turning into a machine.
         */
        async repeats(name, count, gap, seconds) {
          const ctx = offline(CONTENT_AT + seconds);
          const audio = engine(ctx);
          const tl = primed(ctx, audio);
          for (let i = 0; i < count; i++) tl.at(i * gap, () => audio.play(name));
          tl.flush();
          const data = trim(afterPrimer(channels(await ctx.startRendering())));
          return { data, sampleRate: SR, peak: peak(data), rms: rms(data), stats: audio.stats() };
        },

        /**
         * Voice-budget behaviour: a burst inside the coalesce window (which
         * merges into one louder voice) against the same number of hits spread
         * wide enough to stay separate.
         */
        async coalescing() {
          const ctx = offline(CONTENT_AT + 6);
          const audio = engine(ctx);
          const tl = primed(ctx, audio);
          // Twelve villagers chopping on one frame.
          for (let i = 0; i < 12; i++) tl.at(0.25, () => audio.play('chop'));
          // The same twelve with their timers drifted apart.
          for (let i = 0; i < 12; i++) tl.at(1.6 + i * 0.16, () => audio.play('chop'));
          tl.flush();
          const data = trim(afterPrimer(channels(await ctx.startRendering())));
          return { data, sampleRate: SR, peak: peak(data), rms: rms(data), stats: audio.stats() };
        },

        /** Stereo placement: the same cue swept from hard left to hard right. */
        async panSweep() {
          const ctx = offline(CONTENT_AT + 5);
          const audio = engine(ctx);
          const tl = primed(ctx, audio);
          const pans = [-1, -0.6, -0.2, 0.2, 0.6, 1];
          pans.forEach((pan, i) => {
            tl.at(0.2 + i * 0.55, () => audio.play('hammer', { pan }));
          });
          tl.flush();
          const data = trim(afterPrimer(channels(await ctx.startRendering())));
          return { data, sampleRate: SR, peak: peak(data), rms: rms(data) };
        },

        /** Every cue in catalogue order, spaced so each is separable. */
        async tour(gap = 1.5) {
          const names = SOUND_NAMES;
          const ctx = offline(CONTENT_AT + names.length * gap + 6);
          const audio = engine(ctx);
          const tl = primed(ctx, audio);
          names.forEach((n, i) => tl.at(0.4 + i * gap, () => audio.play(n)));
          tl.flush();
          // Not trimmed at the head: the mark times below are offsets into the
          // written file, so the slice point has to stay exactly where it is.
          const data = afterPrimer(channels(await ctx.startRendering()));
          return {
            data,
            sampleRate: SR,
            peak: peak(data),
            rms: rms(data),
            marks: names.map((n, i) => ({
              name: n,
              at: Number((CONTENT_AT - SLICE_AT + 0.4 + i * gap).toFixed(3)),
            })),
          };
        },

        /**
         * The generative bed. The music scheduler works one lookahead window
         * ahead of ctx.currentTime, so the render has to be pumped with
         * update(dt) at intervals exactly as the game loop would.
         */
        async music(seconds) {
          const ctx = offline(CONTENT_AT + seconds + 2);
          const audio = engine(ctx);
          const tl = primed(ctx, audio);
          tl.at(0, () => audio.startMusic());
          const step = 0.25;
          for (let t = step; t < seconds; t += step) tl.at(t, () => audio.update(step));
          tl.flush();
          const data = afterPrimer(channels(await ctx.startRendering()));
          return { data, sampleRate: SR, peak: peak(data), rms: rms(data) };
        },

        /**
         * A slice of match: gathering underway, a build finishing, then a raid
         * that ducks the music under the alert. This is the one file that shows
         * the mix doing its job rather than the cues in isolation.
         */
        async scene() {
          const ctx = offline(CONTENT_AT + 22);
          const audio = engine(ctx);
          const tl = primed(ctx, audio);
          tl.at(0, () => audio.startMusic());
          const step = 0.25;
          for (let t = step; t < 21; t += step) tl.at(t, () => audio.update(step));

          // Six villagers on wood and stone, drifting out of phase.
          for (let i = 0; i < 26; i++) {
            tl.at(2 + i * 0.34 + (i % 3) * 0.05, () => audio.play('chop', { pan: -0.4 }));
          }
          for (let i = 0; i < 18; i++) {
            tl.at(3.1 + i * 0.47, () => audio.play('mine', { pan: 0.35 }));
          }
          for (let i = 0; i < 5; i++) tl.at(4 + i * 2.4, () => audio.play('deposit'));

          // A house going up, then finishing.
          for (let i = 0; i < 9; i++) tl.at(5 + i * 0.42, () => audio.play('hammer', { pan: 0.15 }));
          tl.at(9.2, () => audio.play('buildComplete'));
          tl.at(10.1, () => audio.play('villagerTrained'));

          // The raid.
          tl.at(12.0, () => audio.play('underAttack'));
          tl.at(12.1, () => audio.duckMusic(4));
          for (let i = 0; i < 7; i++) tl.at(12.6 + i * 0.53, () => audio.play('arrowLoose', { pan: -0.2 }));
          for (let i = 0; i < 6; i++) tl.at(13.0 + i * 0.61, () => audio.play('arrowHit', { pan: 0.2 }));
          for (let i = 0; i < 8; i++) tl.at(13.2 + i * 0.44, () => audio.play('meleeHit'));
          tl.at(15.4, () => audio.play('unitDeath'));
          tl.at(16.9, () => audio.play('unitDeath', { pan: 0.3 }));
          tl.at(18.2, () => audio.play('buildingDestroyed'));

          tl.flush();
          const data = afterPrimer(channels(await ctx.startRendering()));
          return { data, sampleRate: SR, peak: peak(data), rms: rms(data), stats: audio.stats() };
        },
      };
    },
    { origin, seed }
  );
}

// --- WAV encoding -----------------------------------------------------------

/** 16-bit PCM WAV. Dither-free: the sources are synthetic and already clean. */
function encodeWav(channelData, sampleRate) {
  const channels = channelData.length;
  const frames = channelData[0].length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      // Clamp rather than wrap: the master limiter should have kept us inside
      // already, and a wrapped sample is a loud click rather than a soft one.
      const s = Math.max(-1, Math.min(1, channelData[c][i]));
      buf.writeInt16LE(Math.round(s * 32767), off);
      off += 2;
    }
  }
  return buf;
}

function write(dir, name, result) {
  const file = path.join(dir, `${name}.wav`);
  const wav = encodeWav(result.data, result.sampleRate);
  fs.writeFileSync(file, wav);
  const seconds = result.data[0].length / result.sampleRate;
  return {
    file: path.basename(file),
    seconds: Number(seconds.toFixed(2)),
    bytes: wav.length,
    peak: Number(result.peak.toFixed(4)),
    rms: Number(result.rms.toFixed(5)),
    stats: result.stats,
  };
}

// --- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const { server, port } = await serve();
  const origin = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio'],
  });

  const failures = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') failures.push(`console: ${m.text()}`);
    });

    await page.goto(`${origin}/__render.html`, { waitUntil: 'load' });
    await installRenderer(page, origin, args.seed);

    const cuesDir = path.join(args.out, 'cues');
    const demosDir = path.join(args.out, 'demos');
    fs.mkdirSync(cuesDir, { recursive: true });
    fs.mkdirSync(demosDir, { recursive: true });

    const names = await page.evaluate(() => window.__audio.names);
    const meta = await page.evaluate(() => window.__audio.meta);
    const manifest = { seed: args.seed, sampleRate: 48000, cues: [], demos: [] };

    for (const name of names) {
      const res = await page.evaluate((n) => window.__audio.cue(n), name);
      const info = write(cuesDir, name, res);
      manifest.cues.push({ name, ...info, ...meta[name] });
      console.log(`cue   ${name.padEnd(20)} ${String(info.seconds).padStart(5)}s  peak ${info.peak}`);
    }

    // Repeated-fire demos, one per worked resource plus construction: these are
    // the cues a player hears hundreds of times, so per-voice variation is the
    // thing worth auditioning.
    const repeatSpecs = [
      { name: 'chop', label: 'variation-chop-x10', count: 10, gap: 0.42, seconds: 7 },
      { name: 'mine', label: 'variation-mine-x10', count: 10, gap: 0.42, seconds: 7 },
      { name: 'forage', label: 'variation-forage-x10', count: 10, gap: 0.45, seconds: 7 },
      { name: 'farm', label: 'variation-farm-x10', count: 10, gap: 0.45, seconds: 7 },
      { name: 'hammer', label: 'variation-hammer-x12', count: 12, gap: 0.38, seconds: 7 },
    ];
    for (const spec of repeatSpecs) {
      const res = await page.evaluate(
        (s) => window.__audio.repeats(s.name, s.count, s.gap, s.seconds),
        spec
      );
      const info = write(demosDir, spec.label, res);
      manifest.demos.push({ name: spec.label, ...info });
      console.log(`demo  ${spec.label.padEnd(20)} ${String(info.seconds).padStart(5)}s  peak ${info.peak}`);
    }

    const demoCalls = [
      ['voice-budget-coalescing', () => window.__audio.coalescing()],
      ['stereo-pan-sweep', () => window.__audio.panSweep()],
      ['all-cues-tour', () => window.__audio.tour()],
      ['match-scene', () => window.__audio.scene()],
    ];
    for (const [label, fn] of demoCalls) {
      const res = await page.evaluate(fn);
      const info = write(demosDir, label, res);
      manifest.demos.push({ name: label, ...info, marks: res.marks });
      console.log(`demo  ${label.padEnd(20)} ${String(info.seconds).padStart(5)}s  peak ${info.peak}`);
    }

    const musicRes = await page.evaluate((s) => window.__audio.music(s), args.music);
    const musicInfo = write(demosDir, 'music-bed', musicRes);
    manifest.demos.push({ name: 'music-bed', ...musicInfo });
    console.log(`demo  ${'music-bed'.padEnd(20)} ${String(musicInfo.seconds).padStart(5)}s  peak ${musicInfo.peak}`);

    fs.writeFileSync(
      path.join(args.out, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    );

    if (failures.length) {
      console.error('\npage reported errors:');
      for (const f of failures) console.error(`  ${f}`);
      process.exitCode = 1;
    }
    console.log(`\nwrote ${manifest.cues.length} cues and ${manifest.demos.length} demos to ${args.out}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
