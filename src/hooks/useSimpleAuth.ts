import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useSelector } from 'react-redux';
import { RootState } from '../store';

/**
 * Simple hook to get sniper configs only if authenticated
 */
export const useAuthenticatedSniperConfigs = () => {
  const { isAuthenticated } = useAuth();
  const sniperConfigs = useSelector((state: RootState) => state.sniperConfigs.configs);
  // Return configs only if authenticated, otherwise empty array
  return useMemo(() => isAuthenticated ? sniperConfigs : [], [isAuthenticated, sniperConfigs]);
};

/**
 * Simple hook to get transactions only if authenticated  
 */
export const useAuthenticatedTransactions = () => {
  const { isAuthenticated } = useAuth();
  const transactions = useSelector((state: RootState) => state.transactions);
  // Return transactions only if authenticated, otherwise empty array
  return useMemo(() => isAuthenticated ? transactions : [], [isAuthenticated, transactions]);
};

/**
 * Simple hook to check authentication status
 */
export const useIsAuthenticated = () => {
  const { isAuthenticated } = useAuth();
  return isAuthenticated;
};
