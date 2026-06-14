/**
 * RpcManager — multi-endpoint RPC pool with automatic rotation
 *
 * Priority: Helius (if key set) → RPC_URL_1…5 → SOLANA_RPC_URL → public fallback
 *
 * Behaviour:
 *  - Round-robin for normal calls
 *  - On 429 / connection error: mark endpoint as cooled-down for COOLDOWN_MS
 *  - Automatically re-enables cooled endpoints after cooldown expires
 */

import { Connection } from '@solana/web3.js';
type SolanaConnection = InstanceType<typeof Connection>;


const COOLDOWN_MS = 60_000; // 1 minute backoff per endpoint on rate-limit
const PUBLIC_FALLBACK = 'https://api.mainnet-beta.solana.com';

interface Endpoint {
    url: string;
    label: string;
    coolUntil: number; // timestamp — 0 means available
    errors: number;
}

class RpcManager {
    private endpoints: Endpoint[] = [];
    private index = 0;

    constructor() {
        this.rebuild();
    }

    /** Re-read environment variables and rebuild the pool (call after .env changes) */
    rebuild(): void {
        const urls: { url: string; label: string }[] = [];

        // 1. Helius (primary)
        const helius = process.env.HELIUS_API_KEY?.trim();
        if (helius) {
            const network = process.env.SOLANA_NETWORK || 'mainnet';
            urls.push({
                url: `https://${network}.helius-rpc.com/?api-key=${helius}`,
                label: 'Helius',
            });
        }

        // 2. Additional Helius keys (HELIUS_API_KEY_2, HELIUS_API_KEY_3 …)
        for (let i = 2; i <= 5; i++) {
            const key = process.env[`HELIUS_API_KEY_${i}`]?.trim();
            if (key) {
                const network = process.env.SOLANA_NETWORK || 'mainnet';
                urls.push({
                    url: `https://${network}.helius-rpc.com/?api-key=${key}`,
                    label: `Helius-${i}`,
                });
            }
        }

        // 3. Generic RPC_URL_1 … RPC_URL_5
        for (let i = 1; i <= 5; i++) {
            const url = process.env[`RPC_URL_${i}`]?.trim();
            if (url) {
                urls.push({ url, label: `RPC-${i}` });
            }
        }

        // 4. Legacy SOLANA_RPC_URL
        const legacy = process.env.SOLANA_RPC_URL?.trim();
        if (legacy) {
            urls.push({ url: legacy, label: 'SOLANA_RPC_URL' });
        }

        // 5. Always keep the free public endpoint as last resort
        if (!urls.find(e => e.url === PUBLIC_FALLBACK)) {
            urls.push({ url: PUBLIC_FALLBACK, label: 'public-fallback' });
        }

        this.endpoints = urls.map(e => ({ ...e, coolUntil: 0, errors: 0 }));
        this.index = 0;
        console.log(`🔄 RpcManager: ${this.endpoints.length} endpoints loaded — [${this.endpoints.map(e => e.label).join(', ')}]`);
    }

    /** Returns the next available RPC URL (round-robin, skipping cooled endpoints) */
    getUrl(): string {
        const now = Date.now();
        const available = this.endpoints.filter(e => e.coolUntil <= now);

        if (available.length === 0) {
            // All on cooldown — use the one that recovers soonest
            const soonest = this.endpoints.reduce((a, b) => a.coolUntil < b.coolUntil ? a : b);
            console.warn(`⚠️  All RPCs on cooldown. Using ${soonest.label} anyway.`);
            return soonest.url;
        }

        // Round-robin over available endpoints
        const ep = available[this.index % available.length];
        this.index = (this.index + 1) % available.length;
        return ep.url;
    }

    /** Returns a fresh Connection using the next available endpoint */
    getConnection(commitment: 'confirmed' | 'finalized' | 'processed' = 'confirmed'): SolanaConnection {
        return new Connection(this.getUrl(), commitment);
    }


    /**
     * Call this when an endpoint request fails.
     * Automatically applies cooldown for 429 / rate-limit errors.
     */
    reportError(url: string, error: unknown): void {
        const ep = this.endpoints.find(e => e.url === url);
        if (!ep) return;

        const isRateLimit =
            (error instanceof Error && /429|rate.limit|too many/i.test(error.message)) ||
            (typeof error === 'object' && error !== null && (error as any).status === 429);

        ep.errors++;

        if (isRateLimit) {
            ep.coolUntil = Date.now() + COOLDOWN_MS;
            console.warn(`🚫 RPC ${ep.label} rate-limited — cooling down for ${COOLDOWN_MS / 1000}s`);
        } else {
            console.warn(`⚠️  RPC ${ep.label} error #${ep.errors}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Wraps an async call with automatic RPC rotation on failure.
     * Tries each available endpoint once before giving up.
     */
    async withRotation<T>(fn: (connection: SolanaConnection, url: string) => Promise<T>): Promise<T> {
        const now = Date.now();
        const pool = this.endpoints.filter(e => e.coolUntil <= now);
        const trialOrder = pool.length > 0 ? pool : this.endpoints;

        let lastErr: unknown;
        for (const ep of trialOrder) {
            try {
                const conn = new Connection(ep.url, 'confirmed');
                return await fn(conn, ep.url);
            } catch (err) {
                this.reportError(ep.url, err);
                lastErr = err;
            }
        }
        throw lastErr;
    }

    /** Status snapshot for debugging / admin endpoints */
    status() {
        const now = Date.now();
        return this.endpoints.map(e => ({
            label: e.label,
            url: e.url.replace(/api-key=[^&]+/, 'api-key=***'),
            available: e.coolUntil <= now,
            cooldownRemaining: Math.max(0, e.coolUntil - now),
            errors: e.errors,
        }));
    }
}

// Singleton — import and use anywhere in server.ts
export const rpcManager = new RpcManager();
