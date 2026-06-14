/**
 * AutoTraderBot Launcher - Preload Script
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autotrader', {
    // App info
    getAppInfo: () => ipcRenderer.invoke('get-app-info'),
    restartServers: () => ipcRenderer.invoke('restart-servers'),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),

    // Wallet connect (opens in system browser)
    openWalletConnect: (sessionId) => ipcRenderer.invoke('open-wallet-connect', sessionId),
    walletConnected: (walletData) => ipcRenderer.invoke('wallet-connected', walletData),

    // Python virtual environment
    checkPython: () => ipcRenderer.invoke('check-python'),
    setupPythonVenv: () => ipcRenderer.invoke('setup-python-venv'),
    startPythonWorker: (scriptName) => ipcRenderer.invoke('start-python-worker', scriptName),
    stopPythonWorker: () => ipcRenderer.invoke('stop-python-worker'),

    // Check if running in Electron
    isElectron: true
});

// Also expose a global flag for easy detection
contextBridge.exposeInMainWorld('isElectronApp', true);
