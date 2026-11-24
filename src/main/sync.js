'use strict';
// Hesap eşitlemesi (istemci). Electron'dan bağımsız; sunucu: server/sync-server.js.
//
// Anahtarlar: hesap parolası -> PBKDF2-SHA512 (sunucudaki tuz) -> ana anahtar -> HKDF ile
//   authKey (sunucuya gider, yalnız kimlik doğrulama) ve wrapKey (cihazdan çıkmaz).
// Kasa anahtarı (VK) rastgele 32 bayt; sunucuda wrapKey ile şifreli (wrappedKey) durur.
// Kasa = { sessions, deleted, settings, keys } JSON'u, VK ile AES-256-GCM. Parola değişince yalnız VK yeniden sarılır.
const crypto = require('crypto');
const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');
const { mergeVaults, sortedJson, encWithKey, decWithKey } = require('./store');

const KDF_ITER = 600000;

// PBKDF2 iş parçacığı havuzunda çalışır (ana süreç donmasın)
async function deriveKeys(password, saltB64, iter = KDF_ITER) {
  const mk = await new Promise((res, rej) => crypto.pbkdf2(Buffer.from(password, 'utf8'), Buffer.from(saltB64, 'base64'), iter, 32, 'sha512', (e, k) => (e ? rej(e) : res(k))));
  const sub = (info) => Buffer.from(crypto.hkdfSync('sha256', mk, Buffer.alloc(0), info, 32));
  return { authKey: sub('sshdeck-auth').toString('base64'), wrapKey: sub('sshdeck-wrap') };
}

// ---- kurtarma anahtarı: 20 rastgele bayt, base32 (32 harf) "ABCD-EFGH-..." ----
// Sunucuya koddan türetilen recAuth gider (doğrulama) ve kasa anahtarı recWrap ile sarılı durur; kod yalnız kullanıcıda.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function newRecoveryCode() {
  const b = crypto.randomBytes(20);
  let bits = 0; let val = 0; let out = '';
  for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return out.match(/.{4}/g).join('-');
}
function recoveryBytes(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (c.length !== 32) throw new Error('Kurtarma anahtarı 32 karakter olmalı (ör. ABCD-EFGH-…; tireler önemli değil)');
  let bits = 0; let val = 0; const out = [];
  for (const ch of c) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function recoveryKeys(code) {
  const raw = recoveryBytes(code);
  const sub = (info) => Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.alloc(0), info, 32));
  return { recAuth: sub('sshdeck-recovery-auth').toString('base64'), recWrap: sub('sshdeck-recovery-wrap') };
}

const DEFAULT_PORT = 3150;
/** Hesap penceresinde hazır gelen genel eşitleme sunucusu */
const DEFAULT_SERVER = 'sshdeck.abdulsamed.net';
// Şemasız yazıldığında yerel sayılan adlar: IP, tek parçalı ad (nas), .local/.lan/.home/.internal
const LOCAL_NAME = /^(\[.*\]|\d+\.\d+\.\d+\.\d+|localhost|[^.]+|.*\.(local|lan|home|internal))$/i;

const normServer = (s) => {
  let u = String(s || '').trim();
  if (!u) throw new Error('Sunucu adresi gerekli');
  if (!/^https?:\/\//i.test(u)) {
    const host = (/^(\[[^\]]+\]|[^:/[]+)/.exec(u) || [''])[0];
    // Yerel adres (ör. 192.168.1.50): http + varsayılan sunucu portu. Alan adı (ör. sshdeck.ornek.com): https
    u = LOCAL_NAME.test(host) ? 'http://' + u.replace(/^(\[[^\]]+\]|[^:/[]+)(?=\/|$)/, '$1:' + DEFAULT_PORT) : 'https://' + u;
  }
  try { u = new URL(u).origin; } catch { throw new Error('Sunucu adresi geçersiz'); }
  return u;
};

// 192.168.x.y gibi yerel IPv4 ağları; Docker köprüleri dahil (aynı makinedeki konteyner sunucusu bulunur)
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** Taranacak adresler: her yerel ağ arabiriminin alt ağı (en fazla /24; büyük ağlarda kendi /24'ü) + bu makine. */
function lanTargets(ifaces = os.networkInterfaces()) {
  const out = new Set(['127.0.0.1']);
  const toInt = (ip) => ip.split('.').reduce((a, x) => (a << 8 >>> 0) + Number(x), 0) >>> 0;
  const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || !PRIVATE_V4.test(a.address)) continue;
      const prefix = Math.max(24, Number(String(a.cidr || '').split('/')[1]) || 24);
      const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
      const base = (toInt(a.address) & mask) >>> 0;
      const size = 2 ** (32 - prefix);
      for (let i = 1; i < size - 1; i++) out.add(toIp(base + i));
    }
  }
  return [...out];
}

/**
 * Yerel ağda eşitleme sunucusu arar: portu açık adreslere /api/info sorulur.
 * Sonuç: [{ server: 'http://192.168.1.50:3150', host, register }] (adrese göre sıralı)
 */
async function scanLan({ port = DEFAULT_PORT, targets = lanTargets(), timeout = 900, concurrency = 96, fetchImpl = globalThis.fetch } = {}) {
  const open = (host) => new Promise((res) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); res(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  const found = [];
  const queue = [...targets];
  const worker = async () => {
    for (let host; (host = queue.shift()) !== undefined;) {
      if (!(await open(host))) continue;
      try {
        const r = await fetchImpl(`http://${host}:${port}/api/info`, { signal: AbortSignal.timeout(3000) });
        const info = await r.json();
        if (info && info.app === 'SSHDeck') found.push({ server: `http://${host}:${port}`, host, register: !!info.register });
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  const key = (h) => h.split('.').map((x) => x.padStart(3, '0')).join('.');
  return found.sort((a, b) => key(a.host).localeCompare(key(b.host)));
}

class AccountSync extends EventEmitter {
  constructor(store, { fetchImpl = globalThis.fetch, interval = 5 * 60000, debounce = 2000, client = '' } = {}) {
    super();
    this.client = client; // sunucu istatistiklerinde görünen istemci adı (ör. "SSHDeck 1.5.0 linux")
    this.store = store;
    this.fetch = fetchImpl;
    this.interval = interval;
    this.debounce = debounce;
    this.state = 'idle'; // idle | syncing | ok | error | locked | auth
    this.error = null;
    this.vk = null; // çözülmüş kasa anahtarı (bellekte)
    this.running = null;
    this.again = false;
    this.timer = null; this.tick = null;
    store.onChange = () => this.schedule();
  }

  get account() { return this.store.sync.account; }

  status() {
    const a = this.account;
    const syncKeys = !!this.store.settings.syncKeys;
    return a ? { loggedIn: true, server: a.server, user: a.user, version: a.version || 0, lastSync: a.lastSync || 0, state: this.state, error: this.error, syncKeys }
      : { loggedIn: false, state: 'idle', syncKeys };
  }

  _set(state, error = null) { this.state = state; this.error = error; this.emit('status', this.status()); }

  async _req(method, path, body, token, server = this.account && this.account.server) {
    let res;
    try {
      res = await this.fetch(server + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(this.client ? { 'X-SSHDeck-Client': this.client } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'Sunucu yanıt vermiyor' : `Sunucuya ulaşılamadı (${server})`);
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `Sunucu hatası (${res.status})`);
      err.status = res.status; err.current = data && data.current;
      throw err;
    }
    if (!data) throw new Error('Sunucudan geçersiz yanıt');
    return data;
  }

  // ---- hesap ----
  async register({ server, user, password, email, invite }) {
    server = normServer(server);
    user = String(user || '').trim().toLowerCase();
    const info = await this._req('GET', '/api/info', null, null, server);
    if (info.app !== 'SSHDeck') throw new Error('Bu bir SSHDeck eşitleme sunucusu değil');
    const salt = crypto.randomBytes(16).toString('base64');
    const { authKey, wrapKey } = await deriveKeys(password, salt, KDF_ITER);
    const vk = crypto.randomBytes(32);
    const wrappedKey = encWithKey(vk.toString('base64'), wrapKey);
    const r = await this._req('POST', '/api/register', { user, email: String(email || '').trim(), invite: invite || undefined, salt, iter: KDF_ITER, authKey, wrappedKey }, null, server);
    // İlk cihaz: buradaki ayarlar hesabın ayarları olur
    if (!this.store.sync.settingsMtime) this.store.sync.settingsMtime = Date.now();
    this._saveAccount({ server, user, token: r.token, version: 0 }, vk);
    return this.syncNow();
  }

  async login({ server, user, password }) {
    server = normServer(server);
    user = String(user || '').trim().toLowerCase();
    const pre = await this._req('GET', '/api/prelogin?user=' + encodeURIComponent(user), null, null, server);
    const { authKey, wrapKey } = await deriveKeys(password, pre.salt, pre.iter);
    const r = await this._req('POST', '/api/login', { user, authKey }, null, server);
    let vk;
    try { vk = Buffer.from(decWithKey(r.wrappedKey, wrapKey), 'base64'); } catch { throw new Error('Kasa anahtarı çözülemedi'); }
    this._saveAccount({ server, user, token: r.token, version: 0 }, vk);
    return this.syncNow();
  }

  async logout() {
    const a = this.account;
    if (!a) return;
    const token = this._token();
    this.store.setAccount(null);
    this.vk = null;
    this.stop();
    this._set('idle');
    if (token) { try { await this._req('POST', '/api/logout', {}, token, a.server); } catch {} }
  }

  async changePassword(oldPassword, newPassword) {
    const a = this.account;
    if (!a) throw new Error('Giriş yapılmamış');
    const vk = this._vk();
    const pre = await this._req('GET', '/api/prelogin?user=' + encodeURIComponent(a.user));
    const old = await deriveKeys(oldPassword, pre.salt, pre.iter);
    const newSalt = crypto.randomBytes(16).toString('base64');
    const nk = await deriveKeys(newPassword, newSalt, KDF_ITER);
    await this._req('POST', '/api/password', {
      authKey: old.authKey, newSalt, iter: KDF_ITER, newAuthKey: nk.authKey, wrappedKey: encWithKey(vk.toString('base64'), nk.wrapKey),
    }, this._token());
  }

  /** Sunucudaki hesap bilgisi: { user, email, created, recovery: oluşturulma zamanı | null } */
  info() { return this._req('GET', '/api/account', null, this._token()); }

  setEmail(email) { return this._req('POST', '/api/email', { email: String(email || '').trim() }, this._token()); }

  /** Hesabı ve sunucudaki kasayı siler (hesap parolasıyla). Bu cihazdaki oturumlar kalır, eşitleme durur. */
  async deleteAccount(password) {
    const a = this.account;
    if (!a) throw new Error('Giriş yapılmamış');
    const pre = await this._req('GET', '/api/prelogin?user=' + encodeURIComponent(a.user));
    const { authKey } = await deriveKeys(password, pre.salt, pre.iter);
    await this._req('POST', '/api/account/delete', { authKey }, this._token());
    this.store.setAccount(null);
    this.vk = null;
    this.stop();
    this._set('idle');
  }

  /** Yeni kurtarma anahtarı (eskisi geçersiz olur). Hesap parolası gerekir. Dönüş: { code, created } */
  async createRecovery(password) {
    const a = this.account;
    if (!a) throw new Error('Giriş yapılmamış');
    const vk = this._vk();
    const pre = await this._req('GET', '/api/prelogin?user=' + encodeURIComponent(a.user));
    const { authKey } = await deriveKeys(password, pre.salt, pre.iter);
    const code = newRecoveryCode();
    const { recAuth, recWrap } = recoveryKeys(code);
    const r = await this._req('POST', '/api/recovery', { authKey, recAuth, recWrapped: encWithKey(vk.toString('base64'), recWrap) }, this._token())
      .catch((e) => { if (e.status === 401) e.message = 'Hesap parolası yanlış'; throw e; });
    return { code, created: r.recovery, server: a.server, user: a.user };
  }

  async removeRecovery(password) {
    const a = this.account;
    if (!a) throw new Error('Giriş yapılmamış');
    const pre = await this._req('GET', '/api/prelogin?user=' + encodeURIComponent(a.user));
    const { authKey } = await deriveKeys(password, pre.salt, pre.iter);
    await this._req('POST', '/api/recovery', { authKey, remove: true }, this._token());
  }

  /** Parolasını unutan kullanıcı: kurtarma anahtarıyla yeni parola belirler ve giriş yapar (kasa korunur) */
  async recover({ server, user, code, password }) {
    server = normServer(server);
    user = String(user || '').trim().toLowerCase();
    const { recAuth, recWrap } = recoveryKeys(code);
    const b = await this._req('POST', '/api/recover/begin', { user, recAuth }, null, server);
    let vk;
    try { vk = Buffer.from(decWithKey(b.recWrapped, recWrap), 'base64'); } catch { throw new Error('Kurtarma anahtarı kasayı açamadı'); }
    const newSalt = crypto.randomBytes(16).toString('base64');
    const nk = await deriveKeys(password, newSalt, KDF_ITER);
    const r = await this._req('POST', '/api/recover/finish', {
      user, recAuth, newSalt, iter: KDF_ITER, newAuthKey: nk.authKey, wrappedKey: encWithKey(vk.toString('base64'), nk.wrapKey),
    }, null, server);
    this._saveAccount({ server, user, token: r.token, version: 0 }, vk);
    return this.syncNow();
  }

  // Jeton ve kasa anahtarı yerelde oturum parolaları gibi saklanır (anahtarlık / ana parola)
  _saveAccount(a, vk) {
    this.store.setAccount({ server: a.server, user: a.user, version: a.version, lastSync: 0, token: this.store._enc(a.token), vk: this.store._enc(vk.toString('base64')) });
    this.vk = vk;
  }
  _token() { const a = this.account; return a && this.store._dec(a.token); }
  _vk() {
    if (this.vk) return this.vk;
    const v = this.account && this.store._dec(this.account.vk);
    if (!v) throw new Error('MASTER_LOCKED');
    return (this.vk = Buffer.from(v, 'base64'));
  }

  // ---- eşitleme ----
  start() {
    this.stop();
    if (!this.account) return;
    this.tick = setInterval(() => this.syncNow().catch(() => {}), this.interval);
    this.syncNow().catch(() => {});
  }
  stop() { clearInterval(this.tick); clearTimeout(this.timer); this.tick = this.timer = null; }

  schedule() {
    if (!this.account) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.syncNow().catch(() => {}); }, this.debounce);
  }

  /** Aynı anda tek eşitleme; sürerken gelen istek bitince bir kez daha çalıştırır. Sonuç: { changed } */
  syncNow() {
    if (!this.account) return Promise.resolve({ changed: false });
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      let out;
      try {
        do { this.again = false; out = await this._syncOnce(); } while (this.again);
        return out;
      } finally { this.running = null; }
    })();
    return this.running;
  }

  async _syncOnce() {
    if (!this.store.isUnlocked()) { this._set('locked', 'Ana parola kilitli'); return { changed: false }; }
    this._set('syncing');
    try {
      const vk = this._vk();
      const token = this._token();
      let changed = false;
      let cur = await this._req('GET', '/api/vault', null, token);
      for (let attempt = 0; ; attempt++) {
        const remote = cur.data ? JSON.parse(decWithKey(cur.data, vk)) : null;
        const local = this.store.syncSnapshot();
        // Anahtar eşitlemesi kapalı: bu cihaz anahtar göndermez/almaz, kasadakiler olduğu gibi kalır
        if (!local.keys) local.keys = (remote && remote.keys) || {};
        const merged = mergeVaults(local, remote);
        if (sortedJson(merged) !== sortedJson(local)) { this.store.applySync(merged); changed = true; }
        if (remote && sortedJson(merged) === sortedJson(remote)) { this._done(cur.version); break; }
        try {
          const r = await this._req('PUT', '/api/vault', { baseVersion: cur.version, data: encWithKey(JSON.stringify(merged), vk) }, token);
          this._done(r.version);
          break;
        } catch (e) {
          if (e.status !== 409 || !e.current || attempt >= 4) throw e;
          cur = e.current; // başka cihaz araya girdi: güncel kasayla yeniden birleştir
        }
      }
      if (changed) this.emit('changed');
      this._set('ok');
      return { changed };
    } catch (e) {
      if (e.message === 'MASTER_LOCKED') { this._set('locked', 'Ana parola kilitli'); return { changed: false }; }
      if (e.message === 'Unsupported state or unable to authenticate data') e = new Error('Kasa çözülemedi (kasa anahtarı uyuşmuyor)');
      this._set(e.status === 401 ? 'auth' : 'error', e.message);
      throw e;
    }
  }

  _done(version) {
    const a = this.account;
    if (!a) return;
    this.store.setAccount({ ...a, version, lastSync: Date.now() });
  }
}

module.exports = { AccountSync, DEFAULT_SERVER, deriveKeys, normServer, scanLan, lanTargets, KDF_ITER, newRecoveryCode, recoveryKeys };
