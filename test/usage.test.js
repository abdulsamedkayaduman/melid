'use strict';
// usage.js: günlük kullanım sayaçları (yalnız izinli anahtarlar, diske yazma, eski günleri atma, son günler)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Usage, dayKey } = require('../src/main/usage');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melid-usage-'));
const u = new Usage(dir);
u.inc('connections'); u.inc('connections'); u.inc('bytesUp', 1500.7); u.inc('bilinmeyen', 5); u.inc('tunnels', 0); u.inc('transfers', -3);
const today = dayKey();
assert.deepEqual(u.recent(), { [today]: { connections: 2, bytesUp: 1500 } });
u.data.days['2000-01-01'] = { connections: 9 }; // 40 günden eski: atılır
u.data.days[dayKey(Date.now() - 20 * 86400000)] = { connections: 4 }; // saklanır ama son 14 günde değil
u.save();
const u2 = new Usage(dir);
assert(!u2.data.days['2000-01-01'], 'eski gün atıldı');
assert.equal(Object.keys(u2.data.days).length, 2);
assert.deepEqual(Object.keys(u2.recent()), [today], 'yalnız son 14 gün gönderilir');
fs.writeFileSync(path.join(dir, 'usage.json'), 'bozuk');
assert.deepEqual(new Usage(dir).recent(), {}, 'bozuk dosya boş başlar');
console.log('OK kullanım sayaçları');
