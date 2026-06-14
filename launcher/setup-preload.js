const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupAPI', {
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    getPlatformInfo: () => ipcRenderer.invoke('get-platform-info'),
    skipSetup: () => ipcRenderer.invoke('skip-setup'),
});
