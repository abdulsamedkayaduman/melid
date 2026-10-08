import { h, icon, formatSize, formatDate, permString, uid } from './util.js';
import { contextMenu, promptText, confirmBox, toast, modal } from './dialogs.js';

// Native (OS) drag started from a pane: { pane, items }. The OS only carries file paths,
// so drops inside the app look up the original items here. Cleared once the mouse is free again.
let outDrag = null;
document.addEventListener('mousemove', (e) => { if (!e.buttons) outDrag = null; }, true);

/**
 * One side of the Xftp-style dual pane. `adapter` abstracts local vs remote filesystem.
 * adapter: { list, home, join, dirname, mkdir, rename, remove, resolve?, label }
 */
export class FilePane {
  constructor({ side, adapter, api, settings, onTransfer, onExtraMenu, onOpenFile, onColResize, extraTools }) {
    this.side = side;
    this.ad = adapter;
    this.api = api;
    this.settings = settings;
    this.onTransfer = onTransfer; // (fromSide, items[{path,name,isDir}], destDir) => void
    this.onExtraMenu = onExtraMenu; // (entries) => items[]
    this.onOpenFile = onOpenFile; // (entry) => void   (double click on file)
    this.onColResize = onColResize; // (widths {key: px}) => void
    this.colW = { ...(settings.colWidths || {}) };
    this.extraTools = extraTools || []; // extra header buttons
    this.cwd = null;
    this.entries = [];
    this.sel = new Set();
    this.anchor = null;
    this.sortKey = 'name';
    this.sortDir = 1;
    this.showHidden = !!settings.showHidden;
    this.filter = '';
    this.history = [];
    this.loading = false;
    this.build();
  }

  build() {
    this.pathInput = h('input.path-input', {
      spellcheck: false,
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.cd(this.pathInput.value.trim()); } else if (e.key === 'Escape') { this.pathInput.value = this.cwd || ''; this.body.focus(); } },
      onfocus: () => this.pathInput.select(),
    });
    this.filterInput = h('input.filter-input', {
      placeholder: 'Süz…', spellcheck: false, title: 'Bu dizindeki öğeleri süz (Ctrl+F)',
      oninput: () => { this.filter = this.filterInput.value; this.render(); },
      onkeydown: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); this.setFilter(''); this.body.focus(); }
        else if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          const first = (this.vis || [])[0];
          if (first) { this.sel = new Set([first.name]); this.anchor = first.name; this.paintSel(); }
          this.body.focus();
          if (e.key === 'Enter' && first && (this.vis || []).length === 1) this.activate(first);
        }
      },
    });
    const tb = (ic, title, fn, extra) => h('button.icon-btn', { title, onclick: fn, ...extra }, icon(ic, 15));
    this.hiddenBtn = tb('eye', 'Gizli dosyaları göster/gizle', () => { this.showHidden = !this.showHidden; this.hiddenBtn.classList.toggle('on', this.showHidden); this.render(); });
    this.hiddenBtn.classList.toggle('on', this.showHidden);
    this.titleEl = h('span.pane-title', null, this.ad.label);
    this.head = h('div.pane-head', null,
      h('div.pane-tools', null, this.titleEl,
        tb('up', 'Üst dizin (Backspace)', () => this.up()),
        tb('home', 'Ev dizini', () => this.goHome()),
        tb('refresh', 'Yenile (F5)', () => this.refresh()),
        tb('newfolder', 'Yeni klasör', () => this.newFolder()),
        this.hiddenBtn, ...this.extraTools),
      h('div.path-row', null, this.pathInput, this.filterInput));

    const last = this.side === 'remote' ? 'owner' : 'mode';
    const col = (key, label, cls) => {
      const th = h('th.' + cls, { dataset: { key }, onclick: () => { if (!this._colDrag) this.sortBy(key); } }, label, h('span.sort'));
      if (key !== last) {
        const grip = h('span.col-grip', { title: 'Sürükleyerek sütunu boyutlandır' });
        grip.addEventListener('mousedown', (e) => this.startColResize(e, th));
        th.append(grip);
      }
      return th;
    };
    this.thead = h('thead', null, h('tr', null,
      col('name', 'Ad', 'c-name'), col('size', 'Boyut', 'c-size'), col('mtime', 'Değiştirilme', 'c-date'),
      col('mode', 'İzinler', 'c-perm'), this.side === 'remote' ? col('owner', 'Sahip', 'c-owner') : null));
    this.applyColWidths(this.colW);
    this.tbody = h('tbody');
    this.table = h('table.files', null, this.thead, this.tbody);
    this.empty = h('div.pane-empty');
    this.body = h('div.pane-body', { tabindex: 0 }, this.table, this.empty);
    this.foot = h('div.pane-foot');
    this.el = h('div.pane', { dataset: { side: this.side } }, this.head, this.body, this.foot);

    this.body.addEventListener('keydown', (e) => this.onKey(e));
    this.body.addEventListener('mousedown', (e) => { if (e.target === this.body || e.target === this.empty) { this.sel.clear(); this.paintSel(); } });
    this.body.addEventListener('contextmenu', (e) => { if (!e.target.closest('tr[data-name]')) { e.preventDefault(); this.sel.clear(); this.paintSel(); this.menu(e.clientX, e.clientY, []); } });

    // drop target: whole pane body = current dir
    this.body.addEventListener('dragover', (e) => {
      if (!this.acceptsDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const row = e.target.closest('tr[data-name]');
      const target = row && this.entryByName(row.dataset.name);
      this.setDropHi(target && target.isDir ? row : null);
      this.body.classList.add('drop');
    });
    this.body.addEventListener('dragleave', (e) => { if (!this.body.contains(e.relatedTarget)) { this.body.classList.remove('drop'); this.setDropHi(null); } });
    this.body.addEventListener('drop', (e) => this.onDrop(e));
  }

  setDropHi(row) {
    if (this._dropRow && this._dropRow !== row) this._dropRow.classList.remove('drop-into');
    this._dropRow = row;
    if (row) row.classList.add('drop-into');
  }

  acceptsDrag(e) {
    if (outDrag && outDrag.pane === this.peer) return true;
    if (outDrag && outDrag.pane === this) return false;
    return this.side === 'remote' && [...e.dataTransfer.types].includes('Files');
  }

  onDrop(e) {
    this.body.classList.remove('drop');
    const row = this._dropRow; this.setDropHi(null);
    if (!this.acceptsDrag(e)) return;
    e.preventDefault();
    let dest = this.cwd;
    if (row) { const t = this.entryByName(row.dataset.name); if (t && t.isDir) dest = this.ad.join(this.cwd, t.name); }
    const d = outDrag; outDrag = null;
    if (d && d.pane === this.peer) {
      this.onTransfer(d.pane.side, d.items, dest);
    } else if (e.dataTransfer.files.length) {
      const items = [...e.dataTransfer.files].map((f) => { const p = this.api.pathForFile(f); return { path: p, name: p.split('/').pop() }; }).filter((x) => x.path);
      if (items.length) this.onTransfer('local', items, dest);
    }
  }

  async startNativeDrag(items) {
    if (!items.length) return;
    outDrag = { pane: this, items };
    if (this.side === 'local') { this.api.drag.start(items.map((it) => it.path)); return; }
    // remote: download to a temp dir while the button is held, then hand the copies to the OS
    const tid = uid('drag');
    let released = false;
    const up = () => { released = true; this.ad.cancelDrag(tid).catch(() => {}); };
    document.addEventListener('mouseup', up, { once: true });
    const slow = setTimeout(() => toast('Sürükleme için indiriliyor… Fareyi bırakmayın.'), 400);
    try {
      const files = await this.ad.prepareDrag(tid, items);
      if (files && !released && outDrag && outDrag.pane === this) this.api.drag.start(files);
    } catch (err) {
      if (!released) toast(cleanErr(err), 'err');
    } finally {
      clearTimeout(slow);
      document.removeEventListener('mouseup', up);
    }
  }

  entryByName(n) { return this.entries.find((e) => e.name === n); }

  selected() { return this.entries.filter((e) => this.sel.has(e.name)); }

  itemsFor(entries) { return entries.map((e) => ({ path: this.ad.join(this.cwd, e.name), name: e.name, isDir: e.isDir })); }

  // ------------------------------------------------ navigation
  async goHome() { await this.cd(await this.ad.home()); }

  async up() { if (this.cwd && this.cwd !== '/') await this.cd(this.ad.dirname(this.cwd), this.ad.basename(this.cwd)); }

  async cd(dir, focusName) {
    if (!dir) return;
    if (this.ad.resolve) dir = await this.ad.resolve(dir);
    this.loading = true;
    this.el.classList.add('loading');
    try {
      const list = await this.ad.list(dir);
      if (dir !== this.cwd) { this.filter = ''; this.filterInput.value = ''; }
      this.cwd = dir;
      this.entries = list;
      this.sel.clear();
      if (focusName) { this.sel.add(focusName); this.anchor = focusName; }
      this.pathInput.value = dir;
      this.render();
      if (focusName) this.scrollTo(focusName);
      else this.body.scrollTop = 0;
    } catch (e) {
      toast(`${dir}: ${cleanErr(e)}`, 'err');
      this.pathInput.value = this.cwd || '';
    } finally {
      this.loading = false;
      this.el.classList.remove('loading');
    }
  }

  async refresh() {
    if (!this.cwd) return;
    const keep = new Set(this.sel);
    const top = this.body.scrollTop;
    try {
      this.entries = await this.ad.list(this.cwd);
      this.sel = new Set([...keep].filter((n) => this.entryByName(n)));
      this.render();
      this.body.scrollTop = top;
    } catch (e) { toast(cleanErr(e), 'err'); }
  }

  // ------------------------------------------------ render
  // "Ad" sütunu kalan genişliği alır; onun tutamacı sağındaki sütunu küçültüp büyütür.
  startColResize(e, th) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const ths = [...this.thead.querySelectorAll('th')].filter((x) => x.offsetWidth > 0);
    const i = ths.indexOf(th);
    const target = th.dataset.key === 'name' ? ths[i + 1] : th;
    if (!target) return;
    const sign = target === th ? 1 : -1;
    const startX = e.clientX;
    const startW = target.offsetWidth;
    const others = ths.reduce((a, x) => a + (x === target || x.dataset.key === 'name' ? 0 : x.offsetWidth), 0);
    const maxW = Math.max(40, this.table.offsetWidth - others - 110);
    this._colDrag = true;
    const move = (ev) => {
      const w = Math.round(Math.min(maxW, Math.max(40, startW + sign * (ev.clientX - startX))));
      this.colW[target.dataset.key] = w;
      target.style.width = w + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-h');
      setTimeout(() => { this._colDrag = false; }, 0); // mouseup'tan sonraki click sıralama yapmasın
      this.onColResize?.({ ...this.colW });
    };
    document.body.classList.add('resizing-h');
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }

  applyColWidths(widths) {
    this.colW = { ...widths };
    for (const th of this.thead.querySelectorAll('th')) {
      const w = this.colW[th.dataset.key];
      th.style.width = th.dataset.key !== 'name' && w ? w + 'px' : '';
    }
  }

  sortBy(key) {
    if (this.sortKey === key) this.sortDir = -this.sortDir; else { this.sortKey = key; this.sortDir = key === 'mtime' || key === 'size' ? -1 : 1; }
    this.render();
  }

  visible() {
    const k = this.sortKey; const d = this.sortDir;
    const coll = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });
    const q = this.filter.trim().toLocaleLowerCase('tr');
    return this.entries
      .filter((e) => this.showHidden || !e.name.startsWith('.'))
      .filter((e) => !q || e.name.toLocaleLowerCase('tr').includes(q))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        let r;
        if (k === 'name') r = coll.compare(a.name, b.name);
        else if (k === 'owner') r = coll.compare(a.owner || '', b.owner || '');
        else r = (a[k] || 0) - (b[k] || 0);
        return (r || coll.compare(a.name, b.name)) * d;
      });
  }

  render() {
    for (const th of this.thead.querySelectorAll('th')) {
      th.classList.toggle('sorted', th.dataset.key === this.sortKey);
      th.querySelector('.sort').textContent = th.dataset.key === this.sortKey ? (this.sortDir > 0 ? '▲' : '▼') : '';
    }
    const vis = this.visible();
    this.vis = vis;
    const frag = document.createDocumentFragment();
    if (this.cwd && this.cwd !== '/') {
      frag.append(h('tr.parent', { ondblclick: () => this.up() }, h('td.c-name', null, h('span.fname', null, icon('up', 14), h('span', null, '..'))), h('td'), h('td'), h('td'), this.side === 'remote' ? h('td') : null));
    }
    for (const e of vis) {
      const ic = e.isDir ? 'folder' : e.isLink ? 'link' : 'file';
      const tr = h('tr', { dataset: { name: e.name }, draggable: 'true', class: (e.isDir ? 'dir' : '') + (e.name.startsWith('.') ? ' hidden-file' : '') },
        h('td.c-name', { title: e.name }, h('span.fname', null, icon(ic, 14), h('span', null, e.name), e.isLink ? h('span.link-tag', null, '↪') : null)),
        h('td.c-size', null, e.isDir ? '' : formatSize(e.size)),
        h('td.c-date', null, formatDate(e.mtime)),
        h('td.c-perm.mono', null, permString(e.mode, e.isDir, e.isLink)),
        this.side === 'remote' ? h('td.c-owner', null, `${e.owner}:${e.group}`) : null);
      tr.addEventListener('mousedown', (ev) => this.onRowDown(ev, e.name));
      tr.addEventListener('dblclick', () => this.activate(e));
      tr.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        if (!this.sel.has(e.name)) { this.sel = new Set([e.name]); this.anchor = e.name; this.paintSel(); }
        this.menu(ev.clientX, ev.clientY, this.selected());
      });
      tr.addEventListener('dragstart', (ev) => {
        // native drag instead of HTML5 so files can also be dropped into the file manager
        ev.preventDefault();
        if (!this.sel.has(e.name)) { this.sel = new Set([e.name]); this.paintSel(); }
        this.startNativeDrag(this.itemsFor(this.selected()));
      });
      frag.append(tr);
    }
    this.tbody.replaceChildren(frag);
    this.empty.textContent = vis.length ? '' : this.filter.trim() ? 'Süzgeçle eşleşen öğe yok' : (this.entries.length ? 'Yalnızca gizli dosyalar var' : 'Klasör boş');
    this.filterInput.classList.toggle('on', !!this.filter.trim());
    this.paintSel();
  }

  paintSel() {
    for (const tr of this.tbody.children) if (tr.dataset.name) tr.classList.toggle('sel', this.sel.has(tr.dataset.name));
    const selEntries = this.selected();
    const size = selEntries.reduce((a, e) => a + (e.isDir ? 0 : e.size), 0);
    const nv = (this.vis || []).length;
    this.foot.textContent = selEntries.length
      ? `${selEntries.length} / ${nv} seçili${size ? ' · ' + formatSize(size) : ''}`
      : `${nv} öğe`;
  }

  scrollTo(name) {
    const tr = [...this.tbody.children].find((r) => r.dataset.name === name);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }

  onRowDown(ev, name) {
    if (ev.button === 2) return;
    this.body.focus({ preventScroll: true });
    const names = this.vis.map((e) => e.name);
    if (ev.shiftKey && this.anchor && names.includes(this.anchor)) {
      const [a, b] = [names.indexOf(this.anchor), names.indexOf(name)].sort((x, y) => x - y);
      if (!ev.ctrlKey) this.sel.clear();
      for (let i = a; i <= b; i++) this.sel.add(names[i]);
    } else if (ev.ctrlKey || ev.metaKey) {
      if (this.sel.has(name)) this.sel.delete(name); else this.sel.add(name);
      this.anchor = name;
    } else if (!this.sel.has(name)) {
      this.sel = new Set([name]);
      this.anchor = name;
    } else {
      // keep multi-selection for drag; collapse on mouseup without drag
      const up = () => { if (!this._dragged) { this.sel = new Set([name]); this.anchor = name; this.paintSel(); } document.removeEventListener('mouseup', up); };
      this._dragged = false;
      document.addEventListener('mouseup', up);
      document.addEventListener('dragstart', () => { this._dragged = true; }, { once: true });
    }
    this.paintSel();
  }

  activate(e) {
    if (e.isDir) this.cd(this.ad.join(this.cwd, e.name));
    else if (this.onOpenFile) this.onOpenFile(e);
  }

  onKey(e) {
    const names = (this.vis || []).map((x) => x.name);
    const cur = this.anchor && names.includes(this.anchor) ? names.indexOf(this.anchor) : -1;
    const move = (i) => {
      i = Math.max(0, Math.min(names.length - 1, i));
      if (!names.length) return;
      if (e.shiftKey && cur >= 0) this.sel.add(names[i]); else this.sel = new Set([names[i]]);
      this.anchor = names[i];
      this.paintSel(); this.scrollTo(names[i]);
    };
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); move(cur + 1); }
    else if (k === 'ArrowUp') { e.preventDefault(); move(cur - 1); }
    else if (k === 'Home') { e.preventDefault(); move(0); }
    else if (k === 'End') { e.preventDefault(); move(names.length - 1); }
    else if (k === 'PageDown') { e.preventDefault(); move(cur + 15); }
    else if (k === 'PageUp') { e.preventDefault(); move(cur - 15); }
    else if (k === 'Enter') { e.preventDefault(); const s = this.selected(); if (s.length === 1) this.activate(s[0]); else if (s.length) this.transferSelection(); }
    else if (k === 'Backspace') { e.preventDefault(); this.up(); }
    else if (k === 'F5') { e.preventDefault(); this.refresh(); }
    else if (k === 'F2') { e.preventDefault(); const s = this.selected(); if (s.length === 1) this.rename(s[0]); }
    else if (k === 'Delete') { e.preventDefault(); this.remove(this.selected()); }
    else if (k === 'a' && e.ctrlKey) { e.preventDefault(); this.sel = new Set(names); this.paintSel(); }
    else if (k === 'l' && e.ctrlKey) { e.preventDefault(); this.pathInput.focus(); }
    else if (k === 'f' && e.ctrlKey && !e.shiftKey) { e.preventDefault(); this.filterInput.focus(); this.filterInput.select(); }
    else if (k === 'Escape' && this.filter) { e.preventDefault(); this.setFilter(''); }
    else if (k === ' ' && !this._ta && !e.ctrlKey) { e.preventDefault(); const s = this.selected(); if (s.length === 1 && !s[0].isDir) this.preview(s[0]); }
    else if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // type-ahead
      clearTimeout(this._taT);
      this._ta = (this._ta || '') + k.toLowerCase();
      this._taT = setTimeout(() => { this._ta = ''; }, 800);
      const i = names.findIndex((n) => n.toLowerCase().startsWith(this._ta));
      if (i >= 0) { this.sel = new Set([names[i]]); this.anchor = names[i]; this.paintSel(); this.scrollTo(names[i]); }
    }
  }

  setFilter(v) { this.filter = v; this.filterInput.value = v; this.render(); }

  // ------------------------------------------------ actions
  async preview(e) {
    if (!this.ad.preview || e.isDir) return;
    const p = this.ad.join(this.cwd, e.name);
    let r;
    this.el.classList.add('loading');
    try { r = await this.ad.preview(p); } catch (err) { toast(`${e.name}: ${cleanErr(err)}`, 'err'); return; } finally { this.el.classList.remove('loading'); }
    let body;
    if (r.kind === 'image') body = h('div.preview-img', null, h('img', { src: r.dataUrl, alt: e.name }));
    else if (r.kind === 'text') {
      body = h('div', null,
        h('pre.preview-text', null, r.text || ' '),
        r.truncated ? h('p.hint', null, `Dosyanın yalnızca ilk ${formatSize(r.text.length)} kısmı gösteriliyor (toplam ${formatSize(r.size)}).`) : null);
    } else {
      body = h('p.muted', null, r.kind === 'too-big' ? `Resim önizleme için çok büyük (${formatSize(r.size)}).` : `İkili dosya, önizlenemez (${formatSize(r.size)}).`);
    }
    const act = await modal({
      title: `${e.name} · ${formatSize(r.size)}`,
      width: r.kind === 'text' || r.kind === 'image' ? 'min(900px, calc(100vw - 60px))' : 440,
      cls: 'preview-modal',
      body,
      buttons: [
        this.onOpenFile ? { label: this.side === 'local' ? 'Yükle' : 'İndir', value: 'transfer' } : null,
        { label: 'Kapat', value: null, primary: true },
      ].filter(Boolean),
    });
    if (act === 'transfer') this.onTransfer(this.side, this.itemsFor([e]), null);
    this.body.focus();
  }

  transferSelection() {
    const s = this.selected();
    if (s.length) this.onTransfer(this.side, this.itemsFor(s), null);
  }

  async newFolder() {
    const name = await promptText({ title: 'Yeni klasör', label: `${this.cwd} içinde`, value: 'yeni-klasor' });
    if (!name) return;
    try { await this.ad.mkdir(this.ad.join(this.cwd, name)); await this.refresh(); this.sel = new Set([name]); this.anchor = name; this.paintSel(); this.scrollTo(name); } catch (e) { toast(cleanErr(e), 'err'); }
  }

  async rename(e) {
    const name = await promptText({ title: 'Yeniden adlandır', label: e.name, value: e.name });
    if (!name || name === e.name) return;
    try { await this.ad.rename(this.ad.join(this.cwd, e.name), this.ad.join(this.cwd, name)); await this.refresh(); this.sel = new Set([name]); this.anchor = name; this.paintSel(); } catch (err) { toast(cleanErr(err), 'err'); }
  }

  async remove(list) {
    if (!list.length) return;
    const names = list.map((e) => e.name + (e.isDir ? '/' : ''));
    const where = this.side === 'local' ? 'Çöp kutusuna taşınacak.' : 'Sunucudan kalıcı olarak silinecek.';
    const ok = await confirmBox({
      title: 'Sil',
      message: list.length === 1 ? `“${names[0]}” silinsin mi?` : `${list.length} öğe silinsin mi?`,
      detail: h('div', null, h('p', null, where), list.length > 1 ? h('div.name-list', null, names.slice(0, 12).join('\n') + (names.length > 12 ? `\n… +${names.length - 12}` : '')) : null),
      ok: 'Sil', danger: true,
    });
    if (!ok) return;
    for (const e of list) {
      try { await this.ad.remove(this.ad.join(this.cwd, e.name)); } catch (err) { toast(`${e.name}: ${cleanErr(err)}`, 'err'); }
    }
    this.sel.clear();
    await this.refresh();
  }

  menu(x, y, sel) {
    const one = sel.length === 1 ? sel[0] : null;
    const other = this.side === 'local' ? 'Yükle' : 'İndir';
    const items = [
      sel.length ? { label: `${other}${sel.length > 1 ? ` (${sel.length})` : ''}`, icon: this.side === 'local' ? 'upload' : 'download', hint: sel.length > 1 ? 'Enter' : null, action: () => this.transferSelection() } : null,
      one && one.isDir ? { label: 'Aç', icon: 'folder', action: () => this.activate(one) } : null,
      one && !one.isDir && this.ad.preview ? { label: 'Önizle', icon: 'eye', hint: 'Boşluk', action: () => this.preview(one) } : null,
      ...(this.onExtraMenu ? this.onExtraMenu(sel) : []),
      sel.length ? '-' : null,
      one ? { label: 'Yeniden adlandır', icon: 'edit', hint: 'F2', action: () => this.rename(one) } : null,
      sel.length ? { label: 'Sil', icon: 'trash', hint: 'Del', danger: true, action: () => this.remove(sel) } : null,
      one ? { label: 'Yolu kopyala', icon: 'file', action: () => this.api.clipboard.write(this.ad.join(this.cwd, one.name)) } : { label: 'Bu dizinin yolunu kopyala', icon: 'file', action: () => this.api.clipboard.write(this.cwd) },
      '-',
      { label: 'Yeni klasör', icon: 'newfolder', action: () => this.newFolder() },
      { label: 'Yenile', icon: 'refresh', hint: 'F5', action: () => this.refresh() },
    ];
    contextMenu(x, y, items);
  }
}

export function cleanErr(e) {
  const m = (e && e.message) || String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^Error: /, '');
}
