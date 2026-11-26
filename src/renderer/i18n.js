// Arayüz dili. Kaynak metinler Türkçe; İngilizce locales/en.js'te Türkçe metin anahtarıyla tutulur:
//   plain:    { "Yeni oturum": "New session" }
//   patterns: { "{0} oturum silindi": "{0} sessions deleted" }   ({0}, {1}... değişken yerleri)
// Dil İngilizceyse ekrana eklenen her metin (metin düğümü, title, placeholder, aria-label) gözlemciyle çevrilir; kodda
// t() yalnız DOM'a girmeyen yerlerde gerekir (terminale yazılan bilgi satırları vb.). Kullanıcı içeriği (oturum, dosya,
// sekme adları, yollar, terminal) NO_TR seçicileriyle hariç tutulur. Ana süreçteki karşılığı: src/main/i18n.js
import EN from './locales/en.js';

let lang = 'tr';
const plain = new Map(Object.entries(EN.plain));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Kalıplar: uzun (daha belirgin) olan önce denenir
const patterns = Object.entries(EN.patterns).map(([tr, en]) => {
  const parts = tr.split(/\{(\d+)\}/);
  let re = '^'; const order = [];
  parts.forEach((p, i) => { if (i % 2) { re += '([\\s\\S]*?)'; order.push(Number(p)); } else re += esc(p); });
  return { re: new RegExp(re + '$'), en, order, weight: tr.replace(/\{\d+\}/g, '').length };
}).sort((a, b) => b.weight - a.weight);

/** 'auto' | 'tr' | 'en' -> etkin dil */
export function resolveLang(setting) {
  if (setting === 'tr' || setting === 'en') return setting;
  return /^tr\b/i.test(navigator.language || '') ? 'tr' : 'en';
}
export function getLang() { return lang; }

/** Türkçe metni etkin dile çevirir; sözlükte yoksa olduğu gibi döner */
export function t(s, depth = 0) {
  if (lang !== 'en' || typeof s !== 'string' || !s || depth > 3) return s;
  const hit = plain.get(s);
  if (hit !== undefined) return hit;
  const m0 = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  const core = m0[2];
  if (!core || !/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(core)) return s;
  const h2 = plain.get(core);
  if (h2 !== undefined) return m0[1] + h2 + m0[3];
  for (const p of patterns) {
    const m = p.re.exec(core);
    if (!m) continue;
    const vals = {};
    p.order.forEach((k, i) => { vals[k] = t(m[i + 1], depth + 1); }); // değişken yerindeki metin de çevrilebilir (ör. hata)
    return m0[1] + p.en.replace(/\{(\d+)\}/g, (_, k) => vals[k] ?? '') + m0[3];
  }
  return s;
}

// Çevrilmeyecek yerler: kullanıcı içeriği ve terminal
const NO_TR = '[translate="no"], .xterm, script, style, textarea, code, pre, .mono, .s-name, .s-host, .g-name, .c-name, .fname, .tab-title, .w-recent b, .crumbs, .path, .breadcrumb, .kv dd, .dev b, .rec-code';
const ATTRS = ['title', 'placeholder', 'aria-label'];

function translateText(node) {
  const p = node.parentElement;
  if (!p || p.closest(NO_TR)) return;
  const v = node.nodeValue;
  const n = t(v);
  if (n !== v) node.nodeValue = n;
}
function translateEl(el) {
  if (el.closest(NO_TR)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v) { const n = t(v); if (n !== v) el.setAttribute(a, n); }
  }
}
export function translateTree(root) {
  if (lang !== 'en' || !root) return;
  if (root.nodeType === 3) { translateText(root); return; }
  if (root.nodeType !== 1) return;
  translateEl(root);
  if (root.closest(NO_TR)) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && n.matches(NO_TR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.nodeType === 3) translateText(n); else translateEl(n); }
}

let observer = null;
/** Dili ayarlar; İngilizcede belgeyi çevirir ve sonradan eklenenleri izler. Türkçeye dönüş sayfa yenilenerek olur. */
export function initI18n(setting) {
  lang = resolveLang(setting);
  document.documentElement.lang = lang;
  if (lang !== 'en' || observer) return;
  translateTree(document.body);
  document.title = t(document.title);
  observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach((n) => translateTree(n));
      else if (m.type === 'characterData') translateText(m.target);
      else if (m.type === 'attributes') translateEl(m.target);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
