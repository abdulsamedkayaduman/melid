import { h, icon, uid, keyLabel } from './util.js';

// ---------------------------------------------------------------- modal core
// bind(close): pencereyi dışarıdan kapatmak için (ör. listeden seçim yapılınca)
// canClose: false dönerse dışarı tıklama, Esc ve X pencereyi kapatmaz (ör. indirme sürerken)
export function modal({ title, body, buttons = [{ label: 'Tamam', value: true, primary: true }], width = 440, onButton, cls, bind, canClose }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const dismiss = () => { if (!canClose || canClose() !== false) close(null); };
    const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); if (prevFocus && prevFocus.focus) prevFocus.focus(); resolve(v); };
    const btns = buttons.map((b) => h('button.btn' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''), {
      type: 'button',
      onclick: async () => {
        if (onButton) { const r = await onButton(b.value); if (r === false) return; if (r !== undefined && r !== true) return close(r); }
        close(b.value);
      },
    }, b.label));
    const box = h('div.modal' + (cls ? '.' + cls : ''), { style: { width: typeof width === 'number' ? width + 'px' : width }, role: 'dialog' },
      h('div.modal-head', null, h('span', null, title), h('button.icon-btn', { title: 'Kapat', onclick: dismiss }, icon('x'))),
      h('div.modal-body', null, body),
      buttons.length ? h('div.modal-foot', null, btns) : null);
    const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) dismiss(); } }, box);
    const onKey = (e) => {
      if (!document.body.contains(overlay)) return;
      const all = document.querySelectorAll('.overlay'); // only the topmost modal reacts
      if (all[all.length - 1] !== overlay) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); }
      else if (e.key === 'Enter' && !(e.target && (e.target.tagName === 'TEXTAREA' || e.target.closest('[data-noenter]')))) {
        const i = buttons.findIndex((b) => b.primary);
        if (i >= 0) { e.preventDefault(); e.stopPropagation(); btns[i].click(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    if (bind) bind(close);
    setTimeout(() => { const f = box.querySelector('[autofocus]') || box.querySelector('input:not(:disabled), select, textarea, button.primary'); if (f) { f.focus(); if (f.select) f.select(); } }, 0);
  });
}

// save verilirse (true/false) "Kaydet" kutusu gösterilir ve sonuç { value, save } olur
// username verilirse (parola tekrar sorulurken) düzenlenebilir kullanıcı adı alanı da gösterilir; sonuç { value, username, save? }
export async function promptText({ title, label, value = '', password = false, placeholder = '', ok = 'Tamam', cancel = 'Vazgeç', save, username }) {
  const input = h('input.input', { type: password ? 'password' : 'text', value, placeholder, autofocus: true, spellcheck: false });
  // Kullanıcı adı kilitli gelir (imleç parolada); kalem düğmesiyle düzenlenebilir
  const userInput = username == null ? null : h('input.input.locked', { type: 'text', value: username, spellcheck: false, disabled: true });
  const userEdit = userInput && h('button.icon-btn', { type: 'button', title: 'Kullanıcı adını düzenle', onclick: () => {
    userInput.disabled = false; userEdit.classList.add('on'); userInput.focus(); userInput.select();
  } }, icon('edit', 14));
  const saveChk = save === undefined ? null : h('input', { type: 'checkbox', checked: !!save });
  const r = await modal({
    title,
    body: h('div', null,
      userInput ? h('div.field', null, h('span', null, 'Kullanıcı adı'), h('div.row.user-row', null, userInput, userEdit)) : null,
      h('label.field', null, h('span', null, label), input),
      saveChk ? h('label.check', null, saveChk, password ? 'Parolayı oturuma kaydet' : 'Oturuma kaydet') : null),
    buttons: [{ label: cancel, value: null }, { label: ok, value: 'ok', primary: true }],
    width: 380,
  });
  if (r !== 'ok') return null;
  if (userInput) return { value: input.value, username: userInput.value, ...(saveChk ? { save: saveChk.checked } : {}) };
  return saveChk ? { value: input.value, save: saveChk.checked } : input.value;
}

export function confirmBox({ title, message, detail, ok = 'Tamam', danger = false, extra = [] }) {
  return modal({
    title,
    body: h('div.confirm', null, h('p', null, message), detail ? h('div.detail', null, detail) : null),
    buttons: [{ label: 'Vazgeç', value: null }, ...extra, { label: ok, value: true, primary: true, danger }],
    width: 420,
  });
}

export function hostKeyDialog({ host, port, type, fingerprint, changed, oldFingerprint }) {
  const body = h('div.hostkey', null,
    changed
      ? h('div.alert.err', null, h('b', null, 'UYARI: Sunucu anahtarı değişti!'), h('p', null, 'Bu, sunucunun yeniden kurulduğu anlamına gelebilir ya da biri araya girmeye çalışıyor olabilir (MITM). Emin değilseniz bağlanmayın.'))
      : h('p', null, 'Bu sunucuya ilk kez bağlanıyorsunuz. Parmak izini doğrulayın.'),
    h('dl.kv', null,
      h('dt', null, 'Sunucu'), h('dd', null, `${host}:${port}`),
      h('dt', null, 'Anahtar türü'), h('dd', null, type),
      changed ? [h('dt', null, 'Eski'), h('dd.mono.strike', null, oldFingerprint)] : null,
      h('dt', null, changed ? 'Yeni' : 'Parmak izi'), h('dd.mono', null, fingerprint)));
  return modal({
    title: changed ? 'Sunucu anahtarı değişti' : 'Bilinmeyen sunucu',
    body,
    width: 520,
    buttons: [
      { label: 'İptal', value: 'cancel' },
      { label: 'Yalnızca bu sefer', value: 'once' },
      { label: changed ? 'Yeni anahtarı kaydet' : 'Kabul et ve kaydet', value: 'trust', primary: !changed, danger: changed },
    ],
  }).then((v) => v || 'cancel');
}

/**
 * Xshell içe aktarma: şifreli parolalar için Windows kullanıcı adı + SID ya da Xshell ana parolası.
 * Dönüş: { master, user, sid } çöz | { skip: true } kalanlar parolasız devam | null iptal (X / Esc / İptal: hiçbir şey aktarılmaz)
 */
export async function xshellCredsDialog({ pending, total, solved, last, prev = {}, triedMe }) {
  const f = {
    master: h('input.input', { type: 'password', autocomplete: 'off' }),
    user: h('input.input', { value: prev.user || '', spellcheck: false, placeholder: 'ör. Abdulsamed' }),
    sid: h('input.input.mono', { value: prev.sid || '', spellcheck: false, placeholder: 'S-1-5-21-…' }),
  };
  const err = h('div.upd-err');
  const field = (label, control, hint) => h('label.field', null, h('span', null, label), control, hint ? h('div.hint', null, hint) : null);
  // Sonuç kutusu: başarı yeşil, sonuçsuz deneme turuncu (kısmi başarı hata gibi görünmesin)
  const notice = (kind, title, text) => h('div.notice.' + kind, null, icon(kind === 'ok' ? 'check' : 'info', 18), h('div', null, h('b', null, title), text ? h('div', null, text) : null));
  let status = null;
  if (last && last.solved > 0) {
    status = notice('ok', `${last.solved} parola çözüldü`, `Şu ana kadar ${solved} / ${total} parola alındı. ${pending} oturumun parolası farklı bir anahtarla şifrelenmiş; bunlar için başka bir ana parola ya da Windows kullanıcısı deneyebilir veya devam edebilirsiniz.`);
  } else if (last) {
    status = notice('warn', 'Bu bilgilerle yeni parola çözülemedi', 'Yazımı kontrol edin ya da başka bir ana parola / Windows kullanıcısı deneyin. Kalanları parolasız da aktarabilirsiniz; parola ilk bağlantıda sorulur.');
  } else if (solved > 0) {
    status = notice('ok', `${solved} / ${total} parola bu bilgisayardaki Windows hesabıyla çözüldü`, `${pending} oturumun parolası başka bir bilgisayarda, başka bir kullanıcıyla ya da Xshell ana parolasıyla şifrelenmiş.`);
  }
  const head = solved > 0
    ? 'Kalan parolalar için bilgi girin: Xshell ana parolası ya da parolaları kaydeden Windows kullanıcısının adı ve SID\'i.'
    : `${pending} oturumun parolası şifreli. Xshell parolaları, dışa aktarıldığı Windows kullanıcısına bağlı bir anahtarla ya da Xshell ana parolasıyla şifreler.`;
  const v = await modal({
    title: 'Xshell parolaları', width: 520,
    body: h('div', null,
      status, h('p', null, head),
      field('Xshell ana parolası', f.master, 'Xshell\'de ana parola (Master Password) ayarladıysanız bunu girin.'),
      field('Windows kullanıcı adı', f.user),
      field('Windows SID', f.sid, 'Xshell\'in kurulu olduğu Windows\'ta komut istemine whoami /user yazın: kullanıcı adı ve S-1-5-21 ile başlayan SID görünür.'),
      h('p.hint', null, 'Bu bilgiler yalnız parolaları çözmek için kullanılır, kaydedilmez. Çözülen parolalar Melid\'de şifreli saklanır.'),
      err),
    buttons: [
      { label: 'İptal', value: 'cancel' },
      { label: solved > 0 ? 'Kalanlar parolasız, devam et' : 'Parolasız aktar', value: 'skip' },
      { label: 'Parolaları çöz', value: 'ok', primary: true },
    ],
    onButton: (b) => {
      if (b !== 'ok') return undefined;
      if (!f.master.value && !f.sid.value.trim()) { err.textContent = 'Xshell ana parolası ya da Windows SID gerekli'; return false; }
      return undefined;
    },
  });
  if (v === 'ok') return { master: f.master.value, user: f.user.value.trim(), sid: f.sid.value.trim() };
  if (v === 'skip') return { skip: true };
  return null;
}

export async function kbdDialog({ title, instructions, prompts }) {
  const inputs = prompts.map((p, i) => h('input.input', { type: p.echo ? 'text' : 'password', autofocus: i === 0 }));
  const r = await modal({
    title: title || 'Kimlik doğrulama',
    body: h('div', null, instructions ? h('p.muted', null, instructions) : null,
      prompts.map((p, i) => h('label.field', null, h('span', null, p.prompt.replace(/:\s*$/, '')), inputs[i]))),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'Gönder', value: 'ok', primary: true }],
    width: 400,
  });
  return r === 'ok' ? inputs.map((i) => i.value) : null;
}

// ---------------------------------------------------------------- context menu
let openMenu = null;
export function contextMenu(x, y, items) {
  closeMenu();
  const menu = h('div.ctx', null, items.filter(Boolean).map((it) => it === '-'
    ? h('div.ctx-sep')
    : h('div.ctx-item' + (it.disabled ? '.disabled' : '') + (it.danger ? '.danger' : ''), {
      onmousedown: (e) => e.preventDefault(),
      onclick: () => { if (it.disabled) return; closeMenu(); it.action(); },
    }, it.icon ? icon(it.icon, 14) : h('span.ic-space'), h('span.ctx-label', null, it.label), it.hint ? h('span.ctx-hint', null, keyLabel(it.hint)) : null)));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
  openMenu = menu;
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
  document.removeEventListener('mousedown', outside, true);
}
window.addEventListener('blur', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ---------------------------------------------------------------- toast
export function toast(msg, kind = 'info', ms = 3500) {
  let host = document.querySelector('.toasts');
  if (!host) { host = h('div.toasts'); document.body.append(host); }
  const t = h('div.toast.' + kind, null, msg);
  host.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  return t; // erken kapatmak için: t.remove()
}

// ---------------------------------------------------------------- session editor
const AUTH_LABELS = {
  password: 'Parola',
  key: 'Özel anahtar dosyası',
  agent: 'SSH agent',
  auto: 'Otomatik (agent → ~/.ssh anahtarları → parola)',
};

export function forwardsEditor(list) {
  const rows = h('tbody');
  const addRow = (fw) => {
    fw = { id: uid('fw'), type: 'L', bindHost: '127.0.0.1', bindPort: '', dstHost: '127.0.0.1', dstPort: '', enabled: true, ...fw };
    const type = h('select.input.sm', null, ['L', 'R', 'D'].map((t) => h('option', { value: t, selected: fw.type === t }, { L: 'Yerel  -L', R: 'Uzak  -R', D: 'SOCKS  -D' }[t])));
    const bh = h('input.input.sm', { value: fw.bindHost, placeholder: '127.0.0.1' });
    const bp = h('input.input.sm.port', { value: fw.bindPort, placeholder: 'port', inputmode: 'numeric' });
    const dh = h('input.input.sm', { value: fw.dstHost || '', placeholder: 'hedef host' });
    const dp = h('input.input.sm.port', { value: fw.dstPort || '', placeholder: 'port', inputmode: 'numeric' });
    const en = h('input', { type: 'checkbox', checked: fw.enabled !== false, title: 'Bağlanınca otomatik başlat' });
    const sync = () => { const d = type.value === 'D'; dh.disabled = d; dp.disabled = d; if (d) { dh.value = ''; dp.value = ''; } };
    type.onchange = sync; sync();
    const tr = h('tr', null, h('td', null, type), h('td', null, bh), h('td', null, bp), h('td.arrow', null, '→'), h('td', null, dh), h('td', null, dp), h('td.c', null, en),
      h('td', null, h('button.icon-btn', { title: 'Sil', onclick: () => tr.remove() }, icon('trash', 14))));
    tr._get = () => ({ id: fw.id, type: type.value, bindHost: bh.value.trim() || '127.0.0.1', bindPort: Number(bp.value), dstHost: dh.value.trim(), dstPort: Number(dp.value) || undefined, enabled: en.checked });
    rows.append(tr);
  };
  (list || []).forEach(addRow);
  const el = h('div.fw-editor', null,
    h('table.fw-table', null, h('thead', null, h('tr', null, ['Tür', 'Dinleme adresi', 'Port', '', 'Hedef', 'Port', 'Oto', ''].map((t) => h('th', null, t)))), rows),
    h('button.btn.sm', { type: 'button', onclick: () => addRow({}) }, icon('plus', 14), 'Tünel ekle'),
    h('p.hint', null, 'Yerel: bu bilgisayarda port açar, sunucu üzerinden hedefe iletir. Uzak: sunucuda port açar, buraya iletir. Dinamik: yerel SOCKS5 proxy (tarayıcıda 127.0.0.1:port).'));
  el.getValue = () => {
    const out = [];
    for (const tr of rows.children) {
      const v = tr._get();
      if (!v.bindPort) continue;
      if (v.type !== 'D' && (!v.dstHost || !v.dstPort)) throw new Error('Tünel için hedef host ve port gerekli');
      out.push(v);
    }
    return out;
  };
  return el;
}

export async function sessionEditor({ session, sessions, groups, secrets, api }) {
  const s = { port: 22, authType: 'password', group: '', forwards: [], ...session };
  const isNew = !s.id;
  const f = {};
  const input = (key, attrs = {}) => (f[key] = h('input.input', { value: s[key] ?? '', spellcheck: false, ...attrs }));
  const field = (label, control, extraCls) => h('label.field' + (extraCls ? '.' + extraCls : ''), null, h('span', null, label), control);

  const groupList = h('datalist', { id: 'grp-list' }, groups.map((g) => h('option', { value: g })));
  f.authType = h('select.input', null, Object.entries(AUTH_LABELS).map(([v, l]) => h('option', { value: v, selected: s.authType === v }, l)));
  f.password = h('input.input', { type: 'password', value: s.password || '', placeholder: s.has_password ? '•••••• (kayıtlı — değiştirmek için yazın)' : 'Boş bırakılırsa bağlanırken sorulur' });
  f.clearPassword = h('input', { type: 'checkbox' });
  // Başka cihazdan gelen oturum: anahtar parmak iziyle bulunur (~/.ssh ya da hesaptan eşitlenen anahtar)
  f.keyPath = h('input.input', { value: s.keyPath || '', placeholder: s.keyFp && !s.keyPath ? 'Eşitlenen anahtar (parmak iziyle bulunur)' : '~/.ssh/id_ed25519', spellcheck: false });
  f.passphrase = h('input.input', { type: 'password', placeholder: s.has_passphrase ? '•••••• (kayıtlı)' : 'Gerekirse bağlanırken sorulur' });
  f.jumpHostId = h('select.input', null, h('option', { value: '' }, '— Yok —'),
    sessions.filter((x) => x.id !== s.id).map((x) => h('option', { value: x.id, selected: s.jumpHostId === x.id }, `${x.name}  (${x.username || '?'}@${x.host})`)));
  const fwEd = forwardsEditor(s.forwards);

  const pwBox = h('div', null,
    field('Parola', f.password),
    s.has_password ? h('label.check', null, f.clearPassword, 'Kayıtlı parolayı sil') : null,
    secrets === 'plain' ? h('p.hint.warn', null, 'Sistem anahtarlığı (KWallet / GNOME Keyring / macOS Anahtar Zinciri) bulunamadı; parolalar yalnızca base64 ile saklanır.') : null);
  const keyBox = h('div', null,
    field('Anahtar dosyası', h('div.row', null, f.keyPath, h('button.btn', { type: 'button', onclick: async () => { const p = await api.openFileDialog({ defaultPath: '~/.ssh' }); if (p) f.keyPath.value = p; } }, 'Gözat…'))),
    field('Anahtar parolası', f.passphrase));
  const syncAuth = () => {
    pwBox.style.display = ['password', 'auto'].includes(f.authType.value) ? '' : 'none';
    keyBox.style.display = f.authType.value === 'key' ? '' : 'none';
  };
  f.authType.onchange = syncAuth; syncAuth();

  const tabs = ['Genel', 'Tüneller', 'Gelişmiş'];
  const pages = [
    h('div.page', null,
      h('div.grid2', null,
        field('Oturum adı', input('name', { placeholder: 'örn. prod-db-1', autofocus: true })),
        field('Grup', input('group', { list: 'grp-list', placeholder: 'örn. Prod/DB' }))),
      groupList,
      h('div.grid-host', null,
        field('Sunucu (host)', input('host', { placeholder: '10.0.0.5 veya sunucu.alanadi.com' })),
        field('Port', input('port', { inputmode: 'numeric' }))),
      field('Kullanıcı adı', input('username', { placeholder: 'root' })),
      field('Kimlik doğrulama', f.authType),
      pwBox, keyBox,
      field('Jump host (bastion)', f.jumpHostId)),
    h('div.page', null, fwEd),
    h('div.page', null,
      field('Başlangıç komutu', input('startupCommand', { placeholder: 'örn. sudo -i  veya  cd /srv/app' })),
      h('div.grid2', null,
        field('Uzak başlangıç dizini (SFTP)', input('remoteDir', { placeholder: 'boşsa ev dizini' })),
        field('Yerel başlangıç dizini', input('localDir', { placeholder: 'boşsa ev dizini' }))),
      field('Keepalive (saniye)', input('keepalive', { placeholder: '30', inputmode: 'numeric' })),
      field('Notlar', f.notes = h('textarea.input', { rows: 3 }, s.notes || ''))),
  ];
  const tabBtns = tabs.map((t, i) => h('button.seg' + (i === 0 ? '.on' : ''), {
    type: 'button',
    onclick: () => { tabBtns.forEach((b, j) => b.classList.toggle('on', i === j)); pages.forEach((p, j) => { p.style.display = i === j ? '' : 'none'; }); },
  }, t));
  pages.forEach((p, j) => { p.style.display = j === 0 ? '' : 'none'; });
  const err = h('div.form-err');

  let result = null;
  const r = await modal({
    title: isNew ? 'Yeni oturum' : `Oturumu düzenle — ${s.name}`,
    width: 640,
    cls: 'session-editor',
    body: h('div', null, h('div.segs', null, tabBtns), pages, err),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'Kaydet', value: 'save' }, { label: 'Kaydet ve bağlan', value: 'connect', primary: true }],
    onButton: (v) => {
      if (!v) return true;
      try {
        const host = f.host.value.trim();
        if (!host) throw new Error('Sunucu adresi gerekli');
        const port = Number(f.port.value) || 22;
        if (port < 1 || port > 65535) throw new Error('Port 1-65535 arasında olmalı');
        result = {
          id: s.id,
          name: f.name.value.trim() || `${f.username.value.trim() ? f.username.value.trim() + '@' : ''}${host}`,
          group: f.group.value.trim().replace(/^\/+|\/+$/g, ''),
          host, port,
          username: f.username.value.trim(),
          authType: f.authType.value,
          keyPath: f.keyPath.value.trim() || undefined,
          jumpHostId: f.jumpHostId.value || undefined,
          startupCommand: f.startupCommand.value,
          remoteDir: f.remoteDir.value.trim(),
          localDir: f.localDir.value.trim(),
          keepalive: Number(f.keepalive.value) || undefined,
          notes: f.notes.value,
          forwards: fwEd.getValue(),
        };
        if (f.password.value) result.password = f.password.value;
        else if (f.clearPassword.checked) result.password = '';
        if (f.passphrase.value) result.passphrase = f.passphrase.value;
        return true;
      } catch (e) { err.textContent = e.message; return false; }
    },
  });
  if (!r || !result) return null;
  return { session: result, connect: r === 'connect' };
}

// ---------------------------------------------------------------- settings
export const THEMES = {
  'deck-dark': { name: 'Melid Koyu', background: '#101217', foreground: '#d7dae0', cursor: '#FB923C', selectionBackground: '#5a3016', black: '#1b1e25', red: '#e5534b', green: '#57c785', yellow: '#e0b44a', blue: '#4f9dff', magenta: '#c678dd', cyan: '#46c1c9', white: '#c9ccd3', brightBlack: '#5c6370', brightRed: '#ff6b63', brightGreen: '#72de9e', brightYellow: '#f5cd6b', brightBlue: '#79b5ff', brightMagenta: '#dd9af0', brightCyan: '#6fdde3', brightWhite: '#ffffff' },
  xshell: { name: 'Klasik (Xshell)', background: '#000000', foreground: '#c0c0c0', cursor: '#c0c0c0', selectionBackground: '#3a3a70', black: '#000000', red: '#cd0000', green: '#00cd00', yellow: '#cdcd00', blue: '#1e90ff', magenta: '#cd00cd', cyan: '#00cdcd', white: '#e5e5e5', brightBlack: '#7f7f7f', brightRed: '#ff0000', brightGreen: '#00ff00', brightYellow: '#ffff00', brightBlue: '#5c5cff', brightMagenta: '#ff00ff', brightCyan: '#00ffff', brightWhite: '#ffffff' },
  dracula: { name: 'Dracula', background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' },
  solarized: { name: 'Solarized Dark', background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: '#274642', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496', brightBlue: '#657b83', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
  light: { name: 'Açık', background: '#fafafa', foreground: '#383a42', cursor: '#526eff', selectionBackground: '#cfe0ff', black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#a0a1a7', brightBlack: '#696c77', brightRed: '#e45649', brightGreen: '#50a14f', brightYellow: '#c18401', brightBlue: '#4078f2', brightMagenta: '#a626a4', brightCyan: '#0184bc', brightWhite: '#ffffff' },
};

// Genel arayüz temaları; renkler styles.css içinde :root[data-ui=...] altında. swatch: [arka plan, panel, vurgu]
export const UI_THEMES = {
  dark: { name: 'Koyu', swatch: ['#0f1115', '#1e222a', '#FB923C'] },
  light: { name: 'Açık', swatch: ['#f4f5f7', '#e3e6eb', '#EA580C'] },
  orange: { name: 'Turuncu', swatch: ['#15110d', '#292018', '#ff8f3f'] },
  red: { name: 'Kırmızı', swatch: ['#140e10', '#2b1d22', '#ff5c70'] },
  pink: { name: 'Pembe', swatch: ['#fdf1f6', '#f5d8e5', '#df5390'] },
  peach: { name: 'Şeftali', swatch: ['#fdf4ee', '#f4ddcd', '#e46f35'] },
  lavender: { name: 'Lavanta', swatch: ['#f5f3fc', '#e1daf4', '#7a58d4'] },
  mint: { name: 'Nane', swatch: ['#f0faf5', '#d5ece1', '#2a9a6d'] },
};

export function applyUiTheme(key) {
  document.documentElement.dataset.ui = UI_THEMES[key] ? key : 'dark';
}

export async function settingsDialog(settings, ctx = {}) {
  const f = {};
  let uiTheme = UI_THEMES[settings.uiTheme] ? settings.uiTheme : 'dark';
  const uiBtns = Object.entries(UI_THEMES).map(([k, t]) => h('button.ui-theme', {
    type: 'button', dataset: { key: k }, class: k === uiTheme ? 'on' : '',
    onclick: () => { uiTheme = k; applyUiTheme(k); for (const b of uiBtns) b.classList.toggle('on', b.dataset.key === k); },
  }, h('span.ui-sw', null, ...t.swatch.map((c) => h('i', { style: { background: c } }))), t.name));
  const chk = (k, label) => h('label.check', null, (f[k] = h('input', { type: 'checkbox', checked: !!settings[k] })), label);
  f.fontFamily = h('input.input', { value: settings.fontFamily, spellcheck: false });
  f.fontSize = h('input.input', { type: 'number', min: 8, max: 32, value: settings.fontSize });
  f.scrollback = h('input.input', { type: 'number', min: 500, max: 200000, step: 500, value: settings.scrollback });
  f.theme = h('select.input', null, Object.entries(THEMES).map(([k, t]) => h('option', { value: k, selected: settings.theme === k }, t.name)));
  const sel = (k, opts) => (f[k] = h('select.input', null, Object.entries(opts).map(([v, l]) => h('option', { value: v, selected: settings[k] === v }, l))));
  sel('rightClick', { menu: 'Menü göster', paste: 'Doğrudan yapıştır (menü: Shift+sağ tık)' });
  sel('tabActivity', { rainbow: 'Büyüyüp renkli parlasın', blink: 'Yanıp sönsün', off: 'Kapalı' });
  sel('fileDblClick', { open: 'Dosyayı aç', transfer: 'Aktar (indir / yükle)' });
  f.maxTransfers = h('input.input', { type: 'number', min: 1, max: 10, value: settings.maxTransfers || 3 });
  f.logDir = h('input.input', { value: settings.logDir || '', placeholder: ctx.logDefaultDir || '', spellcheck: false });
  const logBrowse = h('button.btn.sm', { type: 'button', onclick: async () => { const d = await ctx.api?.openDirDialog({ title: 'Kayıt klasörü', defaultPath: f.logDir.value || ctx.logDefaultDir }); if (d) f.logDir.value = d; } }, icon('folder', 13), 'Seç…');
  const fh = settings.focusHide || {};
  const fhChk = (k, label, def = true) => h('label.check', null, (f['fh_' + k] = h('input', { type: 'checkbox', checked: fh[k] === undefined ? def : !!fh[k] })), label);
  const r = await modal({
    title: 'Ayarlar',
    width: 520,
    body: h('div', null,
      h('div.field', null, h('span', null, 'Arayüz teması'), h('div.ui-themes', null, uiBtns)),
      h('label.field', null, h('span', null, 'Terminal yazı tipi'), f.fontFamily),
      h('div.grid2', null,
        h('label.field', null, h('span', null, 'Yazı boyutu'), f.fontSize),
        h('label.field', null, h('span', null, 'Geri kaydırma (satır)'), f.scrollback)),
      h('label.field', null, h('span', null, 'Terminal renk teması'), f.theme),
      chk('copyOnSelect', 'Seçince kopyala'),
      h('div.grid2', null,
        h('label.field', null, h('span', null, 'Terminalde sağ tık'), f.rightClick),
        h('label.field', null, h('span', null, 'Dosyaya çift tık'), f.fileDblClick)),
      h('label.field', null, h('span', null, 'Arka plan sekmesinde çıktı akınca'), f.tabActivity),
      chk('cursorBlink', 'Yanıp sönen imleç'),
      chk('confirmClose', 'Açık bağlantı varken kapatmadan önce sor'),
      chk('autoReconnect', 'Bağlantı koparsa otomatik yeniden bağlan'),
      chk('showStats', 'Durum çubuğunda sunucu kaynaklarını göster (CPU, RAM, disk, ağ)'),
      chk('toolbarLabels', 'Araç çubuğunda düğme yazılarını göster'),
      chk('showHidden', 'Dosya panelinde gizli dosyaları göster'),
      h('div.field-row', null,
        h('div', null, h('b', null, 'Aynı anda aktarım'), h('div.hint', null, 'Sekme başına en fazla kaç dosya aktarımı birlikte çalışsın; fazlası sıraya girer.')),
        h('div', { style: { width: '80px' } }, f.maxTransfers)),
      h('div.settings-sep'),
      h('div.field-row', null,
        h('div', null, h('b', null, 'Oturum kaydı'), h('div.hint', null, 'Terminal çıktısı her oturum için ayrı bir dosyaya yazılır.'))),
      chk('logEnabled', 'Terminal çıktısını dosyaya kaydet'),
      chk('logStrip', 'Renk ve kontrol kodlarını temizle (düz metin)'),
      h('label.field', null, h('span', null, 'Kayıt klasörü'), h('div.row', null, f.logDir, logBrowse)),
      h('div.settings-sep'),
      h('div.field-row', null,
        h('div', null, h('b', null, 'Hazır komutlar'), h('div.hint', null, keyLabel('Sık kullanılan komutlar; Ctrl+Shift+K ile gönderilir.'))),
        h('button.btn.sm', { type: 'button', onclick: () => ctx.onSnippets && ctx.onSnippets() }, icon('snippet', 14), 'Düzenle…')),
      h('div.field-row', null,
        h('div', null, h('b', null, 'SSH anahtarları'), h('div.hint', null, 'Anahtar oluştur, açık anahtarı kopyala veya sunucuya yükle.')),
        h('button.btn.sm', { type: 'button', onclick: () => ctx.onKeys && ctx.onKeys() }, icon('key', 14), 'Yönet…')),
      h('div.settings-sep'),
      h('div.field-row', null,
        h('div', null, h('b', null, 'Odak modu (Alt+Enter)'), h('div.hint', null, 'Açıkken işaretli parçalar gizlenir; terminal her zaman kalır.'))),
      h('div.grid2', null,
        fhChk('toolbar', 'Üst araç çubuğunu gizle'),
        fhChk('sidebar', 'Oturum listesini gizle'),
        fhChk('tabs', 'Sekme çubuğunu gizle'),
        fhChk('status', 'Durum çubuğunu gizle'),
        fhChk('sftp', 'SFTP panelini gizle', false)),
      h('div.settings-sep'),
      h('div.field-row', null,
        h('div', null, h('b', null, 'Ana parola'), h('div.hint', null, ctx.masterEnabled ? 'Etkin — kayıtlı parolalar ana parolayla şifreli.' : 'Kapalı — kayıtlı parolalar sistem anahtarlığı/base64 ile saklanıyor.')),
        h('button.btn.sm', { type: 'button', onclick: () => ctx.onManageMaster && ctx.onManageMaster() }, icon(ctx.masterEnabled ? 'unlock' : 'lock', 14), ctx.masterEnabled ? 'Değiştir / kaldır…' : 'Belirle…')),
      h('div.field-row', null,
        h('div', null, h('b', null, 'Güncellemeler'), h('div.hint', null, `Kurulu sürüm: v${ctx.version || '?'}. Yeni sürüm çıkınca bildirim gelir; kurmak size kalır.`)),
        h('button.btn.sm', { type: 'button', onclick: () => ctx.onCheckUpdate && ctx.onCheckUpdate() }, icon('upgrade', 14), 'Şimdi denetle')),
      h('label.check', null, (f.autoUpdate = h('input', { type: 'checkbox', checked: settings.autoUpdate !== false })), 'Güncellemeleri kendiliğinden denetle (açılışta ve 6 saatte bir)'),
      h('label.check', null, (f.usageStats = h('input', { type: 'checkbox', checked: settings.usageStats !== false })), 'Anonim kullanım istatistiklerini gönder'),
      h('div.hint', { style: { margin: '-2px 0 8px 23px' } }, 'Kurulum sayısı, sürüm, platform ve (hesap açıksa) bağlantı / aktarım sayıları. Sunucu adresi, kullanıcı adı, parola ya da içerik gönderilmez. Ayrıntı: melid.abdulsamed.net/kosullar'),
      h('div.field-row', null,
        h('div', null, h('b', null, 'Yedekleme'), h('div.hint', null, 'Oturumları ve ayarları JSON olarak dışa/içe aktar.')),
        h('div.btn-row', null,
          h('button.btn.sm', { type: 'button', onclick: () => ctx.onExport && ctx.onExport() }, icon('save', 14), 'Dışa aktar…'),
          h('button.btn.sm', { type: 'button', onclick: () => ctx.onImport && ctx.onImport() }, icon('import', 14), 'İçe aktar…')))),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'Kaydet', value: 'ok', primary: true }],
  });
  if (r !== 'ok') { applyUiTheme(settings.uiTheme); return null; }
  return {
    uiTheme,
    fontFamily: f.fontFamily.value.trim() || settings.fontFamily,
    fontSize: Math.min(32, Math.max(8, Number(f.fontSize.value) || 14)),
    scrollback: Math.max(500, Number(f.scrollback.value) || 10000),
    theme: f.theme.value,
    copyOnSelect: f.copyOnSelect.checked,
    rightClick: f.rightClick.value,
    fileDblClick: f.fileDblClick.value,
    tabActivity: f.tabActivity.value,
    cursorBlink: f.cursorBlink.checked,
    confirmClose: f.confirmClose.checked,
    autoReconnect: f.autoReconnect.checked,
    showStats: f.showStats.checked,
    toolbarLabels: f.toolbarLabels.checked,
    autoUpdate: f.autoUpdate.checked,
    usageStats: f.usageStats.checked,
    maxTransfers: Math.min(10, Math.max(1, Number(f.maxTransfers.value) || 3)),
    logEnabled: f.logEnabled.checked,
    logStrip: f.logStrip.checked,
    logDir: f.logDir.value.trim(),
    showHidden: f.showHidden.checked,
    focusHide: { toolbar: f.fh_toolbar.checked, sidebar: f.fh_sidebar.checked, tabs: f.fh_tabs.checked, status: f.fh_status.checked, sftp: f.fh_sftp.checked },
  };
}
