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
const device = () => { const st = new Store(tmp('melid-dev-'), noKeyring); return { st, sync: new AccountSync(st, { debounce: 10 }) }; };
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

  const dataDir = tmp('melid-srv-');
  const srvHandler = createSyncServer({ dataDir, invite: 'davet-123' });
  const srv = http.createServer(srvHandler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const server = `127.0.0.1:${srv.address().port}`;

  // --- cihaz A: hesap aç, oturumları yükle ---
  const A = device();
  A.st.saveSession({ name: 'web', host: 'web.example', username: 'root', password: 'cokgizli-1' });
  A.st.saveSettings({ fontSize: 17, paneSplit: 30 });
  await assert.rejects(A.sync.register({ server, user: 'samed', email: 'samed@ornek.com', password: 'hesapParola', invite: 'yanlis' }), /Davet kodu yanlış/);
  await assert.rejects(A.sync.register({ server, user: 'samed', email: 'samed@ornek.com', password: 'hesapParola' }), /davet kodu gerekli/);
  await assert.rejects(A.sync.register({ server, user: 'samed', password: 'hesapParola', invite: 'davet-123' }), /E-posta adresi gerekli/);
  await A.sync.register({ server, user: 'Samed', email: ' Samed@Ornek.com ', password: 'hesapParola', invite: 'davet-123' });
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
  // Hangisinin önce yazacağı belli değil: 409 alan birleştirip yükler, önce yazan ötekinin değişikliğini sonraki eşitlemede alır
  await A.sync.syncNow();
  await B.sync.syncNow();
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
  assert.match(await page.text(), /Tüm sunucularınız tek pencerede/);
  const adminPage = await fetch(`http://${server}/admin`);
  assert.equal(adminPage.status, 200, 'yerel adresten yönetici sayfası açılır');
  assert.match(await adminPage.text(), /Yönetici girişi/);
  const stats = (key) => fetch(`http://${server}/api/admin/stats`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  assert.equal((await stats('yanlis')).status, 403);
  const D = new AccountSync(new Store(tmp('melid-dev-'), noKeyring), { client: 'Melid test linux' });
  await D.login({ server, user: 'samed', password: 'yeniParola' });
  const st = await (await stats('davet-123')).json();
  assert.equal(st.totals.users, 1);
  const u = st.users[0];
  assert.equal(u.user, 'samed');
  assert.equal(u.email, 'samed@ornek.com', 'e-posta yönetici panelinde');
  assert(u.version >= 1 && u.size > 0 && u.updated > 0);
  assert(u.devices.some((d) => d.client === 'Melid test linux'), 'istemci adı kaydedildi');
  assert(st.lifetime.syncs > 0 && st.lifetime.failedLogins > 0, 'kalıcı toplamlar');
  assert.equal(st.days.length, 30);
  const today = st.days[29];
  assert(today.activeUsers >= 1 && today.syncs > 0 && today.logins > 0 && today.registrations === 1, 'bugünün sayaçları');
  assert(st.server.rss > 0 && st.server.memTotal > 0 && Array.isArray(st.rpm) && st.rpm.length === 60);
  assert(st.online.some((x) => x.user === 'samed'), 'çevrimiçi cihazlar');
  // sayaçlar dosyaya yazılır (sunucu yeniden başlayınca korunur)
  srvHandler.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats.json'), 'utf8'));
  assert(saved.totals.syncs > 0 && saved.days[today.date].users.includes('samed'));
  assert(!JSON.stringify(st).includes('web-prod'), 'istatistikte kasa içeriği yok');
  // Yönetici parolası olmayan sunucuda panel yok
  const closed = http.createServer(createSyncServer({ dataDir: tmp('melid-srv-') }));
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  assert.equal((await fetch(`http://127.0.0.1:${closed.address().port}/api/admin/stats`, { method: 'POST', body: '{"key":""}' })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${closed.address().port}/admin`)).status, 404);
  console.log('OK ana sayfa ve yönetici paneli');

  // --- SSH anahtarları: yalnız "anahtarları eşitle" açık cihazlar gönderir/alır; kapalı cihaz kasadakilere dokunmaz ---
  const { generateKey } = require('../src/main/keys');
  const keyDev = async (sshDir, on) => {
    const st = new Store(tmp('melid-dev-'), noKeyring);
    st.sshDir = sshDir || null;
    const sync = new AccountSync(st, { debounce: 10 });
    st.setSyncKeys(on);
    await sync.login({ server, user: 'samed', password: 'yeniParola' });
    return { st, sync };
  };
  const sshDir = tmp('melid-ssh-');
  const gk = generateKey(sshDir, { name: 'id_test', type: 'ed25519', comment: 'k1' });
  const K1 = await keyDev(sshDir, true);
  const sid = K1.st.saveSession({ name: 'anahtarli', host: 'k.example', authType: 'key', keyPath: gk.privatePath });
  assert.equal(K1.st.sessions.find((x) => x.id === sid).keyFp, gk.fingerprint, 'oturuma anahtarın parmak izi yazılır');
  await K1.sync.syncNow();
  const K3 = await keyDev(null, false);
  await K3.sync.syncNow();
  assert.equal(K3.st.keys.length, 0, 'anahtar eşitlemesi kapalı cihaza anahtar gelmez');
  assert.equal(K3.st.sessions.find((x) => x.id === sid).keyFp, gk.fingerprint, 'oturumun parmak izi her cihaza gider');
  const K2 = await keyDev(null, true);
  assert.equal(K2.st.syncedKey(gk.fingerprint).private, fs.readFileSync(gk.privatePath, 'utf8'), 'anahtar diğer cihaza geldi (kapalı cihaz kasadan silmedi)');
  assert.equal(K2.st.publicSyncedKeys()[0].name, 'id_test');
  // Kasa sunucuda şifreli: özel anahtar düz görünmez
  const vaultFile = fs.readdirSync(path.join(dataDir, 'vaults')).map((f) => fs.readFileSync(path.join(dataDir, 'vaults', f), 'utf8')).join();
  assert(!vaultFile.includes('OPENSSH PRIVATE KEY'), 'sunucuda özel anahtar düz yok');
  // Hesaptan silme: diğer cihazdan da kalkar, ~/.ssh'deki dosya geri yüklemez
  K2.st.deleteSyncedKey(gk.fingerprint);
  await K2.sync.syncNow();
  await K1.sync.syncNow();
  assert.equal(K1.st.keys.length, 0, 'silinen anahtar diğer cihazdan kalktı');
  assert(fs.existsSync(gk.privatePath), '~/.ssh dosyasına dokunulmaz');
  await K2.sync.syncNow();
  assert.equal(K2.st.keys.length, 0, '~/.ssh\'deki kopya silineni geri getirmez');
  const km = mergeVaults({ sessions: {}, deleted: { f: 5, h: 5 }, keys: { f: { name: 'x', mtime: 4 }, g: { name: 'g', mtime: 9 }, h: { name: 'h', mtime: 3 } } }, { sessions: {}, deleted: { g: 8 }, keys: { f: { name: 'x', mtime: 6 } } }, 10);
  assert.deepEqual(Object.keys(km.keys).sort(), ['f', 'g'], 'silme eski anahtarı kaldırır, sonradan değişeni bırakır');
  assert.deepEqual(km.deleted, { h: 5 });
  console.log('OK SSH anahtarı eşitlemesi');

  // --- hazır komutlar komut başına birleşir: iki cihazda aynı anda eklenenler kaybolmaz, silme geçer ---
  const snipNames = (st) => (st.settings.snippets || []).map((x) => x.name).sort().join(',');
  await K1.sync.syncNow(); await K2.sync.syncNow();
  const base = K1.st.settings.snippets || [];
  K1.st.saveSettings({ snippets: [...base, { id: 'x1', name: 'bir', command: 'echo 1' }] });
  K2.st.saveSettings({ snippets: [...(K2.st.settings.snippets || []), { id: 'x2', name: 'iki', command: 'echo 2' }], fontSize: 19 });
  await K1.sync.syncNow(); await K2.sync.syncNow(); await K1.sync.syncNow();
  assert(snipNames(K1.st).includes('bir') && snipNames(K1.st).includes('iki'), 'K1 iki komutu da görür: ' + snipNames(K1.st));
  assert.equal(snipNames(K2.st), snipNames(K1.st), 'iki cihazda aynı liste');
  assert.equal(K1.st.settings.fontSize, 19, 'diğer ayarlar bütün olarak eşitlenmeye devam eder');
  K2.st.saveSettings({ snippets: K2.st.settings.snippets.filter((x) => x.id !== 'x1') });
  K1.st.saveSettings({ snippets: K1.st.settings.snippets.map((x) => (x.id === 'x2' ? { ...x, command: 'echo iki' } : x)) });
  await K2.sync.syncNow(); await K1.sync.syncNow(); await K2.sync.syncNow();
  assert(!snipNames(K1.st).includes('bir'), 'silinen komut diğer cihazdan da kalktı');
  assert.equal(K2.st.settings.snippets.find((x) => x.id === 'x2').command, 'echo iki', 'aynı anda yapılan düzenleme de geçti');
  // eski kasa (komut haritası yok) okunabilir
  const old = mergeVaults({ sessions: {}, deleted: {}, settings: { data: { snippets: [{ id: 'o', name: 'eski' }] }, mtime: 5 } }, null, 10);
  assert.deepEqual(old.snippets, { o: { id: 'o', name: 'eski', mtime: 5 } });
  console.log('OK hazır komutlar komut başına birleşir');

  // --- kurtarma anahtarı: parolası unutulan hesap kod ile yeni parolaya geçer, kasa korunur ---
  await assert.rejects(K1.sync.createRecovery('yanlis'), /Hesap parolası yanlış/);
  const rc = await K1.sync.createRecovery('yeniParola');
  assert.match(rc.code, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  assert.equal((await K1.sync.info()).recovery, rc.created);
  const usersFile = fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8');
  assert(!usersFile.includes(rc.code.replace(/-/g, '')), 'sunucuda kod düz durmaz');
  const R = { st: new Store(tmp('melid-dev-'), noKeyring) }; R.sync = new AccountSync(R.st);
  await assert.rejects(R.sync.recover({ server, user: 'samed', code: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', password: 'kurtarildi-1' }), /kurtarma anahtarı yanlış/);
  await R.sync.recover({ server, user: 'samed', code: rc.code.toLowerCase().replace(/-/g, ' '), password: 'kurtarildi-1' });
  assert(R.st.sessions.some((x) => x.name === 'anahtarli'), 'kurtarılan hesapta oturumlar yerinde');
  await assert.rejects(K1.sync.syncNow(), /tekrar giriş/, 'kurtarmadan sonra eski oturumlar kapanır');
  const R2 = device();
  await assert.rejects(R2.sync.login({ server, user: 'samed', password: 'yeniParola' }), /parola yanlış/);
  await R2.sync.login({ server, user: 'samed', password: 'kurtarildi-1' });
  assert.equal((await R2.sync.info()).recovery, rc.created, 'kurtarma anahtarı geçerli kalır (kasa anahtarı aynı)');
  const st2 = await (await stats('davet-123')).json();
  assert.equal(st2.users[0].recovery, true);
  await R2.sync.removeRecovery('kurtarildi-1');
  assert.equal((await R2.sync.info()).recovery, null);
  console.log('OK kurtarma anahtarı');

  // --- yerel ağ taraması: portu açık olan Melid sunucusu bulunur, başka hizmet ve kapalı adres atlanır ---
  const port = srv.address().port;
  const other = http.createServer((q, s2) => s2.end('{"app":"baska"}'));
  await new Promise((r) => other.listen(port, '127.0.0.2', r)); // aynı portta Melid olmayan hizmet
  const found = await scanLan({ port, targets: ['127.0.0.3', '127.0.0.2', '127.0.0.1', '127.0.0.4'], timeout: 500 });
  assert.deepEqual(found, [{ server: `http://127.0.0.1:${port}`, host: '127.0.0.1', register: true }]);
  assert.equal(normServer('192.168.1.50'), 'http://192.168.1.50:3150', 'portsuz adrese varsayılan port');
  assert.equal(normServer('https://senkron.ornek.com'), 'https://senkron.ornek.com');
  assert.equal(normServer('melid.abdulsamed.net'), 'https://melid.abdulsamed.net', 'alan adı: https');
  assert.equal(normServer('senkron.ornek.com:8443'), 'https://senkron.ornek.com:8443');
  assert.equal(normServer('nas'), 'http://nas:3150', 'tek parçalı ad yerel');
  assert.equal(normServer('nas.local'), 'http://nas.local:3150');
  assert.equal(normServer('nas.lan:4000'), 'http://nas.lan:4000');
  other.close(); closed.close();
  console.log('OK yerel ağ taraması');

  srv.close();

  // --- herkese açık kayıt, e-posta, hesap silme, IP sınırı, yönetici IP'si (vekil arkasında), güncelleme aktarımı ---
  const upstream = http.createServer((q, s2) => {
    if (q.url === '/melid/latest/latest.json') return s2.end('{"payload":"e30=","sig":"x"}');
    if (q.url === '/melid/1.2.3/Melid-1.2.3.apk') { s2.writeHead(200, { 'Content-Length': 5 }); return s2.end('APK!!'); }
    s2.writeHead(404); s2.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const openDir = tmp('melid-srv-');
  const pub = http.createServer(createSyncServer({
    dataDir: openDir, register: 'open', adminKey: 'yonetici-parolasi', adminIps: '203.0.113.7, 2001:db8::/48', trustProxy: 'cloudflare',
    updateUpstream: `http://127.0.0.1:${upstream.address().port}/melid/`,
  }));
  await new Promise((r) => pub.listen(0, '127.0.0.1', r));
  const P = `127.0.0.1:${pub.address().port}`;
  const info = await (await fetch(`http://${P}/api/info`)).json();
  assert.equal(info.register, true); assert.equal(info.invite, false);
  const O = device();
  O.st.saveSession({ name: 'acik', host: 'acik.example' });
  await assert.rejects(O.sync.register({ server: P, user: 'ali', email: 'gecersiz', password: 'aliParola123' }), /E-posta adresi geçersiz/);
  await O.sync.register({ server: P, user: 'ali', email: 'ali@ornek.com', password: 'aliParola123' });
  assert.equal((await O.sync.info()).email, 'ali@ornek.com');
  await O.sync.setEmail('yeni@ornek.com');
  assert.equal((await O.sync.info()).email, 'yeni@ornek.com');
  // aynı IP'den günde en fazla 5 hesap (vekil arkasında CF-Connecting-IP'ye göre)
  // Traefik, Cloudflare kenar sunucusunun adresini X-Forwarded-For'un sonuna ekler; gerçek istemci CF-Connecting-IP'de
  const CF_EDGE = '188.114.96.5';
  const viaCf = (ip) => ({ 'X-Forwarded-For': CF_EDGE, 'CF-Connecting-IP': ip });
  const reg = (user, ip) => fetch(`http://${P}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...viaCf(ip) },
    body: JSON.stringify({ user, email: `${user}@ornek.com`, salt: 'A'.repeat(24), iter: 600000, authKey: 'B'.repeat(44), wrappedKey: 'C'.repeat(60) }) });
  for (let i = 0; i < 5; i++) assert.equal((await reg('u' + i, '198.51.100.9')).status, 200);
  assert.equal((await reg('u9', '198.51.100.9')).status, 429, 'IP başına günlük kayıt sınırı');
  assert.equal((await reg('u9', '198.51.100.10')).status, 200, 'başka IP açabilir');
  // yönetici: yalnız izinli IP'den; yanlış IP'de sayfa yokmuş gibi
  const adm = (ip, body, path = '/api/admin/stats') => fetch(`http://${P}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...viaCf(ip) }, body: JSON.stringify(body) });
  assert.equal((await fetch(`http://${P}/admin`)).status, 404, 'yerel adres izinli listede değil');
  assert.equal((await fetch(`http://${P}/admin`, { headers: viaCf('198.51.100.9') })).status, 404);
  assert.equal((await fetch(`http://${P}/admin`, { headers: viaCf('203.0.113.7') })).status, 200);
  assert.equal((await fetch(`http://${P}/admin`, { headers: { 'CF-Connecting-IP': '203.0.113.7' } })).status, 404, 'Cloudflare\'i atlayan istek başlığı taklit edemez');
  assert.equal((await fetch(`http://${P}/admin`, { headers: { 'X-Forwarded-For': '9.9.9.9', 'CF-Connecting-IP': '203.0.113.7' } })).status, 404, 'Cloudflare olmayan vekil');
  assert.equal((await fetch(`http://${P}/admin`, { headers: { 'X-Forwarded-For': '1.1.1.1, 2001:db8:0:5::1' } })).status, 200, 'IPv6 alt ağ, XFF en sağ');
  assert.equal((await fetch(`http://${P}/admin`, { headers: { 'X-Forwarded-For': '203.0.113.7, 1.1.1.1' } })).status, 404, 'XFF soldaki girdi sayılmaz');
  assert.equal((await adm('198.51.100.9', { key: 'yonetici-parolasi' })).status, 404);
  assert.equal((await adm('203.0.113.7', { key: 'yanlis' })).status, 403);
  // kullanım sayıları: gün başına tam değer gelir, tekrar gönderim iki kez saymaz; kapalıysa hiç gönderilmez
  const dk = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
  O.sync.usage = () => ({ snapshot: { sessions: 3, groups: 1, keys: 2, bogus: 9 }, days: { [dk]: { connections: 5, bytesUp: 1000, transfers: 2, evil: 7 }, 'gecersiz': { connections: 99 } } });
  await O.sync._sendUsage(O.sync._token(), true);
  await O.sync._sendUsage(O.sync._token(), true);
  assert.equal(await O.sync._sendUsage(O.sync._token()), null, 'saatte bir gönderilir');
  const ast = await (await adm('203.0.113.7', { key: 'yonetici-parolasi' })).json();
  assert.equal(ast.totals.users, 7);
  const aliUse = ast.users.find((x) => x.user === 'ali').usage;
  assert.deepEqual(aliUse.snapshot, { sessions: 3, groups: 1, keys: 2 }, 'yalnız izinli anlık sayılar');
  assert.deepEqual(aliUse.last30, { connections: 5, bytesUp: 1000, transfers: 2 }, 'yalnız izinli günlük sayılar, iki kez sayılmaz');
  assert.equal(ast.days[29].usage.connections, 5);
  assert(ast.days[29].registrations >= 7);
  assert.equal(ast.lifetime.usageReports, 2);
  assert.equal(ast.users.find((x) => x.user === 'ali').email, 'yeni@ornek.com');
  assert.equal((await adm('203.0.113.7', { key: 'yonetici-parolasi', user: 'u0' }, '/api/admin/delete')).status, 200);
  assert.equal((await (await adm('203.0.113.7', { key: 'yonetici-parolasi' })).json()).totals.users, 6, 'yönetici hesap siler');
  // hesap silme: yanlış parola reddedilir, doğrusu hesabı ve kasayı siler; yerel oturumlar kalır
  await assert.rejects(O.sync.deleteAccount('yanlisParola'), /parolası yanlış/);
  const vaultsBefore = fs.readdirSync(path.join(openDir, 'vaults')).length;
  await O.sync.deleteAccount('aliParola123');
  assert.equal(O.sync.status().loggedIn, false);
  assert(O.st.sessions.some((x) => x.name === 'acik'), 'yerel oturumlar silinmez');
  assert.equal(fs.readdirSync(path.join(openDir, 'vaults')).length, vaultsBefore - 1, 'kasa silindi');
  const ast2 = await (await adm('203.0.113.7', { key: 'yonetici-parolasi' })).json();
  assert.equal(ast2.days[29].usage.connections, undefined, 'silinen hesabın kullanım kayıtları da silinir');
  assert.equal(ast2.lifetime.deletions, 2);
  await assert.rejects(device().sync.login({ server: P, user: 'ali', password: 'aliParola123' }), /parola yanlış/);
  // güncelleme aktarımı
  const feed = await fetch(`http://${P}/guncelleme/latest.json`);
  assert.equal(feed.status, 200); assert.equal((await feed.json()).payload, 'e30=');
  const apk = await fetch(`http://${P}/indir/1.2.3/Melid-1.2.3.apk`);
  assert.equal(apk.status, 200); assert.equal(await apk.text(), 'APK!!');
  assert.match(apk.headers.get('content-disposition'), /Melid-1\.2\.3\.apk/);
  assert.equal((await fetch(`http://${P}/indir/1.2.3/yok.apk`)).status, 404);
  assert.equal((await fetch(`http://${P}/indir/1.2.3/..%2Fsecret`)).status, 404);
  // TRUST_PROXY=1 kipinde CF-Connecting-IP hiç sayılmaz
  const plain = http.createServer(createSyncServer({ dataDir: tmp('melid-srv-'), adminKey: 'k', adminIps: '203.0.113.7', trustProxy: true }));
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  const PL = `http://127.0.0.1:${plain.address().port}`;
  assert.equal((await fetch(`${PL}/admin`, { headers: viaCf('203.0.113.7') })).status, 404);
  assert.equal((await fetch(`${PL}/admin`, { headers: { 'X-Forwarded-For': '203.0.113.7' } })).status, 200);
  plain.close();
  // UPDATE_FEED_URL: yönlendirme izlenir (GitHub sürüm dosyası gibi), kaynak düşse de son akış verilir
  let feedHits = 0;
  const gh = http.createServer((q, s2) => {
    if (q.url === '/releases/latest/download/latest.json') { s2.writeHead(302, { Location: '/obj/latest.json' }); return s2.end(); }
    if (q.url === '/obj/latest.json') { feedHits++; return s2.end('{"payload":"gh","sig":"x"}'); }
    s2.writeHead(404); s2.end();
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const fsrv = http.createServer(createSyncServer({ dataDir: tmp('melid-srv-'), updateFeedUrl: `http://127.0.0.1:${gh.address().port}/releases/latest/download/latest.json` }));
  await new Promise((r) => fsrv.listen(0, '127.0.0.1', r));
  const FU = `http://127.0.0.1:${fsrv.address().port}/guncelleme/latest.json`;
  const [f1, f2] = await Promise.all([fetch(FU), fetch(FU)]);
  assert.equal((await f1.json()).payload, 'gh'); assert.equal((await f2.json()).payload, 'gh');
  assert.equal(feedHits, 1, 'eşzamanlı istekler tek kez alır, sonra bellekten');
  gh.close(); fsrv.close();
  pub.close(); upstream.close();
  console.log('OK herkese açık kayıt, e-posta, hesap silme, yönetici IP sınırı, güncelleme aktarımı');
})().catch((e) => { console.error(e); process.exit(1); });
