import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend port set by launcher/main.js via VITE_BACKEND_PORT env var
// Falls back to 3001 if running Vite standalone (npm run dev without Electron)
const backendPort = process.env.VITE_BACKEND_PORT || '3001';
const backendTarget = `http://localhost:${backendPort}`;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.VITE_FRONTEND_PORT || '5173'),
    proxy: {
      // Forward all /api/* HTTP requests to the Express backend
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
      // Forward WebSocket connections to the backend
      '/ws': {
        target: backendTarget.replace('http', 'ws'),
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // No sourcemaps in production bundle (Electron)
  },
});

