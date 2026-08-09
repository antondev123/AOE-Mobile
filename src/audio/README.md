# Audio

A self-contained, procedurally synthesised audio engine. No asset files, no
network requests, no build step: every sound is generated at runtime from
oscillators and three pre-baked noise buffers, so the module drops into the
static GitHub Pages build as-is.

| file | what it is |
| --- | --- |
| `sound.js` | the factory: mixer, voice budget, spatialisation, preferences |
| `catalogue.js` | one recipe per named cue, plus its mixing metadata |
| `synth.js` | synthesis primitives and the shared noise buffers |
| `music.js` | the generative ambient bed |
| `selftest.mjs` | `node src/audio/selftest.mjs` — runs under plain Node with a mock AudioContext |

Nothing here subscribes to the event bus. The engine is a device the game plays,
exactly as `gfx/fx.js` is a device the game draws with; the mapping from game
events to cues lives at the call site (see **Integration points**).

## Quick start

```js
import { createAudio } from '../audio/sound.js';

const audio = createAudio({ seed: world.seed });

// Once, on the first user gesture (mobile autoplay policy).
audio.unlock();

// Every frame, before playing anything positional.
audio.setListener(centreGx, centreGy, camera.zoom);
audio.update(dtSeconds);

// Anywhere.
audio.play('chop', { x: unit.x, y: unit.y });
audio.play('underAttack');

audio.destroy();
```

## API

`createAudio(opts) -> audio`

| option | default | meaning |
| --- | --- | --- |
| `ctx` | — | supply an AudioContext instead of letting the engine create one |
| `storageKey` | `'aos.audio.v1'` | localStorage namespace for the preferences |
| `seed` | `0xa0d10` | seeds cue-to-cue variation and the music generator |
| `maxVoices` | `24` | concurrency budget |
| `autoUnlock` | `true` | attach one-shot `pointerdown`/`touchend`/`keydown` listeners that call `unlock()` |

| method | notes |
| --- | --- |
| `play(name, opts)` | `opts`: `{ volume, rate, pan, x, y }`. `x`/`y` are **grid** coordinates and drive pan and distance attenuation. `rate > 1` transposes up and shortens. Returns an opaque handle or `null` when the cue was dropped — that is a normal outcome, and the handle must not be retained (voice records are pooled). |
| `unlock()` | Resumes the AudioContext. Safe to call on every gesture forever; after the first success it is a state check. Returns whether the context is running. |
| `setListener(gx, gy, zoom)` | Camera centre in grid coordinates plus the camera zoom. Until it is called once, everything plays centred and unattenuated. Also readable as `audio.listener`. |
| `setMuted(b)` / `isMuted()` / `toggleMuted()` | Muting also stops the music bed rather than leaving it burning CPU. |
| `setVolume(v)` / `getVolume()` | Master, 0..1. |
| `setSfxVolume(v)` / `getSfxVolume()` | SFX bus, 0..1. |
| `setMusicVolume(v)` / `getMusicVolume()` | Music bus, 0..1. Default `0.126`, i.e. -18 dB under the SFX bus. |
| `startMusic()` / `stopMusic()` / `isMusicPlaying()` | The bed fades in over 6 s and out over 3 s. `startMusic()` is a no-op while muted or locked. |
| `duckMusic(seconds)` | Drops the music bus to 30 % and recovers slowly. Fire it with the under-attack alert. |
| `update(dt)` | Reaps finished voices, advances the music scheduler, releases the duck, and retries `resume()` if the OS suspended the context (phone lock, tab switch). |
| `destroy()` | Stops everything and closes the context (unless one was injected). |
| `has(name)` / `names` | Catalogue introspection. |
| `stats()` | `{ voices, played, coalesced, dropped, stolen, ... }`, debug only. |

Mute and the three volumes are persisted to `localStorage` under the namespaced
key and reloaded on construction, so a settings screen only has to call the
setters. Storage failures (Safari private mode) are swallowed.

If WebAudio is missing or refuses to start, `createAudio` returns a **silent
stub with the identical API** (`audio.available === false`). It still honours
and persists the preference calls. Nothing in this module ever throws at the
caller.

## Sound catalogue

24 cues. "Priority" drives voice stealing: 3 is never stolen. "Merge" is the
window inside which repeats coalesce into one louder voice.

| name | character | priority | merge | positional |
| --- | --- | --- | --- | --- |
| `chop` | axe crack plus the trunk answering, drops a fifth | 0 | 90 ms | yes |
| `mine` | inharmonic metal-on-rock ping over a dull thud | 0 | 90 ms | yes |
| `forage` | soft pink-noise rustle, bandpass falling as the branch springs back | 0 | 110 ms | yes |
| `farm` | the same gesture lower and earthier — a sickle in wheat | 0 | 110 ms | yes |
| `deposit` | sack thump with three staggered coin tinkles | 1 | 120 ms | yes |
| `nodeDepleted` | quiet falling minor third, "that's it" | 2 | 200 ms | yes |
| `hammer` | one randomly-pitched tap; fire repeatedly while building | 0 | 100 ms | yes |
| `buildComplete` | warm rolled G major chord, soft attack | 2 | — | yes |
| `placeFoundation` | wooden peg into soil plus a small rising blip | 2 | 50 ms | no |
| `meleeHit` | body thud plus a short metallic ring | 1 | 70 ms | yes |
| `arrowLoose` | bow twang with an airy fletching sweep | 1 | 60 ms | yes |
| `arrowHit` | duller, shorter thwack — no metal | 1 | 70 ms | yes |
| `unitDeath` | short falling breath, deliberately not gory | 2 | 90 ms | yes |
| `buildingDestroyed` | brown-noise collapse, sub-bass shock, timber cracks (1.3 s) | 3 | 250 ms | yes |
| `select` | almost subliminal click | 1 | 40 ms | no |
| `commandAck` | brighter rising two-tone blip | 1 | 50 ms | no |
| `invalid` | low detuned square buzz, dull on purpose | 2 | 150 ms | no |
| `buttonTap` | drier, quieter click for HUD chrome | 1 | 40 ms | no |
| `ageAdvance` | rising major arpeggio over a slow swell (1.4 s) | 3 | — | no |
| `villagerTrained` | soft domestic two notes up a fourth | 2 | 120 ms | no |
| `unitTrained` | small drum under a martial fifth | 2 | 120 ms | no |
| `underAttack` | urgent two-tone alarm, twice, bandpassed to cut through | 3 | 600 ms | no |
| `victory` | rising fanfare landing on the octave (2 s) | 3 | — | no |
| `defeat` | falling minor line over a sagging drone (2.2 s) | 3 | — | no |

Levels were set from measured offline renders rather than by ear-guessing: with
master and SFX at 1.0 the chatter cues peak around 0.03-0.14, the notable ones
0.09-0.24, and the critical stings 0.31-0.48. A full battle (40 chops, 30
volleys, 30 melee hits, ten deaths, a collapse and the alert, all in one frame)
renders at 0.66 peak with no clipping.

## Music

A slow D-dorian drone (root, fifth, detuned octave through a lowpass with a
32-second filter sweep) plus sparse plucked notes from a five-note subset,
scheduled one 1.5 s window ahead from `update(dt)`. Phrases are three to seven
slots long, a third of slots inside a phrase are silent, and each phrase is
followed by 6-14 seconds of nothing. Roughly every other phrase the drone
drifts to a new modal centre over an eight-second glide. A low bell appears
about once every two minutes.

Over a twenty-minute match this creates on the order of a thousand nodes total —
about one per second — and the drone is seven nodes that live for the match.

## Integration points

**All of the below is now wired.** The mapping lives in `adapter.js`
(`createAudioAdapter(world, audio, { playerId })`) — one subscription per event,
one cue per subscription, and nothing else; the engine itself still subscribes to
nothing. The scene owns the lifecycle. What follows is kept as the description of
that wiring, with the four "hooks the codebase does not have yet" resolved at the
bottom.

### Ownership and lifecycle — `src/scenes/GameScene.js`

1. `import { createAudio } from '../audio/sound.js';`
2. In `create()`, after the renderer: `this.audio = createAudio({ seed: this.seed });`
   and expose it on `window.__game` alongside `renderer` and `hud`.
3. In `update(time, delta)`, next to `this.hud.update(dtSec)`:
   ```js
   const cam = this.renderer.camera;
   const c = this.renderer.screenToGrid(cam.width / 2, cam.height / 2);
   this.audio.setListener(c.x, c.y, cam.zoom);
   this.audio.update(dtSec);
   ```
   The listener must be fed **before** `update`, and both must run every frame
   even when the simulation is paused.
4. In `teardown()`: `if (this.audio) this.audio.destroy();`

### Unlocking — `src/main.js` and `src/ui/input.js`

- `src/main.js`, in `start()`: the `#btn-start` click is the first trusted
  gesture, and the cleanest place to call `audio.unlock()` — but the engine does
  not exist yet at that point, so either construct it in `main.js` and pass it
  to the scene, or leave `autoUnlock` at its default and let the engine's own
  one-shot document listeners do it. The default is the least intrusive option.
- `src/ui/input.js`, in the pointer-down handler: `audio.unlock()` as a belt-and-
  braces call. It is a state check after the first success.
- Note: the browser harness boots with `?autostart` and never gestures, so audio
  stays locked and silent there. That is correct behaviour, not a failure — no
  console errors are produced.

### Event bus — one adapter, wherever `createFx` is wired (suggest a small block in `GameScene.create()`)

| event (`src/core/events.js`) | payload | call |
| --- | --- | --- |
| `EV.GATHER_TICK` | `{ unit, node, type }` | `node.kind === 'building' && node.type === 'farm'` → `play('farm', at node)`; else by `node.type`: `tree` → `chop`, `berry` → `forage`, `gold` → `mine`, `stone` → `play('mine', { x, y, rate: 0.9 })` (the same pick, pitched down, so stone reads as heavier than gold). Rate-limiting at the call site is unnecessary — coalescing and the per-cue cap handle forty villagers. |
| `EV.DEPOSIT` | `{ unit, building, type, amount }` | `play('deposit', { x: building.x, y: building.y })` |
| `EV.NODE_DEPLETED` | `{ node }` | `play('nodeDepleted', { x: node.x, y: node.y })` |
| `EV.FOUNDATION` | `{ building, builder }` | `play('placeFoundation')` (player-owned only) |
| `EV.BUILT` | `{ building, builder }` | `play('buildComplete', { x: building.x, y: building.y })` |
| `EV.PROJECTILE` | `{ from, to }` | `play('arrowLoose', { x: from.x, y: from.y })` |
| `EV.DAMAGE` | `{ entity, target, amount }` | ranged attacker (`UNIT_STATS[entity.type].projectile`) → `play('arrowHit', at target)`, otherwise `play('meleeHit', at target)`. Skip when `target.kind === 'building'` if the wall-hit texture already carries it. |
| `EV.DEATH` | `{ entity, killer }` | `entity.kind === 'unit'` → `play('unitDeath', at entity)`; `'building'` → `play('buildingDestroyed', at entity)`; `'resource'` → nothing |
| `EV.UNDER_ATTACK` | `{ player, entity, gx, gy }` | `if (player === PLAYER) { audio.play('underAttack'); audio.duckMusic(1.2); }` — the emitter is already throttled |
| `EV.TRAINED` | `{ building, unitType }` | player-owned only: `unitType === 'villager'` → `play('villagerTrained')`, else `play('unitTrained')` |
| `EV.INSUFFICIENT` | `{ player, cost }` | `if (player === PLAYER) play('invalid')` |
| `EV.POP_CAPPED` | `{ player }` | `if (player === PLAYER) play('invalid')` |
| `EV.SELECTION` | `{ ids }` | `if (ids.length) play('select')` |
| `EV.COMMAND_FX` | `{ gx, gy, kind }` | `play('commandAck')` — fires once per issued order, alongside the existing ping |
| `EV.GAME_OVER` | `{ winner }` | `play(winner === PLAYER ? 'victory' : 'defeat')` then `audio.stopMusic()` |

`EV.TOAST` is deliberately not wired: warn-tone toasts are already accompanied by
`EV.INSUFFICIENT` or `EV.POP_CAPPED` in every current emitter, and doubling them
would produce two `invalid` buzzes for one refusal.

One cue was added to the table above by the wiring rather than by this module:
`EV.TRADE` (a Market buy or sell) plays `deposit`. It is the same gesture — a
sack put down and coins counted — and the catalogue did not need a
twenty-fifth entry to say it.

### The four hooks this module was waiting for — all four now exist

1. **Hammer taps while building.** `EV.BUILD_TICK { unit, building }` is now
   emitted from `tickBuild()` in `src/systems/unitAI.js`, on a fixed
   `HAMMER_PERIOD` (0.45 s) beat rather than once per sim step. The beat is in
   the simulation on purpose, so the sound and any future spark agree about when
   a blow lands; per-step emission would have put four hundred dispatches a
   second through the bus with twenty builders working, and every `emit` copies
   its handler list. The polling alternative described here originally is not
   used.
2. **Age advance.** `EV.AGE_ADVANCE { player, age }` arrived with the tech tree
   (`src/systems/tech.js`, `completeResearch`) and is mapped straight to
   `ageAdvance` for the human player.
3. **Button taps.** `createHud(scene, world, audio)` takes the engine, and a
   single local `click()` helper is called from `cmdButton()`, the four dock
   buttons, the menu-sheet rows, the market's Buy/Sell and the minimap's
   pointer-down. It is a no-op with no engine and a no-op while the context is
   locked.
4. **Music transport.** `src/ui/input.js` calls `audio.unlock()` on every canvas
   pointer-down and `startMusic()` the first time it succeeds; the adapter calls
   `stopMusic()` on `EV.GAME_OVER`. Mute and the two volumes live in the HUD's
   menu sheet and map straight onto `toggleMuted()` / `setSfxVolume()` /
   `setMusicVolume()`, which persist themselves.

## Self-test

```
node src/audio/selftest.mjs
```

44 checks covering: the module loads under plain Node; the silent stub is
returned and matches the real API surface when WebAudio is absent; every
catalogued cue renders and reports a sane duration; the voice budget holds under
a 400-call flood while a priority-3 alert still gets through; forty identical
cues in one instant coalesce to one capped-boost voice; distance culling and
non-positional cues behave; preferences survive a destroy/recreate; and twenty
minutes of music stays bounded in both node count and pending scheduler state.
It exits non-zero on failure.
