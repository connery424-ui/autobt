// src/lib/transactionAnalyzer.ts
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

export interface TransactionAnalysis {
  totalSolCost: number;      // Total SOL spent/received (positive for buy, negative for sell)
  gasFees: number;           // Gas fees paid
  jitoTip: number;           // Jito tip paid (if any)
  netSolAmount: number;      // Net SOL for PNL calculation
  preBalance: number;        // SOL balance before transaction
  postBalance: number;       // SOL balance after transaction
}

/**
 * Analyzes a Solana transaction to extract accurate SOL cost information
 * Uses actual blockchain data, not user inputs
 */
export const analyzeTransaction = async (
  txId: string,
  walletAddress: string
): Promise<TransactionAnalysis | null> => {
  try {
    console.log(`🔍 Analyzing transaction: ${txId}`);
    
    // Fetch transaction details from Solana RPC
    const response = await fetch(`https://api.mainnet-beta.solana.com`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [
          txId,
          {
            encoding: 'json',
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          }
        ]
      })
    });

    const data = await response.json();
    
    if (!data.result || data.result.meta.err) {
      console.log(`❌ Transaction failed or not found: ${txId}`);
      return null;
    }

    const transaction = data.result;
    const { meta } = transaction;

    // Find wallet index in the account keys
    const accountKeys = transaction.transaction.message.accountKeys;
    const walletIndex = accountKeys.findIndex((key: string) => key === walletAddress);
    
    if (walletIndex === -1) {
      console.log(`❌ Wallet not found in transaction: ${walletAddress}`);
      return null;
    }

    // Extract balance data
    const preBalance = meta.preBalances[walletIndex] / LAMPORTS_PER_SOL;
    const postBalance = meta.postBalances[walletIndex] / LAMPORTS_PER_SOL;
    const gasFees = meta.fee / LAMPORTS_PER_SOL;
    
    // Calculate total SOL cost (positive = spent, negative = received)
    const totalSolCost = preBalance - postBalance;
    
    // Detect Jito tip (simplified approach)
    const jitoTip = detectJitoTip(transaction, totalSolCost, gasFees);
    
    // Calculate net SOL amount for PNL - this is the actual balance change
    // Positive means you gained SOL (sell), negative means you spent SOL (buy)
    const netSolAmount = postBalance - preBalance;

    const analysis: TransactionAnalysis = {
      totalSolCost,
      gasFees,
      jitoTip,
      netSolAmount,
      preBalance,
      postBalance
    };

    console.log(`✅ Transaction analysis complete:`, {
      txId,
      totalSolCost: totalSolCost.toFixed(9),
      gasFees: gasFees.toFixed(9),
      jitoTip: jitoTip.toFixed(9),
      netSolAmount: netSolAmount.toFixed(9),
      balanceChange: `${preBalance.toFixed(9)} -> ${postBalance.toFixed(9)}`
    });

    return analysis;
  } catch (error) {
    console.error(`❌ Error analyzing transaction ${txId}:`, error);
    return null;
  }
};

/**
 * Detects Jito tip amount from transaction
 * This is a simplified approach - can be enhanced later
 */
const detectJitoTip = (transaction: any, totalSolCost: number, gasFees: number): number => {
  try {
    // Known Jito tip account prefixes
    const JITO_TIP_ACCOUNTS = [
      '96gYz8dYfoRMEGGPWMXLGvJWZQrEJfCMj9CKPeZhHhEs',
      'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
      'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
      'DtmE9D2CSB4L5D6A15mraeEjrGMm6auWVzgaD4jVDiJz',
      'NCybJ7dSoVEUXLZW9BEHfKjvNTqPr9mCjkTp1gFPGqz'
    ];

    const { message } = transaction.transaction;
    let tipAmount = 0;

    // Check for transfers to Jito tip accounts
    if (message.instructions) {
      for (const instruction of message.instructions) {
        // Look for system program transfers
        if (instruction.programId === '11111111111111111111111111111111') {
          const accounts = instruction.accounts;
          if (accounts && accounts.length >= 2) {
            const recipient = message.accountKeys[accounts[1]];
            if (JITO_TIP_ACCOUNTS.includes(recipient)) {
              // This is likely a Jito tip - we'll need to decode the amount
              // For now, we'll estimate based on balance difference
              const estimatedSwapAmount = 0.001; // This would come from the swap instruction
              tipAmount = Math.max(0, totalSolCost - gasFees - estimatedSwapAmount);
              break;
            }
          }
        }
      }
    }

    return tipAmount;
  } catch (error) {
    console.warn('Error detecting Jito tip:', error);
    return 0;
  }
};

/**
 * Calculate PNL between two transactions
 */
export const calculatePNL = (
  buyTransaction: TransactionAnalysis,
  sellTransaction: TransactionAnalysis
): number => {
  // Buy: positive totalSolCost (SOL spent)
  // Sell: negative totalSolCost (SOL received)
  const solSpent = buyTransaction.totalSolCost;
  const solReceived = Math.abs(sellTransaction.totalSolCost);
  
  return solReceived - solSpent;
};
