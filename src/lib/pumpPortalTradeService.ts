/**
 * PumpPortal Trade Service — Universal buy/sell for Pump.fun tokens
 *
 * Uses the PumpPortal trade-local API (https://pumpportal.fun/api/trade-local)
 * to get correctly constructed, unsigned versioned transactions.
 * The caller signs with their keypair and broadcasts via their own RPC.
 *
 * This replaces the manual instruction construction in pumpfunService.ts which
 * broke after the February 2026 cashback upgrade (new account layout).
 *
 * Usage from any execution path:
 *   const svc = new PumpPortalTradeService();
 *   const { transaction } = await svc.buyToken({ publicKey, mint, solAmount, slippagePct });
 *   // sign transaction with keypair, then sendRawTransaction
 */

import { VersionedTransaction } from '@solana/web3.js';

const PUMPPORTAL_TRADE_URL = 'https://pumpportal.fun/api/trade-local';

export interface BuyParams {
  /** Wallet public key (base58) */
  publicKey: string;
  /** Token mint address */
  mint: string;
  /** Amount of SOL to spend */
  solAmount: number;
  /** Slippage tolerance in percent (e.g. 10 = 10%) */
  slippagePct: number;
  /** Priority fee in SOL (default 0.0003 ≈ 300k microlamports) */
  priorityFee?: number;
}

export interface SellParams {
  /** Wallet public key (base58) */
  publicKey: string;
  /** Token mint address */
  mint: string;
  /** Amount to sell: percentage string like "100%", "50%", or numeric token count */
  amount: string | number;
  /** Slippage tolerance in percent (e.g. 10 = 10%) */
  slippagePct: number;
  /** Priority fee in SOL (default 0.0003) */
  priorityFee?: number;
}

export interface TradeResult {
  /** Unsigned versioned transaction ready for signing */
  transaction: InstanceType<typeof VersionedTransaction>;
  /** Quote/metadata for display */
  quote: {
    action: 'buy' | 'sell';
    mint: string;
    amount: number | string;
    slippage: number;
    pool: string;
  };
}

export class PumpPortalTradeService {
  private readonly apiUrl: string;
  private readonly defaultPriorityFee: number;

  constructor(apiUrl?: string, defaultPriorityFee?: number) {
    this.apiUrl = apiUrl || PUMPPORTAL_TRADE_URL;
    this.defaultPriorityFee = defaultPriorityFee ?? 0.0003;
  }

  /**
   * Build a BUY transaction for a Pump.fun bonding curve token.
   * Returns an unsigned VersionedTransaction that the caller must sign and broadcast.
   */
  async buyToken(params: BuyParams): Promise<TradeResult> {
    const { publicKey, mint, solAmount, slippagePct, priorityFee } = params;

    console.log(`[PumpPortalTrade] BUY request: ${solAmount} SOL of ${mint} (slippage ${slippagePct}%)`);

    const body = {
      publicKey,
      action: 'buy',
      mint,
      amount: solAmount,
      denominatedInSol: 'true',
      slippage: slippagePct,
      priorityFee: priorityFee ?? this.defaultPriorityFee,
      pool: 'auto',
    };

    const transaction = await this._fetchTransaction(body);

    console.log(`[PumpPortalTrade] BUY transaction received (${transaction.serialize().length} bytes)`);

    return {
      transaction,
      quote: {
        action: 'buy',
        mint,
        amount: solAmount,
        slippage: slippagePct,
        pool: 'auto',
      },
    };
  }

  /**
   * Build a SELL transaction for a Pump.fun bonding curve token.
   * PumpPortal natively supports percentage amounts (e.g. "100%", "50%").
   * Returns an unsigned VersionedTransaction that the caller must sign and broadcast.
   */
  async sellToken(params: SellParams): Promise<TradeResult> {
    const { publicKey, mint, amount, slippagePct, priorityFee } = params;

    console.log(`[PumpPortalTrade] SELL request: ${amount} of ${mint} (slippage ${slippagePct}%)`);

    const body = {
      publicKey,
      action: 'sell',
      mint,
      amount,
      denominatedInSol: 'false',
      slippage: slippagePct,
      priorityFee: priorityFee ?? this.defaultPriorityFee,
      pool: 'auto',
    };

    const transaction = await this._fetchTransaction(body);

    console.log(`[PumpPortalTrade] SELL transaction received (${transaction.serialize().length} bytes)`);

    return {
      transaction,
      quote: {
        action: 'sell',
        mint,
        amount,
        slippage: slippagePct,
        pool: 'auto',
      },
    };
  }

  /**
   * Internal: POST to PumpPortal trade-local and deserialize the response.
   */
  private async _fetchTransaction(body: Record<string, any>): Promise<InstanceType<typeof VersionedTransaction>> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.status !== 200) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`PumpPortal API error (${response.status}): ${errText}`);
    }

    const txBytes = new Uint8Array(await response.arrayBuffer());
    if (txBytes.length === 0) {
      throw new Error('PumpPortal returned empty transaction');
    }

    return VersionedTransaction.deserialize(txBytes);
  }
}

/** Singleton instance for shared use across the app */
export const pumpPortalTradeService = new PumpPortalTradeService();
