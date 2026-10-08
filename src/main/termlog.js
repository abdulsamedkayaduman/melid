'use strict';
// Terminal oturum kaydı: kabuk çıktısını dosyaya yazar. İsteğe bağlı olarak ANSI kaçış
// dizileri (renk, imleç hareketi, pencere başlığı) temizlenir ki kayıt düz metin olarak okunabilsin.
const fs = require('fs');
const path = require('path');

const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[()#][0-9A-Za-z]|[^[\]PX^_()#])/g;
const COMPLETE_RE = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[()#][0-9A-Za-z]|[^[\]PX^_()#])/;

// Parça parça gelen veride yarım kalan kaçış dizisini bir sonraki parçaya taşır.
function createAnsiStripper() {
  let carry = '';
  return (chunk) => {
    let s = carry + chunk;
    carry = '';
    const i = s.lastIndexOf('\x1b');
    if (i !== -1 && s.length - i < 256 && !COMPLETE_RE.test(s.slice(i))) { carry = s.slice(i); s = s.slice(0, i); }
    s = s.replace(ANSI_RE, '').replace(/\r+\n/g, '\n').replace(/\r/g, '');
    // geri silme: önceki karakteri sil
    for (let prev; prev !== s;) { prev = s; s = s.replace(/[^\n\x08]\x08/g, ''); }
    return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  };
}

const safeName = (s) => String(s || 'oturum').replace(/[/\\:*?"<>|\x00-\x1f]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'oturum';

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

class TermLogger {
  constructor() { this.files = new Map(); } // key -> { stream, strip, path }

  // Kayıt dosyasını ilk veride açar. opts: { dir, name, strip }
  write(key, data, opts) {
    let f = this.files.get(key);
    if (!f) {
      const dir = path.join(opts.dir, safeName(opts.name));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${stamp()}${opts.suffix ? '_' + safeName(opts.suffix) : ''}.log`);
      f = { stream: fs.createWriteStream(file, { flags: 'a', mode: 0o600 }), strip: opts.strip ? createAnsiStripper() : null, path: file };
      f.stream.on('error', () => {});
      this.files.set(key, f);
    }
    f.stream.write(f.strip ? f.strip(data) : data);
    return f.path;
  }

  close(key) {
    const f = this.files.get(key);
    if (f) { this.files.delete(key); f.stream.end(); }
  }

  closePrefix(prefix) { for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.close(k); }

  closeAll() { for (const k of [...this.files.keys()]) this.close(k); }
}

module.exports = { TermLogger, createAnsiStripper, safeName };
