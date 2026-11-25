'use strict';
// Güncelleme denetimi ve indirme (Electron'dan bağımsız; test/updater.test.js düz Node ile test eder).
// Kaynak: CI'ın (.github/workflows/derle.yml) her vX.Y.Z sürümünde GitHub Releases'a koyduğu latest.json; eşitleme
// sunucusu (server/sync-server.js, UPDATE_FEED_URL) /guncelleme/latest.json olarak sunar. Dosyalar GitHub'dan iner:
//   { "payload": base64(JSON), "sig": base64(Ed25519 imzası, payload baytları üzerinde) }
//   JSON = { app, version, date, notes, files: { <tür>: { name, url, sha256, size } } }
// İmza CI secret'ı UPDATE_SIGNING_KEY ile atılır; açık anahtar aşağıda gömülü. Dosyalar sha256 ile doğrulanır.
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');

// MELID_UPDATE_URL: deneme için başka bir kaynak (imza yine gömülü anahtarla doğrulanır)
const FEED_URL = process.env.MELID_UPDATE_URL || 'https://melid.abdulsamed.net/guncelleme/latest.json';
// Ed25519 açık anahtarı (ham 32 bayt, base64) — Android'de de aynısı (Updater.java)
const PUBLIC_KEY = 'JZZUOZm0s+7S9kpAprN5IKx+6fMm07tbSeq5jkCy2Fo=';

const KIND_LABELS = {
  'win-setup': 'Windows kurulumu',
  'win-portable': 'Windows taşınabilir',
  'linux-appimage': 'AppImage',
  'linux-pacman': 'pacman paketi',
  android: 'Android',
};

/** "1.2.10" > "1.2.9"; ön sürüm eki (1.2.0-beta) yok sayılmaz: aynı çekirdekte eksiz olan büyüktür. */
function compareVersions(a, b) {
  const p = (v) => { const [core, pre] = String(v).replace(/^v/, '').split('-'); return { n: core.split('.').map((x) => Number(x) || 0), pre: pre || '' }; };
  const x = p(a); const y = p(b);
  for (let i = 0; i < 3; i++) { const d = (x.n[i] || 0) - (y.n[i] || 0); if (d) return Math.sign(d); }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function publicKeyObject(b64 = PUBLIC_KEY) {
  // SPKI başlığı (Ed25519) + ham anahtar
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(b64, 'base64')]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** latest.json metnini doğrular ve içeriği döndürür; imza geçersizse hata. */
function parseFeed(text, pubKey = PUBLIC_KEY) {
  let outer;
  try { outer = JSON.parse(text); } catch { throw new Error('Güncelleme bilgisi okunamadı'); }
  if (!outer || typeof outer.payload !== 'string' || typeof outer.sig !== 'string') throw new Error('Güncelleme bilgisi okunamadı');
  const payload = Buffer.from(outer.payload, 'base64');
  const ok = crypto.verify(null, payload, publicKeyObject(pubKey), Buffer.from(outer.sig, 'base64'));
  if (!ok) throw new Error('Güncelleme bilgisinin imzası geçersiz');
  const info = JSON.parse(payload.toString('utf8'));
  if (info.app !== 'melid' || !info.version || !info.files) throw new Error('Güncelleme bilgisi okunamadı');
  return info;
}

/** CI tarafı: içeriği imzalayıp latest.json metnini üretir. */
function signFeed(info, privateKeyPem) {
  const payload = Buffer.from(JSON.stringify(info), 'utf8');
  const sig = crypto.sign(null, payload, crypto.createPrivateKey(privateKeyPem));
  return JSON.stringify({ payload: payload.toString('base64'), sig: sig.toString('base64') });
}

function friendlyNetError(e) {
  const c = e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.code || '';
  if (e?.name === 'TimeoutError' || c === 'UND_ERR_CONNECT_TIMEOUT' || c === 'ETIMEDOUT') return 'Güncelleme sunucusu yanıt vermedi';
  if (c === 'ECONNREFUSED' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'Güncelleme sunucusuna ulaşılamadı (internet bağlantınızı denetleyin)';
  return e?.message || String(e);
}

/** Akıştaki son sürümü getirir. { info, newer } — sunucuda henüz sürüm yoksa info null. */
async function check(currentVersion, { url = FEED_URL, pubKey = PUBLIC_KEY, timeout = 15000 } = {}) {
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(timeout), cache: 'no-store' }); } catch (e) { throw new Error(friendlyNetError(e)); }
  if (res.status === 404) return { info: null, newer: false };
  if (!res.ok) throw new Error(`Güncelleme sunucusu hata verdi (HTTP ${res.status})`);
  const info = parseFeed(await res.text(), pubKey);
  return { info, newer: compareVersions(info.version, currentVersion) > 0 };
}

/** Dosyayı indirir, boyut ve sha256'yı doğrular. onProgress(done, total). signal ile iptal edilebilir. */
async function download(file, dest, { onProgress, signal } = {}) {
  let res;
  try { res = await fetch(file.url, { signal }); } catch (e) { if (signal?.aborted) throw new Error('İptal edildi'); throw new Error(friendlyNetError(e)); }
  if (!res.ok) throw new Error(`İndirme başarısız (HTTP ${res.status})`);
  const total = file.size || Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let done = 0; let last = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (onProgress && now - last > 200) { last = now; onProgress(done, total); }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    if (signal?.aborted) throw new Error('İptal edildi');
    throw new Error(friendlyNetError(e));
  }
  if (onProgress) onProgress(done, total);
  if ((file.size && done !== file.size) || hash.digest('hex') !== String(file.sha256).toLowerCase()) {
    await fsp.rm(tmp, { force: true });
    throw new Error('İndirilen dosya doğrulanamadı (bozuk ya da değiştirilmiş)');
  }
  await fsp.rename(tmp, dest);
  return dest;
}

// ---- kurulum ilerlemesi ----
// pacman ilerleme çubuğunu yalnız terminale yazar: `script` ile sanal terminalde, LC_ALL=C ile (İngilizce, ayrıştırılabilir)
// çalıştırılır. Satırlar: "(1/1) installing melid   [####---]  45%" ve ":: Running post-transaction hooks...".
// Genel yüzde: ön denetimler 0-10, kurulum 10-95, kancalar 95-99.
const PACMAN_STEPS = [
  [/checking keys/, 'Anahtarlar denetleniyor', 0, 2],
  [/checking package integrity/, 'Paket bütünlüğü denetleniyor', 2, 5],
  [/loading package files/, 'Paket dosyaları yükleniyor', 5, 8],
  [/checking for file conflicts|checking available disk space/, 'Dosya çakışmaları denetleniyor', 8, 10],
  [/(?:upgrading|installing|reinstalling|downgrading) /, 'Kuruluyor', 10, 95],
];
function pacmanProgressParser(onProgress) {
  let buf = '';
  let lastPct = -1; let lastStep = '';
  const emit = (step, pct) => { if (pct !== lastPct || step !== lastStep) { lastPct = pct; lastStep = step; onProgress({ step, percent: pct }); } };
  return (chunk) => {
    buf += chunk.toString('utf8');
    const parts = buf.split(/[\r\n]/);
    buf = parts.pop();
    for (const raw of parts) {
      const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
      if (!line) continue;
      if (/^:: Running post-transaction hooks/.test(line)) { emit('Son işlemler', 97); continue; }
      const m = /^\(\d+\/\d+\)\s+(.+?)\s+\[[#\-o c]*\]\s+(\d+)%$/.exec(line);
      if (!m) continue;
      const st = PACMAN_STEPS.find(([re]) => re.test(m[1]));
      if (!st) continue;
      const [, label, from, to] = st;
      emit(label, Math.round(from + ((to - from) * Math.min(100, Number(m[2]))) / 100));
    }
  };
}

/**
 * pacman -U ile kurar, ilerlemeyi bildirir. prefix: önüne eklenecek komut (pkexec yolu); script yoksa ilerlemesiz.
 * -> çıkış kodu (126/127: pkexec izin vermedi). extraArgs yalnız testte (sahte kök dizin).
 */
function installPacman(file, { prefix = [], onProgress = () => {}, extraArgs = [], spawnImpl = require('child_process').spawn } = {}) {
  const scriptBin = ['/usr/bin/script', '/bin/script'].find((p) => fs.existsSync(p));
  const shq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  const pacmanCmd = ['/usr/bin/pacman', '-U', '--noconfirm', ...extraArgs, file];
  const argv = scriptBin
    ? [...prefix, '/usr/bin/env', 'LC_ALL=C', scriptBin, '-qfec', pacmanCmd.map(shq).join(' '), '/dev/null']
    : [...prefix, ...pacmanCmd];
  onProgress({ step: prefix.length ? 'Yönetici izni bekleniyor…' : 'Kuruluyor', percent: null });
  return new Promise((resolve) => {
    const p = spawnImpl(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    if (scriptBin) {
      const parse = pacmanProgressParser(onProgress);
      p.stdout.on('data', parse);
    } else p.stdout.resume();
    p.stderr.resume();
    p.on('error', () => resolve(-1));
    p.on('exit', (code) => resolve(code));
  });
}

/** Dosyayı ilerlemeyle kopyalar (AppImage yerine yazılmadan önce). onProgress(yüzde) */
async function copyWithProgress(src, dst, onProgress) {
  const total = (await fsp.stat(src)).size;
  let done = 0; let last = -1;
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src, { highWaterMark: 1024 * 1024 });
    const ws = fs.createWriteStream(dst);
    rs.on('data', (c) => { done += c.length; const pct = total ? Math.floor((100 * done) / total) : 100; if (pct !== last) { last = pct; onProgress(pct); } });
    rs.on('error', reject); ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
}

module.exports = { FEED_URL, PUBLIC_KEY, KIND_LABELS, compareVersions, parseFeed, signFeed, check, download, pacmanProgressParser, installPacman, copyWithProgress };
