// Procedural synthesis primitives.
//
// Every sound the game makes is built here out of oscillators and a few
// pre-generated noise buffers. There are no audio files anywhere in this
// project: the site is a static GitHub Pages build with no build step, so a
// folder of .ogg/.mp3 would be both the largest download we ship and a
// licensing question for every clip. Synth voices cost a handful of nodes,
// start on the same frame they are asked for, and cost nothing to download.
//
// The public surface is a "kit": a single reusable object that recipes in
// catalogue.js draw with. It is re-armed per voice rather than reallocated,
// because with 100+ units on screen play() is called often enough that a fresh
// object literal per call is real garbage-collector pressure on a phone.

// exponentialRampToValueAtTime cannot approach zero, so every decay lands here
// instead. -80 dB is inaudible under any master volume we allow.
const MIN_GAIN = 0.0001;

/** MIDI note number to Hz. Used by the music bed and a couple of the stings. */
export function mtof(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// --- noise buffers ----------------------------------------------------------
// Generated once at construction and shared by every voice for the life of the
// engine. A chop is a noise transient plus a body; if each chop allocated its
// own AudioBuffer, 40 villagers working would allocate 40 buffers a second and
// the GC pause would show up as a dropped frame.

/**
 * Deterministic fill source. Buffer contents are noise either way, but a fixed
 * seed means two runs of the self-test produce byte-identical buffers, which
 * makes "did my change alter the timbre" answerable.
 */
function seededNoise(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

function fillWhite(data, n) {
  const rnd = seededNoise(0x51f0);
  for (let i = 0; i < n; i++) data[i] = rnd();
}

/**
 * Pink noise (Paul Kellet's economical approximation). Its -3 dB/octave tilt is
 * what makes rustles and cloth sound natural; white noise reads as a hiss or a
 * TV, which is wrong for berries and wheat.
 */
function fillPink(data, n) {
  const rnd = seededNoise(0x9e37);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
}

/**
 * Brown noise: a leaky integral of white, -6 dB/octave. This is the rumble in a
 * collapsing building — pink is not heavy enough to read as masonry.
 */
function fillBrown(data, n) {
  const rnd = seededNoise(0xc0de);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * rnd()) / 1.02;
    data[i] = last * 3.2;
  }
}

function buildBuffer(ctx, sr, seconds, fill) {
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(1, len, sr);
  fill(buf.getChannelData(0), len);
  return buf;
}

/**
 * Pre-generate the shared noise beds. Mono on purpose: phone speakers are mono,
 * stereo width comes from the per-voice panner, and mono halves the memory.
 * Lengths are chosen so a random start offset never repeats audibly within one
 * burst — a chop only ever reads ~40 ms of it.
 */
export function makeNoiseBuffers(ctx) {
  const sr = ctx.sampleRate || 44100;
  return {
    white: buildBuffer(ctx, sr, 1.0, fillWhite),
    pink: buildBuffer(ctx, sr, 1.5, fillPink),
    brown: buildBuffer(ctx, sr, 1.5, fillBrown),
  };
}

// --- the kit ----------------------------------------------------------------

function bufferDuration(buf, sr) {
  if (buf && buf.duration) return buf.duration;
  if (buf && buf.length) return buf.length / (buf.sampleRate || sr || 44100);
  return 1;
}

/**
 * Build the drawing kit. One kit is shared by the whole engine; `begin()`
 * re-arms it for a single voice and the recipe then calls tone()/hiss()/etc.
 *
 * Every helper honours `rate`: frequencies scale up with it and times scale
 * down, so play(name, { rate: 1.2 }) is a genuine transposition rather than
 * just a detune. That is how 40 villagers avoid sounding like one machine.
 */
export function createKit(ctx, buffers) {
  const sr = ctx.sampleRate || 44100;

  const kit = {
    ctx,
    buffers,
    out: null,      // the voice gain node everything connects to
    t: 0,           // voice start time, in AudioContext time
    end: 0,         // latest scheduled stop, so the mixer knows when to reap
    rate: 1,
    rng: Math.random,
    srcs: null,     // the voice's source list, so a stolen voice can be silenced

    /** Re-arm for one voice. `srcs` is the voice's (pooled) source array. */
    begin(out, t, rng, rate, srcs) {
      this.out = out;
      this.t = t;
      this.end = t;
      this.rate = rate || 1;
      this.rng = rng;
      this.srcs = srcs;
      return this;
    },

    /** Uniform random in [a, b) from the engine's seeded stream. */
    rand(a, b) {
      return a + this.rng() * (b - a);
    },

    _track(src, stopAt) {
      if (this.srcs) this.srcs.push(src);
      if (stopAt > this.end) this.end = stopAt;
    },

    /**
     * A single enveloped oscillator, optionally pitch-swept and filtered.
     *  freq/to  start and end frequency (Hz, pre-rate)
     *  glide    seconds to reach `to` (default: the whole decay)
     *  attack   seconds to peak; keep >= 1.5 ms or the click becomes the sound
     *  hold     seconds at peak before the decay
     *  decay    seconds to silence (exponential, which is what "natural" means)
     *  lp/hp/bp cutoff for an optional one-pole-ish biquad in the chain
     */
    tone(o) {
      const rate = this.rate;
      const t0 = this.t + (o.delay || 0) / rate;
      const attack = Math.max(0.0015, (o.attack === undefined ? 0.004 : o.attack) / rate);
      const hold = (o.hold || 0) / rate;
      const decay = Math.max(0.01, (o.decay === undefined ? 0.2 : o.decay) / rate);
      const peak = Math.max(MIN_GAIN * 2, o.peak === undefined ? 0.5 : o.peak);
      const stopAt = t0 + attack + hold + decay + 0.02;

      const osc = ctx.createOscillator();
      osc.type = o.type || 'sine';
      const f0 = Math.max(20, (o.freq === undefined ? 440 : o.freq) * rate);
      osc.frequency.setValueAtTime(f0, t0);
      if (o.to) {
        const f1 = Math.max(20, o.to * rate);
        const glide = Math.max(0.01, (o.glide === undefined ? o.decay || 0.2 : o.glide) / rate);
        // Exponential in pitch: a linear sweep from 260 Hz to 60 Hz spends most
        // of its time in the top octave and reads as a siren, not a falling body.
        osc.frequency.exponentialRampToValueAtTime(f1, t0 + glide);
      }
      if (o.detune) osc.detune.setValueAtTime(o.detune, t0);

      const g = ctx.createGain();
      g.gain.setValueAtTime(MIN_GAIN, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      if (hold > 0) g.gain.setValueAtTime(peak, t0 + attack + hold);
      g.gain.exponentialRampToValueAtTime(MIN_GAIN, t0 + attack + hold + decay);

      const tail = this._filter(o, g, t0, decay);
      tail.connect(this.out);
      osc.connect(g);
      osc.start(t0);
      osc.stop(stopAt);
      this._track(osc, stopAt);
      return stopAt;
    },

    /**
     * A burst of the shared noise, filtered and enveloped. `buf` picks the bed:
     * 'white' for metal and clicks, 'pink' for foliage and cloth, 'brown' for
     * rubble and rumble.
     */
    hiss(o) {
      const rate = this.rate;
      const t0 = this.t + (o.delay || 0) / rate;
      const attack = Math.max(0.0008, (o.attack === undefined ? 0.002 : o.attack) / rate);
      const hold = (o.hold || 0) / rate;
      const decay = Math.max(0.008, (o.decay === undefined ? 0.12 : o.decay) / rate);
      const peak = Math.max(MIN_GAIN * 2, o.peak === undefined ? 0.4 : o.peak);
      const stopAt = t0 + attack + hold + decay + 0.02;

      const buf = buffers[o.buf || 'white'] || buffers.white;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (src.playbackRate && o.pitch !== false) {
        src.playbackRate.setValueAtTime(rate, t0);
      }

      const g = ctx.createGain();
      g.gain.setValueAtTime(MIN_GAIN, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      if (hold > 0) g.gain.setValueAtTime(peak, t0 + attack + hold);
      g.gain.exponentialRampToValueAtTime(MIN_GAIN, t0 + attack + hold + decay);

      const tail = this._filter(o, g, t0, decay);
      tail.connect(this.out);
      src.connect(g);
      // Start at a random offset so repeated hits never phase-align into a
      // recognisable loop; the buffer is seconds long and we read tens of ms.
      const dur = bufferDuration(buf, sr);
      const offset = this.rng() * Math.max(0, dur - (attack + hold + decay) * rate - 0.05);
      src.start(t0, offset);
      src.stop(stopAt);
      this._track(src, stopAt);
      return stopAt;
    },

    /**
     * Optional biquad between a source's envelope and the voice bus. Declared
     * as one of lp/hp/bp on the recipe options; `toFreq` sweeps the cutoff,
     * which is how a collapse gets darker as the dust settles.
     */
    _filter(o, from, t0, decay) {
      const type = o.bp ? 'bandpass' : o.hp ? 'highpass' : o.lp ? 'lowpass' : null;
      if (!type || !ctx.createBiquadFilter) return from;
      const f = ctx.createBiquadFilter();
      f.type = type;
      const cut = Math.max(30, (o.bp || o.hp || o.lp) * this.rate);
      f.frequency.setValueAtTime(cut, t0);
      if (o.toFreq) {
        f.frequency.exponentialRampToValueAtTime(
          Math.max(30, o.toFreq * this.rate),
          t0 + Math.max(0.01, (o.sweep === undefined ? decay : o.sweep / this.rate))
        );
      }
      if (o.q !== undefined && f.Q) f.Q.setValueAtTime(o.q, t0);
      from.connect(f);
      return f;
    },

    /** Several tones at once — used for chords, stings and inharmonic metal. */
    stack(freqs, o) {
      for (let i = 0; i < freqs.length; i++) {
        this.tone({
          ...o,
          freq: freqs[i],
          to: o.toRatio ? freqs[i] * o.toRatio : o.to,
          peak: (o.peak === undefined ? 0.4 : o.peak) * (o.falloff ? Math.pow(o.falloff, i) : 1),
          delay: (o.delay || 0) + (o.spread || 0) * i,
        });
      }
    },
  };

  return kit;
}
