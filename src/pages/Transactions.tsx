import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { Loader2, CheckCircle2, XCircle, ExternalLink, TrendingUp, TrendingDown, AlertCircle, Wallet, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { useWallet } from '@solana/wallet-adapter-react';
import toast from '../lib/toast-shim';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Transaction, initGlobalTransactionStorage, getTransactions, deleteTransaction, clearTransactions } from '../lib/transactionStore';
import { fetchDashboardTransactions } from '../lib/transactionApi';
import { useManagedWallets } from '../hooks/useManagedWallets';
import { useAuthenticatedTransactions, useIsAuthenticated } from '../hooks/useSimpleAuth';
import { useLogStore } from '../lib/logStore';
import { Button } from '../components/ui/button';
import { getTokenDisplayName, getTokenFullDisplayName } from '../lib/tokenDisplayUtils';
import { calculatePerformanceMetrics } from '../lib/analytics';
import { useAuth } from '../contexts/AuthContext';

// Khởi tạo ngay khi module được load
initGlobalTransactionStorage();

// Helper function to calculate SOL-based profit for individual transactions
const calculateTransactionProfit = (transaction: Transaction, allTransactions: Transaction[]): number => {
  // For buy transactions, we can't show profit until there's a corresponding sell
  if (transaction.type === 'buy') {
    return 0; // Could show negative spent amount if preferred
  }

  // For sell transactions, find corresponding buy transactions for the same token
  const buyTransactions = allTransactions.filter(tx =>
    tx.tokenAddress === transaction.tokenAddress &&
    tx.type === 'buy' &&
    tx.status === 'confirmed' &&
    tx.timestamp < transaction.timestamp // Only count buys before this sell
  );

  if (buyTransactions.length === 0) {
    return 0; // No corresponding buy found
  }

  // Calculate total SOL spent on buys for this token (use netSolAmount or totalSolCost)
  const totalSolSpent = buyTransactions.reduce((sum, tx) =>
    sum + (tx.netSolAmount || tx.totalSolCost || 0), 0);

  // SOL received from this sell (use netSolAmount - negative value, so use absolute value)
  const solReceived = Math.abs(transaction.netSolAmount || transaction.totalSolCost || 0);

  // Simple approach: attribute profit to the latest sell
  // More sophisticated approach would be FIFO/LIFO accounting
  return solReceived - (totalSolSpent / buyTransactions.length);
};

interface TransactionRowProps {
  transaction: Transaction;
  allTransactions: Transaction[];
  solUsd: number;
  onDelete: (id: string) => void;
}

const TransactionRow: React.FC<TransactionRowProps> = ({ transaction, allTransactions, solUsd, onDelete }) => {
  const isSell = transaction.type === 'sell';
  // Total trade value: what it was bought for (buy) / sold for (sell), in SOL.
  // Prefer the on-chain net SOL amount if present, else amount × per-token price.
  const tradeSol = Math.abs(
    transaction.netSolAmount ?? transaction.totalSolCost ?? ((transaction.amount ?? 0) * (transaction.price ?? 0))
  );
  const tradeUsd = tradeSol * solUsd;
  // Realized PnL from the database (sells only). Fall back to computed value if DB profit is absent.
  const sellPnl = isSell
    ? (transaction.profit ?? calculateTransactionProfit(transaction, allTransactions))
    : null;

  const statusIcon: Record<string, React.ReactNode> = {
    pending: <Loader2 className="w-5 h-5 text-yellow-500 animate-spin" />,
    confirmed: <CheckCircle2 className="w-5 h-5 text-green-500" />,
    failed: <XCircle className="w-5 h-5 text-red-500" />,
    denied: <XCircle className="w-5 h-5 text-orange-500" />,
  };

  const formatProfit = (profit: number | undefined | null) => {
    if (profit === undefined || profit === null) return '-';
    return `${profit >= 0 ? '+' : ''}${profit.toFixed(2)}`;
  };

  const getProfitColor = (profit: number | undefined | null) => {
    if (profit === undefined || profit === null) return 'text-muted-foreground';
    return profit >= 0 ? 'text-green-500' : 'text-red-500';
  };

  // Chỉ hiển thị liên kết solscan cho giao dịch đã confirmed
  const showSolscanLink = transaction.status === 'confirmed' && !transaction.txId.startsWith('simulated');

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(transaction.id);
  };

  return (
    <div className="glass p-4 rounded-xl hover-card transition-all duration-300 group flex flex-col aspect-square overflow-hidden">
      {/* Header: icon + token name/address + buy/sell badge */}
      <div className="flex items-start gap-2">
        <div className="p-2 rounded-lg bg-primary/10 shrink-0">
          {transaction.type === 'buy' ? (
            <TrendingUp className="w-5 h-5 text-primary" />
          ) : (
            <TrendingDown className="w-5 h-5 text-primary" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="font-semibold text-sm leading-tight break-words line-clamp-2"
            title={getTokenDisplayName(transaction)}
          >
            {getTokenDisplayName(transaction)}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate" title={transaction.tokenAddress}>
            {transaction.tokenAddress}
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded",
            isSell ? "bg-red-500/15 text-red-400" : "bg-green-500/15 text-green-400"
          )}
        >
          {isSell ? 'Sell' : 'Buy'}
        </span>
      </div>

      {/* Body: stacked metrics */}
      <div className="flex flex-col justify-center flex-1 space-y-2 mt-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground shrink-0">Amount</span>
          <span className="font-semibold text-sm truncate text-right">
            {(transaction.amount ?? 0).toLocaleString()}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground shrink-0">{isSell ? 'Sold for' : 'Bought for'}</span>
          <div className="text-right min-w-0">
            <div className="font-semibold text-sm truncate" title={`$${tradeUsd.toFixed(6)}`}>
              ${tradeUsd.toFixed(3)}
            </div>
            <div className="text-xs text-muted-foreground truncate" title={`${tradeSol} SOL`}>
              {tradeSol.toFixed(4)} SOL
            </div>
          </div>
        </div>
        {isSell && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground shrink-0">PnL</span>
            <span className={cn("font-semibold text-sm truncate text-right", getProfitColor(sellPnl))}>
              {formatProfit(sellPnl)} {transaction.tokenType?.toUpperCase() || 'SOL'}
            </span>
          </div>
        )}
      </div>

      {/* Footer: status + actions */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
        <div className="flex items-center space-x-1.5 min-w-0">
          {statusIcon[transaction.status]}
          <span className="text-xs capitalize truncate">{transaction.status}</span>
        </div>
        <div className="flex items-center space-x-1 shrink-0">
          {showSolscanLink ? (
            <a
              href={`https://solscan.io/tx/${transaction.txId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 rounded-lg hover:bg-accent/10 transition-colors duration-200"
              title="View on Solscan"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          ) : (
            <span className="p-2 opacity-50 cursor-not-allowed">
              <ExternalLink className="w-4 h-4" />
            </span>
          )}
          <button
            onClick={handleDeleteClick}
            className="p-2 rounded-lg hover:bg-red-500/10 transition-colors duration-200 text-red-500"
            title="Delete transaction"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

const Transactions: React.FC = () => {
  // 🚨 CRITICAL: ALL HOOKS MUST BE CALLED BEFORE ANY CONDITIONAL RETURNS
  const { connected, disconnect } = useWallet();
  const { activeWallet } = useManagedWallets();
  const isAuthenticated = useIsAuthenticated();
  const authenticatedTransactions = useAuthenticatedTransactions();
  const { sessionToken } = useAuth();
  const logs = useLogStore((state) => state.logs);
  const clearLogs = useLogStore((state) => state.clearLogs);


  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [solUsd, setSolUsd] = useState<number>(150); // fallback until live rate loads

  // Fetch live SOL/USD rate (CoinGecko) for converting trade values to USD
  useEffect(() => {
    let cancelled = false;
    const loadSolPrice = async () => {
      try {
        // Use our backend proxy — the browser is blocked from calling CoinGecko
        // directly by the app's Content Security Policy.
        const res = await fetch('/api/sol-price');
        const data = await res.json();
        const price = data?.usd;
        if (!cancelled && typeof price === 'number' && price > 0) setSolUsd(price);
      } catch (e) {
        console.warn('Failed to fetch SOL/USD rate, using fallback:', e);
      }
    };
    loadSolPrice();
    const interval = setInterval(loadSolPrice, 60_000); // refresh each minute
    return () => { cancelled = true; clearInterval(interval); };
  }, []);
  const [showWithoutWallet, setShowWithoutWallet] = useState(() => {
    // Initialize with true if coming from Sniper page or if there are transactions in localStorage
    if (typeof window !== 'undefined') {
      // Check URL parameters
      const urlParams = new URLSearchParams(window.location.search);
      const isNewTransaction = urlParams.get('new') === 'true';

      if (isNewTransaction) {
        return true;
      }

      // Check localStorage for existing transactions
      try {
        const storedData = localStorage.getItem('transactions');
        if (storedData) {
          const parsedData = JSON.parse(storedData);
          if (Array.isArray(parsedData) && parsedData.length > 0) {
            return true;
          }
        }
      } catch (e) {
        console.error("Error checking localStorage during initialization:", e);
      }
    }
    return false;
  });

  // Function to load transactions from both localStorage and database
  const loadAllTransactions = async () => {
    try {
      setLoading(true);

      // Get localStorage transactions (for backwards compatibility)
      const localTransactions = getTransactions();

      // Get database transactions if we have an active wallet (using fast endpoint)
      let dbTransactions: Transaction[] = [];
      if (activeWallet) {
        try {
          // Use the fast dashboard endpoint with higher limit for transactions page
          dbTransactions = await fetchDashboardTransactions(activeWallet.id, 100);
        } catch (error) {
          console.error("Failed to fetch transactions from database:", error);
          // (slop audit P0) The old "fallback" called GET /api/transactions/:wallet,
          // an endpoint that has never existed — it 404'd on every use. Removed.
        }
      }

      // Combine and deduplicate transactions (prioritize database over localStorage)
      const allTransactions = [...dbTransactions, ...localTransactions];
      const uniqueTransactions = Array.from(
        new Map(allTransactions.map(tx => [tx.id, tx])).values()
      ).sort((a, b) => b.timestamp - a.timestamp);

      setTransactions(uniqueTransactions);

      // Show transactions if we have any from either source
      if (uniqueTransactions.length > 0) {
        setShowWithoutWallet(true);
      }

    } catch (error) {
      console.error("Error loading transactions:", error);
      // Fallback to localStorage only
      const localTransactions = getTransactions();
      setTransactions(localTransactions);
      if (localTransactions.length > 0) {
        setShowWithoutWallet(true);
      }
    } finally {
      setLoading(false);
    }
  };

  // Handle transaction deletion — removes from localStorage AND DB
  const handleDeleteTransaction = async (id: string) => {
    try {
      // 1. Remove from DB if authenticated
      if (sessionToken) {
        try {
          await fetch(`/api/transactions/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${sessionToken}` }
          });
        } catch (dbErr) {
          console.warn('DB delete failed, continuing with localStorage:', dbErr);
        }
      }
      // 2. Remove from localStorage
      await deleteTransaction(id);
      setTransactions(prev => prev.filter(tx => tx.id !== id));
      toast.success('Transaction deleted');
    } catch (error) {
      console.error('Error deleting transaction:', error);
      toast.error('Could not delete transaction');
    }
  };

  // Handle clear all — removes from localStorage AND DB
  const handleClearAll = async () => {
    if (transactions.length === 0) return;
    // 1. Clear from DB if authenticated
    if (sessionToken) {
      try {
        await fetch('/api/wallets/all/transactions', {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
      } catch (dbErr) {
        console.warn('DB clear failed, continuing with localStorage:', dbErr);
      }
    }
    // 2. Clear from localStorage
    clearTransactions();
    setTransactions([]);
    toast.success('All transactions cleared');
  };

  // Force reload transactions when component is mounted or re-mounted
  useEffect(() => {
    // Check URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const isNewTransaction = urlParams.get('new') === 'true';

    if (isNewTransaction && !showWithoutWallet) {
      setShowWithoutWallet(true);
    }
  }, []);

  // Reload when active wallet changes - this is the main trigger for loading transactions
  useEffect(() => {
    loadAllTransactions();
  }, [activeWallet]);

  // Monitor wallet connection state
  useEffect(() => {
    // Handle wallet disconnection - clear transactions
    const handleWalletDisconnect = (isConnected: boolean) => {
      // Skip clearing transactions in these cases:
      // 1. If we're coming from the Sniper page with new=true parameter
      // 2. If we're on the Transactions page (just switching tabs)
      // 3. If transactions were already loaded and should be shown

      const urlParams = new URLSearchParams(window.location.search);
      const isNewTransaction = urlParams.get('new') === 'true';

      // Skip clearing if transactions should be shown
      if (isNewTransaction || showWithoutWallet) {
        return;
      }

      // Only clear transactions when wallet actually disconnects
      if (!isConnected && transactions.length > 0) {
        // Clear all transactions when wallet disconnects
        clearTransactions();
        setTransactions([]);
        setShowWithoutWallet(false);
        toast.info("All transactions have been cleared");
      }
    };

    // Watch for changes in connected status
    handleWalletDisconnect(connected);
  }, [connected, transactions.length, showWithoutWallet]);

  // Update transactions immediately and periodically when connection state changes
  useEffect(() => {
    // Skip if already loaded in the first useEffect
    if (loading) return;

    // This useEffect was causing conflicts with loadAllTransactions()
    // Removed the interval that was clearing transactions every 500ms
    // The main transaction loading is now handled by loadAllTransactions() only
  }, [connected, showWithoutWallet, loading]);

  // Kiểm tra tham số URL để xem có cần focus vào transaction mới không
  useEffect(() => {
    // Kiểm tra nếu URL có tham số ?new=true thì tự động scroll đến transaction mới nhất
    const urlParams = new URLSearchParams(window.location.search);
    const isNewTransaction = urlParams.get('new') === 'true';
    if (isNewTransaction && transactions.length > 0) {
      // Could add code to scroll to the first transaction here if needed
    }
  }, [transactions]);

  // Check localStorage for transactions when loading finishes and no transactions found
  useEffect(() => {
    if (!loading && transactions.length === 0) {
      try {
        if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
          const storedData = localStorage.getItem('transactions');
          if (storedData) {
            const parsedTransactions = JSON.parse(storedData);
            if (Array.isArray(parsedTransactions) && parsedTransactions.length > 0) {
              // If there are transactions in localStorage, display them
              setTransactions(parsedTransactions);
              setShowWithoutWallet(true);
            }
          }
        }
      } catch (e) {
        console.error("Error in final localStorage check:", e);
      }
    }
  }, [loading, transactions.length]);

  // ✅ ALL HOOKS ABOVE - NOW CONDITIONAL RENDERING IS SAFE

  // If not authenticated, show empty state  
  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
        <div className="max-w-md space-y-6">
          <div className="w-24 h-24 mx-auto bg-primary/10 rounded-full flex items-center justify-center">
            <AlertCircle className="w-12 h-12 text-primary" />
          </div>

          <div className="space-y-2">
            <h2 className="text-2xl font-bold">Connect Your Profile Wallet</h2>
            <p className="text-muted-foreground">
              Connect your profile wallet to view your transaction history.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Hiển thị loader khi đang tải
  if (loading) {
    return (
      <div className="flex-1 p-6">
        <div className="max-w-7xl mx-auto">
          <div className="mb-6">
            <h1 className="text-2xl font-bold gradient-text">Transactions</h1>
            <p className="text-sm text-muted-foreground mt-1">View your recent trading activity</p>
          </div>

          <div className="glass p-8 rounded-xl text-center">
            <div className="flex justify-center mb-4">
              <div className="p-3 rounded-full bg-primary/10">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
            </div>
            <h3 className="text-lg font-semibold mb-2">Loading Transactions</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm mx-auto">
              Please wait while we fetch your trading activity
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Hiển thị thông báo khi không có giao dịch 
  if (!loading && transactions.length === 0) {
    // Hiển thị thông báo không có giao dịch, chung cho cả trường hợp có wallet và không có wallet
    return (
      <div className="flex-1 p-6">
        <div className="max-w-7xl mx-auto">
          <div className="mb-6">
            <h1 className="text-2xl font-bold gradient-text">Transactions</h1>
            <p className="text-sm text-muted-foreground mt-1">View your recent trading activity</p>
          </div>

          <div className="glass p-8 rounded-xl text-center">
            <div className="flex justify-center mb-4">
              <div className="p-3 rounded-full bg-primary/10">
                <AlertCircle className="w-8 h-8 text-primary" />
              </div>
            </div>
            <h3 className="text-lg font-semibold mb-2">No Transactions Yet</h3>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm mx-auto">
              {connected
                ? "Configure and activate a sniper to start trading tokens"
                : "Configure a sniper to start trading tokens"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Total profit is reset to 0 as requested
  // const metrics = calculatePerformanceMetrics(transactions);
  // const totalProfit = metrics.totalPnl;

  return (
    <div className="flex-1 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold gradient-text">Transactions</h1>
            <p className="text-sm text-muted-foreground mt-1">View your recent trading activity</p>
          </div>

          <div className="flex items-center space-x-4">
            <div className="glass px-4 py-2 rounded-lg">
              <div className="text-sm text-muted-foreground">Total Profit</div>
              <div className="text-lg font-bold text-green-500">
                {(() => {
                  const metrics = calculatePerformanceMetrics(transactions);
                  const profit = metrics.totalPnl;
                  return `${profit >= 0 ? '+' : ''}${profit.toFixed(4)} SOL`;
                })()}
              </div>
            </div>

            {transactions.length > 0 && (
              <button
                onClick={handleClearAll}
                className="modern-button bg-red-500/80 hover:bg-red-500 flex items-center space-x-2 px-3 py-2"
                title="Clear all transactions"
              >
                <Trash2 className="w-4 h-4" />
                <span>Clear All</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
          {transactions.map(tx => (
            <TransactionRow
              key={tx.id}
              transaction={tx}
              allTransactions={transactions}
              solUsd={solUsd}
              onDelete={handleDeleteTransaction}
            />
          ))}
        </div>
        <div className="mt-6">
          <h2 className="text-xl font-bold gradient-text">Logs</h2>
          <div className="glass p-4 rounded-xl mt-4 h-64 overflow-y-auto">
            {logs.map((log, index) => (
              <div key={index} className="font-mono text-xs text-muted-foreground">
                {log}
              </div>
            ))}
          </div>
          <Button onClick={clearLogs} className="mt-4">Clear Logs</Button>
        </div>
      </div>
    </div>
  );
};

export default Transactions;
