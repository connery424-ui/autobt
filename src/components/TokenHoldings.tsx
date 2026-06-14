import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Coins, RefreshCw, DollarSign, ExternalLink, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

interface TokenHolding {
  mint: string;
  balance: number;
  decimals: number;
  amount: string;
  uiAmount: number | null;
  symbol?: string;
  name?: string;
  logoURI?: string;
  price?: number;
  value?: number;
}

interface TokenHoldingsProps {
  walletId: string;
  walletName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const TokenHoldings: React.FC<TokenHoldingsProps> = ({
  walletId,
  walletName,
  open,
  onOpenChange,
}) => {
  const [holdings, setHoldings] = useState<TokenHolding[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { sessionToken } = useAuth();

  const fetchTokenHoldings = useCallback(async () => {
    if (!walletId || !sessionToken) return;
    
    setLoading(true);
    setError(null);
    
    try {
      // Fetch with metadata for enhanced display
      const response = await fetch(`/api/wallets/${walletId}/token-holdings?includeMetadata=true`, {
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) {
        throw new Error('Failed to fetch token holdings');
      }
      
      const data = await response.json();
      setHoldings(data.holdings || []);
    } catch (err: any) {
      setError(err.message);
      console.error('Error fetching token holdings:', err);
    } finally {
      setLoading(false);
    }
  }, [walletId, sessionToken]); // Add sessionToken as dependency

  useEffect(() => {
    if (open && walletId) {
      fetchTokenHoldings();
    }
  }, [open, walletId, fetchTokenHoldings]); // Add fetchTokenHoldings to dependencies

  const formatTokenAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  const openSolscan = (mintAddress: string) => {
    window.open(`https://solscan.io/token/${mintAddress}`, '_blank');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden relative">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <Coins className="w-5 h-5 text-blue-500" />
            Token Holdings - {walletName}
          </DialogTitle>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="h-6 w-6 p-0 hover:bg-secondary absolute top-2 right-2"
            title="Close"
          >
            <X className="w-4 h-4" />
          </Button>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div className="text-sm text-muted-foreground">
              {holdings.length > 0 ? `${holdings.length} tokens found` : 'No tokens found'}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={fetchTokenHoldings}
              disabled={loading}
              className="flex items-center gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>

          {error && (
            <div className="p-3 bg-red-900/20 border border-red-500/20 rounded text-red-400 text-sm">
              {error}
            </div>
          )}

          <div className="max-h-[60vh] overflow-y-auto space-y-3">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="w-6 h-6 animate-spin text-blue-500" />
                <span className="ml-2 text-muted-foreground">Loading token holdings...</span>
              </div>
            ) : holdings.length === 0 && !error ? (
              <div className="text-center py-8 text-muted-foreground">
                <Coins className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>No token holdings found</p>
                <p className="text-sm">This wallet only contains SOL</p>
              </div>
            ) : (
              holdings.map((holding, index) => (
                <Card key={`${holding.mint}-${index}`} className="bg-secondary/50 border-border">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-8 h-8 bg-secondary rounded-full flex items-center justify-center">
                            <Coins className="w-4 h-4 text-muted-foreground" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-white">
                                {holding.symbol || 'Unknown Token'}
                              </span>
                              {holding.name && (
                                <span className="text-sm text-muted-foreground">
                                  {holding.name}
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() => copyToClipboard(holding.mint)}
                              className="text-xs text-muted-foreground hover:text-foreground/80 font-mono"
                              title="Click to copy address"
                            >
                              {formatTokenAddress(holding.mint)}
                            </button>
                          </div>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <span className="text-muted-foreground">Balance:</span>
                            <div className="font-medium text-white">
                              {holding.balance.toLocaleString(undefined, {
                                maximumFractionDigits: holding.decimals > 6 ? 6 : holding.decimals
                              })}
                            </div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Decimals:</span>
                            <div className="font-medium text-white">{holding.decimals}</div>
                          </div>
                        </div>

                        {holding.price && (
                          <div className="mt-2 text-sm">
                            <span className="text-muted-foreground">Price:</span>
                            <span className="ml-2 font-medium text-green-400">
                              ${holding.price.toFixed(6)}
                            </span>
                            {holding.value && (
                              <span className="ml-2 text-muted-foreground">
                                (≈ ${holding.value.toFixed(2)})
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col gap-2 ml-4">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openSolscan(holding.mint)}
                          className="flex items-center gap-1"
                        >
                          <ExternalLink className="w-3 h-3" />
                          View
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default TokenHoldings;
