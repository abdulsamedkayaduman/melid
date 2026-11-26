#!/usr/bin/env node
'use strict';
// Melid hesap/eşitleme sunucusu. Bağımlılıksız (yalnız Node). Uçtan uca şifreli: sunucu kasayı çözemez.
//
// Sunucu ne görür: kullanıcı adı, e-posta, PBKDF2 tuzu, giriş anahtarının scrypt özeti, şifreli kasa anahtarı
// (wrappedKey) ve şifreli kasa. Parolanın kendisi ve şifreleme anahtarı istemciden hiç çıkmaz.
//
// Sayfalar: /  tanıtım ve indirme sayfası (pages/home.html), /admin  yönetici paneli (pages/admin.html; yalnız
// MELID_ADMIN_IPS'ten ve MELID_ADMIN_KEY ile). /guncelleme/latest.json ve /indir/<sürüm>/<dosya>: UPDATE_UPSTREAM
// verilmişse oradaki sürüm dosyalarını dışarıya aktarır (imzalı akış; uygulamalar imzayı kendileri doğrular).
//
// Ortam değişkenleri:
//   PORT (3150), HOST (0.0.0.0), DATA_DIR (./data)
//   MELID_REGISTER     open (varsayılan: herkes hesap açabilir) | invite (davet koduyla) | closed
//   MELID_SYNC_INVITE  invite kipinde davet kodu
//   MELID_MAX_USERS    en fazla hesap (1000)
//   MELID_ADMIN_KEY    yönetici paneli parolası (boşsa MELID_SYNC_INVITE; ikisi de boşsa panel kapalı)
//   MELID_ADMIN_IPS    paneli açabilecek adresler, virgülle: 203.0.113.7, 192.168.0.0/16, 2001:db8::/48
//                        (boşsa yalnız yerel ağ ve bu makine)
//   UPDATE_FEED_URL      imzalı latest.json'ın adresi (ör. https://github.com/<kullanıcı>/<depo>/releases/latest/download/latest.json);
//                        /guncelleme/latest.json buradan alınıp 5 dakika bellekte tutulur. İndirme adresleri akışın içinde.
//   UPDATE_UPSTREAM      sürüm dosyalarının iç adresi (ör. bir paket deposunun .../<sürüm>/<dosya> kökü); hem akış
//                        hem /indir/<sürüm>/<dosya> buradan aktarılır (UPDATE_FEED_URL yoksa)
//   TLS_CERT / TLS_KEY   verilirse HTTPS (yoksa HTTP; internete açarken önüne TLS'li ters vekil koyun)
//   TRUST_PROXY          1: ters vekil (Traefik/Dokploy, nginx) arkasında istemci IP'si X-Forwarded-For'un en sağındaki girdisi.
//                        cloudflare: üstelik o girdi bir Cloudflare adresiyse gerçek IP CF-Connecting-IP'den alınır
//                        (sunucuya Cloudflare'i atlayıp doğrudan gelen istek bu başlığı taklit edemez)
const http = require('http');
const os = require('os');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const MAX_BODY = 16 * 1024 * 1024;
const TOKEN_TTL = 365 * 24 * 3600 * 1000; // kullanıldıkça uzar
const USER_RE = /^[a-z0-9._-]{2,40}$/;
const EMAIL_RE = /^[^\s@<>"'`]{1,64}@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/;
const normEmail = (e) => String(e || '').trim().toLowerCase();
const PRIVATE_NETS = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7'];
const REG_PER_IP_DAY = 5;
// https://www.cloudflare.com/ips/ (2026)
const CLOUDFLARE_NETS = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14',
  '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32']; // aynı IP'den günde en fazla yeni hesap

/** "1.2.3.4, 10.0.0.0/8, 2001:db8::/32" -> BlockList */
function ipList(spec) {
  const bl = new net.BlockList();
  for (const raw of (Array.isArray(spec) ? spec : String(spec || '').split(/[\s,]+/))) {
    const x = String(raw).trim();
    if (!x) continue;
    const [addr, bits] = x.split('/');
    const type = net.isIPv6(addr) ? 'ipv6' : net.isIPv4(addr) ? 'ipv4' : null;
    if (!type) { console.error(`MELID_ADMIN_IPS: geçersiz adres yok sayıldı: ${x}`); continue; }
    if (bits) bl.addSubnet(addr, Number(bits), type); else bl.addAddress(addr, type);
  }
  return bl;
}
const plainIp = (ip) => String(ip || '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
const ipIn = (bl, ip) => { ip = plainIp(ip); const t = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null; return !!t && bl.check(ip, t); };

const B64 = (s, min, max) => typeof s === 'string' && /^[A-Za-z0-9+/=]+$/.test(s) && s.length >= min && s.length <= max;

function createSyncServer({
  dataDir, invite = '', register, adminKey = '', adminIps = '', trustProxy = false, maxUsers = 1000, updateUpstream = '', updateFeedUrl = '', pagesDir,
}) {
  const cfNets = ipList(CLOUDFLARE_NETS);
  const regMode = register || (invite ? 'invite' : 'open');
  if (regMode === 'invite' && !invite) throw new Error('MELID_REGISTER=invite için MELID_SYNC_INVITE gerekli');
  const adminSecret = adminKey || invite;
  const adminNets = ipList(adminIps || PRIVATE_NETS);
  const page = (n) => { try { return fs.readFileSync(path.join(pagesDir || path.join(__dirname, 'pages'), n), 'utf8'); } catch { return `<!doctype html><title>Melid</title><p>${n} bulunamadı</p>`; } };
  const PAGES = { home: page('home.html'), admin: page('admin.html'), terms: page('kosullar.html'), homeEn: page('home.en.html'), termsEn: page('kosullar.en.html') };
  // Sayfa dili: ?lang=tr|en (seçim çerezde bir yıl hatırlanır) > melid_lang çerezi > tarayıcı dili (tr değilse İngilizce)
  const pageLang = (req, url) => {
    const q = url.searchParams.get('lang');
    if (q === 'tr' || q === 'en') return { lang: q, cookie: `melid_lang=${q}; Max-Age=31536000; Path=/; SameSite=Lax` };
    const c = /(?:^|;\s*)melid_lang=(tr|en)\b/.exec(req.headers.cookie || '');
    if (c) return { lang: c[1] };
    const al = String(req.headers['accept-language'] || '').trim().toLowerCase();
    return { lang: !al || al === '*' || al.startsWith('tr') ? 'tr' : 'en' };
  };
  // Favicon ve uygulama ikonları (pages/static, melid-brand/web)
  const STATIC_TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  const STATIC = new Map();
  try {
    const dir = path.join(pagesDir || path.join(__dirname, 'pages'), 'static');
    for (const n of fs.readdirSync(dir)) if (STATIC_TYPES[path.extname(n)]) STATIC.set('/' + n, { type: STATIC_TYPES[path.extname(n)], body: fs.readFileSync(path.join(dir, n)) });
  } catch {}

  // Vekil arkasında herkes vekilin IP'siyle gelir: vekilin eklediği en sağdaki X-Forwarded-For girdisi kullanılır
  // (soldakileri istemci kendisi yazabilir). Cloudflare kipinde o girdi bir Cloudflare adresiyse gerçek istemci
  // CF-Connecting-IP'dedir; Cloudflare'i atlayan istek bu başlığı yazsa da sayılmaz.
  const realIp = (req) => {
    let ip = plainIp(req.socket.remoteAddress);
    if (!trustProxy) return ip;
    const xff = req.headers['x-forwarded-for'];
    if (xff) { const last = plainIp(String(xff).split(',').pop().trim()); if (net.isIP(last)) ip = last; }
    if (trustProxy === 'cloudflare' && ipIn(cfNets, ip)) {
      const cf = plainIp(String(req.headers['cf-connecting-ip'] || '').trim());
      if (net.isIP(cf)) ip = cf;
    }
    return ip;
  };
  const clientIp = (req) => 'ip:' + realIp(req);
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

  // ---- İstatistikler (stats.json): günlük sayaçlar ve kalıcı toplamlar; sunucu yeniden başlasa da korunur.
  // Gün, MELID_STATS_TZ saat diliminde (varsayılan İstanbul). 120 günden eski günler atılır.
  const statsTz = process.env.MELID_STATS_TZ || 'Europe/Istanbul';
  const dayKey = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: statsTz });
  const stats = load('stats.json', null) || { since: new Date().toISOString(), totals: {}, days: {} };
  let statsDirty = false;
  const today = () => { const k = dayKey(); return stats.days[k] || (stats.days[k] = { users: [], devices: [] }); };
  const bump = (key, n = 1) => { const d = today(); d[key] = (d[key] || 0) + n; stats.totals[key] = (stats.totals[key] || 0) + n; statsDirty = true; };
  const seenToday = (user, dev) => {
    const d = today();
    if (!d.users.includes(user)) { d.users.push(user); statsDirty = true; }
    if (dev && !d.devices.includes(dev)) { d.devices.push(dev); statsDirty = true; }
  };
  // Uygulama kullanım sayıları (usage.json): kullanıcı -> cihaz -> gün; istemci açıksa gönderir (POST /api/usage)
  const usage = load('usage.json', {});
  let usageDirty = false;
  const USAGE_KEYS = ['connections', 'connectionFailures', 'transfers', 'transferFailures', 'bytesUp', 'bytesDown', 'tunnels'];
  const SNAP_KEYS = ['sessions', 'groups', 'keys', 'snippets', 'savedTunnels'];
  const pickNums = (o, keys) => {
    const out = {};
    if (o && typeof o === 'object') for (const k of keys) { const v = Number(o[k]); if (Number.isFinite(v) && v > 0) out[k] = Math.min(Math.floor(v), 1e15); }
    return out;
  };
  // Kurulumlar (installs.json): güncelleme denetimindeki X-Melid-Device (kuruluma özgü rastgele kimlik) + X-Melid-Client.
  // Hesap, ad, IP tutulmaz. 90 gün görülmeyen kurulumun ayrıntısı silinir, yalnız "emekli" sayılarına eklenir.
  const installs = load('installs.json', null) || { devices: {}, retired: { count: 0, byOs: {}, byVersion: {} } };
  let installsDirty = false;
  const RETIRE_MS = 90 * 86400000;
  const parseClient = (c) => {
    const m = /^\S+\s+(\d+\.\d+\.\d+\S*)\s*(.*)$/.exec(c || '');
    const r = (m ? m[2] : '').toLowerCase();
    return {
      version: m ? m[1] : 'bilinmiyor',
      os: /android/.test(r) ? 'Android' : /win/.test(r) ? 'Windows' : /mac|darwin/.test(r) ? 'macOS' : /linux/.test(r) ? 'Linux' : 'Bilinmiyor',
    };
  };
  const notePing = (req) => {
    const id = String(req.headers['x-melid-device'] || '');
    if (!/^[\w-]{16,64}$/.test(id)) return;
    const now = Date.now();
    const client = clientName(req);
    let d = installs.devices[id];
    if (!d) { d = installs.devices[id] = { first: now, last: 0, client }; bump('newInstalls'); }
    if (client) d.client = client;
    d.last = now;
    installsDirty = true;
    const day = today();
    const short = crypto.createHash('sha256').update(id).digest('hex').slice(0, 12); // günlük listede kimliğin özeti
    if (!(day.installs || (day.installs = [])).includes(short)) { day.installs.push(short); statsDirty = true; }
  };
  const retireInstalls = () => {
    const cut = Date.now() - RETIRE_MS;
    for (const [id, d] of Object.entries(installs.devices)) {
      if (d.last >= cut) continue;
      const p = parseClient(d.client);
      const R = installs.retired;
      R.count++; R.byOs[p.os] = (R.byOs[p.os] || 0) + 1; R.byVersion[p.version] = (R.byVersion[p.version] || 0) + 1;
      delete installs.devices[id];
      installsDirty = true;
    }
  };

  // Anlık: son istekler (cihaz başına) ve dakika başına istek sayısı (son 60 dk)
  const live = new Map(); // jeton özeti -> { user, client, ts }
  const perMinute = new Map(); // dakika (epoch/60000) -> istek
  const flushStats = () => {
    const cut = dayKey(Date.now() - 120 * 86400000);
    if (statsDirty) {
      for (const k of Object.keys(stats.days)) if (k < cut) delete stats.days[k];
      save('stats.json', stats); statsDirty = false;
    }
    retireInstalls();
    if (installsDirty) { save('installs.json', installs); installsDirty = false; }
    if (usageDirty) {
      for (const u of Object.values(usage)) for (const d of Object.values(u.devices || {})) for (const k of Object.keys(d.days || {})) if (k < cut) delete d.days[k];
      save('usage.json', usage); usageDirty = false;
    }
    const m = Math.floor(Date.now() / 60000);
    for (const k of perMinute.keys()) if (k < m - 60) perMinute.delete(k);
    for (const [k, v] of live) if (Date.now() - v.ts > 3600000) live.delete(k);
  };
  setInterval(flushStats, 60000).unref();
  // İstemci kendini X-Melid-Client başlığıyla tanıtır (ör. "Melid 1.5.0 linux"); yalnız istatistik için
  const clientName = (req) => String(req.headers['x-melid-client'] || req.headers['user-agent'] || '').replace(/[^\w .:;/()+-]/g, '').slice(0, 60);
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
  // Kayıt sınırı: IP başına günde REG_PER_IP_DAY hesap
  const regs = new Map();
  const regCount = (ip) => { const now = Date.now(); const a = (regs.get(ip) || []).filter((t) => now - t < 86400000); regs.set(ip, a); return a; };
  // Bellekte birikmesin: süresi geçen kayıtlar saatte bir atılır
  setInterval(() => {
    const now = Date.now();
    for (const [k, a] of fails) if (!a.some((t) => now - t < 15 * 60000)) fails.delete(k);
    for (const [k, a] of regs) if (!a.some((t) => now - t < 86400000)) regs.delete(k);
  }, 3600000).unref();

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
    const hash = tokenHash(m[1]);
    live.set(hash, { user: rec.user, client: rec.client || c, ts: now });
    seenToday(rec.user, hash.slice(0, 12));
    return { user: rec.user, hash };
  };

  const recoverCheck = (req, b) => {
    const u = String(b.user || '').toLowerCase();
    const ip = clientIp(req);
    if (limited(ip, 'u:' + u)) throw new HttpError(429, 'Çok fazla hatalı deneme, 15 dakika sonra tekrar deneyin');
    const r = users[u] && users[u].recovery;
    const good = r && B64(b.recAuth, 40, 64)
      && crypto.timingSafeEqual(Buffer.from(verifier(b.recAuth, r.vsalt), 'base64'), Buffer.from(r.verifier, 'base64'));
    if (!good) { fail(ip, 'u:' + u); bump('failedLogins'); throw new HttpError(401, 'Kullanıcı adı veya kurtarma anahtarı yanlış'); }
    return true;
  };

  const removeUser = (u) => {
    bump('deletions');
    // Silinen hesabın adı istatistiklerden ve kullanım kayıtlarından da çıkar
    for (const d of Object.values(stats.days)) d.users = (d.users || []).filter((x) => x !== u);
    if (usage[u]) { delete usage[u]; usageDirty = true; }
    for (const [k, v] of live) if (v.user === u) live.delete(k);
    delete users[u];
    save('users.json', users);
    try { fs.unlinkSync(file(vaultName(u))); } catch {}
    for (const [k, v] of Object.entries(tokens)) if (v.user === u) delete tokens[k];
    save('tokens.json', tokens);
  };

  const adminIpOk = (req) => ipIn(adminNets, realIp(req));
  const adminCheck = (req, b) => {
    if (!adminSecret || !adminIpOk(req)) throw new HttpError(404, 'Bulunamadı');
    const ip = clientIp(req);
    if (limited(ip)) throw new HttpError(429, 'Çok fazla hatalı deneme, 15 dakika sonra tekrar deneyin');
    const ok = typeof b.key === 'string' && b.key.length === adminSecret.length
      && crypto.timingSafeEqual(Buffer.from(b.key), Buffer.from(adminSecret));
    if (!ok) { fail(ip); throw new HttpError(403, 'Yönetici parolası yanlış'); }
  };

  const routes = {
    // register: hesap açılabilir mi; invite: davet kodu gerekir mi
    'GET /api/info': () => ({ app: 'Melid', api: 2, register: regMode !== 'closed' && Object.keys(users).length < maxUsers, invite: regMode === 'invite' }),

    // Giriş öncesi: KDF tuzu. Olmayan kullanıcıya da sabit sahte tuz döner (hesap var/yok sızmasın).
    'GET /api/prelogin': (req, _b, url) => {
      const u = String(url.searchParams.get('user') || '').toLowerCase();
      need(USER_RE.test(u), 'Geçersiz kullanıcı adı');
      if (users[u]) return { salt: users[u].salt, iter: users[u].iter };
      const fake = crypto.createHmac('sha256', Buffer.from(secret.key, 'base64')).update(u).digest().subarray(0, 16);
      return { salt: fake.toString('base64'), iter: 600000 };
    },

    'POST /api/register': (req, b) => {
      if (regMode === 'closed') throw new HttpError(403, 'Bu sunucuda yeni hesap açılamıyor');
      const ip = clientIp(req);
      if (limited(ip)) throw new HttpError(429, 'Çok fazla deneme, biraz sonra tekrar deneyin');
      if (regMode === 'invite') {
        const ok = typeof b.invite === 'string' && b.invite.length === invite.length
          && crypto.timingSafeEqual(Buffer.from(b.invite), Buffer.from(invite));
        if (!ok) { fail(ip); throw new HttpError(403, b.invite ? 'Davet kodu yanlış' : 'Bu sunucuda hesap açmak için davet kodu gerekli'); }
      }
      if (Object.keys(users).length >= maxUsers) throw new HttpError(403, 'Sunucu dolu: yeni hesap açılamıyor');
      if (regCount(ip).length >= REG_PER_IP_DAY) throw new HttpError(429, 'Bu ağdan bugün çok fazla hesap açıldı, yarın tekrar deneyin');
      const u = String(b.user || '').toLowerCase();
      need(USER_RE.test(u), 'Kullanıcı adı 2-40 karakter olmalı (küçük harf, rakam, . _ -)');
      const email = normEmail(b.email);
      need(email.length <= 120 && EMAIL_RE.test(email), b.email ? 'E-posta adresi geçersiz' : 'E-posta adresi gerekli (uygulamayı güncelleyin)');
      need(B64(b.salt, 16, 64) && B64(b.authKey, 40, 64) && B64(b.wrappedKey, 40, 200), 'Eksik veya hatalı alan');
      need(Number.isInteger(b.iter) && b.iter >= 100000 && b.iter <= 10000000, 'Hatalı KDF ayarı');
      if (users[u]) throw new HttpError(409, 'Bu kullanıcı adı alınmış');
      const vsalt = crypto.randomBytes(16).toString('base64');
      users[u] = { email, salt: b.salt, iter: b.iter, vsalt, verifier: verifier(b.authKey, vsalt), wrappedKey: b.wrappedKey, created: new Date().toISOString() };
      save('users.json', users);
      regCount(ip).push(Date.now());
      bump('registrations');
      return { token: newToken(u, req), wrappedKey: b.wrappedKey };
    },

    'POST /api/login': (req, b) => {
      const u = String(b.user || '').toLowerCase();
      const ip = clientIp(req);
      if (limited(ip, 'u:' + u)) throw new HttpError(429, 'Çok fazla hatalı deneme, 15 dakika sonra tekrar deneyin');
      const rec = users[u];
      const good = rec && B64(b.authKey, 40, 64)
        && crypto.timingSafeEqual(Buffer.from(verifier(b.authKey, rec.vsalt), 'base64'), Buffer.from(rec.verifier, 'base64'));
      if (!good) { fail(ip, 'u:' + u); bump('failedLogins'); throw new HttpError(401, 'Kullanıcı adı veya parola yanlış'); }
      bump('logins');
      return { token: newToken(u, req), wrappedKey: rec.wrappedKey };
    },

    'POST /api/logout': (req) => { const a = auth(req); delete tokens[a.hash]; save('tokens.json', tokens); return { ok: true }; },

    'GET /api/vault': (req) => {
      const a = auth(req);
      const v = load(vaultName(a.user), null);
      bump('syncs');
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

    // Hesap bilgisi (kurtarma anahtarı var mı)
    'GET /api/account': (req) => {
      const a = auth(req);
      const rec = users[a.user];
      return { user: a.user, email: rec.email || '', created: rec.created, recovery: rec.recovery ? rec.recovery.created : null };
    },

    'POST /api/email': (req, b) => {
      const a = auth(req);
      const email = normEmail(b.email);
      need(email.length <= 120 && EMAIL_RE.test(email), 'E-posta adresi geçersiz');
      users[a.user].email = email;
      save('users.json', users);
      return { email };
    },

    // Hesabı sil: hesap parolasıyla doğrulanır (çalınan jeton yetmesin). Kasa, oturumlar ve kurtarma bilgisi silinir.
    'POST /api/account/delete': (req, b) => {
      const a = auth(req);
      const rec = users[a.user];
      if (limited('u:' + a.user)) throw new HttpError(429, 'Çok fazla hatalı deneme, 15 dakika sonra tekrar deneyin');
      const good = B64(b.authKey, 40, 64)
        && crypto.timingSafeEqual(Buffer.from(verifier(b.authKey, rec.vsalt), 'base64'), Buffer.from(rec.verifier, 'base64'));
      if (!good) { fail('u:' + a.user); throw new HttpError(401, 'Hesap parolası yanlış'); }
      removeUser(a.user);
      return { ok: true };
    },

    // Kurtarma anahtarı koy / değiştir. Hesap parolasıyla doğrulanır (yalnız jetonla olmaz: çalınan jeton hesabı ele
    // geçirmeye yetmesin). Sunucu kodun kendisini değil, ondan türetilen doğrulayıcıyı ve onunla sarılmış kasa anahtarını tutar.
    'POST /api/recovery': (req, b) => {
      const a = auth(req);
      const rec = users[a.user];
      if (limited('u:' + a.user)) throw new HttpError(429, 'Çok fazla hatalı deneme, 15 dakika sonra tekrar deneyin');
      const good = B64(b.authKey, 40, 64)
        && crypto.timingSafeEqual(Buffer.from(verifier(b.authKey, rec.vsalt), 'base64'), Buffer.from(rec.verifier, 'base64'));
      if (!good) { fail('u:' + a.user); throw new HttpError(401, 'Hesap parolası yanlış'); }
      if (b.remove === true) { delete rec.recovery; save('users.json', users); return { recovery: null }; }
      need(B64(b.recAuth, 40, 64) && B64(b.recWrapped, 40, 200), 'Eksik veya hatalı alan');
      const vsalt = crypto.randomBytes(16).toString('base64');
      rec.recovery = { vsalt, verifier: verifier(b.recAuth, vsalt), wrapped: b.recWrapped, created: new Date().toISOString() };
      save('users.json', users);
      return { recovery: rec.recovery.created };
    },

    // Parolasını unutan kullanıcı: kurtarma anahtarıyla kasa anahtarını alır (begin), yeni parolayla yeniden sarıp kaydeder
    // (finish). Deneme sınırı girişle aynı; başarılı kurtarmada tüm oturumlar kapanır.
    'POST /api/recover/begin': (req, b) => recoverCheck(req, b) && { recWrapped: users[String(b.user).toLowerCase()].recovery.wrapped },
    'POST /api/recover/finish': (req, b) => {
      recoverCheck(req, b);
      const u = String(b.user).toLowerCase();
      const rec = users[u];
      need(B64(b.newSalt, 16, 64) && B64(b.newAuthKey, 40, 64) && B64(b.wrappedKey, 40, 200), 'Eksik veya hatalı alan');
      need(Number.isInteger(b.iter) && b.iter >= 100000 && b.iter <= 10000000, 'Hatalı KDF ayarı');
      const vsalt = crypto.randomBytes(16).toString('base64');
      Object.assign(rec, { salt: b.newSalt, iter: b.iter, vsalt, verifier: verifier(b.newAuthKey, vsalt), wrappedKey: b.wrappedKey });
      save('users.json', users);
      for (const [k, v] of Object.entries(tokens)) if (v.user === u) delete tokens[k];
      save('tokens.json', tokens);
      bump('logins');
      return { token: newToken(u, req), wrappedKey: rec.wrappedKey };
    },

    // Uygulama kullanım sayıları: istemci (kapatılmadıysa) günlük sayaçlarını ve anlık sayılarını gönderir. Gün başına
    // değerin tamamı gönderildiği için tekrar gönderim üstüne yazar, iki kez sayılmaz. Sunucu adresi vb. hiç gelmez.
    'POST /api/usage': (req, b) => {
      const a = auth(req);
      const dev = a.hash.slice(0, 12);
      const U = usage[a.user] || (usage[a.user] = { devices: {} });
      const D = U.devices[dev] || (U.devices[dev] = { days: {} });
      D.client = clientName(req); D.updated = Date.now();
      if (b.snapshot) D.snapshot = pickNums(b.snapshot, SNAP_KEYS);
      if (b.days && typeof b.days === 'object') {
        for (const [k, v] of Object.entries(b.days).slice(-31)) if (/^\d{4}-\d{2}-\d{2}$/.test(k)) D.days[k] = pickNums(v, USAGE_KEYS);
      }
      usageDirty = true;
      bump('usageReports');
      return { ok: true };
    },

    // Yönetici paneli (/admin): yalnız MELID_ADMIN_IPS'ten ve yönetici parolasıyla. Kasa içerikleri şifreli olduğundan
    // burada yalnız hesap bilgileri, sayılar, boyutlar ve zamanlar görünür.
    'POST /api/admin/stats': (req, b) => {
      adminCheck(req, b);
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
          user: u, email: rec.email || '', created: Date.parse(rec.created) || 0, version: v ? v.version : 0, updated: v && v.updated ? Date.parse(v.updated) : 0,
          size, devices: devs, seen: devs.length ? devs[0].seen : 0, recovery: !!rec.recovery,
        };
      }).sort((x, y) => (y.seen - x.seen) || x.user.localeCompare(y.user));
      const allDevs = Object.values(devices).flat();
      // Son 30 gün: sunucu sayaçları + uygulama kullanım toplamları
      const days = [];
      for (let i = 29; i >= 0; i--) {
        const k = dayKey(now - i * 86400000);
        const d = stats.days[k] || {};
        const use = {};
        for (const u of Object.values(usage)) for (const dv of Object.values(u.devices || {})) {
          const x = (dv.days || {})[k]; if (x) for (const [kk, vv] of Object.entries(x)) use[kk] = (use[kk] || 0) + vv;
        }
        days.push({
          date: k, activeUsers: (d.users || []).length, activeDevices: (d.devices || []).length,
          installs: (d.installs || []).length, newInstalls: d.newInstalls || 0,
          logins: d.logins || 0, failedLogins: d.failedLogins || 0, syncs: d.syncs || 0, registrations: d.registrations || 0,
          deletions: d.deletions || 0, requests: d.requests || 0, errors: d.errors || 0, denied: d.denied || 0, usage: use,
        });
      }
      const last30 = new Set(days.map((d) => d.date));
      // Hesap başına uygulama kullanımı: son anlık sayılar (cihazlardaki en büyük) ve 30 günlük toplam
      for (const x of list) {
        const U = usage[x.user]; const snap = {}; const sum = {};
        let reported = 0;
        if (U) for (const dv of Object.values(U.devices || {})) {
          reported = Math.max(reported, dv.updated || 0);
          for (const [k, v] of Object.entries(dv.snapshot || {})) snap[k] = Math.max(snap[k] || 0, v);
          for (const [day, v] of Object.entries(dv.days || {})) if (last30.has(day)) for (const [k, n] of Object.entries(v)) sum[k] = (sum[k] || 0) + n;
        }
        x.usage = { snapshot: snap, last30: sum, reported };
      }
      const onlineCut = now - 10 * 60000;
      const online = [...live.values()].filter((v) => v.ts > onlineCut).sort((p, q) => q.ts - p.ts).map((v) => ({ user: v.user, client: v.client, seen: v.ts }));
      const m = Math.floor(now / 60000);
      const rpm = []; for (let i = 59; i >= 0; i--) rpm.push(perMinute.get(m - i) || 0);
      let disk = null;
      try { const f = fs.statfsSync(dataDir); disk = { total: f.blocks * f.bsize, free: f.bavail * f.bsize }; } catch {}
      let dataBytes = 0;
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { dataBytes += fs.statSync(p).size; } catch {} } };
      try { walk(dataDir); } catch {}
      const mem = process.memoryUsage();
      return {
        server: {
          started, uptime: now - started, register: regMode, maxUsers, node: process.version, now, tz: statsTz,
          rss: mem.rss, heapUsed: mem.heapUsed, memTotal: os.totalmem(), memFree: os.freemem(), load: os.loadavg(),
          cpus: os.cpus().length, disk, dataBytes, statsSince: stats.since,
        },
        totals: {
          users: list.length, devices: allDevs.length,
          activeDevices: allDevs.filter((d) => now - d.seen < 7 * 24 * 3600 * 1000).length,
          activeUsers: list.filter((x) => now - x.seen < 7 * 24 * 3600 * 1000).length,
          withRecovery: list.filter((x) => x.recovery).length,
          vaultBytes, online: online.length,
        },
        lifetime: stats.totals,
        installs: (() => {
          const list = Object.entries(installs.devices).map(([id, d]) => ({ id: id.slice(0, 8), first: d.first, last: d.last, client: d.client || '', ...parseClient(d.client) }));
          const act = (ms) => list.filter((x) => now - x.last < ms).length;
          const by = (key, ms) => { const o = {}; for (const x of list) if (!ms || now - x.last < ms) o[x[key]] = (o[x[key]] || 0) + 1; return o; };
          return {
            known: list.length, active1: act(86400000), active7: act(7 * 86400000), active30: act(30 * 86400000),
            new30: list.filter((x) => now - x.first < 30 * 86400000).length, retired: installs.retired,
            byVersion: by('version', 30 * 86400000), byOs: by('os', 30 * 86400000), byOsAll: by('os'),
            recent: list.sort((p, q) => q.last - p.last).slice(0, 100),
          };
        })(),
        latestVersion: feedVersion(),
        days, online, rpm,
        users: list,
      };
    },

    'POST /api/admin/delete': (req, b) => {
      adminCheck(req, b);
      const u = String(b.user || '').toLowerCase();
      if (!users[u]) throw new HttpError(404, 'Böyle bir hesap yok');
      removeUser(u);
      return { ok: true };
    },
  };

  // UPDATE_FEED_URL: latest.json yönlendirmeleri izlenerek alınır (GitHub sürüm dosyaları başka bir sunucuya yönlendirir)
  let urlFeed = null; let urlFeedWait = null;
  const fetchFeed = (u, hops = 0) => new Promise((resolve, reject) => {
    const target = new URL(u);
    (target.protocol === 'https:' ? https : http).get(target, { timeout: 20000, headers: { 'User-Agent': 'Melid-sync' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && hops < 5) {
        r.resume(); return resolve(fetchFeed(new URL(r.headers.location, target).toString(), hops + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const chunks = []; let size = 0;
      r.on('data', (c) => { size += c.length; if (size > 1048576) r.destroy(new Error('çok büyük')); else chunks.push(c); });
      r.on('end', () => resolve(Buffer.concat(chunks)));
      r.on('error', reject);
    }).on('timeout', function () { this.destroy(new Error('timeout')); }).on('error', reject);
  });
  const serveUrlFeed = (res) => {
    const send = (body) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' }); res.end(body); };
    if (urlFeed && Date.now() - urlFeed.at < 300000) return send(urlFeed.body);
    urlFeedWait = urlFeedWait || fetchFeed(updateFeedUrl).then((body) => { urlFeed = { at: Date.now(), body }; return body; }).finally(() => { urlFeedWait = null; });
    // (urlFeed.body yönetici panelinde "en son sürüm" için de kullanılır: feedVersion)
    urlFeedWait.then(send, (e) => {
      if (urlFeed) return send(urlFeed.body); // kaynak geçici olarak yoksa eskisi
      console.error('Güncelleme akışı alınamadı:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'Güncelleme kaynağına ulaşılamadı' }));
    });
  };

  // Sürüm dosyalarını iç kaynaktan (UPDATE_UPSTREAM) aktarır; latest.json bir dakika bellekte tutulur
  let feedCache = null;
  const proxy = (rel, res, isFeed) => {
    const fail = (status, msg) => { if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: msg })); } else res.destroy(); };
    if (!updateUpstream) return fail(404, 'Bulunamadı');
    if (isFeed && feedCache && Date.now() - feedCache.at < 60000) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' });
      return res.end(feedCache.body);
    }
    let target;
    try { target = new URL(updateUpstream.replace(/\/+$/, '') + '/' + rel); } catch { return fail(500, 'UPDATE_UPSTREAM geçersiz'); }
    const lib = target.protocol === 'https:' ? https : http;
    const up = lib.get(target, { timeout: 20000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return fail(r.statusCode === 404 ? 404 : 502, r.statusCode === 404 ? 'Bulunamadı' : 'Güncelleme kaynağına ulaşılamadı'); }
      if (isFeed) {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const body = Buffer.concat(chunks);
          feedCache = { at: Date.now(), body };
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' });
          res.end(body);
        });
        return;
      }
      const name = rel.split('/').pop();
      const headers = { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' };
      if (r.headers['content-length']) headers['Content-Length'] = r.headers['content-length'];
      res.writeHead(200, headers);
      r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => fail(502, 'Güncelleme kaynağına ulaşılamadı'));
    res.on('close', () => up.destroy());
  };

  /** Önbellekteki latest.json'dan en son sürüm (imza burada doğrulanmaz; yalnız panelde "eski sürüm" işareti için) */
  const feedVersion = () => {
    const body = (urlFeed && urlFeed.body) || (feedCache && feedCache.body);
    try { return JSON.parse(Buffer.from(JSON.parse(body.toString('utf8')).payload, 'base64').toString('utf8')).version || null; } catch { return null; }
  };

  const handler = (req, res) => {
    const reply = (status, obj) => {
      if (status >= 500) bump('errors'); else if (status === 401 || status === 403 || status === 429) bump('denied');
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' || req.method === 'HEAD') {
      const htmlHead = (status, extra = {}) => res.writeHead(status, {
        ...extra,
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      });
      const isHome = url.pathname === '/' || url.pathname === '/index.html';
      const isTerms = ['/kosullar', '/gizlilik', '/terms', '/privacy'].includes(url.pathname);
      if (isHome || isTerms) {
        const pl = pageLang(req, url);
        htmlHead(200, { 'Content-Language': pl.lang, Vary: 'Accept-Language, Cookie', ...(pl.cookie ? { 'Set-Cookie': pl.cookie } : {}) });
        const en = pl.lang === 'en';
        return res.end(isHome ? (en ? PAGES.homeEn : PAGES.home) : (en ? PAGES.termsEn : PAGES.terms));
      }
      const st = STATIC.get(url.pathname);
      if (st) {
        res.writeHead(200, { 'Content-Type': st.type, 'Content-Length': st.body.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
        return res.end(req.method === 'HEAD' ? undefined : st.body);
      }
      // Yönetici sayfası izinli adreslerin dışında hiç yokmuş gibi davranır
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        if (!adminSecret || !adminIpOk(req)) return reply(404, { error: 'Bulunamadı' });
        htmlHead(200); return res.end(PAGES.admin);
      }
      if (url.pathname === '/guncelleme/latest.json') { notePing(req); return updateFeedUrl ? serveUrlFeed(res) : proxy('latest/latest.json', res, true); }
      const m = /^\/indir\/(\d+\.\d+\.\d+)\/([\w.-]+)$/.exec(url.pathname);
      if (m && !m[2].startsWith('.')) return proxy(`${m[1]}/${m[2]}`, res, false);
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return reply(404, { error: 'Bulunamadı' });
    bump('requests');
    const minute = Math.floor(Date.now() / 60000);
    perMinute.set(minute, (perMinute.get(minute) || 0) + 1);
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
  handler.flush = flushStats; // kapanırken bekleyen istatistikleri yaz
  return handler;
}

module.exports = { createSyncServer };




if (require.main === module) {
  const port = Number(process.env.PORT) || 3150;
  const host = process.env.HOST || '0.0.0.0';
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const env = process.env;
  const handler = createSyncServer({
    dataDir,
    register: (env.MELID_REGISTER || 'open').toLowerCase(),
    invite: env.MELID_SYNC_INVITE || '',
    adminKey: env.MELID_ADMIN_KEY || '',
    adminIps: env.MELID_ADMIN_IPS || '',
    maxUsers: Number(env.MELID_MAX_USERS) || 1000,
    updateUpstream: env.UPDATE_UPSTREAM || '',
    updateFeedUrl: env.UPDATE_FEED_URL || '',
    trustProxy: /^cloudflare$/i.test(env.TRUST_PROXY || '') ? 'cloudflare' : /^(1|true|yes)$/i.test(env.TRUST_PROXY || ''),
  });
  const tls = process.env.TLS_CERT && process.env.TLS_KEY;
  const srv = tls
    ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handler)
    : http.createServer(handler);
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { try { handler.flush(); } finally { process.exit(0); } });
  srv.listen(port, host, () => {
    console.log(`Melid eşitleme sunucusu: ${tls ? 'https' : 'http'}://${host}:${port}  (veri: ${dataDir})`);
    console.log(`Hesap açma: ${env.MELID_REGISTER || 'open'}; yönetici paneli: ${env.MELID_ADMIN_KEY || env.MELID_SYNC_INVITE ? 'açık (/admin)' : 'kapalı (MELID_ADMIN_KEY yok)'}`);
  });
}
