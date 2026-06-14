import { VersionedTransaction } from '@solana/web3.js';
import axios from 'axios';
import { Buffer } from 'buffer';

/**
 * Fetches a trade quote from the Raydium API via our secure backend proxy.
 * @param inputMint The mint address of the input token (e.g., SOL).
 * @param outputMint The mint address of the output token.
 * @param amount The amount of the input token to swap, in its smallest unit (lamports).
 * @param slippageBps The slippage tolerance in basis points (e.g., 50 for 0.5%).
 * @returns The quote response from the Raydium API.
 */
export const getRaydiumQuote = async (
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number
): Promise<any> => {
  const response = await axios.get(`/api/raydium/quote`, {
    params: {
      inputMint,
      outputMint,
      amount,
      slippageBps,
    },
  });
  return response.data;
};

/**
 * Fetches a ready-to-sign swap transaction from the Raydium API via our secure backend proxy.
 * @param quote The quote object received from `getRaydiumQuote`.
 * @param userPublicKey The public key of the user's wallet.
 * @param inputTokenAccount The input token account address (optional for SOL).
 * @param outputTokenAccount The output token account address (optional for SOL).
 * @param wrapSol Whether to wrap SOL for input.
 * @param unwrapSol Whether to unwrap SOL for output.
 * @returns A `VersionedTransaction` ready to be signed and sent.
 */
export const getRaydiumSwapTransaction = async (
  quote: any,
  userPublicKey: string,
  inputTokenAccount?: string,
  outputTokenAccount?: string,
  wrapSol: boolean = false,
  unwrapSol: boolean = true
): Promise<any> => {
  try {
    console.log('🔵 Requesting Raydium swap transaction...');
    console.log('🔵 Quote:', quote);
    console.log('🔵 User Public Key:', userPublicKey);
    console.log('🔵 Input Token Account:', inputTokenAccount);
    console.log('🔵 Output Token Account:', outputTokenAccount);
    console.log('🔵 Wrap SOL:', wrapSol);
    console.log('🔵 Unwrap SOL:', unwrapSol);
    
    // Determine input and output mints from quote
    const inputMint = quote.data?.inputMint || quote.inputMint;
    const outputMint = quote.data?.outputMint || quote.outputMint;
    
    // For SPL tokens, try to get associated token accounts if not provided
    let finalInputAccount = inputTokenAccount;
    let finalOutputAccount = outputTokenAccount;
    
    if (!finalInputAccount && inputMint && inputMint !== 'So11111111111111111111111111111111111111112') {
      // This would be calculated on the client side if needed
      console.log('🔵 Input mint requires token account:', inputMint);
    }
    
    if (!finalOutputAccount && outputMint && outputMint !== 'So11111111111111111111111111111111111111112') {
      // This would be calculated on the client side if needed  
      console.log('🔵 Output mint requires token account:', outputMint);
    }
    
    const response = await axios.post('/api/raydium/swap', {
      swapResponse: quote,
      wallet: userPublicKey,
      wrapSol,
      unwrapSol,
      inputAccount: finalInputAccount,
      outputAccount: finalOutputAccount,
      computeUnitPriceMicroLamports: '1000000', // 1000000 micro-lamports = 0.001 SOL priority fee
      txVersion: 'V0',
    });

    console.log('🔵 Raydium swap response:', response.data);

    // Check if the response indicates success
    if (!response.data.success) {
      console.error('❌ Raydium API returned failure:', response.data);
      throw new Error(`Raydium swap failed: ${response.data.msg || 'Unknown error'}`);
    }

    // Get the transaction data from the response
    const transactionData = response.data.data?.[0]?.transaction;
    
    if (!transactionData) {
      console.error('❌ No transaction data found in response:', response.data);
      console.error('❌ Available fields:', Object.keys(response.data));
      throw new Error('No transaction data returned from Raydium API');
    }

    console.log('🔵 Found transaction data:', typeof transactionData);
    
    // The transaction comes back as a base64 encoded string, so we deserialize it
    const transaction = VersionedTransaction.deserialize(Buffer.from(transactionData, 'base64'));
    console.log('🔵 Successfully deserialized Raydium transaction');
    
    return transaction;
  } catch (error: any) {
    console.error('❌ Raydium swap transaction error:', error);
    console.error('❌ Error details:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    
    // Re-throw the error with more context
    if (axios.isAxiosError(error) && error.response?.data?.error) {
      throw new Error(`Raydium swap failed: ${error.response.data.error}`);
    }
    throw error;
  }
};