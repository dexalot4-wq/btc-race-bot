# btc-race-bot

A cbBTC 1-minute trading bot for the make.fun "Race a BTC trading bot live
for 24 hours" bounty (protocol `agent-fun/bars-replay/v1`).

Strategy — ride the drift, insure against the crash. A full-size round trip
in this replay costs about 26 bps in fees, slippage and price impact, and
1-minute BTC is mostly chop, so the bot trades as little as possible: it
buys cbBTC with 99% of its cash on the first tradable bar (unless the
market is already falling hard at the open), holds through ordinary dips,
and sells only on a disaster signal — a 250 bps trailing stop below the
best close since entry, or a close 150 bps under the 720-bar EMA. After a
disaster exit it may re-enter once if the trend restores. At most two buys
per window.

Dev window (kit grade-local, process driver): net PnL +$1.0795 on $1,000,
1 trade, max drawdown 2.1%.

Run: `node main.ts` (Node 22). The bot speaks newline-delimited JSON on
stdin/stdout via the vendored SDK shim in `vendor/makefun-bars.ts`
(byte-identical copy of the kit's SDK, MIT-licensed with the kit).
