import React, { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { startTradeToasts } from '../lib/tradeToasts';
import { LayoutDashboard, History, LineChart, Settings as SettingsIcon, Wallet, Target, Briefcase, ArrowDownUp } from 'lucide-react';
import ElectronWalletButton from './ElectronWalletButton';
import GlobalSettingsMenu from './GlobalSettingsMenu';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAuth } from '../contexts/AuthContext';

interface LayoutProps {
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const { disconnect } = useWallet();
  const { isAuthenticated, user, logout, sessionToken } = useAuth();
  const walletAddress = user?.walletAddress;

  // App-wide trade toasts: green buys / red sells, bottom-right, 10s each.
  // Singleton — safe to call on every layout mount.
  useEffect(() => {
    if (isAuthenticated) startTradeToasts(sessionToken);
  }, [isAuthenticated, sessionToken]);

  const handleDisconnect = async () => {
    try {
      console.log('🔌 Disconnecting wallet...');
      await logout(); // Clear auth context first
      await disconnect(); // Then disconnect wallet
      console.log('✅ Wallet disconnected successfully');
    } catch (error) {
      console.error('❌ Error disconnecting wallet:', error);
    }
  };

  const navigation = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard },
    { name: 'Sniper', href: '/sniper', icon: Target },
    { name: 'Swap', href: '/swap', icon: ArrowDownUp },
    { name: 'Wallets', href: '/wallets', icon: Wallet },
    { name: 'Transactions', href: '/transactions', icon: History },
    { name: 'Analytics', href: '/analytics', icon: LineChart },
    { name: 'Settings', href: '/settings', icon: SettingsIcon },
  ];

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Sidebar */}
      <div className="fixed inset-y-0 left-0 w-64 glass transition-all duration-300 z-50">
        <div className="flex h-16 items-center justify-between px-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="logo-scale-in">
              <img
                src="/assets/abotlogo.svg"
                alt="Autobot Logo"
                className="h-8 w-8 object-contain"
              />
            </div>
            <h1 className="text-xl font-bold gradient-text">Autobot App</h1>
          </div>
        </div>
        <nav className="mt-6">
          <div className="space-y-1 px-2">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`
                    group flex items-center px-2 py-2 text-sm font-medium rounded-md
                    transition-all duration-200 hover-card
                    ${location.pathname === item.href
                      ? 'bg-primary/10 text-primary neon-glow'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }
                  `}
                >
                  <Icon className="mr-3 h-6 w-6 transition-transform duration-200 group-hover:scale-110" />
                  {item.name}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>

      {/* Main content */}
      <div className="flex-1 ml-64">
        <header className="h-16 glass border-b border-border flex items-center justify-end px-4 gap-4 relative z-50">
          {/* Global settings gear (audit §8.1) */}
          <GlobalSettingsMenu />
          {isAuthenticated ? (
            <div className="flex items-center space-x-3">
              <div className="text-right">
                <div className="text-sm text-green-500 font-medium">✓ Profile Connected</div>
                <div className="text-xs text-muted-foreground">
                  {walletAddress?.slice(0, 4)}...{walletAddress?.slice(-4)}
                </div>
              </div>
              {/* Soft red on glass — matches the app theme instead of a solid alert-red block */}
              <button
                onClick={handleDisconnect}
                className="glass border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:border-red-500/50 font-medium h-10 px-4 rounded-lg transition-all duration-200"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="flex items-center space-x-3">
              <div className="text-right">
                <div className="text-sm text-yellow-500 font-medium">⚠ No Profile Connected</div>
                <div className="text-xs text-muted-foreground">Connect to access your data</div>
              </div>
              <ElectronWalletButton className="!bg-blue-600 !hover:bg-blue-700 !text-white !font-medium !h-10 !px-6 !rounded-lg !transition-all !shadow-lg hover:!scale-105" />
            </div>
          )}
        </header>
        <main className="p-6 animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
};

export default Layout;
