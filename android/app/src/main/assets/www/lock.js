// Uygulama kilidi: ana parola + isteğe bağlı biyometrik (Java: app/AppLock). Kilitliyken köprü yalnız kilit çağrılarını
// kabul eder; açık bağlantılar ve eşitleme arka planda sürer.
import { h, icon } from './util.js';
import * as N from './native.js';
import { sheet, actionSheet, promptText, confirm, toast } from './dialogs.js';

let shown = null; // { el, done: Promise }

export const lockShown = () => !!shown;

/** Kilitliyse kilit ekranını gösterir; açılınca döner */
export async function ensureUnlocked() {
  let st;
  try { st = await N.call('lockStatus'); } catch { return; }
  if (st.locked) await showLock(st);
}

export function showLock(st0) {
  if (shown) return shown.done;
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const pw = h('input.input', { type: 'password', placeholder: 'Ana parola', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  const err = h('div.form-err');
  const bioBtn = h('button.btn', { type: 'button', hidden: true, onclick: () => bio() }, icon('finger', 20), 'Parmak izi / yüz ile aç');
  const okBtn = h('button.btn.primary', { type: 'button', onclick: () => submit() }, icon('unlock', 18), 'Kilidi aç');
  const el = h('div.lock-screen', null,
    h('div.lock-box', null,
      h('div.lock-logo', null, icon('lock', 34)),
      h('h2', null, 'Melid kilitli'),
      h('p', null, 'Devam etmek için ana parolanızı girin.'),
      pw, err, okBtn, bioBtn,
      h('small.lock-forgot', null, 'Parolayı unuttuysanız tek yol uygulama verilerini silmektir: Android Ayarlar > Uygulamalar > Melid > Depolama > Verileri temizle (oturumlar ve anahtarlar silinir; hesapla eşitliyorsanız tekrar giriş yapınca geri gelir).')));
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  let busy = false;
  const finish = () => {
    el.remove();
    shown = null;
    resolve();
  };
  const submit = async () => {
    if (busy || !pw.value) return;
    busy = true; okBtn.disabled = true; err.textContent = '';
    const label = okBtn.lastChild.textContent;
    okBtn.lastChild.textContent = 'Doğrulanıyor…';
    try { await N.call('lockUnlock', { password: pw.value }); finish(); } catch (e) { err.textContent = e.message; pw.select(); } finally { busy = false; okBtn.disabled = false; okBtn.lastChild.textContent = label; }
  };
  const bio = async () => {
    if (busy) return;
    busy = true; err.textContent = '';
    try { await N.call('lockBiometric'); finish(); } catch (e) {
      if (e.message) err.textContent = e.message;
      const st = await N.call('lockStatus').catch(() => null);
      bioBtn.hidden = !st?.biometric;
      pw.focus();
    } finally { busy = false; }
  };
  document.body.append(el);
  shown = { el, done };
  (async () => {
    const st = st0 || await N.call('lockStatus').catch(() => null);
    if (st && !st.locked) { finish(); return; }
    bioBtn.hidden = !st?.biometric;
    if (st?.biometric) bio(); else pw.focus();
  })();
  return done;
}

const TIMEOUTS = [[0, 'Hemen'], [30, '30 saniye'], [60, '1 dakika'], [300, '5 dakika'], [900, '15 dakika'], [3600, '1 saat']];
const timeoutText = (s) => (TIMEOUTS.find(([v]) => v === s) || [0, `${s} sn`])[1];

export function lockSubtitle(st) {
  if (!st?.enabled) return 'Kapalı · uygulamayı ana parolayla koruyun';
  return `Açık${st.biometric ? ' · biyometrik' : ''} · arka planda ${timeoutText(st.timeout)} sonra kilitlenir`;
}

/** Ayarlar > Uygulama kilidi */
export async function lockSheet(app) {
  let st;
  try { st = await N.call('lockStatus'); } catch (e) { toast(e.message, { type: 'err' }); return; }
  try {
    if (!st.enabled) {
      const p1 = await promptText({ title: 'Ana parola belirle', sub: 'Uygulama her açılışta ve arka plandan dönünce bu parolayı ister. Unutursanız kurtarılamaz.', label: 'Ana parola', type: 'password', validate: (v) => v.length < 4 ? 'En az 4 karakter olmalı' : null });
      if (p1 == null) return;
      const p2 = await promptText({ title: 'Ana parola belirle', label: 'Parolayı tekrar girin', type: 'password', validate: (v) => v !== p1 ? 'Parolalar eşleşmiyor' : null });
      if (p2 == null) return;
      st = await N.call('lockSet', { password: p1 });
      toast('Uygulama kilidi açıldı', { type: 'ok' });
      if (st.bioAvailable && await confirm({ title: 'Biyometrik giriş', message: 'Kilidi parmak izi / yüz tanıma ile de açabilmek ister misiniz?', ok: 'Evet' })) {
        st = await bioToggle(true, p1);
      }
      app.setLock(st);
      return;
    }
    const act = await actionSheet('Uygulama kilidi', [
      { icon: 'finger', label: st.biometric ? 'Biyometrik girişi kapat' : 'Parmak izi / yüz ile aç', value: 'bio', hint: !st.biometric && !st.bioAvailable ? 'telefonda kayıtlı değil' : null },
      { icon: 'refresh', label: 'Kilitlenme süresi', value: 'timeout', hint: timeoutText(st.timeout) },
      { icon: 'lock', label: 'Şimdi kilitle', value: 'now' },
      { icon: 'key', label: 'Ana parolayı değiştir', value: 'change' },
      '-',
      { icon: 'unlock', label: 'Kilidi kaldır', value: 'off', danger: true },
    ], lockSubtitle(st));
    if (act === 'bio') {
      if (st.biometric) st = await bioToggle(false);
      else {
        if (!st.bioAvailable) { toast('Önce Android Ayarlar > Güvenlik bölümünden parmak izi veya yüz tanıma ekleyin', { type: 'err', ms: 5000 }); return; }
        const p = await promptText({ title: 'Biyometrik giriş', label: 'Ana parola', type: 'password' });
        if (p == null) return;
        st = await bioToggle(true, p);
      }
    } else if (act === 'timeout') {
      const v = await actionSheet('Arka planda ne kadar sonra kilitlensin?', TIMEOUTS.map(([s, t]) => ({ label: t, value: String(s), icon: s === st.timeout ? 'check' : null })));
      if (v == null) return;
      st = await N.call('lockTimeout', { sec: Number(v) });
    } else if (act === 'now') {
      await N.call('lockNow');
      return;
    } else if (act === 'change') {
      const old = await promptText({ title: 'Ana parolayı değiştir', label: 'Mevcut parola', type: 'password' });
      if (old == null) return;
      const p1 = await promptText({ title: 'Ana parolayı değiştir', label: 'Yeni parola', type: 'password', validate: (v) => v.length < 4 ? 'En az 4 karakter olmalı' : null });
      if (p1 == null) return;
      const p2 = await promptText({ title: 'Ana parolayı değiştir', label: 'Yeni parolayı tekrar girin', type: 'password', validate: (v) => v !== p1 ? 'Parolalar eşleşmiyor' : null });
      if (p2 == null) return;
      st = await N.call('lockSet', { old, password: p1 });
      toast('Ana parola değiştirildi', { type: 'ok' });
    } else if (act === 'off') {
      const p = await promptText({ title: 'Kilidi kaldır', label: 'Ana parola', type: 'password', ok: 'Kaldır' });
      if (p == null) return;
      st = await N.call('lockDisable', { password: p });
      toast('Uygulama kilidi kaldırıldı', { type: 'ok' });
    }
  } catch (e) { if (e.message) toast(e.message, { type: 'err', ms: 5000 }); }
  app.setLock(st);
}

async function bioToggle(on, password) {
  const st = await N.call('lockSetBiometric', { on, password });
  toast(on ? 'Biyometrik giriş açıldı' : 'Biyometrik giriş kapatıldı', { type: 'ok' });
  return st;
}
