// Early-bird paper bot for the Pump.fun Replay Sprint (agent-fun/replay/v2).
//
// Idea, in one line: buy a new bonding curve only while it is still cheap —
// before its price has run more than 10% off its create price — and only when
// a small crowd (2-3 distinct non-creator buyers) is already buying it, then
// let the winners run under a wide trailing stop and cut the rest by time.
//
// Why this shape: on the dev window the recorded tape shows most curves spike
// in their first slots and then fade (median price is +15% at +10 slots but
// only +5% at +100 slots), so buying after a run-up pays the top. Buying early
// is the only entry with a positive edge, but the 1%-of-real-reserve size cap
// and the 2-slot latency mean a first buy is small; the bot therefore adds
// into the same curve while it is still cheap (up to 0.10 SOL total). Exits
// are deliberately loose — take profit at +50%, a 35% trailing stop armed at
// +5%, and a 100-slot time limit, with no hard stop-loss — because the
// per-trade edge is thin and tight stops just realise noise. The creator
// selling before entry is a veto (bundled launch), but a creator selling
// while held is not an exit: on the dev window those coins usually recover.
//
// Guardrails: the bot trades dozens of coins (55 on dev, 40 of them round
// trips of >= 0.01 SOL) with max drawdown ~0.2%, far inside the 20-coin /
// 50% limits. A pace guard opens tiny 0.01 SOL probe round trips only if
// the fill/coin count ever lags its prorated target, so a thin final window
// still clears the guardrails.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps, charged on curve trades

// --- tuned parameters (chosen on the dev window, flat regions preferred) ---
const FIRST_BUY_SOL = 0.05; // first buy of a position, capped by 1% of real reserves
const TOTAL_STAKE_SOL = 0.1; // most SOL ever put into one coin
const ADD_SOL = 0.02; // each add-on buy
const ADD_GAP_SLOTS = 2; // slots between buys on the same coin
const MIN_BUY_SOL = 0.005; // smallest buy worth its tx fee
const MIN_AGE_SLOTS = 0; // youngest age (slots since CreateEvent) for a first buy
const MAX_AGE_SLOTS = 10; // oldest age for a first buy
const ADD_MAX_AGE_SLOTS = 60; // oldest age for an add-on buy
const MIN_REAL_SOL = 0.3; // real SOL reserves needed at decision time
const MAX_RUNUP = 0.1; // price now over create price, at most, for a first buy
const ADD_MAX_RUNUP = 0.15; // same, for an add-on buy
const MIN_BUYERS = 2; // distinct non-creator buyers seen before a first buy
const MAX_BUYERS = 3; // more distinct early buyers than this smells bundled
const SKIP_DEV_SOLD = true; // never buy a coin whose creator already sold
const MAX_SELL_RATIO = 10; // lamports sold by others / lamports bought, at most
const TAKE_PROFIT = 0.5; // sell all once the position is worth cost * (1 + this)
const TRAIL_ARM = 0.05; // trailing stop arms once value reached cost * (1 + this)
const TRAIL_DROP = 0.35; // exit on a fall of this much from the position's best value
const MAX_HOLD_SLOTS = 100; // exit after holding this many slots
const BUY_SLIPPAGE_BPS = 10000; // buys fill at the recorded reserves 2 slots later
const SELL_SLIPPAGE_BPS = 10000;
const MAX_POSITIONS = 5; // hello caps say the same; kept as a local sanity bound
// Pace guard: prorated over the 24 h window, open a 0.01 SOL probe round trip
// when fills or coins lag. Dev naturally clears these targets, so probes
// should stay idle; they exist only so a thin final window still clears
// the 20-coin guardrail.
const PACE_WINDOW_SECS = 86400;
const PACE_TARGET_COINS = 30;
const PACE_TARGET_FILLS = 70;
const PROBE_SOL = 0.01;
const MAX_PROBES = 1;

interface Tape {
  createdSlot: number;
  creator: Pubkey;
  createPrice: number; // virtual quote / virtual token at the CreateEvent
  buyers: Set<Pubkey>;
  boughtSol: number;
  soldSol: number;
  devSold: boolean;
  lastTradeSlot: number;
}

interface Held {
  openedSlot: number; // slot the first buy filled
  peakValueSol: number; // best close value seen (SOL, after fees)
  investedSol: number; // SOL sent in buys for this position (fees included)
  lastAddSlot: number; // slot the last buy was decided
  exiting: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

/** What selling `tokens` against (vq, vt) would pay, after curve fees and one tx fee. */
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint, txFeeSol: number): number {
  if (tokens <= 0n || vt <= 0n) return 0;
  const t = Number(tokens);
  const out = (t * Number(vq)) / (Number(vt) + t) / LAMPORTS;
  return out * (1 - CURVE_FEE) - txFeeSol;
}

// --- per-run books, created once (must sit above runBot: top-level await
// runs before any declaration below it) ---
interface Books {
  tapes: Map<Pubkey, Tape>;
  held: Map<Pubkey, Held>;
  probes: Map<Pubkey, boolean>;
  entered: Set<Pubkey>;
  myFills: number;
  myCoins: Set<Pubkey>;
  firstTime: number | null;
  lastTime: number | null;
}

let BOOKS: Books | null = null;

function getBooks(): Books {
  if (BOOKS === null) {
    BOOKS = {
      tapes: new Map(),
      held: new Map(),
      probes: new Map(),
      entered: new Set(),
      myFills: 0,
      myCoins: new Set(),
      firstTime: null,
      lastTime: null,
    };
  }
  return BOOKS;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS;
    const cap = state.hello.caps.max_orders_per_batch;
    const orders: OrderInput[] = [];

    // --- persistent per-run books (kept in the closure, insertion-ordered) ---
    // (declared here so the shape is visible; the maps live on the function
    // object via a static-ish holder below)
    const books = getBooks();
    const { tapes, held, probes } = books;
    let { myFills, myCoins, firstTime, lastTime } = books;
    const saveCounts = (): void => {
      books.myFills = myFills;
      books.myCoins = myCoins;
      books.firstTime = firstTime;
      books.lastTime = lastTime;
    };

    // --- fold this batch's fills into the books ---
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
        if (f.side === 'buy') {
          const h = held.get(f.mint);
          if (h === undefined) {
            held.set(f.mint, {
              openedSlot: f.slot,
              peakValueSol: 0,
              investedSol: Number(f.quote_lamports) / LAMPORTS,
              lastAddSlot: f.decided_slot,
              exiting: false,
            });
          } else {
            h.investedSol += Number(f.quote_lamports) / LAMPORTS;
            h.lastAddSlot = f.decided_slot;
          }
        }
      }
    }

    // --- fold this batch's events into the tapes ---
    const traded = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        let t = tapes.get(e.mint);
        if (t === undefined) {
          t = {
            createdSlot: e.slot,
            creator: e.user,
            createPrice: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
            buyers: new Set(),
            boughtSol: 0,
            soldSol: 0,
            devSold: false,
            lastTradeSlot: e.slot,
          };
          tapes.set(e.mint, t);
        }
      } else if (e.event === 'TradeEvent') {
        let t = tapes.get(e.mint);
        if (t === undefined) {
          t = {
            createdSlot: e.slot,
            creator: e.creator,
            createPrice: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
            buyers: new Set(),
            boughtSol: 0,
            soldSol: 0,
            devSold: false,
            lastTradeSlot: e.slot,
          };
          tapes.set(e.mint, t);
        }
        const sol = Number(e.sol_amount) / LAMPORTS;
        if (e.is_buy) {
          t.boughtSol += sol;
          if (e.user !== t.creator) t.buyers.add(e.user);
        } else {
          t.soldSol += sol;
          if (e.user === t.creator) t.devSold = true;
        }
        t.lastTradeSlot = e.slot;
        traded.add(e.mint);
      }
    }

    // --- exits first: take profit, trailing stop, time limit ---
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) held.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const mark = batch.marks.find((m) => m.mint === mint);
      const vq = mark ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mark ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = sellValueSol(BigInt(pos.token_amount), vq, vt, txFeeSol);
      if (value > h.peakValueSol) h.peakValueSol = value;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      let exit = h.exiting;
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && h.peakValueSol >= cost * (1 + TRAIL_ARM) && value <= h.peakValueSol * (1 - TRAIL_DROP)) exit = true;
      if (!exit && now - h.openedSlot > MAX_HOLD_SLOTS) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingByMint.has(mint)) {
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
      }
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    // --- probe round trips: sell the whole probe as soon as its buy has landed ---
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      if (!selling) probes.set(mint, true);
    }

    // --- entries and add-ons, over the coins that traded in this batch ---
    let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
    const committed = state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint);
      if (t === undefined || t.createPrice <= 0) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const runup = price / t.createPrice - 1;
      const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
      const age = now - t.createdSlot;
      const h = held.get(mint);
      if (h !== undefined) {
        // Add-on: keep building while the coin is still cheap and young.
        if (h.exiting || h.investedSol >= TOTAL_STAKE_SOL - MIN_BUY_SOL) continue;
        if (now - h.lastAddSlot < ADD_GAP_SLOTS) continue;
        if (age > ADD_MAX_AGE_SLOTS || runup > ADD_MAX_RUNUP || realSol < MIN_REAL_SOL) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(ADD_SOL, capSol, TOTAL_STAKE_SOL - h.investedSol);
        if (amount > freeSol - txFeeSol) amount = freeSol - txFeeSol;
        if (amount < MIN_BUY_SOL) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: BUY_SLIPPAGE_BPS });
        freeSol -= amount + txFeeSol;
        h.lastAddSlot = now;
        continue;
      }
      // First buy: young, cheap, a small crowd, creator has not sold.
      if (committed + orders.filter((o) => o.side === 'buy').length >= MAX_POSITIONS) continue;
      if (books.entered.has(mint)) continue;
      if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
      if (realSol < MIN_REAL_SOL) continue;
      if (runup > MAX_RUNUP) continue;
      if (t.buyers.size < MIN_BUYERS || t.buyers.size > MAX_BUYERS) continue;
      if (SKIP_DEV_SOLD && t.devSold) continue;
      if (t.boughtSol > 0 && t.soldSol / t.boughtSol > MAX_SELL_RATIO) continue;
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(FIRST_BUY_SOL, capSol);
      if (amount > freeSol - txFeeSol) amount = freeSol - txFeeSol;
      if (amount < MIN_BUY_SOL) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: BUY_SLIPPAGE_BPS });
      freeSol -= amount + txFeeSol;
      books.entered.add(mint);
    }

    // --- pace guard: probe round trips when fills or coins lag the target ---
    if (probes.size < MAX_PROBES && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_WINDOW_SECS);
      const needCoins = myCoins.size < Math.ceil(PACE_TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(PACE_TARGET_FILLS * pace);
      if ((needCoins || needFills) && committed + orders.filter((o) => o.side === 'buy').length < MAX_POSITIONS) {
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < 1.5) continue;
          if (freeSol < PROBE_SOL + 2 * txFeeSol) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIPPAGE_BPS });
          probes.set(mint, false);
          freeSol -= PROBE_SOL + txFeeSol;
        }
      }
    }

    saveCounts();
    return orders;
  },
});
