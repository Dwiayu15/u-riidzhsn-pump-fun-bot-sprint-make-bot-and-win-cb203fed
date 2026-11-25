// Dip-anchor ladder bot for the pump.fun replay (agent-fun/replay/v2).
//
// Character: this bot never chases strength. It waits for a coin that already
// proved it can attract SOL (a real peak in price backed by real reserves),
// then buys only after the price has fallen a long way from that peak, has
// bounced off its post-peak low, and the tape shows the dip is being absorbed
// (recent flow net-buy, last trade a buy). Entries are laddered: one anchor tranche, plus at most one add if the
// price steps down again without the flow rolling over. Every position is
// wrapped in hard exits (take profit, trailing stop, hard stop, time stop),
// and a portfolio shell watches equity drawdown: it halves size when the book
// is bleeding and stops opening new positions entirely past a drawdown cap,
// so a bad stretch cannot turn into a blow-up.
//
// Pure function of the batches: no clock, no randomness, no I/O. The two
// graded executions therefore produce byte-identical order streams.

import { LAMPORTS_PER_SOL, runBot, type OrderInput } from './vendor/makefun-bot.ts';

// ---- tuning constants (lamports are bigint, ratios are plain numbers) ----

/** Real SOL a curve must hold before we trust its peak at all. */
const MIN_REAL_QUOTE = 4n * LAMPORTS_PER_SOL;
/** Trades we must have seen on a coin before it can be entered. */
const MIN_TRADES_SEEN = 40;
/** Slots a peak stays "recent"; an older peak is re-anchored to spot. */
const PEAK_WINDOW_SLOTS = 4200;
/** Enter only when spot is between these fractions below the peak. */
const DIP_SHALLOW = 0.25;
const DIP_DEEP = 0.45;
/** ...and only once spot has bounced at least this far off its post-peak low:
 *  the first run graded -0.995 SOL because it bought falling knives, so an
 *  entry now needs the bounce, not just the dip. */
const BOUNCE_OFF_LOW = 0.05;
/** Flow window: share of SOL that must be buys over the last FLOW_TRADES. */
const FLOW_TRADES = 12;
const FLOW_BUY_SHARE = 0.62;
/** Anchor stake, and the most one coin may hold in total. */
const ANCHOR_STAKE = LAMPORTS_PER_SOL / 3n; // ~0.333 SOL
const MAX_PER_COIN = (LAMPORTS_PER_SOL * 11n) / 20n; // 0.55 SOL
/** Smallest anchor worth the transaction fee. */
const MIN_STAKE = LAMPORTS_PER_SOL / 16n; // 0.0625 SOL
/** Add a second tranche when spot falls this far under the first fill. */
const LADDER_STEP = 0.12;
/** Exits, as fractions of position cost (liquidation value vs cost). */
const TAKE_PROFIT = 0.12;
const HARD_STOP = 0.08;
const TRAIL_ARM = 0.22;
const TRAIL_GIVEBACK = 0.1;
/** Longest a position may live, in slots (~30 minutes). */
const MAX_HOLD_SLOTS = 4500;
/** Slots a coin is ignored after we exit it. */
const COOLDOWN_SLOTS = 2000;
/** Cash that must stay uncommitted after any buy. */
const CASH_FLOOR = (LAMPORTS_PER_SOL * 3n) / 4n; // 0.75 SOL
/** Portfolio shell: size halves past this equity drawdown, entries halt past the next. */
const DD_SOFT = 0.05;
const DD_HARD = 0.12;
const DD_HALT_SLOTS = 4000;
/** New entries per reply, whatever the tape offers. */
const MAX_ENTRIES_PER_BATCH = 2;
/** Slippage tolerance: entries patient, exits determined. */
const BUY_SLIPPAGE_BPS = 400;
const SELL_SLIPPAGE_BPS = 900;
/** Curve fee haircut when estimating what a sell would realise (95 + 30 bps). */
const FEE_BPS = 125n;

// ---- per-coin tape memory ----

interface TapeTrade {
  buy: boolean;
  sol: number; // lamports as a float; only ratios of these are used
}

interface CoinWatch {
  peakPrice: number;
  peakSlot: number;
  lowPrice: number; // lowest spot since the current peak was set
  tape: TapeTrade[];
  lastBuy: boolean;
}

interface PositionBook {
  firstPrice: number; // quote per token of the first fill
  entrySlot: number;
  peakValue: bigint; // best liquidation estimate seen, lamports
  tranches: number;
  exitPending: boolean;
}

const watch = new Map<string, CoinWatch>();
const book = new Map<string, PositionBook>();
const cooldownUntil = new Map<string, number>();

let orderSeq = 0;
let peakEquity = 0n;
let haltEntriesUntil = -1;

function spotPrice(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  if (curve.virtual_token_reserves === 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

/** What selling `tokens` into the curve would realise now, fees haircut, in lamports. */
function liquidationValue(
  curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint },
  tokens: bigint,
): bigint {
  if (tokens === 0n) return 0n;
  const gross = (curve.virtual_quote_reserves * tokens) / (curve.virtual_token_reserves + tokens);
  return (gross * (10_000n - FEE_BPS)) / 10_000n;
}

/** Recent flow verdict for a watch: net-buy share over the tape window. */
function flowIsAbsorbing(w: CoinWatch): boolean {
  if (w.tape.length < FLOW_TRADES || !w.lastBuy) return false;
  let buySol = 0;
  let allSol = 0;
  for (const t of w.tape) {
    allSol += t.sol;
    if (t.buy) buySol += t.sol;
  }
  return allSol > 0 && buySol / allSol >= FLOW_BUY_SHARE;
}

await runBot({
  onBatch(state, batch) {
    const caps = state.hello.caps;
    const slot = state.slot;
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let entries = 0;

    // 1. Fold this batch's trades into the tape memory.
    const tradedHere = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!watch.has(e.mint)) {
          watch.set(e.mint, { peakPrice: 0, peakSlot: slot, lowPrice: 0, tape: [], lastBuy: false });
        }
        continue;
      }
      if (e.event === 'CompleteEvent') {
        watch.delete(e.mint);
        continue;
      }
      // TradeEvent
      let w = watch.get(e.mint);
      if (w === undefined) {
        w = { peakPrice: 0, peakSlot: slot, lowPrice: 0, tape: [], lastBuy: false };
        watch.set(e.mint, w);
      }
      const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      if (price > w.peakPrice || slot - w.peakSlot > PEAK_WINDOW_SLOTS) {
        w.peakPrice = price;
        w.peakSlot = slot;
        w.lowPrice = price;
      }
      if (w.lowPrice === 0 || price < w.lowPrice) w.lowPrice = price;
      w.tape.push({ buy: e.is_buy, sol: Number(e.sol_amount) });
      if (w.tape.length > FLOW_TRADES) w.tape.shift();
      w.lastBuy = e.is_buy;
      tradedHere.add(e.mint);
    }

    // 2. Sync the position book with the authoritative account.
    for (const [mint, pos] of book) {
      if (!state.positions.has(mint)) {
        book.delete(mint);
        cooldownUntil.set(mint, slot + COOLDOWN_SLOTS);
      } else {
        pos.exitPending = false;
        for (const p of state.pending.values()) {
          if (p.order.mint === mint && p.order.side === 'sell') pos.exitPending = true;
        }
      }
    }
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      const pos = book.get(fill.mint);
      if (fill.side === 'buy') {
        const price = Number(fill.quote_lamports) / Number(fill.token_amount);
        if (pos === undefined) {
          book.set(fill.mint, {
            firstPrice: price,
            entrySlot: slot,
            peakValue: 0n,
            tranches: 1,
            exitPending: false,
          });
        } else {
          pos.tranches += 1;
        }
      }
    }

    // 3. Portfolio shell: equity, drawdown, entry halt.
    let equity = state.cash;
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve !== undefined) equity += liquidationValue(curve, holding.token_amount);
    }
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0n ? 1 - Number(equity) / Number(peakEquity) : 0;
    if (drawdown > DD_HARD) haltEntriesUntil = Math.max(haltEntriesUntil, slot + DD_HALT_SLOTS);
    const sizeScale = drawdown > DD_SOFT ? 0.5 : 1;

    // 4. Exits for everything held, decided off the freshest reserves.
    for (const [mint, holding] of state.positions) {
      const pos = book.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined || curve === undefined || curve.complete) continue;
      if (pos.exitPending) continue;
      const value = liquidationValue(curve, holding.token_amount);
      if (value > pos.peakValue) pos.peakValue = value;
      const cost = holding.cost_lamports;
      const heldFor = slot - pos.entrySlot;
      let exit = false;
      if (value >= (cost * BigInt(Math.round((1 + TAKE_PROFIT) * 1000))) / 1000n) exit = true;
      if (value <= (cost * BigInt(Math.round((1 - HARD_STOP) * 1000))) / 1000n) exit = true;
      if (heldFor >= MAX_HOLD_SLOTS) exit = true;
      if (
        pos.peakValue >= (cost * BigInt(Math.round((1 + TRAIL_ARM) * 1000))) / 1000n &&
        value <= (pos.peakValue * BigInt(Math.round((1 - TRAIL_GIVEBACK) * 1000))) / 1000n
      ) {
        exit = true;
      }
      if (exit && orders.length < caps.max_orders_per_batch) {
        orderSeq += 1;
        orders.push({
          side: 'sell',
          client_id: `x${orderSeq}`,
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        pos.exitPending = true;
        free += value; // approximate; the shell only needs the direction
      }
    }

    // 5. Ladder adds and fresh anchors, only on coins that traded this batch.
    const entriesOpen = slot > haltEntriesUntil;
    for (const mint of tradedHere) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const w = watch.get(mint);
      if (w === undefined || w.peakPrice <= 0) continue;
      const price = spotPrice(curve);
      if (price <= 0) continue;
      const cap = state.maxBuyLamports(mint);
      const holding = state.positions.get(mint);

      if (holding !== undefined) {
        // Ladder add: one extra tranche, stepped down, flow still absorbing.
        const pos = book.get(mint);
        if (pos === undefined || pos.tranches >= 2 || pos.exitPending) continue;
        if (price > pos.firstPrice * (1 - LADDER_STEP)) continue;
        if (!flowIsAbsorbing(w)) continue;
        const room = MAX_PER_COIN - holding.cost_lamports;
        if (room < MIN_STAKE) continue;
        let amount = ANCHOR_STAKE < room ? ANCHOR_STAKE : room;
        if (cap < amount) amount = cap;
        if (amount < MIN_STAKE || free - amount - txFee < CASH_FLOOR) continue;
        orderSeq += 1;
        orders.push({
          side: 'buy',
          client_id: `b${orderSeq}`,
          mint,
          quote_lamports: amount,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        free -= amount + txFee;
        continue;
      }

      // Fresh anchor.
      if (!entriesOpen || entries >= MAX_ENTRIES_PER_BATCH) continue;
      if (state.committedPositionCount() + entries >= caps.max_open_positions) continue;
      let buyPending = false;
      for (const p of state.pending.values()) {
        if (p.order.mint === mint && p.order.side === 'buy') buyPending = true;
      }
      if (buyPending) continue;
      const cool = cooldownUntil.get(mint);
      if (cool !== undefined && slot < cool) continue;
      if (curve.trades < MIN_TRADES_SEEN) continue;
      if (curve.real_quote_reserves < MIN_REAL_QUOTE) continue;
      const dip = 1 - price / w.peakPrice;
      if (dip < DIP_SHALLOW || dip > DIP_DEEP) continue;
      if (w.lowPrice <= 0 || price < w.lowPrice * (1 + BOUNCE_OFF_LOW)) continue;
      if (!flowIsAbsorbing(w)) continue;
      let amount = (ANCHOR_STAKE * BigInt(Math.round(sizeScale * 1000))) / 1000n;
      if (cap < amount) amount = cap;
      if (amount < MIN_STAKE) continue;
      if (free - amount - txFee < CASH_FLOOR) continue;
      orderSeq += 1;
      orders.push({
        side: 'buy',
        client_id: `b${orderSeq}`,
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + txFee;
      entries += 1;
    }

    return orders;
  },
});
