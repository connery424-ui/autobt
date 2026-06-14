/**
 * Canonical DEX identifiers (audit §6.1).
 * THE single source of truth — every service, DB write, API response and UI
 * badge must use these values. Display names live in DEX_DISPLAY_NAMES.
 *
 * Legacy aliases seen in old code/DB rows: 'bonkisfun', 'letsbonk' → 'launchlab';
 * 'raydium_amm', 'raydium_clmm' (geyser) → 'raydium'. Use normalizeDexId().
 */

export type DexId = 'pumpfun' | 'pumpswap' | 'launchlab' | 'raydium' | 'jupiter';

export const DEX_IDS: readonly DexId[] = ['pumpfun', 'pumpswap', 'launchlab', 'raydium', 'jupiter'] as const;

export const DEX_DISPLAY_NAMES: Record<DexId, string> = {
    pumpfun: 'Pump.fun',
    pumpswap: 'PumpSwap',
    launchlab: 'Bonk.fun',
    raydium: 'Raydium',
    jupiter: 'Jupiter',
};

const ALIASES: Record<string, DexId> = {
    bonkisfun: 'launchlab',
    letsbonk: 'launchlab',
    bonkfun: 'launchlab',
    raydium_amm: 'raydium',
    raydium_clmm: 'raydium',
    pump: 'pumpfun',
    pumpswapamm: 'pumpswap',
};

/** Map any legacy/variant identifier to its canonical DexId. Unknown values pass through lowercased. */
export function normalizeDexId(raw: string | null | undefined): DexId | string {
    if (!raw) return 'pumpfun';
    const k = raw.toLowerCase().trim();
    if ((DEX_IDS as readonly string[]).includes(k)) return k as DexId;
    return ALIASES[k] ?? k;
}

/** Display name for any identifier (canonical or legacy). */
export function dexDisplayName(raw: string | null | undefined): string {
    const id = normalizeDexId(raw);
    return DEX_DISPLAY_NAMES[id as DexId] ?? (raw || 'Unknown');
}
