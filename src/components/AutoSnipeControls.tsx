import React, { useState, useEffect, useCallback } from 'react';
import { Switch } from './ui/switch';
import { Input } from './ui/input';
import { Button } from './ui/button';
import {
  Zap,
  Settings,
  RefreshCw,
  TrendingUp,
  Shield,
  AlertTriangle,
  Clock,
  DollarSign,
  Layers,
  CheckCircle,
  XCircle,
  ExternalLink
} from 'lucide-react';
import toast from '../lib/toast-shim';
import { useAuth } from '../contexts/AuthContext';
import { useManagedWallets } from '../hooks/useManagedWallets';

// Types for auto-snipe settings
interface SnipeSettings {
  buyAmountSol: number;
  slippageBps: number;
  minLiquidityUsd: number;
  maxLiquidityUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  maxTokenAgeSec: number;
  momentumMaxPositions: number; // shared open-position cap (auto-snipe + momentum)
  enablePumpfun: boolean;
  enableRaydium: boolean;
  enableLaunchlab: boolean;
  checkMintAuthority: boolean;
  checkFreezeAuthority: boolean;
}

interface LiveToken {
  mint: string;
  symbol: string;
  name: string;
  liquiditySol: number;
  marketCapSol: number;
  ageSec: number;
  source: string;
  createdAt: string;
}

interface AutoSnipeStatus {
  enabled: boolean;
  settings: SnipeSettings;
  lastTriggered?: string;
  tokensSniped?: number;
}

const defaultSettings: SnipeSettings = {
  buyAmountSol: 0.1,
  slippageBps: 500, // 5%
  minLiquidityUsd: 1000,
  maxLiquidityUsd: 35000,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 1000,
  maxTokenAgeSec: 300, // 5 minutes
  momentumMaxPositions: 5,
  enablePumpfun: true,
  enableRaydium: true,
  enableLaunchlab: false,
  checkMintAuthority: true,
  checkFreezeAuthority: true,
};

const AutoSnipeControls: React.FC = () => {
  const { sessionToken } = useAuth();
  const { wallets } = useManagedWallets();

  // State
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [settings, setSettings] = useState<SnipeSettings>(defaultSettings);
  const [liveTokens, setLiveTokens] = useState<LiveToken[]>([]);
  const [isLoadingTokens, setIsLoadingTokens] = useState(false);
  const [tokensError, setTokensError] = useState<string | null>(null);

  const activeWallet = wallets.find(w => w.isActive) ?? wallets[0] ?? null;

  // Fetch current auto-snipe status on mount
  useEffect(() => {
    fetchAutoSnipeStatus();
  }, []);

  // Fetch live tokens periodically
  useEffect(() => {
    fetchLiveTokens();
    const interval = setInterval(fetchLiveTokens, 5000);
    return () => clearInterval(interval);
  }, []);

  // Fetch auto-snipe status from backend
  const fetchAutoSnipeStatus = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/sniper/auto-snipe/status', {
        headers: sessionToken ? { 'Authorization': `Bearer ${sessionToken}` } : {},
      });
      if (response.ok) {
        const data: AutoSnipeStatus = await response.json();
        setIsEnabled(data.enabled);
        if (data.settings) {
          setSettings(data.settings);
        }
      }
    } catch (error) {
      console.error('Failed to fetch auto-snipe status:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Toggle auto-snipe on/off — requires an active managed wallet
  const handleToggle = async (checked: boolean) => {
    if (checked && !activeWallet) {
      toast.error('⚠️ Add a managed wallet first before enabling Auto-Snipe');
      return;
    }
    const previousState = isEnabled;
    setIsLoading(true);
    setIsEnabled(checked); // Optimistic update
    try {
      const response = await fetch('/api/sniper/auto-snipe/toggle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionToken ? { 'Authorization': `Bearer ${sessionToken}` } : {}),
        },
        body: JSON.stringify({ enabled: checked }),
      });

      if (response.ok) {
        toast.success(checked ? '🎯 Auto-Snipe ENABLED' : '🛑 Auto-Snipe DISABLED');
      } else {
        const error = await response.json();
        setIsEnabled(previousState); // Revert on failure
        toast.error(error.message || 'Failed to toggle auto-snipe');
      }
    } catch (error) {
      console.error('Failed to toggle auto-snipe:', error);
      setIsEnabled(previousState); // Revert on failure
      toast.error('Failed to toggle auto-snipe');
    } finally {
      setIsLoading(false);
    }
  };

  // Save settings
  const handleSaveSettings = async () => {
    // Form validation
    if (settings.buyAmountSol <= 0) {
      toast.error('Buy amount must be greater than 0');
      return;
    }
    if (settings.minLiquidityUsd > settings.maxLiquidityUsd) {
      toast.error('Min liquidity cannot exceed max');
      return;
    }
    if (settings.minMarketCapUsd > settings.maxMarketCapUsd) {
      toast.error('Min market cap cannot exceed max market cap');
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch('/api/sniper/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionToken ? { 'Authorization': `Bearer ${sessionToken}` } : {}),
        },
        body: JSON.stringify(settings),
      });

      if (response.ok) {
        toast.success('✅ Settings saved successfully');
      } else {
        const error = await response.json();
        toast.error(error.message || 'Failed to save settings');
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  // Fetch live filtered tokens
  const fetchLiveTokens = async () => {
    setIsLoadingTokens(true);
    setTokensError(null);
    try {
      const response = await fetch('/api/tokens/live?limit=5');
      if (response.ok) {
        const data = await response.json();
        setLiveTokens(data.tokens || []);
      }
    } catch (error) {
      console.error('Failed to fetch live tokens:', error);
      setTokensError('Failed to load live tokens');
      toast.error('Failed to fetch live tokens');
    } finally {
      setIsLoadingTokens(false);
    }
  };

  // Update a single setting
  const updateSetting = <K extends keyof SnipeSettings>(
    key: K,
    value: SnipeSettings[K]
  ) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  // Format token age
  const formatAge = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  };

  return (
    <div className="space-y-6">
      {/* Screen reader announcement for toggle state */}
      <div aria-live="polite" className="sr-only">
        Auto-snipe is {isEnabled ? 'enabled' : 'disabled'}
      </div>

      {/* Auto-Snipe Toggle Section */}
      <div className="glass p-6 rounded-xl border border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${isEnabled
              ? 'bg-green-500/20 animate-pulse'
              : 'bg-gray-500/20'
              }`}>
              <Zap className={`w-6 h-6 ${isEnabled ? 'text-green-500' : 'text-gray-400'}`} />
            </div>
            <div>
              <h2 className="text-xl font-bold flex items-center gap-2">
                Auto-Snipe
                {isEnabled && (
                  <span className="text-xs px-2 py-1 bg-green-500/20 text-green-400 rounded-full animate-pulse">
                    ACTIVE
                  </span>
                )}
              </h2>
              <p className="text-sm text-muted-foreground">
                Automatically snipe tokens matching your criteria
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {isLoading && (
              <RefreshCw className="w-4 h-4 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={isEnabled}
              onCheckedChange={handleToggle}
              disabled={isLoading}
              className="data-[state=checked]:bg-green-500"
            />
          </div>
        </div>

        {/* Warning when enabled */}
        {isEnabled && (
          <div className="mt-4 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
            <div className="flex items-center gap-2 text-yellow-500 text-sm">
              <AlertTriangle className="w-4 h-4" />
              <span>Auto-snipe is active. Tokens matching your criteria will be bought automatically.</span>
            </div>
          </div>
        )}
      </div>

      {/* Settings Panel */}
      <div className="glass p-6 rounded-xl border border-border">
        <div className="flex items-center gap-2 mb-6">
          <Settings className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-semibold">Snipe Settings</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Trading Parameters */}
          <div className="space-y-4">
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <DollarSign className="w-4 h-4" />
              Trading Parameters
            </h4>

            <div className="space-y-3">
              <div>
                <label htmlFor="buyAmountSol" className="text-sm font-medium mb-1 block">Buy Amount (SOL)</label>
                <Input
                  id="buyAmountSol"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={settings.buyAmountSol}
                  onChange={(e) => updateSetting('buyAmountSol', parseFloat(e.target.value) || 0)}
                  className="bg-background/50"
                />
              </div>

              <div>
                <label htmlFor="slippageBps" className="text-sm font-medium mb-1 block">Slippage (%)</label>
                <Input
                  id="slippageBps"
                  type="number"
                  step="0.1"
                  min="1"
                  max="100"
                  value={(settings.slippageBps / 100).toFixed(1)}
                  onChange={(e) => updateSetting('slippageBps', Math.round(parseFloat(e.target.value) * 100) || 500)}
                  className="bg-background/50"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {settings.slippageBps / 100}% slippage tolerance
                </p>
              </div>
            </div>
          </div>

          {/* Liquidity Filters */}
          <div className="space-y-4">
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              Liquidity Filters
            </h4>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="minLiquidityUsd" className="text-sm font-medium mb-1 block">Min (USD)</label>
                <Input
                  id="minLiquidityUsd"
                  type="number"
                  step="1"
                  min="0"
                  value={settings.minLiquidityUsd}
                  onChange={(e) => updateSetting('minLiquidityUsd', parseFloat(e.target.value) || 0)}
                  className="bg-background/50"
                />
              </div>
              <div>
                <label htmlFor="maxLiquidityUsd" className="text-sm font-medium mb-1 block">Max (USD)</label>
                <Input
                  id="maxLiquidityUsd"
                  type="number"
                  step="1"
                  min="0"
                  value={settings.maxLiquidityUsd}
                  onChange={(e) => updateSetting('maxLiquidityUsd', parseFloat(e.target.value) || 0)}
                  className="bg-background/50"
                />
              </div>
            </div>
          </div>

          {/* Market Cap Filters */}
          <div className="space-y-4">
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Layers className="w-4 h-4" />
              Market Cap Filters
            </h4>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="minMarketCapUsd" className="text-sm font-medium mb-1 block">Min (USD)</label>
                <Input
                  id="minMarketCapUsd"
                  type="number"
                  step="1"
                  min="0"
                  value={settings.minMarketCapUsd}
                  onChange={(e) => updateSetting('minMarketCapUsd', parseFloat(e.target.value) || 0)}
                  className="bg-background/50"
                />
              </div>
              <div>
                <label htmlFor="maxMarketCapUsd" className="text-sm font-medium mb-1 block">Max (USD)</label>
                <Input
                  id="maxMarketCapUsd"
                  type="number"
                  step="1"
                  min="0"
                  value={settings.maxMarketCapUsd}
                  onChange={(e) => updateSetting('maxMarketCapUsd', parseFloat(e.target.value) || 0)}
                  className="bg-background/50"
                />
              </div>
            </div>
          </div>

          {/* Token Age Filter */}
          <div className="space-y-4">
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Token Age Filter
            </h4>

            <div>
              <label htmlFor="maxTokenAgeSec" className="text-sm font-medium mb-1 block">Max Token Age (seconds)</label>
              <Input
                id="maxTokenAgeSec"
                type="number"
                step="60"
                min="0"
                value={settings.maxTokenAgeSec}
                onChange={(e) => updateSetting('maxTokenAgeSec', parseInt(e.target.value) || 0)}
                className="bg-background/50"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {Math.floor(settings.maxTokenAgeSec / 60)} minutes
              </p>
            </div>

            <div>
              <label htmlFor="momentumMaxPositions" className="text-sm font-medium mb-1 block">Max Open Positions</label>
              <Input
                id="momentumMaxPositions"
                type="number"
                step="1"
                min="1"
                value={settings.momentumMaxPositions}
                onChange={(e) => updateSetting('momentumMaxPositions', parseInt(e.target.value) || 1)}
                className="bg-background/50"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Auto-buys pause while you hold this many unsold tokens (shared with momentum)
              </p>
            </div>
          </div>
        </div>

        {/* Platform Toggles */}
        <div className="mt-6 pt-6 border-t border-border">
          <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
            <Layers className="w-4 h-4" />
            Enable Platforms
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="flex items-center justify-between p-3 rounded-lg bg-background/50 border border-border hover:bg-accent/10 transition-colors cursor-pointer">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-orange-500/20 flex items-center justify-center">
                  <span className="text-orange-500 font-bold text-xs">PF</span>
                </div>
                <span className="font-medium">Pump.fun</span>
              </div>
              <Switch
                checked={settings.enablePumpfun}
                onCheckedChange={(checked) => updateSetting('enablePumpfun', checked)}
              />
            </label>

            <label className="flex items-center justify-between p-3 rounded-lg bg-background/50 border border-border hover:bg-accent/10 transition-colors cursor-pointer">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                  <span className="text-blue-500 font-bold text-xs">RAY</span>
                </div>
                <span className="font-medium">Raydium</span>
              </div>
              <Switch
                checked={settings.enableRaydium}
                onCheckedChange={(checked) => updateSetting('enableRaydium', checked)}
              />
            </label>

            <label className="flex items-center justify-between p-3 rounded-lg bg-background/50 border border-border hover:bg-accent/10 transition-colors cursor-pointer">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                  <span className="text-purple-500 font-bold text-xs">LL</span>
                </div>
                <span className="font-medium">Launchlab</span>
              </div>
              <Switch
                checked={settings.enableLaunchlab}
                onCheckedChange={(checked) => updateSetting('enableLaunchlab', checked)}
              />
            </label>
          </div>
        </div>

        {/* Security Toggles */}
        <div className="mt-6 pt-6 border-t border-border">
          <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
            <Shield className="w-4 h-4" />
            Security Checks
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex items-center justify-between p-3 rounded-lg bg-background/50 border border-border hover:bg-accent/10 transition-colors cursor-pointer">
              <div className="flex items-center gap-3">
                {settings.checkMintAuthority ? (
                  <CheckCircle className="w-5 h-5 text-green-500" />
                ) : (
                  <XCircle className="w-5 h-5 text-red-500" />
                )}
                <div>
                  <span className="font-medium block">Check Mint Authority</span>
                  <span className="text-xs text-muted-foreground">Skip tokens with mint authority</span>
                </div>
              </div>
              <Switch
                checked={settings.checkMintAuthority}
                onCheckedChange={(checked) => updateSetting('checkMintAuthority', checked)}
              />
            </label>

            <label className="flex items-center justify-between p-3 rounded-lg bg-background/50 border border-border hover:bg-accent/10 transition-colors cursor-pointer">
              <div className="flex items-center gap-3">
                {settings.checkFreezeAuthority ? (
                  <CheckCircle className="w-5 h-5 text-green-500" />
                ) : (
                  <XCircle className="w-5 h-5 text-red-500" />
                )}
                <div>
                  <span className="font-medium block">Check Freeze Authority</span>
                  <span className="text-xs text-muted-foreground">Skip tokens with freeze authority</span>
                </div>
              </div>
              <Switch
                checked={settings.checkFreezeAuthority}
                onCheckedChange={(checked) => updateSetting('checkFreezeAuthority', checked)}
              />
            </label>
          </div>
        </div>

        {/* Save Button */}
        <div className="mt-6 pt-6 border-t border-border flex justify-end">
          <Button
            onClick={handleSaveSettings}
            disabled={isSaving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground px-6"
          >
            {isSaving ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Settings className="w-4 h-4 mr-2" />
                Save Settings
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Live Filtered Tokens Preview */}
      <div className="glass p-6 rounded-xl border border-border">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <RefreshCw className={`w-4 h-4 text-primary ${isLoadingTokens ? 'animate-spin' : ''}`} />
            <h3 className="text-lg font-semibold">Live Filtered Tokens</h3>
          </div>
          <button
            onClick={fetchLiveTokens}
            className="text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            Refresh
          </button>
        </div>

        {liveTokens.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Layers className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No filtered tokens yet</p>
            <p className="text-xs mt-1">Tokens matching your criteria will appear here</p>
          </div>
        ) : (
          <div className="space-y-2">
            {liveTokens.map((token, index) => (
              <div
                key={token.mint || index}
                className="flex items-center justify-between p-3 rounded-lg bg-background/50 border border-border hover:bg-accent/10 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-xs font-bold">
                    {index + 1}
                  </div>
                  <div>
                    <div className="font-medium flex items-center gap-2">
                      {token.symbol || 'Unknown'}
                      <span className="text-xs text-muted-foreground">
                        {token.source || ''}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {token.mint
                        ? `${token.mint.slice(0, 8)}...${token.mint.slice(-8)}`
                        : 'Unknown address'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-sm">
                  <div className="text-right">
                    <div className="text-green-400">{token.liquiditySol != null ? token.liquiditySol.toFixed(2) : '—'} SOL</div>
                    <div className="text-xs text-muted-foreground">Liquidity</div>
                  </div>
                  <div className="text-right">
                    <div className="text-blue-400">{token.marketCapSol != null ? token.marketCapSol.toFixed(2) : '—'} SOL</div>
                    <div className="text-xs text-muted-foreground">MCap</div>
                  </div>
                  <div className="text-right">
                    <div className="text-yellow-400">{token.ageSec != null ? formatAge(token.ageSec) : '—'}</div>
                    <div className="text-xs text-muted-foreground">Age</div>
                  </div>
                  {token.mint && (
                    <a
                      href={`https://solscan.io/token/${token.mint}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 hover:bg-accent/20 rounded-lg transition-colors"
                    >
                      <ExternalLink className="w-4 h-4 text-muted-foreground" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AutoSnipeControls;
