import React from 'react';
import ReactDOM from 'react-dom/client';
import './buffer-polyfill';
import App from './App';
import './index.css'; // Assuming you have a CSS file for Tailwind directives

// Import wallet adapter CSS for proper styling and icons
import '@solana/wallet-adapter-react-ui/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />,
);