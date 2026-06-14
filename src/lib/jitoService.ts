// src/lib/jitoService.ts - Official Jito SDK MEV Protection Service

import { JitoJsonRpcClient } from 'jito-js-rpc';
import * as web3 from '@solana/web3.js';

// Type aliases to bypass TypeScript namespace issues
type SolanaConnection = any;
type SolanaVersionedTransaction = any;
type SolanaPublicKey = any;
type SolanaTransactionMessage = any;

// Bundle status interface based on Jito SDK
interface BundleStatus {
  bundle_id: string;
  status: 'Invalid' | 'Pending' | 'Failed' | 'Landed';
  landed_slot: number | null;
}

/**
 * Professional Jito Service using Official SDK
 * Provides MEV protection via bundle submission to Jito validators
 */
export class JitoService {
  private static readonly JITO_BLOCK_ENGINE_URLS = [
    'https://ny.mainnet.block-engine.jito.wtf',
    'https://amsterdam.mainnet.block-engine.jito.wtf',
    'https://frankfurt.mainnet.block-engine.jito.wtf',
    'https://tokyo.mainnet.block-engine.jito.wtf'
  ];

  private static readonly TIP_ACCOUNTS = [
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49'
  ];

  private jitoClient: JitoJsonRpcClient;
  private connection: SolanaConnection;

  constructor(rpcEndpoint: string, jitoEndpoint?: string) {
    this.connection = new web3.Connection(rpcEndpoint, 'confirmed');
    const endpoint = jitoEndpoint || JitoService.JITO_BLOCK_ENGINE_URLS[0];
    this.jitoClient = new JitoJsonRpcClient(endpoint, 'jito-client-uuid');
  }

  /**
   * Submit a bundle to Jito for MEV protection
   * Returns the bundle ID if successful
   */
  async submitBundle(
    transactions: SolanaVersionedTransaction[],
    payerPublicKey: SolanaPublicKey,
    tipLamports: number = 10000,
    maxRetries: number = 3
  ): Promise<string> {
    try {
      // FIX-10: Pass real payer key so tip is debited from the correct wallet.
      const tipTx = await this.createTipTransaction(tipLamports, payerPublicKey);
      const bundleTransactions = [...transactions, tipTx];

      // Serialize transactions to base64 strings
      const serializedTxs = bundleTransactions.map(tx =>
        Buffer.from(tx.serialize()).toString('base64')
      );

      // Try multiple endpoints for redundancy
      for (const endpoint of JitoService.JITO_BLOCK_ENGINE_URLS) {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            const client = new JitoJsonRpcClient(endpoint, 'jito-client-uuid');
            const result = await client.sendBundle([serializedTxs]);

            if (result?.result) {
              console.log(`✅ Jito bundle submitted via ${endpoint}:`, result.result);
              return result.result;
            }
          } catch (endpointError) {
            console.warn(`Jito endpoint ${endpoint} attempt ${attempt + 1} failed:`, endpointError);
            if (attempt === maxRetries - 1) {
              console.error(`All attempts failed for ${endpoint}`);
            }
          }
        }
      }

      throw new Error('All Jito endpoints failed after retries');

    } catch (error) {
      console.error('Jito bundle submission failed:', error);
      throw error;
    }
  }

  /**
   * Create a tip transaction for Jito validators
   */
  private async createTipTransaction(
    tipLamports: number,
    payerPublicKey: SolanaPublicKey
  ): Promise<SolanaVersionedTransaction> {
    // Select random tip account for better distribution
    const tipAccount = JitoService.TIP_ACCOUNTS[Math.floor(Math.random() * JitoService.TIP_ACCOUNTS.length)];

    // FIX-10: Use the real payer key instead of all-zeros PublicKey.default.
    // PublicKey.default causes InvalidAccountForFee on every bundle submission.
    const tipInstruction = web3.SystemProgram.transfer({
      fromPubkey: payerPublicKey,
      toPubkey: new web3.PublicKey(tipAccount),
      lamports: tipLamports
    });

    const computeUnitPrice = web3.ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 1000000
    });

    const instructions = [computeUnitPrice, tipInstruction];

    const message = new web3.TransactionMessage({
      payerKey: payerPublicKey,
      recentBlockhash: (await this.connection.getLatestBlockhash()).blockhash,
      instructions
    }).compileToV0Message();

    return new web3.VersionedTransaction(message);
  }

  /**
   * Get bundle status
   */
  async getBundleStatus(bundleId: string): Promise<BundleStatus | null> {
    try {
      const result = await this.jitoClient.getBundleStatuses([[bundleId]]);
      if (result?.result?.value && result.result.value.length > 0) {
        const status = result.result.value[0];
        return {
          bundle_id: status.bundle_id,
          status: status.confirmation_status === 'finalized' ? 'Landed' : 'Pending',
          landed_slot: status.slot
        };
      }
      return null;
    } catch (error) {
      console.error('Failed to get bundle status:', error);
      return null;
    }
  }

  /**
   * Calculate optimal tip based on network conditions and priority
   */
  static calculateTip(priority: 'low' | 'medium' | 'high' = 'medium'): number {
    const baseTips = {
      low: 5000,      // 0.000005 SOL - for regular trades
      medium: 10000,  // 0.00001 SOL - for important trades  
      high: 20000     // 0.00002 SOL - for critical/time-sensitive trades
    };

    // Add some randomization to avoid tip clustering
    const randomMultiplier = 0.8 + (Math.random() * 0.4); // 0.8x to 1.2x
    return Math.floor(baseTips[priority] * randomMultiplier);
  }

  /**
   * Check if Jito is available
   */
  static async isAvailable(): Promise<boolean> {
    try {
      const client = new JitoJsonRpcClient(JitoService.JITO_BLOCK_ENGINE_URLS[0], 'health-check');
      // Try to get tip accounts to check connectivity
      await client.getTipAccounts();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get recommended tip for current network conditions
   */
  async getRecommendedTip(): Promise<number> {
    try {
      // This is a simplified implementation
      // In practice, you'd analyze recent successful bundles to determine optimal tips
      const recentSlot = await this.connection.getSlot();
      const performanceSamples = await this.connection.getRecentPerformanceSamples(20);

      if (performanceSamples.length > 0) {
        // Calculate network congestion and adjust tip accordingly
        const avgSlotTime = performanceSamples.reduce((acc: number, sample: any) =>
          acc + sample.samplePeriodSecs, 0) / performanceSamples.length;

        // Higher tips during network congestion
        if (avgSlotTime > 0.5) {
          return JitoService.calculateTip('high');
        } else if (avgSlotTime > 0.45) {
          return JitoService.calculateTip('medium');
        }
      }

      return JitoService.calculateTip('low');
    } catch (error) {
      console.warn('Failed to get recommended tip, using default:', error);
      return JitoService.calculateTip('medium');
    }
  }
}
