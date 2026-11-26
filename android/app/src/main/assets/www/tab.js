// SessionTab: tek bir SSH bağlantısı — terminal + dosyalar + tüneller. Yeniden bağlanınca yeni connId üretilir;
// eski connId'den gelen olaylar yok sayılır.
import { h, icon, uid, formatSize } from './util.js';
import * as N from './native.js';
import { toast, actionSheet, sheet, confirm } from './dialogs.js';
import { TermView } from './term.js';
import { FilesView } from './files.js';
import { editForward } from './screens.js';
import { t } from './i18n.js';

const b64ToBytes = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const FW_DESC = { L: 'Yerel (-L)', R: 'Uzak (-R)', D: 'SOCKS5 (-D)' };

export class SessionTab {
  constructor(app, session) {
    this.app = app;
    this.id = uid('tab');
    this.session = session;
    this.connId = null;
    this.state = 'idle'; // idle | connecting | connected | closed | error
    this.message = '';
    this.view = 'term';
    this.fw = new Map(); // fw.id -> { state, port, message }
    this.retry = 0;
    this.everConnected = false;

    this.term = new TermView({
      settings: app.settings,
      onData: (d) => { if (this.state === 'connected') N.write(this.connId, 'main', d); },
      onResize: (cols, rows) => { if (this.state === 'connected') N.resize(this.connId, 'main', cols, rows); },
      onLongPress: (p) => this.termMenu(p),
      onSnippets: () => this.app.pickSnippet(this),
      onFontSize: (n) => this.app.saveSettings({ fontSize: n }, { quiet: true }),
    });
    this.files = null;
    this.tunnelsEl = h('div.pane.hidden');
    this.el = h('div.pane', null, this.term.el, this.tunnelsEl);
  }

  get name() { return this.session.name || this.session.host; }
  get subtitle() {
    if (this.state === 'connected') return `${this.session.username ? this.session.username + '@' : ''}${this.session.host}${this.session.port && this.session.port !== 22 ? ':' + this.session.port : ''}`;
    if (this.state === 'connecting') return this.message || 'Bağlanılıyor…';
    if (this.state === 'error') return 'Hata';
    if (this.state === 'closed') return 'Bağlantı kapalı';
    return '';
  }
  get dotClass() { return { connected: 'ok', connecting: 'busy', error: 'err', closed: 'err' }[this.state] || ''; }

  mounted() { return this.term.open(); }

  // ---------------------------------------------------------------- görünüm (terminal / dosyalar / tüneller)
  show(view) {
    this.view = view;
    this.term.el.classList.toggle('hidden', view !== 'term');
    this.tunnelsEl.classList.toggle('hidden', view !== 'tunnels');
    if (view === 'files') {
      if (!this.files) {
        this.files = new FilesView(this);
        this.el.append(this.files.el);
      }
      this.files.el.classList.remove('hidden');
      if (this.state === 'connected') this.files.show();
    } else if (this.files) this.files.el.classList.add('hidden');
    if (view === 'tunnels') this.renderTunnels();
    if (view === 'term') this.term.scheduleFit();
    else this.term.blur();
    this.app.updateSessionBar();
  }

  get settings() { return this.app.settings; }
  saveSettings(p) { return this.app.saveSettings(p); }
  typeInTerminal(s) { if (this.state === 'connected') N.write(this.connId, 'main', s); }

  // ---------------------------------------------------------------- bağlantı
  setState(state, message = '') {
    this.state = state;
    this.message = message;
    this.app.updateSessionBar();
    this.app.renderHome();
    this.app.updateKeepAwake();
  }

  async connect(overrides) {
    clearTimeout(this.retryT);
    const c = uid('c');
    this.connId = c;
    this.setState('connecting', 'Bağlanılıyor…');
    this.term.setOverlay(h('div.card', null, h('div.spinner'), h('p', null, `${this.session.host} bağlanılıyor…`),
      h('div.btns', null, h('button.btn.sm', { onclick: () => this.cancelConnect() }, 'Vazgeç'))));
    try {
      await N.call('connect', { c, sessionId: this.session.id, overrides });
      if (this.connId !== c) { N.call('disconnect', { c }).catch(() => {}); return; }
      if (this.everConnected) this.term.write(`\r\n\x1b[2m── ${t('yeniden bağlandı')} ──\x1b[0m\r\n`);
      await N.call('openShell', { c, s: 'main', cols: this.term.cols, rows: this.term.rows });
      if (this.connId !== c) return;
      this.everConnected = true;
      this.retry = 0;
      this.term.setOverlay(null);
      this.setState('connected');
      this.app.firstConnect();
      if (this.session.startupCommand) setTimeout(() => this.typeInTerminal(this.session.startupCommand + '\r'), 350);
      for (const fw of this.session.forwards || []) if (fw.enabled !== false) this.startFw(fw, true);
      if (this.view === 'files' && this.files) this.files.show();
      if (this.view === 'term' && this.app.activeTab === this) this.term.focus();
    } catch (e) {
      if (this.connId !== c) return;
      this.connId = null;
      const cancelled = /İptal/.test(e.message);
      this.setState('error', e.message);
      this.showClosed(cancelled ? 'Bağlantı iptal edildi' : e.message, !cancelled);
    }
  }

  cancelConnect() {
    const c = this.connId;
    this.connId = null;
    if (c) N.call('disconnect', { c }).catch(() => {});
    this.setState('closed');
    this.showClosed('Bağlantı iptal edildi', false);
  }

  showClosed(msg, isErr) {
    this.term.setOverlay(h('div.card', null,
      isErr ? h('div', { style: { color: 'var(--err)', marginBottom: '8px' } }, icon('info', 28)) : null,
      h('p', null, msg),
      h('div.btns', null,
        h('button.btn.sm', { onclick: () => this.app.closeTab(this) }, 'Sekmeyi kapat'),
        h('button.btn.sm.primary', { onclick: () => this.connect() }, icon('refresh', 15), 'Yeniden bağlan'))));
  }

  disconnect() {
    const c = this.connId;
    this.connId = null;
    clearTimeout(this.retryT);
    if (c) N.call('disconnect', { c }).catch(() => {});
    this.fw.clear();
    this.setState('closed');
  }

  // ---------------------------------------------------------------- native olayları
  onData(ev) { if (ev.c === this.connId) this.term.write(b64ToBytes(ev.d)); }

  onStatus(ev) {
    if (ev.c !== this.connId) return;
    this.message = ev.message;
    const p = this.term.overlay.querySelector('p');
    if (p && this.state === 'connecting') p.textContent = ev.message;
    this.app.updateSessionBar();
  }

  onBanner(ev) {
    if (ev.c === this.connId) this.term.write('\x1b[2m' + t(ev.message).replace(/\r?\n/g, '\r\n') + '\x1b[0m\r\n');
  }

  onExit(ev) {
    if (ev.c !== this.connId) return;
    const c = this.connId;
    this.connId = null;
    N.call('disconnect', { c }).catch(() => {});
    this.fw.clear();
    this.setState('closed');
    this.showClosed('Oturum sona erdi', false);
  }

  onClosed(ev) {
    if (ev.c !== this.connId) return;
    this.connId = null;
    this.fw.clear();
    this.files?.connLost();
    if (ev.reason === 'user') { this.setState('closed'); this.showClosed('Bağlantı kapatıldı', false); return; }
    this.setState('error', ev.message || 'Bağlantı koptu');
    if (this.settings.autoReconnect !== false && this.retry < 6) this.scheduleReconnect();
    else this.showClosed('Bağlantı koptu', true);
  }

  scheduleReconnect() {
    this.retry++;
    const wait = Math.min(30, 2 ** this.retry);
    this.term.setOverlay(h('div.card', null, h('div.spinner'),
      h('p', null, `Bağlantı koptu. ${wait} sn içinde yeniden bağlanılacak (deneme ${this.retry}/6)…`),
      h('div.btns', null,
        h('button.btn.sm', { onclick: () => { clearTimeout(this.retryT); this.retry = 99; this.showClosed('Bağlantı koptu', true); } }, 'Vazgeç'),
        h('button.btn.sm.primary', { onclick: () => this.connect() }, 'Şimdi bağlan'))));
    clearTimeout(this.retryT);
    this.retryT = setTimeout(() => {
      // uygulama arka plandaysa öne gelince dene (__nresume)
      if (this.app.pausedAt) { this.pendingReconnect = true; return; }
      this.connect();
    }, wait * 1000);
  }

  resumed() {
    if (this.pendingReconnect && this.state === 'error') { this.pendingReconnect = false; this.connect(); }
  }

  // ---------------------------------------------------------------- terminal menüsü
  async termMenu(p) {
    const items = [
      { icon: 'select', label: 'Metin seç / kopyala', value: 'copy' },
      { icon: 'paste', label: 'Yapıştır', value: 'paste' },
      p.url ? { icon: 'open', label: 'Bağlantıyı aç', value: 'url', hint: p.url.replace(/^https?:\/\//, '').slice(0, 28) } : null,
      { icon: 'snippet', label: 'Hazır komutlar', value: 'snip' },
      { icon: 'keyboard', label: 'Klavyeyi göster', value: 'kbd' },
    ];
    const v = await actionSheet(null, items);
    if (v === 'copy') this.copyView();
    else if (v === 'paste') this.term.pasteClipboard();
    else if (v === 'url') N.call('openUrl', { url: p.url });
    else if (v === 'snip') this.app.pickSnippet(this);
    else if (v === 'kbd') this.term.focus();
  }

  copyView() {
    const text = this.term.bufferText();
    const pre = h('pre.copy-view', null, text);
    sheet({
      title: 'Metin seç',
      sub: 'Basılı tutup seçin, ardından Kopyala\'ya dokunun',
      cls: 'tall',
      body: pre,
      buttons: [{ label: 'Kapat', value: null }, { label: 'Tümünü kopyala', value: 'all', primary: true }],
      onOpen: () => requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; }),
    }).then(async (v) => {
      if (v === 'all') { await N.call('clipboardSet', { text }); toast('Kopyalandı'); }
    });
  }

  // ---------------------------------------------------------------- tüneller
  async startFw(fw, auto) {
    this.fw.set(fw.id, { state: 'starting' });
    this.renderTunnels();
    try {
      const r = await N.call('fwdStart', { c: this.connId, fw });
      this.fw.set(fw.id, { state: 'on', port: r.port });
    } catch (e) {
      this.fw.set(fw.id, { state: 'error', message: e.message });
      if (!auto || this.view === 'tunnels') toast(e.message, { type: 'err' }); else toast(`Tünel başlatılamadı: ${e.message}`, { type: 'err' });
    }
    this.renderTunnels();
  }

  async stopFw(fw) {
    await N.call('fwdStop', { c: this.connId, id: fw.id }).catch(() => {});
    this.fw.delete(fw.id);
    this.renderTunnels();
  }

  onFwd(ev) {
    if (ev.c !== this.connId) return;
    if (ev.state === 'off') this.fw.delete(ev.id);
    this.renderTunnels();
  }

  async saveForwards(list) {
    this.session = { ...this.session, forwards: list };
    await N.call('saveSession', { session: { id: this.session.id, forwards: list } });
    await this.app.reload();
  }

  renderTunnels() {
    if (this.view !== 'tunnels') return;
    const list = this.session.forwards || [];
    const rows = list.map((fw) => {
      const st = this.fw.get(fw.id);
      const on = st && (st.state === 'on' || st.state === 'starting');
      const desc = fw.type === 'D' ? `${fw.bindHost || '127.0.0.1'}:${st?.port || fw.bindPort} (SOCKS5)`
        : `${fw.bindHost || '127.0.0.1'}:${st?.port || fw.bindPort} → ${fw.dstHost}:${fw.dstPort}`;
      const sw = h('input', { type: 'checkbox', checked: !!on, disabled: this.state !== 'connected' });
      sw.onchange = () => (sw.checked ? this.startFw(fw) : this.stopFw(fw));
      return h('div.fw-row', null,
        h('div.fw-type', null, fw.type),
        h('div.txt', { onclick: () => this.editFw(fw) },
          h('b', null, desc),
          st?.state === 'error' ? h('small.err', null, st.message)
            : h('small', null, `${FW_DESC[fw.type]}${fw.type === 'R' ? ' · sunucuda dinler' : ' · telefonda dinler'}${on ? ' · açık' : ''}${fw.enabled !== false ? ' · otomatik' : ''}`)),
        h('label.switch', null, sw, h('i')));
    });
    this.tunnelsEl.replaceChildren(
      h('div.scroll', null,
        rows.length ? h('div.set-card', { style: { marginTop: '12px' } }, rows)
          : h('div.empty', null, h('div.big', null, icon('tunnel', 30)), h('h3', null, 'Tünel yok'),
            h('p', null, 'Port yönlendirme ekleyin: yerel (-L) telefonda port açar, uzak (-R) sunucuda port açar, SOCKS5 (-D) telefonda proxy açar.')),
        h('p.hint', { style: { padding: '0 16px' } }, 'Telefonda açılan portlara aynı telefondaki uygulamalardan (tarayıcı vb.) 127.0.0.1 ile erişilir.')),
      h('button.fab', { type: 'button', onclick: () => this.editFw(null) }, icon('plus', 26)));
  }

  async editFw(fw) {
    const r = await editForward(fw);
    if (!r) return;
    let list = [...(this.session.forwards || [])];
    if (r.delete) {
      if (this.fw.has(fw.id)) await this.stopFw(fw);
      list = list.filter((x) => x.id !== fw.id);
    } else {
      const i = list.findIndex((x) => x.id === r.fw.id);
      if (i >= 0) {
        if (this.fw.has(r.fw.id)) await this.stopFw(list[i]);
        list[i] = r.fw;
      } else list.push(r.fw);
    }
    await this.saveForwards(list);
    this.renderTunnels();
  }

  // ---------------------------------------------------------------- sunucu durumu
  async statsSheet() {
    if (this.state !== 'connected') return;
    const body = h('div.stats', null, h('div.spinner'));
    let prev = null; let timer = null; let open = true;
    const tick = async () => {
      try {
        const r = await N.call('stats', { c: this.connId });
        const s = parseStats(r.stdout, prev);
        if (!s) { body.replaceChildren(h('p.muted', null, 'Sunucu kaynakları okunamadı (Linux değil?)')); return; }
        prev = s.raw;
        const bar = (v) => h('div.bar', null, h('i', { style: { width: Math.min(100, Math.max(0, v || 0)) + '%', background: v > 85 ? 'var(--err)' : v > 65 ? 'var(--busy)' : 'var(--accent)' } }));
        const pct = (a, b) => (b ? (100 * a) / b : 0);
        body.replaceChildren(
          h('div.stat', null, h('small', null, `CPU${s.cores ? ' · ' + s.cores + ' çekirdek' : ''}`), h('b', null, s.cpu == null ? '…' : s.cpu.toFixed(0) + '%'), bar(s.cpu)),
          h('div.stat', null, h('small', null, 'Yük ortalaması'), h('b', { style: { fontSize: '15px' } }, s.load || '-')),
          h('div.stat', null, h('small', null, 'Bellek'), h('b', null, `${formatSize(s.memUsed)}`), h('small', null, `/ ${formatSize(s.memTotal)}`), bar(pct(s.memUsed, s.memTotal))),
          h('div.stat', null, h('small', null, 'Disk ( / )'), h('b', null, `${formatSize(s.diskUsed)}`), h('small', null, `/ ${formatSize(s.diskTotal)}`), bar(pct(s.diskUsed, s.diskTotal))),
          h('div.stat', null, h('small', null, 'Ağ ↓ / ↑'), h('b', { style: { fontSize: '15px' } }, s.rxRate == null ? '…' : `${formatSize(s.rxRate)}/s · ${formatSize(s.txRate)}/s`)),
          h('div.stat', null, h('small', null, 'Çalışma süresi'), h('b', { style: { fontSize: '15px' } }, uptime(s.uptime))),
          s.swapTotal ? h('div.stat', null, h('small', null, 'Takas (swap)'), h('b', null, formatSize(s.swapUsed)), h('small', null, `/ ${formatSize(s.swapTotal)}`), bar(pct(s.swapUsed, s.swapTotal))) : null,
          s.sessions ? h('div.stat.wide', null, h('small', null, 'Açık oturumlar'), h('b', null, String(s.sessions.length)),
            h('small.who', null, s.sessions.map((x) => `${x.user} ${x.tty}${x.from ? ' · ' + x.from : ''}`).join('\n'))) : null);
      } catch (e) { body.replaceChildren(h('p.muted', null, e.message)); }
      if (open) timer = setTimeout(tick, 2000);
    };
    tick();
    await sheet({ title: 'Sunucu durumu', sub: this.subtitle, body, buttons: [{ label: 'Kapat', value: null }] });
    open = false;
    clearTimeout(timer);
  }

  async close() {
    this.disconnect();
    this.term.dispose();
    this.el.remove();
    if (this.session.temporary) N.call('deleteSession', { id: this.session.id }).catch(() => {});
  }

  async confirmClose() {
    if (this.state !== 'connected' || this.app.settings.confirmClose === false) return true;
    return confirm({ title: 'Bağlantı kapatılsın mı?', message: this.name, ok: 'Kapat', danger: true });
  }
}

function uptime(s) {
  if (!s) return '-';
  const d = Math.floor(s / 86400); const hh = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d} gün ${hh} sa` : hh ? `${hh} sa ${m} dk` : `${m} dk`;
}

/** Masaüstü ssh-manager.stats() ile aynı ayrıştırma (STATS_SCRIPT çıktısı). */
export function parseStats(stdout, prev) {
  const sec = {}; let cur = null;
  for (const line of stdout.split('\n')) {
    const m = /^@@(\w+)$/.exec(line);
    if (m) { cur = m[1]; sec[cur] = []; } else if (cur && line.trim()) sec[cur].push(line);
  }
  if (!sec.cpu || !sec.cpu.length || !sec.mem) return null;
  const now = Date.now();
  const cpuF = sec.cpu[0].trim().split(/\s+/).slice(1).map(Number);
  const cpuTotal = cpuF.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
  const cpuIdle = (cpuF[3] || 0) + (cpuF[4] || 0);
  const mem = {};
  for (const l of sec.mem) { const mm = /^(\w+):\s+(\d+)/.exec(l); if (mm) mem[mm[1]] = Number(mm[2]) * 1024; }
  let rx = 0; let tx = 0;
  for (const l of sec.net || []) {
    const mm = /^\s*([^:]+):\s*(.*)$/.exec(l);
    if (!mm || mm[1].trim() === 'lo') continue;
    const f = mm[2].trim().split(/\s+/).map(Number);
    rx += f[0] || 0; tx += f[8] || 0;
  }
  const df = ((sec.disk && sec.disk[0]) || '').trim().split(/\s+/);
  const dt = prev ? (now - prev.t) / 1000 : 0;
  return {
    raw: { t: now, cpuTotal, cpuIdle, rx, tx },
    cpu: prev && cpuTotal > prev.cpuTotal ? Math.max(0, Math.min(100, 100 * (1 - (cpuIdle - prev.cpuIdle) / (cpuTotal - prev.cpuTotal)))) : null,
    cores: Number((sec.nproc || [])[0]) || null,
    memTotal: mem.MemTotal || 0,
    memUsed: (mem.MemTotal || 0) - (mem.MemAvailable != null ? mem.MemAvailable : (mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0)),
    swapTotal: mem.SwapTotal || 0,
    swapUsed: (mem.SwapTotal || 0) - (mem.SwapFree || 0),
    diskTotal: Number(df[1]) * 1024 || 0,
    diskUsed: Number(df[2]) * 1024 || 0,
    uptime: Number(((sec.up || [])[0] || '').split(/\s+/)[0]) || 0,
    load: ((sec.load || [])[0] || '').split(/\s+/).slice(0, 3).join(' '),
    rxRate: prev && dt > 0 ? Math.max(0, (rx - prev.rx) / dt) : null,
    txRate: prev && dt > 0 ? Math.max(0, (tx - prev.tx) / dt) : null,
    sessions: parseWho(sec.who),
  };
}

// `who` satırları: "kullanıcı tty tarih saat (nereden)". Kayıt yoksa (utmp tutmayan sunucu) null.
function parseWho(lines) {
  if (!lines || !lines.length) return null;
  return lines.map((l) => {
    const f = l.trim().split(/\s+/);
    const from = /\(([^)]*)\)\s*$/.exec(l);
    return { user: f[0], tty: f[1] || '', from: from ? from[1] : '' };
  });
}
