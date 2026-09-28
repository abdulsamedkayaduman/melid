'use strict';
// SSH connection manager: connections (with jump hosts), shells, SFTP, transfers, port forwards.
// Deliberately free of Electron imports so it can be tested with plain Node.
const { Client, utils } = require('ssh2');
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { createSocksServer } = require('./socks');

const rpath = path.posix;

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function keyType(buf) {
  try { const len = buf.readUInt32BE(0); return buf.subarray(4, 4 + len).toString(); } catch { return 'bilinmiyor'; }
}

class CancelError extends Error { constructor() { super('İptal edildi'); this.cancelled = true; } }

function friendlyError(e, s) {
  const m = (e && e.message) || String(e);
  const where = `${s.host}:${s.port || 22}`;
  if (e && e.cancelled) return e;
  if (/All configured authentication methods failed/i.test(m)) return new Error(`Kimlik doğrulama başarısız (${s.username || '?'}@${where})`);
  if (/ECONNREFUSED/.test(m)) return new Error(`Bağlantı reddedildi: ${where}`);
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return new Error(`Sunucu adı çözülemedi: ${s.host}`);
  if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(m)) return new Error(`Zaman aşımı: ${where}`);
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return new Error(`Sunucuya ulaşılamıyor: ${where}`);
  if (/Host denied/i.test(m)) return new Error(`Sunucu anahtarı reddedildi: ${where}`);
  return new Error(m);
}

const p1 = (fn) => new Promise((res, rej) => fn((err, v) => (err ? rej(err) : res(v))));

class SshManager extends EventEmitter {
  /**
   * hooks:
   *   getSession(id) -> session with decrypted secrets (for jump hosts)
   *   verifyHostKey({host, port, type, fingerprint}) -> Promise<boolean>
   *   prompt(kind, payload) -> Promise<any|null>   kind: 'text' | 'password' | 'kbd'
   */
  constructor(hooks) {
    super();
    this.hooks = hooks;
    this.conns = new Map();
  }

  _get(id) {
    const c = this.conns.get(id);
    if (!c || !c.client) throw new Error('Bağlantı yok');
    return c;
  }

  _status(id, state, message) { this.emit('status', id, state, message); }

  _resolveChain(session) {
    const chain = [session];
    const seen = new Set([session.id]);
    let cur = session;
    while (cur.jumpHostId) {
      const j = this.hooks.getSession(cur.jumpHostId);
      if (!j) throw new Error('Jump host oturumu bulunamadı');
      if (seen.has(j.id) || chain.length > 6) throw new Error('Jump host zincirinde döngü var');
      seen.add(j.id);
      chain.unshift(j);
      cur = j;
    }
    return chain;
  }

  async connect(id, session) {
    if (this.conns.has(id)) throw new Error('Bu sekme zaten bağlı');
    const conn = { id, session, client: null, chain: [], sftpP: null, shell: null, forwards: new Map(), transfers: new Map(), outBuf: '', closing: false };
    this.conns.set(id, conn);
    try {
      const chain = this._resolveChain(session);
      let sock = null;
      for (let i = 0; i < chain.length; i++) {
        const s = chain[i];
        const via = i > 0 ? ` (${chain[i - 1].host} üzerinden)` : '';
        this._status(id, 'connecting', `${s.host}:${s.port || 22} bağlanılıyor${via}…`);
        const client = await this._connectOne(id, s, sock);
        conn.chain.push(client);
        if (conn.closing) throw new CancelError();
        if (i < chain.length - 1) {
          const next = chain[i + 1];
          sock = await p1((cb) => client.forwardOut('127.0.0.1', 0, next.host, Number(next.port) || 22, cb));
        }
      }
      conn.client = conn.chain[conn.chain.length - 1];
      conn.client.on('tcp connection', (info, accept, reject) => this._onRemoteConn(conn, info, accept, reject));
      conn.client.on('close', () => this._onClosed(conn));
      conn.client.on('error', (e) => this._status(id, 'error', e.message));
      const target = chain[chain.length - 1];
      this._status(id, 'connected', `${target.username}@${target.host}:${target.port || 22}`);
      for (const fw of session.forwards || []) {
        if (fw.enabled === false) continue;
        this.startForward(id, fw).catch(() => {});
      }
    } catch (e) {
      this._teardown(conn);
      this.conns.delete(id);
      const fe = friendlyError(e, session);
      this._status(id, fe.cancelled ? 'closed' : 'error', fe.message);
      throw fe;
    }
  }

  async _connectOne(id, s, sock) {
    const cfg = {
      host: s.host,
      port: Number(s.port) || 22,
      username: s.username,
      readyTimeout: 300000,
      keepaliveInterval: (Number(s.keepalive) || 30) * 1000,
      keepaliveCountMax: 4,
    };
    if (sock) cfg.sock = sock;
    cfg.hostVerifier = (key, cb) => {
      Promise.resolve(this.hooks.verifyHostKey({ host: s.host, port: cfg.port, type: keyType(key), fingerprint: fingerprint(key) }))
        .then((ok) => cb(!!ok), () => cb(false));
    };

    if (!cfg.username) {
      const u = await this.hooks.prompt('text', { title: `${s.host} için kullanıcı adı`, label: 'Kullanıcı adı' });
      if (u == null || u === '') throw new CancelError();
      cfg.username = u;
      s.username = u;
    }

    const auth = s.authType || 'password';
    const username = cfg.username;
    const who = `${username}@${s.host}`;
    const methods = []; // tried in order before falling back to password / keyboard-interactive prompts
    const loadKey = async (keyPath, savedPass, required) => {
      let buf;
      try { buf = fs.readFileSync(keyPath); } catch (e) { if (required) throw new Error(`Anahtar dosyası okunamadı: ${keyPath}`); return; }
      let pass = savedPass || undefined;
      let parsed = utils.parseKey(buf, pass);
      for (let tries = 0; parsed instanceof Error && /encrypt|passphrase|decrypt|bad/i.test(parsed.message) && tries < 3; tries++) {
        if (!required) return; // default keys: skip encrypted ones silently
        pass = await this.hooks.prompt('password', { title: 'Anahtar parolası', label: path.basename(keyPath) + (tries ? ' (hatalı, tekrar deneyin)' : '') });
        if (pass == null) throw new CancelError();
        parsed = utils.parseKey(buf, pass);
      }
      if (parsed instanceof Error) { if (required) throw new Error(`Anahtar okunamadı: ${parsed.message}`); return; }
      methods.push({ type: 'publickey', username, key: buf, passphrase: pass });
    };
    const agentSock = process.env.SSH_AUTH_SOCK;
    if (auth === 'key') {
      await loadKey(expandHome(s.keyPath || '~/.ssh/id_ed25519'), s.passphrase, true);
    } else if (auth === 'agent') {
      if (!agentSock) throw new Error('ssh-agent bulunamadı (SSH_AUTH_SOCK tanımlı değil)');
      methods.push({ type: 'agent', username, agent: agentSock });
    } else if (auth === 'auto') {
      if (agentSock) methods.push({ type: 'agent', username, agent: agentSock });
      for (const k of ['id_ed25519', 'id_ecdsa', 'id_rsa']) await loadKey(path.join(os.homedir(), '.ssh', k), undefined, false);
    }

    let savedPassword = s.password || undefined;
    let pwTries = 0;
    let cancelled = false;
    const askPassword = async () => {
      if (savedPassword) { const p = savedPassword; savedPassword = undefined; return p; }
      if (pwTries >= 3) return null;
      const p = await this.hooks.prompt('password', { title: who, label: pwTries++ ? 'Parola hatalı, tekrar deneyin' : 'Parola' });
      if (p == null) cancelled = true;
      return p;
    };
    const kbdPrompt = (name, instructions, lang, prompts, finish) => {
      if (!prompts.length) return finish([]);
      if (prompts.length === 1 && !prompts[0].echo && /pass|parola|şifre/i.test(prompts[0].prompt)) {
        askPassword().then((p) => finish(p == null ? [] : [p]));
        return;
      }
      Promise.resolve(this.hooks.prompt('kbd', { title: name || who, instructions, prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })) }))
        .then((ans) => { if (ans == null) cancelled = true; finish(Array.isArray(ans) ? ans : []); }, () => finish([]));
    };
    const allows = (left, t) => !left || left.includes(t);
    cfg.authHandler = (left, partial, cb) => {
      if (cancelled) return cb(false);
      while (methods.length) {
        const m = methods.shift();
        if (allows(left, 'publickey')) return cb(m);
      }
      if (allows(left, 'password')) {
        askPassword().then((p) => (p == null || cancelled ? cb(false) : cb({ type: 'password', username, password: p })));
        return;
      }
      if (allows(left, 'keyboard-interactive') && pwTries < 3) {
        pwTries++;
        return cb({ type: 'keyboard-interactive', username, prompt: kbdPrompt });
      }
      cb(false);
    };

    // Own TCP socket for direct connections so a dead host fails fast while prompts can take their time.
    if (!sock) {
      sock = await new Promise((resolve, reject) => {
        const t = net.connect({ host: cfg.host, port: cfg.port });
        const timer = setTimeout(() => { t.destroy(); reject(new Error('ETIMEDOUT')); }, 15000);
        t.once('connect', () => { clearTimeout(timer); t.setNoDelay(true); resolve(t); });
        t.once('error', (e) => { clearTimeout(timer); reject(e); });
      });
      cfg.sock = sock;
    }

    const client = new Client();
    client.on('banner', (msg) => this.emit('banner', id, msg));

    await new Promise((resolve, reject) => {
      let done = false;
      client.once('ready', () => { done = true; resolve(); });
      client.on('error', (e) => { if (!done) { done = true; reject(cancelled ? new CancelError() : e); } });
      client.connect(cfg);
    });
    return client;
  }

  _onClosed(conn) {
    if (!this.conns.has(conn.id)) return;
    this._teardown(conn);
    this.conns.delete(conn.id);
    this._status(conn.id, 'closed', conn.closing ? 'Bağlantı kapatıldı' : 'Bağlantı koptu');
  }

  _teardown(conn) {
    for (const [fid] of conn.forwards) { try { this._stopForwardRec(conn, fid); } catch {} }
    for (const t of conn.transfers.values()) { t.cancelled = true; try { t.sftp && t.sftp.end(); } catch {} }
    for (const c of [...conn.chain].reverse()) { try { c.end(); } catch {} }
  }

  disconnect(id) {
    const conn = this.conns.get(id);
    if (!conn) return;
    conn.closing = true;
    if (!conn.client) { this._teardown(conn); return; } // mid-connect: connect() will clean up
    this._teardown(conn);
    // 'close' event will fire and emit the status; safety net if it doesn't:
    setTimeout(() => this._onClosed(conn), 1500);
  }

  // ---------------- shell ----------------
  async openShell(id, cols, rows, startupCommand) {
    const conn = this._get(id);
    const stream = await p1((cb) => conn.client.shell({ term: 'xterm-256color', cols, rows }, cb));
    conn.shell = stream;
    const dec = new StringDecoder('utf8');
    const push = (d) => {
      conn.outBuf += dec.write(d);
      if (!conn.flushT) conn.flushT = setTimeout(() => { conn.flushT = null; const b = conn.outBuf; conn.outBuf = ''; if (b) this.emit('shell-data', id, b); }, 6);
    };
    stream.on('data', push);
    stream.stderr.on('data', push);
    stream.on('close', () => {
      if (conn.shell === stream) conn.shell = null;
      this.emit('shell-exit', id);
    });
    if (startupCommand) setTimeout(() => stream.write(startupCommand.replace(/\r?\n?$/, '\n')), 300);
  }

  write(id, data) { const c = this.conns.get(id); if (c && c.shell) c.shell.write(data); }
  resize(id, cols, rows) { const c = this.conns.get(id); if (c && c.shell) c.shell.setWindow(rows, cols, 0, 0); }

  // ---------------- sftp ----------------
  _sftp(conn) {
    if (!conn.sftpP) {
      conn.sftpP = p1((cb) => conn.client.sftp(cb)).then((s) => {
        s.on('close', () => { conn.sftpP = null; });
        return s;
      }, (e) => { conn.sftpP = null; throw e; });
    }
    return conn.sftpP;
  }

  async home(id) {
    const s = await this._sftp(this._get(id));
    return p1((cb) => s.realpath('.', cb));
  }

  async realpath(id, p) {
    const s = await this._sftp(this._get(id));
    return p1((cb) => s.realpath(p, cb));
  }

  async list(id, dir) {
    const s = await this._sftp(this._get(id));
    const entries = await p1((cb) => s.readdir(dir, cb));
    return Promise.all(entries.map(async (e) => {
      const a = e.attrs;
      const fmt = a.mode & 0o170000;
      const isLink = fmt === 0o120000;
      let isDir = fmt === 0o040000;
      if (isLink) {
        try { const st = await p1((cb) => s.stat(rpath.join(dir, e.filename), cb)); isDir = st.isDirectory(); } catch {}
      }
      const cols = (e.longname || '').split(/\s+/);
      return {
        name: e.filename, size: a.size, mtime: a.mtime * 1000, mode: a.mode,
        isDir, isLink, owner: cols[2] || String(a.uid), group: cols[3] || String(a.gid),
      };
    }));
  }

  async mkdir(id, p) { const s = await this._sftp(this._get(id)); return p1((cb) => s.mkdir(p, cb)); }
  async rename(id, a, b) { const s = await this._sftp(this._get(id)); return p1((cb) => s.rename(a, b, cb)); }
  async chmod(id, p, mode) { const s = await this._sftp(this._get(id)); return p1((cb) => s.chmod(p, mode, cb)); }
  async exists(id, p) { const s = await this._sftp(this._get(id)); try { await p1((cb) => s.lstat(p, cb)); return true; } catch { return false; } }

  async remove(id, p) {
    const s = await this._sftp(this._get(id));
    const rm = async (x) => {
      const st = await p1((cb) => s.lstat(x, cb));
      if (st.isDirectory()) {
        const list = await p1((cb) => s.readdir(x, cb));
        for (const e of list) await rm(rpath.join(x, e.filename));
        await p1((cb) => s.rmdir(x, cb));
      } else {
        await p1((cb) => s.unlink(x, cb));
      }
    };
    await rm(p);
  }

  async fastGet(id, remote, local) { const s = await this._sftp(this._get(id)); return p1((cb) => s.fastGet(remote, local, cb)); }
  async fastPut(id, local, remote) { const s = await this._sftp(this._get(id)); return p1((cb) => s.fastPut(local, remote, cb)); }

  // ---------------- transfers ----------------
  // Each transfer gets its own SFTP channel so it can be cancelled and doesn't block browsing.
  async transfer(id, t) {
    // t: { tid, direction: 'download'|'upload', items: [{src, dst}] }
    const conn = this._get(id);
    const rec = { cancelled: false, sftp: null };
    conn.transfers.set(t.tid, rec);
    const emit = (extra) => this.emit('transfer', id, { tid: t.tid, ...extra });
    let total = 0; let done = 0; let lastEmit = 0;
    const tick = (file, force) => {
      const now = Date.now();
      if (force || now - lastEmit > 120) { lastEmit = now; emit({ state: 'running', done, total, file }); }
    };
    try {
      rec.sftp = await p1((cb) => conn.client.sftp(cb));
      const sftp = rec.sftp;
      const jobs = []; // {src, dst, size, mtime, dir}
      const walkRemote = async (src, dst) => {
        const st = await p1((cb) => sftp.stat(src, cb));
        if (st.isDirectory()) {
          jobs.push({ src, dst, dir: true });
          const list = await p1((cb) => sftp.readdir(src, cb));
          for (const e of list) await walkRemote(rpath.join(src, e.filename), path.join(dst, e.filename));
        } else { jobs.push({ src, dst, size: st.size, mtime: st.mtime, atime: st.atime }); total += st.size; }
      };
      const walkLocal = async (src, dst) => {
        const st = await fsp.stat(src);
        if (st.isDirectory()) {
          jobs.push({ src, dst, dir: true });
          for (const name of await fsp.readdir(src)) await walkLocal(path.join(src, name), rpath.join(dst, name));
        } else { jobs.push({ src, dst, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), atime: Math.floor(st.atimeMs / 1000), mode: st.mode & 0o777 }); total += st.size; }
      };
      emit({ state: 'scanning', done: 0, total: 0 });
      for (const it of t.items) {
        if (t.direction === 'download') await walkRemote(it.src, it.dst); else await walkLocal(it.src, it.dst);
      }
      for (const j of jobs) {
        if (rec.cancelled) throw new CancelError();
        if (j.dir) {
          if (t.direction === 'download') await fsp.mkdir(j.dst, { recursive: true });
          else { try { await p1((cb) => sftp.mkdir(j.dst, cb)); } catch (e) { /* exists */ } }
          continue;
        }
        const base = done;
        const step = (sofar) => { done = base + sofar; tick(j.src); };
        const name = t.direction === 'download' ? path.basename(j.dst) : rpath.basename(j.dst);
        tick(name, true);
        if (t.direction === 'download') {
          await p1((cb) => sftp.fastGet(j.src, j.dst, { step }, cb));
          try { await fsp.utimes(j.dst, j.atime, j.mtime); } catch {}
        } else {
          await p1((cb) => sftp.fastPut(j.src, j.dst, { step, mode: j.mode }, cb));
          try { await p1((cb) => sftp.utimes(j.dst, j.atime, j.mtime, cb)); } catch {}
        }
        done = base + j.size;
      }
      emit({ state: 'done', done: total, total });
    } catch (e) {
      emit({ state: rec.cancelled ? 'cancelled' : 'error', done, total, error: rec.cancelled ? 'İptal edildi' : e.message });
    } finally {
      try { rec.sftp && rec.sftp.end(); } catch {}
      conn.transfers.delete(t.tid);
    }
  }

  cancelTransfer(id, tid) {
    const c = this.conns.get(id);
    const rec = c && c.transfers.get(tid);
    if (!rec) return;
    rec.cancelled = true;
    try { rec.sftp && rec.sftp.end(); } catch {}
  }

  // ---------------- port forwarding ----------------
  listForwards(id) {
    const c = this.conns.get(id);
    if (!c) return [];
    return [...c.forwards.values()].map((r) => ({ id: r.fw.id, active: true, conns: r.sockets.size }));
  }

  async startForward(id, fw) {
    const conn = this._get(id);
    if (conn.forwards.has(fw.id)) return;
    const rec = { fw, server: null, sockets: new Set(), remotePort: null };
    const track = (s) => { rec.sockets.add(s); s.on('close', () => rec.sockets.delete(s)); };
    const bindHost = fw.bindHost || '127.0.0.1';
    const bindPort = Number(fw.bindPort);
    try {
      if (fw.type === 'L' || fw.type === 'D') {
        if (fw.type === 'L') {
          rec.server = net.createServer((sock) => {
            track(sock);
            sock.on('error', () => {});
            sock.pause();
            conn.client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, fw.dstHost, Number(fw.dstPort), (err, ch) => {
              if (err) { this.emit('forward', id, fw.id, 'warn', `Hedefe açılamadı: ${err.message}`); sock.destroy(); return; }
              sock.pipe(ch).pipe(sock);
              ch.on('error', () => sock.destroy());
              ch.on('close', () => sock.destroy());
              sock.on('close', () => { try { ch.close(); } catch {} });
              sock.resume();
            });
          });
        } else {
          rec.server = createSocksServer((host, port, done) => {
            conn.client.forwardOut('127.0.0.1', 0, host, port, (err, ch) => done(err, ch));
          });
          rec.server.on('connection', track);
        }
        await new Promise((res, rej) => {
          rec.server.once('error', rej);
          rec.server.listen(bindPort, bindHost, () => { rec.server.removeListener('error', rej); res(); });
        });
        rec.server.on('error', (e) => this.emit('forward', id, fw.id, 'error', e.message));
      } else if (fw.type === 'R') {
        rec.remotePort = await p1((cb) => conn.client.forwardIn(bindHost, bindPort, cb));
        rec.remoteBind = bindHost;
      } else {
        throw new Error('Bilinmeyen tünel türü');
      }
      conn.forwards.set(fw.id, rec);
      this.emit('forward', id, fw.id, 'active', '');
    } catch (e) {
      try { rec.server && rec.server.close(); } catch {}
      const msg = /EADDRINUSE/.test(e.message) ? `Port kullanımda: ${bindHost}:${bindPort}` : e.message;
      this.emit('forward', id, fw.id, 'error', msg);
      throw new Error(msg);
    }
  }

  _onRemoteConn(conn, info, accept, reject) {
    const rec = [...conn.forwards.values()].find((r) => r.fw.type === 'R' && (r.remotePort || Number(r.fw.bindPort)) === info.destPort);
    if (!rec) return reject();
    const ch = accept();
    const s = net.connect(Number(rec.fw.dstPort), rec.fw.dstHost || '127.0.0.1');
    rec.sockets.add(s);
    s.on('close', () => rec.sockets.delete(s));
    s.on('error', () => { try { ch.close(); } catch {} });
    ch.on('error', () => s.destroy());
    ch.on('close', () => s.destroy());
    s.pipe(ch).pipe(s);
  }

  _stopForwardRec(conn, fid) {
    const rec = conn.forwards.get(fid);
    if (!rec) return;
    conn.forwards.delete(fid);
    for (const s of rec.sockets) { try { s.destroy(); } catch {} }
    if (rec.server) { try { rec.server.close(); } catch {} }
    if (rec.fw.type === 'R') { try { conn.client.unforwardIn(rec.remoteBind, rec.remotePort, () => {}); } catch {} }
    this.emit('forward', conn.id, fid, 'stopped', '');
  }

  stopForward(id, fid) {
    const conn = this.conns.get(id);
    if (conn) this._stopForwardRec(conn, fid);
  }

  closeAll() { for (const id of [...this.conns.keys()]) this.disconnect(id); }
}

module.exports = { SshManager, expandHome, fingerprint };
