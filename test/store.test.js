'use strict';
// Store: ana parola şifreleme + yedek export/import (sunucu gerektirmez).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');

// keyring yokmuş gibi davran (plain base64 yedeği) — ana parola bundan bağımsız çalışmalı
const noKeyring = { available: () => false, encrypt: (s) => s, decrypt: (s) => s };
const fresh = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'melid-store-')), noKeyring);

// --- ana parola ---
let st = fresh();
const id = st.saveSession({ name: 'a', host: 'h', username: 'u', password: 'gizli123' });
assert.equal(st.getSession(id).password, 'gizli123');
assert.equal(st.masterEnabled(), false);

// ana parola belirle -> mevcut parola yeni anahtarla şifrelenir
st.setMasterPassword(null, 'anaP');
assert.equal(st.masterEnabled(), true);
assert.equal(st.isUnlocked(), true);
assert.equal(st.getSession(id).password, 'gizli123');
// diskteki sessions.json içinde parola düz metin OLMAMALI
assert(!fs.readFileSync(path.join(st.dir, 'sessions.json'), 'utf8').includes('gizli123'), 'disk şifreli olmalı');
// settings.json master doğrulayıcı içermeli, renderer'a gitmemeli
assert(st.settings.master && st.settings.master.salt);
assert.equal(st.publicSettings().master, undefined);
assert.equal(st.publicSettings().masterEnabled, true);

// kilitle -> parola çözülemez
st.lock();
assert.equal(st.isUnlocked(), false);
assert.equal(st.getSession(id).password, undefined);
assert.equal(st.unlock('yanlis'), false);
assert.equal(st.unlock('anaP'), true);
assert.equal(st.getSession(id).password, 'gizli123');

// yeni Store aynı diskten okuyunca kilitli açılmalı, unlock ile çözülmeli
const st2 = new Store(st.dir, noKeyring);
assert.equal(st2.masterEnabled(), true);
assert.equal(st2.getSession(id).password, undefined);
assert.equal(st2.unlock('anaP'), true);
assert.equal(st2.getSession(id).password, 'gizli123');

// SSHDeck'te belirlenmiş ana parola (eski doğrulayıcı) Melid'de de açılır
{
  const crypto = require('crypto');
  const { encWithKey } = require('../src/main/store');
  const raw = JSON.parse(fs.readFileSync(path.join(st.dir, 'settings.json'), 'utf8'));
  const key = crypto.pbkdf2Sync('anaP', Buffer.from(raw.master.salt, 'base64'), 200000, 32, 'sha512');
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'melid-store-'));
  for (const f of fs.readdirSync(st.dir)) fs.copyFileSync(path.join(st.dir, f), path.join(legacyDir, f));
  const lraw = { ...raw, master: { ...raw.master, check: encWithKey('sshdeck-master-ok', key) } };
  fs.writeFileSync(path.join(legacyDir, 'settings.json'), JSON.stringify(lraw));
  const legacy = new Store(legacyDir, noKeyring);
  assert.equal(legacy.unlock('yanlis'), false);
  assert.equal(legacy.unlock('anaP'), true, 'eski doğrulayıcıyla ana parola açılır');
  assert.equal(legacy.getSession(id).password, 'gizli123');
}

// yanlış eski parolayla değiştirme reddedilmeli
assert.throws(() => st2.setMasterPassword('yanlis', 'yeni'), /yanlış/);
// doğru eskiyle değiştir
st2.setMasterPassword('anaP', 'yeniAna');
assert.equal(st2.unlock('yeniAna'), true);
// kaldır -> tekrar keyring/plain
st2.setMasterPassword('yeniAna', '');
assert.equal(st2.masterEnabled(), false);
assert.equal(st2.getSession(id).password, 'gizli123');
console.log('OK master password');

// --- yedek export / import ---
let a = fresh();
const s1 = a.saveSession({ name: 'srv1', group: 'G/A', host: '1.2.3.4', port: 2222, username: 'root', password: 'p@ss1', notes: 'not' });
const s2 = a.saveSession({ name: 'srv2', host: '5.6.7.8', username: 'u2' });
// parolasız export: parola içermez
const plain = a.exportData({});
assert.equal(plain.encrypted, false);
assert(!JSON.stringify(plain).includes('p@ss1'));
// parolalı export: şifreli, düz metin sızmaz
const enc = a.exportData({ passphrase: 'yedekPar' });
assert.equal(enc.encrypted, true);
assert(enc.secretsSalt && JSON.stringify(enc).indexOf('p@ss1') === -1, 'parola şifreli olmalı');
assert.equal(a.verifyBackupPassphrase(enc, 'yedekPar'), true);
assert.equal(a.verifyBackupPassphrase(enc, 'yanlis'), false);

// başka bir store'a import (doğru parola) -> parola çözülür
let b = fresh();
const r = b.importData(enc, 'yedekPar');
assert.deepEqual([r.added, r.withPassword], [2, 1]);
assert.equal(b.getSession(s1).password, 'p@ss1');
assert.equal(b.getSession(s1).group, 'G/A');
assert.equal(b.getSession(s2).username, 'u2');
// aynı id tekrar import -> güncelleme
const r2 = b.importData(enc, 'yedekPar');
assert.equal(r2.updated, 2);
assert.equal(r2.added, 0);
// yanlış parolayla import -> parola çözülmez ama oturum yine gelir
let c = fresh();
const r3 = c.importData(enc, 'yanlisPar');
assert.equal(r3.withPassword, 0);
assert.equal(c.getSession(s1).password, undefined);
assert.equal(c.getSession(s1).name, 'srv1');
console.log('OK backup export/import');

// --- grup yerel dizinleri: cihaza özgü; grup yeniden adlandırılınca/silinince birlikte değişir ---
{
  const g = fresh();
  g.saveSession({ name: 'a', host: 'h', group: 'Prod/DB' });
  g.saveSession({ name: 'b', host: 'h', group: 'Test' });
  g.saveSettings({ groupLocalDirs: { Prod: '/srv', 'Prod/DB': '/db', Test: '/t' }, localDir: '/home/x', localShell: 'pwsh' });
  g.renameGroup('Prod', 'Canli');
  assert.deepEqual(g.settings.groupLocalDirs, { Canli: '/srv', 'Canli/DB': '/db', Test: '/t' });
  g.deleteGroup('Test');
  assert.deepEqual(g.settings.groupLocalDirs, { Canli: '/srv', 'Canli/DB': '/db' });
  const out = g.syncSettingsData ? g.syncSettingsData() : null;
  if (out) for (const k of ['groupLocalDirs', 'localDir', 'localShell']) assert.ok(!(k in out), `${k} eşitlenmemeli`);
  console.log('OK grup yerel dizinleri');
}
