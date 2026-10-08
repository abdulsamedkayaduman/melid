// SFTP dosya yöneticisi (sekme başına bir tane). İndirilenler telefonda İndirilenler/SSHDeck klasörüne gider.
import { h, icon, formatSize, formatDate, uid } from './util.js';
import * as N from './native.js';
import { actionSheet, promptText, confirm, toast, sheet } from './dialogs.js';

const join = (dir, name) => (dir === '/' ? '/' + name : dir.replace(/\/+$/, '') + '/' + name);
const parent = (p) => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/');
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const IMG = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon' };

// Terminalin bulunduğu dizin: aynı bağlantıdaki kabuğu $SSH_CONNECTION ile bulur (masaüstü ssh-manager CWD_SCRIPT)
const CWD_SCRIPT = [
  'p=; for d in /proc/[0-9]*; do q=${d#/proc/}; [ -r $d/environ ] || continue;'
    + ' tr "\\0" "\\n" < $d/environ 2>/dev/null | grep -qxF "SSH_CONNECTION=$SSH_CONNECTION" || continue;'
    + ' set -- $(sed "s/^.*) //" $d/stat 2>/dev/null); [ "$4" = "$q" ] && [ "$5" != 0 ] && { p=$q; break; }; done',
  '[ -n "$p" ] || exit 1',
  'set -- $(sed "s/^.*) //" /proc/$p/stat)',
  'echo $p',
  'readlink /proc/$6/cwd 2>/dev/null || readlink /proc/$p/cwd',
].join('\n');

export class FilesView {
  /** tab: { c (connId getter), settings, saveSettings(patch), app, typeInTerminal(str), showEditor(view) } */
  constructor(tab) {
    this.tab = tab;
    this.path = null;
    this.entries = [];
    this.sel = new Set();
    this.xfers = new Map();

    this.crumbs = h('div.crumbs');
    this.loadLine = h('div.loading-line.hidden');
    this.list = h('div.scroll');
    this.selCount = h('b.grow', { style: { paddingLeft: '8px' } });
    this.selbar = h('div.selbar.hidden', null,
      h('button.tb', { onclick: () => this.clearSel() }, icon('x', 20)), this.selCount,
      h('button.tb', { onclick: () => this.downloadSel() }, icon('download', 20)),
      h('button.tb', { onclick: () => this.deleteSel() }, icon('trash', 20)));
    this.xferEl = h('div.xfers.hidden');
    this.fab = h('button.fab', { type: 'button', onclick: () => this.upload() }, icon('upload', 24));
    this.el = h('div.pane.files-pane', null,
      h('div.pathbar', null,
        h('button.tb', { onclick: () => this.go(parent(this.path || '/')) }, icon('up', 20)),
        this.crumbs,
        h('button.tb', { onclick: () => this.refresh() }, icon('refresh', 19)),
        h('button.tb', { onclick: () => this.menu() }, icon('more', 20))),
      this.loadLine, this.selbar, this.list, this.xferEl, this.fab);
  }

  get c() { return this.tab.connId; }
  call(m, a = {}) { return N.call(m, { c: this.c, ...a }); }

  async show() {
    if (this.path == null) {
      const start = this.tab.session.remoteDir;
      try { await this.go(start || await this.call('sftpHome')); } catch (e) {
        if (start) await this.go(await this.call('sftpHome')).catch((e2) => this.error(e2));
        else this.error(e);
      }
    }
  }

  error(e) {
    this.list.replaceChildren(h('div.empty', null, h('div.big', null, icon('folder', 30)), h('h3', null, 'Dosyalar açılamadı'), h('p', null, e.message),
      h('div.btns', null, h('button.btn', { onclick: () => this.refresh() }, icon('refresh', 16), 'Tekrar dene'))));
  }

  async go(path) {
    this.loadLine.classList.remove('hidden');
    try {
      const r = await this.call('sftpList', { path });
      this.path = r.path;
      this.entries = r.entries;
      this.clearSel(true);
      this.render();
      this.list.scrollTop = 0;
    } catch (e) {
      toast(e.message, { type: 'err' });
      if (this.path == null) this.error(e);
      throw e;
    } finally {
      this.loadLine.classList.add('hidden');
    }
  }

  refresh() { return this.go(this.path || '').catch(() => {}); }

  renderCrumbs() {
    const parts = this.path.split('/').filter(Boolean);
    const out = [h('button.crumb', { onclick: () => this.go('/').catch(() => {}) }, '/')];
    let acc = '';
    parts.forEach((p, i) => {
      acc += '/' + p;
      const target = acc;
      if (i > 0) out.push(h('span.crumb-sep', null, '/'));
      out.push(h('button.crumb', { onclick: () => this.go(target).catch(() => {}) }, p));
    });
    this.crumbs.replaceChildren(...out);
    requestAnimationFrame(() => { this.crumbs.scrollLeft = this.crumbs.scrollWidth; });
  }

  isDir(e) { return e.type === 'd' || (e.type === 'l' && e.linkDir); }

  render() {
    this.renderCrumbs();
    const showHidden = !!this.tab.settings.showHidden;
    const items = this.entries.filter((e) => showHidden || !e.name.startsWith('.'))
      .sort((a, b) => (this.isDir(b) - this.isDir(a)) || a.name.localeCompare(b.name, 'tr', { numeric: true, sensitivity: 'base' }));
    if (!items.length) {
      this.list.replaceChildren(h('div.empty', null, h('p', null, this.entries.length ? 'Yalnızca gizli dosyalar var' : 'Klasör boş')));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const e of items) frag.append(this.row(e));
    this.list.replaceChildren(frag);
  }

  row(e) {
    const dir = this.isDir(e);
    const ic = e.type === 'l' ? (dir ? 'folder' : 'link') : dir ? 'folder' : 'file';
    const meta = dir ? formatDate(e.mtime) : `${formatSize(e.size)} · ${formatDate(e.mtime)}`;
    const r = h('div.frow' + (e.name.startsWith('.') ? '.hiddenf' : '') + (this.sel.has(e.name) ? '.sel' : ''), null,
      h('div.fic' + (dir ? '.dir' : e.type === 'l' ? '.link' : ''), null, icon(ic, 20)),
      h('div.txt', null, h('b', null, e.name), h('small', null, `${meta}  ${e.perm || ''}`)));
    let lp = null; let long = false; let sx = 0; let sy = 0;
    r.addEventListener('touchstart', (ev) => {
      long = false; sx = ev.touches[0].clientX; sy = ev.touches[0].clientY;
      lp = setTimeout(() => { long = true; try { navigator.vibrate?.(15); } catch { /* yok */ } this.toggleSel(e.name); }, 480);
    }, { passive: true });
    r.addEventListener('touchmove', (ev) => { if (Math.hypot(ev.touches[0].clientX - sx, ev.touches[0].clientY - sy) > 10) clearTimeout(lp); }, { passive: true });
    r.addEventListener('touchend', () => clearTimeout(lp));
    r.addEventListener('contextmenu', (ev) => { ev.preventDefault(); if (!('ontouchstart' in window)) this.toggleSel(e.name); });
    r.addEventListener('click', () => {
      if (long) return;
      if (this.sel.size) { this.toggleSel(e.name); return; }
      if (dir) this.go(join(this.path, e.name)).catch(() => {});
      else this.fileMenu(e);
    });
    return r;
  }

  // ---------------------------------------------------------------- seçim
  toggleSel(name) {
    if (this.sel.has(name)) this.sel.delete(name); else this.sel.add(name);
    this.updateSel();
    this.render();
  }

  clearSel(silent) {
    this.sel.clear();
    this.updateSel();
    if (!silent) this.render();
  }

  updateSel() {
    this.selbar.classList.toggle('hidden', !this.sel.size);
    this.selCount.textContent = `${this.sel.size} seçili`;
    this.fab.classList.toggle('hidden', !!this.sel.size);
  }

  async downloadSel() {
    const names = [...this.sel];
    this.clearSel();
    for (const n of names) this.download(join(this.path, n), n);
  }

  async deleteSel() {
    const names = [...this.sel];
    if (!await confirm({ title: `${names.length} öğe silinsin mi?`, message: names.slice(0, 8).join(', ') + (names.length > 8 ? ' …' : '') + '\n\nKlasörler içerikleriyle birlikte silinir.', ok: 'Sil', danger: true })) return;
    this.clearSel();
    for (const n of names) {
      try { await this.call('sftpRemove', { path: join(this.path, n) }); } catch (e) { toast(`${n}: ${e.message}`, { type: 'err' }); }
    }
    this.refresh();
  }

  // ---------------------------------------------------------------- menüler
  async menu() {
    const hidden = !!this.tab.settings.showHidden;
    const v = await actionSheet(this.path, [
      { icon: 'upload', label: 'Dosya yükle', value: 'upload' },
      { icon: 'newfolder', label: 'Yeni klasör', value: 'mkdir' },
      { icon: 'file', label: 'Yeni dosya', value: 'touch' },
      '-',
      { icon: 'terminal', label: 'Terminalin dizinine git', value: 'cwd' },
      { icon: 'home', label: 'Ev dizini', value: 'home' },
      { icon: 'search', label: 'Yola git…', value: 'goto' },
      { icon: 'eye', label: hidden ? 'Gizli dosyaları gizle' : 'Gizli dosyaları göster', value: 'hidden' },
      '-',
      { icon: 'copy', label: 'Yolu kopyala', value: 'copy' },
      { icon: 'terminal', label: 'Terminalde bu dizine geç (cd)', value: 'cd' },
    ]);
    switch (v) {
      case 'upload': return this.upload();
      case 'mkdir': {
        const n = await promptText({ title: 'Yeni klasör', placeholder: 'klasör adı', ok: 'Oluştur', validate: (x) => (!x.trim() || x.includes('/') ? 'Geçerli bir ad girin' : null) });
        if (!n) return;
        try { await this.call('sftpMkdir', { path: join(this.path, n.trim()) }); await this.refresh(); } catch (e) { toast(e.message, { type: 'err' }); }
        return;
      }
      case 'touch': {
        const n = await promptText({ title: 'Yeni dosya', placeholder: 'dosya.txt', ok: 'Oluştur', validate: (x) => (!x.trim() || x.includes('/') ? 'Geçerli bir ad girin' : null) });
        if (!n) return;
        const p = join(this.path, n.trim());
        if (this.entries.some((e) => e.name === n.trim())) { toast('Bu adda bir öğe zaten var', { type: 'err' }); return; }
        try { await this.call('sftpWrite', { path: p, text: '' }); await this.refresh(); this.edit({ name: n.trim(), size: 0 }); } catch (e) { toast(e.message, { type: 'err' }); }
        return;
      }
      case 'cwd': return this.gotoTerminalDir();
      case 'home': return this.go(await this.call('sftpHome')).catch(() => {});
      case 'goto': {
        const p = await promptText({ title: 'Yola git', value: this.path, mono: true, ok: 'Git' });
        if (p) this.go(p.trim()).catch(() => {});
        return;
      }
      case 'hidden': this.tab.saveSettings({ showHidden: !hidden }); this.render(); return;
      case 'copy': await N.call('clipboardSet', { text: this.path }); toast('Yol kopyalandı'); return;
      case 'cd': this.tab.typeInTerminal(`cd ${q(this.path)}\r`); this.tab.show('term'); return;
      default:
    }
  }

  async gotoTerminalDir() {
    try {
      const r = await this.call('exec', { cmd: `sh -c '${CWD_SCRIPT}'`, timeout: 6000 });
      const [, cwd] = r.stdout.trim().split('\n');
      if (!cwd || !cwd.startsWith('/')) throw new Error('Terminal dizini okunamadı (sunucu Linux değil ya da yetki yok)');
      await this.go(cwd);
    } catch (e) { toast(e.message, { type: 'err' }); }
  }

  async fileMenu(e) {
    const p = join(this.path, e.name);
    const img = IMG.test(e.name);
    const v = await actionSheet(e.name, [
      { icon: img ? 'eye' : 'edit', label: img ? 'Görüntüle' : 'Aç / düzenle', value: 'open' },
      { icon: 'download', label: 'İndir', value: 'download', hint: formatSize(e.size) },
      { icon: 'open', label: 'İndir ve başka uygulamada aç', value: 'openext' },
      '-',
      { icon: 'edit', label: 'Yeniden adlandır / taşı', value: 'rename' },
      { icon: 'perm', label: 'İzinler', value: 'chmod', hint: e.perm },
      { icon: 'copy', label: 'Yolu kopyala', value: 'copy' },
      { icon: 'terminal', label: 'Yolu terminale yaz', value: 'type' },
      '-',
      { icon: 'trash', label: 'Sil', value: 'delete', danger: true },
    ], `${formatSize(e.size)} · ${formatDate(e.mtime)}`);
    switch (v) {
      case 'open': return img ? this.preview(e) : this.edit(e);
      case 'download': return this.download(p, e.name);
      case 'openext': return this.download(p, e.name, true);
      case 'rename': return this.rename(e);
      case 'chmod': return this.chmod(e);
      case 'copy': await N.call('clipboardSet', { text: p }); toast('Yol kopyalandı'); return;
      case 'type': this.tab.typeInTerminal(q(p) + ' '); this.tab.show('term'); return;
      case 'delete':
        if (!await confirm({ title: 'Silinsin mi?', message: p, ok: 'Sil', danger: true })) return;
        try { await this.call('sftpRemove', { path: p }); this.refresh(); } catch (err) { toast(err.message, { type: 'err' }); }
        return;
      default:
    }
  }

  async rename(e) {
    const n = await promptText({ title: 'Yeniden adlandır', value: e.name, ok: 'Kaydet', sub: 'Başka klasöre taşımak için tam yol yazabilirsiniz', validate: (x) => (!x.trim() ? 'Ad gerekli' : null) });
    if (!n || n === e.name) return;
    const to = n.startsWith('/') ? n : join(this.path, n);
    try { await this.call('sftpRename', { from: join(this.path, e.name), to }); this.refresh(); } catch (err) { toast(err.message, { type: 'err' }); }
  }

  async chmod(e) {
    const cur = (e.mode & 0o7777).toString(8).padStart(3, '0');
    const v = await promptText({ title: 'İzinler', sub: `${e.name} — şu an ${e.perm} (${cur})`, value: cur, mono: true, ok: 'Uygula', validate: (x) => (/^[0-7]{3,4}$/.test(x.trim()) ? null : 'Sekizli değer girin (örn. 644, 755)') });
    if (!v) return;
    try { await this.call('sftpChmod', { path: join(this.path, e.name), mode: parseInt(v.trim(), 8) }); this.refresh(); } catch (err) { toast(err.message, { type: 'err' }); }
  }

  async preview(e) {
    const p = join(this.path, e.name);
    try {
      const r = await this.call('sftpRead', { path: p, max: 8 << 20, base64: true });
      if (r.tooLarge) { toast('Dosya önizleme için çok büyük; indirin', { type: 'err' }); return; }
      const ext = e.name.split('.').pop().toLowerCase();
      sheet({ title: e.name, sub: formatSize(r.size), body: h('img.preview-img', { src: `data:${MIME[ext] || 'image/*'};base64,${r.base64}` }), buttons: [{ label: 'Kapat', value: null }, { label: 'İndir', value: 'dl', primary: true }] })
        .then((v) => { if (v === 'dl') this.download(p, e.name); });
    } catch (err) { toast(err.message, { type: 'err' }); }
  }

  async edit(e) {
    const p = join(this.path, e.name);
    let r;
    try { r = await this.call('sftpRead', { path: p, max: 2 << 20 }); } catch (err) { toast(err.message, { type: 'err' }); return; }
    if (r.tooLarge) { toast('Dosya düzenleyici için çok büyük (2 MB üstü); indirin', { type: 'err' }); return; }
    if (r.binary) {
      if (await confirm({ title: 'İkili dosya', message: 'Bu bir metin dosyası değil. İndirip başka uygulamada açılsın mı?', ok: 'İndir ve aç' })) this.download(p, e.name, true);
      return;
    }
    this.tab.app.openEditor({
      title: e.name, path: p, text: r.text,
      save: async (text) => { await this.call('sftpWrite', { path: p, text }); this.refresh(); },
    });
  }

  // ---------------------------------------------------------------- aktarımlar
  download(path, name, open = false) {
    const t = uid('dl');
    this.addXfer(t, { name, dir: 'down', open });
    this.call('download', { t, path }).catch((e) => this.onXfer({ id: t, state: 'error', message: e.message }));
  }

  async upload() {
    const t = uid('ul');
    const dir = this.path;
    try {
      const names = await this.call('upload', { t, dir });
      if (!names || !names.length) return;
      this.addXfer(t, { name: names.length === 1 ? names[0] : `${names.length} dosya`, dir: 'up', target: dir });
    } catch (e) { toast(e.message, { type: 'err' }); }
  }

  addXfer(id, x) {
    x.state = 'run'; x.done = 0; x.total = 0;
    x.el = h('div.xfer');
    this.xfers.set(id, x);
    this.xferEl.prepend(x.el);
    this.xferEl.classList.remove('hidden');
    this.renderXfer(id);
  }

  renderXfer(id) {
    const x = this.xfers.get(id);
    if (!x) return;
    const pct = x.total ? Math.floor(100 * x.done / x.total) : 0;
    const label = x.state === 'run' ? `${x.dir === 'down' ? 'İndiriliyor' : 'Yükleniyor'} · ${formatSize(x.done)}${x.total ? ' / ' + formatSize(x.total) + ` (%${pct})` : ''}`
      : x.state === 'done' ? (x.dir === 'down' ? 'İndirildi → İndirilenler/SSHDeck' : 'Yüklendi')
      : x.state === 'cancelled' ? 'İptal edildi' : (x.message || 'Hata');
    const btn = x.state === 'run'
      ? h('button.tb', { onclick: () => this.call('cancelXfer', { t: id }) }, icon('x', 18))
      : x.state === 'done' && x.dir === 'down'
        ? h('button.tb', { onclick: () => this.call('openDownloaded', { t: id, name: x.file || x.name }).catch((e) => toast(e.message, { type: 'err' })) }, icon('open', 18))
        : h('button.tb', { onclick: () => this.removeXfer(id) }, icon('x', 18));
    x.el.className = 'xfer ' + x.state;
    x.el.replaceChildren(
      icon(x.dir === 'down' ? 'download' : 'upload', 18),
      h('div.txt', null, h('b', null, x.file && x.file !== x.name ? `${x.name} — ${x.file}` : x.name), h('small', null, label),
        x.state === 'run' ? h('div.bar', null, h('i', { style: { width: pct + '%' } })) : null),
      btn);
  }

  removeXfer(id) {
    const x = this.xfers.get(id);
    if (!x) return;
    x.el.remove();
    this.xfers.delete(id);
    if (!this.xfers.size) this.xferEl.classList.add('hidden');
  }

  onXfer(ev) {
    const x = this.xfers.get(ev.id);
    if (!x) return false;
    x.state = ev.state; x.done = ev.done || x.done; x.total = ev.total || x.total; x.message = ev.message;
    if (ev.file && !x.file) x.file = ev.file.split('/').pop();
    this.renderXfer(ev.id);
    if (ev.state === 'done') {
      if (x.dir === 'up' && x.target === this.path) this.refresh();
      if (x.dir === 'down' && x.open) this.call('openDownloaded', { t: ev.id, name: x.file || x.name }).catch((e) => toast(e.message, { type: 'err' }));
      else if (x.dir === 'down') toast(`${x.name} indirildi (İndirilenler/SSHDeck)`, { type: 'ok' });
      setTimeout(() => this.removeXfer(ev.id), 20000);
    } else if (ev.state === 'error') {
      toast(`${x.name}: ${ev.message}`, { type: 'err' });
    } else if (ev.state === 'cancelled') {
      setTimeout(() => this.removeXfer(ev.id), 3000);
    }
    return true;
  }

  /** Bağlantı koptu: devam eden aktarımlar hata olarak işaretlenir. */
  connLost() {
    for (const [id, x] of this.xfers) if (x.state === 'run') { x.state = 'error'; x.message = 'Bağlantı koptu'; this.renderXfer(id); }
  }
}
