import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { Wallet, Import, X } from 'lucide-react';
import { Button } from './ui/button';
import { toast } from '../lib/toast-shim';

const WalletConnect = () => {
  const { publicKey, connected, select, connect, disconnect, wallets } = useWallet();
  const [showModal, setShowModal] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const walletOptions = [
    {
      name: 'Phantom',
      walletName: 'Phantom',
      icon: '�',
      description: 'A friendly Solana wallet'
    },
    {
      name: 'Solflare',
      walletName: 'Solflare', 
      icon: '🌟',
      description: 'Solana ecosystem wallet'
    },
    {
      name: 'Coinbase Wallet',
      walletName: 'Coinbase Wallet',
      icon: '🔵',
      description: 'Secure crypto wallet'
    },
    {
      name: 'WalletConnect',
      walletName: 'WalletConnect',
      icon: '🔗',
      description: 'Connect any wallet'
    }
  ];

  const handleConnectClick = () => {
    console.log("Connect button clicked");
    console.log("Available wallets:", wallets.map((w: any) => ({ name: w.adapter.name, readyState: w.adapter.readyState })));
    if (connected) {
      disconnect();
    } else {
      setShowModal(true);
    }
  };

  const handleWalletSelect = async (walletName: string) => {
    try {
      setConnecting(true);
      
      console.log('Available wallets:', wallets.map((w: any) => w.adapter.name));
      console.log('Attempting to connect to:', walletName);
      
      // Find the wallet adapter by name (try exact match first, then partial match)
      let walletAdapter = wallets.find((wallet: any) => wallet.adapter.name === walletName);
      
      if (!walletAdapter) {
        // Try partial match for wallets with different naming
        walletAdapter = wallets.find((wallet: any) => 
          wallet.adapter.name.toLowerCase().includes(walletName.toLowerCase()) ||
          walletName.toLowerCase().includes(wallet.adapter.name.toLowerCase())
        );
      }
      
      if (!walletAdapter) {
        console.error(`Wallet ${walletName} not found. Available wallets:`, wallets.map((w: any) => w.adapter.name));
        toast.error(`${walletName} wallet is not available. Please install the wallet extension.`);
        throw new Error(`Wallet ${walletName} not found`);
      }

      console.log('Found wallet adapter:', walletAdapter.adapter.name);

      // Select the wallet
      select(walletAdapter.adapter.name);
      
      // Small delay to allow selection to register
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Connect to the wallet
      await connect();
      
      setShowModal(false);
      console.log(`Successfully connected to ${walletAdapter.adapter.name}`);
      toast.success(`Successfully connected to ${walletAdapter.adapter.name}`);
    } catch (error) {
      console.error('Failed to connect wallet:', error);
      toast.error(error instanceof Error ? error.message : "Failed to connect wallet");
    } finally {
      setConnecting(false);
    }
  };

  return (
    <>
      <div className="flex items-center">
        <Button
          onClick={handleConnectClick}
          variant={connected ? "outline" : "default"}
          className={connected ? 
            "glass hover:bg-primary/10" : 
            "glass bg-gradient-to-r from-primary/90 to-primary hover:opacity-90 transition-all shadow-lg scale-100 hover:scale-105"
          }
          size="sm"
        >
          {connected ? (
            <Wallet className="w-4 h-4 mr-2" />
          ) : (
            <Import className="w-4 h-4 mr-2" />
          )}
          
          {connected && publicKey ? (
            <span className="font-mono">{publicKey.toString().slice(0, 4)}...{publicKey.toString().slice(-4)}</span>
          ) : (
            'Connect Wallet'
          )}
        </Button>
      </div>

      {/* Wallet Selection Modal */}
      {showModal && createPortal(
        <div 
          className="fixed inset-0 z-[99999] flex items-center justify-center p-4"
          style={{ zIndex: 999999 }}
        >
          {/* Darkened overlay */}
          <div 
            className="absolute inset-0 bg-black/85 backdrop-blur-md"
            onClick={() => setShowModal(false)}
          />
          
          {/* Modal content */}
          <div 
            className="relative z-[100000] w-full max-w-md animate-scale-in"
            style={{ zIndex: 1000000 }}
          >
            <div className="glass border border-border/50 rounded-xl p-6 space-y-4 shadow-2xl bg-background/95 backdrop-blur-xl border-white/20">
              {/* Header */}
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold text-white">Connect Wallet</h2>
                <button
                  onClick={() => setShowModal(false)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Wallet options */}
              <div className="space-y-3">
                {walletOptions.map((wallet) => {
                  // Check wallet readyState - WalletReadyState.Installed means it's available
                  const walletAdapter = wallets.find((w: any) => 
                    w.adapter.name === wallet.walletName ||
                    w.adapter.name.toLowerCase().includes(wallet.walletName.toLowerCase()) ||
                    wallet.walletName.toLowerCase().includes(w.adapter.name.toLowerCase())
                  );
                  
                  const isAvailable = walletAdapter && walletAdapter.adapter.readyState === 'Installed';
                  
                  console.log(`Wallet ${wallet.name}:`, {
                    found: !!walletAdapter,
                    readyState: walletAdapter?.adapter.readyState,
                    isAvailable
                  });
                  
                  return (
                    <button
                      key={wallet.walletName}
                      onClick={() => handleWalletSelect(wallet.walletName)}
                      disabled={connecting || !isAvailable}
                      className={`w-full flex items-center gap-4 p-4 rounded-xl border transition-all
                        ${isAvailable 
                          ? 'border-border/60 hover:border-primary/60 hover:bg-primary/15 bg-white/10 backdrop-blur-sm shadow-lg hover:shadow-xl cursor-pointer transform hover:scale-[1.02]' 
                          : 'border-red-500/40 bg-red-900/10 opacity-70 cursor-not-allowed'
                        } 
                        ${connecting ? 'disabled:opacity-50 disabled:cursor-not-allowed' : ''}`}
                    >
                      <div className="text-2xl">{wallet.icon}</div>
                      <div className="flex-1 text-left">
                        <div className={`font-medium ${isAvailable ? 'text-white' : 'text-red-300'}`}>
                          {wallet.name}
                          {!isAvailable && ' (Not Installed)'}
                        </div>
                        <div className={`text-sm ${isAvailable ? 'text-gray-300' : 'text-red-400'}`}>
                          {isAvailable ? wallet.description : 'Install extension to connect'}
                        </div>
                      </div>
                      {!isAvailable && (
                        <div className="text-red-400 text-xs">
                          ❌
                        </div>
                      )}
                      {connecting && (
                        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      )}
                    </button>
                  );
                })}
              </div>
              
              {/* Help text for wallet installation */}
              <div className="text-center text-sm text-gray-400 border-t border-border/30 pt-3">
                <p>Don't have a wallet? Install one from your browser's extension store.</p>
                <p className="text-xs mt-1">Phantom and Solflare are recommended for Solana.</p>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default WalletConnect;
