/**
 * 🚨 SECURITY: Authentication-aware localStorage management
 * Ensures no user data persists without proper authentication
 */

export const clearUnauthenticatedData = () => {
  // auth_token is the Electron localStorage key; browser sessions are cookie-based (no localStorage token)
  const sessionToken = localStorage.getItem('auth_token');

  if (!sessionToken) {
    console.log('🔒 No Electron auth token - clearing all user data from localStorage');

    // Clear Redux persist data
    localStorage.removeItem('persist:root');

    // Clear any wallet-related data
    localStorage.removeItem('activeWalletAddress');
    localStorage.removeItem('managedWallets');

    // Clear transaction data
    localStorage.removeItem('transactions');
    localStorage.removeItem('transactionStore');

    // Clear sniper configs
    localStorage.removeItem('sniperConfigs');

    // Clear any other user-specific data
    localStorage.removeItem('userSettings');
    localStorage.removeItem('userPreferences');

    console.log('✅ Cleared all unauthenticated user data');
  }
};

export const clearAllUserData = () => {
  console.log('🔒 Clearing all user data on logout');

  // Clear Redux persist data
  localStorage.removeItem('persist:root');

  // Clear authentication
  localStorage.removeItem('autobot_session_token');
  localStorage.removeItem('autobot_refresh_token');

  // Clear wallet data
  localStorage.removeItem('activeWalletAddress');
  localStorage.removeItem('managedWallets');

  // Clear transaction data
  localStorage.removeItem('transactions');
  localStorage.removeItem('transactionStore');

  // Clear sniper configs
  localStorage.removeItem('sniperConfigs');

  // Clear settings
  localStorage.removeItem('userSettings');
  localStorage.removeItem('userPreferences');

  console.log('✅ Cleared all user data');
};

/**
 * Check if there's any persisted user data without authentication
 * This helps identify potential security issues
 */
export const auditUnauthenticatedData = () => {
  const sessionToken = localStorage.getItem('auth_token');

  if (!sessionToken) {
    const userDataKeys = [
      'persist:root',
      'activeWalletAddress',
      'managedWallets',
      'transactions',
      'transactionStore',
      'sniperConfigs',
      'userSettings',
      'userPreferences'
    ];

    const foundData = userDataKeys.filter(key => localStorage.getItem(key));

    if (foundData.length > 0) {
      console.warn('🚨 SECURITY WARNING: Found user data without authentication:', foundData);
      return foundData;
    }
  }

  return [];
};
