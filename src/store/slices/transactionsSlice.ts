import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { DatabaseService } from '../../lib/databaseService';
import { clearTransactionsByWallet } from '../../lib/transactionApi';

// The Transaction interface is now defined here as the single source of truth.
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
  dex: 'auto' | 'jupiter' | 'raydium' | string;
  // SOL tracking fields for accurate PNL calculation
  totalSolCost?: number;      // Total SOL spent/received from blockchain balance difference
  gasFees?: number;           // Gas fees paid in SOL from transaction meta.fee
  jitoTip?: number;           // Jito tip paid in SOL (calculated)
  netSolAmount?: number;      // Net SOL amount for PNL calculation
  preBalance?: number;        // Wallet SOL balance before transaction
  postBalance?: number;       // Wallet SOL balance after transaction
}

const initialState: Transaction[] = [];

const transactionsSlice = createSlice({
  name: 'transactions',
  initialState,
  reducers: {
    addTransaction: (state, action: PayloadAction<Transaction>) => {
      const existingIndex = state.findIndex(tx => tx.id === action.payload.id);
      if (existingIndex >= 0) {
        // If transaction exists, update it. This is useful for status updates.
        state[existingIndex] = { ...state[existingIndex], ...action.payload };
      } else {
        // Add new transaction to the beginning of the array
        state.unshift(action.payload);
      }
    },
    clearTransactions: (state) => {
      state.length = 0;
    },
    deleteTransaction: (state, action: PayloadAction<string>) => {
      return state.filter(tx => tx.id !== action.payload);
    },
    setTransactions: (state, action: PayloadAction<Transaction[]>) => {
      return action.payload;
    }
  },
});

// Enhanced actions that sync with database
export const addTransactionWithDB = (transaction: Transaction) => async (dispatch: any) => {
  try {
    // Update Redux state immediately (backend handles database saving)
    dispatch(transactionsSlice.actions.addTransaction(transaction));
    
    // Note: Database saving is handled by the backend when transactions occur
    // No need to double-save here since the backend already saves to DB
    console.log('Transaction added to Redux store:', transaction.id);
  } catch (error) {
    console.error('Failed to add transaction to store:', error);
    // Still try to update Redux state as fallback
    dispatch(transactionsSlice.actions.addTransaction(transaction));
  }
};

export const updateTransactionWithDB = (txId: string, updates: Partial<Transaction>) => async (dispatch: any, getState: any) => {
  try {
    // Update in database
    await DatabaseService.updateTransaction(txId, updates);
    
    // Update Redux state
    const state = getState();
    const transactions = state.transactions || [];
    const updatedTransactions = transactions.map((tx: Transaction) =>
      tx.txId === txId ? { ...tx, ...updates } : tx
    );
    
    dispatch(transactionsSlice.actions.setTransactions(updatedTransactions));
  } catch (error) {
    console.error('Failed to update transaction in database:', error);
  }
};

export const loadTransactionsFromDB = () => async (dispatch: any) => {
  try {
    const transactions = await DatabaseService.getTransactions();
    dispatch(transactionsSlice.actions.setTransactions(transactions));
  } catch (error) {
    console.error('Failed to load transactions from database:', error);
    // Try to load from localStorage as fallback
    const localTransactions = localStorage.getItem('transactions');
    if (localTransactions) {
      dispatch(transactionsSlice.actions.setTransactions(JSON.parse(localTransactions)));
    }
  }
};

export const { addTransaction, clearTransactions, deleteTransaction, setTransactions } = transactionsSlice.actions;
export default transactionsSlice.reducer;