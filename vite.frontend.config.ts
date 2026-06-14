import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Backend port — reads VITE_BACKEND_PORT (set by launcher) or PORT, falls back to 3001
const backendPort = process.env.VITE_BACKEND_PORT || process.env.PORT || '3001';
const backendUrl = `http://localhost:${backendPort}`;
const wsBackendUrl = `ws://localhost:${backendPort}`;

// Frontend port — set by launcher after free-port resolution, falls back to 5173
const frontendPort = parseInt(process.env.VITE_FRONTEND_PORT || '5173', 10);

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: frontendPort,   // bind to exactly the port the launcher polled for
    strictPort: true,     // fail fast if somehow taken (launcher already reserved it)
    proxy: {

      '/api': {
        target: backendUrl,
        changeOrigin: true,
        secure: false,
        // cookieDomainRewrite: domain only (no port) — covers any backend port
        cookieDomainRewrite: 'localhost',
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.cookie) {
              proxyReq.setHeader('cookie', req.headers.cookie);
            }
          });
        }
      },
      '/ws': {
        target: wsBackendUrl,
        ws: true,
        changeOrigin: true
      }
    }

  },
  optimizeDeps: {
    exclude: ['lucide-react'],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  define: {
    global: 'globalThis',
    'process.env': {}
  },
  resolve: {
    alias: {
      'react-hot-toast': resolve(__dirname, './src/lib/toast-shim.ts'),
      '@': resolve(__dirname, './src'),

      // Only apply Node.js polyfills for the browser build, not for tests.
      // This prevents conflicts with the 'node' test environment.
      ...(mode !== 'test' ? {
        stream: 'stream-browserify',
        buffer: 'buffer',
        crypto: 'crypto-browserify',
        http: 'stream-http',
        https: 'https-browserify',
        zlib: 'browserify-zlib',
        url: 'url',
      } : {})
    },
  },
  build: {
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom', 'react-redux', '@reduxjs/toolkit'],
          solana: ['@solana/web3.js', '@solana/spl-token', '@solana/wallet-adapter-base', '@solana/wallet-adapter-react', '@solana/wallet-adapter-react-ui', '@solana/wallet-adapter-phantom', '@solana/wallet-adapter-solflare', '@solana/wallet-adapter-coinbase', '@solana/wallet-adapter-walletconnect'],
          ui: ['lucide-react', '@radix-ui/react-avatar', '@radix-ui/react-dialog', '@radix-ui/react-select', '@radix-ui/react-separator', '@radix-ui/react-slot', '@radix-ui/react-tabs'],
          charts: ['chart.js', 'react-chartjs-2', 'recharts']
        }
      }
    }
  }
}));
