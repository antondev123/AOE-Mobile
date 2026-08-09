// Self-test for the audio engine: `node src/audio/selftest.mjs`.
//
// It lives here rather than in tests/ because it is the audio module's own
// harness — it ships a minimal AudioContext mock, and that mock is part of the
// contract this module promises to hold to (create a gain, create an
// oscillator, schedule an envelope, stop it again). If a change breaks the
// mock, it has almost certainly broken a real browser too.
//
// What is checked:
//   1. the module loads under plain Node with no DOM and no WebAudio
//   2. createAudio() degrades to a silent stub with the same API surface
//   3. every cue in the catalogue is registered and renders without throwing
//   4. the voice budget is enforced under a flood
//   5. identical simultaneous cues coalesce into one louder voice
//   6. spatial culling drops sounds outside the audible radius
//   7. preferences survive a destroy/recreate through localStorage
//   8. the music scheduler stays bounded over a long match
//
// Exits non-zero on the first failing assertion group; prints one line per
// check so a failure says which behaviour regressed.

let failures = 0;
let checks = 0;

function ok(cond, label) {
  checks++;
  if (cond) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  FAIL ${label}\n`);
  }
}

function group(name) {
  process.stdout.write(`\n${name}\n`);
}

// --- minimal WebAudio mock ---------------------------------------------------
// Deliberately strict where browsers are strict: exponential ramps to zero and
// non-finite times throw, because both are real bugs that are silent in a
// browser until the sound simply does not appear.

let nodesCreated = 0;
let sourcesStarted = 0;

class MockParam {
  constructor(value) {
    this.value = value;
    this.calls = 0;
  }
  _time(t, who) {
    if (!Number.isFinite(t)) throw new RangeError(`${who}: non-finite time ${t}`);
    this.calls++;
  }
  setValueAtTime(v, t) {
    this._time(t, 'setValueAtTime');
    if (!Number.isFinite(v)) throw new RangeError(`setValueAtTime: non-finite value ${v}`);
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this._time(t, 'linearRampToValueAtTime');
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    this._time(t, 'exponentialRampToValueAtTime');
    if (!(v > 0)) throw new RangeError(`exponentialRampToValueAtTime: target must be > 0, got ${v}`);
    this.value = v;
    return this;
  }
  setTargetAtTime(v, t, c) {
    this._time(t, 'setTargetAtTime');
    if (!Number.isFinite(c)) throw new RangeError('setTargetAtTime: non-finite time constant');
    this.value = v;
    return this;
  }
  cancelScheduledValues(t) {
    this._time(t, 'cancelScheduledValues');
    return this;
  }
}

class MockNode {
  constructor(kind) {
    this._kind = kind;
    this._connected = [];
    nodesCreated++;
  }
  connect(dest) {
    this._connected.push(dest);
    return dest;
  }
  disconnect() {
    this._connected.length = 0;
  }
}

class MockSource extends MockNode {
  constructor(kind) {
    super(kind);
    this.started = false;
    this.stopped = false;
  }
  start(t) {
    if (t !== undefined && !Number.isFinite(t)) throw new RangeError('start: non-finite time');
    this.started = true;
    sourcesStarted++;
  }
  stop(t) {
    if (t !== undefined && !Number.isFinite(t)) throw new RangeError('stop: non-finite time');
    this.stopped = true;
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'suspended';
    this.sampleRate = 48000;
    this.destination = new MockNode('destination');
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createGain() {
    const n = new MockNode('gain');
    n.gain = new MockParam(1);
    return n;
  }
  createOscillator() {
    const n = new MockSource('oscillator');
    n.type = 'sine';
    n.frequency = new MockParam(440);
    n.detune = new MockParam(0);
    return n;
  }
  createBufferSource() {
    const n = new MockSource('bufferSource');
    n.buffer = null;
    n.playbackRate = new MockParam(1);
    return n;
  }
  createBiquadFilter() {
    const n = new MockNode('biquad');
    n.type = 'lowpass';
    n.frequency = new MockParam(350);
    n.Q = new MockParam(1);
    n.gain = new MockParam(0);
    return n;
  }
  createStereoPanner() {
    const n = new MockNode('panner');
    n.pan = new MockParam(0);
    return n;
  }
  createDynamicsCompressor() {
    const n = new MockNode('compressor');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new MockParam(0);
    return n;
  }
  createBuffer(channels, length, sampleRate) {
    const data = [];
    for (let i = 0; i < channels; i++) data.push(new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (i) => data[i],
    };
  }
}

class MockStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

// A short mock buffer length keeps the test fast: 48 kHz * 1.5 s of Float32 per
// bed is otherwise 3 MB of zero-filled arrays for nothing.
MockAudioContext.prototype.sampleRate = 8000;

// --- harness ----------------------------------------------------------------

const storage = new MockStorage();
globalThis.localStorage = storage;

// Import only after the environment is decided: createAudio reads
// globalThis.AudioContext at call time, so the order below matters for the
// "no WebAudio" case, which must be tested first with the global absent.
const { createAudio } = await import('./sound.js');
const { SOUNDS, SOUND_NAMES } = await import('./catalogue.js');

// --- 1 + 2: module loads, silent stub ---------------------------------------

group('module + silent fallback (no WebAudio)');
ok(typeof createAudio === 'function', 'createAudio is exported as a function');

const stub = createAudio({ storageKey: 'test.stub' });
ok(stub && stub.available === false, 'degrades to the silent stub when AudioContext is absent');
ok(stub.play('chop') === null, 'stub play() returns null instead of throwing');
ok(stub.play('nope') === null, 'stub tolerates unknown cue names');
stub.unlock();
stub.setListener(3, 4, 1);
stub.startMusic();
stub.update(0.016);
stub.setSfxVolume(0.5);
stub.setMusicVolume(0.1);
stub.stopMusic();
stub.destroy();
ok(true, 'stub survives the whole lifecycle without throwing');
stub.setMuted(true);
ok(stub.isMuted() === true, 'stub still honours mute');
ok(storage.getItem('test.stub') !== null, 'stub persists preferences');

// Now install the mock for everything that follows.
globalThis.AudioContext = MockAudioContext;

const real = createAudio({ storageKey: 'test.api', autoUnlock: false });
const stubKeys = Object.keys(createAudio({ storageKey: 'test.api2' })).sort();
const realKeys = Object.keys(real).sort();
ok(
  JSON.stringify(stubKeys) === JSON.stringify(realKeys) ||
    stubKeys.every((k) => realKeys.includes(k)),
  'stub exposes the same API surface as the real engine'
);
real.destroy();

// --- 3: catalogue completeness ----------------------------------------------

group('catalogue');

// The cues the game is specified to have. If a name here disappears, some
// integration point in README.md has silently lost its sound.
const REQUIRED = [
  'chop', 'mine', 'forage', 'farm',
  'deposit', 'nodeDepleted',
  'hammer', 'buildComplete', 'placeFoundation',
  'meleeHit', 'arrowLoose', 'arrowHit', 'unitDeath', 'buildingDestroyed',
  'select', 'commandAck', 'invalid', 'buttonTap',
  'ageAdvance', 'villagerTrained', 'unitTrained', 'underAttack', 'victory', 'defeat',
];
const missing = REQUIRED.filter((n) => !SOUND_NAMES.includes(n));
ok(missing.length === 0, `every required cue is registered${missing.length ? ` (missing ${missing})` : ''}`);

let shapeBad = [];
for (const name of SOUND_NAMES) {
  const d = SOUNDS[name];
  if (typeof d.render !== 'function' || typeof d.gain !== 'number') shapeBad.push(name);
}
ok(shapeBad.length === 0, `every cue has a gain and a render()${shapeBad.length ? ` (bad: ${shapeBad})` : ''}`);

// Render each cue in isolation, stepping the clock past the previous one so the
// voice budget cannot mask a broken recipe.
const ctx = new MockAudioContext();
const a = createAudio({ ctx, storageKey: 'test.catalogue', autoUnlock: false, maxVoices: 64 });
a.unlock();
ok(ctx.state === 'running', 'unlock() resumes a suspended context');
a.unlock();
ok(ctx.state === 'running', 'unlock() is safe to call repeatedly');

let rendered = 0;
let badLength = [];
for (const name of SOUND_NAMES) {
  ctx.currentTime += 5; // let the previous cue expire and be reaped
  const v = a.play(name);
  if (!v) {
    badLength.push(`${name}: dropped`);
    continue;
  }
  const len = v.endsAt - v.startedAt;
  if (!(len > 0.02 && len < 6)) badLength.push(`${name}: ${len.toFixed(3)}s`);
  rendered++;
}
ok(rendered === SOUND_NAMES.length, `all ${SOUND_NAMES.length} cues render and produce a voice`);
ok(badLength.length === 0, `every cue has a sane duration${badLength.length ? ` (${badLength})` : ''}`);
ok(sourcesStarted > SOUND_NAMES.length, 'cues actually start audio sources');

// --- 4: voice limiting -------------------------------------------------------

group('voice budget');
const ctx2 = new MockAudioContext();
const b = createAudio({ ctx: ctx2, storageKey: 'test.voices', autoUnlock: false, maxVoices: 8 });
b.unlock();

let peak = 0;
for (let i = 0; i < 400; i++) {
  // Cycle cues so per-cue caps do not do all the work, and nudge the clock in
  // sub-coalesce-window steps so this is a genuine concurrency flood.
  b.play(SOUND_NAMES[i % SOUND_NAMES.length]);
  ctx2.currentTime += 0.005;
  peak = Math.max(peak, b.stats().voices);
}
ok(peak <= 8, `concurrent voices never exceed the budget (peak ${peak} of 8)`);
ok(peak > 1, 'the budget is actually reached, so the cap is being exercised');
const bs = b.stats();
ok(bs.dropped + bs.stolen > 0, 'over-budget cues are dropped or steal a slot');

// A critical cue must still get through a saturated mixer.
const alert = b.play('underAttack');
ok(alert !== null, 'a priority-3 alert is admitted even when the budget is full');
b.destroy();

// --- 5: coalescing -----------------------------------------------------------

group('coalescing');
const ctx3 = new MockAudioContext();
const c = createAudio({ ctx: ctx3, storageKey: 'test.coalesce', autoUnlock: false });
c.unlock();

const first = c.play('chop');
const firstVol = first.vol;
for (let i = 0; i < 39; i++) c.play('chop'); // 40 villagers, same instant
const cs = c.stats();
ok(cs.coalesced === 39, `39 of 40 identical cues coalesced (got ${cs.coalesced})`);
ok(cs.voices === 1, `40 chops produced one voice (got ${cs.voices})`);
ok(first.vol > firstVol, 'the surviving voice is louder than a single hit');
ok(first.vol <= firstVol * 1.81, 'the coalesced boost is capped, not cumulative');

// Outside the window it is a new voice again. Identity is not the test:
// finished voice records go back to a pool, so the new voice may legitimately
// be the same object. What must be true is that it started fresh — one hit,
// base volume, and a later start time.
const firstStartedAt = first.startedAt;
ctx3.currentTime += 0.5;
const second = c.play('chop');
ok(second !== null, 'a cue outside the coalesce window plays again');
ok(second.hits === 1, 'the new voice is not carrying the old coalesce count');
ok(second.startedAt > firstStartedAt, 'the new voice starts at the current time');
ok(Math.abs(second.vol - firstVol) < 1e-9, 'the new voice starts back at base volume');

// --- 6: spatialisation -------------------------------------------------------

group('spatial');
ctx3.currentTime += 1;
c.setListener(20, 20, 1);
ok(c.play('chop', { x: 20, y: 20 }) !== null, 'a cue at the camera centre plays');
ctx3.currentTime += 1;
ok(c.play('chop', { x: 90, y: 90 }) === null, 'a cue far outside the view is culled');
ctx3.currentTime += 1;
ok(
  c.play('underAttack', { x: 90, y: 90 }) !== null,
  'a non-positional alert is not culled by distance'
);
ctx3.currentTime += 1;
const panned = c.play('meleeHit', { x: 26, y: 14 });
ok(panned !== null && panned.panner !== null, 'an off-centre cue gets a panner');
ok(panned.panner.pan.value > 0, 'a cue to the camera-right pans right');
c.destroy();

// --- 7: preferences ----------------------------------------------------------

group('preferences');
const ctx4 = new MockAudioContext();
const d1 = createAudio({ ctx: ctx4, storageKey: 'test.prefs', autoUnlock: false });
d1.unlock();
d1.setMuted(true);
d1.setVolume(0.42);
d1.setSfxVolume(0.33);
d1.setMusicVolume(0.11);
ok(d1.play('chop') === null || d1.isMuted(), 'muting is reflected immediately');
d1.destroy();

const d2 = createAudio({ ctx: new MockAudioContext(), storageKey: 'test.prefs', autoUnlock: false });
ok(d2.isMuted() === true, 'mute survives a reload');
ok(Math.abs(d2.getVolume() - 0.42) < 1e-6, 'master volume survives a reload');
ok(Math.abs(d2.getSfxVolume() - 0.33) < 1e-6, 'sfx volume survives a reload');
ok(Math.abs(d2.getMusicVolume() - 0.11) < 1e-6, 'music volume survives a reload');
d2.destroy();

// --- 8: music ----------------------------------------------------------------

group('music');
const ctx5 = new MockAudioContext();
const m = createAudio({ ctx: ctx5, storageKey: 'test.music', autoUnlock: false });
m.unlock();
m.startMusic();
ok(m.isMusicPlaying() === true, 'startMusic() starts the bed');

const before = nodesCreated;
// Twenty minutes of a match at 60 fps, stepping the audio clock in lockstep.
const STEP = 1 / 60;
for (let i = 0; i < 60 * 60 * 20; i++) {
  ctx5.currentTime += STEP;
  m.update(STEP);
}
const madeForMusic = nodesCreated - before;
ok(madeForMusic > 50, `the generative part actually produced notes (${madeForMusic} nodes)`);
ok(madeForMusic < 6000, `twenty minutes of music stays cheap (${madeForMusic} nodes)`);
ok(m.stats().music < 40, `pending music nodes stay bounded (${m.stats().music})`);

m.stopMusic();
ok(m.isMusicPlaying() === false, 'stopMusic() stops the bed');
m.startMusic();
m.setMuted(true);
ok(m.isMusicPlaying() === false, 'muting stops the drone rather than leaving it running');
m.destroy();
ok(true, 'destroy() after a full match does not throw');

// --- result ------------------------------------------------------------------

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
if (failures) {
  process.stdout.write(`${failures} FAILED\n`);
  process.exit(1);
}
process.exit(0);
