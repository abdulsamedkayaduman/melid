import { h, icon, uid, formatSize } from './util.js';
import { FilePane, cleanErr } from './filepane.js';
import { contextMenu, modal, toast, promptText, THEMES } from './dialogs.js';

const posix = {
  join: (a, b) => (a === '/' ? '/' + b : a.replace(/\/+$/, '') + '/' + b),
  dirname: (p) => { const s = p.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); },
  basename: (p) => p.replace(/\/+$/, '').split('/').pop(),
  normalize: (p) => {
    const out = [];
    for (const seg of p.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') out.pop(); else out.push(seg); }
    return '/' + out.join('/');
  },
};
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

export class SessionTab {
  constructor(app, { sessionId, quick, title }) {
    this.app = app;
    this.api = app.api;
    this.id = uid('tab');
    this.sessionId = sessionId || null;
    this.quick = quick || null;
    this.title = title;
    this.connId = null;
    this.state = 'idle';
    this.statusText = '';
    this.fwState = new Map(); // fid -> {state, msg}
    this.adhocForwards = [];
    this.transfers = new Map();
    this.sftpVisible = app.settings.sftpPanel !== false;
    this.localInitialized = false;
    this.build();
  }

  get session() { return this.sessionId ? this.app.sessions.find((s) => s.id === this.sessionId) : null; }

  // ------------------------------------------------------------ build UI
  build() {
    const st = this.app.settings;
    this.term = new window.Terminal({
      fontFamily: st.fontFamily,
      fontSize: st.fontSize,
      scrollback: st.scrollback,
      cursorBlink: st.cursorBlink,
      theme: THEMES[st.theme] || THEMES['deck-dark'],
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      smoothScrollDuration: 0,
    });
    this.fit = new window.FitAddon.FitAddon();
    this.search = new window.SearchAddon.SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new window.WebLinksAddon.WebLinksAddon((ev, uri) => { if (ev.ctrlKey || ev.metaKey) this.api.openExternal(uri); }));

    this.termHost = h('div.term-host');
    this.searchInput = h('input.input.sm', {
      placeholder: 'Terminalde ara…',
      oninput: () => this.search.findNext(this.searchInput.value, { incremental: true }),
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) this.search.findPrevious(this.searchInput.value); else this.search.findNext(this.searchInput.value); }
        if (e.key === 'Escape') { e.preventDefault(); this.toggleSearch(false); }
      },
    });
    this.searchBar = h('div.term-search', null, icon('search', 14), this.searchInput,
      h('button.icon-btn', { title: 'Önceki (Shift+Enter)', onclick: () => this.search.findPrevious(this.searchInput.value) }, '▲'),
      h('button.icon-btn', { title: 'Sonraki (Enter)', onclick: () => this.search.findNext(this.searchInput.value) }, '▼'),
      h('button.icon-btn', { title: 'Kapat', onclick: () => this.toggleSearch(false) }, icon('x', 14)));
    this.termWrap = h('div.term-wrap', null, this.termHost, this.searchBar);

    // file panes
    const self = this;
    const cid = () => { if (!this.connId || this.state !== 'connected') throw new Error('Bağlı değil'); return this.connId; };
    this.remote = new FilePane({
      side: 'remote', api: this.api, settings: st,
      adapter: {
        label: 'Uzak',
        list: (d) => this.api.sftp.list(cid(), d),
        home: () => this.api.sftp.home(cid()),
        join: posix.join, dirname: posix.dirname, basename: posix.basename,
        mkdir: (p) => this.api.sftp.mkdir(cid(), p),
        rename: (a, b) => this.api.sftp.rename(cid(), a, b),
        remove: (p) => this.api.sftp.remove(cid(), p),
        resolve: async (p) => (p.startsWith('/') ? posix.normalize(p) : this.api.sftp.realpath(cid(), p.replace(/^~\/?/, '') || '.')),
      },
      onTransfer: (from, items, dest) => this.transfer(from, items, dest),
      onOpenFile: (e) => this.transfer('remote', this.remote.itemsFor([e]), null),
      onExtraMenu: (sel) => {
        const one = sel.length === 1 ? sel[0] : null;
        return [
          one && !one.isDir ? { label: 'Düzenle (varsayılan uygulamayla)', icon: 'edit', action: () => this.editRemote(one) } : null,
          { label: 'Terminalde bu dizine git', icon: 'terminal', action: () => this.cdInTerminal(one && one.isDir ? posix.join(this.remote.cwd, one.name) : this.remote.cwd) },
          one ? { label: 'İzinler (chmod)…', icon: 'key', action: () => this.chmod(one) } : null,
        ];
      },
    });
    this.local = new FilePane({
      side: 'local', api: this.api, settings: st,
      adapter: {
        label: 'Yerel',
        list: (d) => this.api.local.list(d),
        home: async () => this.app.home,
        join: posix.join, dirname: posix.dirname, basename: posix.basename,
        mkdir: (p) => this.api.local.mkdir(p),
        rename: (a, b) => this.api.local.rename(a, b),
        remove: (p) => this.api.local.remove(p),
        resolve: (p) => this.api.local.resolve(p),
      },
      onTransfer: (from, items, dest) => this.transfer(from, items, dest),
      onOpenFile: (e) => this.transfer('local', this.local.itemsFor([e]), null),
      onExtraMenu: (sel) => {
        const one = sel.length === 1 ? sel[0] : null;
        return [
          one && !one.isDir ? { label: 'Aç', icon: 'file', action: () => this.api.local.open(posix.join(this.local.cwd, one.name)) } : null,
          { label: 'Dosya yöneticisinde göster', icon: 'folder', action: () => this.api.local.reveal(one ? posix.join(this.local.cwd, one.name) : this.local.cwd) },
        ];
      },
    });

    this.xferList = h('div.xfer-list');
    this.xferHead = h('div.xfer-head', null,
      h('span.xfer-title', null, 'Aktarımlar'),
      h('span.xfer-count'),
      h('button.link-btn', { onclick: () => this.clearFinished() }, 'Bitenleri temizle'));
    this.xfers = h('div.xfers.empty', null, this.xferHead, this.xferList);

    this.paneSplit = h('div.vsplit');
    this.panes = h('div.panes', null, this.local.el, this.paneSplit, this.remote.el);
    this.sftp = h('div.sftp', null, this.panes, this.xfers);
    this.splitter = h('div.hsplit', { title: 'Sürükleyerek boyutlandır' });
    this.el = h('div.tab-view', null, this.termWrap, this.splitter, this.sftp);
    this.applySftpLayout();
    this.initSplitters();

    this.term.onData((d) => this.onTermInput(d));
    this.term.onBinary((d) => this.onTermInput(d));
    this.term.onResize(({ cols, rows }) => { if (this.state === 'connected') this.api.ssh.resize(this.connId, cols, rows); this.app.updateStatus(); });
    this.term.onSelectionChange(() => {
      if (this.app.settings.copyOnSelect && this.term.hasSelection()) this.api.clipboard.write(this.term.getSelection());
    });
    this.term.attachCustomKeyEventHandler((e) => this.onTermKey(e));
    this.termHost.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.app.settings.rightClickPaste && !e.shiftKey) { this.paste(); return; }
      this.termMenu(e.clientX, e.clientY);
    });
    this.ro = new ResizeObserver(() => this.scheduleFit());
    this.ro.observe(this.termHost);
  }

  initSplitters() {
    this.splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = this.el.getBoundingClientRect();
      const move = (ev) => {
        const pct = Math.min(80, Math.max(15, ((rect.bottom - ev.clientY) / rect.height) * 100));
        this.app.settings.sftpHeight = pct;
        this.applySftpLayout();
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing-v'); this.app.saveSettings({ sftpHeight: this.app.settings.sftpHeight }); };
      document.body.classList.add('resizing-v');
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    this.paneSplit.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = this.panes.getBoundingClientRect();
      const move = (ev) => {
        const pct = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
        this.local.el.style.flexBasis = pct + '%';
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing-h'); };
      document.body.classList.add('resizing-h');
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  applySftpLayout() {
    this.sftp.style.display = this.sftpVisible ? '' : 'none';
    this.splitter.style.display = this.sftpVisible ? '' : 'none';
    this.sftp.style.height = (this.app.settings.sftpHeight || 38) + '%';
  }

  toggleSftp(v) {
    this.sftpVisible = v === undefined ? !this.sftpVisible : v;
    this.applySftpLayout();
    if (this.sftpVisible && this.state === 'connected' && !this.remote.cwd) this.initRemotePane();
    this.scheduleFit();
  }

  scheduleFit() {
    if (this._fitRaf) return;
    this._fitRaf = requestAnimationFrame(() => {
      this._fitRaf = null;
      if (!this.el.isConnected || this.el.offsetParent === null || !this.termHost.clientWidth) return;
      try { this.fit.fit(); } catch {}
    });
  }

  applySettings() {
    const st = this.app.settings;
    this.term.options.fontFamily = st.fontFamily;
    this.term.options.fontSize = st.fontSize;
    this.term.options.scrollback = st.scrollback;
    this.term.options.cursorBlink = st.cursorBlink;
    this.term.options.theme = THEMES[st.theme] || THEMES['deck-dark'];
    this.termHost.style.background = this.term.options.theme.background;
    if (this.local.showHidden !== st.showHidden) { this.local.showHidden = this.remote.showHidden = st.showHidden; this.local.hiddenBtn.classList.toggle('on', st.showHidden); this.remote.hiddenBtn.classList.toggle('on', st.showHidden); this.local.render(); this.remote.render(); }
    this.scheduleFit();
  }

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    this.termHost.style.background = this.term.options.theme.background;
    this.term.open(this.termHost);
    this.scheduleFit();
  }

  focus() { this.mount(); this.scheduleFit(); setTimeout(() => this.term.focus(), 0); }

  // ------------------------------------------------------------ terminal I/O
  onTermInput(d) {
    if (this.state === 'connected') { this.api.ssh.write(this.connId, d); return; }
    if ((this.state === 'closed' || this.state === 'error') && d === '\r') this.connect();
  }

  onTermKey(e) {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && k === 'c') { if (this.term.hasSelection()) this.api.clipboard.write(this.term.getSelection()); return false; }
    if (e.ctrlKey && e.shiftKey && k === 'v') { this.paste(); return false; }
    if (e.ctrlKey && e.shiftKey && k === 'f') { this.toggleSearch(true); return false; }
    if (e.shiftKey && e.key === 'Insert') { this.paste(); return false; }
    if (this.app.isAppShortcut(e)) return false;
    return true;
  }

  async paste() {
    const t = await this.api.clipboard.read();
    if (t) this.term.paste(t);
    this.term.focus();
  }

  toggleSearch(show) {
    this.searchBar.classList.toggle('on', show);
    if (show) { const s = this.term.getSelection(); if (s && !s.includes('\n')) this.searchInput.value = s; this.searchInput.focus(); this.searchInput.select(); }
    else { this.search.clearDecorations?.(); this.term.focus(); }
  }

  termMenu(x, y) {
    const connected = this.state === 'connected';
    contextMenu(x, y, [
      { label: 'Kopyala', icon: 'file', hint: 'Ctrl+Shift+C', disabled: !this.term.hasSelection(), action: () => this.api.clipboard.write(this.term.getSelection()) },
      { label: 'Yapıştır', icon: 'file', hint: 'Ctrl+Shift+V', action: () => this.paste() },
      { label: 'Tümünü seç', icon: 'file', action: () => this.term.selectAll() },
      '-',
      { label: 'Ara', icon: 'search', hint: 'Ctrl+Shift+F', action: () => this.toggleSearch(true) },
      { label: 'Ekranı temizle', icon: 'x', action: () => this.term.clear() },
      '-',
      { label: 'Tüneller…', icon: 'tunnel', disabled: !connected, action: () => this.tunnelsDialog() },
      connected ? { label: 'Bağlantıyı kes', icon: 'stop', danger: true, action: () => this.disconnect() }
        : { label: 'Yeniden bağlan', icon: 'play', action: () => this.connect() },
    ]);
  }

  info(msg, color = '90') { this.term.write(`\r\n\x1b[${color}m${msg}\x1b[0m`); }

  // ------------------------------------------------------------ connection
  setState(state, text) {
    this.state = state;
    if (text !== undefined) this.statusText = text;
    this.app.onTabState(this);
  }

  async connect() {
    if (this.state === 'connecting') return;
    if (this.connId) { try { await this.api.ssh.disconnect(this.connId); } catch {} }
    this.connId = uid('c');
    const connId = this.connId;
    this.fwState.clear();
    this.setState('connecting', 'Bağlanılıyor…');
    const s = this.session;
    const label = s ? `${s.username ? s.username + '@' : ''}${s.host}:${s.port || 22}` : `${this.quick.username ? this.quick.username + '@' : ''}${this.quick.host}:${this.quick.port}`;
    if (this._everConnected) this.term.write('\r\n');
    this.term.write(`\x1b[90m${label} adresine bağlanılıyor…\x1b[0m`);
    try {
      const info = await this.api.ssh.connect(connId, this.sessionId ? { sessionId: this.sessionId } : { session: this.quick });
      if (connId !== this.connId) return;
      this.setState('connected', `${info.username}@${info.host}`);
      this.term.write('\r\x1b[2K');
      await this.api.ssh.shell(connId, this.term.cols, this.term.rows, (s && s.startupCommand) || '');
      this._everConnected = true;
      this.info2 = info;
      for (const fw of this.adhocForwards) this.api.ssh.forwardStart(connId, fw).catch(() => {});
      if (!this.localInitialized) {
        this.localInitialized = true;
        this.local.cd(info.localDir || this.app.home);
      }
      if (this.sftpVisible) this.initRemotePane();
      this.term.focus();
    } catch (e) {
      if (connId !== this.connId) return;
      const msg = cleanErr(e);
      const cancelled = /İptal edildi/.test(msg);
      this.setState(cancelled ? 'closed' : 'error', msg);
      this.term.write('\r\x1b[2K');
      this.info(`✖ ${msg}`, '31');
      this.info('Yeniden bağlanmak için Enter tuşuna basın.', '90');
    }
  }

  async initRemotePane() {
    const connId = this.connId;
    try {
      const start = this.remote.cwd || (this.info2 && this.info2.remoteDir) || null;
      if (start) await this.remote.cd(start);
      if (!this.remote.cwd && connId === this.connId) await this.remote.goHome();
    } catch (e) { toast(cleanErr(e), 'err'); }
  }

  onStatus(state, msg) {
    if (state === 'connected' || state === 'connecting') return; // handled by connect()
    if (this.state === 'connected') {
      this.setState(state, msg);
      this.info(`● ${msg}`, state === 'error' ? '31' : '33');
      this.info('Yeniden bağlanmak için Enter tuşuna basın.', '90');
      for (const [tid, t] of this.transfers) if (t.state === 'running' || t.state === 'scanning') this.onTransfer({ tid, state: 'error', error: 'Bağlantı koptu', done: t.done, total: t.total });
    }
  }

  onShellExit() {
    if (this.state === 'connected') this.api.ssh.disconnect(this.connId);
  }

  disconnect() { if (this.connId) this.api.ssh.disconnect(this.connId); }

  dispose() {
    this.ro.disconnect();
    if (this.connId) this.api.ssh.disconnect(this.connId).catch(() => {});
    this.term.dispose();
    this.el.remove();
  }

  // ------------------------------------------------------------ files
  cdInTerminal(dir) {
    if (this.state !== 'connected') return;
    this.api.ssh.write(this.connId, `cd ${shq(dir)}\r`);
    this.term.focus();
  }

  async editRemote(e) {
    const p = posix.join(this.remote.cwd, e.name);
    try {
      await this.api.sftp.edit(this.connId, p);
      toast(`${e.name} açıldı. Kaydettiğinizde otomatik olarak sunucuya yüklenecek.`, 'info', 5000);
    } catch (err) { toast(cleanErr(err), 'err'); }
  }

  onEditEvent(ev) {
    if (ev.state === 'uploaded') { toast(`${posix.basename(ev.path)} sunucuya yüklendi`, 'ok'); if (posix.dirname(ev.path) === this.remote.cwd) this.remote.refresh(); }
    else toast(`${posix.basename(ev.path)} yüklenemedi: ${ev.error}`, 'err', 6000);
  }

  async chmod(e) {
    const cur = (e.mode & 0o7777).toString(8).padStart(3, '0');
    const v = await promptText({ title: `İzinler — ${e.name}`, label: 'Sekizlik (örn. 755, 644, 600)', value: cur });
    if (v == null) return;
    if (!/^[0-7]{3,4}$/.test(v)) { toast('Geçersiz izin değeri', 'err'); return; }
    try { await this.api.sftp.chmod(this.connId, posix.join(this.remote.cwd, e.name), parseInt(v, 8)); await this.remote.refresh(); } catch (err) { toast(cleanErr(err), 'err'); }
  }

  async transfer(fromSide, items, destDir) {
    if (this.state !== 'connected') { toast('Önce bağlanın', 'err'); return; }
    const destPane = fromSide === 'local' ? this.remote : this.local;
    const dest = destDir || destPane.cwd;
    if (!dest) { toast('Hedef dizin hazır değil', 'err'); return; }
    const direction = fromSide === 'local' ? 'upload' : 'download';
    let list = items.filter((it) => !(posix.dirname(it.path) === dest && fromSide === destPane.side));
    // conflicts
    let existing;
    if (dest === destPane.cwd) existing = new Set(destPane.entries.map((e) => e.name));
    else {
      existing = new Set();
      for (const it of list) {
        const ex = direction === 'upload' ? await this.api.sftp.exists(this.connId, posix.join(dest, it.name)) : await this.api.local.exists(posix.join(dest, it.name));
        if (ex) existing.add(it.name);
      }
    }
    const conflicts = list.filter((it) => existing.has(it.name));
    if (conflicts.length) {
      const r = await modal({
        title: 'Dosyalar zaten var',
        width: 460,
        body: h('div', null, h('p', null, `${dest} içinde aynı adlı ${conflicts.length} öğe var:`),
          h('div.name-list', null, conflicts.slice(0, 10).map((c) => c.name + (c.isDir ? '/' : '')).join('\n') + (conflicts.length > 10 ? `\n… +${conflicts.length - 10}` : '')),
          conflicts.some((c) => c.isDir) ? h('p.hint', null, 'Klasörler birleştirilir; içindeki aynı adlı dosyalar üzerine yazılır.') : null),
        buttons: [{ label: 'Vazgeç', value: null }, { label: 'Çakışanları atla', value: 'skip' }, { label: 'Üzerine yaz', value: 'overwrite', primary: true, danger: true }],
      });
      if (!r) return;
      if (r === 'skip') list = list.filter((it) => !existing.has(it.name));
    }
    if (!list.length) return;
    const tid = uid('t');
    const t = {
      tid, direction, dest, state: 'queued', done: 0, total: 0, started: Date.now(), samples: [],
      label: list.length === 1 ? list[0].name : `${list.length} öğe`,
      destSide: destPane.side,
    };
    this.transfers.set(tid, t);
    this.renderTransfer(t);
    try {
      await this.api.sftp.transfer(this.connId, { tid, direction, items: list.map((it) => ({ src: it.path, dst: posix.join(dest, it.name) })) });
    } catch (e) { this.onTransfer({ tid, state: 'error', error: cleanErr(e) }); }
  }

  onTransfer(info) {
    const t = this.transfers.get(info.tid);
    if (!t) return;
    Object.assign(t, info);
    const now = Date.now();
    t.samples.push([now, t.done || 0]);
    while (t.samples.length > 2 && now - t.samples[0][0] > 3000) t.samples.shift();
    this.renderTransfer(t);
    if (info.state === 'done') {
      const pane = t.destSide === 'remote' ? this.remote : this.local;
      if (pane.cwd === t.dest) pane.refresh();
      const secs = Math.max(0.001, (now - t.started) / 1000);
      toast(`${t.label} ${t.direction === 'upload' ? 'yüklendi' : 'indirildi'} (${formatSize(t.total)}, ${secs.toFixed(1)} sn)`, 'ok');
    } else if (info.state === 'error') toast(`Aktarım hatası: ${info.error}`, 'err', 6000);
  }

  renderTransfer(t) {
    const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : (t.state === 'done' ? 100 : 0);
    let speed = 0;
    if (t.samples.length > 1) { const [a, b] = [t.samples[0], t.samples[t.samples.length - 1]]; speed = (b[1] - a[1]) / Math.max(0.001, (b[0] - a[0]) / 1000); }
    const running = t.state === 'running' || t.state === 'scanning' || t.state === 'queued';
    const stateText = {
      queued: 'Sırada', scanning: 'Taranıyor…', running: `${formatSize(t.done)} / ${formatSize(t.total)} · ${formatSize(speed)}/s${speed > 0 && t.total ? ' · ' + eta((t.total - t.done) / speed) : ''}`,
      done: `Tamamlandı · ${formatSize(t.total)}`, error: `Hata: ${t.error || ''}`, cancelled: 'İptal edildi',
    }[t.state] || t.state;
    const row = h('div.xfer.' + t.state, { dataset: { tid: t.tid } },
      icon(t.direction === 'upload' ? 'upload' : 'download', 14),
      h('div.xfer-main', null,
        h('div.xfer-line', null, h('span.xfer-name', { title: t.file || t.label }, t.label), h('span.xfer-dest', { title: t.dest }, '→ ' + t.dest)),
        h('div.bar', null, h('div.bar-fill', { style: { width: pct.toFixed(1) + '%' } })),
        h('div.xfer-info', null, stateText, t.state === 'running' && t.file ? h('span.xfer-file', null, ' · ' + t.file.split('/').pop()) : null)),
      running ? h('button.icon-btn', { title: 'İptal', onclick: () => this.api.sftp.cancel(this.connId, t.tid) }, icon('x', 14))
        : h('button.icon-btn', { title: 'Listeden kaldır', onclick: () => { this.transfers.delete(t.tid); row.remove(); this.updateXferHead(); } }, icon('x', 14)));
    const old = this.xferList.querySelector(`[data-tid="${t.tid}"]`);
    if (old) old.replaceWith(row); else this.xferList.prepend(row);
    this.updateXferHead();
  }

  updateXferHead() {
    const all = [...this.transfers.values()];
    const active = all.filter((t) => ['running', 'scanning', 'queued'].includes(t.state)).length;
    this.xfers.classList.toggle('empty', all.length === 0);
    this.xferHead.querySelector('.xfer-count').textContent = active ? `${active} etkin` : `${all.length}`;
    this.app.updateStatus();
  }

  clearFinished() {
    for (const [tid, t] of this.transfers) if (!['running', 'scanning', 'queued'].includes(t.state)) { this.transfers.delete(tid); this.xferList.querySelector(`[data-tid="${tid}"]`)?.remove(); }
    this.updateXferHead();
  }

  activeTransfers() { return [...this.transfers.values()].filter((t) => ['running', 'scanning', 'queued'].includes(t.state)).length; }

  // ------------------------------------------------------------ tunnels
  allForwards() {
    const s = this.session;
    return [...((s && s.forwards) || []).map((f) => ({ ...f, saved: true })), ...this.adhocForwards];
  }

  onForward(fid, state, msg) {
    if (state === 'warn') { toast(msg, 'err'); return; }
    this.fwState.set(fid, { state, msg });
    if (state === 'error') toast(`Tünel: ${msg}`, 'err', 6000);
    this.app.updateStatus();
    if (this._fwRefresh) this._fwRefresh();
  }

  activeForwards() { return [...this.fwState.values()].filter((f) => f.state === 'active').length; }

  async tunnelsDialog() {
    const fwLabel = (f) => f.type === 'D' ? `SOCKS5 ${f.bindHost || '127.0.0.1'}:${f.bindPort}`
      : f.type === 'L' ? `${f.bindHost || '127.0.0.1'}:${f.bindPort} → ${f.dstHost}:${f.dstPort}`
        : `sunucu ${f.bindHost || '127.0.0.1'}:${f.bindPort} → ${f.dstHost}:${f.dstPort}`;
    const list = h('div.fw-list');
    const render = () => {
      const fws = this.allForwards();
      list.replaceChildren(...(fws.length ? fws.map((f) => {
        const st = this.fwState.get(f.id) || { state: 'stopped' };
        const on = st.state === 'active';
        return h('div.fw-row', null,
          h('span.dot.' + (on ? 'ok' : st.state === 'error' ? 'err' : 'off')),
          h('span.fw-type', null, { L: 'Yerel', R: 'Uzak', D: 'Dinamik' }[f.type]),
          h('span.fw-desc.mono', null, fwLabel(f)),
          h('span.fw-src', null, f.saved ? 'oturum' : 'geçici'),
          st.state === 'error' ? h('span.fw-err', { title: st.msg }, st.msg) : null,
          on ? h('button.btn.sm', { onclick: () => this.api.ssh.forwardStop(this.connId, f.id) }, icon('stop', 12), 'Durdur')
            : h('button.btn.sm.primary', { onclick: () => this.api.ssh.forwardStart(this.connId, f).catch(() => {}) }, icon('play', 12), 'Başlat'));
      }) : [h('p.muted', null, 'Bu oturumda tanımlı tünel yok.')]));
    };
    this._fwRefresh = render;
    render();
    const type = h('select.input.sm', null, h('option', { value: 'L' }, 'Yerel  -L'), h('option', { value: 'R' }, 'Uzak  -R'), h('option', { value: 'D' }, 'SOCKS  -D'));
    const bp = h('input.input.sm.port', { placeholder: 'port', inputmode: 'numeric' });
    const dh = h('input.input.sm.dst', { placeholder: 'hedef host', value: '127.0.0.1' });
    const dp = h('input.input.sm.port', { placeholder: 'port', inputmode: 'numeric' });
    const save = h('input', { type: 'checkbox' });
    type.onchange = () => { const d = type.value === 'D'; dh.disabled = dp.disabled = d; };
    const add = async () => {
      const fw = { id: uid('fw'), type: type.value, bindHost: '127.0.0.1', bindPort: Number(bp.value), dstHost: dh.value.trim(), dstPort: Number(dp.value), enabled: true };
      if (!fw.bindPort || (fw.type !== 'D' && (!fw.dstHost || !fw.dstPort))) { toast('Port ve hedef bilgilerini doldurun', 'err'); return; }
      if (save.checked && this.session) {
        const s = this.session;
        await this.app.saveSession({ id: s.id, forwards: [...(s.forwards || []), fw] });
      } else this.adhocForwards.push(fw);
      bp.value = ''; dp.value = '';
      render();
      this.api.ssh.forwardStart(this.connId, fw).catch(() => {});
    };
    await modal({
      title: 'Tüneller (port yönlendirme)',
      width: 700,
      body: h('div', null, list,
        h('div.fw-add', { dataset: { noenter: '1' }, onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } } }, type, bp, h('span.arrow', null, '→'), dh, dp,
          this.session ? h('label.check.inline', null, save, 'Oturuma kaydet') : null,
          h('button.btn.sm.primary', { onclick: add }, icon('plus', 12), 'Ekle ve başlat'))),
      buttons: [{ label: 'Kapat', value: true, primary: true }],
    });
    this._fwRefresh = null;
  }
}

function eta(s) {
  if (!isFinite(s)) return '';
  if (s < 60) return `${Math.ceil(s)} sn`;
  if (s < 3600) return `${Math.floor(s / 60)} dk ${Math.ceil(s % 60)} sn`;
  return `${Math.floor(s / 3600)} sa ${Math.floor((s % 3600) / 60)} dk`;
}
