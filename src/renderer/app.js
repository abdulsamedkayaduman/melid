import { h, icon, parseQuick, debounce } from './util.js';
import { modal, promptText, confirmBox, hostKeyDialog, kbdDialog, contextMenu, toast, sessionEditor, settingsDialog } from './dialogs.js';
import { SessionTab } from './tab.js';
import { cleanErr } from './filepane.js';

const api = window.api;

class App {
  constructor() {
    this.api = api;
    this.tabs = [];
    this.active = null;
    try { this.collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]')); } catch { this.collapsed = new Set(); }
  }

  async init() {
    const d = await api.init();
    this.sessions = d.sessions;
    this.settings = d.settings;
    this.home = d.home;
    this.secrets = d.secrets;
    this.version = d.version;
    this.build();
    this.renderSidebar();
    this.renderTabs();
    this.updateStatus();
    this.bindIpc();
    this.bindKeys();
  }

  // ------------------------------------------------------------ layout
  build() {
    const tbtn = (ic, title, fn, cls = '') => h('button.tool' + cls, { title, onclick: fn }, icon(ic, 17));
    this.quickInput = h('input.quick-input', {
      placeholder: 'Hızlı bağlan:  kullanici@sunucu:port',
      spellcheck: false,
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.quickConnect(this.quickInput.value); } if (e.key === 'Escape') { this.quickInput.value = ''; this.active?.focus(); } },
    });
    this.btnSidebar = tbtn('sidebar', 'Oturum listesi (Ctrl+Shift+B)', () => this.toggleSidebar(), '.on');
    this.btnSftp = tbtn('files', 'SFTP dosya paneli (Ctrl+Shift+E)', () => this.active?.toggleSftp() || this.syncToolbar());
    this.btnTunnels = tbtn('tunnel', 'Tüneller', () => this.active?.tunnelsDialog());
    this.btnBroadcast = tbtn('broadcast', 'Tüm sekmelere gönder', () => this.toggleBroadcast());
    const toolbar = h('header.toolbar', null,
      h('div.brand', null, icon('terminal', 18), h('span', null, 'SSH', h('b', null, 'Deck'))),
      h('button.btn.primary.sm', { onclick: () => this.newSession(), title: 'Yeni oturum (Ctrl+Shift+N)' }, icon('plus', 14), 'Yeni oturum'),
      h('div.quick', null, icon('bolt', 14), this.quickInput),
      h('div.spacer'),
      this.btnSidebar, this.btnSftp, this.btnTunnels, this.btnBroadcast,
      h('span.tool-sep'),
      tbtn('import', '~/.ssh/config içe aktar', () => this.importSshConfig()),
      tbtn('gear', 'Ayarlar', () => this.openSettings()));

    this.filter = h('input.input.sm.filter', { placeholder: 'Oturum ara…', spellcheck: false, oninput: debounce(() => this.renderSidebar(), 80), onkeydown: (e) => { if (e.key === 'Escape') { this.filter.value = ''; this.renderSidebar(); } if (e.key === 'Enter') { const first = this.tree.querySelector('.s-item'); if (first) this.openSession(first.dataset.id); } } });
    this.tree = h('div.tree', { tabindex: 0 });
    this.tree.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.s-item, .g-item')) return;
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [{ label: 'Yeni oturum', icon: 'plus', action: () => this.newSession() }, { label: '~/.ssh/config içe aktar', icon: 'import', action: () => this.importSshConfig() }]);
    });
    this.dropTarget(this.tree, '');
    this.sidebar = h('aside.sidebar', null,
      h('div.side-head', null, h('span', null, 'Oturumlar'), h('button.icon-btn', { title: 'Yeni oturum', onclick: () => this.newSession() }, icon('plus', 15))),
      h('div.side-filter', null, this.filter), this.tree);
    const sideResize = h('div.side-resize');
    sideResize.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const move = (ev) => { this.sidebar.style.width = Math.min(480, Math.max(180, ev.clientX)) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing-h'); this.active?.scheduleFit(); };
      document.body.classList.add('resizing-h');
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });

    this.tabbar = h('div.tabbar', { onwheel: (e) => { this.tabbar.scrollLeft += e.deltaY; } });
    this.tabbar.addEventListener('dblclick', (e) => { if (e.target === this.tabbar) this.newSession(); });
    this.views = h('div.views');
    this.welcome = this.buildWelcome();
    this.views.append(this.welcome);

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
    this.sbRight = h('span.sb-right');
    this.statusbar = h('footer.statusbar', null, this.sbLeft, this.sbMid, this.sbRight);

    this.main = h('main.main', null, this.tabbar, this.views, this.bcBar, this.statusbar);
    document.getElementById('app').append(toolbar, h('div.body', null, this.sidebar, sideResize, this.main));
    this.syncToolbar();
  }

  buildWelcome() {
    const card = (ic, title, desc, fn) => h('button.w-card', { onclick: fn }, icon(ic, 22), h('b', null, title), h('span', null, desc));
    return h('div.welcome', null,
      h('div.w-inner', null,
        h('div.w-logo', null, icon('terminal', 40)),
        h('h1', null, 'SSH', h('b', null, 'Deck')),
        h('p.muted', null, 'SSH terminali ve SFTP dosya yöneticisi bir arada.'),
        h('div.w-cards', null,
          card('plus', 'Yeni oturum', 'Sunucu bilgilerini kaydedin', () => this.newSession()),
          card('bolt', 'Hızlı bağlan', 'kullanici@sunucu yazıp Enter', () => this.quickInput.focus()),
          card('import', 'SSH config', '~/.ssh/config içindeki hostları ekleyin', () => this.importSshConfig())),
        h('div.w-keys', null,
          ...[['Ctrl+Shift+N', 'Yeni oturum'], ['Ctrl+Shift+T', 'Sekmeyi çoğalt'], ['Ctrl+Shift+W', 'Sekmeyi kapat'], ['Ctrl+Tab', 'Sonraki sekme'],
            ['Ctrl+Shift+E', 'SFTP paneli'], ['Ctrl+Shift+F', 'Terminalde ara'], ['Ctrl+Shift+C / V', 'Kopyala / yapıştır'], ['Ctrl + / −', 'Yazı boyutu']]
            .map(([k, v]) => h('div.w-key', null, h('kbd', null, k), h('span', null, v))))));
  }

  toggleSidebar(v) {
    const show = v === undefined ? this.sidebar.style.display === 'none' : v;
    this.sidebar.style.display = show ? '' : 'none';
    this.sidebar.nextElementSibling.style.display = show ? '' : 'none';
    this.btnSidebar.classList.toggle('on', show);
    this.active?.scheduleFit();
  }

  toggleBroadcast(v) {
    const show = v === undefined ? !this.bcBar.classList.contains('on') : v;
    this.bcBar.classList.toggle('on', show);
    this.btnBroadcast.classList.toggle('on', show);
    this.updateBcCount();
    if (show) this.bcInput.focus(); else this.active?.focus();
    this.active?.scheduleFit();
  }

  updateBcCount() {
    const n = this.tabs.filter((t) => t.state === 'connected').length;
    this.bcCount.textContent = `${n} sekme`;
  }

  broadcast(text) {
    const targets = this.tabs.filter((t) => t.state === 'connected');
    for (const t of targets) api.ssh.write(t.connId, text);
    if (!targets.length) toast('Bağlı sekme yok', 'err');
  }

  syncToolbar() {
    const t = this.active;
    this.btnSftp.classList.toggle('on', !!(t && t.sftpVisible));
    this.btnSftp.disabled = !t;
    this.btnTunnels.disabled = !(t && t.state === 'connected');
  }

  // ------------------------------------------------------------ sidebar
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
        const row = h('div.g-item' + (collapsed ? '.collapsed' : ''), { style: { paddingLeft: 8 + depth * 14 + 'px' }, dataset: { path: g.path } },
          h('span.chev', null, icon('chevron', 12)), icon('folder', 14), h('span.g-name', null, g.name), h('span.g-count', null, count(g)));
        row.onclick = () => { if (this.collapsed.has(g.path)) this.collapsed.delete(g.path); else this.collapsed.add(g.path); localStorage.setItem('collapsed', JSON.stringify([...this.collapsed])); this.renderSidebar(); };
        row.oncontextmenu = (e) => { e.preventDefault(); this.groupMenu(e.clientX, e.clientY, g.path); };
        this.dropTarget(row, g.path);
        out.push(row);
        if (!collapsed) out.push(...renderNode(g, depth + 1));
      }
      for (const s of node.items.sort((a, b) => coll.compare(a.name, b.name))) {
        const row = h('div.s-item' + (openIds.has(s.id) ? '.live' : ''), { style: { paddingLeft: 8 + depth * 14 + 'px' }, dataset: { id: s.id }, draggable: 'true', title: `${s.username || '?'}@${s.host}:${s.port || 22}${s.notes ? '\n\n' + s.notes : ''}` },
          h('span.s-dot'), icon('server', 14),
          h('span.s-text', null, h('span.s-name', null, s.name), h('span.s-host', null, `${s.username ? s.username + '@' : ''}${s.host}${Number(s.port) !== 22 ? ':' + s.port : ''}`)),
          s.jumpHostId ? h('span.s-badge', { title: 'Jump host üzerinden' }, '⇢') : null,
          (s.forwards || []).length ? h('span.s-badge', { title: `${s.forwards.length} tünel` }, icon('tunnel', 11)) : null);
        row.ondblclick = () => this.openSession(s.id);
        row.oncontextmenu = (e) => { e.preventDefault(); this.sessionMenu(e.clientX, e.clientY, s); };
        row.ondragstart = (e) => { e.dataTransfer.setData('x-session', s.id); e.dataTransfer.effectAllowed = 'move'; };
        out.push(row);
      }
      return out;
    };
    const rows = renderNode(root, 0);
    this.tree.replaceChildren(...(rows.length ? rows : [h('div.tree-empty', null, q ? 'Eşleşen oturum yok' : h('span', null, 'Henüz oturum yok.', h('br'), h('a', { href: '#', onclick: (e) => { e.preventDefault(); this.newSession(); } }, 'Yeni oturum ekleyin')))]));
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
      { label: 'Yalnızca SFTP ile aç', icon: 'files', action: () => this.openSession(s.id, { sftpOnly: true }) },
      '-',
      { label: 'Düzenle…', icon: 'edit', action: () => this.editSession(s) },
      { label: 'Kopyasını oluştur', icon: 'plus', action: () => this.duplicateSession(s) },
      { label: 'ssh komutunu kopyala', icon: 'terminal', action: () => api.clipboard.write(`ssh ${Number(s.port) !== 22 ? `-p ${s.port} ` : ''}${s.username ? s.username + '@' : ''}${s.host}`) },
      '-',
      { label: 'Sil', icon: 'trash', danger: true, action: () => this.deleteSession(s) },
    ]);
  }

  groupMenu(x, y, path) {
    contextMenu(x, y, [
      { label: 'Bu gruba yeni oturum', icon: 'plus', action: () => this.newSession({ group: path }) },
      { label: 'Gruptaki tüm oturumlara bağlan', icon: 'play', action: () => { for (const s of this.sessions.filter((s) => s.group === path || (s.group || '').startsWith(path + '/'))) this.openSession(s.id); } },
      { label: 'Grubu yeniden adlandır…', icon: 'edit', action: async () => {
        const n = await promptText({ title: 'Grubu yeniden adlandır', label: 'Yeni ad (alt grup için / kullanın)', value: path });
        if (n && n.trim() && n.trim() !== path) { this.sessions = await api.sessions.renameGroup(path, n.trim().replace(/^\/+|\/+$/g, '')); this.renderSidebar(); }
      } },
    ]);
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

  async openSettings() {
    const r = await settingsDialog(this.settings);
    if (!r) return;
    await this.saveSettings(r);
    for (const t of this.tabs) t.applySettings();
  }

  async saveSettings(patch) {
    Object.assign(this.settings, patch);
    this.settings = await api.saveSettings(patch);
  }

  // ------------------------------------------------------------ tabs
  openSession(id, opts = {}) {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    const tab = new SessionTab(this, { sessionId: id, title: s.name });
    if (opts.sftpOnly) { tab.sftpVisible = true; tab.sftpOnly = true; }
    this.addTab(tab);
    if (opts.sftpOnly) tab.el.classList.add('sftp-only');
    tab.connect();
  }

  quickConnect(str) {
    const q = parseQuick(str);
    if (!q) { toast('Biçim: kullanici@sunucu:port', 'err'); return; }
    this.quickInput.value = '';
    const saved = this.sessions.find((s) => s.host === q.host && Number(s.port || 22) === q.port && (!q.username || s.username === q.username));
    if (saved) { this.openSession(saved.id); return; }
    const tab = new SessionTab(this, { quick: { name: q.host, host: q.host, port: q.port, username: q.username, authType: 'auto', forwards: [] }, title: `${q.username ? q.username + '@' : ''}${q.host}` });
    this.addTab(tab);
    tab.connect();
  }

  addTab(tab) {
    this.tabs.push(tab);
    this.views.append(tab.el);
    tab.mount();
    this.activate(tab);
  }

  activate(tab) {
    this.active = tab;
    for (const t of this.tabs) t.el.classList.toggle('on', t === tab);
    this.welcome.style.display = tab ? 'none' : '';
    this.renderTabs();
    this.updateStatus();
    this.syncToolbar();
    if (tab) { tab.focus(); const b = this.tabbar.querySelector(`[data-id="${tab.id}"]`); b?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }

  closeTab(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    if (tab.activeTransfers() && !window.confirm('Bu sekmede devam eden aktarımlar var. Kapatılsın mı?')) return;
    tab.dispose();
    this.tabs.splice(i, 1);
    if (this.active === tab) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)] || null);
    else this.renderTabs();
    this.renderSidebar();
    this.updateBcCount();
  }

  duplicateTab(tab) {
    if (!tab) return;
    if (tab.sessionId) this.openSession(tab.sessionId);
    else { const t = new SessionTab(this, { quick: { ...tab.quick }, title: tab.title }); this.addTab(t); t.connect(); }
  }

  renderTabs() {
    const btns = this.tabs.map((t) => {
      const b = h('div.tab' + (t === this.active ? '.on' : ''), { dataset: { id: t.id }, title: t.statusText || t.title },
        h('span.dot.' + ({ connected: 'ok', connecting: 'busy', error: 'err' }[t.state] || 'off')),
        h('span.tab-title', null, t.title),
        h('button.tab-x', { title: 'Kapat (Ctrl+Shift+W)', onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }, icon('x', 12)));
      b.onmousedown = (e) => { if (e.button === 1) { e.preventDefault(); this.closeTab(t); } else if (e.button === 0) this.activate(t); };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'Sekmeyi çoğalt', icon: 'plus', hint: 'Ctrl+Shift+T', action: () => this.duplicateTab(t) },
          t.state === 'connected' ? { label: 'Bağlantıyı kes', icon: 'stop', action: () => t.disconnect() } : { label: 'Yeniden bağlan', icon: 'play', action: () => t.connect() },
          t.sessionId ? { label: 'Oturumu düzenle…', icon: 'edit', action: () => { const s = this.sessions.find((x) => x.id === t.sessionId); if (s) this.editSession(s); } } : null,
          !t.sessionId ? { label: 'Oturum olarak kaydet…', icon: 'server', action: () => this.newSession({ ...t.quick, authType: 'auto' }) } : null,
          '-',
          { label: 'Kapat', icon: 'x', action: () => this.closeTab(t) },
          { label: 'Diğerlerini kapat', icon: 'x', disabled: this.tabs.length < 2, action: () => { for (const o of [...this.tabs]) if (o !== t) this.closeTab(o); } },
        ]);
      };
      return b;
    });
    this.tabbar.replaceChildren(...btns, h('button.tab-add', { title: 'Yeni oturum', onclick: () => this.newSession() }, icon('plus', 14)));
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
    this.sbRight.replaceChildren(this.secrets === 'plain' ? h('span.warn', { title: 'KWallet / GNOME Keyring bulunamadı. Parolalar şifrelenmeden saklanıyor.' }, 'Anahtarlık yok') : h('span', { title: 'Parolalar sistem anahtarlığında şifreli' }, icon('key', 12), ' Anahtarlık'), `  v${this.version}`);
  }

  tabByConn(connId) { return this.tabs.find((t) => t.connId === connId); }

  // ------------------------------------------------------------ IPC + keys
  bindIpc() {
    api.onUiRequest(async ({ id, kind, payload }) => {
      let v = null;
      try {
        if (kind === 'hostkey') v = await hostKeyDialog(payload);
        else if (kind === 'password') v = await promptText({ title: payload.title, label: payload.label, password: true });
        else if (kind === 'text') v = await promptText({ title: payload.title, label: payload.label });
        else if (kind === 'kbd') v = await kbdDialog(payload);
      } finally { api.uiRespond(id, v); }
    });
    api.ssh.onStatus((connId, state, msg) => this.tabByConn(connId)?.onStatus(state, msg));
    api.ssh.onData((connId, data) => this.tabByConn(connId)?.term.write(data));
    api.ssh.onExit((connId) => this.tabByConn(connId)?.onShellExit());
    api.ssh.onForward((connId, fid, state, msg) => this.tabByConn(connId)?.onForward(fid, state, msg));
    api.ssh.onBanner((connId, msg) => { const t = this.tabByConn(connId); if (t) t.term.write('\r\n' + msg.replace(/\r?\n/g, '\r\n')); });
    api.sftp.onTransfer((connId, info) => this.tabByConn(connId)?.onTransfer(info));
    api.sftp.onEdit((connId, ev) => this.tabByConn(connId)?.onEditEvent(ev));
  }

  isAppShortcut(e) {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && ['n', 't', 'w', 'e', 'b', 'r', 'l'].includes(k)) return true;
    if (e.ctrlKey && (k === 'tab' || k === 'pageup' || k === 'pagedown')) return true;
    if (e.ctrlKey && !e.shiftKey && (k === '=' || k === '+' || k === '-' || k === '0')) return true;
    if (e.altKey && !e.ctrlKey && /^[1-9]$/.test(k)) return true;
    return false;
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (document.querySelector('.overlay')) return;
      if (!this.isAppShortcut(e)) return;
      const k = e.key.toLowerCase();
      e.preventDefault();
      const i = this.tabs.indexOf(this.active);
      if (e.ctrlKey && e.shiftKey) {
        if (k === 'n') this.newSession();
        else if (k === 't') this.duplicateTab(this.active);
        else if (k === 'w') this.active && this.closeTab(this.active);
        else if (k === 'e') { this.active?.toggleSftp(); this.syncToolbar(); }
        else if (k === 'b') this.toggleSidebar();
        else if (k === 'r') this.active?.connect();
        else if (k === 'l') this.quickInput.focus();
        else if (k === 'tab' && this.tabs.length) this.activate(this.tabs[(i - 1 + this.tabs.length) % this.tabs.length]);
        return;
      }
      if (e.ctrlKey && (k === 'tab' || k === 'pagedown') && this.tabs.length) this.activate(this.tabs[(i + 1) % this.tabs.length]);
      else if (e.ctrlKey && k === 'pageup' && this.tabs.length) this.activate(this.tabs[(i - 1 + this.tabs.length) % this.tabs.length]);
      else if (e.ctrlKey && ['=', '+', '-', '0'].includes(k)) {
        const size = k === '0' ? 14 : Math.min(32, Math.max(8, this.settings.fontSize + (k === '-' ? -1 : 1)));
        this.saveSettings({ fontSize: size });
        for (const t of this.tabs) t.applySettings();
      } else if (e.altKey && /^[1-9]$/.test(k)) { const t = this.tabs[Number(k) - 1]; if (t) this.activate(t); }
    });
    window.addEventListener('resize', () => this.active?.scheduleFit());
  }
}

const app = new App();
window.__app = app;
app.init().catch((e) => { document.body.textContent = 'Başlatma hatası: ' + e.message; });
