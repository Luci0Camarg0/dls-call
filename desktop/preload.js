// Ponte mínima entre o site e o Windows: escolher tela/janela e atalhos globais do soundpad.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dlsDesktop', {
  getSources: () => ipcRenderer.invoke('dls:get-sources'),
  selectSource: (id, withAudio) => ipcRenderer.invoke('dls:select-source', id, withAudio),
  setHotkeys: (list) => ipcRenderer.invoke('dls:set-hotkeys', list),
  onHotkey: (cb) => ipcRenderer.on('dls:hotkey', (_e, accel) => cb(accel)),
});
