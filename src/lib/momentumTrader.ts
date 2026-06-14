/**
 * momentumTrader — auto-buy existing tokens that match a user's momentum settings.
 *
 * This is NOT launch-sniping. On a fixed interval it scans tracked pre-bonded tokens
 * and, for each user whose snipe_settings has momentumEnabled, buys tokens whose
 * price-change % (5m/1h/24h, from pumpPortalService.getMarketStats) and marketcap/age
 * meet the configured thresholds. Buys route through the proven PumpPortal path
 * (pumpPortalTradeService + pumpBuySizer) using the user's saved trading wallet.
 *
 * SAFETY: disabled unless momentumEnabled is true. Per-user: max concurrent positions,
 * per-token cooldown, and skip tokens already held. Buy amount/slippage come from
 * the user's settings. All errors are swallowed so the loop never crashes the server.
 */
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { prisma } from './prisma.js';
import { rpcManager } from './rpcManager.js';
import { secureWalletService } from './secureWalletService.js';
import { pumpPortalTradeService } from './pumpPortalTradeService.js';
import { sizePumpBuyToBudget } from './pumpBuySizer.js';
import { pumpPortalService, getSolPriceUsd } from './pumpPortalService.js';
import { PumpFunService } from './pumpfunService.js';

// Candidate feed for auto-buy: the live pump.fun Explore board (frontend-api-v3),
// the SAME source the rest of the app now uses — not the PumpPortal new-mint stream.
const pumpFunService = new PumpFunService();

const SCAN_INTERVAL_MS = 8000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// userId|mint -> last buy timestamp, for cooldown + in-flight de-dupe.
const recentBuys = new Map<string, number>();
let scanTimer: ReturnType<typeof setInterval> | null = null;
let scanning = false;

function key(userId: string, mint: string) { return `${userId}|${mint}`; }

// ── Centralized verified recorders (injected by server.ts at startup) ──
// When set, auto-buys/auto-sells record through recordBuyTrade/recordSellTrade
// (on-chain verification + real amounts) instead of blind status:'confirmed' inserts.
type TradeRecorders = {
  recordBuy?: (opts: any) => Promise<void>;
  recordSell?: (opts: any) => Promise<void>;
};
let tradeRecorders: TradeRecorders = {};
export function setTradeRecorders(r: TradeRecorders): void { tradeRecorders = r; }
export function getTradeRecorders(): TradeRecorders { return tradeRecorders; }

function onCooldown(userId: string, mint: string, cooldownSec: number): boolean {
  const t = recentBuys.get(key(userId, mint));
  return t != null && (Date.now() - t) < cooldownSec * 1000;
}

/** Execute a budget-sized PumpPortal buy (mirrors the working manual zap path).
 *  Exported (2026-06-12): the auto-snipe path in pumpPortalService reuses this
 *  instead of its old broken Jupiter flow. */
export async function executeBuy(
  conn: Connection,
  wallet: { id: string; publicKey: string },
  userId: string,
  mint: string,
  buyAmountSol: number,
  slippageBps: number,
): Promise<string> {
  const slipPct = Math.max(Math.round((slippageBps || 1000) / 100), 10);
  const result = await pumpPortalTradeService.buyToken({
    publicKey: wallet.publicKey, mint, solAmount: buyAmountSol, slippagePct: slipPct,
  });
  if (!result?.transaction) throw new Error('PumpPortal returned no transaction');

  await sizePumpBuyToBudget(conn, result.transaction, buyAmountSol, slipPct);

  const keypair = await secureWalletService.getKeypairForSigning(wallet.id, userId);
  const tx = result.transaction as VersionedTransaction;
  tx.sign([keypair]);

  // Advisory simulation: only hard-fail on genuine program errors.
  try {
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' });
    if (sim.value.err) {
      const e = JSON.stringify(sim.value.err);
      if (!/AccountNotFound|BlockhashNotFound|could not find account/i.test(e)) {
        throw new Error(`simulation failed: ${e}`);
      }
    }
  } catch (e: any) {
    if (e?.message?.startsWith('simulation failed')) throw e;
  }

  const raw = tx.serialize();
  const t0 = Date.now();
  let sig: string | null = null;
  let lastSent = 0;
  while (Date.now() - t0 < 30000) {
    if (Date.now() - lastSent >= 2000) {
      try { sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); lastSent = Date.now(); }
      catch (e: any) { if (String(e?.message).includes('Blockhash not found')) throw new Error('blockhash expired'); }
    }
    if (!sig) { await sleep(800); continue; }
    await sleep(1500);
    const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: false }).catch(() => null);
    const c = st?.value?.confirmationStatus;
    if (c === 'confirmed' || c === 'finalized') {
      if (st?.value?.err) throw new Error(`on-chain fail: ${JSON.stringify(st.value.err)}`);
      return sig;
    }
  }
  throw new Error('confirmation timeout');
}

async function resolveWallet(s: any): Promise<{ id: string; publicKey: string; walletName: string } | null> {
  const w = await prisma.managed_wallets.findFirst({
    where: { userId: s.userId, ...(s.walletId ? { id: s.walletId } : {}) },
    orderBy: s.walletId ? undefined : [{ isActive: 'desc' }, { createdAt: 'asc' }],
  }).catch(() => null);
  return w as any;
}

async function evalUser(s: any, candidates: any[], solPrice: number): Promise<void> {
  const wallet = await resolveWallet(s);
  if (!wallet) return;

  const maxPositions = s.momentumMaxPositions || 5;
  const openCount = await prisma.token_holdings.count({ where: { userId: s.userId } }).catch(() => 0);
  if (openCount >= maxPositions) return;
  let boughtThisScan = 0;

  for (const tk of candidates) {
    if (openCount + boughtThisScan >= maxPositions) break;
    const mint = tk.mint;
    if (!mint) continue;

    // Price-change thresholds need trade history (the PumpPortal stream). Only those
    // require stats; if none are configured we evaluate purely on the board record.
    const wantsChange =
      s.minChange5m != null || s.minChange1h != null || s.minChange24h != null ||
      s.maxChange5m != null || s.maxChange1h != null || s.maxChange24h != null;
    const stats = wantsChange ? pumpPortalService.getMarketStats(mint) : null;
    if (wantsChange && !stats) continue; // change filters set but no history → can't judge

    // Price-change thresholds (only those configured). Min = floor, Max = ceiling:
    // [min, max] together express a range — gains-only (min>0), avoid over-pumped
    // tops (max set), or deliberate dip-buys (both negative, e.g. min -60 max -20).
    if (stats) {
      if (s.minChange5m != null && (stats.priceChange5m == null || stats.priceChange5m < s.minChange5m)) continue;
      if (s.minChange1h != null && (stats.priceChange1h == null || stats.priceChange1h < s.minChange1h)) continue;
      if (s.minChange24h != null && (stats.priceChange24h == null || stats.priceChange24h < s.minChange24h)) continue;
      if (s.maxChange5m != null && (stats.priceChange5m == null || stats.priceChange5m > s.maxChange5m)) continue;
      if (s.maxChange1h != null && (stats.priceChange1h == null || stats.priceChange1h > s.maxChange1h)) continue;
      if (s.maxChange24h != null && (stats.priceChange24h == null || stats.priceChange24h > s.maxChange24h)) continue;
    }

    // Market cap (USD): prefer the board's own figure, fall back to stream stats.
    const mcUsd = (typeof tk.usd_market_cap === 'number' && tk.usd_market_cap > 0)
      ? tk.usd_market_cap
      : (stats ? stats.currentMarketCapSol * (solPrice || 0) : 0);
    if (s.minMarketCapUsd && mcUsd < s.minMarketCapUsd) continue;
    if (s.maxMarketCapUsd && mcUsd > s.maxMarketCapUsd) continue;

    // Age — the board record carries created_timestamp (ms epoch).
    const createdMs = tk.created_timestamp || tk.timestamp || Date.now();
    const ageSec = (Date.now() - createdMs) / 1000;
    if (s.minTokenAgeSec && ageSec < s.minTokenAgeSec) continue;
    if (s.maxTokenAgeSec && ageSec > s.maxTokenAgeSec) continue;

    // Socials (required ones must be present)
    if (s.requireTwitter && !tk.twitter) continue;
    if (s.requireTelegram && !tk.telegram) continue;
    if (s.requireWebsite && !tk.website) continue;

    // De-dupe: cooldown + already held
    if (onCooldown(s.userId, mint, s.momentumCooldownSec || 300)) continue;
    const held = await prisma.token_holdings.findUnique({
      where: { userId_tokenAddress: { userId: s.userId, tokenAddress: mint } },
    }).catch(() => null);
    if (held) continue;

    // Price for sizing/recording: prefer the board's price, fall back to stream stats.
    const priceSol = (typeof tk.price_sol === 'number' && tk.price_sol > 0)
      ? tk.price_sol
      : (stats && stats.currentMarketCapSol > 0 ? stats.currentMarketCapSol / 1e9 : 0);

    // Mark immediately to avoid double-buy across overlapping scans, then buy.
    recentBuys.set(key(s.userId, mint), Date.now());
    try {
      const conn = new Connection(rpcManager.getUrl(), 'confirmed');
      const sig = await executeBuy(conn, wallet, s.userId, mint, s.buyAmountSol, s.slippageBps);
      boughtThisScan++;
      console.log(`🤖✅ Momentum buy ${tk.symbol || mint.slice(0, 8)} for user ${s.userId.slice(0, 8)} — ${sig.slice(0, 16)}…`);
      await recordBuy(s, tk, mint, sig, priceSol, wallet);
    } catch (e: any) {
      console.log(`🤖❌ Momentum buy failed ${mint.slice(0, 8)}: ${e?.message}`);
    }
  }
}

async function recordBuy(s: any, tk: any, mint: string, sig: string, priceSol: number, wallet?: { id: string; publicKey: string }): Promise<void> {
  try {
    await prisma.snipe_executions.create({
      data: {
        userId: s.userId, settingsId: s.id, tokenAddress: mint,
        tokenName: tk.name || null, tokenSymbol: tk.symbol || null, dex: 'pumpfun',
        buyAmountSol: s.buyAmountSol, txSignature: sig,
        status: 'success', detectedAt: new Date(), executedAt: new Date(),
      },
    });
  } catch { /* non-fatal */ }
  try {
    await prisma.token_holdings.upsert({
      where: { userId_tokenAddress: { userId: s.userId, tokenAddress: mint } },
      create: {
        userId: s.userId, tokenAddress: mint, tokenName: tk.name || null, tokenSymbol: tk.symbol || null,
        amount: 0, averageBuyPrice: priceSol, totalCostSol: s.buyAmountSol, dex: 'pumpfun', isPreBonded: true,
      },
      update: { totalCostSol: { increment: s.buyAmountSol }, lastUpdatedAt: new Date() },
    });
  } catch { /* non-fatal */ }
  // Record to transactions so the auto-buy shows on the Transactions page.
  // Prefer the injected verified recorder (on-chain check + real amounts).
  if (tradeRecorders.recordBuy && wallet) {
    void tradeRecorders.recordBuy({
      userId: s.userId, walletId: wallet.id, walletPubkey: wallet.publicKey, signature: sig,
      tokenMint: mint, tokenName: tk.name || null, tokenSymbol: tk.symbol || null,
      tokensEstimate: priceSol > 0 ? s.buyAmountSol / priceSol : 0,
      dexLabel: 'PUMPFUN', fallbackSolSpent: s.buyAmountSol,
    });
    return;
  }
  try {
    await prisma.transactions.create({
      data: {
        userId: s.userId, txId: sig, tokenName: tk.name || 'Unknown', tokenSymbol: tk.symbol || null,
        tokenAddress: mint, type: 'buy', amount: priceSol > 0 ? s.buyAmountSol / priceSol : 0,
        price: priceSol, profit: -s.buyAmountSol, status: 'confirmed', dex: 'PUMPFUN',
        totalSolCost: s.buyAmountSol, timestamp: new Date(),
      },
    });
  } catch { /* non-fatal */ }
}

async function scanOnce(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    // Gate on BOTH momentumEnabled AND isActive. isActive is what the Start/Stop
    // Sniper toggle sets — without it, momentum kept buying while the sniper showed
    // "off" (it was only gated by momentumEnabled). The toggle is now the master switch.
    const settingsList = await prisma.snipe_settings.findMany({ where: { momentumEnabled: true, isActive: true } }).catch(() => []);
    if (!settingsList.length) return;
    const solPrice = getSolPriceUsd();
    // Pull candidates from the pump.fun Explore board (frontend-api-v3) instead of
    // the new-mint websocket stream, so auto-buy considers the same tokens the rest
    // of the app shows. Per-user thresholds are applied in evalUser.
    const candidates = await pumpFunService.getPumpFunTokens({ limit: 100 }).catch(() => []);
    for (const s of settingsList) {
      await evalUser(s, candidates, solPrice).catch((e) => console.error('[momentum] evalUser error', e?.message));
    }
  } finally {
    scanning = false;
  }
}

export function startMomentumTrader(): void {
  if (scanTimer) return;
  scanTimer = setInterval(() => { scanOnce().catch((e) => console.error('[momentum] scan error', e?.message)); }, SCAN_INTERVAL_MS);
  console.log('🤖 Momentum trader started (scans every ' + SCAN_INTERVAL_MS / 1000 + 's; acts only when momentumEnabled AND sniper isActive)');
}

export function stopMomentumTrader(): void {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}

// ─────────────────────────── AUTO-SELL ───────────────────────────
// Monitors open positions for users with autoSellEnabled and sells 100% when
// take-profit / stop-loss / trailing-stop / max-hold triggers fire. Price comes
// from the same bonding-curve market-cap tracking used for buys.

const peakPrice = new Map<string, number>();   // userId|mint -> highest price seen since entry
const sellInFlight = new Set<string>();        // userId|mint currently selling
let sellTimer: ReturnType<typeof setInterval> | null = null;
let selling = false;

/** Sell 100% of a holding via PumpPortal (mirrors the working manual sell path). */
async function executeSell(
  conn: Connection,
  wallet: { id: string; publicKey: string },
  userId: string,
  mint: string,
  slippageBps: number,
): Promise<string> {
  const slipPct = Math.max(Math.round((slippageBps || 1000) / 100), 10);
  const result = await pumpPortalTradeService.sellToken({
    publicKey: wallet.publicKey, mint, amount: '100%', slippagePct: slipPct,
  });
  if (!result?.transaction) throw new Error('PumpPortal returned no sell transaction');

  const keypair = await secureWalletService.getKeypairForSigning(wallet.id, userId);
  const tx = result.transaction as VersionedTransaction;
  tx.sign([keypair]);

  const raw = tx.serialize();
  const t0 = Date.now();
  let sig: string | null = null;
  let lastSent = 0;
  while (Date.now() - t0 < 30000) {
    if (Date.now() - lastSent >= 2000) {
      try { sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); lastSent = Date.now(); }
      catch (e: any) { if (String(e?.message).includes('Blockhash not found')) throw new Error('blockhash expired'); }
    }
    if (!sig) { await sleep(800); continue; }
    await sleep(1500);
    const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: false }).catch(() => null);
    const c = st?.value?.confirmationStatus;
    if (c === 'confirmed' || c === 'finalized') {
      if (st?.value?.err) throw new Error(`on-chain fail: ${JSON.stringify(st.value.err)}`);
      return sig;
    }
  }
  throw new Error('confirmation timeout');
}

function sellReason(s: any, entry: number, current: number, peak: number, ageSec: number): string | null {
  const pnlPct = entry > 0 ? ((current - entry) / entry) * 100 : 0;
  if (s.takeProfitPercent != null && pnlPct >= s.takeProfitPercent) return `take-profit (+${pnlPct.toFixed(1)}%)`;
  if (s.stopLossPercent != null && pnlPct <= -Math.abs(s.stopLossPercent)) return `stop-loss (${pnlPct.toFixed(1)}%)`;
  if (s.trailingStopPercent != null && peak > 0 && current <= peak * (1 - s.trailingStopPercent / 100)) {
    return `trailing-stop (${(((current - peak) / peak) * 100).toFixed(1)}% from peak)`;
  }
  if (s.maxHoldSec != null && ageSec >= s.maxHoldSec) return `max-hold (${Math.round(ageSec)}s)`;
  return null;
}

async function evalUserSells(s: any): Promise<void> {
  const wallet = await resolveWallet(s);
  if (!wallet) return;
  const holdings = await prisma.token_holdings.findMany({ where: { userId: s.userId } }).catch(() => []);
  for (const h of holdings) {
    const mint = h.tokenAddress;
    const k = key(s.userId, mint);
    if (sellInFlight.has(k)) continue;

    const ageSec = (Date.now() - new Date(h.firstBuyAt as any).getTime()) / 1000;
    const stats = pumpPortalService.getMarketStats(mint);

    let reason: string | null = null;
    let current = 0;
    let entry = 0;
    if (stats && stats.currentMarketCapSol > 0) {
      current = stats.currentMarketCapSol / 1e9; // price per token (1B supply)
      entry = h.averageBuyPrice || current;
      // Track running peak for trailing stop
      const prevPeak = peakPrice.get(k) ?? entry;
      const peak = Math.max(prevPeak, current);
      peakPrice.set(k, peak);
      reason = sellReason(s, entry, current, peak, ageSec);
    } else if (s.maxHoldSec != null && ageSec >= s.maxHoldSec) {
      // FIX (2026-06-12): positions with NO live price data (no trades since the
      // buy, or in-memory price history lost to a server restart) were skipped
      // entirely — so max-hold never fired and dead tokens stranded in the wallet
      // for 26+ minutes against a 60s timer. The timer needs no price: sell.
      reason = `max-hold (${Math.round(ageSec)}s, no live price data)`;
    }
    if (!reason) continue;

    sellInFlight.add(k);
    try {
      const conn = new Connection(rpcManager.getUrl(), 'confirmed');
      const sig = await executeSell(conn, wallet, s.userId, mint, s.slippageBps);
      console.log(`🤖💰 Auto-sell ${h.tokenSymbol || mint.slice(0, 8)} — ${reason} — ${sig.slice(0, 16)}…`);
      await prisma.snipe_executions.create({
        data: {
          userId: s.userId, settingsId: s.id, tokenAddress: mint,
          tokenName: h.tokenName, tokenSymbol: h.tokenSymbol, dex: 'pumpfun',
          buyAmountSol: 0, txSignature: sig, status: 'success',
          failureReason: `SELL: ${reason}`, detectedAt: new Date(), executedAt: new Date(),
        },
      }).catch(() => { });
      // Record to transactions so the auto-sell shows on the Transactions page.
      // Prefer the injected verified recorder (on-chain check + real SOL received).
      const pnlSol = entry > 0 ? (current - entry) / entry * (h.totalCostSol || 0) : 0;
      if (tradeRecorders.recordSell) {
        void tradeRecorders.recordSell({
          userId: s.userId, walletId: wallet.id, walletPubkey: wallet.publicKey, signature: sig,
          tokenMint: mint, tokenName: h.tokenName || null, tokenSymbol: h.tokenSymbol || null,
          tokensSold: h.amount || 0, dexLabel: 'PUMPFUN', fallbackSolReceived: Math.max(pnlSol, 0),
        });
      } else {
        await prisma.transactions.create({
          data: {
            userId: s.userId, txId: sig, tokenName: h.tokenName || 'Unknown', tokenSymbol: h.tokenSymbol || null,
            tokenAddress: mint, type: 'sell', amount: h.amount || 0, price: current,
            profit: pnlSol, status: 'confirmed', dex: 'PUMPFUN', timestamp: new Date(),
          },
        }).catch(() => { });
      }
      await prisma.token_holdings.delete({
        where: { userId_tokenAddress: { userId: s.userId, tokenAddress: mint } },
      }).catch(() => { });
      peakPrice.delete(k);
    } catch (e: any) {
      console.log(`🤖❌ Auto-sell failed ${mint.slice(0, 8)}: ${e?.message}`);
    } finally {
      sellInFlight.delete(k);
    }
  }
}

async function scanSells(): Promise<void> {
  if (selling) return;
  selling = true;
  try {
    const settingsList = await prisma.snipe_settings.findMany({ where: { autoSellEnabled: true } }).catch(() => []);
    for (const s of settingsList) {
      await evalUserSells(s).catch((e) => console.error('[autosell] evalUser error', e?.message));
    }
  } finally {
    selling = false;
  }
}

export function startAutoSeller(): void {
  if (sellTimer) return;
  sellTimer = setInterval(() => { scanSells().catch((e) => console.error('[autosell] scan error', e?.message)); }, SCAN_INTERVAL_MS);
  console.log('🤖 Auto-seller started (scans every ' + SCAN_INTERVAL_MS / 1000 + 's; acts only when autoSellEnabled)');
}

export function stopAutoSeller(): void {
  if (sellTimer) { clearInterval(sellTimer); sellTimer = null; }
}
