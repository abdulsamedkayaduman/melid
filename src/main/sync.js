'use strict';
// Hesap eşitlemesi (istemci). Electron'dan bağımsız; sunucu: server/sync-server.js.
//
// Anahtarlar: hesap parolası -> PBKDF2-SHA512 (sunucudaki tuz) -> ana anahtar -> HKDF ile
//   authKey (sunucuya gider, yalnız kimlik doğrulama) ve wrapKey (cihazdan çıkmaz).
// Kasa anahtarı (VK) rastgele 32 bayt; sunucuda wrapKey ile şifreli (wrappedKey) durur.
// Kasa = { sessions, deleted, settings } JSON'u, VK ile AES-256-GCM. Parola değişince yalnız VK yeniden sarılır.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { mergeVaults, sortedJson, encWithKey, decWithKey } = require('./store');

const KDF_ITER = 600000;

// PBKDF2 iş parçacığı havuzunda çalışır (ana süreç donmasın)
async function deriveKeys(password, saltB64, iter = KDF_ITER) {
  const mk = await new Promise((res, rej) => crypto.pbkdf2(Buffer.from(password, 'utf8'), Buffer.from(saltB64, 'base64'), iter, 32, 'sha512', (e, k) => (e ? rej(e) : res(k))));
  const sub = (info) => Buffer.from(crypto.hkdfSync('sha256', mk, Buffer.alloc(0), info, 32));
  return { authKey: sub('sshdeck-auth').toString('base64'), wrapKey: sub('sshdeck-wrap') };
}

const normServer = (s) => {
  let u = String(s || '').trim();
  if (!u) throw new Error('Sunucu adresi gerekli');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try { u = new URL(u).origin; } catch { throw new Error('Sunucu adresi geçersiz'); }
  return u;
};

class AccountSync extends EventEmitter {
  constructor(store, { fetchImpl = globalThis.fetch, interval = 5 * 60000, debounce = 2000 } = {}) {
    super();
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
    return a ? { loggedIn: true, server: a.server, user: a.user, version: a.version || 0, lastSync: a.lastSync || 0, state: this.state, error: this.error }
      : { loggedIn: false, state: 'idle' };
  }

  _set(state, error = null) { this.state = state; this.error = error; this.emit('status', this.status()); }

  async _req(method, path, body, token, server = this.account && this.account.server) {
    let res;
    try {
      res = await this.fetch(server + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
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
  async register({ server, user, password, invite }) {
    server = normServer(server);
    user = String(user || '').trim().toLowerCase();
    const info = await this._req('GET', '/api/info', null, null, server);
    if (info.app !== 'SSHDeck') throw new Error('Bu bir SSHDeck eşitleme sunucusu değil');
    const salt = crypto.randomBytes(16).toString('base64');
    const { authKey, wrapKey } = await deriveKeys(password, salt, KDF_ITER);
    const vk = crypto.randomBytes(32);
    const wrappedKey = encWithKey(vk.toString('base64'), wrapKey);
    const r = await this._req('POST', '/api/register', { user, invite, salt, iter: KDF_ITER, authKey, wrappedKey }, null, server);
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
    this.timer = setTimeout(() => this.syncNow().catch(() => {}), this.debounce);
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

module.exports = { AccountSync, deriveKeys, normServer, KDF_ITER };
