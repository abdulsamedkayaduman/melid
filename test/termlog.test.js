'use strict';
// Oturum kaydı: ANSI temizleme (parçalı veri dahil) ve dosya adları. Sunucusuz.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TermLogger, createAnsiStripper, safeName } = require('../src/main/termlog.js');

const s = createAnsiStripper();
assert.equal(s('\x1b]0;user@h: ~\x07\x1b[01;32muser@h\x1b[00m:\x1b[01;34m~\x1b[00m$ ls\r\n'), 'user@h:~$ ls\n');
// kaçış dizisi iki parçaya bölünmüş
assert.equal(s('a\x1b[3') + s('1mb\x1b[0m\r\n'), 'ab\n');
assert.equal(s('abc\x08\x08x\r\n'), 'ax\n');
assert.equal(s('\x1b(B\x1b[?2004htext\x1b[K\x07\n'), 'text\n');
assert.equal(safeName('a/b:c'), 'a_b_c');
assert.equal(safeName('..'), 'oturum');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshdeck-log-'));
const lg = new TermLogger();
const f = lg.write('c1:main', '\x1b[31mkırmızı\x1b[0m\r\n', { dir, name: 'Sunucu 1', strip: true });
lg.write('c1:main', 'ikinci\r\n', { dir, name: 'Sunucu 1', strip: true });
const raw = lg.write('c1:p2', '\x1b[31mx', { dir, name: 'Sunucu 1', suffix: 'p2', strip: false });
lg.closePrefix('c1:');
setTimeout(() => {
  assert.equal(path.dirname(f), path.join(dir, 'Sunucu 1'));
  assert.equal(fs.readFileSync(f, 'utf8'), 'kırmızı\nikinci\n');
  assert(raw.endsWith('_p2.log'));
  assert.equal(fs.readFileSync(raw, 'utf8'), '\x1b[31mx');
  assert.equal(lg.files.size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('OK termlog');
}, 100);
