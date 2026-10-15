// Bağlantı denetimi: kayıtlı oturumları sormadan dener (ana süreçte conncheck.js), sonuçları listeler,
// seçilenler silinebilir. Kapanan sunucular, değişen parolalar, silinen kullanıcılar ayıklanır.
import { h, icon } from './util.js';
import { modal, toast, confirmBox } from './dialogs.js';
import { cleanErr } from './filepane.js';

const api = window.api;

const STATES = {
  pending: { label: 'Bekliyor', ic: 'stop' },
  running: { label: 'Deneniyor…', ic: 'refresh' },
  ok: { label: 'Çalışıyor', ic: 'check' },
  auth: { label: 'Giriş başarısız', ic: 'lock' },
  input: { label: 'Bilgi eksik', ic: 'key' },
  unreachable: { label: 'Ulaşılamıyor', ic: 'x' },
  hostkey: { label: 'Sunucu anahtarı', ic: 'lock' },
  error: { label: 'Hata', ic: 'x' },
};
const CHIP_HINTS = {
  all: 'Denetlenen tüm oturumlar',
  bad: 'Silmeye aday olanlar: ulaşılamayanlar ve girişi kabul edilmeyenler ("Sorunluları seç" bunları seçer)',
  ok: 'Bağlanıldı ve kayıtlı bilgilerle giriş yapıldı',
  auth: 'Sunucuya ulaşıldı ama kayıtlı bilgiler kabul edilmedi: parola değişmiş, kullanıcı silinmiş ya da anahtar yetkisiz',
  unreachable: 'Sunucuya ulaşılamadı: kapalı, IP/ad değişmiş, port kapalı ya da zaman aşımı (VPN bağlı mı?)',
  input: 'Kayıtlı bilgi eksik: parola, kullanıcı adı ya da anahtar parolası kayıtlı değil veya 2FA gerekiyor. Elle bağlanınca sorulur',
  hostkey: 'Sunucu anahtarı değişmiş ya da henüz onaylanmamış. Yeni sunucular için "anahtarlarını kabul et" kutusunu işaretleyip yeniden denetleyin',
  error: 'Beklenmeyen hata (satırın üzerine gelince ayrıntı görünür)',
};

// "Sorunlu" sayılanlar (silmeye aday): ulaşılamayan ve girişi kabul edilmeyenler
const BAD = new Set(['unreachable', 'auth']);

/** ids: denetlenecek oturumlar (ör. tümü ya da bir grup) */
export async function checkDialog(app, ids, title = 'Bağlantıları denetle') {
  const byId = new Map(app.sessions.map((s) => [s.id, s]));
  ids = ids.filter((id) => byId.has(id));
  if (!ids.length) { toast('Denetlenecek oturum yok', 'info'); return; }
  const res = new Map(ids.map((id) => [id, { state: 'pending', message: '' }]));
  const sel = new Set();
  let filter = 'all';
  let runId = null;
  let close;

  const acceptNew = h('input', { type: 'checkbox' });
  const chips = h('div.cc-chips');
  const list = h('div.cc-list');
  const startBtn = h('button.btn.primary', { type: 'button', onclick: () => (runId ? stop() : start()) }, 'Denetle');
  const pickBad = h('button.btn', { type: 'button', onclick: () => { sel.clear(); for (const [id, r] of res) if (BAD.has(r.state)) sel.add(id); render(); } }, 'Sorunluları seç');
  const delBtn = h('button.btn.danger', { type: 'button', onclick: () => removeSelected() }, 'Seçilenleri sil');

  const counts = () => {
    const c = { all: res.size };
    for (const r of res.values()) c[r.state] = (c[r.state] || 0) + 1;
    return c;
  };
  const visible = () => ids.filter((id) => res.has(id) && (filter === 'all' || res.get(id).state === filter || (filter === 'bad' && BAD.has(res.get(id).state))));

  const render = () => {
    const c = counts();
    // Rozetler her zaman görünür (0 olsa da); üzerine gelince ne anlama geldiği yazar
    const chip = (key, label, n) => h('button.cc-chip' + (filter === key ? '.on' : '') + (key !== 'all' && key !== 'bad' ? '.s-' + key : ''),
      { type: 'button', title: CHIP_HINTS[key], onclick: () => { filter = key; render(); } }, label, h('b', null, String(n || 0)));
    chips.replaceChildren(
      chip('all', 'Tümü', c.all),
      chip('bad', 'Sorunlu', (c.unreachable || 0) + (c.auth || 0)),
      ...['ok', 'auth', 'unreachable', 'input', 'hostkey', 'error'].map((k) => chip(k, STATES[k].label, c[k])));
    const rows = visible();
    list.replaceChildren(...(rows.length ? rows.map((id) => {
      const s = byId.get(id); const r = res.get(id);
      const chk = h('input', { type: 'checkbox', checked: sel.has(id), onchange: (e) => { if (e.target.checked) sel.add(id); else sel.delete(id); updBtns(); } });
      return h('label.cc-row.s-' + r.state, null, chk,
        h('div.cc-name', null, h('b', null, s.name || s.host), s.group ? h('span.muted', null, s.group) : null),
        h('span.cc-host.mono', null, `${s.username ? s.username + '@' : ''}${s.host}${Number(s.port || 22) !== 22 ? ':' + s.port : ''}`),
        h('div.cc-state', { title: r.message || '' }, icon(STATES[r.state].ic, 14), h('span', null, r.message || STATES[r.state].label)));
    }) : [h('div.muted.cc-empty', null, 'Bu süzgeçte oturum yok')]));
    updBtns();
  };
  const updBtns = () => {
    delBtn.disabled = !sel.size || !!runId;
    delBtn.textContent = sel.size ? `Seçilenleri sil (${sel.size})` : 'Seçilenleri sil';
    pickBad.disabled = ![...res.values()].some((r) => BAD.has(r.state));
    startBtn.textContent = runId ? 'Durdur' : [...res.values()].some((r) => r.state !== 'pending') ? 'Yeniden denetle' : 'Denetle';
    acceptNew.disabled = !!runId;
  };

  // Ana süreç ilk sonuçları runId dönmeden gönderebilir: o arada gelenler saklanıp sonra işlenir
  let early = [];
  const onProgress = (rid, id, r) => {
    if (!res.has(id)) return;
    res.set(id, r);
    render();
  };
  const start = async () => {
    for (const id of ids) if (res.has(id)) res.set(id, { state: 'pending', message: '' });
    render();
    try {
      early = [];
      runId = await api.check.start([...res.keys()], { acceptNew: acceptNew.checked });
      for (const ev of early.filter((x) => x[0] === runId)) (ev[3] ? onDone(ev[0], ev[1]) : onProgress(...ev));
      early = [];
    } catch (e) { toast(cleanErr(e), 'err'); runId = null; }
    updBtns();
  };
  const stop = () => { if (runId) api.check.cancel(runId); };
  const offP = api.check.onProgress((rid, id, r) => {
    if (!runId) { early.push([rid, id, r]); return; }
    if (rid === runId) onProgress(rid, id, r);
  });
  const offD = api.check.onDone((rid, cancelled) => {
    if (!runId) { early.push([rid, cancelled, null, true]); return; }
    if (rid === runId) onDone(rid, cancelled);
  });
  function onDone(rid, cancelled) {
    runId = null;
    if (cancelled) for (const [id, r] of res) if (r.state === 'pending' || r.state === 'running') res.set(id, { state: 'pending', message: 'Durduruldu' });
    render();
    const c = counts();
    toast(`Denetim ${cancelled ? 'durduruldu' : 'bitti'}: ${c.ok || 0} çalışıyor, ${(c.unreachable || 0) + (c.auth || 0)} sorunlu`, 'info', 5000);
  }

  const removeSelected = async () => {
    const names = [...sel].map((id) => byId.get(id)?.name || id);
    const ok = await confirmBox({
      title: 'Oturumları sil', message: `${sel.size} oturum silinsin mi?`,
      detail: names.slice(0, 12).join(', ') + (names.length > 12 ? ` ve ${names.length - 12} tane daha` : '') + '. Hesap eşitlemesi açıksa diğer cihazlardan da silinir.',
      ok: 'Sil', danger: true,
    });
    if (!ok) return;
    try {
      app.sessions = await api.sessions.removeMany([...sel]);
      app.renderSidebar();
      for (const id of sel) { res.delete(id); byId.delete(id); }
      toast(`${sel.size} oturum silindi`, 'ok');
      sel.clear();
      render();
    } catch (e) { toast(cleanErr(e), 'err'); }
  };

  const body = h('div.cc', null,
    h('p.hint', null, 'Her oturuma kayıtlı bilgileriyle, hiçbir şey sormadan bağlanmayı dener ve hemen ayrılır (komut çalıştırılmaz). VPN gerekiyorsa önce bağlanın. Aynı anda 6 sunucu denenir.'),
    h('label.check', { title: 'Kapalıyken anahtarı bilinmeyen sunuculara parola gönderilmez' }, acceptNew, 'Yeni sunucuların anahtarlarını kabul et ve kaydet (ilk bağlantıdaki "Kabul et" gibi)'),
    chips, list,
    h('div.cc-foot', null, pickBad, delBtn, h('span.spacer'), startBtn, h('button.btn', { type: 'button', onclick: () => close(null) }, 'Kapat')));
  render();
  await modal({ title: `${title} (${ids.length})`, width: 860, body, buttons: [], bind: (c) => { close = c; }, cls: 'cc-modal' });
  if (runId) api.check.cancel(runId);
  offP?.(); offD?.();
}
