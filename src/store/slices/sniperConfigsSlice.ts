import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { TokenInfo } from '../../lib/tokenService';
import { DatabaseService } from '../../lib/databaseService';

export interface SniperConfig {
  id: string;
  name: string;
  tokenAddress: string;
  buyAmount: string;
  sellTarget: string;
  stopLoss: string;
  maxSlippage: string;
  autoApprove: boolean;
  tokenType: 'sol' | 'wsol';
  dex: 'jupiter' | 'raydium';
  gasLimit?: string;
  walletId: string; // Add walletId to store which wallet to use for trading
  
  // Advanced Fee Management
  priorityFee: string; // SOL amount for priority fee
  bribeFee: string; // SOL amount for bribe fee
  autoFeeMode: boolean; // Auto-calculate optimal fees
  baseFeeMultiplier: string; // Multiplier for base fees (1.0 = 1x, 2.0 = 2x)
  
  // MEV Protection
  mevProtection: boolean; // Enable Jito bundle protection
  jitoTipAmount: string; // Tip amount for Jito
  
  // Advanced Trading Options
  maxSlippageAdvanced: string; // Advanced slippage (can be higher than basic)
  slippageMode: 'conservative' | 'aggressive' | 'custom'; // Slippage presets
  frontrunProtection: boolean; // Enable front-run protection
  sandwichProtection: boolean; // Enable sandwich attack protection
  
  notifications: {
    telegram: boolean;
    email: boolean;
  };
  tokenInfo?: TokenInfo | {
    name: string;
    symbol: string;
    decimals: number;
    logoUrl?: string;
    price?: number;
  };
}

interface SniperConfigsState {
  configs: SniperConfig[];
}

const initialState: SniperConfigsState = {
  configs: [],
};

const sniperConfigsSlice = createSlice({
  name: 'sniperConfigs',
  initialState,
  reducers: {
    addSniperConfig: (state, action: PayloadAction<SniperConfig>) => {
      state.configs.push(action.payload);
    },
    updateSniperConfig: (state, action: PayloadAction<{ id: string; updates: Partial<SniperConfig> }>) => {
      const { id, updates } = action.payload;
      const config = state.configs.find(c => c.id === id);
      if (config) {
        Object.assign(config, updates);
      }
    },
    deleteSniperConfig: (state, action: PayloadAction<string>) => {
      state.configs = state.configs.filter(config => config.id !== action.payload);
    },
    setSniperConfigs: (state, action: PayloadAction<SniperConfig[]>) => {
      state.configs = action.payload;
    },
    clearAll: (state) => {
      // 🚨 SECURITY: Clear all user data when not authenticated
      state.configs = [];
    },
  },
});

// Enhanced actions that sync with database
export const addSniperConfigWithDB = (config: SniperConfig) => async (dispatch: any) => {
  try {
    // Save to database
    await DatabaseService.saveSniperConfig(config);
    
    // Update Redux state
    dispatch(sniperConfigsSlice.actions.addSniperConfig(config));
  } catch (error) {
    console.error('Failed to save sniper config to database:', error);
    // Still update Redux state as fallback
    dispatch(sniperConfigsSlice.actions.addSniperConfig(config));
  }
};

export const updateSniperConfigWithDB = (id: string, updates: Partial<SniperConfig>) => async (dispatch: any) => {
  try {
    // Update in database
    await DatabaseService.updateSniperConfig(id, updates);
    
    // Update Redux state
    dispatch(sniperConfigsSlice.actions.updateSniperConfig({ id, updates }));
  } catch (error) {
    console.error('Failed to update sniper config in database:', error);
  }
};

export const deleteSniperConfigWithDB = (id: string) => async (dispatch: any) => {
  try {
    // Delete from database
    await DatabaseService.deleteSniperConfig(id);
    
    // Update Redux state
    dispatch(sniperConfigsSlice.actions.deleteSniperConfig(id));
  } catch (error) {
    console.error('Failed to delete sniper config from database:', error);
  }
};

export const loadSniperConfigsFromDB = () => async (dispatch: any) => {
  try {
    const configs = await DatabaseService.getSniperConfigs();
    dispatch(sniperConfigsSlice.actions.setSniperConfigs(configs));
  } catch (error) {
    console.error('Failed to load sniper configs from database:', error);
    // Try to load from localStorage as fallback
    const localConfigs = localStorage.getItem('sniperConfigs');
    if (localConfigs) {
      const configs = JSON.parse(localConfigs);
      dispatch(sniperConfigsSlice.actions.setSniperConfigs(configs));
    }
  }
};

export const { addSniperConfig, updateSniperConfig, deleteSniperConfig, setSniperConfigs, clearAll } = sniperConfigsSlice.actions;
export default sniperConfigsSlice.reducer;
