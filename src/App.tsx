import React from 'react';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';
import { store, persistor } from './store';
import { Router } from './simpleRouter';
import { Toaster } from './lib/toast-shim';
import SolanaWalletProvider from './components/SolanaWalletProvider';
import { AuthProvider } from './contexts/AuthContext';

function App() {

  return (
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <SolanaWalletProvider>
          <AuthProvider>
            <Router />
            <Toaster />
          </AuthProvider>
        </SolanaWalletProvider>
      </PersistGate>
    </Provider>
  );
}

export default App;