'use strict';
// Uygulama kullanım sayıları (usage.json, cihaza özgü): günlük bağlantı / aktarım / tünel sayıları.
// Yalnız sayılar tutulur; sunucu adresi, kullanıcı adı, dosya adı tutulmaz. Hesap açıksa ve "Kullanım istatistiklerini
// gönder" kapatılmadıysa sync.js bunları eşitleme sunucusuna gönderir (POST /api/usage). Gizlilik: server/pages/kosullar.html
const fs = require('fs');
const path = require('path');

const KEYS = ['connections', 'connectionFailures', 'transfers', 'transferFailures', 'bytesUp', 'bytesDown', 'tunnels'];
const dayKey = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE'); // YYYY-MM-DD, yerel saat

class Usage {
  constructor(dir) {
    this.file = path.join(dir, 'usage.json');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = null; }
    if (!this.data || typeof this.data.days !== 'object') this.data = { days: {} };
    this._timer = null;
  }

  inc(key, n = 1) {
    if (!KEYS.includes(key) || !(n > 0)) return;
    const k = dayKey();
    const d = this.data.days[k] || (this.data.days[k] = {});
    d[key] = (d[key] || 0) + Math.floor(n);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save(), 5000);
    if (this._timer.unref) this._timer.unref();
  }

  save() {
    clearTimeout(this._timer);
    const cut = dayKey(Date.now() - 40 * 86400000);
    for (const k of Object.keys(this.data.days)) if (k < cut) delete this.data.days[k];
    try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data)); fs.renameSync(this.file + '.tmp', this.file); } catch {}
  }

  /** Son n günün sayaçları (sunucuya gün başına tam değer gider; tekrar gönderim üstüne yazar) */
  recent(n = 14) {
    const cut = dayKey(Date.now() - n * 86400000);
    return Object.fromEntries(Object.entries(this.data.days).filter(([k]) => k > cut));
  }
}

module.exports = { Usage, dayKey, USAGE_KEYS: KEYS };
