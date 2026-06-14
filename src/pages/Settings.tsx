import React, { useState, useEffect } from 'react';
import { Bell, Shield, Wallet, MessageSquare, Save, CheckCircle, Key, Eye, EyeOff, Sliders } from 'lucide-react';
import { cn } from '../lib/utils';
import { useWallet } from '@solana/wallet-adapter-react';
import { useIsAuthenticated } from '../hooks/useSimpleAuth';
import { useAuth } from '../contexts/AuthContext';
import { useManagedWallets } from '../hooks/useManagedWallets';

// 🚨 SECURITY: Component for when user is not authenticated
const UnauthenticatedSettings: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="max-w-md space-y-6">
        <div className="w-24 h-24 mx-auto bg-primary/10 rounded-full flex items-center justify-center">
          <Sliders className="w-12 h-12 text-primary" />
        </div>

        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Connect Your Profile Wallet</h2>
          <p className="text-muted-foreground">
            Connect your profile wallet to access settings.
          </p>
        </div>
      </div>
    </div>
  );
};

interface SettingsSection {
  id: string;
  title: string;
  icon: React.ReactNode;
  description: string;
}

const Settings: React.FC = () => {
  // 🚨 SECURITY: Check authentication first
  const isAuthenticated = useIsAuthenticated();
  const { sessionToken, user } = useAuth();

  const [activeSection, setActiveSection] = useState('apikeys');

  // ── Security tools state (audit + per-wallet encryption rotation) ──
  const [audit, setAudit] = useState<any>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);
  const [rotated, setRotated] = useState<string[]>([]);
  const { wallets } = useManagedWallets();

  const runSecurityAudit = async () => {
    if (!sessionToken) return;
    setAuditLoading(true);
    try {
      const r = await fetch('/api/wallets/security-audit', { headers: { 'Authorization': `Bearer ${sessionToken}` } });
      const d = await r.json();
      if (d.success) setAudit(d.audit);
    } catch (e) { console.warn('Security audit failed:', e); }
    finally { setAuditLoading(false); }
  };

  const rotateWallet = async (walletId: string) => {
    if (!sessionToken || rotating) return;
    setRotating(walletId);
    try {
      const r = await fetch(`/api/wallets/${walletId}/rotate-encryption`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sessionToken}` },
      });
      const d = await r.json();
      if (d.success) setRotated(prev => [...prev, walletId]);
    } catch (e) { console.warn('Encryption rotation failed:', e); }
    finally { setRotating(null); }
  };
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [apiKeys, setApiKeys] = useState({
    HELIUS_API_KEY: '',
    TAVAHIN_RPC_URL: '',
    TAVAHIN_API_KEY: '',
    GEYSER_GRPC_ENDPOINT: '',
    GEYSER_AUTH_TOKEN: '',
    SOLANA_NETWORK: '', // empty = unchanged; bind falls back to the saved value
    JUPITER_API_KEY: '',
  });
  const [apiKeyStatus, setApiKeyStatus] = useState<Record<string, { set: boolean; masked?: string; value?: string }>>({});
  const [showKeys, setShowKeys] = useState({ HELIUS_API_KEY: false, TAVAHIN_API_KEY: false, GEYSER_AUTH_TOKEN: false, JUPITER_API_KEY: false });
  const [settings, setSettings] = useState({
    slippage: 1,
    autoApprove: false,
    notifications: {
      email: true,
      telegram: false,
      desktop: true,
    },
    rpcEndpoint: 'https://api.mainnet-beta.solana.com',
    privateRpc: '',
    telegramBotToken: '',
    telegramChatId: '',
    emailAddress: '',
    profitTarget: 50,
    stopLoss: 20,
    maxConcurrentTrades: 3,
  });

  const { connected, publicKey } = useWallet();

  // Load settings from backend on mount
  useEffect(() => {
    if (!isAuthenticated || !sessionToken) return;
    fetch('/api/settings', {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    })
      .then(r => r.json())
      .then(data => {
        if (data.success && data.settings && Object.keys(data.settings).length > 0) {
          setSettings(prev => ({ ...prev, ...data.settings }));
        }
      })
      .catch(e => console.warn('Failed to load settings:', e));
  }, [isAuthenticated, sessionToken]);

  // Load API keys status
  useEffect(() => {
    if (!isAuthenticated || !sessionToken) return;
    fetch('/api/config/api-keys', {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    })
      .then(r => r.json())
      .then(data => {
        if (data.success && data.config) setApiKeyStatus(data.config);
      })
      .catch(e => console.warn('Failed to load API key status:', e));
  }, [isAuthenticated, sessionToken]);


  // 🚨 SECURITY: Check authentication BEFORE rendering sensitive data
  if (!isAuthenticated) {
    return <UnauthenticatedSettings />;
  }

  // General + Trading sections removed (2026-06-12): their fields were dead
  // duplicates — real RPC config lives in "API Keys & RPC" (Helius/Tavahin),
  // and real trading params live in Sniper → Sniper Filters (snipe_settings).
  const sections: SettingsSection[] = [
    {
      id: 'apikeys',
      title: 'API Keys & RPC',
      icon: <Key className="w-5 h-5" />,
      description: 'Manage Helius, Tavahin, and Geyser credentials',
    },
    {
      id: 'notifications',
      title: 'Notifications',
      icon: <Bell className="w-5 h-5" />,
      description: 'Manage your notification preferences',
    },
    {
      id: 'security',
      title: 'Security',
      icon: <Shield className="w-5 h-5" />,
      description: 'Configure security settings and permissions',
    },
  ];

  const handleSettingChange = (key: string, value: any) => {
    setSettings(prev => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleNotificationChange = (key: string, value: boolean) => {
    setSettings(prev => ({
      ...prev,
      notifications: {
        ...prev.notifications,
        [key]: value,
      },
    }));
  };

  const handleSave = async () => {
    if (!sessionToken || saveStatus === 'saving') return;
    setSaveStatus('saving');
    try {
      // Save general settings to DB
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ settings }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Failed to save');

      // Save API keys if any were entered — regardless of which tab is active
      // (previously keys typed on the API Keys tab were silently dropped if the
      // user switched tabs before hitting Save)
      {
        const keysToSave = Object.fromEntries(
          Object.entries(apiKeys).filter(([k, v]) => v.trim() !== '' && k !== 'SOLANA_NETWORK')
        );
        // Only send SOLANA_NETWORK when the user actually changed it — the old code
        // force-wrote 'mainnet' (the state default) on every save.
        if (apiKeys.SOLANA_NETWORK && apiKeys.SOLANA_NETWORK !== (apiKeyStatus.SOLANA_NETWORK?.value || 'mainnet')) {
          (keysToSave as any).SOLANA_NETWORK = apiKeys.SOLANA_NETWORK;
        }
        if (Object.keys(keysToSave).length > 0) {
          const keyResp = await fetch('/api/config/api-keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
            body: JSON.stringify(keysToSave),
          });
          if (!keyResp.ok) throw new Error('Failed to save API keys');
          // Reload status after save
          const statusResp = await fetch('/api/config/api-keys', { headers: { 'Authorization': `Bearer ${sessionToken}` } });
          const statusData = await statusResp.json();
          if (statusData.success) setApiKeyStatus(statusData.config);
          setApiKeys({ HELIUS_API_KEY: '', TAVAHIN_RPC_URL: '', TAVAHIN_API_KEY: '', GEYSER_GRPC_ENDPOINT: '', GEYSER_AUTH_TOKEN: '', SOLANA_NETWORK: '', JUPITER_API_KEY: '' });
        }
      }

      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (e) {
      console.error('Settings save error:', e);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };


  return (
    <div className="flex-1 p-2 sm:p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-4 sm:mb-6">
          <h1 className="text-xl sm:text-2xl font-bold gradient-text">Settings</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">Configure your bot settings and preferences</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 sm:gap-6">
          {/* Sidebar - Responsive layout */}
          <div className="flex lg:block overflow-x-auto lg:overflow-x-visible pb-2 lg:pb-0 space-x-2 lg:space-x-0 lg:space-y-2">
            {sections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  "flex-shrink-0 lg:flex-shrink w-auto lg:w-full flex items-center space-x-2 sm:space-x-3 px-3 sm:px-4 py-2 sm:py-3 rounded-xl transition-all duration-200",
                  activeSection === section.id
                    ? "glass text-primary"
                    : "hover:glass hover:text-primary"
                )}
              >
                <div className="p-1.5 sm:p-2 rounded-lg bg-primary/10">
                  {section.icon}
                </div>
                <div className="text-left">
                  <div className="text-sm sm:text-base font-medium">{section.title}</div>
                  <div className="hidden lg:block text-xs sm:text-sm text-muted-foreground">{section.description}</div>
                </div>
              </button>
            ))}
          </div>

          {/* Main Content - Responsive padding and spacing */}
          <div className="lg:col-span-3 glass rounded-xl p-3 sm:p-4 md:p-6 border">
            {/* General + Trading sections removed (2026-06-12) — dead duplicates;
                RPC lives in API Keys & RPC, trading params in Sniper Filters */}

            {activeSection === 'notifications' && (
              <div className="space-y-4 sm:space-y-6 animate-fade-in">
                <div className="space-y-3 sm:space-y-4">
                  {/* Email section removed (2026-06-12) — Telegram covers trade alerts;
                      email would require an external sending provider */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <MessageSquare className="w-4 h-4 sm:w-5 sm:h-5 text-primary" />
                      <span className="text-sm sm:text-base">Telegram Notifications</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.notifications.telegram}
                      onChange={(e) => handleNotificationChange('telegram', e.target.checked)}
                      className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                    />
                  </div>

                  {settings.notifications.telegram && (
                    <div className="space-y-3 sm:space-y-4">
                      <input
                        type="text"
                        value={settings.telegramBotToken}
                        onChange={(e) => handleSettingChange('telegramBotToken', e.target.value)}
                        className="w-full px-3 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base rounded-lg glass border border-border focus:border-primary transition-colors duration-200"
                        placeholder="Enter Telegram bot token"
                      />
                      <input
                        type="text"
                        value={settings.telegramChatId}
                        onChange={(e) => handleSettingChange('telegramChatId', e.target.value)}
                        className="w-full px-3 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base rounded-lg glass border border-border focus:border-primary transition-colors duration-200"
                        placeholder="Enter Telegram chat ID"
                      />
                      <p className="text-xs text-muted-foreground">
                        Token from @BotFather · your ID from @userinfobot · open your bot's chat and press <span className="text-foreground">Start</span> first, or Telegram blocks the messages. Saving sends a test message.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeSection === 'security' && (
              <div className="space-y-4 sm:space-y-6 animate-fade-in">
                <div className="p-3 sm:p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                  <div className="flex items-center space-x-2 text-yellow-500">
                    <Shield className="w-4 h-4 sm:w-5 sm:h-5" />
                    <span className="text-sm sm:text-base font-medium">Security Notice</span>
                  </div>
                  <p className="mt-2 text-xs sm:text-sm text-muted-foreground">
                    Never share your private keys or seed phrases. Keep your wallet secure at all times.
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium mb-1.5 sm:mb-2 block">Wallet Address</label>
                  <div className="flex items-center space-x-2">
                    <input
                      type="text"
                      className="w-full px-3 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base rounded-lg glass border border-border focus:border-primary transition-colors duration-200 font-mono"
                      value={user?.walletAddress ?? ''}
                      placeholder="Connect your wallet to view address"
                      readOnly
                    />
                  </div>
                </div>

                {/* ── Security Audit (2026-06-12) — wires /api/wallets/security-audit ── */}
                <div className="p-3 sm:p-4 rounded-lg glass border border-border">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm sm:text-base font-medium">Wallet Security Audit</div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Read-only check of your managed wallets' encryption (AES-256-GCM, per-wallet salts). No keys are read or moved.
                      </p>
                    </div>
                    <button
                      onClick={runSecurityAudit}
                      disabled={auditLoading}
                      className="px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg glass border border-border text-foreground hover:border-primary hover:text-primary transition-colors text-sm disabled:opacity-60"
                    >
                      {auditLoading ? 'Auditing…' : 'Run Audit'}
                    </button>
                  </div>
                  {audit && (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4 text-sm">
                      <div className="glass rounded-lg p-3">
                        <div className={`text-xl font-bold ${audit.securityScore >= 90 ? 'text-green-400' : audit.securityScore >= 60 ? 'text-yellow-400' : 'text-red-400'}`}>
                          {audit.securityScore}/100
                        </div>
                        <div className="text-xs text-muted-foreground">Security score</div>
                      </div>
                      <div className="glass rounded-lg p-3">
                        <div className="text-xl font-bold text-green-400">{audit.encryptedWallets}/{audit.totalWallets}</div>
                        <div className="text-xs text-muted-foreground">Encrypted wallets</div>
                      </div>
                      <div className="glass rounded-lg p-3">
                        <div className={`text-xl font-bold ${audit.unencryptedWallets > 0 ? 'text-red-400' : 'text-foreground'}`}>{audit.unencryptedWallets}</div>
                        <div className="text-xs text-muted-foreground">Unencrypted (legacy)</div>
                      </div>
                    </div>
                  )}
                  {audit && audit.unencryptedWallets > 0 && (
                    <p className="text-xs text-yellow-400 mt-3">
                      ⚠️ Legacy unencrypted wallet(s) found — use the migration API (`POST /api/wallets/upgrade-all`) to encrypt them.
                    </p>
                  )}
                </div>

                {/* ── Rotate encryption per managed wallet — wires /api/wallets/:id/rotate-encryption ── */}
                <div className="p-3 sm:p-4 rounded-lg glass border border-border">
                  <div className="text-sm sm:text-base font-medium">Rotate Wallet Encryption</div>
                  <p className="text-xs text-muted-foreground mt-0.5 mb-3">
                    Re-encrypts a wallet's stored private key with a fresh salt. The keypair itself never changes and never leaves this machine — like changing the lock, not the key.
                  </p>
                  {wallets.length === 0 && <p className="text-xs text-muted-foreground">No managed wallets.</p>}
                  <div className="space-y-2">
                    {wallets.map(w => (
                      <div key={w.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-secondary/40">
                        <div className="min-w-0">
                          <span className="text-sm font-medium">{w.name}</span>
                          <span className="text-xs text-muted-foreground font-mono ml-2">{w.publicKey.slice(0, 4)}…{w.publicKey.slice(-4)}</span>
                        </div>
                        <button
                          onClick={() => rotateWallet(w.id)}
                          disabled={rotating === w.id}
                          className="px-3 py-1 rounded-lg text-xs glass border border-border hover:border-primary hover:text-primary transition-colors disabled:opacity-60 shrink-0"
                        >
                          {rotating === w.id ? 'Rotating…' : rotated.includes(w.id) ? '✓ Rotated' : 'Rotate'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeSection === 'apikeys' && (
              <div className="space-y-4 sm:space-y-6 animate-fade-in">
                <div className="p-3 sm:p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
                  <div className="flex items-center space-x-2 text-blue-400">
                    <Key className="w-4 h-4 sm:w-5 sm:h-5" />
                    <span className="text-sm sm:text-base font-medium">API Keys & RPC Configuration</span>
                  </div>
                  <p className="mt-2 text-xs sm:text-sm text-muted-foreground">
                    These settings mirror what the setup wizard configured. Leave a field blank to keep the existing value. Changes are saved to the app database and take effect immediately.
                  </p>
                </div>

                {/* Helius */}
                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Helius API Key
                    {apiKeyStatus.HELIUS_API_KEY?.set && <span className="ml-2 text-xs text-green-400">✓ Configured</span>}
                  </label>
                  <div className="relative">
                    <input
                      type={showKeys.HELIUS_API_KEY ? 'text' : 'password'}
                      className="w-full px-3 sm:px-4 py-2 pr-10 text-sm rounded-lg glass border border-border focus:border-primary transition-colors font-mono"
                      value={apiKeys.HELIUS_API_KEY}
                      onChange={e => setApiKeys(prev => ({ ...prev, HELIUS_API_KEY: e.target.value }))}
                      placeholder={apiKeyStatus.HELIUS_API_KEY?.masked || 'Enter Helius API key…'}
                    />
                    <button type="button" onClick={() => setShowKeys(p => ({ ...p, HELIUS_API_KEY: !p.HELIUS_API_KEY }))}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition-colors" title="Toggle visibility">
                      {showKeys.HELIUS_API_KEY ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Tavahin RPC */}
                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Tavahin RPC URL <span className="text-muted-foreground text-xs">(optional — private RPC)</span>
                    {apiKeyStatus.TAVAHIN_RPC_URL?.set && <span className="ml-2 text-xs text-green-400">✓ Configured</span>}
                  </label>
                  <input
                    type="text"
                    className="w-full px-3 sm:px-4 py-2 text-sm rounded-lg glass border border-border focus:border-primary transition-colors font-mono"
                    value={apiKeys.TAVAHIN_RPC_URL}
                    onChange={e => setApiKeys(prev => ({ ...prev, TAVAHIN_RPC_URL: e.target.value }))}
                    placeholder={apiKeyStatus.TAVAHIN_RPC_URL?.value || 'https://rpc.tavahin.io/…'}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Tavahin API Key
                    {apiKeyStatus.TAVAHIN_API_KEY?.set && <span className="ml-2 text-xs text-green-400">✓ Configured</span>}
                  </label>
                  <div className="relative">
                    <input
                      type={showKeys.TAVAHIN_API_KEY ? 'text' : 'password'}
                      className="w-full px-3 sm:px-4 py-2 pr-10 text-sm rounded-lg glass border border-border focus:border-primary transition-colors font-mono"
                      value={apiKeys.TAVAHIN_API_KEY}
                      onChange={e => setApiKeys(prev => ({ ...prev, TAVAHIN_API_KEY: e.target.value }))}
                      placeholder={apiKeyStatus.TAVAHIN_API_KEY?.masked || 'Enter Tavahin API key…'}
                    />
                    <button type="button" onClick={() => setShowKeys(p => ({ ...p, TAVAHIN_API_KEY: !p.TAVAHIN_API_KEY }))}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition-colors" title="Toggle visibility">
                      {showKeys.TAVAHIN_API_KEY ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Geyser gRPC */}
                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Geyser gRPC Endpoint <span className="text-muted-foreground text-xs">(optional — 0-block sniping)</span>
                    {apiKeyStatus.GEYSER_GRPC_ENDPOINT?.set && <span className="ml-2 text-xs text-green-400">✓ Configured</span>}
                  </label>
                  <input
                    type="text"
                    className="w-full px-3 sm:px-4 py-2 text-sm rounded-lg glass border border-border focus:border-primary transition-colors font-mono"
                    value={apiKeys.GEYSER_GRPC_ENDPOINT}
                    onChange={e => setApiKeys(prev => ({ ...prev, GEYSER_GRPC_ENDPOINT: e.target.value }))}
                    placeholder={apiKeyStatus.GEYSER_GRPC_ENDPOINT?.value || 'grpc://…'}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Geyser Auth Token
                    {apiKeyStatus.GEYSER_AUTH_TOKEN?.set && <span className="ml-2 text-xs text-green-400">✓ Configured</span>}
                  </label>
                  <div className="relative">
                    <input
                      type={showKeys.GEYSER_AUTH_TOKEN ? 'text' : 'password'}
                      className="w-full px-3 sm:px-4 py-2 pr-10 text-sm rounded-lg glass border border-border focus:border-primary transition-colors font-mono"
                      value={apiKeys.GEYSER_AUTH_TOKEN}
                      onChange={e => setApiKeys(prev => ({ ...prev, GEYSER_AUTH_TOKEN: e.target.value }))}
                      placeholder={apiKeyStatus.GEYSER_AUTH_TOKEN?.masked || 'Enter Geyser auth token…'}
                    />
                    <button type="button" onClick={() => setShowKeys(p => ({ ...p, GEYSER_AUTH_TOKEN: !p.GEYSER_AUTH_TOKEN }))}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition-colors" title="Toggle visibility">
                      {showKeys.GEYSER_AUTH_TOKEN ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Jupiter API Key */}
                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Jupiter API Key <span className="text-muted-foreground text-xs">(required for swaps — <a href="https://portal.jup.ag" target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">get one free</a>)</span>
                    {apiKeyStatus.JUPITER_API_KEY?.set && <span className="ml-2 text-xs text-green-400">✓ Configured</span>}
                  </label>
                  <div className="relative">
                    <input
                      type={showKeys.JUPITER_API_KEY ? 'text' : 'password'}
                      className="w-full px-3 sm:px-4 py-2 pr-10 text-sm rounded-lg glass border border-border focus:border-primary transition-colors font-mono"
                      value={apiKeys.JUPITER_API_KEY}
                      onChange={e => setApiKeys(prev => ({ ...prev, JUPITER_API_KEY: e.target.value }))}
                      placeholder={apiKeyStatus.JUPITER_API_KEY?.masked || 'Enter Jupiter API key…'}
                    />
                    <button type="button" onClick={() => setShowKeys(p => ({ ...p, JUPITER_API_KEY: !p.JUPITER_API_KEY }))}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition-colors" title="Toggle visibility">
                      {showKeys.JUPITER_API_KEY ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Network */}
                <div>
                  <label className="text-sm font-medium mb-1.5 block">Solana Network</label>
                  <select
                    className="w-full px-3 sm:px-4 py-2 text-sm rounded-lg glass border border-border focus:border-primary transition-colors"
                    value={apiKeys.SOLANA_NETWORK || apiKeyStatus.SOLANA_NETWORK?.value || 'mainnet'}
                    onChange={e => setApiKeys(prev => ({ ...prev, SOLANA_NETWORK: e.target.value }))}
                  >
                    <option value="mainnet">Mainnet Beta</option>
                    <option value="devnet">Devnet</option>
                    <option value="testnet">Testnet</option>
                  </select>
                </div>
              </div>
            )}

            <div className="mt-4 sm:mt-6 flex justify-end items-center gap-3">
              {saveStatus === 'saved' && (
                <span className="flex items-center gap-1 text-green-500 text-sm font-medium">
                  <CheckCircle className="w-4 h-4" /> Saved!
                </span>
              )}
              {saveStatus === 'error' && (
                <span className="text-red-500 text-sm">Save failed — check console</span>
              )}
              <button
                id="saveButton"
                onClick={handleSave}
                disabled={saveStatus === 'saving'}
                className="modern-button solana-glow flex items-center space-x-2 text-sm sm:text-base px-3 sm:px-4 py-1.5 sm:py-2 disabled:opacity-60"
              >
                {saveStatus === 'saving' ? (
                  <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /><span>Saving…</span></>
                ) : (
                  <><Save className="w-4 h-4" /><span>Save Changes</span></>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
