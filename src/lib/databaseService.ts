// src/lib/databaseService.ts
import { Transaction } from '../store/slices/transactionsSlice';
import { SniperConfig } from '../store/slices/sniperConfigsSlice';

interface DatabaseUser {
  id: string;
  walletAddress: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DatabaseTransaction {
  id: string;
  txId: string;
  tokenName: string;
  tokenSymbol?: string; // Add optional tokenSymbol field
  tokenAddress: string;
  type: 'buy' | 'sell';
  amount: number;
  price: number;
  profit?: number;
  status: 'pending' | 'confirmed' | 'failed';
  tokenType: 'sol' | 'wsol';
  dex: string;
  timestamp: Date;
  userId: string;
}

interface DatabaseSniperConfig {
  id: string;
  name: string;
  walletId: string; // Add walletId field
  tokenAddress: string;
  buyAmount: string;
  sellTarget: string;
  stopLoss: string;
  maxSlippage: string;
  tokenType: 'sol' | 'wsol';
  dex: string;
  autoApprove: boolean;
  gasLimit: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  userId: string;

  // Advanced Fee Management - Optional for backwards compatibility
  priorityFee?: string;
  bribeFee?: string;
  autoFeeMode?: boolean;
  baseFeeMultiplier?: string;

  // MEV Protection - Optional for backwards compatibility
  mevProtection?: boolean;
  jitoTipAmount?: string;

  // Advanced Trading Options - Optional for backwards compatibility
  maxSlippageAdvanced?: string;
  slippageMode?: string;
  frontrunProtection?: boolean;
  sandwichProtection?: boolean;
}

/**
 * Database service for managing persistent storage
 * Replaces localStorage with backend API calls
 */
export class DatabaseService {
  private static baseUrl = '';
  private static currentUser: DatabaseUser | null = null;

  /**
   * Initialize database connection and user session
   */
  static async initialize(walletAddress: string): Promise<void> {
    try {
      // Get or create user
      const response = await fetch(`${this.baseUrl}/api/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ walletAddress }),
      });

      if (!response.ok) {
        throw new Error(`Failed to initialize user: ${response.statusText}`);
      }

      this.currentUser = await response.json();

      // Migrate existing localStorage data if present
      await this.migrateLocalStorageData();
    } catch (error) {
      console.error('Failed to initialize database service:', error);
      throw error;
    }
  }

  /**
   * Migrate existing localStorage data to database
   */
  private static async migrateLocalStorageData(): Promise<void> {
    if (!this.currentUser) return;

    try {
      // Migrate transactions
      const localTransactions = localStorage.getItem('transactions');
      if (localTransactions) {
        const transactions: Transaction[] = JSON.parse(localTransactions);

        for (const transaction of transactions) {
          await this.saveTransaction(transaction);
        }

        localStorage.removeItem('transactions');
        console.log('Migrated transactions to database');
      }

      // Migrate sniper configs
      const localConfigs = localStorage.getItem('sniperConfigs');
      if (localConfigs) {
        const configs: SniperConfig[] = JSON.parse(localConfigs);

        for (const config of configs) {
          await this.saveSniperConfig(config);
        }

        localStorage.removeItem('sniperConfigs');
        console.log('Migrated sniper configs to database');
      }
    } catch (error) {
      console.error('Failed to migrate localStorage data:', error);
    }
  }

  /**
   * Save transaction to database
   */
  static async saveTransaction(transaction: Transaction): Promise<DatabaseTransaction> {
    if (!this.currentUser) {
      throw new Error('User not initialized');
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...transaction,
          userId: this.currentUser.id,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to save transaction: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Failed to save transaction:', error);
      throw error;
    }
  }

  /**
   * Get all transactions for current user
   */
  static async getTransactions(): Promise<Transaction[]> {
    if (!this.currentUser) {
      throw new Error('User not initialized');
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/api/transactions?userId=${this.currentUser.id}`
      );

      if (!response.ok) {
        throw new Error(`Failed to get transactions: ${response.statusText}`);
      }

      const dbTransactions: DatabaseTransaction[] = await response.json();

      // Convert to frontend format
      return dbTransactions.map(this.convertTransactionFromDb);
    } catch (error) {
      console.error('Failed to get transactions:', error);
      // Fallback to localStorage if database fails
      const localTransactions = localStorage.getItem('transactions');
      return localTransactions ? JSON.parse(localTransactions) : [];
    }
  }

  /**
   * Update transaction status
   */
  static async updateTransaction(txId: string, updates: Partial<Transaction>): Promise<void> {
    if (!this.currentUser) {
      throw new Error('User not initialized');
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/transactions/${txId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        throw new Error(`Failed to update transaction: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to update transaction:', error);
      throw error;
    }
  }

  /**
   * Save sniper config to database
   */
  static async saveSniperConfig(config: SniperConfig): Promise<DatabaseSniperConfig> {
    if (!this.currentUser) {
      throw new Error('User not initialized');
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/sniper-configs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...config,
          userId: this.currentUser.id,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to save sniper config: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Failed to save sniper config:', error);
      throw error;
    }
  }

  /**
   * Get all sniper configs for current user
   */
  static async getSniperConfigs(): Promise<SniperConfig[]> {
    if (!this.currentUser) {
      throw new Error('User not initialized');
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/api/sniper-configs?userId=${this.currentUser.id}`
      );

      if (!response.ok) {
        throw new Error(`Failed to get sniper configs: ${response.statusText}`);
      }

      const dbConfigs: DatabaseSniperConfig[] = await response.json();

      // Convert to frontend format
      return dbConfigs.map(this.convertSniperConfigFromDb);
    } catch (error) {
      console.error('Failed to get sniper configs:', error);
      // Fallback to localStorage if database fails
      const localConfigs = localStorage.getItem('sniperConfigs');
      return localConfigs ? JSON.parse(localConfigs) : [];
    }
  }

  /**
   * Update sniper config
   */
  static async updateSniperConfig(id: string, updates: Partial<SniperConfig>): Promise<void> {
    if (!this.currentUser) {
      throw new Error('User not initialized');
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/sniper-configs/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        throw new Error(`Failed to update sniper config: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to update sniper config:', error);
      throw error;
    }
  }

  /**
   * Delete sniper config
   */
  static async deleteSniperConfig(id: string): Promise<void> {
    if (!this.currentUser) {
      throw new Error('User not initialized');
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/sniper-configs/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(`Failed to delete sniper config: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to delete sniper config:', error);
      throw error;
    }
  }

  /**
   * Sync data between frontend and backend
   */
  static async syncData(): Promise<void> {
    if (!this.currentUser) return;

    try {
      // Force refresh data from backend
      const [transactions, sniperConfigs] = await Promise.all([
        this.getTransactions(),
        this.getSniperConfigs(),
      ]);

      // Update Redux store
      window.dispatchEvent(new CustomEvent('database-sync', {
        detail: { transactions, sniperConfigs }
      }));

      console.log('Data synced successfully');
    } catch (error) {
      console.error('Failed to sync data:', error);
    }
  }

  /**
   * Get current user
   */
  static getCurrentUser(): DatabaseUser | null {
    return this.currentUser;
  }

  /**
   * Convert database transaction to frontend format
   */
  private static convertTransactionFromDb(dbTx: DatabaseTransaction): Transaction {
    return {
      id: dbTx.id,
      txId: dbTx.txId,
      tokenName: dbTx.tokenName,
      tokenSymbol: dbTx.tokenSymbol || 'UNKNOWN', // Provide default value
      tokenAddress: dbTx.tokenAddress,
      type: dbTx.type,
      amount: dbTx.amount,
      price: dbTx.price,
      profit: dbTx.profit,
      status: dbTx.status,
      tokenType: dbTx.tokenType,
      dex: dbTx.dex as 'jupiter' | 'raydium',
      timestamp: new Date(dbTx.timestamp).getTime(),
    };
  }

  /**
   * Convert database sniper config to frontend format
   */
  private static convertSniperConfigFromDb(dbConfig: DatabaseSniperConfig): SniperConfig {
    return {
      id: dbConfig.id,
      name: dbConfig.name,
      walletId: dbConfig.walletId || '', // Add walletId field
      tokenAddress: dbConfig.tokenAddress,
      buyAmount: dbConfig.buyAmount,
      sellTarget: dbConfig.sellTarget,
      stopLoss: dbConfig.stopLoss,
      maxSlippage: dbConfig.maxSlippage,
      tokenType: dbConfig.tokenType,
      dex: dbConfig.dex as 'jupiter' | 'raydium',
      autoApprove: dbConfig.autoApprove,
      gasLimit: dbConfig.gasLimit,

      // Advanced Fee Management - Add defaults if not present
      priorityFee: dbConfig.priorityFee || '0.001',
      bribeFee: dbConfig.bribeFee || '0.001',
      autoFeeMode: dbConfig.autoFeeMode ?? true,
      baseFeeMultiplier: dbConfig.baseFeeMultiplier || '1.5',

      // MEV Protection - Add defaults if not present
      mevProtection: dbConfig.mevProtection ?? true,
      jitoTipAmount: dbConfig.jitoTipAmount || '0.01',

      // Advanced Trading Options - Add defaults if not present
      maxSlippageAdvanced: dbConfig.maxSlippageAdvanced || '40',
      slippageMode: (dbConfig.slippageMode as 'conservative' | 'aggressive' | 'custom') || 'aggressive',
      frontrunProtection: dbConfig.frontrunProtection ?? true,
      sandwichProtection: dbConfig.sandwichProtection ?? true,

      notifications: {
        telegram: false,
        email: false,
      },
    };
  }
}
