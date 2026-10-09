#!/usr/bin/env node
'use strict';
// SSHDeck hesap/eşitleme sunucusu. Bağımlılıksız (yalnız Node). Uçtan uca şifreli: sunucu kasayı çözemez.
//
// Sunucu ne görür: kullanıcı adı, PBKDF2 tuzu, giriş anahtarının scrypt özeti, şifreli kasa anahtarı
// (wrappedKey) ve şifreli kasa. Parolanın kendisi ve şifreleme anahtarı istemciden hiç çıkmaz.
//
// Ortam değişkenleri:
//   PORT (3150), HOST (0.0.0.0), DATA_DIR (./data)
//   SSHDECK_SYNC_INVITE  hesap açmak için davet kodu (boşsa yeni hesap açılamaz)
//   TLS_CERT / TLS_KEY   verilirse HTTPS (yoksa HTTP; internete açarken önüne TLS'li ters vekil koyun)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BODY = 16 * 1024 * 1024;
const TOKEN_TTL = 365 * 24 * 3600 * 1000; // kullanıldıkça uzar
const USER_RE = /^[a-z0-9._-]{2,40}$/;
const B64 = (s, min, max) => typeof s === 'string' && /^[A-Za-z0-9+/=]+$/.test(s) && s.length >= min && s.length <= max;

function createSyncServer({ dataDir, invite = '' }) {
  fs.mkdirSync(path.join(dataDir, 'vaults'), { recursive: true, mode: 0o700 });
  const file = (n) => path.join(dataDir, n);
  const load = (n, def) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return def; } };
  const save = (n, data) => { const f = file(n); fs.writeFileSync(f + '.tmp', JSON.stringify(data), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };

  let secret = load('secret.json', null);
  if (!secret) { secret = { key: crypto.randomBytes(32).toString('base64') }; save('secret.json', secret); }
  const users = load('users.json', {});
  const tokens = load('tokens.json', {}); // sha256(token) -> { user, expires }
  const vaultName = (u) => 'vaults/' + crypto.createHash('sha256').update(u).digest('hex') + '.json';

  const verifier = (authKey, salt) => crypto.scryptSync(Buffer.from(authKey, 'base64'), Buffer.from(salt, 'base64'), 32).toString('base64');
  const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const newToken = (user) => {
    const t = crypto.randomBytes(32).toString('base64url');
    tokens[tokenHash(t)] = { user, expires: Date.now() + TOKEN_TTL };
    for (const [k, v] of Object.entries(tokens)) if (v.expires < Date.now()) delete tokens[k];
    save('tokens.json', tokens);
    return t;
  };

  // Başarısız giriş sınırı: kullanıcı ve IP başına 15 dakikada 10 deneme
  const fails = new Map();
  const failKey = (k) => { const now = Date.now(); const a = (fails.get(k) || []).filter((t) => now - t < 15 * 60000); fails.set(k, a); return a; };
  const limited = (...keys) => keys.some((k) => failKey(k).length >= 10);
  const fail = (...keys) => { for (const k of keys) failKey(k).push(Date.now()); };

  class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
  const need = (cond, msg) => { if (!cond) throw new HttpError(400, msg); };

  const auth = (req) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    const rec = m && tokens[tokenHash(m[1])];
    if (!rec || rec.expires < Date.now() || !users[rec.user]) throw new HttpError(401, 'Oturum geçersiz, tekrar giriş yapın');
    if (rec.expires - Date.now() < TOKEN_TTL - 24 * 3600 * 1000) { rec.expires = Date.now() + TOKEN_TTL; save('tokens.json', tokens); }
    return { user: rec.user, hash: tokenHash(m[1]) };
  };

  const routes = {
    'GET /api/info': () => ({ app: 'SSHDeck', api: 1, register: !!invite }),

    // Giriş öncesi: KDF tuzu. Olmayan kullanıcıya da sabit sahte tuz döner (hesap var/yok sızmasın).
    'GET /api/prelogin': (req, _b, url) => {
      const u = String(url.searchParams.get('user') || '').toLowerCase();
      need(USER_RE.test(u), 'Geçersiz kullanıcı adı');
      if (users[u]) return { salt: users[u].salt, iter: users[u].iter };
      const fake = crypto.createHmac('sha256', Buffer.from(secret.key, 'base64')).update(u).digest().subarray(0, 16);
      return { salt: fake.toString('base64'), iter: 600000 };
    },

    'POST /api/register': (req, b) => {
      if (!invite) throw new HttpError(403, 'Bu sunucuda yeni hesap açılamıyor');
      const ip = 'ip:' + req.socket.remoteAddress;
      if (limited(ip)) throw new HttpError(429, 'Çok fazla deneme, biraz sonra tekrar deneyin');
      const ok = typeof b.invite === 'string' && b.invite.length === invite.length
        && crypto.timingSafeEqual(Buffer.from(b.invite), Buffer.from(invite));
      if (!ok) { fail(ip); throw new HttpError(403, 'Davet kodu yanlış'); }
      const u = String(b.user || '').toLowerCase();
      need(USER_RE.test(u), 'Kullanıcı adı 2-40 karakter olmalı (küçük harf, rakam, . _ -)');
      need(B64(b.salt, 16, 64) && B64(b.authKey, 40, 64) && B64(b.wrappedKey, 40, 200), 'Eksik veya hatalı alan');
      need(Number.isInteger(b.iter) && b.iter >= 100000 && b.iter <= 10000000, 'Hatalı KDF ayarı');
      if (users[u]) throw new HttpError(409, 'Bu kullanıcı adı alınmış');
      const vsalt = crypto.randomBytes(16).toString('base64');
      users[u] = { salt: b.salt, iter: b.iter, vsalt, verifier: verifier(b.authKey, vsalt), wrappedKey: b.wrappedKey, created: new Date().toISOString() };
      save('users.json', users);
      return { token: newToken(u), wrappedKey: b.wrappedKey };
    },

    'POST /api/login': (req, b) => {
      const u = String(b.user || '').toLowerCase();
      const ip = 'ip:' + req.socket.remoteAddress;
      if (limited(ip, 'u:' + u)) throw new HttpError(429, 'Çok fazla hatalı deneme, 15 dakika sonra tekrar deneyin');
      const rec = users[u];
      const good = rec && B64(b.authKey, 40, 64)
        && crypto.timingSafeEqual(Buffer.from(verifier(b.authKey, rec.vsalt), 'base64'), Buffer.from(rec.verifier, 'base64'));
      if (!good) { fail(ip, 'u:' + u); throw new HttpError(401, 'Kullanıcı adı veya parola yanlış'); }
      return { token: newToken(u), wrappedKey: rec.wrappedKey };
    },

    'POST /api/logout': (req) => { const a = auth(req); delete tokens[a.hash]; save('tokens.json', tokens); return { ok: true }; },

    'GET /api/vault': (req) => {
      const a = auth(req);
      const v = load(vaultName(a.user), null);
      return v || { version: 0, data: null };
    },

    // İyimser kilit: baseVersion sunucudakiyle aynı değilse 409 + güncel kasa döner, istemci birleştirip yeniden dener
    'PUT /api/vault': (req, b) => {
      const a = auth(req);
      need(Number.isInteger(b.baseVersion) && B64(b.data, 1, MAX_BODY), 'Eksik veya hatalı alan');
      const cur = load(vaultName(a.user), null) || { version: 0, data: null };
      if (cur.version !== b.baseVersion) throw new HttpError(409, 'Kasa başka bir cihazda değişti', cur);
      const next = { version: cur.version + 1, data: b.data, updated: new Date().toISOString() };
      save(vaultName(a.user), next);
      return { version: next.version };
    },

    // Parola değişimi: mevcut giriş anahtarıyla doğrulanır; kasa anahtarı aynı kalır, yalnız yeniden sarılır
    'POST /api/password': (req, b) => {
      const a = auth(req);
      const rec = users[a.user];
      if (limited('u:' + a.user)) throw new HttpError(429, 'Çok fazla hatalı deneme, 15 dakika sonra tekrar deneyin');
      const good = B64(b.authKey, 40, 64)
        && crypto.timingSafeEqual(Buffer.from(verifier(b.authKey, rec.vsalt), 'base64'), Buffer.from(rec.verifier, 'base64'));
      if (!good) { fail('u:' + a.user); throw new HttpError(401, 'Mevcut parola yanlış'); }
      need(B64(b.newSalt, 16, 64) && B64(b.newAuthKey, 40, 64) && B64(b.wrappedKey, 40, 200), 'Eksik veya hatalı alan');
      need(Number.isInteger(b.iter) && b.iter >= 100000 && b.iter <= 10000000, 'Hatalı KDF ayarı');
      const vsalt = crypto.randomBytes(16).toString('base64');
      Object.assign(rec, { salt: b.newSalt, iter: b.iter, vsalt, verifier: verifier(b.newAuthKey, vsalt), wrappedKey: b.wrappedKey });
      save('users.json', users);
      // Diğer cihazların oturumları kapatılır (yeni parolayla tekrar girmeleri gerekir)
      for (const [k, v] of Object.entries(tokens)) if (v.user === a.user && k !== a.hash) delete tokens[k];
      save('tokens.json', tokens);
      return { ok: true };
    },
  };

  const handler = (req, res) => {
    const reply = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    const url = new URL(req.url, 'http://x');
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return reply(404, { error: 'Bulunamadı' });
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reply(413, { error: 'Kasa çok büyük' }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      try {
        let body = {};
        if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Geçersiz JSON'); } }
        if (!body || typeof body !== 'object') throw new HttpError(400, 'Geçersiz JSON');
        reply(200, route(req, body, url));
      } catch (e) {
        if (e instanceof HttpError) reply(e.status, { error: e.message, ...(e.extra ? { current: e.extra } : {}) });
        else { console.error(e); reply(500, { error: 'Sunucu hatası' }); }
      }
    });
  };
  return handler;
}

module.exports = { createSyncServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3150;
  const host = process.env.HOST || '0.0.0.0';
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const handler = createSyncServer({ dataDir, invite: process.env.SSHDECK_SYNC_INVITE || '' });
  const tls = process.env.TLS_CERT && process.env.TLS_KEY;
  const srv = tls
    ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handler)
    : http.createServer(handler);
  srv.listen(port, host, () => {
    console.log(`SSHDeck eşitleme sunucusu: ${tls ? 'https' : 'http'}://${host}:${port}  (veri: ${dataDir})`);
    if (!process.env.SSHDECK_SYNC_INVITE) console.log('Uyarı: SSHDECK_SYNC_INVITE boş, yeni hesap açılamaz.');
  });
}
