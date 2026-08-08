# Handoff: the military layer

Everything below is something the military pass could not do itself, because the
file belongs to another pass this sprint. Nothing here is a known bug in the
military layer — each item is a hole in a *neighbouring* file that the new roster
opened, and each one has a concrete fix.

Read this alongside `HANDOFF-vision.md`, whose item 1 (the vision constants) and
item 3 (the targeting leak) are **closed** by this pass: `DEFAULT_UNIT_LOS`,
`LOS_RANGE_MARGIN` and `DEFAULT_BUILDING_LOS` are gone from `systems/vision.js`,
every unit carries an explicit `lineOfSight` in `UNIT_STATS`, and `acquire()`
now refuses to pick a target its owner cannot see. Items 2 (enemy AI fairness),
4 (selection through fog) and 5 (placement on unexplored ground) are still open.

---

## 1. Art — `gfx/textures.js` (not owned by this pass)

Three new units have no sprite. `render.js`'s `unitFrameFor()` already falls back
to the villager frame for a type it has no art for, so **nothing crashes and
nothing warns** — the three of them simply walk around dressed as villagers,
which is the one thing about this pass that looks unfinished in a screenshot.

Each needs eight facings x two teams, generated the same way `unitFrame()` does
for the militia and the archer, plus a `UNIT_BOX` entry beside theirs:

| type | suggested `UNIT_BOX` | what it has to read as at 1x on a phone |
| --- | --- | --- |
| `spearman` | `{ w: 46, h: 64, cx: 23, ft: 54 }` | **A spear that is taller than the man.** That is the whole silhouette: a vertical shaft rising well above the head with a visible point, held at an angle. Box is taller than the militia's (56) purely to fit it. Body reads as the militia's — same helmet, same tunic — because a spearman *is* the militia line's cousin and should group with it visually. |
| `scout` | `{ w: 58, h: 60, cx: 29, ft: 52 }` | **A horse.** Four legs and a long body: the only unit on the map that is wider than it is tall, which is what makes cavalry legible in a crowd at 0.7 zoom without reading any labels. Rider small and low. The team colour belongs on the rider's torso, not the horse. |
| `ram` | `{ w: 64, h: 48, cx: 32, ft: 42 }` | **A machine, not a man.** A low timber frame with a suspended log and a pitched roof over it; no head, no limbs, no team-coloured tunic — a team-coloured pennant on the roof instead. It must not read as "a big soldier": the player has to know at a glance that the thing crawling at their Town Center cannot be answered by trading blows with it. |

The archer's note in `textures.js` — that one clear read carries a unit better
than three fussy ones — applies to all three. Spear, horse, log.

Two smaller things in the same file / `render.js`:

- `render.js` scales the militia by 1.12 and everything else by 1. The scout and
  the ram want their own figures once they have art (the ram especially: at 1.0
  it will be the same visual weight as a villager).
- **The garrison has no visual.** A Town Center with eight villagers inside looks
  exactly like an empty one. AoE2 draws a small flag/count over a garrisoned
  building; the HUD prints `Garrison 8 / 10` on the selection panel, which is the
  whole of the feedback today. `garrisonCount(building)` from `systems/combat.js`
  is the number to draw, and `building.garrison` is the array.

## 2. `trains` wiring — `core/constants.js`, `BUILDING_STATS` (owned by the walls pass)

The five units are all in `UNIT_STATS`. Only the barracks can currently produce
any of them, because the Archery Range, the Stable and the Siege Workshop are
named in `tech.js`'s age tables and in `BUILDABLE` but have no `BUILDING_STATS`
entry yet.

Rather than ship a roster nobody can reach, the barracks trains four of the five
as a stopgap — the archer was already there on exactly those terms. **The moment
the three military buildings land, this is the one-line change:**

```js
barracks:      trains: ['militia', 'spearman'],
archeryrange:  trains: ['archer'],
stable:        trains: ['scout'],
siegeworkshop: trains: ['ram'],
```

Nothing else needs editing. The HUD builds its train buttons from
`building.trains`, and the enemy AI now discovers its production buildings by
asking which of the ones it owns train something in `MILITARY_TYPES` — so a
Stable appearing means the AI starts making cavalry with no edit to `enemyAI.js`.

The **ram is deliberately not on the barracks**: a barracks building a siege
engine is a step too far, and unlike cavalry its absence costs the counter
triangle nothing. It is fully implemented and tested, and becomes reachable in
game the day the Siege Workshop does.

## 3. Town Center garrison capacity — `core/constants.js`, `BUILDING_STATS`

The Watch Tower (5) and the Castle (10) declare `garrisonCapacity`. The Town
Center does not, so it is currently served by a fallback table in the combat
section of `constants.js`:

```js
export const GARRISON_CAPACITY_FALLBACK = { towncenter: 10 };
```

**Please add `garrisonCapacity: 10` to the `towncenter` entry and delete the
fallback**, so there is one place a building's capacity is stated. Until then
both work and the declared value always wins.

While you are there: the Castle and the Watch Tower now *shoot*, using the
`attack` / `attackRange` / `attackCooldown` / `projectile` fields you added.
`updateBuildings()` in `systems/combat.js` reads them directly, adds one arrow
per garrisoned body on top, and obeys the fog. Nothing further is needed from
your side — the numbers you wrote are the numbers being fired.

## 4. Selection and orders — `ui/input.js` (not owned by this pass)

Two things there still believe the roster is two units wide:

```js
const MILITARY = new Set(['militia', 'archer']);   // line 85
```

It is used at line ~380 (which selected units an armed attack-move applies to)
and line ~592 (which tapped units count as troops). **A spearman, a scout or a
ram is currently not "military" as far as the input layer is concerned**, so
attack-move silently drops them from a mixed selection. The fix is one import:

```js
import { MILITARY_TYPES } from '../core/constants.js';
const MILITARY = new Set(MILITARY_TYPES);
```

`ui/hud.js` has been changed to do exactly that, so the two files currently
disagree about what a soldier is — which is the worst state for them to be in.

Two more, both smaller:

- **Garrisoning by tapping a building.** AoE2 garrisons with a right-click on the
  building. There is no right-click here, so the HUD has a `Garrison` button that
  sends the selection into its nearest shelter with room. If `input.js` ever
  grows "tap your own building with units selected", the order to issue is
  `commandUnits(world, units, { type: 'garrison', target: building })`.
- **Selection must skip garrisoned units.** `pickAt()` and the box-select loop
  iterate `world.units`, and a garrisoned unit is *not* in `world.units`, so they
  are already safe. Anything that iterates `ownedBy(world, PLAYER, 'unit')`
  instead is not: use `isGarrisoned(u)` from `systems/combat.js` to filter, the
  way the HUD's "select all military" now does.

## 5. What this pass changed outside its own files

Kept as small and as mechanical as possible, and listed here so nothing is a
surprise:

- **`systems/vision.js`** — three constants deleted, two imported from
  `constants.js` in their place, and `unitLineOfSight()` reduced from a
  derivation to `s.lineOfSight || DEFAULT_UNIT_LOS`. No behaviour change: the
  explicit values reproduce the derivation exactly (villager 4, militia 4,
  archer 6) and `tests/vision.test.mjs` still asserts them unchanged.
- **`core/events.js`** — two event names added, `EV.GARRISON` and
  `EV.UNGARRISON`, with their payloads documented in the table.
- **`core/constants.js`, `BUILDING_STATS.barracks.trains`** — the one line
  described in section 2 above. The only edit this pass made inside
  `BUILDING_STATS`.
- **`tests/combat.test.mjs`, `tests/units.test.mjs`** — both harnesses now call
  `world.vision.update()` in their step loop, as `GameScene.simStep()` does.
  This is not optional any more: auto-acquisition refuses to target what its
  owner cannot see, so a harness that never lights the map is a harness in which
  no unit ever picks a fight. Four tests in `combat.test.mjs` that assumed a
  militia could acquire at 7.5 tiles now use a scout (line of sight 7) or give
  the line a pair of scouts as its eyes; each carries a comment saying why.

## 6. Still open, and deliberately so

- **The enemy AI still plays with perfect information.** `foeArmorMix()` reads
  `ownedBy(world, foeId, 'unit')` directly rather than going through
  `world.vision.state(ENEMY)`. That is `HANDOFF-vision.md` item 2 and it is a
  bigger job than swapping the query — an honest AI also needs a scouting
  behaviour, since with fog it starts blind. The composition logic is written so
  that routing it through vision is a change to *one function*: everything else
  consumes the `{ mix, total }` it returns.
- **Units garrisoned in a building that is destroyed are ejected, not killed.**
  AoE2 kills them. Ejecting is a deliberate deviation: losing a Town Center is
  already the worst thing that can happen to a player on a phone, and silently
  deleting the eight villagers they sheltered in it turns a setback into an
  unrecoverable one with no visible cause. Worth revisiting if the Castle makes
  garrisoning too safe.
- **A unit already engaged keeps chasing a target that walks into fog.** AoE2
  does the same — the chase runs until the leash expires rather than dropping the
  instant the target goes dark — so this was left alone, as `HANDOFF-vision.md`
  suggested. It does mean a unit will follow something it cannot see.
- **No unit-upgrade line** (Man-at-Arms, Pikeman, Knight). The tech system has
  no notion of a unit *becoming* another unit, and adding one is a change to
  `tech.js`'s machinery rather than to its table. The three new Castle-Age
  entries (Blast Furnace, Ring Archer Armour, Plate Mail) are what the enlarged
  roster has to spend gold on in the meantime.
