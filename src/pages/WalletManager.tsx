import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Wallet, Plus, Download, Upload, Trash2, Eye, EyeOff, CheckCircle, AlertTriangle, Copy, Send, Activity, Clock, User, Settings, Wifi, WifiOff, Coins } from 'lucide-react';
import TokenHoldings from '../components/TokenHoldings';
import { useAuth } from '../contexts/AuthContext';

// 🚨 SECURITY: Component for when user is not authenticated
const UnauthenticatedWalletManager: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="max-w-md space-y-6">
        <div className="w-24 h-24 mx-auto bg-red-500/10 rounded-full flex items-center justify-center">
          <Wallet className="w-12 h-12 text-red-500" />
        </div>

        <div className="space-y-2">
          <h2 className="text-2xl font-bold text-red-600">⚠️ Access Restricted</h2>
          <p className="text-muted-foreground">
            You must connect your profile wallet to access the Wallet Manager.
          </p>
        </div>

        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">
            <AlertTriangle className="w-4 h-4 inline mr-1" />
            🚨 SECURITY FEATURE: Wallet operations require authentication to protect your funds
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            To access wallet management features:
          </p>
          <ol className="text-sm text-center space-y-1 text-muted-foreground">
            <li>1. Click "Select Wallet" in the top right</li>
            <li>2. Connect your Solana profile wallet</li>
            <li>3. Approve the connection</li>
            <li>4. Return to this page</li>
          </ol>
        </div>
      </div>
    </div>
  );
};

interface ManagedWallet {
  id: string;
  name: string;
  publicKey: string;
  balance: number;
  isActive: boolean;
  createdAt: string;
  isProfileWallet?: boolean;
  wallet_type?: string;
}

interface ActivityLog {
  timestamp: string;
  action: string;
  walletId?: string;
  walletName?: string;
  details?: any;
}

export const WalletManager: React.FC = () => {
  // 🚨 SECURITY: Check authentication first - ALL HOOKS MUST BE CALLED BEFORE CONDITIONAL RETURNS
  const { isAuthenticated, sessionToken, user } = useAuth();
  const profileWalletAddress = user?.walletAddress || null;

  const [wallets, setWallets] = useState<ManagedWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null); // walletId of the recently copied address
  const [balanceUpdating, setBalanceUpdating] = useState<{ [key: string]: boolean }>({});
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const [isWebSocketConnected, setIsWebSocketConnected] = useState(false);

  // Performance optimization: Cache control
  const [lastFetchTime, setLastFetchTime] = useState<number>(0);
  const [fetchCache, setFetchCache] = useState<{ data: ManagedWallet[]; timestamp: number } | null>(null);
  const CACHE_DURATION = 30000; // 30 seconds frontend cache

  // WebSocket connection
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;

  // Activity logs state
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [showActivityLogs, setShowActivityLogs] = useState(false);

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [confirmRevealOpen, setConfirmRevealOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [confirmTransferOpen, setConfirmTransferOpen] = useState(false);
  const [tokenHoldingsOpen, setTokenHoldingsOpen] = useState(false);
  const [holdingsWallet, setHoldingsWallet] = useState<ManagedWallet | null>(null);

  // Form states
  const [showPrivateKey, setShowPrivateKey] = useState<{ [key: string]: boolean }>({});
  // FIX-12: Private keys must NEVER accumulate in React state.
  // Use an ephemeral single-value state that auto-clears after 60 seconds.
  // At most one decrypted key is in memory at a time, and only while displayed.
  const [oneTimeKey, setOneTimeKey] = useState<{ walletId: string; key: string } | null>(null);
  const oneTimeKeyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedWallet, setSelectedWallet] = useState<ManagedWallet | null>(null);
  const [newWalletName, setNewWalletName] = useState('');
  const [batchCount, setBatchCount] = useState(3);
  const [batchPrefix, setBatchPrefix] = useState('Trading Wallet');
  const [importName, setImportName] = useState('');
  const [importPrivateKey, setImportPrivateKey] = useState('');
  const [transferAddress, setTransferAddress] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferLoading, setTransferLoading] = useState(false);
  const [showImportPrivateKey, setShowImportPrivateKey] = useState(false);

  // WebSocket connection functions
  const connectWebSocket = () => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      console.log('🔌 WebSocket already connected, skipping...');
      return; // Already connected
    }

    // Close any existing connection first
    if (ws.current) {
      ws.current.close();
    }

    // Use same host as the page — Vite proxies /ws to backend in dev, direct in prod
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws${sessionToken ? `?token=${encodeURIComponent(sessionToken)}` : ''}`;

    console.log('🔌 Connecting to WebSocket:', wsUrl);

    try {
      ws.current = new WebSocket(wsUrl);

      ws.current.onopen = () => {
        console.log('✅ WebSocket connected - Real-time balance updates active');
        setIsWebSocketConnected(true);
        reconnectAttempts.current = 0;

        // Clear any pending reconnection
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      ws.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('📨 WebSocket message received:', data);

          switch (data.type) {
            case 'BALANCE_CHANGE':
            case 'walletBalanceUpdate': {
              // Update the specific wallet's balance in real-time
              const newBal = data.balanceSol ?? data.newBalance;
              setWallets(prev => prev.map(wallet =>
                (wallet.id === data.walletId || wallet.publicKey === data.publicKey)
                  ? { ...wallet, balance: newBal }
                  : wallet
              ));
              console.log(`💰 Balance streamed: ${data.publicKey ?? data.walletId} → ${newBal} SOL`);
              break;
            }

            case 'WALLET_CREATED':
              // Add new wallet to the list with proper mapping
              const newWallet = {
                id: data.wallet.id,
                name: data.wallet.walletName || data.wallet.name,
                publicKey: data.wallet.publicKey,
                balance: data.wallet.balanceSol || data.wallet.balance || 0,
                isActive: data.wallet.isActive,
                createdAt: data.wallet.createdAt,
              };
              setWallets(prev => [...prev, newWallet]);
              console.log(`✅ New wallet added: ${newWallet.name}`);
              break;

            case 'WALLET_DELETED':
              // Remove wallet from the list
              setWallets(prev => prev.filter(wallet => wallet.id !== data.walletId));
              console.log(`🗑️ Wallet removed: ${data.walletName}`);
              break;

            case 'WALLET_LIST':
              // Initial wallet list received on connection with proper mapping
              const mappedWalletList = (data.wallets || []).map((wallet: any) => ({
                id: wallet.id,
                name: wallet.walletName || wallet.name,
                publicKey: wallet.publicKey,
                balance: wallet.balanceSol || wallet.balance || 0,
                isActive: wallet.isActive,
                createdAt: wallet.createdAt,
              }));
              setWallets(mappedWalletList);
              console.log(`📋 Received wallet list: ${mappedWalletList.length} wallets`);
              break;

            default:
              console.log('🤷 Unknown WebSocket message type:', data.type);
          }
        } catch (error) {
          console.error('❌ Error parsing WebSocket message:', error);
        }
      };

      ws.current.onclose = (event) => {
        console.log('🔌 WebSocket disconnected:', event.code, event.reason);
        setIsWebSocketConnected(false);

        // Attempt to reconnect if not intentional close
        if (event.code !== 1000 && reconnectAttempts.current < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000); // Exponential backoff, max 30s
          console.log(`🔄 Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current + 1}/${maxReconnectAttempts})`);

          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttempts.current++;
            connectWebSocket();
          }, delay);
        } else if (reconnectAttempts.current >= maxReconnectAttempts) {
          console.error('❌ Max reconnection attempts reached. Please refresh the page.');
        }
      };

      ws.current.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
        setIsWebSocketConnected(false);

        // Don't attempt to reconnect immediately on connection errors
        // The onclose handler will handle reconnection logic
        console.log('ℹ️ WebSocket connection failed. Falling back to polling mode.');
      };

    } catch (error) {
      console.error('❌ Failed to create WebSocket connection:', error);
      setIsWebSocketConnected(false);
    }
  };

  const disconnectWebSocket = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (ws.current) {
      ws.current.close(1000, 'Component unmounting');
      ws.current = null;
    }

    setIsWebSocketConnected(false);
  };

  // Fetch wallets from API with performance optimizations
  const fetchWallets = useCallback(async (isAutoRefresh = false, bypassCache = false) => {
    try {
      if (!sessionToken) {
        console.log('🔒 No session token - not fetching wallets');
        setWallets([]);
        setLoading(false);
        return;
      }

      // Performance: Check cache first (unless bypassed or auto-refresh)
      const now = Date.now();
      if (!bypassCache && !isAutoRefresh && fetchCache && (now - fetchCache.timestamp) < CACHE_DURATION) {
        console.log('💨 Using cached wallet data');
        setWallets(fetchCache.data);
        setLoading(false);
        return;
      }

      if (isAutoRefresh) {
        setIsAutoRefreshing(true);
      } else {
        setLoading(true);
      }

      console.log('🔐 Fetching wallets with token:', sessionToken.substring(0, 20) + '...');

      const startTime = Date.now();
      const response = await fetch('/api/wallets/secure', {
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Cache-Control': isAutoRefresh ? 'no-cache' : 'max-age=30',
        }
      });

      console.log('🔐 Response status:', response.status);

      if (!response.ok) {
        const errorData = await response.json();
        console.error('🔐 Fetch error:', errorData);
        throw new Error(errorData.error || 'Failed to fetch wallets');
      }

      const data = await response.json();
      console.log('🔐 Raw response data:', data);
      const fetchTime = Date.now() - startTime;
      console.log(`⚡ Wallet fetch completed in ${fetchTime}ms`);

      // Map server response to frontend interface
      const mappedWallets = (data.wallets || []).map((wallet: any) => ({
        id: wallet.id,
        name: wallet.name, // Backend already maps walletName to name
        publicKey: wallet.publicKey,
        balance: wallet.balance, // Backend already maps balanceSol to balance
        isActive: wallet.isActive,
        createdAt: wallet.createdAt,
        isProfileWallet: wallet.isProfileWallet || false,
        wallet_type: wallet.wallet_type || 'sniping',
      }));

      console.log('🔐 Mapped wallets:', mappedWallets);

      setWallets(mappedWallets);
      setError(null);
      setLastFetchTime(now);

      // Update cache
      setFetchCache({
        data: mappedWallets,
        timestamp: now
      });

    } catch (err: any) {
      console.error('❌ Error fetching wallets:', err);
      setError(err.message);
    } finally {
      setLoading(false);
      if (isAutoRefresh) {
        setIsAutoRefreshing(false);
      }
    }
  }, [sessionToken, fetchCache, CACHE_DURATION]); // Add cache dependencies



  // Create single wallet
  const createWallet = async () => {
    try {
      if (!sessionToken) {
        setError('Authentication required. Please connect your wallet.');
        return;
      }

      console.log('🔐 Creating wallet with token:', sessionToken.substring(0, 20) + '...');

      const response = await fetch('/api/wallets/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ walletName: newWalletName }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create wallet');
      }

      setNewWalletName('');
      setCreateDialogOpen(false);
      // Force fresh fetch after creation, bypassing cache
      await fetchWallets(false, true);

      // Reduce auto-refresh frequency for better performance
      setTimeout(async () => {
        await fetchWallets(true);
        console.log('Auto-refreshed after wallet creation');
      }, 5000); // Increased from 2s to 5s
    } catch (err: any) {
      console.error('❌ Error creating wallet:', err);
      setError(err.message);
    }
  };

  // Create batch wallets
  const createBatchWallets = async () => {
    try {
      if (!sessionToken) {
        setError('Authentication required. Please connect your wallet.');
        return;
      }

      // Generate array of wallet names
      const walletNames = Array.from({ length: batchCount }, (_, i) =>
        `${batchPrefix} ${i + 1}`
      );

      const response = await fetch('/api/wallets/batch-create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ walletNames }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create batch wallets');
      }

      setBatchCount(3);
      setBatchPrefix('Trading Wallet');
      setBatchDialogOpen(false);
      // Force fresh fetch after batch creation, bypassing cache
      await fetchWallets(false, true);

      // Auto-refresh after 2 seconds to catch any updates
      setTimeout(async () => {
        await fetchWallets(true);
        console.log('Auto-refreshed after batch wallet creation');
      }, 2000);
    } catch (err: any) {
      console.error('❌ Error creating batch wallets:', err);
      setError(err.message);
    }
  };

  // Import wallet
  const importWallet = async () => {
    try {
      if (!sessionToken) {
        setError('Authentication required. Please connect your wallet.');
        return;
      }

      if (!importName.trim() || !importPrivateKey.trim()) {
        setError('Please provide both wallet name and private key.');
        return;
      }

      const response = await fetch('/api/wallets/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ walletName: importName.trim(), privateKey: importPrivateKey.trim() }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to import wallet');
      }

      const data = await response.json();
      const newWalletId = data.wallet?.id;

      setImportName('');
      setImportPrivateKey('');
      setImportDialogOpen(false);

      // Force fresh fetch after import, bypassing cache
      await fetchWallets(false, true);

      // If the backend returned the new wallet ID, immediately trigger a balance refresh
      if (newWalletId && sessionToken) {
        fetch(`/api/wallets/${newWalletId}/balance`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        }).then(() => fetchWallets(true)).catch(() => {});
      }

    } catch (err: any) {
      console.error('❌ Error importing wallet:', err);
      setError(err.message);
    }
  };

  // Export private key - Now using secure endpoint with risk confirmation
  const exportPrivateKey = async (walletId: string) => {
    try {
      if (!sessionToken) {
        setError('Authentication required. Please connect your wallet.');
        return;
      }

      const response = await fetch(`/api/wallets/${walletId}/private-key`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ confirmationPhrase: 'I_UNDERSTAND_THE_RISKS' })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to retrieve private key');
      }

      const data = await response.json();

      // FIX-12: Copy to clipboard immediately, then show ephemerally.
      // Key is auto-cleared after 60 seconds — never accumulates in state.
      if (oneTimeKeyTimer.current) clearTimeout(oneTimeKeyTimer.current);
      setOneTimeKey({ walletId, key: data.privateKey });
      oneTimeKeyTimer.current = setTimeout(() => {
        setOneTimeKey(null);
        setShowPrivateKey({});
      }, 60_000); // 60-second auto-clear

      console.log('✅ Private key retrieved successfully for wallet:', walletId);
    } catch (err: any) {
      console.error('❌ Error exporting private key:', err);
      setError(err.message);
    }
  };


  // Delete wallet
  const deleteWallet = async (walletId: string) => {
    try {
      if (!sessionToken) {
        setError('Authentication required. Please connect your wallet.');
        return;
      }

      const response = await fetch(`/api/wallets/${walletId}/secure-delete`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          confirmationPhrase: 'DELETE_WALLET_PERMANENTLY'
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Delete failed:', errorData);
        throw new Error(errorData.error || 'Failed to delete wallet');
      }

      const result = await response.json();
      console.log('✅ Wallet deletion successful:', result);

      setDeleteDialogOpen(false);
      setSelectedWallet(null);
      // Force fresh fetch after deletion, bypassing cache
      await fetchWallets(false, true);

      // Show success message
      console.log(`✅ Wallet "${selectedWallet?.name}" has been permanently deleted from the server`);

      // Auto-refresh after 1 second to ensure UI updates
      setTimeout(async () => {
        await fetchWallets(true);
        console.log('Auto-refreshed after wallet deletion');
      }, 1000);
    } catch (err: any) {
      console.error('❌ Error deleting wallet:', err);
      setError(err.message);
    }
  };

  // Update wallet balance — calls RPC and broadcasts via WebSocket
  const updateBalance = async (walletId: string) => {
    if (!sessionToken) return;
    try {
      setBalanceUpdating(prev => ({ ...prev, [walletId]: true }));
      const resp = await fetch(`/api/wallets/${walletId}/balance`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (!resp.ok) throw new Error('Balance fetch failed');
      const { balance } = await resp.json();
      setWallets(prev => prev.map(w => w.id === walletId ? { ...w, balance } : w));
    } catch (err: any) {
      console.error('Balance update error:', err);
    } finally {
      setBalanceUpdating(prev => ({ ...prev, [walletId]: false }));
    }
  };

  // Copy to clipboard with security notice (not an error)
  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setSecurityNotice('⚠️ Security: Private key copied. Clear your clipboard after use.');
    setTimeout(() => setSecurityNotice(null), 6000);
  };

  // Transfer SOL from wallet
  const transferSol = async () => {
    if (!selectedWallet) return;

    try {
      setTransferLoading(true);
      const response = await fetch(`/api/wallets/${selectedWallet.id}/transfer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          toAddress: transferAddress,
          amount: parseFloat(transferAmount)
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Transfer failed:', errorData);

        // Show detailed error message
        let errorMessage = errorData.error || 'Failed to transfer SOL';
        if (errorData.details) {
          errorMessage += `\n\n${errorData.details}`;
        }
        if (errorData.currentBalance !== undefined) {
          errorMessage += `\n\nCurrent Balance: ${errorData.currentBalance} SOL`;
          errorMessage += `\nRequested Amount: ${errorData.requestedAmount} SOL`;
          if (errorData.totalNeeded) {
            errorMessage += `\nTotal Needed: ${errorData.totalNeeded} SOL`;
          }
        }

        throw new Error(errorMessage);
      }

      const data = await response.json();

      // Reset form and close dialogs
      setTransferAddress('');
      setTransferAmount('');
      setTransferDialogOpen(false);
      setConfirmTransferOpen(false);
      setSelectedWallet(null);

      // Show success
      setError(null);
      console.log(`✅ Transfer complete: ${data.amount} SOL → ${data.toAddress} (sig: ${data.signature})`);

      // Refresh wallets immediately and wait for a moment for blockchain confirmation
      await fetchWallets();

      // Auto-refresh after 3 seconds to catch blockchain updates
      setTimeout(async () => {
        await fetchWallets(true);
        console.log('Auto-refreshed wallets after transfer');
      }, 3000);

      // Auto-refresh balance for the specific wallet that made the transfer
      setTimeout(async () => {
        await updateBalance(selectedWallet.id);
        console.log('Auto-updated balance for transfer wallet');
      }, 5000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setTransferLoading(false);
    }
  };

  // Fetch activity logs
  const fetchActivityLogs = useCallback(async () => {
    if (!selectedWallet) return;

    try {
      setActivityLoading(true);
      const response = await fetch(`/api/wallets/${selectedWallet.id}/activity`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` },
      });
      if (!response.ok) throw new Error('Failed to fetch activity logs');
      const data = await response.json();
      setActivityLogs(data.logs || []);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      console.error('Error fetching activity logs:', err);
    } finally {
      setActivityLoading(false);
    }
  }, [selectedWallet]); // Add selectedWallet as dependency

  useEffect(() => {
    fetchWallets();

    // Note: Removed automatic refresh interval since we now have real-time WebSocket updates
  }, [fetchWallets]); // Add fetchWallets to dependencies

  useEffect(() => {
    if (showActivityLogs) {
      fetchActivityLogs();
    }
  }, [showActivityLogs, fetchActivityLogs]); // Add fetchActivityLogs to dependencies

  useEffect(() => {
    // Only connect WebSocket if user is authenticated and not already connected
    if (isAuthenticated && (!ws.current || ws.current.readyState !== WebSocket.OPEN)) {
      console.log('🔄 Authentication state changed, connecting WebSocket...');
      connectWebSocket();
    } else if (!isAuthenticated && ws.current) {
      console.log('🔄 User not authenticated, disconnecting WebSocket...');
      disconnectWebSocket();
    }

    // Cleanup WebSocket on unmount
    return () => {
      disconnectWebSocket();
    };
  }, [isAuthenticated]); // Connect/disconnect based on authentication status

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-foreground space-y-4 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
          <div>Loading wallets...</div>
          <div className="text-sm text-muted-foreground">
            {isAutoRefreshing ? 'Refreshing...' : 'Fetching secure wallet data...'}
          </div>
        </div>
      </div>
    );
  }

  // 🚨 SECURITY: Check authentication AFTER all hooks are called
  if (!isAuthenticated) {
    return <UnauthenticatedWalletManager />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Wallet Manager</h1>
          <div className="flex items-center gap-3 mt-2">
            <p className="text-muted-foreground">Manage your server-side wallets for instant trading</p>
            {/* WebSocket Connection Status */}
            <div className="flex items-center gap-1 text-xs">
              {isWebSocketConnected ? (
                <>
                  <Wifi className="w-3 h-3 text-green-400" />
                  <span className="text-green-400">Live Updates Active</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3 h-3 text-red-400" />
                  <span className="text-red-400">Live Updates Disconnected</span>
                </>
              )}
            </div>
            {isAutoRefreshing && (
              <div className="flex items-center gap-1 text-blue-400 text-xs">
                <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse"></div>
                Auto-refreshing...
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-3 flex-wrap">
          <Button
            onClick={() => setCreateDialogOpen(true)}
            className="flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Create Wallet
          </Button>

          <Button
            onClick={() => setBatchDialogOpen(true)}
            variant="outline"
            className="flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Batch Create
          </Button>

          <Button
            onClick={() => setImportDialogOpen(true)}
            variant="outline"
            className="flex items-center gap-2"
          >
            <Upload className="w-4 h-4" />
            Import
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-500 text-red-200 p-4 rounded-lg">
          {error}
        </div>
      )}

      {securityNotice && (
        <div className="bg-yellow-900/20 border border-yellow-500 text-yellow-200 p-4 rounded-lg flex items-center gap-2">
          <span>{securityNotice}</span>
        </div>
      )}

      {/* Create Wallet Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create New Wallet</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <input
              type="text"
              placeholder="Wallet name"
              value={newWalletName}
              onChange={(e) => setNewWalletName(e.target.value)}
              className="w-full p-3 bg-secondary border border-input rounded text-foreground placeholder:text-muted-foreground"
            />
            <div className="flex gap-2 pt-4">
              <Button onClick={createWallet} disabled={!newWalletName} className="flex-1 font-medium text-sm">
                Create Wallet
              </Button>
              <Button variant="outline" onClick={() => setCreateDialogOpen(false)} className="flex-1 font-medium text-sm">
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Batch Create Dialog */}
      <Dialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Multiple Wallets</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <input
                type="number"
                placeholder="Count"
                value={batchCount}
                onChange={(e) => setBatchCount(Number(e.target.value))}
                min="1"
                max="100"
                className="p-3 bg-secondary border border-input rounded text-foreground placeholder:text-muted-foreground"
              />
              <input
                type="text"
                placeholder="Name prefix"
                value={batchPrefix}
                onChange={(e) => setBatchPrefix(e.target.value)}
                className="p-3 bg-secondary border border-input rounded text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="flex gap-2 pt-4">
              <Button onClick={createBatchWallets} disabled={batchCount < 1 || batchCount > 100} className="flex-1 font-medium text-sm">
                Create {batchCount} Wallets
              </Button>
              <Button variant="outline" onClick={() => setBatchDialogOpen(false)} className="flex-1 font-medium text-sm">
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Import Wallet Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={(open) => {
        setImportDialogOpen(open);
        if (!open) {
          setShowImportPrivateKey(false);
          setImportPrivateKey('');
          setImportName('');
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Import Existing Wallet</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <input
              type="text"
              placeholder="Wallet name"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              className="w-full p-3 bg-secondary border border-input rounded text-foreground placeholder:text-muted-foreground"
            />

            {/* Security Warning */}
            <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-3">
              <div className="flex items-start text-red-300 text-sm">
                <AlertTriangle className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium">⚠️ SECURITY WARNING</p>
                  <p className="text-xs mt-1">Never share your private key with anyone. AutoBotAPP will never ask for your private key via email or support.</p>
                </div>
              </div>
            </div>

            {/* Private Key Input with Toggle */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="text-sm text-muted-foreground">Private Key (base58)</label>
                <button
                  type="button"
                  onClick={() => setShowImportPrivateKey(!showImportPrivateKey)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showImportPrivateKey ? (
                    <>
                      <EyeOff className="w-3 h-3" />
                      Hide
                    </>
                  ) : (
                    <>
                      <Eye className="w-3 h-3" />
                      Show
                    </>
                  )}
                </button>
              </div>
              <div className="relative">
                <input
                  type={showImportPrivateKey ? "text" : "password"}
                  placeholder="Enter your private key"
                  value={importPrivateKey}
                  onChange={(e) => setImportPrivateKey(e.target.value)}
                  className="w-full p-3 pr-10 bg-secondary border border-input rounded text-foreground placeholder:text-muted-foreground font-mono text-sm"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowImportPrivateKey(!showImportPrivateKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showImportPrivateKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="flex gap-2 pt-4">
              <Button onClick={importWallet} disabled={!importName || !importPrivateKey} className="flex-1 font-medium text-sm">
                Import Wallet
              </Button>
              <Button variant="outline" onClick={() => {
                setImportDialogOpen(false);
              }} className="flex-1 font-medium text-sm">
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirm Private Key Reveal Dialog */}
      <Dialog open={confirmRevealOpen} onOpenChange={setConfirmRevealOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-500" />
              Security Warning
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="bg-yellow-900/20 border border-yellow-500 p-4 rounded-lg">
              <p className="text-yellow-200 text-sm">
                ⚠️ You are about to reveal a private key. Never share this with anyone or enter it on suspicious websites.
              </p>
            </div>
            <div className="flex gap-2 pt-4">
              <Button
                onClick={() => {
                  if (selectedWallet) {
                    exportPrivateKey(selectedWallet.id);
                    setShowPrivateKey(prev => ({ ...prev, [selectedWallet.id]: true }));
                  }
                  setConfirmRevealOpen(false);
                }}
                className="flex-1 bg-red-600 hover:bg-red-700 text-foreground font-medium text-sm leading-tight py-2.5 px-4"
              >
                I Understand, Show Key
              </Button>
              <Button variant="outline" onClick={() => setConfirmRevealOpen(false)} className="flex-1 font-medium text-sm">
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Wallet</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-foreground/80">
              Are you sure you want to delete wallet "{selectedWallet?.name}"? This action cannot be undone.
            </p>
            <div className="bg-red-900/20 border border-red-500 p-4 rounded-lg">
              <p className="text-red-200 text-sm">
                ⚠️ Make sure you have exported and safely stored the private key before deleting.
              </p>
            </div>
            <div className="flex gap-2 pt-4">
              <Button
                onClick={() => selectedWallet && deleteWallet(selectedWallet.id)}
                className="flex-1 bg-red-600 hover:bg-red-700 text-foreground font-medium text-sm leading-tight py-2.5 px-4"
              >
                Delete Wallet
              </Button>
              <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} className="flex-1 font-medium text-sm">
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Transfer SOL Dialog */}
      <Dialog open={transferDialogOpen} onOpenChange={setTransferDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-5 h-5 text-blue-500" />
              Transfer SOL
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <p className="text-sm text-muted-foreground mb-2">From Wallet</p>
              <p className="text-foreground font-medium">{selectedWallet?.name}</p>
              <p className="text-sm text-muted-foreground">Balance: {(selectedWallet?.balance ?? 0).toFixed(4)} SOL</p>
            </div>
            <input
              type="text"
              placeholder="Recipient address (44-character Solana address)"
              value={transferAddress}
              onChange={(e) => setTransferAddress(e.target.value)}
              className="w-full p-3 bg-secondary border border-input rounded text-foreground placeholder:text-muted-foreground font-mono text-sm"
            />
            <input
              type="number"
              placeholder="Amount (SOL)"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              step="0.001"
              min="0"
              max={selectedWallet?.balance || 0}
              className="w-full p-3 bg-secondary border border-input rounded text-foreground placeholder:text-muted-foreground"
            />
            <div className="flex gap-2 pt-4">
              <Button
                onClick={() => {
                  if (!transferAddress || !transferAmount) {
                    setError('Please fill in all fields');
                    return;
                  }
                  if (parseFloat(transferAmount) <= 0) {
                    setError('Amount must be greater than 0');
                    return;
                  }
                  if (parseFloat(transferAmount) > (selectedWallet?.balance || 0)) {
                    setError('Insufficient balance');
                    return;
                  }
                  setConfirmTransferOpen(true);
                }}
                disabled={!transferAddress || !transferAmount || parseFloat(transferAmount) <= 0}
                className="flex-1 font-medium text-sm"
              >
                Review Transfer
              </Button>
              <Button variant="outline" onClick={() => setTransferDialogOpen(false)} className="flex-1 font-medium text-sm">
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirm Transfer Dialog */}
      <Dialog open={confirmTransferOpen} onOpenChange={setConfirmTransferOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-orange-500" />
              Confirm Transfer
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="bg-orange-900/20 border border-orange-500 p-4 rounded-lg">
              <p className="text-orange-200 text-sm mb-3">
                ⚠️ Please confirm the transfer details. This action cannot be undone.
              </p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">From:</span>
                  <span className="text-foreground font-medium">{selectedWallet?.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">To:</span>
                  <span className="text-foreground font-mono text-xs break-all">{transferAddress}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Amount:</span>
                  <span className="text-foreground font-bold">{transferAmount} SOL</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Remaining Balance:</span>
                  <span className="text-foreground">{(((selectedWallet?.balance ?? 0) - parseFloat(transferAmount || '0'))).toFixed(4)} SOL</span>
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-4">
              <Button
                onClick={transferSol}
                disabled={transferLoading}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-foreground font-medium text-sm leading-tight py-2.5 px-4"
              >
                {transferLoading ? 'Transferring...' : 'Confirm Transfer'}
              </Button>
              <Button variant="outline" onClick={() => setConfirmTransferOpen(false)} className="flex-1 font-medium text-sm">
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Activity Logs Dialog */}
      <Dialog open={showActivityLogs} onOpenChange={setShowActivityLogs}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Activity Logs</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {activityLoading ? (
              <div className="flex items-center justify-center h-32">
                <div className="text-foreground">Loading activity logs...</div>
              </div>
            ) : (
              <div className="space-y-2">
                {activityLogs.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8">
                    <Clock className="w-10 h-10 mx-auto mb-4" />
                    <p>No activity logs found for this wallet.</p>
                  </div>
                ) : (
                  activityLogs.map((log, index) => (
                    <div key={index} className="p-3 glass border border-border rounded-lg">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{new Date(log.timestamp).toLocaleString()}</span>
                        <span>{log.action}</span>
                      </div>
                      {log.details && (
                        <div className="mt-2 text-sm text-foreground">
                          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(log.details, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
            <div className="flex gap-2 pt-4">
              <Button variant="outline" onClick={() => setShowActivityLogs(false)} className="flex-1 font-medium text-sm">
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Wallets Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-6xl mx-auto">
        {wallets.map((wallet) => (
          <Card key={wallet.id} className="glass border-border min-w-0">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-foreground flex items-center gap-2">
                  <Wallet className="w-5 h-5" />
                  {wallet.name}
                </CardTitle>
                <Badge className="bg-green-600 text-foreground">
                  <CheckCircle className="w-3 h-3 mr-1" />
                  {wallet.wallet_type === 'profile-readonly' ? 'Connected' : 'Active'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 px-6 pb-6">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Public Key</p>
                <div
                  className="relative group cursor-pointer"
                  onClick={async () => {
                    await navigator.clipboard.writeText(wallet.publicKey);
                    setCopiedAddress(wallet.id);
                    setTimeout(() => setCopiedAddress(null), 2000);
                  }}
                  title="Click to copy"
                >
                  <p className="text-sm font-mono text-foreground/80 break-all bg-background p-2 rounded group-hover:bg-secondary transition-colors select-all">
                    {wallet.publicKey}
                  </p>
                  <span className={`absolute top-1 right-1 text-xs px-1.5 py-0.5 rounded transition-all duration-200 ${copiedAddress === wallet.id
                    ? 'bg-green-600 text-foreground opacity-100'
                    : 'bg-secondary text-muted-foreground opacity-0 group-hover:opacity-100'
                    }`}>
                    {copiedAddress === wallet.id ? '✓ Copied!' : 'Copy'}
                  </span>
                </div>
              </div>

              <div>
                <p className="text-sm text-muted-foreground mb-1">Balance</p>
                <p className="text-xl font-semibold text-foreground">
                  {(wallet.balance ?? 0).toFixed(4)} SOL
                </p>
              </div>

              <div className="flex gap-3 pt-3">
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => updateBalance(wallet.id)}
                  disabled={balanceUpdating[wallet.id]}
                  className="flex-1 min-w-0 text-center justify-center"
                >
                  <span className="truncate">
                    {balanceUpdating[wallet.id] ? 'Updating...' : 'Update Balance'}
                  </span>
                </Button>
              </div>

              {/* Secondary action buttons - Responsive grid */}
              <div className="grid grid-cols-3 gap-2 mt-3">
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => {
                    setHoldingsWallet(wallet);
                    setTokenHoldingsOpen(true);
                  }}
                  className="min-w-0 justify-center px-2 text-sm"
                >
                  <Coins className="w-4 h-4 mr-2" />
                  <span className="truncate">Holdings</span>
                </Button>
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => {
                    setSelectedWallet(wallet);
                    setTransferDialogOpen(true);
                  }}
                  className="min-w-0 justify-center px-2 text-sm"
                >
                  <Send className="w-4 h-4 mr-2" />
                  <span className="truncate">Transfer</span>
                </Button>
                <Button
                  size="default"
                  variant="outline"
                  onClick={() => {
                    setHoldingsWallet(wallet);
                    setTokenHoldingsOpen(true);
                  }}
                  className="min-w-0 justify-center px-2 text-sm"
                >
                  <Coins className="w-4 h-4 mr-2" />
                  <span className="truncate">Tokens</span>
                </Button>
              </div>

              {/* Management buttons - hidden for read-only profile wallet */}
              {wallet.wallet_type !== 'profile-readonly' && (
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <Button
                    size="default"
                    variant="outline"
                    onClick={() => {
                      setSelectedWallet(wallet);
                      setConfirmRevealOpen(true);
                    }}
                    className="min-w-0 justify-center px-2 text-sm"
                  >
                    <Eye className="w-4 h-4 mr-2" />
                    <span className="truncate">Show Key</span>
                  </Button>
                  <Button
                    size="default"
                    variant="outline"
                    onClick={() => {
                      setSelectedWallet(wallet);
                      setDeleteDialogOpen(true);
                    }}
                    className="min-w-0 justify-center px-2 text-sm text-red-400 hover:text-red-300 border-red-400 hover:border-red-300"
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    <span className="truncate">Delete</span>
                  </Button>
                </div>
              )}


              {/* Private Key Display — ephemeral, auto-clears after 60s (FIX-12) */}
              {showPrivateKey[wallet.id] && oneTimeKey?.walletId === wallet.id && (
                <div className="mt-4 p-3 bg-red-900/20 border border-red-500 rounded-lg">
                  <p className="text-red-200 text-xs mb-2">🔑 Private Key (auto-hides in 60s — Keep Secret!)</p>
                  <p className="text-xs font-mono text-red-100 break-all bg-black/30 p-2 rounded">
                    {oneTimeKey.key}
                  </p>
                  <div className="flex gap-2 mt-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copyToClipboard(oneTimeKey.key)}
                      className="flex-1"
                    >
                      <Copy className="w-3 h-3 mr-1" />
                      Copy to Clipboard
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (oneTimeKeyTimer.current) clearTimeout(oneTimeKeyTimer.current);
                        setOneTimeKey(null);
                        setShowPrivateKey(prev => ({ ...prev, [wallet.id]: false }));
                      }}
                    >
                      <EyeOff className="w-3 h-3 mr-1" />
                      Hide
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {wallets.length === 0 && !loading && (
        <Card className="glass border-border">
          <CardContent className="text-center py-12">
            <Wallet className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-foreground mb-2">No Wallets Found</h3>
            <p className="text-muted-foreground mb-4">Create your first server-managed wallet to get started</p>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Create First Wallet          </Button>
          </CardContent>
        </Card>
      )}

      {/* Token Holdings Dialog */}
      {holdingsWallet && (
        <TokenHoldings
          walletId={holdingsWallet.id}
          walletName={holdingsWallet.name}
          open={tokenHoldingsOpen}
          onOpenChange={setTokenHoldingsOpen}
        />
      )}
    </div>
  );
};
