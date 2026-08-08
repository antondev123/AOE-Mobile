// The sound catalogue: one recipe per named cue.
//
// A recipe is a function that draws with the kit from synth.js. It never keeps
// state and never allocates buffers — it schedules a few oscillators and noise
// bursts relative to `k.t` and returns. The mixer works out when the voice ends
// from `k.end`, so a recipe does not have to report its own length.
//
// Per-entry knobs the mixer reads:
//   gain        base level before master/sfx/spatial gain. Tuned so that the
//               loud end (a collapsing town centre) and the quiet end (a
//               villager picking berries) coexist without a mastering stage.
//   priority    0 chatter, 1 normal, 2 notable, 3 critical. Voice stealing
//               drops the lowest priority first, and a priority-3 cue is never
//               stolen — "under attack" must survive a battle full of arrows.
//   coalesce    seconds within which repeats of this cue merge into one
//               slightly louder instance instead of stacking. Set to 0 for
//               cues that are inherently singular (victory, age advance).
//   maxVoices   hard cap on concurrent instances of this one cue. Coalescing
//               handles simultaneous fire; this catches staggered fire, e.g.
//               forty villagers whose chop timers drift 80 ms apart.
//   positional  false for anything that is a message to the player rather than
//               an event in the world (UI, alerts, stings) — those must not
//               get quieter because the camera is looking elsewhere.

export const SOUNDS = {
  // --- gathering ------------------------------------------------------------

  // Axe into a trunk. The transient is the axe head (a bright, very short
  // noise crack) and the body is the trunk answering (a low triangle that
  // drops a fifth in 60 ms). Wood is the sound of the body, not the crack, so
  // the noise is deliberately quieter and shorter than instinct suggests.
  chop: {
    gain: 0.5, priority: 0, coalesce: 0.09, maxVoices: 3,
    render(k) {
      const f = k.rand(0.92, 1.1);
      k.hiss({ buf: 'white', bp: 1900 * f, q: 1.1, peak: 0.35, attack: 0.001, decay: 0.028 });
      k.tone({ type: 'triangle', freq: 168 * f, to: 104 * f, glide: 0.06,
        peak: 0.55, attack: 0.002, decay: 0.13, lp: 1400 });
      // A little mid "crunch" of fibres tearing, one octave up and half as loud.
      k.hiss({ buf: 'pink', bp: 760 * f, q: 2.2, peak: 0.16, attack: 0.004, decay: 0.09, delay: 0.01 });
    },
  },

  // Pick on stone or a gold vein. Metal on rock is inharmonic and rings
  // briefly: three partials at non-integer ratios (1 : 1.47 : 2.09) over a
  // dull rock thud. The ratios are what stop it sounding like a bell.
  mine: {
    gain: 0.5, priority: 0, coalesce: 0.09, maxVoices: 3,
    render(k) {
      const f = k.rand(0.94, 1.08);
      k.hiss({ buf: 'white', hp: 3200 * f, peak: 0.3, attack: 0.001, decay: 0.02 });
      k.stack([2150 * f, 3160 * f, 4490 * f], {
        type: 'sine', peak: 0.3, falloff: 0.45, attack: 0.002, decay: 0.11, spread: 0.002,
      });
      k.tone({ type: 'triangle', freq: 190 * f, to: 120 * f, glide: 0.05,
        peak: 0.32, attack: 0.002, decay: 0.1, lp: 900 });
    },
  },

  // Berries: a hand going into a bush. Pink noise through a bandpass that
  // falls as the branch springs back, with a soft attack so there is no click.
  forage: {
    gain: 1.0, priority: 0, coalesce: 0.11, maxVoices: 3,
    render(k) {
      const f = k.rand(0.9, 1.15);
      k.hiss({ buf: 'pink', bp: 2100 * f, toFreq: 900 * f, sweep: 0.2, q: 0.9,
        peak: 0.4, attack: 0.02, decay: 0.22 });
      k.hiss({ buf: 'pink', bp: 3400 * f, q: 1.4, peak: 0.14, attack: 0.008, decay: 0.07, delay: 0.06 });
    },
  },

  // Farm: the same gesture as foraging but lower and earthier — a sickle in
  // wheat rather than fingers in a bush. Kept separate so a farm-heavy economy
  // does not sound identical to a berry-heavy one.
  farm: {
    gain: 0.85, priority: 0, coalesce: 0.11, maxVoices: 3,
    render(k) {
      const f = k.rand(0.88, 1.06);
      k.hiss({ buf: 'pink', bp: 1400 * f, toFreq: 620 * f, sweep: 0.24, q: 0.8,
        peak: 0.42, attack: 0.016, decay: 0.26 });
      k.tone({ type: 'sine', freq: 130 * f, to: 96 * f, peak: 0.12, attack: 0.01, decay: 0.14, lp: 400 });
    },
  },

  // Sack of goods onto the pile, with the coins on top. Three detuned tinkles
  // staggered by ~35 ms read as several coins; perfectly simultaneous ones
  // read as a single chime.
  deposit: {
    gain: 0.5, priority: 1, coalesce: 0.12, maxVoices: 2,
    render(k) {
      const f = k.rand(0.96, 1.06);
      k.tone({ type: 'sine', freq: 120, to: 78, peak: 0.4, attack: 0.004, decay: 0.16, lp: 600 });
      k.hiss({ buf: 'pink', bp: 900, q: 1.1, peak: 0.18, attack: 0.006, decay: 0.1 });
      k.stack([2350 * f, 2820 * f, 3510 * f], {
        type: 'sine', peak: 0.22, falloff: 0.7, attack: 0.002, decay: 0.16, spread: 0.035, delay: 0.02,
      });
    },
  },

  // A node ran dry. A short descending "that's it" — not a failure sound, so
  // it stays consonant (a falling minor third) and quiet.
  nodeDepleted: {
    gain: 0.3, priority: 2, coalesce: 0.2, maxVoices: 2, positional: true,
    render(k) {
      k.tone({ type: 'triangle', freq: 520, peak: 0.3, attack: 0.006, decay: 0.16, lp: 2600 });
      k.tone({ type: 'triangle', freq: 415, peak: 0.26, attack: 0.006, decay: 0.24, lp: 2200, delay: 0.1 });
      k.hiss({ buf: 'pink', bp: 1200, q: 1.2, peak: 0.1, attack: 0.01, decay: 0.18, delay: 0.02 });
    },
  },

  // --- building -------------------------------------------------------------

  // One hammer tap. Meant to be fired repeatedly while a site is under
  // construction, so it is short, cheap, and randomly pitched: a fixed pitch
  // repeated every 400 ms becomes a metronome within seconds.
  hammer: {
    gain: 0.5, priority: 0, coalesce: 0.1, maxVoices: 3,
    render(k) {
      const f = k.rand(0.85, 1.2);
      k.hiss({ buf: 'white', bp: 2600 * f, q: 1.6, peak: 0.3, attack: 0.001, decay: 0.022 });
      k.tone({ type: 'triangle', freq: 240 * f, to: 170 * f, glide: 0.05,
        peak: 0.45, attack: 0.002, decay: 0.1, lp: 1600 });
      k.tone({ type: 'sine', freq: 88, peak: 0.2, attack: 0.003, decay: 0.07, lp: 300 });
    },
  },

  // Construction finished. A warm major triad with a soft attack — the reward
  // has to feel settled rather than sharp, because it fires while the player
  // is usually doing something else.
  buildComplete: {
    gain: 0.5, priority: 2, coalesce: 0, maxVoices: 2, positional: true,
    render(k) {
      // G3 - B3 - D4 - G4, rolled slightly, through a lowpass so it reads as
      // wood and horn rather than a synth pad.
      k.stack([196, 246.9, 293.7, 392], {
        type: 'triangle', peak: 0.3, falloff: 0.82, attack: 0.02, decay: 0.75,
        spread: 0.045, lp: 2200,
      });
      k.hiss({ buf: 'pink', bp: 1800, toFreq: 700, sweep: 0.3, q: 0.7,
        peak: 0.1, attack: 0.02, decay: 0.3 });
    },
  },

  // Foundation pegged out. A wooden peg into soil plus a small rising blip so
  // the player knows the tap was accepted even with the finger over the tile.
  placeFoundation: {
    gain: 0.42, priority: 2, coalesce: 0.05, maxVoices: 2, positional: false,
    render(k) {
      k.tone({ type: 'triangle', freq: 300, to: 150, glide: 0.07,
        peak: 0.4, attack: 0.002, decay: 0.12, lp: 1800 });
      k.hiss({ buf: 'brown', lp: 700, peak: 0.25, attack: 0.003, decay: 0.13 });
      k.tone({ type: 'sine', freq: 587.3, to: 784, glide: 0.07,
        peak: 0.22, attack: 0.006, decay: 0.16, delay: 0.05 });
    },
  },

  // --- combat ---------------------------------------------------------------

  // Sword on shield: a body thud plus a short metallic ring. The thud carries
  // the weight, the metal carries the material; either alone sounds cheap.
  meleeHit: {
    gain: 0.5, priority: 1, coalesce: 0.07, maxVoices: 4,
    render(k) {
      const f = k.rand(0.9, 1.12);
      k.tone({ type: 'sine', freq: 150 * f, to: 62, glide: 0.09,
        peak: 0.6, attack: 0.002, decay: 0.15, lp: 700 });
      k.hiss({ buf: 'white', bp: 2600 * f, toFreq: 1400 * f, sweep: 0.08, q: 1.2,
        peak: 0.3, attack: 0.001, decay: 0.07 });
      k.stack([1580 * f, 2360 * f], {
        type: 'sine', peak: 0.16, falloff: 0.6, attack: 0.002, decay: 0.12, spread: 0.003,
      });
    },
  },

  // Bow release. The twang is a fast downward pitch sweep (the string losing
  // tension), the air is a short noise sweep behind it (the fletching). Very
  // quiet on purpose: a dozen archers volleying should be texture, not a wall.
  arrowLoose: {
    gain: 0.55, priority: 1, coalesce: 0.06, maxVoices: 4,
    render(k) {
      const f = k.rand(0.94, 1.1);
      k.tone({ type: 'sawtooth', freq: 360 * f, to: 150 * f, glide: 0.07,
        peak: 0.3, attack: 0.002, decay: 0.11, lp: 1500 });
      k.hiss({ buf: 'white', bp: 3600 * f, toFreq: 1500 * f, sweep: 0.12, q: 2.4,
        peak: 0.24, attack: 0.004, decay: 0.14, delay: 0.01 });
    },
  },

  // Arrow landing. Duller and shorter than a melee hit — there is no metal
  // ring, just the shaft stopping and a low thump.
  arrowHit: {
    gain: 0.5, priority: 1, coalesce: 0.07, maxVoices: 4,
    render(k) {
      const f = k.rand(0.9, 1.12);
      k.hiss({ buf: 'white', bp: 1500 * f, q: 1.6, peak: 0.3, attack: 0.001, decay: 0.035 });
      k.tone({ type: 'triangle', freq: 210 * f, to: 110 * f, glide: 0.05,
        peak: 0.4, attack: 0.002, decay: 0.09, lp: 900 });
    },
  },

  // A unit falls. Deliberately not gory: a short breath (bandpassed pink noise
  // sweeping down) over a falling sine. It reads as "gone" without being a
  // scream, which matters in a game a child might play on a phone.
  unitDeath: {
    gain: 0.55, priority: 2, coalesce: 0.09, maxVoices: 3,
    render(k) {
      const f = k.rand(0.9, 1.14);
      k.hiss({ buf: 'pink', bp: 1000 * f, toFreq: 320 * f, sweep: 0.3, q: 1.6,
        peak: 0.34, attack: 0.01, decay: 0.34 });
      k.tone({ type: 'triangle', freq: 250 * f, to: 118 * f, glide: 0.3,
        peak: 0.26, attack: 0.012, decay: 0.36, lp: 1100 });
      k.hiss({ buf: 'brown', lp: 500, peak: 0.16, attack: 0.02, decay: 0.28, delay: 0.12 });
    },
  },

  // A building comes down. Brown noise for the mass of rubble, a sub-bass
  // sweep for the ground shock, and three staggered mid cracks for the timbers
  // giving way. The longest cue in the set at roughly 1.5 s.
  buildingDestroyed: {
    gain: 0.75, priority: 3, coalesce: 0.25, maxVoices: 2,
    render(k) {
      k.hiss({ buf: 'brown', lp: 900, toFreq: 180, sweep: 1.1, peak: 0.7,
        attack: 0.01, hold: 0.08, decay: 1.15 });
      k.tone({ type: 'sine', freq: 74, to: 34, glide: 0.9,
        peak: 0.6, attack: 0.01, decay: 1.0, lp: 200 });
      for (let i = 0; i < 3; i++) {
        k.hiss({ buf: 'white', bp: k.rand(700, 1800), q: 2.2, peak: 0.2,
          attack: 0.002, decay: 0.09, delay: 0.12 + i * k.rand(0.08, 0.22) });
      }
      k.hiss({ buf: 'pink', lp: 2200, toFreq: 400, sweep: 0.8, peak: 0.16,
        attack: 0.15, decay: 0.9, delay: 0.2 });
    },
  },

  // --- UI -------------------------------------------------------------------

  // Selecting a unit. Almost subliminal: this fires on every tap, so anything
  // with a tail becomes irritating inside a minute.
  select: {
    gain: 0.42, priority: 1, coalesce: 0.04, maxVoices: 2, positional: false,
    render(k) {
      k.tone({ type: 'sine', freq: 880, peak: 0.3, attack: 0.002, decay: 0.045, lp: 3000 });
      k.hiss({ buf: 'white', hp: 4000, peak: 0.1, attack: 0.001, decay: 0.012 });
    },
  },

  // Order accepted. Brighter than select and rising, so "I heard you" and
  // "I selected something" are distinguishable without looking.
  commandAck: {
    gain: 0.42, priority: 1, coalesce: 0.05, maxVoices: 2, positional: false,
    render(k) {
      k.tone({ type: 'triangle', freq: 660, peak: 0.28, attack: 0.003, decay: 0.06, lp: 3500 });
      k.tone({ type: 'triangle', freq: 990, peak: 0.24, attack: 0.003, decay: 0.1,
        lp: 4000, delay: 0.045 });
    },
  },

  // Refused: too expensive, population capped, cannot build there. A low
  // detuned square pair beating against each other through a lowpass — dull
  // and slightly unpleasant, which is exactly the message.
  invalid: {
    gain: 0.36, priority: 2, coalesce: 0.15, maxVoices: 1, positional: false,
    render(k) {
      k.tone({ type: 'square', freq: 118, peak: 0.3, attack: 0.006, hold: 0.05, decay: 0.16, lp: 620 });
      k.tone({ type: 'square', freq: 111, peak: 0.28, attack: 0.006, hold: 0.05, decay: 0.18, lp: 560 });
    },
  },

  // A HUD button. Quieter and drier than `select` so the chrome never competes
  // with the world.
  buttonTap: {
    gain: 0.36, priority: 1, coalesce: 0.04, maxVoices: 2, positional: false,
    render(k) {
      k.tone({ type: 'sine', freq: 1250, peak: 0.24, attack: 0.001, decay: 0.03 });
      k.hiss({ buf: 'white', hp: 5000, peak: 0.08, attack: 0.001, decay: 0.01 });
    },
  },

  // --- event stings ---------------------------------------------------------

  // Advancing an age. A rising major triad answered by the octave, with a soft
  // pad underneath. Celebratory but capped well below the stings: it fires
  // mid-game while the player is managing an economy, not at a screen break.
  ageAdvance: {
    gain: 0.55, priority: 3, coalesce: 0, maxVoices: 1, positional: false,
    render(k) {
      // C4 E4 G4 then C5 — arpeggiated at ~150 ms, the pace of a fanfare and
      // not a strum.
      const notes = [261.6, 329.6, 392, 523.3];
      for (let i = 0; i < notes.length; i++) {
        k.tone({ type: 'triangle', freq: notes[i], peak: 0.3, attack: 0.012,
          decay: i === 3 ? 0.9 : 0.45, lp: 3000, delay: i * 0.15 });
        k.tone({ type: 'sine', freq: notes[i] * 2, peak: 0.08, attack: 0.012,
          decay: 0.3, delay: i * 0.15 });
      }
      // Slow swell under the arpeggio, arriving with the top note.
      k.tone({ type: 'triangle', freq: 130.8, peak: 0.22, attack: 0.35, hold: 0.1,
        decay: 0.8, lp: 900 });
    },
  },

  // A villager is ready. Soft, domestic, two notes up a fourth. Fires often,
  // so it must be pleasant at the twentieth repetition.
  villagerTrained: {
    gain: 0.42, priority: 2, coalesce: 0.12, maxVoices: 2, positional: false,
    render(k) {
      k.tone({ type: 'sine', freq: 587.3, peak: 0.26, attack: 0.008, decay: 0.14, lp: 3000 });
      k.tone({ type: 'sine', freq: 784, peak: 0.24, attack: 0.008, decay: 0.26, lp: 3000, delay: 0.08 });
    },
  },

  // A soldier is ready. The same event with a martial accent: a small drum
  // under a horn-ish fifth, so the player can tell a barracks from a town
  // centre with the phone in a pocket.
  unitTrained: {
    gain: 0.38, priority: 2, coalesce: 0.12, maxVoices: 2, positional: false,
    render(k) {
      k.tone({ type: 'sine', freq: 110, to: 70, glide: 0.09, peak: 0.35,
        attack: 0.003, decay: 0.16, lp: 400 });
      k.hiss({ buf: 'brown', lp: 1200, peak: 0.16, attack: 0.002, decay: 0.1 });
      k.tone({ type: 'sawtooth', freq: 293.7, peak: 0.2, attack: 0.02, decay: 0.22,
        lp: 1600, delay: 0.05 });
      k.tone({ type: 'sawtooth', freq: 440, peak: 0.18, attack: 0.02, decay: 0.3,
        lp: 1800, delay: 0.12 });
    },
  },

  // Under attack. This is the one cue that has to arrive through everything
  // else, so: a tritone-ish two-tone alternation (the interval every emergency
  // signal on earth uses because it never occurs in the rest of this soundset),
  // repeated twice, bandpassed into the 700-1400 Hz range a phone speaker
  // actually reproduces, and priority 3 so it is never stolen. The engine also
  // ducks the music under it.
  underAttack: {
    gain: 0.7, priority: 3, coalesce: 0.6, maxVoices: 1, positional: false,
    render(k) {
      const pattern = [880, 622.3, 880, 622.3];
      for (let i = 0; i < pattern.length; i++) {
        k.tone({ type: 'square', freq: pattern[i], peak: 0.3, attack: 0.005,
          hold: 0.09, decay: 0.09, lp: 2200, delay: i * 0.19 });
        k.tone({ type: 'sine', freq: pattern[i] / 2, peak: 0.14, attack: 0.005,
          hold: 0.09, decay: 0.09, delay: i * 0.19 });
      }
    },
  },

  // Victory. A rising fanfare that lands on the octave and is allowed a real
  // tail, because nothing else is competing with it by then.
  victory: {
    gain: 0.6, priority: 3, coalesce: 0, maxVoices: 1, positional: false,
    render(k) {
      const notes = [261.6, 392, 523.3, 659.3, 784];
      for (let i = 0; i < notes.length; i++) {
        k.tone({ type: 'triangle', freq: notes[i], peak: 0.28, attack: 0.01,
          decay: i === notes.length - 1 ? 1.5 : 0.4, lp: 3500, delay: i * 0.13 });
      }
      k.tone({ type: 'triangle', freq: 130.8, peak: 0.24, attack: 0.2, hold: 0.3,
        decay: 1.2, lp: 800, delay: 0.2 });
      k.hiss({ buf: 'pink', bp: 2600, toFreq: 900, sweep: 0.6, q: 0.7,
        peak: 0.08, attack: 0.15, decay: 0.8 });
    },
  },

  // Defeat. The same shape inverted: a falling minor line over a slowly
  // sagging drone. Long and quiet rather than harsh — losing should feel
  // heavy, not punished.
  defeat: {
    gain: 0.55, priority: 3, coalesce: 0, maxVoices: 1, positional: false,
    render(k) {
      const notes = [349.2, 311.1, 261.6, 207.7];
      for (let i = 0; i < notes.length; i++) {
        k.tone({ type: 'triangle', freq: notes[i], peak: 0.26, attack: 0.02,
          decay: i === notes.length - 1 ? 1.6 : 0.5, lp: 2200, delay: i * 0.2 });
      }
      k.tone({ type: 'sine', freq: 103.8, to: 82, glide: 1.6, peak: 0.3,
        attack: 0.3, decay: 1.6, lp: 400 });
    },
  },
};

/** Stable list of every registered cue name. */
export const SOUND_NAMES = Object.keys(SOUNDS);
