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

export const KEYS_HINT = 'Açıkken bu cihazın SSH anahtarları (~/.ssh ve hesaptan gelenler) uçtan uca şifreli olarak hesaba yüklenir, diğer cihazların anahtarları buraya gelir. Anahtarlar ~/.ssh\'ye yazılmaz; SSHDeck bağlanırken kullanır. Kapalıysa bu cihaz anahtar göndermez ve almaz.';

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
    server: h('input.input', { type: 'text', value: lastServer, placeholder: 'örn. 192.168.1.50 veya https://senkron.ornek.com', spellcheck: false }),
    user: h('input.input', { type: 'text', value: lastUser, spellcheck: false, autocapitalize: 'off' }),
    password: h('input.input', { type: 'password' }),
    password2: h('input.input', { type: 'password' }),
    invite: h('input.input', { type: 'text', spellcheck: false }),
    syncKeys: h('input', { type: 'checkbox' }),
  };
  api.account.status().then((st) => { f.syncKeys.checked = !!st.syncKeys; }).catch(() => {});
  if (reauth) { f.server.disabled = true; f.user.disabled = true; }
  const field = (label, control, cls) => h('label.field' + (cls || ''), null, h('span', null, label), control);
  const warn = h('div.hint.warn', { hidden: true }, 'Bu adres internette ve şifresiz (http). Kasa uçtan uca şifreli olsa da giriş bilgisi ağda açık gider; https kullanın.');
  const err = h('div.upd-err');
  // Yerel ağ taraması: alt ağdaki adreslerde 3150 portu açık SSHDeck sunucusu aranır
  const found = h('div.scan-list', { hidden: true });
  const scanBtn = h('button.btn', { type: 'button', title: 'Yerel ağdaki adreslerde 3150 portunu tarar', onclick: () => scan() }, icon('search', 14), 'Yerel ağda ara');
  const scan = async () => {
    scanBtn.disabled = true;
    found.hidden = false;
    found.replaceChildren(h('div.hint', null, 'Yerel ağ taranıyor (port 3150)…'));
    try {
      const list = await api.account.scan();
      found.replaceChildren(...(list.length ? list.map((x) => h('button.scan-item', {
        type: 'button',
        onclick: () => { f.server.value = x.server; checkWarn(); found.hidden = true; (f.user.value ? f.password : f.user).focus(); },
      }, h('b', null, x.server.replace(/^http:\/\//, '')), h('span.hint', null, x.host === '127.0.0.1' ? 'bu bilgisayar' : x.register ? 'hesap açılabilir' : 'yalnız giriş')))
        : [h('div.hint', null, 'Yerel ağda eşitleme sunucusu bulunamadı. Sunucu başka bir portta ya da internetteyse adresi elle yazın.')]));
    } catch (e) {
      found.replaceChildren(h('div.upd-err', null, cleanErr(e)));
    } finally { scanBtn.disabled = false; }
  };
  const regOnly = [field('Parola (tekrar)', f.password2, '.reg-only'), field('Davet kodu', f.invite, '.reg-only')];
  const modeBtns = {
    login: h('button.seg', { type: 'button', onclick: () => setMode('login') }, 'Giriş yap'),
    register: h('button.seg', { type: 'button', onclick: () => setMode('register') }, 'Hesap oluştur'),
  };
  const intro = h('p.hint');
  const body = h('div.account', null,
    reauth ? null : h('div.segs', null, modeBtns.login, modeBtns.register),
    intro,
    h('label.field', null, h('span', null, 'Sunucu'), h('div.row', null, f.server, scanBtn)), found, warn,
    field('Kullanıcı adı', f.user),
    field('Hesap parolası', f.password),
    ...regOnly,
    h('div.forgot', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); forgot = true; closeLogin?.(null); } }, 'Hesap parolamı unuttum (kurtarma anahtarıyla gir)')),
    reauth ? null : h('label.check', { title: KEYS_HINT }, f.syncKeys, 'SSH anahtarlarını da eşitle'),
    reauth ? null : h('p.hint.keys-hint', null, 'Özel anahtarlar da hesaba (şifreli) yüklenir. Sonradan hesap penceresinden değiştirilebilir.'),
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
  let forgot = false; let closeLogin = null;
  const r = await modal({
    title: 'Hesap ve eşitleme', width: 460, body,
    bind: (c) => { closeLogin = c; },
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
        if (!reauth) await api.account.setSyncKeys(f.syncKeys.checked);
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
  if (forgot) { await recoverDialog(app, { server: f.server.value.trim() || lastServer, user: f.user.value.trim() || lastUser }); return; }
  if (r && r.loggedIn) {
    app.setAccount(r);
    toast(mode === 'register' ? `Hesap oluşturuldu: ${r.user}` : `Giriş yapıldı: ${r.user}. Bağlantılar eşitlendi.`, 'ok', 5000);
  }
}

async function manageDialog(app, st) {
  const recState = h('span.muted', null, 'denetleniyor…');
  let recInfo = null;
  const recRow = h('div.rec-row', null, icon('key', 15), h('div', null, h('b', null, 'Kurtarma anahtarı: '), recState,
    h('div.hint', null, 'Hesap parolanızı unutursanız bu anahtarla yeni parola belirlersiniz; yoksa kasa kurtarılamaz.')),
  h('button.btn.sm', { type: 'button', onclick: () => recoveryMenu(app, recInfo, (i) => { recInfo = i; showRec(); }) }, 'Yönet…'));
  const showRec = () => { recState.textContent = recInfo && recInfo.recovery ? `var (${new Date(recInfo.recovery).toLocaleDateString('tr-TR')})` : 'yok — oluşturmanız önerilir'; recState.classList.toggle('warn-text', !(recInfo && recInfo.recovery)); };
  api.account.info().then((i) => { recInfo = i; showRec(); }).catch(() => { recState.textContent = 'sunucuya sorulamadı'; });
  const body = h('div.account', null,
    h('dl.kv', null,
      h('dt', null, 'Hesap'), h('dd', null, st.user),
      h('dt', null, 'Sunucu'), h('dd', null, st.server),
      h('dt', null, 'Durum'), h('dd', null, STATE_TEXT[st.state] || st.state),
      h('dt', null, 'Son eşitleme'), h('dd', null, syncTimeText(st.lastSync))),
    st.error ? h('div.upd-err', null, st.error) : null,
    insecureServer(st.server) ? h('div.hint.warn', null, 'Sunucu şifresiz (http) ve yerel ağ dışında; https kullanın.') : null,
    h('label.check', null, h('input', {
      type: 'checkbox', checked: !!st.syncKeys,
      onchange: async (e) => {
        const on = e.target.checked;
        try {
          await api.account.setSyncKeys(on);
          toast(on ? 'SSH anahtarları eşitlenecek' : 'SSH anahtarları artık bu cihazdan gönderilmeyecek ve alınmayacak', 'ok', 5000);
        } catch (err) { e.target.checked = !on; toast(cleanErr(err), 'err'); }
      },
    }), 'SSH anahtarlarını da eşitle'),
    h('p.hint', null, KEYS_HINT),
    recRow,
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

// ---------------------------------------------------------------- kurtarma anahtarı
async function recoveryMenu(app, info, done) {
  const has = !!(info && info.recovery);
  const act = has ? await modal({
    title: 'Kurtarma anahtarı', width: 440,
    body: h('div', null, h('p', null, `Bu hesabın ${new Date(info.recovery).toLocaleDateString('tr-TR')} tarihli bir kurtarma anahtarı var.`),
      h('p.hint', null, 'Kaybettiyseniz yenisini oluşturun: eskisi hemen geçersiz olur.')),
    buttons: [{ label: 'Kaldır', value: 'remove', danger: true }, { label: 'Vazgeç', value: null }, { label: 'Yeni anahtar oluştur', value: 'new', primary: true }],
  }) : 'new';
  if (!act) return;
  const pw = await promptText({ title: 'Kurtarma anahtarı', label: 'Doğrulamak için hesap parolanız', password: true, ok: act === 'remove' ? 'Kaldır' : 'Oluştur' });
  if (pw == null) return;
  try {
    if (act === 'remove') {
      await api.account.recoveryRemove(pw);
      done({ ...info, recovery: null });
      toast('Kurtarma anahtarı kaldırıldı', 'ok');
      return;
    }
    const rc = await api.account.recoveryCreate(pw);
    done({ ...info, recovery: rc.created });
    await showRecoveryCode(rc);
  } catch (e) { toast(cleanErr(e), 'err', 6000); }
}

async function showRecoveryCode(rc) {
  const saved = h('div.hint');
  await modal({
    title: 'Kurtarma anahtarınız', width: 520,
    body: h('div.rec-show', null,
      h('p', null, 'Bu anahtarı şimdi kaydedin: bir daha gösterilmez. Parola yöneticisine yazın ya da dosyaya kaydedip güvenli bir yerde saklayın.'),
      h('div.rec-code.mono', null, rc.code),
      h('div.row', null,
        h('button.btn', { type: 'button', onclick: () => { api.clipboard.write(rc.code); toast('Kurtarma anahtarı kopyalandı', 'ok'); } }, icon('copy', 14), 'Kopyala'),
        h('button.btn', { type: 'button', onclick: async () => { try { const p = await api.account.recoverySave(rc); if (p) saved.textContent = `Kaydedildi: ${p}`; } catch (e) { toast(cleanErr(e), 'err'); } } }, icon('save', 14), 'Dosyaya kaydet…')),
      saved,
      h('p.hint.warn', null, 'Anahtarı ele geçiren biri hesap parolanızı değiştirip bağlantılarınıza erişebilir.')),
    buttons: [{ label: 'Kaydettim', value: true, primary: true }],
  });
}

/** Parolası unutulan hesap: kurtarma anahtarı (yazarak ya da dosyadan) + yeni parola */
export async function recoverDialog(app, pre = {}) {
  const f = {
    server: h('input.input', { value: pre.server || '', placeholder: 'örn. 192.168.1.50 veya https://senkron.ornek.com', spellcheck: false }),
    user: h('input.input', { value: pre.user || '', spellcheck: false, autocapitalize: 'off' }),
    code: h('input.input.mono', { placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', spellcheck: false, autocapitalize: 'characters' }),
    pw1: h('input.input', { type: 'password' }),
    pw2: h('input.input', { type: 'password' }),
  };
  const err = h('div.upd-err');
  const fromFile = h('button.btn', { type: 'button', onclick: async () => {
    try {
      const r = await api.account.recoveryOpen();
      if (!r) return;
      f.code.value = r.code;
      if (r.server) f.server.value = r.server;
      if (r.user) f.user.value = r.user;
    } catch (e) { err.textContent = cleanErr(e); }
  } }, icon('file', 14), 'Dosyadan…');
  const field = (label, control) => h('label.field', null, h('span', null, label), control);
  let busy = false;
  const r = await modal({
    title: 'Hesabı kurtar', width: 480,
    canClose: () => !busy,
    body: h('div.account', null,
      h('p.hint', null, 'Kurtarma anahtarıyla yeni bir hesap parolası belirlenir. Bağlantılarınız ve kayıtlı parolalarınız korunur; diğer cihazlarda yeni parolayla tekrar giriş yapmanız gerekir.'),
      field('Sunucu', f.server), field('Kullanıcı adı', f.user),
      h('label.field', null, h('span', null, 'Kurtarma anahtarı'), h('div.row', null, f.code, fromFile)),
      field('Yeni hesap parolası (en az 10 karakter)', f.pw1), field('Yeni parola (tekrar)', f.pw2), err),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'Kurtar', value: 'ok', primary: true }],
    onButton: async (v) => {
      if (v !== 'ok') return busy ? false : undefined;
      if (busy) return false;
      err.textContent = '';
      if (!f.server.value.trim() || !f.user.value.trim() || !f.code.value.trim()) { err.textContent = 'Sunucu, kullanıcı adı ve kurtarma anahtarı gerekli'; return false; }
      if (f.pw1.value.length < 10) { err.textContent = 'Yeni parola en az 10 karakter olmalı'; return false; }
      if (f.pw1.value !== f.pw2.value) { err.textContent = 'Parolalar eşleşmiyor'; return false; }
      busy = true;
      try {
        return await api.account.recover({ server: f.server.value.trim(), user: f.user.value.trim(), code: f.code.value, password: f.pw1.value });
      } catch (e) { err.textContent = cleanErr(e); return false; } finally { busy = false; }
    },
  });
  if (r && r.loggedIn) {
    app.setAccount(r);
    toast(`Hesap kurtarıldı: ${r.user}. Diğer cihazlarda yeni parolayla giriş yapın.`, 'ok', 7000);
  }
}
