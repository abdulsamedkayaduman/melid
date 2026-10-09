// Güncelleme penceresi: sürüm notları, indir ve kur (ana süreçte updater.js + main.js installUpdate)
import { h, icon, formatSize } from './util.js';
import { modal, toast } from './dialogs.js';

const api = window.api;

/** check: önce sunucuya sor (Ayarlar > "Şimdi denetle"); yoksa son bilinen durumu göster. */
export async function updateDialog(app, { check = false } = {}) {
  let st = app.update;
  if (check || !st) {
    try { st = await api.update.check(); } catch (e) { toast(`Güncelleme denetlenemedi: ${e.message}`, 'err', 6000); return; }
    app.setUpdate(st);
  }
  if (!st.newer) {
    toast(st.version ? `SSHDeck güncel (v${st.current})` : 'Sunucuda henüz yayınlanmış bir sürüm yok', 'ok');
    return;
  }

  const bar = h('i');
  const stat = h('span.upd-stat');
  const prog = h('div.upd-prog', { hidden: true }, h('div.upd-bar', null, bar), stat);
  const err = h('div.upd-err');
  const date = st.date ? new Date(st.date).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const body = h('div.upd', null,
    h('div.upd-ver', null, h('span', null, `v${st.current}`), icon('arrowRight', 14), h('b', null, `v${st.version}`), date ? h('span.muted', null, `· ${date}`) : null),
    st.notes ? h('pre.upd-notes', null, st.notes) : null,
    h('div.hint', null, st.canInstall
      ? `${st.kindLabel} indirilecek (${formatSize(st.size)}). Kurulumdan sonra SSHDeck yeniden açılır; açık bağlantılar kapanır.`
      : 'Bu kurulum kendiliğinden güncellenemiyor (geliştirme sürümü ya da tanınmayan paket). Yeni sürümü elle indirip kurun.'),
    prog, err);

  let busy = false;
  const setButtons = (on) => { for (const b of body.closest('.modal')?.querySelectorAll('.modal-foot button') || []) b.disabled = !on; };
  const r = await modal({
    title: 'Yeni sürüm var',
    width: 500,
    body,
    buttons: [
      { label: 'Bu sürümü atla', value: 'skip' },
      { label: 'Sonra', value: null },
      st.canInstall ? { label: 'İndir ve kur', value: 'install', primary: true } : null,
    ].filter(Boolean),
    onButton: async (v) => {
      if (v === 'skip') { app.setUpdate(await api.update.skip(st.version)); toast(`v${st.version} atlandı; sonraki sürümde yine haber verilir`); return; }
      if (v !== 'install') return;
      busy = true; setButtons(false); prog.hidden = false; err.textContent = '';
      const off = api.update.onProgress(({ done, total, installing }) => {
        const pct = total ? Math.min(100, (100 * done) / total) : 0;
        bar.style.width = pct + '%';
        stat.textContent = installing ? 'Kuruluyor… SSHDeck birazdan yeniden açılacak' : `${formatSize(done)} / ${formatSize(total)} (%${Math.round(pct)})`;
      });
      try {
        await api.update.install();
        return false; // uygulama kapanıyor; pencere açık kalsın
      } catch (e) {
        err.textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        busy = false; setButtons(true); prog.hidden = true;
        return false;
      } finally { off(); }
    },
  });
  if (busy && r == null) api.update.cancel(); // indirme sürerken pencere kapatıldı
}
