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

// Terminal cwd (Linux /proc): find this connection's interactive shell by $SSH_CONNECTION
// (session leader with a tty), then read the cwd of its foreground process group.
// No single quotes inside: it is wrapped in sh -c '...' so it also works under fish etc.
// Aynı bağlantıdaki kabuklar aynı $SSH_CONNECTION'ı paylaşır: diğer kabukların pid'leri (exclude) atlanır.
const CWD_SCRIPT = (pid, exclude = []) => [
  `p=${pid || ''}`,
  `x=" ${exclude.filter((e) => /^\d+$/.test(e)).join(' ')} "`,
  'if [ -z "$p" ] || [ ! -r /proc/$p/stat ]; then p=; for d in /proc/[0-9]*; do q=${d#/proc/}; case "$x" in *" $q "*) continue;; esac; [ -r $d/environ ] || continue;'
    + ' tr "\\0" "\\n" < $d/environ 2>/dev/null | grep -qxF "SSH_CONNECTION=$SSH_CONNECTION" || continue;'
    + ' set -- $(sed "s/^.*) //" $d/stat 2>/dev/null); [ "$4" = "$q" ] && [ "$5" != 0 ] && { p=$q; break; }; done; fi',
  '[ -n "$p" ] || exit 1',
  'set -- $(sed "s/^.*) //" /proc/$p/stat)',
  'echo $p',
  'readlink /proc/$6/cwd 2>/dev/null || readlink /proc/$p/cwd',
].join('\n');

// Sunucu kaynakları: tek exec ile /proc'tan okunur, bölümler @@ ile ayrılır.
const STATS_SCRIPT = [
  'echo @@cpu; head -1 /proc/stat',
  'echo @@mem; grep -E "^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):" /proc/meminfo',
  'echo @@net; tail -n +3 /proc/net/dev',
  'echo @@disk; df -Pk / 2>/dev/null | tail -1',
  'echo @@up; cat /proc/uptime',
  'echo @@load; cat /proc/loadavg',
  'echo @@nproc; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo',
  // açık oturumlar (utmp); who yoksa bölüm hiç yazılmaz
  'command -v who >/dev/null 2>&1 && { echo @@who; who; }',
].join('; ');

// `who` satırları: "kullanıcı tty tarih saat (nereden)". Kayıt yoksa (ör. utmp tutmayan container) null.
function parseWho(lines) {
  if (!lines || !lines.length) return null;
  return lines.map((l) => {
    const f = l.trim().split(/\s+/);
    const from = /\(([^)]*)\)\s*$/.exec(l);
    return { user: f[0], tty: f[1] || '', from: from ? from[1] : '' };
  });
}

const rpath = path.posix;

// SSH agent: SSH_AUTH_SOCK; Windows'ta yoksa OpenSSH agent named pipe'ı, o da yoksa Pageant.
const WIN_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';
function findAgent() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform !== 'win32') return null;
  try { if (fs.existsSync(WIN_AGENT_PIPE)) return WIN_AGENT_PIPE; } catch {}
  return 'pageant';
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\'))) return path.join(os.homedir(), p.slice(2));
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

// Basit ad deseni eşleyici: "node_modules", "*.log", ".git" gibi (yalnızca dosya/klasör adına bakar)
function globMatcher(patterns) {
  const res = (patterns || []).map((x) => String(x).trim()).filter(Boolean)
    .map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'));
  return (name) => res.some((r) => r.test(name));
}

// İki SFTP kanalı arasında dosya kopyalama (fastGet/fastPut gibi paralel: aynı anda PAR parça yolda).
// j: { src, dst, size, mode }; start > 0 ise hedefin o kısmı zaten var (sürdürme). step(kopyalanan bayt).
async function sftpCopy(src, dst, j, start, step, isCancelled) {
  const CHUNK = 32768; const PAR = 32;
  const sh = await p1((cb) => src.open(j.src, 'r', cb));
  let dh = null;
  try {
    dh = await p1((cb) => dst.open(j.dst, start ? 'r+' : 'w', { mode: j.mode }, cb));
    let next = start; let copied = start;
    const worker = async () => {
      while (next < j.size) {
        if (isCancelled()) throw new CancelError();
        const pos = next; const len = Math.min(CHUNK, j.size - pos);
        next += len;
        const buf = Buffer.allocUnsafe(len);
        let got = 0;
        while (got < len) {
          const n = await new Promise((res, rej) => src.read(sh, buf, got, len - got, pos + got, (e, nb) => (e ? rej(e) : res(nb))));
          if (!n) throw new Error('Kaynak dosya kopyalanırken değişti');
          got += n;
        }
        await p1((cb) => dst.write(dh, buf, 0, len, pos, cb));
        copied += len;
        step(copied);
      }
    };
    await Promise.all(Array.from({ length: PAR }, worker));
  } finally {
    src.close(sh, () => {});
    if (dh) await new Promise((res) => dst.close(dh, () => res()));
  }
}

const p1 = (fn) => new Promise((res, rej) => fn((err, v) => (err ? rej(err) : res(v))));

class SshManager extends EventEmitter {
  /**
   * hooks:
   *   getSession(id) -> session with decrypted secrets (for jump hosts)
   *   verifyHostKey({host, port, type, fingerprint}) -> Promise<boolean>
   *   prompt(kind, payload) -> Promise<any|null>   kind: 'text' | 'password' | 'kbd'
   *     payload.canSave: true ise yanıt { value, save } olabilir (kayıtlı oturumlar için "Kaydet" kutusu)
   *   saveCredentials(sessionId, { username?, password?, passphrase? })  bağlantı başarılı olunca çağrılır
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
    const conn = { id, session, client: null, chain: [], sftpP: null, shells: new Map(), forwards: new Map(), transfers: new Map(), closing: false, stat: null };
    this.conns.set(id, conn);
    try {
      const chain = this._resolveChain(session);
      let sock = null;
      for (let i = 0; i < chain.length; i++) {
        let s = chain[i];
        const via = i > 0 ? ` (${chain[i - 1].host} üzerinden)` : '';
        this._status(id, 'connecting', `${s.host}:${s.port || 22} bağlanılıyor${via}…`);
        let client;
        for (let carry = null; ;) {
          try { client = await this._connectOne(id, s, sock, carry); break; } catch (e) {
            if (!e.userChange || conn.closing) throw e;
            // Parola ekranında kullanıcı adı değişti: OpenSSH aynı bağlantıda buna izin vermez, yeni adla baştan bağlan
            carry = e.userChange;
            s = chain[i] = { ...s, username: carry.username, password: carry.password };
            this._status(id, 'connecting', `${s.username}@${s.host}:${s.port || 22} bağlanılıyor${via}…`);
            sock = i > 0 ? await p1((cb) => conn.chain[i - 1].forwardOut('127.0.0.1', 0, s.host, Number(s.port) || 22, cb)) : null;
          }
        }
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
      const target = conn.target = chain[chain.length - 1];
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

  async _connectOne(id, s, sock, carry) {
    const cfg = {
      host: s.host,
      port: Number(s.port) || 22,
      username: s.username,
      readyTimeout: 300000,
      keepaliveInterval: (Number(s.keepalive) || 30) * 1000,
      keepaliveCountMax: 4,
    };
    if (sock) cfg.sock = sock;
    let hostKey = null; // doğrudan sunucu-sunucu aktarımında kaynağa bu anahtar "bilinen sunucu" olarak verilir
    cfg.hostVerifier = (key, cb) => {
      hostKey = key;
      Promise.resolve(this.hooks.verifyHostKey({ host: s.host, port: cfg.port, type: keyType(key), fingerprint: fingerprint(key) }))
        .then((ok) => cb(!!ok), () => cb(false));
    };

    // Kayıtlı oturumlarda sorulan bilgiler "Kaydet" işaretliyse bağlantı başarılı olunca saklanır
    const canSave = !!(s.id && this.hooks.saveCredentials);
    const toSave = { ...(carry && carry.toSave) };
    const ask = async (kind, payload, field) => {
      const r = await this.hooks.prompt(kind, canSave ? { ...payload, canSave: true } : payload);
      if (r && typeof r === 'object') {
        if (r.value != null) { if (r.save) toSave[field] = r.value; else delete toSave[field]; }
        return r.value;
      }
      return r;
    };

    if (!cfg.username) {
      const u = await ask('text', { title: `${s.host} için kullanıcı adı`, label: 'Kullanıcı adı' }, 'username');
      if (u == null || u === '') throw new CancelError();
      cfg.username = u;
      s.username = u;
    }

    const auth = s.authType || 'password';
    const username = cfg.username;
    const who = `${username}@${s.host}`;
    const methods = []; // tried in order before falling back to password / keyboard-interactive prompts
    const loadKey = async (keyPath, savedPass, required, data) => {
      let buf = data;
      if (!buf) try { buf = fs.readFileSync(keyPath); } catch (e) { if (required) throw new Error(`Anahtar dosyası okunamadı: ${keyPath}`); return; }
      let pass = savedPass || undefined;
      let parsed = utils.parseKey(buf, pass);
      for (let tries = 0; parsed instanceof Error && /encrypt|passphrase|decrypt|bad/i.test(parsed.message) && tries < 3; tries++) {
        if (!required) return; // default keys: skip encrypted ones silently
        pass = await ask('password', { title: 'Anahtar parolası', label: path.basename(keyPath) + (tries ? ' (hatalı, tekrar deneyin)' : '') }, 'passphrase');
        if (pass == null) throw new CancelError();
        parsed = utils.parseKey(buf, pass);
      }
      if (parsed instanceof Error) { if (required) throw new Error(`Anahtar okunamadı: ${parsed.message}`); return; }
      methods.push({ type: 'publickey', username, key: buf, passphrase: pass });
    };
    const agentSock = findAgent();
    // Agent yönlendirme yalnız istenen komutta açılır (doğrudan aktarım); bağlantıda kendiliğinden açılmaz
    if (agentSock) { cfg.agent = agentSock; cfg.agentForward = true; }
    if (auth === 'key') {
      // keyData: hesaptan gelen anahtar (dosyası yok; main.js resolveKey)
      await loadKey(s.keyData ? s.keyPath : expandHome(s.keyPath || '~/.ssh/id_ed25519'), s.passphrase, true, s.keyData && Buffer.from(s.keyData));
    } else if (auth === 'agent') {
      if (!agentSock) throw new Error(process.platform === 'win32' ? 'ssh-agent bulunamadı (OpenSSH Authentication Agent hizmeti veya Pageant çalışmıyor)' : 'ssh-agent bulunamadı (SSH_AUTH_SOCK tanımlı değil)');
      methods.push({ type: 'agent', username, agent: agentSock });
    } else if (auth === 'auto') {
      if (agentSock) methods.push({ type: 'agent', username, agent: agentSock });
      for (const k of ['id_ed25519', 'id_ecdsa', 'id_rsa']) await loadKey(path.join(os.homedir(), '.ssh', k), undefined, false);
    }

    let savedPassword = s.password || undefined;
    let pwTries = (carry && carry.pwTries) || 0;
    let cancelled = false;
    let userChange = null;
    let triedSaved = false;
    const askPassword = async () => {
      if (savedPassword) { const p = savedPassword; savedPassword = undefined; triedSaved = true; return p; }
      if (pwTries >= 3) return null;
      // Tekrar sorarken (kayıtlı parola da tutmadıysa) kullanıcı adı da gösterilir ve değiştirilebilir
      const retry = pwTries++ > 0 || triedSaved;
      const r = await this.hooks.prompt('password', {
        title: who, label: retry ? 'Parola hatalı, tekrar deneyin' : 'Parola',
        ...(retry ? { username } : {}), ...(canSave ? { canSave: true } : {}),
      });
      const p = r && typeof r === 'object' ? r.value : r;
      if (p == null) { cancelled = true; return null; }
      const save = !!(r && typeof r === 'object' && r.save);
      if (save) toSave.password = p; else delete toSave.password;
      const u = r && typeof r === 'object' && typeof r.username === 'string' ? r.username.trim() : '';
      if (u && u !== username) {
        if (save) toSave.username = u;
        userChange = { username: u, password: p, pwTries, toSave: { ...toSave } };
        cancelled = true;
        return null;
      }
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
    // Bağlanırken iptal / zaman aşımı: _teardown bu yarım bağlantıyı da kapatsın (soket açık kalmasın)
    const pconn = this.conns.get(id);
    if (pconn) pconn.pending = { client, sock };
    client.on('banner', (msg) => this.emit('banner', id, msg));

    await new Promise((resolve, reject) => {
      let done = false;
      client.once('ready', () => { done = true; resolve(); });
      client.on('error', (e) => {
        if (done) return;
        done = true;
        if (userChange) { try { client.end(); } catch {} reject(Object.assign(new Error('Kullanıcı adı değişti'), { userChange })); }
        else reject(cancelled ? new CancelError() : e);
      });
      client.connect(cfg);
    });
    client.hostKey = hostKey;
    if (canSave && Object.keys(toSave).length) {
      try { this.hooks.saveCredentials(s.id, toSave); } catch {}
    }
    return client;
  }

  _onClosed(conn) {
    if (!this.conns.has(conn.id)) return;
    for (const sh of conn.shells.values()) sh.flush(); // son çıktı durum mesajından önce gitsin
    this._teardown(conn);
    this.conns.delete(conn.id);
    this._status(conn.id, 'closed', conn.closing ? 'Bağlantı kapatıldı' : 'Bağlantı koptu');
  }

  _teardown(conn) {
    if (conn.pending) { try { conn.pending.client.end(); } catch {} try { conn.pending.sock.destroy(); } catch {} conn.pending = null; }
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
  // Bir bağlantıda birden çok kabuk olabilir (bölünmüş terminal); her biri sid ile tutulur.
  async openShell(id, cols, rows, startupCommand, sid = 'main') {
    const conn = this._get(id);
    if (conn.shells.has(sid)) throw new Error('Bu kabuk zaten açık');
    const stream = await p1((cb) => conn.client.shell({ term: 'xterm-256color', cols, rows }, cb));
    const sh = { stream, pid: null, pidP: null, buf: '', flushT: null };
    conn.shells.set(sid, sh);
    // Kabuğun uzak pid'ini hemen bul (diğer kabuklar hariç); dizin takibi buna dayanır.
    const others = () => [...conn.shells.values()].filter((o) => o !== sh).map((o) => o.pid).filter(Boolean);
    sh.pidP = (async () => {
      await Promise.all([...conn.shells.values()].filter((o) => o !== sh && o.pidP).map((o) => o.pidP));
      for (let i = 0; i < 6 && conn.shells.get(sid) === sh; i++) {
        try {
          const { stdout } = await this.exec(id, `sh -c '${CWD_SCRIPT(null, others())}'`, { timeout: 5000 });
          const pid = stdout.trim().split('\n')[0];
          if (/^\d+$/.test(pid)) { sh.pid = pid; return; }
        } catch { return; }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    const dec = new StringDecoder('utf8');
    sh.flush = () => { clearTimeout(sh.flushT); sh.flushT = null; const b = sh.buf; sh.buf = ''; if (b) this.emit('shell-data', id, b, sid); };
    const push = (d) => {
      sh.buf += dec.write(d);
      if (!sh.flushT) sh.flushT = setTimeout(sh.flush, 6);
    };
    stream.on('data', push);
    stream.stderr.on('data', push);
    stream.on('close', () => {
      sh.flush();
      if (conn.shells.get(sid) === sh) conn.shells.delete(sid);
      this.emit('shell-exit', id, sid);
    });
    if (startupCommand) setTimeout(() => stream.write(startupCommand.replace(/\r?\n?$/, '\n')), 300);
  }

  closeShell(id, sid) {
    const c = this.conns.get(id);
    const sh = c && c.shells.get(sid);
    if (sh) { try { sh.stream.close(); } catch {} }
  }

  // Tek seferlik komut (ayrı exec kanalı). -> { code, stdout, stderr }
  async exec(id, cmd, { timeout = 15000, stdin } = {}) {
    const conn = this._get(id);
    return new Promise((res, rej) => {
      conn.client.exec(cmd, (err, ch) => {
        if (err) return rej(err);
        let stdout = ''; let stderr = ''; let code = null;
        const t = setTimeout(() => ch.close(), timeout);
        ch.on('data', (d) => { stdout += d; });
        ch.stderr.on('data', (d) => { stderr += d; });
        ch.on('exit', (c) => { code = c; });
        ch.on('close', () => { clearTimeout(t); res({ code, stdout, stderr }); });
        if (stdin != null) ch.end(stdin);
      });
    });
  }

  // -> cwd, '' (unreadable), or null (shell not found / not Linux)
  async shellCwd(id, sid = 'main') {
    const conn = this._get(id);
    const sh = conn.shells.get(sid);
    if (!sh) return null;
    await sh.pidP;
    const others = [...conn.shells.values()].filter((o) => o !== sh).map((o) => o.pid);
    const { stdout } = await this.exec(id, `sh -c '${CWD_SCRIPT(sh.pid, others)}'`, { timeout: 5000 });
    const [pid, cwd] = stdout.trim().split('\n');
    if (!/^\d+$/.test(pid || '')) return null;
    sh.pid = pid;
    return cwd && cwd.startsWith('/') ? cwd : ''; // '' = shell found but cwd unreadable (e.g. sudo)
  }

  write(id, data, sid = 'main') { const sh = this.conns.get(id)?.shells.get(sid); if (sh) sh.stream.write(data); }
  resize(id, cols, rows, sid = 'main') { const sh = this.conns.get(id)?.shells.get(sid); if (sh) sh.stream.setWindow(rows, cols, 0, 0); }

  // Sunucu kaynakları (Linux /proc). CPU ve ağ hızı önceki ölçümle farktan hesaplanır. Linux değilse null.
  async stats(id) {
    const conn = this._get(id);
    const { stdout } = await this.exec(id, `sh -c '${STATS_SCRIPT}'`, { timeout: 5000 });
    const now = Date.now();
    const sec = {};
    let cur = null;
    for (const line of stdout.split('\n')) {
      const m = /^@@(\w+)$/.exec(line);
      if (m) { cur = m[1]; sec[cur] = []; } else if (cur && line.trim()) sec[cur].push(line);
    }
    if (!sec.cpu || !sec.cpu.length || !sec.mem) return null;
    const cpuF = sec.cpu[0].trim().split(/\s+/).slice(1).map(Number);
    const cpuTotal = cpuF.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
    const cpuIdle = (cpuF[3] || 0) + (cpuF[4] || 0);
    const mem = {};
    for (const l of sec.mem) { const mm = /^(\w+):\s+(\d+)/.exec(l); if (mm) mem[mm[1]] = Number(mm[2]) * 1024; }
    let rx = 0; let tx = 0;
    for (const l of sec.net || []) {
      const mm = /^\s*([^:]+):\s*(.*)$/.exec(l);
      if (!mm || mm[1] === 'lo') continue;
      const f = mm[2].trim().split(/\s+/).map(Number);
      rx += f[0] || 0; tx += f[8] || 0;
    }
    const df = (sec.disk && sec.disk[0] || '').trim().split(/\s+/);
    const prev = conn.stat;
    conn.stat = { t: now, cpuTotal, cpuIdle, rx, tx };
    const dt = prev ? (now - prev.t) / 1000 : 0;
    const out = {
      cpu: prev && cpuTotal > prev.cpuTotal ? Math.max(0, Math.min(100, 100 * (1 - (cpuIdle - prev.cpuIdle) / (cpuTotal - prev.cpuTotal)))) : null,
      cores: Number((sec.nproc || [])[0]) || null,
      memTotal: mem.MemTotal || 0,
      memUsed: (mem.MemTotal || 0) - (mem.MemAvailable != null ? mem.MemAvailable : (mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0)),
      swapTotal: mem.SwapTotal || 0,
      swapUsed: (mem.SwapTotal || 0) - (mem.SwapFree || 0),
      diskTotal: Number(df[1]) * 1024 || 0,
      diskUsed: Number(df[2]) * 1024 || 0,
      uptime: Number(((sec.up || [])[0] || '').split(/\s+/)[0]) || 0,
      load: ((sec.load || [])[0] || '').split(/\s+/).slice(0, 3).join(' '),
      rxRate: prev && dt > 0 ? Math.max(0, (rx - prev.rx) / dt) : null,
      txRate: prev && dt > 0 ? Math.max(0, (tx - prev.tx) / dt) : null,
      sessions: parseWho(sec.who),
    };
    return out;
  }

  // Açık anahtarı sunucudaki ~/.ssh/authorized_keys dosyasına ekler (ssh-copy-id karşılığı).
  async installPublicKey(id, pubKey) {
    const key = String(pubKey || '').trim();
    if (!/^(ssh-|ecdsa-|sk-)\S+ [A-Za-z0-9+/=]+( .*)?$/.test(key) || key.includes('\n')) throw new Error('Geçersiz açık anahtar');
    const q = `'${key.replace(/'/g, `'\\''`)}'`;
    const cmd = `sh -c 'umask 077; mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && chmod 700 "$HOME/.ssh" && chmod 600 "$HOME/.ssh/authorized_keys" && `
      + `if grep -qxF "$1" "$HOME/.ssh/authorized_keys"; then echo EXISTS; else printf "%s\\n" "$1" >> "$HOME/.ssh/authorized_keys" && echo ADDED; fi' sh ${q}`;
    const r = await this.exec(id, cmd);
    if (/ADDED/.test(r.stdout)) return 'added';
    if (/EXISTS/.test(r.stdout)) return 'exists';
    throw new Error(`Anahtar eklenemedi: ${(r.stderr || r.stdout).trim() || 'çıkış kodu ' + r.code}`);
  }

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

  // Uzak dosyanın başını okur (önizleme). -> { size, data: Buffer, truncated }
  async readFile(id, p, maxBytes = 512 * 1024) {
    const s = await this._sftp(this._get(id));
    const st = await p1((cb) => s.stat(p, cb));
    if (st.isDirectory()) throw new Error('Bu bir klasör');
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const h = await p1((cb) => s.open(p, 'r', cb));
    try {
      let off = 0;
      while (off < len) {
        const n = await new Promise((res, rej) => s.read(h, buf, off, len - off, off, (e, bytes) => (e ? rej(e) : res(bytes))));
        if (!n) break;
        off += n;
      }
      return { size: st.size, data: buf.subarray(0, off), truncated: st.size > off };
    } finally { s.close(h, () => {}); }
  }

  // Uzak dizini özyinelemeli listeler: Map(rel -> {isDir, size, mtime(sn)}). exclude: ad desenleri (glob * ?)
  async walkRemote(id, root, exclude = []) {
    const s = await this._sftp(this._get(id));
    const out = new Map();
    const ex = globMatcher(exclude);
    const walk = async (rel) => {
      const list = await p1((cb) => s.readdir(rel ? rpath.join(root, rel) : root, cb));
      for (const e of list) {
        if (ex(e.filename)) continue;
        const r = rel ? rel + '/' + e.filename : e.filename;
        const fmt = e.attrs.mode & 0o170000;
        if (fmt === 0o040000) { out.set(r, { isDir: true }); await walk(r); } else if (fmt === 0o100000) out.set(r, { isDir: false, size: e.attrs.size, mtime: e.attrs.mtime });
      }
      if (out.size > 200000) throw new Error('Çok fazla dosya (200 000 sınırı)');
    };
    await walk('');
    return out;
  }

  // ---------------- transfers ----------------
  // Each transfer gets its own SFTP channel so it can be cancelled and doesn't block browsing.
  // t.resume: hedefte aynı boyut+tarihte olan dosyalar atlanır, daha küçük olanlar kaldığı yerden sürdürülür.
  // t.mkdirs: dosya öğelerinin hedef üst klasörleri yoksa oluşturulur (klasör eşitleme).
  async transfer(id, t) {
    // t: { tid, direction: 'download'|'upload'|'relay', items: [{src, dst}], resume?, mkdirs?, srcConnId? (relay) }
    if (t.direction === 'relay') return this._relay(id, t);
    const conn = this._get(id);
    const rec = { cancelled: false, sftp: null };
    conn.transfers.set(t.tid, rec);
    const emit = (extra) => this.emit('transfer', id, { tid: t.tid, ...extra });
    const down = t.direction === 'download';
    let total = 0; let done = 0; let lastEmit = 0; let skipped = 0; let resumed = 0;
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
      const dstStat = async (p) => {
        try {
          if (down) { const st = await fsp.stat(p); return { size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }; }
          const st = await p1((cb) => sftp.stat(p, cb)); return { size: st.size, mtime: st.mtime };
        } catch { return null; }
      };
      const madeDirs = new Set();
      const ensureParent = async (p) => {
        const dir = down ? path.dirname(p) : rpath.dirname(p);
        if (madeDirs.has(dir)) return;
        if (down) await fsp.mkdir(dir, { recursive: true });
        else {
          const parts = dir.split('/'); let cur = '';
          for (const part of parts) {
            cur = cur ? (cur === '/' ? '/' + part : cur + '/' + part) : (part || '/');
            if (madeDirs.has(cur) || cur === '/') continue;
            try { await p1((cb) => sftp.mkdir(cur, cb)); } catch {}
            madeDirs.add(cur);
          }
        }
        madeDirs.add(dir);
      };
      // Kaldığı yerden sürdürme: fastGet/fastPut ofset desteklemediği için akışlarla kopyalanır.
      const copyFrom = (j, start, step) => new Promise((res, rej) => {
        const rs = down ? sftp.createReadStream(j.src, { start }) : fs.createReadStream(j.src, { start });
        const ws = down ? fs.createWriteStream(j.dst, { flags: 'r+', start }) : sftp.createWriteStream(j.dst, { flags: 'r+', start });
        let n = start;
        rs.on('data', (d) => { n += d.length; step(n); });
        rs.on('error', rej); ws.on('error', rej);
        ws.on('finish', res); ws.on('close', res);
        rs.pipe(ws);
      });
      emit({ state: 'scanning', done: 0, total: 0 });
      for (const it of t.items) {
        if (down) await walkRemote(it.src, it.dst); else await walkLocal(it.src, it.dst);
      }
      for (const j of jobs) {
        if (rec.cancelled) throw new CancelError();
        if (j.dir) {
          if (down) await fsp.mkdir(j.dst, { recursive: true });
          else { try { await p1((cb) => sftp.mkdir(j.dst, cb)); } catch (e) { /* exists */ } }
          madeDirs.add(j.dst);
          continue;
        }
        const base = done;
        const step = (sofar) => { done = base + sofar; tick(j.src); };
        const name = down ? path.basename(j.dst) : rpath.basename(j.dst);
        if (t.mkdirs) await ensureParent(j.dst);
        let start = 0;
        if (t.resume) {
          const ds = await dstStat(j.dst);
          if (ds && ds.size === j.size && ds.mtime === j.mtime) { done = base + j.size; skipped++; continue; }
          if (ds && ds.size > 0 && ds.size < j.size) { start = ds.size; resumed++; }
        }
        tick(name, true);
        if (start) await copyFrom(j, start, step);
        else if (down) await p1((cb) => sftp.fastGet(j.src, j.dst, { step }, cb));
        else await p1((cb) => sftp.fastPut(j.src, j.dst, { step, mode: j.mode }, cb));
        if (down) { try { await fsp.utimes(j.dst, j.atime, j.mtime); } catch {} }
        else { try { await p1((cb) => sftp.utimes(j.dst, j.atime, j.mtime, cb)); } catch {} }
        done = base + j.size;
      }
      emit({ state: 'done', done: total, total, skipped, resumed });
    } catch (e) {
      emit({ state: rec.cancelled ? 'cancelled' : 'error', done, total, error: rec.cancelled ? 'İptal edildi' : e.message });
    } finally {
      try { rec.sftp && rec.sftp.end(); } catch {}
      conn.transfers.delete(t.tid);
    }
  }

  // Uzak -> uzak: kaynak bağlantıdan (t.srcConnId) okunup bu bağlantıya (id) yazılır. Veri bu bilgisayardan
  // geçer ama diske yazılmaz. Olaylar hedef bağlantı adına gelir (aktarım hedef sekmenin kuyruğunda görünür).
  async _relay(id, t) {
    const conn = this._get(id);
    const rec = { cancelled: false, sftp: null, srcSftp: null };
    conn.transfers.set(t.tid, rec);
    const emit = (extra) => this.emit('transfer', id, { tid: t.tid, ...extra });
    let total = 0; let done = 0; let lastEmit = 0; let skipped = 0; let resumed = 0;
    const tick = (file, force) => {
      const now = Date.now();
      if (force || now - lastEmit > 120) { lastEmit = now; emit({ state: 'running', done, total, file }); }
    };
    try {
      const srcConn = this.conns.get(t.srcConnId);
      if (!srcConn || !srcConn.client) throw new Error('Kaynak sunucuya bağlı değil');
      rec.srcSftp = await p1((cb) => srcConn.client.sftp(cb));
      rec.sftp = await p1((cb) => conn.client.sftp(cb));
      const src = rec.srcSftp; const dst = rec.sftp;
      const jobs = [];
      const walk = async (sp, dp) => {
        const st = await p1((cb) => src.stat(sp, cb));
        if (st.isDirectory()) {
          jobs.push({ src: sp, dst: dp, dir: true });
          for (const e of await p1((cb) => src.readdir(sp, cb))) await walk(rpath.join(sp, e.filename), rpath.join(dp, e.filename));
        } else { jobs.push({ src: sp, dst: dp, size: st.size, mtime: st.mtime, atime: st.atime, mode: st.mode & 0o777 }); total += st.size; }
      };
      emit({ state: 'scanning', done: 0, total: 0 });
      for (const it of t.items) await walk(it.src, it.dst);
      // Önce doğrudan (kaynak sunucu hedefe kendisi gönderir); olmazsa bu bilgisayar üzerinden devam
      let fallback = null;
      if (t.direct && !t.resume) {
        try {
          const via = await this._direct(id, t, rec, total, (n) => { done = n; tick(); }, (v) => emit({ state: 'running', done, total, via: v }));
          emit({ state: 'done', done: total, total, skipped: 0, resumed: 0, via, keys: rec.keys });
          return;
        } catch (e) {
          if (rec.cancelled) throw e;
          fallback = e.message;
          done = 0;
        }
      }
      const via = 'bu bilgisayar üzerinden';
      emit({ state: 'running', done: 0, total, via, fallback });
      // Doğrudan yöntem hedef klasörü `mkdir -p` ile açıyordu; geri dönüşte de üst klasörler oluşturulur
      if (fallback) {
        let cur = '';
        for (const part of rpath.dirname(t.items[0].dst).split('/').filter(Boolean)) {
          cur += '/' + part;
          try { await p1((cb) => dst.mkdir(cur, cb)); } catch { /* var */ }
        }
      }
      for (const j of jobs) {
        if (rec.cancelled) throw new CancelError();
        if (j.dir) { try { await p1((cb) => dst.mkdir(j.dst, cb)); } catch { /* var */ } continue; }
        const base = done;
        let start = 0;
        if (t.resume) {
          let ds = null;
          try { ds = await p1((cb) => dst.stat(j.dst, cb)); } catch {}
          if (ds && ds.size === j.size && ds.mtime === j.mtime) { done = base + j.size; skipped++; continue; }
          if (ds && ds.size > 0 && ds.size < j.size) { start = ds.size; resumed++; }
        }
        tick(rpath.basename(j.dst), true);
        await sftpCopy(src, dst, j, start, (n) => { done = base + n; tick(j.src); }, () => rec.cancelled);
        try { await p1((cb) => dst.utimes(j.dst, j.atime, j.mtime, cb)); } catch {}
        done = base + j.size;
      }
      emit({ state: 'done', done: total, total, skipped, resumed, via, fallback, keys: rec.keys });
    } catch (e) {
      emit({ state: rec.cancelled ? 'cancelled' : 'error', done, total, error: rec.cancelled ? 'İptal edildi' : e.message, keys: rec.keys });
    } finally {
      for (const ch of [rec.sftp, rec.srcSftp]) { try { ch && ch.end(); } catch {} }
      if (rec.abort) { try { await rec.abort(); } catch {} }
      conn.transfers.delete(t.tid);
    }
  }

  cancelTransfer(id, tid) {
    const c = this.conns.get(id);
    const rec = c && c.transfers.get(tid);
    if (!rec) return;
    rec.cancelled = true;
    for (const ch of [rec.sftp, rec.srcSftp]) { try { ch && ch.end(); } catch {} }
    if (rec.abort) rec.abort().catch(() => {});
  }

  // Uzun süren komut (kanal açık kalır); agentForward: bu bilgisayarın ssh-agent'ı komuta yönlendirilir
  _execLong(id, cmd, { agentForward = false, onChannel } = {}) {
    const conn = this._get(id);
    return new Promise((res, rej) => {
      conn.client.exec(cmd, agentForward ? { agentForward: true } : {}, (err, ch) => {
        if (err) return rej(err);
        if (onChannel) onChannel(ch);
        let stdout = ''; let stderr = ''; let code = null;
        ch.on('data', (d) => { stdout += d; });
        ch.stderr.on('data', (d) => { stderr += d; });
        ch.on('exit', (c) => { code = c; });
        ch.on('close', () => res({ code, stdout, stderr }));
      });
    });
  }

  // Aktarım yöntemi penceresi için: bu bilgisayarın ssh-agent'ında (bu bağlantıya verilen) anahtar sayısı
  agentKeyCount(id) {
    const c = this.conns.get(id);
    const ag = c && c.client && c.client.config.allowAgentFwd && c.client.config.agent;
    if (!ag) return Promise.resolve(0);
    return new Promise((res) => {
      const t = setTimeout(() => res(0), 3000);
      try { ag.getIdentities((e, keys) => { clearTimeout(t); res(e || !keys ? 0 : keys.length); }); } catch { clearTimeout(t); res(0); }
    });
  }

  /**
   * Doğrudan sunucu-sunucu aktarım: kaynak (t.srcConnId) `tar | ssh hedef 'tar x'` ile hedefe (id) kendisi gönderir.
   * t.direct = kullanıcının seçtiği yöntem:
   *   'key'   tek kullanımlık anahtar. Hedefin authorized_keys'ine restrict + command (yalnız bu klasöre tar açabilir,
   *           başka komut çalıştıramaz) + 30 dk expiry-time ile eklenir; özel anahtar kaynağın 0700 geçici klasörüne
   *           konur. Bitince/iptalde ikisi de silinir ve silindiği denetlenir (rec.keys). Süre sınırı
   *           hesaplanamazsa (GNU date yok) anahtar hiç eklenmez.
   *   'agent' bu bilgisayarın ssh-agent'ı yalnız bu komut için yönlendirilir; sunuculara bir şey yazılmaz.
   * Hedefin sunucu anahtarı kaynağa bilinen sunucu olarak verilir (StrictHostKeyChecking=yes).
   * Başarısızsa hata fırlatır; çağıran bu bilgisayar üzerinden aktarıma döner.
   */
  async _direct(id, t, rec, total, onBytes, onVia) {
    const method = t.direct;
    if (method !== 'key' && method !== 'agent') throw new Error('bilinmeyen yöntem');
    const A = t.srcConnId;
    const srcConn = this._get(A); const dstConn = this._get(id);
    const B = dstConn.target; const hk = dstConn.client.hostKey;
    if (!B || !hk) throw new Error('hedef bilgisi yok');
    if (dstConn.chain.length > 1) throw new Error('hedefe jump host üzerinden bağlanılıyor');
    if (method === 'agent' && !srcConn.client.config.allowAgentFwd) throw new Error('bu bilgisayarda ssh-agent yok');
    const srcDir = rpath.dirname(t.items[0].src); const dstDir = rpath.dirname(t.items[0].dst);
    if (!t.items.every((it) => rpath.dirname(it.src) === srcDir && rpath.dirname(it.dst) === dstDir && rpath.basename(it.src) === rpath.basename(it.dst))) throw new Error('öğeler aynı klasörde değil ya da adı değişiyor');
    // Hedef yol authorized_keys'teki command="..." içine gömülür: ", \ ve satır sonu olamaz
    if (method === 'key' && /["\\\n\r]/.test(dstDir)) throw new Error('hedef klasör adı geçici anahtar için uygun değil');
    const names = t.items.map((it) => rpath.basename(it.src));
    const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const okA = await this.exec(A, 'command -v ssh >/dev/null && command -v tar >/dev/null && command -v bash >/dev/null && mktemp -d /tmp/melid.XXXXXXXX');
    const tmp = okA.stdout.trim();
    if (okA.code !== 0 || !tmp.startsWith('/tmp/melid.')) throw new Error('kaynakta ssh/tar/bash yok');
    // Geçici anahtar yalnız tar açabildiği için tar'ın korumaları önemli: GNU tar ../ ve sembolik bağlantıyla
    // klasör dışına yazmayı engeller (BusyBox tar o kadar sıkı değil) -> anahtar yönteminde GNU tar şart
    const okB = await this.exec(id, 'tar --version 2>/dev/null | head -1');
    const gnuTar = /GNU tar/.test(okB.stdout);
    if (!okB.stdout.trim() || (method === 'key' && !gnuTar)) {
      this.exec(A, `rm -rf ${q(tmp)}`).catch(() => {});
      throw new Error(okB.stdout.trim() ? 'hedefte GNU tar yok (geçici anahtar için gerekli)' : 'hedefte tar yok');
    }
    const extractCmd = `mkdir -p ${q(dstDir)} && tar -C ${q(dstDir)} -xf -`;
    let marker = null; let ch = null; let cleaning = null;
    // Bitişte ve iptalde çağrılır, bir kez çalışır. Anahtar eklendiyse iki tarafta da kalmadığını denetler.
    const cleanup = () => cleaning || (cleaning = (async () => {
      try { ch && ch.close(); } catch {}
      await this.exec(A, `pkill -f ${q(tmp)} ; rm -rf ${q(tmp)}`).catch(() => {});
      if (!marker) return;
      const ak = '"$HOME/.ssh/authorized_keys"';
      await this.exec(id, `f=${ak}; [ -f "$f" ] && grep -vF ${q(marker)} "$f" > "$f.melid" && cat "$f.melid" > "$f"; rm -f "$f.melid"`).catch(() => {});
      const problems = [];
      try {
        const r = await this.exec(id, `{ grep -F ${q(marker)} ${ak} 2>/dev/null || true; } | wc -l`);
        if (r.stdout.trim() !== '0') problems.push(`hedefte ~/.ssh/authorized_keys içinde "${marker}" satırı duruyor`);
      } catch (e) { problems.push(`hedef denetlenemedi (${e.message})`); }
      try {
        const r = await this.exec(A, `[ -e ${q(tmp)} ] && echo VAR || true`);
        if (r.stdout.includes('VAR')) problems.push(`kaynakta ${tmp} klasörü duruyor`);
      } catch (e) { problems.push(`kaynak denetlenemedi (${e.message})`); }
      rec.keys = problems.length ? { ok: false, marker, detail: problems.join('; ') } : { ok: true };
    })());
    rec.abort = cleanup;
    try {
      await this.exec(A, `umask 077; cat > ${q(tmp + '/kh')}`, { stdin: `melid-hedef ${keyType(hk)} ${hk.toString('base64')}\n` });
      // İlerleme: hedefteki boyut saniyede bir ölçülür (GNU du; yoksa ilerleme sonda görünür)
      const sizeCmd = `du -sb -- ${names.map((n) => q(rpath.join(dstDir, n))).join(' ')} 2>/dev/null | awk '{s+=$1} END {print s+0}'`;
      const poll = setInterval(async () => {
        try { const r = await this.exec(id, sizeCmd, { timeout: 5000 }); const n = Number(r.stdout.trim()); if (n > 0) onBytes(Math.min(n, total)); } catch {}
      }, 1000);
      const run = (identity, agentForward) => {
        const script = [
          'set -o pipefail',
          `trap 'rm -rf ${q(tmp)}' EXIT HUP INT TERM`,
          `tar -C ${q(srcDir)} -cf - -- ${names.map(q).join(' ')} | ssh -F /dev/null -p ${Number(B.port) || 22}${identity ? ` -i ${q(tmp + '/k')} -o IdentitiesOnly=yes` : ''}`
            + ` -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o LogLevel=ERROR -o HostKeyAlias=melid-hedef`
            + ` -o UserKnownHostsFile=${q(tmp + '/kh')} -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes`
            + ` -l ${q(B.username)} ${q(B.host)} ${q(extractCmd)}`,
        ].join('\n');
        return this._execLong(A, `bash -c ${q(script)}`, { agentForward, onChannel: (c) => { ch = c; } });
      };
      const fail = (r) => new Error((r.stderr.trim().split('\n').pop() || `çıkış kodu ${r.code}`).replace(/^ssh: /, ''));
      try {
        if (method === 'agent') {
          onVia('doğrudan (agent)');
          const r = await run(false, true); // A'nın sunucusu yönlendirmeyi reddederse hata fırlar
          if (rec.cancelled) throw new CancelError();
          if (r.code !== 0) throw fail(r);
          return 'doğrudan (agent)';
        }
        const exp = (await this.exec(id, 'date -d "@$(( $(date +%s) + 1800 ))" +%Y%m%d%H%M 2>/dev/null')).stdout.trim();
        if (!/^\d{12}$/.test(exp)) throw new Error('hedefte süre sınırı hesaplanamadı (GNU date yok), geçici anahtar eklenmedi');
        const kp = utils.generateKeyPairSync('ed25519', { comment: 'melid' });
        marker = 'melid-gecici-' + crypto.randomBytes(6).toString('hex');
        const line = `restrict,command="${extractCmd}",expiry-time="${exp}" ${kp.public.trim().split(' ').slice(0, 2).join(' ')} ${marker}`;
        const ins = await this.exec(id, `umask 077; mkdir -p "$HOME/.ssh" && printf '%s\\n' ${q(line)} >> "$HOME/.ssh/authorized_keys" && echo OK`);
        if (!ins.stdout.includes('OK')) throw new Error('hedefe geçici anahtar eklenemedi');
        await this.exec(A, `umask 077; cat > ${q(tmp + '/k')}`, { stdin: kp.private });
        onVia('doğrudan (geçici anahtar)');
        const r = await run(true, false);
        if (rec.cancelled) throw new CancelError();
        if (r.code !== 0) throw fail(r);
        return 'doğrudan (geçici anahtar)';
      } finally { clearInterval(poll); }
    } finally { await cleanup(); }
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

module.exports = { SshManager, expandHome, fingerprint, globMatcher };
