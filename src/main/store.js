'use strict';
// Persistent storage: sessions, settings, known host keys. Secrets are encrypted via
// Electron safeStorage (KWallet / GNOME Keyring / libsecret) when available.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listKeys, keyFileFingerprint } = require('./keys');

const SECRET_FIELDS = ['password', 'passphrase'];

// Passphrase-based encryption for the master password and for backups.
// AES-256-GCM + PBKDF2-SHA512 (both supported by Node and Electron's BoringSSL; SHA3 is not).
const KDF_ITER = 200000;
function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, KDF_ITER, 32, 'sha512');
}
// -> base64 of iv(12) | tag(16) | ciphertext
function encWithKey(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}
// throws on wrong key / tampered data
function decWithKey(b64, key) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
const MASTER_CHECK = 'melid-master-ok';
const MASTER_CHECK_OLD = 'sshdeck-master-ok'; // SSHDeck'te belirlenmiş ana parola

const DEFAULT_SETTINGS = {
  fontFamily: "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', Menlo, monospace",
  fontSize: 14,
  theme: 'deck-dark',
  copyOnSelect: true,
  rightClick: 'menu', // terminalde sağ tık: 'menu' | 'paste'
  savePrompted: true, // bağlanırken sorulan kullanıcı adı/parola için "Kaydet" kutusu varsayılanı
  fileDblClick: 'open', // dosyaya çift tık: 'open' (varsayılan uygulamayla aç) | 'transfer'
  scrollback: 10000,
  confirmClose: true,
  showHidden: false,
  sftpPanel: true,
  sftpHeight: 38,
  paneSplit: 50, // yerel panelin genişliği (%)
  xferHeight: 0, // aktarım listesi yüksekliği (px, 0 = otomatik)
  colWidths: {}, // dosya paneli sütun genişlikleri (px)
  hiddenCols: [], // dosya panelinde gizlenen sütunlar: 'size' | 'mtime' | 'mode' | 'owner'
  autoHideCols: true, // dar panelde sağdaki sütunları gizle (kapalıysa yatay kaydırma)
  uiTheme: 'dark',
  autoReconnect: true, // bağlantı beklenmedik koparsa yeniden dene
  logEnabled: false, // terminal çıktısını dosyaya kaydet
  logDir: '', // boş = ~/Belgeler/Melid/kayitlar
  logStrip: true, // kayıtta ANSI renk/kontrol kodlarını temizle
  maxTransfers: 3, // aynı anda en fazla kaç aktarım (sekme başına)
  relayMethod: 'relay', // uzak -> uzak aktarımda son seçilen yöntem: 'relay' (bu bilgisayar) | 'key' | 'agent'
  showStats: true, // durum çubuğunda sunucu kaynakları
  toolbarLabels: true, // araç çubuğu düğmelerinin altında yazı
  autoUpdate: true, // güncellemeleri kendiliğinden denetle (açılışta + 6 saatte bir)
  updateSkip: null, // "bu sürümü atla" denen sürüm
  updateLastCheck: 0,
  snippets: [], // hazır komutlar: [{ id, name, command, run }]
  localPane: true,
  followTerminal: true,
  cursorBlink: true,
  tabActivity: 'rainbow', // arka plan sekmesinde çıktı göstergesi: 'rainbow' | 'blink' | 'off'
  // Odak modu (Alt+Enter): hangi arayüz parçaları gizlensin
  focusHide: { toolbar: true, sidebar: true, tabs: true, status: true, sftp: false },
  recent: [], // son bağlanılan kayıtlı oturumlar (açılış ekranı): [{ id, t }], en yenisi başta; cihaza özgü
  syncKeys: false, // hesap eşitlemesinde SSH anahtarları da gönderilsin/alınsın (cihaza özgü seçim)
};

// Hesap eşitlemesine girmeyen, cihaza özgü ayarlar
const LOCAL_SETTINGS = new Set(['master', 'syncKeys', 'recent', 'logDir', 'logEnabled', 'colWidths', 'hiddenCols', 'autoHideCols', 'paneSplit', 'sftpHeight', 'xferHeight', 'updateSkip', 'updateLastCheck', 'usageStats', 'deviceId']);
// Oturumda cihaza özgü alanlar (yerel klasör yolu başka cihazda/işletim sisteminde geçersiz)
const LOCAL_SESSION_FIELDS = ['localDir'];
const TOMBSTONE_TTL = 180 * 24 * 3600 * 1000;
const sortedJson = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

class Store {
  constructor(dir, crypt) {
    this.dir = dir;
    this.crypt = crypt; // { available(): bool, encrypt(str): string, decrypt(str): string }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.sessions = this._load('sessions.json', []);
    this.settings = { ...DEFAULT_SETTINGS, ...this._load('settings.json', {}) };
    this.knownHosts = this._load('known_hosts.json', {});
    // Hesaptaki SSH anahtarları (anahtar eşitlemesi açıkken): [{ id: parmak izi, name, type, public, private, passphrase?, mtime }]
    // private/passphrase oturum parolaları gibi şifreli. ~/.ssh'deki dosyalara hiç yazılmaz.
    this.keys = this._load('keys.json', []);
    this.sshDir = null; // ~/.ssh (main.js verir; testlerde yok): buradaki anahtarlar da gönderilir
    // Eşitleme durumu: silinen oturumlar (id -> zaman), ayarların değişme zamanı, hesap bilgisi
    this.sync = { deleted: {}, settingsMtime: 0, account: null, ...this._load('sync.json', {}) };
    this.onChange = null; // eşitlenen bir veri değişince çağrılır
  }

  _saveSync() { this._save('sync.json', this.sync); }
  _changed() { if (this.onChange) { try { this.onChange(); } catch {} } }
  _touchSessions() { this._save('sessions.json', this.sessions); this._changed(); }

  _file(n) { return path.join(this.dir, n); }

  _load(name, def) {
    try { return JSON.parse(fs.readFileSync(this._file(name), 'utf8')); } catch { return def; }
  }

  _save(name, data) {
    const f = this._file(name);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  _enc(v) {
    if (!v) return undefined;
    if (this.masterKey) return { enc: 'mpw', v: encWithKey(v, this.masterKey) };
    if (this.masterEnabled()) throw new Error('MASTER_LOCKED'); // enabled but not unlocked
    if (this.crypt.available()) return { enc: 'safe', v: this.crypt.encrypt(v) };
    return { enc: 'plain', v: Buffer.from(v, 'utf8').toString('base64') };
  }

  _dec(o) {
    if (!o) return undefined;
    try {
      if (o.enc === 'mpw') return this.masterKey ? decWithKey(o.v, this.masterKey) : undefined;
      if (o.enc === 'safe') return this.crypt.decrypt(o.v);
      if (o.enc === 'plain') return Buffer.from(o.v, 'base64').toString('utf8');
    } catch { return undefined; }
    return undefined;
  }

  secretsBackend() {
    if (this.masterEnabled()) return 'master';
    return this.crypt.available() ? 'keyring' : 'plain';
  }

  /** Settings for the renderer: never expose the master verifier. */
  publicSettings() {
    const { master, ...rest } = this.settings;
    return { ...rest, masterEnabled: this.masterEnabled(), masterUnlocked: this.isUnlocked() };
  }

  // ---- backup export / import ----
  /** Build a portable backup object. With a passphrase, secrets are included (encrypted). */
  exportData({ passphrase } = {}) {
    const salt = passphrase ? crypto.randomBytes(16) : null;
    const key = passphrase ? deriveKey(passphrase, salt) : null;
    const sessions = this.sessions.map((s) => {
      const o = {};
      for (const [k, v] of Object.entries(s)) if (!SECRET_FIELDS.includes(k)) o[k] = v;
      if (key) {
        const sec = {};
        for (const f of SECRET_FIELDS) { const v = this._dec(s[f]); if (v) sec[f] = encWithKey(v, key); }
        if (Object.keys(sec).length) o.secrets = sec;
      }
      return o;
    });
    const { master, updateSkip, updateLastCheck, ...settings } = this.settings;
    return {
      app: 'Melid', format: 1, exportedAt: new Date().toISOString(),
      encrypted: !!key, secretsSalt: salt ? salt.toString('base64') : undefined,
      settings, sessions,
    };
  }

  /** True if the passphrase decrypts the backup's first secret (or backup has no secrets). */
  verifyBackupPassphrase(obj, passphrase) {
    if (!obj || !obj.encrypted || !obj.secretsSalt) return true;
    const first = (obj.sessions || []).map((s) => s.secrets && (s.secrets.password || s.secrets.passphrase)).find(Boolean);
    if (!first) return true;
    try { decWithKey(first, deriveKey(passphrase, Buffer.from(obj.secretsSalt, 'base64'))); return true; } catch { return false; }
  }

  /** Merge a backup into the store. Preserves session ids (update on match). */
  importData(obj, passphrase, { withSettings = true } = {}) {
    if (!obj || !Array.isArray(obj.sessions)) throw new Error('Geçersiz yedek dosyası');
    const key = obj.encrypted && obj.secretsSalt && passphrase
      ? deriveKey(passphrase, Buffer.from(obj.secretsSalt, 'base64')) : null;
    let added = 0; let updated = 0; let withPassword = 0;
    for (const es of obj.sessions) {
      const input = { ...es }; delete input.secrets; delete input.masterEnabled; delete input.masterUnlocked;
      for (const f of SECRET_FIELDS) delete input['has_' + f];
      if (es.secrets && key) {
        for (const f of SECRET_FIELDS) {
          if (!es.secrets[f]) continue;
          try { input[f] = decWithKey(es.secrets[f], key); if (f === 'password') withPassword++; } catch { /* bozuk/yanlış parola */ }
        }
      }
      const existed = input.id && this.sessions.some((x) => x.id === input.id);
      this.saveSession(input);
      if (existed) updated++; else added++;
    }
    if (withSettings && obj.settings) {
      const { master, masterEnabled, masterUnlocked, ...safe } = obj.settings;
      this.saveSettings(safe);
    }
    return { added, updated, withPassword, found: obj.sessions.length };
  }

  // ---- master password ----
  masterEnabled() { return !!(this.settings.master && this.settings.master.salt); }
  isUnlocked() { return !this.masterEnabled() || !!this.masterKey; }

  /** Derive & verify the master key. Returns true on success. */
  unlock(passphrase) {
    const m = this.settings.master;
    if (!m || !m.salt) return false;
    try {
      const key = deriveKey(passphrase, Buffer.from(m.salt, 'base64'));
      const chk = decWithKey(m.check, key);
      if (chk !== MASTER_CHECK && chk !== MASTER_CHECK_OLD) return false;
      this.masterKey = key;
      return true;
    } catch { return false; }
  }

  lock() { this.masterKey = null; }

  /**
   * Set, change, or remove the master password, re-encrypting all stored secrets.
   * oldPassphrase: required when a master password is currently set.
   * newPassphrase: '' or null removes the master password (secrets go back to keyring/plain).
   */
  setMasterPassword(oldPassphrase, newPassphrase) {
    // 1. obtain current secrets in cleartext
    if (this.masterEnabled()) {
      if (!this.unlock(oldPassphrase || '')) throw new Error('Mevcut ana parola yanlış');
    }
    const clear = new Map(); // id -> { field: value }
    for (const s of this.sessions) {
      const c = {};
      for (const f of SECRET_FIELDS) { const v = this._dec(s[f]); if (v) c[f] = v; }
      clear.set(s.id, c);
    }
    const keysClear = this.keys.map((k) => ({ private: this._dec(k.private), passphrase: this._dec(k.passphrase) }));
    const acc = this.sync.account;
    const accClear = acc && { token: this._dec(acc.token), vk: this._dec(acc.vk) };
    // 2. switch scheme
    if (newPassphrase) {
      const salt = crypto.randomBytes(16);
      const key = deriveKey(newPassphrase, salt);
      this.settings.master = { salt: salt.toString('base64'), check: encWithKey(MASTER_CHECK, key) };
      this.masterKey = key;
    } else {
      delete this.settings.master;
      this.masterKey = null;
    }
    // 3. re-encrypt every secret under the new scheme
    for (const s of this.sessions) {
      const c = clear.get(s.id) || {};
      for (const f of SECRET_FIELDS) s[f] = c[f] ? this._enc(c[f]) : undefined;
    }
    this.keys.forEach((k, i) => { k.private = this._enc(keysClear[i].private); k.passphrase = this._enc(keysClear[i].passphrase); });
    if (this.keys.length) this._save('keys.json', this.keys);
    if (acc) { acc.token = this._enc(accClear.token); acc.vk = this._enc(accClear.vk); this._saveSync(); }
    this._save('sessions.json', this.sessions);
    this._save('settings.json', this.settings);
  }

  /** Sessions as sent to the renderer (no secrets, just flags). */
  publicSessions() {
    return this.sessions.map((s) => {
      const o = { ...s };
      for (const f of SECRET_FIELDS) { o['has_' + f] = !!s[f]; delete o[f]; }
      return o;
    });
  }

  /** Full session with decrypted secrets (main process only). */
  getSession(id) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    const o = JSON.parse(JSON.stringify(s));
    for (const f of SECRET_FIELDS) o[f] = this._dec(s[f]);
    return o;
  }

  /** Upsert. Secret fields: undefined = keep, '' = clear, string = set. */
  saveSession(input) {
    const id = input.id || crypto.randomUUID();
    const idx = this.sessions.findIndex((x) => x.id === id);
    const prev = idx >= 0 ? this.sessions[idx] : {};
    const next = { ...prev, ...input, id };
    for (const k of Object.keys(next)) if (k.startsWith('has_')) delete next[k];
    for (const f of SECRET_FIELDS) {
      if (input[f] === undefined) next[f] = prev[f];
      else next[f] = input[f] === '' ? undefined : this._enc(input[f]);
    }
    // Anahtarın parmak izi eşitlenir: başka cihaz (yol farklı ya da yok) aynı anahtarı bununla bulur
    if (input.keyPath && input.keyPath !== prev.keyPath) next.keyFp = keyFileFingerprint(input.keyPath);
    else if ('keyPath' in input && !input.keyPath && prev.keyPath && !input.keyFp) delete next.keyFp;
    if (!next.keyFp) delete next.keyFp;
    next.mtime = Date.now();
    if (idx >= 0) this.sessions[idx] = next; else this.sessions.push(next);
    this._touchSessions();
    return id;
  }

  deleteSession(id) {
    this._removeSessions(new Set([id]));
  }

  deleteSessions(ids) {
    const set = new Set((ids || []).filter((id) => this.sessions.some((s) => s.id === id)));
    if (set.size) this._removeSessions(set);
  }

  _removeSessions(ids) {
    const now = Date.now();
    this.sessions = this.sessions.filter((s) => !ids.has(s.id));
    for (const s of this.sessions) if (s.jumpHostId && ids.has(s.jumpHostId)) { delete s.jumpHostId; s.mtime = now; }
    for (const id of ids) this.sync.deleted[id] = now;
    this._saveSync();
    this._touchSessions();
  }

  renameGroup(from, to) {
    for (const s of this.sessions) {
      const g = s.group || '';
      if (g === from || g.startsWith(from + '/')) { s.group = to + g.slice(from.length); s.mtime = Date.now(); }
    }
    this._touchSessions();
  }

  // Removes every session in a group (and its subgroups); returns how many were deleted.
  deleteGroup(group) {
    const inGroup = (s) => { const g = s.group || ''; return g === group || g.startsWith(group + '/'); };
    const ids = new Set(this.sessions.filter(inGroup).map((s) => s.id));
    if (ids.size) this._removeSessions(ids);
    return ids.size;
  }

  saveSettings(patch) {
    // Hazır komutlar ayrı ayrı eşitlenir (komut başına mtime + silme kaydı); ayar bloğunun zamanını değiştirmez
    let snipChanged = false;
    if (Array.isArray(patch.snippets)) {
      const r = stampSnippets(this.settings.snippets || [], patch.snippets, this.sync.deleted, this.sync.settingsMtime || 0);
      patch = { ...patch, snippets: r.list };
      snipChanged = r.changed;
    }
    const synced = Object.keys(patch).some((k) => k !== 'snippets' && !LOCAL_SETTINGS.has(k) && sortedJson(patch[k]) !== sortedJson(this.settings[k]));
    this.settings = { ...this.settings, ...patch };
    this._save('settings.json', this.settings);
    if (synced) this.sync.settingsMtime = Date.now();
    if (synced || snipChanged) { this._saveSync(); this._changed(); }
    return this.settings;
  }

  // ---- hesap eşitlemesi (sync.js) ----
  /** Eşitlenecek veri, sırlar açık hâlde (yalnız ana süreçte; şifrelenip sunucuya gider). Kilitliyse hata. */
  syncSnapshot() {
    if (!this.isUnlocked()) throw new Error('MASTER_LOCKED');
    const sessions = {};
    for (const s of this.sessions) {
      const o = {};
      for (const [k, v] of Object.entries(s)) if (!SECRET_FIELDS.includes(k) && !LOCAL_SESSION_FIELDS.includes(k) && v !== undefined) o[k] = v;
      for (const f of SECRET_FIELDS) { const v = this._dec(s[f]); if (v) o[f] = v; }
      o.mtime = s.mtime || 0;
      sessions[s.id] = o;
    }
    const settings = {};
    for (const [k, v] of Object.entries(this.settings)) if (!LOCAL_SETTINGS.has(k)) settings[k] = v;
    const out = { sessions, deleted: { ...this.sync.deleted }, settings: { data: settings, mtime: this.sync.settingsMtime || 0 } };
    out.snippets = snippetMap(this.settings.snippets, this.sync.settingsMtime || 0);
    if (this.settings.syncKeys) out.keys = this._keysSnapshot();
    return out;
  }

  /** Eşitlenecek anahtarlar: hesaptan gelenler + ~/.ssh'deki çiftler (aynı parmak izi bir kez; hesaptan silineni geri koymaz) */
  _keysSnapshot() {
    const out = {};
    for (const k of this.keys) {
      const prv = this._dec(k.private);
      if (!prv) continue;
      const o = { name: k.name, type: k.type, public: k.public, private: prv, mtime: k.mtime || 0 };
      const pp = this._dec(k.passphrase);
      if (pp) o.passphrase = pp;
      out[k.id] = o;
    }
    for (const k of this.sshDir ? listKeys(this.sshDir) : []) {
      if (!k.privatePath || out[k.fingerprint]) continue;
      let prv; let mtime;
      try {
        const st = fs.statSync(k.privatePath);
        if (st.size > 64 * 1024) continue;
        prv = fs.readFileSync(k.privatePath, 'utf8');
        mtime = Math.floor(st.mtimeMs);
      } catch { continue; }
      if (!/PRIVATE KEY/.test(prv) || (this.sync.deleted[k.fingerprint] || 0) >= mtime) continue;
      out[k.fingerprint] = { name: k.name, type: k.type, public: k.publicKey, private: prv, mtime };
    }
    return out;
  }

  /** Anahtar eşitlemesini aç/kapat. Açılınca anahtarlı oturumlara parmak izi eklenir (diğer cihaz anahtarı bulsun). */
  setSyncKeys(on) {
    this.settings.syncKeys = !!on;
    this._save('settings.json', this.settings);
    if (on) {
      let touched = false;
      for (const s of this.sessions) {
        if (!s.keyPath || s.keyFp) continue;
        const fp = keyFileFingerprint(s.keyPath);
        if (fp) { s.keyFp = fp; s.mtime = Date.now(); touched = true; }
      }
      if (touched) this._save('sessions.json', this.sessions);
    }
    this._changed();
  }

  /** Hesaptan gelen anahtar (parmak iziyle; sırlar açık, yalnız ana süreçte) */
  syncedKey(fp) {
    const k = fp && this.keys.find((x) => x.id === fp);
    if (!k) return null;
    const prv = this._dec(k.private);
    return prv ? { name: k.name, private: prv, passphrase: this._dec(k.passphrase) } : null;
  }

  /** Hesaptan gelen anahtarı sil (diğer cihazlardan da silinir; ~/.ssh'deki dosyalara dokunulmaz) */
  deleteSyncedKey(fp) {
    this.keys = this.keys.filter((k) => k.id !== fp);
    this._save('keys.json', this.keys);
    this.sync.deleted[fp] = Date.now();
    this._saveSync();
    this._changed();
  }

  /** Hesaptan gelen anahtarlar (anahtar listesi için; sırsız) */
  publicSyncedKeys() {
    return this.keys.map((k) => ({ name: k.name, type: k.type, fingerprint: k.id, publicKey: k.public, synced: true }));
  }

  /** Birleştirilmiş kasayı yerele uygular. onChange tetiklenmez (eşitlemenin kendi yazması). */
  applySync(v) {
    if (!this.isUnlocked()) throw new Error('MASTER_LOCKED');
    const prev = new Map(this.sessions.map((s) => [s.id, s]));
    this.sessions = Object.values(v.sessions).map((r) => {
      const o = { ...r };
      for (const f of SECRET_FIELDS) o[f] = r[f] ? this._enc(r[f]) : undefined;
      const old = prev.get(r.id);
      if (old) for (const f of LOCAL_SESSION_FIELDS) if (old[f] !== undefined) o[f] = old[f];
      return o;
    });
    this._save('sessions.json', this.sessions);
    if (v.settings && v.settings.mtime > (this.sync.settingsMtime || 0)) {
      const local = Object.fromEntries(Object.entries(this.settings).filter(([k]) => LOCAL_SETTINGS.has(k)));
      this.settings = { ...DEFAULT_SETTINGS, ...v.settings.data, ...local };
      this._save('settings.json', this.settings);
      this.sync.settingsMtime = v.settings.mtime;
    }
    // Hazır komutlar ayar bloğundan bağımsız birleşir (bkz. mergeVaults); blok eski kalsa da liste güncellenir
    const snips = v.settings && v.settings.data && v.settings.data.snippets;
    if (Array.isArray(snips) && sortedJson(snips) !== sortedJson(this.settings.snippets || [])) {
      this.settings = { ...this.settings, snippets: snips };
      this._save('settings.json', this.settings);
    }
    if (this.settings.syncKeys && v.keys) {
      const prevKeys = new Map(this.keys.map((k) => [k.id, k]));
      this.keys = Object.entries(v.keys).map(([id, k]) => {
        const old = prevKeys.get(id);
        if (old && old.mtime === (k.mtime || 0) && old.name === k.name && this._dec(old.private) === k.private && (this._dec(old.passphrase) || '') === (k.passphrase || '')) return old;
        return { id, name: k.name, type: k.type, public: k.public, private: this._enc(k.private), passphrase: k.passphrase ? this._enc(k.passphrase) : undefined, mtime: k.mtime || 0 };
      });
      this._save('keys.json', this.keys);
    }
    this.sync.deleted = { ...v.deleted };
    this._saveSync();
  }

  setAccount(a) { this.sync.account = a; this._saveSync(); }

  hostKey(host, port) { return this.knownHosts[`${host}:${port}`]; }

  trustHostKey(host, port, type, fp) {
    this.knownHosts[`${host}:${port}`] = { type, fingerprint: fp, added: new Date().toISOString() };
    this._save('known_hosts.json', this.knownHosts);
  }
}

// ---- hazır komutlar: komut başına birleştirme ----
const snipBody = (x) => { const { mtime, ...rest } = x || {}; return sortedJson(rest); };

/** Kaydedilen yeni listeye mtime koyar (değişen/yeni: şimdi), silinenler için silme kaydı yazar */
function stampSnippets(oldList, newList, deleted, fallbackMtime) {
  const now = Date.now();
  const old = new Map((oldList || []).filter((x) => x && x.id).map((x) => [x.id, x]));
  let changed = false;
  const list = (newList || []).map((x) => {
    if (!x || !x.id) return x;
    const o = old.get(x.id);
    if (o && snipBody(o) === snipBody(x)) return { ...x, mtime: o.mtime || x.mtime || fallbackMtime };
    changed = true;
    return { ...x, mtime: now };
  });
  const keep = new Set(list.filter((x) => x && x.id).map((x) => x.id));
  for (const id of old.keys()) if (!keep.has(id)) { deleted[id] = now; changed = true; }
  return { list, changed };
}

/** Liste -> { id: komut } (mtime'ı olmayan eski kayıt ayar bloğunun zamanını alır) */
function snippetMap(list, blobMtime) {
  const out = {};
  for (const x of Array.isArray(list) ? list : []) if (x && x.id && !out[x.id]) out[x.id] = { ...x, mtime: x.mtime || blobMtime || 0 };
  return out;
}

/**
 * İki kasayı birleştirir (değişme zamanı yeni olan kazanır). Aynı girdilerle her cihazda aynı sonucu verir.
 * Silme kaydı, kendinden sonra değişmemiş oturumu/anahtarı siler; daha yeni düzenleme silmeyi geçersiz kılar.
 * keys: SSH anahtarları (parmak izine göre; yalnız "anahtarları eşitle" açık cihazlar katkı verir).
 */
function mergeVaults(a, b, now = Date.now()) {
  const empty = { sessions: {}, deleted: {}, settings: { data: {}, mtime: 0 }, keys: {} };
  a = a || empty; b = b || empty;
  // Eski kasa (komut haritası yok): ayar bloğundaki liste, bloğun zamanıyla
  const snipsOf = (v) => (v.snippets && typeof v.snippets === 'object' ? v.snippets : snippetMap(v.settings && v.settings.data && v.settings.data.snippets, v.settings && v.settings.mtime));
  const mergeItems = (ma, mb) => {
    const out = {};
    ma = ma || {}; mb = mb || {};
    for (const id of new Set([...Object.keys(ma), ...Object.keys(mb)])) {
      const x = ma[id]; const y = mb[id];
      if (!x || !y) { out[id] = x || y; continue; }
      const tx = x.mtime || 0; const ty = y.mtime || 0;
      out[id] = tx !== ty ? (tx > ty ? x : y) : (sortedJson(x) >= sortedJson(y) ? x : y);
    }
    return out;
  };
  const sessions = mergeItems(a.sessions, b.sessions);
  const keys = mergeItems(a.keys, b.keys);
  const snippets = mergeItems(snipsOf(a), snipsOf(b));
  const deleted = {};
  for (const src of [a.deleted || {}, b.deleted || {}]) for (const [id, t] of Object.entries(src)) if (!(deleted[id] >= t)) deleted[id] = t;
  for (const [id, t] of Object.entries(deleted)) {
    let live = false;
    for (const items of [sessions, keys, snippets]) {
      if (!items[id]) continue;
      if ((items[id].mtime || 0) <= t) delete items[id]; else live = true;
    }
    if (live || now - t > TOMBSTONE_TTL) delete deleted[id];
  }
  const sa = a.settings || empty.settings; const sb = b.settings || empty.settings;
  let settings = sa.mtime !== sb.mtime ? (sa.mtime > sb.mtime ? sa : sb) : (sortedJson(sa) >= sortedJson(sb) ? sa : sb);
  // Bloğun komut listesi birleşmiş haritadan yeniden kurulur (eski sürümler listeyi buradan okur).
  // Sıra: kazanan bloğun sırası, sonra yeni gelenler (mtime, id)
  const data = settings.data || {};
  if (Object.keys(snippets).length || Array.isArray(data.snippets)) {
    const seen = new Set();
    const list = [];
    for (const x of Array.isArray(data.snippets) ? data.snippets : []) if (x && snippets[x.id] && !seen.has(x.id)) { seen.add(x.id); list.push(snippets[x.id]); }
    const rest = Object.keys(snippets).filter((id) => !seen.has(id)).sort((x, y) => (snippets[x].mtime || 0) - (snippets[y].mtime || 0) || (x < y ? -1 : x > y ? 1 : 0));
    for (const id of rest) list.push(snippets[id]);
    settings = { ...settings, data: { ...data, snippets: list } };
  }
  return { sessions, deleted, settings, keys, snippets };
}

module.exports = { Store, DEFAULT_SETTINGS, mergeVaults, sortedJson, encWithKey, decWithKey };
