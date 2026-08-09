// The Market: trading food, wood and stone against gold at a drifting price.
//
// No Phaser imports — this is pure economy and runs headlessly under Node (see
// tests/market.test.mjs).
//
// WHAT THE MARKET IS FOR
// ----------------------
// Two problems, one building. The first is that a surplus is dead weight: this
// map carries 39000-44000 wood in trees and 150 starting stone with two sinks
// worth the name, so by minute eight a player who chopped well is sitting on a
// number that buys nothing. The second is the opposite and much worse — a
// player who has *mined out* their gold cannot train an archer, cannot buy a
// Blacksmith upgrade and cannot advance to the Castle Age, and there is nothing
// in the game they can do about it, however well the rest of their economy is
// running. The Market turns both of those into a decision.
//
// THE PRICING RULE
// ----------------
// AoE2's, with its numbers. Food, wood and stone each carry a price in gold per
// hundred units, and gold itself is never traded — it is the currency, not a
// commodity, which is what makes "I am out of gold" a problem the Market can
// answer at all.
//
//   buying   one lot of 100 costs the price, in gold, and pushes that
//            resource's price UP by PRICE_STEP
//   selling  one lot of 100 pays the price LESS the commission, and pushes the
//            price DOWN by PRICE_STEP
//
// Everything interesting follows from those four lines:
//
//   * The commission is on the sell side only, exactly as in AoE2. It is what
//     makes the Market a *sink* rather than an arbitrage machine: buy a lot and
//     immediately sell it back and you are down COMMISSION of its value plus
//     twice the price step, so there is no loop to farm.
//   * A price that moves with the trade is what stops the Market being an
//     infinite tap. Dumping wood is worth a great deal for the first few
//     hundred and progressively less after that: at 100 gold a lot, ten
//     consecutive sales take wood from 100 to 70 and the tenth lot pays 21 gold
//     less than the first. A player who wants to convert a forest into a Castle
//     Age can, and pays a worsening rate for the privilege.
//   * The floor and the ceiling exist so neither end can be walked to zero. At
//     MIN_PRICE a resource still pays something for the player who has nothing
//     else; at MAX_PRICE buying it is a bad idea but never impossible.
//
// The prices are one set for the whole world rather than one per player, which
// is AoE2's rule too: a market price is a fact about the map, not about who is
// looking at it. With a single AI opponent that does not trade, the two are the
// same thing today — it is written this way so that the day the AI learns to
// dump its stone, the player feels it.

import { RES, PLAYER } from '../core/constants.js';
import { EV } from '../core/events.js';
import { canAfford, pay, addResource } from './economy.js';

/** Units bought or sold in one trade. AoE2's hundred. */
export const TRADE_LOT = 100;
/** What a lot of anything is worth on the first day. */
export const BASE_PRICE = 100;
/**
 * Gold the price moves per lot traded.
 *
 * Three is AoE2's own step, and at a hundred-gold base it is the number that
 * makes the drift *legible*: a player who sells five lots of stone watches the
 * price fall 100 → 85 and understands the rule without being told it. One would
 * be invisible over a ten-minute match; ten would make the second trade of any
 * session feel like a punishment.
 */
export const PRICE_STEP = 3;
/**
 * The spread. Thirty per cent is AoE2's opening commission, and it is high on
 * purpose: the Market is the expensive way to get a resource, and it has to stay
 * clearly worse than sending a villager to fetch it. A player who trades because
 * it is convenient should regret it; a player who trades because their gold is
 * gone should be grateful it exists.
 */
export const COMMISSION = 0.30;
/**
 * Price bounds. Twenty is AoE2's floor and it matters most to the player this
 * building is here to rescue: whatever they have dumped, a lot of it still buys
 * a fifth of what it used to and never nothing. The ceiling is this game's own —
 * a ten-minute match cannot walk a price to AoE2's 9999, and 500 is high enough
 * that buying a resource you have exhausted is a genuinely bad deal without
 * being a locked door.
 */
export const MIN_PRICE = 20;
export const MAX_PRICE = 500;

/** What can be traded, in the order the sheet lists it. Gold is the currency. */
export const TRADED = [RES.FOOD, RES.WOOD, RES.STONE];

// --- State -------------------------------------------------------------------
//
// Attached lazily to the world, the same way tech and allocation do it, so that
// core/world.js does not have to know this system exists.

function marketState(world) {
  if (!world._market) {
    world._market = { prices: {} };
    for (const k of TRADED) world._market.prices[k] = BASE_PRICE;
  }
  // A world saved before a resource was tradeable gets the missing entry.
  for (const k of TRADED) {
    if (!Number.isFinite(world._market.prices[k])) world._market.prices[k] = BASE_PRICE;
  }
  return world._market;
}

function clampPrice(v) {
  return Math.max(MIN_PRICE, Math.min(MAX_PRICE, v));
}

/** The current price of a lot, in gold, before commission. */
export function priceOf(world, resource) {
  if (!TRADED.includes(resource)) return 0;
  return marketState(world).prices[resource];
}

/** Every price at once, for the HUD. A copy — nothing outside here writes them. */
export function prices(world) {
  return { ...marketState(world).prices };
}

/** Gold it costs to buy one lot right now. */
export function buyCost(world, resource) {
  return Math.ceil(priceOf(world, resource));
}

/** Gold one lot fetches right now, commission taken off. */
export function sellValue(world, resource) {
  return Math.floor(priceOf(world, resource) * (1 - COMMISSION));
}

/** Does this player own a finished Market? Trading needs one standing. */
export function hasMarket(world, playerId) {
  for (const b of world.buildings) {
    if (b.dead || b.player !== playerId) continue;
    if (b.type === 'market' && b.complete) return true;
  }
  return false;
}

/**
 * Everything the trade sheet needs for one resource, in one read.
 *
 * `refusal` is the sentence explaining why a side is greyed out, and it is
 * computed here rather than in the HUD so that the button, the toast the button
 * raises, and the refusal `buy`/`sell` would give can never disagree.
 */
export function tradeOptions(world, playerId = PLAYER) {
  const p = world.players[playerId];
  const gold = (p && p.resources.gold) || 0;
  const standing = hasMarket(world, playerId);
  return TRADED.map((res) => {
    const have = (p && p.resources[res]) || 0;
    const cost = buyCost(world, res);
    const value = sellValue(world, res);
    return {
      res,
      price: priceOf(world, res),
      cost,
      value,
      lot: TRADE_LOT,
      have: Math.floor(have),
      canBuy: standing && gold >= cost,
      canSell: standing && have >= TRADE_LOT,
      buyRefusal: !standing ? NO_MARKET
        : gold < cost ? `Not enough gold — ${cost} needed` : null,
      sellRefusal: !standing ? NO_MARKET
        : have < TRADE_LOT ? `You need ${TRADE_LOT} ${res} to sell a lot` : null,
    };
  });
}

const NO_MARKET = 'You need a finished Market to trade';

// --- The two trades ----------------------------------------------------------

function refuse(world, playerId, text) {
  if (playerId === PLAYER) world.events.emit(EV.TOAST, { text, tone: 'warn' });
  return false;
}

/**
 * Spend gold on a lot of `resource`. Returns true when the trade happened.
 *
 * Both directions charge before they pay, and both move the price *after* the
 * exchange, so the price a player was shown is the price they got — a market
 * that moved the number under the tap would be a market nobody trusts.
 */
export function buy(world, playerId, resource) {
  if (!TRADED.includes(resource)) return false;
  if (!hasMarket(world, playerId)) return refuse(world, playerId, NO_MARKET);
  const cost = buyCost(world, resource);
  if (!canAfford(world, playerId, { gold: cost })) {
    world.events.emit(EV.INSUFFICIENT, { player: playerId, playerId, cost: { gold: cost } });
    return false;
  }
  if (!pay(world, playerId, { gold: cost }, `market:buy:${resource}`)) return false;
  addResource(world, playerId, resource, TRADE_LOT, `market:buy:${resource}`);
  const st = marketState(world);
  st.prices[resource] = clampPrice(st.prices[resource] + PRICE_STEP);
  world.events.emit(EV.TRADE, {
    player: playerId, playerId, side: 'buy', resource,
    amount: TRADE_LOT, gold: cost, price: st.prices[resource],
  });
  return true;
}

/** Sell a lot of `resource` for gold, less the commission. */
export function sell(world, playerId, resource) {
  if (!TRADED.includes(resource)) return false;
  if (!hasMarket(world, playerId)) return refuse(world, playerId, NO_MARKET);
  const p = world.players[playerId];
  if (!p || (p.resources[resource] || 0) < TRADE_LOT) {
    return refuse(world, playerId, `You need ${TRADE_LOT} ${resource} to sell a lot`);
  }
  const value = sellValue(world, resource);
  if (!pay(world, playerId, { [resource]: TRADE_LOT }, `market:sell:${resource}`)) return false;
  addResource(world, playerId, RES.GOLD, value, `market:sell:${resource}`);
  const st = marketState(world);
  st.prices[resource] = clampPrice(st.prices[resource] - PRICE_STEP);
  world.events.emit(EV.TRADE, {
    player: playerId, playerId, side: 'sell', resource,
    amount: TRADE_LOT, gold: value, price: st.prices[resource],
  });
  return true;
}

// --- Save and load -----------------------------------------------------------

export function serializeMarket(world) {
  return { prices: { ...marketState(world).prices } };
}

export function restoreMarket(world, data) {
  const st = marketState(world);
  if (!data || !data.prices) return;
  for (const k of TRADED) {
    const v = data.prices[k];
    if (Number.isFinite(v)) st.prices[k] = clampPrice(v);
  }
}
