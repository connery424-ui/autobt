/**
 * PumpFun / PumpSwap Service
 * 
 * Handles interactions with the PumpFun DEX for:
 * - Pre-bonded token discovery and filtering
 * - Token purchases during bonding curve
 * - Migration detection
 * 
 * Also includes LaunchLab integration for Raydium launchpad tokens
 */

import axios from 'axios';
import { Connection, PublicKey, VersionedTransaction, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';

// PumpFun Program ID
export const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// LaunchLab Program ID (Raydium's launch platform)
export const LAUNCHLAB_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

export interface PumpFunToken {
    mint: string;
    name: string;
    symbol: string;
    description?: string;
    image_uri?: string;
    metadata_uri?: string;
    twitter?: string;
    telegram?: string;
    website?: string;

    // Bonding curve info
    bonding_curve: string;
    associated_bonding_curve: string;
    virtual_sol_reserves: number;
    virtual_token_reserves: number;
    total_supply: number;

    // Market data
    market_cap: number; // in SOL
    usd_market_cap?: number;
    complete: boolean; // true = migrated to Raydium

    // Creator info
    creator: string;

    // Timestamps
    created_timestamp: number;

    // Trading stats
    reply_count?: number;
    last_trade_timestamp?: number;

    // Calculated fields
    price_sol?: number;
    bonding_progress?: number; // 0-100%
}

export interface LaunchLabToken {
    poolAddress: string;
    tokenMint: string;
    tokenName: string;
    tokenSymbol: string;
    tokenDecimals: number;
    tokenLogo?: string;

    // Market data
    liquidity: number;
    volume24h: number;
    priceUsd?: number;
    marketCap?: number;

    // Social links
    website?: string;
    twitter?: string;
    telegram?: string;

    // Status
    status: 'presale' | 'live' | 'completed';
    launchTime?: number;

    // Progress for presale tokens
    presaleProgress?: number;
    softCap?: number;
    hardCap?: number;
    raised?: number;

    // Canonical venue this token actually trades on (audit §6.2).
    // DexScreener returns BOTH raydium and launchlab pairs from this fetch path —
    // previously everything was mislabeled launchlab.
    source?: 'launchlab' | 'raydium';
}

export interface TokenFilters {
    // Source filters
    includePumpfun: boolean;
    includeLaunchlab: boolean;
    includeRaydium: boolean;

    // Pre-bonded filters (PumpFun specific)
    preBondedOnly: boolean;
    postBondedOnly: boolean;

    // Market cap filters (in SOL for PumpFun, USD for others)
    minMarketCap?: number;
    maxMarketCap?: number;

    // Volume filters
    minVolume24h?: number;
    maxVolume24h?: number;

    // Liquidity filters
    minLiquidity?: number;
    maxLiquidity?: number;

    // Age filters
    maxAgeMinutes?: number;
    minAgeMinutes?: number;

    // Social filters
    hasTwitter?: boolean;
    hasTelegram?: boolean;
    hasWebsite?: boolean;

    // Safety filters
    mintAuthorityRevoked?: boolean;
    freezeAuthorityRevoked?: boolean;

    // Sorting
    sortBy: 'created' | 'market_cap' | 'volume' | 'last_trade' | 'bonding_progress';
    sortDirection: 'asc' | 'desc';

    // Pagination
    limit: number;
    offset: number;
}

const DEFAULT_FILTERS: TokenFilters = {
    includePumpfun: true,
    includeLaunchlab: true,
    includeRaydium: false,
    preBondedOnly: false,
    postBondedOnly: false,
    sortBy: 'created',
    sortDirection: 'desc',
    limit: 100,
    offset: 0,
};

export class PumpFunService {
    private rpcEndpoint: string;
    private rpcApiKey: string;
    private connection: InstanceType<typeof Connection>;

    // Cache to prevent rate limiting
    private tokenCache: PumpFunToken[] = [];
    private launchLabCache: LaunchLabToken[] = [];
    private lastFetchTime: number = 0;
    private lastLaunchLabFetchTime: number = 0;
    private readonly CACHE_TTL_MS = 30000; // 30 seconds cache

    // SOL/USD price derived from DexScreener's own priceUsd/priceNative ratio
    private lastKnownSolPrice: number | null = null;

    getLastKnownSolPrice(): number | null { return this.lastKnownSolPrice; }

    constructor(rpcEndpoint?: string, rpcApiKey?: string) {
        const heliusKey = process.env.HELIUS_API_KEY || process.env.VITE_HELIUS_API_KEY;
        const heliusNetwork = process.env.SOLANA_NETWORK || 'mainnet';
        const heliusRpc = heliusKey ? `https://${heliusNetwork}.helius-rpc.com/?api-key=${heliusKey}` : null;

        this.rpcEndpoint = rpcEndpoint || heliusRpc || process.env.TAVAHIN_RPC_URL || 'https://api.mainnet-beta.solana.com';
        this.rpcApiKey = rpcApiKey || process.env.TAVAHIN_API_KEY || '';
        this.connection = new Connection(this.rpcEndpoint, 'confirmed');
    }


    /**
     * Fetch PumpFun tokens with filters
     * Uses DexScreener API (verified working) as primary source
     * Includes 30-second cache to prevent rate limiting
     */
    async getPumpFunTokens(filters: Partial<TokenFilters> = {}): Promise<PumpFunToken[]> {
        const mergedFilters = { ...DEFAULT_FILTERS, ...filters };

        // Return cached data if still valid
        const now = Date.now();
        if (this.tokenCache.length > 0 && (now - this.lastFetchTime) < this.CACHE_TTL_MS) {
            console.log(`📦 Using cached tokens (${this.tokenCache.length} tokens, ${Math.round((this.CACHE_TTL_MS - (now - this.lastFetchTime)) / 1000)}s remaining)`);
            let filtered = this.applyPumpFunFilters(this.tokenCache, mergedFilters);
            filtered = this.sortTokens(filtered, mergedFilters.sortBy, mergedFilters.sortDirection);
            return filtered.slice(0, mergedFilters.limit);
        }

        try {
            const tokens: PumpFunToken[] = [];

            // pump.fun frontend-api v3 — the live Explore feed. Publicly readable
            // (no auth/cookies needed, verified server-side). /coins/recommended is
            // the default board; /coins/latest adds fresh mints. Browser-like headers
            // are required. Local sortTokens/applyPumpFunFilters handle ranking, so we
            // don't pass a sort param. Rate limit is 60 req/min/IP — the 30s cache keeps
            // us far under that.
            try {
                const V3 = 'https://frontend-api-v3.pump.fun';
                const browserHeaders = {
                    'Accept': 'application/json',
                    'Accept-Language': 'en-US,en;q=0.6',
                    'Origin': 'https://pump.fun',
                    'Referer': 'https://pump.fun/',
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                };
                const lim = Math.min(Math.max(mergedFilters.limit || 50, 1), 100);
                const urls = [
                    `${V3}/coins/recommended?limit=${lim}&includeNsfw=false&platform=WEB&caller=WEB`,
                    `${V3}/coins/latest?offset=0&limit=${lim}&includeNsfw=false`,
                ];
                const seen = new Set<string>();
                for (const url of urls) {
                    try {
                        const response = await axios.get(url, { timeout: 15000, headers: browserHeaders });
                        const arr = Array.isArray(response.data) ? response.data
                            : Array.isArray(response.data?.data) ? response.data.data : [];
                        for (const coin of arr) {
                            if (!coin?.mint || seen.has(coin.mint)) continue;
                            seen.add(coin.mint);
                            tokens.push(this.transformPumpFunToken(coin));
                        }
                    } catch (e) {
                        console.warn(`pump.fun v3 ${url.split('?')[0]} failed:`, (e as Error).message);
                    }
                }
                if (tokens.length > 0) {
                    console.log(`✅ Fetched ${tokens.length} tokens from pump.fun frontend-api-v3`);
                } else {
                    throw new Error('frontend-api-v3 returned no tokens');
                }
            } catch (pumpError) {
                console.warn('pump.fun v3 API error, falling back to DexScreener:', (pumpError as Error).message);

                // Fallback: DexScreener (returns graduated pairs, less ideal)
                try {
                    const dexScreenerUrl = 'https://api.dexscreener.com/latest/dex/search?q=pump';
                    const response = await axios.get(dexScreenerUrl, {
                        timeout: 15000,
                        headers: { 'Accept': 'application/json', 'User-Agent': 'AutoBotAPP/1.0' }
                    });
                    if (response.data?.pairs && Array.isArray(response.data.pairs)) {
                        const solanaPairs = response.data.pairs
                            .filter((pair: any) => pair.chainId === 'solana')
                            .slice(0, mergedFilters.limit);
                        for (const pair of solanaPairs) {
                            tokens.push(this.transformDexScreenerToPumpFun(pair));
                        }
                    }
                } catch (dexError) {
                    console.warn('DexScreener fallback also failed:', (dexError as Error).message);
                }
            }

            // Apply filters
            let filtered = this.applyPumpFunFilters(tokens, mergedFilters);

            // Sort
            filtered = this.sortTokens(filtered, mergedFilters.sortBy, mergedFilters.sortDirection);

            // Update cache
            if (tokens.length > 0) {
                this.tokenCache = tokens;
                this.lastFetchTime = Date.now();
            }

            console.log(`✅ Fetched ${filtered.length} tokens from pump.fun (cached for 30s)`);
            return filtered.slice(0, mergedFilters.limit);
        } catch (error) {
            console.error('Error fetching tokens:', (error as Error).message);
            // Return cached data on error if available
            if (this.tokenCache.length > 0) {
                console.log(`⚠️ API error, using ${this.tokenCache.length} cached tokens`);
                return this.tokenCache.slice(0, mergedFilters.limit);

            }
            return [];
        }
    }

    /**
     * Transform DexScreener pair data to PumpFunToken format
     */
    private transformDexScreenerToPumpFun(pair: any): PumpFunToken {
        const priceUsd = parseFloat(pair.priceUsd || '0');
        const priceNativeSol = parseFloat(pair.priceNative || '0'); // price in SOL
        const liquidityUsd = pair.liquidity?.usd || 0;
        const marketCapUsd = pair.fdv || pair.marketCap || 0;
        const createdAt = pair.pairCreatedAt || Date.now();

        // Derive SOL/USD price from DexScreener's own token pricing:
        // If priceUsd and priceNative differ, their ratio = USD per SOL (e.g. 0.001754 / 0.0000204 = $86/SOL)
        let impliedSolPrice = 0;
        if (priceNativeSol > 0 && priceUsd > 0 && Math.abs(priceUsd - priceNativeSol) > priceNativeSol * 0.01) {
            impliedSolPrice = priceUsd / priceNativeSol; // USD/SOL
            if (impliedSolPrice > 1 && impliedSolPrice < 100000) {
                this.lastKnownSolPrice = impliedSolPrice; // update service-level cache
            }
        }

        const marketCapSol = impliedSolPrice > 0 ? marketCapUsd / impliedSolPrice : 0;
        const liquiditySol = impliedSolPrice > 0 ? liquidityUsd / 2 / impliedSolPrice : 0;

        return {
            mint: pair.baseToken?.address || '',
            name: pair.baseToken?.name || 'Unknown',
            symbol: pair.baseToken?.symbol || '???',
            description: pair.info?.description || '',
            image_uri: pair.info?.imageUrl || '',
            metadata_uri: '',
            twitter: pair.info?.socials?.find((s: any) => s.type === 'twitter')?.url || '',
            telegram: pair.info?.socials?.find((s: any) => s.type === 'telegram')?.url || '',
            website: pair.info?.websites?.[0]?.url || '',
            bonding_curve: pair.pairAddress || '',
            associated_bonding_curve: pair.pairAddress || '',
            virtual_sol_reserves: liquiditySol * 1e9, // Store in lamports
            virtual_token_reserves: 1000000000,
            total_supply: 1000000000,
            market_cap: marketCapSol,
            usd_market_cap: marketCapUsd,
            complete: false,
            creator: '',
            created_timestamp: createdAt,
            reply_count: 0,
            last_trade_timestamp: Date.now(),
            price_sol: priceNativeSol,
            bonding_progress: 100,
        };
    }

    /**
     * Fetch LaunchLab tokens with filters
     * Uses DexScreener API for Raydium launchpad tokens
     * Includes 30-second cache to prevent rate limiting
     */
    async getLaunchLabTokens(filters: Partial<TokenFilters> = {}): Promise<LaunchLabToken[]> {
        const mergedFilters = { ...DEFAULT_FILTERS, ...filters };

        // Return cached data if still valid
        const now = Date.now();
        if (this.launchLabCache.length > 0 && (now - this.lastLaunchLabFetchTime) < this.CACHE_TTL_MS) {
            console.log(`📦 Using cached Raydium tokens (${this.launchLabCache.length} tokens)`);
            return this.launchLabCache.slice(0, mergedFilters.limit);
        }

        try {
            // Use DexScreener to get Raydium pairs (LaunchLab uses Raydium)
            const response = await axios.get('https://api.dexscreener.com/latest/dex/search?q=raydium', {
                timeout: 15000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'AutoBotAPP/1.0'
                }
            });

            if (response.data?.pairs && Array.isArray(response.data.pairs)) {
                // Keep BOTH raydium and launchlab pairs, tagged with their real venue (§6.2)
                const pairs = response.data.pairs
                    .filter((pair: any) => pair.chainId === 'solana'
                        && (pair.dexId === 'raydium' || pair.dexId === 'launchlab'))
                    .slice(0, mergedFilters.limit);

                const tokens = pairs.map((pair: any) => this.transformDexScreenerToLaunchLab(pair));

                // Update cache
                if (tokens.length > 0) {
                    this.launchLabCache = tokens;
                    this.lastLaunchLabFetchTime = Date.now();
                }

                console.log(`✅ Fetched ${tokens.length} Raydium tokens from DexScreener (cached for 30s)`);
                return tokens;
            }

            return [];
        } catch (error) {
            console.warn('Error fetching Raydium tokens:', (error as Error).message);
            // Return cached data on error if available
            if (this.launchLabCache.length > 0) {
                console.log(`⚠️ API error, using ${this.launchLabCache.length} cached Raydium tokens`);
                return this.launchLabCache.slice(0, mergedFilters.limit);
            }
            return [];
        }
    }

    /**
     * Transform DexScreener pair to LaunchLabToken format
     */
    private transformDexScreenerToLaunchLab(pair: any): LaunchLabToken {
        return {
            // Real venue from DexScreener — 'raydium' pairs are NOT launchlab (§6.2)
            source: pair.dexId === 'launchlab' ? 'launchlab' : 'raydium',
            poolAddress: pair.pairAddress || '',
            tokenMint: pair.baseToken?.address || '',
            tokenName: pair.baseToken?.name || 'Unknown',
            tokenSymbol: pair.baseToken?.symbol || '???',
            tokenDecimals: 9,
            tokenLogo: pair.info?.imageUrl || '',
            liquidity: pair.liquidity?.usd || 0,
            volume24h: pair.volume?.h24 || 0,
            priceUsd: parseFloat(pair.priceUsd || '0'),
            marketCap: pair.fdv || pair.marketCap || 0,
            website: pair.info?.websites?.[0]?.url || '',
            twitter: pair.info?.socials?.find((s: any) => s.type === 'twitter')?.url || '',
            telegram: pair.info?.socials?.find((s: any) => s.type === 'telegram')?.url || '',
            status: 'live',
            launchTime: pair.pairCreatedAt || Date.now(),
            presaleProgress: 100,
        };
    }

    /**
     * Get combined token feed from all sources
     */
    async getCombinedTokenFeed(filters: Partial<TokenFilters> = {}): Promise<(PumpFunToken | LaunchLabToken)[]> {
        const mergedFilters = { ...DEFAULT_FILTERS, ...filters };
        const results: (PumpFunToken | LaunchLabToken)[] = [];

        const promises: Promise<void>[] = [];

        if (mergedFilters.includePumpfun) {
            promises.push(
                this.getPumpFunTokens(mergedFilters).then(tokens => {
                    results.push(...tokens);
                })
            );
        }

        if (mergedFilters.includeLaunchlab) {
            promises.push(
                this.getLaunchLabTokens(mergedFilters).then(tokens => {
                    results.push(...tokens);
                })
            );
        }

        await Promise.all(promises);

        // Sort combined results
        return results.sort((a, b) => {
            const aTime = 'created_timestamp' in a ? a.created_timestamp : (a as LaunchLabToken).launchTime || 0;
            const bTime = 'created_timestamp' in b ? b.created_timestamp : (b as LaunchLabToken).launchTime || 0;
            return mergedFilters.sortDirection === 'desc' ? bTime - aTime : aTime - bTime;
        }).slice(0, mergedFilters.limit);
    }

    // ─── PUMP.FUN ON-CHAIN CONSTANTS ────────────────────────────────────────────
    private static readonly PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    private static readonly PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
    private static readonly PUMP_FEE_ACCT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
    private static readonly PUMP_FEE_PROG = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
    private static readonly TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    // Global fee-vault account owned by the Pump Fees Program. Extracted from a
    // verified on-chain Token-2022 sell (tx 5u5mYNC3...h1gX, account slot 15).
    // Required as the 16th account of `sell` on cashback-era tokens; NOT in the
    // published on-chain IDL (which still lists only 14 accounts).
    private static readonly PUMP_FEE_VAULT = new PublicKey('A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW');
    private static readonly SPL_TOKEN_PROG = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    private static readonly BUY_DISC = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
    private static readonly SELL_DISC = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

    // ─── PDA DERIVATIONS ─────────────────────────────────────────────────────
    private static pda(seeds: (Buffer | Uint8Array)[], program: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync(seeds, program)[0];
    }
    private static bondingCurvePda(mint: PublicKey) { return PumpFunService.pda([Buffer.from('bonding-curve'), mint.toBytes()], PumpFunService.PUMP_PROGRAM); }
    private static bondingCurveV2Pda(mint: PublicKey) { return PumpFunService.pda([Buffer.from('bonding-curve-v2'), mint.toBytes()], PumpFunService.PUMP_PROGRAM); }
    private static creatorVaultPda(creator: PublicKey) { return PumpFunService.pda([Buffer.from('creator-vault'), creator.toBytes()], PumpFunService.PUMP_PROGRAM); }
    private static globalVolAccPda() { return PumpFunService.pda([Buffer.from('global_volume_accumulator')], PumpFunService.PUMP_PROGRAM); }
    private static userVolAccPda(user: PublicKey) { return PumpFunService.pda([Buffer.from('user_volume_accumulator'), user.toBytes()], PumpFunService.PUMP_PROGRAM); }
    private static feeConfigPda() { return PumpFunService.pda([Buffer.from('fee_config'), PumpFunService.PUMP_PROGRAM.toBytes()], PumpFunService.PUMP_FEE_PROG); }
    private static eventAuthorityPda() { return PumpFunService.pda([Buffer.from('__event_authority')], PumpFunService.PUMP_PROGRAM); }

    /**
     * Parse pump.fun bonding curve account:
     * [8]  discriminator
     * [8]  virtualTokenReserves  [8] virtualSolReserves
     * [8]  realTokenReserves     [8] realSolReserves
     * [8]  tokenTotalSupply      [1] complete
     * [32] creator (V2+)        [1] is_mayhem_mode (Token2022+)
     */
    private static parseBondingCurve(data: Buffer) {
        if (data.length < 49) throw new Error('Bonding curve data too short');
        const virtualTokenReserves = data.readBigInt64LE(8);
        const virtualSolReserves = data.readBigInt64LE(16);
        const complete = data[48] !== 0;
        const creator = data.length >= 81 ? new PublicKey(data.slice(49, 81)) : null;
        const isMayhemMode = creator !== null && data.length >= 82 ? data[81] !== 0 : false;
        return { virtualTokenReserves, virtualSolReserves, complete, creator, isMayhemMode };
    }

    /** Get fee recipient — mayhem mode reads reserved_fee_recipient from pump global at offset 483 */
    private async _feeRecipient(isMayhem: boolean): Promise<PublicKey> {
        if (!isMayhem) return PumpFunService.PUMP_FEE_ACCT;
        try {
            const info = await this.connection.getAccountInfo(PumpFunService.PUMP_GLOBAL);
            if (info && info.data.length >= 515) return new PublicKey(info.data.slice(483, 515));
        } catch { }
        return PumpFunService.PUMP_FEE_ACCT;
    }

    /** Detect if mint uses Token2022 */
    private async _tokenProgram(mint: PublicKey): Promise<PublicKey> {
        try {
            const info = await this.connection.getAccountInfo(mint);
            return info?.owner.toBase58() === PumpFunService.TOKEN_2022.toBase58()
                ? PumpFunService.TOKEN_2022
                : PumpFunService.SPL_TOKEN_PROG;
        } catch {
            return PumpFunService.SPL_TOKEN_PROG;
        }
    }

    /**
     * Buy token on PumpFun — DIRECT ON-CHAIN
     *
     * Dual-path based on token type (detected via mint owner):
     *   SPL tokens    → 12-account layout (legacy, verified from decoded_buy_tx_from_getTransaction.json)
     *   Token2022     → 17-account layout V2 (required by pump.fun for Token2022 mints)
     *
     * Returns raw instructions + connection + payerKey so the caller can build the
     * VersionedTransaction with a FRESH blockhash right before signing/broadcasting.
     * This avoids blockhash expiry caused by the latency between here and signAndSend.
     */
    async buyPumpFunToken(
        tokenMint: string,
        amountSol: number,
        slippageBps: number,
        walletPublicKey: string,
    ): Promise<{ transaction: InstanceType<typeof VersionedTransaction>; instructions: any[]; connection: any; payerKey: any; quote: any } | null> {
        const { VersionedTransaction: VT, TransactionMessage: TM,
            SystemProgram: SP, SYSVAR_RENT_PUBKEY: RENT,
            ComputeBudgetProgram: CBP, TransactionInstruction: TI } = await import('@solana/web3.js');
        const { getAssociatedTokenAddressSync: gATA, createAssociatedTokenAccountInstruction: cATA,
            ASSOCIATED_TOKEN_PROGRAM_ID: ATPK } = await import('@solana/spl-token');

        const mint = new PublicKey(tokenMint);
        const buyer = new PublicKey(walletPublicKey);
        const conn = this.connection;

        // 1. Read bonding curve
        const curvePda = PumpFunService.bondingCurvePda(mint);
        const curveAcct = await conn.getAccountInfo(curvePda);
        if (!curveAcct) throw new Error(`Bonding curve not found for ${tokenMint} — may have graduated`);

        const curve = PumpFunService.parseBondingCurve(Buffer.from(curveAcct.data));
        if (curve.complete) throw new Error('Token has graduated — use PumpSwap');

        // 2. AMM formula
        const solLamports = BigInt(Math.floor(amountSol * 1e9));
        const tokensOut = (solLamports * curve.virtualTokenReserves) / (curve.virtualSolReserves + solLamports);
        const maxSolCost = (solLamports * BigInt(10000 + slippageBps)) / 10000n;
        const minTokens = (tokensOut * BigInt(10000 - slippageBps)) / 10000n;

        // 3. Detect token program and derive accounts
        const tokenProg = await this._tokenProgram(mint);
        const isToken2022 = tokenProg.toBase58() === PumpFunService.TOKEN_2022.toBase58();
        const curveTokAcct = gATA(mint, curvePda, true, tokenProg);
        const buyerTokAcct = gATA(mint, buyer, false, tokenProg);
        const eventAuth = PumpFunService.eventAuthorityPda();
        const feeRecipient = await this._feeRecipient(curve.isMayhemMode);

        // V2 accounts (Token2022 only)
        const creatorVault = curve.creator ? PumpFunService.creatorVaultPda(curve.creator) : feeRecipient;
        const globalVolAcc = PumpFunService.globalVolAccPda();
        const userVolAcc = PumpFunService.userVolAccPda(buyer);
        const feeConfig = PumpFunService.feeConfigPda();
        const curveV2 = PumpFunService.bondingCurveV2Pda(mint);

        const ixs: InstanceType<typeof TI>[] = [];
        ixs.push(CBP.setComputeUnitLimit({ units: 200_000 }));
        ixs.push(CBP.setComputeUnitPrice({ microLamports: 5_000 }));

        // 4. Create ATAs if absent (idempotent)
        const curveTokInfo = await conn.getAccountInfo(curveTokAcct);
        if (!curveTokInfo) ixs.push(cATA(buyer, curveTokAcct, curvePda, mint, tokenProg, ATPK));
        const buyerTokInfo = await conn.getAccountInfo(buyerTokAcct);
        if (!buyerTokInfo) ixs.push(cATA(buyer, buyerTokAcct, buyer, mint, tokenProg, ATPK));

        // 5. Build buy instruction
        const ixData = Buffer.allocUnsafe(24);
        PumpFunService.BUY_DISC.copy(ixData, 0);
        ixData.writeBigUInt64LE(tokensOut, 8);
        ixData.writeBigUInt64LE(maxSolCost, 16);

        const baseKeys = [
            { pubkey: PumpFunService.PUMP_GLOBAL, isSigner: false, isWritable: false }, // 0: global
            { pubkey: feeRecipient, isSigner: false, isWritable: true }, // 1: feeRecipient
            { pubkey: mint, isSigner: false, isWritable: false }, // 2: mint
            { pubkey: curvePda, isSigner: false, isWritable: true }, // 3: bondingCurve
            { pubkey: curveTokAcct, isSigner: false, isWritable: true }, // 4: associatedBondingCurve
            { pubkey: buyerTokAcct, isSigner: false, isWritable: true }, // 5: associatedUser
            { pubkey: buyer, isSigner: true, isWritable: true }, // 6: user
            { pubkey: SP.programId, isSigner: false, isWritable: false }, // 7: systemProgram
            { pubkey: tokenProg, isSigner: false, isWritable: false }, // 8: tokenProgram
            { pubkey: RENT, isSigner: false, isWritable: false }, // 9: rent (SPL) OR creatorVault-placeholder slot
            { pubkey: eventAuth, isSigner: false, isWritable: false }, // 10: eventAuthority
            { pubkey: PumpFunService.PUMP_PROGRAM, isSigner: false, isWritable: false }, // 11: program
        ];

        const v2ExtraKeys = isToken2022 ? [
            { pubkey: creatorVault, isSigner: false, isWritable: true }, // 9 (overwrite): creatorVault
            { pubkey: globalVolAcc, isSigner: false, isWritable: false }, // 12: globalVolumeAccumulator
            { pubkey: userVolAcc, isSigner: false, isWritable: true }, // 13: userVolumeAccumulator
            { pubkey: feeConfig, isSigner: false, isWritable: false }, // 14: feeConfig
            { pubkey: PumpFunService.PUMP_FEE_PROG, isSigner: false, isWritable: false }, // 15: feeProgram
            { pubkey: curveV2, isSigner: false, isWritable: false }, // 16: bondingCurveV2
        ] : [];

        // For Token2022 V2: position 9 is creatorVault (not rent), 12-16 are the extras
        const keys = isToken2022
            ? [
                ...baseKeys.slice(0, 9),
                { pubkey: creatorVault, isSigner: false, isWritable: true }, // 9: creatorVault
                ...baseKeys.slice(10),   // 10: eventAuth, 11: program
                { pubkey: globalVolAcc, isSigner: false, isWritable: false },
                { pubkey: userVolAcc, isSigner: false, isWritable: true },
                { pubkey: feeConfig, isSigner: false, isWritable: false },
                { pubkey: PumpFunService.PUMP_FEE_PROG, isSigner: false, isWritable: false },
                { pubkey: curveV2, isSigner: false, isWritable: false },
            ]
            : baseKeys;

        ixs.push(new TI({ programId: PumpFunService.PUMP_PROGRAM, data: ixData, keys }));

        // 6. Build transaction with FRESH blockhash (fetched as late as possible)
        const { blockhash } = await conn.getLatestBlockhash('confirmed');
        const msg = new TM({ payerKey: buyer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const transaction = new VT(msg);

        const tokensOutNum = Number(tokensOut) / 1e6;
        console.log(`📊 On-chain buy (${isToken2022 ? 'Token2022 V2' : 'SPL'}): ${tokensOutNum.toFixed(0)} tokens for ${amountSol} SOL`);

        return {
            transaction,
            instructions: ixs,
            connection: conn,
            payerKey: buyer,
            quote: {
                tokensOut: tokensOutNum, minTokensOut: Number(minTokens) / 1e6,
                priceImpact: 0, effectivePrice: amountSol / tokensOutNum,
                tokenInfo: {
                    mint: tokenMint, name: 'Unknown', symbol: '???',
                    bonding_curve: curvePda.toBase58(),
                    associated_bonding_curve: curveTokAcct.toBase58(),
                    virtual_sol_reserves: Number(curve.virtualSolReserves),
                    virtual_token_reserves: Number(curve.virtualTokenReserves),
                    total_supply: 1_000_000_000, market_cap: 0,
                    complete: false, creator: curve.creator?.toBase58() || '',
                    created_timestamp: Date.now(),
                },
            },
        };
    }


    /**
     * Sell token on PumpFun — DIRECT ON-CHAIN
     * Mirror of buy with sell discriminator and reversed token/sol roles.
     */
    async sellPumpFunToken(
        tokenMint: string,
        tokenAmount: number,
        slippageBps: number,
        walletPublicKey: string,
    ): Promise<{ transaction: InstanceType<typeof VersionedTransaction>; quote: any } | null> {
        const { VersionedTransaction: VT, TransactionMessage: TM,
            SystemProgram: SP, SYSVAR_RENT_PUBKEY: RENT,
            ComputeBudgetProgram: CBP, TransactionInstruction: TI } = await import('@solana/web3.js');
        const { getAssociatedTokenAddressSync: gATA, ASSOCIATED_TOKEN_PROGRAM_ID: ATPK } = await import('@solana/spl-token');

        const mint = new PublicKey(tokenMint);
        const seller = new PublicKey(walletPublicKey);
        const conn = this.connection;

        const curvePda = PumpFunService.bondingCurvePda(mint);
        const curveAcct = await conn.getAccountInfo(curvePda);
        if (!curveAcct) throw new Error(`Bonding curve not found for ${tokenMint}`);

        const curve = PumpFunService.parseBondingCurve(Buffer.from(curveAcct.data));
        if (curve.complete) throw new Error('Token graduated — use PumpSwap');

        // Send the full amount. If the on-chain program overflows (error 6024),
        // the simulation halving loop below will find the max safe amount empirically.
        let tokensRaw = BigInt(Math.floor(tokenAmount * 1e6));
        let isPartialSell = false;

        const solOut = (tokensRaw * curve.virtualSolReserves) / (curve.virtualTokenReserves + tokensRaw);

        // For Token2022 tokens the pump.fun program internally handles fee routing differently
        // and throws Overflow (6024) at lib.rs:764 when minSolOut > 0. Real on-chain Token2022
        // sells always pass 0 to bypass this check. SPL tokens keep standard slippage protection.
        // minSolOut is still computed and returned in the quote for display purposes.
        const minSolOut = (solOut * BigInt(10000 - slippageBps)) / 10000n; // used for SPL & display

        const tokenProg = await this._tokenProgram(mint);
        const isToken2022 = tokenProg.toBase58() === PumpFunService.TOKEN_2022.toBase58();
        const curveTokAcct = gATA(mint, curvePda, true, tokenProg);
        const sellerTokAcct = gATA(mint, seller, false, tokenProg);
        const eventAuth = PumpFunService.eventAuthorityPda();
        const feeRecipient = await this._feeRecipient(curve.isMayhemMode);

        // V2 accounts (Token2022 only)
        const creatorVault = curve.creator ? PumpFunService.creatorVaultPda(curve.creator) : feeRecipient;
        const globalVolAcc = PumpFunService.globalVolAccPda();
        const userVolAcc = PumpFunService.userVolAccPda(seller);
        const feeConfig = PumpFunService.feeConfigPda();
        const curveV2 = PumpFunService.bondingCurveV2Pda(mint);

        const ixs: InstanceType<typeof TI>[] = [];
        ixs.push(CBP.setComputeUnitLimit({ units: 200_000 }));
        ixs.push(CBP.setComputeUnitPrice({ microLamports: 5_000 }));

        // Token2022: real on-chain sells always pass minSolOut=0 — the pump.fun program internally
        // handles fee routing for Token2022 before checking the minimum, and a non-zero value
        // triggers Overflow (6024) at lib.rs:764. SPL tokens keep slippage protection.
        const minSolOutInInstruction = isToken2022 ? 0n : minSolOut;
        const data = Buffer.allocUnsafe(24);
        PumpFunService.SELL_DISC.copy(data, 0);
        data.writeBigUInt64LE(tokensRaw, 8);
        data.writeBigUInt64LE(minSolOutInInstruction, 16);

        // SPL tokens: classic verified 12-account layout.
        // Token2022: VERIFIED 15-account layout from live on-chain sell tx:
        //   slot 8  = creatorVault  (NOT tokenProg)
        //   slot 9  = TOKEN_2022    (tokenProgram)
        //   slot 10 = eventAuthority
        //   slot 11 = PUMP_PROGRAM
        //   slot 12 = feeConfig
        //   slot 13 = PUMP_FEE_PROG
        //   slot 14 = bondingCurveV2  ← was WRONG (globalVolAcc/userVolAcc)
        let keys: { pubkey: InstanceType<typeof PublicKey>; isSigner: boolean; isWritable: boolean }[];
        if (isToken2022) {
            keys = [
                { pubkey: PumpFunService.PUMP_GLOBAL, isSigner: false, isWritable: false },  // 0: global
                { pubkey: feeRecipient, isSigner: false, isWritable: true },                  // 1: feeRecipient
                { pubkey: mint, isSigner: false, isWritable: false },                         // 2: mint
                { pubkey: curvePda, isSigner: false, isWritable: true },                      // 3: bondingCurve
                { pubkey: curveTokAcct, isSigner: false, isWritable: true },                  // 4: assocBondingCurve
                { pubkey: sellerTokAcct, isSigner: false, isWritable: true },                 // 5: assocUser
                { pubkey: seller, isSigner: true, isWritable: true },                         // 6: user/seller
                { pubkey: SP.programId, isSigner: false, isWritable: false },                 // 7: systemProgram
                { pubkey: creatorVault, isSigner: false, isWritable: true },                  // 8: creatorVault
                { pubkey: PumpFunService.TOKEN_2022, isSigner: false, isWritable: false },    // 9: tokenProgram
                { pubkey: eventAuth, isSigner: false, isWritable: false },                    // 10: eventAuthority
                { pubkey: PumpFunService.PUMP_PROGRAM, isSigner: false, isWritable: false },  // 11: program
                { pubkey: feeConfig, isSigner: false, isWritable: false },                    // 12: feeConfig
                { pubkey: PumpFunService.PUMP_FEE_PROG, isSigner: false, isWritable: false }, // 13: feeProgram
                { pubkey: curveV2, isSigner: false, isWritable: true },                       // 14: bondingCurveV2 (w)
                { pubkey: PumpFunService.PUMP_FEE_VAULT, isSigner: false, isWritable: true }, // 15: feeVault (w) — ground truth from working tx
            ];
        } else {
            // Classic SPL sell — 12-account layout verified from prior txs
            const { SYSVAR_RENT_PUBKEY: RENT } = await import('@solana/web3.js');
            keys = [
                { pubkey: PumpFunService.PUMP_GLOBAL, isSigner: false, isWritable: false },  // 0: global
                { pubkey: feeRecipient, isSigner: false, isWritable: true },                  // 1: feeRecipient
                { pubkey: mint, isSigner: false, isWritable: false },                         // 2: mint
                { pubkey: curvePda, isSigner: false, isWritable: true },                      // 3: bondingCurve
                { pubkey: curveTokAcct, isSigner: false, isWritable: true },                  // 4: assocBondingCurve
                { pubkey: sellerTokAcct, isSigner: false, isWritable: true },                 // 5: assocUser
                { pubkey: seller, isSigner: true, isWritable: true },                         // 6: user/seller
                { pubkey: SP.programId, isSigner: false, isWritable: false },                 // 7: systemProgram
                { pubkey: tokenProg, isSigner: false, isWritable: false },                    // 8: tokenProgram (SPL)
                { pubkey: RENT, isSigner: false, isWritable: false },                         // 9: rent
                { pubkey: eventAuth, isSigner: false, isWritable: false },                    // 10: eventAuthority
                { pubkey: PumpFunService.PUMP_PROGRAM, isSigner: false, isWritable: false },  // 11: program
            ];
        }

        // Helper to build a fresh sell instruction + transaction with given token amount
        const buildSellTx = async (rawAmt: bigint): Promise<InstanceType<typeof VT>> => {
            const d = Buffer.allocUnsafe(24);
            PumpFunService.SELL_DISC.copy(d, 0);
            d.writeBigUInt64LE(rawAmt, 8);
            d.writeBigUInt64LE(isToken2022 ? 0n : minSolOut, 16);
            const sellIx = new TI({ programId: PumpFunService.PUMP_PROGRAM, data: d, keys });
            const allIxs = [ixs[0], ixs[1], sellIx];
            const { blockhash } = await conn.getLatestBlockhash('confirmed');
            const msg = new TM({ payerKey: seller, recentBlockhash: blockhash, instructions: allIxs }).compileToV0Message();
            return new VT(msg);
        };

        let transaction = await buildSellTx(tokensRaw);

        // Adaptive simulation: try the FULL amount first (a dump should be ONE tx).
        // Only if the program overflows (6024 / 0x1788) on the full amount, binary-search
        // the maximum sellable amount via free read-only simulations and send a single
        // transaction for that max — NOT blind halving (which dumped only 50% per click).
        if (isToken2022) {
            const MIN_RAW = 1_000_000n; // 1 token minimum
            const sim = await conn.simulateTransaction(transaction);
            if (sim.value.err) {
                const errStr = JSON.stringify(sim.value.err);
                if (errStr.includes('6024') || errStr.includes('1788')) {
                    let lo = 0n;            // largest amount known to pass
                    let hi = tokensRaw;     // smallest amount known to fail
                    for (let i = 0; i < 12; i++) {
                        const mid = (lo + hi) / 2n;
                        if (mid < MIN_RAW) break;
                        const t = await buildSellTx(mid);
                        const s = await conn.simulateTransaction(t);
                        if (!s.value.err) lo = mid; else hi = mid;
                        if (hi - lo <= tokensRaw / 200n) break; // converged within 0.5%
                    }
                    if (lo >= MIN_RAW) {
                        tokensRaw = lo;
                        isPartialSell = true;
                        transaction = await buildSellTx(tokensRaw);
                        console.warn(`⚠️ Overflow on full amount — max sellable via binary search: ${Number(tokensRaw) / 1e6} tokens in ONE tx`);
                    }
                }
            }
        }

        const solOutNum = Number((tokensRaw * curve.virtualSolReserves) / (curve.virtualTokenReserves + tokensRaw)) / 1e9;
        console.log(`📊 On-chain sell (${isToken2022 ? 'Token2022 V2' : 'SPL'}): ${tokenAmount.toFixed(0)} tokens → ${solOutNum.toFixed(6)} SOL`);

        return {
            transaction,
            quote: {
                solOut: solOutNum,
                minSolOut: Number(minSolOut) / 1e9,
                priceImpact: 0,
                effectivePrice: solOutNum / tokenAmount,
                tokensSold: Number(tokensRaw) / 1e6,
                isPartialSell,
            },
        };
    }

    /**
     * Get specific token info from PumpFun
     * Fallback chain:
     *   1. frontend-api.pump.fun (with browser-like headers, often blocked)
     *   2. pumpportal.fun/api/data/token (lightweight endpoint)
     *   3. DexScreener /tokens/v1/solana/{mint}
     */
    async getPumpFunTokenInfo(mint: string): Promise<PumpFunToken | null> {
        // ── 1. PumpFun frontend API (blocked by Cloudflare 530 when hitting from servers) ──
        try {
            const response = await axios.get(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
                timeout: 8000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://pump.fun/',
                    'Origin': 'https://pump.fun',
                },
            });
            if (response.data?.mint) {
                return this.transformPumpFunToken(response.data);
            }
        } catch (e1) {
            console.warn(`⚠️ pump.fun frontend-api blocked (${(e1 as any)?.response?.status ?? (e1 as Error).message}) — trying PumpPortal...`);
        }

        // ── 2. PumpPortal token data endpoint ──
        try {
            const ppResp = await axios.get(`https://pumpportal.fun/api/data/token?mint=${mint}`, {
                timeout: 8000,
                headers: { 'Accept': 'application/json' },
            });
            const d = ppResp.data;
            if (d?.mint) {
                return this.transformPumpFunToken(d);
            }
        } catch (e2) {
            console.warn(`⚠️ PumpPortal token API unavailable — trying DexScreener...`);
        }

        // ── 3. DexScreener /tokens/v1/solana/{mint} ──
        try {
            const dxResp = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, {
                timeout: 8000,
                headers: { 'Accept': 'application/json' },
            });
            const pairs: any[] = dxResp.data;
            if (Array.isArray(pairs) && pairs.length > 0) {
                const pair = pairs[0];
                // DexScreener only has graduated tokens — if we find it here it may have completed
                const liquidityUsd = pair.liquidity?.usd || 0;
                const priceNative = parseFloat(pair.priceNative || '0');
                const virtualSol = liquidityUsd > 0 ? liquidityUsd / 2 : 30 * 1e9; // fallback 30 SOL
                return {
                    mint,
                    name: pair.baseToken?.name || 'Unknown',
                    symbol: pair.baseToken?.symbol || '???',
                    bonding_curve: '',
                    associated_bonding_curve: '',
                    virtual_sol_reserves: virtualSol,
                    virtual_token_reserves: priceNative > 0 ? virtualSol / priceNative : 1_000_000_000,
                    total_supply: 1_000_000_000,
                    market_cap: virtualSol,
                    complete: false, // assume still tradeable
                    creator: '',
                    created_timestamp: pair.pairCreatedAt || Date.now(),
                    price_sol: priceNative,
                    bonding_progress: 50,
                };
            }
        } catch (e3) {
            console.warn(`⚠️ DexScreener token lookup failed: ${(e3 as Error).message}`);
        }

        console.error(`❌ All token info sources failed for ${mint}`);
        return null;
    }

    /**
     * Check if token is on bonding curve (pre-bonded)
     */
    async isPreBonded(mint: string): Promise<boolean> {
        const tokenInfo = await this.getPumpFunTokenInfo(mint);
        return tokenInfo ? !tokenInfo.complete : false;
    }

    /**
     * Calculate quote for PumpFun bonding curve
     */
    private calculatePumpFunQuote(
        token: PumpFunToken,
        amount: number,
        type: 'buy' | 'sell'
    ): { tokensOut?: number; solOut?: number; priceImpact: number; effectivePrice: number } {
        const virtualSol = token.virtual_sol_reserves;
        const virtualTokens = token.virtual_token_reserves;

        // Constant product formula: k = x * y
        const k = virtualSol * virtualTokens;

        if (type === 'buy') {
            // User is buying tokens with SOL
            const newSolReserves = virtualSol + amount;
            const newTokenReserves = k / newSolReserves;
            const tokensOut = virtualTokens - newTokenReserves;

            const effectivePrice = amount / tokensOut;
            const spotPrice = virtualSol / virtualTokens;
            const priceImpact = ((effectivePrice - spotPrice) / spotPrice) * 100;

            return {
                tokensOut,
                priceImpact,
                effectivePrice,
            };
        } else {
            // User is selling tokens for SOL
            const newTokenReserves = virtualTokens + amount;
            const newSolReserves = k / newTokenReserves;
            const solOut = virtualSol - newSolReserves;

            const effectivePrice = solOut / amount;
            const spotPrice = virtualSol / virtualTokens;
            const priceImpact = ((spotPrice - effectivePrice) / spotPrice) * 100;

            return {
                solOut,
                priceImpact,
                effectivePrice,
            };
        }
    }

    /**
     * Transform raw PumpFun API response to our format
     */
    private transformPumpFunToken(raw: any): PumpFunToken {
        const virtualSol = raw.virtual_sol_reserves || 0;
        const virtualTokens = raw.virtual_token_reserves || 0;
        const priceSol = virtualTokens > 0 ? virtualSol / virtualTokens : 0;

        // Bonding curve progress (PumpFun uses ~85 SOL target for migration)
        const BONDING_TARGET_SOL = 85 * 1e9; // 85 SOL in lamports
        const bondingProgress = Math.min(100, (virtualSol / BONDING_TARGET_SOL) * 100);

        return {
            mint: raw.mint,
            name: raw.name || 'Unknown',
            symbol: raw.symbol || 'UNKNOWN',
            description: raw.description,
            image_uri: raw.image_uri,
            metadata_uri: raw.metadata_uri,
            twitter: raw.twitter,
            telegram: raw.telegram,
            website: raw.website,
            bonding_curve: raw.bonding_curve,
            associated_bonding_curve: raw.associated_bonding_curve,
            virtual_sol_reserves: virtualSol,
            virtual_token_reserves: virtualTokens,
            total_supply: raw.total_supply || 1000000000,
            market_cap: raw.market_cap || (virtualSol / 1e9), // pump.fun API provides market_cap in SOL directly
            usd_market_cap: raw.usd_market_cap,
            complete: raw.complete || false,
            creator: raw.creator,
            created_timestamp: raw.created_timestamp || Date.now(),
            reply_count: raw.reply_count,
            last_trade_timestamp: raw.last_trade_timestamp,
            price_sol: priceSol,
            bonding_progress: bondingProgress,
        };
    }

    /**
     * Transform LaunchLab API response
     */
    private transformLaunchLabToken(raw: any): LaunchLabToken {
        return {
            poolAddress: raw.poolAddress || raw.id,
            tokenMint: raw.baseMint || raw.mint,
            tokenName: raw.name || 'Unknown',
            tokenSymbol: raw.symbol || 'UNKNOWN',
            tokenDecimals: raw.decimals || 9,
            tokenLogo: raw.logoURI || raw.image,
            liquidity: raw.liquidity || 0,
            volume24h: raw.volume24h || 0,
            priceUsd: raw.priceUsd,
            marketCap: raw.marketCap,
            website: raw.website,
            twitter: raw.twitter,
            telegram: raw.telegram,
            status: raw.complete ? 'completed' : raw.launchTime && raw.launchTime < Date.now() ? 'live' : 'presale',
            launchTime: raw.launchTime,
            presaleProgress: raw.presaleProgress,
            softCap: raw.softCap,
            hardCap: raw.hardCap,
            raised: raw.raised,
        };
    }

    /**
     * Apply filters to PumpFun tokens
     */
    private applyPumpFunFilters(tokens: PumpFunToken[], filters: TokenFilters): PumpFunToken[] {
        return tokens.filter(token => {
            // Pre-bonded filter
            if (filters.preBondedOnly && token.complete) return false;
            if (filters.postBondedOnly && !token.complete) return false;

            // Market cap filters
            if (filters.minMarketCap !== undefined && token.market_cap < filters.minMarketCap) return false;
            if (filters.maxMarketCap !== undefined && token.market_cap > filters.maxMarketCap) return false;

            // Age filters
            if (filters.maxAgeMinutes !== undefined) {
                const ageMinutes = (Date.now() - token.created_timestamp) / (1000 * 60);
                if (ageMinutes > filters.maxAgeMinutes) return false;
            }
            if (filters.minAgeMinutes !== undefined) {
                const ageMinutes = (Date.now() - token.created_timestamp) / (1000 * 60);
                if (ageMinutes < filters.minAgeMinutes) return false;
            }

            // Social filters
            if (filters.hasTwitter && !token.twitter) return false;
            if (filters.hasTelegram && !token.telegram) return false;
            if (filters.hasWebsite && !token.website) return false;

            return true;
        });
    }

    /**
     * Sort tokens
     */
    private sortTokens<T extends PumpFunToken>(
        tokens: T[],
        sortBy: TokenFilters['sortBy'],
        sortDirection: TokenFilters['sortDirection']
    ): T[] {
        return tokens.sort((a, b) => {
            let comparison = 0;

            switch (sortBy) {
                case 'created':
                    comparison = a.created_timestamp - b.created_timestamp;
                    break;
                case 'market_cap':
                    comparison = a.market_cap - b.market_cap;
                    break;
                case 'last_trade':
                    comparison = (a.last_trade_timestamp || 0) - (b.last_trade_timestamp || 0);
                    break;
                case 'bonding_progress':
                    comparison = (a.bonding_progress || 0) - (b.bonding_progress || 0);
                    break;
                default:
                    comparison = a.created_timestamp - b.created_timestamp;
            }

            return sortDirection === 'desc' ? -comparison : comparison;
        });
    }
}

// Singleton instance
let pumpFunService: PumpFunService | null = null;

export function getPumpFunService(): PumpFunService {
    if (!pumpFunService) {
        pumpFunService = new PumpFunService();
    }
    return pumpFunService;
}

export default PumpFunService;
