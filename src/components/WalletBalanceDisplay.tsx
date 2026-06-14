import React, { memo } from 'react';
import { AlertCircle, Wallet, Loader2 } from 'lucide-react';
import { formatPublicKey } from '../lib/solana';
import { useWallet } from '@solana/wallet-adapter-react';
import useWalletBalance from '../hooks/useWalletBalance';

// Use React.memo to prevent re-renders when props don't change
const WalletBalanceDisplay: React.FC = memo(() => {
  const { connected, publicKey } = useWallet();
  const { balance, loading, error } = useWalletBalance();
  
  const isLoading = loading;

  if (!connected || !publicKey) {
    return null;
  }

  return (
    <div className="w-full p-4 rounded-lg bg-background/70 border border-gray-800 backdrop-blur-sm">
      <div className="flex items-center space-x-2 mb-3">
        <Wallet className="h-5 w-5 text-primary" />
        <h3 className="text-lg font-semibold text-white">Wallet Connected</h3>
        {isLoading && (
          <Loader2 className="h-4 w-4 text-primary animate-spin ml-auto" />
        )}
      </div>
      
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">Address:</span>
          <span className="font-mono text-white">{formatPublicKey(publicKey.toString())}</span>
        </div>
        
        <div className="flex justify-between items-center">
          <span className="text-muted-foreground">SOL Balance:</span>
          <span className={`font-semibold ${isLoading ? 'text-muted-foreground' : 'text-white'}`}>
            {error ? 'Error' : balance !== null ? `${balance.toFixed(4)} SOL` : 'Loading...'}
          </span>
        </div>
      </div>
      
      <div className="mt-3 text-xs text-muted-foreground flex items-start space-x-1">
        <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
        <span>
          {error ? `Error: ${error}` : 'SOL is the native token of Solana used for transactions and gas fees.'}
        </span>
      </div>
    </div>
  );
});

// Add display name for debugging
WalletBalanceDisplay.displayName = 'WalletBalanceDisplay';

export { WalletBalanceDisplay }; 