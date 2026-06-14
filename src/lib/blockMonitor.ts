// src/lib/blockMonitor.ts
import * as web3 from '@solana/web3.js';
import WebSocket from 'ws';
import * as crypto from 'crypto';
import { prisma } from './prisma';
import { log } from './logStore';

// Type aliases to avoid TypeScript namespace issues
type SolanaConnection = any; // Connection
type SolanaParsedConfirmedTransaction = any; // ParsedConfirmedTransaction

export interface TokenCreationEvent {
  tokenAddress: string;
  tokenName?: string;
  symbol?: string;
  liquidityPool?: string;
  dex: string;
  timestamp: number;
  slot: number;
  signature: string;
}

export class BlockMonitor {
  private connection: SolanaConnection;
  private wsConnection: WebSocket | null = null;
  private isMonitoring = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private onTokenCreated?: (event: TokenCreationEvent) => void;

  constructor(rpcEndpoint: string, private wsEndpoint: string) {
    this.connection = new web3.Connection(rpcEndpoint, {
      commitment: 'confirmed',
      wsEndpoint: wsEndpoint
    });
  }

  async startMonitoring(onTokenCreated: (event: TokenCreationEvent) => void) {
    this.onTokenCreated = onTokenCreated;
    this.isMonitoring = true;
    
    log('🔍 Starting real-time block monitoring for new tokens...');
    
    try {
      // Method 1: Subscribe to new signatures for token creation programs
      await this.subscribeToTokenPrograms();
      
      // Method 2: WebSocket connection for real-time updates
      await this.connectWebSocket();
      
      // Method 3: Monitor logs for Raydium/Jupiter pool creation
      await this.subscribeToLogs();
      
    } catch (error) {
      console.error('Failed to start block monitoring:', error);
      throw error;
    }
  }

  private async subscribeToTokenPrograms() {
    // Subscribe to Token Program for new token creation
    const TOKEN_PROGRAM_ID = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    
    this.connection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (accountInfo: any, context: any) => {
        await this.handleProgramAccountChange(accountInfo, context);
      },
      'confirmed'
    );
  }

  private async connectWebSocket() {
    if (this.wsConnection) {
      this.wsConnection.close();
    }

    try {
      this.wsConnection = new WebSocket(this.wsEndpoint);
      
      this.wsConnection.on('open', () => {
        log('✅ WebSocket connection established');
        this.reconnectAttempts = 0;

        // P1 fix: blockSubscribe is a validator-only RPC method — public
        // endpoints (Helius, QuickNode) reject it, silently breaking 0-block detection.
        // logsSubscribe is supported on all endpoints and is sufficient to detect
        // new Pump.fun token launches and Raydium pool creation events.
        const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
        const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

        this.wsConnection?.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [
            { mentions: [PUMP_FUN_PROGRAM, RAYDIUM_AMM_PROGRAM] },
            { commitment: 'processed' }   // 'processed' = fastest, acceptable for snipe detection
          ]
        }));
      });

      this.wsConnection.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          // logsSubscribe emits 'logsNotification' (not 'blockNotification')
          if (message.method === 'logsNotification') {
            const logs = message.params?.result?.value;
            if (logs) await this.processLogEvent(logs);
          }
        } catch (error) {
          console.error('Error processing WebSocket message:', error);
        }
      });

      this.wsConnection.on('close', () => {
        log('❌ WebSocket connection closed');
        if (this.isMonitoring && this.reconnectAttempts < this.maxReconnectAttempts) {
          setTimeout(() => this.reconnectWebSocket(), 5000);
        }
      });

    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      this.reconnectWebSocket();
    }
  }

  private async subscribeToLogs() {
    // Subscribe to Raydium program logs for new pool creation
    const RAYDIUM_PROGRAM_ID = new web3.PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    
    this.connection.onLogs(
      RAYDIUM_PROGRAM_ID,
      async (logs: any, context: any) => {
        await this.handleRaydiumLogs(logs, context);
      },
      'confirmed'
    );

    // Subscribe to Jupiter program logs
    const JUPITER_PROGRAM_ID = new web3.PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    
    this.connection.onLogs(
      JUPITER_PROGRAM_ID,
      async (logs: any, context: any) => {
        await this.handleJupiterLogs(logs, context);
      },
      'confirmed'
    );
  }

  /**
   * P1 fix: Process a logsNotification event from logsSubscribe.
   * Extracts the transaction signature, identifies the DEX, and emits a token event.
   * Replaces the old processNewBlock path which relied on the validator-only blockSubscribe.
   */
  private async processLogEvent(logEvent: any) {
    try {
      const signature = logEvent.signature;
      const slot = logEvent.context?.slot ?? 0;
      if (!signature) return;

      // Identify DEX from logs (which program was mentioned)
      const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
      const RAYDIUM_PROGRAM   = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
      const logs: string[] = logEvent.logs || [];
      const hasPumpFun = logs.some(l => l.includes(PUMP_FUN_PROGRAM));
      const hasRaydium = logs.some(l => l.includes(RAYDIUM_PROGRAM));
      if (!hasPumpFun && !hasRaydium) return;

      const dex = hasPumpFun ? 'pump.fun' : 'raydium';

      // Use existing logic to fetch tx details and extract token address
      const tokenEvent = await this.extractTokenCreationEvent(
        { signatures: [signature] },
        slot
      );

      if (tokenEvent) {
        const event: TokenCreationEvent = { ...tokenEvent, dex };
        await this.saveNewToken(event);
        this.onTokenCreated?.(event);
        log(`🎯 Token launch detected via ${dex}: ${event.tokenAddress}`);
      }
    } catch (error) {
      console.error('Error processing log event:', error);
    }
  }

  private async processNewBlock(blockData: any) {
    try {
      const transactions = blockData.value?.block?.transactions || [];
      
      for (const tx of transactions) {
        if (tx && tx.transaction) {
          await this.analyzeTxForTokenCreation(tx.transaction, blockData.value.slot);
        }
      }
    } catch (error) {
      console.error('Error processing new block:', error);
    }
  }

  private async analyzeTxForTokenCreation(transaction: any, slot: number) {
    try {
      // Look for token mint instructions
      const instructions = transaction.message?.instructions || [];
      
      for (const instruction of instructions) {
        if (this.isTokenCreationInstruction(instruction)) {
          const tokenEvent = await this.extractTokenCreationEvent(transaction, slot);
          if (tokenEvent) {
            await this.saveNewToken(tokenEvent);
            this.onTokenCreated?.(tokenEvent);
          }
        }
      }
    } catch (error) {
      console.error('Error analyzing transaction for token creation:', error);
    }
  }

  private isTokenCreationInstruction(instruction: any): boolean {
    // Check if this is a token creation or pool creation instruction
    const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const RAYDIUM_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
    
    return instruction.programId === TOKEN_PROGRAM_ID || 
           instruction.programId === RAYDIUM_PROGRAM_ID;
  }

  private async extractTokenCreationEvent(transaction: any, slot: number): Promise<TokenCreationEvent | null> {
    try {
      // Parse transaction for token creation details
      // This is a simplified implementation - you'd need more sophisticated parsing
      const signature = transaction.signatures?.[0];
      
      if (!signature) return null;

      // Get detailed transaction information
      const txDetails = await this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });

      if (!txDetails || !txDetails.meta) return null;

      // Extract token address from transaction
      const tokenAddress = this.extractTokenAddressFromTx(txDetails);
      
      if (!tokenAddress) return null;

      return {
        tokenAddress,
        dex: 'unknown', // Determine based on program ID
        timestamp: Date.now(),
        slot,
        signature
      };
    } catch (error) {
      console.error('Error extracting token creation event:', error);
      return null;
    }
  }

  private extractTokenAddressFromTx(tx: SolanaParsedConfirmedTransaction): string | null {
    // Extract new token address from transaction
    // This would need more sophisticated parsing based on the specific transaction structure
    const postTokenBalances = tx.meta?.postTokenBalances || [];
    const preTokenBalances = tx.meta?.preTokenBalances || [];
    
    // Find newly created token accounts
    for (const postBalance of postTokenBalances) {
      const existsInPre = preTokenBalances.find(
        (pre: any) => pre.accountIndex === postBalance.accountIndex
      );
      
      if (!existsInPre && postBalance.mint) {
        return postBalance.mint;
      }
    }
    
    return null;
  }

  private async handleProgramAccountChange(accountInfo: any, context: any) {
    // Handle token program account changes
    log(`Token program account change detected at slot ${context.slot}`);
  }

  private async handleRaydiumLogs(logs: any, context: any) {
    // Parse Raydium logs for new pool creation
    const logMessages = logs.logs || [];
    
    for (const logMessage of logMessages) {
      if (logMessage.includes('InitializeInstruction') || logMessage.includes('CreatePool')) {
        log(`Potential Raydium pool creation detected: ${logs.signature}`);
        // Extract token details and notify
      }
    }
  }

  private async handleJupiterLogs(logs: any, context: any) {
    // Parse Jupiter logs for new routes/tokens
    log(`Jupiter activity detected: ${logs.signature}`);
  }

  private async saveNewToken(event: TokenCreationEvent) {
    try {
      await prisma.new_tokens.create({
        data: {
          id: crypto.randomUUID(),
          tokenAddress: event.tokenAddress,
          tokenName: event.tokenName,
          tokenSymbol: event.symbol,
          liquidityPool: event.liquidityPool,
          dex: event.dex,
          isMonitored: true
        }
      });
      
      log(`💾 Saved new token to database: ${event.tokenAddress}`);
    } catch (error) {
      // Handle duplicate key errors gracefully
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('unique constraint')) {
        console.error('Error saving new token:', error);
      }
    }
  }

  private reconnectWebSocket() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log('❌ Max WebSocket reconnection attempts reached');
      return;
    }
    
    this.reconnectAttempts++;
    log(`🔄 Attempting WebSocket reconnection (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    setTimeout(() => {
      this.connectWebSocket();
    }, 5000 * this.reconnectAttempts);
  }

  stopMonitoring() {
    this.isMonitoring = false;
    
    if (this.wsConnection) {
      this.wsConnection.close();
      this.wsConnection = null;
    }
    
    log('⏹️ Block monitoring stopped');
  }
}
