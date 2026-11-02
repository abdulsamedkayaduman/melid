'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage, nativeTheme, nativeImage, powerMonitor, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { SshManager, expandHome, globMatcher } = require('./ssh-manager');
const { Store } = require('./store');
const { readSshConfig } = require('./sshconfig');
const importers = require('./importers');
const { TermLogger } = require('./termlog');
const keys = require('./keys');
const updater = require('./updater');
const { AccountSync, scanLan } = require('./sync');
const { runSessions, runOne, execTask, statsTask } = require('./conncheck');
const { spawn } = require('child_process');

app.setName('SSHDeck');
let win = null;
let store = null;
let manager = null;
let account = null; // hesap eşitlemesi (sync.js)

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
// Windows: sürücü kökünden yukarı çıkınca sanal "Bu Bilgisayar" (DRIVES) listesi gösterilir.
const DRIVES = 'Bu Bilgisayar';
async function listDrives() {
  const out = [];
  for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
    try { await fsp.access(c + ':\\'); out.push({ name: c + ':', size: 0, mtime: 0, mode: 0, isDir: true, isLink: false }); } catch {}
  }
  return out;
}
async function localList(dir) {
  if (process.platform === 'win32' && dir === DRIVES) return listDrives();
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

// ---------- oturum kaydı ----------
const SSH_DIR = path.join(os.homedir(), '.ssh');
const allKeys = () => {
  const local = keys.listKeys(SSH_DIR);
  const have = new Set(local.map((k) => k.fingerprint));
  return [...local, ...store.publicSyncedKeys().filter((k) => !have.has(k.fingerprint))];
};

/**
 * Anahtarlı oturumun anahtarını bulur: keyPath dosyası yoksa (başka cihazdan gelen oturum) parmak iziyle
 * ~/.ssh'de, sonra hesaptan gelen anahtarlarda arar. Hesaptaki anahtar dosyaya yazılmaz, keyData olarak gider.
 */
function resolveKey(s) {
  if (!s || s.authType !== 'key' || !s.keyFp) return s;
  if (s.keyPath && fs.existsSync(expandHome(s.keyPath))) return s;
  const local = keys.listKeys(SSH_DIR).find((k) => k.fingerprint === s.keyFp && k.privatePath);
  if (local) return { ...s, keyPath: local.privatePath };
  const synced = store.syncedKey(s.keyFp);
  if (synced) return { ...s, keyPath: synced.name, keyData: synced.private, passphrase: s.passphrase || synced.passphrase };
  if (!s.keyPath) throw new Error('Bu oturumun SSH anahtarı bu bilgisayarda yok. Hesap ve eşitleme penceresinde "SSH anahtarlarını eşitle"yi bu bilgisayarda ve anahtarın olduğu cihazda açın.');
  return s;
}

const logger = new TermLogger();
const logDir = () => expandHome(store.settings.logDir) || path.join(app.getPath('documents'), 'SSHDeck', 'kayitlar');
function logShellData(connId, data, sid) {
  if (!store.settings.logEnabled) return;
  const c = manager.conns.get(connId);
  const s = c && c.session;
  if (!s) return; // bağlantı kapandıktan sonra gelen artık veri
  try {
    logger.write(`${connId}:${sid}`, data, { dir: logDir(), name: (s && (s.name || s.host)) || 'oturum', suffix: sid === 'main' ? '' : sid, strip: store.settings.logStrip !== false });
  } catch (e) {
    store.saveSettings({ logEnabled: false });
    send('app:toast', `Oturum kaydı durduruldu: ${e.message}`, 'err');
  }
}

// ---------- dosya önizleme ----------
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif' };
async function localRead(p, max) {
  const st = await fsp.stat(p);
  if (st.isDirectory()) throw new Error('Bu bir klasör');
  const fh = await fsp.open(p, 'r');
  try {
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    return { size: st.size, data: buf.subarray(0, bytesRead), truncated: st.size > bytesRead };
  } finally { await fh.close(); }
}
async function preview(read, p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = IMG_MIME[ext];
  if (mime) {
    const r = await read(p, 15 * 1024 * 1024);
    if (r.truncated) return { kind: 'too-big', size: r.size };
    return { kind: 'image', size: r.size, dataUrl: `data:${mime};base64,${r.data.toString('base64')}` };
  }
  const r = await read(p, 512 * 1024);
  if (r.data.subarray(0, 8000).includes(0)) return { kind: 'binary', size: r.size };
  return { kind: 'text', size: r.size, text: r.data.toString('utf8'), truncated: r.truncated };
}

// ---------- klasör karşılaştırma (eşitleme) ----------
async function walkLocal(root, exclude) {
  const ex = globMatcher(exclude);
  const out = new Map();
  const walk = async (rel) => {
    const ents = await fsp.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    for (const e of ents) {
      if (ex(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { out.set(r, { isDir: true }); await walk(r); } else if (e.isFile()) {
        const st = await fsp.stat(path.join(root, r));
        out.set(r, { isDir: false, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
      }
    }
    if (out.size > 200000) throw new Error('Çok fazla dosya (200 000 sınırı)');
  };
  await walk('');
  return out;
}
// -> [{ rel, isDir, local: {size,mtime}|null, remote: ...|null, status: 'local-only'|'remote-only'|'local-newer'|'remote-newer'|'differs' }]
async function compareDirs(connId, localDir, remoteDir, exclude) {
  const [L, R] = await Promise.all([walkLocal(localDir, exclude), manager.walkRemote(connId, remoteDir, exclude)]);
  const out = [];
  for (const [rel, l] of L) {
    const r = R.get(rel);
    if (!r) { out.push({ rel, isDir: l.isDir, local: l, remote: null, status: 'local-only' }); continue; }
    if (l.isDir || r.isDir) {
      if (l.isDir !== r.isDir) out.push({ rel, isDir: l.isDir, local: l, remote: r, status: 'differs' });
      continue;
    }
    if (l.size === r.size && Math.abs(l.mtime - r.mtime) <= 1) continue;
    out.push({ rel, isDir: false, local: l, remote: r, status: l.mtime > r.mtime + 1 ? 'local-newer' : r.mtime > l.mtime + 1 ? 'remote-newer' : 'differs' });
  }
  for (const [rel, r] of R) if (!L.has(rel)) out.push({ rel, isDir: r.isDir, local: null, remote: r, status: 'remote-only' });
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ---------- native drag out to the OS (file manager, desktop, ...) ----------
const DRAG_ROOT = path.join(os.tmpdir(), 'sshdeck-drag');
let dragIcon = null;
function getDragIcon() {
  if (!dragIcon) {
    dragIcon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png'));
    if (!dragIcon.isEmpty()) dragIcon = dragIcon.resize({ width: 32, height: 32 });
  }
  return dragIcon;
}
// Remote files must exist locally before the OS can take them: download into a temp dir first.
async function prepareDrag(connId, tid, items) {
  const dir = path.join(DRAG_ROOT, crypto.randomBytes(4).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  const dsts = items.map((it) => path.join(dir, path.basename(it.name)));
  let result = null;
  const l = (id, info) => { if (id === connId && info.tid === tid && ['done', 'error', 'cancelled'].includes(info.state)) result = info; };
  manager.on('transfer', l);
  try { await manager.transfer(connId, { tid, direction: 'download', items: items.map((it, i) => ({ src: it.path, dst: dsts[i] })) }); } finally { manager.off('transfer', l); }
  if (result && result.state === 'done') return dsts;
  fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  if (result && result.state === 'cancelled') return null;
  throw new Error(result ? result.error : 'İndirilemedi');
}

// Windows'ta Xshell oturumları: Belgeler\NetSarang Computer\<sürüm>\Xshell\Sessions (en yeni sürüm)
function xshellDefaultDir() {
  if (process.platform !== 'win32') return os.homedir();
  try {
    const base = path.join(app.getPath('documents'), 'NetSarang Computer');
    const vers = fs.readdirSync(base).filter((v) => /^\d+$/.test(v)).sort((a, b) => b - a);
    for (const v of vers) { const d = path.join(base, v, 'Xshell', 'Sessions'); if (fs.existsSync(d)) return d; }
  } catch {}
  return os.homedir();
}

// ---------- güncellemeler (updater.js) ----------
// Bu kurulum hangi paket türüyle güncellenir? null = kendiliğinden kurulamaz (geliştirme, deb vb.)
function installKind() {
  if (!app.isPackaged) return null;
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? 'win-portable' : 'win-setup';
  if (process.platform === 'linux') {
    if (process.env.APPIMAGE) return 'linux-appimage';
    if (fs.existsSync('/usr/bin/pacman') && process.execPath.startsWith('/opt/')) return 'linux-pacman';
  }
  return null;
}

const upd = { info: null, newer: false, checking: null, abort: null, timer: null };
async function checkUpdates(manual) {
  if (upd.checking) return upd.checking;
  upd.checking = (async () => {
    try {
      const r = await updater.check(app.getVersion());
      upd.info = r.info; upd.newer = r.newer;
      store.saveSettings({ updateLastCheck: Date.now() });
      if (r.newer && !manual && store.settings.updateSkip !== r.info.version) announceUpdate(r.info);
      return updateState();
    } finally { upd.checking = null; }
  })();
  return upd.checking;
}
function updateState() {
  const kind = installKind();
  const info = upd.info;
  return {
    current: app.getVersion(),
    newer: upd.newer,
    version: info?.version || null,
    notes: info?.notes || '',
    date: info?.date || null,
    kind,
    kindLabel: kind ? updater.KIND_LABELS[kind] : null,
    canInstall: !!(upd.newer && kind && info.files[kind]),
    size: kind && info?.files[kind] ? info.files[kind].size : 0,
    skipped: info && store.settings.updateSkip === info.version,
  };
}
function announceUpdate(info) {
  send('update:available', updateState());
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `SSHDeck ${info.version} çıktı`, body: 'Yeni sürümü görmek ve kurmak için tıklayın.', icon: path.join(__dirname, '..', '..', 'build', 'icon.png') });
  n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); send('update:show'); } });
  n.show();
}
function scheduleUpdateChecks() {
  clearInterval(upd.timer);
  if (store.settings.autoUpdate === false) return;
  const due = () => Date.now() - (store.settings.updateLastCheck || 0) > 6 * 3600e3;
  setTimeout(() => { if (store.settings.autoUpdate !== false) checkUpdates(false).catch(() => {}); }, 15000);
  upd.timer = setInterval(() => { if (store.settings.autoUpdate !== false && due()) checkUpdates(false).catch(() => {}); }, 30 * 60e3);
}

function quitForUpdate() {
  try { manager.closeAll(); logger.closeAll(); } catch {}
  setTimeout(() => app.exit(0), 300);
}

async function installUpdate() {
  const st = updateState();
  if (!st.canInstall) throw new Error('Bu kurulum otomatik güncellenemiyor; yeni sürümü elle indirin');
  const file = upd.info.files[st.kind];
  const dir = path.join(app.getPath('userData'), 'guncelleme');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const ac = new AbortController(); upd.abort = ac;
  let dest;
  try {
    dest = await updater.download(file, path.join(dir, file.name), {
      signal: ac.signal, onProgress: (done, total) => send('update:progress', { done, total }),
    });
  } finally { upd.abort = null; }
  // Kurulum aşaması: { installing, step, percent (null = bilinmiyor) }
  const installing = (step, percent = null) => send('update:progress', { installing: true, step, percent });
  installing('Kuruluyor…');

  if (st.kind === 'win-setup') {
    // NSIS: sessiz kurulum aynı klasöre, bitince uygulamayı yeniden açar
    spawn(dest, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    quitForUpdate();
  } else if (st.kind === 'win-portable') {
    // çalışan exe kilitli: uygulama kapandıktan sonra yerine taşıyıp yeniden başlatan geçici betik
    const target = process.env.PORTABLE_EXECUTABLE_FILE;
    const cmd = path.join(dir, 'guncelle.cmd');
    await fsp.writeFile(cmd, [
      '@echo off', 'set n=0', ':dene', 'timeout /t 1 /nobreak >nul', 'set /a n+=1',
      `move /y "${dest}" "${target}" >nul 2>&1 || (if %n% lss 60 goto dene)`,
      `start "" "${target}" ${RELAUNCH_ARG}`, '(goto) 2>nul & del "%~f0"', '',
    ].join('\r\n'));
    spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    quitForUpdate();
  } else if (st.kind === 'linux-appimage') {
    const target = process.env.APPIMAGE;
    const tmp = target + '.yeni';
    try {
      await updater.copyWithProgress(dest, tmp, (pct) => installing('AppImage yerine yazılıyor', pct));
      await fsp.chmod(tmp, 0o755);
      await fsp.rename(tmp, target);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw new Error(`AppImage değiştirilemedi (${path.dirname(target)} klasörüne yazma izni yok mu?): ${e.message}`);
    }
    const env = { ...process.env };
    for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete env[k];
    spawn(target, [RELAUNCH_ARG], { detached: true, stdio: 'ignore', env }).unref();
    quitForUpdate();
  } else if (st.kind === 'linux-pacman') {
    // pkexec yönetici parolasını grafik olarak sorar
    const pkexec = ['/usr/bin/pkexec', '/bin/pkexec'].find((p) => fs.existsSync(p));
    if (!pkexec) {
      shell.showItemInFolder(dest);
      throw new Error(`pkexec bulunamadı. Paketi terminalden kurun: sudo pacman -U "${dest}"`);
    }
    // pacman sanal terminalde (script) çalışır; ilerleme çubuğundaki yüzde ayrıştırılıp pencereye gönderilir
    const code = await updater.installPacman(dest, { prefix: [pkexec], onProgress: ({ step, percent }) => installing(step, percent) });
    if (code === 126 || code === 127) throw new Error('Yönetici izni verilmedi');
    if (code !== 0) throw new Error(`pacman kurulumu başarısız oldu (çıkış kodu ${code}). Elle: sudo pacman -U "${dest}"`);
    app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== RELAUNCH_ARG), RELAUNCH_ARG] });
    quitForUpdate();
  }
  return true;
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));

  // app / store
  h('app:init', () => ({
    sessions: store.publicSessions(),
    settings: store.publicSettings(),
    home: os.homedir(),
    logDefaultDir: path.join(app.getPath('documents'), 'SSHDeck', 'kayitlar'),
    secrets: store.secretsBackend(),
    platform: process.platform,
    version: app.getVersion(),
  }));
  // When a master password is set but not yet unlocked, ask for it before writing secrets.
  async function ensureUnlocked() {
    if (!store.masterEnabled() || store.isUnlocked()) return true;
    for (let tries = 0; tries < 3; tries++) {
      const pw = await uiRequest('password', { title: 'Ana parola', label: tries ? 'Parola yanlış, tekrar deneyin' : 'Devam etmek için ana parolanızı girin' });
      if (pw == null) return false;
      if (store.unlock(pw)) return true;
    }
    return false;
  }
  h('sessions:save', async (s) => {
    const hasSecret = s && (s.password || s.passphrase);
    if (hasSecret && !(await ensureUnlocked())) throw new Error('Ana parola girilmedi');
    const id = store.saveSession(s);
    return { id, sessions: store.publicSessions() };
  });
  h('sessions:delete', (id) => { store.deleteSession(id); return store.publicSessions(); });
  h('sessions:deleteMany', (ids) => { store.deleteSessions(ids); return store.publicSessions(); });

  // Toplu işler (conncheck.js): kayıtlı oturumlara sormadan bağlanıp denetim / komut / kaynak özeti.
  // o.kind: 'check' (varsayılan) | 'exec' (o.cmd) | 'stats'. Sonuçlar check:progress ile akar.
  const checkRuns = new Map(); // runId -> { cancelled }
  const jobOpts = (o = {}) => ({
    resolve: (id) => resolveKey(store.getSession(id)),
    getSession: (id) => resolveKey(store.getSession(id)),
    hostKey: (host, port) => store.hostKey(host, port),
    trustHostKey: (host, port, type, fp) => store.trustHostKey(host, port, type, fp),
    acceptNew: !!o.acceptNew,
    task: o.kind === 'exec' ? execTask(String(o.cmd || ''), Math.min(600000, Number(o.timeout) || 60000)) : o.kind === 'stats' ? statsTask : null,
  });
  h('check:start', async (ids, o = {}) => {
    if (!(await ensureUnlocked())) throw new Error('Ana parola girilmedi');
    if (o.kind === 'exec' && !String(o.cmd || '').trim()) throw new Error('Komut boş');
    const runId = crypto.randomUUID();
    const run = { cancelled: false };
    checkRuns.set(runId, run);
    runSessions(ids, {
      ...jobOpts(o),
      concurrency: Math.min(16, Math.max(1, Number(o.concurrency) || 6)),
      isCancelled: () => run.cancelled,
      onStart: (id) => send('check:progress', runId, id, { state: 'running' }),
      onResult: (id, r) => send('check:progress', runId, id, r),
    }).finally(() => { checkRuns.delete(runId); send('check:done', runId, run.cancelled); });
    return runId;
  });
  // Tek oturumu yeniden dene (ör. parolası düzeltildikten sonra)
  h('check:one', async (id, o = {}) => {
    if (!(await ensureUnlocked())) throw new Error('Ana parola girilmedi');
    const opts = jobOpts(o);
    try {
      const s = opts.resolve(id);
      return s ? await runOne(s, opts, opts.task) : { state: 'error', message: 'Oturum bulunamadı' };
    } catch (e) { return { state: 'error', message: e.message }; }
  });
  h('check:cancel', (runId) => { const r = checkRuns.get(runId); if (r) r.cancelled = true; });
  h('sessions:renameGroup', (a, b) => { store.renameGroup(a, b); return store.publicSessions(); });
  h('sessions:deleteGroup', (g) => ({ removed: store.deleteGroup(g), sessions: store.publicSessions() }));
  // Adds parsed sessions, skipping ones already present (same name/host/port/user).
  const addImported = (parsed) => {
    const key = (s) => `${s.name}|${s.host}|${s.port}|${s.username || ''}`;
    const existing = new Set(store.sessions.map(key));
    let added = 0; let withPassword = 0;
    for (const s of parsed) {
      if (existing.has(key(s))) continue;
      existing.add(key(s));
      store.saveSession(s); added++;
      if (s.password) withPassword++;
    }
    return { added, found: parsed.length, withPassword, sessions: store.publicSessions() };
  };
  h('sessions:import', async (kind) => {
    let parsed;
    if (kind === 'windterm') {
      const found = importers.findWindTermFiles();
      const r = await dialog.showOpenDialog(win, {
        title: 'WindTerm oturum dosyası (user.sessions)',
        defaultPath: found[0] || os.homedir(),
        properties: ['openFile', 'showHiddenFiles'],
        filters: [{ name: 'WindTerm oturumları', extensions: ['sessions'] }, { name: 'Tüm dosyalar', extensions: ['*'] }],
      });
      if (r.canceled) return null;
      const file = r.filePaths[0];
      let text;
      try { text = await fsp.readFile(file, 'utf8'); } catch (e) { throw new Error(`WindTerm dosyası okunamadı: ${e.message}`); }
      // WindTerm encrypts passwords with the master password. If any exist, ask for it (optional).
      let fingerprint = null; let master = null;
      if (importers.windTermHasSecrets(text)) {
        fingerprint = importers.readWindTermFingerprint(file);
        if (fingerprint) {
          for (let tries = 0; tries < 3; tries++) {
            const ans = await uiRequest('password', {
              title: 'WindTerm ana parolası',
              label: tries ? 'Parola yanlış. Tekrar deneyin veya boş bırakıp parolasız aktarın.'
                : 'Parolaları da aktarmak için WindTerm ana parolanızı girin (boş bırakabilirsiniz).',
            });
            if (ans == null || ans === '') break;
            if (importers.verifyWindTermMaster(text, fingerprint, ans)) { master = ans; break; }
          }
        }
      }
      try { parsed = importers.parseWindTerm(text, { fingerprint, master }); } catch (e) { throw new Error(`WindTerm dosyası okunamadı: ${e.message}`); }
    } else if (kind === 'xshell-dir' || kind === 'xshell-files') {
      const xsDir = xshellDefaultDir();
      const r = await dialog.showOpenDialog(win, kind === 'xshell-dir'
        ? { title: 'Xshell Sessions klasörü', defaultPath: xsDir, properties: ['openDirectory', 'showHiddenFiles'] }
        : { title: 'Xshell oturumları (.xsh / .xts)', defaultPath: xsDir, properties: ['openFile', 'multiSelections', 'showHiddenFiles'], filters: [{ name: 'Xshell', extensions: ['xsh', 'xts'] }] });
      if (r.canceled) return null;
      try { parsed = importers.parseXshellPaths(r.filePaths); } catch (e) { throw new Error(`Xshell oturumları okunamadı: ${e.message}`); }
    } else throw new Error('Bilinmeyen içe aktarma türü');
    if (parsed.some((s) => s.password) && !(await ensureUnlocked())) throw new Error('Ana parola girilmedi');
    return addImported(parsed);
  });
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
  h('settings:save', (patch) => { store.saveSettings(patch); if ('uiTheme' in patch) applyNativeTheme(); return store.publicSettings(); });

  // master password
  h('master:status', () => ({ enabled: store.masterEnabled(), unlocked: store.isUnlocked() }));
  h('master:unlock', (pw) => { const ok = store.unlock(pw); if (ok) account.syncNow().catch(() => {}); return ok; });
  h('master:lock', () => { store.lock(); return true; });
  h('master:set', (oldPw, newPw) => {
    store.setMasterPassword(oldPw, newPw);
    return { settings: store.publicSettings(), secrets: store.secretsBackend() };
  });

  // hesap eşitlemesi: parola renderer'dan bir kez gelir, yalnız anahtar türetmek için kullanılır, saklanmaz
  const accountCall = async (fn) => {
    if (!(await ensureUnlocked())) throw new Error('Ana parola girilmedi');
    await fn();
    account.start();
    return account.status();
  };
  h('account:status', () => account.status());
  h('account:scan', () => scanLan());
  h('account:register', (o) => accountCall(() => account.register(o)));
  h('account:login', (o) => accountCall(() => account.login(o)));
  h('account:logout', async () => { await account.logout(); return account.status(); });
  h('account:syncNow', async () => {
    if (!(await ensureUnlocked())) throw new Error('Ana parola girilmedi');
    await account.syncNow();
    return account.status();
  });
  h('account:setSyncKeys', async (on) => {
    if (on && !(await ensureUnlocked())) throw new Error('Ana parola girilmedi');
    store.setSyncKeys(on);
    account.syncNow().catch(() => {});
    return account.status();
  });
  // kurtarma anahtarı (sync.js): kod kullanıcıya bir kez gösterilir, istenirse metin dosyasına kaydedilir
  h('account:info', () => account.info());
  h('account:recoveryCreate', async (pw) => {
    if (!(await ensureUnlocked())) throw new Error('Ana parola girilmedi');
    return account.createRecovery(pw);
  });
  h('account:recoveryRemove', (pw) => account.removeRecovery(pw));
  h('account:recover', (o) => accountCall(() => account.recover(o)));
  h('account:recoverySave', async (rc) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Kurtarma anahtarını kaydet', defaultPath: path.join(app.getPath('documents'), `sshdeck-kurtarma-${rc.user}.txt`),
      filters: [{ name: 'Metin', extensions: ['txt'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const text = [
      'SSHDeck hesap kurtarma anahtarı',
      '',
      `Sunucu: ${rc.server}`,
      `Kullanıcı: ${rc.user}`,
      `Anahtar: ${rc.code}`,
      `Oluşturulma: ${new Date(rc.created || Date.now()).toLocaleString('tr-TR')}`,
      '',
      'Hesap parolanızı unutursanız SSHDeck giriş penceresinde "Parolamı unuttum" ile bu anahtarla yeni parola',
      'belirleyebilirsiniz; bağlantılarınız ve parolalarınız korunur. Bu dosyayı parola yöneticisi ya da şifreli bir',
      'diskte saklayın: anahtarı ele geçiren biri hesabınıza girebilir. Yeni anahtar oluşturunca bu geçersiz olur.',
      '',
    ].join('\n');
    await fsp.writeFile(r.filePath, text, { mode: 0o600 });
    return r.filePath;
  });
  h('account:recoveryOpen', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Kurtarma anahtarı dosyası', properties: ['openFile'], filters: [{ name: 'Metin', extensions: ['txt'] }, { name: 'Tümü', extensions: ['*'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const t = (await fsp.readFile(r.filePaths[0], 'utf8')).slice(0, 20000);
    const get = (k) => { const m = new RegExp('^' + k + ':\\s*(.+)$', 'mi').exec(t); return m ? m[1].trim() : ''; };
    const code = get('Anahtar') || (/([A-Z2-7]{4}-){7}[A-Z2-7]{4}/.exec(t) || [''])[0];
    if (!code) throw new Error('Dosyada kurtarma anahtarı bulunamadı');
    return { server: get('Sunucu'), user: get('Kullanıcı'), code };
  });
  h('account:changePassword', async (oldPw, newPw) => {
    if (!(await ensureUnlocked())) throw new Error('Ana parola girilmedi');
    await account.changePassword(oldPw, newPw);
    return account.status();
  });

  // backup export / import
  h('backup:export', async (withSecrets) => {
    if (withSecrets && store.masterEnabled() && !store.isUnlocked()) {
      const pw = await uiRequest('password', { title: 'Ana parola', label: 'Yedek almak için ana parolanızı girin' });
      if (!pw || !store.unlock(pw)) return { ok: false, error: 'Ana parola gerekli' };
    }
    let passphrase = null;
    if (withSecrets) {
      passphrase = await uiRequest('password', { title: 'Yedek parolası', label: 'Parolaları şifrelemek için bir yedek parolası belirleyin (geri yüklerken sorulur)' });
      if (passphrase == null) return { ok: false };
    }
    const r = await dialog.showSaveDialog(win, {
      title: 'Yedeği dışa aktar', defaultPath: path.join(os.homedir(), `sshdeck-yedek-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'SSHDeck yedeği', extensions: ['json'] }],
    });
    if (r.canceled) return { ok: false };
    await fsp.writeFile(r.filePath, JSON.stringify(store.exportData({ passphrase: passphrase || undefined }), null, 2), { mode: 0o600 });
    return { ok: true, path: r.filePath };
  });
  h('backup:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Yedeği içe aktar', defaultPath: os.homedir(), properties: ['openFile'],
      filters: [{ name: 'SSHDeck yedeği', extensions: ['json'] }],
    });
    if (r.canceled) return null;
    let obj;
    try { obj = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8')); } catch (e) { throw new Error(`Yedek okunamadı: ${e.message}`); }
    if (!obj || obj.app !== 'SSHDeck' || !Array.isArray(obj.sessions)) throw new Error('Bu bir SSHDeck yedek dosyası değil');
    // local master must be unlocked to store secrets
    if (store.masterEnabled() && !store.isUnlocked()) {
      const pw = await uiRequest('password', { title: 'Ana parola', label: 'İçe aktarmak için ana parolanızı girin' });
      if (!pw || !store.unlock(pw)) throw new Error('Ana parola gerekli');
    }
    let passphrase = null;
    if (obj.encrypted) {
      for (let tries = 0; tries < 3; tries++) {
        passphrase = await uiRequest('password', { title: 'Yedek parolası', label: tries ? 'Parola yanlış, tekrar deneyin' : 'Yedekteki parolaları çözmek için yedek parolasını girin (boş: parolasız aktar)' });
        if (passphrase == null || passphrase === '') { passphrase = null; break; }
        if (store.verifyBackupPassphrase(obj, passphrase)) break;
        passphrase = null;
        if (tries === 2) return { ok: false, error: 'Yedek parolası yanlış' };
      }
    }
    const res = store.importData(obj, passphrase);
    applyNativeTheme();
    return { ok: true, ...res, sessions: store.publicSessions(), settings: store.publicSettings() };
  });

  // ssh
  h('ssh:connect', async (connId, ref) => {
    let session;
    if (ref.sessionId) {
      session = resolveKey(store.getSession(ref.sessionId));
      if (!session) throw new Error('Oturum bulunamadı');
    } else session = { ...ref.session };
    await manager.connect(connId, session);
    return { host: session.host, username: session.username, remoteDir: session.remoteDir, localDir: session.localDir };
  });
  h('ssh:shell', (connId, cols, rows, startup, sid) => manager.openShell(connId, cols, rows, startup, sid));
  h('ssh:closeShell', (connId, sid) => manager.closeShell(connId, sid));
  h('ssh:cwd', (connId, sid) => manager.shellCwd(connId, sid));
  h('ssh:stats', (connId) => manager.stats(connId));
  ipcMain.on('ssh:write', (_e, connId, data, sid) => manager.write(connId, data, sid));
  ipcMain.on('ssh:resize', (_e, connId, cols, rows, sid) => manager.resize(connId, cols, rows, sid));
  h('ssh:disconnect', (connId) => { stopEdits(connId); manager.disconnect(connId); });
  // ---- SFTP ek işleri: uzakta arama, sıkıştırma, arşiv açma (kabuk komutları burada güvenle tırnaklanır)
  const shq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  const safeName = (n) => { if (!n || n.includes('/') || n === '.' || n === '..') throw new Error('Geçersiz ad'); return n; };
  h('sftp:search', async (connId, dir, pattern) => {
    let p = String(pattern || '').trim();
    if (!p) throw new Error('Aranacak adı yazın');
    if (!/[*?[]/.test(p)) p = `*${p}*`;
    const cmd = `find ${shq(dir)} -mindepth 1 \\( -type d -iname ${shq(p)} -exec printf 'd %s\\n' {} + \\) -o \\( -iname ${shq(p)} -exec printf 'f %s\\n' {} + \\) 2>/dev/null | head -n 1001`;
    const r = await manager.exec(connId, cmd, { timeout: 60000 });
    const lines = r.stdout.split('\n').filter((l) => /^[df] \//.test(l));
    return { truncated: lines.length > 1000, items: lines.slice(0, 1000).map((l) => ({ isDir: l[0] === 'd', path: l.slice(2) })) };
  });
  // Seçilenleri sunucuda .tar.gz yapar. tmp: true -> /tmp altına (indirilip silinmek üzere), yoksa aynı klasöre
  h('sftp:compress', async (connId, dir, names, { tmp = false, name } = {}) => {
    const list = (names || []).map(safeName);
    if (!list.length) throw new Error('Seçim yok');
    const base = safeName(name || (list.length === 1 ? list[0] : path.posix.basename(dir) || 'arsiv') + '.tar.gz');
    const out = tmp ? `/tmp/sshdeck-${crypto.randomBytes(6).toString('hex')}-${base}` : path.posix.join(dir, base);
    const r = await manager.exec(connId, `cd ${shq(dir)} && tar czf ${shq(out)} -- ${list.map(shq).join(' ')}`, { timeout: 600000 });
    if (r.code !== 0) throw new Error(`Sıkıştırılamadı: ${(r.stderr || '').trim().split('\n').slice(-2).join(' ') || 'çıkış kodu ' + r.code}`);
    return { path: out, name: base };
  });
  h('sftp:extract', async (connId, dir, name) => {
    const n = safeName(name);
    const f = shq(n);
    const cmd = /\.(tar\.gz|tgz)$/i.test(n) ? `tar xzf ${f}` : /\.(tar\.xz|txz)$/i.test(n) ? `tar xJf ${f}` : /\.(tar\.bz2|tbz2?)$/i.test(n) ? `tar xjf ${f}`
      : /\.(tar\.zst|tzst)$/i.test(n) ? `tar --zstd -xf ${f}` : /\.tar$/i.test(n) ? `tar xf ${f}` : /\.zip$/i.test(n) ? `unzip -o -q ${f}` : /\.gz$/i.test(n) ? `gunzip -k ${f}` : null;
    if (!cmd) throw new Error('Desteklenmeyen arşiv türü (.tar, .tar.gz/.tgz, .tar.xz, .tar.bz2, .tar.zst, .zip, .gz)');
    const r = await manager.exec(connId, `cd ${shq(dir)} && ${cmd}`, { timeout: 600000 });
    if (r.code === 127) throw new Error(`Sunucuda ${cmd.split(' ')[0]} yok`);
    if (r.code !== 0) throw new Error(`Açılamadı: ${(r.stderr || '').trim().split('\n').slice(-2).join(' ') || 'çıkış kodu ' + r.code}`);
    return true;
  });

  h('ssh:installKey', async (connId, ref) => {
    const k = allKeys().find((x) => x.pubPath === ref || x.fingerprint === ref);
    if (!k) throw new Error('Açık anahtar bulunamadı');
    return manager.installPublicKey(connId, k.publicKey);
  });

  // ssh anahtarları: ~/.ssh + hesaptan gelenler (anahtar eşitlemesi; aynı parmak izi bir kez)
  h('keys:list', () => allKeys());
  h('keys:deleteSynced', (fp) => { store.deleteSyncedKey(fp); return allKeys(); });
  h('keys:generate', (opts) => keys.generateKey(path.join(os.homedir(), '.ssh'), opts));

  // oturum kaydı
  h('logs:dir', () => logDir());
  h('logs:open', async () => { const d = logDir(); await fsp.mkdir(d, { recursive: true }); return shell.openPath(d); });
  h('dialog:openDir', async (opts) => {
    const r = await dialog.showOpenDialog(win, { title: opts && opts.title, properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'], defaultPath: expandHome(opts && opts.defaultPath) || os.homedir() });
    return r.canceled ? null : r.filePaths[0];
  });
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
  h('sftp:preview', (c, p) => preview((x, max) => manager.readFile(c, x, max), p));
  h('sync:compare', (c, localDir, remoteDir, exclude) => compareDirs(c, localDir, remoteDir, exclude));
  h('sftp:transfer', (c, t) => { manager.transfer(c, t); return true; });
  h('sftp:cancel', (c, tid) => manager.cancelTransfer(c, tid));
  h('sftp:agentKeys', (c) => manager.agentKeyCount(c));
  h('drag:prepare', (c, tid, items) => prepareDrag(c, tid, items));
  ipcMain.on('drag:start', (e, files) => {
    files = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && path.isAbsolute(f));
    if (files.length) e.sender.startDrag({ file: files[0], files, icon: getDragIcon() });
  });

  // local fs
  h('local:list', (p) => localList(p));
  h('local:mkdir', (p) => fsp.mkdir(p));
  h('local:rename', (a, b) => fsp.rename(a, b));
  h('local:remove', (p) => shell.trashItem(p).catch(() => fsp.rm(p, { recursive: true, force: true })));
  h('local:exists', (p) => fsp.access(p).then(() => true, () => false));
  h('local:open', (p) => shell.openPath(p));
  h('local:reveal', (p) => shell.showItemInFolder(p));
  h('local:resolve', (p) => {
    if (process.platform === 'win32') {
      if (/^(bu bilgisayar|this pc)$/i.test(p)) return DRIVES;
      if (/^[a-z]:$/i.test(p)) p += '\\';
    }
    return path.resolve(expandHome(p));
  });
  h('local:preview', (p) => preview(localRead, p));

  // misc
  h('clipboard:read', () => clipboard.readText());
  h('clipboard:write', (t) => clipboard.writeText(t));
  h('dialog:openFile', async (opts) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'showHiddenFiles'], defaultPath: expandHome(opts && opts.defaultPath) || path.join(os.homedir(), '.ssh') });
    return r.canceled ? null : r.filePaths[0];
  });
  h('update:state', () => updateState());
  h('update:check', () => checkUpdates(true));
  h('update:install', () => installUpdate());
  h('update:cancel', () => { upd.abort?.abort(); });
  h('update:skip', (version) => { store.saveSettings({ updateSkip: version || null }); return updateState(); });
  h('update:schedule', () => scheduleUpdateChecks());
  h('shell:openExternal', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

  manager.on('status', (id, state, msg) => {
    if (state === 'closed' || state === 'error') { stopEdits(id); logger.closePrefix(id + ':'); }
    send('ssh:status', id, state, msg);
  });
  manager.on('shell-data', (id, data, sid) => { send('ssh:data', id, data, sid); logShellData(id, data, sid); });
  manager.on('shell-exit', (id, sid) => { logger.close(`${id}:${sid}`); send('ssh:exit', id, sid); });
  manager.on('banner', (id, msg) => send('ssh:banner', id, msg));
  manager.on('forward', (id, fid, state, msg) => send('ssh:forward', id, fid, state, msg));
  manager.on('transfer', (id, info) => send('sftp:transfer', id, info));
}

// Arayüz temasının pencere arka planı (açılışta beyaz/siyah parlama olmasın) ve yerel diyalogların açık/koyu modu
const UI_BG = { dark: '#0f1115', light: '#f4f5f7', orange: '#15110d', red: '#140e10', pink: '#fdf1f6', peach: '#fdf4ee', lavender: '#f5f3fc', mint: '#f0faf5' };
const LIGHT_UI = new Set(['light', 'pink', 'peach', 'lavender', 'mint']);
function applyNativeTheme() {
  const t = store?.settings.uiTheme;
  nativeTheme.themeSource = LIGHT_UI.has(t) ? 'light' : 'dark';
  if (win) win.setBackgroundColor(UI_BG[t] || UI_BG.dark);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: UI_BG[store.settings.uiTheme] || UI_BG.dark,
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
  let closingConfirmed = false, closeAsking = false;
  win.on('close', (e) => {
    if (!closingConfirmed && manager.conns.size && store.settings.confirmClose) {
      // Onay kutusu durumu için async showMessageBox; kapanışı durdurup onaydan sonra yeniden tetikle
      e.preventDefault();
      if (closeAsking) return;
      closeAsking = true;
      dialog.showMessageBox(win, {
        type: 'question', buttons: ['Kapat', 'Vazgeç'], defaultId: 1, cancelId: 1,
        title: 'SSHDeck', message: `${manager.conns.size} açık bağlantı var. Kapatılsın mı?`,
        checkboxLabel: 'Bir daha sorma (Ayarlar\'dan tekrar açılabilir)',
      }).then(({ response, checkboxChecked }) => {
        closeAsking = false;
        if (response !== 0 || !win) return;
        if (checkboxChecked) store.saveSettings({ confirmClose: false });
        closingConfirmed = true;
        win.close();
      });
      return;
    }
    manager.closeAll();
  });
  win.on('closed', () => { win = null; });
}

// Tek kopya: ikinci kez açılınca yeni pencere açılmaz, açık olan öne getirilir.
// Güncelleme sonrası yeniden başlatılan kopya (RELAUNCH_ARG) eski kopya kapanana kadar kilidi bekler.
const RELAUNCH_ARG = '--sshdeck-relaunch';
async function singleInstance() {
  const relaunched = process.argv.includes(RELAUNCH_ARG);
  for (let i = 0; ; i++) {
    if (app.requestSingleInstanceLock()) return true;
    if (!relaunched || i >= 60) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}
const gotLock = singleInstance();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
});

app.whenReady().then(async () => {
  if (!(await gotLock)) { app.quit(); return; }
  fsp.rm(DRAG_ROOT, { recursive: true, force: true }).catch(() => {});
  store = new Store(path.join(app.getPath('userData')), {
    available: () => { try { return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; } },
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
  });
  store.sshDir = SSH_DIR;
  manager = new SshManager({
    getSession: (id) => resolveKey(store.getSession(id)),
    verifyHostKey,
    prompt: (kind, payload) => uiRequest(kind, payload),
    saveCredentials: (id, creds) => {
      if (!store.getSession(id)) return;
      let err = null;
      try { store.saveSession({ id, ...creds }); } catch (e) {
        err = e.message === 'MASTER_LOCKED' ? 'Ana parola kilitli olduğu için parola kaydedilemedi' : `Bilgiler kaydedilemedi: ${e.message}`;
        if (creds.username) { try { store.saveSession({ id, username: creds.username }); } catch {} }
      }
      send('sessions:updated', store.publicSessions(), err);
    },
  });
  account = new AccountSync(store, { client: `SSHDeck ${app.getVersion()} ${process.platform === 'win32' ? 'Windows' : 'Linux'}` });
  account.on('status', (st) => send('account:status', st));
  account.on('changed', () => { applyNativeTheme(); send('account:changed', { sessions: store.publicSessions(), settings: store.publicSettings() }); });
  registerIpc();
  applyNativeTheme();
  createWindow();
  win.webContents.once('did-finish-load', () => account.start());
  // Pencereye dönünce (başka cihazda değişmiş olabilir) en fazla 30 sn'de bir eşitle
  win.on('focus', () => { const a = account.status(); if (a.loggedIn && Date.now() - a.lastSync > 30000) account.syncNow().catch(() => {}); });
  scheduleUpdateChecks();
  // Uykudan uyanınca: renderer kopmuş bağlantıları hemen yeniden denesin
  powerMonitor.on('resume', () => { send('app:resume'); setTimeout(() => account.syncNow().catch(() => {}), 5000); });
});

app.on('window-all-closed', () => { if (account) account.stop(); if (manager) manager.closeAll(); logger.closeAll(); app.quit(); });
app.on('will-quit', () => { try { fs.rmSync(DRAG_ROOT, { recursive: true, force: true }); } catch {} });
