'use strict';
// Ana süreçteki metinler (işletim sisteminin dosya pencereleri, bildirimler, macOS menüsü, kapatma onayı) için çeviri.
// Sözlük arayüzle ortak: src/renderer/locales/en.js (Türkçe metin -> İngilizce). Arayüzdeki metinleri renderer çevirir.
const fs = require('fs');
const path = require('path');

let dict = { plain: {}, patterns: {} };
try {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'locales', 'en.js'), 'utf8');
  dict = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
} catch (e) { console.error('Çeviri sözlüğü okunamadı:', e.message); }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.entries(dict.patterns).map(([tr, en]) => {
  const parts = tr.split(/\{(\d+)\}/); let re = '^'; const order = [];
  parts.forEach((p, i) => { if (i % 2) { re += '([\\s\\S]*?)'; order.push(Number(p)); } else re += esc(p); });
  return { re: new RegExp(re + '$'), en, order, weight: tr.replace(/\{\d+\}/g, '').length };
}).sort((a, b) => b.weight - a.weight);

let lang = 'tr';
/** setting: 'auto' | 'tr' | 'en'; locale: app.getLocale() */
function setLang(setting, locale = '') { lang = setting === 'tr' || setting === 'en' ? setting : /^tr\b/i.test(locale) ? 'tr' : 'en'; }
function T(s) {
  if (lang !== 'en' || typeof s !== 'string' || !s) return s;
  if (dict.plain[s] !== undefined) return dict.plain[s];
  for (const p of patterns) {
    const m = p.re.exec(s);
    if (m) { const v = {}; p.order.forEach((k, i) => { v[k] = T(m[i + 1]); }); return p.en.replace(/\{(\d+)\}/g, (_, k) => v[k] ?? ''); }
  }
  return s;
}
module.exports = { T, setLang, getLang: () => lang };
