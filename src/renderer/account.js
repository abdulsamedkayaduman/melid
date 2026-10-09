// Hesap penceresi: giriş / hesap açma / eşitleme durumu (ana süreçte sync.js, sunucu: server/sync-server.js)
import { h, icon } from './util.js';
import { modal, toast, promptText } from './dialogs.js';
import { cleanErr } from './filepane.js';

const api = window.api;

// Yerel ağ / Tailscale dışında düz HTTP: parola türevi giriş anahtarı ağda açık gider
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1\]?|[^.]+$|.*\.(local|lan|home|ts\.net)$)/i;
export function insecureServer(server) {
  let u = String(server || '').trim();
  if (!u) return false;
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try { const x = new URL(u); return x.protocol === 'http:' && !PRIVATE_HOST.test(x.hostname); } catch { return false; }
}

export function syncTimeText(t) {
  if (!t) return 'henüz eşitlenmedi';
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const STATE_TEXT = { idle: 'Bekliyor', syncing: 'Eşitleniyor…', ok: 'Eşitlendi', error: 'Hata', locked: 'Ana parola kilitli', auth: 'Tekrar giriş gerekli' };

export async function accountDialog(app) {
  const st = await api.account.status();
  if (st.loggedIn) return manageDialog(app, st);
  return loginDialog(app);
}

async function loginDialog(app, { reauth } = {}) {
  let mode = 'login';
  let lastServer = ''; let lastUser = '';
  try { lastServer = localStorage.getItem('syncServer') || ''; lastUser = localStorage.getItem('syncUser') || ''; } catch {}
  if (reauth) { lastServer = reauth.server; lastUser = reauth.user; }
  const f = {
    server: h('input.input', { type: 'text', value: lastServer, placeholder: 'örn. 192.168.1.50:3150 veya https://senkron.ornek.com', spellcheck: false }),
    user: h('input.input', { type: 'text', value: lastUser, spellcheck: false, autocapitalize: 'off' }),
    password: h('input.input', { type: 'password' }),
    password2: h('input.input', { type: 'password' }),
    invite: h('input.input', { type: 'text', spellcheck: false }),
  };
  if (reauth) { f.server.disabled = true; f.user.disabled = true; }
  const field = (label, control, cls) => h('label.field' + (cls || ''), null, h('span', null, label), control);
  const warn = h('div.hint.warn', { hidden: true }, 'Bu adres internette ve şifresiz (http). Kasa uçtan uca şifreli olsa da giriş bilgisi ağda açık gider; https kullanın.');
  const err = h('div.upd-err');
  const regOnly = [field('Parola (tekrar)', f.password2, '.reg-only'), field('Davet kodu', f.invite, '.reg-only')];
  const modeBtns = {
    login: h('button.seg', { type: 'button', onclick: () => setMode('login') }, 'Giriş yap'),
    register: h('button.seg', { type: 'button', onclick: () => setMode('register') }, 'Hesap oluştur'),
  };
  const intro = h('p.hint');
  const body = h('div.account', null,
    reauth ? null : h('div.segs', null, modeBtns.login, modeBtns.register),
    intro,
    field('Sunucu', f.server), warn,
    field('Kullanıcı adı', f.user),
    field('Hesap parolası', f.password),
    ...regOnly,
    err);
  const setMode = (m) => {
    mode = m;
    for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle('on', k === m);
    for (const el of regOnly) el.hidden = m !== 'register';
    intro.textContent = m === 'register'
      ? 'Hesap parolası bağlantılarınızı şifreler ve hiçbir zaman sunucuya gönderilmez. Unutursanız sunucudaki veriler kurtarılamaz; güçlü ve akılda kalır bir parola seçin.'
      : reauth ? 'Hesap parolası başka bir cihazda değiştirildi; yeni parolayla tekrar giriş yapın.'
        : 'Giriş yaptığınız her cihazda oturumlarınız, kayıtlı parolalarınız, ayarlarınız ve hazır komutlarınız eşitlenir. Bu cihazdaki oturumlar hesaptakilerle birleştirilir.';
    err.textContent = '';
  };
  setMode('login');
  const checkWarn = () => { warn.hidden = !insecureServer(f.server.value); };
  f.server.addEventListener('input', checkWarn); checkWarn();

  let busy = false;
  const r = await modal({
    title: 'Hesap ve eşitleme', width: 460, body,
    canClose: () => !busy,
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'Devam', value: 'ok', primary: true }],
    onButton: async (v) => {
      if (v !== 'ok') return busy ? false : undefined;
      if (busy) return false;
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
      const btns = body.closest('.modal').querySelectorAll('.modal-foot .btn');
      btns.forEach((b) => { b.disabled = true; });
      err.textContent = '';
      intro.textContent = mode === 'register' ? 'Hesap oluşturuluyor ve bu cihazdaki veriler yükleniyor…' : 'Giriş yapılıyor ve eşitleniyor…';
      try {
        const res = mode === 'register' ? await api.account.register(o) : await api.account.login(o);
        try { localStorage.setItem('syncServer', o.server); localStorage.setItem('syncUser', o.user); } catch {}
        return res;
      } catch (e) {
        setMode(mode); // giriş metnini geri getirir
        err.textContent = cleanErr(e);
        return false;
      } finally {
        busy = false;
        btns.forEach((b) => { b.disabled = false; });
      }
    },
  });
  if (r && r.loggedIn) {
    app.setAccount(r);
    toast(mode === 'register' ? `Hesap oluşturuldu: ${r.user}` : `Giriş yapıldı: ${r.user}. Bağlantılar eşitlendi.`, 'ok', 5000);
  }
}

async function manageDialog(app, st) {
  const body = h('div.account', null,
    h('dl.kv', null,
      h('dt', null, 'Hesap'), h('dd', null, st.user),
      h('dt', null, 'Sunucu'), h('dd', null, st.server),
      h('dt', null, 'Durum'), h('dd', null, STATE_TEXT[st.state] || st.state),
      h('dt', null, 'Son eşitleme'), h('dd', null, syncTimeText(st.lastSync))),
    st.error ? h('div.upd-err', null, st.error) : null,
    insecureServer(st.server) ? h('div.hint.warn', null, 'Sunucu şifresiz (http) ve yerel ağ dışında; https kullanın.') : null,
    h('p.hint', null, 'Oturumlar, kayıtlı parolalar, ayarlar ve hazır komutlar uçtan uca şifreli eşitlenir. Bu cihaza özgü ayarlar (kayıt klasörü, panel boyutları) ve oturumların yerel klasörü eşitlenmez.'));
  const act = await modal({
    title: 'Hesap ve eşitleme', width: 460, body,
    buttons: [
      { label: 'Çıkış yap', value: 'logout', danger: true },
      { label: 'Parolayı değiştir', value: 'password' },
      { label: st.state === 'auth' ? 'Tekrar giriş yap' : 'Şimdi eşitle', value: st.state === 'auth' ? 'reauth' : 'sync', primary: true },
    ],
  });
  try {
    if (act === 'sync') {
      app.setAccount(await api.account.syncNow());
      toast('Eşitlendi', 'ok');
    } else if (act === 'reauth') {
      await loginDialog(app, { reauth: st });
    } else if (act === 'password') {
      const oldP = await promptText({ title: 'Hesap parolası', label: 'Mevcut hesap parolası', password: true });
      if (oldP == null) return;
      const n1 = await promptText({ title: 'Hesap parolası', label: 'Yeni hesap parolası (en az 10 karakter)', password: true });
      if (n1 == null) return;
      if (n1.length < 10) { toast('Hesap parolası en az 10 karakter olmalı', 'err'); return; }
      const n2 = await promptText({ title: 'Hesap parolası', label: 'Yeni parolayı tekrar girin', password: true });
      if (n2 == null) return;
      if (n1 !== n2) { toast('Parolalar eşleşmiyor', 'err'); return; }
      await api.account.changePassword(oldP, n1);
      toast('Hesap parolası değiştirildi. Diğer cihazlarda yeni parolayla tekrar giriş yapmanız gerekecek.', 'ok', 7000);
    } else if (act === 'logout') {
      const ok = await modal({
        title: 'Çıkış yap', width: 420,
        body: h('p', null, 'Bu cihaz hesaptan çıkarılsın mı? Buradaki oturumlar silinmez, yalnız eşitleme durur.'),
        buttons: [{ label: 'Vazgeç', value: null }, { label: 'Çıkış yap', value: true, primary: true, danger: true }],
      });
      if (!ok) return;
      app.setAccount(await api.account.logout());
      toast('Hesaptan çıkıldı', 'ok');
    }
  } catch (e) { toast(cleanErr(e), 'err', 6000); }
}
