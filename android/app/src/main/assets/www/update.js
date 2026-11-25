// Güncelleme sayfası: sürüm notları, indir + kur (Java: Updater.java; Android onay ekranı gösterir)
import { h, icon, formatSize } from './util.js';
import * as N from './native.js';
import { sheet, toast } from './dialogs.js';

/** check: önce sunucuya sor (Ayarlar > "Güncellemeleri denetle"); yoksa son bilinen durumu göster. */
export async function updateSheet(app, { check = false } = {}) {
  let st = app.update;
  if (check || !st) {
    try { st = await N.call('updateCheck'); } catch (e) { toast(`Güncelleme denetlenemedi: ${e.message}`, 'err'); return; }
    app.setUpdate(st);
  }
  if (!st.newer) {
    toast(st.version ? `Melid güncel (${st.current})` : 'Sunucuda henüz yayınlanmış bir sürüm yok');
    return;
  }
  const bar = h('i');
  const stat = h('small.upd-stat');
  const prog = h('div.upd-prog.hidden', null, h('div.bar', null, bar), stat);
  const err = h('div.upd-err');
  const date = st.date ? new Date(st.date).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const body = h('div.upd', null,
    h('div.upd-ver', null, h('span', null, st.current), icon('chevron', 16), h('b', null, st.version), date ? h('small', null, date) : null),
    st.notes ? h('pre.upd-notes', null, st.notes) : null,
    h('small.hint', null, st.canInstall
      ? `${formatSize(st.size)} indirilecek. Android kurulum için onay isteyecek; açık bağlantılar kapanır.`
      : 'Bu sürümde Android paketi yok.'),
    prog, err);
  let busy = false;
  let box = null; let m = null;
  // İndirme sürerken: normal düğmeler gizlenir, yerine "İptal"; dışarı dokunma / geri tuşu kapatmaz
  const cancelBtn = h('button.btn', { type: 'button', onclick: () => {
    cancelBtn.disabled = true; cancelBtn.textContent = 'İptal ediliyor…';
    N.call('updateCancel').catch(() => {});
  } }, 'İptal');
  const setBusy = (on) => {
    busy = on;
    m.dismiss = on ? false : undefined;
    const foot = box.querySelector('.foot');
    for (const b of foot.querySelectorAll('button')) if (b !== cancelBtn) b.style.display = on ? 'none' : '';
    if (on) { cancelBtn.disabled = false; cancelBtn.textContent = 'İptal'; foot.append(cancelBtn); } else cancelBtn.remove();
  };
  const off = N.on('updateProgress', (p) => {
    if (p.error) { err.textContent = p.error; prog.classList.add('hidden'); if (busy) setBusy(false); return; }
    const pct = p.total ? Math.min(100, (100 * p.done) / p.total) : 0;
    bar.style.width = pct + '%';
    if (p.installing) { cancelBtn.disabled = true; stat.textContent = 'Android kurulum onayı bekleniyor…'; } else stat.textContent = `${formatSize(p.done)} / ${formatSize(p.total)} (%${Math.round(pct)})`;
  });
  await sheet({
    title: 'Yeni sürüm var',
    body,
    onOpen: (b, mm) => { box = b; m = mm; },
    buttons: [
      { label: 'Atla', value: 'skip' },
      { label: 'Sonra', value: null },
      st.canInstall ? { label: 'İndir ve kur', value: 'install', primary: true } : null,
    ].filter(Boolean),
    onButton: async (v) => {
      if (v === 'skip') { app.setUpdate(await N.call('updateSkip', { version: st.version })); toast(`${st.version} atlandı`); return true; }
      if (v !== 'install') return true;
      if (busy) return false;
      setBusy(true); prog.classList.remove('hidden'); err.textContent = ''; bar.style.width = '0%'; stat.textContent = 'İndirme başlıyor…';
      try {
        await N.call('updateInstall');
        // indirme bitti, Android'in onay ekranı açıldı; sayfa kapatılabilir ya da tekrar denenebilir
      } catch (e) {
        err.textContent = e.message === 'İptal edildi' ? 'İndirme iptal edildi.' : e.message;
        prog.classList.add('hidden');
      }
      setBusy(false);
      return false;
    },
  });
  off();
}
