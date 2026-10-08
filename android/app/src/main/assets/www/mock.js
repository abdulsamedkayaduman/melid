// Tarayıcıda arayüz geliştirme/test için sahte native katman (APK'da kullanılmaz: SSHDeckNative vardır).
const emit = (type, data) => setTimeout(() => window.__nevent([[type, data]]), 0);
const reply = (id, err, res) => setTimeout(() => window.__nreply(id, err, res === undefined ? null : res), 30);
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const LS = 'sshdeck-mock';
let db = null;
if (!window.SSHDeckNative) { try { db = JSON.parse(localStorage.getItem(LS)); } catch { /* yok */ } }
db = db || {
  sessions: [
    { id: 's1', name: 'web-1', group: 'Prod', host: '10.0.0.5', port: 22, username: 'root', authType: 'password', password: 'x' },
    { id: 's2', name: 'db-master', group: 'Prod/DB', host: 'db.example.com', port: 2222, username: 'postgres', authType: 'key', keyId: 'k1' },
    { id: 's3', name: 'raspberry', group: '', host: '192.168.1.40', port: 22, username: 'pi', authType: 'password',
      forwards: [{ id: 'f1', type: 'L', bindHost: '127.0.0.1', bindPort: 8080, dstHost: '127.0.0.1', dstPort: 80, enabled: true }] },
  ],
  settings: {},
  keys: [{ id: 'k1', name: 'id_ed25519', type: 'ssh-ed25519', public: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyMockKeyMockKey sshdeck@android', fingerprint: 'SHA256:mockmockmockmockmock', created: Date.now() }],
  known: {},
};
const save = () => { try { localStorage.setItem(LS, JSON.stringify(db)); } catch { /* yok */ } };
const pub = (s) => { const o = { ...s, has_password: !!s.password, has_passphrase: !!s.passphrase }; delete o.password; delete o.passphrase; return o; };

const asks = new Map();
let askSeq = 0;
const ask = (kind, p) => new Promise((res) => { const id = 'a' + (++askSeq); asks.set(id, res); emit('ask', { ...p, kind, askId: id }); });

const shells = new Map(); // c -> { line }
const conns = new Set();
const prompt = (c) => emit('data', { c, s: 'main', d: b64('\x1b[1;32mroot@mock\x1b[0m:\x1b[1;34m~\x1b[0m$ ') });

const FS = {
  '/root': [['projeler', 'd'], ['.bashrc', 'f', 3771], ['notlar.txt', 'f', 120], ['yedek.tar.gz', 'f', 734003200], ['foto.png', 'f', 2048], ['link', 'l', 10]],
  '/root/projeler': [['sshdeck', 'd'], ['README.md', 'f', 2048]],
  '/root/projeler/sshdeck': [['main.js', 'f', 10240]],
  '/': [['root', 'd'], ['etc', 'd'], ['var', 'd'], ['home', 'd']],
};

async function handle(id, m, a) {
  switch (m) {
    case 'state': return { sessions: db.sessions.map(pub), settings: db.settings, keys: db.keys, knownHosts: db.known };
    case 'saveSession': {
      const s = a.session; const sid = s.id || 'id' + Math.random().toString(36).slice(2);
      const i = db.sessions.findIndex((x) => x.id === sid);
      const prev = i >= 0 ? db.sessions[i] : {};
      const next = { ...prev, ...s, id: sid };
      for (const k of Object.keys(next)) if (k.startsWith('has_')) delete next[k];
      for (const f of ['password', 'passphrase']) { if (s[f] === undefined) next[f] = prev[f]; else if (s[f] === '') delete next[f]; }
      if (i >= 0) db.sessions[i] = next; else db.sessions.push(next);
      save(); return sid;
    }
    case 'deleteSession': db.sessions = db.sessions.filter((x) => x.id !== a.id); save(); return null;
    case 'saveSettings': Object.assign(db.settings, a.patch); save(); return null;
    case 'removeKnownHost': delete db.known[a.key]; save(); return null;
    case 'connect': {
      const s = db.sessions.find((x) => x.id === a.sessionId);
      if (!s) throw new Error('Oturum bulunamadı');
      emit('status', { c: a.c, state: 'connecting', message: s.host + ' bağlanılıyor…' });
      await new Promise((r) => setTimeout(r, 600));
      if (s.host.includes('fail')) throw new Error('Bağlantı reddedildi: ' + s.host + ':' + (s.port || 22));
      const hp = `[${s.host}]:${s.port || 22}`;
      if (!db.known[hp]) {
        const r = await ask('hostkey', { host: s.host, port: s.port || 22, type: 'ssh-ed25519', fingerprint: 'SHA256:Nq3x8mockFingerprintAbCdEf0123456789', changed: false });
        if (!r || !r.accept) throw new Error('Sunucu anahtarı reddedildi: ' + s.host);
        if (r.save) { db.known[hp] = { type: 'ssh-ed25519', fingerprint: 'SHA256:Nq3x8mock', added: Date.now() }; save(); }
      }
      if (!s.password && s.authType === 'password') {
        const r = await ask('password', { title: 'Parola', message: `${s.username}@${s.host} parolası`, canSave: !s.temporary });
        if (!r) throw new Error('İptal edildi');
        if (r.save) { s.password = r.value; save(); emit('stateChanged', {}); }
      }
      conns.add(a.c);
      return { ok: true, serverVersion: 'SSH-2.0-OpenSSH_9.6 (mock)' };
    }
    case 'disconnect': conns.delete(a.c); emit('closed', { c: a.c, reason: 'user' }); return null;
    case 'disconnectAll': for (const c of conns) emit('closed', { c, reason: 'user' }); conns.clear(); return null;
    case 'openShell':
      shells.set(a.c, { line: '' });
      emit('data', { c: a.c, s: a.s, d: b64(`Welcome to Mock Linux (${a.cols}x${a.rows})\r\n\r\n`) });
      prompt(a.c);
      return null;
    case 'closeShell': return null;
    case 'exec':
      if (a.cmd.includes('/proc/stat')) return { code: 0, stdout: '', stderr: '' };
      if (a.cmd.includes('readlink')) return { code: 0, stdout: '1234\n/root/projeler\n', stderr: '' };
      return { code: 0, stdout: 'ok\n', stderr: '' };
    case 'stats': {
      const t = Date.now() / 1000;
      return { code: 0, stderr: '', stdout: `@@cpu\ncpu ${Math.floor(t * 40)} 0 ${Math.floor(t * 10)} ${Math.floor(t * 100)} 0 0 0 0\n@@mem\nMemTotal: 8000000 kB\nMemAvailable: 3000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1500000 kB\n@@net\n  eth0: ${Math.floor(t * 5000)} 0 0 0 0 0 0 0 ${Math.floor(t * 2000)} 0\n@@disk\n/dev/sda1 100000000 42000000 58000000 42% /\n@@up\n123456.7 0\n@@load\n0.42 0.36 0.30 1/200 999\n@@nproc\n4\n` };
    }
    case 'installKey': return 'added';
    case 'sftpHome': return '/root';
    case 'sftpList': {
      const p = a.path || '/root';
      if (!FS[p]) throw new Error('Dosya ya da klasör bulunamadı');
      return { path: p, entries: FS[p].map(([name, type, size]) => ({ name, type, size: size || 4096, mtime: Date.now() - Math.random() * 1e9, perm: (type === 'd' ? 'd' : '-') + 'rw-r--r--', mode: 0o644, linkDir: type === 'l' ? true : undefined })) };
    }
    case 'sftpRead': return { size: 120, binary: false, text: 'Merhaba dünya\nBu bir deneme dosyasıdır.\n' };
    case 'sftpWrite': case 'sftpMkdir': case 'sftpRename': case 'sftpRemove': case 'sftpChmod': return null;
    case 'download': case 'upload': {
      let done = 0; const total = 5e6;
      const t = setInterval(() => {
        done += 1e6;
        emit('xfer', { id: a.t, state: done >= total ? 'done' : 'run', done, total, file: m === 'download' ? a.path.split('/').pop() : 'resim.jpg' });
        if (done >= total) clearInterval(t);
      }, 300);
      return m === 'upload' ? ['resim.jpg'] : null;
    }
    case 'cancelXfer': return null;
    case 'openDownloaded': return null;
    case 'fwdStart': emit('fwd', { c: a.c, id: a.fw.id, state: 'on', port: a.fw.bindPort }); return { port: a.fw.bindPort };
    case 'fwdStop': emit('fwd', { c: a.c, id: a.id, state: 'off' }); return null;
    case 'fwdActive': return [];
    case 'keyGenerate': { const k = { id: 'k' + Date.now(), name: a.name || 'id_ed25519', type: 'ssh-' + a.type, public: `ssh-${a.type} AAAAmock ${a.comment}`, fingerprint: 'SHA256:new', created: Date.now() }; db.keys.push(k); save(); return k.id; }
    case 'keyImport': { const k = { id: 'k' + Date.now(), name: a.name, type: 'ssh-ed25519', public: 'ssh-ed25519 AAAAimported', fingerprint: 'SHA256:imp', created: Date.now() }; db.keys.push(k); save(); return k.id; }
    case 'keyInspect': return { encrypted: false, type: 'ssh-ed25519', public: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:x' };
    case 'keyDelete': db.keys = db.keys.filter((k) => k.id !== a.id); save(); return null;
    case 'keyRename': db.keys.find((k) => k.id === a.id).name = a.name; save(); return null;
    case 'keyExportPrivate': return 'İndirilenler/SSHDeck/' + a.name;
    case 'pickTextFile': return null;
    case 'importBackup': return { added: 0, updated: 0, withPassword: 0, found: 0 };
    case 'exportBackup': return 'İndirilenler/SSHDeck/sshdeck-yedek.json';
    case 'clipboardSet': try { await navigator.clipboard.writeText(a.text); } catch { /* yok */ } return null;
    case 'clipboardGet': try { return await navigator.clipboard.readText(); } catch { return 'echo pano'; }
    case 'appInfo': return { version: '1.0.0 (tarayıcı)', android: '-', conns: conns.size };
    default: return null;
  }
}

export default {
  call(id, m, args) {
    handle(id, m, JSON.parse(args)).then((r) => reply(id, null, r), (e) => reply(id, e.message));
  },
  write(c, s, data) {
    const sh = shells.get(c);
    if (!sh) return;
    let out = '';
    for (const ch of data) {
      if (ch === '\r') {
        out += '\r\n';
        if (sh.line.trim()) out += `mock: ${sh.line.trim()}: komut çalıştırıldı\r\n`;
        if (sh.line.trim() === 'exit') { emit('data', { c, s, d: b64(out) }); setTimeout(() => emit('exit', { c, s }), 50); return; }
        if (sh.line.trim() === 'renk') for (let i = 0; i < 8; i++) out += `\x1b[3${i}m██ renk ${i}\x1b[0m  \x1b[9${i}m██ parlak\x1b[0m\r\n`;
        if (sh.line.trim() === 'uzun') for (let i = 0; i < 200; i++) out += `satır ${i} ${'─'.repeat(30)}\r\n`;
        sh.line = '';
        emit('data', { c, s, d: b64(out) }); out = '';
        prompt(c);
      } else if (ch === '\x7f') {
        if (sh.line) { sh.line = sh.line.slice(0, -1); out += '\b \b'; }
      } else if (ch === '\x1b' || ch < ' ') {
        out += JSON.stringify(ch).slice(1, -1).replace(/\\u00/g, '^');
      } else { sh.line += ch; out += ch; }
    }
    if (out) emit('data', { c, s, d: b64(out) });
  },
  resize() {},
  answer(id, json) { const r = asks.get(id); if (r) { asks.delete(id); r(JSON.parse(json)); } },
  termInput() {},
};
