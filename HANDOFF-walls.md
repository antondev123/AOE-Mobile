# Handoff: castles, walls and gates

Everything below is a thing the wall pass could not do itself, because the file
belongs to another agent this sprint. None of it is a known bug in the wall
work — the buildings, the block grid, the drag-to-draw placement, the sprites
and the tests are all complete and shipping.

One thing is genuinely outstanding: **`src/systems/unitAI.js`** should start
telling the pathfinder who is walking, so a unit can plan a route through its own
gate instead of only walking through one it has already reached (section 2).
Section 1 is the combat contract, which the military pass has already
implemented — it is recorded here so neither side breaks it. Section 3 is the
enemy AI, which is optional.

---

## 1. `combat.js` — done, and what it consumes

The military pass landed `updateBuildings()` while this one was in flight, so
the Castle and the Watch Tower already shoot and already garrison. Nothing is
outstanding. What follows is only the contract, so that neither side breaks it
by accident.

**`combat.js` reads the numbers straight out of `BUILDING_STATS`** — it does not
read them off the entity — so the wall pass owns these four fields and adding a
fifth shooting building needs no edit in `combat.js` at all:

| field in `BUILDING_STATS` | Castle | Watch Tower | everything else |
| --- | --- | --- | --- |
| `attack` | 12 | 6 | absent |
| `attackRange` (tiles) | 9 | 7 | absent |
| `attackCooldown` (seconds) | 2.0 | 2.0 | absent |
| `garrisonCapacity` | 10 | 5 | absent |

**`world.js` stamps only the mutable state** those systems tick, so no loop has
to guard for `undefined`: `cooldown`, `attackAnim` and `garrison: []`. It
deliberately does *not* copy the stats onto the entity — two copies of a number
is one more than can be kept in step.

Two things worth knowing if the balance is revisited. A Watch Tower at 6 damage
every 2.0s is 3 dps against 1-armour militia: it kills a lone raider and loses to
four, which is what 100 stone should do. A Castle at 12 every 2.0s is 6 dps
empty; `buildingWeapon()` adds one arrow per garrisoned body, so a full one is
several times that, which is what 250 stone should buy.

An earlier draft of this document asked for all of the above to be built. It is
kept only as the record of what the two passes agreed.

## 2. `unitAI.js` — one change left

Garrisoning is done too: `combat.js` owns `garrisonUnit` / `ungarrisonUnit` /
`ungarrisonAll` / `garrisonRefusal`, the HUD has its button, and `unitAI` has the
order. What is still outstanding is the pathfinder's new argument.

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

### b. Spread builders along a wall run (nice to have)

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
`setGateOpen`, `onBuildingComplete`; `cooldown` / `attackAnim` / `garrison` on
every building.

**`systems/pathfinding.js`** — the optional `player` argument described above.

**`systems/economy.js`** — `wallLineTiles`, `planWallLine`, `placeWallLine`,
`MAX_WALL_RUN`, `tilesTrapReason`, `updateGates` (called from `updateEconomy`);
`placeFoundation` gained `opts.quiet` and `opts.skipTrap`.

**`ui/input.js`** — the `wallDraw` pointer mode.

**`gfx/textures.js`** — `wallFrame(type, player, mask)` (16 per type per player),
`gateFrame(type, player, axis, open)`, the Castle and Watch Tower art, 1x1 and
4x4 foundations; the atlas is now 2048.

**`gfx/render.js`** — `setWallPreview()`, `setWallReadout()`, connected-variant
frame selection.

**`tests/walls.test.mjs`** — 25 assertions covering all sixteen mask cases, gate
passability through the real A*, run charging, enclosure refusal and the
Castle's age gate. Garrison behaviour is `tests/military.test.mjs`'s.
