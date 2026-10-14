'use strict';
// updater.js: sürüm karşılaştırma, imzalı latest.json, indirme + sha256 doğrulama (yerel HTTP sunucusu)
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const u = require('../src/main/updater');

(async () => {
  const c = u.compareVersions;
  assert.equal(c('1.0.1', '1.0.0'), 1);
  assert.equal(c('1.0.0', '1.0.0'), 0);
  assert.equal(c('1.2.10', '1.2.9'), 1);
  assert.equal(c('v2.0.0', '1.99.99'), 1);
  assert.equal(c('1.1.0-beta', '1.1.0'), -1);
  assert.equal(c('1.1.0', '1.0.9-beta'), 1);
  console.log('OK compareVersions');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const data = Buffer.from('SSHDeck güncelleme deneme dosyası\n'.repeat(5000));
  const info = {
    app: 'sshdeck', version: '9.9.9', date: '2026-10-09T10:00:00Z', notes: '- yeni şey',
    files: { 'linux-appimage': { name: 'a.AppImage', url: '', sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length } },
  };
  const feed = u.signFeed(info, pem);
  assert.deepEqual(u.parseFeed(feed, pub), info);
  // gömülü (gerçek) açık anahtarla bu imza geçmemeli
  assert.throws(() => u.parseFeed(feed), /imzası geçersiz/);
  const tampered = JSON.parse(feed);
  tampered.payload = Buffer.from(JSON.stringify({ ...info, version: '10.0.0' })).toString('base64');
  assert.throws(() => u.parseFeed(JSON.stringify(tampered), pub), /imzası geçersiz/);
  assert.throws(() => u.parseFeed('<html>', pub), /okunamadı/);
  console.log('OK signed feed');

  let served = feed; let fileBody = data;
  const srv = http.createServer((req, res) => {
    if (req.url === '/latest.json') { if (!served) { res.statusCode = 404; return res.end('yok'); } return res.end(served); }
    if (req.url === '/a.AppImage') return res.end(fileBody);
    res.statusCode = 404; res.end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  info.files['linux-appimage'].url = base + '/a.AppImage';
  served = u.signFeed(info, pem);

  let r = await u.check('1.0.0', { url: base + '/latest.json', pubKey: pub });
  assert.equal(r.newer, true); assert.equal(r.info.version, '9.9.9');
  r = await u.check('9.9.9', { url: base + '/latest.json', pubKey: pub });
  assert.equal(r.newer, false);
  served = null;
  r = await u.check('1.0.0', { url: base + '/latest.json', pubKey: pub });
  assert.deepEqual(r, { info: null, newer: false });
  const closed = http.createServer().listen(0, '127.0.0.1');
  await new Promise((rr) => closed.once('listening', rr));
  const deadPort = closed.address().port; closed.close();
  await assert.rejects(u.check('1.0.0', { url: `http://127.0.0.1:${deadPort}/latest.json`, pubKey: pub }), /ulaşılamadı/);
  console.log('OK check');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-upd-'));
  const prog = [];
  const out = await u.download(info.files['linux-appimage'], path.join(dir, 'a.AppImage'), { onProgress: (d, t) => prog.push([d, t]) });
  assert(fs.readFileSync(out).equals(data));
  assert.deepEqual(prog[prog.length - 1], [data.length, data.length]);
  fileBody = Buffer.concat([data.subarray(0, 10), Buffer.from('X'), data.subarray(11)]); // aynı boyut, farklı içerik
  await assert.rejects(u.download(info.files['linux-appimage'], path.join(dir, 'b.AppImage')), /doğrulanamadı/);
  assert(!fs.existsSync(path.join(dir, 'b.AppImage')) && !fs.existsSync(path.join(dir, 'b.AppImage.part')));
  fs.rmSync(dir, { recursive: true, force: true });
  srv.close();
  console.log('OK download + sha256');

  // pacman ilerleme çıktısı (gerçek `LC_ALL=C script -qfec "pacman -U ..."` çıktısı; \r ile güncellenen satırlar)
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'pacman-progress.txt')).toString('utf8')
    + ':: Running post-transaction hooks...\r\n(1/2) Arming ConditionNeedsUpdate...\r\n';
  const seen = [];
  const feedPacman = u.pacmanProgressParser((p) => seen.push(p));
  for (let i = 0; i < raw.length;) { const n = 1 + Math.floor(Math.random() * 40); feedPacman(Buffer.from(raw.slice(i, i + n))); i += n; }
  const pcts = seen.map((p) => p.percent);
  assert.deepEqual([...new Set(seen.map((p) => p.step))], ['Anahtarlar denetleniyor', 'Paket bütünlüğü denetleniyor', 'Paket dosyaları yükleniyor', 'Dosya çakışmaları denetleniyor', 'Kuruluyor', 'Son işlemler']);
  assert(pcts.every((x, i) => i === 0 || x >= pcts[i - 1]), 'yüzde geri gitmez: ' + pcts.join(','));
  assert(pcts.includes(95) && pcts.at(-1) === 97, pcts.join(','));
  assert(pcts.some((x) => x > 10 && x < 95), 'kurulum sırasında ara yüzde');
  console.log('OK pacman ilerleme ayrıştırma');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
