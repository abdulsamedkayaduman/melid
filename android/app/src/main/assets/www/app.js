// SSHDeck Android arayüzü: oturum listesi, sekmeler, gezinme ve native olay yönlendirme.
import { h, icon, parseQuick, parseConnText } from './util.js';
import * as N from './native.js';
import { sheet, actionSheet, promptText, confirm, toast, handleAsk, closeTop, modalOpen, UI_THEMES } from './dialogs.js';
import { SessionTab } from './tab.js';
import { sessionEditor, settingsView, editorView, importBackup, snippetsView } from './screens.js';
import { updateSheet } from './update.js';

class App {
  constructor() {
    this.sessions = [];
    this.settings = {};
    this.keys = [];
    this.knownHosts = {};
    this.tabs = [];
    this.activeTab = null;
    this.stack = [];
    this.query = '';
  }

  async init() {
    await this.reload();
    // önceki çalıştırmadan kalan geçici (hızlı bağlan) oturumları temizle
    for (const s of this.sessions.filter((x) => x.temporary)) await N.call('deleteSession', { id: s.id }).catch(() => {});
    if (this.sessions.some((x) => x.temporary)) await this.reload();
    this.applyTheme();

    this.root = document.getElementById('app');
    this.buildHome();
    this.buildSession();
    this.root.append(this.home.el, this.sess.el);
    this.stack = [this.home];
    this.showTop();
    this.renderHome();

    N.on('data', (e) => this.tabFor(e.c)?.onData(e));
    N.on('status', (e) => this.tabFor(e.c)?.onStatus(e));
    N.on('banner', (e) => this.tabFor(e.c)?.onBanner(e));
    N.on('exit', (e) => this.tabFor(e.c)?.onExit(e));
    N.on('closed', (e) => this.tabFor(e.c)?.onClosed(e));
    N.on('fwd', (e) => this.tabFor(e.c)?.onFwd(e));
    N.on('xfer', (e) => { for (const t of this.tabs) if (t.files?.onXfer(e)) break; });
    N.on('ask', async (a) => {
      let v = null;
      try { v = await handleAsk(a, this.settings); } finally { N.answer(a.askId, v); }
    });
    N.on('stateChanged', () => this.reload());
    N.on('allClosed', () => {
      for (const t of this.tabs) if (t.connId) t.onClosed({ c: t.connId, reason: 'user' });
    });
    window.__nback = () => this.onBack();
    window.__nresume = () => {
      if (this.pausedAt && Date.now() - this.pausedAt > 60000 && this.tabs.some((t) => t.state === 'connected')) N.call('probe').catch(() => {});
      this.pausedAt = 0;
      for (const t of this.tabs) t.resumed();
    };
    window.__npause = () => { this.pausedAt = Date.now(); };
    N.call('appInfo').then((i) => { this.info = i; }).catch(() => {});
    N.on('update', (st) => { this.setUpdate(st); if (st.newer && !st.skipped) toast(`SSHDeck ${st.version} çıktı`); });
    N.on('updateShow', () => updateSheet(this));
    N.call('updateState').then((st) => { if (st.version) this.setUpdate(st); if (st.show) updateSheet(this); }).catch(() => {});
  }

  setUpdate(st) { this.update = st; this.renderHome(); }

  tabFor(c) { return c ? this.tabs.find((t) => t.connId === c) : null; }

  async reload() {
    const st = await N.call('state');
    this.sessions = st.sessions;
    this.settings = st.settings || {};
    this.keys = st.keys || [];
    this.knownHosts = st.knownHosts || {};
    // açık sekmelerin oturum bilgisini tazele
    for (const t of this.tabs) {
      const s = this.sessions.find((x) => x.id === t.session.id);
      if (s) t.session = s;
    }
    this.renderHome();
    for (const v of this.stack) v.refresh?.();
  }

  async saveSettings(patch, { quiet } = {}) {
    Object.assign(this.settings, patch);
    await N.call('saveSettings', { patch });
    if ('uiTheme' in patch) this.applyTheme();
    if (!quiet || 'fontSize' in patch) for (const t of this.tabs) t.term.applySettings(this.settings);
    if ('keepScreenOn' in patch) this.updateKeepAwake();
  }

  applyTheme() {
    const key = UI_THEMES[this.settings.uiTheme] ? this.settings.uiTheme : 'dark';
    document.documentElement.dataset.ui = key;
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg2').trim() || '#14171c';
    N.call('barColors', { bg, light: !!UI_THEMES[key].light }).catch(() => {});
  }

  updateKeepAwake() {
    const on = !!this.settings.keepScreenOn && this.tabs.some((t) => t.state === 'connected');
    if (on !== this.awake) { this.awake = on; N.call('keepScreenOn', { on }).catch(() => {}); }
  }

  firstConnect() {
    if (!this.settings.askedNotif) {
      N.call('notifyPermission').catch(() => {});
      this.saveSettings({ askedNotif: true }, { quiet: true });
    }
  }

  // ---------------------------------------------------------------- gezinme
  push(view) {
    this.stack.push(view);
    if (!view.el.isConnected) this.root.append(view.el);
    this.showTop();
  }

  async back() {
    if (this.stack.length <= 1) return;
    const top = this.stack[this.stack.length - 1];
    if (top.canLeave && !(await top.canLeave())) return;
    this.stack.pop();
    if (top !== this.sess) top.el.remove();
    this.showTop();
  }

  showTop() {
    const top = this.stack[this.stack.length - 1];
    for (const v of [this.home, this.sess, ...this.stack]) v.el.classList.toggle('hidden', v !== top);
    if (top === this.sess) this.activeTab?.term.scheduleFit();
    if (top === this.home) this.renderHome();
  }

  onBack() {
    if (modalOpen()) { closeTop(); return true; }
    if (this.stack.length > 1) { this.back(); return true; }
    if (this.query) { this.setQuery(''); return true; }
    return false;
  }

  // ---------------------------------------------------------------- ana ekran
  buildHome() {
    this.searchInput = h('input', { type: 'search', placeholder: 'Oturum ara…', autocapitalize: 'off', spellcheck: false, oninput: () => { this.query = this.searchInput.value; this.renderHome(); } });
    this.searchBar = h('div.searchbar.hidden', null, this.searchInput);
    this.homeList = h('div.scroll');
    this.openBadge = h('span.badge.hidden');
    const sessBtn = h('button.tb', { onclick: () => this.tabs.length && this.activate(this.activeTab || this.tabs[0]) }, icon('terminal', 22), this.openBadge);
    this.home = {
      el: h('div.view', null,
        h('div.topbar', null,
          h('div.logo', null, h('i', null, icon('terminal', 18)), 'SSHDeck'),
          sessBtn,
          h('button.tb', { onclick: () => this.toggleSearch() }, icon('search', 21)),
          h('button.tb', { onclick: () => this.push(settingsView(this)) }, icon('gear', 21))),
        this.searchBar, this.homeList,
        h('button.fab', { onclick: () => this.addMenu() }, icon('plus', 28))),
      refresh: () => this.renderHome(),
    };
  }

  toggleSearch() {
    const show = this.searchBar.classList.contains('hidden');
    this.searchBar.classList.toggle('hidden', !show);
    if (show) setTimeout(() => this.searchInput.focus(), 50); else this.setQuery('');
  }

  setQuery(q) {
    this.query = q;
    this.searchInput.value = q;
    if (!q) this.searchBar.classList.add('hidden');
    this.renderHome();
  }

  renderHome() {
    if (!this.homeList || this.homeRaf) return;
    this.homeRaf = requestAnimationFrame(() => { this.homeRaf = null; this.doRenderHome(); });
  }

  doRenderHome() {
    this.openBadge.textContent = this.tabs.length;
    this.openBadge.classList.toggle('hidden', !this.tabs.length);
    const out = [];
    const u = this.update;
    if (u && u.newer && !u.skipped) {
      out.push(h('div.upd-banner', { onclick: () => updateSheet(this) }, icon('upload', 20),
        h('div.txt', null, h('b', null, `SSHDeck ${u.version} çıktı`), h('small', null, 'Yenilikleri görmek ve kurmak için dokunun')), icon('chevron', 18)));
    }
    if (this.tabs.length) {
      out.push(h('div.sec-title', null, 'Açık bağlantılar'));
      out.push(h('div', null, this.tabs.map((t) => h('div.row', { onclick: () => this.activate(t) },
        h('div.av', null, icon('terminal', 20), h('span.dot.' + (t.dotClass || 'x'))),
        h('div.txt', null, h('b', null, t.name), h('small', null, t.state === 'error' ? t.message : t.subtitle)),
        h('button.tb', { onclick: async (e) => { e.stopPropagation(); if (await t.confirmClose()) this.closeTab(t); } }, icon('x', 20))))));
    }
    const q = this.query.trim().toLocaleLowerCase('tr');
    const list = this.sessions.filter((s) => !s.temporary && (!q || [s.name, s.host, s.username, s.group].some((v) => String(v || '').toLocaleLowerCase('tr').includes(q))));
    if (!this.sessions.filter((s) => !s.temporary).length) {
      out.push(h('div.empty', null, h('div.big', null, icon('server', 32)), h('h3', null, 'Henüz oturum yok'),
        h('p', null, 'Bir sunucu ekleyin ya da bilgisayardaki SSHDeck\'in yedeğini içe aktarın.'),
        h('div.btns', null,
          h('button.btn.primary', { onclick: () => this.newSession() }, icon('plus', 18), 'Yeni oturum'),
          h('button.btn', { onclick: () => this.quickConnect() }, icon('bolt', 18), 'Hızlı bağlan'),
          h('button.btn', { onclick: () => importBackup(this) }, icon('import', 18), 'Masaüstü yedeğini içe aktar'))));
    } else {
      const groups = new Map();
      for (const s of list) {
        const g = s.group || '';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(s);
      }
      const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, 'tr'));
      const collapsed = new Set(this.settings.collapsedGroups || []);
      if (!keys.length) out.push(h('div.empty', null, h('p', null, 'Eşleşen oturum yok')));
      for (const g of keys) {
        const items = groups.get(g).sort((a, b) => a.name.localeCompare(b.name, 'tr', { numeric: true }));
        const closed = !q && collapsed.has(g);
        if (keys.length > 1 || g) {
          out.push(h('div.group-h' + (closed ? '.closed' : ''), {
            onclick: () => {
              const c = new Set(this.settings.collapsedGroups || []);
              if (c.has(g)) c.delete(g); else c.add(g);
              this.saveSettings({ collapsedGroups: [...c] }, { quiet: true }).then(() => this.renderHome());
            },
          }, icon('chevron', 14), h('span', null, g || 'Grupsuz'), h('span.count', null, items.length)));
          out[out.length - 1].querySelector('.ic').classList.add('chev');
          out[out.length - 1].querySelector('.ic').style.transform = closed ? '' : 'rotate(90deg)';
        }
        if (closed) continue;
        out.push(h('div', null, items.map((s) => this.sessionRow(s))));
      }
    }
    out.push(h('div', { style: { height: '96px' } }));
    this.homeList.replaceChildren(...out);
  }

  sessionRow(s) {
    const open = this.tabs.filter((t) => t.session.id === s.id);
    const st = open.find((t) => t.state === 'connected') ? 'ok' : open.find((t) => t.state === 'connecting') ? 'busy' : open.length ? 'err' : null;
    const r = h('div.row', null,
      h('div.av', null, icon('server', 20), st ? h('span.dot.' + st) : null),
      h('div.txt', null, h('b', null, s.name), h('small', null, `${s.username ? s.username + '@' : ''}${s.host}${s.port && s.port !== 22 ? ':' + s.port : ''}${s.authType === 'key' ? ' · anahtar' : ''}`)),
      h('button.tb', { onclick: (e) => { e.stopPropagation(); this.sessionMenu(s); } }, icon('more', 20)));
    let lp = null; let long = false;
    r.addEventListener('touchstart', () => { long = false; lp = setTimeout(() => { long = true; try { navigator.vibrate?.(15); } catch { /* yok */ } this.sessionMenu(s); }, 500); }, { passive: true });
    r.addEventListener('touchmove', () => clearTimeout(lp), { passive: true });
    r.addEventListener('touchend', () => clearTimeout(lp));
    r.addEventListener('click', () => {
      if (long) return;
      const t = open[0];
      if (t) { this.activate(t); if (t.state !== 'connected' && t.state !== 'connecting') t.connect(); } else this.openTab(s);
    });
    return r;
  }

  async sessionMenu(s) {
    const v = await actionSheet(s.name, [
      { icon: 'terminal', label: 'Bağlan', value: 'connect' },
      { icon: 'tab', label: 'Yeni sekmede bağlan', value: 'newtab' },
      { icon: 'folder', label: 'Dosyaları aç (SFTP)', value: 'files' },
      '-',
      { icon: 'edit', label: 'Düzenle', value: 'edit' },
      { icon: 'dup', label: 'Kopyasını oluştur', value: 'dup' },
      { icon: 'copy', label: 'ssh komutunu kopyala', value: 'copycmd' },
      { icon: 'trash', label: 'Sil', value: 'delete', danger: true },
    ], `${s.username ? s.username + '@' : ''}${s.host}:${s.port || 22}`);
    switch (v) {
      case 'connect': { const t = this.tabs.find((x) => x.session.id === s.id); if (t) this.activate(t); else this.openTab(s); break; }
      case 'newtab': this.openTab(s); break;
      case 'files': this.openTab(s, 'files'); break;
      case 'edit': { const r = await sessionEditor(this, s); if (r?.connect) this.openTab(this.sessions.find((x) => x.id === r.id)); break; }
      case 'dup': {
        const { id, has_password: _a, has_passphrase: _b, ...rest } = s;
        const nid = await N.call('saveSession', { session: { ...rest, name: s.name + ' (kopya)' } });
        await this.reload();
        const r = await sessionEditor(this, this.sessions.find((x) => x.id === nid));
        if (r?.connect) this.openTab(this.sessions.find((x) => x.id === r.id));
        break;
      }
      case 'copycmd': await N.call('clipboardSet', { text: `ssh ${s.port && s.port !== 22 ? '-p ' + s.port + ' ' : ''}${s.username ? s.username + '@' : ''}${s.host}` }); toast('Kopyalandı'); break;
      case 'delete':
        if (!await confirm({ title: 'Oturum silinsin mi?', message: s.name, ok: 'Sil', danger: true })) return;
        await N.call('deleteSession', { id: s.id });
        await this.reload();
        break;
      default:
    }
  }

  async addMenu() {
    const v = await actionSheet('Ekle', [
      { icon: 'plus', label: 'Yeni oturum', value: 'new' },
      { icon: 'bolt', label: 'Hızlı bağlan (kullanıcı@sunucu)', value: 'quick' },
      { icon: 'paste', label: 'Panodan oturum oluştur', value: 'paste', hint: 'ssh komutu / bilgiler' },
      { icon: 'import', label: 'Masaüstü yedeğini içe aktar', value: 'import' },
    ]);
    if (v === 'new') this.newSession();
    else if (v === 'quick') this.quickConnect();
    else if (v === 'paste') this.pasteSession();
    else if (v === 'import') importBackup(this);
  }

  async newSession(prefill = {}) {
    const r = await sessionEditor(this, prefill);
    if (r?.connect) this.openTab(this.sessions.find((x) => x.id === r.id));
  }

  async quickConnect() {
    const v = await promptText({
      title: 'Hızlı bağlan', placeholder: 'kullanıcı@sunucu:port', ok: 'Bağlan',
      sub: 'Kaydedilmez; bağlantıyı sonra menüden kaydedebilirsiniz.',
      validate: (x) => (parseQuick(x) ? null : 'örn. root@10.0.0.5 veya pi@raspberry:2222'),
    });
    if (!v) return;
    const q = parseQuick(v);
    const id = await N.call('saveSession', { session: { ...q, name: `${q.username ? q.username + '@' : ''}${q.host}`, authType: 'auto', temporary: true } });
    await this.reload();
    this.openTab(this.sessions.find((x) => x.id === id));
  }

  async pasteSession() {
    let text = '';
    try { text = await N.call('clipboardGet'); } catch { /* yok */ }
    const p = parseConnText(text);
    if (!p) { toast('Panoda bağlantı bilgisi bulunamadı (örn. "ssh -p 22 root@10.0.0.5")', { type: 'err', ms: 4500 }); return; }
    const pre = { name: p.name, host: p.host, port: p.port, username: p.username, authType: 'password' };
    if (p.password) pre.password = p.password;
    this.newSession(pre);
  }

  // ---------------------------------------------------------------- oturum ekranı
  buildSession() {
    this.sTitle = h('b');
    this.sSub = h('small');
    this.vBtns = {
      term: h('button.tb', { onclick: () => this.activeTab?.show('term') }, icon('terminal', 21)),
      files: h('button.tb', { onclick: () => this.activeTab?.show('files') }, icon('folder', 21)),
      tunnels: h('button.tb', { onclick: () => this.activeTab?.show('tunnels') }, icon('tunnel', 21)),
    };
    this.tabStrip = h('div.sess-tabs.hidden');
    this.tabBox = h('div.pane');
    this.sess = {
      el: h('div.view.hidden', null,
        h('div.topbar', null,
          h('button.tb', { onclick: () => this.back() }, icon('back', 22)),
          h('div.title', { onclick: () => this.tabSwitcher() }, this.sTitle, this.sSub),
          this.vBtns.term, this.vBtns.files, this.vBtns.tunnels,
          h('button.tb', { onclick: () => this.tabMenu() }, icon('more', 21))),
        this.tabStrip, this.tabBox),
    };
  }

  updateSessionBar() {
    const t = this.activeTab;
    if (!t) return;
    this.sTitle.textContent = t.name;
    this.sSub.textContent = t.state === 'error' ? t.message : t.subtitle;
    this.sSub.style.color = t.state === 'error' ? 'var(--err)' : '';
    for (const [k, b] of Object.entries(this.vBtns)) b.classList.toggle('on', t.view === k);
    this.tabStrip.classList.toggle('hidden', this.tabs.length < 2);
    if (this.tabs.length > 1) {
      this.tabStrip.replaceChildren(...this.tabs.map((x) => h('button.stab' + (x === t ? '.on' : ''), { onclick: () => this.activate(x) },
        h('span.dot.' + (x.dotClass || 'x')), h('span.ellip', null, x.name))),
      h('button.stab', { onclick: () => this.back() }, icon('plus', 16)));
    }
  }

  async openTab(session, view = 'term') {
    if (!session) return;
    const t = new SessionTab(this, session);
    this.tabs.push(t);
    t.el.classList.add('hidden');
    this.tabBox.append(t.el);
    this.activate(t);
    await t.mounted();
    t.show(view);
    t.connect();
  }

  activate(t) {
    this.activeTab = t;
    for (const x of this.tabs) x.el.classList.toggle('hidden', x !== t);
    if (this.stack[this.stack.length - 1] !== this.sess) {
      // ana ekrandan açıldıysa ayarlar vb. kapat: yığın = [home, sess]
      for (const v of this.stack.splice(1)) if (v !== this.sess) v.el.remove();
      this.push(this.sess);
    }
    this.updateSessionBar();
    t.term.scheduleFit();
    this.renderHome();
  }

  async closeTab(t) {
    await t.close();
    this.tabs = this.tabs.filter((x) => x !== t);
    if (this.activeTab === t) {
      this.activeTab = this.tabs[this.tabs.length - 1] || null;
      if (this.activeTab) this.activate(this.activeTab);
      else if (this.stack[this.stack.length - 1] === this.sess) this.back();
    }
    this.updateSessionBar();
    this.renderHome();
    this.updateKeepAwake();
  }

  async tabSwitcher() {
    if (this.tabs.length < 2) return;
    const id = await actionSheet('Açık bağlantılar', this.tabs.map((t) => ({ icon: t === this.activeTab ? 'check' : 'terminal', label: t.name, value: t.id, hint: t.state === 'connected' ? 'bağlı' : t.state === 'connecting' ? 'bağlanıyor' : 'kapalı' })));
    const t = this.tabs.find((x) => x.id === id);
    if (t) this.activate(t);
  }

  async tabMenu() {
    const t = this.activeTab;
    if (!t) return;
    const conn = t.state === 'connected';
    const v = await actionSheet(t.name, [
      conn ? { icon: 'cpu', label: 'Sunucu durumu', value: 'stats' } : null,
      { icon: 'snippet', label: 'Hazır komutlar', value: 'snip' },
      { icon: 'select', label: 'Metin seç / kopyala', value: 'copy' },
      { icon: 'paste', label: 'Yapıştır', value: 'paste' },
      { icon: 'zoomin', label: 'Yazıyı büyüt', value: 'zin', hint: String(this.settings.fontSize || 13) },
      { icon: 'zoomout', label: 'Yazıyı küçült', value: 'zout' },
      '-',
      t.session.temporary ? { icon: 'save', label: 'Oturumu kaydet', value: 'save' } : { icon: 'edit', label: 'Oturumu düzenle', value: 'edit' },
      { icon: 'tab', label: 'Aynı sunucuya yeni sekme', value: 'dup' },
      { icon: 'refresh', label: conn ? 'Yeniden bağlan' : 'Bağlan', value: 'reconnect' },
      { icon: 'power', label: 'Bağlantıyı kapat', value: 'close', danger: true },
    ]);
    switch (v) {
      case 'stats': t.statsSheet(); break;
      case 'snip': this.pickSnippet(t); break;
      case 'copy': t.copyView(); break;
      case 'paste': t.show('term'); t.term.pasteClipboard(); break;
      case 'zin': case 'zout': {
        const n = Math.max(7, Math.min(30, (this.settings.fontSize || 13) + (v === 'zin' ? 1 : -1)));
        this.saveSettings({ fontSize: n });
        break;
      }
      case 'save': {
        const name = await promptText({ title: 'Oturumu kaydet', label: 'Ad', value: t.name, ok: 'Kaydet' });
        if (!name) return;
        await N.call('saveSession', { session: { id: t.session.id, name: name.trim() || t.name, temporary: null } });
        await this.reload();
        toast('Oturum kaydedildi', { type: 'ok' });
        break;
      }
      case 'edit': await sessionEditor(this, t.session); break;
      case 'dup': this.openTab(t.session); break;
      case 'reconnect':
        if (conn && !await confirm({ title: 'Yeniden bağlanılsın mı?', message: 'Mevcut kabuk kapanır.', ok: 'Yeniden bağlan' })) return;
        t.disconnect();
        t.connect();
        break;
      case 'close': if (await t.confirmClose()) this.closeTab(t); break;
      default:
    }
  }

  async pickSnippet(t) {
    const sn = this.settings.snippets || [];
    const v = await actionSheet('Hazır komutlar', [
      ...sn.map((s) => ({ icon: 'snippet', label: s.name, value: s.id, hint: s.run ? '↵' : '' })),
      sn.length ? '-' : null,
      { icon: 'edit', label: sn.length ? 'Komutları düzenle' : 'Hazır komut ekle', value: '__edit' },
    ]);
    if (v === '__edit') { this.push(snippetsView(this)); return; }
    const s = sn.find((x) => x.id === v);
    if (!s) return;
    if (t.state !== 'connected') { toast('Bağlı değil', { type: 'err' }); return; }
    t.show('term');
    t.typeInTerminal(s.command.replace(/\r?\n/g, '\r') + (s.run ? '\r' : ''));
    t.term.focus();
  }

  openEditor(opts) { this.push(editorView(this, opts)); }
}

const app = new App();
window.sshdeck = app;
app.init().catch((e) => {
  console.error(e);
  document.body.append(h('pre', { style: { color: 'tomato', padding: '16px', whiteSpace: 'pre-wrap' } }, 'Başlatma hatası: ' + e.message + '\n' + e.stack));
});
