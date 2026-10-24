// Ponte mínima entre o site e o Windows: só listar telas/janelas e escolher uma.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dlsDesktop', {
  getSources: () => ipcRenderer.invoke('dls:get-sources'),
  selectSource: (id, withAudio) => ipcRenderer.invoke('dls:select-source', id, withAudio),
});
