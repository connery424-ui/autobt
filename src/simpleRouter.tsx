import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import SimpleLayout from './components/SimpleLayout';
import Dashboard from './pages/Dashboard';
import SniperPage from './pages/SniperPage';
import Transactions from './pages/Transactions';
import Analytics from './pages/Analytics';
import Settings from './pages/Settings';
import { WalletManager } from './pages/WalletManager';
import WalletConnect from './pages/WalletConnect';
import Swap from './pages/Swap';

const router = createBrowserRouter([
  {
    path: '/',
    element: <SimpleLayout>
      <Dashboard />
    </SimpleLayout>,
  },
  {
    // Merged page (audit §2): Live Feed + Targets tabs
    path: '/sniper',
    element: <SimpleLayout>
      <SniperPage />
    </SimpleLayout>,
  },
  {
    // Legacy route — redirect to merged page
    path: '/auto-sniper',
    element: <Navigate to="/sniper" replace />,
  },
  {
    path: '/swap',
    element: <SimpleLayout>
      <Swap />
    </SimpleLayout>,
  },
  {
    path: '/wallets',
    element: <SimpleLayout>
      <WalletManager />
    </SimpleLayout>,
  },
  {
    path: '/transactions',
    element: <SimpleLayout>
      <Transactions />
    </SimpleLayout>,
  },
  {
    path: '/analytics',
    element: <SimpleLayout>
      <Analytics />
    </SimpleLayout>,
  },
  {
    path: '/settings',
    element: <SimpleLayout>
      <Settings />
    </SimpleLayout>,
  },
  {
    path: '/wallet-connect',
    element: <WalletConnect />,
  },
]);

export function Router() {
  return <RouterProvider router={router} />;
}

