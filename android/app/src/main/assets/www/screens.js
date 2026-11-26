// Ekranlar ve formlar: oturum düzenleyici, tünel, ayarlar, anahtarlar, bilinen sunucular, hazır komutlar, düzenleyici.
import { h, icon, uid, formatDate } from './util.js';
import * as N from './native.js';
import { sheet, actionSheet, promptText, confirm, toast, THEMES, UI_THEMES } from './dialogs.js';
import { updateSheet } from './update.js';
import { accountSubtitle } from './account.js';
import { lockSheet, lockSubtitle } from './lock.js';

const field = (label, control, hint) => h('label.field', null, h('span', null, label), control, hint ? h('small.hint', { style: { margin: 0 } }, hint) : null);
const sw = (checked) => { const i = h('input', { type: 'checkbox', checked: !!checked }); return { input: i, el: h('label.switch', null, i, h('i')) }; };

// ---------------------------------------------------------------- oturum düzenleyici
export async function sessionEditor(app, session) {
  const s = { port: 22, authType: 'password', group: '', forwards: [], ...session };
  const isNew = !s.id;
  const inp = (key, attrs = {}) => h('input.input', { value: s[key] ?? '', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', ...attrs });
  const f = {
    name: inp('name', { placeholder: 'örn. web-sunucu' }),
    group: inp('group', { placeholder: 'örn. Prod/DB', list: 'grp-list' }),
    host: inp('host', { placeholder: '10.0.0.5 veya sunucu.com', inputmode: 'url' }),
    port: inp('port', { inputmode: 'numeric' }),
    username: inp('username', { placeholder: 'root' }),
    authType: h('select.input', null, [['password', 'Parola'], ['key', 'SSH anahtarı'], ['auto', 'Otomatik (anahtarlar, sonra parola)']]
      .map(([v, l]) => h('option', { value: v, selected: s.authType === v || (v === 'auto' && s.authType === 'agent') }, l))),
    password: h('input.input', { type: 'password', placeholder: s.has_password ? '•••••• (kayıtlı — değiştirmek için yazın)' : 'Boş bırakılırsa bağlanırken sorulur', autocomplete: 'off' }),
    keyId: h('select.input', null,
      h('option', { value: '' }, app.keys.length ? '— Anahtar seçin —' : '— Kayıtlı anahtar yok —'),
      app.keys.map((k) => h('option', { value: k.id, selected: s.keyId === k.id || (!s.keyId && ((s.keyFp && s.keyFp === k.fingerprint) || (s.keyPath && s.keyPath.split('/').pop() === k.name))) }, `${k.name}  (${k.type.replace('ssh-', '')})`))),
    passphrase: h('input.input', { type: 'password', placeholder: s.has_passphrase ? '•••••• (kayıtlı)' : 'Gerekirse bağlanırken sorulur', autocomplete: 'off' }),
    jumpHostId: h('select.input', null, h('option', { value: '' }, '— Yok —'),
      app.sessions.filter((x) => x.id !== s.id && !x.temporary).map((x) => h('option', { value: x.id, selected: s.jumpHostId === x.id }, `${x.name} (${x.username || '?'}@${x.host})`))),
    startupCommand: inp('startupCommand', { placeholder: 'örn. sudo -i  veya  cd /srv/app' }),
    remoteDir: inp('remoteDir', { placeholder: 'boşsa ev dizini' }),
    keepalive: inp('keepalive', { placeholder: '30', inputmode: 'numeric' }),
    notes: h('textarea.input', { rows: 3 }, s.notes || ''),
  };
  const clearPw = h('input', { type: 'checkbox' });
  const groups = [...new Set(app.sessions.map((x) => x.group).filter(Boolean))];
  const pwBox = h('div', null, field('Parola', f.password), s.has_password ? h('label.check', null, clearPw, 'Kayıtlı parolayı sil') : null);
  const keyBox = h('div', null,
    field('SSH anahtarı', f.keyId, s.keyPath && !s.keyId ? `Masaüstündeki dosya: ${s.keyPath} — aynı adlı anahtar içe aktarılınca otomatik eşleşir.` : null),
    field('Anahtar parolası', f.passphrase));
  const sync = () => {
    pwBox.style.display = ['password', 'auto'].includes(f.authType.value) ? '' : 'none';
    keyBox.style.display = f.authType.value === 'key' ? '' : 'none';
  };
  f.authType.onchange = sync; sync();

  const fwList = [...(s.forwards || [])];
  const fwBox = h('div');
  const renderFw = () => {
    fwBox.replaceChildren(
      ...fwList.map((fw) => h('div.fw-row', { style: { padding: '8px 0' }, onclick: async () => {
        const r = await editForward(fw);
        if (!r) return;
        const i = fwList.indexOf(fw);
        if (r.delete) fwList.splice(i, 1); else fwList[i] = r.fw;
        renderFw();
      } }, h('div.fw-type', null, fw.type), h('div.txt', null,
        h('b', null, fw.type === 'D' ? `${fw.bindHost}:${fw.bindPort}` : `${fw.bindHost}:${fw.bindPort} → ${fw.dstHost}:${fw.dstPort}`),
        h('small', null, fw.enabled !== false ? 'Bağlanınca başlar' : 'Elle başlatılır')))),
      h('button.btn.sm', { type: 'button', style: { marginTop: '8px' }, onclick: async () => { const r = await editForward(null); if (r?.fw) { fwList.push(r.fw); renderFw(); } } }, icon('plus', 15), 'Tünel ekle'));
  };
  renderFw();

  const pages = [
    h('div', null,
      field('Sunucu (host)', f.host),
      h('div.grid-host', null, field('Kullanıcı adı', f.username), field('Port', f.port)),
      field('Kimlik doğrulama', f.authType), pwBox, keyBox,
      h('div.grid2', null, field('Oturum adı', f.name), field('Grup', f.group)),
      h('datalist', { id: 'grp-list' }, groups.map((g) => h('option', { value: g })))),
    h('div', null, fwBox),
    h('div', null,
      field('Jump host (bastion)', f.jumpHostId),
      field('Başlangıç komutu', f.startupCommand),
      field('Uzak başlangıç dizini (dosyalar)', f.remoteDir),
      field('Keepalive (saniye)', f.keepalive),
      field('Notlar', f.notes)),
  ];
  const segs = ['Genel', 'Tüneller', 'Gelişmiş'].map((t, i) => h('button.seg' + (i ? '' : '.on'), {
    type: 'button',
    onclick: () => { segs.forEach((b, j) => b.classList.toggle('on', i === j)); pages.forEach((p, j) => { p.style.display = i === j ? '' : 'none'; }); },
  }, t));
  pages.forEach((p, j) => { p.style.display = j ? 'none' : ''; });
  const err = h('div.form-err');
  let result = null;
  const r = await sheet({
    title: isNew ? 'Yeni oturum' : 'Oturumu düzenle',
    body: h('div', null, h('div.segs', null, segs), pages, err),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'Kaydet', value: 'save' }, { label: 'Bağlan', value: 'connect', primary: true }],
    onButton: (v) => {
      if (!v) return true;
      const host = f.host.value.trim();
      const port = Number(f.port.value) || 22;
      if (!host) { err.textContent = 'Sunucu adresi gerekli'; return false; }
      if (/\s/.test(host)) { err.textContent = 'Sunucu adresinde boşluk olamaz'; return false; }
      if (port < 1 || port > 65535) { err.textContent = 'Port 1-65535 arasında olmalı'; return false; }
      if (f.authType.value === 'key' && !f.keyId.value) { err.textContent = 'Bir SSH anahtarı seçin (Ayarlar > SSH anahtarları)'; return false; }
      const user = f.username.value.trim();
      result = {
        id: s.id,
        name: f.name.value.trim() || `${user ? user + '@' : ''}${host}`,
        group: f.group.value.trim().replace(/^\/+|\/+$/g, ''),
        host, port, username: user,
        authType: f.authType.value,
        keyId: f.keyId.value || null,
        jumpHostId: f.jumpHostId.value || null,
        startupCommand: f.startupCommand.value,
        remoteDir: f.remoteDir.value.trim(),
        keepalive: Number(f.keepalive.value) || null,
        notes: f.notes.value,
        forwards: fwList,
        temporary: null,
      };
      if (f.password.value) result.password = f.password.value;
      else if (clearPw.checked) result.password = '';
      if (f.passphrase.value) result.passphrase = f.passphrase.value;
      return true;
    },
  });
  if (!r || !result) return null;
  const id = await N.call('saveSession', { session: result });
  await app.reload();
  return { id, connect: r === 'connect' };
}

// ---------------------------------------------------------------- tünel düzenleyici
export async function editForward(fw) {
  const isNew = !fw;
  const v = { id: uid('fw'), type: 'L', bindHost: '127.0.0.1', bindPort: '', dstHost: '127.0.0.1', dstPort: '', enabled: true, ...fw };
  const type = h('select.input', null, [['L', 'Yerel (-L): telefonda port aç'], ['R', 'Uzak (-R): sunucuda port aç'], ['D', 'SOCKS5 (-D): telefonda proxy']]
    .map(([k, l]) => h('option', { value: k, selected: v.type === k }, l)));
  const bh = h('input.input', { value: v.bindHost, inputmode: 'url', autocapitalize: 'off' });
  const bp = h('input.input', { value: v.bindPort || '', inputmode: 'numeric', placeholder: 'örn. 8080' });
  const dh = h('input.input', { value: v.dstHost || '', inputmode: 'url', autocapitalize: 'off', placeholder: '127.0.0.1' });
  const dp = h('input.input', { value: v.dstPort || '', inputmode: 'numeric', placeholder: 'örn. 80' });
  const auto = h('input', { type: 'checkbox', checked: v.enabled !== false });
  const dst = h('div.grid-host', null, field('Hedef adres', dh), field('Port', dp));
  const sync = () => { dst.style.display = type.value === 'D' ? 'none' : ''; };
  type.onchange = sync; sync();
  const err = h('div.form-err');
  let out = null;
  const r = await sheet({
    title: isNew ? 'Tünel ekle' : 'Tüneli düzenle',
    body: h('div', null, field('Tür', type), h('div.grid-host', null, field('Dinleme adresi', bh), field('Port', bp)), dst,
      h('label.check', null, auto, 'Bağlanınca otomatik başlat'), err),
    buttons: [...(isNew ? [] : [{ label: 'Sil', value: 'delete', danger: true }]), { label: 'Vazgeç', value: null }, { label: 'Kaydet', value: 'save', primary: true }],
    onButton: (b) => {
      if (b !== 'save') return true;
      const port = Number(bp.value);
      if (!(port >= 0 && port <= 65535) || bp.value === '') { err.textContent = 'Geçerli bir dinleme portu girin'; return false; }
      if (type.value !== 'D' && (!dh.value.trim() || !(Number(dp.value) > 0))) { err.textContent = 'Hedef adres ve port gerekli'; return false; }
      out = { id: v.id, type: type.value, bindHost: bh.value.trim() || '127.0.0.1', bindPort: port, dstHost: type.value === 'D' ? '' : dh.value.trim(), dstPort: type.value === 'D' ? undefined : Number(dp.value), enabled: auto.checked };
      return true;
    },
  });
  if (r === 'delete') return { delete: true };
  return r === 'save' ? { fw: out } : null;
}

// ---------------------------------------------------------------- ayarlar
export function settingsView(app) {
  const body = h('div.scroll');
  const row = (ic, title, sub, right, onclick) => h('div.set-row', { onclick }, ic ? icon(ic, 22) : null,
    h('div.txt', null, h('b', null, title), sub ? h('small', null, sub) : null), right || null);
  const toggle = (ic, key, title, sub, def = false, after) => {
    const s = sw(app.settings[key] === undefined ? def : app.settings[key]);
    s.input.onchange = async () => { await app.saveSettings({ [key]: s.input.checked }); after?.(s.input.checked); };
    s.el.onclick = (e) => e.stopPropagation();
    return row(ic, title, sub, s.el, () => { s.input.checked = !s.input.checked; s.input.onchange(); });
  };
  const accSub = h('small');
  const accRow = h('div.set-row', { onclick: () => app.accountSheet() }, icon('cloud', 22),
    h('div.txt', null, h('b', null, 'Hesap ve eşitleme'), accSub), icon('chevron', 18));
  const refreshAccount = () => {
    accSub.textContent = accountSubtitle(app.account);
    accSub.classList.toggle('warn', !!app.account && ['error', 'auth'].includes(app.account.state));
  };
  const lockSub = h('small');
  const lockRow = h('div.set-row', { onclick: () => lockSheet(app) }, icon('lock', 22),
    h('div.txt', null, h('b', null, 'Uygulama kilidi'), lockSub), icon('chevron', 18));
  const refreshLock = () => { lockSub.textContent = lockSubtitle(app.lock); };
  N.call('lockStatus').then((st) => app.setLock(st)).catch(() => {});
  const render = () => {
    const st = app.settings;
    refreshAccount();
    refreshLock();
    const uiKey = UI_THEMES[st.uiTheme] ? st.uiTheme : 'dark';
    const fs = st.fontSize || 13;
    const fsVal = h('b', { style: { minWidth: '28px', textAlign: 'center' } }, String(fs));
    const setFs = (d) => { const n = Math.max(7, Math.min(30, (app.settings.fontSize || 13) + d)); app.saveSettings({ fontSize: n }); fsVal.textContent = n; };
    body.replaceChildren(
      h('div.sec-title', null, 'Hesap'),
      h('div.set-card', null, accRow),
      h('div.sec-title', null, 'Güvenlik'),
      h('div.set-card', null, lockRow),
      h('div.sec-title', null, 'Görünüm'),
      h('div.set-card', null,
        h('div.set-row', { translate: 'no', onclick: async () => {
          const cur = app.settings.language || 'auto';
          const v = await actionSheet('Dil / Language', [['auto', 'Otomatik / Automatic'], ['tr', 'Türkçe'], ['en', 'English']]
            .map(([k, l]) => ({ label: l, value: k, icon: k === cur ? 'check' : null })));
          if (!v || v === cur) return;
          await app.saveSettings({ language: v });
          try { localStorage.setItem('language', v); } catch { /* yok */ }
          location.reload();
        } }, icon('globe', 22), h('div.txt', null, h('b', null, 'Dil / Language'),
          h('small', null, { auto: 'Otomatik / Automatic', tr: 'Türkçe', en: 'English' }[app.settings.language || 'auto'])), icon('chevron', 18)),
        h('div', { style: { padding: '12px 16px 4px', fontWeight: 500 } }, 'Arayüz teması'),
        h('div.ui-themes', null, Object.entries(UI_THEMES).map(([k, t]) => h('button.ui-theme' + (k === uiKey ? '.on' : ''), {
          type: 'button', onclick: async () => { await app.saveSettings({ uiTheme: k }); render(); },
        }, h('span.ui-sw', null, t.swatch.map((c) => h('i', { style: { background: c } }))), t.name))),
        row('palette', 'Terminal renk teması', (THEMES[st.theme] || THEMES['deck-dark']).name, icon('chevron', 18), async () => {
          const v = await actionSheet('Terminal renk teması', Object.entries(THEMES).map(([k, t]) => ({ label: t.name, value: k, icon: k === (st.theme || 'deck-dark') ? 'check' : null })));
          if (v) { await app.saveSettings({ theme: v }); render(); }
        }),
        row('font', 'Yazı boyutu', 'Terminalde iki parmakla da büyütüp küçültebilirsiniz',
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' }, onclick: (e) => e.stopPropagation() },
            h('button.tb', { onclick: () => setFs(-1) }, icon('minus', 18)), fsVal, h('button.tb', { onclick: () => setFs(1) }, icon('plus', 18))))),
      h('div.set-card', { style: { marginTop: '-1px' } },
        toggle('keyboard', 'extraKeys', 'Ek tuş satırı', 'Esc, Ctrl, Alt, Tab, oklar…', true),
        toggle(null, 'privateKeyboard', 'Gizli klavye', 'Öneri ve öğrenme kapalı, tuşlar tek tek gider. Kapalıyken klavye normal açılır (öneriler, kaydırarak yazma)', true),
        toggle(null, 'cursorBlink', 'Yanıp sönen imleç', null, true)),
      h('div.sec-title', null, 'Bağlantı'),
      h('div.set-card', null,
        toggle('refresh', 'autoReconnect', 'Kopunca yeniden bağlan', 'Ağ değişince / bağlantı düşünce otomatik dener', true),
        toggle('eye', 'keepScreenOn', 'Bağlıyken ekranı açık tut', null, false),
        toggle('bolt', 'wakeLock', 'Ekran kapalıyken bağlantıyı canlı tut', 'Kısmi uyanık kalma kilidi + Wi-Fi kilidi (pil tüketimini artırır)', false),
        toggle('save', 'savePrompted', 'Sorulan parolaları kaydet', '"Kaydet" kutusunun varsayılanı', true),
        toggle('x', 'confirmClose', 'Kapatırken onay iste', null, true)),
      h('div.sec-title', null, 'Veriler'),
      h('div.set-card', null,
        row('key', 'SSH anahtarları', `${app.keys.length} anahtar`, icon('chevron', 18), () => app.push(keysView(app))),
        row('snippet', 'Hazır komutlar', `${(st.snippets || []).length} komut`, icon('chevron', 18), () => app.push(snippetsView(app))),
        row('lock', 'Bilinen sunucular', `${Object.keys(app.knownHosts).length} sunucu anahtarı`, icon('chevron', 18), () => app.push(knownHostsView(app))),
        row('import', 'Masaüstü yedeğini içe aktar', 'Melid (Linux) > Ayarlar > Yedekle ile alınan .json', null, () => importBackup(app)),
        row('upload', 'Yedek dışa aktar', 'Masaüstü Melid ile uyumlu; İndirilenler/Melid', null, () => exportBackup(app))),
      h('div.sec-title', null, 'Hakkında'),
      h('div.set-card', null,
        row('info', 'Melid Android', app.info ? `Sürüm ${app.info.version} · Android ${app.info.android}` : '', null, null),
        row('upload', 'Güncellemeleri denetle', app.update?.newer ? `${app.update.version} kurulabilir` : 'Yeni sürüm çıkınca bildirim gelir', icon('chevron', 18), () => updateSheet(app, { check: true })),
        toggle('refresh', 'autoUpdate', 'Arka planda denetle', 'Açılışta ve 12 saatte bir', true),
        toggle('info', 'usageStats', 'Anonim kullanım istatistikleri', 'Kurulum sayısı, sürüm ve bağlantı sayıları; içerik gönderilmez', true)),
      h('div', { style: { height: '40px' } }));
  };
  render();
  return {
    el: h('div.view', null, topbar(app, 'Ayarlar'), body),
    refresh: render,
    refreshAccount,
    refreshLock,
  };
}

function topbar(app, title, ...right) {
  return h('div.topbar', null, h('button.tb', { onclick: () => app.back() }, icon('back', 22)), h('div.title', null, h('b', null, title)), ...right);
}

// ---------------------------------------------------------------- yedek
export async function importBackup(app) {
  let file;
  try { file = await N.call('pickTextFile', { max: 8 << 20 }); } catch (e) { toast(e.message, { type: 'err' }); return; }
  if (!file) return;
  let bk;
  try { bk = JSON.parse(file.text); } catch { toast('Dosya JSON değil', { type: 'err' }); return; }
  if (!bk || !Array.isArray(bk.sessions)) {
    toast('Bu bir Melid yedek dosyası değil', { type: 'err' });
    return;
  }
  const hasSecrets = bk.encrypted && bk.sessions.some((s) => s.secrets);
  const pw = hasSecrets ? h('input.input', { type: 'password', placeholder: 'Yedek parolası', autofocus: true }) : null;
  const withSettings = h('input', { type: 'checkbox', checked: true });
  const err = h('div.form-err');
  let res = null;
  const r = await sheet({
    title: 'Yedeği içe aktar',
    sub: `${file.name} · ${bk.sessions.length} oturum`,
    body: h('div', null,
      hasSecrets ? field('Yedek parolası', pw, 'Parolalar bu parolayla şifrelenmiş. Boş bırakırsanız oturumlar parolasız aktarılır.') : h('p.hint', null, 'Bu yedekte kayıtlı parola yok.'),
      h('label.check', null, withSettings, 'Temalar ve hazır komutlar da aktarılsın'),
      h('p.hint', null, 'Aynı kimlikli oturumlar güncellenir. Anahtar dosyaları yedekte yoktur: anahtarları Ayarlar > SSH anahtarları bölümünden ayrıca içe aktarın (aynı dosya adı otomatik eşleşir).'),
      err),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'İçe aktar', value: 'ok', primary: true }],
    onButton: async (v) => {
      if (!v) return true;
      err.textContent = '';
      try {
        res = await N.call('importBackup', { text: file.text, passphrase: pw?.value || null, withSettings: withSettings.checked });
        return true;
      } catch (e) { err.textContent = e.message; return false; }
    },
  });
  if (!r) return;
  await app.reload();
  toast(`${res.added} oturum eklendi, ${res.updated} güncellendi${res.withPassword ? ` (${res.withPassword} parola)` : ''}`, { type: 'ok' });
}

export async function exportBackup(app) {
  const pw = h('input.input', { type: 'password', placeholder: 'Boş: parolalar yedeğe girmez' });
  const pw2 = h('input.input', { type: 'password', placeholder: 'Parola tekrar' });
  const err = h('div.form-err');
  let path = null;
  const r = await sheet({
    title: 'Yedek dışa aktar',
    body: h('div', null, field('Yedek parolası', pw), field('Tekrar', pw2),
      h('p.hint', null, 'Parola verirseniz kayıtlı parolalar bu parolayla şifrelenerek yedeğe eklenir. Dosya masaüstü Melid ile içe aktarılabilir.'), err),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'Dışa aktar', value: 'ok', primary: true }],
    onButton: async (v) => {
      if (!v) return true;
      if (pw.value !== pw2.value) { err.textContent = 'Parolalar aynı değil'; return false; }
      try { path = await N.call('exportBackup', { passphrase: pw.value || null }); return true; } catch (e) { err.textContent = e.message; return false; }
    },
  });
  if (r) toast(`Kaydedildi: ${path}`, { type: 'ok', ms: 5000 });
}

// ---------------------------------------------------------------- SSH anahtarları
export function keysView(app) {
  const list = h('div.scroll');
  const render = () => {
    if (!app.keys.length) {
      list.replaceChildren(h('div.empty', null, h('div.big', null, icon('key', 30)), h('h3', null, 'Anahtar yok'),
        h('p', null, 'Telefonda yeni bir anahtar oluşturun ya da bilgisayarınızdaki özel anahtarı (ör. ~/.ssh/id_ed25519) içe aktarın.')));
      return;
    }
    list.replaceChildren(h('div.set-card', { style: { marginTop: '12px' } }, app.keys.map((k) => h('div.row', { onclick: () => keyMenu(app, k, render) },
      h('div.av', null, icon('key', 20)),
      h('div.txt', null, h('b', null, k.name), h('small', null, `${k.type.replace('ssh-', '')} · ${k.fingerprint}`)),
      icon('more', 20)))));
  };
  render();
  const add = async () => {
    const v = await actionSheet('Anahtar ekle', [
      { icon: 'plus', label: 'Yeni anahtar oluştur', value: 'gen' },
      { icon: 'import', label: 'Dosyadan içe aktar', value: 'file' },
      { icon: 'paste', label: 'Yapıştırarak içe aktar', value: 'paste' },
    ]);
    if (v === 'gen') await generateKey(app);
    else if (v === 'file' || v === 'paste') await importKey(app, v);
    render();
  };
  return {
    el: h('div.view', null, topbar(app, 'SSH anahtarları'), list, h('button.fab', { onclick: add }, icon('plus', 26))),
    refresh: render,
  };
}

async function generateKey(app) {
  const type = h('select.input', null, [['ed25519', 'Ed25519 (önerilen)'], ['ecdsa', 'ECDSA P-256'], ['rsa', 'RSA 4096']].map(([v, l]) => h('option', { value: v }, l)));
  const name = h('input.input', { value: uniqueName(app, 'id_ed25519'), autocapitalize: 'off' });
  type.onchange = () => { name.value = uniqueName(app, 'id_' + type.value); };
  const comment = h('input.input', { value: 'melid@android', autocapitalize: 'off' });
  const err = h('div.form-err');
  const r = await sheet({
    title: 'Yeni SSH anahtarı',
    body: h('div', null, field('Tür', type), field('Ad', name), field('Açıklama (yorum)', comment), err),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'Oluştur', value: 'ok', primary: true }],
    onButton: async (v) => {
      if (!v) return true;
      try { await N.call('keyGenerate', { type: type.value, name: name.value.trim(), comment: comment.value.trim() }); return true; } catch (e) { err.textContent = e.message; return false; }
    },
  });
  if (r) { await app.reload(); toast('Anahtar oluşturuldu. Açık anahtarı sunucuya yüklemek için anahtara dokunun.', { type: 'ok', ms: 5000 }); }
}

function uniqueName(app, base) {
  let n = base; let i = 2;
  while (app.keys.some((k) => k.name === n)) n = `${base}-${i++}`;
  return n;
}

async function importKey(app, mode) {
  let text = ''; let fname = 'id_ed25519';
  if (mode === 'file') {
    let f;
    try { f = await N.call('pickTextFile', { max: 64 << 10 }); } catch (e) { toast(e.message, { type: 'err' }); return; }
    if (!f) return;
    text = f.text; fname = f.name.replace(/\.(pem|key|txt)$/i, '');
  }
  const ta = h('textarea.input.mono', { rows: 6, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----\n…', spellcheck: false, autocapitalize: 'off' });
  ta.value = text;
  const name = h('input.input', { value: uniqueName(app, fname), autocapitalize: 'off' });
  const pp = h('input.input', { type: 'password', placeholder: 'Anahtar parolalıysa' });
  const err = h('div.form-err');
  const r = await sheet({
    title: 'Özel anahtarı içe aktar',
    body: h('div', null, mode === 'paste' ? field('Özel anahtar', ta) : h('p.hint', null, `${fname} okundu.`),
      field('Ad', name, 'Masaüstünden aktarılan oturumlar anahtar dosya adıyla eşleşir (ör. id_ed25519)'), field('Anahtar parolası', pp), err),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'İçe aktar', value: 'ok', primary: true }],
    onButton: async (v) => {
      if (!v) return true;
      const t = mode === 'paste' ? ta.value : text;
      if (!t.includes('PRIVATE KEY')) { err.textContent = 'Bu bir özel anahtar değil (BEGIN … PRIVATE KEY satırı yok). Açık anahtar (.pub) değil, özel anahtar gerekir.'; return false; }
      try { await N.call('keyImport', { text: t.trim() + '\n', name: name.value.trim(), passphrase: pp.value || null }); return true; } catch (e) { err.textContent = e.message; return false; }
    },
  });
  if (r) { await app.reload(); toast('Anahtar içe aktarıldı', { type: 'ok' }); }
}

async function keyMenu(app, k, render) {
  const v = await actionSheet(k.name, [
    { icon: 'copy', label: 'Açık anahtarı kopyala', value: 'copy' },
    { icon: 'upload', label: 'Sunucuya yükle (ssh-copy-id)', value: 'install' },
    { icon: 'edit', label: 'Yeniden adlandır', value: 'rename' },
    { icon: 'download', label: 'Özel anahtarı dışa aktar', value: 'export' },
    '-',
    { icon: 'trash', label: 'Sil', value: 'delete', danger: true },
  ], k.fingerprint);
  if (v === 'copy') { await N.call('clipboardSet', { text: k.public }); toast('Açık anahtar kopyalandı'); }
  else if (v === 'install') {
    const tabs = app.tabs.filter((t) => t.state === 'connected');
    if (!tabs.length) { toast('Önce anahtarı yüklemek istediğiniz sunucuya (parolayla) bağlanın', { type: 'err', ms: 5000 }); return; }
    const pick = tabs.length === 1 ? tabs[0].id : await actionSheet('Hangi sunucuya?', tabs.map((x) => ({ icon: 'server', label: x.name, value: x.id, hint: x.subtitle })));
    const t = tabs.find((x) => x.id === pick);
    if (!t) return;
    try {
      const r = await N.call('installKey', { c: t.connId, keyId: k.id });
      toast(r === 'exists' ? 'Anahtar zaten yüklü' : `Anahtar ${t.name} sunucusuna eklendi`, { type: 'ok' });
      if (t.session.authType === 'password' && !t.session.temporary && await confirm({ title: 'Oturum bu anahtarı kullansın mı?', message: `${t.name} oturumunun kimlik doğrulaması "${k.name}" anahtarına çevrilsin.`, ok: 'Evet' })) {
        await N.call('saveSession', { session: { id: t.session.id, authType: 'key', keyId: k.id } });
        await app.reload();
      }
    } catch (e) { toast(e.message, { type: 'err' }); }
  } else if (v === 'rename') {
    const n = await promptText({ title: 'Yeniden adlandır', value: k.name, ok: 'Kaydet' });
    if (n && n.trim()) { await N.call('keyRename', { id: k.id, name: n.trim() }); await app.reload(); render(); }
  } else if (v === 'export') {
    if (!await confirm({ title: 'Özel anahtar dışa aktarılsın mı?', message: 'Anahtar şifresiz olarak İndirilenler/Melid klasörüne yazılır. Bu dosyaya erişen herkes sunucularınıza girebilir; işiniz bitince silin.', ok: 'Dışa aktar', danger: true })) return;
    try { toast('Kaydedildi: ' + await N.call('keyExportPrivate', { id: k.id, name: k.name }), { type: 'ok' }); } catch (e) { toast(e.message, { type: 'err' }); }
  } else if (v === 'delete') {
    const users = app.sessions.filter((s) => s.keyId === k.id).map((s) => s.name);
    if (!await confirm({ title: 'Anahtar silinsin mi?', message: `${k.name}${users.length ? `\n\nBu anahtarı kullanan oturumlar: ${users.join(', ')}` : ''}`, ok: 'Sil', danger: true })) return;
    await N.call('keyDelete', { id: k.id }); await app.reload(); render();
  }
}

// ---------------------------------------------------------------- bilinen sunucular
export function knownHostsView(app) {
  const list = h('div.scroll');
  const render = () => {
    const ent = Object.entries(app.knownHosts);
    if (!ent.length) { list.replaceChildren(h('div.empty', null, h('p', null, 'Henüz kayıtlı sunucu anahtarı yok'))); return; }
    list.replaceChildren(h('div.set-card', { style: { marginTop: '12px' } }, ent.sort().map(([hp, e]) => h('div.row', {
      onclick: async () => {
        if (!await confirm({ title: 'Sunucu anahtarı silinsin mi?', message: `${hp}\n${e.fingerprint}\n\nBir sonraki bağlantıda yeniden sorulur.`, ok: 'Sil', danger: true })) return;
        await N.call('removeKnownHost', { key: hp }); await app.reload(); render();
      },
    }, h('div.av', null, icon('lock', 20)), h('div.txt', null, h('b', null, hp.replace(/^\[(.*)\]:22$/, '$1')), h('small.mono', null, `${e.type} ${e.fingerprint}`)), icon('trash', 18)))));
  };
  render();
  return { el: h('div.view', null, topbar(app, 'Bilinen sunucular'), list), refresh: render };
}

// ---------------------------------------------------------------- hazır komutlar
export function snippetsView(app) {
  const list = h('div.scroll');
  const render = () => {
    const sn = app.settings.snippets || [];
    if (!sn.length) {
      list.replaceChildren(h('div.empty', null, h('div.big', null, icon('snippet', 30)), h('h3', null, 'Hazır komut yok'),
        h('p', null, 'Sık kullandığınız komutları ekleyin; terminalde ek tuş satırındaki { } düğmesi veya basılı tutma menüsüyle tek dokunuşla gönderin.')));
      return;
    }
    list.replaceChildren(h('div.set-card', { style: { marginTop: '12px' } }, sn.map((s) => h('div.snip', { onclick: () => editSnippet(app, s).then(render) },
      h('div.txt', null, h('b', { translate: 'no' }, s.name), h('code', null, s.command)), s.run ? h('small.muted', null, '↵') : null))));
  };
  render();
  return { el: h('div.view', null, topbar(app, 'Hazır komutlar'), list, h('button.fab', { onclick: () => editSnippet(app, null).then(render) }, icon('plus', 26))), refresh: render };
}

async function editSnippet(app, s) {
  const name = h('input.input', { value: s?.name || '', placeholder: 'örn. Disk durumu' });
  const cmd = h('textarea.input.mono', { rows: 4, placeholder: 'df -h', spellcheck: false, autocapitalize: 'off' });
  cmd.value = s?.command || '';
  const run = h('input', { type: 'checkbox', checked: s ? !!s.run : true });
  const err = h('div.form-err');
  const r = await sheet({
    title: s ? 'Komutu düzenle' : 'Yeni hazır komut',
    body: h('div', null, field('Ad', name), field('Komut', cmd), h('label.check', null, run, 'Gönderince çalıştır (Enter)'), err),
    buttons: [...(s ? [{ label: 'Sil', value: 'delete', danger: true }] : []), { label: 'Vazgeç', value: null }, { label: 'Kaydet', value: 'save', primary: true }],
    onButton: (v) => { if (v === 'save' && !cmd.value.trim()) { err.textContent = 'Komut gerekli'; return false; } return true; },
  });
  if (!r) return;
  let list = [...(app.settings.snippets || [])];
  if (r === 'delete') list = list.filter((x) => x.id !== s.id);
  else {
    const v = { id: s?.id || uid('sn'), name: name.value.trim() || cmd.value.trim().split('\n')[0].slice(0, 40), command: cmd.value.replace(/\s+$/, ''), run: run.checked };
    const i = list.findIndex((x) => x.id === v.id);
    if (i >= 0) list[i] = v; else list.push(v);
  }
  await app.saveSettings({ snippets: list });
}

// ---------------------------------------------------------------- metin düzenleyici
export function editorView(app, { title, path, text, save }) {
  const ta = h('textarea.editor', { spellcheck: false, autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
  ta.value = text;
  let saved = text;
  const status = h('small', null, path);
  const doSave = async () => {
    try { await save(ta.value); saved = ta.value; status.textContent = 'Kaydedildi · ' + path; toast('Kaydedildi', { type: 'ok' }); } catch (e) { toast(e.message, { type: 'err' }); }
  };
  const wrapBtn = h('button.tb', { onclick: () => { const on = ta.getAttribute('wrap') !== 'soft'; ta.setAttribute('wrap', on ? 'soft' : 'off'); ta.style.whiteSpace = on ? 'pre-wrap' : 'pre'; wrapBtn.classList.toggle('on', on); } }, icon('sidebar', 20));
  const view = {
    el: h('div.view', null,
      h('div.topbar', null, h('button.tb', { onclick: () => app.back() }, icon('back', 22)),
        h('div.title', null, h('b', null, title), status), wrapBtn, h('button.tb', { onclick: doSave }, icon('save', 21))),
      ta),
    async canLeave() {
      if (ta.value === saved) return true;
      const v = await actionSheet('Kaydedilmemiş değişiklikler', [
        { icon: 'save', label: 'Kaydet ve çık', value: 'save' },
        { icon: 'trash', label: 'Değişiklikleri at', value: 'drop', danger: true },
      ]);
      if (v === 'save') { await doSave(); return ta.value === saved; }
      return v === 'drop';
    },
  };
  return view;
}
