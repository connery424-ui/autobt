import React, { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Wallet, TrendingUp, Clock, Zap, ArrowUpRight, ArrowDownRight, AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { useIsAuthenticated } from '../hooks/useSimpleAuth';
import { useAuth } from '../contexts/AuthContext';
import { dexDisplayName } from '../lib/dexIds';

// 🚨 SECURITY: Component for when user is not authenticated
const UnauthenticatedAnalytics: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="max-w-md space-y-6">
        <div className="w-24 h-24 mx-auto bg-primary/10 rounded-full flex items-center justify-center">
          <TrendingUp className="w-12 h-12 text-primary" />
        </div>

        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Connect Your Profile Wallet</h2>
          <p className="text-muted-foreground">
            Connect your profile wallet to view analytics.
          </p>
        </div>
      </div>
    </div>
  );
};

interface DailyProfit {
  date: string;
  profit: number;
  cumulativeProfit?: number;
  trades?: number;
}

interface TokenPerformance {
  name: string;
  profit: number;
  trades: number;
  successRate: number;
}

interface TradingStats {
  totalProfit: number;
  totalTrades: number;
  successRate: number;
  avgProfitTrade: number;
  profitableTrades: number;
  buyTrades: number;
  sellTrades: number;
}

interface ApiStatsResponse {
  success: boolean;
  stats: TradingStats;
  meta: {
    queryTime: number;
    lastUpdated: string;
    dataSource: string;
  };
}

interface ApiProfitHistoryResponse {
  success: boolean;
  profitHistory: {
    date: string;
    profit: number;
    cumulativeProfit: number;
    trades: number;
  }[];
  meta: {
    totalDays: number;
    queryTime: number;
    lastUpdated: string;
    dataSource: string;
  };
}

interface ApiTokenPerformanceResponse {
  success: boolean;
  dexPerformance: {
    dexName: string;
    totalProfit: number;
    totalTrades: number;
    profitableTrades: number;
    successRate: number;
    avgProfitPerTrade: number;
  }[];
  meta: {
    totalDexsAnalyzed: number;
    queryTime: number;
    lastUpdated: string;
    dataSource: string;
  };
}

interface ApiTradingResultsResponse {
  success: boolean;
  bestResults: {
    bestTrade: {
      profit: number;
      tokenName: string;
      tokenSymbol: string;
      dex: string;
      date: string;
      txId: string;
    } | null;
    bestTradingDay: {
      date: string;
      totalProfit: number;
      trades: number;
      avgProfitPerTrade: number;
    } | null;
    longestWinStreak: number;
  };
  worstResults: {
    worstTrade: {
      profit: number;
      tokenName: string;
      tokenSymbol: string;
      dex: string;
      date: string;
      txId: string;
    } | null;
    worstTradingDay: {
      date: string;
      totalProfit: number;
      trades: number;
      avgProfitPerTrade: number;
    } | null;
    longestLossStreak: number;
  };
  meta: {
    totalTransactions: number;
    totalTradingDays: number;
    queryTime: number;
    lastUpdated: string;
    dataSource: string;
  };
}

const mockData: {
  dailyProfit: DailyProfit[];
  tokenPerformance: TokenPerformance[];
  tradingStats: TradingStats;
} = {
  dailyProfit: [
    { date: '2024-03-20', profit: 0 },
    { date: '2024-03-21', profit: 0 },
    { date: '2024-03-22', profit: 0 },
    { date: '2024-03-23', profit: 0 },
    { date: '2024-03-24', profit: 0 },
    { date: '2024-03-25', profit: 0 },
  ],
  tokenPerformance: [
    { name: 'Raydium', profit: 0, trades: 0, successRate: 0 },
    { name: 'Jupiter', profit: 0, trades: 0, successRate: 0 },
  ],
  tradingStats: {
    totalProfit: 0,
    totalTrades: 0,
    successRate: 0,
    avgProfitTrade: 0,
    profitableTrades: 0,
    buyTrades: 0,
    sellTrades: 0,
  }
};

const StatCard: React.FC<{
  title: string;
  value: string | number;
  icon: React.ReactNode;
  trend?: number;
  prefix?: string;
  suffix?: string;
}> = ({ title, value, icon, trend, prefix = '', suffix = '' }) => (
  <div className="glass p-2 sm:p-4 rounded-xl hover-card transition-all duration-300">
    <div className="flex items-center justify-between mb-1 sm:mb-2">
      <div className="p-1 sm:p-2 rounded-lg bg-primary/10">
        {icon}
      </div>
      {trend !== undefined && (
        <div className={cn(
          "flex items-center text-xs sm:text-sm font-medium",
          trend >= 0 ? "text-green-500" : "text-red-500"
        )}>
          {/* trend is a ±direction flag, not a percentage — the old code rendered
              it as a literal "1%" which was meaningless */}
          {trend >= 0 ? <ArrowUpRight className="w-3 h-3 sm:w-4 sm:h-4" /> : <ArrowDownRight className="w-3 h-3 sm:w-4 sm:h-4" />}
        </div>
      )}
    </div>
    <div className="text-lg sm:text-2xl font-bold mb-0.5 sm:mb-1">
      {prefix}{value}{suffix}
    </div>
    <div className="text-xs sm:text-sm text-muted-foreground">{title}</div>
  </div>
);

const TokenPerformanceCard: React.FC<{
  token: typeof mockData.tokenPerformance[0];
}> = ({ token }) => (
  <div className="glass p-2 sm:p-4 rounded-xl hover-card transition-all duration-300">
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 mb-2 sm:mb-4">
      <div className="font-semibold text-base sm:text-lg truncate min-w-0">{token.name}</div>
      <div className={cn(
        "text-xs sm:text-sm font-medium whitespace-nowrap tabular-nums ml-auto",
        token.profit >= 0 ? "text-green-500" : "text-red-500"
      )}>
        {token.profit >= 0 ? "+" : ""}{Number(token.profit).toFixed(6)} SOL
      </div>
    </div>
    <div className="space-y-1 sm:space-y-2">
      <div className="flex justify-between text-xs sm:text-sm">
        <span className="text-muted-foreground">Trades</span>
        <span>{token.trades}</span>
      </div>
      <div className="flex justify-between text-xs sm:text-sm">
        <span className="text-muted-foreground">Success Rate</span>
        <span>{token.successRate}%</span>
      </div>
      <div className="w-full bg-primary/10 rounded-full h-1.5 sm:h-2 mt-1 sm:mt-2">
        <div
          className="bg-gradient-to-r from-primary to-primary/50 h-1.5 sm:h-2 rounded-full transition-all duration-300"
          style={{ width: `${token.successRate}%` }}
        />
      </div>
    </div>
  </div>
);

const Analytics: React.FC = () => {
  // 🚨 SECURITY: Check authentication first
  const isAuthenticated = useIsAuthenticated();
  const { sessionToken } = useAuth();

  // State for real-time stats
  const [stats, setStats] = useState<TradingStats | null>(null);
  const [profitHistory, setProfitHistory] = useState<DailyProfit[]>([]);
  const [tokenPerformance, setTokenPerformance] = useState<TokenPerformance[]>([]);
  const [tradingResults, setTradingResults] = useState<ApiTradingResultsResponse['bestResults'] & ApiTradingResultsResponse['worstResults'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [perfError, setPerfError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // §4.4: date-range selector — 7d / 30d / all-time
  const [dateRange, setDateRange] = useState<'7d' | '30d' | 'all'>('all');
  const rangeQuery = React.useMemo(() => {
    if (dateRange === 'all') return '';
    const days = dateRange === '7d' ? 7 : 30;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return `?from=${from}`;
  }, [dateRange]);

  // Fetch stats from our blockchain-verified endpoint
  const fetchStats = async () => {
    try {
      setLoading(true);
      setError(null);

      // P1 fix: include Authorization header so server middleware accepts the request.
      const response = await fetch(`/api/dashboard/stats${rangeQuery}`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch stats: ${response.statusText}`);
      }

      const data: ApiStatsResponse = await response.json();
      if (!data.success) {
        throw new Error('API returned error');
      }

      setStats(data.stats);
      setLastUpdated(data.meta.lastUpdated);
      console.log('📊 Stats loaded:', data.stats);
    } catch (err) {
      console.error('❌ Error fetching stats:', err);
      setError(err instanceof Error ? err.message : 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  };

  // Fetch profit history from our blockchain-verified endpoint
  const fetchProfitHistory = async () => {
    try {
      console.log('📈 Fetching profit history...');

      const response = await fetch(`/api/dashboard/profit-history${rangeQuery}`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch profit history: ${response.statusText}`);
      }

      const data: ApiProfitHistoryResponse = await response.json();
      if (!data.success) {
        throw new Error('Profit history API returned error');
      }

      // Transform the data to include profit field for chart compatibility
      const transformedHistory = data.profitHistory.map(day => ({
        date: day.date,
        profit: day.cumulativeProfit || 0, // Use cumulative profit for the chart
        dailyProfit: day.profit || 0,
        cumulativeProfit: day.cumulativeProfit || 0,
        trades: day.trades || 0
      }));

      setProfitHistory(transformedHistory);
      console.log('📈 Profit history loaded:', transformedHistory.length, 'days');
    } catch (err) {
      console.error('❌ Error fetching profit history:', err);
      // Don't set error state for profit history, just use empty array
      setProfitHistory([]);
    }
  };

  // Fetch token performance from our blockchain-verified endpoint
  const fetchTokenPerformance = async () => {
    try {
      console.log('🏆 Fetching token performance...');

      const response = await fetch(`/api/dashboard/token-performance${rangeQuery}`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch token performance: ${response.statusText}`);
      }

      const data: ApiTokenPerformanceResponse = await response.json();
      if (!data.success) {
        throw new Error('Token performance API returned error');
      }

      // §4.2: render whatever DEXes the data actually contains (launchlab, pumpswap, …)
      // instead of a hardcoded list that silently dropped trades from other venues.
      const transformedPerformance: TokenPerformance[] = (data.dexPerformance || [])
        .map(dexData => ({
          name: dexDisplayName(dexData.dexName),
          profit: dexData.totalProfit || 0,
          trades: dexData.totalTrades || 0,
          successRate: dexData.successRate || 0
        }))
        .filter(p => p.trades > 0)
        .sort((a, b) => b.trades - a.trades);

      setTokenPerformance(transformedPerformance);
      setPerfError(null);
      console.log('🏆 Token performance loaded:', transformedPerformance);
    } catch (err) {
      console.error('❌ Error fetching token performance:', err);
      // §4.1: NO mock fallback — show a real error state with retry instead of fake numbers
      setTokenPerformance([]);
      setPerfError(err instanceof Error ? err.message : 'Failed to load DEX performance');
    }
  };

  // Fetch trading results from our blockchain-verified endpoint
  const fetchTradingResults = async () => {
    try {
      console.log('📊 Fetching trading results...');

      const response = await fetch(`/api/dashboard/trading-results${rangeQuery}`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch trading results: ${response.statusText}`);
      }

      const data: ApiTradingResultsResponse = await response.json();
      if (!data.success) {
        throw new Error('Trading results API returned error');
      }

      // Combine best and worst results
      const combinedResults = {
        ...data.bestResults,
        ...data.worstResults
      };

      setTradingResults(combinedResults);
      console.log('📊 Trading results loaded:', combinedResults);
    } catch (err) {
      console.error('❌ Error fetching trading results:', err);
      // Set to null on error
      setTradingResults(null);
    }
  };

  // Load data on component mount
  useEffect(() => {
    if (isAuthenticated) {
      // Fetch all data in parallel
      Promise.all([
        fetchStats(),
        fetchProfitHistory(),
        fetchTokenPerformance(),
        fetchTradingResults()
      ]);
    }
  }, [isAuthenticated, rangeQuery]);

  // Refresh all analytics data at once
  const handleRefreshAll = () => {
    Promise.all([
      fetchStats(),
      fetchProfitHistory(),
      fetchTokenPerformance(),
      fetchTradingResults()
    ]);
  };

  // 🚨 SECURITY: Check authentication BEFORE rendering sensitive data
  if (!isAuthenticated) {
    return <UnauthenticatedAnalytics />;
  }

  // Loading state
  if (loading && !stats) {
    return (
      <div className="flex-1 p-2 sm:p-4 md:p-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-center min-h-[60vh]">
            <div className="flex items-center space-x-2">
              <RefreshCw className="w-6 h-6 animate-spin text-primary" />
              <span className="text-lg">Loading blockchain-verified analytics...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex-1 p-2 sm:p-4 md:p-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
            <AlertTriangle className="w-12 h-12 text-red-500 mb-4" />
            <h2 className="text-xl font-bold mb-2">Failed to Load Analytics</h2>
            <p className="text-muted-foreground mb-4">{error}</p>
            <button
              onClick={handleRefreshAll}
              className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-2 sm:p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-4 sm:mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold gradient-text">Analytics Dashboard</h1>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">Track your trading performance and statistics</p>
            </div>
            <div className="flex items-center space-x-2">
              {/* §4.4: date-range selector */}
              <div className="flex items-center rounded-lg bg-secondary p-0.5">
                {(['7d', '30d', 'all'] as const).map(r => (
                  <button
                    key={r}
                    onClick={() => setDateRange(r)}
                    className={cn(
                      'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                      dateRange === r ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {r === 'all' ? 'All' : r}
                  </button>
                ))}
              </div>
              {lastUpdated && (
                <span className="text-xs text-muted-foreground">
                  Updated: {new Date(lastUpdated).toLocaleTimeString()}
                </span>
              )}
              <button
                onClick={handleRefreshAll}
                disabled={loading}
                className="p-2 rounded-lg bg-primary/10 hover:bg-primary/20 transition-colors disabled:opacity-50"
                title="Refresh all analytics data"
              >
                <RefreshCw className={cn("w-4 h-4 text-primary", loading && "animate-spin")} />
              </button>
            </div>
          </div>
        </div>

        {/* Phase 1: Top Row Metrics - Now with real blockchain-verified data */}
        <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4 mb-4 sm:mb-6">
          <StatCard
            title="Total Profit"
            value={stats?.totalProfit.toFixed(6) || '0.000000'}
            icon={<Wallet className="w-4 h-4 sm:w-5 sm:h-5 text-primary" />}
            suffix=" SOL"
            trend={(stats?.totalProfit ?? 0) > 0 ? 1 : (stats?.totalProfit ?? 0) < 0 ? -1 : undefined}
          />
          <StatCard
            title="Total Trades"
            value={stats?.totalTrades || 0}
            icon={<TrendingUp className="w-4 h-4 sm:w-5 sm:h-5 text-primary" />}
          />
          <StatCard
            title="Success Rate"
            value={stats?.successRate.toFixed(1) || '0.0'}
            icon={<Zap className="w-4 h-4 sm:w-5 sm:h-5 text-primary" />}
            suffix="%"
            trend={(stats?.successRate ?? 0) > 50 ? 1 : (stats?.successRate ?? 0) < 50 ? -1 : undefined}
          />
          <StatCard
            title="Avg. Profit/Trade"
            value={stats?.avgProfitTrade.toFixed(6) || '0.000000'}
            icon={<Clock className="w-4 h-4 sm:w-5 sm:h-5 text-primary" />}
            suffix=" SOL"
            trend={(stats?.avgProfitTrade ?? 0) > 0 ? 1 : (stats?.avgProfitTrade ?? 0) < 0 ? -1 : undefined}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-6 mb-4 sm:mb-6">
          <div className="lg:col-span-2 glass p-2 sm:p-4 rounded-xl">
            <div className="flex items-center justify-between mb-2 sm:mb-4">
              <h2 className="text-base sm:text-lg font-semibold">Profit History (Cumulative)</h2>
              <div className="text-xs text-muted-foreground">
                {profitHistory.length > 0 ? `${profitHistory.length} days` : 'No data'}
              </div>
            </div>
            <div className="h-[200px] sm:h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={profitHistory}>
                  <defs>
                    <linearGradient id="profitGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgb(14, 165, 233)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="rgb(14, 165, 233)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis
                    dataKey="date"
                    stroke="rgba(255,255,255,0.5)"
                    tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 10 }}
                    tickFormatter={(value) => {
                      // Format date to show only MM/DD for better readability
                      const date = new Date(value);
                      return `${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
                    }}
                  />
                  <YAxis
                    stroke="rgba(255,255,255,0.5)"
                    tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 10 }}
                    tickFormatter={(value) => `${value.toFixed(4)} SOL`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'rgba(0,0,0,0.8)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '8px',
                      fontSize: '12px'
                    }}
                    labelFormatter={(value) => `Date: ${value}`}
                    formatter={(value: any, name: string) => [
                      `${Number(value).toFixed(6)} SOL`,
                      'Cumulative Profit'
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="profit"
                    stroke="rgb(14, 165, 233)"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#profitGradient)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="glass p-2 sm:p-4 rounded-xl">
            <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-4">DEX Performance</h2>
            <div className="space-y-2 sm:space-y-4">
              {perfError ? (
                /* §4.1: real error state with retry — never fake numbers */
                <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-center">
                  <AlertTriangle className="w-5 h-5 text-red-400 mx-auto mb-2" />
                  <p className="text-sm text-red-300 mb-3">{perfError}</p>
                  <button
                    onClick={fetchTokenPerformance}
                    className="px-3 py-1.5 text-xs rounded-lg bg-secondary hover:bg-secondary/80 transition-colors"
                  >
                    Retry
                  </button>
                </div>
              ) : tokenPerformance.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No trades recorded yet.</p>
              ) : (
                tokenPerformance.map((token, index) => (
                  <TokenPerformanceCard key={index} token={token} />
                ))
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-6">
          <div className="glass p-3 sm:p-6 rounded-xl">
            <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-4">Best Trading Results</h2>
            <div className="space-y-2 sm:space-y-4">
              <div className="flex justify-between items-center">
                <div className="flex items-center">
                  <div className="p-1 sm:p-2 rounded-lg bg-green-500/10 mr-2 sm:mr-3">
                    <ArrowUpRight className="w-3 h-3 sm:w-4 sm:h-4 text-green-500" />
                  </div>
                  <div>
                    <div className="text-xs sm:text-sm">Best Trade</div>
                    <div className="font-semibold text-sm sm:text-base">
                      {tradingResults?.bestTrade
                        ? `${tradingResults.bestTrade.profit >= 0 ? '+' : ''}${tradingResults.bestTrade.profit.toFixed(6)} SOL`
                        : '—'
                      }
                    </div>
                  </div>
                </div>
                <div className="text-xs sm:text-sm text-muted-foreground">
                  {tradingResults?.bestTrade ? tradingResults.bestTrade.tokenSymbol : '-'}
                </div>
              </div>

              <div className="flex justify-between items-center">
                <div className="flex items-center">
                  <div className="p-1 sm:p-2 rounded-lg bg-green-500/10 mr-2 sm:mr-3">
                    <ArrowUpRight className="w-3 h-3 sm:w-4 sm:h-4 text-green-500" />
                  </div>
                  <div>
                    <div className="text-xs sm:text-sm">Best Win Streak</div>
                    <div className="font-semibold text-sm sm:text-base">
                      {tradingResults?.longestWinStreak || 0} trades
                    </div>
                  </div>
                </div>
                <div className="text-xs sm:text-sm text-muted-foreground">Consecutive</div>
              </div>

              <div className="flex justify-between items-center">
                <div className="flex items-center">
                  <div className="p-1 sm:p-2 rounded-lg bg-green-500/10 mr-2 sm:mr-3">
                    <ArrowUpRight className="w-3 h-3 sm:w-4 sm:h-4 text-green-500" />
                  </div>
                  <div>
                    <div className="text-xs sm:text-sm">Best Day</div>
                    <div className="font-semibold text-sm sm:text-base">
                      {tradingResults?.bestTradingDay
                        ? `${tradingResults.bestTradingDay.totalProfit >= 0 ? '+' : ''}${tradingResults.bestTradingDay.totalProfit.toFixed(6)} SOL`
                        : '—'
                      }
                    </div>
                  </div>
                </div>
                <div className="text-xs sm:text-sm text-muted-foreground">
                  {tradingResults?.bestTradingDay ? tradingResults.bestTradingDay.date : '-'}
                </div>
              </div>
            </div>
          </div>

          <div className="glass p-3 sm:p-6 rounded-xl">
            <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-4">Worst Trading Results</h2>
            <div className="space-y-2 sm:space-y-4">
              <div className="flex justify-between items-center">
                <div className="flex items-center">
                  <div className="p-1 sm:p-2 rounded-lg bg-red-500/10 mr-2 sm:mr-3">
                    <ArrowDownRight className="w-3 h-3 sm:w-4 sm:h-4 text-red-500" />
                  </div>
                  <div>
                    <div className="text-xs sm:text-sm">Worst Trade</div>
                    <div className="font-semibold text-sm sm:text-base">
                      {tradingResults?.worstTrade
                        ? `${tradingResults.worstTrade.profit.toFixed(6)} SOL`
                        : '0 SOL'
                      }
                    </div>
                  </div>
                </div>
                <div className="text-xs sm:text-sm text-muted-foreground">
                  {tradingResults?.worstTrade ? tradingResults.worstTrade.tokenSymbol : '-'}
                </div>
              </div>

              <div className="flex justify-between items-center">
                <div className="flex items-center">
                  <div className="p-1 sm:p-2 rounded-lg bg-red-500/10 mr-2 sm:mr-3">
                    <ArrowDownRight className="w-3 h-3 sm:w-4 sm:h-4 text-red-500" />
                  </div>
                  <div>
                    <div className="text-xs sm:text-sm">Worst Loss Streak</div>
                    <div className="font-semibold text-sm sm:text-base">
                      {tradingResults?.longestLossStreak || 0} trades
                    </div>
                  </div>
                </div>
                <div className="text-xs sm:text-sm text-muted-foreground">Consecutive</div>
              </div>

              <div className="flex justify-between items-center">
                <div className="flex items-center">
                  <div className="p-1 sm:p-2 rounded-lg bg-red-500/10 mr-2 sm:mr-3">
                    <ArrowDownRight className="w-3 h-3 sm:w-4 sm:h-4 text-red-500" />
                  </div>
                  <div>
                    <div className="text-xs sm:text-sm">Worst Day</div>
                    <div className="font-semibold text-sm sm:text-base">
                      {tradingResults?.worstTradingDay
                        ? `${tradingResults.worstTradingDay.totalProfit.toFixed(6)} SOL`
                        : '0 SOL'
                      }
                    </div>
                  </div>
                </div>
                <div className="text-xs sm:text-sm text-muted-foreground">
                  {tradingResults?.worstTradingDay ? tradingResults.worstTradingDay.date : '-'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Analytics;