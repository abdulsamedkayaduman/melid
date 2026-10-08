'use strict';
// Persistent storage: sessions, settings, known host keys. Secrets are encrypted via
// Electron safeStorage (KWallet / GNOME Keyring / libsecret) when available.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const MASTER_CHECK = 'sshdeck-master-ok';

const DEFAULT_SETTINGS = {
  fontFamily: "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', monospace",
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
  uiTheme: 'dark',
  autoReconnect: true, // bağlantı beklenmedik koparsa yeniden dene
  logEnabled: false, // terminal çıktısını dosyaya kaydet
  logDir: '', // boş = ~/Belgeler/SSHDeck/kayitlar
  logStrip: true, // kayıtta ANSI renk/kontrol kodlarını temizle
  maxTransfers: 3, // aynı anda en fazla kaç aktarım (sekme başına)
  showStats: true, // durum çubuğunda sunucu kaynakları
  snippets: [], // hazır komutlar: [{ id, name, command, run }]
  localPane: true,
  followTerminal: true,
  cursorBlink: true,
  tabActivity: 'rainbow', // arka plan sekmesinde çıktı göstergesi: 'rainbow' | 'blink' | 'off'
  // Odak modu (Alt+Enter): hangi arayüz parçaları gizlensin
  focusHide: { toolbar: true, sidebar: true, tabs: true, status: true, sftp: false },
};

class Store {
  constructor(dir, crypt) {
    this.dir = dir;
    this.crypt = crypt; // { available(): bool, encrypt(str): string, decrypt(str): string }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.sessions = this._load('sessions.json', []);
    this.settings = { ...DEFAULT_SETTINGS, ...this._load('settings.json', {}) };
    this.knownHosts = this._load('known_hosts.json', {});
  }

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
    const { master, ...settings } = this.settings;
    return {
      app: 'SSHDeck', format: 1, exportedAt: new Date().toISOString(),
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
      this.settings = { ...this.settings, ...safe };
      this._save('settings.json', this.settings);
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
      if (decWithKey(m.check, key) !== MASTER_CHECK) return false;
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
    if (idx >= 0) this.sessions[idx] = next; else this.sessions.push(next);
    this._save('sessions.json', this.sessions);
    return id;
  }

  deleteSession(id) {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    for (const s of this.sessions) if (s.jumpHostId === id) delete s.jumpHostId;
    this._save('sessions.json', this.sessions);
  }

  renameGroup(from, to) {
    for (const s of this.sessions) {
      const g = s.group || '';
      if (g === from || g.startsWith(from + '/')) s.group = to + g.slice(from.length);
    }
    this._save('sessions.json', this.sessions);
  }

  // Removes every session in a group (and its subgroups); returns how many were deleted.
  deleteGroup(group) {
    const inGroup = (s) => { const g = s.group || ''; return g === group || g.startsWith(group + '/'); };
    const ids = new Set(this.sessions.filter(inGroup).map((s) => s.id));
    this.sessions = this.sessions.filter((s) => !ids.has(s.id));
    for (const s of this.sessions) if (s.jumpHostId && ids.has(s.jumpHostId)) delete s.jumpHostId;
    this._save('sessions.json', this.sessions);
    return ids.size;
  }

  saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this._save('settings.json', this.settings);
    return this.settings;
  }

  hostKey(host, port) { return this.knownHosts[`${host}:${port}`]; }

  trustHostKey(host, port, type, fp) {
    this.knownHosts[`${host}:${port}`] = { type, fingerprint: fp, added: new Date().toISOString() };
    this._save('known_hosts.json', this.knownHosts);
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
