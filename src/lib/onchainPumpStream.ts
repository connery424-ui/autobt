/**
 * onchainPumpStream — real-time pre-bonded pump.fun feed, read directly from chain.
 *
 * Subscribes ONCE to the pump.fun bonding-curve program over a Helius WebSocket
 * and decodes both `CreateEvent` (new mint) and `TradeEvent` (every buy/sell)
 * straight out of the log payload. From the trade stream it maintains, in memory:
 *   - current price / market cap / liquidity (from each trade's virtual reserves)
 *   - rolling volume + price-change windows
 *
 * No per-token RPC calls — everything is derived from the one subscription, so it
 * doesn't burn the Helius req/s budget. New tokens are seen at block time (~0s),
 * vs PumpPortal (relayed) and the v3 API (~6 min stale).
 *
 * Exposes a getLiveFeed() shaped like pumpPortalService so it slots into
 * buildSniperFeed as a primary source.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// pump.fun bonding-curve constants (mainnet defaults)
const TOKEN_DECIMALS = 6;
const SOL_DECIMALS = 9;
const DEFAULT_VIRTUAL_TOKEN = 1_073_000_000_000_000n; // 1.073B * 1e6
const DEFAULT_VIRTUAL_SOL = 30_000_000_000n;          // 30 SOL in lamports
const DEFAULT_TOTAL_SUPPLY = 1_000_000_000;           // 1B tokens
const GRADUATION_SOL = 85;                            // ~85 SOL real reserves to bond

// Anchor event discriminators = sha256("event:<Name>")[..8]
const DISC_CREATE = createHash('sha256').update('event:CreateEvent').digest().subarray(0, 8);
const DISC_TRADE = createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8);

// ── retention / memory bounds ──
const MAX_TOKENS = 3000;          // hard cap on tracked tokens
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // drop tokens untouched for 2h
const TRADE_WINDOW_MS = 60 * 60 * 1000;  // keep 1h of trades per token for windows

interface Trade { t: number; sol: number; buy: boolean; }

interface TokenState {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string | null;
  createdMs: number;
  lastSeenMs: number;
  vSol: bigint;          // virtual SOL reserves (lamports)
  vToken: bigint;        // virtual token reserves (base units)
  realSol: number;       // real SOL reserves (SOL)
  totalSupply: number;
  priceSol: number;      // SOL per token
  trades: Trade[];
  priceSamples: { t: number; p: number }[]; // for change% windows
  cumVolSol: number;     // cumulative SOL volume since first seen
  socials?: { twitter: string | null; telegram: string | null; website: string | null } | null;
  socialsFetched?: boolean;
}

class Reader {
  b: Buffer; o = 0;
  constructor(b: Buffer) { this.b = b; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  bool() { const v = this.b[this.o] !== 0; this.o += 1; return v; }
  str() { const n = this.u32(); const s = this.b.subarray(this.o, this.o + n).toString('utf8'); this.o += n; return s; }
  pk() { const s = new PublicKey(this.b.subarray(this.o, this.o + 32)).toBase58(); this.o += 32; return s; }
  left() { return this.b.length - this.o; }
}

function priceFromReserves(vSol: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  const sol = Number(vSol) / 10 ** SOL_DECIMALS;
  const tok = Number(vToken) / 10 ** TOKEN_DECIMALS;
  return tok > 0 ? sol / tok : 0;
}

class OnchainPumpStream {
  private conn: any = null;
  private tokens = new Map<string, TokenState>();
  private solPriceUsd = 0;
  private started = false;
  private stats = { creates: 0, trades: 0, startedAt: 0 };

  /** Start the subscription. No-op if already running or no RPC configured. */
  start() {
    if (this.started) return;
    const key = process.env.HELIUS_API_KEY || process.env.VITE_HELIUS_API_KEY;
    const explicitWs = process.env.SOLANA_WS_ENDPOINT;
    const explicitHttp = process.env.SOLANA_RPC_ENDPOINT || process.env.SOLANA_NODE_RPC_ENDPOINT;
    const http = explicitHttp || (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null);
    const ws = explicitWs || (key ? `wss://mainnet.helius-rpc.com/?api-key=${key}` : null);
    if (!http || !ws) {
      console.warn('[onchain] no Helius/RPC endpoint configured — on-chain pump stream disabled');
      return;
    }
    this.started = true;
    this.stats.startedAt = Date.now();
    try {
      this.conn = new Connection(http, { wsEndpoint: ws, commitment: 'processed' });
      this.conn.onLogs(PUMP_PROGRAM, (info: any) => {
        const { logs, err } = info || {};
        if (err || !logs) return;
        for (const l of logs) {
          if (l.startsWith('Program data:')) this.handleProgramData(l.slice(13).trim());
        }
      }, 'processed');
      console.log('🛰️  [onchain] subscribed to pump.fun program logs (Create + Trade)');
    } catch (e: any) {
      console.error('[onchain] failed to subscribe:', e?.message);
      this.started = false;
    }
    setInterval(() => this.prune(), 60_000).unref?.();
  }

  setSolPrice(usd: number) { if (usd > 0) this.solPriceUsd = usd; }

  private handleProgramData(b64: string) {
    let buf: Buffer;
    try { buf = Buffer.from(b64, 'base64'); } catch { return; }
    if (buf.length < 8) return;
    const disc = buf.subarray(0, 8);
    if (disc.equals(DISC_CREATE)) this.onCreate(buf.subarray(8));
    else if (disc.equals(DISC_TRADE)) this.onTrade(buf.subarray(8));
  }

  private onCreate(body: Buffer) {
    try {
      const r = new Reader(body);
      const name = r.str();
      const symbol = r.str();
      const uri = r.str();
      const mint = r.pk();
      r.pk(); // bondingCurve
      r.pk(); // user
      let creator: string | null = null;
      let vToken = DEFAULT_VIRTUAL_TOKEN;
      let vSol = DEFAULT_VIRTUAL_SOL;
      let totalSupply = DEFAULT_TOTAL_SUPPLY;
      if (r.left() >= 32) { try { creator = r.pk(); } catch {} }
      if (r.left() >= 8) { try { r.i64(); } catch {} } // timestamp
      // newer event versions append reserves + supply
      if (r.left() >= 8) { try { vToken = r.u64(); } catch {} }
      if (r.left() >= 8) { try { vSol = r.u64(); } catch {} }
      if (r.left() >= 8) { try { r.u64(); } catch {} } // real token reserves
      if (r.left() >= 8) { try { totalSupply = Number(r.u64()) / 10 ** TOKEN_DECIMALS; } catch {} }

      const now = Date.now();
      const st: TokenState = {
        mint, name, symbol, uri, creator,
        createdMs: now, lastSeenMs: now,
        vSol, vToken, realSol: 0,
        totalSupply: totalSupply || DEFAULT_TOTAL_SUPPLY,
        priceSol: priceFromReserves(vSol, vToken),
        trades: [],
        priceSamples: [{ t: now, p: priceFromReserves(vSol, vToken) }], // launch baseline
        cumVolSol: 0,
        socials: null, socialsFetched: false,
      };
      this.tokens.set(mint, st);
      this.stats.creates++;
      if (this.tokens.size > MAX_TOKENS) this.prune(true);
    } catch { /* ignore malformed */ }
  }

  private onTrade(body: Buffer) {
    try {
      const r = new Reader(body);
      const mint = r.pk();
      const solAmount = Number(r.u64()) / 10 ** SOL_DECIMALS;
      r.u64(); // tokenAmount
      const isBuy = r.bool();
      r.pk();  // user
      const ts = Number(r.i64()) * 1000 || Date.now();
      const vSol = r.u64();
      const vToken = r.u64();
      let realSol = 0;
      if (r.left() >= 8) { try { realSol = Number(r.u64()) / 10 ** SOL_DECIMALS; } catch {} }

      const st = this.tokens.get(mint);
      if (!st) return; // only track tokens we saw created (pre-bonded)
      st.vSol = vSol;
      st.vToken = vToken;
      st.realSol = realSol || st.realSol;
      st.priceSol = priceFromReserves(vSol, vToken);
      st.lastSeenMs = Date.now();
      st.trades.push({ t: ts, sol: solAmount, buy: isBuy });
      st.priceSamples.push({ t: Date.now(), p: st.priceSol });
      st.cumVolSol += solAmount;
      this.stats.trades++;
      // prune this token's windows
      const cutoff = Date.now() - TRADE_WINDOW_MS;
      if (st.trades.length > 256) st.trades = st.trades.filter((x) => x.t >= cutoff);
      if (st.priceSamples.length > 600) st.priceSamples = st.priceSamples.slice(-600);
    } catch { /* ignore malformed */ }
  }

  // % price change over a window; falls back to since-launch for young tokens.
  private changePct(st: TokenState, ms: number): number | null {
    if (st.priceSol <= 0 || !st.priceSamples.length) return null;
    const cutoff = Date.now() - ms;
    let base: { t: number; p: number } | null = null;
    for (const s of st.priceSamples) { if (s.t >= cutoff) { base = s; break; } }
    if (!base) base = st.priceSamples[0]; // older than window → since first sample
    if (!base || base.p <= 0) return null;
    return ((st.priceSol - base.p) / base.p) * 100;
  }

  /** Live market stats for one mint (used by the feed enrichment path). */
  getMarketStats(mint: string): { price: number; priceChange5m: number | null; priceChange1h: number | null; priceChange24h: number | null; volume24h: number } | null {
    const st = this.tokens.get(mint);
    if (!st) return null;
    const sol = this.solPriceUsd;
    return {
      price: st.priceSol,
      priceChange5m: this.changePct(st, 5 * 60_000),
      priceChange1h: this.changePct(st, 60 * 60_000),
      priceChange24h: this.changePct(st, 24 * 60 * 60_000),
      volume24h: sol ? st.cumVolSol * sol : st.cumVolSol,
    };
  }

  private volumeSince(st: TokenState, ms: number): number {
    const cutoff = Date.now() - ms;
    let v = 0;
    for (let i = st.trades.length - 1; i >= 0; i--) {
      if (st.trades[i].t < cutoff) break;
      v += st.trades[i].sol;
    }
    return v;
  }

  private prune(force = false) {
    const now = Date.now();
    for (const [mint, st] of this.tokens) {
      if (now - st.lastSeenMs > TOKEN_TTL_MS) this.tokens.delete(mint);
    }
    if (force && this.tokens.size > MAX_TOKENS) {
      // drop oldest by lastSeen
      const sorted = [...this.tokens.values()].sort((a, b) => a.lastSeenMs - b.lastSeenMs);
      for (let i = 0; i < sorted.length - MAX_TOKENS; i++) this.tokens.delete(sorted[i].mint);
    }
  }

  getStats() {
    const secs = Math.max(1, (Date.now() - this.stats.startedAt) / 1000);
    return {
      tracked: this.tokens.size,
      creates: this.stats.creates,
      trades: this.stats.trades,
      createsPerSec: +(this.stats.creates / secs).toFixed(2),
      running: this.started,
    };
  }

  /** Feed shaped to match what buildSniperFeed's transform expects. Newest first. */
  getLiveFeed(limit = 200): any[] {
    const sol = this.solPriceUsd;
    const arr = [...this.tokens.values()]
      .sort((a, b) => b.createdMs - a.createdMs)
      .slice(0, limit);
    return arr.map((st) => {
      const liqSol = Number(st.vSol) / 10 ** SOL_DECIMALS;
      const mcSol = st.priceSol * st.totalSupply;
      const vol5mSol = this.volumeSince(st, 5 * 60_000);
      return {
        mint: st.mint,
        name: st.name,
        symbol: st.symbol,
        source: 'pumpfun',
        // liquidity — provide both conventions used by the transform
        vSolInBondingCurve: liqSol,            // SOL
        virtual_sol_reserves: Number(st.vSol), // lamports
        virtual_token_reserves: Number(st.vToken),
        liquiditySol: liqSol,
        // market cap
        market_cap: mcSol,                     // SOL
        usd_market_cap: sol ? mcSol * sol : null,
        marketCapUsd: sol ? mcSol * sol : null,
        // volume (USD if SOL price known, else SOL)
        volume24h: sol ? st.cumVolSol * sol : st.cumVolSol,
        volume5m: sol ? vol5mSol * sol : vol5mSol,
        priceSol: st.priceSol,
        created_timestamp: st.createdMs,
        bonding_progress: Math.min((st.realSol / GRADUATION_SOL) * 100, 100),
        status: 'presale',
        complete: false,
        creator: st.creator,
        uri: st.uri,
        twitter: st.socials?.twitter ?? null,
        telegram: st.socials?.telegram ?? null,
        website: st.socials?.website ?? null,
        _source: 'onchain',
      };
    });
  }
}

export const onchainPumpStream = new OnchainPumpStream();
