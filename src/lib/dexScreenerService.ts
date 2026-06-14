import axios from 'axios';

const API_BASE = '';

export interface DexScreenerToken {
  address: string;
  name: string;
  symbol: string;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: DexScreenerToken;
  quoteToken: DexScreenerToken;
  priceNative: string;
  priceUsd: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity: {
    usd: number;
    base: number;
    quote: number;
  };
  pairCreatedAt: number;
  labels?: string[];
  fdv?: number;
  marketCap?: number;
}

export interface DexScreenerTokenResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[];
}

export interface DexScreenerPairResponse {
  schemaVersion: string;
  pair: DexScreenerPair;
}

export interface DexScreenerSearchResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[];
}

export class DexScreenerService {
  /**
   * Get token information and all pairs for a given token address
   */
  static async getTokenInfo(tokenAddress: string): Promise<DexScreenerTokenResponse> {
    try {
      const response = await axios.get(`${API_BASE}/api/token-info/${tokenAddress}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching token info from DexScreener:', error);
      throw new Error('Failed to fetch token information');
    }
  }

  /**
   * Get specific pair information by pair address
   */
  static async getPairInfo(pairAddress: string): Promise<DexScreenerPairResponse> {
    try {
      const response = await axios.get(`${API_BASE}/api/pair-info/${pairAddress}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching pair info from DexScreener:', error);
      throw new Error('Failed to fetch pair information');
    }
  }

  /**
   * Search for tokens and pairs by name or symbol
   */
  static async searchTokens(query: string): Promise<DexScreenerSearchResponse> {
    try {
      const response = await axios.get(`${API_BASE}/api/search/${encodeURIComponent(query)}`);
      return response.data;
    } catch (error) {
      console.error('Error searching DexScreener:', error);
      throw new Error('Failed to search tokens');
    }
  }

  /**
   * Get the best price for a token (highest liquidity pair)
   */
  static async getBestPrice(tokenAddress: string): Promise<DexScreenerPair | null> {
    try {
      const tokenInfo = await this.getTokenInfo(tokenAddress);
      if (!tokenInfo.pairs || tokenInfo.pairs.length === 0) {
        return null;
      }

      // Sort pairs by liquidity (USD value) and return the highest
      const sortedPairs = tokenInfo.pairs.sort((a, b) =>
        (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      );

      return sortedPairs[0];
    } catch (error) {
      console.error('Error getting best price from DexScreener:', error);
      return null;
    }
  }

  /**
   * Get trading stats for a token (volume, price changes)
   */
  static async getTradingStats(tokenAddress: string): Promise<{
    totalVolume24h: number;
    averagePriceChange24h: number;
    totalPairs: number;
    highestLiquidity: number;
    mostActivePair: DexScreenerPair | null;
  }> {
    try {
      const tokenInfo = await this.getTokenInfo(tokenAddress);
      if (!tokenInfo.pairs || tokenInfo.pairs.length === 0) {
        return {
          totalVolume24h: 0,
          averagePriceChange24h: 0,
          totalPairs: 0,
          highestLiquidity: 0,
          mostActivePair: null
        };
      }

      const pairs = tokenInfo.pairs;
      const totalVolume24h = pairs.reduce((sum, pair) => sum + (pair.volume?.h24 || 0), 0);
      const averagePriceChange24h = pairs.reduce((sum, pair) => sum + (pair.priceChange?.h24 || 0), 0) / pairs.length;
      const highestLiquidity = Math.max(...pairs.map(pair => pair.liquidity?.usd || 0));

      // Most active pair by 24h volume
      const mostActivePair = pairs.reduce((best, current) =>
        (current.volume?.h24 || 0) > (best.volume?.h24 || 0) ? current : best
      );

      return {
        totalVolume24h,
        averagePriceChange24h,
        totalPairs: pairs.length,
        highestLiquidity,
        mostActivePair
      };
    } catch (error) {
      console.error('Error getting trading stats from DexScreener:', error);
      throw new Error('Failed to fetch trading statistics');
    }
  }

  /**
   * Check if a token is likely a legitimate project based on DexScreener data
   */
  static async analyzeTokenSafety(tokenAddress: string): Promise<{
    safetyScore: number; // 0-100
    riskFactors: string[];
    recommendations: string[];
    pairs: DexScreenerPair[];
  }> {
    try {
      const tokenInfo = await this.getTokenInfo(tokenAddress);
      if (!tokenInfo.pairs || tokenInfo.pairs.length === 0) {
        return {
          safetyScore: 0,
          riskFactors: ['No trading pairs found'],
          recommendations: ['Token may not be listed on major DEXs'],
          pairs: []
        };
      }

      const pairs = tokenInfo.pairs;
      let safetyScore = 50; // Start with neutral score
      const riskFactors: string[] = [];
      const recommendations: string[] = [];

      // Check liquidity
      const totalLiquidity = pairs.reduce((sum, pair) => sum + (pair.liquidity?.usd || 0), 0);
      if (totalLiquidity > 100000) {
        safetyScore += 20;
      } else if (totalLiquidity < 10000) {
        safetyScore -= 20;
        riskFactors.push('Low liquidity (< $10k)');
      }

      // Check volume
      const totalVolume24h = pairs.reduce((sum, pair) => sum + (pair.volume?.h24 || 0), 0);
      if (totalVolume24h > 50000) {
        safetyScore += 15;
      } else if (totalVolume24h < 1000) {
        safetyScore -= 15;
        riskFactors.push('Low trading volume (< $1k/24h)');
      }

      // Check number of DEXs
      const uniqueDexs = new Set(pairs.map(pair => pair.dexId));
      if (uniqueDexs.size >= 3) {
        safetyScore += 10;
      } else if (uniqueDexs.size === 1) {
        riskFactors.push('Only available on one DEX');
      }

      // Check token age
      const oldestPair = pairs.reduce((oldest, current) =>
        current.pairCreatedAt < oldest.pairCreatedAt ? current : oldest
      );
      const tokenAge = Date.now() - oldestPair.pairCreatedAt;
      const daysOld = tokenAge / (1000 * 60 * 60 * 24);

      if (daysOld > 30) {
        safetyScore += 10;
      } else if (daysOld < 1) {
        safetyScore -= 25;
        riskFactors.push('Very new token (< 1 day old)');
      } else if (daysOld < 7) {
        riskFactors.push('New token (< 1 week old)');
      }

      // Ensure score is within bounds
      safetyScore = Math.max(0, Math.min(100, safetyScore));

      // Generate recommendations
      if (safetyScore < 30) {
        recommendations.push('HIGH RISK: Consider avoiding this token');
        recommendations.push('If trading, use very small amounts');
      } else if (safetyScore < 60) {
        recommendations.push('MEDIUM RISK: Exercise caution');
        recommendations.push('Research the project thoroughly before investing');
      } else {
        recommendations.push('Looks relatively safe based on market data');
        recommendations.push('Still perform your own research (DYOR)');
      }

      return {
        safetyScore,
        riskFactors,
        recommendations,
        pairs
      };
    } catch (error) {
      console.error('Error analyzing token safety:', error);
      return {
        safetyScore: 0,
        riskFactors: ['Unable to analyze token'],
        recommendations: ['Proceed with extreme caution'],
        pairs: []
      };
    }
  }
}

export default DexScreenerService;
