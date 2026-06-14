import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';

interface ManagedWallet {
  id: string;
  name: string;
  publicKey: string;
  balance: number;
  isActive: boolean;
  createdAt: string;
}

interface UseManagedWalletsReturn {
  wallets: ManagedWallet[];
  activeWallet: ManagedWallet | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  setActiveWallet: (walletId: string) => Promise<void>;
}

export const useManagedWallets = (): UseManagedWalletsReturn => {
  const { sessionToken, isAuthenticated } = useAuth();
  const [wallets, setWallets] = useState<ManagedWallet[]>([]);
  const [activeWallet, setActiveWalletState] = useState<ManagedWallet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchWallets = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // 🚨 SECURITY FIX: Check for authentication before fetching
      if (!isAuthenticated || !sessionToken) {
        console.log('🔒 No authentication - not loading wallets');
        setWallets([]);
        setActiveWalletState(null);
        localStorage.removeItem('activeWalletAddress');
        setLoading(false);
        return;
      }

      console.log('🔐 Fetching wallets with token:', sessionToken.substring(0, 20) + '...');

      const response = await fetch('/api/wallets/secure', {
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });

      if (response.status === 401) {
        // Token may be valid but user record not yet committed (race condition on first login).
        // Retry once after a short delay before giving up.
        console.log('🔒 Got 401 — retrying wallet fetch in 800ms (race condition guard)...');
        await new Promise(resolve => setTimeout(resolve, 800));
        const retry = await fetch('/api/wallets/secure', {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (retry.status === 401) {
          // Still failing — genuine auth problem, clear
          console.log('🔒 Authentication failed (retry also 401) - clearing wallet data');
          localStorage.removeItem('solsniper_session_token');
          localStorage.removeItem('activeWalletAddress');
          setWallets([]);
          setActiveWalletState(null);
          setError('Authentication required. Please connect your profile wallet.');
          setLoading(false);
          return;
        }
        // Retry succeeded — fall through with the retry response
        const retryData = await retry.json();
        if (retry.ok) {
          setWallets(retryData.wallets || []);
          const active = retryData.wallets?.find((w: ManagedWallet) => w.isActive);
          setActiveWalletState(active || null);
          if (active) localStorage.setItem('activeWalletAddress', active.publicKey);
          else localStorage.removeItem('activeWalletAddress');
        }
        setLoading(false);
        return;
      }


      const data = await response.json();

      if (response.ok) {
        setWallets(data.wallets || []);

        // Find and set the active wallet - only update if it actually changed
        const active = data.wallets?.find((w: ManagedWallet) => w.isActive);

        // Only update activeWallet state if the ID changed (prevent unnecessary re-renders)
        setActiveWalletState(prevActive => {
          if (!prevActive && !active) return null;
          if (!prevActive && active) return active;
          if (prevActive && !active) return null;
          if (prevActive && active && prevActive.id !== active.id) return active;
          // IDs are the same, check if we need to update other properties
          if (prevActive && active && JSON.stringify(prevActive) !== JSON.stringify(active)) return active;
          return prevActive; // No change, keep the same reference
        });

        // Store active wallet address in localStorage for transaction sync
        if (active) {
          localStorage.setItem('activeWalletAddress', active.publicKey);
        } else {
          localStorage.removeItem('activeWalletAddress');
        }
      } else {
        setError(data.error || 'Failed to fetch wallets');
      }
    } catch (err) {
      setError('Network error fetching wallets');
      console.error('Error fetching managed wallets:', err);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, sessionToken]); // Add dependencies

  const setActiveWallet = useCallback(async (walletId: string) => {
    try {
      // 🚨 SECURITY FIX: Check authentication before setting active wallet
      if (!isAuthenticated || !sessionToken) {
        setError('Authentication required. Please connect your profile wallet.');
        return;
      }

      const response = await fetch(`/api/wallets/${walletId}/activate-secure`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });

      if (response.status === 401) {
        setError('Authentication expired. Please reconnect your profile wallet.');
        return;
      }

      if (response.ok) {
        // Refetch wallets to update active status and localStorage
        await fetchWallets();
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to set active wallet');
      }
    } catch (err) {
      setError('Network error setting active wallet');
      console.error('Error setting active wallet:', err);
    }
  }, [isAuthenticated, sessionToken, fetchWallets]); // Add dependencies

  useEffect(() => {
    // 🚨 SECURITY FIX: Only fetch wallets if we have authentication
    if (isAuthenticated && sessionToken) {
      console.log('🔐 Auth context ready - fetching wallets');
      fetchWallets();
    } else {
      console.log('🔒 No authentication - not auto-loading wallets');
      setWallets([]);
      setActiveWalletState(null);
      setLoading(false);
    }
  }, [isAuthenticated, sessionToken]); // fetchWallets intentionally omitted — it only depends on these same values

  return {
    wallets,
    activeWallet,
    loading,
    error,
    refetch: fetchWallets,
    setActiveWallet,
  };
};
