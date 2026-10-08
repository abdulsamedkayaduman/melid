import { h, icon } from './util.js';
import { THEMES } from './dialogs.js';

// Bir sekmedeki tek terminal bölmesi: kendi xterm'i ve aynı SSH bağlantısında kendi kabuğu (sid).
export class TermPane {
  constructor(tab, sid) {
    this.tab = tab;
    this.sid = sid;
    const st = tab.app.settings;
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
    this.term.loadAddon(new window.WebLinksAddon.WebLinksAddon((ev, uri) => { if (ev.ctrlKey || ev.metaKey) tab.api.openExternal(uri); }));

    this.host = h('div.term-host');
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
    this.el = h('div.term-pane', null, this.host, this.searchBar);
    this.el.addEventListener('focusin', () => tab.setActivePane(this));
    this.el.addEventListener('mousedown', () => tab.setActivePane(this));

    this.term.onData((d) => tab.onTermInput(this, d));
    this.term.onBinary((d) => tab.onTermInput(this, d));
    this.term.onResize(({ cols, rows }) => {
      if (this.shellOpen && tab.state === 'connected') tab.api.ssh.resize(tab.connId, cols, rows, this.sid);
      if (tab.activePane === this) tab.app.updateStatus();
    });
    this.term.onSelectionChange(() => {
      if (tab.app.settings.copyOnSelect && this.term.hasSelection()) tab.api.clipboard.write(this.term.getSelection());
    });
    // OSC 52: tmux/vim gibi fare modunu açan programlar kopyaladığını bu diziyle panoya gönderir.
    // Yalnız yazma desteklenir; '?' (panoyu okuma) isteği güvenlik için yok sayılır.
    this.term.parser.registerOscHandler(52, (data) => {
      const b64 = data.slice(data.indexOf(';') + 1);
      if (!b64 || b64 === '?') return true;
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        tab.api.clipboard.write(new TextDecoder().decode(bytes));
      } catch {}
      return true;
    });
    this.term.attachCustomKeyEventHandler((e) => tab.onTermKey(this, e));
    this.host.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (tab.app.settings.rightClick === 'paste' && !e.shiftKey) { this.paste(); return; }
      tab.termMenu(this, e.clientX, e.clientY);
    });
    this.ro = new ResizeObserver(() => this.scheduleFit());
    this.ro.observe(this.host);
  }

  mount() {
    if (this.mounted) return;
    this.mounted = true;
    this.host.style.background = this.term.options.theme.background;
    this.term.open(this.host);
    this.scheduleFit();
  }

  scheduleFit() {
    if (this._fitRaf) return;
    this._fitRaf = requestAnimationFrame(() => {
      this._fitRaf = null;
      if (!this.el.isConnected || this.el.offsetParent === null || !this.host.clientWidth) return;
      try { this.fit.fit(); } catch {}
    });
  }

  applySettings() {
    const st = this.tab.app.settings;
    this.term.options.fontFamily = st.fontFamily;
    this.term.options.fontSize = st.fontSize;
    this.term.options.scrollback = st.scrollback;
    this.term.options.cursorBlink = st.cursorBlink;
    this.term.options.theme = THEMES[st.theme] || THEMES['deck-dark'];
    this.host.style.background = this.term.options.theme.background;
    this.scheduleFit();
  }

  focus() { this.mount(); setTimeout(() => this.term.focus(), 0); }

  async paste() {
    const t = await this.tab.api.clipboard.read();
    if (t) this.term.paste(t);
    this.term.focus();
  }

  toggleSearch(show) {
    this.searchBar.classList.toggle('on', show);
    if (show) { const s = this.term.getSelection(); if (s && !s.includes('\n')) this.searchInput.value = s; this.searchInput.focus(); this.searchInput.select(); }
    else { this.search.clearDecorations?.(); this.term.focus(); }
  }

  info(msg, color = '90') { this.term.write(`\r\n\x1b[${color}m${msg}\x1b[0m`); }

  dispose() {
    this.ro.disconnect();
    this.term.dispose();
    this.el.remove();
  }
}
