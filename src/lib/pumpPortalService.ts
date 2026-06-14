/**
 * PumpPortal WebSocket Service
 * Connects to pumpportal.fun WebSocket to receive real-time new token events
 * Persists tokens to LOCAL SQLite database for fast access
 * 
 * FILTERING: Pre-filters tokens to reduce noise before storage/logging
 * AUTO-SNIPE: Triggers auto-snipes for tokens that match active snipe_settings
 */

import WebSocket from 'ws';
import { sqliteDb as tokenDb } from './sqliteDb.js';
import { prisma } from './prisma.js';
import { EnhancedSniperService } from './enhancedSniperService.js';

// SOL/USD price + USD liquidity checks live in liquidityUnits.ts (single source
// of truth, audit §1.2). Re-exported here for backward compatibility.
import { liquidityUsdCheck, getSolPriceUsd } from './liquidityUnits.js';
export { setSolPriceUsd, getSolPriceUsd, liquidityUsdCheck } from './liquidityUnits.js';


interface PumpPortalToken {
    mint: string;
    name: string;
    symbol: string;
    description?: string;
    uri?: string;
    imageUri?: string;
    traderPublicKey?: string;
    signature?: string;
    bondingCurveKey?: string;
    vTokensInBondingCurve?: number;
    vSolInBondingCurve?: number;
    marketCapSol?: number;
    usd_market_cap?: number;  // USD market cap from PumpPortal — used to derive SOL price
    timestamp?: number;
    buyCount?: number;
    sellCount?: number;
    buySolVolume?: number;
    sellSolVolume?: number;
    lastTradeAt?: number;
    trendingScore?: number;
    passedFilter?: boolean;
    filterReason?: string;
    twitter?: string | null;
    telegram?: string | null;
    website?: string | null;
}

interface TokenFilterConfig {
    minLiquidityUsd: number;      // Min liquidity in USD (default: 75 ≈ 0.5 SOL @ $150)
    maxLiquidityUsd: number;      // Max liquidity in USD (default: 150000 ≈ 1000 SOL @ $150)
    minMarketCapSol: number;      // Min market cap in SOL (default: 0)
    maxMarketCapSol: number;      // Max market cap in SOL (default: 10000)
    blockSuspicious: boolean;     // Block suspicious names (default: true)
    requireDescription: boolean;  // Require non-empty description (default: false)
    minSymbolLength: number;      // Min symbol length (default: 2)
    maxSymbolLength: number;      // Max symbol length (default: 10)
}

// Suspicious/test patterns to block
const SUSPICIOUS_PATTERNS = [
    /^test/i, /^demo/i, /^sample/i, /^foo/i, /^bar/i, /^baz/i,
    /^xxx/i, /^yyy/i, /^zzz/i, /^aaa/i, /^bbb/i, /^ccc/i,
    /^placeholder/i, /^untitled/i, /^unknown/i, /^token\d*$/i,
    /^mint\d*$/i, /^coin\d*$/i, /^new token/i, /^my token/i,
    /^\.$/, /^\?$/, /^!$/, /^-$/, /^_$/,
];

class PumpPortalService {
    private ws: WebSocket | null = null;
    private isConnected = false;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = Infinity;  // never give up
    private reconnectDelay = 5000;
    private maxReconnectDelay = 60000; // cap at 60s
    private tradingTokens: Set<string> = new Set();

    // Auto-snipe service
    private enhancedSniperService: EnhancedSniperService | null = null;
    private autoSnipeEnabled = false;
    private recentlyCheckedTokens: Set<string> = new Set(); // Track recently checked tokens per-token

    // In-memory caches
    private recentTokens: PumpPortalToken[] = [];
    private recentFilteredTokens: PumpPortalToken[] = [];  // Only tokens that passed filter
    // Buffers were 50/30 — far too small: getLiveFeed/getNewTokens could never return
    // more than that, so the Sniper feed was capped at ~50 pump.fun tokens regardless
    // of the requested limit. Raised so the feed reflects the real universe of recent
    // pre-bonded tokens (memory cost is trivial — a few hundred small objects).
    private readonly maxRecentTokens = 600;
    private readonly maxRecentFilteredTokens = 600;

    // Filter configuration (can be updated at runtime)
    private filterConfig: TokenFilterConfig = {
        minLiquidityUsd: 75,
        maxLiquidityUsd: 150000,
        minMarketCapSol: 0,
        maxMarketCapSol: 10000,
        blockSuspicious: true,
        requireDescription: false,
        minSymbolLength: 2,
        maxSymbolLength: 10,
    };

    // Stats tracking
    private stats = {
        totalTokens: 0,
        filteredTokens: 0,
        rejectedTokens: 0,
        rejectionReasons: {} as Record<string, number>,
    };

    // ── Per-token market-cap history for bonding-curve price change ──────────────
    // pump.fun has a fixed supply, so price ∝ marketCapSol. We record marketCapSol
    // at token creation and on every trade event, then derive 5m/1h/24h % change.
    // This is the REAL price source for pre-bonded tokens (DexScreener barely indexes
    // them). Bounded in size + pruned to 24h so memory stays flat.
    private marketStats: Map<string, { initialMc: number; history: { ts: number; mc: number }[]; lastTs: number }> = new Map();
    private readonly maxMarketStats = 600;

    // In-flight socials fetches — awaited by the social-requirement filter so new
    // tokens aren't rejected before their metadata has been read.
    private socialsPromises: Map<string, Promise<void>> = new Map();
    // Auto-snipe buys currently executing per user — closes the position-cap race:
    // the DB row only lands after on-chain confirmation (~3-15s), so without this
    // several buys could all see "0 open" and blow past the cap (2026-06-12).
    private inFlightSnipes: Map<string, number> = new Map();
    // Copycat guard: `userId|SYMBOL` → last snipe ts. pump.fun floods identical-name
    // clones within seconds of a hyped launch; one symbol per 10 min per user.
    private recentSnipedSymbols: Map<string, number> = new Map();
    // Tokens whose socials (twitter/telegram/website) we've already tried to fetch from metadata.
    private socialsFetched: Set<string> = new Set();

    constructor() {
        // Initialize EnhancedSniperService for auto-sniping
        try {
            // Prefer Helius RPC for speed; fall back to SOLANA_RPC_URL, then public mainnet
            const heliusKey = process.env.HELIUS_API_KEY;
            const heliusRpc = heliusKey
                ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
                : null;
            const rpcEndpoint = heliusRpc || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
            const heliusWs = heliusKey
                ? `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`
                : null;
            const wsEndpoint = heliusWs || process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com';
            this.enhancedSniperService = new EnhancedSniperService(rpcEndpoint, wsEndpoint);
            console.log('✅ EnhancedSniperService initialized for auto-sniping');
        } catch (error) {
            console.warn('⚠️ Failed to initialize EnhancedSniperService:', error);
            this.enhancedSniperService = null;
        }
        this.connect();
    }

    /**
     * Update filter configuration at runtime
     */
    updateFilterConfig(config: Partial<TokenFilterConfig>) {
        this.filterConfig = { ...this.filterConfig, ...config };
        console.log('🔧 Token filter config updated:', this.filterConfig);
    }

    /**
     * Get current filter configuration
     */
    getFilterConfig(): TokenFilterConfig {
        return { ...this.filterConfig };
    }

    /**
     * Get filter statistics
     */
    getStats() {
        return { ...this.stats };
    }

    /**
     * Enable or disable auto-snipe functionality
     */
    setAutoSnipeEnabled(enabled: boolean) {
        this.autoSnipeEnabled = enabled;
        console.log(`🔧 Auto-snipe ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Check if auto-snipe is enabled
     */
    isAutoSnipeEnabled(): boolean {
        return this.autoSnipeEnabled;
    }

    /**
     * Fetch all active snipe_settings from database
     */
    private async getActiveSnipeSettings(): Promise<any[]> {
        try {
            const settings = await prisma.snipe_settings.findMany({
                where: {
                    isActive: true
                },
                include: {
                    users: true
                }
            });
            return settings;
        } catch (error) {
            console.error('Error fetching active snipe settings:', error);
            return [];
        }
    }

    /**
     * Check if a token matches the snipe settings criteria
     */
    private tokenMatchesSnipeSettings(token: PumpPortalToken, settings: any): { matches: boolean; reason?: string } {
        // Check DEX type (PumpPortal tokens are always from pump.fun)
        if (!settings.enablePumpfun) {
            return { matches: false, reason: 'pumpfun_disabled' };
        }

        // Check liquidity — single source of truth: USD thresholds (see liquidityUsdCheck)
        const liqCheck = liquidityUsdCheck(token.vSolInBondingCurve || 0, settings.minLiquidityUsd, settings.maxLiquidityUsd);
        if (!liqCheck.ok) {
            return { matches: false, reason: liqCheck.reason };
        }

        // Check market cap — USD thresholds preferred (the UI is labeled USD);
        // legacy SOL thresholds still honored when the USD ones aren't set.
        const marketCapSol = token.marketCapSol || 0;
        const marketCapUsd = marketCapSol * getSolPriceUsd();
        if (settings.minMarketCapUsd || settings.maxMarketCapUsd) {
            if (settings.minMarketCapUsd && marketCapUsd < settings.minMarketCapUsd) {
                return { matches: false, reason: `low_marketCap ($${Math.round(marketCapUsd)} < $${settings.minMarketCapUsd})` };
            }
            if (settings.maxMarketCapUsd && marketCapUsd > settings.maxMarketCapUsd) {
                return { matches: false, reason: `high_marketCap ($${Math.round(marketCapUsd)} > $${settings.maxMarketCapUsd})` };
            }
        } else {
            if (settings.minMarketCapSol && marketCapSol < settings.minMarketCapSol) {
                return { matches: false, reason: `low_marketCap (${marketCapSol} SOL < ${settings.minMarketCapSol} SOL)` };
            }
            if (settings.maxMarketCapSol && marketCapSol > settings.maxMarketCapSol) {
                return { matches: false, reason: `high_marketCap (${marketCapSol} SOL > ${settings.maxMarketCapSol} SOL)` };
            }
        }

        // Check token age
        if (settings.maxTokenAgeSec && token.timestamp) {
            const ageSec = (Date.now() - token.timestamp) / 1000;
            if (ageSec > settings.maxTokenAgeSec) {
                return { matches: false, reason: `token_too_old (${ageSec.toFixed(0)}s > ${settings.maxTokenAgeSec}s)` };
            }
        }

        // Note: Authority checks (mint/freeze) and social checks (Twitter/Telegram/Website)
        // would require additional RPC calls or API requests. For now, we log them as potential matches
        // and let the enhancedSniperService handle the detailed checks during execution.

        return { matches: true };
    }

    /**
     * Record auto-snipe execution attempt
     */
    private async recordAutoSnipeExecution(
        settings: any,
        token: PumpPortalToken,
        status: 'pending' | 'success' | 'failed',
        signature?: string,
        failureReason?: string,
        latencyMs?: number
    ): Promise<void> {
        try {
            await prisma.snipe_executions.create({
                data: {
                    settingsId: settings.id,
                    userId: settings.userId,
                    tokenAddress: token.mint,
                    tokenName: token.name,
                    tokenSymbol: token.symbol,
                    dex: 'pumpfun',
                    buyAmountSol: settings.buyAmountSol,
                    status,
                    txSignature: signature,
                    failureReason,
                    detectedAt: new Date(token.timestamp || Date.now()),
                    executedAt: signature ? new Date() : null,
                    latencyMs
                }
            });
            console.log(`📝 Auto-snipe execution recorded: ${status} for ${token.symbol}`);
        } catch (error) {
            console.error('Error recording auto-snipe execution:', error);
        }
    }

    /**
     * Execute auto-snipe for a token
     */
    private async executeAutoSnipe(token: PumpPortalToken, settings: any): Promise<{ success: boolean; signature?: string; error?: string }> {
        const detectedAt = Date.now();

        console.log(`🎯 Executing auto-snipe for ${token.symbol} (${token.mint.slice(0, 8)}...)`);

        try {
            // Step 1: Get the user's managed wallet
            const { secureWalletService } = await import('./secureWalletService.js');
            const userWallets = await secureWalletService.getUserWallets(settings.userId);

            // Use the wallet saved in snipe_settings (the UI selector) for consistency with
            // the manual zap; fall back to active, then first.
            const activeWallet = (settings.walletId && userWallets.find((w: any) => w.id === settings.walletId))
                || userWallets.find((w: { isActive: boolean }) => w.isActive)
                || userWallets[0];

            if (!activeWallet) {
                const error = 'No managed wallet found for user';
                console.error('❌', error);
                await this.recordAutoSnipeExecution(settings, token, 'failed', undefined, error, Date.now() - detectedAt);
                return { success: false, error };
            }

            console.log(`📋 Using wallet: ${activeWallet.walletName} (${activeWallet.publicKey})`);

            // ── Authority safety checks (2026-06-11) ──
            // checkMintAuthority/checkFreezeAuthority were saved but never enforced.
            // One parsed-account read (~100ms) verifies both before any SOL is spent.
            if (settings.checkMintAuthority || settings.checkFreezeAuthority) {
                try {
                    const { rpcManager } = await import('./rpcManager.js');
                    const { PublicKey } = await import('@solana/web3.js');
                    const mintInfo = await rpcManager.getConnection().getParsedAccountInfo(new PublicKey(token.mint));
                    const parsed: any = (mintInfo.value?.data as any)?.parsed?.info;
                    if (settings.checkMintAuthority && parsed?.mintAuthority) {
                        const error = 'mint_authority_present';
                        console.log(`🚫 Skipping ${token.symbol}: mint authority not revoked`);
                        await this.recordAutoSnipeExecution(settings, token, 'failed', undefined, error, Date.now() - detectedAt);
                        return { success: false, error };
                    }
                    if (settings.checkFreezeAuthority && parsed?.freezeAuthority) {
                        const error = 'freeze_authority_present';
                        console.log(`🚫 Skipping ${token.symbol}: freeze authority present`);
                        await this.recordAutoSnipeExecution(settings, token, 'failed', undefined, error, Date.now() - detectedAt);
                        return { success: false, error };
                    }
                } catch (authErr: any) {
                    console.warn(`⚠️ Authority check failed (${authErr?.message}) — proceeding (pump.fun revokes both by default)`);
                }
            }

            // ── Buy via pump.fun bonding curve (2026-06-12) ──
            // The old path quoted Jupiter through the FRONTEND axios helper
            // ('/api/jupiter/quote' — an invalid relative URL inside Node), so every
            // auto-snipe failed instantly. It was also conceptually wrong: brand-new
            // pre-bonded pump.fun tokens aren't routable on Jupiter at all. Reuse the
            // proven momentum/zap buy: PumpPortal trade-local build → budget sizing →
            // sign → rebroadcast until confirmed (throws on on-chain failure).
            const slippageBps = settings.slippageBps || 100;
            console.log(`💰 Amount: ${settings.buyAmountSol} SOL · slippage ${slippageBps / 100}%`);

            const { executeBuy, getTradeRecorders } = await import('./momentumTrader.js');
            const { rpcManager } = await import('./rpcManager.js');
            const { Connection } = await import('@solana/web3.js');
            const connection = new Connection(rpcManager.getUrl(), 'confirmed');

            const signature = await executeBuy(
                connection,
                { id: activeWallet.id, publicKey: activeWallet.publicKey },
                settings.userId,
                token.mint,
                settings.buyAmountSol,
                slippageBps,
            );

            const latencyMs = Date.now() - detectedAt;
            console.log(`⚡ Auto-snipe completed for ${token.symbol} in ${latencyMs}ms — ${signature.slice(0, 16)}…`);

            // Record execution + a VERIFIED transactions row (recorder injected by server)
            await this.recordAutoSnipeExecution(settings, token, 'success', signature, undefined, latencyMs);
            const recorders = getTradeRecorders();
            if (recorders.recordBuy) {
                void recorders.recordBuy({
                    userId: settings.userId, walletId: activeWallet.id, walletPubkey: activeWallet.publicKey,
                    signature, tokenMint: token.mint, tokenName: token.name || null, tokenSymbol: token.symbol || null,
                    tokensEstimate: 0, dexLabel: 'PUMPFUN', fallbackSolSpent: settings.buyAmountSol,
                });
            }

            // Track the position in token_holdings so the Auto-Sell scanner can
            // manage it (TP/SL/trailing/max-hold) — without this row, sniped
            // positions were invisible to auto-sell.
            try {
                const priceSol = token.marketCapSol && token.marketCapSol > 0 ? token.marketCapSol / 1e9 : 0;
                await prisma.token_holdings.upsert({
                    where: { userId_tokenAddress: { userId: settings.userId, tokenAddress: token.mint } },
                    create: {
                        userId: settings.userId, tokenAddress: token.mint,
                        tokenName: token.name || null, tokenSymbol: token.symbol || null,
                        amount: 0, averageBuyPrice: priceSol, totalCostSol: settings.buyAmountSol,
                        dex: 'pumpfun', isPreBonded: true,
                    },
                    update: { totalCostSol: { increment: settings.buyAmountSol }, lastUpdatedAt: new Date() },
                });
            } catch { /* non-fatal — auto-sell tracking only */ }

            return { success: true, signature };

        } catch (error: any) {
            const errorMessage = error.message || 'Unknown error';
            console.error('❌ Auto-snipe execution failed:', errorMessage);
            console.error('Error stack:', error.stack);

            // Record failed execution
            const latencyMs = Date.now() - detectedAt;
            await this.recordAutoSnipeExecution(settings, token, 'failed', undefined, errorMessage, latencyMs);

            return { success: false, error: errorMessage };
        }
    }

    /**
     * Check and trigger auto-snipe for a token that passed filter
     */
    private async checkAndTriggerAutoSnipe(token: PumpPortalToken): Promise<void> {
        // Per-token debounce: skip if we've already checked this token recently
        if (this.recentlyCheckedTokens.has(token.mint)) {
            return; // Already checked this token
        }

        // P2 fix: cap the Set size to prevent unbounded memory growth during high-traffic events.
        // When >5000 entries accumulate faster than the 60s TTL can clean them, prune the oldest half.
        if (this.recentlyCheckedTokens.size >= 5000) {
            const entries = Array.from(this.recentlyCheckedTokens);
            entries.slice(0, 2500).forEach(e => this.recentlyCheckedTokens.delete(e));
        }

        this.recentlyCheckedTokens.add(token.mint);

        // Clean up old entries (keep set small) - remove after 1 minute
        setTimeout(() => {
            this.recentlyCheckedTokens.delete(token.mint);
        }, 60000);

        // Check if auto-snipe is enabled
        if (!this.autoSnipeEnabled) {
            return;
        }

        try {
            // Fetch all active snipe settings
            const activeSettings = await this.getActiveSnipeSettings();

            if (activeSettings.length === 0) {
                return;
            }

            console.log(`🔍 Checking ${activeSettings.length} active snipe settings for ${token.symbol}...`);

            // Check each setting to see if token matches
            for (const settings of activeSettings) {
                const matchResult = this.tokenMatchesSnipeSettings(token, settings);

                if (matchResult.matches) {
                    console.log(`✅ Token ${token.symbol} matches snipe setting "${settings.name}" for user ${settings.userId}`);

                    // Check if this user has already sniped this token (duplicate prevention)
                    const existingExecution = await prisma.snipe_executions.findFirst({
                        where: {
                            settingsId: settings.id,
                            tokenAddress: token.mint,
                            status: { in: ['pending', 'success'] }
                        }
                    });

                    if (existingExecution) {
                        console.log(`⏭️ Already sniped ${token.symbol} for setting ${settings.name}`);
                        continue; // Skip this setting, try next
                    }

                    // ── Social requirements (2026-06-11) ──
                    // requireTwitter/Telegram/Website were saved but never enforced.
                    // Socials load async from the metadata URI — wait for that fetch
                    // (max 4s) before judging, so brand-new tokens aren't rejected
                    // just because their metadata hadn't arrived yet.
                    if (settings.requireTwitter || settings.requireTelegram || settings.requireWebsite) {
                        const sp = this.socialsPromises.get(token.mint);
                        if (sp) await Promise.race([sp, new Promise(r => setTimeout(r, 4000))]);
                        const missing: string[] = [];
                        if (settings.requireTwitter && !token.twitter) missing.push('X');
                        if (settings.requireTelegram && !token.telegram) missing.push('Telegram');
                        if (settings.requireWebsite && !token.website) missing.push('Website');
                        if (missing.length) {
                            console.log(`⏭️ ${token.symbol} skipped — missing required socials: ${missing.join(', ')}`);
                            continue;
                        }
                    }

                    // ── Copycat guard (2026-06-12) ──
                    // pump.fun floods identical-symbol clones within seconds of a hyped
                    // launch — one run bought THREE different "WOC" mints. One snipe per
                    // symbol per user per 10 minutes.
                    const symKey = `${settings.userId}|${(token.symbol || '').toUpperCase()}`;
                    if (token.symbol) {
                        const lastSym = this.recentSnipedSymbols.get(symKey);
                        if (lastSym && Date.now() - lastSym < 10 * 60_000) {
                            console.log(`⏭️ ${token.symbol} skipped — same symbol sniped recently (copycat guard)`);
                            continue;
                        }
                    }

                    // ── Open-position gate (2026-06-11, race-fixed 2026-06-12) ──
                    // Cap how many distinct tokens the user can hold from auto-buys.
                    // Open positions = token_holdings rows (created synchronously on
                    // buy, deleted on auto-sell) PLUS buys still executing (inFlight) —
                    // the old transactions-table count only updated after on-chain
                    // confirmation, so simultaneous launches blew past the cap (4/2).
                    const maxPositions = Number(settings.momentumMaxPositions) || 5;
                    const inFlight = this.inFlightSnipes.get(settings.userId) || 0;
                    try {
                        const openPositions = await prisma.token_holdings.count({
                            where: { userId: settings.userId },
                        });
                        if (openPositions + inFlight >= maxPositions) {
                            console.log(`🚧 Position cap: ${openPositions} open + ${inFlight} in flight ≥ ${maxPositions} — skipping snipe of ${token.symbol}`);
                            continue;
                        }
                    } catch (gateErr: any) {
                        console.warn(`⚠️ Position-gate check failed (${gateErr?.message}) — proceeding without gate`);
                    }

                    // Reserve the slot + symbol BEFORE executing so concurrent launches
                    // can't double-book while this buy is in flight.
                    this.inFlightSnipes.set(settings.userId, inFlight + 1);
                    if (token.symbol) this.recentSnipedSymbols.set(symKey, Date.now());
                    if (this.recentSnipedSymbols.size > 1000) {
                        const oldest = this.recentSnipedSymbols.keys().next().value;
                        if (oldest) this.recentSnipedSymbols.delete(oldest);
                    }

                    // Execute auto-snipe
                    let result: { success: boolean; signature?: string; error?: string };
                    try {
                        result = await this.executeAutoSnipe(token, settings);
                    } finally {
                        const cur = this.inFlightSnipes.get(settings.userId) || 1;
                        this.inFlightSnipes.set(settings.userId, Math.max(cur - 1, 0));
                    }

                    if (result.success) {
                        console.log(`🎯 Auto-snipe triggered for ${token.symbol} via setting "${settings.name}"`);
                    } else {
                        console.log(`❌ Auto-snipe failed for ${token.symbol}: ${result.error}`);
                    }

                    // Don't break - allow each user with matching settings to get their own snipe
                } else {
                    console.log(`⏭️ Token ${token.symbol} does not match setting "${settings.name}": ${matchResult.reason}`);
                }
            }
        } catch (error) {
            console.error('Error in checkAndTriggerAutoSnipe:', error);
            // Don't throw - we don't want to crash the WebSocket loop
        }
    }

    /**
     * Check if a token passes the filter
     */
    private checkTokenFilter(token: PumpPortalToken): { passed: boolean; reason?: string } {
        const cfg = this.filterConfig;

        // Check liquidity — same USD helper as tokenMatchesSnipeSettings (unit consistency)
        const liqCheck = liquidityUsdCheck(token.vSolInBondingCurve || 0, cfg.minLiquidityUsd, cfg.maxLiquidityUsd);
        if (!liqCheck.ok) {
            return { passed: false, reason: liqCheck.reason };
        }

        // Check market cap
        const marketCap = token.marketCapSol || 0;
        if (marketCap < cfg.minMarketCapSol) {
            return { passed: false, reason: `low_marketCap (${marketCap.toFixed(2)} < ${cfg.minMarketCapSol})` };
        }
        if (marketCap > cfg.maxMarketCapSol) {
            return { passed: false, reason: `high_marketCap (${marketCap.toFixed(2)} > ${cfg.maxMarketCapSol})` };
        }

        // Check symbol length
        if (token.symbol.length < cfg.minSymbolLength) {
            return { passed: false, reason: `short_symbol (${token.symbol.length} < ${cfg.minSymbolLength})` };
        }
        if (token.symbol.length > cfg.maxSymbolLength) {
            return { passed: false, reason: `long_symbol (${token.symbol.length} > ${cfg.maxSymbolLength})` };
        }

        // Check for suspicious patterns
        if (cfg.blockSuspicious) {
            const name = token.name.toLowerCase();
            const symbol = token.symbol.toLowerCase();

            for (const pattern of SUSPICIOUS_PATTERNS) {
                if (pattern.test(name) || pattern.test(symbol)) {
                    return { passed: false, reason: `suspicious_name (${pattern.source})` };
                }
            }
        }

        // Check description requirement
        if (cfg.requireDescription && (!token.description || token.description.trim().length < 10)) {
            return { passed: false, reason: 'no_description' };
        }

        return { passed: true };
    }

    /**
     * Get recent tokens that passed the filter
     */
    getRecentFilteredTokens(limit: number = 20): PumpPortalToken[] {
        return this.recentFilteredTokens.slice(0, limit);
    }

    private connect() {
        try {
            console.log('🔌 Connecting to PumpPortal WebSocket...');
            this.ws = new WebSocket('wss://pumpportal.fun/api/data');

            this.ws.on('open', () => {
                console.log('✅ PumpPortal WebSocket connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;

                this.ws?.send(JSON.stringify({
                    method: 'subscribeNewToken'
                }));
                console.log('📡 Subscribed to new token events');
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());

                    // Handle new token event
                    if (message.mint && message.name) {
                        this.handleNewToken(message);
                    }

                    // Handle trade events
                    if (message.txType && message.mint) {
                        this.handleTradeEvent(message);
                    }
                } catch {
                    // Ignore parse errors
                }
            });

            this.ws.on('close', () => {
                console.log('❌ PumpPortal WebSocket closed');
                this.isConnected = false;
                this.tradingTokens.clear();
                this.scheduleReconnect();
            });

            this.ws.on('error', (error) => {
                console.error('❌ PumpPortal WebSocket error:', error.message);
                this.isConnected = false;
            });

        } catch (error) {
            console.error('❌ Failed to connect to PumpPortal:', error);
            this.scheduleReconnect();
        }
    }

    private async handleNewToken(message: any) {
        const token: PumpPortalToken = {
            mint: message.mint,
            name: message.name || 'Unknown',
            symbol: message.symbol || 'UNKNOWN',
            description: message.description,
            uri: message.uri,
            imageUri: message.image_uri || message.imageUri,
            bondingCurveKey: message.bondingCurveKey,
            vSolInBondingCurve: message.vSolInBondingCurve,
            marketCapSol: message.marketCapSol,
            usd_market_cap: message.usd_market_cap,  // from pump.fun via PumpPortal
            timestamp: Date.now(),
            buyCount: 0,
            sellCount: 0,
            buySolVolume: 0,
            sellSolVolume: 0
        };

        // Update stats
        this.stats.totalTokens++;

        // Apply filter
        const filterResult = this.checkTokenFilter(token);
        token.passedFilter = filterResult.passed;
        token.filterReason = filterResult.reason;

        // Keep small in-memory cache (all tokens)
        this.recentTokens.unshift(token);
        if (this.recentTokens.length > this.maxRecentTokens) {
            this.recentTokens = this.recentTokens.slice(0, this.maxRecentTokens);
        }

        // If token passed filter, add to filtered cache and log
        if (filterResult.passed) {
            this.stats.filteredTokens++;

            this.recentFilteredTokens.unshift(token);
            if (this.recentFilteredTokens.length > this.maxRecentFilteredTokens) {
                this.recentFilteredTokens = this.recentFilteredTokens.slice(0, this.maxRecentFilteredTokens);
            }

            // Save to SQLite database (only filtered tokens)
            try {
                await tokenDb.token.upsert({
                    where: { tokenAddress: token.mint },
                    create: {
                        tokenAddress: token.mint,
                        tokenName: token.name,
                        tokenSymbol: token.symbol,
                        description: token.description,
                        imageUri: token.imageUri,
                        bondingCurveKey: token.bondingCurveKey,
                        marketCapSol: token.marketCapSol,
                        vSolInBondingCurve: token.vSolInBondingCurve,
                        liquidityUsd: (() => {
                            // Derive USD from pump.fun's own data — no external price API needed
                            const mcUsd = token.usd_market_cap || 0;
                            const mcSol = token.marketCapSol || 0;
                            const sol = token.vSolInBondingCurve || 0;
                            if (mcUsd > 0 && mcSol > 0 && sol > 0) {
                                return Math.round((sol / mcSol) * mcUsd);
                            }
                            return null; // don't guess
                        })(),
                        dex: 'pumpfun',
                        source: 'pumpportal',
                        isBonded: false
                    },
                    update: {
                        lastUpdatedAt: new Date()
                    }
                });
            } catch (err) {
                // Ignore DB errors
            }

            // Subscribe to trades for filtered tokens
            this.subscribeToTokenTrades(token.mint);

            // Seed market-cap tracking. IMPORTANT (2026-06-12): the creation MC is NOT
            // pushed into history — history holds TRADED prices only. Measuring change
            // from the pre-trade launch MC inflated "5m %" with phantom gains: dev
            // bundle buys land in the same instant as launch, so a token showed +100%
            // that no buyer could capture (trackers measure from the first traded
            // candle). Momentum was buying those spikes and eating the dump.
            if (token.marketCapSol && token.marketCapSol > 0) {
                const now = Date.now();
                this.marketStats.set(token.mint, {
                    initialMc: token.marketCapSol, // kept for reference only
                    history: [],
                    lastTs: now,
                });
                this.pruneMarketStats();
            }

            // Fetch socials (twitter/telegram/website) from the token's metadata URI —
            // fire-and-forget so it never blocks the WebSocket loop. The promise is
            // kept so the social-requirement filter can await it (2026-06-11).
            const socialsPromise = this.enrichSocials(token).catch(() => { });
            this.socialsPromises.set(token.mint, socialsPromise);
            if (this.socialsPromises.size > 1000) {
                const oldest = this.socialsPromises.keys().next().value;
                if (oldest) this.socialsPromises.delete(oldest);
            }

            // Log filtered token with details
            const liq = token.vSolInBondingCurve?.toFixed(2) || '?';
            const mc = token.marketCapSol?.toFixed(2) || '?';
            console.log(`✅ ${token.symbol} | ${token.name} | Liq: ${liq} SOL | MC: ${mc} SOL | ${token.mint.slice(0, 8)}...`);

            // Check and trigger auto-snipe for tokens that passed filter
            // This runs asynchronously and won't block the main WebSocket loop
            this.checkAndTriggerAutoSnipe(token).catch(err => {
                console.error('Error in auto-snipe check:', err);
            });
        } else {
            // Token was rejected
            this.stats.rejectedTokens++;
            const reason = filterResult.reason || 'unknown';
            this.stats.rejectionReasons[reason] = (this.stats.rejectionReasons[reason] || 0) + 1;

            // Log rejection at debug level (less noisy) - uncomment to see rejections
            // console.log(`🚫 ${token.symbol} rejected: ${reason}`);
        }
    }

    private async handleTradeEvent(message: any) {
        const mint = message.mint;
        const solAmount = message.solAmount || 0;
        const isBuy = message.txType === 'buy';

        // Update in-memory caches - skip DB updates to avoid connection pool exhaustion
        const updateToken = (t: PumpPortalToken) => {
            if (isBuy) {
                t.buyCount = (t.buyCount || 0) + 1;
                t.buySolVolume = (t.buySolVolume || 0) + solAmount;
            } else {
                t.sellCount = (t.sellCount || 0) + 1;
                t.sellSolVolume = (t.sellSolVolume || 0) + solAmount;
            }
            t.lastTradeAt = Date.now();
        };

        // Update both caches
        const cached = this.recentTokens.find(t => t.mint === mint);
        if (cached) updateToken(cached);

        const filteredCached = this.recentFilteredTokens.find(t => t.mint === mint);
        if (filteredCached) updateToken(filteredCached);

        // Record market-cap point for bonding-curve price change. PumpPortal sends the
        // post-trade marketCapSol on every trade event (price ∝ marketCapSol).
        const mc = typeof message.marketCapSol === 'number' ? message.marketCapSol : undefined;
        if (mc && mc > 0) {
            const now = Date.now();
            let s = this.marketStats.get(mint);
            if (!s) {
                // Token not seeded (e.g. existed before restart) — start tracking from now.
                s = { initialMc: mc, history: [], lastTs: now };
                this.marketStats.set(mint, s);
                this.pruneMarketStats();
            }
            s.history.push({ ts: now, mc });
            s.lastTs = now;
            // Prune: drop points older than 24h, cap to 240 samples per token.
            const cutoff = now - 24 * 60 * 60 * 1000;
            while (s.history.length > 1 && s.history[0].ts < cutoff) s.history.shift();
            if (s.history.length > 240) s.history.splice(0, s.history.length - 240);
            // Keep the in-memory token's current market cap fresh too.
            if (cached) cached.marketCapSol = mc;
            if (filteredCached) filteredCached.marketCapSol = mc;
        }
    }

    /**
     * Fetch a token's socials from its metadata URI (pump.fun metadata JSON has
     * twitter/telegram/website at top level) and persist them. Cached per-mint, with a
     * short timeout; failures are silent (socials stay null).
     */
    private async enrichSocials(token: PumpPortalToken): Promise<void> {
        if (!token.uri || this.socialsFetched.has(token.mint)) return;
        this.socialsFetched.add(token.mint);
        if (this.socialsFetched.size > 5000) {
            // keep the set bounded
            const it = this.socialsFetched.values().next().value;
            if (it) this.socialsFetched.delete(it);
        }
        try {
            const resp = await fetch(token.uri, { signal: AbortSignal.timeout(5000) });
            if (!resp.ok) return;
            const meta: any = await resp.json();
            const twitter = meta?.twitter || meta?.twitter_url || null;
            const telegram = meta?.telegram || meta?.telegram_url || null;
            const website = meta?.website || meta?.website_url || null;
            if (!twitter && !telegram && !website) return;

            const apply = (t?: PumpPortalToken) => { if (t) { t.twitter = twitter; t.telegram = telegram; t.website = website; } };
            apply(this.recentTokens.find((x) => x.mint === token.mint));
            apply(this.recentFilteredTokens.find((x) => x.mint === token.mint));
            await tokenDb.token.update({
                where: { tokenAddress: token.mint },
                data: { twitter, telegram, website },
            }).catch(() => { });
            console.log(`🔗 Socials for ${token.symbol}: ${[twitter && 'X', telegram && 'TG', website && 'web'].filter(Boolean).join(' ')}`);
        } catch { /* network/parse error — leave socials null */ }
    }

    /** Evict oldest-updated market-stat entries when the map grows past the cap. */
    private pruneMarketStats(): void {
        if (this.marketStats.size <= this.maxMarketStats) return;
        let oldestKey: string | null = null;
        let oldestTs = Infinity;
        for (const [k, v] of this.marketStats) {
            if (v.lastTs < oldestTs) { oldestTs = v.lastTs; oldestKey = k; }
        }
        if (oldestKey) this.marketStats.delete(oldestKey);
    }

    /**
     * Bonding-curve price change for a token, derived from PumpPortal market-cap
     * history (price ∝ marketCapSol for pump.fun's fixed supply). History contains
     * TRADED prices only (2026-06-12): for each window we compare the current market
     * cap to the traded price as of (now − window); if trading is younger than the
     * window, the baseline is the FIRST TRADE — the same convention trackers use.
     * The old launch-MC baseline reported phantom gains (dev bundles spike the MC in
     * the same instant as launch) that momentum kept buying into.
     * Returns null with fewer than two trades — change is unmeasurable.
     */
    getMarketStats(mint: string): {
        priceChange5m: number | null;
        priceChange1h: number | null;
        priceChange24h: number | null;
        currentMarketCapSol: number;
    } | null {
        const s = this.marketStats.get(mint);
        // Need at least two trades — a single trade has nothing to measure against.
        if (!s || s.history.length < 2) return null;
        const now = Date.now();
        const cur = s.history[s.history.length - 1].mc;
        if (!cur || cur <= 0) return null;
        const changeOver = (windowMs: number): number | null => {
            const cutoff = now - windowMs;
            let baseline: number | null = null;
            for (const p of s.history) {
                if (p.ts <= cutoff) baseline = p.mc; else break;
            }
            // No trade old enough for this window → measure since the FIRST trade
            // (capturable price), never since the pre-trade launch curve.
            if (baseline == null) baseline = s.history[0].mc;
            if (!baseline || baseline <= 0) return null;
            return ((cur - baseline) / baseline) * 100;
        };
        return {
            priceChange5m: changeOver(5 * 60 * 1000),
            priceChange1h: changeOver(60 * 60 * 1000),
            priceChange24h: changeOver(24 * 60 * 60 * 1000),
            currentMarketCapSol: cur,
        };
    }

    private subscribeToTokenTrades(mint: string) {
        if (this.tradingTokens.has(mint) || !this.ws || !this.isConnected) return;

        if (this.tradingTokens.size >= 200) {
            const oldest = this.tradingTokens.values().next().value;
            if (oldest) {
                this.ws.send(JSON.stringify({
                    method: 'unsubscribeTokenTrade',
                    keys: [oldest]
                }));
                this.tradingTokens.delete(oldest);
            }
        }

        this.ws.send(JSON.stringify({
            method: 'subscribeTokenTrade',
            keys: [mint]
        }));
        this.tradingTokens.add(mint);
    }

    private scheduleReconnect() {
        this.reconnectAttempts++;
        // Exponential backoff: 5s, 10s, 20s, 40s, capped at 60s
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
        console.log(`🔄 Reconnecting to PumpPortal in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    /**
     * Get newest unbonded tokens from database
     */
    async getNewTokens(limit: number = 20): Promise<PumpPortalToken[]> {
        try {
            const tokens = await tokenDb.token.findMany({
                where: {
                    isBonded: false,
                },
                orderBy: { createdAt: 'desc' },
                take: limit
            });

            return tokens.map((t: any) => ({
                mint: t.tokenAddress,
                name: t.tokenName || 'Unknown',
                symbol: t.tokenSymbol || 'UNKNOWN',
                description: t.description || undefined,
                imageUri: t.imageUri || undefined,
                bondingCurveKey: t.bondingCurveKey || undefined,
                marketCapSol: t.marketCapSol ? Number(t.marketCapSol) : undefined,
                vSolInBondingCurve: t.vSolInBondingCurve ? Number(t.vSolInBondingCurve) : undefined,
                timestamp: t.createdAt.getTime(),
                buyCount: t.buyCount,
                sellCount: t.sellCount,
                buySolVolume: Number(t.buySolVolume),
                sellSolVolume: Number(t.sellSolVolume),
                twitter: (t as any).twitter || null,
                telegram: (t as any).telegram || null,
                website: (t as any).website || null
            }));
        } catch (err) {
            console.error('Error fetching tokens from DB:', err);
            // Fallback to in-memory cache
            return this.recentTokens.slice(0, limit);
        }
    }

    /**
     * Get trending tokens sorted by activity
     */
    async getTrendingTokens(limit: number = 20): Promise<PumpPortalToken[]> {
        try {
            const tokens = await tokenDb.token.findMany({
                where: {
                    isBonded: false,
                    // This service only ever writes dex:'pumpfun' — the old 'bonkisfun'
                    // value was never written, so the query always returned [] (audit §1.4)
                    dex: 'pumpfun'
                },
                orderBy: [
                    { buyCount: 'desc' },
                    { buySolVolume: 'desc' }
                ],
                take: limit
            });

            return tokens.map((t: any) => {
                const recencyBonus = Math.max(0, 1 - (Date.now() - t.createdAt.getTime()) / (60 * 60 * 1000));
                const trendingScore = t.buyCount * 2 + Number(t.buySolVolume) * 10 + recencyBonus * 5;

                return {
                    mint: t.tokenAddress,
                    name: t.tokenName || 'Unknown',
                    symbol: t.tokenSymbol || 'UNKNOWN',
                    description: t.description || undefined,
                    imageUri: t.imageUri || undefined,
                    bondingCurveKey: t.bondingCurveKey || undefined,
                    marketCapSol: t.marketCapSol ? Number(t.marketCapSol) : undefined,
                    vSolInBondingCurve: t.vSolInBondingCurve ? Number(t.vSolInBondingCurve) : undefined,
                    timestamp: t.createdAt.getTime(),
                    buyCount: t.buyCount,
                    sellCount: t.sellCount,
                    buySolVolume: Number(t.buySolVolume),
                    sellSolVolume: Number(t.sellSolVolume),
                    trendingScore
                };
            }).sort((a: any, b: any) => (b.trendingScore || 0) - (a.trendingScore || 0));
        } catch (err) {
            console.error('Error fetching trending tokens from DB:', err);
            return this.recentFilteredTokens.slice(0, limit);
        }
    }

    /**
     * Get tokens filtered by custom criteria (for API endpoint)
     */
    async getFilteredTokens(options: {
        limit?: number;
        minLiquidity?: number;
        maxLiquidity?: number;
        minMarketCap?: number;
        maxMarketCap?: number;
        minBuyCount?: number;
        maxAgeMs?: number;
        sortBy?: 'newest' | 'trending' | 'volume';
    } = {}): Promise<{ tokens: PumpPortalToken[]; total: number; stats: any }> {
        const {
            limit = 20,
            minLiquidity = 0,
            maxLiquidity = Infinity,
            minMarketCap = 0,
            maxMarketCap = Infinity,
            minBuyCount = 0,
            maxAgeMs = Infinity,
            sortBy = 'newest'
        } = options;

        // Use in-memory filtered cache for speed, then apply additional filters
        let tokens = [...this.recentFilteredTokens];

        // Apply additional filters
        tokens = tokens.filter(t => {
            const liq = t.vSolInBondingCurve || 0;
            const mc = t.marketCapSol || 0;
            const buys = t.buyCount || 0;
            const age = Date.now() - (t.timestamp || 0);

            if (liq < minLiquidity || liq > maxLiquidity) return false;
            if (mc < minMarketCap || mc > maxMarketCap) return false;
            if (buys < minBuyCount) return false;
            if (age > maxAgeMs) return false;

            return true;
        });

        // Sort
        if (sortBy === 'trending') {
            tokens.sort((a, b) => (b.buyCount || 0) - (a.buyCount || 0));
        } else if (sortBy === 'volume') {
            tokens.sort((a, b) => (b.buySolVolume || 0) - (a.buySolVolume || 0));
        } else {
            // newest - already sorted by timestamp
        }

        const total = tokens.length;
        tokens = tokens.slice(0, limit);

        return {
            tokens,
            total,
            stats: this.getStats()
        };
    }

    /**
     * Get live token feed with real-time filtering
     */
    getLiveFeed(limit: number = 20): PumpPortalToken[] {
        return this.recentFilteredTokens.slice(0, limit).map(t => ({
            ...t,
            age: Date.now() - (t.timestamp || 0)
        } as any));
    }

    /**
     * Get token by address from database
     */
    async getToken(address: string): Promise<PumpPortalToken | null> {
        try {
            const token = await tokenDb.token.findUnique({
                where: { tokenAddress: address }
            });

            if (!token) return null;

            return {
                mint: token.tokenAddress,
                name: token.tokenName || 'Unknown',
                symbol: token.tokenSymbol || 'UNKNOWN',
                description: token.description || undefined,
                imageUri: token.imageUri || undefined,
                bondingCurveKey: token.bondingCurveKey || undefined,
                marketCapSol: token.marketCapSol ? Number(token.marketCapSol) : undefined,
                vSolInBondingCurve: token.vSolInBondingCurve ? Number(token.vSolInBondingCurve) : undefined,
                timestamp: token.createdAt.getTime(),
                buyCount: token.buyCount,
                sellCount: token.sellCount,
                buySolVolume: Number(token.buySolVolume),
                sellSolVolume: Number(token.sellSolVolume)
            };
        } catch {
            return null;
        }
    }

    isWebSocketConnected(): boolean {
        return this.isConnected;
    }

    getTokenCount(): number {
        return this.recentTokens.length;
    }

    /**
     * Get the EnhancedSniperService instance (for external use)
     */
    getEnhancedSniperService(): EnhancedSniperService | null {
        return this.enhancedSniperService;
    }
}

export const pumpPortalService = new PumpPortalService();
export type { PumpPortalToken };
