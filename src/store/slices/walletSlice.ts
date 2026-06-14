import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface WalletState {
  network: 'mainnet-beta' | 'devnet' | 'testnet';
  connected: boolean;
  publicKey: string | null;
  balance: number | null;
}

const initialState: WalletState = {
  network: 'mainnet-beta',
  connected: false,
  publicKey: null,
  balance: null,
};

const walletSlice = createSlice({
  name: 'wallet',
  initialState,
  reducers: {
    setNetwork: (state, action: PayloadAction<'mainnet-beta' | 'devnet' | 'testnet'>) => {
      state.network = action.payload;
    },
    setConnected: (state, action: PayloadAction<boolean>) => {
      state.connected = action.payload;
    },
    setPublicKey: (state, action: PayloadAction<string | null>) => {
      state.publicKey = action.payload;
    },
    setBalance: (state, action: PayloadAction<number | null>) => {
      state.balance = action.payload;
    },
    resetWallet: (state) => {
      state.connected = false;
      state.publicKey = null;
      state.balance = null;
    },
  },
});

export const { setNetwork, setConnected, setPublicKey, setBalance, resetWallet } = walletSlice.actions;
export default walletSlice.reducer;
