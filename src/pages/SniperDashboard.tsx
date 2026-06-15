/**
 * Sniper Dashboard - Main control panel for automatic token sniping
 * 
 * Features:
 * - Real-time token feed from PumpFun, LaunchLab, and Raydium
 * - Auto-snipe settings configuration
 * - Active snipes monitoring
 * - Quick buy/sell actions
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
    Zap,
    Settings,
    TrendingUp,
    Shield,
    Clock,
    DollarSign,
    Activity,
    AlertTriangle,
    CheckCircle,
    XCircle,
    RefreshCw,
    Play,
    Pause,
    Filter,
    Search,
    ExternalLink
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { FitText } from '../components/FitText';

// Types
interface SnipeSettings {
    id?: string;
    name: string;
    isActive: boolean;
    walletId?: string;  // selected wallet for trading

    // Buy settings
    buyAmountSol: number;
    slippageBps: number;
    useJito: boolean;
    jitoTipLamports: number;

    // Filters
    minLiquidityUsd: number;
    maxLiquidityUsd: number;
    maxTokenAgeSec: number;
    minMarketCapUsd?: number;
    maxMarketCapUsd?: number;


    // DEX selection
    enableRaydium: boolean;
    enablePumpfun: boolean;
    enableLaunchlab: boolean;
    preBondedOnly: boolean;

    // Anti-scam
    checkMintAuthority: boolean;
    checkFreezeAuthority: boolean;
    maxHolderConcentration: number;

    // Social filters
    requireTwitter: boolean;
    requireTelegram: boolean;
    requireWebsite: boolean;

    // Momentum auto-buy
    momentumEnabled?: boolean;
    minChange5m?: number | null;
    minChange1h?: number | null;
    minChange24h?: number | null;
    maxChange5m?: number | null;
    maxChange1h?: number | null;
    maxChange24h?: number | null;
    minTokenAgeSec?: number | null;
    momentumCooldownSec?: number;
    momentumMaxPositions?: number;

    // Auto-sell
    autoSellEnabled?: boolean;
    takeProfitPercent?: number | null;
    stopLossPercent?: number | null;
    trailingStopPercent?: number | null;
    maxHoldSec?: number | null;
}

interface DetectedToken {
    id: string;
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    dex: 'raydium' | 'pumpfun' | 'launchlab';

    // Market data
    liquiditySol?: number;
    liquidityUsd?: number;
    marketCapSol?: number;
    marketCapUsd?: number;
    price?: number;

    // Volume windows (from DexScreener enrichment, null if not listed yet)
    volume24h?: number | null;       // DexScreener h24 volume (shown as a column)
    priceChange5m?: number | null;   // DexScreener priceChange m5/h1/h24 (%)
    priceChange1h?: number | null;
    priceChange24h?: number | null;

    // Status
    isPreBonded?: boolean;
    bondingProgress?: number;

    // Safety
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    warnings: string[];

    // Social
    hasTwitter: boolean;
    hasTelegram: boolean;
    hasWebsite: boolean;

    // Timestamps
    detectedAt: Date;
    createdAt?: Date;
}

interface ActiveSnipe {
    id: string;
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    status: 'pending' | 'executing' | 'success' | 'failed';
    buyAmountSol: number;
    tokensReceived?: number;
    txSignature?: string;
    failureReason?: string;
    latencyMs?: number;
    detectedAt: Date;
    executedAt?: Date;
}

const DEFAULT_SETTINGS: SnipeSettings = {
    name: 'Default',
    isActive: false,
    buyAmountSol: 0.001,
    slippageBps: 100,         // 1%
    useJito: true,
    jitoTipLamports: 50000,
    minLiquidityUsd: 0,       // no minimum
    maxLiquidityUsd: 35000,   // treated as USD: $35,000 max
    maxTokenAgeSec: 172800,   // 48 hours
    minMarketCapUsd: 0,
    maxMarketCapUsd: 0,

    enableRaydium: false,
    enablePumpfun: true,
    enableLaunchlab: false,
    preBondedOnly: true,
    checkMintAuthority: false,
    checkFreezeAuthority: false,
    maxHolderConcentration: 30,
    requireTwitter: false,
    requireTelegram: false,
    requireWebsite: false,
};

const SniperDashboard: React.FC = () => {
    // State
    const [settings, setSettings] = useState<SnipeSettings>(DEFAULT_SETTINGS);
    const [detectedTokens, setDetectedTokens] = useState<DetectedToken[]>([]);
    // §8.4: persist UI prefs (sort, age unit, DEX tab) across restarts
    const [sortBy, setSortBy] = useState<'newest' | 'liquidity' | 'change5m' | 'change1h' | 'change24h'>(
        () => (localStorage.getItem('sniper:sortBy') as any) || 'newest');
    const [ageUnit, setAgeUnit] = useState<'minutes' | 'hours'>(
        () => (localStorage.getItem('sniper:ageUnit') as any) || 'minutes');
    useEffect(() => { localStorage.setItem('sniper:sortBy', sortBy); }, [sortBy]);
    useEffect(() => { localStorage.setItem('sniper:ageUnit', ageUnit); }, [ageUnit]);
    const [sortLoading, setSortLoading] = useState(false);
    // Ref so that the 5s polling interval always reads the CURRENT sort without stale closure
    const sortByRef = React.useRef<typeof sortBy>('newest');
    useEffect(() => { sortByRef.current = sortBy; }, [sortBy]);
    // Ref for settings — same reason (interval captures stale closure)
    const settingsRef = React.useRef(settings);
    useEffect(() => { settingsRef.current = settings; }, [settings]);
    const [activeSnipes, setActiveSnipes] = useState<ActiveSnipe[]>([]);
    const [isConnected, setIsConnected] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [showSettings, setShowSettings] = useState(false);
    const [displayCount, setDisplayCount] = useState(10); // pagination: show 10 at a time

    const [searchTerm, setSearchTerm] = useState('');
    const [selectedDex, setSelectedDex] = useState<'all' | 'raydium' | 'pumpfun' | 'launchlab'>(
        () => (localStorage.getItem('sniper:selectedDex') as any) || 'all');
    useEffect(() => { localStorage.setItem('sniper:selectedDex', selectedDex); }, [selectedDex]);
    const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
    const [snipeMessage, setSnipeMessage] = useState<{ type: 'success' | 'error'; text: string; sig?: string } | null>(null);

    // Auth — declared before any effects that depend on sessionToken
    const { sessionToken } = useAuth();
    const authHeader: Record<string, string> = sessionToken ? { 'Authorization': `Bearer ${sessionToken}` } : {};

    // Managed wallets for the selector
    const [managedWallets, setManagedWallets] = useState<Array<{ id: string; name: string; publicKey: string; wallet_type?: string }>>([]);

    const loadWallets = async () => {
        try {
            const res = await fetch('/api/wallets/secure', { headers: authHeader });
            if (res.ok) {
                const data = await res.json();
                // Only show wallets that have a private key (not profile-readonly)
                const tradeable = (data.wallets || []).filter((w: any) => w.wallet_type !== 'profile-readonly');
                setManagedWallets(tradeable);
            }
        } catch (e) {
            console.error('Failed to load wallets for selector:', e);
        }
    };
    // Load tokens on mount (no auth required)
    useEffect(() => {
        loadDetectedTokens();
        const pollInterval = setInterval(() => {
            loadDetectedTokens();
        }, 5000);
        return () => clearInterval(pollInterval);
    }, []);

    // Separate effect: open WS + load settings once we have a session token
    useEffect(() => {
        if (!sessionToken) return; // Wait for auth
        loadSettings(); // Load settings with auth now that token is ready
        loadWallets();  // Load wallets for the selector
        const ws = setupWebSocket();
        return () => {
            ws?.close();
        };
    }, [sessionToken]);

    const setupWebSocket = useCallback(() => {
        try {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws${sessionToken ? `?token=${encodeURIComponent(sessionToken)}` : ''}`;
            const ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                console.log('🔌 Sniper WebSocket connected');
                setIsConnected(true);
                ws.send(JSON.stringify({ type: 'subscribe_sniper' }));
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'new_token') handleNewToken(data.token);
                    else if (data.type === 'snipe_update') handleSnipeUpdate(data.snipe);
                } catch (error) {
                    console.error('Error parsing WebSocket message:', error);
                }
            };

            ws.onclose = () => {
                console.log('🔌 Sniper WebSocket disconnected');
                setIsConnected(false);
            };

            return ws;
        } catch (error) {
            console.error('WebSocket setup error:', error);
            return null;
        }
    }, [sessionToken]); // sessionToken in deps so WS reconnects with fresh token

    const handleNewToken = (token: DetectedToken) => {
        setDetectedTokens(prev => {
            // Add new token at the beginning, cap the in-memory list
            const updated = [token, ...prev.filter(t => t.tokenAddress !== token.tokenAddress)];
            return updated.slice(0, 600);
        });
        setLastUpdate(new Date());
    };


    // Reset pagination when filters change
    useEffect(() => {
        setDisplayCount(10);
    }, [selectedDex, settings.enablePumpfun, settings.enableLaunchlab, settings.enableRaydium,
        settings.preBondedOnly, settings.maxTokenAgeSec, settings.minLiquidityUsd,
        settings.maxLiquidityUsd, settings.minMarketCapUsd, settings.maxMarketCapUsd, searchTerm]);

    const handleSnipeUpdate = (snipe: ActiveSnipe) => {
        setActiveSnipes(prev => {
            const existing = prev.findIndex(s => s.id === snipe.id);
            if (existing >= 0) {
                const updated = [...prev];
                updated[existing] = snipe;
                return updated;
            }
            return [snipe, ...prev];
        });
    };

    // (sessionToken and authHeader already declared above)


    const loadSettings = async () => {
        try {
            const response = await fetch('/api/sniper/settings', { headers: authHeader });
            if (response.ok) {
                const data = await response.json();
                if (data.settings) {
                    setSettings(data.settings);
                }
            }
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    };

    const loadDetectedTokens = async (overrideSortBy?: typeof sortBy) => {
        const activeSortBy = overrideSortBy ?? sortByRef.current; // use ref to avoid stale closure in interval
        // Only reset pagination when user explicitly triggers a sort/refresh, not on background poll
        const isUserAction = overrideSortBy !== undefined;
        try {
            // §7.4: spinner only on user-triggered loads — background polls update silently
            if (isUserAction) setIsLoading(true);
            if (activeSortBy.startsWith('change')) setSortLoading(true);
            // §7.1: always fetch the FULL feed (one server cache key); preBondedOnly and
            // all other display filters are applied client-side below — toggles are instant
            const params = new URLSearchParams({ limit: '500' });
            if (activeSortBy.startsWith('change')) params.set('sortBy', activeSortBy);
            const response = await fetch(`/api/sniper/tokens?${params}`, { headers: authHeader });
            if (response.ok) {
                const data = await response.json();
                if (data.tokens) {
                    // Deduplicate by tokenAddress before setting state
                    const seen = new Set<string>();
                    const unique = (data.tokens as DetectedToken[]).filter(t => {
                        if (!t.tokenAddress || seen.has(t.tokenAddress)) return false;
                        seen.add(t.tokenAddress);
                        return true;
                    });
                    setDetectedTokens(unique);
                    setLastUpdate(new Date());
                    if (isUserAction) setDisplayCount(10); // only reset pagination on user-triggered loads
                }
            }
        } catch (error) {
            console.error('Error loading tokens:', error);
        } finally {
            setIsLoading(false);
            setSortLoading(false);
        }
    };


    const saveSettings = async () => {
        try {
            const response = await fetch('/api/sniper/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeader },
                body: JSON.stringify(settings),
            });

            const data = await response.json();
            if (response.ok && data.success) {
                // Update settings.id from DB record so future saves upsert correctly
                if (data.settings?.id) {
                    setSettings(prev => ({ ...prev, id: data.settings.id }));
                }
                setShowSettings(false);
            } else {
                // Surface the error — users need to know if save failed
                const msg = data.error || `Save failed (HTTP ${response.status})`;
                console.error('Settings save failed:', msg);
                alert(`❌ Settings not saved: ${msg}`);
            }
        } catch (error) {
            console.error('Error saving settings:', error);
            alert(`❌ Settings not saved: network error`);
        }
    };

    const toggleAutoSnipe = async () => {
        const newSettings = { ...settings, isActive: !settings.isActive };
        setSettings(newSettings);

        try {
            await fetch('/api/sniper/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeader },
                body: JSON.stringify({ isActive: newSettings.isActive }),
            });
        } catch (error) {
            console.error('Error toggling auto-snipe:', error);
            setSettings(settings); // Revert on error
        }
    };

    const executeSnipe = async (token: DetectedToken) => {
        try {
            const response = await fetch('/api/sniper/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeader },
                body: JSON.stringify({
                    tokenAddress: token.tokenAddress,
                    buyAmountSol: settings.buyAmountSol,
                    slippageBps: settings.slippageBps,
                    useJito: settings.useJito,
                    ...(settings.walletId ? { walletId: settings.walletId } : {}),
                }),
            });

            const data = await response.json();
            if (response.ok && data.success) {
                const shortSig = data.signature ? data.signature.slice(0, 8) + '...' : '';
                setSnipeMessage({ type: 'success', text: `✅ Snipe submitted! ${shortSig}`, sig: data.signature });
                console.log('🎯 Snipe executed:', data);
            } else {
                // Detect common on-chain errors and show clean messages
                const raw = data.error || '';
                let friendlyMsg = raw;
                if (raw.includes('0x1772') || raw.includes('TooMuchSolRequired') || raw.includes('slippage')) {
                    friendlyMsg = 'Slippage exceeded — price moved too fast. Try increasing slippage %.';
                } else if (raw.includes('0x1788') || raw.includes('Overflow')) {
                    friendlyMsg = 'On-chain overflow — token amount too large for bonding curve.';
                } else if (raw.includes('0x1') || raw.includes('InsufficientFunds') || raw.includes('insufficient')) {
                    friendlyMsg = 'Insufficient SOL balance for this trade.';
                } else if (raw.includes('blockhash') || raw.includes('expired')) {
                    friendlyMsg = 'Transaction expired — network congestion. Try again.';
                } else if (raw.length > 120) {
                    friendlyMsg = raw.slice(0, 100) + '…'; // truncate unknown long errors
                }
                setSnipeMessage({ type: 'error', text: `❌ ${friendlyMsg}` });
                console.error('Snipe failed:', data);
            }
            // Auto-clear after 8 seconds
            setTimeout(() => setSnipeMessage(null), 8000);
        } catch (error) {
            console.error('Error executing snipe:', error);
            setSnipeMessage({ type: 'error', text: `❌ Network error — check connection.` });
            setTimeout(() => setSnipeMessage(null), 8000);
        }
    };

    // §7.5: debounce search input so filtering doesn't recompute per keystroke
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(searchTerm), 200);
        return () => clearTimeout(t);
    }, [searchTerm]);

    // Filter tokens (memoized — §7.5)
    const filteredTokens = React.useMemo(() => detectedTokens.filter(token => {
        // DEX tab filter
        if (selectedDex !== 'all' && token.dex !== selectedDex) return false;

        // DEX settings toggles
        if (token.dex === 'pumpfun' && !settings.enablePumpfun) return false;
        if (token.dex === 'launchlab' && !settings.enableLaunchlab) return false;
        if (token.dex === 'raydium' && !settings.enableRaydium) return false;

        // Pre-bonded filter
        if (settings.preBondedOnly && !token.isPreBonded) return false;

        // Max token age filter (uses createdAt which is the real launch time)
        if (settings.maxTokenAgeSec > 0) {
            const ref = token.createdAt ?? token.detectedAt;
            if (ref) {
                const ageSec = (Date.now() - new Date(ref).getTime()) / 1000;
                if (ageSec > settings.maxTokenAgeSec) return false;
            }
        }

        // Liquidity filter — use USD value from server. If null (SOL price unavailable), skip filter for this token.
        const liqForFilter = (typeof token.liquidityUsd === 'number' && !isNaN(token.liquidityUsd))
            ? token.liquidityUsd
            : undefined; // don't guess — skip filtering if price unavailable
        if (typeof liqForFilter === 'number') {
            if (settings.minLiquidityUsd > 0 && liqForFilter < settings.minLiquidityUsd) return false;
            if (settings.maxLiquidityUsd > 0 && liqForFilter > settings.maxLiquidityUsd) return false;
        }

        // Market cap USD filter — MUST come before search return to always apply
        if (typeof token.marketCapUsd === 'number') {
            if (settings.minMarketCapUsd && settings.minMarketCapUsd > 0 && token.marketCapUsd < settings.minMarketCapUsd) return false;
            if (settings.maxMarketCapUsd && settings.maxMarketCapUsd > 0 && token.marketCapUsd > settings.maxMarketCapUsd) return false;
        }

        // Text search (must be last — returns true on match, skipping nothing)
        if (debouncedSearch) {
            const s = debouncedSearch.toLowerCase();
            return (
                token.tokenName.toLowerCase().includes(s) ||
                token.tokenSymbol.toLowerCase().includes(s) ||
                token.tokenAddress.toLowerCase().includes(s)
            );
        }

        return true;
    }), [detectedTokens, selectedDex, settings, debouncedSearch]);


    // Client-side sort (memoized — §7.5)
    const sortedTokens = React.useMemo(() => [...filteredTokens].sort((a, b) => {
        switch (sortBy) {
            case 'liquidity':
                return (b.liquidityUsd ?? b.liquiditySol ?? 0) - (a.liquidityUsd ?? a.liquiditySol ?? 0);
            case 'change5m':
                return (b.priceChange5m ?? -Infinity) - (a.priceChange5m ?? -Infinity);
            case 'change1h':
                return (b.priceChange1h ?? -Infinity) - (a.priceChange1h ?? -Infinity);
            case 'change24h':
                return (b.priceChange24h ?? -Infinity) - (a.priceChange24h ?? -Infinity);
            default: // newest
                return new Date(b.createdAt ?? b.detectedAt).getTime() - new Date(a.createdAt ?? a.detectedAt).getTime();
        }
    }), [filteredTokens, sortBy]);

    const fmtVol = (v?: number | null) => {
        if (v == null) return '—';
        if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
        if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
        return `$${v.toFixed(0)}`;
    };


    const formatTime = (date: Date) => {
        const diff = Date.now() - new Date(date).getTime();
        const seconds = Math.floor(diff / 1000);
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ago`;
    };

    const getRiskColor = (risk: string) => {
        switch (risk) {
            case 'low': return 'text-green-400 bg-green-500/10';
            case 'medium': return 'text-yellow-400 bg-yellow-500/10';
            case 'high': return 'text-orange-400 bg-orange-500/10';
            case 'critical': return 'text-red-400 bg-red-500/10';
            default: return 'text-muted-foreground bg-gray-500/10';
        }
    };

    const getDexBadge = (dex: string) => {
        switch (dex) {
            case 'raydium': return 'bg-purple-500/20 text-purple-400';
            case 'pumpfun': return 'bg-pink-500/20 text-pink-400';
            case 'launchlab': return 'bg-blue-500/20 text-blue-400';
            default: return 'bg-gray-500/20 text-muted-foreground';
        }
    };

    // Returns the canonical platform URL for a token based on its DEX
    const getTokenUrl = (dex: string, tokenAddress: string): string => {
        switch (dex) {
            case 'pumpfun':
                return `https://pump.fun/coin/${tokenAddress}`;
            case 'launchlab':
                // LaunchLab is Raydium's launchpad — token pages live under /launchpad/token/?mint=
                return `https://raydium.io/launchpad/token/?mint=${tokenAddress}`;
            case 'raydium':
                return `https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenAddress}`;
            default:
                return `https://dexscreener.com/solana/${tokenAddress}`;
        }
    };

    const getTokenUrlLabel = (dex: string): string => {
        switch (dex) {
            case 'pumpfun': return 'View on Pump.fun';
            case 'launchlab': return 'View on LaunchLab';
            case 'raydium': return 'View on Raydium';
            default: return 'View on DexScreener';
        }
    };

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center space-x-4">
                    {/* Page title lives in SniperPage (merged page, audit §2) */}
                    <div className={`flex items-center space-x-2 px-3 py-1 rounded-full ${isConnected ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
                        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
                        <span className={`text-sm ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
                            {isConnected ? 'Live' : 'Disconnected'}
                        </span>
                    </div>
                </div>

                {/* Snipe result toast */}
                {snipeMessage && (
                    <div className={`flex items-center justify-between px-4 py-2 rounded-lg text-sm font-medium ${snipeMessage.type === 'success' ? 'bg-green-500/20 text-green-300 border border-green-500/30' : 'bg-red-500/20 text-red-300 border border-red-500/30'
                        }`}>
                        <span>{snipeMessage.text}</span>
                        {snipeMessage.sig && (
                            <a href={`https://solscan.io/tx/${snipeMessage.sig}`} target="_blank" rel="noopener noreferrer"
                                className="ml-3 underline text-xs opacity-80 hover:opacity-100">Solscan ↗</a>
                        )}
                        <button onClick={() => setSnipeMessage(null)} className="ml-3 opacity-60 hover:opacity-100">✕</button>
                    </div>
                )}

                <div className="flex items-center space-x-4">
                    <button
                        onClick={() => loadDetectedTokens()}
                        className="p-2 glass hover:bg-secondary rounded-lg transition-colors"
                        title="Refresh"
                    >
                        <RefreshCw className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`} />
                    </button>

                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className="flex items-center space-x-2 px-4 py-2 glass hover:bg-secondary rounded-lg transition-colors"
                    >
                        <Settings className="w-5 h-5" />
                        {/* "Sniper Filters", not "Settings" — avoids clash with global /settings (audit §8.2) */}
                        <span>Sniper Filters</span>
                    </button>

                    <button
                        onClick={toggleAutoSnipe}
                        className={`flex items-center space-x-2 px-6 py-2 rounded-lg font-medium transition-all ${settings.isActive
                            ? 'bg-green-600 hover:bg-green-700 text-foreground'
                            : 'bg-secondary hover:bg-secondary/80 text-foreground/80'
                            }`}
                    >
                        {settings.isActive ? (
                            <>
                                <Pause className="w-5 h-5" />
                                <span>Stop Sniper</span>
                            </>
                        ) : (
                            <>
                                <Play className="w-5 h-5" />
                                <span>Start Sniper</span>
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="glass rounded-xl p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <p className="text-muted-foreground text-sm"><FitText max={14} min={10}>Tokens Detected</FitText></p>
                            <p className="font-bold"><FitText max={24} min={12} className="tabular-nums">{filteredTokens.length}</FitText></p>
                            {detectedTokens.length !== filteredTokens.length && (
                                <p className="text-xs text-muted-foreground mt-0.5 truncate">{detectedTokens.length} total</p>
                            )}
                        </div>
                        <Activity className="w-8 h-8 text-blue-400 shrink-0" />
                    </div>
                </div>


                <div className="glass rounded-xl p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <p className="text-muted-foreground text-sm"><FitText max={14} min={10}>Active Snipes</FitText></p>
                            <p className="font-bold"><FitText max={24} min={12} className="tabular-nums">{activeSnipes.filter(s => s.status === 'executing').length}</FitText></p>
                        </div>
                        <Zap className="w-8 h-8 text-yellow-400 shrink-0" />
                    </div>
                </div>

                <div className="glass rounded-xl p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <p className="text-muted-foreground text-sm"><FitText max={14} min={10}>Successful</FitText></p>
                            <p className="font-bold text-green-400"><FitText max={24} min={12} className="tabular-nums">{activeSnipes.filter(s => s.status === 'success').length}</FitText></p>
                        </div>
                        <CheckCircle className="w-8 h-8 text-green-400 shrink-0" />
                    </div>
                </div>

                <div className="glass rounded-xl p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <p className="text-muted-foreground text-sm"><FitText max={14} min={10}>Buy Amount</FitText></p>
                            <p className="font-bold"><FitText max={24} min={12} className="tabular-nums">{settings.buyAmountSol} SOL</FitText></p>
                        </div>
                        <DollarSign className="w-8 h-8 text-purple-400 shrink-0" />
                    </div>
                </div>
            </div>

            {/* Settings Panel (Collapsible) */}
            {showSettings && (
                <div className="glass rounded-xl p-6 mb-6">
                    <h2 className="text-xl font-bold mb-4 flex items-center space-x-2">
                        <Settings className="w-5 h-5" />
                        <span>Snipe Settings</span>
                    </h2>

                    {/* 2-col: [Buy + DEX] | [Filters] */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                        {/* ── LEFT COLUMN ── Buy Settings + DEX & Safety */}
                        <div className="space-y-6">
                            {/* Buy Settings */}
                            <div className="space-y-3">
                                <h3 className="font-medium text-foreground/80 border-b border-border pb-2">Buy Settings</h3>

                                {/* Wallet selector */}
                                <div>
                                    <label className="block text-sm text-muted-foreground mb-1">Trading Wallet</label>
                                    <select
                                        value={settings.walletId || ''}
                                        onChange={(e) => setSettings({ ...settings, walletId: e.target.value || undefined })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm"
                                    >
                                        <option value="">— Select a wallet —</option>
                                        {managedWallets.map(w => (
                                            <option key={w.id} value={w.id}>
                                                {w.name} ({w.publicKey.slice(0, 6)}…{w.publicKey.slice(-4)})
                                            </option>
                                        ))}
                                    </select>
                                    {managedWallets.length === 0 && (
                                        <p className="text-xs text-yellow-400 mt-1">No wallets with private keys found. Import one in Wallet Manager.</p>
                                    )}
                                </div>

                                <div>
                                    <label className="block text-sm text-muted-foreground mb-1">Buy Amount (SOL)</label>
                                    <input
                                        type="number"
                                        value={settings.buyAmountSol}
                                        onChange={(e) => setSettings({ ...settings, buyAmountSol: parseFloat(e.target.value) || 0 })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground"
                                        step="0.01" min="0.01"
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm text-muted-foreground mb-1">Slippage (%)</label>
                                    <input
                                        type="number"
                                        value={settings.slippageBps / 100}
                                        onChange={(e) => setSettings({ ...settings, slippageBps: (parseFloat(e.target.value) || 0) * 100 })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground"
                                        step="0.5" min="0.5" max="50"
                                    />
                                </div>

                                <div className="flex items-center justify-between py-1">
                                    <label className="text-sm text-muted-foreground">Use Jito (MEV Protection)</label>
                                    <button
                                        onClick={() => setSettings({ ...settings, useJito: !settings.useJito })}
                                        className={`w-12 h-6 rounded-full transition-colors flex-shrink-0 ${settings.useJito ? 'bg-green-500' : 'bg-muted'}`}
                                    >
                                        <div className={`w-5 h-5 rounded-full bg-white transition-transform mx-0.5 ${settings.useJito ? 'translate-x-6' : 'translate-x-0'}`} />
                                    </button>
                                </div>
                            </div>

                            {/* DEX & Safety */}
                            <div className="space-y-3">
                                <h3 className="font-medium text-foreground/80 border-b border-border pb-2">DEX & Safety</h3>

                                {(['Raydium', 'PumpFun', 'LaunchLab'] as const).map((label) => {
                                    const key = label === 'PumpFun' ? 'enablePumpfun' : label === 'Raydium' ? 'enableRaydium' : 'enableLaunchlab';
                                    return (
                                        <div key={key} className="flex items-center justify-between py-1">
                                            <label className="text-sm text-muted-foreground">{label}</label>
                                            <button
                                                onClick={() => setSettings({ ...settings, [key]: !(settings as any)[key] })}
                                                className={`w-12 h-6 rounded-full transition-colors flex-shrink-0 ${(settings as any)[key] ? 'bg-green-500' : 'bg-muted'}`}
                                            >
                                                <div className={`w-5 h-5 rounded-full bg-white transition-transform mx-0.5 ${(settings as any)[key] ? 'translate-x-6' : 'translate-x-0'}`} />
                                            </button>
                                        </div>
                                    );
                                })}

                                <div className="pt-2 border-t border-border space-y-2">
                                    {([
                                        ['checkMintAuthority', 'Check Mint Authority'],
                                        ['checkFreezeAuthority', 'Check Freeze Authority'],
                                    ] as const).map(([key, label]) => (
                                        <div key={key} className="flex items-center justify-between py-1">
                                            <label className="text-sm text-muted-foreground flex items-center gap-1.5">
                                                <Shield className="w-3.5 h-3.5 flex-shrink-0" />
                                                {label}
                                            </label>
                                            <button
                                                onClick={() => setSettings({ ...settings, [key]: !settings[key] })}
                                                className={`w-12 h-6 rounded-full transition-colors flex-shrink-0 ${settings[key] ? 'bg-green-500' : 'bg-muted'}`}
                                            >
                                                <div className={`w-5 h-5 rounded-full bg-white transition-transform mx-0.5 ${settings[key] ? 'translate-x-6' : 'translate-x-0'}`} />
                                            </button>
                                        </div>
                                    ))}
                                </div>

                                {/* Required socials — token must have these in its metadata to be sniped.
                                    (Instagram isn't part of pump.fun/LaunchLab token metadata.) */}
                                <div className="pt-2 border-t border-border space-y-2">
                                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Required Socials</p>
                                    {([
                                        ['requireTwitter', '𝕏 (Twitter)'],
                                        ['requireTelegram', 'Telegram'],
                                        ['requireWebsite', 'Website'],
                                    ] as const).map(([key, label]) => (
                                        <div key={key} className="flex items-center justify-between py-1">
                                            <label className="text-sm text-muted-foreground">{label}</label>
                                            <button
                                                onClick={() => setSettings({ ...settings, [key]: !settings[key] })}
                                                className={`w-12 h-6 rounded-full transition-colors flex-shrink-0 ${settings[key] ? 'bg-green-500' : 'bg-muted'}`}
                                            >
                                                <div className={`w-5 h-5 rounded-full bg-white transition-transform mx-0.5 ${settings[key] ? 'translate-x-6' : 'translate-x-0'}`} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* ── RIGHT COLUMN ── Filters */}
                        <div className="space-y-4">
                            <h3 className="font-medium text-foreground/80 border-b border-border pb-2">Filters</h3>

                            {/* Liquidity */}
                            <div className="space-y-3">
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Liquidity (USD)</p>
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-xs text-muted-foreground mb-1">Min</label>
                                        <input
                                            type="number" min="0"
                                            value={settings.minLiquidityUsd}
                                            onChange={(e) => setSettings({ ...settings, minLiquidityUsd: parseFloat(e.target.value) || 0 })}
                                            className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm"
                                            placeholder="0"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-muted-foreground mb-1">Max</label>
                                        <input
                                            type="number" min="0"
                                            value={settings.maxLiquidityUsd}
                                            onChange={(e) => setSettings({ ...settings, maxLiquidityUsd: parseFloat(e.target.value) || 0 })}
                                            className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm"
                                            placeholder="0 = no limit"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Token Age */}
                            <div className="space-y-1">
                                <label className="block text-sm text-muted-foreground">Max Token Age</label>
                                <div className="flex gap-2">
                                    <input
                                        type="number" min="1"
                                        value={ageUnit === 'hours'
                                            ? Math.round(settings.maxTokenAgeSec / 3600)
                                            : Math.round(settings.maxTokenAgeSec / 60)}
                                        onChange={(e) => {
                                            const val = parseInt(e.target.value) || 1;
                                            setSettings({ ...settings, maxTokenAgeSec: ageUnit === 'hours' ? val * 3600 : val * 60 });
                                        }}
                                        className="flex-1 bg-secondary rounded-lg px-3 py-2 text-foreground text-sm"
                                    />
                                    <select
                                        className="bg-secondary rounded-lg px-3 py-2 text-foreground text-sm"
                                        value={ageUnit}
                                        onChange={(e) => {
                                            const unit = e.target.value as 'minutes' | 'hours';
                                            // Convert current seconds to the new unit display
                                            setAgeUnit(unit);
                                        }}
                                    >
                                        <option value="minutes">minutes</option>
                                        <option value="hours">hours</option>
                                    </select>
                                </div>
                                <p className="text-xs text-muted-foreground">{settings.maxTokenAgeSec}s internally</p>
                            </div>

                            {/* Market Cap */}
                            <div className="space-y-3">
                                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Market Cap (USD)</p>
                                <div className="grid grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-xs text-muted-foreground mb-1">Min</label>
                                        <input
                                            type="number" min="0"
                                            value={settings.minMarketCapUsd || 0}
                                            onChange={(e) => setSettings({ ...settings, minMarketCapUsd: parseFloat(e.target.value) || 0 })}
                                            className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm"
                                            placeholder="0"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs text-muted-foreground mb-1">Max</label>
                                        <input
                                            type="number" min="0"
                                            value={settings.maxMarketCapUsd || 0}
                                            onChange={(e) => setSettings({ ...settings, maxMarketCapUsd: parseFloat(e.target.value) || 0 })}
                                            className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm"
                                            placeholder="0 = no limit"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Pre-bonded */}
                            <div className="flex items-center justify-between py-1 border-t border-border pt-3">
                                <label className="text-sm text-muted-foreground">Pre-Bonded Only (PumpFun)</label>
                                <button
                                    onClick={() => setSettings({ ...settings, preBondedOnly: !settings.preBondedOnly })}
                                    className={`w-12 h-6 rounded-full transition-colors flex-shrink-0 ${settings.preBondedOnly ? 'bg-green-500' : 'bg-muted'}`}
                                >
                                    <div className={`w-5 h-5 rounded-full bg-white transition-transform mx-0.5 ${settings.preBondedOnly ? 'translate-x-6' : 'translate-x-0'}`} />
                                </button>
                            </div>
                        </div>
                    </div>


                    {/* ── Momentum Auto-Buy ───────────────────────────────────────── */}
                    <div className="mt-6 border border-border rounded-lg p-4 bg-secondary/40">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="font-medium text-foreground">🤖 Momentum Auto-Buy</h3>
                                <p className="text-xs text-muted-foreground mt-0.5">Auto-buys tracked tokens whose price-change % crosses your thresholds. Trades real funds — start small.</p>
                            </div>
                            <button
                                onClick={() => setSettings({ ...settings, momentumEnabled: !settings.momentumEnabled })}
                                className={`w-12 h-6 rounded-full transition-colors flex-shrink-0 ${settings.momentumEnabled ? 'bg-green-500' : 'bg-muted'}`}
                            >
                                <div className={`w-5 h-5 rounded-full bg-white transition-transform mx-0.5 ${settings.momentumEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
                            </button>
                        </div>

                        {settings.momentumEnabled && (
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4">
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Min 5m change %</label>
                                    <input type="number" value={settings.minChange5m ?? ''} placeholder="ignore"
                                        onChange={(e) => setSettings({ ...settings, minChange5m: e.target.value === '' ? null : parseFloat(e.target.value) })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Min 1h change %</label>
                                    <input type="number" value={settings.minChange1h ?? ''} placeholder="ignore"
                                        onChange={(e) => setSettings({ ...settings, minChange1h: e.target.value === '' ? null : parseFloat(e.target.value) })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Min 24h change %</label>
                                    <input type="number" value={settings.minChange24h ?? ''} placeholder="ignore"
                                        onChange={(e) => setSettings({ ...settings, minChange24h: e.target.value === '' ? null : parseFloat(e.target.value) })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                {/* Max bounds (2026-06-12): min+max form a RANGE per timeframe —
                                    gains-only (min>0), avoid over-pumped tops (max set), or
                                    dip-buys (both negative, e.g. min -60 / max -20) */}
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Max 5m change %</label>
                                    <input type="number" value={(settings as any).maxChange5m ?? ''} placeholder="ignore"
                                        onChange={(e) => setSettings({ ...settings, maxChange5m: e.target.value === '' ? null : parseFloat(e.target.value) } as any)}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Max 1h change %</label>
                                    <input type="number" value={(settings as any).maxChange1h ?? ''} placeholder="ignore"
                                        onChange={(e) => setSettings({ ...settings, maxChange1h: e.target.value === '' ? null : parseFloat(e.target.value) } as any)}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Max 24h change %</label>
                                    <input type="number" value={(settings as any).maxChange24h ?? ''} placeholder="ignore"
                                        onChange={(e) => setSettings({ ...settings, maxChange24h: e.target.value === '' ? null : parseFloat(e.target.value) } as any)}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Min token age (sec)</label>
                                    <input type="number" value={settings.minTokenAgeSec ?? ''} placeholder="0"
                                        onChange={(e) => setSettings({ ...settings, minTokenAgeSec: e.target.value === '' ? null : parseInt(e.target.value) })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Re-buy cooldown (sec)</label>
                                    <input type="number" value={settings.momentumCooldownSec ?? 300}
                                        onChange={(e) => setSettings({ ...settings, momentumCooldownSec: parseInt(e.target.value) || 300 })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Max open positions</label>
                                    <input type="number" value={settings.momentumMaxPositions ?? 5}
                                        onChange={(e) => setSettings({ ...settings, momentumMaxPositions: parseInt(e.target.value) || 5 })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div className="col-span-2 md:col-span-3 text-[11px] text-muted-foreground">
                                    Buy amount ({settings.buyAmountSol} SOL), slippage, market-cap, max-age, and social filters above also apply.
                                    Min + Max form a range per timeframe: gains-only (Min 25), skip over-pumped tops (Max 300), or buy dips (Min −60, Max −20). Blank = ignore.
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ── Auto-Sell ───────────────────────────────────────────────── */}
                    <div className="mt-4 border border-border rounded-lg p-4 bg-secondary/40">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="font-medium text-foreground">💰 Auto-Sell</h3>
                                <p className="text-xs text-muted-foreground mt-0.5">Sells 100% of a position when any trigger below fires. Applies to all your open positions.</p>
                            </div>
                            <button
                                onClick={() => setSettings({ ...settings, autoSellEnabled: !settings.autoSellEnabled })}
                                className={`w-12 h-6 rounded-full transition-colors flex-shrink-0 ${settings.autoSellEnabled ? 'bg-green-500' : 'bg-muted'}`}
                            >
                                <div className={`w-5 h-5 rounded-full bg-white transition-transform mx-0.5 ${settings.autoSellEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
                            </button>
                        </div>

                        {settings.autoSellEnabled && (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Take-profit %</label>
                                    <input type="number" value={settings.takeProfitPercent ?? ''} placeholder="off"
                                        onChange={(e) => setSettings({ ...settings, takeProfitPercent: e.target.value === '' ? null : parseFloat(e.target.value) })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Stop-loss %</label>
                                    <input type="number" value={settings.stopLossPercent ?? ''} placeholder="off"
                                        onChange={(e) => setSettings({ ...settings, stopLossPercent: e.target.value === '' ? null : parseFloat(e.target.value) })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Trailing stop %</label>
                                    <input type="number" value={settings.trailingStopPercent ?? ''} placeholder="off"
                                        onChange={(e) => setSettings({ ...settings, trailingStopPercent: e.target.value === '' ? null : parseFloat(e.target.value) })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div>
                                    <label className="block text-xs text-muted-foreground mb-1">Max hold (sec)</label>
                                    <input type="number" value={settings.maxHoldSec ?? ''} placeholder="off"
                                        onChange={(e) => setSettings({ ...settings, maxHoldSec: e.target.value === '' ? null : parseInt(e.target.value) })}
                                        className="w-full bg-secondary rounded-lg px-3 py-2 text-foreground text-sm" />
                                </div>
                                <div className="col-span-2 md:col-span-4 text-[11px] text-muted-foreground">
                                    Leave a field blank to disable that trigger. Whichever fires first sells the position.
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="flex justify-end mt-6 space-x-4">
                        <button
                            onClick={() => setShowSettings(false)}
                            className="px-4 py-2 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={saveSettings}
                            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
                        >
                            Save Settings
                        </button>
                    </div>
                </div>
            )}

            {/* Filters Bar */}
            <div className="flex items-center space-x-4 mb-4">
                <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                        type="text"
                        placeholder="Search tokens..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 glass rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                </div>

                <div className="flex items-center space-x-2">
                    <Filter className="w-4 h-4 text-muted-foreground" />
                    {['all', 'raydium', 'pumpfun', 'launchlab'].map((dex) => (
                        <button
                            key={dex}
                            onClick={() => setSelectedDex(dex as any)}
                            className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors ${selectedDex === dex
                                ? 'bg-blue-600 text-foreground'
                                : 'bg-secondary text-muted-foreground hover:bg-secondary'
                                }`}
                        >
                            {dex.charAt(0).toUpperCase() + dex.slice(1)}
                        </button>
                    ))}
                </div>

                {/* Active filter badges */}
                {(settings.preBondedOnly || settings.minLiquidityUsd > 0 || (settings.maxLiquidityUsd > 0 && settings.maxLiquidityUsd < 9999)) && (
                    <div className="flex items-center gap-1 flex-wrap">
                        {settings.preBondedOnly && (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-pink-500/20 text-pink-400 border border-pink-500/30">
                                Pre-Bonded Only
                            </span>
                        )}
                        {settings.minLiquidityUsd > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30">
                                Liq ≥ ${settings.minLiquidityUsd.toLocaleString()}
                            </span>
                        )}
                        {settings.maxLiquidityUsd > 0 && settings.maxLiquidityUsd < 9999999 && (
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30">
                                Liq ≤ ${settings.maxLiquidityUsd.toLocaleString()}
                            </span>
                        )}

                    </div>
                )}

                <span className="text-sm text-muted-foreground">
                    Updated {formatTime(lastUpdate)}
                </span>
            </div>

            {/* Token Feed Table */}
            <div className="glass rounded-xl overflow-hidden">
                {/* Sort Bar */}
                <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-secondary/60">
                    <span className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold">Sort:</span>
                    {(
                        [['newest', '🕐 Newest'], ['liquidity', '💧 Liquidity'], ['change5m', '⚡ 5m %'], ['change1h', '🔥 1h %'], ['change24h', '📊 24h %']] as const
                    ).map(([key, label]) => (
                        <button
                            key={key}
                            onClick={() => {
                                // Re-sort instantly client-side — every poll already includes
                                // priceChange5m/1h/24h, so switching tabs needs no refetch.
                                // The 5s background poll refreshes data (incl. volume) for the
                                // new sort via sortByRef, so don't block the UI on a fetch here.
                                setSortBy(key);
                                setDisplayCount(10);
                            }}
                            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${sortBy === key
                                ? 'bg-blue-600 text-foreground'
                                : 'bg-secondary text-muted-foreground hover:bg-muted hover:text-foreground'
                                } ${sortLoading && key === sortBy ? 'opacity-60 cursor-wait' : ''}`}
                        >
                            {sortLoading && key === sortBy ? '⏳' : label}
                        </button>
                    ))}
                    {sortBy.startsWith('change') && (
                        <span className="ml-auto text-[10px] text-muted-foreground">Price change % + vol from DexScreener / Raydium API · tokens with no trades show —</span>
                    )}
                </div>

                {/* Header — always 12 cols; Token shrinks col-span-3 when vol column present */}
                <div className="grid grid-cols-12 gap-2 px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider border-b border-border">
                    <div className={sortBy.startsWith('change') ? 'col-span-3' : 'col-span-4'}>Token</div>
                    <div className="col-span-2">DEX</div>
                    <div className="col-span-2">Liquidity / MC</div>
                    <div className="col-span-2">Risk</div>
                    <div className="col-span-1">Age</div>
                    <div className="col-span-1">Act.</div>
                    {sortBy.startsWith('change') && (
                        <div className="col-span-1 text-blue-400">{sortBy === 'change5m' ? '5m % / Vol' : sortBy === 'change24h' ? '24h % / Vol' : '1h % / Vol'}</div>
                    )}
                </div>

                <div className="max-h-[calc(100vh-420px)] min-h-[300px] overflow-y-auto">
                    {sortedTokens.length === 0 ? (
                        <div className="p-8 text-center text-muted-foreground">
                            <Activity className="w-12 h-12 mx-auto mb-4 opacity-50" />
                            <p>No tokens detected yet</p>
                            <p className="text-sm mt-2">Waiting for new token launches...</p>
                        </div>
                    ) : (
                        <>
                            {sortedTokens.slice(0, displayCount).map((token) => (
                                <div
                                    key={token.tokenAddress || token.id}
                                    className="grid grid-cols-12 gap-2 px-4 py-3 border-b border-border/60 hover:bg-secondary/40 transition-colors items-center"
                                >
                                    {/* Token Info */}
                                    <div className={`${sortBy.startsWith('change') ? 'col-span-3' : 'col-span-4'} min-w-0 overflow-hidden`}>
                                        <div className="flex items-center gap-2">
                                            <div className="w-8 h-8 flex-shrink-0 rounded-full bg-muted flex items-center justify-center text-xs font-bold">
                                                {(token.tokenSymbol || '??').slice(0, 2).toUpperCase()}
                                            </div>
                                            <div className="min-w-0">
                                                <p className="font-semibold text-sm truncate">{token.tokenSymbol}</p>
                                                <p className="text-xs text-muted-foreground truncate">{token.tokenName}</p>
                                                {(token.hasTwitter || token.hasTelegram || token.hasWebsite) && (
                                                    <div className="flex items-center gap-1 mt-0.5">
                                                        {token.hasTwitter && <span className="text-[9px] px-1 rounded bg-sky-500/20 text-sky-300">X</span>}
                                                        {token.hasTelegram && <span className="text-[9px] px-1 rounded bg-blue-500/20 text-blue-300">TG</span>}
                                                        {token.hasWebsite && <span className="text-[9px] px-1 rounded bg-gray-500/20 text-foreground/80">web</span>}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* DEX */}
                                    <div className="col-span-2 min-w-0 overflow-hidden flex flex-col gap-1 items-start">
                                        <span className={`px-1.5 py-0.5 rounded text-xs font-semibold whitespace-nowrap ${getDexBadge(token.dex)}`}>
                                            {token.dex.toUpperCase()}
                                        </span>
                                        {token.isPreBonded && (
                                            <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-amber-500/20 text-amber-400 whitespace-nowrap">
                                                Bonding
                                            </span>
                                        )}
                                    </div>

                                    {/* Liquidity + Market Cap */}
                                    <div className="col-span-2 min-w-0 overflow-hidden">
                                        <p className="font-semibold text-sm">
                                            {token.liquidityUsd != null
                                                ? `$${token.liquidityUsd >= 1000 ? `${(token.liquidityUsd / 1000).toFixed(1)}K` : token.liquidityUsd.toLocaleString()}`
                                                : (token as any).solPriceError
                                                    ? <span className="text-red-400 text-xs" title={(token as any).solPriceError}>⚠ No price</span>
                                                    : token.liquiditySol != null
                                                        ? `${token.liquiditySol.toFixed(1)} SOL`
                                                        : '—'}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {token.marketCapUsd
                                                ? `MC $${token.marketCapUsd >= 1000 ? `${(token.marketCapUsd / 1000).toFixed(1)}K` : token.marketCapUsd.toFixed(0)}`
                                                : token.marketCapSol
                                                    ? `MC ${token.marketCapSol.toFixed(1)} SOL`
                                                    : ''}
                                        </p>
                                    </div>

                                    {/* Risk */}
                                    <div className="col-span-2 min-w-0 overflow-hidden">
                                        <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${getRiskColor(token.riskLevel)}`}>
                                            {token.riskLevel.toUpperCase()}
                                        </span>
                                        {token.warnings.length > 0 && (
                                            <div className="flex items-center mt-1 text-xs text-yellow-400">
                                                <AlertTriangle className="w-3 h-3 mr-1 flex-shrink-0" />
                                                <span className="truncate">{token.warnings.length} warn</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Age */}
                                    <div className="col-span-1 text-xs text-muted-foreground whitespace-nowrap">
                                        {formatTime(token.createdAt ?? token.detectedAt)}
                                    </div>

                                    {/* Actions — always shown */}
                                    <div className="col-span-1 flex items-center gap-1">
                                        <button
                                            onClick={() => executeSnipe(token)}
                                            disabled={token.riskLevel === 'critical'}
                                            className="p-1.5 bg-green-600 hover:bg-green-700 disabled:bg-muted disabled:cursor-not-allowed rounded font-medium transition-colors flex items-center justify-center"
                                            title="Snipe"
                                        >
                                            <Zap className="w-4 h-4" />
                                        </button>
                                        <button
                                            onClick={() => window.open(getTokenUrl(token.dex, token.tokenAddress), '_blank')}
                                            className="p-1.5 bg-secondary hover:bg-secondary/80 rounded transition-colors"
                                            title={getTokenUrlLabel(token.dex)}
                                        >
                                            <ExternalLink className="w-4 h-4" />
                                        </button>
                                    </div>

                                    {/* Price-change % (sort metric) + 24h volume — only when a change sort is active */}
                                    {sortBy.startsWith('change') && (() => {
                                        const pct = sortBy === 'change5m' ? token.priceChange5m
                                            : sortBy === 'change24h' ? token.priceChange24h
                                                : token.priceChange1h;
                                        const pctColor = pct == null ? 'text-muted-foreground' : pct >= 0 ? 'text-green-400' : 'text-red-400';
                                        const pctText = pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
                                        return (
                                            <div className="col-span-1 leading-tight">
                                                <div className={`text-xs font-mono font-semibold ${pctColor}`}>{pctText}</div>
                                                <div className="text-[10px] font-mono text-muted-foreground">{token.volume24h != null ? fmtVol(token.volume24h) : '—'}</div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            ))}
                            {/* Load More button */}
                            {displayCount < sortedTokens.length && (
                                <div className="p-4 text-center border-t border-border">
                                    <p className="text-xs text-muted-foreground mb-2">
                                        Showing {Math.min(displayCount, sortedTokens.length)} of {sortedTokens.length} tokens
                                    </p>
                                    <button
                                        onClick={() => setDisplayCount(prev => prev + 10)}
                                        className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-foreground rounded-lg text-sm font-medium transition-colors"
                                    >
                                        Load 10 More
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* Active Snipes */}
            {
                activeSnipes.length > 0 && (
                    <div className="mt-6">
                        <h2 className="text-xl font-bold mb-4">Active Snipes</h2>
                        <div className="glass rounded-xl overflow-hidden">
                            {activeSnipes.map((snipe) => (
                                <div
                                    key={snipe.id}
                                    className="flex items-center justify-between p-4 border-b border-border"
                                >
                                    <div className="flex items-center space-x-4">
                                        <div className={`w-3 h-3 rounded-full ${snipe.status === 'success' ? 'bg-green-400' :
                                            snipe.status === 'failed' ? 'bg-red-400' :
                                                snipe.status === 'executing' ? 'bg-yellow-400 animate-pulse' :
                                                    'bg-muted-foreground'
                                            }`} />
                                        <div>
                                            <p className="font-medium">{snipe.tokenSymbol}</p>
                                            <p className="text-sm text-muted-foreground">{snipe.buyAmountSol} SOL</p>
                                        </div>
                                    </div>

                                    <div className="text-right">
                                        <p className={`font-medium ${snipe.status === 'success' ? 'text-green-400' :
                                            snipe.status === 'failed' ? 'text-red-400' :
                                                'text-muted-foreground'
                                            }`}>
                                            {snipe.status.charAt(0).toUpperCase() + snipe.status.slice(1)}
                                        </p>
                                        {snipe.latencyMs && (
                                            <p className="text-sm text-muted-foreground">{snipe.latencyMs}ms</p>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )
            }
        </div >
    );
};

export default SniperDashboard;
