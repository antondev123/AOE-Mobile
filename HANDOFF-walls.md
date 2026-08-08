# Handoff: castles, walls and gates

Everything below is a thing the wall pass could not do itself, because the file
belongs to another agent this sprint. None of it is a known bug in the wall
work — the buildings, the block grid, the drag-to-draw placement, the sprites
and the tests are all complete and shipping.

Two files are waiting on somebody: **`src/systems/combat.js`** (buildings that
shoot) and **`src/systems/unitAI.js`** (pathing that knows who is walking, and
the order to garrison). Sections 1 and 2 are the ones with teeth; section 3 is
the enemy AI, which is optional.

---

## 1. `combat.js` — make the Castle and the Watch Tower shoot

The **state is already there**. `spawnBuilding()` in `core/world.js` stamps every
building with the same field names a unit carries, taken from `BUILDING_STATS`:

| field on the building | Castle | Watch Tower | everything else |
| --- | --- | --- | --- |
| `attack` | 12 | 6 | `0` |
| `range` (tiles, from `attackRange`) | 9 | 7 | `0` |
| `attackCooldown` (seconds) | 2.0 | 2.0 | `0` |
| `cooldown` | ticked by you | ticked by you | `0` |
| `target` | `null` | `null` | `null` |
| `attackAnim` | `0` | `0` | `0` |
| `garrison` (array of units inside) | `[]` | `[]` | `[]` |
| `garrisonCapacity` | 10 | 5 | `0` |

They are the *same names* on purpose: `attackReach()`, `inRange()`,
`effectiveAttack()` and `launchProjectile()` already work on anything carrying
`attack` / `range` / `radius`, so nothing in the damage path needs a second
vocabulary for masonry.

### What has to change

**a. `canAttack()` currently refuses every non-unit attacker.**

```js
if (attacker.kind !== 'unit') return false;       // buildings do not fight back
```

That line is the whole of the block. Replace it with a test that a building may
attack when it is finished and armed:

```js
if (attacker.kind === 'building') {
  if (!attacker.complete) return false;           // a building site does not shoot
} else if (attacker.kind !== 'unit') {
  return false;
}
```

`attack > 0` is already tested on the next line, so an unarmed building still
falls out. Nothing else in `canAttack` needs touching — `isHostile` works on any
entity with a `player`.

**b. `updateCombat()` needs a second loop over `world.buildings`.**

It should be an exact echo of the unit loop, minus everything about walking:

```js
for (const b of world.buildings) {
  if (b.dead || !b.complete || !(b.attack > 0)) continue;
  if (b.cooldown > 0) b.cooldown = Math.max(0, b.cooldown - dt);
  if (b.target && !canAttack(b, b.target)) b.target = null;
  if (b.target && !inRange(b, b.target)) b.target = null;   // no leash: it cannot chase
  if (!b.target) acquireForBuilding(world, b, dt);
  if (!b.target || b.cooldown > 0) continue;
  b.cooldown = b.attackCooldown;
  for (let i = 0; i < volleySize(b); i++) launchProjectile(world, b, b.target);
}
```

Three things to be careful about, in order of how badly they bite:

1. **`volleySize(b)`** is exported from `core/world.js` and returns
   `1 + b.garrison.length` for an armed building, `0` for anything else. That is
   AoE2's rule — every body inside a Castle adds an arrow — and it is the whole
   point of the garrison. A full Castle looses eleven arrows a volley.
2. **`launchProjectile` reads `effectiveAttack(world, u)`**, which calls
   `attackBonus(world, unit)` in `tech.js`. That already returns `0` for a
   building (`unitClass()` returns `null` for a type with no `UNIT_STATS` entry),
   so a building swings with its base `attack` and no blacksmith line. That is
   the intended behaviour — AoE2's Fletching does buff towers, so if you want it,
   add a `'building'` class to `unitClass()` rather than special-casing here.
3. **Acquisition must prefer units over buildings and must not use
   `ENGAGE_RANGE`.** A tower's range *is* its range. Use `forEachNear(world, b.x,
   b.y, b.range + 1, ...)`, filter with `canAttack(b, e)`, score by
   `edgeDist2(e, b.x, b.y)` and push buildings to the back exactly the way
   `acquire()` already does.

**c. `applyDamage` and `kill` already work on buildings** — a Castle taking fire
goes through the same path a Town Center does, `raiseAlert` already treats every
building hit as relevant, and `removeEntity` empties the garrison out (see
`evictGarrison` in `world.js`). Nothing to do.

**d. Do not give the projectile a `duration` from the launcher's centre for a
4x4 Castle.** `launchProjectile` measures `dist(u.x, u.y, target.x, target.y)`,
which for a Castle is measured from the middle of a four-tile building; the arrow
will appear to start inside it. Launching from the footprint edge toward the
target — or simply from `u.x, u.y - 1` — reads better and costs nothing.

### Suggested balance sanity check

A Watch Tower (6 damage, 2.0s) is 3 dps against 1-armour militia — it kills a
lone raider and loses to four of them, which is what a 100-stone building should
do. An empty Castle (12 damage, 2.0s) is 6 dps; a full one is 66 dps and shreds
an early army, which is what 250 stone should buy.

---

## 2. `unitAI.js` — three small changes

### a. Pass the walking player into the pathfinder (the important one)

`world.blocked` now carries a fourth value, `BLOCK_GATE` (3), and
`world.gateOwner[i]` says whose gate it is as `playerId + 1`. Every walkability
API in `pathfinding.js` takes an **optional trailing `player`** (or `opts.player`
for `findPath` / `findAdjacentStandTile`):

| call | pass |
| --- | --- |
| `findPath(world, sx, sy, tx, ty, opts)` | `opts.player = u.player` |
| `isWalkable(world, tx, ty)` | fourth argument `u.player` |
| `nearestWalkable(world, tx, ty, maxR)` | fifth argument `u.player` |
| `hasLineOfSight(world, ax, ay, bx, by)` | fifth argument `u.player` |
| `findAdjacentStandTile(world, target, x, y, opts)` | `opts.player = u.player` |

**With a player**, that player's own gates are open ground. **Without one**, every
gate is a wall. The default is deliberately the conservative one: a unit walking
the long way round its own gate is an annoyance, an enemy strolling through it is
the feature not existing.

The call sites, at the time of writing:

```
unitAI.js:1503   findPath(world, u.x, u.y, x, y, {})          -> { player: u.player }
unitAI.js:482    isWalkable(world, ox + dx, oy + dy)          -> , u.player
unitAI.js:602    isWalkable(world, px, py)
unitAI.js:693    isWalkable(world, x, y)  + nearestWalkable(world, x, y, 3)
unitAI.js:706    isWalkable(world, u.x, u.y)
unitAI.js:824    nearestWalkable(world, u.x, u.y, 5)
unitAI.js:1566   isWalkable(world, nx, ny)                    <- the movement step
unitAI.js:1672   hasLineOfSight(world, u.x, u.y, goal.x, goal.y)
unitAI.js:1818   isWalkable(world, nx, ny) (+ the two axis fallbacks)
```

`1566` and `1818` are the two that matter most: they are the per-step "may I
stand here" test, and until they know the player a unit will not physically step
onto its own closed gate.

**It works without any of this today**, because a gate also physically opens when
its owner's units are within ~2 tiles and no enemy is within ~3.5 (see
`updateGates` in `economy.js`), which flips the tile to `BLOCK_FREE` for
everybody. That is what makes the gate visibly swing open and it is enough for a
villager to walk through one. What it does *not* do is let A* plan a route
through a gate it cannot see opening from thirty tiles away, so today a unit
trudges to the wall, the gate opens as it arrives, and the next repath takes it
through. Passing the player removes that hop.

`enemyAI.js:994` calls `findPath` too, and should pass `{ player: this.playerId }`
for the same reason.

### b. The garrison order

The building side is done. `core/world.js` exports the surgery
(`canGarrison`, `garrisonUnit`, `ungarrisonUnit`, `evictGarrison`, `volleySize`)
and `economy.js` exports the gameplay wrappers that also fix the population
(`garrison`, `ungarrison`, `ungarrisonAll`, re-exported `canGarrison`). What is
missing is the *order*: walking there, and then going in.

```js
// in commandUnits, a new order type:
case 'garrison': {
  u.task = { type: 'garrison', target: order.target };
  break;
}
// in the task step, on arrival (use findAdjacentStandTile against the building):
if (economy.canGarrison(world, task.target, u)) economy.garrison(world, task.target, u);
u.task = null;
```

A garrisoned unit is spliced out of `world.units` and left in `world.entities`
and in its owner's `owned` set, so:

* **nothing in `unitAI` will ever see it again** — no flag to test, no loop to
  teach. That is why it was done by splicing rather than by a `garrisoned` bool.
* it **still counts against the population cap**, which is AoE2's rule and stops
  garrisoning being a way to duck the cap.
* `ungarrison(world, building)` puts one back on a free tile beside the building;
  `ungarrisonAll` empties it. A razed building empties itself.

The HUD side (an "Unload" button on a selected Castle) belongs to whoever owns
`hud.js`; `economy.ungarrisonAll(world, building)` is the one call it needs, and
`building.garrison.length` / `building.garrisonCapacity` are the numbers to show.

### c. Spread builders along a wall run (nice to have)

`ui/input.js` places N foundations in one drag and then sends every selected
villager to **the first one**. A wall built from one end inwards is useful while
it goes up, so this is deliberate rather than broken — but a batch-build order
that hands each villager the nearest unfinished foundation of a group, and moves
them to the next when one finishes, would be a real improvement. The foundations
are entirely ordinary construction sites; nothing about them needs special
handling.

---

## 3. `enemyAI.js` — the AI does not build walls (optional)

Nothing was changed in `enemyAI.js`, so the enemy still never spends a stone. It
plays exactly as it did, which is safe but means the stone sink is one-sided.

The cheapest version that would make the match feel different: when the AI
reaches the Feudal Age and has more than ~150 stone banked, have it place a
`watchtower` beside whichever of its resource drop-offs is nearest the player's
base. That is one building, no run-drawing, and it uses the existing
`placeFoundation` path. A wall run would use
`economy.wallLineTiles()` + `economy.placeWallLine()`, which are the same two
functions the player's drag uses and take no UI.

---

## 4. Reference: what this pass added

**`core/constants.js`** (building region only) — `palisade`, `palisadegate`,
`stonewall`, `stonegate`, `watchtower`, `castle` in `BUILDING_STATS`; the same
keys in `BUILDABLE`; `isWallType()` and `isGateType()`.

**`core/world.js`** — `BLOCK_FREE/SOLID/TERRAIN/GATE`; `world.gateOwner`;
`WALL_N/E/S/W`, `wallMaskAt`, `refreshWallMask`, `refreshWallsAround`,
`setGateOpen`, `onBuildingComplete`; `canGarrison`, `garrisonUnit`,
`ungarrisonUnit`, `evictGarrison`, `volleySize`.

**`systems/pathfinding.js`** — the optional `player` argument described above.

**`systems/economy.js`** — `wallLineTiles`, `planWallLine`, `placeWallLine`,
`MAX_WALL_RUN`, `tilesTrapReason`, `updateGates` (called from `updateEconomy`),
`garrison` / `ungarrison` / `ungarrisonAll`; `placeFoundation` gained
`opts.quiet` and `opts.skipTrap`.

**`ui/input.js`** — the `wallDraw` pointer mode.

**`gfx/textures.js`** — `wallFrame(type, player, mask)` (16 per type per player),
`gateFrame(type, player, axis, open)`, the Castle and Watch Tower art, 1x1 and
4x4 foundations; the atlas is now 2048.

**`gfx/render.js`** — `setWallPreview()`, `setWallReadout()`, connected-variant
frame selection.

**`tests/walls.test.mjs`** — 27 assertions covering all sixteen mask cases, gate
passability through the real A*, run charging, enclosure refusal, the Castle's
age gate and the garrison.
