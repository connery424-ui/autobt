import React, { useState, useEffect } from 'react';
import { X, ExternalLink, Copy, TrendingUp, TrendingDown, DollarSign, Activity, Globe, MessageCircle, Twitter, AlertTriangle, CheckCircle } from 'lucide-react';

interface Token {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;

  // Market data
  price: number;
  priceChange24h: number;
  volume24h: number;
  volume7d: number;
  liquidity: number;
  marketCap?: number;
  fdv?: number;

  // Pool information
  mainPool: {
    id: string;
    type: string;
    lpMint?: string;
    pairedWith: {
      symbol: string;
      address: string;
    };
  };

  // All available pools
  allPools: Array<{
    id: string;
    type: string;
    liquidity: number;
    volume24h: number;
    pairedWith: string;
  }>;

  // Timestamps
  createdAt: string;

  // Social and metadata
  website?: string;
  twitter?: string;
  telegram?: string;
  description?: string;

  // Risk assessment
  riskLevel: 'low' | 'medium' | 'high';

  source: string;
}

interface TokenDetailsModalProps {
  tokenAddress: string | null;
  isOpen: boolean;
  onClose: () => void;
  onTrade?: (action: 'buy' | 'sell', tokenAddress: string) => void;
}

const TokenDetailsModal: React.FC<TokenDetailsModalProps> = ({
  tokenAddress,
  isOpen,
  onClose,
  onTrade
}) => {
  const [token, setToken] = useState<Token | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Fetch token details
  useEffect(() => {
    if (!tokenAddress || !isOpen) {
      setToken(null);
      setError(null);
      return;
    }

    const fetchTokenDetails = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/token-feed/token/${tokenAddress}`);
        const data = await response.json();

        if (data.success) {
          setToken(data.token);
        } else {
          setError(data.error || 'Failed to fetch token details');
        }
      } catch (err) {
        setError('Network error while fetching token details');
        console.error('Error fetching token details:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchTokenDetails();
  }, [tokenAddress, isOpen]);

  // Copy to clipboard
  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Format numbers
  const formatNumber = (num: number | null | undefined, isPrice = false): string => {
    if (num === null || num === undefined || isNaN(num)) return 'N/A';
    if (num === 0) return isPrice ? '$0' : '0';

    if (isPrice) {
      // For very small prices, use subscript notation like DexScreener
      if (num < 0.0001) {
        const str = num.toFixed(20);
        const match = str.match(/^0\.(0+)(\d{2,4})/);
        if (match) {
          const zeros = match[1].length;
          const significantDigits = match[2];
          // Return format like $0.0₄92 (using subscript for zero count)
          return `$0.0${String.fromCharCode(8320 + zeros)}${significantDigits}`;
        }
        return `$${num.toFixed(10).replace(/0+$/, '')}`;
      }
      if (num < 1) {
        return `$${num.toFixed(6)}`;
      }
      if (num >= 1000000000) {
        return `$${(num / 1000000000).toFixed(2)}B`;
      } else if (num >= 1000000) {
        return `$${(num / 1000000).toFixed(2)}M`;
      } else if (num >= 1000) {
        return `$${(num / 1000).toFixed(2)}K`;
      }
      return `$${num.toFixed(2)}`;
    }

    // Non-price formatting
    if (num >= 1000000000) {
      return `${(num / 1000000000).toFixed(2)}B`;
    } else if (num >= 1000000) {
      return `${(num / 1000000).toFixed(2)}M`;
    } else if (num >= 1000) {
      return `${(num / 1000).toFixed(2)}K`;
    } else {
      return num.toFixed(2);
    }
  };

  // Format time ago
  const timeAgo = (dateString: string): string => {
    const now = new Date();
    const date = new Date(dateString);
    const diffInMs = now.getTime() - date.getTime();
    const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
    const diffInHours = Math.floor(diffInMinutes / 60);
    const diffInDays = Math.floor(diffInHours / 24);

    if (diffInMinutes < 1) return 'Just now';
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
    if (diffInHours < 24) return `${diffInHours}h ago`;
    return `${diffInDays}d ago`;
  };

  const getRiskColor = (riskLevel: string) => {
    switch (riskLevel) {
      case 'low': return 'text-green-400 bg-green-400/10';
      case 'medium': return 'text-yellow-400 bg-yellow-400/10';
      case 'high': return 'text-red-400 bg-red-400/10';
      default: return 'text-muted-foreground bg-gray-400/10';
    }
  };

  const getPriceChangeColor = (change: number) => {
    if (change > 0) return 'text-green-400';
    if (change < 0) return 'text-red-400';
    return 'text-muted-foreground';
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-background rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-bold text-white">Token Details</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400"></div>
              <span className="ml-3 text-muted-foreground">Loading token details...</span>
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <p className="text-red-400 text-lg font-semibold mb-2">Error Loading Token</p>
              <p className="text-muted-foreground">{error}</p>
            </div>
          ) : token ? (
            <div className="space-y-6">
              {/* Token Header */}
              <div className="flex items-start space-x-4">
                <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center overflow-hidden flex-shrink-0">
                  {token.logoURI ? (
                    <img src={token.logoURI} alt={token.symbol} className="w-14 h-14 rounded-full" />
                  ) : (
                    <span className="text-xl font-bold text-muted-foreground">{token.symbol?.slice(0, 2) || '??'}</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-3 mb-2">
                    <h3 className="text-2xl font-bold text-white">{token.symbol}</h3>
                    {token.riskLevel && (
                      <span className={`px-2 py-1 rounded text-xs font-medium ${getRiskColor(token.riskLevel)}`}>
                        {token.riskLevel.toUpperCase()} RISK
                      </span>
                    )}
                  </div>
                  <p className="text-lg text-foreground/80 mb-2">{token.name}</p>
                  <div className="flex items-center space-x-2 text-sm">
                    <span className="text-muted-foreground">Contract:</span>
                    <span className="text-foreground/80 font-mono text-xs">{token.address.slice(0, 8)}...{token.address.slice(-8)}</span>
                    <button
                      onClick={() => copyToClipboard(token.address, 'address')}
                      className="text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      {copiedField === 'address' ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              {/* Price and Change */}
              <div className="grid grid-cols-2 gap-4">
                <div className="glass rounded-xl p-4">
                  <div className="text-sm text-muted-foreground mb-1">Price</div>
                  <div className="text-xl font-bold text-white">{formatNumber(token.price, true)}</div>
                </div>
                <div className="glass rounded-xl p-4">
                  <div className="text-sm text-muted-foreground mb-1">24h Change</div>
                  <div className={`text-xl font-bold flex items-center space-x-1 ${getPriceChangeColor(token.priceChange24h || 0)}`}>
                    {(token.priceChange24h || 0) > 0 ? (
                      <TrendingUp className="w-5 h-5" />
                    ) : (token.priceChange24h || 0) < 0 ? (
                      <TrendingDown className="w-5 h-5" />
                    ) : null}
                    <span>{(token.priceChange24h || 0) > 0 ? '+' : ''}{(token.priceChange24h || 0).toFixed(2)}%</span>
                  </div>
                </div>
              </div>

              {/* Market Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="glass rounded-xl p-4">
                  <div className="text-sm text-muted-foreground mb-1">Volume (24h)</div>
                  <div className="text-lg font-semibold text-white">
                    {token.volume24h != null ? `$${formatNumber(token.volume24h)}` : 'N/A'}
                  </div>
                </div>
                <div className="glass rounded-xl p-4">
                  <div className="text-sm text-muted-foreground mb-1">Volume (7d)</div>
                  <div className="text-lg font-semibold text-white">
                    {token.volume7d != null ? `$${formatNumber(token.volume7d)}` : 'N/A'}
                  </div>
                </div>
                <div className="glass rounded-xl p-4">
                  <div className="text-sm text-muted-foreground mb-1">Liquidity</div>
                  <div className="text-lg font-semibold text-white">
                    {token.liquidity ? `$${formatNumber(token.liquidity)}` : 'N/A'}
                  </div>
                </div>
                <div className="glass rounded-xl p-4">
                  <div className="text-sm text-muted-foreground mb-1">Market Cap</div>
                  <div className="text-lg font-semibold text-white">
                    {token.marketCap ? `$${formatNumber(token.marketCap)}` : 'N/A'}
                  </div>
                </div>
              </div>

              {/* Pool Information */}
              {token.mainPool && (
                <div className="glass rounded-xl p-4">
                  <h4 className="text-lg font-semibold text-white mb-3">Pool Information</h4>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Main Pool:</span>
                      <span className="text-white font-mono text-sm">{token.mainPool.id?.slice(0, 8)}...{token.mainPool.id?.slice(-8)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Pool Type:</span>
                      <span className="text-white">{token.mainPool.type}</span>
                    </div>
                    {token.mainPool.pairedWith && (
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Paired With:</span>
                        <span className="text-white">{token.mainPool.pairedWith.symbol}</span>
                      </div>
                    )}
                    {token.allPools && token.allPools.length > 1 && (
                      <div className="pt-2 border-t border-border">
                        <span className="text-muted-foreground">Available Pools: {token.allPools.length}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Social Links */}
              {(token.website || token.twitter || token.telegram) && (
                <div className="glass rounded-xl p-4">
                  <h4 className="text-lg font-semibold text-white mb-3">Social Links</h4>
                  <div className="flex space-x-4">
                    {token.website && (
                      <a
                        href={token.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center space-x-2 text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        <Globe className="w-4 h-4" />
                        <span>Website</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {token.twitter && (
                      <a
                        href={token.twitter}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center space-x-2 text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        <Twitter className="w-4 h-4" />
                        <span>Twitter</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {token.telegram && (
                      <a
                        href={token.telegram}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center space-x-2 text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        <MessageCircle className="w-4 h-4" />
                        <span>Telegram</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>
              )}

              {/* Description */}
              {token.description && (
                <div className="glass rounded-xl p-4">
                  <h4 className="text-lg font-semibold text-white mb-3">Description</h4>
                  <p className="text-foreground/80 leading-relaxed">{token.description}</p>
                </div>
              )}

              {/* Token Info */}
              <div className="glass rounded-xl p-4">
                <h4 className="text-lg font-semibold text-white mb-3">Token Information</h4>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Decimals:</span>
                    <span className="text-white ml-2">{token.decimals ?? 9}</span>
                  </div>
                  {token.createdAt && (
                    <div>
                      <span className="text-muted-foreground">Created:</span>
                      <span className="text-white ml-2">{timeAgo(token.createdAt)}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Source:</span>
                    <span className="text-white ml-2 capitalize">{token.source || 'Unknown'}</span>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              {onTrade && (
                <div className="flex space-x-4 pt-4">
                  <button
                    onClick={() => onTrade('buy', token.address)}
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors"
                  >
                    <DollarSign className="w-5 h-5 inline mr-2" />
                    Buy Token
                  </button>
                  <button
                    onClick={() => onTrade('sell', token.address)}
                    className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors"
                  >
                    <Activity className="w-5 h-5 inline mr-2" />
                    Sell Token
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default TokenDetailsModal;
