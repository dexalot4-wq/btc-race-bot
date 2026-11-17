// cbBTC 1-minute bot for agent-fun/bars-replay/v1: ride the drift, insure
// against the crash.
//
// A full-size round trip in this replay costs about 26 bps (4 bps fee and
// 2 bps slippage each way, plus constant-product price impact), and 1-minute
// BTC is mostly chop: every active strategy in the kit's baselines that
// trades more than a couple of times pays more in costs than the chop gives
// back. So this bot trades as little as possible:
//
//   - Entry: it puts nearly all its cash into cbBTC on the first bar it may
//     trade on, unless the market is already falling hard at the open (the
//     first close far under the first open), in which case it waits for the
//     re-entry signal below instead. One position, held.
//   - Disaster exits only: it sells if the close trails the highest close
//     since entry by 250 bps, or closes 150 bps under its 720-bar EMA (a
//     regime break, not a wiggle). Ordinary dips do not shake it out.
//   - Re-entry: after a disaster exit it may buy back once, when the close
//     is back above the 240-bar EMA with a trailing 240-bar return over
//     +40 bps. At most two buys in a window.
//
// On a rising or sideways window it behaves like holding and keeps the
// drift; on a crashing window the exits cap the loss at a few percent
// instead of riding the fall, which also keeps the drawdown far inside the
// race's 25% guardrail. Every decision is a deterministic function of the
// bars seen so far: no clock, no environment, no randomness.

import { runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SLIP_BPS = 150; // max_slippage_bps sent with every order
const CRASH_OPEN_BPS = 100; // first close this far under the first open: do not buy yet
const TRAIL_BPS = 250; // disaster trailing stop below the best close since entry
const REGIME_EMA = 720; // slow regime EMA, in bars
const REGIME_DROP_BPS = 150; // close this far under the regime EMA: regime break
const RE_EMA = 240; // re-entry trend EMA, in bars
const RE_MOM_BPS = 40; // trailing RE_EMA-bar return needed to re-enter
const MAX_BUYS = 2;

const closes: number[] = [];
let firstOpen: number | null = null;
let emaRegime: number | null = null;
let emaRe: number | null = null;
let peak: number | null = null; // highest close since the position appeared
let buys = 0;
let buyPending = false; // a buy was sent and has not been seen filled or refused yet
let wasHolding = false;

function stepEma(prev: number | null, close: number, span: number): number {
  if (prev === null) return close;
  return prev + (2 / (span + 1)) * (close - prev);
}

function buyOrder(state: { cash: bigint; hello: { fees: { min_notional_quote_units: string } } }): BuyInput | null {
  const spend = (state.cash * 99n) / 100n;
  if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return null;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: SLIP_BPS };
}

await runBars({
  onBatch(state, batch) {
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      if (firstOpen === null) firstOpen = Number(bar.o);
      const c = Number(bar.c);
      closes.push(c);
      emaRegime = stepEma(emaRegime, c, REGIME_EMA);
      emaRe = stepEma(emaRe, c, RE_EMA);
      fresh = true;
    }
    // A sent buy either filled (a position is here now) or was refused; both
    // clear the pending flag, and a refusal still counts against MAX_BUYS so
    // a gap cannot make the bot spam orders bar after bar.
    for (const fill of batch.fills) {
      if (fill.side === 'buy') buyPending = false;
    }

    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;
    if (holding) {
      const c = closes[closes.length - 1];
      if (c !== undefined && (peak === null || c > peak)) peak = c;
      wasHolding = true;
      buyPending = false;
    } else {
      wasHolding = false;
      peak = null;
    }

    if (state.warmingUp || !fresh || closes.length === 0) return [];
    const close = closes[closes.length - 1];

    if (holding && held !== undefined) {
      const stopped = peak !== null && close * 10000 < peak * (10000 - TRAIL_BPS);
      const regimeBroke =
        closes.length >= REGIME_EMA &&
        emaRegime !== null &&
        close * 10000 < emaRegime * (10000 - REGIME_DROP_BPS);
      if (stopped || regimeBroke) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SLIP_BPS };
        return [sell];
      }
      return [];
    }

    if (buyPending || buys >= MAX_BUYS) return [];

    if (buys === 0) {
      // First entry: buy at once unless the open is a falling knife.
      if (firstOpen !== null && close * 10000 < firstOpen * (10000 - CRASH_OPEN_BPS)) {
        // Fall through to the re-entry signal instead of catching the fall.
      } else {
        const order = buyOrder(state);
        if (order === null) return [];
        buys += 1;
        buyPending = true;
        return [order];
      }
    }

    // Re-entry (also the entry when the open crashed): trend restored.
    if (closes.length > RE_EMA && emaRe !== null && close > emaRe) {
      const past = closes[closes.length - 1 - RE_EMA];
      if (past > 0 && close * 10000 >= past * (10000 + RE_MOM_BPS)) {
        const order = buyOrder(state);
        if (order === null) return [];
        buys += 1;
        buyPending = true;
        return [order];
      }
    }
    return [];
  },
});
