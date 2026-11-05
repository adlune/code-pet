const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  setIgnore: (ignore) => ipcRenderer.send('set-ignore', ignore),
  setMetrics: (m) => ipcRenderer.send('metrics', m),
  onEdges: (cb) => ipcRenderer.on('edges', (_e, d) => cb(d)),
  moveBy: (dx, dy) => ipcRenderer.invoke('move-by', dx, dy),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  showMenu: () => ipcRenderer.send('show-menu'),
  onEvent: (cb) => ipcRenderer.on('pet-event', (_e, d) => cb(d)),
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, d) => cb(d)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, d) => cb(d)),
  onFall: (cb) => ipcRenderer.on('fall', () => cb()),
});
