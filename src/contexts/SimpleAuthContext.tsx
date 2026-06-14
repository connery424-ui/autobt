import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

interface AuthContextType {
  isAuthenticated: boolean;
  walletAddress: string | null;
  connect: () => void;
  disconnect: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { connected, publicKey, disconnect: walletDisconnect } = useWallet();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  // Update authentication state when wallet changes
  useEffect(() => {
    if (connected && publicKey) {
      const address = publicKey.toString();
      setIsAuthenticated(true);
      setWalletAddress(address);
      // NOTE: Do NOT store tokens in localStorage — sessions are managed via HttpOnly cookie (AuthContext)
    } else {
      setIsAuthenticated(false);
      setWalletAddress(null);
      localStorage.removeItem('autobot_session_token'); // clean up legacy key if present
    }
  }, [connected, publicKey]);


  const connect = () => {
    // Connection is handled by the WalletMultiButton
    // This is just a placeholder
  };

  const disconnect = async () => {
    await walletDisconnect();
    setIsAuthenticated(false);
    setWalletAddress(null);
    localStorage.removeItem('autobot_session_token');
    localStorage.removeItem('activeWalletAddress');

    // Clear all user data
    localStorage.removeItem('persist:root');
    localStorage.removeItem('managedWallets');
    localStorage.removeItem('transactions');
    localStorage.removeItem('sniperConfigs');

    // Force reload to clear state
    window.location.reload();
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, walletAddress, connect, disconnect }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
