import * as web3 from '@solana/web3.js';
import axios from 'axios';
import { toast } from './toast-shim';
import { Buffer } from 'buffer';

// Type alias to bypass TypeScript namespace issues
type SolanaVersionedTransaction = any; // VersionedTransaction

export const getJupiterQuote = async (
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number
): Promise<any> => {
  try {
    const response = await axios.get('/api/jupiter/quote', {
      params: {
        inputMint,
        outputMint,
        amount,
        slippageBps,
      },
    });
    if (!response.data) {
      throw new Error("Failed to get a quote from Jupiter API.");
    }
    return response.data;
  } catch (error) {
    console.error("Error getting Jupiter quote:", error);
    toast.error("Failed to get a quote from Jupiter API.");
    return null;
  }
};

export const getJupiterSwapTransaction = async (
  quoteResponse: any,
  userPublicKey: string
): Promise<SolanaVersionedTransaction | null> => {
  try {
    const response = await axios.post('/api/jupiter/swap', {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
    });

    const { swapTransaction } = response.data;
    if (!swapTransaction) return null;

    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    return web3.VersionedTransaction.deserialize(swapTransactionBuf);
  } catch (error) {
    console.error("Error getting Jupiter swap transaction:", error);
    toast.error("Failed to get a swap transaction from Jupiter API.");
    return null;
  }
};
