// Dokunmatik terminal: xterm.js çizer; klavye girişi, ek tuşlar ve dokunma hareketleri burada.
//
// Android klavyeleri (Gboard vb.) tuş olayı yerine metin girişi (input/composition) gönderir. xterm'in kendi
// işleyicileri yerine: xterm'in textarea'sına giden olaylar üst öğede (capture) yakalanır, textarea içinde sabit
// bir "nöbetçi" metin tutulur ve her değişiklikte fark (silinen + eklenen) terminale gönderilir. Native taraf da
// terminal odaktayken klavyeyi "görünür parola" kipine alır (öneri/otomatik düzeltme yok).
import { h, icon } from './util.js';
import * as N from './native.js';
import { THEMES } from './dialogs.js';

const SENT = '  ';
const FN = { F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS', F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~', F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~' };
const TILDE = { PGUP: 5, PGDN: 6, INS: 2, DEL: 3 };
const ARROW = { UP: 'A', DOWN: 'B', RIGHT: 'C', LEFT: 'D', HOME: 'H', END: 'F' };
const KEYNAME = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Home: 'HOME', End: 'END', PageUp: 'PGUP', PageDown: 'PGDN', Insert: 'INS', Delete: 'DEL' };

export function ctrlChar(c) {
  const k = c.toLowerCase();
  if (k >= 'a' && k <= 'z') return String.fromCharCode(k.charCodeAt(0) - 96);
  const m = { '@': 0, ' ': 0, 2: 0, '[': 27, 3: 27, '\\': 28, 4: 28, ']': 29, 5: 29, '^': 30, 6: 30, _: 31, '-': 31, 7: 31, '?': 127, 8: 127, '/': 31 };
  return k in m ? String.fromCharCode(m[k]) : c;
}

const ROWS_MAIN = [
  ['ESC', '/', '|', '-', 'HOME', 'UP', 'END', 'PGUP', 'KBD'],
  ['TAB', 'CTRL', 'ALT', '~', 'LEFT', 'DOWN', 'RIGHT', 'PGDN', 'MORE'],
];
const ROWS_FN = [
  ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'INS', 'DEL', 'KBD'],
  ['F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'PASTE', 'SNIP', 'MORE'],
];
const LABEL = { UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→', PGUP: 'PgUp', PGDN: 'PgDn', HOME: 'Home', END: 'End' };
const REPEAT = new Set(['UP', 'DOWN', 'LEFT', 'RIGHT', 'PGUP', 'PGDN', 'DEL']);

export class TermView {
  /**
   * opts: { settings, onData(str), onResize(cols, rows), onLongPress({x, y, url}), onSnippets(), onFontSize(n) }
   */
  constructor(opts) {
    this.opts = opts;
    const s = opts.settings;
    this.mods = { CTRL: 0, ALT: 0 }; // 0 kapalı, 1 tek sefer, 2 kilitli
    this.layer = 'main';

    this.host = h('div.term-host');
    this.overlay = h('div.term-overlay.hidden');
    this.zoomInd = h('div.zoom-ind.hidden');
    this.scrollInd = h('div.scroll-ind');
    this.jumpBtn = h('button.jump-bottom.hidden', { type: 'button', onclick: () => { this.term.scrollToBottom(); } }, icon('down', 20));
    this.jumpBtn.addEventListener('pointerdown', (e) => e.preventDefault()); // klavye odağı terminalde kalsın
    this.wrap = h('div.term-wrap', null, this.host, this.scrollInd, this.zoomInd, this.jumpBtn, this.overlay);
    this.keysEl = h('div.xkeys');
    this.el = h('div.pane.term-pane', null, this.wrap, this.keysEl);
    if (s.extraKeys === false) this.keysEl.classList.add('hidden');
    this.privateKb = s.privateKeyboard !== false;
    this.renderKeys();

    const theme = THEMES[s.theme] || THEMES['deck-dark'];
    this.term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: s.fontSize || 13,
      lineHeight: 1.1,
      theme,
      scrollback: s.scrollback || 5000,
      cursorBlink: s.cursorBlink !== false,
      allowProposedApi: true,
      smoothScrollDuration: 0,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    try {
      this.term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => N.call('openUrl', { url: uri })));
    } catch { /* isteğe bağlı */ }
    this.term.onData((d) => this.opts.onData(d)); // terminal sorgu yanıtları (DA, DSR) ve fare olayları
    this.term.onBinary((d) => this.opts.onData(d));
    this.term.onResize(({ cols, rows }) => this.opts.onResize(cols, rows));
    this.term.onScroll(() => this.updateScrollUi());
    this.term.onWriteParsed(() => this.updateScrollUi());
    this.wrap.style.background = theme.background;
  }

  /** DOM'a eklendikten sonra çağrılır. */
  async open() {
    try { await document.fonts.load(`${this.term.options.fontSize}px 'JetBrains Mono'`); } catch { /* yok */ }
    this.term.open(this.host);
    const ta = this.term.textarea;
    this.ta = ta;
    for (const [k, v] of Object.entries({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'enter' })) ta.setAttribute(k, v);
    // Gizli klavye: öneri/öğrenme yok, tuşlar tek tek gelir; kapalıysa klavye normal (öneri, kaydırarak yazma) açılır
    ta.addEventListener('focus', () => { N.termInput(this.privateKb); this.resetInput(); });
    ta.addEventListener('blur', () => N.termInput(false));
    this.bindInput();
    this.bindTouch();
    this.ro = new ResizeObserver(() => this.scheduleFit());
    this.ro.observe(this.wrap);
    this.scheduleFit();
  }

  scheduleFit() {
    if (this.fitRaf) return;
    this.fitRaf = requestAnimationFrame(() => {
      this.fitRaf = null;
      if (!this.wrap.isConnected || this.wrap.clientHeight < 20 || this.wrap.clientWidth < 20) return;
      try { this.fit.fit(); } catch { /* görünmüyor */ }
      this.updateScrollUi();
    });
  }

  get cols() { return this.term.cols; }
  get rows() { return this.term.rows; }

  write(data) { this.term.write(data); }

  focus() {
    if (!this.term.element) return;
    this.term.focus();
    N.call('showKeyboard').catch(() => {});
  }

  blur() { this.ta?.blur(); }

  setOverlay(content) {
    this.overlay.replaceChildren();
    if (!content) { this.overlay.classList.add('hidden'); return; }
    this.overlay.append(content);
    this.overlay.classList.remove('hidden');
  }

  applySettings(s) {
    const theme = THEMES[s.theme] || THEMES['deck-dark'];
    this.term.options.theme = theme;
    this.term.options.cursorBlink = s.cursorBlink !== false;
    if (s.fontSize && s.fontSize !== this.term.options.fontSize) this.term.options.fontSize = s.fontSize;
    this.wrap.style.background = theme.background;
    this.keysEl.classList.toggle('hidden', s.extraKeys === false);
    this.privateKb = s.privateKeyboard !== false;
    if (this.ta && document.activeElement === this.ta) N.termInput(this.privateKb);
    this.scheduleFit();
  }

  setFontSize(n) {
    n = Math.max(7, Math.min(30, Math.round(n)));
    if (n === this.term.options.fontSize) return n;
    this.term.options.fontSize = n;
    this.scheduleFit();
    return n;
  }

  dispose() {
    this.ro?.disconnect();
    this.term.dispose();
  }

  // ------------------------------------------------------------ gönderme
  /** Klavyeden gelen veri: tek seferlik Ctrl/Alt uygulanır. */
  sendTyped(data) {
    if (!data) return;
    if (this.mods.CTRL && data.length === 1) data = ctrlChar(data);
    if (this.mods.ALT) data = '\x1b' + data;
    this.releaseMods();
    this.term.scrollToBottom();
    this.opts.onData(data);
  }

  releaseMods() {
    let changed = false;
    for (const k of ['CTRL', 'ALT']) if (this.mods[k] === 1) { this.mods[k] = 0; changed = true; }
    if (changed) this.renderKeys();
  }

  /** Ok / Home / End / PgUp / F tuşları (değiştiricilerle). */
  keySeq(name, { ctrl = false, alt = false, shift = false } = {}) {
    const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
    if (ARROW[name]) {
      const c = ARROW[name];
      if (mod > 1) return `\x1b[1;${mod}${c}`;
      return (this.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + c;
    }
    if (TILDE[name]) return mod > 1 ? `\x1b[${TILDE[name]};${mod}~` : `\x1b[${TILDE[name]}~`;
    if (FN[name]) return FN[name];
    return null;
  }

  // ------------------------------------------------------------ klavye
  resetInput() {
    if (!this.ta) return;
    this.ta.value = SENT;
    try { this.ta.setSelectionRange(SENT.length, SENT.length); } catch { /* yok */ }
  }

  bindInput() {
    const w = this.wrap;
    const stop = (e) => e.stopPropagation();
    let composing = false;
    const flush = () => {
      const v = this.ta.value;
      if (v === SENT) return;
      let p = 0;
      while (p < v.length && p < SENT.length && v[p] === SENT[p]) p++;
      const del = SENT.length - p;
      const ins = v.slice(p).replace(/ /g, ' ').replace(/\r?\n/g, '\r');
      this.resetInput();
      if (del > 0) { this.releaseMods(); this.opts.onData('\x7f'.repeat(del)); }
      if (ins) {
        if (ins.length === 1) this.sendTyped(ins);
        else { this.releaseMods(); this.term.scrollToBottom(); this.opts.onData(ins); }
      }
    };
    w.addEventListener('keydown', (e) => {
      if (e.target !== this.ta) return;
      stop(e);
      if (e.isComposing || e.keyCode === 229) return; // metin "input" olayıyla gelecek
      const seq = this.keyFromEvent(e);
      if (seq === null) return;
      e.preventDefault();
      if (seq) { this.term.scrollToBottom(); this.opts.onData(seq); }
    }, true);
    w.addEventListener('keypress', (e) => { if (e.target === this.ta) stop(e); }, true);
    w.addEventListener('keyup', (e) => { if (e.target === this.ta) stop(e); }, true);
    w.addEventListener('beforeinput', (e) => { if (e.target === this.ta) stop(e); }, true);
    w.addEventListener('input', (e) => {
      if (e.target !== this.ta) return;
      stop(e);
      if (!composing) flush();
    }, true);
    w.addEventListener('compositionstart', (e) => { if (e.target === this.ta) { stop(e); composing = true; } }, true);
    w.addEventListener('compositionupdate', (e) => { if (e.target === this.ta) stop(e); }, true);
    w.addEventListener('compositionend', (e) => {
      if (e.target !== this.ta) return;
      stop(e);
      composing = false;
      setTimeout(flush, 0);
    }, true);
    w.addEventListener('paste', (e) => {
      if (e.target !== this.ta) return;
      stop(e);
      e.preventDefault();
      this.paste(e.clipboardData.getData('text/plain'));
    }, true);
  }

  /**
   * Tuş olayı -> terminal dizisi (tek seferlik Ctrl/Alt uygulanmış ve bırakılmış).
   * '' = yut (değiştirici tuş), null = tarayıcıya bırak.
   */
  keyFromEvent(e) {
    const k = e.key;
    if (['Unidentified', 'Process', 'Dead'].includes(k)) return null; // IME: metin "input" ile gelecek
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn'].includes(k)) return '';
    const ctrl = e.ctrlKey || !!this.mods.CTRL;
    const alt = e.altKey || !!this.mods.ALT;
    const pre = (s) => (alt ? '\x1b' + s : s);
    let out = null;
    if (k === 'Enter') out = pre('\r');
    else if (k === 'Backspace') out = pre(ctrl ? '\x08' : '\x7f');
    else if (k === 'Tab') out = e.shiftKey ? '\x1b[Z' : pre('\t');
    else if (k === 'Escape') out = '\x1b';
    else if (KEYNAME[k]) out = this.keySeq(KEYNAME[k], { ctrl, alt, shift: e.shiftKey });
    else if (/^F([1-9]|1[0-2])$/.test(k)) out = FN[k];
    else if (k && [...k].length === 1) {
      // donanım klavyesi: Ctrl+Shift+V yapıştır
      if (e.ctrlKey && e.shiftKey && (k === 'V' || k === 'v')) { this.pasteClipboard(); return ''; }
      if (e.ctrlKey && e.shiftKey && (k === 'C' || k === 'c')) return '';
      out = pre(ctrl ? ctrlChar(k) : k);
    }
    if (out !== null) this.releaseMods();
    return out;
  }

  async pasteClipboard() {
    try { this.paste(await N.call('clipboardGet')); } catch { /* yok */ }
  }

  paste(text) {
    if (!text) return;
    text = text.replace(/\r?\n/g, '\r');
    if (this.term.modes.bracketedPasteMode) text = '\x1b[200~' + text + '\x1b[201~';
    this.term.scrollToBottom();
    this.opts.onData(text);
  }

  // ------------------------------------------------------------ ek tuşlar
  renderKeys() {
    const rows = this.layer === 'fn' ? ROWS_FN : ROWS_MAIN;
    this.keysEl.replaceChildren(...rows.map((r) => h('div.xrow', null, r.map((k) => this.keyButton(k)))));
  }

  keyButton(k) {
    let label = LABEL[k] || k;
    if (k === 'KBD') label = icon('keyboard', 18);
    if (k === 'MORE') label = this.layer === 'fn' ? 'abc' : 'Fn';
    if (k === 'PASTE') label = icon('paste', 17);
    if (k === 'SNIP') label = icon('snippet', 17);
    const cls = this.mods[k] === 2 ? '.lock' : this.mods[k] === 1 ? '.latched' : '';
    const b = h('button.xk' + cls, { type: 'button' }, label);
    let rep = null;
    const stopRep = () => { clearTimeout(rep); clearInterval(rep); rep = null; b.classList.remove('pressed'); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // odak terminalde kalsın (klavye kapanmasın)
      b.classList.add('pressed');
      try { navigator.vibrate?.(8); } catch { /* yok */ }
      this.pressKey(k);
      if (REPEAT.has(k)) rep = setTimeout(() => { rep = setInterval(() => this.pressKey(k), 60); }, 380);
    });
    b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    b.addEventListener('pointerup', stopRep);
    b.addEventListener('pointercancel', stopRep);
    b.addEventListener('pointerleave', stopRep);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  }

  pressKey(k) {
    const ctrl = !!this.mods.CTRL; const alt = !!this.mods.ALT;
    switch (k) {
      case 'CTRL': case 'ALT': {
        const now = Date.now();
        const st = this.mods[k];
        if (st === 1 && now - (this.modTap?.[k] || 0) < 350) this.mods[k] = 2;
        else this.mods[k] = st ? 0 : 1;
        this.modTap = { ...this.modTap, [k]: now };
        this.renderKeys();
        return;
      }
      case 'KBD':
        if (document.activeElement === this.ta && window.innerHeight < (this.maxH || 0) * 0.85) { N.call('hideKeyboard'); }
        else this.focus();
        return;
      case 'MORE': this.layer = this.layer === 'fn' ? 'main' : 'fn'; this.renderKeys(); return;
      case 'PASTE': this.pasteClipboard(); return;
      case 'SNIP': this.opts.onSnippets?.(); return;
      case 'ESC': this.releaseMods(); this.opts.onData(alt ? '\x1b\x1b' : '\x1b'); return;
      case 'TAB': this.releaseMods(); this.opts.onData(alt ? '\x1b\t' : '\t'); return;
      default: break;
    }
    const seq = this.keySeq(k, { ctrl, alt });
    if (seq) { this.releaseMods(); this.term.scrollToBottom(); this.opts.onData(seq); return; }
    this.sendTyped(k); // '/', '|', '-', '~'
  }

  // ------------------------------------------------------------ dokunma
  cellHeight() {
    const r = this.term.element?.querySelector('.xterm-rows');
    if (r && r.firstElementChild) return r.firstElementChild.getBoundingClientRect().height || 16;
    return (this.term.options.fontSize || 13) * 1.25;
  }

  bindTouch() {
    const w = this.wrap;
    this.maxH = window.innerHeight;
    window.addEventListener('resize', () => { this.maxH = Math.max(this.maxH || 0, window.innerHeight); });
    let st = null; // { x0, y0, t0, lastY, lastT, moved, mode, d0, f0, acc, vel, lp, long }
    const passthrough = (e) => e.target.closest('.term-overlay .card, .jump-bottom');
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    w.addEventListener('touchstart', (e) => {
      if (passthrough(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this.stopInertia();
      if (e.touches.length >= 2) {
        if (st) clearTimeout(st.lp);
        st = { mode: 'pinch', d0: dist(e.touches), f0: this.term.options.fontSize };
        return;
      }
      const t = e.touches[0];
      st = { x0: t.clientX, y0: t.clientY, t0: Date.now(), lastY: t.clientY, lastT: Date.now(), moved: false, acc: 0, vel: 0, mode: 'one' };
      st.lp = setTimeout(() => {
        if (!st || st.moved || st.mode !== 'one') return;
        st.long = true;
        try { navigator.vibrate?.(15); } catch { /* yok */ }
        this.opts.onLongPress?.({ x: st.x0, y: st.y0, url: this.urlAt(st.x0, st.y0) });
      }, 480);
    }, { capture: true, passive: false });

    w.addEventListener('touchmove', (e) => {
      if (!st || passthrough(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (st.mode === 'pinch') {
        if (e.touches.length < 2) return;
        const n = this.setFontSize(st.f0 * dist(e.touches) / st.d0);
        this.zoomInd.textContent = `Yazı boyutu: ${n}`;
        this.zoomInd.classList.remove('hidden');
        return;
      }
      const t = e.touches[0];
      if (!st.moved && Math.hypot(t.clientX - st.x0, t.clientY - st.y0) > 10) { st.moved = true; clearTimeout(st.lp); }
      if (!st.moved) return;
      const now = Date.now();
      const dy = t.clientY - st.lastY;
      const dt = Math.max(1, now - st.lastT);
      st.vel = 0.8 * (dy / dt) + 0.2 * st.vel;
      st.lastY = t.clientY; st.lastT = now;
      this.scrollPixels(dy, st);
    }, { capture: true, passive: false });

    const end = (e) => {
      if (!st || passthrough(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (st.mode === 'pinch') {
        if (e.touches.length === 0) {
          this.zoomInd.classList.add('hidden');
          this.opts.onFontSize?.(this.term.options.fontSize);
          st = null;
        }
        return;
      }
      clearTimeout(st.lp);
      if (e.type === 'touchend' && !st.moved && !st.long) this.tap(st.x0, st.y0);
      else if (st.moved && Math.abs(st.vel) > 0.25) this.inertia(st.vel);
      st = null;
    };
    w.addEventListener('touchend', end, { capture: true, passive: false });
    w.addEventListener('touchcancel', end, { capture: true, passive: false });

    // fare (tarayıcıda deneme): tıklayınca odaklan, tekerlek xterm'e kalsın
    w.addEventListener('mousedown', (e) => {
      if (passthrough(e)) return;
      if (e.button === 0 && !this.mouseMode()) { e.preventDefault(); this.focus(); }
    }, true);
  }

  mouseMode() { return this.term.modes.mouseTrackingMode && this.term.modes.mouseTrackingMode !== 'none'; }

  /** Parmak dy piksel kaydı: normal ekranda geçmişte gezin; tam ekran uygulamalarda tekerlek/ok tuşu gönder. */
  scrollPixels(dy, st) {
    const ch = this.cellHeight();
    st.acc += dy;
    const lines = Math.trunc(st.acc / ch);
    if (!lines) return;
    st.acc -= lines * ch;
    const buf = this.term.buffer.active;
    if (this.mouseMode()) {
      const screen = this.term.element.querySelector('.xterm-screen');
      const r = screen.getBoundingClientRect();
      for (let i = 0; i < Math.abs(lines); i++) {
        screen.dispatchEvent(new WheelEvent('wheel', { deltaY: lines > 0 ? -ch : ch, deltaMode: 0, clientX: r.left + 10, clientY: r.top + 10, bubbles: true, cancelable: true }));
      }
    } else if (buf.type === 'alternate') {
      const seq = this.keySeq(lines > 0 ? 'UP' : 'DOWN');
      this.opts.onData(seq.repeat(Math.abs(lines)));
    } else {
      this.term.scrollLines(-lines);
      this.flashScroll();
    }
  }

  inertia(vel) {
    const st = { acc: 0 };
    let v = vel * 16; // px / kare
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - last) / 16;
      last = now;
      v *= Math.pow(0.94, dt);
      if (Math.abs(v) < 0.6) { this.inertiaRaf = null; return; }
      this.scrollPixels(v * dt, st);
      this.inertiaRaf = requestAnimationFrame(step);
    };
    this.inertiaRaf = requestAnimationFrame(step);
  }

  stopInertia() { if (this.inertiaRaf) cancelAnimationFrame(this.inertiaRaf); this.inertiaRaf = null; }

  flashScroll() {
    this.scrollInd.classList.add('show');
    clearTimeout(this.flashT);
    this.flashT = setTimeout(() => this.scrollInd.classList.remove('show'), 700);
  }

  updateScrollUi() {
    const buf = this.term.buffer.active;
    const total = buf.length;
    const rows = this.term.rows;
    const atBottom = buf.viewportY >= buf.baseY;
    this.jumpBtn.classList.toggle('hidden', atBottom || buf.type === 'alternate');
    if (total <= rows) { this.scrollInd.style.height = '0'; return; }
    const H = this.wrap.clientHeight;
    const hgt = Math.max(24, H * rows / total);
    this.scrollInd.style.height = hgt + 'px';
    this.scrollInd.style.top = ((H - hgt) * (buf.viewportY / Math.max(1, buf.baseY))) + 'px';
  }

  tap(x, y) {
    if (this.mouseMode()) {
      // htop / mc gibi uygulamalar: dokunmayı fare tıklamasına çevir (xterm kodlar)
      const screen = this.term.element.querySelector('.xterm-screen');
      const o = { clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true, cancelable: true, view: window };
      screen.dispatchEvent(new MouseEvent('mousedown', o));
      screen.ownerDocument.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
    }
    this.focus();
  }

  /** Dokunulan satırdaki bağlantı (varsa). */
  urlAt(x, y) {
    try {
      const screen = this.term.element.querySelector('.xterm-screen');
      const r = screen.getBoundingClientRect();
      const row = Math.floor((y - r.top) / (r.height / this.term.rows));
      const col = Math.floor((x - r.left) / (r.width / this.term.cols));
      const buf = this.term.buffer.active;
      const line = buf.getLine(buf.viewportY + row)?.translateToString(true) || '';
      const re = /(https?:\/\/[^\s"'<>`]+)/g;
      let m;
      while ((m = re.exec(line))) if (col >= m.index - 2 && col <= m.index + m[0].length + 2) return m[1].replace(/[).,;:]+$/, '');
    } catch { /* yok */ }
    return null;
  }

  /** Seçip kopyalamak için arabellek metni (son n satır). */
  bufferText(n = 3000) {
    const buf = this.term.buffer.active;
    const out = [];
    const start = Math.max(0, buf.length - n);
    for (let i = start; i < buf.length; i++) {
      const l = buf.getLine(i);
      if (!l) continue;
      const s = l.translateToString(true);
      if (l.isWrapped && out.length) out[out.length - 1] += s; else out.push(s);
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join('\n');
  }
}
