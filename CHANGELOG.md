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

`HANDOFF-walls.md` has the details. In short: `combat.js` has to grow a
buildings-that-shoot loop (the Castle and the Watch Tower already carry `attack`,
`range`, `attackCooldown`, `cooldown`, `target` and `garrison` under the same
field names a unit uses, and `volleySize()` returns AoE2's one-arrow-per-body),
and `unitAI.js` should start passing `u.player` to the pathfinder and gain a
garrison order. The building side of garrisoning is done: a unit inside is
spliced out of `world.units` — so no loop anywhere has to learn the word — while
staying in `world.entities` and on the population.

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
