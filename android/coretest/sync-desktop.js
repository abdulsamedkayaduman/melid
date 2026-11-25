'use strict';
// SyncTest.java'nın masaüstü tarafı: gerçek src/main/sync.js + store.js ile aynı hesaba girer.
//   node sync-desktop.js pre  <work> <server>  -> hesap açar, oturum yükler, birleştirme örnekleri yazar
//   node sync-desktop.js post <work> <server>  -> Android'in yüklediğini görür, Android'in açtığı hesaba girer
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Store, mergeVaults, sortedJson } = require('../../src/main/store');
const { AccountSync } = require('../../src/main/sync');
const { generateKey } = require('../../src/main/keys');

const [mode, work, server] = process.argv.slice(2);
const noKeyring = { available: () => false, encrypt: (s) => s, decrypt: (s) => s };
const dir = path.join(work, 'desk');
const names = (st) => st.sessions.map((s) => s.name).sort().join(',');

(async () => {
  if (mode === 'pre') {
    fs.rmSync(dir, { recursive: true, force: true });
    const st = new Store(dir, noKeyring);
    // Anahtar eşitlemesi açık: ~/.ssh yerine geçici klasördeki anahtar hesaba gider
    st.sshDir = path.join(work, 'desk-ssh');
    fs.rmSync(st.sshDir, { recursive: true, force: true });
    const gk = generateKey(st.sshDir, { name: 'id_masaustu', type: 'ed25519' });
    fs.writeFileSync(path.join(work, 'desk-key.json'), JSON.stringify({ fp: gk.fingerprint }));
    st.setSyncKeys(true);
    const sync = new AccountSync(st, { client: 'Melid test linux' });
    st.saveSession({ name: 'masaüstü', host: 'web.example', username: 'root', password: 'gizli-ğ', keyPath: '/home/x/.ssh/id_ed25519', localDir: '/home/x' });
    st.saveSession({ name: 'anahtarlı', host: 'k.example', authType: 'key', keyPath: gk.privatePath });
    st.saveSettings({ snippets: [{ id: 's1', name: 'disk', command: 'df -h', run: true }], fontFamily: 'Masaüstü Fontu', fontSize: 15 });
    await sync.register({ server, user: 'samed', email: 'samed@ornek.com', password: 'hesapParolası-ş', invite: 'davet' });
    // Java'nın canon/mergeVaults'u JS ile aynı sonucu vermeli (eşit zamanda aynı taraf seçilmeli)
    const a = { sessions: { x: { id: 'x', name: 'Ç"\\/\n\u0001😀', mtime: 5, n: 1.5, arr: [1, null, true] }, y: { id: 'y', name: 'b', mtime: 2 } }, deleted: { z: 1, y: 3, 'SHA256:k2': 4 }, settings: { data: { b: 1, a: 'ş' }, mtime: 7 },
      keys: { 'SHA256:k1': { name: 'a', private: 'p1', mtime: 3 }, 'SHA256:k2': { name: 'b', mtime: 2 } },
      snippets: { s1: { id: 's1', name: 'bir', mtime: 4 }, s2: { id: 's2', name: 'iki', mtime: 9 }, s9: { id: 's9', name: 'silinen', mtime: 1 } } };
    a.deleted.s9 = 2;
    a.settings.data.snippets = [{ id: 's2', name: 'iki' }, { id: 's1', name: 'bir' }];
    const b = { sessions: { x: { id: 'x', name: 'Ä', mtime: 5 }, z: { id: 'z', mtime: 0 } }, deleted: { y: 1 }, settings: { data: { a: 'z' }, mtime: 7 },
      keys: { 'SHA256:k1': { name: 'c', private: 'p1', mtime: 3 }, 'SHA256:k3': { name: 'd', mtime: 9 } } };
    // b eski biçim: komut haritası yok, liste ayar bloğunda
    b.settings.data.snippets = [{ id: 's1', name: 'BİR', mtime: 6 }, { id: 's3', name: 'üç' }, { id: 's9', name: 'silinen' }];
    fs.writeFileSync(path.join(work, 'merge.json'), JSON.stringify({ a, b, expected: sortedJson(mergeVaults(a, b, 10)), canonA: sortedJson(a) }));
    console.log('  ✓ masaüstü hesap açtı');
  } else {
    const st = new Store(dir, noKeyring);
    const sync = new AccountSync(st);
    await sync.syncNow();
    assert.equal(names(st), 'anahtarlı,android,masaüstü-düzenlendi');
    const andr = st.sessions.find((s) => s.name === 'android');
    assert.equal(st.getSession(andr.id).password, 'tel-parola-ü', 'Android parolası masaüstüne geldi');
    assert(!('keyId' in andr), 'Android keyId cihaza özgü kalır');
    const desk = st.sessions.find((s) => s.name === 'masaüstü-düzenlendi');
    assert.equal(desk.localDir, '/home/x', 'masaüstü localDir korunur');
    assert.equal(desk.keyPath, '/home/x/.ssh/id_ed25519', 'Android düzenlemesi keyPath\'i silmez');
    assert.equal(st.settings.snippets.length, 2, 'Android hazır komutu geldi');
    assert.equal(st.settings.fontFamily, 'Masaüstü Fontu', 'masaüstü ayarları korunur');
    assert.equal(st.settings.fontSize, 15, 'Android yazı boyutu masaüstüne geçmez');
    console.log('  ✓ masaüstü, Android\'in değişikliklerini aldı');
    // Android'in açtığı hesaba masaüstünden giriş
    fs.rmSync(path.join(work, 'desk2'), { recursive: true, force: true });
    const st3 = new Store(path.join(work, 'desk2'), noKeyring);
    await new AccountSync(st3).login({ server, user: 'telefon', password: 'telefonParola1' });
    assert.equal(names(st3), 'telefondan');
    console.log('  ✓ Android\'in açtığı hesaba masaüstünden giriş');
    // Anahtarlar: eşitlemesi kapalı Android (samed) kasadaki masaüstü anahtarını silmedi; açık Android'in (telefon) anahtarı geldi
    const { fp } = JSON.parse(fs.readFileSync(path.join(work, 'desk-key.json'), 'utf8'));
    fs.rmSync(path.join(work, 'desk4'), { recursive: true, force: true });
    const st4 = new Store(path.join(work, 'desk4'), noKeyring);
    st4.setSyncKeys(true);
    await new AccountSync(st4).login({ server, user: 'samed', password: 'hesapParolası-ş' });
    assert(st4.syncedKey(fp), 'masaüstü anahtarı kasada kaldı');
    const ks = st4.sessions.find((s) => s.name === 'anahtarlı');
    assert.equal(ks.keyFp, fp, 'oturum anahtarın parmak iziyle');
    assert.equal(st3.keys.length, 0, 'anahtar eşitlemesi kapalı masaüstüne anahtar gelmez');
    fs.rmSync(path.join(work, 'desk5'), { recursive: true, force: true });
    const st5 = new Store(path.join(work, 'desk5'), noKeyring);
    st5.setSyncKeys(true);
    await new AccountSync(st5).login({ server, user: 'telefon', password: 'telefonParola1' });
    const tk = st5.publicSyncedKeys().find((k) => k.name === 'telefon-anahtari');
    assert(tk && st5.syncedKey(tk.fingerprint).private.includes('OPENSSH PRIVATE KEY'), 'Android anahtarı masaüstüne geldi');
    assert.equal(st5.sessions.find((s) => s.name === 'telefondan').keyFp, tk.fingerprint, 'Android oturumu anahtarı parmak iziyle bulur');
    console.log('  ✓ SSH anahtarları (açık/kapalı cihaz) masaüstü ile uyumlu');
    // Java'nın oluşturduğu kurtarma anahtarıyla masaüstünden kurtarma
    const rc = JSON.parse(fs.readFileSync(path.join(work, 'rec.json'), 'utf8'));
    for (const d of ['desk6', 'desk7']) fs.rmSync(path.join(work, d), { recursive: true, force: true });
    const st6 = new Store(path.join(work, 'desk6'), noKeyring);
    await new AccountSync(st6).recover({ server, user: 'telefon', code: rc.code, password: 'telefonYeni-12' });
    assert.equal(names(st6), 'telefondan');
    await new AccountSync(new Store(path.join(work, 'desk7'), noKeyring)).login({ server, user: 'telefon', password: 'telefonYeni-12' });
    console.log('  ✓ Android kurtarma anahtarı masaüstünde çalışıyor');
  }
})().catch((e) => { console.error(e); process.exit(1); });
