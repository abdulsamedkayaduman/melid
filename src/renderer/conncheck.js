// Bağlantı denetimi: kayıtlı oturumları sormadan dener (ana süreçte conncheck.js), sonuçları listeler,
// seçilenler silinebilir. Kapanan sunucular, değişen parolalar, silinen kullanıcılar ayıklanır.
import { h, icon } from './util.js';
import { modal, toast, confirmBox } from './dialogs.js';
import { cleanErr } from './filepane.js';
import { execDialog } from './bulk.js';

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
  unreachable: "Sunucuya ulaşılamadı. Satırda nedeni yazar: IP'ye erişim yok (kapalı / VPN / adres değişmiş), port kapalı (sunucu ayakta ama SSH portu kapalı ya da değişmiş), ad çözülemedi (DNS) ya da port açık ama SSH yanıt vermiyor",
  input: 'Kayıtlı bilgi eksik: parola, kullanıcı adı ya da anahtar parolası kayıtlı değil veya 2FA gerekiyor. Elle bağlanınca sorulur',
  hostkey: 'Sunucu anahtarı değişmiş ya da henüz onaylanmamış. Yeni sunucular için "anahtarlarını kabul et" kutusunu işaretleyip yeniden denetleyin',
  error: 'Beklenmeyen hata (satırın üzerine gelince ayrıntı görünür)',
};

// Ulaşılamayanlarda nedenin kısa adı (ayrıntı mesajda)
const REACH = { dns: 'Ad çözülemedi', ip: "IP'ye erişim yok", port: 'Port kapalı', ssh: 'SSH yanıt vermiyor' };

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
        h('div.cc-state', { title: r.message || '' }, icon(STATES[r.state].ic, 14),
          r.state === 'unreachable' && REACH[r.reach] ? h('b.cc-reach', null, REACH[r.reach]) : null,
          h('span', null, r.message || STATES[r.state].label)),
        fixButton(id, s, r));
    }) : [h('div.muted.cc-empty', null, 'Bu süzgeçte oturum yok')]));
    updBtns();
  };
  // Düzelt: girişi kabul edilmeyen / bilgisi eksik oturumda bilgiyi sorup kaydeder ve hemen yeniden dener;
  // onaylanmamış sunucu anahtarında anahtarı kabul edip dener
  const fixButton = (id, s, r) => {
    const can = (r.state === 'auth' || r.state === 'input') && r.need || (r.state === 'hostkey' && !r.changed);
    if (!can || runId) return h('span');
    return h('button.btn.sm.cc-fix', {
      type: 'button',
      title: r.state === 'hostkey' ? 'Sunucu anahtarını kabul et ve yeniden dene' : 'Bilgileri düzelt ve yeniden dene',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); fix(id, s, r); },
    }, r.state === 'hostkey' ? 'Kabul et' : 'Düzelt');
  };
  const retry = async (id, o = {}) => {
    res.set(id, { state: 'running' });
    render();
    try { res.set(id, await api.check.one(id, o)); } catch (e) { res.set(id, { state: 'error', message: cleanErr(e) }); }
    render();
  };
  const fix = async (id, s, r) => {
    if (r.state === 'hostkey') { await retry(id, { acceptNew: true }); return; }
    const user = h('input.input', { value: s.username || '', spellcheck: false });
    const secret = h('input.input', { type: 'password', autofocus: r.need !== 'username' });
    const isPass = r.need === 'passphrase';
    const err = h('div.upd-err');
    const ok = await modal({
      title: `${s.name || s.host}: bilgileri düzelt`, width: 420,
      body: h('div', null,
        h('p.hint', { style: { marginTop: 0 } }, r.message),
        isPass ? null : h('label.field', null, h('span', null, 'Kullanıcı adı'), user),
        h('label.field', null, h('span', null, isPass ? 'Anahtar parolası' : 'Parola'), secret),
        h('p.hint', null, 'Kaydedilip bu sunucu hemen yeniden denenir.'), err),
      buttons: [{ label: 'Vazgeç', value: null }, { label: 'Kaydet ve dene', value: true, primary: true }],
      onButton: (v) => {
        if (!v) return;
        if (!isPass && !user.value.trim()) { err.textContent = 'Kullanıcı adı gerekli'; return false; }
        if (!secret.value && r.need !== 'username') { err.textContent = isPass ? 'Anahtar parolasını girin' : 'Parolayı girin'; return false; }
      },
    });
    if (!ok) return;
    const patch = { id };
    if (!isPass) patch.username = user.value.trim();
    if (secret.value) patch[isPass ? 'passphrase' : 'password'] = secret.value;
    try {
      await app.saveSession(patch);
      byId.set(id, app.sessions.find((x) => x.id === id) || s);
    } catch (e) { toast(cleanErr(e), 'err'); return; }
    await retry(id);
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
    h('div.cc-foot', null, pickBad, delBtn, h('span.spacer'),
      h('button.btn', { type: 'button', title: 'Denetimde çalışan sunucularda komut çalıştır', onclick: () => { const ok = [...res].filter(([, r]) => r.state === 'ok').map(([id]) => id); if (!ok.length) { toast('Önce denetleyin: çalışan sunucu yok', 'info'); return; } execDialog(app, ok, 'Çalışan sunucularda komut'); } }, 'Çalışanlarda komut…'),
      startBtn, h('button.btn', { type: 'button', onclick: () => close(null) }, 'Kapat')));
  render();
  await modal({ title: `${title} (${ids.length})`, width: 860, body, buttons: [], bind: (c) => { close = c; }, cls: 'cc-modal' });
  if (runId) api.check.cancel(runId);
  offP?.(); offD?.();
}
