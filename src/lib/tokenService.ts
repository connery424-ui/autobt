import axios from 'axios';
import toast from './toast-shim';

// Interface for token information
export interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: number;
  address: string;
  logoUrl?: string;
  price?: number;
  priceChangePercent?: number;
  marketcap?: number;
}

// Function to validate if a string is a valid Solana address
export const isValidSolanaAddress = (address: string): boolean => {
  const solanaAddressRegex = /^[A-HJ-NP-Za-km-z1-9]{32,44}$/;
  return solanaAddressRegex.test(address);
};

// Function to fetch token information from Solscan API
export const fetchTokenInfo = async (tokenAddress: string): Promise<TokenInfo | null> => {
  if (!isValidSolanaAddress(tokenAddress)) {
    console.error("Invalid Solana address format");
    return null;
  }

  try {
    // This now points to our secure backend proxy
    const response = await fetch(`/api/token-info/${tokenAddress}`);
    if (!response.ok) {
      // The proxy will return a descriptive error
      const errorData = await response.json();
      throw new Error(errorData.error || `Failed to fetch token info: ${response.status}`);
    }
    const data = await response.json();

    // The backend now returns a combined object, simplifying the frontend.
    const tokenInfo: TokenInfo = {
      name: data.name || 'Unknown Token',
      symbol: data.symbol || 'UNKNOWN',
      decimals: data.decimals || 9,
      totalSupply: data.supply || 0,
      address: tokenAddress,
      logoUrl: data.icon || '',
      price: data.priceUsdt || 0,
      priceChangePercent: data.priceChange24h || 0,
      marketcap: (data.priceUsdt || 0) * (data.supply || 0)
    };

    return tokenInfo;
  } catch (error) {
    console.error("Error fetching token information:", error);
    return null;
  }
};

// Function to format token amount based on decimals
export const formatTokenAmount = (amount: number, decimals: number = 9): string => {
  const divisor = Math.pow(10, decimals);
  const formattedAmount = amount / divisor;
  
  if (formattedAmount < 0.01) {
    return formattedAmount.toExponential(2);
  }
  
  return formattedAmount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  });
};

// Function to format price in USD
export const formatUsdPrice = (price: number | undefined): string => {
  if (price === undefined || price === 0) return '$0.00';
  
  if (price < 0.01) {
    return `$${price.toExponential(2)}`;
  }
  
  return `$${price.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  })}`;
};

// Function to calculate price in SOL based on USD price
export const calculateSolPrice = (usdPrice: number, solPrice: number = 150): number => {
  if (usdPrice === 0 || solPrice === 0) return 0;
  return usdPrice / solPrice;
};

// Cache for token information to avoid repeated API calls
const tokenInfoCache: Record<string, TokenInfo & { timestamp: number }> = {};
const CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes

// Function to get token info with caching
export const getTokenInfo = async (tokenAddress: string): Promise<TokenInfo | null> => {
  // Check cache first
  const cachedInfo = tokenInfoCache[tokenAddress];
  if (cachedInfo && (Date.now() - cachedInfo.timestamp < CACHE_EXPIRY)) {
    return cachedInfo;
  }
  
  // Fetch new data if not in cache or expired
  const tokenInfo = await fetchTokenInfo(tokenAddress);
  if (tokenInfo) {
    // Store in cache with timestamp
    tokenInfoCache[tokenAddress] = { ...tokenInfo, timestamp: Date.now() };
  }
  
  return tokenInfo;
}; 