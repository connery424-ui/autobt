// src/lib/analytics.ts
import { Transaction } from '../store/slices/transactionsSlice';

export interface PerformanceMetrics {
  totalPnl: number;
  winRate: number;
  totalVolume: number;
  totalTrades: number;
  averagePnl: number;
  wins: number;
  losses: number;
}

export interface RealTimeMetrics {
  currentPnL: number;
  todayPnL: number;
  weekPnL: number;
  monthPnL: number;
  activeTrades: number;
  pendingTrades: number;
  successRate24h: number;
  avgExecutionTime: number;
}

export interface DetailedAnalytics {
  performance: PerformanceMetrics;
  realTime: RealTimeMetrics;
  trends: PnLTrend[];
  topPerformers: TokenPerformance[];
  executionMetrics: ExecutionMetrics;
}

export interface PnLTrend {
  date: string;
  cumulativePnL: number;
  dailyPnL: number;
  trades: number;
}

export interface TokenPerformance {
  tokenAddress: string;
  tokenName: string;
  totalPnL: number;
  trades: number;
  winRate: number;
  avgProfit: number;
  volume: number;
}

export interface ExecutionMetrics {
  avgExecutionTime: number;
  successRate: number;
  failureRate: number;
  avgSlippage: number;
  gasEfficiency: number;
}

/**
 * Calculates performance metrics from a list of transactions.
 * @param transactions - An array of user's transactions.
 * @returns An object containing performance metrics.
 */
/**
 * Calculate PNL from actual SOL spent vs received (not token prices)
 * This groups buy/sell pairs by tokenAddress and calculates real SOL profit/loss
 */
const calculateSOLBasedPNL = (transactions: Transaction[]): { 
  totalPnL: number; 
  completedTrades: number; 
  wins: number; 
  losses: number; 
} => {
  // Group transactions by token address
  const tokenGroups = new Map<string, { buys: Transaction[], sells: Transaction[] }>();
  
  transactions
    .filter(tx => tx.status === 'confirmed')
    .forEach(tx => {
      if (!tokenGroups.has(tx.tokenAddress)) {
        tokenGroups.set(tx.tokenAddress, { buys: [], sells: [] });
      }
      
      const group = tokenGroups.get(tx.tokenAddress)!;
      if (tx.type === 'buy') {
        group.buys.push(tx);
      } else {
        group.sells.push(tx);
      }
    });

  let totalPnL = 0;
  let completedTrades = 0;
  let wins = 0;
  let losses = 0;

  // Calculate PNL for each token
  tokenGroups.forEach((group, tokenAddress) => {
    // Calculate total SOL spent on buys (use netSolAmount - positive values)
    const totalSolSpent = group.buys.reduce((sum, tx) => {
      // Use netSolAmount (positive for buys = SOL spent)
      console.log(`Buy transaction ${tx.id}: netSolAmount = ${tx.netSolAmount}, totalSolCost = ${tx.totalSolCost}`);
      return sum + (tx.netSolAmount || tx.totalSolCost || 0);
    }, 0);

    // Calculate total SOL received from sells (use netSolAmount - negative values, so use Math.abs)
    const totalSolReceived = group.sells.reduce((sum, tx) => {
      // Use netSolAmount (negative for sells, so take absolute value = SOL received)
      console.log(`Sell transaction ${tx.id}: netSolAmount = ${tx.netSolAmount}, totalSolCost = ${tx.totalSolCost}`);
      return sum + Math.abs(tx.netSolAmount || tx.totalSolCost || 0);
    }, 0);

    console.log(`Token ${tokenAddress}: SOL spent = ${totalSolSpent}, SOL received = ${totalSolReceived}, PnL = ${totalSolReceived - totalSolSpent}`);

    // Only count as completed trade if we have both buys and sells
    if (group.buys.length > 0 && group.sells.length > 0) {
      const tokenPnL = totalSolReceived - totalSolSpent;
      totalPnL += tokenPnL;
      completedTrades++;
      
      if (tokenPnL > 0) {
        wins++;
      } else if (tokenPnL < 0) {
        losses++;
      }
    }
  });

  return { totalPnL, completedTrades, wins, losses };
};

export const calculatePerformanceMetrics = (transactions: Transaction[]): PerformanceMetrics => {
  if (!transactions || transactions.length === 0) {
    return {
      totalPnl: 0,
      winRate: 0,
      totalVolume: 0,
      totalTrades: 0,
      averagePnl: 0,
      wins: 0,
      losses: 0,
    };
  }

  // Use SOL-based PNL calculation
  const solPnL = calculateSOLBasedPNL(transactions);
  
  const winRate = solPnL.completedTrades > 0 ? (solPnL.wins / solPnL.completedTrades) * 100 : 0;
  const averagePnl = solPnL.completedTrades > 0 ? solPnL.totalPnL / solPnL.completedTrades : 0;

  // Calculate total volume from all confirmed transactions (use netSolAmount or totalSolCost)
  const totalVolume = transactions
    .filter(tx => tx.status === 'confirmed')
    .reduce((acc, tx) => acc + Math.abs(tx.netSolAmount || tx.totalSolCost || 0), 0);

  return {
    totalPnl: solPnL.totalPnL,
    winRate,
    totalVolume,
    totalTrades: solPnL.completedTrades,
    averagePnl,
    wins: solPnL.wins,
    losses: solPnL.losses,
  };
};

/**
 * Real-time profit tracking service
 */
export class RealTimeProfitTracker {
  private static instance: RealTimeProfitTracker;
  private listeners: Set<(metrics: RealTimeMetrics) => void> = new Set();
  private updateInterval: NodeJS.Timeout | null = null;
  private lastMetrics: RealTimeMetrics | null = null;

  static getInstance(): RealTimeProfitTracker {
    if (!this.instance) {
      this.instance = new RealTimeProfitTracker();
    }
    return this.instance;
  }

  /**
   * Start real-time profit tracking
   */
  startTracking(updateIntervalMs: number = 5000) {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    this.updateInterval = setInterval(() => {
      this.updateMetrics();
    }, updateIntervalMs);

    console.log('📊 Real-time profit tracking started');
  }

  /**
   * Stop real-time profit tracking
   */
  stopTracking() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    console.log('📊 Real-time profit tracking stopped');
  }

  /**
   * Get current metrics
   */
  getCurrentMetrics(): RealTimeMetrics | null {
    return this.lastMetrics;
  }

  /**
   * Subscribe to real-time metrics updates
   */
  subscribe(callback: (metrics: RealTimeMetrics) => void) {
    this.listeners.add(callback);
    
    // Send current metrics immediately
    if (this.lastMetrics) {
      callback(this.lastMetrics);
    }

    return () => this.listeners.delete(callback);
  }

  /**
   * Update and broadcast metrics
   */
  private async updateMetrics() {
    try {
      const transactions = await this.getTransactions();
      const metrics = this.calculateRealTimeMetrics(transactions);
      
      this.lastMetrics = metrics;
      
      // Notify all listeners
      this.listeners.forEach(callback => {
        try {
          callback(metrics);
        } catch (error) {
          console.error('Error notifying analytics listener:', error);
        }
      });

    } catch (error) {
      console.error('Error updating real-time metrics:', error);
    }
  }

  /**
   * Calculate real-time metrics from transactions
   */
  private calculateRealTimeMetrics(transactions: Transaction[]): RealTimeMetrics {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const week = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const month = new Date(now.getFullYear(), now.getMonth(), 1);

    const todayTxs = transactions.filter(tx => new Date(tx.timestamp) >= today);
    const weekTxs = transactions.filter(tx => new Date(tx.timestamp) >= week);
    const monthTxs = transactions.filter(tx => new Date(tx.timestamp) >= month);

    const activeTrades = transactions.filter(tx => 
      tx.type === 'buy' && tx.status === 'confirmed' && 
      !transactions.some(sellTx => sellTx.type === 'sell' && sellTx.tokenAddress === tx.tokenAddress)
    ).length;

    const pendingTrades = transactions.filter(tx => tx.status === 'pending').length;

    const todayCompletedTrades = todayTxs.filter(tx => tx.type === 'sell' && tx.status === 'confirmed');
    const successRate24h = todayCompletedTrades.length > 0 
      ? (todayCompletedTrades.filter(tx => (tx.profit || 0) > 0).length / todayCompletedTrades.length) * 100 
      : 0;

    return {
      currentPnL: this.calculateTotalPnL(transactions),
      todayPnL: this.calculateTotalPnL(todayTxs),
      weekPnL: this.calculateTotalPnL(weekTxs),
      monthPnL: this.calculateTotalPnL(monthTxs),
      activeTrades,
      pendingTrades,
      successRate24h,
      avgExecutionTime: this.calculateAvgExecutionTime(transactions)
    };
  }

  /**
   * Calculate total P&L from transactions using SOL-based approach
   */
  private calculateTotalPnL(transactions: Transaction[]): number {
    // Use the same SOL-based calculation as the main analytics
    const solPnL = this.calculateSOLBasedPNLForRealTime(transactions);
    return solPnL.totalPnL;
  }

  /**
   * Helper method for real-time SOL-based PNL calculation
   */
  private calculateSOLBasedPNLForRealTime(transactions: Transaction[]): { totalPnL: number } {
    // Group transactions by token address
    const tokenGroups = new Map<string, { buys: Transaction[], sells: Transaction[] }>();
    
    transactions
      .filter(tx => tx.status === 'confirmed')
      .forEach(tx => {
        if (!tokenGroups.has(tx.tokenAddress)) {
          tokenGroups.set(tx.tokenAddress, { buys: [], sells: [] });
        }
        
        const group = tokenGroups.get(tx.tokenAddress)!;
        if (tx.type === 'buy') {
          group.buys.push(tx);
        } else {
          group.sells.push(tx);
        }
      });

    let totalPnL = 0;

    // Calculate PNL for each token
    tokenGroups.forEach((group) => {
      // Calculate total SOL spent on buys (use netSolAmount - positive values)
      const totalSolSpent = group.buys.reduce((sum, tx) => {
        return sum + (tx.netSolAmount || tx.totalSolCost || 0);
      }, 0);

      // Calculate total SOL received from sells (use netSolAmount - negative values, so use Math.abs)
      const totalSolReceived = group.sells.reduce((sum, tx) => {
        return sum + Math.abs(tx.netSolAmount || tx.totalSolCost || 0);
      }, 0);

      // Only count if we have both buys and sells
      if (group.buys.length > 0 && group.sells.length > 0) {
        totalPnL += totalSolReceived - totalSolSpent;
      }
    });

    return { totalPnL };
  }

  /**
   * Calculate average execution time
   */
  private calculateAvgExecutionTime(transactions: Transaction[]): number {
    const recentTxs = transactions
      .filter(tx => tx.status === 'confirmed')
      .slice(-50); // Last 50 transactions

    if (recentTxs.length === 0) return 0;

    // This would need actual execution time data
    // For now, return a placeholder
    return 2.5; // seconds
  }

  /**
   * Get transactions from store or API
   */
  private async getTransactions(): Promise<Transaction[]> {
    // This would integrate with your Redux store or API
    // For now, return empty array
    return [];
  }
}

/**
 * Generate detailed analytics report
 */
export const generateDetailedAnalytics = (transactions: Transaction[]): DetailedAnalytics => {
  const performance = calculatePerformanceMetrics(transactions);
  const realTime = RealTimeProfitTracker.getInstance().getCurrentMetrics() || {
    currentPnL: 0,
    todayPnL: 0,
    weekPnL: 0,
    monthPnL: 0,
    activeTrades: 0,
    pendingTrades: 0,
    successRate24h: 0,
    avgExecutionTime: 0
  };

  const trends = generatePnLTrends(transactions);
  const topPerformers = generateTokenPerformance(transactions);
  const executionMetrics = calculateExecutionMetrics(transactions);

  return {
    performance,
    realTime,
    trends,
    topPerformers,
    executionMetrics
  };
};

/**
 * Generate P&L trends over time
 */
export const generatePnLTrends = (transactions: Transaction[]): PnLTrend[] => {
  // Group transactions by date
  const dateGroups: Map<string, Transaction[]> = new Map();

  transactions
    .filter(tx => tx.status === 'confirmed')
    .forEach(tx => {
      const date = new Date(tx.timestamp).toISOString().split('T')[0];
      if (!dateGroups.has(date)) {
        dateGroups.set(date, []);
      }
      dateGroups.get(date)!.push(tx);
    });

  let cumulativePnL = 0;
  const trends: PnLTrend[] = [];

  Array.from(dateGroups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([date, dayTxs]) => {
      // Calculate daily PNL using SOL-based approach for this day
      const dailyTokenGroups = new Map<string, { buys: Transaction[], sells: Transaction[] }>();
      
      dayTxs.forEach(tx => {
        if (!dailyTokenGroups.has(tx.tokenAddress)) {
          dailyTokenGroups.set(tx.tokenAddress, { buys: [], sells: [] });
        }
        
        const group = dailyTokenGroups.get(tx.tokenAddress)!;
        if (tx.type === 'buy') {
          group.buys.push(tx);
        } else {
          group.sells.push(tx);
        }
      });

      let dailyPnL = 0;
      dailyTokenGroups.forEach((group) => {
        const totalSolSpent = group.buys.reduce((sum, tx) => 
          sum + (tx.netSolAmount || tx.totalSolCost || 0), 0);
        const totalSolReceived = group.sells.reduce((sum, tx) => 
          // For sells, use absolute value of netSolAmount or totalSolCost
          sum + Math.abs(tx.netSolAmount || tx.totalSolCost || 0), 0);
        
        // Only count trades completed on this day (has both buy and sell)
        if (group.buys.length > 0 && group.sells.length > 0) {
          dailyPnL += totalSolReceived - totalSolSpent;
        }
      });

      cumulativePnL += dailyPnL;

      trends.push({
        date,
        cumulativePnL,
        dailyPnL,
        trades: dayTxs.length
      });
    });

  return trends;
};

/**
 * Calculate token-specific performance
 */
export const generateTokenPerformance = (transactions: Transaction[]): TokenPerformance[] => {
  const tokenGroups: Map<string, Transaction[]> = new Map();

  transactions.forEach(tx => {
    if (!tokenGroups.has(tx.tokenAddress)) {
      tokenGroups.set(tx.tokenAddress, []);
    }
    tokenGroups.get(tx.tokenAddress)!.push(tx);
  });

  return Array.from(tokenGroups.entries()).map(([address, txs]) => {
    const confirmedTxs = txs.filter(tx => tx.status === 'confirmed');
    const buyTxs = confirmedTxs.filter(tx => tx.type === 'buy');
    const sellTxs = confirmedTxs.filter(tx => tx.type === 'sell');
    
    // Calculate SOL-based PNL for this token (use netSolAmount or totalSolCost)
    const totalSolSpent = buyTxs.reduce((sum, tx) => sum + (tx.netSolAmount || tx.totalSolCost || 0), 0);
    const totalSolReceived = sellTxs.reduce((sum, tx) => 
      // For sells, use absolute value of netSolAmount or totalSolCost
      sum + Math.abs(tx.netSolAmount || tx.totalSolCost || 0), 0);
    const totalPnL = totalSolReceived - totalSolSpent;
    
    const completedTrades = Math.min(buyTxs.length, sellTxs.length); // Count of complete buy/sell pairs
    const wins = totalPnL > 0 ? 1 : 0; // For token level, it's either profitable or not
    const winRate = completedTrades > 0 ? (wins / completedTrades) * 100 : 0;
    const volume = confirmedTxs.reduce((sum, tx) => sum + Math.abs(tx.netSolAmount || tx.totalSolCost || 0), 0);

    return {
      tokenAddress: address,
      tokenName: txs[0]?.tokenName || 'Unknown',
      totalPnL,
      trades: completedTrades,
      winRate,
      avgProfit: completedTrades > 0 ? totalPnL / completedTrades : 0,
      volume
    };
  }).sort((a, b) => b.totalPnL - a.totalPnL);
};

/**
 * Calculate execution performance metrics
 */
export const calculateExecutionMetrics = (transactions: Transaction[]): ExecutionMetrics => {
  const confirmedTxs = transactions.filter(tx => tx.status === 'confirmed');
  const failedTxs = transactions.filter(tx => tx.status === 'failed');
  
  const total = confirmedTxs.length + failedTxs.length;
  const successRate = total > 0 ? (confirmedTxs.length / total) * 100 : 0;
  const failureRate = 100 - successRate;

  return {
    avgExecutionTime: 2.5, // This would need real timing data
    successRate,
    failureRate,
    avgSlippage: 0.5, // This would need real slippage data
    gasEfficiency: 95 // This would need real gas usage data
  };
};