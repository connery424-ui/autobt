import { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

const useWalletBalance = () => {
  const { publicKey, connected } = useWallet();
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchBalance = async () => {
      if (!connected || !publicKey) {
        console.log('❌ Wallet not connected or no public key');
        setBalance(null);
        return;
      }

      console.log('🔄 Fetching balance from backend for:', publicKey.toString());
      setLoading(true);
      setError(null);

      try {
        // Use our backend endpoint instead of direct RPC calls
        const response = await fetch(`/api/wallet/balance/${publicKey.toString()}`);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.error) {
          throw new Error(data.error);
        }

        // Calculate balance from lamports
        const balanceInSol = data.balanceLamports?.value ? data.balanceLamports.value / 1000000000 : 0;

        console.log(`✅ Successfully fetched balance: ${balanceInSol} SOL`);
        setBalance(balanceInSol);
      } catch (err) {
        console.error('❌ Error fetching wallet balance:', err);
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        setError(errorMsg);
        setBalance(null);
      } finally {
        setLoading(false);
      }
    };

    fetchBalance();

    // Refresh balance every 30 seconds when connected
    const interval = connected ? setInterval(fetchBalance, 30000) : null;

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [connected, publicKey]);

  return { balance, loading, error, refetch: () => { } };
};

export default useWalletBalance;
