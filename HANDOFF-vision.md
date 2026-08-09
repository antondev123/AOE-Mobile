# Handoff: fog of war (`src/systems/vision.js`)

Everything below is a thing the fog pass could not do itself, either because the
file belongs to somebody else this sprint or because it is a decision for a
later pass. Nothing here is a known bug in the fog itself.

## 1. Tuning that belongs in `core/constants.js`

`constants.js` was owned by a parallel balance pass, so three numbers live at the
top of `vision.js` instead. Move them next to `UNIT_STATS` when that file is free
again, and the derivation in `unitLineOfSight()` can go away with them:

| in `vision.js` | value | what it should become |
| --- | --- | --- |
| `DEFAULT_UNIT_LOS` | 4 | a `lineOfSight` field on every entry in `UNIT_STATS`, the way `BUILDING_STATS` already has one |
| `LOS_RANGE_MARGIN` | 2 | gone — with an explicit per-unit `lineOfSight` there is nothing left to derive |
| `DEFAULT_BUILDING_LOS` | 3 | the fallback for a `BUILDING_STATS` entry that forgets `lineOfSight` |

What the derivation currently produces, and what the explicit values should
therefore be if you want no behaviour change: **villager 4, militia 4, archer 6**
(AoE2's own numbers). Building radii come from `BUILDING_STATS.lineOfSight` plus
half the footprint, so a Town Center sees 9 and a house 5.

The one rule that must survive the move: **a unit's line of sight must be
strictly greater than its attack range.** An archer with range 4.5 and sight 4
would auto-acquire and shoot at things the player cannot see, which is the
ugliest failure a fog can have. `LOS_RANGE_MARGIN` exists only to guarantee
that; explicit values must be checked against `range` by hand.

## 2. Enemy AI fairness — `systems/enemyAI.js`

The vision system maintains **full masks and full object memory for both
players**, not just the human one. Nothing reads player 1's masks yet, so the AI
still plays with perfect information exactly as before; this pass deliberately
changed none of its behaviour.

To make it honest, a later pass needs to route the AI's world queries through
`world.vision`:

- `world.vision.state(ENEMY).visible` / `.explored` — the two `Uint8Array`s,
  indexed `ty * MAP_W + tx`.
- `world.vision.entityVisible(ENEMY, e)` — true if any tile the entity stands on
  is lit. This is the check to put in front of target selection.
- `world.vision.state(ENEMY).memory` — a dense array of snapshots of static
  objects (resource nodes, buildings) the AI has seen and walked away from.
  Snapshots carry `{ id, kind, type, player, x, y, fw, fh, hp, maxHp, amount,
  maxAmount, complete, tiles }` and are **copies**, never live entities.

The three places that currently see through walls:

1. `findNearestGlobal(world, x, y, world.resources, …)` — the AI picks gather
   targets from the whole map. It should pick from `memory` plus what is
   currently visible; the snapshot's `amount` is exactly the "how much did I
   think was left" number it needs.
2. `findNearestGlobal(world, x, y, world.buildings, …)` for attack targets
   (`enemyAI.js` around the raid/target selection helpers) — the AI knows where
   the player's Town Center is from the first frame. It should have to scout.
3. Threat assessment over `world.units` — the AI reacts to armies it has no way
   of having seen.

An honest AI also needs an *explore* behaviour, since with fog it starts blind;
that is a bigger change than swapping the queries and is the real work here.

## 3. Combat and targeting — `systems/combat.js`

Not owned by this pass, and not changed. Two places let a unit act on something
its owner cannot see:

- **`acquire()` / `ENGAGE_RANGE` (7.5 tiles).** An idle or attack-moving unit
  auto-acquires anything hostile within 7.5 tiles. A militia's line of sight is
  4 and an archer's is 6, so *both* can currently open fire on an enemy that is
  invisible to the player — the unit's target ring and its arrows appear, aimed
  at empty black ground. `AGGRO_RANGE` (5.0), used by a unit that is busy under
  an order, has the same problem for the militia. The fix is one line inside the
  `forEachNear` callback in `acquire()`:

  ```js
  if (!world.vision.entityVisible(u.player, e)) return;
  ```

  That is the correct AoE2 behaviour: units only auto-attack what their side can
  see. It is deliberately *not* applied to an explicit player-issued attack
  order, which should keep working on a target the player has selected.

- **`engage()` chase.** A unit already engaged keeps chasing a target that walks
  into fog. AoE2 keeps the chase until the leash (`CHASE_LEASH`) expires rather
  than dropping the target the instant it goes dark, so leaving this alone is
  defensible — but it does mean a unit will follow something it cannot see.
  Worth a decision either way.

The renderer already refuses to draw units in fog, so today the visible symptom
is arrows leaving a bow and a health bar that is not attached to anything.
`gfx/fx.js` suppresses projectiles and damage numbers whose *own* position is in
fog, which hides most of it, but the underlying targeting is still wrong.

## 4. Selection and input — `ui/input.js`, `ui/selection.js`

Neither file was in this pass's scope. `pickAt()` in `input.js` iterates
`world.units`, `world.buildings` and `world.resources` with no fog test, so a tap
on black ground can select an enemy unit standing in it and the HUD will then
show its name, hit points and portrait. Drag-box selection has the same hole.

The fix is the same one-line test as above, applied in `pickAt`'s `consider()`
and in the box-select loop:

```js
if (!world.vision.entityVisible(PLAYER, e)) return;
```

Remembered buildings are a separate question: AoE2 lets you click a building you
remember and shows a stale panel for it. That needs the HUD to accept a snapshot
rather than an entity, so it is a bigger job than the leak above.

## 5. Building placement

`canPlace()` (`core/world.js`) does not consult the fog, so a player can place a
foundation on ground they have never explored. AoE2 requires explored ground.
The check is `world.vision.isExplored(PLAYER, tx, ty)` for every footprint tile;
it was left out because the placement flow lives in `ui/input.js` and `ui/hud.js`.

## 6. Numbers measured on this branch

96x96 map, 141 viewers (137 units + buildings), Chromium at phone size:

- `vision.update()` — **0.15 ms mean, 6.9 ms worst** (the worst is the single
  cold step where 140 units were spawned at once and every disc was stamped in
  from nothing; steady state never exceeds ~0.4 ms). Sim budget is 50 ms.
- 1211 tile writes per sim step on average, against 9216 tiles — i.e. the
  incremental path touches about 13% of the map per step instead of all of it.
- A still army costs **zero** tile writes (asserted in `tests/vision.test.mjs`).
- Renderer, fully explored map (8499 explored tiles, 1757 remembered objects,
  143 units, zoomed fully out over the map centre) — **0.40 ms median,
  1.7 ms p95** per frame for the whole render pass including fog.
- Fog texture: 200x200 canvas, repainted at most 12 times a second and only when
  the mask has actually changed.
