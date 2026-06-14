// src/lib/transactionApi.ts
import { Transaction } from '../store/slices/transactionsSlice';

export interface ApiTransaction {
  id: string;
  txId: string;
  tokenName: string;
  tokenSymbol?: string; // Add optional token symbol from database
  tokenAddress: string;
  type: 'buy' | 'sell';
  amount: number | string; // Can come as string from database
  price: number | string; // Can come as string from database
  profit?: number | string; // Can come as string from database
  status: 'pending' | 'confirmed' | 'failed';
  tokenType: 'sol' | 'wsol';
  dex: string;
  timestamp: string; // ISO string from database
  userId: string;
}

// Convert API transaction to UI transaction format
const convertApiTransaction = (apiTx: ApiTransaction): Transaction => ({
  id: apiTx.id,
  tokenName: apiTx.tokenName,
  tokenSymbol: apiTx.tokenSymbol || 'UNKNOWN', // Default to 'UNKNOWN' if not provided
  tokenAddress: apiTx.tokenAddress,
  type: apiTx.type,
  amount: typeof apiTx.amount === 'string' ? parseFloat(apiTx.amount) : apiTx.amount,
  price: typeof apiTx.price === 'string' ? parseFloat(apiTx.price) : apiTx.price,
  profit: typeof apiTx.profit === 'string' ? parseFloat(apiTx.profit) : apiTx.profit,
  status: apiTx.status,
  timestamp: new Date(apiTx.timestamp).getTime(),
  txId: apiTx.txId,
  tokenType: apiTx.tokenType,
  dex: apiTx.dex as 'jupiter' | 'raydium'
});

// Fetch transactions from database by wallet address
export const fetchTransactionsByWallet = async (walletAddress: string): Promise<Transaction[]> => {
  try {
    const response = await fetch(`/api/transactions/${walletAddress}`, {
      credentials: 'include', // send HttpOnly cookie (browser)
      headers: {
        // auth_token is the Electron fallback; browser uses cookie automatically
        ...(localStorage.getItem('auth_token') ? { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` } : {}),
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) {
      if (response.status === 404) {
        // No user found or no transactions
        return [];
      }
      throw new Error(`Failed to fetch transactions: ${response.statusText}`);
    }

    const data = await response.json();
    const transactions = data.transactions || [];

    return transactions.map(convertApiTransaction);
  } catch (error) {
    console.error('Error fetching transactions from database:', error);
    return [];
  }
};

// Fetch recent transactions (limit 5) by wallet address
export const fetchRecentTransactionsByWallet = async (walletAddress: string): Promise<Transaction[]> => {
  try {
    const transactions = await fetchTransactionsByWallet(walletAddress);
    return transactions.slice(0, 5); // Return only the 5 most recent
  } catch (error) {
    console.error('Error fetching recent transactions:', error);
    return [];
  }
};

// Fast dashboard transactions endpoint using wallet ID
export const fetchDashboardTransactions = async (walletId: string, limit: number = 10): Promise<Transaction[]> => {
  try {
    const response = await fetch(`/api/dashboard/transactions/${walletId}?limit=${limit}`, {
      credentials: 'include',
      headers: {
        ...(localStorage.getItem('auth_token') ? { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` } : {}),
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch dashboard transactions: ${response.status}`);
    }
    const data = await response.json();
    return data.transactions || [];
  } catch (error) {
    console.error('Error fetching dashboard transactions:', error);
    return [];
  }
};

// Clear all transactions for a specific wallet
export const clearTransactionsByWallet = async (walletAddress: string): Promise<{
  success: boolean;
  deletedCount: number;
  message: string;
}> => {
  try {
    // Note: walletAddress parameter is still required for frontend compatibility
    // but the backend now uses the authenticated user's ID for security
    const response = await fetch(`/api/transactions/clear/${walletAddress}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        ...(localStorage.getItem('auth_token') ? { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` } : {}),
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to clear transactions: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      success: true,
      deletedCount: data.deletedCount || 0,
      message: `Successfully cleared ${data.deletedCount || 0} transactions`
    };
  } catch (error) {
    console.error('Error clearing transactions from database:', error);
    return {
      success: false,
      deletedCount: 0,
      message: error instanceof Error ? error.message : 'Failed to clear transactions'
    };
  }
};
