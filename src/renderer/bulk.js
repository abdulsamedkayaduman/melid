// Toplu işler: birden çok sunucuda komut çalıştırıp çıktıları toplama ve sunucu kaynak özeti.
// Ana süreçte conncheck.js (sessiz bağlanır, işi yapar, ayrılır); olaylar check:progress / check:done.
import { h, icon, formatSize, keyLabel } from './util.js';
import { modal, toast, confirmBox } from './dialogs.js';
import { cleanErr } from './filepane.js';

const api = window.api;

/** Bir toplu işi başlatır; ilk olaylar runId dönmeden gelebilir, onlar da işlenir. Dönen nesne: { cancel, off } */
async function startJob(ids, opts, { onProgress, onDone }) {
  let runId = null; const early = [];
  const offP = api.check.onProgress((rid, id, r) => { if (!runId) early.push(['p', rid, id, r]); else if (rid === runId) onProgress(id, r); });
  const offD = api.check.onDone((rid, cancelled) => { if (!runId) early.push(['d', rid, cancelled]); else if (rid === runId) { off(); onDone(cancelled); } });
  const off = () => { offP(); offD(); };
  try { runId = await api.check.start(ids, opts); } catch (e) { off(); throw e; }
  for (const ev of early) if (ev[1] === runId) { if (ev[0] === 'p') onProgress(ev[2], ev[3]); else { off(); onDone(ev[2]); } }
  return { cancel: () => api.check.cancel(runId), off };
}

/** Oturum seçici: grup başlıklı, işaret kutulu liste. get() seçili kimlikleri verir. */
function sessionPicker(app, ids) {
  const sel = new Set(ids);
  const byGroup = new Map();
  for (const s of app.sessions.filter((x) => ids.includes(x.id))) {
    const g = s.group || 'Grupsuz';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(s);
  }
  const count = h('span.muted');
  const boxes = new Map();
  const upd = () => { count.textContent = `${sel.size} / ${ids.length} sunucu seçili`; };
  const el = h('div.bk-picker', null,
    h('div.bk-picker-head', null, count, h('span.spacer'),
      h('button.link-btn', { type: 'button', onclick: () => { for (const id of ids) sel.add(id); for (const b of boxes.values()) b.checked = true; upd(); } }, 'Tümü'),
      h('button.link-btn', { type: 'button', onclick: () => { sel.clear(); for (const b of boxes.values()) b.checked = false; upd(); } }, 'Hiçbiri')),
    h('div.bk-picker-list', null, [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0], 'tr')).map(([g, list]) => h('div', null,
      byGroup.size > 1 ? h('div.bk-group', null, g) : null,
      list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr', { numeric: true })).map((s) => {
        const b = h('input', { type: 'checkbox', checked: true, onchange: () => { if (b.checked) sel.add(s.id); else sel.delete(s.id); upd(); } });
        boxes.set(s.id, b);
        return h('label.bk-pick', { title: `${s.username ? s.username + '@' : ''}${s.host}` }, b, h('span', null, s.name || s.host));
      })))));
  upd();
  return { el, get: () => ids.filter((id) => sel.has(id)) };
}

const nameOf = (s) => (s ? s.name || s.host : '?');
const errText = (r) => (r.state === 'unreachable' ? 'Ulaşılamıyor: ' : r.state === 'auth' || r.state === 'input' ? 'Giriş yapılamadı: ' : '') + (r.message || 'Hata');

// ---------------------------------------------------------------- çoklu sunucuda komut
export async function execDialog(app, ids, title = 'Sunucularda komut çalıştır') {
  const byId = new Map(app.sessions.map((s) => [s.id, s]));
  ids = ids.filter((id) => byId.has(id));
  if (!ids.length) { toast('Seçili sunucu yok', 'info'); return; }
  const picker = sessionPicker(app, ids);
  const cmd = h('textarea.input.mono.bk-cmd', { rows: 3, placeholder: 'ör. df -h /   ·   uptime   ·   systemctl is-active nginx', spellcheck: false, 'data-noenter': '' });
  const snips = (app.settings.snippets || []).filter((x) => x.command);
  const snipSel = snips.length ? h('select.input.sm', { onchange: (e) => { const sn = snips.find((x) => x.id === e.target.value); if (sn) cmd.value = sn.command; e.target.value = ''; } },
    h('option', { value: '' }, 'Hazır komut…'), snips.map((sn) => h('option', { value: sn.id }, sn.name))) : null;
  const timeoutSel = h('select.input.sm', { title: 'Sunucu başına en uzun süre' }, [[30, '30 sn'], [60, '1 dk'], [300, '5 dk'], [600, '10 dk']].map(([v, l]) => h('option', { value: v * 1000, selected: v === 60 }, l)));
  const results = h('div.bk-results');
  const summary = h('span.muted');
  const runBtn = h('button.btn.primary', { type: 'button', onclick: () => (job ? job.cancel() : run()) }, icon('play', 13), 'Çalıştır');
  const copyBtn = h('button.btn', { type: 'button', disabled: true, onclick: () => copyAll() }, 'Çıktıları kopyala');
  const res = new Map(); // id -> sonuç
  const open = new Set();
  let job = null; let order = [];

  const outOf = (r) => (r.data ? (r.data.stdout || '') + (r.data.stderr ? (r.data.stdout ? '\n' : '') + r.data.stderr : '') : '');
  const render = () => {
    // Aynı çıktıyı veren sunucular birlikte sayılır (ör. 40 sunucudan 3'ü farklı)
    const groups = new Map();
    for (const id of order) { const r = res.get(id); if (r && r.state === 'ok') { const k = `${r.data.code}\u0000${outOf(r)}`; groups.set(k, (groups.get(k) || 0) + 1); } }
    const done = order.filter((id) => res.get(id) && res.get(id).state !== 'running').length;
    const failed = order.filter((id) => { const r = res.get(id); return r && r.state !== 'running' && (r.state !== 'ok' || r.data.code !== 0); }).length;
    summary.textContent = order.length ? `${done} / ${order.length} bitti · ${failed} hata${groups.size > 1 ? ` · ${groups.size} farklı çıktı` : groups.size === 1 && done > 1 ? ' · hepsi aynı çıktı' : ''}` : '';
    results.replaceChildren(...order.map((id) => {
      const s = byId.get(id); const r = res.get(id) || { state: 'pending' };
      const ok = r.state === 'ok';
      const out = ok ? outOf(r) : '';
      const st = r.state === 'running' ? 'run' : r.state === 'pending' ? 'wait' : !ok ? 'fail' : r.data.code === 0 ? 'ok' : 'warn';
      const same = ok ? groups.get(`${r.data.code}\u0000${out}`) : 0;
      const first = r.state === 'running' ? 'Çalışıyor…' : r.state === 'pending' ? 'Bekliyor' : !ok ? errText(r) : (out.trim().split('\n')[0] || '(çıktı yok)');
      const row = h('div.bk-row.st-' + st, null,
        h('button.bk-row-head', { type: 'button', onclick: () => { if (open.has(id)) open.delete(id); else open.add(id); render(); } },
          icon(open.has(id) ? 'expand' : 'chevron', 12), h('b', null, nameOf(s)),
          ok ? h('span.bk-code', { title: 'Çıkış kodu' }, String(r.data.code ?? '?')) : null,
          h('span.bk-first.mono', null, first),
          same > 1 && groups.size > 1 ? h('span.bk-same', { title: 'Bu çıktıyı veren sunucu sayısı' }, `×${same}`) : null),
        open.has(id) && ok ? h('pre.bk-out', null, out || '(çıktı yok)') : null,
        open.has(id) && !ok && r.message ? h('pre.bk-out', null, r.message) : null);
      return row;
    }));
    copyBtn.disabled = !order.some((id) => res.get(id) && res.get(id).state !== 'running');
  };

  const run = async () => {
    const c = cmd.value.trim();
    const sel = picker.get();
    if (!c) { toast('Komut yazın', 'err'); cmd.focus(); return; }
    if (!sel.length) { toast('En az bir sunucu seçin', 'err'); return; }
    if (sel.length > 1 && !await confirmBox({ title: 'Komutu çalıştır', message: `${sel.length} sunucuda çalıştırılsın mı?`, detail: c, ok: 'Çalıştır' })) return;
    order = sel; res.clear(); open.clear();
    render();
    try {
      job = await startJob(sel, { kind: 'exec', cmd: c, timeout: Number(timeoutSel.value) }, {
        onProgress: (id, r) => { res.set(id, r); render(); },
        onDone: (cancelled) => {
          job = null;
          runBtn.replaceChildren(icon('play', 13), 'Çalıştır');
          for (const id of order) if (!res.has(id) || res.get(id).state === 'running') res.set(id, { state: 'error', message: cancelled ? 'Durduruldu' : 'Çalıştırılmadı' });
          render();
        },
      });
      runBtn.replaceChildren(icon('stop', 13), 'Durdur');
    } catch (e) { toast(cleanErr(e), 'err'); }
  };

  const copyAll = () => {
    const txt = order.map((id) => {
      const r = res.get(id); const s = byId.get(id);
      const body = !r ? '' : r.state === 'ok' ? `${outOf(r)}${r.data.code ? `\n[çıkış kodu ${r.data.code}]` : ''}` : errText(r);
      return `=== ${nameOf(s)} (${s.host}) ===\n${body.trimEnd()}`;
    }).join('\n\n');
    api.clipboard.write(txt + '\n');
    toast('Çıktılar panoya kopyalandı', 'ok');
  };

  cmd.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!job) run(); } });
  const body = h('div.bk', null,
    h('div.bk-top', null,
      h('div.bk-left', null,
        h('label.field', null, h('span', null, keyLabel('Komut (Ctrl+Enter ile çalıştır)')), cmd),
        h('div.row', null, snipSel, h('span.muted', null, 'Zaman aşımı'), timeoutSel)),
      picker.el),
    h('div.bk-res-head', null, summary, h('span.spacer'), copyBtn, runBtn),
    results);
  await modal({ title, width: 900, body, buttons: [], cls: 'bk-modal' });
  if (job) { job.cancel(); job.off(); }
}

// ---------------------------------------------------------------- sunucu özeti
const pct = (u, t) => (t > 0 ? Math.round((100 * u) / t) : null);
const level = (p) => (p == null ? '' : p >= 90 ? '.hi' : p >= 75 ? '.mid' : '');
function bar(p, label, title) {
  return h('div.bk-bar' + level(p), { title: title || '' }, h('i', { style: { width: (p ?? 0) + '%' } }), h('span', null, label));
}
function uptimeText(sec) {
  if (!sec) return '';
  const d = Math.floor(sec / 86400); const hh = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} gün ${hh} sa` : hh ? `${hh} sa ${m} dk` : `${m} dk`;
}

export async function statsDialog(app, ids, title = 'Sunucu özeti') {
  const byId = new Map(app.sessions.map((s) => [s.id, s]));
  ids = ids.filter((id) => byId.has(id));
  if (!ids.length) { toast('Seçili sunucu yok', 'info'); return; }
  const res = new Map();
  let sortKey = 'name'; let sortDir = 1; let job = null;
  const table = h('div.bk-stats');
  const summary = h('span.muted');
  const refreshBtn = h('button.btn.primary', { type: 'button', onclick: () => (job ? job.cancel() : load()) }, icon('refresh', 13), 'Yenile');

  const val = (id, k) => {
    const r = res.get(id); const d = r && r.state === 'ok' ? r.data : null; const s = byId.get(id);
    if (k === 'name') return nameOf(s).toLocaleLowerCase('tr');
    if (!d) return -1;
    return { cpu: d.cpu ?? -1, mem: pct(d.memUsed, d.memTotal) ?? -1, disk: d.fullest ? pct(d.fullest.used, d.fullest.total) : pct(d.diskUsed, d.diskTotal) ?? -1, load: parseFloat(d.load) || 0, up: d.uptime || 0, os: d.os || '' }[k];
  };
  const cols = [['name', 'Sunucu'], ['os', 'Sistem'], ['cpu', 'CPU'], ['load', 'Yük'], ['mem', 'Bellek'], ['disk', 'En dolu disk'], ['up', 'Açık kalma']];
  const render = () => {
    const sorted = [...ids].sort((a, b) => { const x = val(a, sortKey); const y = val(b, sortKey); return (x < y ? -1 : x > y ? 1 : 0) * sortDir; });
    const okN = ids.filter((id) => res.get(id)?.state === 'ok').length;
    const warn = ids.filter((id) => { const d = res.get(id)?.data; return d && ((d.fullest && pct(d.fullest.used, d.fullest.total) >= 90) || pct(d.memUsed, d.memTotal) >= 90); }).length;
    summary.textContent = `${okN} / ${ids.length} sunucudan bilgi alındı${warn ? ` · ${warn} sunucuda bellek ya da disk %90 üstünde` : ''}`;
    table.replaceChildren(
      h('div.bk-srow.head', null, cols.map(([k, l]) => h('button', { type: 'button', onclick: () => { sortDir = sortKey === k ? -sortDir : k === 'name' || k === 'os' ? 1 : -1; sortKey = k; render(); } }, l, sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''))),
      ...sorted.map((id) => {
        const s = byId.get(id); const r = res.get(id) || { state: 'pending' };
        const nameCell = h('div.bk-sname', { title: `${s.username ? s.username + '@' : ''}${s.host}` }, h('b', null, nameOf(s)), s.group ? h('span.muted', null, s.group) : null);
        if (r.state !== 'ok') {
          return h('div.bk-srow.fail', null, nameCell, h('div.bk-smsg', null, r.state === 'running' ? 'Bilgi alınıyor…' : r.state === 'pending' ? 'Bekliyor' : errText(r)));
        }
        const d = r.data;
        const mp = pct(d.memUsed, d.memTotal);
        const disk = d.fullest || { mount: '/', used: d.diskUsed, total: d.diskTotal };
        const dp = pct(disk.used, disk.total);
        const cores = d.cores || 0;
        const loadN = parseFloat(d.load) || 0;
        return h('div.bk-srow', null, nameCell,
          h('div.bk-os', { title: d.os }, d.os || '—'),
          bar(d.cpu == null ? null : Math.round(d.cpu), d.cpu == null ? '—' : `%${Math.round(d.cpu)}${cores ? ` · ${cores} çekirdek` : ''}`),
          h('div.bk-load' + (cores && loadN > cores ? '.hi' : ''), { title: '1 / 5 / 15 dakikalık ortalama yük' + (cores ? ` (${cores} çekirdek)` : '') }, d.load || '—'),
          bar(mp, `%${mp ?? '—'} · ${formatSize(d.memUsed)} / ${formatSize(d.memTotal)}`, d.swapTotal ? `Takas: ${formatSize(d.swapUsed)} / ${formatSize(d.swapTotal)}` : ''),
          bar(dp, `${disk.mount} %${dp ?? '—'} · ${formatSize(disk.total - disk.used)} boş`, (d.disks || []).map((x) => `${x.mount}: %${pct(x.used, x.total)} (${formatSize(x.total - x.used)} boş)`).join('\n')),
          h('div.bk-up', null, uptimeText(d.uptime)));
      }));
  };

  const load = async () => {
    for (const id of ids) res.set(id, { state: 'pending' });
    render();
    try {
      job = await startJob(ids, { kind: 'stats', concurrency: 8 }, {
        onProgress: (id, r) => { res.set(id, r); render(); },
        onDone: () => { job = null; refreshBtn.replaceChildren(icon('refresh', 13), 'Yenile'); render(); },
      });
      refreshBtn.replaceChildren(icon('stop', 13), 'Durdur');
    } catch (e) { toast(cleanErr(e), 'err'); }
  };

  const body = h('div.bk', null,
    h('p.hint', { style: { margin: '0 0 8px' } }, 'Her sunucuya kayıtlı bilgileriyle bağlanıp /proc ve df ile kaynakları okur (Linux). Başlığa tıklayarak sıralayın; %75 üstü turuncu, %90 üstü kırmızı. Disk sütunu en dolu bölümü gösterir; üzerine gelince tüm diskler görünür.'),
    h('div.bk-res-head', null, summary, h('span.spacer'), refreshBtn),
    table);
  load();
  await modal({ title: `${title} (${ids.length})`, width: 1080, body, buttons: [], cls: 'bk-modal' });
  if (job) { job.cancel(); job.off(); }
}
