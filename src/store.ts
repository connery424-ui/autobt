import { configureStore } from '@reduxjs/toolkit';
import { persistStore, persistReducer } from 'redux-persist';
import storage from 'redux-persist/lib/storage';
import { combineReducers } from '@reduxjs/toolkit';

// Import your slice reducers
import sniperConfigsReducer from './store/slices/sniperConfigsSlice';
import transactionsReducer from './store/slices/transactionsSlice';
import walletReducer from './store/slices/walletSlice';

const rootReducer = combineReducers({
  sniperConfigs: sniperConfigsReducer,
  transactions: transactionsReducer,
  wallet: walletReducer,
});

const persistConfig = {
  key: 'root',
  storage,
  // Optionally, you can blacklist certain reducers from being persisted
  // blacklist: ['someNonPersistentReducer']
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

export const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: ['persist/PERSIST', 'persist/REHYDRATE'],
      },
    }),
});

export const persistor = persistStore(store);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;