# Changelog

## Economy foundation

### Stone, a fourth resource

- `RES.STONE` threaded through every place the other three appear: starting
  stockpile (150 — AoE2 gives 200, trimmed for a ten-minute skirmish), gather
  rate, node amount, `RES_KEYS` in `economy.js`, the resource bar, the minimap
  colour table, carry-chip tints in `render.js`/`fx.js`, and the enemy AI's
  bookkeeping.
- New `stone` resource node ("Stone Mine"), 220 per node, with its own generated
  texture: cool slate boulders drawn as isometric blocks, deliberately unlike the
  gold vein's warm rubble in hue, value and silhouette. Three variants.
- `world.spawnResource` now maps node type to resource type through a table
  instead of a ternary chain, which used to turn any unrecognised type into gold.
- Map generation places stone in clusters: one guaranteed cluster per base, ~11
  tiles out (further than the starting gold's ~7), plus neutral clusters through
  the middle. Measured across seeds: 72-89 stone nodes against 104-115 gold and
  ~1500 trees.
- Stone has no sink yet. Castles, towers and stone walls are a later pass.

### Lumber Camp and Mining Camp

- Two new 2x2 drop-off buildings, 100 wood each (AoE2's price), 18s to build:
  `lumbercamp` (wood) and `miningcamp` (gold + stone). Both buildable by the
  player and by the enemy AI. Generated textures share a shed body and are told
  apart by their props — a log stack and saw, an ore heap and pick.
- The Town Center now accepts stone as well.
- `nearestDropoff` already picked the nearest building by edge distance across
  everything the player owns; it is re-asked on every trip, so a camp planted
  mid-game shortens existing villagers' round trips with no re-tasking.
- Added `adoptNewDropoff` in `unitAI.js`: a villager already walking a load home
  switches to a nearer drop-off the moment one is finished, instead of waiting
  out the trip it is on.
- The selection panel now names the drop-off a villager is using ("Gathering
  wood → Lumber Camp", "Hauling 10 wood to the Lumber Camp").
- Enemy AI builds camps when its own workforce's haul passes 9 tiles, capped at
  3 lumber camps and 2 mining camps, gated behind 6 villagers and a 120-wood
  reserve. It also builds a Lumber Camp to recover from losing its Town Center,
  which is the only way to bank the wood a replacement costs.

### 96x96 map

- `MAP_W`/`MAP_H` 48 → 96. Everything else derives from them; the hardcoded 48s
  that were left were in the spatial-bucket grid in `world.js` and in three test
  fixtures, all now computed.
- Base offset 9 → 18, so the two bases are 85 tiles apart (was 42) — a militia
  crossing takes a little over a minute.
- Terrain patches, forests, gold, stone and berries all scale with map area.
- A* budget 6000 → 12000, which is the tile count with a third in hand. Measured
  over a five-minute two-AI match: 225 nodes expanded per search on average, 3
  partials in 1031 searches, 0 failures; worst case (corner to corner) is ~1400
  nodes and 0.6ms.
- Terrain render textures are now baked lazily as the camera approaches, rather
  than all at once. An eager bake of the larger map was 91 RenderTextures and
  ~100MB of GPU memory before the first frame.

### AoE2 pacing

Roughly half the old speed, retuned as one set:

- `GATHER_SPEED` 6.0 → 2.5. A full 10-unit pack now takes 7.3s on berries, 8.0s
  on wood, 8.9s on gold, 9.5s on stone (was ~3s for everything).
- Measured round trips on a generated map: food 7.7s, wood 9.8s, gold 13.8s.
  A lumber camp beside a distant woodline cuts a 36.5s round trip to 8.2s.
- Villager movement 1.5 → 1.35 tiles/s, militia 1.25 → 1.1, archer 1.35 → 1.2.
  Walking is dead time; it is the one figure that was not halved.
- Train times: villager 8 → 16s, militia 11 → 22s, archer 12 → 24s.
- Build times: Town Center 30 → 60s, House 10 → 20s, Barracks 20 → 38s,
  Farm 8 → 15s, Mill 12 → 24s.
- `MAX_POP_CAP` 50 → 200 (AoE2's default). The enemy AI still runs a 50-pop
  economy by its own `MAX_HOUSES` limit; growing past that is a later pass.
- Test assertions were repinned to the new pacing rather than the pacing being
  reverted to satisfy them.

## Tech tree

New module `src/systems/tech.js` owns ages, building unlocks and research. It is
Phaser-free and runs headlessly; `updateResearch` ticks from `updateEconomy`
rather than from the scene, because research is production and belongs on the
training queue's beat.

### Ages

Three, not AoE2's four — Imperial in a ten-minute match would be a tier nobody
reaches.

| Age | Cost | Research time | Buys |
| --- | --- | --- | --- |
| Dark | — (start) | — | the economy, the Barracks |
| Feudal | 400 food | 50s | the first tier of every upgrade line, Feudal buildings, +15% building hp |
| Castle | 600 food + 200 gold | 65s | the second tier, Castle buildings, +30% building hp |

- Researched at the Town Center, which is occupied by it (its research slot is
  taken, with a progress bar in the HUD) but keeps training villagers — that is
  AoE2's behaviour and stopping villager production for fifty seconds would make
  the age-up unaffordable in a way the cost already handles.
- AoE2's own costs are 500 food and 800 food + 200 gold. Measured against this
  economy those land the Feudal Age at ~5:30 of a ten-minute match, past the
  point where it can pay for anything; 400 and 600+200 put the two at roughly
  3:30 and 7:00 on a good opening.
- Aging up scales every building the player owns — standing, wounded or still a
  foundation — to +15% / +30% maximum hitpoints, keeping damage as a fraction.
  This is the buff that lands the instant the age does, so the age-up is not
  purely a shopping list you then have to pay for again; hitpoints because it is
  the one bonus that helps the player who is behind.
- New events: `EV.RESEARCH_START`, `EV.RESEARCH_DONE`, `EV.AGE_ADVANCE`.

### Building unlocks

- Dark: Town Center, House, Mill, Lumber Camp, Mining Camp, Farm, palisade,
  **Barracks**.
- Feudal: Archery Range, Stable, Blacksmith, Market, Watch Tower, stone wall.
- Castle: Castle, Siege Workshop, University, Monastery.

The Barracks is Dark Age, against the brief's suggested table. It is Dark Age in
AoE2 — the Barracks and the Militia are both Dark Age and the drush is the
oldest opening in the game — and moving it to Feudal would also have pushed the
enemy AI's first barracks (105s) and first wave (170s) out past the age-up,
which is the pacing everything else is tuned around.

- Buildings that do not exist yet are named in the tables anyway and filtered
  against `BUILDING_STATS`, so the Castle/wall/tower/Market pass slots in with no
  edit here. `BUILDABLE` carries the same forward declarations.
- An unrecognised type defaults to Dark Age (never permanently locked out),
  except one that costs stone, which defaults to Feudal — in AoE2 nothing you pay
  stone for is a Dark Age building.
- The build menu shows locked buildings, grouped under age headings, greyed with
  the age they need where the cost would go. Tapping one says why. Hiding them
  would ask the player to buy an age blind.
- `placementRefusal` / `canPlaceReachable` refuse a locked type before geometry,
  so the ghost, the toast and the placement all say the same sentence.

### Upgrades

| Tech | Building | Age | Cost | Effect |
| --- | --- | --- | --- | --- |
| Horse Collar | Mill | Feudal | 75F 75W | +15% food |
| Heavy Plough | Mill | Castle | 125F 125W | +15% food |
| Double-Bit Axe | Lumber Camp | Feudal | 100F 50W | +20% wood |
| Bow Saw | Lumber Camp | Castle | 150F 100W | +20% wood |
| Gold Mining | Mining Camp | Feudal | 100F 75W | +15% gold |
| Gold Shaft Mining | Mining Camp | Castle | 200F 150W | +15% gold |
| Stone Mining | Mining Camp | Feudal | 100F 75W | +15% stone |
| Stone Shaft Mining | Mining Camp | Castle | 200F 150W | +15% stone |
| Forging | Barracks | Feudal | 150F | +1 melee attack |
| Iron Casting | Barracks | Castle | 220F 120G | +1 melee attack |
| Fletching | Barracks | Feudal | 100F 50G | +1 ranged attack |
| Bodkin Arrow | Barracks | Castle | 200F 100G | +1 ranged attack |
| Scale Mail | Barracks | Feudal | 100F | +1 melee armour |
| Chain Mail | Barracks | Castle | 200F 100G | +1 melee armour |
| Padded Archer Armour | Barracks | Feudal | 100F | +1 ranged armour |
| Leather Archer Armour | Barracks | Castle | 150F 150G | +1 ranged armour |

- Costs are AoE2's, unrounded — resource costs in this game have always been
  AoE2's real numbers and only the times are compressed (roughly 0.4, the same
  factor as build and train times).
- Tiers stack additively, as in AoE2: two wood tiers is +40%, not +44%.
- Each tech names a *preference list* of buildings and takes the first that
  exists, so the blacksmith line says `['blacksmith', 'barracks']` and moves to a
  Blacksmith by itself the day one is added.
- Unit classes (`melee` / `ranged` / `worker`) are derived from `UNIT_STATS` —
  `projectile: true` is ranged, anything the Town Center trains is a worker — so
  a Knight or a Spearman added later is upgraded without a line changing.

### How the effects are read

- `gatherRateFor(resourceType, world, playerId)` — the resource type still comes
  first and the two new arguments are optional, so a caller with no player gets
  the base rate. `gatherTick` passes the gathering villager's owner.
- `combat.js` reads `effectiveAttack` / `effectiveArmor` **at the moment of the
  swing** and never copies a bonus onto a unit. A Forging finished while your
  army is standing in the enemy's base makes that army hit harder immediately,
  which is how AoE2 works; stamping the bonus at train time is the classic bug
  where the army you already paid for is the army that dies. Projectiles
  snapshot their damage at launch, because an arrow in the air was already loosed.

### Research mechanics

- A generic queue on the building (`building.research`), sharing the training
  queue's shape: `{ remaining, total }` entries, head-of-queue tick with
  overshoot carried, full refund on cancel, capped at 3. It is deliberately a
  *separate* array from `building.queue`, because `recomputePop` counts every
  entry in `queue` as a reserved population point and a Bow Saw would silently
  cost a villager's worth of pop for 28 seconds.
- Techs are permanent per player and idempotent: `completeResearch` returns false
  for anything already done, and `queueResearch` refuses a tech already finished
  or already under way anywhere, so nothing double-charges or double-applies.
- HUD: selecting a building lists its upgrades as ≥44px buttons carrying name,
  effect and cost. Done ones are green and ticked, in-progress gold, age-locked
  greyed with the age, unaffordable greyed with the reason — and every greyed
  button is still tappable and explains itself, because a dead button on a phone
  is indistinguishable from a missed tap. Later tiers of a line the player has
  not started are folded away behind a "N further upgrades unlock behind these"
  footnote; showing all four tiers filled two thirds of the screen.
- `.cmd-panel` is now capped at 40vh and scrolls, so no future panel can grow the
  bottom bar without limit.
- A compact age indicator sits at the end of the resource bar, set off by a
  hairline rule and brightening with each age. It is the one entry with no pip:
  it is not a quantity. The bar's padding, gaps and pip size were trimmed ~55px
  to keep six items on one line through most of a match, and it now wraps rather
  than clipping when a late-game bank overflows it (the toast stack measures the
  bar and moves down to match).

### Enemy AI

- Ages up on a schedule — earliest 4:15 and 8:15, gated behind 10/18 villagers
  and a stockpile reserve, which in practice lands the Feudal Age at 5:30-8:00
  and the Castle at 8:15-9:30 across seeds. Deliberately behind what a human who
  chooses to stop making villagers can manage.
- Shops the economic upgrades at whichever drop-off is free, wood line first,
  then the blacksmith line once it has six soldiers to improve. One purchase per
  pass, each behind a reserve that has to survive it — an upgrade that stalls
  production for forty seconds has cost more than it gave.
- Skips a gathering upgrade for a resource nobody is assigned to, tested against
  the live job board rather than a hardcoded exclusion, so Stone Mining starts
  being bought the day the villager split grows a fourth leg.
- New stats: `techsResearched`, `ageUps`.

### Tests

`tests/tech.test.mjs`, 39 checks. Beyond the obvious: an economic upgrade is
verified by *measuring* wood banked over ten seconds rather than by reading the
multiplier; a military upgrade is verified against a unit that was already alive
when it finished; researching twice is checked for both no-op and no-double-
charge; the age-up bill is compared against the table; and a synthetic Castle is
injected into `BUILDING_STATS` mid-test to prove a building added by another pass
gets age-gated with no edit to the unlock tables.

## Castles and walls

The last release shipped a resource with no sink. Across two ten-minute
simulations both players' stone counters read exactly 150 — the starting figure,
untouched, for the entire match — because nothing in the game cost any. This is
the pass that gives stone a job.

### The five buildings stone pays for

| building | cost | hp | size | build | age |
| --- | --- | --- | --- | --- | --- |
| Palisade | 2 wood | 90 | 1x1 | 4s | Dark |
| Palisade Gate | 20 wood | 130 | 1x1 | 8s | Dark |
| Stone Wall | 5 stone | 420 | 1x1 | 8s | Feudal |
| Stone Gate | 30 stone | 520 | 1x1 | 16s | Feudal |
| Watch Tower | 100 stone + 25 wood | 380 | 1x1 | 22s | Feudal |
| Castle | 250 stone | 1500 | 4x4 | 90s | Castle |

Costs are AoE2's wherever the economy can carry them — a palisade really is 2
wood, a stone wall really is 5 stone, a stone gate really is 30 — and cut where
it cannot. The two cuts are the Watch Tower (AoE2: 125 stone) and the Castle
(AoE2: 650). A villager on stone banks about 0.7 a second including its walk, so
650 is fifteen villager-minutes, longer than the whole match; 250 is about four
minutes of two villagers on a mine, which is a project you commit to rather than
a number you read once and dismiss. The opening 150 stone now buys a tower, or
thirty wall segments, or most of a Castle's first instalment — so the first stone
mine is finally the decision `STARTING_RESOURCES` always claimed it was.

The Castle is 4x4, trains militia and archers, banks all four resources like a
Town Center (deliberately unlike AoE2 — 250 stone should buy a forward base that
can hold the gold it was planted on), sees twelve tiles, and garrisons ten.

### Walls that look like walls

A wall segment's sprite is chosen by a four-bit mask of which of its four axis
neighbours are also walls: post, four stubs, two straight runs, four corners,
four tees, one cross. All sixteen are drawn per wall family per player — 64
frames — rather than derived by rotation, because in this projection the two grid
axes run in different screen directions and are lit differently, so an east-west
run is not a north-south run turned round.

Each case is assembled from one primitive: an isometric prism from the tile
centre to the middle of one tile edge, one per connected direction, plus a post
at the junction. Every limb ends exactly on the edge shared with its neighbour,
so two segments meet with no gap and no overlap at any zoom without a single
hand-placed pixel. Masks are recomputed only when a neighbour appears or
disappears (`refreshWallsAround` in `world.js`) — four tile reads, never
per-frame.

Team colour is a band under each post's crenellations rather than a pennant per
segment: the first cut drew a flag on every tile and a thirty-tile run came out
as a picket fence with no findable ends. Pennants now mark only ends, lone posts
and junctions.

The atlas moved from 1024 to 2048 to hold all of this. A second atlas was the
alternative and is worse — it would break the sprite batch every time the
renderer alternates between a wall and anything else, which on a walled base is
every few sprites.

### Gates, and per-player passability

`world.blocked` is one byte per tile and is read by A*'s inner loop, the
line-of-sight sampler and every flood fill, so it could not become a map lookup.
It gained a fourth value, `BLOCK_GATE`, plus a parallel `world.gateOwner` byte
array read *only* when that value appears. A free tile therefore costs exactly
the compare it always did, a blocked tile costs one more, and only a real gate
tile — of which there are a handful on 9216 — touches the second array. Nothing
allocates and nothing hashes.

Every walkability API (`isWalkable`, `nearestWalkable`, `hasLineOfSight`,
`findPath`, `findAdjacentStandTile`) now takes an optional player: pass it and
that player's own gates are ground, omit it and every gate is a wall. The default
is the conservative one, because a unit walking the long way round its own gate
is an annoyance and an enemy strolling through it is the feature not existing.
The path memo is keyed on the player for the same reason.

A gate also physically opens — `BLOCK_FREE` — when its owner's units are within
about two tiles and no hostile is within three and a half, and it never shuts on
somebody standing in the doorway. That is both the visible animation and what
makes gates work today, before the unit AI starts naming who is walking. Open and
shut differ by a whole shape (an oak slab filling the arch, versus an empty
threshold with the leaves folded back), not by a tint, so a player can see which
of their gates is standing open from across the base.

The enclosure fills treat a gate as *not* solid, so a wall line with a door in it
can always be finished — which is the play the whole feature exists for.

### Drawing a wall: the drag

Arm a wall type and a one-finger drag draws the whole run under your finger. The
run is an L along the two grid axes, longer leg first. Two other shapes were
tried: a straight Bresenham line between the endpoints renders in isometric as a
column of tiles touching only at their corners — the segments never share an
edge, every mask comes out 0, and the "wall" is a stack of loose posts units walk
straight through. A free-form path following the drag is unreadable under a
thumb. The L is what AoE2 does and the only shape that is always four-connected.

While dragging, the real connected sprites are previewed (not abstract markers —
the question you are asking is "will this join up", and a row of highlights
cannot answer it), refused segments stay in shape and turn red, and a label above
the finger reads the live count and bill: *12 Stone Walls — 60 stone*.
Affordability is evaluated cumulatively along the run, so with 12 stone in hand a
five-tile line shows two green and three red.

`wallDraw` is its own pointer mode. It never consults `effectiveDragMode()`, so
it cannot be turned into a box-select by having units in hand or into a pan by
not having any; two fingers still pan and pinch exactly as before, and putting a
second finger down is also how you abandon a half-drawn run. There is no drag
threshold — a press and release without moving is a one-tile run — so tapping and
dragging are one code path rather than two rules that have to agree.

Releasing charges for exactly the segments actually placed. A run drawn across a
tree becomes a wall with a gap in it, not a wall that silently did nothing. The
enclosure test runs once over the finished run rather than once per segment:
forty bounded flood fills inside a drag handler is a visible stutter, and "does
*this* brick trap anyone" was never the question the player was asking.

### What is waiting on other files

The Castle and the Watch Tower declare `attack`, `attackRange`, `attackCooldown`
and `garrisonCapacity` in `BUILDING_STATS`, and `world.js` stamps every building
with the mutable state a volley ticks (`cooldown`, `attackAnim`, `garrison`).
The military pass's `combat.js` reads both and does the shooting, so towers and
Castles fire the day their stats land — which they now have.

One thing is genuinely outstanding, and `HANDOFF-walls.md` has it: `unitAI.js`
should start passing `u.player` to the pathfinder. Without it a unit walks *to*
its own gate, waits for it to open, and repaths through — rather than planning
the route through it from across the map. It works either way; the argument just
removes the hop.

### Tests

`tests/walls.test.mjs`, 27 checks: all sixteen mask cases swept exhaustively,
straight runs, corners, tees, removal re-opening its neighbours, and walls
refusing to join to an enemy's wall or to a house. Gate passability is checked
*through the real A\** with a wall spanning the whole map and one gate in it —
the owner crosses, the enemy does not. Plus: a run charges for exactly what it
places, runs out exactly when the purse does, refuses entirely when it would seal
the player in but not when the enclosure is base-sized, the Castle is refused
before the Castle Age and deducts exactly its listed stone after it, and a
garrisoned unit leaves the map, keeps its population and adds an arrow.

Screenshots in `screenshots/walls-*.png` are the other half of that: the sixteen
variants meeting up is not a thing a headless test can see.

## Performance

The target is a stable 60fps on a mid-range Android phone with 100+ units. This
pass profiled first, then fixed what the profile pointed at, and — the part that
took the longest — worked out which of the numbers this repo can measure are
statements about a phone and which are statements about the build machine.

### The measurement problem, and what was done about it

Every browser test here runs Chromium with `--use-gl=swiftshader`: software
rasterisation, no GPU. That matters more than it sounds. Two measurements settle
what it does to a frame time.

**The floor.** Hide every Game Object in the scene — draw literally nothing, and
leave only Phaser's loop and the buffer swap — and a frame on this machine still
costs 21ms on an idle box and past 30ms on a busy one. The 60fps budget is
16.7ms. There is no version of this game, or of any game, that renders inside a
frame budget here.

**The split.** Of a 45ms frame with two hundred units fighting, about 4ms is our
JavaScript and 87% of the rest is native time inside the rasteriser. Hiding one
layer at a time attributes it: the fog quad 9.6ms, the baked terrain 8.6ms, the
overlay Graphics 5.1ms, and all 450 sprites together 2.9ms. Every one of those is
fill rate — screen-sized textured quads, which a phone GPU draws in microseconds
and a CPU pretending to be one takes ten milliseconds over.

So the old check — `130 units still render inside a frame budget`, asserting a
median under 34ms — was measuring the wrong machine, and 34 was a number chosen
to sit above whatever the renderer cost on the day. It has been replaced, in
`tests/art.browser.mjs`, by assertions on draw calls, Game Objects touched and
JavaScript milliseconds, with the wall clock still printed next to the *measured*
empty-scene floor so a reader can see the ratio for themselves.

`src/core/perf.js` is the instrument: a per-phase CPU profiler, off by default,
costing two function calls and a boolean test per phase when it is on. Every
phase of a frame reports separately — sim, and inside it allocation, units,
combat, economy, enemy AI and vision; render, and inside it terrain, cliffs,
resources, buildings, units, memory, fog and effects; input; HUD, and inside it
the DOM pass and the minimap.

### Before and after

Stress scenario (`tests/perf.browser.mjs`): 216 units, two armies of 85 in
contact under a real `attackMove` so combat, damage numbers, sparks, corpses and
arrows are all live, 40 villagers still gathering, fog updating every step, the
minimap redrawing at 10Hz and the HUD holding a live twelve-unit selection.

| | before | after |
|---|---|---|
| **draw calls / frame** | **36.9** | **16.1** |
| Game Objects touched / frame (p95) | 603-700 | 658-721 |
| allocation / frame (sampled) | 1.6-1.7 kB | 1.4-2.0 kB |
| render CPU, median | 1.20 ms | 1.20 ms |
| render CPU, worst frame | 5.1 ms | 2.9 ms |
| `render.units`, worst frame | 4.7 ms | 2.4 ms |
| `render.resources`, worst frame | 2.0 ms | 0.4 ms |
| draw + HUD + input, low quartile | 1.0-1.3 ms | 1.1-1.4 ms |
| wall clock median (swiftshader) | 45-82 ms | 44-82 ms |

Read that table honestly. **The draw call count halved and that is the headline.**
The renderer's *median* CPU did not move at all, and it was never going to:
Chrome clamps `performance.now()` to 100 microseconds, the whole unit pass costs
0.7ms, and the renderer changes below are each worth tens of microseconds. What
they did move is the tail — the worst frame in the run is roughly half what it
was — and they removed work that scales with entity count and with map size,
which is the axis a slower core runs out of road on first. The draw + HUD + input
row overlaps in both directions between runs; it is reported at the low quartile
because contention can only ever add to a sample, and even so it is inside the
noise.

The simulation was measured with no browser at all, which is the quietest
instrument available and the one `tests/simperf.test.mjs` now guards:

| headless fixed step, 120 units in melee | before | after |
|---|---|---|
| **median** | **1.86 ms** | **1.51 ms** |
| p95 | 2.85 ms | 2.48 ms |
| best case | 0.93 ms | 0.80 ms |

Three runs each, spread under 5%. That is a 19% cut in the cost of a simulation
step, and it is the one CPU improvement in this pass big enough to see clearly.

### What each change bought

**Floating damage numbers are baked glyphs, not Phaser Text.** Every `-12` over
a fight was a `Text` object, and every one of those carries its own
canvas-backed texture — so eighteen numbers over a melee were eighteen extra
texture binds, which is eighteen extra draw calls, plus a canvas rasterisation
and a GPU upload each time a number was born. Twelve glyphs (`0-9`, `+`, `-`)
are now baked into the atlas at build time and a label is a run of pooled
sprites out of the same batch as everything else. **37 → 27 draw calls.** A
four-digit number is now four quads on a batch of several hundred instead of one
texture switch.

This one has a cost as well as a benefit and it should be stated: a label that
was one Game Object to position each frame is now up to four. That is more CPU
and more objects in the batch, traded for eighteen fewer texture binds and no
canvas rasterisation. On any GPU ever shipped that trade is heavily in credit —
a draw call is worth tens to hundreds of quads — but it is a trade, not a free
win, and it is why the objects-per-frame column did not fall.

**Off-screen terrain chunks are hidden.** Phaser does not frustum-cull an Image
or a RenderTexture: everything in the display list is submitted every frame, and
because each baked chunk is its own texture, each is its own draw call. Twenty
chunks were resident in the stress scenario to draw the six on screen — and
after twenty minutes of a real match the player has visited most of the map and
ninety-one of them are resident. **27 → 16 draw calls**, and, more importantly,
a number that no longer grows with how much of the map has been explored.

**Separation steering walks a units-only index on a finer grid.** It was the
hottest function in the simulation: 200 units × 20Hz, each asking "who is within
one tile of me" through `forEachNear`, which allocated a closure per call, walked
the ~1700 trees and the buildings sharing those cells, and swept a 12×12 tile
neighbourhood because its query pad is sized for buildings, which have footprints,
rather than for units, which are points. Now: inline over a units-only index with
two-tile cells and a one-tile pad. **`sim.units.separate` 1.00ms → 0.50ms
median.** The candidate set is unchanged and visited in the same order, so the
simulation is bit-for-bit the same game.

**Per-frame string building in the renderer is gone.** Working out which frame a
unit shows built four template strings and probed the atlas up to four times —
once per unit per frame, so thirteen thousand throwaway strings a second with
two hundred units on screen. Memoised on (type, player, facing, pose) in a
nested lookup that allocates nothing and builds no key, and it now returns the
frame's origin alongside its name so the draw loop does one lookup instead of
two. Below the resolution of the timer here; it is in for the phone's sake and
for the garbage, not for a number this machine can show.

**Pooled sprite resets are guarded.** `setFrame` unconditionally cleared the
tint, the flip, the rotation and the alpha of every sprite it handed out —
around two thousand Phaser setter calls a frame, each doing real work
(`clearTint` writes four packed colours and a flag, `setAlpha` writes four more
and re-derives the render flags). Each reset is now guarded on the value it
would write, which is a hundred or so actual writes instead of two thousand.

**Resource nodes have a static index.** ~1900 of them on a full map against the
forty the camera can hold, and the draw pass walked all of them and rejected
them one at a time. They are now bucketed eight tiles to a cell, keyed off the
event bus rather than rebuilt on a clock, so a query touches about two hundred
candidates. `render.resources`' worst frame went from 2.0ms to 0.4ms; its median
was already inside the timer's resolution. It deliberately does *not* reuse `world._buckets`: that index is
rebuilt at the top of each fixed step, and the draw pass runs three times per
step, so anything spawned between steps would be invisible until the next tick.

**The per-step allocations are gone.** `updateUnits` and `updateCombat` each
took `world.units.slice()` every step — forty two-hundred-element arrays a
second so that a loop could have a stable view of a list it already owns. They
share a reused buffer now (`snapshotUnits`). `checkVictory` allocated four
arrays of up to two hundred entities per step, per player, to answer two
questions that stop at their first hit; it is a scan.

### What degrades under load, and when

Nothing was cut. Two things thin out, and both are keyed on a measurement rather
than on a frame time — frame time is a lagging, noisy signal that would make the
effects flicker between full and thinned.

**Effects, keyed on the particle budget** (`src/gfx/fx.js`). Below 45%
occupancy of the 220-particle pool, everything is exactly as it was. Between 45%
and 85%, spawn counts fall off linearly to a third — a burst of four sparks
becomes two, then one, never zero. Above 85%, the two purely atmospheric effects
stop: footfall dust behind moving units, and the dust puff under a landed blow.
The sparks, the corpses, the arrows and the damage numbers never stop, because
those are what a player reads a fight from. In practice a skirmish of twenty
never leaves full detail, and a hundred-a-side melee spends most of its time in
the middle band, where a third of the sparks were landing on top of each other
anyway.

**Health bar decoration, keyed on the bar count** (`src/gfx/render.js`). A bar
is six filled rectangles: an outer shadow, an outline, the track, the fill and a
gloss. Above 48 bars in a frame — a fight of about two dozen a side — the outer
shadow and the gloss are dropped and the bar keeps its outline, its track and
its fill. In a two-hundred-unit battle that is 1200 rectangles a frame instead of
over 2000, submitted through the Graphics pipeline. The *information* is
untouched: the length and the colour are what a player reads, and both are
exactly as before. The count is taken from the previous frame, so the decision
costs nothing and cannot oscillate within a frame.

Neither degradation is permanent and neither has a hysteresis problem worth
worrying about: both thresholds sit well away from the density an ordinary game
reaches.

### The guards

`tests/perf.browser.mjs` — the full stress scenario, asserting the transferable
metrics: the drawing half of the frame's CPU at its low quartile and at its p95,
draw calls, Game Objects touched, and allocation per frame measured with V8's
sampling allocation profiler rather than by watching `usedJSHeapSize`, which
swings by a factor of two between identical runs because what it really measures
is where the collector last got to. The low quartile is used because a process
descheduled mid-frame charges that time to whichever phase was running, so
contention can only add to a sample and never subtract — which makes a low
percentile the only stable estimator available here, and a real regression
raises it along with everything else. The simulation's cost is deliberately
*not* asserted here; `simperf` measures it better. `--verbose` prints the
per-phase table and names the top allocation sites.

`tests/simperf.test.mjs` — the same battle with no browser at all, in `npm test`.
It is the quiet instrument: under 5% spread between runs, so it catches a small
regression that the browser guard would lose in machine weather.

`tests/art.browser.mjs` — the rewritten section 8, asserting draw calls, objects
touched and JavaScript milliseconds, and printing the wall clock beside the
measured empty-scene floor.

### What could not be measured from here

There is no GPU in this environment, so nothing was measured about actual fill
rate, overdraw cost, texture bandwidth or shader throughput on a real tile-based
mobile GPU — only the structural quantities that predict them. Specifically
unverified: whether the full-screen fog quad and its 12Hz texture upload are as
cheap on an Adreno or Mali as the arithmetic says they should be; whether the
2048² atlas fits comfortably in a mid-range phone's texture budget alongside the
resident terrain chunks; and whether the browser's own compositor on Android
leaves as much of the 16.7ms as this assumes. The honest claim this pass can
make is the one its numbers support: with 216 units in a pitched battle the game
asks for about 5ms of JavaScript, 16 draw calls, 650 Game Objects and under 2kB
of garbage per frame — and a device that cannot hold 60fps on that is not being
held back by anything in this repository.
