/**
 * Liquidity unit conversion — single source of truth (audit §1.2).
 * All liquidity thresholds in the app are USD. On-chain liquidity arrives in SOL
 * (vSolInBondingCurve) and is converted here using the cached live SOL/USD price.
 * Dependency-free so it can be unit-tested in isolation.
 */

let _cachedSolPriceUsd = 150; // conservative default until first real price

export function setSolPriceUsd(price: number): void {
    if (price > 1 && price < 100000) _cachedSolPriceUsd = price;
}

export function getSolPriceUsd(): number {
    return _cachedSolPriceUsd;
}

/**
 * Converts SOL liquidity to USD and compares against USD thresholds.
 * Used by BOTH tokenMatchesSnipeSettings (auto-snipe) and checkTokenFilter
 * (feed gating) so the two paths can never disagree on units again.
 * Falsy (0/null/undefined) thresholds disable that bound.
 */
export function liquidityUsdCheck(
    liquiditySol: number,
    minLiquidityUsd?: number | null,
    maxLiquidityUsd?: number | null
): { ok: boolean; reason?: string; liquidityUsd: number } {
    const liquidityUsd = liquiditySol * _cachedSolPriceUsd;
    if (minLiquidityUsd && liquidityUsd < minLiquidityUsd) {
        return { ok: false, liquidityUsd, reason: `low_liquidity ($${Math.round(liquidityUsd)} < $${minLiquidityUsd})` };
    }
    if (maxLiquidityUsd && liquidityUsd > maxLiquidityUsd) {
        return { ok: false, liquidityUsd, reason: `high_liquidity ($${Math.round(liquidityUsd)} > $${maxLiquidityUsd})` };
    }
    return { ok: true, liquidityUsd };
}
