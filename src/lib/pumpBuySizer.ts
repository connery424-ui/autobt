/**
 * pumpBuySizer — make a PumpPortal buy spend the user's actual SOL budget.
 *
 * PumpPortal sizes the token amount from its own price, which lags badly for tokens
 * that just pumped — it hands you far too many tokens, so the on-chain buy costs
 * several × the SOL you asked for and pump.fun rejects it with Custom error 6002
 * (TooMuchSolRequired). No amount of slippage fixes that (the token amount is wrong).
 *
 * This resizes the buy: simulate to learn the real per-amount token cost, scale the
 * token amount to the budget, and patch the instruction's `amount` + `max_sol_cost`
 * in place. The caller signs afterwards. Mutates `tx`; never throws.
 *
 * Works for both the classic pump program and the Feb-2026 cashback router that CPIs
 * into it (both carry amount@8 / max_sol_cost@16 in the instruction data).
 */
import { Connection, VersionedTransaction } from '@solana/web3.js';

const PUMP_PROGRAMS = new Set([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // classic pump
  'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe', // cashback router
]);

function findPumpBuyIx(tx: VersionedTransaction): any {
  const msg: any = tx.message;
  const keys: string[] = msg.staticAccountKeys.map((k: any) => k.toBase58());
  for (const ix of msg.compiledInstructions) {
    if (PUMP_PROGRAMS.has(keys[ix.programIdIndex]) && ix.data.length >= 24) return ix;
  }
  return null;
}

function readU64(data: Uint8Array, off: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(off, true);
}
function writeU64(data: Uint8Array, off: number, val: bigint): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(off, val, true);
}

export interface SizeResult {
  resized: boolean;
  reason: string;
  detail?: any;
}

export async function sizePumpBuyToBudget(
  connection: Connection,
  tx: VersionedTransaction,
  budgetSol: number,
  slipPct: number,
): Promise<SizeResult> {
  try {
    const ix = findPumpBuyIx(tx);
    if (!ix) return { resized: false, reason: 'no-pump-ix' };

    const budgetLamports = BigInt(Math.round(budgetSol * 1e9));
    if (budgetLamports <= 0n) return { resized: false, reason: 'bad-budget' };

    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed',
    });

    if (!sim.value.err) {
      return { resized: false, reason: 'fits' }; // already within budget (fresh token)
    }
    const errStr = JSON.stringify(sim.value.err);
    if (!errStr.includes('6002')) {
      return { resized: false, reason: 'other-error', detail: errStr };
    }

    // Pull the real token cost from pump.fun's AnchorError "Right:" log line.
    let cost: bigint | null = null;
    for (const l of (sim.value.logs || [])) {
      const m = l.match(/Right:\s*(\d+)/);
      if (m) cost = BigInt(m[1]);
    }
    if (!cost || cost <= 0n) return { resized: false, reason: 'no-cost' };

    const amount = readU64(ix.data, 8);
    // token cost is ~linear in token amount for small buys → scale to budget.
    const newAmount = (amount * budgetLamports) / cost;
    if (newAmount <= 0n) return { resized: false, reason: 'amount-zero' };
    const newMax = (budgetLamports * BigInt(100 + Math.round(slipPct))) / 100n;

    writeU64(ix.data, 8, newAmount);
    writeU64(ix.data, 16, newMax);

    return {
      resized: true,
      reason: 'rescaled',
      detail: {
        fromTokens: amount.toString(),
        toTokens: newAmount.toString(),
        realCostLamports: cost.toString(),
        newMaxSolCost: newMax.toString(),
      },
    };
  } catch (e: any) {
    return { resized: false, reason: 'exception:' + (e?.message || String(e)) };
  }
}
