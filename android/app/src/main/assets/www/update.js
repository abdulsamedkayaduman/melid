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
    toast(st.version ? `SSHDeck güncel (${st.current})` : 'Sunucuda henüz yayınlanmış bir sürüm yok');
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
  let off = null;
  const r = await sheet({
    title: 'Yeni sürüm var',
    body,
    buttons: [
      { label: 'Atla', value: 'skip' },
      { label: 'Sonra', value: null },
      st.canInstall ? { label: 'İndir ve kur', value: 'install', primary: true } : null,
    ].filter(Boolean),
    onButton: async (v) => {
      if (v === 'skip') { app.setUpdate(await N.call('updateSkip', { version: st.version })); toast(`${st.version} atlandı`); return true; }
      if (v !== 'install') return true;
      if (busy) return false;
      busy = true; prog.classList.remove('hidden'); err.textContent = '';
      off?.();
      off = N.on('updateProgress', (p) => {
        if (p.error) { err.textContent = p.error; prog.classList.add('hidden'); busy = false; return; }
        const pct = p.total ? Math.min(100, (100 * p.done) / p.total) : 0;
        bar.style.width = pct + '%';
        stat.textContent = p.installing ? 'Android kurulum onayı bekleniyor…' : `${formatSize(p.done)} / ${formatSize(p.total)} (%${Math.round(pct)})`;
      });
      try {
        await N.call('updateInstall');
      } catch (e) {
        err.textContent = e.message;
        prog.classList.add('hidden');
      }
      busy = false;
      return false; // sayfa açık kalsın (onay ekranından dönünce tekrar denenebilir)
    },
  });
  off?.();
  if (busy && r == null) N.call('updateCancel').catch(() => {});
}
