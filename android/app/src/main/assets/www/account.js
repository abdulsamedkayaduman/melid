// Hesap ve eşitleme: giriş / hesap oluşturma (yerel ağda sunucu arama ile) ve hesap durumu.
// Protokol Java'da (core/SyncCore, app/AccountSync); masaüstüyle aynı hesap ve aynı uçtan uca şifreli kasa.
import { h, icon } from './util.js';
import * as N from './native.js';
import { sheet, actionSheet, promptText, confirm, toast } from './dialogs.js';

const field = (label, control, hint) => h('label.field', null, h('span', null, label), control, hint ? h('small.hint', { style: { margin: 0 } }, hint) : null);

export const STATE_TEXT = { idle: 'Bekliyor', syncing: 'Eşitleniyor…', ok: 'Eşitlendi', error: 'Hata', auth: 'Tekrar giriş gerekli' };

export function syncTimeText(t) {
  if (!t) return 'henüz eşitlenmedi';
  const d = new Date(t);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Ayarlar satırının alt yazısı */
export function accountSubtitle(st) {
  if (!st || !st.loggedIn) return 'Oturumları, parolaları ve hazır komutları bilgisayarla eşitleyin';
  if (st.state === 'error' || st.state === 'auth') return `${st.user} · ${STATE_TEXT[st.state]}`;
  return `${st.user} · ${st.state === 'syncing' ? STATE_TEXT.syncing : 'son eşitleme ' + syncTimeText(st.lastSync)}`;
}

const KEYS_TEXT = 'Açıkken bu telefondaki SSH anahtarları (özel anahtarlar dahil) uçtan uca şifreli olarak hesaba yüklenir; bilgisayardaki ve diğer cihazlardaki anahtarlar da buraya gelir. Kapalıysa bu telefon anahtar göndermez ve almaz.';

export async function accountSheet(app) {
  let st;
  try { st = await N.call('accountStatus'); } catch (e) { toast(e.message, { type: 'err' }); return; }
  return st.loggedIn ? manageSheet(app, st) : loginSheet(app, null, st);
}

async function loginSheet(app, reauth, st0) {
  let mode = 'login';
  let lastServer = ''; let lastUser = '';
  try { lastServer = localStorage.getItem('syncServer') || ''; lastUser = localStorage.getItem('syncUser') || ''; } catch {}
  if (reauth) { lastServer = reauth.server; lastUser = reauth.user; }
  const inp = (attrs) => h('input.input', { spellcheck: false, autocapitalize: 'off', autocomplete: 'off', ...attrs });
  const f = {
    server: inp({ value: lastServer, placeholder: 'örn. 192.168.1.50 veya https://senkron.ornek.com', inputmode: 'url' }),
    user: inp({ value: lastUser }),
    password: inp({ type: 'password' }),
    password2: inp({ type: 'password' }),
    invite: inp({}),
    syncKeys: h('input', { type: 'checkbox', checked: !!st0?.syncKeys }),
  };
  if (reauth) { f.server.disabled = true; f.user.disabled = true; }
  const err = h('div.form-err');
  const intro = h('p.hint', { style: { marginTop: 0 } });

  // Yerel ağ taraması: Wi-Fi'deki adreslerde 3150 portu açık SSHDeck sunucusu aranır
  const found = h('div.scan-list', { hidden: true });
  const scanBtn = h('button.btn.sm', { type: 'button', onclick: () => scan() }, icon('search', 16), 'Yerel ağda ara');
  const scan = async () => {
    scanBtn.disabled = true;
    found.hidden = false;
    found.replaceChildren(h('div.hint', { style: { margin: 0 } }, 'Yerel ağ taranıyor (port 3150)…'));
    try {
      const list = await N.call('accountScan');
      found.replaceChildren(...(list.length ? list.map((x) => h('button.scan-item', {
        type: 'button',
        onclick: () => { f.server.value = x.server; found.hidden = true; },
      }, icon('server', 18), h('b.grow', null, x.server.replace(/^http:\/\//, '')), h('small', null, x.register ? 'hesap açılabilir' : 'yalnız giriş')))
        : [h('div.hint', { style: { margin: 0 } }, 'Yerel ağda eşitleme sunucusu bulunamadı. Telefon aynı Wi-Fi\'de mi? Sunucu internetteyse adresi elle yazın.')]));
    } catch (e) {
      found.replaceChildren(h('div.form-err', null, e.message));
    } finally { scanBtn.disabled = false; }
  };

  const regOnly = [field('Parola (tekrar)', f.password2), field('Davet kodu', f.invite, 'Sunucudaki SSHDECK_SYNC_INVITE')];
  const modeBtns = {
    login: h('button.seg', { type: 'button', onclick: () => setMode('login') }, 'Giriş yap'),
    register: h('button.seg', { type: 'button', onclick: () => setMode('register') }, 'Hesap oluştur'),
  };
  const setMode = (m) => {
    mode = m;
    for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle('on', k === m);
    for (const el of regOnly) el.hidden = m !== 'register';
    intro.textContent = m === 'register'
      ? 'Hesap parolası bağlantılarınızı şifreler ve hiçbir zaman sunucuya gönderilmez. Unutursanız sunucudaki veriler kurtarılamaz.'
      : reauth ? 'Hesap parolası başka bir cihazda değiştirildi; yeni parolayla tekrar giriş yapın.'
        : 'Bilgisayardaki SSHDeck hesabınızla giriş yapın: oturumlar, kayıtlı parolalar ve hazır komutlar iki yönlü eşitlenir. Bu telefondaki oturumlar hesaptakilerle birleştirilir.';
    err.textContent = '';
  };
  setMode('login');

  let busy = false;
  let res = null;
  let sh;
  const r = await sheet({
    title: 'Hesap ve eşitleme',
    onOpen: (_, m) => { sh = m; },
    body: h('div', null,
      reauth ? null : h('div.segs', null, modeBtns.login, modeBtns.register),
      intro,
      field('Sunucu', f.server),
      reauth ? null : h('div', { style: { margin: '-6px 0 14px' } }, scanBtn),
      found,
      field('Kullanıcı adı', f.user),
      field('Hesap parolası', f.password),
      ...regOnly,
      reauth ? null : h('label.check', null, f.syncKeys, 'SSH anahtarlarını da eşitle'),
      reauth ? null : h('p.hint', { style: { margin: '-4px 0 12px 32px', fontSize: '12px' } }, 'Özel anahtarlar da hesaba (şifreli) yüklenir. Sonradan Hesap ve eşitleme menüsünden değiştirilebilir.'),
      err),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'Devam', value: 'ok', primary: true }],
    onButton: async (v) => {
      if (busy) return false;
      if (!v) return true;
      err.textContent = '';
      const o = { server: f.server.value.trim(), user: f.user.value.trim(), password: f.password.value };
      if (!o.server || !o.user || !o.password) { err.textContent = 'Sunucu, kullanıcı adı ve parola gerekli'; return false; }
      if (mode === 'register') {
        if (o.password.length < 10) { err.textContent = 'Hesap parolası en az 10 karakter olmalı'; return false; }
        if (o.password !== f.password2.value) { err.textContent = 'Parolalar eşleşmiyor'; return false; }
        o.invite = f.invite.value.trim();
        if (!o.invite) { err.textContent = 'Davet kodu gerekli (sunucudaki SSHDECK_SYNC_INVITE)'; return false; }
      }
      busy = true;
      sh.dismiss = false; // sürerken dışarı dokunmak / geri tuşu pencereyi kapatmasın
      intro.textContent = mode === 'register' ? 'Hesap oluşturuluyor ve bu telefondaki veriler yükleniyor…' : 'Giriş yapılıyor ve eşitleniyor… (anahtar türetme birkaç saniye sürebilir)';
      try {
        if (!reauth) await N.call('accountSetKeys', { on: f.syncKeys.checked });
        res = await N.call(mode === 'register' ? 'accountRegister' : 'accountLogin', o);
        try { localStorage.setItem('syncServer', o.server); localStorage.setItem('syncUser', o.user); } catch {}
        return true;
      } catch (e) {
        setMode(mode);
        err.textContent = e.message;
        // ilk eşitleme hata verse de hesap kaydedilmiş olabilir
        const s2 = await N.call('accountStatus').catch(() => null);
        if (s2?.loggedIn) { res = s2; return true; }
        return false;
      } finally { busy = false; sh.dismiss = undefined; }
    },
  });
  if (r && res?.loggedIn) {
    app.setAccount(res);
    toast(mode === 'register' ? `Hesap oluşturuldu: ${res.user}` : `Giriş yapıldı: ${res.user}`, { type: 'ok' });
  }
}

async function manageSheet(app, st) {
  const kv = (k, v) => h('div.kv-row', null, h('span', null, k), h('b', null, v));
  const act = await actionSheet('Hesap ve eşitleme', [
    st.state === 'auth' ? { icon: 'lock', label: 'Tekrar giriş yap', value: 'reauth' } : { icon: 'sync', label: 'Şimdi eşitle', value: 'sync' },
    { icon: 'key', label: st.syncKeys ? 'SSH anahtarı eşitlemesini kapat' : 'SSH anahtarlarını da eşitle', value: 'keys' },
    { icon: 'lock', label: 'Hesap parolasını değiştir', value: 'password' },
    '-',
    { icon: 'power', label: 'Çıkış yap', value: 'logout', danger: true },
  ], h('div', null,
    kv('Hesap', st.user), kv('Sunucu', st.server.replace(/^https?:\/\//, '')),
    kv('Durum', STATE_TEXT[st.state] || st.state), kv('Son eşitleme', syncTimeText(st.lastSync)),
    kv('SSH anahtarları', st.syncKeys ? 'eşitleniyor' : 'eşitlenmiyor'),
    st.error ? h('div.form-err', null, st.error) : null));
  try {
    if (act === 'sync') {
      app.setAccount(await N.call('accountSync'));
      toast('Eşitlendi', { type: 'ok' });
    } else if (act === 'keys') {
      const on = !st.syncKeys;
      if (!await confirm({ title: on ? 'SSH anahtarlarını eşitle' : 'Anahtar eşitlemesini kapat', message: on ? KEYS_TEXT : 'Bu telefon artık anahtar göndermez ve almaz. Buradaki anahtarlar silinmez; hesaptaki anahtarlar da diğer cihazlarda kalır.', ok: on ? 'Eşitle' : 'Kapat' })) return;
      app.setAccount(await N.call('accountSetKeys', { on }));
      toast(on ? 'SSH anahtarları eşitlenecek' : 'Anahtar eşitlemesi kapatıldı', { type: 'ok' });
    } else if (act === 'reauth') {
      await loginSheet(app, st);
    } else if (act === 'password') {
      const oldP = await promptText({ title: 'Hesap parolası', label: 'Mevcut hesap parolası', type: 'password' });
      if (oldP == null) return;
      const n1 = await promptText({ title: 'Hesap parolası', label: 'Yeni hesap parolası', type: 'password', validate: (v) => v.length < 10 ? 'En az 10 karakter olmalı' : null });
      if (n1 == null) return;
      const n2 = await promptText({ title: 'Hesap parolası', label: 'Yeni parolayı tekrar girin', type: 'password', validate: (v) => v !== n1 ? 'Parolalar eşleşmiyor' : null });
      if (n2 == null) return;
      const t = toast('Parola değiştiriliyor…', { ms: 20000 });
      try { await N.call('accountPassword', { old: oldP, new: n1 }); } finally { t.remove(); }
      toast('Hesap parolası değiştirildi. Diğer cihazlarda yeni parolayla tekrar giriş gerekecek.', { type: 'ok', ms: 6000 });
    } else if (act === 'logout') {
      if (!await confirm({ title: 'Çıkış yap', message: 'Bu telefon hesaptan çıkarılsın mı? Buradaki oturumlar silinmez, yalnız eşitleme durur.', ok: 'Çıkış yap', danger: true })) return;
      app.setAccount(await N.call('accountLogout'));
      toast('Hesaptan çıkıldı', { type: 'ok' });
    }
  } catch (e) { toast(e.message, { type: 'err', ms: 6000 }); }
}
