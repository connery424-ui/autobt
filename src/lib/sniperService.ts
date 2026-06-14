// src/lib/sniperService.ts

import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import toast from './toast-shim';
import { SniperConfig } from '../store/slices/sniperConfigsSlice';
import { log } from './logStore';
import { getRaydiumQuote, getRaydiumSwapTransaction } from './raydium';
import { store } from '../store';
import { getJupiterQuote, getJupiterSwapTransaction } from './jupiter';
import { Buffer } from 'buffer';

// Type aliases to avoid TypeScript namespace issues
type SolanaConnection = any; // Connection
type SolanaPublicKey = any; // PublicKey  
type SolanaVersionedTransaction = any; // VersionedTransaction
import { Transaction, addTransaction as addTransactionAction } from '../store/slices/transactionsSlice';
import { addTransaction as addTransactionToStore } from './transactionStore';
import { fetchTokenInfo } from './tokenService';

// Store active snipe tasks
const activeSnipeTasks: Map<string, NodeJS.Timeout> = new Map();

// Validate token address
export function validateTokenAddress(address: string): boolean {
  if (!address || address.trim() === '') return false;
  try {
    new PublicKey(address);
    return true;
  } catch (error) {
    return false;
  }
}

// Function to add new transaction
export const addTransaction = async (transaction: Transaction) => {
  console.log("Adding transaction to both Redux store and database:", transaction);
  
  // Add to Redux store for immediate UI update
  store.dispatch(addTransactionAction(transaction));
  
  // Add to localStorage and sync with database
  await addTransactionToStore(transaction);
};

// Function to create new transaction
export const createTransaction = async (config: SniperConfig, type: 'buy' | 'sell', status: 'pending' | 'confirmed' | 'failed' = 'pending', profit?: number): Promise<Transaction> => {
  const id = `tx-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const buyAmount = parseFloat(config.buyAmount) || 0.1;
  const tokenType = config.tokenType || 'sol';

  // Fetch actual token metadata from blockchain
  let tokenName = config.name || "Unknown Token";
  let tokenSymbol: string | undefined;
  
  try {
    const tokenInfo = await fetchTokenInfo(config.tokenAddress);
    if (tokenInfo) {
      tokenName = tokenInfo.name || config.name || "Unknown Token";
      tokenSymbol = tokenInfo.symbol;
    }
  } catch (error) {
    console.warn(`Failed to fetch token info for ${config.tokenAddress}:`, error);
    // Fall back to config name
  }

  return {
    id,
    tokenName,
    tokenSymbol: tokenSymbol || 'UNKNOWN', // Provide default value
    tokenAddress: config.tokenAddress,
    type,
    amount: 0, // Will be updated later with the actual amount from the quote
    price: type === 'buy' ? buyAmount : 0, // Sell price will be updated on confirmation
    profit,
    status,
    timestamp: Date.now(),
    txId: `simulated-${id}`,
    tokenType: tokenType as 'sol' | 'wsol',
    dex: config.dex,
  };
};

// Auto sell function (real-time price check, real sell action)
const setupAutoSell = (
  config: SniperConfig,
  buyTx: Transaction,
  connection: SolanaConnection,
  publicKey: SolanaPublicKey,
  sendTransaction: (transaction: SolanaVersionedTransaction, connection: SolanaConnection) => Promise<string>
) => {
  const sellTarget = parseFloat(config.sellTarget);
  const stopLoss = parseFloat(config.stopLoss);
  
  if (isNaN(sellTarget) && isNaN(stopLoss)) return;

  const checkPriceAndSell = async () => {
    try {
      let quoteResponse: any;
      const slippageBps = parseInt(config.maxSlippage) * 100;
      const outputMint = 'So11111111111111111111111111111111111111111'; // Native SOL

      // Get a quote for the entire holding to determine its current value in SOL
      if (config.dex === 'raydium') {
        quoteResponse = await getRaydiumQuote(config.tokenAddress, outputMint, buyTx.amount, slippageBps);
      } else { // Default to Jupiter
        quoteResponse = await getJupiterQuote(config.tokenAddress, outputMint, buyTx.amount, slippageBps);
      }

      if (!quoteResponse) {
        console.warn(`[Auto-Sell] Could not get a price quote for ${config.name} on ${config.dex}. Skipping this check.`);
        return;
      }

      const currentValueInSol = parseInt(quoteResponse.outAmount, 10) / 1e9;
      const initialValueInSol = parseFloat(config.buyAmount);

      if (initialValueInSol === 0) return;

      const changePercent = ((currentValueInSol - initialValueInSol) / initialValueInSol) * 100;

      console.log(`[Auto-Sell Check] ${config.name}: Current Value: ${currentValueInSol.toFixed(4)} SOL, Initial: ${initialValueInSol.toFixed(4)} SOL, Change: ${changePercent.toFixed(2)}%`);

      let shouldSell = false;
      let reason = '';

      if (!isNaN(sellTarget) && changePercent >= sellTarget) {
        shouldSell = true;
        reason = `Sell target of ${sellTarget}% hit.`;
      } else if (!isNaN(stopLoss) && changePercent <= -stopLoss) {
        shouldSell = true;
        reason = `Stop loss of ${-stopLoss}% hit.`;
      }

      if (shouldSell) {
        console.log(`[Auto-Sell] ${reason} Selling ${config.name}.`);
        toast.info(`Auto-sell triggered for ${config.name}: ${reason}`);
        
        clearInterval(priceCheckInterval);
        activeSnipeTasks.delete(config.id);

        sellToken(config, buyTx, connection, publicKey, sendTransaction).catch(err => { // This now correctly calls the unified sellToken
          console.error("Auto-sell failed after trigger:", err);
        });
      }
    } catch (error: any) {
      console.warn(`Error during auto-sell price check for ${config.name}: ${error.message}`);
    }
  };
  
  // Check price every 15 seconds. A shorter interval risks API rate-limiting.
  const priceCheckInterval = setInterval(checkPriceAndSell, 15000);
  activeSnipeTasks.set(config.id, priceCheckInterval);
  toast.info(`Auto-sell monitoring enabled for ${config.name}.`);
};

// Function to cancel all snipe tasks
export const cancelAllSnipeTasks = () => {
  activeSnipeTasks.forEach((interval) => clearInterval(interval));
  activeSnipeTasks.clear();
};

// Unified function to buy a token
export const buyToken = async (
  config: SniperConfig,
  connection: SolanaConnection,
  publicKey: SolanaPublicKey,
  sendTransaction: (transaction: SolanaVersionedTransaction, connection: SolanaConnection) => Promise<string>
): Promise<Transaction> => {
  log(`buyToken called for DEX: ${config.dex}`);

  if (!validateTokenAddress(config.tokenAddress)) {
    toast.error("Invalid token address");
    const failedTx = await createTransaction(config, 'buy', 'failed');
    await addTransaction(failedTx);
    return failedTx;
  }

  const pendingTx = await createTransaction(config, 'buy', 'pending');
  await addTransaction(pendingTx);

  try {
    const amountInLamports = Math.floor((parseFloat(config.buyAmount) || 0.1) * 1e9);
    const slippageBps = parseInt(config.maxSlippage) * 100;
    const inputMint = 'So11111111111111111111111111111111111111111'; // Native SOL

    let quoteResponse: any;
    let swapTx: SolanaVersionedTransaction | null;

    if (config.dex === 'raydium') {
      quoteResponse = await getRaydiumQuote(inputMint, config.tokenAddress, amountInLamports, slippageBps);
      if (!quoteResponse) throw new Error("Failed to get a quote from Raydium API.");
      swapTx = await getRaydiumSwapTransaction(
        quoteResponse, 
        publicKey.toString(),
        undefined,  // inputAccount
        undefined,  // outputAccount
        false,      // wrapSol
        true        // unwrapSol
      );
    } else { // Default to Jupiter
      quoteResponse = await getJupiterQuote(inputMint, config.tokenAddress, amountInLamports, slippageBps);
      if (!quoteResponse) throw new Error("Failed to get a quote from Jupiter API.");
      swapTx = await getJupiterSwapTransaction(quoteResponse, publicKey.toString());
    }

    if (!quoteResponse || !quoteResponse.outAmount) {
      throw new Error(`Invalid quote response from ${config.dex} API.`);
    }
    
    pendingTx.amount = parseInt(quoteResponse.outAmount, 10);
    await addTransaction(pendingTx);

    if (!swapTx) {
      throw new Error(`Failed to get a swap transaction from ${config.dex} API.`);
    }

    const signature = await sendTransaction(swapTx, connection);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');

    const confirmedTx = {
      ...pendingTx,
      status: 'confirmed' as const,
      txId: signature,
      price: parseFloat(config.buyAmount) || 0.1,
    };
    await addTransaction(confirmedTx);
    toast.success(`Successfully bought ${config.name} on ${config.dex}`);
    setupAutoSell(config, confirmedTx, connection, publicKey, sendTransaction);
    return confirmedTx;
  } catch (error: any) {
    console.error(`Transaction failed on ${config.dex}:`, error);
    const failedTx = {
      ...pendingTx,
      status: 'failed' as const,
    };
    await addTransaction(failedTx);
    toast.error(`Failed to buy ${config.name} on ${config.dex}: ${error.message}`);
    return failedTx;
  }
};

// Unified function to sell a token
export const sellToken = async (
  config: SniperConfig,
  buyTx: Transaction,
  connection: SolanaConnection,
  publicKey: SolanaPublicKey,
  sendTransaction: (transaction: SolanaVersionedTransaction, connection: SolanaConnection) => Promise<string>
): Promise<Transaction> => {
  log(`sellToken called for DEX: ${config.dex}`);

  const pendingTx = await createTransaction(config, 'sell', 'pending');
  pendingTx.amount = buyTx.amount;
  await addTransaction(pendingTx);

  try {
    const slippageBps = parseInt(config.maxSlippage) * 100;
    const outputMint = 'So11111111111111111111111111111111111111111'; // Native SOL

    let quoteResponse: any;
    let swapTx: SolanaVersionedTransaction | null;

    if (config.dex === 'raydium') {
      quoteResponse = await getRaydiumQuote(config.tokenAddress, outputMint, buyTx.amount, slippageBps);
      if (!quoteResponse) throw new Error("Failed to get a sell quote from Raydium API.");
      swapTx = await getRaydiumSwapTransaction(
        quoteResponse, 
        publicKey.toString(),
        undefined,  // inputAccount
        undefined,  // outputAccount
        false,      // wrapSol
        true        // unwrapSol
      );
    } else { // Default to Jupiter
      quoteResponse = await getJupiterQuote(config.tokenAddress, outputMint, buyTx.amount, slippageBps);
      if (!quoteResponse) throw new Error("Failed to get a sell quote from Jupiter API.");
      swapTx = await getJupiterSwapTransaction(quoteResponse, publicKey.toString());
    }

    if (!quoteResponse || !quoteResponse.outAmount) {
      throw new Error(`Invalid sell quote response from ${config.dex} API.`);
    }

    if (!swapTx) {
      throw new Error(`Failed to get a swap transaction from ${config.dex} API.`);
    }

    const signature = await sendTransaction(swapTx, connection);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');

    // Calculate profit
    const solReceived = parseInt(quoteResponse.outAmount, 10) / 1e9;
    const solSpent = parseFloat(config.buyAmount);
    const profit = solReceived - solSpent;

    const confirmedTx = { ...pendingTx, status: 'confirmed' as const, txId: signature, price: solReceived, profit };
    await addTransaction(confirmedTx);

    const profitMsg = profit >= 0 ? `profit: +${profit.toFixed(4)} SOL` : `loss: ${profit.toFixed(4)} SOL`;
    toast.success(`Successfully sold ${config.name} on ${config.dex} (${profitMsg})`);
    return confirmedTx;

  } catch (error: any) {
    console.error(`Sell transaction failed on ${config.dex}:`, error);
    const failedTx = { ...pendingTx, status: 'failed' as const };
    await addTransaction(failedTx);
    toast.error(`Failed to sell ${config.name} on ${config.dex}: ${error.message}`);
    return failedTx;
  }
};

// Snipe function to be called from the UI
export const snipe = async (
  config: SniperConfig,
  connection: SolanaConnection,
  publicKey: SolanaPublicKey,
  sendTransaction: (transaction: SolanaVersionedTransaction, connection: SolanaConnection) => Promise<string>
): Promise<void> => {
  try {
    await buyToken(config, connection, publicKey, sendTransaction);
  } catch (error: any) {
    console.error("Snipe error:", error);
    toast.error(`Error sniping ${config.name || config.tokenAddress}: ${error.message}`);
  }
};

// StartSnipe function to be called from the component
export const startSnipe = (
  config: SniperConfig,
  connection: SolanaConnection,
  publicKey: SolanaPublicKey,
  sendTransaction: (transaction: SolanaVersionedTransaction, connection: SolanaConnection) => Promise<string>
) => {
  if (!validateTokenAddress(config.tokenAddress)) {
    toast.error("Invalid token address");
    return;
  }

  // Transaction creation is now handled inside buyToken to avoid duplicates.
  toast.success(`Starting snipe for ${config.name || config.tokenAddress}`);

  snipe(config, connection, publicKey, sendTransaction).catch((error) => { // Removed unnecessary setTimeout
    console.error('Snipe failed:', error);
  });
};
