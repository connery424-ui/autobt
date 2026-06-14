import { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

/**
 * Unified auth hook — checks HttpOnly cookie session first (browser flow),
 * then Electron JWT from localStorage (Electron pairing flow).
 */
export const useWalletAuth = () => {
  const { connected, publicKey, disconnect } = useWallet();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const checkAuth = async () => {
      // 1. Check HttpOnly cookie session (browser flow — cookie sent automatically)
      try {
        const res = await fetch('/api/auth/verify', { credentials: 'include' });
        if (!cancelled && res.ok) {
          const data = await res.json();
          if (data.valid && data.user) {
            setIsAuthenticated(true);
            setWalletAddress(data.user.walletAddress || data.user.id);
            return;
          }
        }
      } catch {
        // Network error — don't update state
        if (!cancelled) setIsAuthenticated(false);
        return;
      }

      // 2. Check Electron auth_token (Bearer flow)
      const electronToken = localStorage.getItem('auth_token');
      if (electronToken) {
        try {
          const res = await fetch('/api/auth/verify', {
            headers: { 'Authorization': `Bearer ${electronToken}` },
          });
          if (!cancelled) {
            if (res.ok) {
              const data = await res.json();
              if (data.valid && data.user) {
                setIsAuthenticated(true);
                setWalletAddress(data.user.walletAddress || data.user.id);
                return;
              }
            }
            // Token invalid (e.g. DB wiped) — clear it so Connect button shows
            console.warn('⚠️ auth_token invalid, clearing');
            localStorage.removeItem('auth_token');
          }
        } catch {
          if (!cancelled) setIsAuthenticated(false);
          return;
        }
      }

      // 3. Fall back to wallet adapter state (no verified session)
      if (!cancelled) {
        if (connected && publicKey) {
          setIsAuthenticated(true);
          setWalletAddress(publicKey.toString());
        } else {
          setIsAuthenticated(false);
          setWalletAddress(null);
        }
      }
    };

    checkAuth();
    return () => { cancelled = true; };
  }, [connected, publicKey]);

  const logout = async () => {
    try {
      // Clear HttpOnly cookie server-side
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      // Clear Electron localStorage tokens
      localStorage.removeItem('auth_token');
      localStorage.removeItem('solsniper_session_token');
      localStorage.removeItem('autobot_session_token');
      localStorage.removeItem('activeWalletAddress');
      await disconnect();
    } catch { /* ignore */ }
    setIsAuthenticated(false);
    setWalletAddress(null);
    window.location.reload();
  };

  return { isAuthenticated, walletAddress, logout, connected, publicKey };
};
