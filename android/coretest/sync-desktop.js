'use strict';
// SyncTest.java'nın masaüstü tarafı: gerçek src/main/sync.js + store.js ile aynı hesaba girer.
//   node sync-desktop.js pre  <work> <server>  -> hesap açar, oturum yükler, birleştirme örnekleri yazar
//   node sync-desktop.js post <work> <server>  -> Android'in yüklediğini görür, Android'in açtığı hesaba girer
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Store, mergeVaults, sortedJson } = require('../../src/main/store');
const { AccountSync } = require('../../src/main/sync');

const [mode, work, server] = process.argv.slice(2);
const noKeyring = { available: () => false, encrypt: (s) => s, decrypt: (s) => s };
const dir = path.join(work, 'desk');
const names = (st) => st.sessions.map((s) => s.name).sort().join(',');

(async () => {
  if (mode === 'pre') {
    fs.rmSync(dir, { recursive: true, force: true });
    const st = new Store(dir, noKeyring);
    const sync = new AccountSync(st, { client: 'SSHDeck test linux' });
    st.saveSession({ name: 'masaüstü', host: 'web.example', username: 'root', password: 'gizli-ğ', keyPath: '/home/x/.ssh/id_ed25519', localDir: '/home/x' });
    st.saveSettings({ snippets: [{ id: 's1', name: 'disk', command: 'df -h', run: true }], fontFamily: 'Masaüstü Fontu', fontSize: 15 });
    await sync.register({ server, user: 'samed', password: 'hesapParolası-ş', invite: 'davet' });
    // Java'nın canon/mergeVaults'u JS ile aynı sonucu vermeli (eşit zamanda aynı taraf seçilmeli)
    const a = { sessions: { x: { id: 'x', name: 'Ç"\\/\n\u0001😀', mtime: 5, n: 1.5, arr: [1, null, true] }, y: { id: 'y', name: 'b', mtime: 2 } }, deleted: { z: 1, y: 3 }, settings: { data: { b: 1, a: 'ş' }, mtime: 7 } };
    const b = { sessions: { x: { id: 'x', name: 'Ä', mtime: 5 }, z: { id: 'z', mtime: 0 } }, deleted: { y: 1 }, settings: { data: { a: 'z' }, mtime: 7 } };
    fs.writeFileSync(path.join(work, 'merge.json'), JSON.stringify({ a, b, expected: sortedJson(mergeVaults(a, b, 10)), canonA: sortedJson(a) }));
    console.log('  ✓ masaüstü hesap açtı');
  } else {
    const st = new Store(dir, noKeyring);
    const sync = new AccountSync(st);
    await sync.syncNow();
    assert.equal(names(st), 'android,masaüstü-düzenlendi');
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
  }
})().catch((e) => { console.error(e); process.exit(1); });
