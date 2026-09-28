'use strict';
// Persistent storage: sessions, settings, known host keys. Secrets are encrypted via
// Electron safeStorage (KWallet / GNOME Keyring / libsecret) when available.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SECRET_FIELDS = ['password', 'passphrase'];

const DEFAULT_SETTINGS = {
  fontFamily: "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', monospace",
  fontSize: 14,
  theme: 'deck-dark',
  copyOnSelect: true,
  rightClickPaste: true,
  scrollback: 10000,
  confirmClose: true,
  showHidden: false,
  sftpPanel: true,
  sftpHeight: 38,
  cursorBlink: true,
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
    if (this.crypt.available()) return { enc: 'safe', v: this.crypt.encrypt(v) };
    return { enc: 'plain', v: Buffer.from(v, 'utf8').toString('base64') };
  }

  _dec(o) {
    if (!o) return undefined;
    try {
      if (o.enc === 'safe') return this.crypt.decrypt(o.v);
      if (o.enc === 'plain') return Buffer.from(o.v, 'base64').toString('utf8');
    } catch { return undefined; }
    return undefined;
  }

  secretsBackend() { return this.crypt.available() ? 'keyring' : 'plain'; }

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
