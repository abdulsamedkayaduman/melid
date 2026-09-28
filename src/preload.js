'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => {
  const l = (_e, ...a) => fn(...a);
  ipcRenderer.on(ch, l);
  return () => ipcRenderer.removeListener(ch, l);
};

contextBridge.exposeInMainWorld('api', {
  init: inv('app:init'),
  sessions: {
    save: inv('sessions:save'),
    remove: inv('sessions:delete'),
    renameGroup: inv('sessions:renameGroup'),
    importSshConfig: inv('sessions:importSshConfig'),
  },
  saveSettings: inv('settings:save'),
  ssh: {
    connect: inv('ssh:connect'),
    shell: inv('ssh:shell'),
    write: (id, d) => ipcRenderer.send('ssh:write', id, d),
    resize: (id, c, r) => ipcRenderer.send('ssh:resize', id, c, r),
    disconnect: inv('ssh:disconnect'),
    forwardStart: inv('ssh:forwardStart'),
    forwardStop: inv('ssh:forwardStop'),
    forwardList: inv('ssh:forwardList'),
    onStatus: on('ssh:status'),
    onData: on('ssh:data'),
    onExit: on('ssh:exit'),
    onBanner: on('ssh:banner'),
    onForward: on('ssh:forward'),
  },
  sftp: {
    home: inv('sftp:home'),
    realpath: inv('sftp:realpath'),
    list: inv('sftp:list'),
    mkdir: inv('sftp:mkdir'),
    rename: inv('sftp:rename'),
    remove: inv('sftp:remove'),
    chmod: inv('sftp:chmod'),
    exists: inv('sftp:exists'),
    edit: inv('sftp:edit'),
    transfer: inv('sftp:transfer'),
    cancel: inv('sftp:cancel'),
    onTransfer: on('sftp:transfer'),
    onEdit: on('edit:event'),
  },
  local: {
    list: inv('local:list'),
    mkdir: inv('local:mkdir'),
    rename: inv('local:rename'),
    remove: inv('local:remove'),
    exists: inv('local:exists'),
    open: inv('local:open'),
    reveal: inv('local:reveal'),
    resolve: inv('local:resolve'),
  },
  clipboard: { read: inv('clipboard:read'), write: inv('clipboard:write') },
  openFileDialog: inv('dialog:openFile'),
  openExternal: inv('shell:openExternal'),
  pathForFile: (f) => webUtils.getPathForFile(f),
  onUiRequest: on('ui:request'),
  uiRespond: (id, value) => ipcRenderer.send('ui:response', { id, value }),
});
