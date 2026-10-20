import { h, icon, uid, formatSize, backForward } from './util.js';
import { FilePane, cleanErr } from './filepane.js';
import { contextMenu, modal, toast, promptText } from './dialogs.js';
import { TermPane } from './termpane.js';

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
// Yerel yollar: Windows'ta C:\... biçimi; sürücü kökünün üstü sanal "Bu Bilgisayar" listesi (main.js DRIVES).
const DRIVES = 'Bu Bilgisayar';
const win32 = {
  join: (a, b) => (a === DRIVES ? b + '\\' : a.replace(/[\\/]+$/, '') + '\\' + b),
  dirname: (p) => {
    if (p === DRIVES || /^[a-z]:[\\/]?$/i.test(p)) return DRIVES;
    const s = p.replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    if (i < 0) return DRIVES;
    const d = s.slice(0, i);
    return /^[a-z]:$/i.test(d) ? d + '\\' : (d || DRIVES);
  },
  basename: (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop(),
  isRoot: (p) => p === DRIVES,
};
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

const ARCHIVE_RE = /\.(tar(\.(gz|xz|bz2|zst))?|tgz|txz|tbz2?|tzst|zip|gz)$/i;

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
    this.localVisible = app.settings.localPane !== false;
    this.followTerm = app.settings.followTerminal !== false;
    this.localInitialized = false;
    this.build();
  }

  get session() { return this.sessionId ? this.app.sessions.find((s) => s.id === this.sessionId) : null; }

  // ------------------------------------------------------------ build UI
  build() {
    const st = this.app.settings;
    // Terminal bölmeleri: layout ikili bir ağaç — { pane } ya da { dir: 'h'|'v', a, b, ratio }
    const first = new TermPane(this, 'main');
    this.panes = [first];
    this.activePane = first;
    this.layout = { pane: first };
    this.termWrap = h('div.term-wrap');
    // Terminalde fare geri/ileri tuşları ve touchpad iki parmak yatay kaydırma: önceki / sonraki sekme
    backForward(this.termWrap, { back: () => this.app.stepTab(-1), forward: () => this.app.stepTab(1) });
    this.renderLayout();

    // file panes
    const self = this;
    const cid = () => { if (!this.connId || this.state !== 'connected') throw new Error('Bağlı değil'); return this.connId; };
    this.localBtn = h('button.icon-btn', { title: 'Yerel paneli göster/gizle', onclick: () => this.toggleLocal() }, icon('sidebar', 15));
    this.followBtn = h('button.icon-btn', { title: 'Terminaldeki dizini takip et', onclick: () => this.toggleFollow() }, icon('terminal', 15));
    this.syncBtn = h('button.icon-btn', { title: 'Klasörleri karşılaştır / eşitle', onclick: () => this.syncDialog() }, icon('sync', 15));
    this.searchBtn = h('button.icon-btn', { title: 'Sunucuda dosya ara (bu klasör ve altı)', onclick: () => this.remoteSearch() }, icon('search', 15));
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
        preview: (p) => this.api.sftp.preview(cid(), p),
        prepareDrag: (tid, items) => this.api.drag.prepare(cid(), tid, items),
        cancelDrag: (tid) => this.api.sftp.cancel(cid(), tid),
      },
      extraTools: [this.searchBtn, this.syncBtn, this.followBtn, this.localBtn],
      onTransfer: (from, items, dest) => this.transfer(from, items, dest),
      onColResize: (w) => this.saveColWidths(w),
      onColPrefs: (p) => this.saveColPrefs(p),
      onDropFrom: (src, items, dest) => this.dropFrom(src, items, dest, this.remote),
      onOpenFile: (e) => (this.app.settings.fileDblClick === 'transfer' ? this.transfer('remote', this.remote.itemsFor([e]), null) : this.editRemote(e)),
      onExtraMenu: (sel) => {
        const one = sel.length === 1 ? sel[0] : null;
        return [
          one && !one.isDir ? { label: 'Düzenle (varsayılan uygulamayla)', icon: 'edit', action: () => this.editRemote(one) } : null,
          { label: 'Terminalde bu dizine git', icon: 'terminal', action: () => this.cdInTerminal(one && one.isDir ? posix.join(this.remote.cwd, one.name) : this.remote.cwd) },
          one ? { label: 'İzinler (chmod)…', icon: 'key', action: () => this.chmod(one) } : null,
          sel.length ? '-' : null,
          sel.length ? { label: 'Sıkıştırıp indir (.tar.gz)', icon: 'archive', action: () => this.compressDownload(sel) } : null,
          sel.length ? { label: 'Sunucuda sıkıştır (.tar.gz)', icon: 'archive', action: () => this.compressRemote(sel) } : null,
          one && !one.isDir && ARCHIVE_RE.test(one.name) ? { label: 'Arşivi burada aç', icon: 'folder', action: () => this.extractRemote(one) } : null,
        ];
      },
    });
    const lp = this.lpath = app.platform === 'win32' ? win32 : posix;
    this.local = new FilePane({
      side: 'local', api: this.api, settings: st,
      adapter: {
        label: 'Yerel',
        list: (d) => this.api.local.list(d),
        home: async () => this.app.home,
        join: lp.join, dirname: lp.dirname, basename: lp.basename, isRoot: lp.isRoot,
        mkdir: (p) => this.api.local.mkdir(p),
        rename: (a, b) => this.api.local.rename(a, b),
        remove: (p) => this.api.local.remove(p),
        resolve: (p) => this.api.local.resolve(p),
        preview: (p) => this.api.local.preview(p),
      },
      onTransfer: (from, items, dest) => this.transfer(from, items, dest),
      onColResize: (w) => this.saveColWidths(w),
      onColPrefs: (p) => this.saveColPrefs(p),
      onDropFrom: (src, items, dest) => this.dropFrom(src, items, dest, this.local),
      onOpenFile: (e) => (this.app.settings.fileDblClick === 'transfer' ? this.transfer('local', this.local.itemsFor([e]), null) : this.api.local.open(lp.join(this.local.cwd, e.name))),
      onExtraMenu: (sel) => {
        const one = sel.length === 1 ? sel[0] : null;
        return [
          one && !one.isDir ? { label: 'Aç', icon: 'file', action: () => this.api.local.open(lp.join(this.local.cwd, one.name)) } : null,
          { label: 'Dosya yöneticisinde göster', icon: 'folder', action: () => this.api.local.reveal(one ? lp.join(this.local.cwd, one.name) : this.local.cwd) },
        ];
      },
    });
    this.local.tab = this.remote.tab = this;
    this.local.peer = this.remote;
    this.remote.peer = this.local;

    this.xferList = h('div.xfer-list');
    this.xferHead = h('div.xfer-head', null,
      h('span.xfer-title', null, 'Aktarımlar'),
      h('span.xfer-count'),
      h('button.link-btn', { onclick: () => this.clearFinished() }, 'Bitenleri temizle'));
    this.xferSplit = h('div.xsplit', { title: 'Sürükleyerek boyutlandır' });
    this.xfers = h('div.xfers.empty', null, this.xferSplit, this.xferHead, this.xferList);

    this.paneSplit = h('div.vsplit');
    this.paneBox = h('div.panes', null, this.local.el, this.paneSplit, this.remote.el);
    this.sftp = h('div.sftp', null, this.paneBox, this.xfers);
    this.splitter = h('div.hsplit', { title: 'Sürükleyerek boyutlandır' });
    this.el = h('div.tab-view', null, this.termWrap, this.splitter, this.sftp);
    this.applySftpLayout();
    this.initSplitters();

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
      const rect = this.paneBox.getBoundingClientRect();
      const move = (ev) => {
        const pct = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
        this.app.settings.paneSplit = Math.round(pct * 10) / 10;
        this.applySftpLayout();
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing-h'); this.app.saveSettings({ paneSplit: this.app.settings.paneSplit }); };
      document.body.classList.add('resizing-h');
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    this.paneSplit.addEventListener('dblclick', () => { this.app.settings.paneSplit = 50; this.applySftpLayout(); this.app.saveSettings({ paneSplit: 50 }); });
    this.xferSplit.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = this.sftp.getBoundingClientRect();
      const move = (ev) => {
        this.app.settings.xferHeight = Math.round(Math.min(rect.height - 90, Math.max(50, rect.bottom - ev.clientY)));
        this.applySftpLayout();
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing-v'); this.app.saveSettings({ xferHeight: this.app.settings.xferHeight }); };
      document.body.classList.add('resizing-v');
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  saveColPrefs(p) {
    this.app.saveSettings(p);
    for (const t of this.app.tabs) for (const pane of [t.local, t.remote]) pane.setColPrefs(p);
  }

  saveColWidths(w) {
    this.app.saveSettings({ colWidths: w });
    for (const t of this.app.tabs) for (const p of [t.local, t.remote]) p.applyColWidths(w);
  }

  applySftpLayout() {
    this.sftp.style.display = this.sftpVisible ? '' : 'none';
    this.splitter.style.display = this.sftpVisible ? '' : 'none';
    this.sftp.style.height = (this.app.settings.sftpHeight || 38) + '%';
    this.local.el.style.flexBasis = (this.app.settings.paneSplit || 50) + '%';
    const xh = this.app.settings.xferHeight;
    this.xfers.style.height = xh ? xh + 'px' : '';
    this.xfers.style.maxHeight = xh ? 'none' : '';
    this.local.el.style.display = this.paneSplit.style.display = this.localVisible ? '' : 'none';
    this.localBtn.classList.toggle('on', this.localVisible);
    this.followBtn.classList.toggle('on', this.followTerm);
  }

  toggleLocal() {
    this.localVisible = !this.localVisible;
    this.applySftpLayout();
    this.app.saveSettings({ localPane: this.localVisible });
  }

  toggleFollow() {
    this.followTerm = !this.followTerm;
    this.applySftpLayout();
    this.app.saveSettings({ followTerminal: this.followTerm });
    this.lastTermCwd = null;
    if (this.followTerm) this.syncTermCwd();
  }

  // Remote pane follows the shell's cwd: checked shortly after Enter and periodically while visible.
  async syncTermCwd() {
    if (!this.followTerm || !this.sftpVisible || this.state !== 'connected' || this._cwdBusy || this._cwdUnsupported) return;
    const connId = this.connId;
    const pane = this.activePane;
    if (!pane.shellOpen) return;
    this._cwdBusy = true;
    try {
      const cwd = await this.api.ssh.cwd(connId, pane.sid);
      if (connId !== this.connId || pane !== this.activePane) return;
      if (cwd === null && ++this._cwdFails >= 3) this._cwdUnsupported = true;
      if (!cwd) return;
      this._cwdFails = 0;
      if (cwd === this.lastTermCwd) return;
      this.lastTermCwd = cwd;
      if (cwd !== this.remote.cwd && !this.remote.loading) await this.remote.cd(cwd);
    } catch { /* bağlantı yok vb. */ } finally { this._cwdBusy = false; }
  }

  // Durum çubuğundaki sunucu kaynakları (yalnızca etkin sekme, Linux sunucular)
  async pollStats() {
    if (!this.app.settings.showStats || this.state !== 'connected' || this._statsBusy || this._statsUnsupported) return;
    const connId = this.connId;
    this._statsBusy = true;
    try {
      const st = await this.api.ssh.stats(connId);
      if (connId !== this.connId) return;
      if (!st) { this._statsUnsupported = true; this.stats = null; } else this.stats = st;
      this.app.updateStats();
    } catch { /* bağlantı yok vb. */ } finally { this._statsBusy = false; }
  }

  toggleSftp(v) {
    this.sftpVisible = v === undefined ? !this.sftpVisible : v;
    this.applySftpLayout();
    if (this.sftpVisible && this.state === 'connected' && !this.remote.cwd) this.initRemotePane();
    this.scheduleFit();
  }

  // ------------------------------------------------------------ terminal panes
  get term() { return this.activePane.term; }

  scheduleFit() { for (const p of this.panes) p.scheduleFit(); }

  applySettings() {
    const st = this.app.settings;
    for (const p of this.panes) p.applySettings();
    this.applySftpLayout();
    for (const p of [this.local, this.remote]) { p.applyColWidths(st.colWidths || {}); p.setColPrefs(st); }
    if (this.local.showHidden !== st.showHidden) { this.local.showHidden = this.remote.showHidden = st.showHidden; this.local.hiddenBtn.classList.toggle('on', st.showHidden); this.remote.hiddenBtn.classList.toggle('on', st.showHidden); this.local.render(); this.remote.render(); }
    if (!st.showStats) this.stats = null;
    this.pump();
  }

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    for (const p of this.panes) p.mount();
  }

  focus() { this.mount(); this.scheduleFit(); this.activePane.focus(); }

  setActivePane(pane) {
    if (this.activePane === pane) return;
    this.activePane = pane;
    for (const p of this.panes) p.el.classList.toggle('active', p === pane && this.panes.length > 1);
    this.lastTermCwd = null;
    if (this.app.active === this) this.app.updateStatus();
  }

  renderLayout() {
    const build = (node) => {
      if (node.pane) return node.pane.el;
      const a = h('div.tsplit-cell', { style: { flex: `${node.ratio} 1 0` } }, build(node.a));
      const b = h('div.tsplit-cell', { style: { flex: `${1 - node.ratio} 1 0` } }, build(node.b));
      const box = h('div.tsplit.' + node.dir, null, a);
      const gutter = h('div.tsplit-gutter', { title: 'Sürükleyerek boyutlandır' });
      gutter.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const r = box.getBoundingClientRect();
        const cls = node.dir === 'h' ? 'resizing-h' : 'resizing-v';
        const move = (ev) => {
          const f = node.dir === 'h' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
          node.ratio = Math.min(0.85, Math.max(0.15, f));
          a.style.flex = `${node.ratio} 1 0`; b.style.flex = `${1 - node.ratio} 1 0`;
        };
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove(cls); this.scheduleFit(); };
        document.body.classList.add(cls);
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
      gutter.addEventListener('dblclick', () => { node.ratio = 0.5; this.renderLayout(); });
      box.append(gutter, b);
      return box;
    };
    this.termWrap.replaceChildren(build(this.layout));
    for (const p of this.panes) p.el.classList.toggle('active', p === this.activePane && this.panes.length > 1);
    this.scheduleFit();
  }

  // dir: 'h' = sağa böl (yan yana), 'v' = aşağı böl (alt alta)
  async splitPane(dir, pane = this.activePane) {
    if (this.panes.length >= 8) { toast('En fazla 8 bölme açılabilir', 'err'); return; }
    this._paneSeq = (this._paneSeq || 1) + 1;
    const np = new TermPane(this, `bolme${this._paneSeq}`); // sid; kayıt dosyası adında da görünür
    const replace = (node) => {
      if (node.pane === pane) return { dir, a: { pane }, b: { pane: np }, ratio: 0.5 };
      if (node.pane) return node;
      return { ...node, a: replace(node.a), b: replace(node.b) };
    };
    this.layout = replace(this.layout);
    this.panes.push(np);
    this.renderLayout();
    if (this.mounted) np.mount();
    this.setActivePane(np);
    np.fit.fit();
    np.focus();
    if (this.state === 'connected') {
      // yeni kabuk, bölünen bölmenin dizininde başlasın
      let cwd = null;
      if (pane.shellOpen) { try { cwd = await Promise.race([this.api.ssh.cwd(this.connId, pane.sid), new Promise((r) => setTimeout(() => r(null), 1500))]); } catch {} }
      await this.openPaneShell(np, cwd ? `cd ${shq(cwd)}` : '');
    }
  }

  closePane(pane = this.activePane) {
    if (this.panes.length < 2) return false;
    const remove = (node) => {
      if (node.pane) return node;
      if (node.a.pane === pane) return node.b;
      if (node.b.pane === pane) return node.a;
      return { ...node, a: remove(node.a), b: remove(node.b) };
    };
    this.layout = remove(this.layout);
    const i = this.panes.indexOf(pane);
    this.panes.splice(i, 1);
    if (pane.shellOpen && this.state === 'connected') this.api.ssh.closeShell(this.connId, pane.sid).catch(() => {});
    pane.shellOpen = false;
    pane.dispose();
    if (this.activePane === pane) { this.activePane = null; this.setActivePane(this.panes[Math.max(0, i - 1)]); }
    this.renderLayout();
    this.activePane.focus();
    return true;
  }

  // Alt+Shift+ok: ekrandaki konuma göre en yakın komşu bölmeye geç
  focusNeighbor(key) {
    const cur = this.activePane.el.getBoundingClientRect();
    const cx = cur.left + cur.width / 2; const cy = cur.top + cur.height / 2;
    let best = null; let bestD = Infinity;
    for (const p of this.panes) {
      if (p === this.activePane) continue;
      const r = p.el.getBoundingClientRect();
      const x = r.left + r.width / 2; const y = r.top + r.height / 2;
      const ok = { ArrowLeft: r.right <= cur.left + 2, ArrowRight: r.left >= cur.right - 2, ArrowUp: r.bottom <= cur.top + 2, ArrowDown: r.top >= cur.bottom - 2 }[key];
      if (!ok) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) { this.setActivePane(best); best.focus(); }
    return !!best;
  }

  async openPaneShell(pane, startup) {
    const connId = this.connId;
    try { pane.fit.fit(); } catch {}
    await this.api.ssh.shell(connId, pane.term.cols, pane.term.rows, startup || '', pane.sid);
    if (connId !== this.connId) return;
    pane.shellOpen = true;
  }

  // Etkin bölmeye metin gönder (yayın, hazır komutlar)
  writeActive(text) {
    if (this.state !== 'connected' || !this.activePane.shellOpen) return false;
    this.api.ssh.write(this.connId, text, this.activePane.sid);
    return true;
  }

  onShellData(data, sid) { this.panes.find((p) => p.sid === sid)?.term.write(data); }

  // ------------------------------------------------------------ terminal I/O
  onTermInput(pane, d) {
    if (this.state === 'connected') {
      if (!pane.shellOpen) return;
      this.api.ssh.write(this.connId, d, pane.sid);
      if (this.followTerm && d.includes('\r')) { setTimeout(() => this.syncTermCwd(), 300); setTimeout(() => this.syncTermCwd(), 1200); }
      return;
    }
    if (this._retryTimer && d === '\x1b') { this.cancelReconnect(); this.info('Otomatik yeniden bağlanma iptal edildi. Enter: yeniden bağlan', '90'); return; }
    if ((this.state === 'closed' || this.state === 'error') && d === '\r') this.connect();
  }

  onTermKey(pane, e) {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && k === 'c') { if (pane.term.hasSelection()) this.api.clipboard.write(pane.term.getSelection()); return false; }
    // preventDefault: yoksa Chromium da 'paste' olayı üretir ve xterm ikinci kez yapıştırır
    if (e.ctrlKey && e.shiftKey && k === 'v') { e.preventDefault(); pane.paste(); return false; }
    if (e.ctrlKey && e.shiftKey && k === 'f') { pane.toggleSearch(true); return false; }
    if (e.shiftKey && e.key === 'Insert') { e.preventDefault(); pane.paste(); return false; }
    if (this.app.isAppShortcut(e)) return false;
    return true;
  }

  termMenu(pane, x, y) {
    const connected = this.state === 'connected';
    const t = pane.term;
    // tmux/vim fare modundayken sürükleme programa gider; seçim Shift+sürükle ile yapılır
    const mouseApp = t.modes.mouseTrackingMode !== 'none';
    contextMenu(x, y, [
      { label: 'Kopyala', icon: 'file', hint: 'Ctrl+Shift+C', disabled: !t.hasSelection(), action: () => this.api.clipboard.write(t.getSelection()) },
      ...(mouseApp && !t.hasSelection() ? [{ label: 'Seçmek için Shift+sürükle', icon: 'file', disabled: true }] : []),
      { label: 'Yapıştır', icon: 'file', hint: 'Ctrl+Shift+V', action: () => pane.paste() },
      { label: 'Tümünü seç', icon: 'file', action: () => t.selectAll() },
      '-',
      { label: 'Hazır komutlar…', icon: 'snippet', hint: 'Ctrl+Shift+K', action: () => this.app.snippetPalette() },
      { label: 'Ara', icon: 'search', hint: 'Ctrl+Shift+F', action: () => pane.toggleSearch(true) },
      { label: 'Ekranı temizle', icon: 'x', action: () => t.clear() },
      '-',
      { label: 'Sağa böl', icon: 'splitH', hint: 'Ctrl+Shift+D', action: () => this.splitPane('h', pane) },
      { label: 'Aşağı böl', icon: 'splitV', hint: 'Ctrl+Shift+S', action: () => this.splitPane('v', pane) },
      this.panes.length > 1 ? { label: 'Bölmeyi kapat', icon: 'x', hint: 'Ctrl+Shift+W', action: () => this.closePane(pane) } : null,
      '-',
      { label: 'Tüneller…', icon: 'tunnel', disabled: !connected, action: () => this.tunnelsDialog() },
      { label: 'Açık anahtarı sunucuya yükle…', icon: 'key', disabled: !connected, action: () => this.app.installKeyDialog(this) },
      this.app.settings.logEnabled ? { label: 'Kayıt klasörünü aç', icon: 'record', action: () => this.api.logs.open() } : null,
      connected ? { label: 'Bağlantıyı kes', icon: 'stop', danger: true, action: () => this.disconnect() }
        : { label: 'Yeniden bağlan', icon: 'play', action: () => this.connect() },
    ]);
  }

  // Bağlantı durum mesajları tüm bölmelere yazılır
  info(msg, color = '90') { for (const p of this.panes) p.info(msg, color); }
  writeAll(s) { for (const p of this.panes) p.term.write(s); }

  // ------------------------------------------------------------ connection
  setState(state, text) {
    this.state = state;
    if (text !== undefined) this.statusText = text;
    this.app.onTabState(this);
  }

  async connect() {
    if (this.state === 'connecting') return;
    clearTimeout(this._retryTimer); this._retryTimer = null;
    if (this.connId) { try { await this.api.ssh.disconnect(this.connId); } catch {} }
    this.connId = uid('c');
    const connId = this.connId;
    this.fwState.clear();
    for (const p of this.panes) p.shellOpen = false;
    this._userClosed = false;
    this.setState('connecting', 'Bağlanılıyor…');
    const s = this.session;
    const label = s ? `${s.username ? s.username + '@' : ''}${s.host}:${s.port || 22}` : `${this.quick.username ? this.quick.username + '@' : ''}${this.quick.host}:${this.quick.port}`;
    if (this._everConnected) this.writeAll('\r\n');
    this.writeAll(`\x1b[90m${label} adresine bağlanılıyor…\x1b[0m`);
    try {
      const info = await this.api.ssh.connect(connId, this.sessionId ? { sessionId: this.sessionId } : { session: this.quick });
      if (connId !== this.connId) return;
      this.setState('connected', `${info.username}@${info.host}`);
      this.writeAll('\r\x1b[2K');
      // çoğaltılan sekme: ana kabuk kaynak sekmenin dizininde başlasın (yalnız ilk bağlantıda)
      const startCd = this.startDirs && this.startDirs.term ? `cd ${shq(this.startDirs.term)}` : '';
      const mainStartup = [startCd, s && s.startupCommand].filter(Boolean).join('; ');
      for (const p of this.panes) await this.openPaneShell(p, p.sid === 'main' ? mainStartup : '');
      if (connId !== this.connId) return;
      this._everConnected = true;
      this._retry = 0;
      this.info2 = info;
      for (const fw of this.adhocForwards) this.api.ssh.forwardStart(connId, fw).catch(() => {});
      if (!this.localInitialized) {
        this.localInitialized = true;
        this.local.cd((this.startDirs && this.startDirs.local) || info.localDir || this.app.home);
      }
      if (this.sftpVisible) this.initRemotePane();
      // SFTP paneli gizliyse uzak başlangıç dizini panel açılınca kullanılsın
      if (this.startDirs) this.startDirs = !this.sftpVisible && this.startDirs.remote ? { remote: this.startDirs.remote } : null;
      this.lastTermCwd = null; this._cwdFails = 0; this._cwdUnsupported = false;
      this.stats = null; this._statsUnsupported = false;
      clearInterval(this._cwdTimer);
      this._cwdTimer = setInterval(() => { if (this.app.active === this) { this.syncTermCwd(); this.pollStats(); } }, 3000);
      this.pollStats();
      this.pump();
      this.activePane.term.focus();
    } catch (e) {
      if (connId !== this.connId) return;
      const msg = cleanErr(e);
      const cancelled = /İptal edildi/.test(msg);
      this.setState(cancelled ? 'closed' : 'error', msg);
      this.writeAll('\r\x1b[2K');
      this.info(`✖ ${msg}`, '31');
      if (this._retry && !cancelled) this.scheduleReconnect();
      else this.info('Yeniden bağlanmak için Enter tuşuna basın.', '90');
    }
  }

  // Beklenmedik kopmada artan aralıklarla yeniden dene (Enter: hemen, Esc: vazgeç)
  scheduleReconnect() {
    const MAX = 10;
    if (this._retry >= MAX) { this._retry = 0; this.info(`${MAX} denemede bağlanılamadı. Yeniden bağlanmak için Enter tuşuna basın.`, '90'); return; }
    const delay = [2, 3, 5, 10, 15, 20, 30][Math.min(this._retry, 6)];
    this._retry++;
    this.info(`↻ ${delay} sn içinde yeniden bağlanılacak (deneme ${this._retry}/${MAX}) — Enter: şimdi, Esc: vazgeç`, '33');
    this.statusText = `Yeniden bağlanılacak (${this._retry}/${MAX})…`;
    this.app.onTabState(this);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this.connect(); }, delay * 1000);
  }

  cancelReconnect() { clearTimeout(this._retryTimer); this._retryTimer = null; this._retry = 0; }

  // Uykudan uyanınca bekleyen yeniden bağlanmayı hemen yap
  onResume() { if (this._retryTimer) this.connect(); }

  async initRemotePane() {
    const connId = this.connId;
    try {
      const start = this.remote.cwd || (this.startDirs && this.startDirs.remote) || (this.info2 && this.info2.remoteDir) || null;
      if (start) await this.remote.cd(start);
      if (!this.remote.cwd && connId === this.connId) await this.remote.goHome();
    } catch (e) { toast(cleanErr(e), 'err'); }
  }

  onStatus(state, msg) {
    if (state === 'connected' || state === 'connecting') return; // handled by connect()
    if (this.state === 'connected') {
      for (const p of this.panes) p.shellOpen = false;
      this.stats = null;
      this.setState(state, msg);
      this.info(`● ${msg}`, state === 'error' ? '31' : '33');
      for (const [tid, t] of this.transfers) if (t.state === 'running' || t.state === 'scanning' || t.state === 'starting') this.onTransfer({ tid, state: 'error', error: 'Bağlantı koptu', done: t.done, total: t.total });
      if (!this._userClosed && this.app.settings.autoReconnect !== false) { this._retry = 0; this.scheduleReconnect(); }
      else this.info('Yeniden bağlanmak için Enter tuşuna basın.', '90');
    }
  }

  onShellExit(sid) {
    const pane = this.panes.find((p) => p.sid === sid);
    if (!pane || !pane.shellOpen) return;
    pane.shellOpen = false;
    if (this.panes.length > 1) { this.closePane(pane); return; }
    if (this.state === 'connected') { this._userClosed = true; this.api.ssh.disconnect(this.connId); }
  }

  disconnect() {
    this._userClosed = true;
    this.cancelReconnect();
    if (this.connId) this.api.ssh.disconnect(this.connId);
  }

  dispose() {
    clearInterval(this._cwdTimer);
    this.cancelReconnect();
    this._userClosed = true;
    if (this.connId) this.api.ssh.disconnect(this.connId).catch(() => {});
    for (const p of this.panes) p.dispose();
    this.el.remove();
  }

  // ------------------------------------------------------------ files
  cdInTerminal(dir) {
    if (!this.writeActive(`cd ${shq(dir)}\r`)) return;
    this.activePane.term.focus();
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

  // Bir panelden bu sekmenin destPane'ine bırakılan öğeler. Kaynak başka bir sekmede olabilir:
  //   yerel -> uzak: bu sekme yükler · uzak -> yerel: kaynak sekme indirir (bağlantı onun)
  //   uzak -> uzak (farklı sekme/sunucu): bu sekme kaynağın bağlantısından okuyup kendi sunucusuna yazar
  dropFrom(src, items, dest, destPane) {
    if (src.side === 'local') return this.transfer('local', items, dest);
    if (destPane.side === 'local') return src.tab.transfer('remote', items, dest, { destPane });
    if (src.tab === this) return;
    return this.transfer('remote', items, dest, { destPane, srcTab: src.tab });
  }

  async transfer(fromSide, items, destDir, { destPane, srcTab } = {}) {
    if (this.state !== 'connected') { toast('Önce bağlanın', 'err'); return; }
    destPane = destPane || (fromSide === 'local' ? this.remote : this.local);
    const relay = fromSide === 'remote' && destPane.side === 'remote';
    if (relay && (!srcTab || srcTab.state !== 'connected')) { toast('Kaynak sekmenin bağlantısı yok', 'err'); return; }
    const dest = destDir || destPane.cwd;
    if (!dest) { toast('Hedef dizin hazır değil', 'err'); return; }
    const direction = relay ? 'relay' : fromSide === 'local' ? 'upload' : 'download';
    let resume = false;
    const sp = fromSide === 'local' ? this.lpath : posix; const dp = destPane.side === 'remote' ? posix : this.lpath;
    let list = relay ? items : items.filter((it) => !(sp.dirname(it.path) === dest && fromSide === destPane.side));
    // conflicts
    let existing;
    if (dest === destPane.cwd) existing = new Set(destPane.entries.map((e) => e.name));
    else {
      existing = new Set();
      for (const it of list) {
        const ex = destPane.side === 'remote' ? await this.api.sftp.exists(this.connId, dp.join(dest, it.name)) : await this.api.local.exists(dp.join(dest, it.name));
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
        buttons: [{ label: 'Vazgeç', value: null }, { label: 'Çakışanları atla', value: 'skip' },
          { label: 'Eksikleri tamamla', value: 'resume' }, { label: 'Üzerine yaz', value: 'overwrite', primary: true, danger: true }],
      });
      if (!r) return;
      if (r === 'skip') list = list.filter((it) => !existing.has(it.name));
      if (r === 'resume') resume = true;
    }
    if (!list.length) return;
    // Sunucudan sunucuya: yöntemi kullanıcı seçer (kaldığı yerden sürdürme yalnız bu bilgisayar üzerinden olur)
    let method = null;
    if (relay) {
      method = resume ? 'relay' : await this.askRelayMethod(srcTab, list.length === 1 ? list[0].name : `${list.length} öğe`);
      if (!method) return;
    }
    this.enqueue({
      direction, dest, destSide: destPane.side, destPane, srcTab, resume, method,
      label: list.length === 1 ? list[0].name : `${list.length} öğe`,
      items: list.map((it) => ({ src: it.path, dst: dp.join(dest, it.name) })),
    });
  }

  // Sunucudan sunucuya aktarım yöntemi penceresi (son seçim hatırlanır). -> 'relay' | 'key' | 'agent' | null
  async askRelayMethod(srcTab, label) {
    const viaJump = !!(this.session && this.session.jumpHostId) && 'hedefe jump host üzerinden bağlanılıyor';
    let agentKeys = 0;
    try { agentKeys = await this.api.sftp.agentKeys(srcTab.connId); } catch {}
    const opts = [
      { v: 'relay', title: 'Bu bilgisayar üzerinden',
        hint: 'Veri bu bilgisayardan geçer, diske yazılmaz. Sunuculara hiçbir şey eklenmez. Hız bu bilgisayarın bağlantısıyla sınırlı.' },
      { v: 'key', title: 'Doğrudan — geçici anahtarla', off: viaJump,
        hint: `${srcTab.title}, dosyaları ${this.title} sunucusuna kendisi gönderir. Hedefe yalnız bu klasöre dosya açabilen, 30 dakika geçerli tek kullanımlık bir anahtar eklenir; özel anahtar kaynakta geçici bir klasörde durur. Bitince ikisi de silinir ve size bildirilir.` },
      { v: 'agent', title: 'Doğrudan — ssh-agent yönlendirme', off: viaJump || (!agentKeys && "bu bilgisayarın ssh-agent'ında anahtar yok"),
        hint: "Sunuculara hiçbir şey yazılmaz. Ancak aktarım sürerken kaynak sunucuda root yetkisi olan biri agent'ınızdaki anahtarları (açtıkları bütün sunucular için) kullanabilir." },
    ];
    let sel = this.app.settings.relayMethod;
    if (!opts.some((o) => o.v === sel && !o.off)) sel = 'relay';
    const inputs = [];
    const rows = opts.map((o) => {
      const inp = h('input', { type: 'radio', name: 'relay-method', value: o.v, checked: o.v === sel, disabled: !!o.off });
      inputs.push(inp);
      return h('label.method' + (o.off ? '.off' : ''), null, inp,
        h('div', null, h('b', null, o.title), h('div.hint', null, o.off ? `Kullanılamıyor: ${o.off}` : o.hint)));
    });
    const r = await modal({
      title: 'Sunucudan sunucuya aktarım', width: 540,
      body: h('div.relay-methods', null,
        h('p', null, `${label}: ${srcTab.title} → ${this.title}`),
        ...rows,
        h('p.hint', null, 'Doğrudan yöntem olmazsa (sunucular birbirine ulaşamıyor, gerekli araçlar yok) bu bilgisayar üzerinden gönderilir ve nedeni bildirilir.')),
      buttons: [{ label: 'Vazgeç', value: null }, { label: 'Aktar', value: 'ok', primary: true }],
    });
    if (r !== 'ok') return null;
    const v = (inputs.find((i) => i.checked) || {}).value || 'relay';
    if (v !== this.app.settings.relayMethod) this.app.saveSettings({ relayMethod: v });
    return v;
  }

  // Aktarımlar sekme başına kuyruğa girer; aynı anda en fazla settings.maxTransfers tanesi çalışır.
  enqueue({ direction, dest, destSide, destPane, srcTab, method, label, items, resume = false, mkdirs = false }) {
    const tid = uid('t');
    const t = { tid, direction, dest, destSide, destPane, srcTab, method, label, items, resume, mkdirs, state: 'queued', done: 0, total: 0, started: 0, samples: [] };
    this.transfers.set(tid, t);
    this.renderTransfer(t);
    this.pump();
    return t;
  }

  pump() {
    if (this.state !== 'connected') return;
    const max = Math.max(1, Number(this.app.settings.maxTransfers) || 3);
    let running = [...this.transfers.values()].filter((t) => t.state === 'running' || t.state === 'scanning' || t.state === 'starting').length;
    for (const t of [...this.transfers.values()].reverse()) { // en eski önce
      if (running >= max) break;
      if (t.state !== 'queued') continue;
      // uzak -> uzak: kaynak sekme yeniden bağlanmışsa güncel bağlantısı kullanılır
      if (t.direction === 'relay' && t.srcTab.state !== 'connected') {
        Object.assign(t, { state: 'error', error: `Kaynak (${t.srcTab.title}) bağlı değil` });
        this.renderTransfer(t);
        continue;
      }
      running++;
      t.state = 'starting'; t.started = Date.now(); t.samples = []; t.done = 0; t.total = 0; t.error = null;
      this.renderTransfer(t);
      this.api.sftp.transfer(this.connId, { tid: t.tid, direction: t.direction, items: t.items, resume: t.resume, mkdirs: t.mkdirs, srcConnId: t.srcTab && t.srcTab.connId, direct: !t.resume && (t.method === 'key' || t.method === 'agent') ? t.method : false })
        .catch((e) => this.onTransfer({ tid: t.tid, state: 'error', error: cleanErr(e) }));
    }
  }

  // ---- SFTP ek işleri (ana süreçte sftp:search / compress / extract)
  async compressDownload(sel) {
    if (this.state !== 'connected') { toast('Önce bağlanın', 'err'); return; }
    const dir = this.remote.cwd;
    const names = sel.map((e) => e.name);
    const t = toast(`Sunucuda sıkıştırılıyor: ${names.length === 1 ? names[0] : names.length + ' öğe'}…`, 'info', 600000);
    let arc;
    try { arc = await this.api.sftp.compress(this.connId, dir, names, { tmp: true }); } catch (e) { toast(cleanErr(e), 'err', 7000); return; } finally { t.remove?.(); }
    const lp = this.lpath;
    let dstName = arc.name;
    const taken = new Set(this.local.entries.map((x) => x.name));
    for (let i = 2; taken.has(dstName); i++) dstName = arc.name.replace(/\.tar\.gz$/, `-${i}.tar.gz`);
    const tr = this.enqueue({
      direction: 'download', dest: this.local.cwd, destSide: 'local', destPane: this.local,
      label: dstName, items: [{ src: arc.path, dst: lp.join(this.local.cwd, dstName) }],
    });
    tr.cleanup = arc.path; // bitince / iptalde sunucudaki geçici arşiv silinir
  }

  async compressRemote(sel) {
    const dir = this.remote.cwd;
    const def = (sel.length === 1 ? sel[0].name : posix.basename(dir) || 'arsiv') + '.tar.gz';
    const name = await promptText({ title: 'Sunucuda sıkıştır', label: `${sel.length} öğe → ${dir}`, value: def });
    if (!name || !name.trim()) return;
    const t = toast('Sıkıştırılıyor…', 'info', 600000);
    try {
      const r = await this.api.sftp.compress(this.connId, dir, sel.map((e) => e.name), { name: name.trim() });
      await this.remote.refresh();
      this.remote.sel = new Set([r.name]); this.remote.paintSel(); this.remote.scrollTo(r.name);
      toast(`${r.name} oluşturuldu`, 'ok');
    } catch (e) { toast(cleanErr(e), 'err', 7000); } finally { t.remove?.(); }
  }

  async extractRemote(e) {
    const t = toast(`${e.name} açılıyor…`, 'info', 600000);
    try {
      await this.api.sftp.extract(this.connId, this.remote.cwd, e.name);
      await this.remote.refresh();
      toast(`${e.name} açıldı`, 'ok');
    } catch (err) { toast(cleanErr(err), 'err', 7000); } finally { t.remove?.(); }
  }

  async remoteSearch() {
    if (this.state !== 'connected' || !this.remote.cwd) { toast('Önce bağlanın', 'err'); return; }
    const dir = this.remote.cwd;
    const q = h('input.input', { placeholder: 'ad ya da desen: rapor, *.log, nginx*.conf', spellcheck: false, autofocus: true });
    const info = h('div.hint');
    const list = h('div.rs-list');
    let close;
    const go = async (it) => {
      const parent = posix.dirname(it.path);
      close?.(null);
      await this.remote.cd(parent, posix.basename(it.path));
    };
    const run = async () => {
      if (!q.value.trim()) return;
      info.textContent = 'Aranıyor…'; list.replaceChildren();
      try {
        const r = await this.api.sftp.search(this.connId, dir, q.value);
        info.textContent = r.items.length ? `${r.items.length}${r.truncated ? '+ (ilk 1000)' : ''} sonuç · çift tıklayınca klasörüne gider` : 'Sonuç yok';
        list.replaceChildren(...r.items.map((it) => h('div.rs-item', { title: it.path, ondblclick: () => go(it) },
          icon(it.isDir ? 'folder' : 'file', 14), h('span.rs-name', null, posix.basename(it.path)), h('span.rs-dir.mono', null, posix.dirname(it.path).slice(dir.length).replace(/^\//, '') || '.'),
          h('button.btn.sm', { type: 'button', onclick: () => go(it) }, 'Git'))));
      } catch (e) { info.textContent = cleanErr(e); }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); run(); } });
    await modal({
      title: `Sunucuda ara: ${dir}`, width: 640, bind: (c) => { close = c; },
      body: h('div.rs', null, h('div.row', null, q, h('button.btn.primary', { type: 'button', onclick: run }, icon('search', 14), 'Ara')),
        h('p.hint', null, 'Bu klasör ve tüm alt klasörlerde ada göre arar (büyük/küçük harf fark etmez). Joker yoksa adın içinde geçenler bulunur.'), info, list),
      buttons: [{ label: 'Kapat', value: null }],
    });
  }

  retryTransfer(t) {
    t.state = 'queued'; t.resume = true; t.error = null;
    this.renderTransfer(t);
    this.pump();
    if (this.state !== 'connected') toast('Bağlantı kurulunca aktarım sürecek', 'info');
  }

  cancelTransfer(t) {
    if (t.state === 'queued') this.onTransfer({ tid: t.tid, state: 'cancelled', done: t.done, total: t.total });
    else this.api.sftp.cancel(this.connId, t.tid);
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
      const pane = t.destPane || (t.destSide === 'remote' ? this.remote : this.local);
      if (pane.cwd === t.dest || (t.mkdirs && pane.cwd && pane.cwd.startsWith(t.dest))) pane.refresh();
      const secs = Math.max(0.001, (now - t.started) / 1000);
      const extra = [info.skipped ? `${info.skipped} aynı dosya atlandı` : '', info.resumed ? `${info.resumed} dosya sürdürüldü` : ''].filter(Boolean).join(', ');
      const via = t.via ? ` · ${t.via}` : '';
      toast(`${t.label} ${{ upload: 'yüklendi', download: 'indirildi', relay: 'aktarıldı' }[t.direction]} (${formatSize(t.total)}, ${secs.toFixed(1)} sn)${via}${extra ? ' · ' + extra : ''}`, 'ok');
      // doğrudan denendi ama olmadıysa nedenini bir kez göster
      if (t.fallback) toast(`Doğrudan aktarım olmadı (${t.fallback}); bu bilgisayar üzerinden gönderildi.`, 'info', 7000);
    } else if (info.state === 'error') toast(`Aktarım hatası: ${info.error}`, 'err', 6000);
    // Geçici anahtar kullanıldıysa: silindiği iki tarafta da denetlendi
    if (info.keys && ['done', 'error', 'cancelled'].includes(info.state)) {
      if (info.keys.ok) toast('Geçici anahtarlar silindi: hedefteki authorized_keys satırı ve kaynaktaki geçici klasör kaldırıldı (denetlendi).', 'ok', 7000);
      else toast(`Geçici anahtar tam silinemedi: ${info.keys.detail}. Elle silin; anahtar en geç 30 dakikada kendiliğinden geçersiz olur.`, 'err', 20000);
    }
    if (['done', 'error', 'cancelled'].includes(info.state)) this.pump();
    // Sıkıştırıp indir: sunucudaki geçici arşiv bitince / iptalde silinir (hatada yeniden denemek için kalır)
    if (t.cleanup && (info.state === 'done' || info.state === 'cancelled')) { const p = t.cleanup; t.cleanup = null; this.api.sftp.remove(this.connId, p).catch(() => {}); }
  }

  renderTransfer(t) {
    const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : (t.state === 'done' ? 100 : 0);
    let speed = 0;
    if (t.samples.length > 1) { const [a, b] = [t.samples[0], t.samples[t.samples.length - 1]]; speed = (b[1] - a[1]) / Math.max(0.001, (b[0] - a[0]) / 1000); }
    const running = ['running', 'scanning', 'queued', 'starting'].includes(t.state);
    const stateText = {
      queued: 'Sırada', starting: 'Başlıyor…', scanning: 'Taranıyor…', running: `${formatSize(t.done)} / ${formatSize(t.total)} · ${formatSize(speed)}/s${speed > 0 && t.total ? ' · ' + eta((t.total - t.done) / speed) : ''}`,
      done: `Tamamlandı · ${formatSize(t.total)}`, error: `Hata: ${t.error || ''}`, cancelled: 'İptal edildi',
    }[t.state] || t.state;
    const canRetry = t.state === 'error' || t.state === 'cancelled';
    const row = h('div.xfer.' + t.state, { dataset: { tid: t.tid } },
      icon({ upload: 'upload', download: 'download', relay: 'arrowRight' }[t.direction], 14),
      h('div.xfer-main', null,
        h('div.xfer-line', null, h('span.xfer-name', { title: t.file || t.label }, t.label), h('span.xfer-dest', { title: t.dest }, (t.direction === 'relay' ? `${t.srcTab.title} → ` : '→ ') + t.dest)),
        h('div.bar', null, h('div.bar-fill', { style: { width: pct.toFixed(1) + '%' } })),
        h('div.xfer-info', null, stateText, t.state === 'running' && t.via ? ` · ${t.via}` : null, t.state === 'running' && t.file ? h('span.xfer-file', null, ' · ' + t.file.split('/').pop()) : null)),
      canRetry ? h('button.icon-btn', { title: 'Yeniden dene (kaldığı yerden sürdürür)', onclick: () => this.retryTransfer(t) }, icon('refresh', 14)) : null,
      running ? h('button.icon-btn', { title: 'İptal', onclick: () => this.cancelTransfer(t) }, icon('x', 14))
        : h('button.icon-btn', { title: 'Listeden kaldır', onclick: () => { this.transfers.delete(t.tid); row.remove(); this.updateXferHead(); } }, icon('x', 14)));
    const old = this.xferList.querySelector(`[data-tid="${t.tid}"]`);
    if (old) old.replaceWith(row); else this.xferList.prepend(row);
    this.updateXferHead();
  }

  updateXferHead() {
    const all = [...this.transfers.values()];
    const active = all.filter((t) => ['running', 'scanning', 'queued', 'starting'].includes(t.state)).length;
    this.xfers.classList.toggle('empty', all.length === 0);
    this.xferHead.querySelector('.xfer-count').textContent = active ? `${active} etkin` : `${all.length}`;
    this.app.updateStatus();
  }

  clearFinished() {
    for (const [tid, t] of this.transfers) if (!['running', 'scanning', 'queued', 'starting'].includes(t.state)) { this.transfers.delete(tid); this.xferList.querySelector(`[data-tid="${tid}"]`)?.remove(); }
    this.updateXferHead();
  }

  activeTransfers() { return [...this.transfers.values()].filter((t) => ['running', 'scanning', 'queued', 'starting'].includes(t.state)).length; }

  // ------------------------------------------------------------ klasör eşitleme
  async syncDialog() {
    if (this.state !== 'connected') { toast('Önce bağlanın', 'err'); return; }
    if (!this.local.cwd || !this.remote.cwd) { toast('Yerel ve uzak paneller hazır değil', 'err'); return; }
    const localDir = this.local.cwd; const remoteDir = this.remote.cwd;
    const dir = h('select.input', null,
      h('option', { value: 'upload' }, 'Yerel → Uzak (yükle)'),
      h('option', { value: 'download' }, 'Uzak → Yerel (indir)'));
    const exclude = h('input.input', {
      value: this.app.settings.syncExclude ?? 'node_modules, .git, __pycache__, .DS_Store', spellcheck: false, dataset: { noenter: '1' },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); compare(); } },
    });
    const skipNewer = h('input', { type: 'checkbox', checked: true });
    const del = h('input', { type: 'checkbox' });
    const summary = h('div.sync-summary.muted', null, 'Karşılaştırmak için “Karşılaştır”a basın.');
    const list = h('div.sync-list');
    let diff = null;
    const STATUS = {
      'local-only': 'yalnız yerelde', 'remote-only': 'yalnız uzakta', 'local-newer': 'yerel daha yeni',
      'remote-newer': 'uzak daha yeni', differs: 'farklı',
    };
    // Seçilen yöne göre yapılacaklar: kopyalanacaklar, silinecekler, atlananlar
    const plan = () => {
      const up = dir.value === 'upload';
      const srcOnly = up ? 'local-only' : 'remote-only';
      const dstOnly = up ? 'remote-only' : 'local-only';
      const dstNewer = up ? 'remote-newer' : 'local-newer';
      const copy = []; const remove = []; const skipped = [];
      const under = (arr, rel) => arr.some((x) => x.isDir && rel.startsWith(x.rel + '/'));
      for (const d of diff) {
        if (d.status === srcOnly) { if (!under(copy, d.rel)) copy.push(d); } else if (d.status === dstOnly) { if (del.checked && !under(remove, d.rel)) remove.push(d); } else if (d.local && d.remote && !!d.local.isDir !== !!d.remote.isDir) skipped.push(d); // klasör/dosya çakışması
        else if (d.status === dstNewer && skipNewer.checked) skipped.push(d);
        else copy.push(d);
      }
      return { up, copy, remove, skipped };
    };
    const render = () => {
      if (!diff) return;
      const p = plan();
      const bytes = p.copy.reduce((a, d) => a + ((p.up ? d.local : d.remote)?.size || 0), 0);
      summary.className = 'sync-summary';
      summary.replaceChildren(diff.length
        ? `${p.copy.length} öğe kopyalanacak (${formatSize(bytes)}${p.copy.some((d) => d.isDir) ? ' + klasör içerikleri' : ''})`
          + (p.remove.length ? ` · ${p.remove.length} öğe silinecek` : '') + (p.skipped.length ? ` · ${p.skipped.length} atlanacak` : '')
        : 'Klasörler aynı, eşitlenecek bir şey yok.');
      const row = (d, act) => h('div.sync-row.' + act, null,
        h('span.sync-act', null, { copy: p.up ? '↑' : '↓', remove: '✕', skip: '–' }[act]),
        icon(d.isDir ? 'folder' : 'file', 13),
        h('span.sync-rel', { title: d.rel }, d.rel + (d.isDir ? '/' : '')),
        h('span.sync-st', null, STATUS[d.status]));
      const rows = [...p.copy.map((d) => row(d, 'copy')), ...p.remove.map((d) => row(d, 'remove')), ...p.skipped.map((d) => row(d, 'skip'))];
      list.replaceChildren(...rows.slice(0, 800), ...(rows.length > 800 ? [h('div.muted', null, `… +${rows.length - 800} öğe daha`)] : []));
    };
    dir.onchange = render; skipNewer.onchange = render; del.onchange = render;
    const compare = async () => {
      summary.className = 'sync-summary muted'; summary.textContent = 'Karşılaştırılıyor…'; list.replaceChildren();
      try {
        const ex = exclude.value.split(',').map((x) => x.trim()).filter(Boolean);
        this.app.saveSettings({ syncExclude: exclude.value });
        diff = await this.api.sftp.compare(this.connId, localDir, remoteDir, ex);
        render();
      } catch (e) { diff = null; summary.className = 'sync-summary'; summary.replaceChildren(h('span.warn', null, cleanErr(e))); }
      return false;
    };
    const r = await modal({
      title: 'Klasör eşitleme',
      width: 720,
      cls: 'sync-dialog',
      body: h('div', null,
        h('dl.kv.sync-dirs', null, h('dt', null, 'Yerel'), h('dd.mono', null, localDir), h('dt', null, 'Uzak'), h('dd.mono', null, remoteDir)),
        h('div.grid2', null, h('label.field', null, h('span', null, 'Yön'), dir), h('label.field', null, h('span', null, 'Hariç tut (virgülle; * ? kullanılabilir)'), exclude)),
        h('label.check', null, skipNewer, 'Hedefteki daha yeni dosyaların üzerine yazma'),
        h('label.check', null, del, h('span', null, 'Kaynakta olmayanları hedefte ', h('b.warn', null, 'sil'))),
        summary, list),
      buttons: [{ label: 'Kapat', value: null }, { label: 'Karşılaştır', value: 'compare' }, { label: 'Eşitle', value: 'sync', primary: true }],
      onButton: async (v) => {
        if (v === 'compare') return compare();
        if (v === 'sync') {
          if (!diff) { await compare(); return false; }
          const p = plan();
          if (!p.copy.length && !p.remove.length) { toast('Yapılacak bir şey yok', 'info'); return false; }
          if (p.remove.length) {
            const ok = await modal({
              title: 'Silme onayı', width: 460,
              body: h('div', null, h('p', null, `${p.up ? 'Sunucudan' : 'Bilgisayardan'} ${p.remove.length} öğe silinecek:`),
                h('div.name-list', null, p.remove.slice(0, 12).map((d) => d.rel + (d.isDir ? '/' : '')).join('\n') + (p.remove.length > 12 ? `\n… +${p.remove.length - 12}` : ''))),
              buttons: [{ label: 'Vazgeç', value: null }, { label: 'Sil ve eşitle', value: true, primary: true, danger: true }],
            });
            if (!ok) return false;
          }
          return p;
        }
      },
    });
    if (!r || !r.copy) return;
    const p = r;
    const srcRoot = p.up ? localDir : remoteDir; const dstRoot = p.up ? remoteDir : localDir;
    if (p.copy.length) {
      this.enqueue({
        direction: p.up ? 'upload' : 'download', dest: dstRoot, destSide: p.up ? 'remote' : 'local', mkdirs: true,
        label: `Eşitleme (${p.copy.length} öğe)`,
        items: p.copy.map((d) => ({ src: (p.up ? this.lpath : posix).join(srcRoot, d.rel), dst: (p.up ? posix : this.lpath).join(dstRoot, d.rel) })),
      });
    }
    let removed = 0;
    for (const d of p.remove) {
      try { if (p.up) await this.api.sftp.remove(this.connId, posix.join(dstRoot, d.rel)); else await this.api.local.remove(this.lpath.join(dstRoot, d.rel)); removed++; } catch (e) { toast(`${d.rel}: ${cleanErr(e)}`, 'err'); }
    }
    if (removed) { toast(`${removed} öğe silindi`, 'ok'); (p.up ? this.remote : this.local).refresh(); }
  }

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
