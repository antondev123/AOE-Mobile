// The game audio engine: mixer, voice budget, spatialisation and preferences.
//
// Module contract, matching gfx/fx.js and the other subsystems:
//   createAudio(opts) -> { play, unlock, setMuted, setVolume, ..., update(dt), destroy() }
//
// Nothing in here is wired to the event bus. The engine is a device the game
// plays; GameScene (or a thin adapter next to it) decides which events map to
// which cue, exactly as it decides which events map to which particle. That
// keeps this file testable under plain Node with a mock AudioContext, and keeps
// the sound design in one place instead of scattered through the systems.
//
// Design constraints that shaped everything below:
//  - Phones. 60 fps with 100+ units, mono speaker, and a CPU that throttles
//    when warm. Voices are capped, far-away sounds are culled before any node
//    is created, and identical simultaneous sounds are merged rather than
//    stacked.
//  - Autoplay policy. iOS and Android will not start an AudioContext outside a
//    user gesture, so the context is created lazily and unlock() is safe to
//    call from every pointerdown for the life of the page.
//  - No assets. Everything is synthesised; see synth.js and catalogue.js.
//  - Never throw. A browser with WebAudio disabled, or a context that refuses
//    to start, degrades to a silent stub with the identical API. Audio failing
//    must never take the game down with it.

import { HALF_W, HALF_H } from '../core/constants.js';
import { makeRng } from '../core/rng.js';
import { makeNoiseBuffers, createKit } from './synth.js';
import { SOUNDS, SOUND_NAMES } from './catalogue.js';
import { createMusic } from './music.js';

// Namespaced so it cannot collide with anything else on the github.io origin,
// which is shared by every project the account publishes.
const STORAGE_KEY = 'aos.audio.v1';

// Concurrency budget. 24 simultaneous voices is around 80 nodes, which a 2019
// phone mixes without trouble; past that the audio thread starts to glitch
// before the render thread does, and a glitch is more noticeable than a
// missing chop.
const DEFAULT_MAX_VOICES = 24;

// Below this final gain a voice is inaudible on a phone speaker, so it is
// dropped before any node is built. With a hundred units off-screen this is
// the single largest saving in the engine.
const MIN_AUDIBLE = 0.005;

// Spatial rolloff, in screen pixels from the camera centre (so it already
// accounts for zoom: what you can see, you can hear).
const FULL_VOLUME_PX = 240;   // inside this, no attenuation at all
const SILENT_PX = 950;        // beyond this, not played
const PAN_SPAN_PX = 300;      // horizontal offset that reaches full pan
const MAX_PAN = 0.7;          // never hard-pan: half the audience is on a
                              // single mono speaker and the other half is on
                              // earbuds, where hard pans are fatiguing.

// Music sits about -18 dB under the SFX bus. 10^(-18/20) = 0.126.
const DEFAULT_MUSIC_VOLUME = 0.126;
const DEFAULT_SFX_VOLUME = 0.9;
const DEFAULT_MASTER_VOLUME = 0.8;

// How hard "under attack" ducks the music, and how long the bus takes to come
// back. The alert has to arrive over the drone without the drone disappearing.
const DUCK_LEVEL = 0.3;
const DUCK_HOLD = 0.6;

/** Everything the silent stub and the real engine both answer to. */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// --- preferences ------------------------------------------------------------
// Wrapped in try/catch because Safari in private mode throws on both read and
// write, and losing a volume setting must not lose the game.

function loadPrefs(key) {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : null;
  } catch (e) {
    return null;
  }
}

function savePrefs(key, prefs) {
  try {
    if (globalThis.localStorage) {
      globalThis.localStorage.setItem(key, JSON.stringify(prefs));
    }
  } catch (e) {
    /* storage full, disabled, or private mode — the session still works */
  }
}

// --- silent stub ------------------------------------------------------------

/**
 * The no-op engine. Returned when WebAudio is missing or refuses to start.
 * It still honours the preference API so a settings screen keeps working and
 * the player's choice survives to a browser that can play it.
 */
function createSilentAudio(prefsKey, prefs) {
  const state = {
    muted: !!prefs.muted,
    master: prefs.master === undefined ? DEFAULT_MASTER_VOLUME : prefs.master,
    sfx: prefs.sfx === undefined ? DEFAULT_SFX_VOLUME : prefs.sfx,
    music: prefs.music === undefined ? DEFAULT_MUSIC_VOLUME : prefs.music,
  };
  const persist = () => savePrefs(prefsKey, state);

  return {
    available: false,
    names: SOUND_NAMES.slice(),
    has: (name) => Object.prototype.hasOwnProperty.call(SOUNDS, name),
    play: () => null,
    unlock: () => false,
    setListener: () => {},
    listener: { gx: 0, gy: 0, zoom: 1, set: false },
    setMuted(v) { state.muted = !!v; persist(); },
    isMuted: () => state.muted,
    toggleMuted() { state.muted = !state.muted; persist(); return state.muted; },
    setVolume(v) { state.master = clamp01(v); persist(); },
    getVolume: () => state.master,
    setSfxVolume(v) { state.sfx = clamp01(v); persist(); },
    getSfxVolume: () => state.sfx,
    setMusicVolume(v) { state.music = clamp01(v); persist(); },
    getMusicVolume: () => state.music,
    startMusic: () => {},
    stopMusic: () => {},
    isMusicPlaying: () => false,
    duckMusic: () => {},
    update: () => {},
    destroy: () => {},
    stats: () => ({ voices: 0, played: 0, coalesced: 0, dropped: 0, stolen: 0 }),
  };
}

// --- the engine -------------------------------------------------------------

/**
 * Build the audio engine.
 *
 * opts:
 *   ctx         supply an AudioContext instead of letting the engine make one
 *   storageKey  override the localStorage namespace (tests do)
 *   seed        seeds the variation PRNG and the music generator
 *   maxVoices   concurrency budget (default 24)
 *   autoUnlock  attach one-shot gesture listeners to the document (default true
 *               in a browser; the caller can do it itself instead)
 */
export function createAudio(opts = {}) {
  const prefsKey = opts.storageKey || STORAGE_KEY;
  const prefs = loadPrefs(prefsKey) || {};

  const Ctor = opts.ctx
    ? null
    : globalThis.AudioContext || globalThis.webkitAudioContext || null;
  if (!opts.ctx && !Ctor) return createSilentAudio(prefsKey, prefs);

  const rng = makeRng(opts.seed || 0xa0d10);
  const maxVoices = opts.maxVoices || DEFAULT_MAX_VOICES;

  const vol = {
    muted: !!prefs.muted,
    master: prefs.master === undefined ? DEFAULT_MASTER_VOLUME : clamp01(prefs.master),
    sfx: prefs.sfx === undefined ? DEFAULT_SFX_VOLUME : clamp01(prefs.sfx),
    music: prefs.music === undefined ? DEFAULT_MUSIC_VOLUME : clamp01(prefs.music),
  };

  const listener = { gx: 0, gy: 0, zoom: 1, set: false };

  let ctx = opts.ctx || null;
  let master = null;
  let sfxBus = null;
  let musicBus = null;
  let buffers = null;
  let kit = null;
  let music = null;
  let failed = false;          // WebAudio exists but would not start
  let unlockWanted = false;    // a gesture has asked us to run
  let sinceResumeTry = 0;      // wall-clock seconds, not context time
  let duckReleaseAt = -1;      // engine clock, -1 when not ducked
  let clock = 0;               // seconds of update(dt), independent of ctx time

  const voices = [];           // active, oldest first
  const freeVoices = [];       // pooled records, srcs arrays reused
  const lastPlay = new Map();  // cue name -> most recent voice, for coalescing
  const stats = { played: 0, coalesced: 0, dropped: 0, stolen: 0 };

  // --- graph ---------------------------------------------------------------

  function ensureContext() {
    if (ctx || failed) return ctx;
    try {
      // latencyHint 'interactive' asks the platform for the smallest buffer it
      // will give us. A gather chip that lands 100 ms after the axe visibly
      // hits reads as a bug, not as latency.
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (e) {
      failed = true;
      return null;
    }
    return ctx;
  }

  function ensureGraph() {
    if (!ensureContext()) return false;
    if (master) return true;
    try {
      master = ctx.createGain();
      sfxBus = ctx.createGain();
      musicBus = ctx.createGain();

      const now = ctx.currentTime;
      master.gain.setValueAtTime(vol.muted ? 0 : vol.master, now);
      sfxBus.gain.setValueAtTime(vol.sfx, now);
      musicBus.gain.setValueAtTime(vol.music, now);

      // A limiter on the master, not for loudness but for safety: twenty-four
      // percussive voices can sum well past 0 dBFS during a big fight, and the
      // clipping that follows is far uglier than 3 dB of gain reduction.
      let tail = master;
      if (ctx.createDynamicsCompressor) {
        const lim = ctx.createDynamicsCompressor();
        lim.threshold.setValueAtTime(-8, now);
        lim.knee.setValueAtTime(6, now);
        lim.ratio.setValueAtTime(8, now);
        lim.attack.setValueAtTime(0.004, now);
        lim.release.setValueAtTime(0.18, now);
        master.connect(lim);
        tail = lim;
      }
      tail.connect(ctx.destination);
      sfxBus.connect(master);
      musicBus.connect(master);

      buffers = makeNoiseBuffers(ctx);
      kit = createKit(ctx, buffers);
      music = createMusic(ctx, musicBus, { seed: opts.seed || 0x5eed });
      return true;
    } catch (e) {
      // A half-built graph is worse than none: fall back to silence.
      failed = true;
      master = null;
      return false;
    }
  }

  function running() {
    return !!ctx && ctx.state === 'running';
  }

  // --- spatialisation ------------------------------------------------------

  /**
   * Convert grid coordinates to a gain multiplier and a pan position.
   *
   * Distance is measured in screen pixels after the isometric projection and
   * the camera zoom, because that is what the player's sense of "near" means
   * here: zoomed out, a unit twenty tiles away is on screen and should be
   * audible; zoomed in, it is off screen and should not be.
   *
   * Until setListener() has been called even once we treat everything as
   * centred, so a caller that forgets to feed camera state gets a working (if
   * flat) mix rather than silence.
   */
  const _sp = { gain: 1, pan: 0 };
  function spatial(gx, gy) {
    if (!listener.set) {
      _sp.gain = 1;
      _sp.pan = 0;
      return _sp;
    }
    const dx = gx - listener.gx;
    const dy = gy - listener.gy;
    const z = listener.zoom || 1;
    const px = (dx - dy) * HALF_W * z;
    const py = (dx + dy) * HALF_H * z;
    const d = Math.sqrt(px * px + py * py);
    if (d >= SILENT_PX) {
      _sp.gain = 0;
      _sp.pan = 0;
      return _sp;
    }
    if (d <= FULL_VOLUME_PX) {
      _sp.gain = 1;
    } else {
      const t = (d - FULL_VOLUME_PX) / (SILENT_PX - FULL_VOLUME_PX);
      // Exponent 1.6 rather than linear: linear rolloff leaves the far half of
      // the map audible as a constant mush of half-volume chopping.
      _sp.gain = Math.pow(1 - t, 1.6);
    }
    const p = px / PAN_SPAN_PX;
    _sp.pan = (p < -1 ? -1 : p > 1 ? 1 : p) * MAX_PAN;
    return _sp;
  }

  // --- voices --------------------------------------------------------------

  function reap(now) {
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i];
      if (v.endsAt > now) continue;
      release(v);
      voices.splice(i, 1);
    }
  }

  function release(v) {
    try { v.node.disconnect(); } catch (e) { /* already detached */ }
    if (v.panner) {
      try { v.panner.disconnect(); } catch (e) { /* already detached */ }
    }
    v.srcs.length = 0;
    v.node = null;
    v.panner = null;
    if (lastPlay.get(v.name) === v) lastPlay.delete(v.name);
    freeVoices.push(v);
  }

  /** Silence a voice now and free it: stop its sources, do not just mute it. */
  function kill(v, now) {
    for (let i = 0; i < v.srcs.length; i++) {
      try { v.srcs[i].stop(now); } catch (e) { /* already stopped */ }
    }
    release(v);
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
  }

  /**
   * Pick the voice to sacrifice for a new one of `priority`, or null if the
   * new sound should be dropped instead. Priority wins, then loudness, then
   * age: the quietest oldest chatter goes first and a critical cue never goes
   * at all.
   */
  function pickVictim(priority) {
    let worst = null;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v.priority >= 3) continue; // alerts and stings are untouchable
      if (v.priority > priority) continue;
      if (
        !worst ||
        v.priority < worst.priority ||
        (v.priority === worst.priority && v.vol < worst.vol) ||
        (v.priority === worst.priority && v.vol === worst.vol && v.startedAt < worst.startedAt)
      ) {
        worst = v;
      }
    }
    return worst;
  }

  function countByName(name) {
    let n = 0;
    for (let i = 0; i < voices.length; i++) if (voices[i].name === name) n++;
    return n;
  }

  // --- play ----------------------------------------------------------------

  /**
   * Fire a cue.
   *
   *   play('chop', { x: unit.x, y: unit.y })
   *   play('underAttack')
   *   play('hammer', { rate: 1.1, volume: 0.8 })
   *
   * opts:
   *   volume  0..1 multiplier on the cue's catalogue gain
   *   rate    playback rate; > 1 is higher and faster (a real transposition)
   *   pan     -1..1, overrides the spatial pan
   *   x, y    grid coordinates; pans and attenuates from the listener
   *
   * Returns an opaque voice handle, or null when the cue was dropped (unknown
   * name, context not running, too far away, or over budget). Callers should
   * not depend on the return value — a dropped sound is a normal outcome — and
   * must not retain it: voice records are pooled and recycled once the voice
   * has finished, so a stale handle may describe some later sound entirely.
   */
  function play(name, o) {
    const def = SOUNDS[name];
    if (!def) return null;
    if (!ensureGraph()) return null;
    // Before the first gesture the context is suspended and scheduling into it
    // just queues a pile of sounds that all fire at once on unlock. Drop them.
    if (!running()) return null;

    const now = ctx.currentTime;
    reap(now);

    let v = 1;
    let pan = 0;
    if (o) {
      if (o.volume !== undefined) v = o.volume;
      if (o.x !== undefined && o.y !== undefined && def.positional !== false) {
        const sp = spatial(o.x, o.y);
        v *= sp.gain;
        pan = sp.pan;
      }
      if (o.pan !== undefined) pan = o.pan;
    }
    v *= def.gain;
    if (v < MIN_AUDIBLE) {
      stats.dropped++;
      return null;
    }

    // Coalescing. Forty villagers chopping in the same frame is forty calls to
    // play('chop'); forty voices would be both a CPU spike and a flam. Instead
    // the first one plays and the rest make it louder, which is roughly what
    // forty axes actually sound like from a distance.
    const coalesce = def.coalesce === undefined ? 0.06 : def.coalesce;
    if (coalesce > 0) {
      const prev = lastPlay.get(name);
      if (prev && prev.node && now - prev.startedAt < coalesce) {
        stats.coalesced++;
        prev.hits++;
        // Roughly +1.4 dB per extra hit, hard-capped at +5 dB: a crowd of axes
        // is louder than one axe, but not forty times louder. The cap is taken
        // against the loudest single contributor (`base`), never against the
        // already-boosted level, or forty hits would compound to silly gains.
        prev.base = Math.max(prev.base, v);
        const target = Math.min(prev.base * 1.8, prev.base * (1 + 0.18 * (prev.hits - 1)));
        prev.vol = target;
        try { prev.node.gain.value = target; } catch (e) { /* param locked */ }
        return prev;
      }
    }

    // Per-cue concurrency. Coalescing only catches sounds in the same window;
    // this catches the staggered case, where forty gather timers have drifted
    // 80 ms apart and every one of them misses the coalesce window.
    const perCue = def.maxVoices || 3;
    if (countByName(name) >= perCue) {
      stats.dropped++;
      return null;
    }

    const priority = def.priority === undefined ? 1 : def.priority;
    if (voices.length >= maxVoices) {
      const victim = pickVictim(priority);
      if (!victim) {
        stats.dropped++;
        return null;
      }
      stats.stolen++;
      kill(victim, now);
    }

    // Build the voice.
    let rec = freeVoices.pop();
    if (!rec) rec = { srcs: [] };
    let node;
    let panner = null;
    try {
      node = ctx.createGain();
      node.gain.value = v;
      if (pan !== 0 && ctx.createStereoPanner) {
        panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        node.connect(panner);
        panner.connect(sfxBus);
      } else {
        node.connect(sfxBus);
      }

      rec.name = name;
      rec.node = node;
      rec.panner = panner;
      rec.priority = priority;
      rec.vol = v;
      rec.base = v;
      rec.hits = 1;
      rec.startedAt = now;
      rec.srcs.length = 0;

      kit.begin(node, now, rng, o && o.rate ? o.rate : 1, rec.srcs);
      def.render(kit);
      // A recipe that scheduled nothing still needs a lifetime, or it would sit
      // in the voice list forever holding a slot.
      rec.endsAt = Math.max(kit.end, now + 0.05);
    } catch (e) {
      // One bad recipe must not kill the mixer; drop this voice and carry on.
      if (rec) {
        rec.srcs.length = 0;
        freeVoices.push(rec);
      }
      stats.dropped++;
      return null;
    }

    voices.push(rec);
    lastPlay.set(name, rec);
    stats.played++;
    return rec;
  }

  // --- transport and mixing ------------------------------------------------

  function applyMaster() {
    if (!master) return;
    const now = ctx.currentTime;
    // setTargetAtTime rather than an assignment: stepping a gain during a
    // sustained drone is an audible click on every device.
    master.gain.setTargetAtTime(vol.muted ? 0 : vol.master, now, 0.02);
  }

  function applySfx() {
    if (!sfxBus) return;
    sfxBus.gain.setTargetAtTime(vol.sfx, ctx.currentTime, 0.02);
  }

  function applyMusic(ducked) {
    if (!musicBus) return;
    const level = vol.music * (ducked ? DUCK_LEVEL : 1);
    // Slower constant on the way down than up: a duck should feel like the
    // music stepping aside, and the recovery should be unnoticeable.
    musicBus.gain.setTargetAtTime(level, ctx.currentTime, ducked ? 0.05 : 0.8);
  }

  /**
   * Resume the context. Safe to call on every pointerdown for the life of the
   * page: after the first success this is a state check and a no-op.
   */
  function unlock() {
    unlockWanted = true;
    if (!ensureGraph()) return false;
    if (ctx.state === 'running') return true;
    try {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      /* the gesture was not trusted; the next one may be */
    }
    // Some iOS builds only truly start the clock once something has been
    // played, so nudge it with one silent frame. It costs nothing and it is
    // the difference between "audio works" and "audio works after the second
    // tap" on older hardware.
    try {
      if (buffers) {
        const s = ctx.createBufferSource();
        s.buffer = buffers.white;
        const g = ctx.createGain();
        g.gain.value = 0;
        s.connect(g);
        g.connect(master);
        s.start(ctx.currentTime, 0, 0.01);
        s.stop(ctx.currentTime + 0.02);
      }
    } catch (e) {
      /* not fatal */
    }
    return ctx.state === 'running';
  }

  function setListener(gx, gy, zoom) {
    listener.gx = gx;
    listener.gy = gy;
    if (zoom) listener.zoom = zoom;
    listener.set = true;
  }

  function persist() {
    savePrefs(prefsKey, {
      muted: vol.muted,
      master: vol.master,
      sfx: vol.sfx,
      music: vol.music,
    });
  }

  function duckMusic(seconds) {
    if (!musicBus) return;
    duckReleaseAt = clock + (seconds === undefined ? DUCK_HOLD : seconds);
    applyMusic(true);
  }

  function update(dt) {
    clock += dt || 0;
    if (!ctx || !master) return;

    // The OS suspends the context when the phone locks or the tab goes to the
    // background. Once the player has asked for sound, keep trying to get it
    // back — but only twice a second, because resume() on a running context
    // still costs a promise.
    if (unlockWanted && ctx.state !== 'running') {
      sinceResumeTry += dt || 0;
      if (sinceResumeTry > 0.5) {
        sinceResumeTry = 0;
        try {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (e) { /* still blocked */ }
      }
      return;
    }

    reap(ctx.currentTime);

    if (duckReleaseAt >= 0 && clock >= duckReleaseAt) {
      duckReleaseAt = -1;
      applyMusic(false);
    }

    if (music) music.update(dt || 0);
  }

  function destroy() {
    const now = ctx ? ctx.currentTime : 0;
    for (let i = voices.length - 1; i >= 0; i--) kill(voices[i], now);
    voices.length = 0;
    freeVoices.length = 0;
    lastPlay.clear();
    if (music) music.destroy();
    music = null;
    if (master) {
      try { master.disconnect(); } catch (e) { /* already gone */ }
    }
    // Only close a context we own. A caller that injected one may still want it.
    if (ctx && !opts.ctx && ctx.close) {
      try {
        const p = ctx.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) { /* already closing */ }
    }
    master = sfxBus = musicBus = kit = buffers = null;
    ctx = null;
  }

  const api = {
    available: true,
    names: SOUND_NAMES.slice(),
    has: (name) => Object.prototype.hasOwnProperty.call(SOUNDS, name),
    play,
    unlock,
    setListener,
    listener,

    setMuted(v) {
      vol.muted = !!v;
      applyMaster();
      persist();
      // Muting while the drone is running would leave it burning CPU for
      // nothing over a twenty-minute match.
      if (vol.muted && music && music.isPlaying()) music.stop();
    },
    isMuted: () => vol.muted,
    toggleMuted() {
      api.setMuted(!vol.muted);
      return vol.muted;
    },

    setVolume(v) { vol.master = clamp01(v); applyMaster(); persist(); },
    getVolume: () => vol.master,
    setSfxVolume(v) { vol.sfx = clamp01(v); applySfx(); persist(); },
    getSfxVolume: () => vol.sfx,
    setMusicVolume(v) {
      vol.music = clamp01(v);
      applyMusic(duckReleaseAt >= 0);
      persist();
    },
    getMusicVolume: () => vol.music,

    startMusic() {
      if (vol.muted) return;
      if (!ensureGraph() || !running()) return;
      applyMusic(false);
      music.start();
    },
    stopMusic() {
      if (music) music.stop();
    },
    isMusicPlaying: () => !!music && music.isPlaying(),
    duckMusic,

    update,
    destroy,

    /** Debug/telemetry only; the shape is not a contract. */
    stats: () => ({
      voices: voices.length,
      pooled: freeVoices.length,
      music: music ? music._pendingCount() : 0,
      ...stats,
    }),
  };

  // Convenience: one listener per gesture type, removed on the first success.
  // The caller can opt out and drive unlock() itself from ui/input.js.
  if (opts.autoUnlock !== false && typeof document !== 'undefined' &&
      document.addEventListener) {
    const kick = () => {
      if (unlock()) {
        document.removeEventListener('pointerdown', kick, true);
        document.removeEventListener('touchend', kick, true);
        document.removeEventListener('keydown', kick, true);
      }
    };
    document.addEventListener('pointerdown', kick, true);
    document.addEventListener('touchend', kick, true);
    document.addEventListener('keydown', kick, true);
  }

  return api;
}
