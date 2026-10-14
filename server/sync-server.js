#!/usr/bin/env node
'use strict';
// SSHDeck hesap/eşitleme sunucusu. Bağımlılıksız (yalnız Node). Uçtan uca şifreli: sunucu kasayı çözemez.
//
// Sunucu ne görür: kullanıcı adı, PBKDF2 tuzu, giriş anahtarının scrypt özeti, şifreli kasa anahtarı
// (wrappedKey) ve şifreli kasa. Parolanın kendisi ve şifreleme anahtarı istemciden hiç çıkmaz.
//
// Ortam değişkenleri:
//   PORT (3150), HOST (0.0.0.0), DATA_DIR (./data)
//   SSHDECK_SYNC_INVITE  hesap açmak için davet kodu (boşsa yeni hesap açılamaz). Ana sayfadaki (/)
//                        istatistiklere de bu kodla girilir.
//   TLS_CERT / TLS_KEY   verilirse HTTPS (yoksa HTTP; internete açarken önüne TLS'li ters vekil koyun)
//   TRUST_PROXY=1        ters vekil (Traefik/Dokploy, nginx) arkasında: istemci IP'si X-Forwarded-For'dan alınır
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BODY = 16 * 1024 * 1024;
const TOKEN_TTL = 365 * 24 * 3600 * 1000; // kullanıldıkça uzar
const USER_RE = /^[a-z0-9._-]{2,40}$/;
const B64 = (s, min, max) => typeof s === 'string' && /^[A-Za-z0-9+/=]+$/.test(s) && s.length >= min && s.length <= max;

function createSyncServer({ dataDir, invite = '', trustProxy = false }) {
  // Deneme sınırı IP başına: vekil arkasında herkes vekilin IP'siyle gelir. Vekilin eklediği en sağdaki
  // X-Forwarded-For girdisi kullanılır (soldakileri istemci kendisi yazabilir).
  const clientIp = (req) => {
    const xff = trustProxy && req.headers['x-forwarded-for'];
    return 'ip:' + (xff ? String(xff).split(',').pop().trim() : req.socket.remoteAddress);
  };
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
  const started = Date.now();
  const counters = { syncs: 0, logins: 0, failedLogins: 0 }; // sunucu açıldığından beri
  // İstemci kendini X-SSHDeck-Client başlığıyla tanıtır (ör. "SSHDeck 1.5.0 linux"); yalnız istatistik için
  const clientName = (req) => String(req.headers['x-sshdeck-client'] || req.headers['user-agent'] || '').replace(/[^\w .:;/()+-]/g, '').slice(0, 60);
  const newToken = (user, req) => {
    const t = crypto.randomBytes(32).toString('base64url');
    tokens[tokenHash(t)] = { user, expires: Date.now() + TOKEN_TTL, created: Date.now(), seen: Date.now(), client: clientName(req) };
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
    const now = Date.now();
    const c = clientName(req);
    // Diske yazım sınırlı: süre günde bir uzar, son görülme 10 dakikada bir kaydedilir
    if (rec.expires - now < TOKEN_TTL - 24 * 3600 * 1000 || !(now - (rec.seen || 0) < 10 * 60000) || (c && c !== rec.client)) {
      rec.expires = now + TOKEN_TTL; rec.seen = now; if (c) rec.client = c;
      save('tokens.json', tokens);
    }
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
      const ip = clientIp(req);
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
      return { token: newToken(u, req), wrappedKey: b.wrappedKey };
    },

    'POST /api/login': (req, b) => {
      const u = String(b.user || '').toLowerCase();
      const ip = clientIp(req);
      if (limited(ip, 'u:' + u)) throw new HttpError(429, 'Çok fazla hatalı deneme, 15 dakika sonra tekrar deneyin');
      const rec = users[u];
      const good = rec && B64(b.authKey, 40, 64)
        && crypto.timingSafeEqual(Buffer.from(verifier(b.authKey, rec.vsalt), 'base64'), Buffer.from(rec.verifier, 'base64'));
      if (!good) { fail(ip, 'u:' + u); counters.failedLogins++; throw new HttpError(401, 'Kullanıcı adı veya parola yanlış'); }
      counters.logins++;
      return { token: newToken(u, req), wrappedKey: rec.wrappedKey };
    },

    'POST /api/logout': (req) => { const a = auth(req); delete tokens[a.hash]; save('tokens.json', tokens); return { ok: true }; },

    'GET /api/vault': (req) => {
      const a = auth(req);
      const v = load(vaultName(a.user), null);
      counters.syncs++;
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

    // Ana sayfadaki istatistikler. Davet koduyla girilir; kod boşsa sayfa kapalıdır.
    // Kasa içerikleri şifreli olduğundan burada yalnız sayılar, boyutlar ve zamanlar görünür.
    'POST /api/stats': (req, b) => {
      if (!invite) throw new HttpError(403, 'İstatistikler kapalı: sunucuda SSHDECK_SYNC_INVITE tanımlı değil');
      const ip = clientIp(req);
      if (limited(ip)) throw new HttpError(429, 'Çok fazla hatalı deneme, 15 dakika sonra tekrar deneyin');
      const ok = typeof b.invite === 'string' && b.invite.length === invite.length
        && crypto.timingSafeEqual(Buffer.from(b.invite), Buffer.from(invite));
      if (!ok) { fail(ip); throw new HttpError(403, 'Davet kodu yanlış'); }
      const now = Date.now();
      const devices = {};
      for (const t of Object.values(tokens)) {
        if (t.expires < now || !users[t.user]) continue;
        (devices[t.user] = devices[t.user] || []).push({ client: t.client || '', created: t.created || 0, seen: t.seen || 0 });
      }
      let vaultBytes = 0;
      const list = Object.entries(users).map(([u, rec]) => {
        let size = 0; let v = null;
        try { size = fs.statSync(file(vaultName(u))).size; v = load(vaultName(u), null); } catch {}
        vaultBytes += size;
        const devs = (devices[u] || []).sort((x, y) => y.seen - x.seen);
        return {
          user: u, created: Date.parse(rec.created) || 0, version: v ? v.version : 0, updated: v && v.updated ? Date.parse(v.updated) : 0,
          size, devices: devs, seen: devs.length ? devs[0].seen : 0,
        };
      }).sort((x, y) => (y.seen - x.seen) || x.user.localeCompare(y.user));
      const allDevs = Object.values(devices).flat();
      return {
        server: { started, uptime: now - started, register: true, node: process.version, now },
        totals: {
          users: list.length, devices: allDevs.length,
          activeDevices: allDevs.filter((d) => now - d.seen < 7 * 24 * 3600 * 1000).length,
          activeUsers: list.filter((x) => now - x.seen < 7 * 24 * 3600 * 1000).length,
          vaultBytes, ...counters,
        },
        users: list,
      };
    },
  };

  const handler = (req, res) => {
    const reply = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      return res.end(HOME_PAGE);
    }
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

// Ana sayfa: davet koduyla girilen istatistik paneli (dış kaynak yok; CSP ile yalnız kendi API'sine bağlanır)
const HOME_PAGE = String.raw`<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>SSHDeck Eşitleme</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='5' fill='%234f9dff'/%3E%3Cpath d='M6 8l4 4-4 4M12 16h6' stroke='white' stroke-width='2' fill='none' stroke-linecap='round'/%3E%3C/svg%3E">
<style>
:root { --bg: #0f1115; --bg2: #171a20; --line: #262a33; --fg: #d7dae0; --dim: #8b919c; --acc: #4f9dff; --ok: #57c785; --err: #e5534b; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root { --bg: #f4f5f7; --bg2: #ffffff; --line: #e1e4e9; --fg: #1d2129; --dim: #646b77; --acc: #2f7de0; --ok: #2a9a6d; --err: #d0453d; color-scheme: light; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 48px; }
header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
header h1 { font-size: 20px; margin: 0; font-weight: 600; }
header .sp { flex: 1; }
.logo { width: 32px; height: 32px; border-radius: 8px; background: var(--acc); display: grid; place-items: center; }
.card { background: var(--bg2); border: 1px solid var(--line); border-radius: 10px; }
.login { max-width: 380px; margin: 10vh auto 0; padding: 24px; }
.login h2 { margin: 0 0 4px; font-size: 18px; }
.login p { margin: 0 0 16px; color: var(--dim); }
input { width: 100%; padding: 9px 11px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; }
input:focus { outline: 2px solid var(--acc); outline-offset: -1px; }
button { padding: 8px 14px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg2); color: var(--fg); font: inherit; cursor: pointer; }
button.primary { background: var(--acc); border-color: var(--acc); color: #fff; }
button:disabled { opacity: .6; cursor: default; }
.row { display: flex; gap: 8px; margin-top: 12px; }
.row button { flex: 1; }
.err { color: var(--err); min-height: 20px; margin-top: 10px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
.tile { padding: 14px 16px; }
.tile .v { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tile .l { color: var(--dim); font-size: 12px; }
.tile .s { color: var(--dim); font-size: 12px; margin-top: 2px; }
h3 { font-size: 15px; margin: 0; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.tbl { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 9px 16px; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
th { color: var(--dim); font-weight: 500; font-size: 12px; }
tr:last-child td { border-bottom: 0; }
td.devs { white-space: normal; min-width: 240px; }
.dev { display: flex; gap: 8px; justify-content: space-between; color: var(--dim); font-size: 12px; }
.dev b { color: var(--fg); font-weight: 500; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--dim); margin-right: 6px; vertical-align: 1px; }
.dot.on { background: var(--ok); }
.empty { padding: 24px 16px; color: var(--dim); }
.foot { color: var(--dim); font-size: 12px; margin-top: 16px; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <div class="logo"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M6 8l4 4-4 4M12 16h6"/></svg></div>
    <h1>SSHDeck eşitleme sunucusu</h1>
    <span class="sp"></span>
    <button id="refresh" hidden>Yenile</button>
    <button id="logout" hidden>Çıkış</button>
  </header>

  <form id="login" class="card login" hidden>
    <h2>İstatistikler</h2>
    <p>Sunucudaki davet koduyla (SSHDECK_SYNC_INVITE) girin.</p>
    <input id="code" type="password" autocomplete="current-password" placeholder="Davet kodu" autofocus>
    <div class="row"><button class="primary" id="go" type="submit">Giriş</button></div>
    <div class="err" id="err"></div>
  </form>

  <section id="stats" hidden>
    <div class="tiles" id="tiles"></div>
    <div class="card">
      <h3>Hesaplar</h3>
      <div class="tbl"><table>
        <thead><tr><th>Kullanıcı</th><th>Son görülme</th><th>Son değişiklik</th><th>Kasa sürümü</th><th>Kasa boyutu</th><th>Açılış</th><th>Cihazlar</th></tr></thead>
        <tbody id="users"></tbody>
      </table></div>
    </div>
    <div class="foot" id="foot"></div>
  </section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'sshdeckStatsCode';
  var code = '';
  try { code = sessionStorage.getItem(KEY) || ''; } catch (e) {}

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function bytes(n) { var u = ['B', 'KB', 'MB', 'GB']; var i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; }
  function ago(t, now) {
    if (!t) return '—';
    var s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return 'az önce';
    if (s < 3600) return Math.floor(s / 60) + ' dk önce';
    if (s < 86400) return Math.floor(s / 3600) + ' sa önce';
    if (s < 30 * 86400) return Math.floor(s / 86400) + ' gün önce';
    return date(t);
  }
  function date(t) { return t ? new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function dur(ms) {
    var m = Math.floor(ms / 60000); var d = Math.floor(m / 1440); var h = Math.floor((m % 1440) / 60);
    return d ? d + ' gün ' + h + ' sa' : h ? h + ' sa ' + (m % 60) + ' dk' : (m % 60) + ' dk';
  }
  var WEEK = 7 * 86400000;

  function show(view) {
    $('login').hidden = view !== 'login';
    $('stats').hidden = view !== 'stats';
    $('refresh').hidden = $('logout').hidden = view !== 'stats';
  }

  function load() {
    $('err').textContent = '';
    $('go').disabled = $('refresh').disabled = true;
    return fetch('api/stats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite: code }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('Sunucu hatası (' + r.status + ')')); return d; }); })
      .then(function (d) { try { sessionStorage.setItem(KEY, code); } catch (e) {} render(d); show('stats'); })
      .catch(function (e) {
        try { sessionStorage.removeItem(KEY); } catch (x) {}
        show('login'); $('err').textContent = e.message === 'Failed to fetch' ? 'Sunucuya ulaşılamadı' : e.message; $('code').focus();
      })
      .then(function () { $('go').disabled = $('refresh').disabled = false; });
  }

  function tile(label, value, sub) {
    var t = el('div', null, 'card tile');
    t.append(el('div', label, 'l'), el('div', String(value), 'v'));
    if (sub) t.append(el('div', sub, 's'));
    return t;
  }

  function render(d) {
    var now = d.server.now, T = d.totals;
    $('tiles').replaceChildren(
      tile('Hesaplar', T.users, T.activeUsers + ' hesap son 7 günde etkin'),
      tile('Bağlı cihazlar', T.devices, T.activeDevices + ' cihaz son 7 günde görüldü'),
      tile('Toplam kasa', bytes(T.vaultBytes), 'uçtan uca şifreli'),
      tile('Eşitleme', T.syncs, 'sunucu açıldığından beri'),
      tile('Giriş', T.logins, T.failedLogins + ' hatalı deneme'),
      tile('Çalışma süresi', dur(d.server.uptime), 'Node ' + d.server.node));
    var tb = $('users');
    tb.replaceChildren();
    if (!d.users.length) {
      var tr0 = el('tr'); var td0 = el('td', 'Henüz hesap yok. Uygulamada bulut düğmesi → Hesap oluştur.', 'empty'); td0.colSpan = 7; tr0.append(td0); tb.append(tr0);
    }
    d.users.forEach(function (u) {
      var tr = el('tr');
      var name = el('td'); var dot = el('span', null, 'dot' + (now - u.seen < WEEK ? ' on' : '')); name.append(dot, el('b', u.user));
      var devs = el('td', null, 'devs');
      if (!u.devices.length) devs.append(el('span', 'oturum açık cihaz yok', 'dev'));
      u.devices.forEach(function (x) {
        var r = el('div', null, 'dev'); r.append(el('b', x.client || 'bilinmeyen istemci'), el('span', ago(x.seen, now))); devs.append(r);
      });
      tr.append(name, el('td', ago(u.seen, now)), el('td', ago(u.updated, now)), el('td', String(u.version)), el('td', bytes(u.size)), el('td', date(u.created)), devs);
      tb.append(tr);
    });
    $('foot').textContent = 'Sunucu kasaların içeriğini göremez: oturum adları, adresler ve parolalar burada hiçbir zaman görünmez. Güncelleme: ' + new Date(now).toLocaleTimeString('tr-TR');
  }

  $('login').addEventListener('submit', function (e) { e.preventDefault(); code = $('code').value.trim(); if (code) load(); });
  $('refresh').addEventListener('click', load);
  $('logout').addEventListener('click', function () { code = ''; try { sessionStorage.removeItem(KEY); } catch (e) {} $('code').value = ''; show('login'); $('code').focus(); });
  if (code) load(); else show('login');
})();
</script>
</body>
</html>`;


if (require.main === module) {
  const port = Number(process.env.PORT) || 3150;
  const host = process.env.HOST || '0.0.0.0';
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const handler = createSyncServer({ dataDir, invite: process.env.SSHDECK_SYNC_INVITE || '', trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '') });
  const tls = process.env.TLS_CERT && process.env.TLS_KEY;
  const srv = tls
    ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handler)
    : http.createServer(handler);
  srv.listen(port, host, () => {
    console.log(`SSHDeck eşitleme sunucusu: ${tls ? 'https' : 'http'}://${host}:${port}  (veri: ${dataDir})`);
    if (!process.env.SSHDECK_SYNC_INVITE) console.log('Uyarı: SSHDECK_SYNC_INVITE boş, yeni hesap açılamaz.');
  });
}
