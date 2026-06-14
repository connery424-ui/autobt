import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ArrowDownUp, ArrowDown, Zap, ExternalLink, Loader2, CheckCircle2, XCircle, Search, Wallet2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useManagedWallets } from '../hooks/useManagedWallets';
import { cn } from '../lib/utils';

/**
 * Swap page — trade any token by address with automatic venue routing.
 *
 * Detection is informational; execution ALWAYS uses the server's auto-routers,
 * which are the single source of truth for venue selection:
 *  - BUY  → POST /api/sniper/execute        (pump.fun bonding curve → PumpSwap → LaunchLab → Jupiter)
 *  - SELL → POST /api/wallets/sell-token    (dex:'auto': LaunchLab → pump.fun → PumpSwap → Jupiter)
 * Both paths record through the verified trade recorders.
 */

type Venue = {
  label: string;
  detail: string;
  color: string; // tailwind classes for the badge
};

const detectVenueHeuristic = (mint: string): Venue => {
  const m = mint.toLowerCase();
  if (m.endsWith('pump')) {
    return {
      label: 'Pump.fun',
      detail: 'Auto route: bonding curve → PumpSwap (graduated) → Jupiter',
      color: 'bg-green-500/15 text-green-400 border-green-500/30',
    };
  }
  if (m.endsWith('bonk')) {
    return {
      label: 'LaunchLab',
      detail: 'Auto route: LaunchLab pool → Jupiter fallback',
      color: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    };
  }
  return {
    label: 'Jupiter / Raydium',
    detail: 'Auto route: best available DEX via Jupiter aggregation',
    color: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  };
};

const isValidMint = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());

interface TokenInfo {
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  dexId: string | null;
}

const Swap: React.FC = () => {
  const { isAuthenticated, sessionToken } = useAuth();
  const { wallets, activeWallet, refetch } = useManagedWallets();

  // Per-trade wallet selection — defaults to the active wallet but doesn't change it
  const [walletId, setWalletId] = useState<string | null>(null);
  useEffect(() => {
    if (!walletId && activeWallet) setWalletId(activeWallet.id);
  }, [activeWallet, walletId]);
  const selectedWallet = wallets.find(w => w.id === walletId) || activeWallet;

  const [mode, setMode] = useState<'buy' | 'sell'>('buy');
  const [mint, setMint] = useState('');
  const [venue, setVenue] = useState<Venue | null>(null);
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [detecting, setDetecting] = useState(false);

  const [amountSol, setAmountSol] = useState('');
  const [sellPct, setSellPct] = useState(100);
  const [tokenBalance, setTokenBalance] = useState<number | null>(null);
  const [slippagePct, setSlippagePct] = useState('5');

  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string; sig?: string } | null>(null);

  const authHeader: Record<string, string> = sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
  const detectSeq = useRef(0);

  // ── Venue detection + token info (debounced on mint change) ──
  useEffect(() => {
    setResult(null);
    setTokenInfo(null);
    setTokenBalance(null);
    if (!isValidMint(mint)) { setVenue(null); return; }
    setVenue(detectVenueHeuristic(mint.trim()));
    const seq = ++detectSeq.current;
    setDetecting(true);
    const t = setTimeout(async () => {
      try {
        // DexScreener proxy — fills name/symbol/price for indexed tokens.
        // Pre-bonded pump/bonk tokens often aren't indexed; the heuristic badge stands.
        const r = await fetch(`/api/token-info/${mint.trim()}`);
        const d = r.ok ? await r.json() : null;
        const pair = d?.pairs?.[0];
        if (seq === detectSeq.current && pair) {
          setTokenInfo({
            name: pair.baseToken?.name ?? null,
            symbol: pair.baseToken?.symbol ?? null,
            priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
            liquidityUsd: pair.liquidity?.usd ?? null,
            dexId: pair.dexId ?? null,
          });
        }
      } catch { /* heuristic badge is enough */ }
      if (seq === detectSeq.current) setDetecting(false);
    }, 400);
    return () => clearTimeout(t);
  }, [mint]);

  // ── Token balance for sell mode ──
  const loadTokenBalance = useCallback(async () => {
    if (!selectedWallet || !isValidMint(mint)) return;
    try {
      const r = await fetch(`/api/wallets/${selectedWallet.id}/token-holdings`, { headers: authHeader });
      const d = await r.json();
      const h = (d.holdings || []).find((x: any) => (x.mint || x.tokenAddress) === mint.trim());
      setTokenBalance(h ? Number(h.balance ?? h.uiAmount ?? h.amount ?? 0) : 0);
    } catch { setTokenBalance(null); }
  }, [selectedWallet, mint, sessionToken]);

  useEffect(() => {
    if (mode === 'sell') loadTokenBalance();
  }, [mode, mint, selectedWallet?.id, loadTokenBalance]);

  // ── Execute ──
  const handleTrade = async () => {
    if (!selectedWallet || executing) return;
    setExecuting(true);
    setResult(null);
    try {
      const slippageBps = Math.round((parseFloat(slippagePct) || 5) * 100);
      if (mode === 'buy') {
        const buyAmountSol = parseFloat(amountSol);
        if (!buyAmountSol || buyAmountSol <= 0) throw new Error('Enter a SOL amount');
        const r = await fetch('/api/sniper/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            tokenAddress: mint.trim(),
            buyAmountSol,
            slippageBps,
            walletId: selectedWallet.id,
          }),
        });
        const d = await r.json();
        if (!r.ok || !d.success) throw new Error(d.error || 'Buy failed');
        setResult({ ok: true, msg: `Bought via ${d.path || 'auto route'}`, sig: d.signature });
      } else {
        if (tokenBalance == null || tokenBalance <= 0) throw new Error('No balance for this token in the selected wallet');
        const tokenAmount = tokenBalance * (sellPct / 100);
        const r = await fetch('/api/wallets/sell-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            walletId: selectedWallet.id,
            tokenMint: mint.trim(),
            tokenAmount,
            dex: 'auto', // server resolves the real venue and records it
            tokenName: tokenInfo?.name,
            tokenSymbol: tokenInfo?.symbol,
          }),
        });
        const d = await r.json();
        if (!r.ok || d.success === false) throw new Error(d.error || 'Sell failed');
        setResult({ ok: true, msg: `Sold via ${(d.dex || 'auto route').toString().toUpperCase()}`, sig: d.signature });
        loadTokenBalance();
      }
      refetch();
    } catch (e: any) {
      setResult({ ok: false, msg: e?.message || 'Trade failed' });
    } finally {
      setExecuting(false);
    }
  };

  const canTrade = isAuthenticated && selectedWallet && isValidMint(mint) && !executing
    && (mode === 'buy' ? parseFloat(amountSol) > 0 : (tokenBalance ?? 0) > 0);

  const tokenLabel = tokenInfo?.symbol || (isValidMint(mint) ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : 'Token');

  // ── Panels (From/To flip with mode) ──
  const solPanel = (kind: 'from' | 'to') => (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-muted-foreground">{kind === 'from' ? 'From' : 'To'}</span>
        {kind === 'from' && (
          <span className="text-xs text-muted-foreground">
            Balance: <span className="text-foreground">{selectedWallet ? `${Number(selectedWallet.balance).toFixed(4)} SOL` : '—'}</span>
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-primary/10 border border-primary/30 shrink-0">
          <span className="text-base">◎</span>
          <span className="font-semibold">SOL</span>
        </div>
        {kind === 'from' ? (
          <div className="flex items-center gap-2 flex-1 justify-end min-w-0">
            {[25, 50, 100].map(p => (
              <button key={p}
                onClick={() => {
                  if (!selectedWallet) return;
                  const bal = Number(selectedWallet.balance);
                  // Max leaves ~0.005 SOL headroom for fees/tip/rent
                  const v = p === 100 ? Math.max(bal - 0.005, 0) : bal * p / 100;
                  setAmountSol(v.toFixed(4));
                }}
                className="px-2.5 py-1 rounded-full text-xs bg-secondary text-muted-foreground hover:text-foreground transition-colors shrink-0">
                {p === 100 ? 'Max' : `${p}%`}
              </button>
            ))}
            {/* text+decimal instead of type=number: no native spinner arrows, fully flexible width */}
            <input
              type="text" inputMode="decimal" placeholder="0.0"
              value={amountSol}
              onChange={e => {
                const v = e.target.value.replace(',', '.');
                if (v === '' || /^\d*\.?\d*$/.test(v)) setAmountSol(v);
              }}
              className="flex-1 min-w-0 bg-transparent text-right text-2xl font-semibold outline-none placeholder:text-muted-foreground/40"
            />
          </div>
        ) : (
          <span className="text-2xl font-semibold text-muted-foreground/60">auto</span>
        )}
      </div>
    </div>
  );

  const tokenPanel = (kind: 'from' | 'to') => (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-muted-foreground">{kind === 'from' ? 'From' : 'To'}</span>
        {kind === 'from' && (
          <span className="text-xs text-muted-foreground">
            Balance: <span className="text-foreground">{tokenBalance != null ? tokenBalance.toLocaleString() : '—'}</span>
          </span>
        )}
      </div>
      <div className="relative mb-3">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={mint}
          onChange={e => setMint(e.target.value.trim())}
          placeholder="Paste token address (mint)…"
          spellCheck={false}
          className="w-full pl-9 pr-3 py-2 rounded-lg glass border border-border focus:border-primary transition-colors font-mono text-sm"
        />
      </div>
      {venue && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('px-2 py-0.5 rounded-full text-xs font-semibold border', venue.color)}>
            {detecting ? <Loader2 className="w-3 h-3 inline animate-spin mr-1" /> : <Zap className="w-3 h-3 inline mr-1" />}
            {venue.label}
          </span>
          {tokenInfo?.name && (
            <span className="text-sm font-medium">{tokenInfo.name} {tokenInfo.symbol ? `(${tokenInfo.symbol})` : ''}</span>
          )}
          {tokenInfo?.priceUsd != null && (
            <span className="text-xs text-muted-foreground">${tokenInfo.priceUsd.toPrecision(3)}</span>
          )}
          {tokenInfo?.liquidityUsd != null && (
            <span className="text-xs text-muted-foreground">Liq ${Math.round(tokenInfo.liquidityUsd).toLocaleString()}</span>
          )}
        </div>
      )}
      {venue && <p className="text-xs text-muted-foreground mt-2">{venue.detail}</p>}
      {kind === 'from' && (
        <div className="flex items-center gap-2 mt-3">
          {[25, 50, 75, 100].map(p => (
            <button key={p}
              onClick={() => setSellPct(p)}
              className={cn('px-2.5 py-1 rounded-full text-xs transition-colors',
                sellPct === p ? 'bg-primary/20 text-primary border border-primary/40' : 'bg-secondary text-muted-foreground hover:text-foreground')}>
              {p === 100 ? 'Max' : `${p}%`}
            </button>
          ))}
          {tokenBalance != null && (
            <span className="text-xs text-muted-foreground ml-auto">
              Selling {(tokenBalance * sellPct / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} {tokenLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex-1 p-2 sm:p-4 md:p-6">
      <div className="max-w-xl mx-auto">
        <div className="mb-4 sm:mb-6">
          <h1 className="text-xl sm:text-2xl font-bold gradient-text">Swap</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Trade any token by address — the route is detected automatically
          </p>
        </div>

        <div className="glass rounded-xl border overflow-hidden">
          {/* Mode tabs + slippage */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex gap-1">
              {(['buy', 'sell'] as const).map(m => (
                <button key={m}
                  onClick={() => { setMode(m); setResult(null); }}
                  className={cn('px-4 py-1.5 rounded-lg text-sm font-semibold capitalize transition-colors',
                    mode === m
                      ? m === 'buy' ? 'bg-green-600/20 text-green-400 border border-green-500/40'
                        : 'bg-red-600/20 text-red-400 border border-red-500/40'
                      : 'text-muted-foreground hover:text-foreground')}>
                  {m}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>Slippage</span>
              <input
                type="text" inputMode="decimal"
                value={slippagePct}
                onChange={e => {
                  const v = e.target.value.replace(',', '.');
                  if (v === '' || /^\d*\.?\d*$/.test(v)) setSlippagePct(v);
                }}
                className="w-14 px-2 py-1 rounded-md glass border border-border text-right text-foreground"
              />
              <span>%</span>
            </div>
          </div>

          {/* Wallet selector — trade from any loaded wallet (doesn't change the global active wallet) */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <Wallet2 className="w-4 h-4 text-muted-foreground shrink-0" />
            <select
              value={walletId ?? ''}
              onChange={e => { setWalletId(e.target.value); setResult(null); setTokenBalance(null); }}
              className="flex-1 px-2 py-1.5 rounded-lg glass border border-border focus:border-primary transition-colors text-sm bg-transparent"
            >
              {wallets.length === 0 && <option value="">No wallets loaded</option>}
              {wallets.map(w => (
                <option key={w.id} value={w.id} className="bg-background">
                  {w.name} — {w.publicKey.slice(0, 4)}…{w.publicKey.slice(-4)} ({Number(w.balance).toFixed(3)} SOL){w.isActive ? ' · active' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* From / To */}
          <div className="divide-y divide-border">
            {mode === 'buy' ? solPanel('from') : tokenPanel('from')}
            <div className="relative">
              <button
                onClick={() => { setMode(mode === 'buy' ? 'sell' : 'buy'); setResult(null); }}
                title="Flip buy/sell"
                className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 p-2 rounded-full glass border border-border hover:border-primary transition-colors">
                <ArrowDownUp className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            {mode === 'buy' ? tokenPanel('to') : solPanel('to')}
          </div>

          {/* Result */}
          {result && (
            <div className={cn('mx-4 mt-1 mb-2 px-3 py-2 rounded-lg text-sm flex items-center gap-2',
              result.ok ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400')}>
              {result.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
              <span className="truncate">{result.msg}</span>
              {result.sig && (
                <a href={`https://solscan.io/tx/${result.sig}`} target="_blank" rel="noopener noreferrer"
                  className="ml-auto shrink-0 inline-flex items-center gap-1 underline">
                  tx <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}

          {/* Action */}
          <div className="p-4 border-t border-border">
            <button
              onClick={handleTrade}
              disabled={!canTrade}
              className={cn('w-full py-3 rounded-xl font-semibold transition-all',
                canTrade
                  ? mode === 'buy'
                    ? 'bg-green-600 hover:bg-green-500 text-white solana-glow'
                    : 'bg-red-600 hover:bg-red-500 text-white'
                  : 'bg-secondary text-muted-foreground cursor-not-allowed')}>
              {executing ? (
                <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Routing…</span>
              ) : !isAuthenticated ? 'Connect profile to trade'
                : !selectedWallet ? 'No wallet selected'
                : !isValidMint(mint) ? 'Paste a token address'
                : mode === 'buy' ? `Buy ${tokenLabel}`
                : `Sell ${sellPct === 100 ? 'all' : `${sellPct}%`} ${tokenLabel}`}
            </button>
            <p className="text-[11px] text-muted-foreground text-center mt-2 flex items-center justify-center gap-1">
              <ArrowDown className="w-3 h-3" />
              Real blockchain transaction · venue chosen automatically · recorded after on-chain verification
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Swap;
