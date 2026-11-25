'use strict';
// Session importers for WindTerm (user.sessions) and Xshell (.xsh files, session folders, .xts exports).
// WindTerm passwords: with the WindTerm master password. Xshell passwords: RC4 with a key from the exporting Windows
// user (username + SID) or the Xshell master password (decryptXshellPassword). Android port: core/XshellImport.java.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const cleanGroup = (g) => String(g || '').replace(/\\/g, '/').split('/').map((x) => x.trim()).filter(Boolean).join('/');
const normHost = (h) => (h === 'localhost' || !h ? '127.0.0.1' : h);

// ---------------------------------------------------------------- WindTerm
/** Default WindTerm session files: ~/.wind/profiles/<profile>/terminal/user.sessions */
function findWindTermFiles() {
  const root = path.join(os.homedir(), '.wind', 'profiles');
  try {
    return fs.readdirSync(root).map((p) => path.join(root, p, 'terminal', 'user.sessions')).filter((f) => fs.existsSync(f));
  } catch { return []; }
}

// WindTerm password decryption. Matches WindTerm's Cryptographic (Apache-2.0):
//   key = PBKDF2-SHA3-512(masterPassword, salt=application.fingerprint, 100000, 48 bytes)
//   AES-256-CBC, first 32 bytes = key, next 16 = IV; session.autoLogin is base64(ciphertext).
// The salt is the fingerprint's base64 TEXT (ASCII bytes), not its raw decode.
// Note: SHA3 must come from @noble/hashes, not node crypto — Electron's BoringSSL has no SHA3.
const { pbkdf2: noblePbkdf2 } = require('@noble/hashes/pbkdf2.js');
const { sha3_512 } = require('@noble/hashes/sha3.js');

// Derive the 48-byte key once; it is identical for every credential (same master + fingerprint).
function wtDeriveKey(master, fingerprint) {
  return Buffer.from(noblePbkdf2(sha3_512, Buffer.from(master, 'utf8'), Buffer.from(fingerprint, 'utf8'), { c: 100000, dkLen: 48 }));
}
// -> decrypted UTF-8 string; throws (bad padding) when the key is wrong.
function wtDecryptWithKey(autoLogin, key) {
  const d = crypto.createDecipheriv('aes-256-cbc', key.subarray(0, 32), key.subarray(32, 48));
  return Buffer.concat([d.update(Buffer.from(autoLogin, 'base64')), d.final()]).toString('utf8');
}
// autoLogin decrypts to JSON like {"Password":"...","PasswordEnabled":true,...}. Returns password or null.
function wtPasswordWithKey(autoLogin, key) {
  let obj;
  try { obj = JSON.parse(wtDecryptWithKey(autoLogin, key)); } catch { return null; }
  const p = obj && (obj.Password != null ? obj.Password : obj.password);
  return typeof p === 'string' && p ? p : null;
}
// Convenience wrappers (derive key each call) — for one-off use and tests.
function wtPassword(autoLogin, fingerprint, master) { return wtPasswordWithKey(autoLogin, wtDeriveKey(master, fingerprint)); }
/** Sessions file .../profiles/<p>/terminal/user.sessions -> fingerprint from .../profiles/<p>/user.config */
function readWindTermFingerprint(sessionsFile) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(sessionsFile)), 'user.config'), 'utf8'));
    const fp = cfg['application.fingerprint'];
    return typeof fp === 'string' && fp.length >= 40 ? fp : null;
  } catch { return null; }
}
/** Any encrypted credentials present? */
function windTermHasSecrets(text) {
  try { return JSON.parse(text).some((s) => s && s['session.autoLogin']); } catch { return false; }
}
/** True if the master password decrypts the first encrypted credential. */
function verifyWindTermMaster(text, fingerprint, master) {
  let cred;
  try { cred = JSON.parse(text).map((s) => s && s['session.autoLogin']).find(Boolean); } catch { return false; }
  if (!cred || !fingerprint) return false;
  try { wtDecryptWithKey(cred, wtDeriveKey(master, fingerprint)); return true; } catch { return false; }
}

// "name:Local(bindHost),bindPort,dstHost:dstPort;" — the name may itself contain ':'
function parseWindTermTunnels(str) {
  const out = [];
  for (const part of String(str || '').split(';')) {
    const m = part.trim().match(/^(?:.*:)?(Local|Remote|Dynamic)(?:\(([^)]*)\))?,(\d+),(.*)$/i);
    if (!m) continue;
    const type = { local: 'L', remote: 'R', dynamic: 'D' }[m[1].toLowerCase()];
    const fw = { id: `wt${out.length}`, type, bindHost: normHost(m[2]), bindPort: Number(m[3]), enabled: true };
    if (type !== 'D') {
      const d = m[4].match(/^(.*):(\d+)$/);
      if (!d) continue;
      fw.dstHost = normHost(d[1].replace(/^\[(.*)\]$/, '$1'));
      fw.dstPort = Number(d[2]);
    }
    if (fw.bindPort) out.push(fw);
  }
  return out;
}

// opts: { fingerprint, master } — when both given, decrypts session.autoLogin into the password field.
function parseWindTerm(text, opts = {}) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('Geçerli bir WindTerm oturum dosyası değil');
  const key = opts.fingerprint && opts.master ? wtDeriveKey(opts.master, opts.fingerprint) : null;
  const out = [];
  for (const w of list) {
    if (!w || String(w['session.protocol'] || 'SSH').toUpperCase() !== 'SSH') continue;
    const target = String(w['session.target'] || '').trim();
    if (!target) continue;
    const at = target.lastIndexOf('@');
    let host = at >= 0 ? target.slice(at + 1) : target;
    let port = Number(w['session.port']) || 22;
    const hp = host.match(/^\[(.+)\](?::(\d+))?$/) || (host.split(':').length === 2 ? host.match(/^(.+):(\d+)$/) : null);
    if (hp) { host = hp[1]; if (hp[2]) port = Number(hp[2]); }
    const s = {
      name: String(w['session.label'] || '').trim() || target,
      group: cleanGroup(w['session.group']) || 'WindTerm',
      host,
      port,
      username: at >= 0 ? target.slice(0, at) : '',
      authType: 'auto',
      notes: w['session.description'] || undefined,
      forwards: parseWindTermTunnels(w['ssh.tunnels']),
    };
    if (key && w['session.autoLogin']) {
      const pw = wtPasswordWithKey(w['session.autoLogin'], key);
      if (pw) { s.password = pw; s.authType = 'password'; }
    }
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- Xshell
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  if (buf.length > 3 && buf[1] === 0 && buf[3] === 0) return buf.toString('utf16le');
  const s = buf.toString('utf8');
  return s.includes('�') ? new TextDecoder('windows-1254').decode(buf) : s.replace(/^﻿/, '');
}

function parseIni(text) {
  const out = {}; let sec = out[''] = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === ';') continue;
    const s = line.match(/^\[(.+)\]$/);
    if (s) { sec = out[s[1].toUpperCase()] = out[s[1].toUpperCase()] || {}; continue; }
    const i = line.indexOf('=');
    if (i > 0) sec[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/** One .xsh file -> session (or null for non-SSH). `rel` = path relative to the Sessions root. */
function parseXsh(buf, rel) {
  const ini = parseIni(decodeText(buf));
  const c = ini.CONNECTION || {};
  const a = ini['CONNECTION:AUTHENTICATION'] || {};
  if (c.protocol && c.protocol.toUpperCase() !== 'SSH') return null;
  if (!c.host) return null;
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts.pop().replace(/\.xsh$/i, '');
  const notes = (ini.SESSIONINFO || {}).description || (c.description) || undefined;
  const out = {
    name,
    group: cleanGroup(parts.join('/')) || 'Xshell',
    host: c.host,
    port: Number(c.port) || 22,
    username: a.username || '',
    authType: 'auto',
    notes: notes ? notes.replace(/\\n/g, '\n') : undefined,
    forwards: parseXshellForwards(ini['CONNECTION:SSH'] || {}),
  };
  // Şifreli parola: içe aktarırken decryptXshellPassword ile çözülür (alan kaydedilmeden önce silinir)
  if (a.password) out._xshell = { enc: a.password, version: (ini.SESSIONINFO || {}).version || '' };
  return out;
}

/**
 * [CONNECTION:SSH] FwdReqCount + FwdReq_<i>_Port (dinlenen port), _Host / _HostPort (hedef). Yön alanı belgelenmemiş:
 * FwdReq_<i>_Type (0/1/2 ya da local/remote/dynamic) varsa ondan, yoksa hedef yoksa SOCKS, varsa yerel sayılır.
 */
function parseXshellForwards(sec) {
  const out = [];
  const n = Math.min(Number(sec.fwdreqcount) || 0, 100);
  for (let i = 0; i < n; i++) {
    const g = (k) => (sec[`fwdreq_${i}_${k}`] || '').trim();
    const bindPort = Number(g('port'));
    if (!bindPort) continue;
    const t = g('type').toLowerCase();
    const dstHost = g('host'); const dstPort = Number(g('hostport'));
    const type = /^(1|r|remote)/.test(t) ? 'R' : /^(2|d|dynamic|socks)/.test(t) ? 'D' : t ? 'L' : (!dstHost && !dstPort ? 'D' : 'L');
    const fw = { id: `xs${i}`, type, bindHost: normHost(g('source') || g('bindaddress') || g('listenhost')), bindPort, enabled: true };
    if (type !== 'D') {
      if (!dstHost || !dstPort) continue;
      fw.dstHost = normHost(dstHost); fw.dstPort = dstPort;
    }
    out.push(fw);
  }
  return out;
}

// ---------------------------------------------------------------- Xshell parolaları
// Kaynak: Metasploit Rex::Parser::NetSarang ve SharpXDecrypt. 5.1 ve sonrası: base64(RC4(parola) + SHA256(parola)).
// Anahtar sürüme göre değişir ve kaynaklar ayrıntıda ayrışır; bu yüzden olası bütün anahtarlar denenir ve sonuç
// sondaki SHA-256 ile doğrulanır: yanlış anahtar hiçbir zaman parola diye kabul edilmez.
function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255; j = (j + S[i]) & 255; [S[i], S[j]] = [S[j], S[i]];
    out[n] = data[n] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}
// Windows'un ANSI kod sayfası (Türkçe Windows: 1254). Diğer harfler Latin-1 ile aynı.
const CP1254 = { 'Ğ': 0xd0, 'ğ': 0xf0, 'İ': 0xdd, 'ı': 0xfd, 'Ş': 0xde, 'ş': 0xfe };
function encodings(str) {
  const out = [Buffer.from(str, 'utf8')];
  if (/[^\x00-\x7f]/.test(str)) {
    out.push(Buffer.from([...str].map((ch) => CP1254[ch] || (ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 0x3f))));
    out.push(Buffer.from(str, 'latin1'));
  }
  return out;
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const rev = (x) => [...x].reverse().join('');

/** creds: { user, sid, master } -> denenecek RC4 anahtarları (sürüm ayrımı yapmadan; doğrulama SHA-256 ile) */
function xshellKeys({ user, sid, master } = {}) {
  const keys = [];
  if (master) for (const b of encodings(master)) keys.push(sha256(b));
  if (sid) {
    sid = String(sid).trim();
    // whoami adı küçük harfle verir; Xshell hesabın gerçek yazılışını kullanır: yaygın biçimlerin hepsi denenir
    const u0 = user ? String(user).trim().replace(/^.*\\/, '') : '';
    const cap = (x) => x.charAt(0).toLocaleUpperCase('tr') + x.slice(1);
    const users = u0 ? [...new Set([u0, u0.toLowerCase(), cap(u0.toLowerCase()), u0.toUpperCase(), cap(u0.toLowerCase()).replace(/^I/, 'I')])] : [];
    for (const u of users) for (const str of [u + sid, rev(sid) + u]) for (const b of encodings(str)) keys.push(sha256(b));
    keys.push(sha256(Buffer.from(sid, 'ascii')));
  }
  return keys;
}

/** Şifreli Xshell parolası -> düz parola ya da null (anahtarlardan hiçbiri tutmadı) */
function decryptXshellPassword(enc, version, keys) {
  let data;
  try { data = Buffer.from(String(enc).trim(), 'base64'); } catch { return null; }
  if (!data.length) return null;
  const v = parseFloat(version) || 0;
  if (v > 0 && v < 5.1) { // eski sürümler: sabit anahtar, doğrulama özeti yok
    const pt = rc4(crypto.createHash('md5').update('!X@s#h$e%l^l&').digest(), data);
    const str = pt.toString('utf8');
    return /^[\x20-\x7e\u00a0-\uffff]+$/.test(str) && !str.includes('\ufffd') ? str : null;
  }
  if (data.length <= 32) return null;
  const ct = data.subarray(0, data.length - 32); const sum = data.subarray(data.length - 32);
  for (const k of keys) {
    const pt = rc4(k, ct);
    if (sha256(pt).equals(sum)) {
      const u = pt.toString('utf8');
      return u.includes('\ufffd') ? new TextDecoder('windows-1254').decode(pt) : u;
    }
  }
  return null;
}

/** list içindeki _xshell parolalarını creds ile çözmeyi dener. Dönüş: { total, ok } (çözülemeyenler beklemede kalır) */
function applyXshellPasswords(list, creds) {
  const keys = xshellKeys(creds);
  let total = 0; let ok = 0;
  for (const s of list) {
    if (!s._xshell) continue;
    total++;
    if (s.password) { ok++; continue; }
    if (!keys.length && !(parseFloat(s._xshell.version) < 5.1)) continue;
    const pw = decryptXshellPassword(s._xshell.enc, s._xshell.version, keys);
    if (pw != null) { s.password = pw; ok++; }
  }
  return { total, ok };
}

/** Test ve Android uyumu için: düz parola -> Xshell 5.1+ biçimi */
function encryptXshellPassword(pw, key) {
  const pt = Buffer.from(pw, 'utf8');
  return Buffer.concat([rc4(key, pt), sha256(pt)]).toString('base64');
}

// Minimal ZIP reader (stored + deflate) for Xshell .xts exports.
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Geçerli bir .xts (zip) dosyası değil');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8); const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28); const xl = buf.readUInt16LE(p + 30); const cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nl);
    const name = flags & 0x800 ? rawName.toString('utf8') : decodeText(rawName);
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(ds, ds + csize);
    if (method === 0) files.push({ name, data });
    else if (method === 8) files.push({ name, data: zlib.inflateRawSync(data) });
  }
  return files;
}

/** paths: .xsh / .xts files and/or folders (searched recursively for .xsh). */
function parseXshellPaths(paths) {
  const out = [];
  const walk = (dir, root) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, root);
      else if (/\.xsh$/i.test(e.name)) { const s = parseXsh(fs.readFileSync(f), path.relative(root, f)); if (s) out.push(s); }
    }
  };
  for (const p of paths) {
    if (fs.statSync(p).isDirectory()) walk(p, p);
    else if (/\.xts$/i.test(p)) {
      for (const z of readZip(fs.readFileSync(p))) {
        if (!/\.xsh$/i.test(z.name)) continue;
        // .xts entries usually start with "Xshell/Sessions/..." or "Sessions/..."; strip that prefix
        const rel = z.name.replace(/\\/g, '/').replace(/^(?:.*\/)?Sessions\//i, '');
        const s = parseXsh(z.data, rel); if (s) out.push(s);
      }
    } else if (/\.xsh$/i.test(p)) { const s = parseXsh(fs.readFileSync(p), path.basename(p)); if (s) out.push(s); }
  }
  return out;
}

module.exports = {
  findWindTermFiles, parseWindTerm, parseWindTermTunnels, parseXsh, parseXshellPaths, parseXshellForwards, readZip,
  xshellKeys, decryptXshellPassword, applyXshellPasswords, encryptXshellPassword, rc4,
  readWindTermFingerprint, windTermHasSecrets, verifyWindTermMaster, wtPassword,
};
