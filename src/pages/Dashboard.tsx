import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useSelector, useDispatch } from 'react-redux';
import { Link, useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { RootState } from '../store';
import { Transaction, addTransactionWithDB } from '../store/slices/transactionsSlice';
import { fetchDashboardTransactions } from '../lib/transactionApi';
import { useManagedWallets } from '../hooks/useManagedWallets';
import { useAuthenticatedSniperConfigs, useAuthenticatedTransactions, useIsAuthenticated } from '../hooks/useSimpleAuth';
import { useAuth } from '../contexts/AuthContext';
import { getTokenDisplayName, getTokenFullDisplayName } from '../lib/tokenDisplayUtils';
import RecentTransactions from '../components/RecentTransactions';
import { FitText } from '../components/FitText';
import TokenDetailsModal from '../components/TokenDetailsModal';
import {
  TrendingUp,
  TrendingDown,
  Zap,
  Target,
  AlertCircle,
  DollarSign,
  Activity,
  BarChart3,
  Clock,
  CheckCircle,
  XCircle,
  Crosshair,
  Coins,
  Wallet,
  ExternalLink
} from 'lucide-react';

// Build a link to a token's launch platform. Prefers the RECORDED venue from the
// DB (holding.dex, attached by the holdings endpoint) — the old mint-suffix
// heuristic broke once pump.fun stopped guaranteeing the "pump" suffix, sending
// pump.fun tokens to a DexScreener badge. Suffix remains the fallback.
const getTokenSource = (mint: string, dexHint?: string | null): { label: string; url: string } => {
  const m = (mint || '').toLowerCase();
  const dex = (dexHint || '').toLowerCase();
  if (dex.includes('pump') || m.endsWith('pump')) {
    return { label: 'Pump.fun', url: `https://pump.fun/coin/${mint}` };
  }
  if (dex.includes('launchlab') || m.endsWith('bonk')) {
    return { label: 'LaunchLab', url: `https://raydium.io/launchpad/token/?mint=${mint}` };
  }
  return { label: 'DexScreener', url: `https://dexscreener.com/solana/${mint}` };
};
import { cn } from '../lib/utils';
import { Button } from '../components/ui/button';

// 🚨 SECURITY FIX: Check authentication status is now handled by useIsAuthenticated hook

// Component for when user is not authenticated
const UnauthenticatedDashboard: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="max-w-md space-y-6">
        <div className="w-24 h-24 mx-auto bg-primary/10 rounded-full flex items-center justify-center">
          <Wallet className="w-12 h-12 text-primary" />
        </div>

        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Connect Your Profile Wallet</h2>
          <p className="text-muted-foreground">
            Connect your profile wallet to access your dashboard, view your trading history, and manage your sniping wallets.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="glass p-4 rounded-lg">
            <Target className="w-8 h-8 text-blue-500 mx-auto mb-2" />
            <div className="font-medium">Sniper Configs</div>
            <div className="text-muted-foreground">Manage automated trading</div>
          </div>
          <div className="glass p-4 rounded-lg">
            <BarChart3 className="w-8 h-8 text-green-500 mx-auto mb-2" />
            <div className="font-medium">Trading History</div>
            <div className="text-muted-foreground">Track your performance</div>
          </div>
          <div className="glass p-4 rounded-lg">
            <Coins className="w-8 h-8 text-yellow-500 mx-auto mb-2" />
            <div className="font-medium">Managed Wallets</div>
            <div className="text-muted-foreground">Import & create wallets</div>
          </div>
          <div className="glass p-4 rounded-lg">
            <Activity className="w-8 h-8 text-purple-500 mx-auto mb-2" />
            <div className="font-medium">Live Analytics</div>
            <div className="text-muted-foreground">Real-time insights</div>
          </div>
        </div>
      </div>
    </div>
  );
};

interface DashboardStats {
  totalProfit: number;
  activeSnipes: number;
  successfulTrades: number;
  failedTrades: number;
  totalTrades: number;
  successRate: number;
}

interface RecentTrade {
  id: string;
  tokenSymbol: string;
  type: 'buy' | 'sell';
  amount: number;
  profit: number;
  timestamp: string;
  status: 'success' | 'failed' | 'pending';
}

interface TokenHolding {
  mint: string;
  balance: number;
  decimals: number;
  amount: string;
  uiAmount: number | null;
  symbol?: string;
  name?: string;
  logoURI?: string;
  price?: number;
  value?: number;
}

interface HealthStatus {
  timestamp: string;
  services: {
    database: { status: string; responseTime: number };
    raydium: { status: string; responseTime: number };
    jupiter: { status: string; responseTime: number };
    solana_rpc: { status: string; responseTime: number };
  };
}

const Dashboard: React.FC = () => {
  // 🚨 SECURITY: Use authenticated hooks and data - CALL ALL HOOKS FIRST
  const isAuthenticated = useIsAuthenticated();
  const { sessionToken } = useAuth();
  const dispatch = useDispatch();
  const wallet = useWallet();

  // 🚨 SECURITY: Use authenticated hooks instead of direct Redux access
  const sniperConfigs = useAuthenticatedSniperConfigs();
  const transactions = useAuthenticatedTransactions() as Transaction[];

  // Get managed wallet for fetching transactions
  const { activeWallet } = useManagedWallets();

  const [stats, setStats] = useState<DashboardStats>({
    totalProfit: 0,
    activeSnipes: 0,
    successfulTrades: 0,
    failedTrades: 0,
    totalTrades: 0,
    successRate: 0,
  });

  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [isLoadingHealth, setIsLoadingHealth] = useState(true);
  const [activeSnipesCount, setActiveSnipesCount] = useState(0);
  const [recentTrades, setRecentTrades] = useState<RecentTrade[]>([]);
  const [loadingRecentTrades, setLoadingRecentTrades] = useState(false);
  const [dbTransactions, setDbTransactions] = useState<Transaction[]>([]);
  const [tokenHoldings, setTokenHoldings] = useState<TokenHolding[]>([]);
  const [loadingHoldings, setLoadingHoldings] = useState(false);

  // Token feed modal state
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string | null>(null);
  const [isTokenModalOpen, setIsTokenModalOpen] = useState(false);
  const [sellLoading, setSellLoading] = useState<{ [key: string]: boolean }>({});

  // Use ref to track last fetched wallet to prevent infinite loops
  const lastFetchedWalletId = useRef<string | null>(null);

  // Convert Transaction to RecentTrade format
  const convertToRecentTrade = useCallback((transaction: Transaction): RecentTrade => {
    const getRelativeTime = (timestamp: number) => {
      const now = Date.now();
      const diff = now - timestamp;
      const minutes = Math.floor(diff / (1000 * 60));
      if (minutes < 1) return 'Just now';
      if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
      const days = Math.floor(hours / 24);
      return `${days} day${days > 1 ? 's' : ''} ago`;
    };

    return {
      id: transaction.id,
      tokenSymbol: getTokenDisplayName(transaction),
      type: transaction.type,
      amount: transaction.amount,
      profit: typeof transaction.profit === 'string' ? parseFloat(transaction.profit) : (transaction.profit || 0),
      timestamp: getRelativeTime(transaction.timestamp),
      status: transaction.status === 'confirmed' ? 'success' :
        transaction.status === 'failed' ? 'failed' : 'pending'
    };
  }, []); // No dependencies needed as this is a pure function

  // Fetch token holdings from the active wallet
  const fetchTokenHoldings = useCallback(async (bustCache = false) => {
    if (!activeWallet || !sessionToken) {
      setTokenHoldings([]);
      return;
    }

    try {
      setLoadingHoldings(true);

      // Add cache-busting parameter when requested (e.g., after a transaction)
      const cacheBuster = bustCache ? `&_t=${Date.now()}` : '';

      const response = await fetch(`/api/wallets/${activeWallet.id}/token-holdings?includeMetadata=true${cacheBuster}`, {
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json',
          // Force fresh data when busting cache
          ...(bustCache && { 'Cache-Control': 'no-cache, no-store, must-revalidate' })
        }
      });
      if (!response.ok) {
        throw new Error('Failed to fetch token holdings');
      }

      const data = await response.json();
      // Show top 5 holdings by value (if available) or balance
      const sortedHoldings = (data.holdings || [])
        .filter((holding: TokenHolding) => holding.balance > 0.000001) // Client-side dust filter
        .sort((a: TokenHolding, b: TokenHolding) => {
          if (a.value && b.value) return b.value - a.value;
          return b.balance - a.balance;
        })
        .slice(0, 5);

      console.log(`📊 Token holdings updated: ${sortedHoldings.length} tokens (cache-busted: ${bustCache})`);
      setTokenHoldings(sortedHoldings);
    } catch (error) {
      console.error('Failed to fetch token holdings:', error);
      setTokenHoldings([]);
    } finally {
      setLoadingHoldings(false);
    }
  }, [activeWallet, sessionToken]);

  // Fetch transactions from database (unified approach - database as single source of truth)
  const fetchTransactions = useCallback(async () => {
    if (!activeWallet) {
      setRecentTrades([]);
      setDbTransactions([]);
      return;
    }

    try {
      setLoadingRecentTrades(true);

      // Fetch from database using fast dashboard endpoint with wallet ID
      // Get enough for both recent trades (5) and stats calculation (100)
      const allTxs = await fetchDashboardTransactions(activeWallet.id, 100);

      // Convert first 5 to recent trades format
      const latestTransactions = allTxs
        .slice(0, 5)
        .map(convertToRecentTrade);

      setRecentTrades(latestTransactions);
      setDbTransactions(allTxs);
    } catch (error) {
      console.error('Failed to fetch transactions:', error);
      // Fallback to empty state
      setRecentTrades([]);
      setDbTransactions([]);
    } finally {
      setLoadingRecentTrades(false);
    }
  }, [activeWallet, convertToRecentTrade]);

  // Fetch health status
  const fetchHealthStatus = useCallback(async () => {
    try {
      setIsLoadingHealth(true);
      const response = await fetch('/api/system/health');
      if (response.ok) {
        const health = await response.json();
        setHealthStatus(health);
      }
    } catch (error) {
      console.error('Failed to fetch health status:', error);
    } finally {
      setIsLoadingHealth(false);
    }
  }, []);

  // Buy modal state
  const [buyModalOpen, setBuyModalOpen] = useState(false);
  const [buyTargetToken, setBuyTargetToken] = useState<string | null>(null);
  const [buyAmount, setBuyAmount] = useState('0.1');
  const [buyDex, setBuyDex] = useState<'jupiter' | 'raydium'>('jupiter');
  const [buyLoading, setBuyLoading] = useState(false);
  const [buyMsg, setBuyMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Sell confirm modal state
  const [sellPendingToken, setSellPendingToken] = useState<TokenHolding | null>(null);
  const [sellSelectedDex, setSellSelectedDex] = useState<'auto' | 'pumpfun' | 'pumpswap' | 'jupiter' | 'raydium'>('auto');
  const [sellConfirmOpen, setSellConfirmOpen] = useState(false);
  const [sellMsg, setSellMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Handle selling a specific token with optimistic UI updates
  const handleSellToken = useCallback(async (holding: TokenHolding) => {
    if (!activeWallet) {
      setSellMsg({ type: 'error', text: 'No active wallet selected.' });
      return;
    }
    // Open confirmation modal instead of window.prompt/confirm
    setSellPendingToken(holding);
    // Always default to Auto so the server's resilient routing chain runs
    // (pump.fun → Jupiter → PumpSwap). Forcing 'pumpfun' made any single
    // PumpPortal hiccup hard-500 with no fallback. The user can still pick a
    // specific DEX manually in the confirm dialog.
    setSellSelectedDex('auto');
    setSellConfirmOpen(true);
  }, [activeWallet]);

  // Called when user confirms the sell inside the modal
  const executeSell = useCallback(async () => {
    const holding = sellPendingToken;
    const selectedDEX = sellSelectedDex;
    if (!holding || !activeWallet) return;
    setSellConfirmOpen(false);
    setSellPendingToken(null);

    // 🚀 OPTIMISTIC UI UPDATE: Immediately remove token from holdings
    const originalHoldings = [...tokenHoldings];
    setTokenHoldings(prev => prev.filter(h => h.mint !== holding.mint));
    console.log(`⚡ Instantly removed ${holding.symbol} from UI - transaction processing in background`);

    try {
      setSellLoading(prev => ({ ...prev, [holding.mint]: true }));

      const tokenAmountRaw = holding.amount || Math.floor(holding.balance * Math.pow(10, holding.decimals));

      const SOL_MINT = 'So11111111111111111111111111111111111111112';

      const sellTransaction: Transaction = {
        id: `sell-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        txId: 'pending',
        tokenName: holding.name || holding.symbol || 'Unknown Token',
        tokenSymbol: holding.symbol || 'UNKNOWN',
        tokenAddress: holding.mint,
        type: 'sell',
        amount: holding.balance,
        price: holding.price || 0,
        profit: 0,
        status: 'pending',
        timestamp: Date.now(),
        tokenType: 'sol',
        dex: selectedDEX
      };

      dispatch(addTransactionWithDB(sellTransaction));

      const response = await fetch('/api/wallets/sell-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          walletId: activeWallet.id,
          tokenMint: holding.mint,
          tokenAmount: tokenAmountRaw,
          tokenDecimals: holding.decimals,
          outputMint: SOL_MINT,
          dex: selectedDEX,
          slippageBps: 300,
          tokenName: holding.name || holding.symbol || 'Unknown',
          tokenSymbol: holding.symbol || 'UNKNOWN',
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to execute sell transaction');
      }

      const result = await response.json();

      dispatch(addTransactionWithDB({ ...sellTransaction, txId: result.signature, status: 'confirmed', price: result.solReceived > 0 ? result.solReceived / holding.balance : 0 }));
      setSellMsg({ type: 'success', text: `✅ ${holding.symbol} sold for ${result.solReceived.toFixed(6)} SOL` });
      setTimeout(() => setSellMsg(null), 6000);

    } catch (error) {
      setTokenHoldings(originalHoldings);
      const raw = error instanceof Error ? error.message : 'Unknown error';
      let friendlyMsg = raw;
      if (raw.includes('0x1772') || raw.includes('TooMuchSolRequired') || raw.includes('slippage')) {
        friendlyMsg = 'Slippage exceeded — price moved too fast. Try again.';
      } else if (raw.includes('0x1788') || raw.includes('Overflow')) {
        friendlyMsg = 'On-chain overflow — try selling a smaller amount.';
      } else if (raw.includes('0x1') || raw.includes('InsufficientFunds') || raw.includes('insufficient')) {
        friendlyMsg = 'Insufficient SOL balance for fees.';
      } else if (raw.includes('blockhash') || raw.includes('expired')) {
        friendlyMsg = 'Transaction expired — network congestion. Try again.';
      } else if (raw.length > 120) {
        friendlyMsg = raw.slice(0, 100) + '…';
      }
      setSellMsg({ type: 'error', text: `❌ Sell failed: ${friendlyMsg}` });
      setTimeout(() => setSellMsg(null), 8000);
    } finally {
      setSellLoading(prev => ({ ...prev, [holding.mint]: false }));
    }
  }, [activeWallet, dispatch, sessionToken, tokenHoldings, sellPendingToken, sellSelectedDex]);


  // Token feed handlers
  const handleTokenSelect = useCallback((token: any) => {
    setSelectedTokenAddress(token.address);
    setIsTokenModalOpen(true);
  }, []);

  const navigate = useNavigate();

  const handleTokenTrade = useCallback((action: 'buy' | 'sell', tokenAddress: string) => {
    setIsTokenModalOpen(false);

    if (action === 'buy') {
      if (!activeWallet) {
        setBuyMsg({ type: 'error', text: 'Please select an active wallet in Wallet Manager before buying.' });
        return;
      }
      setBuyTargetToken(tokenAddress);
      setBuyAmount('0.1');
      setBuyDex('jupiter');
      setBuyModalOpen(true);
    } else if (action === 'sell') {
      // Navigate to Sniper Config — the user can add a sell config for the token
      navigate(`/sniper?tokenAddress=${tokenAddress}`);
    }
  }, [activeWallet, navigate]);

  const handleExecuteBuy = useCallback(async () => {
    if (!activeWallet || !sessionToken || !buyTargetToken) return;
    const solAmount = parseFloat(buyAmount);
    if (isNaN(solAmount) || solAmount <= 0) {
      setBuyMsg({ type: 'error', text: 'Please enter a valid SOL amount.' });
      return;
    }
    setBuyMsg(null);
    setBuyLoading(true);
    try {
      const response = await fetch('/api/wallets/buy-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
        body: JSON.stringify({
          walletId: activeWallet.id,
          tokenMint: buyTargetToken,
          solAmount,
          outputMint: buyTargetToken,
          slippageBps: 100,
          dex: buyDex,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Buy failed');
      setBuyModalOpen(false);
      setBuyMsg({ type: 'success', text: `✅ Buy successful! TxID: ${data.signature?.slice(0, 16)}...` });
      setTimeout(() => setBuyMsg(null), 6000);
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      setBuyMsg({ type: 'error', text: `❌ Buy failed: ${err.message}` });
    } finally {
      setBuyLoading(false);
    }
  }, [activeWallet, sessionToken, buyTargetToken, buyAmount, buyDex]);

  const handleCloseTokenModal = useCallback(() => {
    setIsTokenModalOpen(false);
    setSelectedTokenAddress(null);
  }, []);

  useEffect(() => {
    // Fetch initial health status
    fetchHealthStatus();

    // Refresh health status every 30 seconds
    const healthInterval = setInterval(fetchHealthStatus, 30000);

    return () => clearInterval(healthInterval);
  }, [fetchHealthStatus]);

  // Fetch real active snipes count from server
  useEffect(() => {
    if (!sessionToken) return;
    fetch('/api/active-snipes', { headers: { 'Authorization': `Bearer ${sessionToken}` } })
      .then(r => r.ok ? r.json() : { activeSnipes: [] })
      .then(d => setActiveSnipesCount((d.activeSnipes || []).length))
      .catch(() => setActiveSnipesCount(0));
  }, [sessionToken]);

  useEffect(() => {
    const allTransactions = dbTransactions;
    if (allTransactions.length === 0 && dbTransactions.length === 0) {
      setStats({ totalProfit: 0, activeSnipes: activeSnipesCount, successfulTrades: 0, failedTrades: 0, totalTrades: 0, successRate: 0 });
      return;
    }
    const successfulTrades = allTransactions.filter((t: Transaction) => t.status === 'confirmed').length;
    const failedTrades = allTransactions.filter((t: Transaction) => t.status === 'failed').length;
    const totalTrades = allTransactions.length;
    const totalProfit = allTransactions
      .filter((t: Transaction) => t.status === 'confirmed')
      .reduce((sum: number, t: Transaction) => sum + (typeof t.profit === 'string' ? parseFloat(t.profit) : (t.profit || 0)), 0);
    setStats({ totalProfit, activeSnipes: activeSnipesCount, successfulTrades, failedTrades, totalTrades, successRate: totalTrades > 0 ? (successfulTrades / totalTrades) * 100 : 0 });
  }, [activeSnipesCount, dbTransactions]);

  useEffect(() => {
    // Fetch transactions when component mounts or active wallet changes
    // Prevent infinite loops by checking if we need to fetch
    const currentWalletId = activeWallet?.id || null;

    if (currentWalletId !== lastFetchedWalletId.current) {
      lastFetchedWalletId.current = currentWalletId;

      if (!activeWallet) {
        setRecentTrades([]);
        setDbTransactions([]);
        setTokenHoldings([]);
        return;
      }

      fetchTransactions();
      fetchTokenHoldings();
    }
  }, [activeWallet?.id, fetchTransactions, fetchTokenHoldings]);

  // If not authenticated, show the unauthenticated component - ALL HOOKS CALLED ABOVE
  if (!isAuthenticated) {
    return <UnauthenticatedDashboard />;
  }

  // Main dashboard JSX
  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold gradient-text">Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Monitor your sniper bot performance and manage your configurations
          </p>
        </div>
        <Link to="/sniper">
          {/* Themed like the Sniper page's Live Feed / Start Sniper buttons (glass + border) */}
          <button className="flex items-center gap-2 px-4 py-2 rounded-lg glass border border-border text-foreground hover:border-primary hover:text-primary transition-colors duration-200">
            <Crosshair className="h-4 w-4" />
            Sniper Config
          </button>
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="glass p-6 rounded-xl hover:shadow-lg transition-shadow">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-green-500/10 rounded-full shrink-0">
              <DollarSign className="h-6 w-6 text-green-500" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-muted-foreground"><FitText max={14} min={10}>Total Profit</FitText></p>
              <p className={cn("font-bold", {
                "text-green-500": stats.totalProfit >= 0,
                "text-red-500": stats.totalProfit < 0
              })}>
                <FitText max={24} min={12} className="tabular-nums">
                  {stats.totalProfit >= 0 ? '+' : ''}${stats.totalProfit.toFixed(2)}
                </FitText>
              </p>
            </div>
          </div>
        </div>

        <div className="glass p-6 rounded-xl hover:shadow-lg transition-shadow">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-blue-500/10 rounded-full shrink-0">
              <Target className="h-6 w-6 text-blue-500" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-muted-foreground"><FitText max={14} min={10}>Active Snipes</FitText></p>
              <p className="font-bold"><FitText max={24} min={12} className="tabular-nums">{stats.activeSnipes}</FitText></p>
            </div>
          </div>
        </div>

        <div className="glass p-6 rounded-xl hover:shadow-lg transition-shadow">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-purple-500/10 rounded-full shrink-0">
              <Activity className="h-6 w-6 text-purple-500" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-muted-foreground"><FitText max={14} min={10}>Total Trades</FitText></p>
              <p className="font-bold"><FitText max={24} min={12} className="tabular-nums">{stats.totalTrades}</FitText></p>
            </div>
          </div>
        </div>

        <div className="glass p-6 rounded-xl hover:shadow-lg transition-shadow">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-orange-500/10 rounded-full shrink-0">
              <BarChart3 className="h-6 w-6 text-orange-500" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-muted-foreground"><FitText max={14} min={10}>Success Rate</FitText></p>
              <p className="font-bold"><FitText max={24} min={12} className="tabular-nums">{stats.successRate.toFixed(1)}%</FitText></p>
            </div>
          </div>
        </div>
      </div>

      {/* Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Recent Transactions (audit §5 — replaced LiveTokenFeed; live feed lives in /sniper) */}
        <RecentTransactions
          transactions={dbTransactions as any}
          loading={loadingRecentTrades}
          limit={10}
        />

        {/* Token Holdings */}
        <div className="glass p-6 rounded-xl">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Coins className="h-5 w-5" />
              Token Holdings
            </h2>
            <Button variant="outline" size="sm" onClick={() => fetchTokenHoldings(true)} disabled={loadingHoldings}>
              {loadingHoldings ? 'Loading...' : 'Refresh'}
            </Button>
          </div>

          {loadingHoldings ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex items-center gap-4 p-4 glass rounded-lg animate-pulse">
                  <div className="w-8 h-8 bg-muted rounded-full"></div>
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-muted rounded w-3/4"></div>
                    <div className="h-3 bg-muted rounded w-1/2"></div>
                  </div>
                  <div className="h-4 bg-muted rounded w-16"></div>
                </div>
              ))}
            </div>
          ) : tokenHoldings.length > 0 ? (
            <div className="space-y-4">
              {tokenHoldings.map((holding) => (
                <div key={holding.mint} className="flex items-center gap-4 p-4 glass rounded-lg hover:bg-white/5 transition-colors">
                  <div className="p-2 bg-blue-500/10 rounded-full">
                    <Coins className="h-4 w-4 text-blue-500" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{holding.symbol || 'Unknown'}</span>
                      {holding.name && (
                        <span className="text-xs text-muted-foreground">({holding.name})</span>
                      )}
                      {(() => {
                        const src = getTokenSource(holding.mint, (holding as any).dex);
                        const isPump = src.label === 'Pump.fun';
                        const isLaunch = src.label === 'LaunchLab';
                        return (
                          <a
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title={`View on ${src.label}`}
                            className={cn(
                              'inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors',
                              isPump && 'bg-green-500/15 text-green-400 hover:bg-green-500/25',
                              isLaunch && 'bg-orange-500/15 text-orange-400 hover:bg-orange-500/25',
                              !isPump && !isLaunch && 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25'
                            )}
                          >
                            {src.label}
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        );
                      })()}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {holding.balance.toLocaleString()} tokens
                      {holding.price && (
                        <span> • ${holding.price.toFixed(6)} each</span>
                      )}
                    </p>
                  </div>
                  <div className="text-right">
                    {holding.value && (
                      <p className="font-medium">${holding.value.toFixed(2)}</p>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleSellToken(holding)}
                      disabled={sellLoading[holding.mint]}
                      className="mt-1 text-xs"
                    >
                      {sellLoading[holding.mint] ? 'Selling...' : 'Sell'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Coins className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No token holdings found</p>
              <p className="text-sm">Buy some tokens to see them here</p>
            </div>
          )}
        </div>
      </div>

      {/* System Health Status */}
      <div className="glass p-6 rounded-xl">
        <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
          <Zap className="h-5 w-5" />
          System Health
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 text-sm">
          {healthStatus && !isLoadingHealth ? (
            // Show actual health status with proper colors
            <>
              <div className="flex items-center gap-3">
                <div className={cn("w-3 h-3 rounded-full", {
                  "bg-green-500": healthStatus.services.solana_rpc.status === 'healthy',
                  "bg-yellow-500": ['degraded', 'unknown'].includes(healthStatus.services.solana_rpc.status),
                  "bg-red-500": healthStatus.services.solana_rpc.status === 'unhealthy'
                })}></div>
                <span className="text-sm">
                  Solana RPC: {healthStatus.services.solana_rpc.status === 'healthy' ? 'Connected' :
                    healthStatus.services.solana_rpc.status === 'degraded' ? 'Slow' :
                    healthStatus.services.solana_rpc.status === 'unknown' ? 'Checking...' : 'Disconnected'}
                  {healthStatus.services.solana_rpc.responseTime > 0 && (
                    <span className="text-xs text-muted-foreground ml-1">
                      ({healthStatus.services.solana_rpc.responseTime}ms)
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div className={cn("w-3 h-3 rounded-full", {
                  "bg-green-500": healthStatus.services.jupiter.status === 'healthy',
                  "bg-yellow-500": ['degraded', 'unknown'].includes(healthStatus.services.jupiter.status),
                  "bg-red-500": healthStatus.services.jupiter.status === 'unhealthy'
                })}></div>
                <span className="text-sm">
                  Jupiter API: {healthStatus.services.jupiter.status === 'healthy' ? 'Active' :
                    healthStatus.services.jupiter.status === 'degraded' ? 'Limited' :
                    healthStatus.services.jupiter.status === 'unknown' ? 'Checking...' : 'Offline'}
                  {healthStatus.services.jupiter.responseTime > 0 && (
                    <span className="text-xs text-muted-foreground ml-1">
                      ({healthStatus.services.jupiter.responseTime}ms)
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div className={cn("w-3 h-3 rounded-full", {
                  "bg-green-500": healthStatus.services.raydium.status === 'healthy',
                  "bg-yellow-500": ['degraded', 'unknown'].includes(healthStatus.services.raydium.status),
                  "bg-red-500": healthStatus.services.raydium.status === 'unhealthy'
                })}></div>
                <span className="text-sm">
                  Raydium API: {healthStatus.services.raydium.status === 'healthy' ? 'Active' :
                    healthStatus.services.raydium.status === 'degraded' ? 'Limited' :
                    healthStatus.services.raydium.status === 'unknown' ? 'Checking...' : 'Offline'}
                  {healthStatus.services.raydium.responseTime > 0 && (
                    <span className="text-xs text-muted-foreground ml-1">
                      ({healthStatus.services.raydium.responseTime}ms)
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div className={cn("w-3 h-3 rounded-full", {
                  "bg-green-500": healthStatus.services.database.status === 'healthy',
                  "bg-yellow-500": ['degraded', 'unknown'].includes(healthStatus.services.database.status),
                  "bg-red-500": healthStatus.services.database.status === 'unhealthy'
                })}></div>
                <span className="text-sm">
                  Database: {healthStatus.services.database.status === 'healthy' ? 'Connected' :
                    healthStatus.services.database.status === 'degraded' ? 'Slow' :
                    healthStatus.services.database.status === 'unknown' ? 'Checking...' : 'Disconnected'}
                  {healthStatus.services.database.responseTime > 0 && (
                    <span className="text-xs text-muted-foreground ml-1">
                      ({healthStatus.services.database.responseTime}ms)
                    </span>
                  )}
                </span>
              </div>
            </>
          ) : (
            // Loading state - always show all systems as loading with yellow indicators
            <>
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 bg-yellow-500 rounded-full animate-pulse"></div>
                <span className="text-sm">Solana RPC: Loading...</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 bg-yellow-500 rounded-full animate-pulse"></div>
                <span className="text-sm">Jupiter API: Loading...</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 bg-yellow-500 rounded-full animate-pulse"></div>
                <span className="text-sm">Raydium API: Loading...</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 bg-yellow-500 rounded-full animate-pulse"></div>
                <span className="text-sm">Database: Loading...</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Token Details Modal */}
      {selectedTokenAddress && (
        <TokenDetailsModal
          tokenAddress={selectedTokenAddress}
          isOpen={isTokenModalOpen}
          onClose={handleCloseTokenModal}
          onTrade={handleTokenTrade}
        />
      )}

      {/* Buy/Sell Status Banners — bottom-right toasts */}
      {(buyMsg || sellMsg) && (
        <div className="fixed bottom-6 right-6 z-50 space-y-2 max-w-sm">
          {buyMsg && (
            <div className={`px-4 py-3 rounded-xl text-sm font-medium shadow-lg border ${buyMsg.type === 'success' ? 'bg-green-900/80 border-green-500/40 text-green-300' : 'bg-red-900/80 border-red-500/40 text-red-300'}`}>
              {buyMsg.text}
            </div>
          )}
          {sellMsg && (
            <div className={`px-4 py-3 rounded-xl text-sm font-medium shadow-lg border ${sellMsg.type === 'success' ? 'bg-green-900/80 border-green-500/40 text-green-300' : 'bg-red-900/80 border-red-500/40 text-red-300'}`}>
              {sellMsg.text}
            </div>
          )}
        </div>
      )}

      {/* Sell Confirm Modal */}
      {sellConfirmOpen && sellPendingToken && ReactDOM.createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-background border border-border rounded-2xl p-6 w-full max-w-sm mx-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">🔴 Confirm Sell</h2>
              <button onClick={() => { setSellConfirmOpen(false); setSellPendingToken(null); }} className="text-muted-foreground hover:text-white text-xl leading-none">×</button>
            </div>
            <div className="space-y-1 text-sm">
              <p className="text-muted-foreground">Token: <span className="text-white font-medium">{sellPendingToken.symbol || 'Unknown'}</span></p>
              <p className="text-muted-foreground">Balance: <span className="text-white">{sellPendingToken.balance.toLocaleString()}</span></p>
              {sellPendingToken.value && <p className="text-muted-foreground">Est. Value: <span className="text-green-400">${sellPendingToken.value.toFixed(2)}</span></p>}
              <p className="text-muted-foreground">Wallet: <span className="text-white">{activeWallet?.name}</span></p>
            </div>
            <p className="text-xs text-yellow-400">⚠️ Sells ALL tokens of this type. Real blockchain transaction.</p>
            {/* DEX Selector */}
            <div>
              <label className="block text-xs text-muted-foreground mb-2">Sell via</label>
              {(sellPendingToken.mint || '').toLowerCase().endsWith('pump') ? (
                <>
                  {/* pump.fun token — only its source exchanges (Jupiter can't route these) */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSellSelectedDex('auto')}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ${
                        sellSelectedDex === 'auto'
                          ? 'bg-green-600 border-green-500 text-white'
                          : 'bg-secondary border-input text-foreground/80 hover:bg-secondary'
                      }`}
                    >
                      ✨ Auto
                    </button>
                    <button
                      onClick={() => setSellSelectedDex('pumpfun')}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ${
                        sellSelectedDex === 'pumpfun'
                          ? 'bg-green-600 border-green-500 text-white'
                          : 'bg-secondary border-input text-foreground/80 hover:bg-secondary'
                      }`}
                    >
                      💊 Pump.fun
                    </button>
                    <button
                      onClick={() => setSellSelectedDex('pumpswap')}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ${
                        sellSelectedDex === 'pumpswap'
                          ? 'bg-purple-600 border-purple-500 text-white'
                          : 'bg-secondary border-input text-foreground/80 hover:bg-secondary'
                      }`}
                    >
                      ⚡ PumpSwap
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {sellSelectedDex === 'pumpswap'
                      ? 'For graduated tokens trading on PumpSwap'
                      : sellSelectedDex === 'pumpfun'
                      ? 'Bonding-curve sell on pump.fun (auto-falls back to PumpSwap if graduated)'
                      : 'Recommended — pump.fun bonding curve first, then PumpSwap, then Jupiter'}
                  </p>
                </>
              ) : (
                <>
                  {/* Non-pump token — standard routing */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSellSelectedDex('auto')}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ${
                        sellSelectedDex === 'auto'
                          ? 'bg-green-600 border-green-500 text-white'
                          : 'bg-secondary border-input text-foreground/80 hover:bg-secondary'
                      }`}
                    >
                      ✨ Auto
                    </button>
                    <button
                      onClick={() => setSellSelectedDex('jupiter')}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ${
                        sellSelectedDex === 'jupiter'
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-secondary border-input text-foreground/80 hover:bg-secondary'
                      }`}
                    >
                      🔀 Jupiter
                    </button>
                    <button
                      onClick={() => setSellSelectedDex('raydium')}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ${
                        sellSelectedDex === 'raydium'
                          ? 'bg-purple-600 border-purple-500 text-white'
                          : 'bg-secondary border-input text-foreground/80 hover:bg-secondary'
                      }`}
                    >
                      ⚡ Raydium
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {sellSelectedDex === 'auto'
                      ? 'Recommended — finds the best available route automatically'
                      : sellSelectedDex === 'jupiter'
                      ? 'Jupiter aggregator — best for graduated/listed tokens'
                      : 'Direct Raydium route'}
                  </p>
                </>
              )}
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => { setSellConfirmOpen(false); setSellPendingToken(null); }}
                className="flex-1 py-2 rounded-lg border border-input text-foreground/80 hover:bg-secondary text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeSell}
                className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-colors"
              >
                Sell Now
              </button>
            </div>
          </div>
        </div>
        , document.body)}

      {/* Buy Token Modal */}
      {buyModalOpen && buyTargetToken && ReactDOM.createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-background border border-border rounded-2xl p-6 w-full max-w-sm mx-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Buy Token</h2>
              <button onClick={() => setBuyModalOpen(false)} className="text-muted-foreground hover:text-white text-xl leading-none">×</button>
            </div>
            <p className="text-xs text-muted-foreground break-all">
              Token: <span className="text-primary font-mono">{buyTargetToken}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Wallet: <span className="text-white font-medium">{activeWallet?.name}</span>
              {' '}({activeWallet?.balance?.toFixed(4)} SOL)
            </p>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">SOL Amount</label>
              <input
                type="number"
                min="0.001"
                step="0.01"
                value={buyAmount}
                onChange={e => setBuyAmount(e.target.value)}
                className="w-full bg-secondary border border-input rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-primary"
                placeholder="0.1"
              />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1">DEX</label>
              <select
                value={buyDex}
                onChange={e => setBuyDex(e.target.value as 'jupiter' | 'raydium')}
                className="w-full bg-secondary border border-input rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-primary"
              >
                <option value="jupiter">Jupiter (recommended)</option>
                <option value="raydium">Raydium</option>
              </select>
            </div>
            {buyMsg && (
              <p className={`text-xs ${buyMsg.type === 'error' ? 'text-red-400' : 'text-green-400'}`}>{buyMsg.text}</p>
            )}
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setBuyModalOpen(false)}
                className="flex-1 py-2 rounded-lg border border-input text-foreground/80 hover:bg-secondary text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleExecuteBuy}
                disabled={buyLoading}
                className="flex-1 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-semibold transition-colors disabled:opacity-50"
              >
                {buyLoading ? 'Buying…' : `Buy ${buyAmount} SOL`}
              </button>
            </div>
          </div>
        </div>
        , document.body)}
    </div>
  );
};

export default Dashboard;
