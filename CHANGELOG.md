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
