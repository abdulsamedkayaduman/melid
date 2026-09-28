'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { SshManager, expandHome } = require('./ssh-manager');
const { Store } = require('./store');
const { readSshConfig } = require('./sshconfig');

app.setName('SSHDeck');
let win = null;
let store = null;
let manager = null;

// ---------- main -> renderer request/response (prompts, host keys) ----------
let reqSeq = 0;
const pending = new Map();
function uiRequest(kind, payload) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(null);
    const id = ++reqSeq;
    pending.set(id, resolve);
    win.webContents.send('ui:request', { id, kind, payload });
  });
}
ipcMain.on('ui:response', (_e, { id, value }) => {
  const r = pending.get(id);
  if (r) { pending.delete(id); r(value); }
});

function send(ch, ...args) { if (win && !win.isDestroyed()) win.webContents.send(ch, ...args); }

// Host key prompts for the same host are serialized so parallel tabs don't ask twice.
const hostKeyLocks = new Map();
async function verifyHostKey({ host, port, type, fingerprint }) {
  const k = `${host}:${port}`;
  while (hostKeyLocks.has(k)) await hostKeyLocks.get(k);
  const known = store.hostKey(host, port);
  if (known && known.fingerprint === fingerprint) return true;
  let release;
  hostKeyLocks.set(k, new Promise((r) => { release = r; }));
  try {
    const ans = await uiRequest('hostkey', { host, port, type, fingerprint, changed: !!known, oldFingerprint: known && known.fingerprint });
    if (ans === 'trust') { store.trustHostKey(host, port, type, fingerprint); return true; }
    return ans === 'once';
  } finally { hostKeyLocks.delete(k); release(); }
}

// ---------- remote file editing ----------
const editWatchers = new Map(); // connId -> [watcher]
async function editRemote(connId, remotePath) {
  const dir = path.join(os.tmpdir(), 'sshdeck-edit', crypto.randomBytes(4).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  const local = path.join(dir, path.posix.basename(remotePath));
  await manager.fastGet(connId, remotePath, local);
  let timer = null; let lastMtime = (await fsp.stat(local)).mtimeMs;
  const w = fs.watch(dir, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const st = await fsp.stat(local);
        if (st.mtimeMs === lastMtime) return;
        lastMtime = st.mtimeMs;
        await manager.fastPut(connId, local, remotePath);
        send('edit:event', connId, { path: remotePath, state: 'uploaded' });
      } catch (e) { send('edit:event', connId, { path: remotePath, state: 'error', error: e.message }); }
    }, 400);
  });
  if (!editWatchers.has(connId)) editWatchers.set(connId, []);
  editWatchers.get(connId).push(w);
  const err = await shell.openPath(local);
  if (err) throw new Error(err);
  return local;
}
function stopEdits(connId) {
  for (const w of editWatchers.get(connId) || []) { try { w.close(); } catch {} }
  editWatchers.delete(connId);
}

// ---------- local filesystem ----------
async function localList(dir) {
  const names = await fsp.readdir(dir);
  const out = [];
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const l = await fsp.lstat(p);
      let st = l; const isLink = l.isSymbolicLink();
      if (isLink) { try { st = await fsp.stat(p); } catch {} }
      out.push({ name, size: st.size, mtime: st.mtimeMs, mode: st.mode, isDir: st.isDirectory(), isLink });
    } catch {}
  }
  return out;
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));

  // app / store
  h('app:init', () => ({
    sessions: store.publicSessions(),
    settings: store.settings,
    home: os.homedir(),
    secrets: store.secretsBackend(),
    platform: process.platform,
    version: app.getVersion(),
  }));
  h('sessions:save', (s) => { const id = store.saveSession(s); return { id, sessions: store.publicSessions() }; });
  h('sessions:delete', (id) => { store.deleteSession(id); return store.publicSessions(); });
  h('sessions:renameGroup', (a, b) => { store.renameGroup(a, b); return store.publicSessions(); });
  h('sessions:importSshConfig', () => {
    const parsed = readSshConfig();
    const existing = new Set(store.sessions.map((s) => `${s.name}|${s.host}|${s.port}`));
    const idByAlias = {};
    for (const s of store.sessions) idByAlias[s.name] = s.id;
    let added = 0;
    const later = [];
    for (const s of parsed) {
      if (existing.has(`${s.name}|${s.host}|${s.port}`)) continue;
      const pj = s._proxyJump; delete s._proxyJump;
      const id = store.saveSession(s);
      idByAlias[s.name] = id; added++;
      if (pj) later.push([id, pj]);
    }
    for (const [id, pj] of later) {
      const alias = pj.replace(/^.*@/, '').replace(/:\d+$/, '');
      if (idByAlias[alias]) store.saveSession({ id, jumpHostId: idByAlias[alias] });
    }
    return { added, found: parsed.length, sessions: store.publicSessions() };
  });
  h('settings:save', (patch) => store.saveSettings(patch));

  // ssh
  h('ssh:connect', async (connId, ref) => {
    let session;
    if (ref.sessionId) {
      session = store.getSession(ref.sessionId);
      if (!session) throw new Error('Oturum bulunamadı');
    } else session = { ...ref.session };
    await manager.connect(connId, session);
    return { host: session.host, username: session.username, remoteDir: session.remoteDir, localDir: session.localDir };
  });
  h('ssh:shell', (connId, cols, rows, startup) => manager.openShell(connId, cols, rows, startup));
  ipcMain.on('ssh:write', (_e, connId, data) => manager.write(connId, data));
  ipcMain.on('ssh:resize', (_e, connId, cols, rows) => manager.resize(connId, cols, rows));
  h('ssh:disconnect', (connId) => { stopEdits(connId); manager.disconnect(connId); });
  h('ssh:forwardStart', (connId, fw) => manager.startForward(connId, fw));
  h('ssh:forwardStop', (connId, fid) => manager.stopForward(connId, fid));
  h('ssh:forwardList', (connId) => manager.listForwards(connId));

  // sftp
  h('sftp:home', (c) => manager.home(c));
  h('sftp:realpath', (c, p) => manager.realpath(c, p));
  h('sftp:list', (c, p) => manager.list(c, p));
  h('sftp:mkdir', (c, p) => manager.mkdir(c, p));
  h('sftp:rename', (c, a, b) => manager.rename(c, a, b));
  h('sftp:remove', (c, p) => manager.remove(c, p));
  h('sftp:chmod', (c, p, m) => manager.chmod(c, p, m));
  h('sftp:exists', (c, p) => manager.exists(c, p));
  h('sftp:edit', (c, p) => editRemote(c, p));
  h('sftp:transfer', (c, t) => { manager.transfer(c, t); return true; });
  h('sftp:cancel', (c, tid) => manager.cancelTransfer(c, tid));

  // local fs
  h('local:list', (p) => localList(p));
  h('local:mkdir', (p) => fsp.mkdir(p));
  h('local:rename', (a, b) => fsp.rename(a, b));
  h('local:remove', (p) => shell.trashItem(p).catch(() => fsp.rm(p, { recursive: true, force: true })));
  h('local:exists', (p) => fsp.access(p).then(() => true, () => false));
  h('local:open', (p) => shell.openPath(p));
  h('local:reveal', (p) => shell.showItemInFolder(p));
  h('local:resolve', (p) => path.resolve(expandHome(p)));

  // misc
  h('clipboard:read', () => clipboard.readText());
  h('clipboard:write', (t) => clipboard.writeText(t));
  h('dialog:openFile', async (opts) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'showHiddenFiles'], defaultPath: expandHome(opts && opts.defaultPath) || path.join(os.homedir(), '.ssh') });
    return r.canceled ? null : r.filePaths[0];
  });
  h('shell:openExternal', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

  manager.on('status', (id, state, msg) => { if (state === 'closed' || state === 'error') stopEdits(id); send('ssh:status', id, state, msg); });
  manager.on('shell-data', (id, data) => send('ssh:data', id, data));
  manager.on('shell-exit', (id) => send('ssh:exit', id));
  manager.on('banner', (id, msg) => send('ssh:banner', id, msg));
  manager.on('forward', (id, fid, state, msg) => send('ssh:forward', id, fid, state, msg));
  manager.on('transfer', (id, info) => send('sftp:transfer', id, info));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#14161b',
    title: 'SSHDeck',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && process.env.SSHDECK_DEV) win.webContents.toggleDevTools();
  });
  win.on('close', (e) => {
    if (manager.conns.size && store.settings.confirmClose) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: ['Kapat', 'Vazgeç'], defaultId: 1, cancelId: 1,
        title: 'SSHDeck', message: `${manager.conns.size} açık bağlantı var. Kapatılsın mı?`,
      });
      if (r !== 0) { e.preventDefault(); return; }
    }
    manager.closeAll();
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  store = new Store(path.join(app.getPath('userData')), {
    available: () => { try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; } },
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
  });
  manager = new SshManager({
    getSession: (id) => store.getSession(id),
    verifyHostKey,
    prompt: (kind, payload) => uiRequest(kind, payload),
  });
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => { if (manager) manager.closeAll(); app.quit(); });
