import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, Account, getAssociatedTokenAddress } from '@solana/spl-token';
import { notify } from './notifications';

// wSOL mint address
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// The RPC endpoint - use Helius directly for wallet connections
// import.meta.env.VITE_* is resolved by Vite at build time; process.env.VITE_* is always undefined in browser
const HELIUS_API_KEY = import.meta.env.VITE_HELIUS_API_KEY;
const SOLANA_NETWORK = import.meta.env.VITE_SOLANA_NETWORK || 'mainnet-beta';

export const SOLANA_RPC_ENDPOINT = `https://${SOLANA_NETWORK}.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;


// Backup RPC endpoints
export const SOLANA_BACKUP_RPC_ENDPOINT = SOLANA_RPC_ENDPOINT;

// Known token addresses
export const WSOL_TOKEN_ADDRESS = 'So11111111111111111111111111111111111111112';

// Interface for token holding information
export interface TokenHolding {
  mint: string;
  balance: number;
  decimals: number;
  amount: string; // Raw amount as string
  uiAmount: number | null;
  symbol?: string;
  name?: string;
  logoURI?: string;
  price?: number;
  value?: number; // USD value
}

/**
 * Format a Solana public key for display (first 4 and last 4 characters)
 */
export const formatPublicKey = (publicKey: string | null): string => {
  if (!publicKey) return 'No key';

  return `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`;
};

/**
 * Get SOL balance for a wallet address
 */
export const getSolBalance = async (
  connection: any,
  publicKey: string | any
): Promise<number> => {
  try {
    // Convert to PublicKey if it's a string
    const pubKey = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;

    // Get balance in lamports
    const balance = await connection.getBalance(pubKey);

    // Convert to SOL
    const solBalance = balance / LAMPORTS_PER_SOL;

    console.log(`SOL balance for ${pubKey.toString()}: ${solBalance}`);
    return solBalance;
  } catch (error) {
    console.error('Error fetching SOL balance:', error);
    // Try backup RPC endpoint if primary fails
    try {
      const backupConnection = new Connection(SOLANA_BACKUP_RPC_ENDPOINT, 'confirmed');
      const pubKey = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;
      const balance = await backupConnection.getBalance(pubKey);
      const solBalance = balance / LAMPORTS_PER_SOL;
      console.log(`SOL balance from backup RPC for ${pubKey.toString()}: ${solBalance}`);
      return solBalance;
    } catch (backupError) {
      console.error('Error fetching SOL balance from backup RPC:', backupError);
      return 0; // Return 0 instead of throwing to avoid crashing the app
    }
  }
};

/**
 * Get all SPL token holdings for a wallet
 * @param connection The Solana connection
 * @param walletPublicKey The wallet public key
 * @returns Array of token holdings
 */
export async function getAllTokenHoldings(
  connection: any,
  walletPublicKey: string | any
): Promise<TokenHolding[]> {
  try {
    const pubKey = typeof walletPublicKey === 'string' ? new PublicKey(walletPublicKey) : walletPublicKey;

    console.log(`Fetching token holdings for wallet: ${pubKey.toString()}`);

    // Get all token accounts for this wallet
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      pubKey,
      { programId: TOKEN_PROGRAM_ID }
    );

    const holdings: TokenHolding[] = [];

    for (const accountInfo of tokenAccounts.value) {
      try {
        const parsedInfo = accountInfo.account.data.parsed.info;
        const tokenAmount = parsedInfo.tokenAmount;

        // Only include tokens with a balance > 0
        if (parseFloat(tokenAmount.amount) > 0) {
          const holding: TokenHolding = {
            mint: parsedInfo.mint,
            balance: tokenAmount.uiAmount || 0,
            decimals: tokenAmount.decimals,
            amount: tokenAmount.amount,
            uiAmount: tokenAmount.uiAmount,
          };

          holdings.push(holding);
        }
      } catch (accountError) {
        console.warn('Error parsing token account:', accountError);
      }
    }

    console.log(`Found ${holdings.length} token holdings for wallet ${pubKey.toString()}`);
    return holdings;
  } catch (error) {
    console.error('Error fetching token holdings:', error);

    // Try with backup connection
    try {
      const backupConnection = new Connection(SOLANA_BACKUP_RPC_ENDPOINT, 'confirmed');
      const pubKey = typeof walletPublicKey === 'string' ? new PublicKey(walletPublicKey) : walletPublicKey;

      const tokenAccounts = await backupConnection.getParsedTokenAccountsByOwner(
        pubKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      const holdings: TokenHolding[] = [];

      for (const accountInfo of tokenAccounts.value) {
        try {
          const parsedInfo = accountInfo.account.data.parsed.info;
          const tokenAmount = parsedInfo.tokenAmount;

          if (parseFloat(tokenAmount.amount) > 0) {
            const holding: TokenHolding = {
              mint: parsedInfo.mint,
              balance: tokenAmount.uiAmount || 0,
              decimals: tokenAmount.decimals,
              amount: tokenAmount.amount,
              uiAmount: tokenAmount.uiAmount,
            };

            holdings.push(holding);
          }
        } catch (accountError) {
          console.warn('Error parsing token account with backup:', accountError);
        }
      }

      console.log(`Found ${holdings.length} token holdings for wallet ${pubKey.toString()} (backup)`);
      return holdings;
    } catch (backupError) {
      console.error('Error fetching token holdings from backup RPC:', backupError);
      return [];
    }
  }
}

/**
 * Get wSOL balance for an account
 * @param connection The Solana connection
 * @param publicKey The public key to check balance for
 * @returns Balance in wSOL
 */
export async function getWsolBalance(connection: any, walletPubkey: any): Promise<number> {
  try {
    // Get all token accounts for this wallet
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletPubkey,
      { programId: TOKEN_PROGRAM_ID }
    );

    // Find the WSOL account
    const wsolAccount = tokenAccounts.value.find((accountInfo: any) =>
      accountInfo.account.data.parsed.info.mint === WSOL_TOKEN_ADDRESS
    );

    if (!wsolAccount) {
      return 0;
    }

    // Get the balance and convert to SOL
    const rawBalance = wsolAccount.account.data.parsed.info.tokenAmount.amount;
    const decimals = wsolAccount.account.data.parsed.info.tokenAmount.decimals;

    return parseFloat(rawBalance) / Math.pow(10, decimals);
  } catch (error) {
    console.error('Error fetching WSOL balance:', error);

    // Try backup RPC endpoint if primary fails
    try {
      const backupConnection = new Connection(SOLANA_BACKUP_RPC_ENDPOINT, 'confirmed');
      const tokenAccounts = await backupConnection.getParsedTokenAccountsByOwner(
        walletPubkey,
        { programId: TOKEN_PROGRAM_ID }
      );

      const wsolAccount = tokenAccounts.value.find((accountInfo: any) =>
        accountInfo.account.data.parsed.info.mint === WSOL_TOKEN_ADDRESS
      );

      if (!wsolAccount) {
        return 0;
      }

      const rawBalance = wsolAccount.account.data.parsed.info.tokenAmount.amount;
      const decimals = wsolAccount.account.data.parsed.info.tokenAmount.decimals;

      return parseFloat(rawBalance) / Math.pow(10, decimals);
    } catch (backupError) {
      console.error('Error fetching WSOL balance from backup RPC:', backupError);
      return 0;
    }
  }
}

/**
 * Check if a string is a valid Solana address
 */
export const isValidSolanaAddress = (address: string): boolean => {
  try {
    new PublicKey(address);
    return true;
  } catch (error) {
    return false;
  }
};
