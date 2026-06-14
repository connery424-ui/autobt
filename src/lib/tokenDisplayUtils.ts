// src/lib/tokenDisplayUtils.ts
import { Transaction } from './transactionStore';

/**
 * Centralized function to get the display name for a token
 * Priority: full tokenName > tokenSymbol > abbreviated fallback
 */
export const getTokenDisplayName = (transaction: Transaction): string => {
  // Prioritize the full token name if available and meaningful
  if (transaction.tokenName && transaction.tokenName.trim() !== '' && transaction.tokenName !== "Unknown Token") {
    return transaction.tokenName;
  }
  
  // Fall back to tokenSymbol if tokenName is not available
  if (transaction.tokenSymbol && transaction.tokenSymbol.trim() !== '') {
    return transaction.tokenSymbol;
  }
  
  // Last resort: return "UNKNOWN"
  return "UNKNOWN";
};

/**
 * Get the token symbol/ticker for compact display (if needed)
 * This function abbreviates long names - use sparingly
 */
export const getTokenSymbol = (transaction: Transaction): string => {
  // Prioritize tokenSymbol if available and not empty
  if (transaction.tokenSymbol && transaction.tokenSymbol.trim() !== '') {
    return transaction.tokenSymbol;
  }
  
  // Fall back to tokenName processing
  const tokenName = transaction.tokenName;
  if (!tokenName || tokenName === "Unknown Token") return "UNKNOWN";
  
  // If tokenName looks like a ticker (short, all caps), use it directly
  if (tokenName.length <= 6 && tokenName === tokenName.toUpperCase()) {
    return tokenName;
  }
  
  // Try to extract ticker from patterns like "TOKEN (TICKER)" or "TokenName (TICK)"
  const tickerMatch = tokenName.match(/\(([A-Z0-9]{1,6})\)/);
  if (tickerMatch) {
    return tickerMatch[1];
  }
  
  // Try to extract from patterns like "$TICKER" or "TICKER:"
  const symbolMatch = tokenName.match(/\$([A-Z0-9]{1,6})|^([A-Z0-9]{1,6}):/);
  if (symbolMatch) {
    return symbolMatch[1] || symbolMatch[2];
  }
  
  // If it's too long, try to abbreviate it intelligently
  if (tokenName.length > 8) {
    // Remove common words and take first letters
    const cleaned = tokenName.replace(/\b(token|coin|finance|protocol|network)\b/gi, '').trim();
    const words = cleaned.split(/[\s-_]+/);
    if (words.length > 1) {
      return words.map(w => w.charAt(0).toUpperCase()).join('').slice(0, 6);
    }
    return tokenName.slice(0, 6).toUpperCase();
  }
  
  return tokenName.toUpperCase();
};

/**
 * Get the full display name for a token (for detailed views)
 * Returns: "TokenName (SYMBOL)" or just "TokenName" if no symbol
 */
export const getTokenFullDisplayName = (transaction: Transaction): string => {
  const name = transaction.tokenName || "Unknown Token";
  const symbol = transaction.tokenSymbol;
  
  if (symbol && symbol.trim() !== '' && symbol !== name) {
    return `${name} (${symbol})`;
  }
  
  return name;
};
