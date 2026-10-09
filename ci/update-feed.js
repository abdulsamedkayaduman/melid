#!/usr/bin/env node
'use strict';
// İmzalı latest.json üretir (uygulamalardaki güncelleme denetimi bunu okur; biçim: src/main/updater.js).
// Kullanım: UPDATE_SIGNING_KEY=<PEM> node ci/update-feed.js <sürüm> <notlar-dosyası> <dosyaların-taban-url'si> <dist-klasörü>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { signFeed } = require('../src/main/updater');

const [version, notesFile, baseUrl, dist] = process.argv.slice(2);
const key = process.env.UPDATE_SIGNING_KEY;
if (!key) { console.error('UPDATE_SIGNING_KEY yok'); process.exit(1); }
const names = {
  'win-setup': `SSHDeck-${version}-kurulum.exe`,
  'win-portable': `SSHDeck-${version}-tasinabilir.exe`,
  'linux-appimage': `SSHDeck-${version}.AppImage`,
  'linux-pacman': `sshdeck-${version}.pacman`,
  android: `SSHDeck-${version}.apk`,
};
const files = {};
for (const [kind, name] of Object.entries(names)) {
  const p = path.join(dist, name);
  if (!fs.existsSync(p)) { console.error(`Eksik dosya: ${p}`); process.exit(1); }
  const buf = fs.readFileSync(p);
  files[kind] = { name, url: `${baseUrl}/${encodeURIComponent(name)}`, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
}
const info = { app: 'sshdeck', version, date: new Date().toISOString(), notes: fs.readFileSync(notesFile, 'utf8').trim(), files };
process.stdout.write(signFeed(info, key));
