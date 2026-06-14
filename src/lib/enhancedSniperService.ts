// src/lib/enhancedSniperService.ts
import * as web3 from '@solana/web3.js';
import { SniperConfig } from '../store/slices/sniperConfigsSlice';
import { BlockMonitor, TokenCreationEvent } from './blockMonitor';
import { JitoService } from './jitoService';
import { prisma } from './prisma';
import { log } from './logStore';
import toast from './toast-shim';
import { analyzeTransaction, type TransactionAnalysis } from './transactionAnalyzer.js';

// Type aliases to avoid TypeScript namespace issues
type SolanaConnection = any;
type SolanaVersionedTransaction = any;

// ─── Sign context injected from server.ts ───────────────────────────────────
// This gives the sniper access to the user's server-side encrypted keypair
// without exposing private keys directly. server.ts passes this in at init.
export interface SniperSignContext {
  userId: string;
  walletId: string;
  walletPublicKey: string;
  /** Signs instructions with a fresh blockhash and broadcasts the transaction */
  signAndBroadcast: (instructions: any[] | null, payerKey: any | null, connection: any, prebuiltTx?: any) => Promise<string>;
}

export interface PrecomputedTransaction {
  transaction: SolanaVersionedTransaction;
  config: SniperConfig;
  tokenAddress: string;
  expiresAt: number;
}

export class EnhancedSniperService {
  private connection: SolanaConnection;
  private blockMonitor: BlockMonitor;
  private jitoService: JitoService;
  private precomputedTxs: Map<string, PrecomputedTransaction> = new Map();
  private activeSnipes: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;
  private signContext: SniperSignContext | null = null;

  constructor(rpcEndpoint: string, wsEndpoint: string, signContext?: SniperSignContext) {
    this.connection = new web3.Connection(rpcEndpoint, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30000
    });
    this.blockMonitor = new BlockMonitor(rpcEndpoint, wsEndpoint);
    this.jitoService = new JitoService(rpcEndpoint);
    this.signContext = signContext || null;
  }

  /** Update sign context after initialization (e.g. after DB config loads) */
  setSignContext(ctx: SniperSignContext) {
    this.signContext = ctx;
    log(`🔑 Sniper sign context updated for wallet ${ctx.walletPublicKey}`);
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    log('🚀 Enhanced Sniper Service starting...');
    try {
      await this.blockMonitor.startMonitoring(this.handleNewToken.bind(this));
      this.startPrecomputationLoop();
      this.startAutoSellLoop();
      log('✅ Enhanced Sniper Service started successfully');
    } catch (error) {
      console.error('Failed to start Enhanced Sniper Service:', error);
      throw error;
    }
  }

  async stop() {
    this.isRunning = false;
    this.blockMonitor.stopMonitoring();
    this.activeSnipes.forEach(interval => clearInterval(interval));
    this.activeSnipes.clear();
    log('⏹️ Enhanced Sniper Service stopped');
  }

  private async handleNewToken(event: TokenCreationEvent) {
    log(`🎯 New token detected: ${event.tokenAddress}`);
    try {
      const targetConfigs = await this.getTargetConfigs(event.tokenAddress);
      for (const config of targetConfigs) {
        await this.executeZeroBlockSnipe(config, event);
      }
    } catch (error) {
      console.error('Error handling new token:', error);
    }
  }

  private async executeZeroBlockSnipe(config: SniperConfig, event: TokenCreationEvent) {
    log(`⚡ Executing 0-block snipe for ${config.name} (${event.tokenAddress})`);
    try {
      const signature = await this.smartBuy(event.tokenAddress, config);
      if (signature) {
        log(`✅ 0-block snipe executed successfully: ${signature}`);
        await this.recordTransaction(config, event.tokenAddress, signature, 'buy');
        toast.success(`🎯 0-block snipe successful for ${config.name}!`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`❌ 0-block snipe failed: ${errorMessage}`);
      console.error('0-block snipe error:', error);
    }
  }

  // ─── SMART ROUTING ────────────────────────────────────────────────────────
  /**
   * Route a buy through the correct DEX by checking on-chain state:
   *   1. pump.fun bonding curve (pre-bonded)
   *   2. PumpSwap pAMM (graduated)
   *   3. Jupiter/Raydium (everything else)
   */
  private async smartBuy(tokenAddress: string, config: SniperConfig): Promise<string | null> {
    const amountSol = parseFloat(config.buyAmount);
    const slippageBps = Math.round(parseFloat(config.maxSlippage) * 100);
    const walletPublicKey = this.signContext?.walletPublicKey || this.getWalletPublicKey();

    if (!walletPublicKey) {
      log('❌ No wallet public key available for snipe');
      return null;
    }

    const PUMP_PROGRAM = new web3.PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    const mint = new web3.PublicKey(tokenAddress);

    // ── 1. Check pump.fun bonding curve ─────────────────────────────────────
    try {
      const [curvePda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBytes()],
        PUMP_PROGRAM
      );
      const curveAcct = await this.connection.getAccountInfo(curvePda);

      if (curveAcct) {
        const data = Buffer.from(curveAcct.data);
        const complete = data.length >= 49 && data[48] !== 0;

        if (!complete) {
          // ── PATH A: pump.fun bonding curve ──────────────────────────────
          log(`🔮 [Sniper] pump.fun bonding curve buy: ${tokenAddress}`);
          const { PumpFunService } = await import('./pumpfunService.js');
          const pumpSvc = new PumpFunService(this.connection);
          const result = await pumpSvc.buyPumpFunToken(tokenAddress, amountSol, slippageBps, walletPublicKey);
          if (result) return await this.signAndBroadcast(result);
        } else {
          // ── PATH B: PumpSwap pAMM ────────────────────────────────────────
          log(`🔀 [Sniper] Token graduated — trying PumpSwap: ${tokenAddress}`);
          try {
            const { PumpSwapService } = await import('./pumpSwapService.js');
            const swapSvc = new PumpSwapService(this.connection);
            const poolAddr = await swapSvc.findPoolByMint(tokenAddress);
            if (poolAddr) {
              const result = await swapSvc.buyPumpSwap(tokenAddress, amountSol, slippageBps, walletPublicKey);
              if (result) return await this.signAndBroadcast(result);
            }
          } catch (swapErr: any) {
            log(`⚠️ [Sniper] PumpSwap failed: ${swapErr.message}`);
          }
        }
      }
    } catch (curveErr: any) {
      log(`⚠️ [Sniper] Bonding curve check failed: ${curveErr.message}`);
    }

    // ── PATH C: Jupiter (non-pump.fun tokens) ─────────────────────────────
    log(`📊 [Sniper] Falling back to Jupiter: ${tokenAddress}`);
    return await this.jupiterBuy(tokenAddress, amountSol, slippageBps, walletPublicKey);
  }

  /**
   * Sign a result object (with either `.transaction` or `.instructions + .payerKey`)
   * and broadcast it. Uses signContext if available (server-side), otherwise falls
   * back to Jito/direct submit (legacy browser path).
   */
  private async signAndBroadcast(result: any): Promise<string | null> {
    // Server-side: use injected signAndBroadcast callback
    if (this.signContext?.signAndBroadcast && result.instructions && result.payerKey) {
      return await this.signContext.signAndBroadcast(result.instructions, result.payerKey, this.connection);
    }
    if (this.signContext?.signAndBroadcast && result.transaction) {
      return await this.signContext.signAndBroadcast(null, null, this.connection, result.transaction);
    }
    // Legacy: submit unsigned (precomputed or Jito)
    if (result.transaction) {
      return await this.submitWithJito(result.transaction, null);
    }
    return null;
  }

  /**
   * Jupiter buy (fallback for non-pump.fun tokens)
   */
  private async jupiterBuy(
    tokenAddress: string, amountSol: number, slippageBps: number, walletPublicKey: string
  ): Promise<string | null> {
    try {
      const { getJupiterQuote, getJupiterSwapTransaction } = await import('./jupiter.js');
      const amountInLamports = Math.floor(amountSol * 1e9);
      const inputMint = 'So11111111111111111111111111111111111111111'; // native SOL
      const quote = await getJupiterQuote(inputMint, tokenAddress, amountInLamports, slippageBps);
      if (!quote) throw new Error('Failed to get Jupiter quote');
      const transaction = await getJupiterSwapTransaction(quote, walletPublicKey);
      if (!transaction) throw new Error('Failed to build Jupiter transaction');
      return await this.submitWithJito(transaction, null);
    } catch (err: any) {
      log(`❌ [Sniper] Jupiter buy failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Submit transaction with Jito for MEV protection (fallback: direct submit)
   */
  private async submitWithJito(
    transaction: SolanaVersionedTransaction,
    _config: any,
    payerPublicKey?: any
  ): Promise<string | null> {
    try {
      const tipLamports = 50000;

      // FIX-10 follow-up: resolve the payer key for the Jito tip transaction.
      // Priority: explicit argument → signContext.walletPublicKey.
      // A missing payer would default to PublicKey.default (all zeros) which
      // causes InvalidAccountForFee on every bundle — we must throw instead.
      const rawKey = payerPublicKey ?? this.signContext?.walletPublicKey;
      if (!rawKey) {
        throw new Error('No payer public key available for Jito bundle — cannot build tip transaction');
      }
      const { PublicKey } = await import('@solana/web3.js');
      const resolvedKey = typeof rawKey === 'string' ? new PublicKey(rawKey) : rawKey;

      const bundleId = await this.jitoService.submitBundle([transaction], resolvedKey, tipLamports);
      log(`📦 Bundle submitted to Jito: ${bundleId}`);
      return bundleId;
    } catch (error) {
      log('⚠️ Jito submission failed, falling back to regular submission');
      try {
        const signature = await this.connection.sendTransaction(transaction, {
          skipPreflight: true, preflightCommitment: 'processed', maxRetries: 0
        });
        return signature;
      } catch (fallbackError) {
        console.error('Both Jito and regular submission failed:', fallbackError);
        return null;
      }
    }
  }

  private startPrecomputationLoop() {
    const precomputeInterval = setInterval(async () => {
      if (!this.isRunning) return;
      try { await this.precomputeTransactions(); }
      catch (error) { console.error('Error in precomputation loop:', error); }
    }, 30000);
    this.activeSnipes.set('precompute', precomputeInterval);
  }

  private async precomputeTransactions() {
    try {
      const activeConfigs = await this.getActiveConfigs();
      for (const config of activeConfigs) {
        if (config.tokenAddress && !this.precomputedTxs.has(config.tokenAddress)) {
          log(`📦 [Sniper] Precompute skipped (using smart-route on detection for ${config.name})`);
        }
      }
      this.cleanupExpiredTransactions();
    } catch (error) { console.error('Error precomputing transactions:', error); }
  }

  private startAutoSellLoop() {
    const autoSellInterval = setInterval(async () => {
      if (!this.isRunning) return;
      try { await this.checkAutoSellConditions(); }
      catch (error) { console.error('Error in auto-sell loop:', error); }
    }, 5000);
    this.activeSnipes.set('autoSell', autoSellInterval);
  }

  private async checkAutoSellConditions() {
    try {
      const activeSnipes = await prisma.active_snipes.findMany({ where: { status: 'monitoring' } });
      for (const snipe of activeSnipes) { await this.checkSingleAutoSell(snipe); }
    } catch (error) { console.error('Error checking auto-sell conditions:', error); }
  }

  private async checkSingleAutoSell(snipe: any) {
    try {
      const config = await this.getConfigById(snipe.configId);
      if (!config) return;
      const sellTarget = parseFloat(config.sellTarget);
      const stopLoss = parseFloat(config.stopLoss);
      if (isNaN(sellTarget) && isNaN(stopLoss)) return;
      const currentPrice = await this.getCurrentPrice(snipe.tokenAddress, config.dex);
      if (!currentPrice) return;
      const buyTx = await this.getBuyTransaction(snipe.buyTxId);
      if (!buyTx) return;
      const initialPrice = buyTx.price;
      const changePercent = ((currentPrice - initialPrice) / initialPrice) * 100;
      log(`📊 Price check for ${config.name}: ${changePercent.toFixed(2)}% change`);
      let shouldSell = false, reason = '';
      if (!isNaN(sellTarget) && changePercent >= sellTarget) { shouldSell = true; reason = `Take profit at ${sellTarget}%`; }
      else if (!isNaN(stopLoss) && changePercent <= -stopLoss) { shouldSell = true; reason = `Stop loss at ${-stopLoss}%`; }
      if (shouldSell) { log(`🎯 Auto-sell triggered: ${reason}`); await this.executeSell(config, snipe); }
      await prisma.active_snipes.update({ where: { id: snipe.id }, data: { lastPriceCheck: new Date() } });
    } catch (error) { console.error('Error checking single auto-sell:', error); }
  }

  private async executeSell(config: SniperConfig, snipe: any) {
    try {
      const sellTx = await this.createSellTransaction(config, snipe.tokenAddress);
      if (!sellTx) return;
      const signature = await this.submitWithJito(sellTx, config);
      if (signature) {
        await this.recordTransaction(config, snipe.tokenAddress, signature, 'sell');
        await prisma.active_snipes.update({ where: { id: snipe.id }, data: { status: 'completed' } });
        toast.success(`💰 Auto-sell executed for ${config.name}`);
      }
    } catch (error) { console.error('Error executing sell:', error); }
  }

  private async createSellTransaction(config: SniperConfig, _tokenAddress: string): Promise<SolanaVersionedTransaction | null> {
    return null; // Placeholder — sell routing to be implemented
  }

  private getWalletPublicKey(): string | null {
    try {
      if (typeof window !== 'undefined') {
        const walletAdapter = (window as any).solanaWalletAdapter;
        if (walletAdapter?.publicKey) return walletAdapter.publicKey.toString();
      }
      if (typeof localStorage !== 'undefined') {
        const storedPublicKey = localStorage.getItem('walletPublicKey');
        if (storedPublicKey) return storedPublicKey;
      }
      return null;
    } catch { return null; }
  }

  // ── Helpers (stubs — filled in by DB when configs are active) ─────────────
  private async getTargetConfigs(_tokenAddress: string): Promise<SniperConfig[]> { return []; }
  private async getActiveConfigs(): Promise<SniperConfig[]> { return []; }
  private async getCurrentPrice(_tokenAddress: string, _dex: string): Promise<number | null> { return null; }
  private async getBuyTransaction(txId: string): Promise<any> {
    return await prisma.transactions.findUnique({ where: { txId } });
  }
  private async getConfigById(_configId: string): Promise<SniperConfig | null> { return null; }

  private async recordTransaction(config: SniperConfig, tokenAddress: string, signature: string, type: 'buy' | 'sell') {
    try {
      console.log(`📝 Recording sniper transaction: ${type} ${tokenAddress} - ${signature}`);
      const txDetails = await this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!txDetails) { console.error(`❌ Could not fetch transaction details for ${signature}`); return; }
      let tokenName = tokenAddress, tokenSymbol: string | null = null;
      try {
        const response = await fetch(`https://api.solana.fm/v1/tokens/${tokenAddress}`);
        if (response.ok) { const m = await response.json(); tokenName = m.name || tokenAddress; tokenSymbol = m.symbol || null; }
      } catch { /**/ }
      const amount = type === 'buy' ? parseFloat(config.buyAmount) : ((config as any).sellPercent || 100);
      let transactionAnalysis: TransactionAnalysis | null = null;
      try { transactionAnalysis = await analyzeTransaction(signature, (config as any).walletAddress || ''); }
      catch { /**/ }
      await prisma.transactions.create({
        data: {
          userId: (config as any).userId, txId: signature, tokenName, tokenSymbol, tokenAddress,
          type, amount, price: 1, status: 'confirmed', dex: 'SNIPER', timestamp: new Date(),
          totalSolCost: transactionAnalysis?.totalSolCost || null,
          gasFees: transactionAnalysis?.gasFees || null,
          jitoTip: transactionAnalysis?.jitoTip || null,
          netSolAmount: transactionAnalysis?.netSolAmount || null,
          preBalance: transactionAnalysis?.preBalance || null,
          postBalance: transactionAnalysis?.postBalance || null,
        }
      });
      console.log(`✅ Sniper transaction recorded: ${type} ${tokenName} - ${signature}`);
    } catch (error) { console.error(`❌ Failed to record sniper transaction ${signature}:`, error); }
  }

  private cleanupExpiredTransactions() {
    const now = Date.now();
    for (const [key, tx] of this.precomputedTxs) {
      if (tx.expiresAt <= now) this.precomputedTxs.delete(key);
    }
  }
}
