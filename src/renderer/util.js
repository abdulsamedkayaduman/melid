// Small DOM + formatting helpers.
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const e = document.createElement(name || 'div');
  if (classes.length) e.className = classes.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className += (e.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function formatSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

export function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function permString(mode, isDir, isLink) {
  const t = isLink ? 'l' : isDir ? 'd' : '-';
  let s = '';
  const bits = 'rwxrwxrwx';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? bits[i] : '-';
  return t + s;
}

export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Parses "user@host:port" (also "host", "user@host", "host:port", "[v6]:port")
export function parseQuick(str) {
  const s = str.trim().replace(/^ssh\s+/, '');
  if (!s) return null;
  let user = ''; let rest = s;
  const at = s.lastIndexOf('@');
  if (at > 0) { user = s.slice(0, at); rest = s.slice(at + 1); }
  let host = rest; let port = 22;
  const v6 = rest.match(/^\[(.+)\](?::(\d+))?$/);
  if (v6) { host = v6[1]; port = Number(v6[2] || 22); }
  else if ((rest.match(/:/g) || []).length === 1) { const [a, b] = rest.split(':'); host = a; port = Number(b) || 22; }
  return host ? { username: user, host, port } : null;
}

// Parses free-form pasted connection info, e.g. lines of "name / host / user / password",
// "host user pass", "ssh -p 2222 user@host", or "Host: x" / "Kullanıcı: y" / "Parola: z" lines.
// Returns { name, host, port, username, password } or null.
const HOSTISH = /^(\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3}|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+|[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7})(:\d{1,5})?$/i;
const KEYS = [
  [/^(host|hostname|ip|ip adresi|adres|address|server|sunucu)$/i, 'host'],
  [/^(user|username|login|kullan[ıi]c[ıi]( ad[ıi])?|kullan[ıi]c[ıi]ad[ıi])$/i, 'username'],
  [/^(pass|password|passwd|pw|parola|[şs]ifre)$/i, 'password'],
  [/^port$/i, 'port'],
  [/^(name|ad|ad[ıi]|isim|oturum|session)$/i, 'name'],
];
export function parseConnText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const r = { name: '', host: '', port: 22, username: '', password: '' };
  let items = [];
  if (lines.length === 1) {
    const toks = lines[0].split(/\s+/);
    if (/^ssh$/i.test(toks[0])) {
      // ssh [-p port] [-l user] [user@]host[:port]
      let target = '';
      for (let i = 1; i < toks.length; i++) {
        if (toks[i] === '-p') r.port = Number(toks[++i]) || 22;
        else if (toks[i] === '-l') r.username = toks[++i] || '';
        else if (/^-[bcDEeFIiJLmOoQRSWw]$/.test(toks[i])) i++; // options that take a value
        else if (!toks[i].startsWith('-') && !target) target = toks[i];
      }
      const q = target && parseQuick(target);
      if (!q) return null;
      return { ...r, host: q.host, port: q.port !== 22 ? q.port : r.port, username: q.username || r.username };
    }
    items = toks;
  } else {
    for (const l of lines) {
      const m = l.match(/^([^:=]{1,20}?)\s*[:=]\s*(.+)$/);
      const key = m && KEYS.find(([re]) => re.test(m[1].trim()));
      if (key) {
        if (key[1] === 'port') r.port = Number(m[2]) || 22;
        else if (key[1] === 'host') { const q = parseQuick(m[2]); if (q) { r.host = q.host; if (q.port !== 22) r.port = q.port; if (q.username) r.username = q.username; } }
        else r[key[1]] = m[2].trim();
      } else items.push(l);
    }
  }
  const hostOf = (it) => {
    const at = it.lastIndexOf('@');
    const rest = at > 0 ? it.slice(at + 1) : it;
    return HOSTISH.test(rest) ? parseQuick(it) : null;
  };
  if (!r.host) {
    let idx = items.findIndex(hostOf);
    // no dotted host/IP: a lone single-line word, or the first line of a block
    if (idx < 0) { if (items.length === 1 || lines.length > 1) idx = 0; else return null; }
    const q = parseQuick(items[idx]);
    if (!q || /\s/.test(q.host)) return null;
    r.host = q.host;
    if (q.port !== 22) r.port = q.port;
    if (q.username) r.username = q.username;
    if (!r.name) r.name = items.slice(0, idx).join(' ');
    items = items.slice(idx + 1);
  }
  if (items.length >= 2 && /^\d{1,5}$/.test(items[0]) && Number(items[0]) <= 65535 && r.port === 22) r.port = Number(items.shift());
  if (!r.username && items.length) r.username = items.shift();
  if (!r.password && items.length) r.password = items.shift();
  return r.host ? r : null;
}

// Minimal inline SVG icon set (stroke icons, 16px).
const I = {
  plus: 'M12 5v14M5 12h14',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  up: 'M12 19V5M5 12l7-7 7 7',
  home: 'M3 11 12 3l9 8M5 10v10h14V10',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  newfolder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  x: 'M18 6 6 18M6 6l12 12',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  import: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  sidebar: 'M3 4h18v16H3zM9 4v16',
  files: 'M3 13h18M3 4h18v16H3z',
  tunnel: 'M4 20V10a8 8 0 0 1 16 0v10M9 20v-6a3 3 0 0 1 6 0v6',
  broadcast: 'M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M12 12h.01',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  chevron: 'M9 6l6 6-6 6',
  expand: 'M7 13l5 5 5-5M7 6l5 5 5-5',
  collapse: 'M7 11l5-5 5 5M7 18l5-5 5 5',
  lock: 'M6 10V8a6 6 0 0 1 12 0v2M5 10h14v10H5zM12 14v3',
  unlock: 'M7 10V8a5 5 0 0 1 9.9-1M5 10h14v10H5zM12 14v3',
  save: 'M5 3h11l3 3v15H5zM8 3v6h7V3M8 14h8',
  focus: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  upgrade: 'M12 20V8M7 13l5-5 5 5M4 4h16',
  upload: 'M12 20V8M7 13l5-5 5 5M4 4h16',
  play: 'M6 4l14 8-14 8z',
  stop: 'M6 6h12v12H6z',
  key: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7zM16 10h.01',
  snippet: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  splitH: 'M3 4h18v16H3zM12 4v16',
  splitV: 'M3 4h18v16H3zM3 12h18',
  cloud: 'M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 17.7 9.1 4.5 4.5 0 0 1 17.5 18z',
  sync: 'M4 9a8 8 0 0 1 14-3l2 2M20 4v4h-4M20 15a8 8 0 0 1-14 3l-2-2M4 20v-4h4',
  record: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  cpu: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
};
export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('ic');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', I[name] || I.file);
  svg.append(p);
  return svg;
}

/**
 * Geri/ileri hareketleri: fare yan tuşları (4./5.) ve touchpad'de iki parmakla yatay kaydırma
 * (parmaklar sağa = geri, sola = ileri; tarayıcılardaki gibi). canScroll(dir): öğe o yönde kendisi kayabiliyorsa
 * hareket kaydırmaya bırakılır. Shift+tekerlek (farede yatay kaydırma) sayılmaz.
 */
export function backForward(el, { back, forward, canScroll = () => false }) {
  el.addEventListener('mousedown', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); });
  el.addEventListener('mouseup', (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (e.button === 3) back(); else forward();
  });
  let acc = 0; let fired = false; let idle = 0;
  el.addEventListener('wheel', (e) => {
    if (e.shiftKey || e.ctrlKey || Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5 || !e.deltaX) return;
    const dir = e.deltaX < 0 ? -1 : 1;
    if (canScroll(dir)) { acc = 0; return; }
    clearTimeout(idle);
    idle = setTimeout(() => { acc = 0; fired = false; }, 350); // hareket bitince yeniden tetiklenebilir
    if (fired) return;
    acc += e.deltaX * (e.deltaMode === 1 ? 30 : 1);
    if (Math.abs(acc) < 120) return;
    fired = true;
    if (acc < 0) back(); else forward();
  }, { capture: true, passive: true });
}

