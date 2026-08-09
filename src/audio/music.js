// The generative ambient bed.
//
// Twenty minutes is a long match, and a looping two-bar clip would be hated by
// minute four. So there is no loop: a slow modal drone runs continuously and
// single plucked notes are placed on top by a seeded PRNG, with real rests
// between phrases and an occasional shift of the modal centre. Nothing here is
// a melody, which is the point — it should be possible to stop noticing it.
//
// Cost budget: the drone is seven nodes that live for the whole match, and the
// plucks average one note every ~2.5 s at three nodes each. Notes are scheduled
// one short lookahead window ahead from update(dt) rather than all at once, so
// a twenty-minute match never has more than a couple of pending nodes.

import { makeRng } from '../core/rng.js';
import { mtof } from './synth.js';

// How far ahead of the audio clock we schedule. Long enough that a 60 fps
// update() (or a stuttering one) never misses a note boundary, short enough
// that stopMusic() does not leave a queue of notes fading in behind it.
const LOOKAHEAD = 1.5;
// Bound the scheduling loop. If the tab was backgrounded, currentTime can jump
// by minutes; without this we would schedule (and pay for) every note we
// "missed" all at once.
const MAX_NOTES_PER_UPDATE = 4;

// D dorian, the workhorse mode of medieval European music: minor in feel but
// with a raised sixth, so it never lands in the film-score minor that a plain
// aeolian drone falls into. The plucks use a five-note subset (1 b3 4 5 b7),
// which is unison-safe: any two notes from it sound intentional together, so
// random selection cannot produce a wrong note.
const PENTATONIC = [0, 3, 5, 7, 10];
// Which octaves plucks may land in, relative to the root. Kept high above the
// drone so the two never fight for the same frequency band.
const OCTAVES = [12, 24, 24, 36];

// Modal centres we drift between: tonic, the fourth below, and the fifth. All
// three share enough of the pentatonic set that a shift reads as a change of
// light rather than a key change.
const CENTRES = [0, -5, 2, -5, 0, 7];

export function createMusic(ctx, out, opts = {}) {
  const rng = makeRng(opts.seed || 0x5eed);
  const rootMidi = opts.root === undefined ? 38 : opts.root; // D2

  let playing = false;
  let drone = null;         // { gain, oscs: [], filter, lfo, lfoGain }
  let centreIdx = 0;
  let centre = CENTRES[0];
  let nextNoteAt = 0;
  let notesLeftInPhrase = 0;
  let restUntil = 0;
  // Active pluck nodes, pruned by end time so stop()/destroy() can silence them.
  const pending = [];

  // --- drone ---------------------------------------------------------------

  function buildDrone(t) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    // Six seconds to arrive. A drone that fades in quickly announces itself;
    // one that takes six seconds is simply there when you next notice.
    gain.gain.linearRampToValueAtTime(0.19, t + 6);
    gain.connect(out);

    let node = gain;
    let filter = null;
    if (ctx.createBiquadFilter) {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(430, t);
      if (filter.Q) filter.Q.setValueAtTime(0.7, t);
      filter.connect(gain);
      node = filter;
    }

    // Root, fifth, and a detuned octave. The octave is 7 cents sharp so the
    // three beat slowly against each other — that drift is the whole reason
    // the drone stays alive over twenty minutes without any automation.
    const specs = [
      { type: 'sawtooth', semi: 0, gain: 0.5, detune: 0 },
      { type: 'sawtooth', semi: 7, gain: 0.34, detune: -4 },
      { type: 'triangle', semi: 12, gain: 0.22, detune: 7 },
    ];
    const oscs = [];
    for (const s of specs) {
      const o = ctx.createOscillator();
      o.type = s.type;
      o.frequency.setValueAtTime(mtof(rootMidi + centre + s.semi), t);
      if (s.detune && o.detune) o.detune.setValueAtTime(s.detune, t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(s.gain, t);
      o.connect(g);
      g.connect(node);
      o.start(t);
      oscs.push({ osc: o, semi: s.semi });
    }

    // A very slow filter sweep: 0.031 Hz is one cycle every 32 seconds, well
    // below the rate at which a listener perceives it as movement.
    let lfo = null;
    let lfoGain = null;
    if (filter) {
      lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(0.031, t);
      lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(150, t);
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start(t);
    }

    return { gain, oscs, filter, lfo, lfoGain };
  }

  /**
   * Move the drone to a new modal centre over eight seconds. Linear in Hz on
   * purpose: the slight acceleration at the start of an exponential glide is
   * audible as a swoop, and a drone must never swoop.
   */
  function shiftCentre(t) {
    centreIdx = (centreIdx + 1) % CENTRES.length;
    centre = CENTRES[centreIdx];
    if (!drone) return;
    for (const d of drone.oscs) {
      d.osc.frequency.linearRampToValueAtTime(mtof(rootMidi + centre + d.semi), t + 8);
    }
  }

  // --- plucks --------------------------------------------------------------

  /** One plucked note: triangle through a lowpass, long exponential decay. */
  function pluck(t, semi, level) {
    const f = mtof(rootMidi + centre + semi);
    const decay = 1.2 + rng() * 1.6;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    let node = g;
    if (ctx.createBiquadFilter) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      // Cutoff tracks pitch so high notes are not dull and low notes are not
      // buzzy, then falls as the note decays like a real damped string.
      lp.frequency.setValueAtTime(f * 6 + 400, t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(200, f * 1.6), t + decay);
      g.connect(lp);
      lp.connect(out);
      node = g;
    } else {
      g.connect(out);
    }

    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f, t);
    o.connect(node);
    o.start(t);
    o.stop(t + decay + 0.05);
    pending.push({ src: o, endsAt: t + decay + 0.05 });

    // A sine an octave up at a third of the level gives the pluck its attack
    // without a filter sweep; it decays four times faster, like a real string's
    // upper partials.
    const h = ctx.createGain();
    h.gain.setValueAtTime(0.0001, t);
    h.gain.exponentialRampToValueAtTime(level * 0.3, t + 0.008);
    h.gain.exponentialRampToValueAtTime(0.0001, t + decay * 0.25);
    h.connect(out);
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(f * 2, t);
    o2.connect(h);
    o2.start(t);
    o2.stop(t + decay * 0.25 + 0.05);
    pending.push({ src: o2, endsAt: t + decay * 0.25 + 0.05 });
  }

  /** A distant low bell. Rare by design: roughly once every two minutes. */
  function bell(t) {
    const f = mtof(rootMidi + centre + 12);
    for (let i = 0; i < 3; i++) {
      // Inharmonic partials (1 : 2.76 : 5.4) are what separates a bell from a
      // pad; the ratios are the classic tubular-bell set, thinned out.
      const ratio = [1, 2.76, 5.4][i];
      const decay = [4.5, 2.4, 1.4][i];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09 * Math.pow(0.5, i), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      g.connect(out);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * ratio, t);
      o.connect(g);
      o.start(t);
      o.stop(t + decay + 0.05);
      pending.push({ src: o, endsAt: t + decay + 0.05 });
    }
  }

  // --- phrase scheduling ---------------------------------------------------

  function scheduleSlot(t) {
    if (notesLeftInPhrase <= 0) {
      // End of a phrase: six to fourteen seconds of nothing. The rests are the
      // reason this survives a long match — continuous notes, however sparse,
      // eventually read as a tune you are waiting to resolve.
      restUntil = t + 6 + rng() * 8;
      notesLeftInPhrase = 3 + Math.floor(rng() * 5);
      // Roughly every other phrase, drift to a new modal centre.
      if (rng() < 0.45) shiftCentre(t);
      return restUntil;
    }

    notesLeftInPhrase--;

    // A third of slots inside a phrase are silent too, so the rhythm of the
    // phrase itself is irregular rather than an even pulse.
    if (rng() < 0.32) return t + 1.4 + rng() * 1.4;

    if (rng() < 0.04) {
      bell(t);
      return t + 6 + rng() * 6;
    }

    const semi = PENTATONIC[Math.floor(rng() * PENTATONIC.length)] +
      OCTAVES[Math.floor(rng() * OCTAVES.length)];
    // Levels vary by 6 dB note to note; a constant level is the single most
    // machine-like quality a generative part can have.
    pluck(t, semi, 0.1 + rng() * 0.1);

    // Occasionally a second note a fourth or fifth up, a beat later — the
    // closest this gets to a phrase with intent.
    if (rng() < 0.28) {
      const partner = semi + (rng() < 0.5 ? 5 : 7);
      pluck(t + 0.36 + rng() * 0.3, partner, 0.07 + rng() * 0.05);
    }

    return t + 1.6 + rng() * 1.9;
  }

  // --- public --------------------------------------------------------------

  function start() {
    if (playing) return;
    const t = ctx.currentTime;
    playing = true;
    if (!drone) drone = buildDrone(t);
    else drone.gain.gain.linearRampToValueAtTime(0.19, t + 4);
    // Four seconds of drone alone before the first pluck, so the bed
    // establishes itself before anything happens on top of it.
    nextNoteAt = t + 4 + rng() * 3;
    notesLeftInPhrase = 3 + Math.floor(rng() * 4);
    restUntil = 0;
  }

  function stop() {
    if (!playing) return;
    playing = false;
    const t = ctx.currentTime;
    if (drone) {
      // Three-second fade, then tear the oscillators down. Cutting a drone
      // dead is more noticeable than the drone itself ever was.
      drone.gain.gain.cancelScheduledValues(t);
      drone.gain.gain.setValueAtTime(Math.max(0.0001, drone.gain.gain.value || 0.19), t);
      drone.gain.gain.exponentialRampToValueAtTime(0.0001, t + 3);
      const d = drone;
      drone = null;
      teardownDrone(d, t + 3.1);
    }
    // Pending plucks are left to ring out; they are already scheduled and
    // stopping them mid-decay would click.
  }

  function teardownDrone(d, at) {
    for (const o of d.oscs) {
      try { o.osc.stop(at); } catch (e) { /* already stopped */ }
    }
    if (d.lfo) {
      try { d.lfo.stop(at); } catch (e) { /* already stopped */ }
    }
  }

  function update(dt) {
    if (!playing || !ctx) return;
    const now = ctx.currentTime;

    // Reap finished plucks so the array cannot grow across a long match.
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].endsAt <= now) pending.splice(i, 1);
    }

    if (nextNoteAt < now) nextNoteAt = now + 0.05; // recover from a tab stall
    const horizon = now + LOOKAHEAD;
    let scheduled = 0;
    while (nextNoteAt < horizon && scheduled < MAX_NOTES_PER_UPDATE) {
      if (nextNoteAt < restUntil) {
        nextNoteAt = restUntil;
        continue;
      }
      nextNoteAt = scheduleSlot(nextNoteAt);
      scheduled++;
    }
  }

  function destroy() {
    const t = ctx ? ctx.currentTime : 0;
    playing = false;
    if (drone) {
      teardownDrone(drone, t);
      try { drone.gain.disconnect(); } catch (e) { /* already gone */ }
      drone = null;
    }
    for (const p of pending) {
      try { p.src.stop(t); } catch (e) { /* already stopped */ }
    }
    pending.length = 0;
  }

  return {
    start,
    stop,
    update,
    destroy,
    isPlaying: () => playing,
    // Exposed for the self-test: proves the scheduler stays bounded.
    _pendingCount: () => pending.length,
  };
}
