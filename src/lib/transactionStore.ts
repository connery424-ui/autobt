// src/lib/transactionStore.ts
import { transactions as PrismaTransaction } from '@prisma/client';

export interface Transaction {
  id: string;
  tokenName: string;
  tokenSymbol: string; // Make tokenSymbol required for consistency
  tokenAddress: string;
  type: 'buy' | 'sell';
  amount: number;
  price: number;
  profit?: number;
  status: 'pending' | 'confirmed' | 'failed';
  timestamp: number;
  txId: string;
  tokenType: 'sol' | 'wsol';
  dex: 'jupiter' | 'raydium';
  // SOL tracking fields for accurate PNL calculation
  totalSolCost?: number;      // Total SOL spent/received from blockchain balance difference
  gasFees?: number;           // Gas fees paid in SOL from transaction meta.fee
  jitoTip?: number;           // Jito tip paid in SOL (calculated)
  netSolAmount?: number;      // Net SOL amount for PNL calculation
  preBalance?: number;        // Wallet SOL balance before transaction
  postBalance?: number;       // Wallet SOL balance after transaction
}

// Local storage key for backward compatibility
const STORAGE_KEY = 'sol_sniper_transactions';

// Initialize global transaction storage
export const initGlobalTransactionStorage = () => {
  if (!localStorage.getItem(STORAGE_KEY)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
  }
};

// Get transactions from localStorage (fallback until DB is fully integrated)
export const getTransactions = (): Transaction[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error('Error loading transactions from localStorage:', error);
    return [];
  }
};

// Add transaction to localStorage and sync with database
export const addTransaction = async (transaction: Transaction): Promise<void> => {
  try {
    // Add to localStorage for immediate UI update
    const transactions = getTransactions();
    const existingIndex = transactions.findIndex(t => t.id === transaction.id);
    
    if (existingIndex >= 0) {
      transactions[existingIndex] = transaction;
    } else {
      transactions.unshift(transaction);
    }
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));

    // Sync with database (if available)
    await syncTransactionToDatabase(transaction);
  } catch (error) {
    console.error('Error adding transaction:', error);
  }
};

// Delete transaction
export const deleteTransaction = async (id: string): Promise<void> => {
  try {
    // Remove from localStorage
    const transactions = getTransactions();
    const filtered = transactions.filter(t => t.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));

    // Delete from database
    await deleteTransactionFromDatabase(id);
  } catch (error) {
    console.error('Error deleting transaction:', error);
  }
};

// Clear all transactions
export const clearTransactions = async (): Promise<void> => {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
    
    // Clear from database
    await clearTransactionsFromDatabase();
  } catch (error) {
    console.error('Error clearing transactions:', error);
  }
};

// Sync with database functions
const syncTransactionToDatabase = async (transaction: Transaction): Promise<void> => {
  try {
    const walletAddress = getCurrentWalletAddress();
    if (!walletAddress) return;

    const response = await fetch('/api/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...transaction,
        walletAddress,
      }),
    });

    if (!response.ok) {
      console.warn('Failed to sync transaction to database:', response.statusText);
    }
  } catch (error) {
    console.warn('Database sync failed, using localStorage only:', error);
  }
};

const deleteTransactionFromDatabase = async (id: string): Promise<void> => {
  try {
    const response = await fetch(`/api/transactions/${id}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      console.warn('Failed to delete transaction from database:', response.statusText);
    }
  } catch (error) {
    console.warn('Database delete failed:', error);
  }
};

const clearTransactionsFromDatabase = async (): Promise<void> => {
  try {
    const walletAddress = getCurrentWalletAddress();
    if (!walletAddress) return;

    const response = await fetch(`/api/transactions/clear/${walletAddress}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      console.warn('Failed to clear transactions from database:', response.statusText);
    }
  } catch (error) {
    console.warn('Database clear failed:', error);
  }
};

// Load transactions from database
export const loadTransactionsFromDatabase = async (walletAddress: string): Promise<Transaction[]> => {
  try {
    const response = await fetch(`/api/transactions/${walletAddress}`);
    if (!response.ok) {
      throw new Error('Failed to fetch transactions');
    }

    const data = await response.json();
    const dbTransactions = data.transactions || [];

    // Convert database format to local format if needed
    const converted = dbTransactions.map((tx: any) => ({
      id: tx.id,
      tokenName: tx.tokenName,
      tokenAddress: tx.tokenAddress,
      type: tx.type,
      amount: Number(tx.amount),
      price: Number(tx.price),
      profit: tx.profit ? Number(tx.profit) : undefined,
      status: tx.status,
      timestamp: new Date(tx.timestamp).getTime(),
      txId: tx.txId,
      tokenType: tx.tokenType,
      dex: tx.dex,
    }));

    // Merge with localStorage and update
    const localTransactions = getTransactions();
    const merged = mergeTransactions(localTransactions, converted);
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    return merged;
  } catch (error) {
    console.warn('Failed to load from database, using localStorage:', error);
    return getTransactions();
  }
};

// Merge transactions from different sources
const mergeTransactions = (local: Transaction[], database: Transaction[]): Transaction[] => {
  const merged = new Map<string, Transaction>();
  
  // Add local transactions
  local.forEach(tx => merged.set(tx.id, tx));
  
  // Add/update with database transactions (database is source of truth)
  database.forEach(tx => merged.set(tx.id, tx));
  
  return Array.from(merged.values()).sort((a, b) => b.timestamp - a.timestamp);
};

// Helper to get current wallet address
const getCurrentWalletAddress = (): string | null => {
  // Try to get the active wallet from the API
  try {
    // For now, we'll use a synchronous approach and return the first active wallet found
    // This could be improved by storing the active wallet in localStorage or state management
    return localStorage.getItem('activeWalletAddress') || null;
  } catch (error) {
    console.warn('Could not get current wallet address:', error);
    return null;
  }
};

// Initialize WebSocket connection for real-time updates
// NOTE: This function is currently disabled as the /ws endpoint is not implemented
// The real-time updates are handled by the wallet manager WebSocket on port 8081
export const initializeRealtimeUpdates = (walletAddress: string): void => {
  console.log('Real-time transaction updates are handled by wallet manager WebSocket');
  // Disabled to prevent connection errors to non-existent /ws endpoint
  /*
  try {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    
    ws.onopen = () => {
      console.log('Connected to real-time transaction updates');
      ws.send(JSON.stringify({
        type: 'subscribe_transactions',
        walletAddress
      }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'transaction_update') {
          addTransaction(data.transaction);
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      console.log('Disconnected from real-time updates');
      // Attempt to reconnect after 5 seconds
      setTimeout(() => initializeRealtimeUpdates(walletAddress), 5000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  } catch (error) {
    console.error('Failed to initialize real-time updates:', error);
  }
  */
};
