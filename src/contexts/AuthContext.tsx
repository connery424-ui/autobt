// Authentication Context for SolSniper Frontend
// SIWS (Sign-In With Solana) + HttpOnly Cookie sessions
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';

interface User {
  id: string;
  walletAddress: string;
  username?: string;
  createdAt: Date;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (token?: string, walletAddress?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  // sessionToken is intentionally null — JWT lives in HttpOnly cookie only
  sessionToken: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const { connected, publicKey, signMessage } = useWallet();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // sessionToken lives in React state only — never written to localStorage
  // JWT is authoritative in the HttpOnly cookie; this is just a convenience copy
  const [sessionToken, setSessionToken] = useState<string | null>(null);

  // ── On mount: verify any existing session (cookie OR Electron Bearer) ─────
  useEffect(() => {
    const checkExistingAuth = async () => {
      try {
        // Send cookie + Bearer in ONE request.
        // Backend middleware checks cookie first, falls back to Bearer — so either
        // credential authenticates in a single round-trip with zero 401s.
        const electronToken = localStorage.getItem('auth_token');
        const headers: HeadersInit = {};
        if (electronToken) {
          headers['Authorization'] = `Bearer ${electronToken}`;
        }

        const response = await fetch('/api/auth/verify', {
          credentials: 'include', // sends cookie automatically if present
          headers,                // also sends Bearer if auth_token in localStorage
        });

        if (response.ok) {
          const data = await response.json();
          if (data.valid && data.user) {
            console.log('✅ Auth verified, user:', data.user.walletAddress);
            setUser({ id: data.user.id, walletAddress: data.user.walletAddress, createdAt: new Date() });
            if (data.token) setSessionToken(data.token);
            else if (electronToken) setSessionToken(electronToken);
            setIsLoading(false);
            return;
          }
        }

        // Truly unauthenticated — clear any stale token
        if (electronToken) {
          console.log('⚠️ Auth token invalid — clearing');
          localStorage.removeItem('auth_token');
        }
        // Clean up legacy keys
        localStorage.removeItem('solsniper_session_token');
      } catch (error) {
        console.log('⚠️ Auth check failed (network?):', error);
      }

      setIsLoading(false);
    };

    checkExistingAuth();
  }, []);


  // ── Handle wallet adapter connection (SIWS browser flow) ──────────────────
  useEffect(() => {
    if (isLoading) return; // Wait for initial check

    const walletAddress = publicKey?.toString();
    console.log('AuthContext: Wallet state changed', { connected, publicKey: walletAddress });

    // Skip if not connected, no address, or already authenticated for this wallet
    if (!connected || !walletAddress) return;
    if (user?.walletAddress === walletAddress) return;

    (async () => {
      try {
        // Step 1: Request nonce + message from server
        const nonceResp = await fetch('/api/auth/nonce-siws', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ walletAddress }),
          credentials: 'include',
        });

        if (!nonceResp.ok) {
          console.error('❌ AuthContext: nonce request failed', nonceResp.status);
          return;
        }

        const { nonce, message } = await nonceResp.json();

        // Step 2: Ask wallet to sign the message (Phantom popup — no gas, no tx)
        let signatureB58: string;
        if (signMessage) {
          const msgBytes = new TextEncoder().encode(message);
          const signatureBytes = await signMessage(msgBytes);
          signatureB58 = bs58.encode(signatureBytes);
        } else {
          // Fallback for wallets that don't implement signMessage (rare)
          console.warn('⚠️ Wallet does not support signMessage — falling back to unsigned login');
          signatureB58 = '';
        }

        // Step 3: POST to wallet-login with signature (server sets HttpOnly cookie)
        const loginResp = await fetch('/api/auth/wallet-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include', // required for the Set-Cookie to be accepted
          body: JSON.stringify({
            walletAddress,
            ...(signatureB58 ? { signature: signatureB58, message, nonce } : {}),
          }),
        });

        if (loginResp.ok) {
          const data = await loginResp.json();
          if (data.success) {
            console.log('✅ AuthContext: SIWS login success, cookie set by server');
            setUser({
              id: data.user.id,
              walletAddress: data.user.walletAddress,
              username: `User_${walletAddress.slice(0, 8)}`,
              createdAt: new Date(),
            });

            // Electron path: server returns token in body when no sig was sent
            if (data.token) {
              localStorage.setItem('auth_token', data.token);
              setSessionToken(data.token);
            }
          } else {
            console.error('❌ AuthContext: wallet-login returned unexpected data', data);
          }
        } else {
          console.error('❌ AuthContext: wallet-login HTTP error', loginResp.status, loginResp.statusText);
        }
      } catch (err) {
        console.error('❌ AuthContext: SIWS login failed', err);
      }
    })();
  }, [connected, publicKey, isLoading]); // user intentionally excluded — guard prevents re-login

  const login = async (token?: string, walletAddress?: string) => {
    if (token && walletAddress) {
      // Electron flow — token provided directly in body (pairing code)
      localStorage.setItem('auth_token', token);
      setSessionToken(token);
      setUser({
        id: walletAddress,
        walletAddress: walletAddress,
        createdAt: new Date()
      });
      console.log('✅ Logged in via Electron pairing:', walletAddress);
    }
  };

  const logout = async () => {
    try {
      // Clear server-side HttpOnly cookie
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch { /* ignore */ }

    setUser(null);
    setSessionToken(null);
    // Clean up any Electron localStorage tokens
    localStorage.removeItem('auth_token');
    localStorage.removeItem('solsniper_session_token');
    console.log('✅ User logged out');
  };

  const refreshUser = async () => {
    try {
      // Try cookie path first
      let response = await fetch('/api/auth/verify', { credentials: 'include' });
      // Fall back to Bearer if cookie not present (Electron)
      if (!response.ok) {
        const electronToken = localStorage.getItem('auth_token');
        if (electronToken) {
          response = await fetch('/api/auth/verify', {
            headers: { 'Authorization': `Bearer ${electronToken}` },
            credentials: 'include',
          });
        }
      }
      if (response.ok) {
        const data = await response.json();
        if (data.valid && data.user) {
          setUser(prev => prev ? { ...prev, walletAddress: data.user.walletAddress } : null);
          if (data.token) setSessionToken(data.token);
        }
      }
    } catch { /* ignore */ }
  };


  const isAuthenticated = !!user;

  const value: AuthContextType = {
    user,
    isAuthenticated,
    isLoading,
    login,
    logout,
    refreshUser,
    sessionToken
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

// Higher-order component for protected routes
export const withAuth = <P extends object>(Component: React.ComponentType<P>) => {
  return (props: P) => {
    const { isAuthenticated, isLoading } = useAuth();

    if (isLoading) {
      return (
        <div className="flex items-center justify-center h-screen">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600"></div>
        </div>
      );
    }

    if (!isAuthenticated) {
      return (
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <h2 className="text-2xl font-bold mb-4">Welcome to SolSniper</h2>
            <p className="text-gray-600 mb-6">Connect your wallet to access your dashboard</p>
            <button
              onClick={() => window.location.reload()}
              className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
            >
              Connect Wallet
            </button>
          </div>
        </div>
      );
    }

    return <Component {...props} />;
  };
};

// Component for connecting wallet
export const ConnectWalletButton: React.FC = () => {
  const { isLoading } = useAuth();
  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnect = async () => {
    try {
      setIsConnecting(true);

      if (!window.solana?.isPhantom) {
        throw new Error('Phantom wallet not found. Please install Phantom wallet.');
      }

      await window.solana.connect();
      // AuthContext's useEffect will pick up the wallet connection and trigger SIWS

    } catch (error) {
      console.error('Connection failed:', error);
      alert('Failed to connect wallet: ' + (error as Error).message);
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <button
      onClick={handleConnect}
      disabled={isConnecting || isLoading}
      className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-bold py-2 px-4 rounded flex items-center space-x-2"
    >
      {isConnecting ? (
        <>
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
          <span>Connecting...</span>
        </>
      ) : (
        <>
          <span>Connect Wallet</span>
        </>
      )}
    </button>
  );
};

// Types for Phantom wallet
declare global {
  interface Window {
    solana?: {
      isPhantom?: boolean;
      isConnected?: boolean;
      connect(): Promise<{ publicKey: { toString(): string } }>;
      disconnect(): Promise<void>;
      signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
    };
  }
}
