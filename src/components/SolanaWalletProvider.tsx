import React, { useState, useEffect } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { CoinbaseWalletAdapter } from '@solana/wallet-adapter-coinbase';
import { WalletConnectWalletAdapter } from '@solana/wallet-adapter-walletconnect';

// Build-time fallback — will be immediately overridden by server fetch below
const VITE_KEY = import.meta.env.VITE_HELIUS_API_KEY;
const VITE_NET = import.meta.env.VITE_SOLANA_NETWORK || 'mainnet';
const FALLBACK_ENDPOINT = VITE_KEY
  ? `https://${VITE_NET}.helius-rpc.com/?api-key=${VITE_KEY}`
  : 'https://api.mainnet-beta.solana.com';

const SolanaWalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Start with baked VITE_ value, fetch DB value immediately
  const [endpoint, setEndpoint] = useState(FALLBACK_ENDPOINT);
  const [network, setNetwork] = useState<string>(VITE_NET);

  useEffect(() => {
    fetch('/api/config/rpc-endpoint')
      .then(r => r.json())
      .then(data => {
        if (data.rpcUrl) setEndpoint(data.rpcUrl);
        if (data.network) setNetwork(data.network);
      })
      .catch(() => { }); // keep build-time value if server unreachable
  }, []);

  const wallets = React.useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter({ network: network as any }),
    new CoinbaseWalletAdapter(),
    new WalletConnectWalletAdapter({
      network: network as any,
      options: {
        projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'default-project-id',
      }
    }),
  ], [network]);

  const onError = React.useCallback((error: any) => {
    console.error('Wallet error:', error);
  }, []);

  // On the standalone /wallet-connect page, autoConnect must be OFF. With it on, the
  // adapter fires a silent (gesture-less) connect on load; against a LOCKED wallet that
  // leaves the adapter wedged in `connecting`, so the user's later click never reaches
  // the wallet and Phantom never queues its unlock prompt. With autoConnect off, the
  // only connect attempt is the user's button click — a real gesture — so the wallet
  // queues the unlock and continues, like every other dApp.
  const isWalletConnectPage =
    typeof window !== 'undefined' && window.location.pathname.startsWith('/wallet-connect');

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} onError={onError} autoConnect={!isWalletConnectPage}>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

export default SolanaWalletProvider;

