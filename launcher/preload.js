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

    // ---- Auto-update (fully manual, driven by the in-app button) ----
    // Returns the installed app version.
    getVersion: () => ipcRenderer.invoke('updates:get-version'),
    // Ask the launcher to check the GitHub release feed for a newer version.
    checkForUpdates: () => ipcRenderer.invoke('updates:check'),
    // Start downloading the available update (call after the user accepts).
    downloadUpdate: () => ipcRenderer.invoke('updates:download'),
    // Quit and install a downloaded update.
    installUpdate: () => ipcRenderer.invoke('updates:install'),
    // Subscribe to update-status events. Returns an unsubscribe function.
    onUpdateStatus: (callback) => {
        const listener = (_event, status) => callback(status);
        ipcRenderer.on('update-status', listener);
        return () => ipcRenderer.removeListener('update-status', listener);
    },

    // Check if running in Electron
    isElectron: true
});

// Also expose a global flag for easy detection
contextBridge.exposeInMainWorld('isElectronApp', true);
