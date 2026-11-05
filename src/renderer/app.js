import { h, icon, parseConnText, debounce, formatSize } from './util.js';
import { modal, promptText, confirmBox, hostKeyDialog, kbdDialog, contextMenu, toast, sessionEditor, settingsDialog, applyUiTheme } from './dialogs.js';
import { SessionTab } from './tab.js';
import { cleanErr } from './filepane.js';
import { checkDialog } from './conncheck.js';
import { execDialog, statsDialog } from './bulk.js';
import { snippetPalette, snippetsEditor, keysDialog, installKeyDialog } from './tools.js';
import { updateDialog } from './update.js';
import { accountDialog, STATE_TEXT, syncTimeText } from './account.js';

const api = window.api;

// "az önce", "12 dk önce", "dün 14:05", "3 Eki"
function recentWhen(t) {
  const d = new Date(t); const now = new Date();
  const min = Math.round((now - d) / 60000);
  if (min < 1) return 'az önce';
  if (min < 60) return `${min} dk önce`;
  const hm = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.toDateString() === new Date(now - 86400000).toDateString()) return `dün ${hm}`;
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

class App {
  constructor() {
    this.api = api;
    this.tabs = [];
    this.active = null;
    this.selectedSidebar = null;
    try { this.groupRatio = Math.min(0.85, Math.max(0.15, Number(localStorage.getItem('groupRatio')) || 0.5)); } catch { this.groupRatio = 0.5; }
    try { this.collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]')); } catch { this.collapsed = new Set(); }
  }

  async init() {
    const d = await api.init();
    this.sessions = d.sessions;
    this.settings = d.settings;
    this.home = d.home;
    this.platform = d.platform;
    this.logDefaultDir = d.logDefaultDir;
    this.secrets = d.secrets;
    this.version = d.version;
    this.account = await api.account.status();
    applyUiTheme(this.settings.uiTheme);
    this.applyTabActivity();
    this.build();
    this.renderSidebar();
    this.renderTabs();
    this.setAccount(this.account);
    this.bindIpc();
    this.bindKeys();
    if (this.settings.masterEnabled && !this.settings.masterUnlocked) this.promptUnlock().then(() => this.focusHome());
    else this.focusHome();
  }

  // Ana ekranda (açık sekme yokken) odak arama kutusunda: yazınca doğrudan oturum aranır
  focusHome() {
    if (!this.tabs.length && !document.querySelector('.overlay')) this.filter.focus();
  }

  // Startup unlock: loops until the correct master password is entered, or the user skips.
  async promptUnlock() {
    for (;;) {
      const pw = await promptText({ title: 'SSHDeck kilidi', label: 'Ana parolanızı girin (kayıtlı parolalara erişmek için)', password: true, ok: 'Kilidi aç', cancel: 'Atla' });
      if (pw == null) { toast('Kilit açılmadı; kayıtlı parolalar bağlanırken sorulacak.', 'info', 5000); return; }
      if (await api.master.unlock(pw)) { this.settings.masterUnlocked = true; toast('Kilit açıldı', 'ok'); return; }
      toast('Ana parola yanlış', 'err');
    }
  }

  // ------------------------------------------------------------ layout
  build() {
    const tbtn = (ic, title, fn, cls = '') => h('button.tool' + cls, { title, onclick: fn }, icon(ic, 17));
    this.quickInput = h('input.quick-input', {
      placeholder: 'Hızlı bağlan:  kullanici@sunucu:port  — veya bağlantı bilgilerini yapıştırın',
      spellcheck: false,
      // Pasting into an empty (or fully selected) box connects right away: "ad / ip / kullanıcı / parola" blocks etc.
      onpaste: (e) => {
        const el = this.quickInput;
        if (el.value && !(el.selectionStart === 0 && el.selectionEnd === el.value.length)) return;
        const q = parseConnText(e.clipboardData?.getData('text') || '');
        if (!q) return;
        e.preventDefault();
        this.quickConnect(q);
      },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.quickConnect(this.quickInput.value); } if (e.key === 'Escape') { this.quickInput.value = ''; this.active?.focus(); } },
    });
    this.btnSidebar = tbtn('sidebar', 'Oturum listesi (Ctrl+Shift+B)', () => this.toggleSidebar(), '.on');
    this.btnSftp = tbtn('files', 'SFTP dosya paneli (Ctrl+Shift+E)', () => this.active?.toggleSftp() || this.syncToolbar());
    this.btnTunnels = tbtn('tunnel', 'Tüneller', () => this.active?.tunnelsDialog());
    this.btnBroadcast = tbtn('broadcast', 'Tüm sekmelere gönder', () => this.toggleBroadcast());
    this.btnSnippets = tbtn('snippet', 'Hazır komutlar (Ctrl+Shift+K)', () => this.snippetPalette());
    this.btnSplit = tbtn('splitH', 'Terminali böl (Ctrl+Shift+D sağa, Ctrl+Shift+S aşağı)', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, [
        { label: 'Sağa böl', icon: 'splitH', hint: 'Ctrl+Shift+D', action: () => this.active?.splitPane('h') },
        { label: 'Aşağı böl', icon: 'splitV', hint: 'Ctrl+Shift+S', action: () => this.active?.splitPane('v') },
        { label: 'Bölmeyi kapat', icon: 'x', hint: 'Ctrl+Shift+W', disabled: !(this.active && this.active.panes.length > 1), action: () => this.active?.closePane() },
      ]);
    });
    this.btnFocus = tbtn('focus', 'Odak modu (Alt+Enter)', () => this.toggleFocus());
    const toolbar = h('header.toolbar', null,
      h('div.brand', null, icon('terminal', 18), h('span', null, 'SSH', h('b', null, 'Deck'))),
      h('button.btn.primary.sm', { onclick: () => this.newSession(), title: 'Yeni oturum (Ctrl+Shift+N)' }, icon('plus', 14), 'Yeni oturum'),
      h('div.quick', null, icon('bolt', 14), this.quickInput),
      h('div.spacer'),
      this.btnSidebar, this.btnSftp, this.btnSplit, this.btnTunnels, this.btnSnippets, this.btnBroadcast, this.btnFocus,
      h('span.tool-sep'),
      tbtn('import', 'İçe aktar (SSH config, WindTerm, Xshell)', (e) => { const r = e.currentTarget.getBoundingClientRect(); this.importMenu(r.left, r.bottom + 4); }),
      (this.btnAccount = tbtn('cloud', 'Hesap ve eşitleme', () => accountDialog(this))),
      tbtn('gear', 'Ayarlar', () => this.openSettings()));

    // Arama: yazdıkça ilk eşleşme seçilir; ↑/↓ (Home/End) ile gezilir, Enter bağlanır, Esc temizler
    this.filter = h('input.input.sm.filter', {
      placeholder: 'Oturum ara… (↑↓, Enter)', spellcheck: false,
      oninput: debounce(() => {
        if (this.selectedSidebar?.type === 'session') this.selectedSidebar = null;
        this.renderSidebar();
        if (this.filter.value.trim()) this.moveSidebarSel(1);
      }, 80),
      onkeydown: (e) => this.sidebarNavKey(e, true),
    });
    this.tree = h('div.tree', { tabindex: 0 });
    this.tree.addEventListener('keydown', (e) => {
      if (this.sidebarNavKey(e, false)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedSidebar) {
        e.preventDefault();
        if (this.selectedSidebar.type === 'group') this.deleteGroup(this.selectedSidebar.path);
        else { const s = this.sessions.find((x) => x.id === this.selectedSidebar.id); if (s) this.deleteSession(s); }
      }
    });
    this.tree.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.s-item, .g-item')) return;
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Yeni oturum', icon: 'plus', action: () => this.newSession() },
        '-',
        { label: 'Tümünü genişlet', icon: 'expand', action: () => this.expandAll() },
        { label: 'Tümünü daralt', icon: 'collapse', action: () => this.collapseAll() },
        '-',
        ...this.bulkItems(this.sessions.map((s) => s.id)),
        '-',
        ...this.importItems(),
      ]);
    });
    this.dropTarget(this.tree, '');
    this.sidebar = h('aside.sidebar', null,
      h('div.side-head', null, h('span', null, 'Oturumlar'),
        h('div.side-head-btns', null,
          h('button.icon-btn', { title: 'Tümünü genişlet', onclick: () => this.expandAll() }, icon('expand', 15)),
          h('button.icon-btn', { title: 'Tümünü daralt', onclick: () => this.collapseAll() }, icon('collapse', 15)),
          h('button.icon-btn', { title: 'Toplu işlemler: bağlantı denetimi, sunucularda komut, sunucu özeti', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); contextMenu(r.left, r.bottom + 4, this.bulkItems(this.sessions.map((s) => s.id))); } }, icon('cpu', 15)),
          h('button.icon-btn', { title: 'Yeni oturum', onclick: () => this.newSession() }, icon('plus', 15)))),
      h('div.side-filter', null, this.filter), this.tree);
    const sideResize = h('div.side-resize');
    sideResize.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const move = (ev) => { this.sidebar.style.width = Math.min(480, Math.max(180, ev.clientX)) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing-h'); this.fitAll(); };
      document.body.classList.add('resizing-h');
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });

    // Ekran iki sekme grubuna bölünebilir (yan yana iki ayrı bağlantı); her grubun kendi sekme çubuğu var
    this.tabGroups = [this.makeGroup(0), this.makeGroup(1)];
    this.welcome = this.buildWelcome();
    this.tabGroups[0].views.append(this.welcome);
    this.groupGutter = h('div.tgroup-gutter', { title: 'Sürükleyerek boyutlandır, çift tıkla eşitle' });
    this.groupGutter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const box = this.tabGroupsEl.getBoundingClientRect();
      const move = (ev) => { this.groupRatio = Math.min(0.85, Math.max(0.15, (ev.clientX - box.left) / box.width)); this.layoutGroups(); };
      const up = () => {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing-h');
        try { localStorage.setItem('groupRatio', String(this.groupRatio)); } catch {}
      };
      document.body.classList.add('resizing-h');
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    this.groupGutter.addEventListener('dblclick', () => { this.groupRatio = 0.5; this.layoutGroups(); try { localStorage.setItem('groupRatio', '0.5'); } catch {} });
    this.dropHint = h('div.group-drop');
    this.tabGroupsEl = h('div.tgroups', null, this.tabGroups[0].el, this.groupGutter, this.tabGroups[1].el, this.dropHint);
    this.bindGroupDrop();

    this.bcInput = h('input.input.sm', {
      placeholder: 'Komut yazın — Enter ile tüm bağlı sekmelere gönderilir',
      spellcheck: false,
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.broadcast(this.bcInput.value + '\r'); this.bcInput.value = ''; }
        if (e.key === 'Escape') this.toggleBroadcast(false);
      },
    });
    this.bcCount = h('span.bc-count');
    this.bcBar = h('div.broadcast', null, icon('broadcast', 14), this.bcInput, this.bcCount,
      h('button.btn.sm', { onclick: () => this.broadcast('\x03') }, 'Ctrl+C gönder'),
      h('button.icon-btn', { title: 'Kapat', onclick: () => this.toggleBroadcast(false) }, icon('x', 14)));

    this.sbLeft = h('span.sb-left');
    this.sbMid = h('span.sb-mid');
    this.sbStats = h('span.sb-stats');
    this.sbRight = h('span.sb-right');
    this.statusbar = h('footer.statusbar', null, this.sbLeft, this.sbMid, this.sbStats, this.sbRight);

    this.toolbar = toolbar;
    this.main = h('main.main', null, this.tabGroupsEl, this.bcBar, this.statusbar);
    document.getElementById('app').append(toolbar, h('div.body', null, this.sidebar, sideResize, this.main));
    this.syncToolbar();
    this.applyFocusClasses();
  }

  buildWelcome() {
    const card = (ic, title, desc, fn) => h('button.w-card', { onclick: fn }, icon(ic, 22), h('b', null, title), h('span', null, desc));
    return h('div.welcome', null,
      h('div.w-inner', null,
        h('div.w-logo', null, icon('terminal', 40)),
        h('h1', null, 'SSH', h('b', null, 'Deck')),
        h('p.muted', null, 'SSH terminali ve SFTP dosya yöneticisi bir arada.'),
        (this.recentEl = h('div.w-recent')),
        h('div.w-cards', null,
          card('plus', 'Yeni oturum', 'Sunucu bilgilerini kaydedin', () => this.newSession()),
          card('bolt', 'Hızlı bağlan', 'kullanici@sunucu yazın veya bağlantı bilgilerini yapıştırın', () => this.quickInput.focus()),
          card('import', 'İçe aktar', 'SSH config, WindTerm veya Xshell oturumları', (e) => this.importMenu(e.clientX, e.clientY))),
        h('div.w-keys', null,
          ...[['Ctrl+Shift+N', 'Yeni oturum'], ['Ctrl+Shift+T', 'Sekmeyi çoğalt'], ['Ctrl+Shift+W', 'Bölmeyi / sekmeyi kapat'], ['Ctrl+Tab', 'Sonraki sekme'],
            ['Ctrl+Shift+D / S', 'Sağa / aşağı böl'], ['Ctrl+Shift+M', 'Sekmeyi yana ayır'], ['Ctrl+Shift+PgUp / PgDn', 'Sekmeyi sola / sağa al'], ['Alt+Shift+Oklar', 'Bölmeler arası geç'], ['Ctrl+Shift+K', 'Hazır komutlar'],
            ['Ctrl+Shift+E', 'SFTP paneli'], ['Ctrl+Shift+F', 'Terminalde ara'], ['Ctrl+Shift+C / V', 'Kopyala / yapıştır'], ['Ctrl + / −', 'Yazı boyutu'], ['Alt+Enter', 'Odak modu']]
            .map(([k, v]) => h('div.w-key', null, h('kbd', null, k), h('span', null, v))))));
  }

  // Açılış ekranındaki son bağlantılar: tek tıkla bağlanır
  renderRecent() {
    if (!this.recentEl) return;
    const byId = new Map(this.sessions.map((s) => [s.id, s]));
    const list = (this.settings.recent || []).filter((r) => byId.has(r.id)).slice(0, 6);
    this.recentEl.replaceChildren(...(list.length ? [
      h('div.w-recent-head', null, 'Son bağlantılar'),
      ...list.map((r) => {
        const s = byId.get(r.id);
        return h('button.w-recent-row', { type: 'button', title: 'Bağlan', onclick: () => this.openSession(s.id) },
          icon('terminal', 15),
          h('b', null, s.name || s.host),
          h('span.muted', null, `${s.username ? s.username + '@' : ''}${s.host}${Number(s.port || 22) !== 22 ? ':' + s.port : ''}`),
          h('span.w-recent-when', null, recentWhen(r.t)),
          icon('play', 13));
      })] : []));
  }

  toggleSidebar(v) {
    const show = v === undefined ? this.sidebar.style.display === 'none' : v;
    this.sidebar.style.display = show ? '' : 'none';
    this.sidebar.nextElementSibling.style.display = show ? '' : 'none';
    this.btnSidebar.classList.toggle('on', show);
    this.fitAll();
  }

  // Odak modu: seçili arayüz parçalarını gizleyip terminale yer açar. CSS sınıflarıyla
  // çalışır ki kenar çubuğu vb. kendi aç/kapa durumuna dokunmadan geri gelebilsin.
  applyFocusClasses() {
    const el = document.getElementById('app');
    const hide = this.settings.focusHide || {};
    el.classList.toggle('fh-toolbar', hide.toolbar !== false);
    el.classList.toggle('fh-sidebar', hide.sidebar !== false);
    el.classList.toggle('fh-tabs', hide.tabs !== false);
    el.classList.toggle('fh-status', hide.status !== false);
    el.classList.toggle('fh-sftp', hide.sftp === true); // varsayılan: SFTP görünür kalır
    el.classList.toggle('focus', !!this.focus);
    this.btnFocus.classList.toggle('on', !!this.focus);
  }

  toggleFocus(v) {
    this.focus = v === undefined ? !this.focus : v;
    this.applyFocusClasses();
    if (this.focus && !this._focusHinted) { this._focusHinted = true; toast('Odak modu açık — çıkmak için Alt+Enter', 'info', 4000); }
    this.fitAll();
    this.active?.focus();
  }

  toggleBroadcast(v) {
    const show = v === undefined ? !this.bcBar.classList.contains('on') : v;
    this.bcBar.classList.toggle('on', show);
    this.btnBroadcast.classList.toggle('on', show);
    this.updateBcCount();
    if (show) this.bcInput.focus(); else this.active?.focus();
    this.fitAll();
  }

  updateBcCount() {
    const n = this.tabs.filter((t) => t.state === 'connected').length;
    this.bcCount.textContent = `${n} sekme`;
  }

  broadcast(text) {
    const targets = this.tabs.filter((t) => t.state === 'connected');
    for (const t of targets) t.writeActive(text);
    if (!targets.length) toast('Bağlı sekme yok', 'err');
  }

  snippetPalette() { snippetPalette(this); }

  installKeyDialog(tab) { installKeyDialog(this, tab); }

  syncToolbar() {
    const t = this.active;
    this.btnSftp.classList.toggle('on', !!(t && t.sftpVisible));
    this.btnSftp.disabled = !t;
    this.btnTunnels.disabled = !(t && t.state === 'connected');
    this.btnSplit.disabled = !t || !!t.sftpOnly;
  }

  // ------------------------------------------------------------ sidebar
  expandAll() { this.collapsed.clear(); this._saveCollapsed(); this.renderSidebar(); }

  collapseAll() { for (const g of this.groups()) this.collapsed.add(g); this._saveCollapsed(); this.renderSidebar(); }

  _saveCollapsed() { try { localStorage.setItem('collapsed', JSON.stringify([...this.collapsed])); } catch {} }

  groups() {
    const set = new Set();
    for (const s of this.sessions) {
      if (!s.group) continue;
      const parts = s.group.split('/');
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'tr'));
  }

  renderSidebar() {
    this.renderRecent();
    const q = this.filter.value.trim().toLowerCase();
    const match = (s) => !q || [s.name, s.host, s.username, s.group].some((v) => v && String(v).toLowerCase().includes(q));
    const root = { name: '', path: '', groups: new Map(), items: [] };
    for (const s of this.sessions.filter(match)) {
      let node = root;
      if (s.group) {
        for (const part of s.group.split('/')) {
          const p = node.path ? node.path + '/' + part : part;
          if (!node.groups.has(part)) node.groups.set(part, { name: part, path: p, groups: new Map(), items: [] });
          node = node.groups.get(part);
        }
      }
      node.items.push(s);
    }
    const coll = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });
    const count = (n) => n.items.length + [...n.groups.values()].reduce((a, g) => a + count(g), 0);
    const openIds = new Set(this.tabs.filter((t) => t.state === 'connected').map((t) => t.sessionId));
    const renderNode = (node, depth) => {
      const out = [];
      for (const g of [...node.groups.values()].sort((a, b) => coll.compare(a.name, b.name))) {
        const collapsed = !q && this.collapsed.has(g.path);
        const gsel = this.selectedSidebar && this.selectedSidebar.type === 'group' && this.selectedSidebar.path === g.path;
        const row = h('div.g-item' + (collapsed ? '.collapsed' : '') + (gsel ? '.sel' : ''), { style: { paddingLeft: 8 + depth * 14 + 'px' }, dataset: { path: g.path } },
          h('span.chev', null, icon('chevron', 12)), icon('folder', 14), h('span.g-name', null, g.name), h('span.g-count', null, count(g)));
        row.onclick = () => { this.selectedSidebar = { type: 'group', path: g.path }; if (this.collapsed.has(g.path)) this.collapsed.delete(g.path); else this.collapsed.add(g.path); localStorage.setItem('collapsed', JSON.stringify([...this.collapsed])); this.renderSidebar(); };
        row.oncontextmenu = (e) => { e.preventDefault(); this.groupMenu(e.clientX, e.clientY, g.path); };
        this.dropTarget(row, g.path);
        out.push(row);
        if (!collapsed) out.push(...renderNode(g, depth + 1));
      }
      for (const s of node.items.sort((a, b) => coll.compare(a.name, b.name))) {
        const ssel = this.selectedSidebar && this.selectedSidebar.type === 'session' && this.selectedSidebar.id === s.id;
        const row = h('div.s-item' + (openIds.has(s.id) ? '.live' : '') + (ssel ? '.sel' : ''), { style: { paddingLeft: 8 + depth * 14 + 'px' }, dataset: { id: s.id }, draggable: 'true', title: `${s.username || '?'}@${s.host}:${s.port || 22}${s.notes ? '\n\n' + s.notes : ''}` },
          h('span.s-dot'), icon('server', 14),
          h('span.s-text', null, h('span.s-name', null, s.name), h('span.s-host', null, `${s.username ? s.username + '@' : ''}${s.host}${Number(s.port) !== 22 ? ':' + s.port : ''}`)),
          s.jumpHostId ? h('span.s-badge', { title: 'Jump host üzerinden' }, '⇢') : null,
          (s.forwards || []).length ? h('span.s-badge', { title: `${s.forwards.length} tünel` }, icon('tunnel', 11)) : null);
        row.onclick = () => { this.selectedSidebar = { type: 'session', id: s.id }; this.renderSidebar(); };
        row.ondblclick = () => this.openSession(s.id);
        row.oncontextmenu = (e) => { e.preventDefault(); this.sessionMenu(e.clientX, e.clientY, s); };
        row.ondragstart = (e) => { e.dataTransfer.setData('x-session', s.id); e.dataTransfer.effectAllowed = 'copyMove'; };
        out.push(row);
      }
      return out;
    };
    const rows = renderNode(root, 0);
    this.tree.replaceChildren(...(rows.length ? rows : [h('div.tree-empty', null, q ? 'Eşleşen oturum yok' : h('span', null, 'Henüz oturum yok.', h('br'), h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.newSession(); } }, 'Yeni oturum ekleyin')))]));
  }

  /** Görünen oturum satırları arasında seçimi d kadar kaydırır (seçim yoksa ilk/son). Grup satırları atlanır. */
  moveSidebarSel(d, edge) {
    const items = [...this.tree.querySelectorAll('.s-item')];
    if (!items.length) return null;
    let i = items.findIndex((r) => r.classList.contains('sel'));
    if (edge) i = d > 0 ? items.length - 1 : 0;
    else i = i < 0 ? (d > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + d));
    const row = items[i];
    this.selectedSidebar = { type: 'session', id: row.dataset.id };
    for (const r of this.tree.querySelectorAll('.sel')) r.classList.remove('sel');
    row.classList.add('sel');
    row.scrollIntoView({ block: 'nearest' });
    return row;
  }

  /** Arama kutusu ve liste için ortak tuşlar; işlendiyse true. */
  sidebarNavKey(e, inFilter) {
    const page = Math.max(1, Math.floor(this.tree.clientHeight / 38) - 1);
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    if (moves[e.key] && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.moveSidebarSel(moves[e.key]); return true; }
    // arama kutusunda Home/End imleci taşır; yalnız listede başa/sona gider
    if (!inFilter && (e.key === 'Home' || e.key === 'End')) { e.preventDefault(); this.moveSidebarSel(e.key === 'End' ? 1 : -1, true); return true; }
    if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      const sel = this.tree.querySelector('.s-item.sel') || (inFilter ? this.tree.querySelector('.s-item') : null);
      if (!sel) return false;
      e.preventDefault();
      this.openSession(sel.dataset.id, e.shiftKey ? { group: this.sideGroup() } : undefined);
      return true;
    }
    if (e.key === 'Escape' && inFilter) {
      e.preventDefault();
      if (this.filter.value) { this.filter.value = ''; this.renderSidebar(); } else this.active?.focus();
      return true;
    }
    return false;
  }

  dropTarget(el, group) {
    el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('x-session')) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', async (e) => {
      el.classList.remove('drop');
      const id = e.dataTransfer.getData('x-session');
      if (!id) return;
      e.preventDefault(); e.stopPropagation();
      const s = this.sessions.find((x) => x.id === id);
      if (s && (s.group || '') !== group) await this.saveSession({ id, group });
    });
  }

  sessionMenu(x, y, s) {
    contextMenu(x, y, [
      { label: 'Bağlan', icon: 'play', hint: 'Çift tık', action: () => this.openSession(s.id) },
      { label: 'Yanda aç (ekranı böl)', icon: 'splitH', action: () => this.openSession(s.id, { group: this.sideGroup() }) },
      { label: 'Yalnızca SFTP ile aç', icon: 'files', action: () => this.openSession(s.id, { sftpOnly: true }) },
      '-',
      { label: 'Düzenle…', icon: 'edit', action: () => this.editSession(s) },
      { label: 'Kopyasını oluştur', icon: 'plus', action: () => this.duplicateSession(s) },
      { label: 'Bağlantıyı denetle…', icon: 'check', action: () => checkDialog(this, [s.id], 'Bağlantı denetimi') },
      { label: 'ssh komutunu kopyala', icon: 'terminal', action: () => api.clipboard.write(`ssh ${Number(s.port) !== 22 ? `-p ${s.port} ` : ''}${s.username ? s.username + '@' : ''}${s.host}`) },
      '-',
      { label: 'Sil', icon: 'trash', danger: true, action: () => this.deleteSession(s) },
    ]);
  }

  groupMenu(x, y, path) {
    contextMenu(x, y, [
      { label: 'Bu gruba yeni oturum', icon: 'plus', action: () => this.newSession({ group: path }) },
      { label: 'Gruptaki tüm oturumlara bağlan', icon: 'play', action: () => { for (const s of this.sessions.filter((s) => s.group === path || (s.group || '').startsWith(path + '/'))) this.openSession(s.id); } },
      ...this.bulkItems(this.sessions.filter((s) => s.group === path || (s.group || '').startsWith(path + '/')).map((s) => s.id), `“${path}”`),
      { label: 'Grubu yeniden adlandır…', icon: 'edit', action: async () => {
        const n = await promptText({ title: 'Grubu yeniden adlandır', label: 'Yeni ad (alt grup için / kullanın)', value: path });
        if (n && n.trim() && n.trim() !== path) { this.sessions = await api.sessions.renameGroup(path, n.trim().replace(/^\/+|\/+$/g, '')); this.renderSidebar(); }
      } },
      '-',
      { label: 'Grubu sil', icon: 'trash', danger: true, action: () => this.deleteGroup(path) },
    ]);
  }

  async deleteGroup(path) {
    const n = this.sessions.filter((s) => s.group === path || (s.group || '').startsWith(path + '/')).length;
    const ok = await confirmBox({ title: 'Grubu sil', message: `“${path}” grubu silinsin mi?`, detail: `Bu grup ve alt gruplarındaki ${n} oturum kalıcı olarak silinir.`, ok: 'Sil', danger: true });
    if (!ok) return;
    const r = await api.sessions.deleteGroup(path);
    this.sessions = r.sessions;
    this.selectedSidebar = null;
    this.renderSidebar();
    toast(`${r.removed} oturum silindi`, 'ok');
  }

  // ------------------------------------------------------------ sessions CRUD
  async saveSession(s) {
    const r = await api.sessions.save(s);
    this.sessions = r.sessions;
    this.renderSidebar();
    for (const t of this.tabs) if (t.sessionId === r.id) { t.title = this.sessions.find((x) => x.id === r.id)?.name || t.title; }
    this.renderTabs();
    return r.id;
  }

  async newSession(preset = {}) {
    const r = await sessionEditor({ session: preset, sessions: this.sessions, groups: this.groups(), secrets: this.secrets, api });
    if (!r) return;
    const id = await this.saveSession(r.session);
    if (r.connect) this.openSession(id);
  }

  async editSession(s) {
    const r = await sessionEditor({ session: s, sessions: this.sessions, groups: this.groups(), secrets: this.secrets, api });
    if (!r) return;
    const id = await this.saveSession(r.session);
    if (r.connect) this.openSession(id);
  }

  async duplicateSession(s) {
    const copy = { ...s, id: undefined, name: s.name + ' (kopya)' };
    delete copy.has_password; delete copy.has_passphrase;
    await this.newSession(copy);
  }

  async deleteSession(s) {
    const ok = await confirmBox({ title: 'Oturumu sil', message: `“${s.name}” oturumu silinsin mi?`, detail: 'Kayıtlı parola ve ayarlar da silinir.', ok: 'Sil', danger: true });
    if (!ok) return;
    this.sessions = await api.sessions.remove(s.id);
    if (this.selectedSidebar && this.selectedSidebar.id === s.id) this.selectedSidebar = null;
    this.renderSidebar();
  }

  async importSshConfig() {
    try {
      const r = await api.sessions.importSshConfig();
      this.sessions = r.sessions;
      this.collapsed.delete('ssh config');
      this.renderSidebar();
      if (!r.found) toast('~/.ssh/config içinde host bulunamadı', 'info');
      else toast(r.added ? `${r.added} oturum “ssh config” grubuna eklendi` : 'Tüm hostlar zaten ekli', 'ok');
    } catch (e) { toast(cleanErr(e), 'err'); }
  }

  /** Toplu işlemler menüsü (ids: ilgili oturumlar; where: başlıkta grup adı) */
  bulkItems(ids, where) {
    const t = (x) => (where ? `${where}: ${x.toLocaleLowerCase('tr')}` : x);
    return [
      { label: where ? 'Gruptaki bağlantıları denetle…' : 'Bağlantıları denetle…', icon: 'check', action: () => checkDialog(this, ids, t('Bağlantı denetimi')) },
      { label: where ? 'Gruptaki sunucularda komut çalıştır…' : 'Sunucularda komut çalıştır…', icon: 'terminal', action: () => execDialog(this, ids, t('Sunucularda komut')) },
      { label: where ? 'Gruptaki sunucuların özeti…' : 'Sunucu özeti (CPU, bellek, disk)…', icon: 'cpu', action: () => statsDialog(this, ids, t('Sunucu özeti')) },
    ];
  }

  importItems() {
    return [
      { label: '~/.ssh/config içe aktar', icon: 'import', action: () => this.importSshConfig() },
      { label: 'WindTerm oturumları…', icon: 'import', action: () => this.importFrom('windterm') },
      { label: 'Xshell Sessions klasörü…', icon: 'folder', action: () => this.importFrom('xshell-dir') },
      { label: 'Xshell dosyaları (.xsh / .xts)…', icon: 'file', action: () => this.importFrom('xshell-files') },
    ];
  }

  importMenu(x, y) { contextMenu(x, y, this.importItems()); }

  async importFrom(kind) {
    try {
      const r = await api.sessions.import(kind);
      if (!r) return;
      this.sessions = r.sessions;
      this.renderSidebar();
      if (!r.found) toast('İçe aktarılacak SSH oturumu bulunamadı', 'info');
      else if (!r.added) toast('Tüm oturumlar zaten ekli', 'info', 6000);
      else {
        const pw = r.withPassword ? `${r.withPassword} tanesinin parolası da alındı` : 'Parolalar alınamadı; ilk bağlantıda sorulur';
        toast(`${r.added} oturum eklendi${r.found > r.added ? ` (${r.found - r.added} zaten vardı)` : ''}. ${pw}.`, 'ok', 6000);
      }
    } catch (e) { toast(cleanErr(e), 'err', 6000); }
  }

  setUpdate(st) { this.update = st; this.updateStatus(); }

  async openSettings() {
    const r = await settingsDialog(this.settings, {
      logDefaultDir: this.logDefaultDir,
      api,
      onSnippets: () => snippetsEditor(this),
      onKeys: () => keysDialog(this),
      masterEnabled: !!this.settings.masterEnabled,
      onManageMaster: () => this.manageMaster(),
      onExport: () => this.exportBackup(),
      onImport: () => this.importBackup(),
      onCheckUpdate: () => updateDialog(this, { check: true }),
      version: this.version,
    });
    if (!r) return;
    const updChanged = r.autoUpdate !== (this.settings.autoUpdate !== false);
    await this.saveSettings(r);
    if (updChanged) api.update.schedule();
    this.applyTabActivity();
    for (const t of this.tabs) t.applySettings();
    this.applyFocusClasses();
    this.updateStatus();
    this.fitAll();
  }

  async manageMaster() {
    const askNew = async () => {
      const p1 = await promptText({ title: 'Ana parola', label: 'Yeni ana parola', password: true });
      if (p1 == null) return undefined;
      if (!p1) { toast('Boş parola olmaz', 'err'); return undefined; }
      const p2 = await promptText({ title: 'Ana parola', label: 'Yeni ana parolayı tekrar girin', password: true });
      if (p2 == null) return undefined;
      if (p1 !== p2) { toast('Parolalar eşleşmiyor', 'err'); return undefined; }
      return p1;
    };
    try {
      if (!this.settings.masterEnabled) {
        const np = await askNew();
        if (np === undefined) return;
        const res = await api.master.set(null, np);
        this.applyMasterResult(res, true);
        toast('Ana parola belirlendi. Tüm kayıtlı parolalar bununla şifrelendi.', 'ok', 5000);
      } else {
        const act = await modal({
          title: 'Ana parola', width: 420,
          body: h('p', null, 'Ana parola ayarlı. Ne yapmak istersiniz?'),
          buttons: [{ label: 'Vazgeç', value: null }, { label: 'Kaldır', value: 'remove', danger: true }, { label: 'Değiştir', value: 'change', primary: true }],
        });
        if (!act) return;
        const oldP = await promptText({ title: 'Ana parola', label: 'Mevcut ana parola', password: true });
        if (oldP == null) return;
        if (act === 'remove') {
          await api.master.set(oldP, '');
          this.applyMasterResult({ }, false);
          toast('Ana parola kaldırıldı. Parolalar anahtarlık/base64 ile saklanıyor.', 'ok', 5000);
        } else {
          const np = await askNew();
          if (np === undefined) return;
          await api.master.set(oldP, np);
          this.applyMasterResult({ }, true);
          toast('Ana parola değiştirildi', 'ok');
        }
      }
    } catch (e) { toast(cleanErr(e), 'err', 6000); }
  }

  applyMasterResult(res, enabled) {
    this.settings.masterEnabled = enabled;
    this.settings.masterUnlocked = true;
    if (res && res.secrets) this.secrets = res.secrets;
    this.updateStatus();
  }

  async exportBackup() {
    const withSecrets = await modal({
      title: 'Yedeği dışa aktar', width: 440,
      body: h('div', null, h('p', null, 'Kayıtlı parolalar yedeğe eklensin mi?'),
        h('p.hint', null, 'Eklenirse ayrı bir yedek parolasıyla şifrelenir; geri yüklerken o parola sorulur.')),
      buttons: [{ label: 'Vazgeç', value: null }, { label: 'Parolasız', value: 'no' }, { label: 'Parolalar dahil', value: 'yes', primary: true }],
    });
    if (!withSecrets) return;
    try {
      const r = await api.backup.export(withSecrets === 'yes');
      if (r && r.ok) toast(`Yedek kaydedildi: ${r.path}`, 'ok', 6000);
      else if (r && r.error) toast(r.error, 'err');
    } catch (e) { toast(cleanErr(e), 'err', 6000); }
  }

  async importBackup() {
    try {
      const r = await api.backup.import();
      if (!r) return;
      if (!r.ok) { toast(r.error || 'İçe aktarılamadı', 'err'); return; }
      this.sessions = r.sessions;
      if (r.settings) this.applyNewSettings(r.settings);
      this.renderSidebar();
      const pw = r.withPassword ? `, ${r.withPassword} parola çözüldü` : '';
      toast(`${r.added} yeni, ${r.updated} güncellenen oturum${pw}.`, 'ok', 6000);
    } catch (e) { toast(cleanErr(e), 'err', 6000); }
  }

  // Dışarıdan gelen ayarlar (yedek, hesap eşitlemesi): ana parola durumu bu cihazınki kalır
  applyNewSettings(settings) {
    const keepMaster = { masterEnabled: this.settings.masterEnabled, masterUnlocked: this.settings.masterUnlocked };
    this.settings = { ...settings, ...keepMaster };
    applyUiTheme(this.settings.uiTheme);
    this.applyTabActivity();
    for (const t of this.tabs) t.applySettings();
    this.applyFocusClasses();
    this.updateStatus();
    this.fitAll();
  }

  setAccount(st) {
    this.account = st;
    this.btnAccount.classList.toggle('on', !!st.loggedIn);
    this.btnAccount.title = st.loggedIn ? `Hesap: ${st.user} (${STATE_TEXT[st.state] || st.state})` : 'Hesap ve eşitleme';
    this.updateStatus();
  }

  async saveSettings(patch) {
    Object.assign(this.settings, patch);
    this.settings = await api.saveSettings(patch);
  }

  // ------------------------------------------------------------ tabs
  openSession(id, opts = {}) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    this.saveSettings({ recent: [{ id, t: Date.now() }, ...(this.settings.recent || []).filter((r) => r.id !== id)].slice(0, 20) }).catch(() => {});
    this.renderRecent();
    const tab = new SessionTab(this, { sessionId: id, title: s.name });
    if (opts.sftpOnly) { tab.sftpVisible = true; tab.sftpOnly = true; tab.applySftpLayout(); }
    this.addTab(tab, opts.group);
    tab.connect();
  }

  quickConnect(str) {
    const q = typeof str === 'string' ? parseConnText(str) : str;
    if (!q) { toast('Biçim: kullanici@sunucu:port', 'err'); return; }
    this.quickInput.value = '';
    const saved = this.sessions.find((s) => s.host === q.host && Number(s.port || 22) === q.port && (!q.username || s.username === q.username));
    if (saved) { this.openSession(saved.id); return; }
    const quick = { name: q.name || q.host, host: q.host, port: q.port, username: q.username, authType: 'auto', forwards: [] };
    if (q.password) quick.password = q.password;
    const tab = new SessionTab(this, { quick, title: q.name || `${q.username ? q.username + '@' : ''}${q.host}` });
    this.addTab(tab);
    tab.connect();
  }

  // ------------------------------------------------------------ sekme grupları (yan yana bölme)
  makeGroup(i) {
    const g = { i, active: null };
    g.tabbar = h('div.tabbar', { onwheel: (e) => { g.tabbar.scrollLeft += e.deltaY; } });
    g.tabbar.addEventListener('dblclick', (e) => {
      if (e.target !== g.tabbar || e.timeStamp - (this.tabDownAt ?? -1e9) < 800) return;
      if (g.active) this.activate(g.active);
      this.newSession();
    });
    this.bindTabReorder(g);
    g.views = h('div.views');
    g.el = h('div.tgroup' + (i ? '.g1' : ''), null, g.tabbar, g.views);
    // Gruptaki terminale / dosya paneline tıklanınca o grup etkin olur
    g.el.addEventListener('focusin', () => { if (g.active && this.active !== g.active) this.activate(g.active, { focus: false }); });
    g.el.addEventListener('mousedown', () => { if (g.active && this.active !== g.active) this.activate(g.active, { focus: false }); }, true);
    return g;
  }

  /** Etkin gruptaki önceki (-1) / sonraki (1) sekme */
  stepTab(d) {
    const list = this.tabsOf(this.curGroup());
    if (list.length < 2) return;
    const i = list.indexOf(this.active);
    this.activate(list[(i + d + list.length) % list.length]);
  }

  fitAll() { for (const g of this.tabGroups ?? []) g.active?.scheduleFit(); }

  tabsOf(gi) { return this.tabs.filter((t) => t.group === gi); }
  isSplit() { return this.tabsOf(1).length > 0; }
  curGroup() { return this.active ? this.active.group : 0; }
  // "Yanda aç": bölünmemişse sağa, bölünmüşse etkin grubun karşısına
  sideGroup() { return this.isSplit() ? 1 - this.curGroup() : 1; }

  layoutGroups() {
    const split = this.isSplit();
    this.tabGroupsEl.classList.toggle('split', split);
    this.tabGroups[0].el.style.flex = split ? `${this.groupRatio} 1 0` : '';
    this.tabGroups[1].el.style.flex = split ? `${1 - this.groupRatio} 1 0` : '';
    for (const g of this.tabGroups) g.el.classList.toggle('cur', split && this.curGroup() === g.i);
    this.welcome.style.display = this.tabs.length ? 'none' : '';
    for (const g of this.tabGroups) g.active?.scheduleFit();
  }

  // Sol grup boşalırsa sağdaki sekmeler sola geçer (bölme kalkar)
  normalizeGroups() {
    const [g0, g1] = this.tabGroups;
    if (this.tabsOf(0).length || !this.tabsOf(1).length) return;
    for (const t of this.tabsOf(1)) { t.group = 0; g0.views.append(t.el); }
    g0.active = g1.active;
    g1.active = null;
  }

  // Sekmeyi gi grubuna taşır. before: o sekmenin önüne, null: grubun sonuna; verilmezse aynı grupta bir şey yapmaz
  moveTab(tab, gi, before) {
    if (!tab || before === tab) return;
    const same = tab.group === gi;
    if (same && before === undefined) return;
    const from = this.tabGroups[tab.group];
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    const at = before ? this.tabs.indexOf(before) : -1;
    if (at >= 0) this.tabs.splice(at, 0, tab); else this.tabs.push(tab);
    if (!same) {
      tab.group = gi;
      this.tabGroups[gi].views.append(tab.el);
      if (from.active === tab) {
        const rest = this.tabsOf(from.i);
        from.active = rest[rest.length - 1] || null;
        for (const t of rest) t.el.classList.toggle('on', t === from.active);
      }
      this.normalizeGroups();
    }
    this.activate(tab);
  }

  // Ctrl+Shift+PgUp/PgDn: sekmeyi kendi grubunda bir sola / sağa al
  shiftTab(tab, dir) {
    if (!tab) return;
    const list = this.tabsOf(tab.group);
    const j = list.indexOf(tab) + dir;
    if (j < 0 || j >= list.length) return;
    this.moveTab(tab, tab.group, dir < 0 ? list[j] : (list[j + 1] || null));
  }

  // Sekme çubuğunda sürükle-bırak ile sıralama: bırakılacak yer sekmenin solunda/sağında çizgiyle gösterilir
  bindTabReorder(g) {
    const clear = () => { for (const b of g.tabbar.querySelectorAll('.drop-l, .drop-r')) b.classList.remove('drop-l', 'drop-r'); };
    // İmlecin konumuna göre önüne bırakılacak sekme (null = sona)
    const slot = (e) => {
      const btns = [...g.tabbar.querySelectorAll('.tab')];
      for (const b of btns) { const r = b.getBoundingClientRect(); if (e.clientX < r.left + r.width / 2) return { btn: b, before: this.tabs.find((t) => t.id === b.dataset.id) }; }
      return { btn: btns[btns.length - 1] || null, before: null };
    };
    g.tabbar.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('x-tab')) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      this.dropHint.style.display = 'none';
      clear();
      const { btn, before } = slot(e);
      if (btn) btn.classList.add(before ? 'drop-l' : 'drop-r');
    });
    g.tabbar.addEventListener('dragleave', (e) => { if (!g.tabbar.contains(e.relatedTarget)) clear(); });
    g.tabbar.addEventListener('drop', (e) => {
      if (![...e.dataTransfer.types].includes('x-tab')) return;
      e.preventDefault(); e.stopPropagation();
      const { before } = slot(e);
      clear();
      const tab = this.tabs.find((t) => t.id === e.dataTransfer.getData('x-tab'));
      if (tab) this.moveTab(tab, g.i, before || null);
    });
    document.addEventListener('dragend', clear);
  }

  // Sekme veya kenar çubuğundaki oturum gruplara sürüklenebilir; bölünmemişken sağ yarıya bırakmak ekranı böler
  bindGroupDrop() {
    const accepts = (e) => { const ty = [...e.dataTransfer.types]; return ty.includes('x-tab') || ty.includes('x-session'); };
    const targetOf = (e) => {
      const box = this.tabGroupsEl.getBoundingClientRect();
      if (this.isSplit()) return this.tabGroups[1].el.getBoundingClientRect().left <= e.clientX ? 1 : 0;
      return e.clientX > box.left + box.width / 2 ? 1 : 0;
    };
    const showHint = (gi) => {
      const box = this.tabGroupsEl.getBoundingClientRect();
      let r = this.tabGroups[gi].el.getBoundingClientRect();
      if (!this.isSplit()) r = gi === 1 ? { left: box.left + box.width / 2, width: box.width / 2 } : { left: box.left, width: box.width / 2 };
      Object.assign(this.dropHint.style, { left: r.left - box.left + 'px', width: r.width + 'px', display: 'block' });
    };
    const hide = () => { this.dropHint.style.display = 'none'; };
    this.tabGroupsEl.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      const gi = targetOf(e);
      // Tek sekmeli bölünmemiş ekranda sekmeyi sola bırakmak bir şey değiştirmez
      if ([...e.dataTransfer.types].includes('x-tab') && !this.isSplit() && gi === 0) { hide(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = [...e.dataTransfer.types].includes('x-tab') ? 'move' : 'copy';
      showHint(gi);
    });
    this.tabGroupsEl.addEventListener('dragleave', (e) => { if (!this.tabGroupsEl.contains(e.relatedTarget)) hide(); });
    this.tabGroupsEl.addEventListener('drop', (e) => {
      hide();
      if (!accepts(e)) return;
      e.preventDefault();
      const gi = targetOf(e);
      const tabId = e.dataTransfer.getData('x-tab');
      if (tabId) { this.moveTab(this.tabs.find((t) => t.id === tabId), gi); return; }
      const sid = e.dataTransfer.getData('x-session');
      if (sid) this.openSession(sid, { group: gi });
    });
    document.addEventListener('dragend', hide);
  }

  addTab(tab, gi = this.curGroup()) {
    tab.group = gi === 1 ? 1 : 0;
    this.tabs.push(tab);
    this.tabGroups[tab.group].views.append(tab.el);
    tab.mount();
    this.normalizeGroups();
    this.activate(tab);
  }

  activate(tab, { focus = true } = {}) {
    this.active = tab;
    if (tab) {
      const g = this.tabGroups[tab.group];
      g.active = tab;
      for (const t of this.tabsOf(g.i)) t.el.classList.toggle('on', t === tab);
    }
    this.layoutGroups();
    this.renderTabs();
    this.updateStatus();
    this.syncToolbar();
    if (tab) {
      if (focus) tab.focus(); else tab.scheduleFit();
      tab.pollStats();
      const b = this.tabGroups[tab.group].tabbar.querySelector(`[data-id="${tab.id}"]`); b?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  closeTab(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    if (tab.activeTransfers() && !window.confirm('Bu sekmede devam eden aktarımlar var. Kapatılsın mı?')) return;
    const g = this.tabGroups[tab.group];
    const siblings = this.tabsOf(g.i);
    const j = siblings.indexOf(tab);
    tab.dispose();
    this.tabs.splice(i, 1);
    if (g.active === tab) {
      const rest = this.tabsOf(g.i);
      g.active = rest[Math.min(j, rest.length - 1)] || null;
      for (const t of rest) t.el.classList.toggle('on', t === g.active);
    }
    this.normalizeGroups();
    if (this.active === tab) this.activate(g.active || this.tabGroups[0].active || null);
    else { this.layoutGroups(); this.renderTabs(); }
    this.renderSidebar();
    this.updateBcCount();
    this.focusHome();
  }

  // Sekmeyi çoğalt: yeni sekme terminalin, uzak ve yerel panelin bulunduğu dizinlerde açılır
  async duplicateTab(tab) {
    if (!tab) return;
    const dirs = { remote: tab.remote.cwd || null, local: tab.local.cwd || null, term: null };
    const pane = tab.activePane;
    if (tab.state === 'connected' && pane.shellOpen) {
      try { dirs.term = await Promise.race([api.ssh.cwd(tab.connId, pane.sid), new Promise((r) => setTimeout(() => r(null), 1500))]); } catch {}
    }
    if (tab.sessionId && !this.sessions.some((x) => x.id === tab.sessionId)) return;
    const t = tab.sessionId
      ? new SessionTab(this, { sessionId: tab.sessionId, title: tab.title })
      : new SessionTab(this, { quick: { ...tab.quick }, title: tab.title });
    t.startDirs = dirs;
    if (tab.sftpOnly) { t.sftpVisible = true; t.sftpOnly = true; t.applySftpLayout(); }
    else if (t.sftpVisible !== tab.sftpVisible) { t.sftpVisible = tab.sftpVisible; t.applySftpLayout(); }
    this.addTab(t, tab.group);
    t.connect();
  }

  renderTabs() {
    for (const g of this.tabGroups) this.renderGroupTabs(g);
  }

  renderGroupTabs(g) {
    const btns = this.tabsOf(g.i).map((t) => {
      const b = this.tabButton(t);
      b.classList.toggle('on', t === g.active);
      b.title = t.statusText || t.title;
      b._dot.className = 'dot ' + ({ connected: 'ok', connecting: 'busy', error: 'err' }[t.state] || 'off');
      if (t === g.active) this.clearActivity(t);
      b._title.textContent = t.title;
      return b;
    });
    g.addBtn ??= h('button.tab-add', { title: 'Yeni oturum', onclick: () => { if (g.active) this.activate(g.active); this.newSession(); } }, icon('plus', 14));
    g.tabbar.replaceChildren(...btns, g.addBtn);
  }

  // Linux'ta orta tuş bırakılınca Chromium panodaki/seçili metni odaktaki alana yapıştırır. Sekme orta tuşa
  // basınca kapandığı için odak yandaki sekmenin terminaline geçer ve metin oraya giderdi: tuş bırakılana kadar
  // (ve hemen ardından) yapıştırma yutulur. Tuş pencere dışında bırakılırsa 3 sn sonra kendiliğinden kalkar.
  suppressMiddlePaste() {
    let deadline = Infinity;
    const onPaste = (e) => { if (Date.now() < deadline) { e.preventDefault(); e.stopImmediatePropagation(); } };
    const done = () => { document.removeEventListener('mouseup', onUp, true); window.removeEventListener('paste', onPaste, true); };
    const onUp = (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      deadline = Date.now() + 400;
      document.removeEventListener('mouseup', onUp, true);
      setTimeout(done, 450);
    };
    window.addEventListener('paste', onPaste, true);
    document.addEventListener('mouseup', onUp, true);
    setTimeout(done, 3000);
  }

  // Sekme düğmesi bir kez oluşturulur ve sonra yerinde güncellenir; yeniden yaratılsaydı
  // tıklama sırasında DOM değiştiği için çift tık ve sürükleme kopardı.
  tabButton(t) {
    if (t._tabBtn) return t._tabBtn;
    const dot = h('span.dot');
    const title = h('span.tab-title');
    const b = h('div.tab', { dataset: { id: t.id }, draggable: 'true' }, dot, title,
      h('button.tab-x', { title: 'Kapat (Ctrl+Shift+W)', onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }, icon('x', 12)));
    b._dot = dot;
    b._title = title;
    b.onmousedown = (e) => {
      if (e.target.closest('.tab-x')) return;
      if (e.button === 1) { e.preventDefault(); this.suppressMiddlePaste(); this.closeTab(t); return; }
      if (e.button !== 0) return;
      this.tabDownAt = e.timeStamp;
      if (e.detail === 2) this.duplicateTab(t);
      else if (t !== this.active) this.activate(t);
      else t.focus();
    };
    b.ondragstart = (e) => { e.dataTransfer.setData('x-tab', t.id); e.dataTransfer.effectAllowed = 'move'; };
    b.oncontextmenu = (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Sekmeyi çoğalt', icon: 'plus', hint: 'Çift tık / Ctrl+Shift+T', action: () => this.duplicateTab(t) },
        this.isSplit()
          ? { label: t.group === 0 ? 'Sağ tarafa taşı' : 'Sol tarafa taşı', icon: 'splitH', hint: 'Ctrl+Shift+M', action: () => this.moveTab(t, 1 - t.group) }
          : { label: 'Yana ayır (ekranı böl)', icon: 'splitH', hint: 'Ctrl+Shift+M', disabled: this.tabs.length < 2, action: () => this.moveTab(t, 1) },
        { label: 'Sola al', icon: 'arrowLeft', hint: 'Ctrl+Shift+PgUp', disabled: this.tabsOf(t.group)[0] === t, action: () => this.shiftTab(t, -1) },
        { label: 'Sağa al', icon: 'arrowRight', hint: 'Ctrl+Shift+PgDn', disabled: this.tabsOf(t.group).at(-1) === t, action: () => this.shiftTab(t, 1) },
        t.state === 'connected' ? { label: 'Bağlantıyı kes', icon: 'stop', action: () => t.disconnect() } : { label: 'Yeniden bağlan', icon: 'play', action: () => t.connect() },
        t.sessionId ? { label: 'Oturumu düzenle…', icon: 'edit', action: () => { const s = this.sessions.find((x) => x.id === t.sessionId); if (s) this.editSession(s); } } : null,
        !t.sessionId ? { label: 'Oturum olarak kaydet…', icon: 'server', action: () => this.newSession({ ...t.quick, authType: 'auto' }) } : null,
        '-',
        { label: 'Kapat', icon: 'x', action: () => this.closeTab(t) },
        { label: 'Bu taraftaki diğerlerini kapat', icon: 'x', disabled: this.tabsOf(t.group).length < 2, action: () => { for (const o of this.tabsOf(t.group)) if (o !== t) this.closeTab(o); } },
        { label: 'Soldakileri kapat', icon: 'x', disabled: this.tabsOf(t.group)[0] === t, action: () => { const l = this.tabsOf(t.group); for (const o of l.slice(0, l.indexOf(t))) this.closeTab(o); } },
        { label: 'Sağdakileri kapat', icon: 'x', disabled: this.tabsOf(t.group).at(-1) === t, action: () => { const l = this.tabsOf(t.group); for (const o of l.slice(l.indexOf(t) + 1)) this.closeTab(o); } },
      ]);
    };
    t._tabBtn = b;
    return b;
  }

  // Görünmeyen sekmeye çıktı düşünce: akış sürerken nokta yanıp söner ('activity'),
  // durunca sekme 'unread' kalır; sekme görünür olunca ikisi de temizlenir.
  applyTabActivity() {
    document.documentElement.dataset.tabActivity = this.settings.tabActivity || 'rainbow';
  }

  markActivity(t) {
    if (this.settings.tabActivity === 'off' || this.tabGroups.some((g) => g.active === t)) return;
    const b = this.tabButton(t);
    b.classList.add('activity', 'unread');
    clearTimeout(t._activityTimer);
    t._activityTimer = setTimeout(() => b.classList.remove('activity'), 1200);
  }

  clearActivity(t) {
    clearTimeout(t._activityTimer);
    t._tabBtn?.classList.remove('activity', 'unread');
  }

  onTabState(tab) {
    this.renderTabs();
    this.renderSidebar();
    this.updateBcCount();
    if (tab === this.active) { this.updateStatus(); this.syncToolbar(); }
  }

  updateStatus() {
    const t = this.active;
    if (!t) {
      this.sbLeft.replaceChildren(h('span.dot.off'), `${this.sessions.length} kayıtlı oturum`);
      this.sbMid.textContent = '';
    } else {
      this.sbLeft.replaceChildren(h('span.dot.' + ({ connected: 'ok', connecting: 'busy', error: 'err' }[t.state] || 'off')), t.statusText || t.title);
      const parts = [`${t.term.cols}×${t.term.rows}`];
      const fw = t.activeForwards(); if (fw) parts.push(`${fw} tünel`);
      const tr = t.activeTransfers(); if (tr) parts.push(`${tr} aktarım`);
      const s = t.session; if (s && s.jumpHostId) { const j = this.sessions.find((x) => x.id === s.jumpHostId); if (j) parts.push(`jump: ${j.name}`); }
      this.sbMid.textContent = parts.join('  ·  ');
    }
    const secBadge = this.secrets === 'master'
      ? h('span', { title: 'Parolalar ana parolayla şifreli' }, icon('lock', 12), ' Ana parola')
      : this.secrets === 'plain'
        ? h('span.warn', { title: 'KWallet / GNOME Keyring bulunamadı. Parolalar şifrelenmeden saklanıyor.' }, 'Anahtarlık yok')
        : h('span', { title: 'Parolalar sistem anahtarlığında şifreli' }, icon('key', 12), ' Anahtarlık');
    const upd = this.update && this.update.newer && !this.update.skipped
      ? h('button.sb-upd', { title: 'Yeni sürümü gör ve kur', onclick: () => updateDialog(this) }, icon('upgrade', 12), ` v${this.update.version} hazır`)
      : null;
    const a = this.account;
    const acc = a && a.loggedIn
      ? h('button.sb-acc' + (['error', 'auth', 'locked'].includes(a.state) ? '.warn' : ''), {
        title: `Hesap: ${a.user} @ ${a.server}\nSon eşitleme: ${syncTimeText(a.lastSync)}${a.error ? `\n${a.error}` : ''}`,
        onclick: () => accountDialog(this),
      }, icon('cloud', 12), ' ', a.state === 'ok' ? `Eşitlendi ${syncTimeText(a.lastSync)}` : STATE_TEXT[a.state] || a.state)
      : null;
    this.sbRight.replaceChildren(...[upd, acc, this.settings.logEnabled ? h('span.sb-rec', { title: 'Oturum kaydı açık' }, icon('record', 12), ' Kayıt') : null, secBadge, `  v${this.version}`].filter(Boolean));
    this.updateStats();
  }

  // Durum çubuğu: etkin sekmedeki sunucunun kaynak kullanımı (tab.pollStats doldurur)
  updateStats() {
    const st = this.active && this.active.state === 'connected' && this.settings.showStats ? this.active.stats : null;
    if (!st) { this.sbStats.replaceChildren(); return; }
    const gb = (n) => (n / 1073741824).toFixed(n >= 10737418240 ? 0 : 1);
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
    // Renk: yeşil < %70, sarı %70-89, kırmızı ≥ %90 (yük için çekirdek başına 0.7 / 1.0)
    const lvl = (p) => (p >= 90 ? '.crit' : p >= 70 ? '.warn' : '.ok');
    const up = st.uptime; const d = Math.floor(up / 86400); const hh = Math.floor((up % 86400) / 3600); const mm = Math.floor((up % 3600) / 60);
    const upText = d ? `${d}g ${hh}sa` : hh ? `${hh}sa ${mm}dk` : `${mm}dk`;
    const cpu = st.cpu == null ? null : Math.round(st.cpu);
    const mem = pct(st.memUsed, st.memTotal); const disk = pct(st.diskUsed, st.diskTotal);
    const load1 = parseFloat(st.load) || 0;
    const loadPct = st.cores ? Math.round((100 * load1) / st.cores) : null;
    const meter = (p) => h('span.meter', null, h('i', { style: { width: Math.min(100, Math.max(0, p)) + '%' } }));
    const item = (cls, label, val, p) => h('span.st' + cls, null, h('b', null, label), p == null ? null : meter(p), h('em', null, val));
    const levels = [cpu, mem, disk, loadPct].filter((x) => x != null);
    const worst = levels.length ? Math.max(...levels) : 0;
    this.sbStats.title = [
      `Yük ortalaması: ${st.load}${st.cores ? ` (${st.cores} çekirdek)` : ''}`,
      `Bellek: ${formatSize(st.memUsed)} / ${formatSize(st.memTotal)}`,
      st.swapTotal ? `Takas: ${formatSize(st.swapUsed)} / ${formatSize(st.swapTotal)}` : 'Takas: yok',
      `Disk (/): ${formatSize(st.diskUsed)} / ${formatSize(st.diskTotal)}`,
      `Çalışma süresi: ${upText}`,
      st.sessions ? `Açık oturumlar (${st.sessions.length}):\n${st.sessions.map((x) => `  ${x.user}  ${x.tty}${x.from ? `  ${x.from}` : ''}`).join('\n')}` : null,
    ].filter(Boolean).join('\n');
    this.sbStats.replaceChildren(...[
      h('span.health' + lvl(worst), { title: 'Genel durum: en yüksek kullanım' }),
      cpu == null ? null : item(lvl(cpu), 'CPU', `${cpu}%`, cpu),
      loadPct == null ? null : item(lvl(loadPct >= 100 ? 90 : loadPct >= 70 ? 70 : 0), 'Yük', load1.toFixed(2)),
      item(lvl(mem), 'RAM', `${gb(st.memUsed)}/${gb(st.memTotal)} GB`, mem),
      st.diskTotal ? item(lvl(disk), 'Disk', `${disk}%`, disk) : null,
      st.rxRate == null ? null : h('span.st.net', null, h('span.rx', null, `↓${formatSize(Math.round(st.rxRate))}/s`), ' ', h('span.tx', null, `↑${formatSize(Math.round(st.txRate))}/s`)),
      st.sessions ? item('.info', 'Oturum', String(st.sessions.length)) : null,
      h('span.st.up', null, `⏱ ${upText}`)].filter(Boolean));
  }

  tabByConn(connId) { return this.tabs.find((t) => t.connId === connId); }

  // ------------------------------------------------------------ IPC + keys
  bindIpc() {
    api.onUiRequest(async ({ id, kind, payload }) => {
      let v = null;
      try {
        if (kind === 'hostkey') v = await hostKeyDialog(payload);
        else if (kind === 'password' || kind === 'text') {
          v = await promptText({ title: payload.title, label: payload.label, password: kind === 'password', username: payload.username, save: payload.canSave ? !!this.settings.savePrompted : undefined });
          // "Kaydet" kutusunun son durumu hatırlanır
          if (v && typeof v === 'object' && 'save' in v && v.save !== !!this.settings.savePrompted) this.saveSettings({ savePrompted: v.save });
        }
        else if (kind === 'kbd') v = await kbdDialog(payload);
      } finally { api.uiRespond(id, v); }
    });
    api.ssh.onStatus((connId, state, msg) => this.tabByConn(connId)?.onStatus(state, msg));
    api.ssh.onData((connId, data, sid) => {
      const t = this.tabByConn(connId);
      if (!t) return;
      t.onShellData(data, sid);
      this.markActivity(t);
    });
    api.ssh.onExit((connId, sid) => this.tabByConn(connId)?.onShellExit(sid));
    api.onResume(() => { for (const t of this.tabs) t.onResume(); });
    api.update.onAvailable((st) => { this.setUpdate(st); toast(`SSHDeck v${st.version} çıktı — durum çubuğundan güncelleyebilirsiniz`, 'info', 8000); });
    api.update.onShow(() => updateDialog(this));
    api.onSessionsUpdated((sessions, err) => {
      this.sessions = sessions;
      this.renderSidebar();
      if (err) toast(err, 'err', 6000); else toast('Giriş bilgileri oturuma kaydedildi', 'ok');
    });
    api.account.onStatus((st) => this.setAccount(st));
    api.account.onChanged(({ sessions, settings }) => {
      this.sessions = sessions;
      this.renderSidebar();
      this.applyNewSettings(settings);
    });
    api.onToast((msg, kind) => { toast(msg, kind, 6000); this.settings.logEnabled = false; this.updateStatus(); });
    api.ssh.onForward((connId, fid, state, msg) => this.tabByConn(connId)?.onForward(fid, state, msg));
    api.ssh.onBanner((connId, msg) => { const t = this.tabByConn(connId); if (t) t.panes[0].term.write('\r\n' + msg.replace(/\r?\n/g, '\r\n')); });
    api.sftp.onTransfer((connId, info) => this.tabByConn(connId)?.onTransfer(info));
    api.sftp.onEdit((connId, ev) => this.tabByConn(connId)?.onEditEvent(ev));
  }

  isAppShortcut(e) {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && ['n', 't', 'w', 'e', 'b', 'r', 'l', 'd', 's', 'k', 'm'].includes(k)) return true;
    if (e.altKey && e.shiftKey && !e.ctrlKey && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) return true;
    if (e.ctrlKey && (k === 'tab' || k === 'pageup' || k === 'pagedown')) return true;
    if (e.ctrlKey && !e.shiftKey && (k === '=' || k === '+' || k === '-' || k === '0')) return true;
    if (e.altKey && !e.ctrlKey && /^[1-9]$/.test(k)) return true;
    if (e.altKey && !e.ctrlKey && !e.shiftKey && k === 'enter') return true; // odak modu
    return false;
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (document.querySelector('.overlay')) return;
      // Ana ekranda odak bir alanda değilken basılan harf aramaya gider
      if (!this.tabs.length && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey
        && !document.activeElement?.matches('input, textarea, select, [contenteditable]')) { this.filter.focus(); return; }
      if (!this.isAppShortcut(e)) return;
      const k = e.key.toLowerCase();
      e.preventDefault();
      // Sekmeler arası geçiş etkin grubun içinde
      const list = this.tabsOf(this.curGroup());
      const i = list.indexOf(this.active);
      if (e.ctrlKey && e.shiftKey) {
        if (k === 'n') this.newSession();
        else if (k === 't') this.duplicateTab(this.active);
        else if (k === 'w') { if (this.active && !this.active.closePane()) this.closeTab(this.active); }
        else if (k === 'd') { if (this.active && !this.active.sftpOnly) this.active.splitPane('h'); }
        else if (k === 's') { if (this.active && !this.active.sftpOnly) this.active.splitPane('v'); }
        else if (k === 'k') this.snippetPalette();
        else if (k === 'e') { this.active?.toggleSftp(); this.syncToolbar(); }
        else if (k === 'b') this.toggleSidebar();
        else if (k === 'r') this.active?.connect();
        else if (k === 'l') this.quickInput.focus();
        else if (k === 'm') this.moveActiveSide();
        else if (k === 'tab' && list.length) this.activate(list[(i - 1 + list.length) % list.length]);
        else if (k === 'pageup' || k === 'pagedown') this.shiftTab(this.active, k === 'pageup' ? -1 : 1);
        return;
      }
      if (e.altKey && e.shiftKey && k.startsWith('arrow')) {
        // Sekme içinde komşu bölme yoksa yandaki gruba geç
        if (this.active && !this.active.focusNeighbor(e.key) && this.isSplit()) {
          const gi = this.curGroup();
          const to = { arrowleft: 0, arrowright: 1 }[k];
          if (to !== undefined && to !== gi && this.tabGroups[to].active) this.activate(this.tabGroups[to].active);
        }
        return;
      }
      if (e.ctrlKey && (k === 'tab' || k === 'pagedown') && list.length) this.activate(list[(i + 1) % list.length]);
      else if (e.ctrlKey && k === 'pageup' && list.length) this.activate(list[(i - 1 + list.length) % list.length]);
      else if (e.ctrlKey && ['=', '+', '-', '0'].includes(k)) {
        const size = k === '0' ? 14 : Math.min(32, Math.max(8, this.settings.fontSize + (k === '-' ? -1 : 1)));
        this.saveSettings({ fontSize: size });
        for (const t of this.tabs) t.applySettings();
      } else if (e.altKey && /^[1-9]$/.test(k)) { const t = list[Number(k) - 1]; if (t) this.activate(t); }
      else if (e.altKey && k === 'enter') this.toggleFocus();
    });
    window.addEventListener('resize', () => this.fitAll());
  }

  // Ctrl+Shift+M: etkin sekmeyi karşı tarafa taşı (tek tarafta tek sekme varsa bir şey yapmaz)
  moveActiveSide() {
    const t = this.active;
    if (!t) return;
    if (!this.isSplit() && this.tabs.length < 2) { toast('Yana ayırmak için en az iki sekme gerekli', 'info'); return; }
    this.moveTab(t, 1 - t.group);
  }
}

const app = new App();
window.__app = app;
app.init().catch((e) => { document.body.textContent = 'Başlatma hatası: ' + e.message; });
