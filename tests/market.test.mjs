// The Market: the pricing rule, and the two things it exists to fix.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, spawnBuilding, removeEntity } from '../src/core/world.js';
import { PLAYER, ENEMY, BUILDING_STATS, BUILDABLE } from '../src/core/constants.js';
import { EV } from '../src/core/events.js';
import { AGE, ageForBuilding, completeResearch, isUnlocked } from '../src/systems/tech.js';
import {
  TRADE_LOT, BASE_PRICE, PRICE_STEP, COMMISSION, MIN_PRICE, MAX_PRICE, TRADED,
  priceOf, prices, buyCost, sellValue, hasMarket, tradeOptions, buy, sell,
  serializeMarket, restoreMarket,
} from '../src/systems/market.js';

function stage({ market = true, gold = 1000, food = 1000, wood = 1000, stone = 1000 } = {}) {
  const world = createWorld(11);
  const p = world.players[PLAYER];
  p.resources.gold = gold;
  p.resources.food = food;
  p.resources.wood = wood;
  p.resources.stone = stone;
  const b = market ? spawnBuilding(world, 'market', PLAYER, 10, 10) : null;
  return { world, p, b };
}

// --- The building ------------------------------------------------------------

test('the Market is a Feudal Age building the build menu already knows about', () => {
  const s = BUILDING_STATS.market;
  assert.ok(s, 'there is no Market in BUILDING_STATS');
  assert.equal(ageForBuilding('market'), AGE.FEUDAL);
  assert.ok(BUILDABLE.includes('market'), 'the build menu does not list it');
  assert.ok(s.cost.wood > 0, 'a Market that costs nothing is not a decision');
  assert.ok(!s.dropoff, 'a Market must not bank resources — see the note in constants.js');

  const { world } = stage({ market: false });
  assert.equal(isUnlocked(world, PLAYER, 'market'), false, 'buildable in the Dark Age');
  completeResearch(world, PLAYER, 'feudal_age');
  assert.equal(isUnlocked(world, PLAYER, 'market'), true, 'still locked in the Feudal Age');
});

test('trading needs a finished Market of your own', () => {
  const { world } = stage({ market: false });
  assert.equal(hasMarket(world, PLAYER), false);
  assert.equal(sell(world, PLAYER, 'wood'), false, 'sold without a Market');
  assert.equal(buy(world, PLAYER, 'food'), false, 'bought without a Market');

  const site = spawnBuilding(world, 'market', PLAYER, 10, 10, { complete: false });
  assert.equal(hasMarket(world, PLAYER), false, 'a foundation traded');
  assert.equal(sell(world, PLAYER, 'wood'), false);
  site.complete = true;
  assert.equal(hasMarket(world, PLAYER), true);
  assert.equal(sell(world, PLAYER, 'wood'), true);

  // ...and it has to be yours.
  const theirs = createWorld(2);
  theirs.players[ENEMY].resources.wood = 500;
  spawnBuilding(theirs, 'market', ENEMY, 10, 10);
  assert.equal(hasMarket(theirs, PLAYER), false, 'the enemy Market traded for the player');
  assert.equal(sell(theirs, PLAYER, 'wood'), false);
});

// --- The pricing rule --------------------------------------------------------

test('prices start level, and the commission is on the sell side only', () => {
  const { world } = stage();
  for (const res of TRADED) {
    assert.equal(priceOf(world, res), BASE_PRICE, res);
    assert.equal(buyCost(world, res), BASE_PRICE, `buying ${res}`);
    assert.equal(sellValue(world, res), Math.floor(BASE_PRICE * (1 - COMMISSION)),
      `selling ${res}`);
  }
  assert.ok(sellValue(world, 'wood') < buyCost(world, 'wood'),
    'a lot sells for at least what it costs — that is an arbitrage loop');
  assert.ok(!TRADED.includes('gold'), 'gold must be the currency, not a commodity');
});

test('selling drops a price and buying raises it, by the step, per lot', () => {
  const { world, p } = stage();

  sell(world, PLAYER, 'wood');
  assert.equal(priceOf(world, 'wood'), BASE_PRICE - PRICE_STEP);
  assert.equal(priceOf(world, 'food'), BASE_PRICE, 'selling wood moved food');

  buy(world, PLAYER, 'food');
  assert.equal(priceOf(world, 'food'), BASE_PRICE + PRICE_STEP);
  assert.equal(priceOf(world, 'wood'), BASE_PRICE - PRICE_STEP, 'buying food moved wood');

  // Ten more lots of wood, and the tenth is worth measurably less than the first.
  const first = sellValue(world, 'wood');
  p.resources.wood = 2000;
  for (let i = 0; i < 9; i++) sell(world, PLAYER, 'wood');
  const tenth = sellValue(world, 'wood');
  assert.equal(priceOf(world, 'wood'), BASE_PRICE - PRICE_STEP * 10);
  assert.ok(tenth < first - 15,
    `dumping ten lots barely moved the price: ${first} -> ${tenth}`);
});

test('one lot in and straight back out is a loss — there is no loop to farm', () => {
  const { world, p } = stage({ gold: 1000, wood: 0 });
  const gold0 = p.resources.gold;
  assert.ok(buy(world, PLAYER, 'wood'));
  assert.equal(p.resources.wood, TRADE_LOT);
  assert.ok(sell(world, PLAYER, 'wood'));
  assert.equal(p.resources.wood, 0);
  assert.ok(p.resources.gold < gold0,
    `round-tripped a lot for a profit: ${gold0} -> ${p.resources.gold}`);
  // The price is back where it started, so the only cost was the commission.
  assert.equal(priceOf(world, 'wood'), BASE_PRICE);
});

test('the stockpile moves by exactly the lot and exactly the quoted gold', () => {
  const { world, p } = stage({ gold: 500, stone: 500 });

  const sellQuote = sellValue(world, 'stone');
  const gold0 = p.resources.gold;
  const stone0 = p.resources.stone;
  assert.ok(sell(world, PLAYER, 'stone'));
  assert.equal(p.resources.stone, stone0 - TRADE_LOT);
  assert.equal(p.resources.gold, gold0 + sellQuote);

  const buyQuote = buyCost(world, 'food');
  const food0 = p.resources.food;
  const gold1 = p.resources.gold;
  assert.ok(buy(world, PLAYER, 'food'));
  assert.equal(p.resources.food, food0 + TRADE_LOT);
  assert.equal(p.resources.gold, gold1 - buyQuote);
});

test('a trade the player cannot pay for does not happen at all', () => {
  const { world, p } = stage({ gold: 10, wood: 40 });
  const before = { ...p.resources };
  assert.equal(buy(world, PLAYER, 'food'), false, 'bought with ten gold');
  assert.equal(sell(world, PLAYER, 'wood'), false, 'sold forty wood as a lot of a hundred');
  assert.deepEqual(p.resources, before, 'a refused trade still moved the stockpile');
  assert.deepEqual(prices(world), { food: BASE_PRICE, wood: BASE_PRICE, stone: BASE_PRICE },
    'a refused trade still moved a price');
});

test('prices cannot be walked past their floor or their ceiling', () => {
  const { world, p } = stage({ gold: 1e6, wood: 1e6, food: 1e6, stone: 1e6 });
  for (let i = 0; i < 400; i++) sell(world, PLAYER, 'wood');
  assert.equal(priceOf(world, 'wood'), MIN_PRICE);
  assert.ok(sellValue(world, 'wood') > 0, 'a floored resource pays nothing at all');
  for (let i = 0; i < 400; i++) buy(world, PLAYER, 'food');
  assert.equal(priceOf(world, 'food'), MAX_PRICE);
  assert.ok(p.resources.food > 1e6, 'four hundred lots bought and no food arrived');
});

test('it rescues a player who has mined out their gold', () => {
  // The scenario the building exists for: no gold at all, a forest banked, and
  // an archer (45 gold) that cannot be trained.
  const { world, p } = stage({ gold: 0, wood: 2000, food: 200, stone: 400 });
  assert.equal(p.resources.gold, 0);
  let lots = 0;
  while (p.resources.gold < 45 && lots < 10) {
    assert.ok(sell(world, PLAYER, 'wood'), `sale ${lots + 1} was refused`);
    lots++;
  }
  assert.ok(p.resources.gold >= 45,
    `still cannot afford an archer after ${lots} lots of wood`);
  assert.ok(lots <= 2,
    `it took ${lots} lots of wood to reach 45 gold — the market is not a rescue`);
});

// --- What the sheet reads ----------------------------------------------------

test('tradeOptions says the same thing the trade itself will', () => {
  const { world, p } = stage({ gold: 100, wood: 100, food: 0, stone: 0 });
  const opts = tradeOptions(world, PLAYER);
  assert.equal(opts.length, TRADED.length);

  const wood = opts.find((o) => o.res === 'wood');
  assert.equal(wood.canSell, true, 'exactly one lot of wood cannot be sold');
  assert.equal(wood.sellRefusal, null);
  assert.equal(wood.cost, buyCost(world, 'wood'));
  assert.equal(wood.value, sellValue(world, 'wood'));

  const stone = opts.find((o) => o.res === 'stone');
  assert.equal(stone.canSell, false, 'no stone, but the sheet offered a sale');
  assert.match(stone.sellRefusal, /100 stone/);
  assert.equal(sell(world, PLAYER, 'stone'), false, 'the sheet and the trade disagree');

  // 100 gold buys exactly one lot at the base price and no more.
  const food = opts.find((o) => o.res === 'food');
  assert.equal(food.canBuy, true);
  assert.ok(buy(world, PLAYER, 'food'));
  assert.equal(p.resources.gold, 0);
  assert.equal(tradeOptions(world, PLAYER).find((o) => o.res === 'food').canBuy, false);
  assert.equal(buy(world, PLAYER, 'food'), false);
});

test('every trade announces itself, and a refusal never does', () => {
  const { world } = stage({ gold: 200, wood: 300 });
  const seen = [];
  world.events.on(EV.TRADE, (p) => seen.push(p));

  sell(world, PLAYER, 'wood');
  buy(world, PLAYER, 'food');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].side, 'sell');
  assert.equal(seen[0].resource, 'wood');
  assert.equal(seen[0].amount, TRADE_LOT);
  assert.equal(seen[0].price, BASE_PRICE - PRICE_STEP, 'the event carries the stale price');
  assert.equal(seen[1].side, 'buy');
  assert.equal(seen[1].gold, BASE_PRICE);

  world.players[PLAYER].resources.gold = 0;
  world.players[PLAYER].resources.wood = 0;
  buy(world, PLAYER, 'food');
  sell(world, PLAYER, 'wood');
  assert.equal(seen.length, 2, 'a refused trade announced itself');
});

test('a Market that is destroyed stops the trading', () => {
  const { world, b } = stage();
  assert.ok(sell(world, PLAYER, 'wood'));
  removeEntity(world, b);
  assert.equal(hasMarket(world, PLAYER), false);
  assert.equal(sell(world, PLAYER, 'wood'), false);
  // The prices it moved stay moved: they are a fact about the map, not about
  // who happens to own a building today.
  assert.equal(priceOf(world, 'wood'), BASE_PRICE - PRICE_STEP);
});

// --- Save --------------------------------------------------------------------

test('the drifting prices survive a save', () => {
  const { world, p } = stage({ gold: 5000, wood: 5000 });
  for (let i = 0; i < 7; i++) sell(world, PLAYER, 'wood');
  for (let i = 0; i < 4; i++) buy(world, PLAYER, 'stone');
  const before = prices(world);
  assert.notDeepEqual(before, { food: BASE_PRICE, wood: BASE_PRICE, stone: BASE_PRICE });

  const data = JSON.parse(JSON.stringify(serializeMarket(world)));
  const fresh = createWorld(11);
  restoreMarket(fresh, data);
  assert.deepEqual(prices(fresh), before);

  // A nonsense payload leaves the prices alone rather than poisoning them.
  const other = createWorld(11);
  restoreMarket(other, { prices: { wood: 'lots', food: NaN } });
  assert.deepEqual(prices(other), { food: BASE_PRICE, wood: BASE_PRICE, stone: BASE_PRICE });
  restoreMarket(other, null);
  assert.deepEqual(prices(other), { food: BASE_PRICE, wood: BASE_PRICE, stone: BASE_PRICE });
  // ...and an out-of-range one is clamped, not trusted.
  restoreMarket(other, { prices: { wood: 99999, food: -50 } });
  assert.equal(priceOf(other, 'wood'), MAX_PRICE);
  assert.equal(priceOf(other, 'food'), MIN_PRICE);
  void p;
});
