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
  let box = null;
  // İndirme sürerken: normal düğmeler gizlenir, yerine "İptal"; dışarı tıklama / Esc / X kapatmaz
  const cancelBtn = h('button.btn', { type: 'button', onclick: () => {
    cancelBtn.disabled = true; cancelBtn.textContent = 'İptal ediliyor…';
    api.update.cancel();
  } }, 'İptal');
  const setBusy = (on) => {
    busy = on;
    const foot = box.querySelector('.modal-foot');
    for (const b of foot.querySelectorAll('button')) if (b !== cancelBtn) b.style.display = on ? 'none' : '';
    box.querySelector('.modal-head .icon-btn').style.display = on ? 'none' : '';
    if (on) { cancelBtn.disabled = false; cancelBtn.textContent = 'İptal'; foot.append(cancelBtn); } else cancelBtn.remove();
  };
  await modal({
    title: 'Yeni sürüm var',
    width: 500,
    body,
    canClose: () => !busy,
    bind: () => { box = body.closest('.modal'); },
    buttons: [
      { label: 'Bu sürümü atla', value: 'skip' },
      { label: 'Sonra', value: null },
      st.canInstall ? { label: 'İndir ve kur', value: 'install', primary: true } : null,
    ].filter(Boolean),
    onButton: async (v) => {
      if (v === 'skip') { app.setUpdate(await api.update.skip(st.version)); toast(`v${st.version} atlandı; sonraki sürümde yine haber verilir`); return; }
      if (v !== 'install') return;
      if (busy) return false;
      setBusy(true); prog.hidden = false; err.textContent = ''; bar.style.width = '0%'; stat.textContent = 'İndirme başlıyor…';
      const off = api.update.onProgress(({ done, total, installing }) => {
        const pct = total ? Math.min(100, (100 * done) / total) : 0;
        bar.style.width = pct + '%';
        if (installing) { cancelBtn.disabled = true; stat.textContent = 'Kuruluyor… SSHDeck birazdan yeniden açılacak'; } else stat.textContent = `${formatSize(done)} / ${formatSize(total)} (%${Math.round(pct)})`;
      });
      try {
        await api.update.install();
        return false; // uygulama kapanıp yeniden açılıyor; pencere açık kalsın
      } catch (e) {
        const msg = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        err.textContent = msg === 'İptal edildi' ? 'İndirme iptal edildi.' : msg;
        prog.hidden = true;
        setBusy(false);
        return false;
      } finally { off(); }
    },
  });
}
