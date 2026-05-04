// Bridge between Node-isolated main process and the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('iss', {
  // info
  paths:        ()        => ipcRenderer.invoke('app:paths'),
  systemCheck:  ()        => ipcRenderer.invoke('system:check'),
  openPath:     (p)       => ipcRenderer.invoke('app:open-path', p),
  openExternal: (url)     => ipcRenderer.invoke('open-external', url),

  // participants
  listParticipants:   ()              => ipcRenderer.invoke('participants:list'),
  createParticipant:  (data)          => ipcRenderer.invoke('participants:create', data),
  deleteParticipant:  (id)            => ipcRenderer.invoke('participants:delete', id),

  // sessions / recordings
  listSessions:    (pid)              => ipcRenderer.invoke('sessions:list', pid),
  saveRecording:   (data)             => ipcRenderer.invoke('recording:save', data),

  // setup
  downloadReferenceData: (opts)       => ipcRenderer.invoke('reference:download', opts || {}),
  pullDockerImage:       ()           => ipcRenderer.invoke('docker:pull'),

  // pipeline
  runPipeline:    (data)              => ipcRenderer.invoke('pipeline:run', data),
  cancelPipeline: ()                  => ipcRenderer.invoke('pipeline:cancel'),

  // results
  listResults: (pid)                  => ipcRenderer.invoke('results:list', pid),
  readCsv:     (path)                 => ipcRenderer.invoke('results:read-csv', path),

  // event subscriptions
  onReferenceProgress: (cb) => {
    const fn = (_e, msg) => cb(msg);
    ipcRenderer.on('reference:progress', fn);
    return () => ipcRenderer.removeListener('reference:progress', fn);
  },
  onDockerPullLog: (cb) => {
    const fn = (_e, line) => cb(line);
    ipcRenderer.on('docker:pull-log', fn);
    return () => ipcRenderer.removeListener('docker:pull-log', fn);
  },
  onPipelineLog: (cb) => {
    const fn = (_e, msg) => cb(msg);
    ipcRenderer.on('pipeline:log', fn);
    return () => ipcRenderer.removeListener('pipeline:log', fn);
  }
});
