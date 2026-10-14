'use strict';
// Hesap eşitlemesi: gerçek eşitleme sunucusu (bellek içi port) + iki "cihaz" (ayrı Store). Sunucu gerektirmez.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Store, mergeVaults } = require('../src/main/store');
const { AccountSync, scanLan, normServer } = require('../src/main/sync');
const { createSyncServer } = require('../server/sync-server');

const noKeyring = { available: () => false, encrypt: (s) => s, decrypt: (s) => s };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const device = () => { const st = new Store(tmp('sshdeck-dev-'), noKeyring); return { st, sync: new AccountSync(st, { debounce: 10 }) }; };
const names = (st) => st.sessions.map((s) => s.name).sort().join(',');

(async () => {
  // --- birleştirme kuralları (saf fonksiyon) ---
  const m = mergeVaults(
    { sessions: { a: { id: 'a', name: 'A1', mtime: 5 }, b: { id: 'b', name: 'B', mtime: 1 } }, deleted: {}, settings: { data: { x: 1 }, mtime: 3 } },
    { sessions: { a: { id: 'a', name: 'A2', mtime: 7 }, c: { id: 'c', name: 'C', mtime: 9 } }, deleted: { b: 2, c: 8 }, settings: { data: { x: 2 }, mtime: 4 } }, 10);
  assert.equal(m.sessions.a.name, 'A2', 'yeni düzenleme kazanır');
  assert(!m.sessions.b, 'silme, önceki düzenlemeyi siler');
  assert.equal(m.sessions.c.name, 'C', 'silmeden sonraki düzenleme kalır');
  assert(m.deleted.b && !m.deleted.c);
  assert.equal(m.settings.data.x, 2);
  assert.deepEqual(mergeVaults(m, m, 10), m);
  assert(!mergeVaults(m, m).deleted.b, '180 günden eski silme kaydı atılır');
  console.log('OK birleştirme kuralları');

  const dataDir = tmp('sshdeck-srv-');
  const srv = http.createServer(createSyncServer({ dataDir, invite: 'davet-123' }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const server = `127.0.0.1:${srv.address().port}`;

  // --- cihaz A: hesap aç, oturumları yükle ---
  const A = device();
  A.st.saveSession({ name: 'web', host: 'web.example', username: 'root', password: 'cokgizli-1' });
  A.st.saveSettings({ fontSize: 17, paneSplit: 30 });
  await assert.rejects(A.sync.register({ server, user: 'samed', password: 'hesapParola', invite: 'yanlis' }), /Davet kodu yanlış/);
  await A.sync.register({ server, user: 'Samed', password: 'hesapParola', invite: 'davet-123' });
  assert.equal(A.sync.status().user, 'samed');
  assert.equal(A.sync.status().version, 1);

  // Sunucu diskinde düz metin parola, oturum adı veya hesap parolası olmamalı
  const onDisk = fs.readdirSync(path.join(dataDir, 'vaults')).map((f) => fs.readFileSync(path.join(dataDir, 'vaults', f), 'utf8')).join('')
    + fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8');
  for (const secret of ['cokgizli-1', 'web.example', 'hesapParola']) assert(!onDisk.includes(secret), `sunucuda düz metin: ${secret}`);
  console.log('OK hesap açma, sunucuda yalnız şifreli veri');

  // --- cihaz B: yanlış parola, sonra doğru giriş; kendi oturumu da birleşir ---
  const B = device();
  B.st.saveSession({ name: 'db', host: 'db.example', username: 'pg' });
  B.st.saveSettings({ paneSplit: 70 });
  await assert.rejects(B.sync.login({ server, user: 'samed', password: 'yanlis' }), /parola yanlış/);
  await assert.rejects(B.sync.login({ server, user: 'yok', password: 'x' }), /parola yanlış/);
  await B.sync.login({ server, user: 'samed', password: 'hesapParola' });
  assert.equal(names(B.st), 'db,web');
  const web = B.st.sessions.find((s) => s.name === 'web');
  assert.equal(B.st.getSession(web.id).password, 'cokgizli-1', 'parola diğer cihaza geldi');
  assert.equal(B.st.settings.fontSize, 17, 'ayar geldi');
  assert.equal(B.st.settings.paneSplit, 70, 'cihaza özgü ayar korunur');
  await A.sync.syncNow();
  assert.equal(names(A.st), 'db,web');
  assert.equal(A.st.settings.paneSplit, 30);
  console.log('OK ikinci cihazda giriş + birleştirme');

  // --- değişiklik, silme, aynı anda düzenleme ---
  const dbId = A.st.sessions.find((s) => s.name === 'db').id;
  A.st.deleteSession(dbId);
  B.st.saveSession({ id: web.id, name: 'web-prod' });
  await A.sync.syncNow();
  await B.sync.syncNow();
  await A.sync.syncNow();
  assert.equal(names(A.st), 'web-prod');
  assert.equal(names(B.st), 'web-prod');
  assert.equal(A.st.getSession(web.id).password, 'cokgizli-1');
  console.log('OK silme ve düzenleme iki yöne');

  // Çakışma (409): iki cihaz aynı sürümden yükler
  A.st.saveSession({ name: 'a-yeni', host: 'a' });
  B.st.saveSession({ name: 'b-yeni', host: 'b' });
  await Promise.all([A.sync.syncNow(), B.sync.syncNow()]);
  await A.sync.syncNow();
  assert.equal(names(A.st), 'a-yeni,b-yeni,web-prod');
  assert.equal(names(B.st), 'a-yeni,b-yeni,web-prod');
  console.log('OK eşzamanlı değişiklik (sürüm çakışması) birleşir');

  // onChange -> otomatik eşitleme
  A.sync.start();
  const tSave = Date.now();
  A.st.saveSession({ name: 'oto', host: 'o' });
  // süreye değil sonuca bağlı: kayıttan sonra başlayan bir eşitleme bitene kadar (en çok 10 sn)
  for (let i = 0; i < 500 && !(A.sync.status().lastSync > tSave && !A.sync.running && !A.sync.timer); i++) await new Promise((r) => setTimeout(r, 20));
  assert(A.sync.status().lastSync > tSave, 'otomatik eşitleme çalışmadı');
  A.sync.stop();
  await B.sync.syncNow();
  assert(names(B.st).includes('oto'));
  console.log('OK değişiklikten sonra otomatik eşitleme');

  // --- ana parola kilitliyken eşitleme bekler ---
  B.st.setMasterPassword(null, 'yerelAna');
  const B2 = new AccountSync(new Store(B.st.dir, noKeyring));
  await B2.syncNow();
  assert.equal(B2.state, 'locked');
  B2.store.unlock('yerelAna');
  await B2.syncNow();
  assert.equal(B2.state, 'ok');
  B2.store.setMasterPassword('yerelAna', 'yeniAna'); // hesap jetonu/kasa anahtarı da yeniden şifrelenmeli
  const B3 = new AccountSync(new Store(B.st.dir, noKeyring));
  B3.store.unlock('yeniAna');
  await B3.syncNow();
  assert.equal(B3.state, 'ok');
  console.log('OK ana parola kilitliyken bekler, açılınca eşitler');

  // --- parola değişimi: eski parola artık çalışmaz, diğer cihazın oturumu kapanır ---
  await assert.rejects(A.sync.changePassword('yanlis', 'yeniParola'), /Mevcut parola yanlış/);
  await A.sync.changePassword('hesapParola', 'yeniParola');
  await assert.rejects(B.sync.syncNow(), /tekrar giriş/);
  assert.equal(B.sync.state, 'auth');
  const C = device();
  await assert.rejects(C.sync.login({ server, user: 'samed', password: 'hesapParola' }), /parola yanlış/);
  await C.sync.login({ server, user: 'samed', password: 'yeniParola' });
  assert.equal(names(C.st), 'a-yeni,b-yeni,oto,web-prod');
  await A.sync.syncNow(); // A'nın jetonu geçerli kalır
  console.log('OK parola değişimi');

  // --- çıkış: yerel veriler kalır, jeton sunucuda iptal ---
  const tok = C.sync._token();
  await C.sync.logout();
  assert.equal(C.sync.status().loggedIn, false);
  assert.equal(names(C.st), 'a-yeni,b-yeni,oto,web-prod');
  const r = await fetch(`http://${server}/api/vault`, { headers: { Authorization: 'Bearer ' + tok } });
  assert.equal(r.status, 401);
  console.log('OK çıkış');

  // --- ana sayfa + davet koduyla istatistik ---
  const page = await fetch(`http://${server}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await page.text(), /Davet kodu/);
  const stats = (invite) => fetch(`http://${server}/api/stats`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite }) });
  assert.equal((await stats('yanlis')).status, 403);
  const D = new AccountSync(new Store(tmp('sshdeck-dev-'), noKeyring), { client: 'SSHDeck test linux' });
  await D.login({ server, user: 'samed', password: 'yeniParola' });
  const st = await (await stats('davet-123')).json();
  assert.equal(st.totals.users, 1);
  const u = st.users[0];
  assert.equal(u.user, 'samed');
  assert(u.version >= 1 && u.size > 0 && u.updated > 0);
  assert(u.devices.some((d) => d.client === 'SSHDeck test linux'), 'istemci adı kaydedildi');
  assert(st.totals.syncs > 0 && st.totals.failedLogins > 0);
  assert(!JSON.stringify(st).includes('web-prod'), 'istatistikte kasa içeriği yok');
  // Davet kodu boş sunucuda istatistik kapalı
  const closed = http.createServer(createSyncServer({ dataDir: tmp('sshdeck-srv-') }));
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  assert.equal((await fetch(`http://127.0.0.1:${closed.address().port}/api/stats`, { method: 'POST', body: '{"invite":""}' })).status, 403);
  console.log('OK ana sayfa ve istatistikler (davet koduyla)');

  // --- yerel ağ taraması: portu açık olan SSHDeck sunucusu bulunur, başka hizmet ve kapalı adres atlanır ---
  const port = srv.address().port;
  const other = http.createServer((q, s2) => s2.end('{"app":"baska"}'));
  await new Promise((r) => other.listen(port, '127.0.0.2', r)); // aynı portta SSHDeck olmayan hizmet
  const found = await scanLan({ port, targets: ['127.0.0.3', '127.0.0.2', '127.0.0.1', '127.0.0.4'], timeout: 500 });
  assert.deepEqual(found, [{ server: `http://127.0.0.1:${port}`, host: '127.0.0.1', register: true }]);
  assert.equal(normServer('192.168.1.50'), 'http://192.168.1.50:3150', 'portsuz adrese varsayılan port');
  assert.equal(normServer('https://senkron.ornek.com'), 'https://senkron.ornek.com');
  other.close(); closed.close();
  console.log('OK yerel ağ taraması');

  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
