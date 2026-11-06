import { h, icon, uid, keyLabel } from './util.js';
import { modal, toast, confirmBox } from './dialogs.js';
import { cleanErr } from './filepane.js';

// ---------------------------------------------------------------- hazır komutlar
// settings.snippets: [{ id, name, command, run }]  run: sonuna Enter eklenip hemen çalıştırılsın mı

// Hızlı seçici (Ctrl+Shift+K): yazarak süz, Enter = etkin terminale, Shift+Enter = tüm bağlı sekmelere
export async function snippetPalette(app) {
  const all = app.settings.snippets || [];
  const input = h('input.input', { placeholder: all.length ? 'Komut ara…' : 'Henüz hazır komut yok', spellcheck: false, dataset: { noenter: '1' } });
  const list = h('div.snip-list');
  let items = []; let idx = 0; let close = null;
  const send = (sn, everywhere) => {
    const text = sn.command.replace(/\r?\n/g, '\r') + (sn.run !== false ? '\r' : '');
    close?.(null);
    if (everywhere) { app.broadcast(text); return; }
    const t = app.active;
    if (!t || !t.writeActive(text)) { toast('Bağlı bir terminal yok', 'err'); return; }
    t.activePane.term.focus();
  };
  const render = () => {
    const q = input.value.trim().toLocaleLowerCase('tr');
    items = all.filter((s) => !q || s.name.toLocaleLowerCase('tr').includes(q) || s.command.toLocaleLowerCase('tr').includes(q));
    idx = Math.min(idx, Math.max(0, items.length - 1));
    list.replaceChildren(...[...items.map((s, i) => h('div.snip-item' + (i === idx ? '.sel' : ''), {
      onmousemove: () => { if (idx !== i) { idx = i; render(); } },
      onclick: (e) => send(s, e.shiftKey),
    }, h('span.snip-name', null, s.name), h('span.snip-cmd.mono', null, s.command.split('\n')[0] + (s.command.includes('\n') ? ' …' : '')),
    s.run === false ? h('span.snip-tag', { title: 'Enter eklenmez, yalnızca yazılır' }, 'yaz') : null)),
    items.length ? null : h('div.muted.snip-empty', null, all.length ? 'Eşleşen komut yok' : 'Ayarlar › Hazır komutlar ile ekleyebilirsiniz.')].filter(Boolean));
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { idx = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) send(items[idx], e.shiftKey); }
  });
  render();
  const r = await modal({
    title: 'Hazır komutlar',
    width: 560,
    cls: 'snip-palette',
    bind: (c) => { close = c; },
    body: h('div', null, input, list,
      h('div.snip-foot.hint', null, h('span', null, h('kbd', null, 'Enter'), ' etkin terminale · ', h('kbd', null, 'Shift+Enter'), ' tüm sekmelere'),
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); close('manage'); } }, 'Düzenle…'))),
    buttons: [],
  });
  if (r === 'manage') snippetsEditor(app);
}

export async function snippetsEditor(app) {
  let list = (app.settings.snippets || []).map((s) => ({ ...s }));
  let editing = null; // düzenlenen öğenin id'si
  const box = h('div.snip-editor');
  const name = h('input.input', { placeholder: 'Ad (ör. Nginx yeniden başlat)', spellcheck: false });
  const cmd = h('textarea.input.mono', { rows: 4, placeholder: 'sudo systemctl restart nginx', spellcheck: false });
  const run = h('input', { type: 'checkbox', checked: true });
  const saveBtn = h('button.btn.sm.primary', { type: 'button' }, icon('plus', 12), 'Ekle');
  const cancelBtn = h('button.btn.sm', { type: 'button', style: { display: 'none' } }, 'Vazgeç');
  const resetForm = () => { editing = null; name.value = ''; cmd.value = ''; run.checked = true; saveBtn.lastChild.textContent = 'Ekle'; cancelBtn.style.display = 'none'; };
  const render = () => {
    box.replaceChildren(...(list.length ? list.map((s, i) => h('div.snip-row' + (editing === s.id ? '.editing' : ''), null,
      h('div.snip-main', null, h('b', null, s.name), h('div.snip-cmd.mono', null, s.command)),
      s.run === false ? h('span.snip-tag', null, 'yaz') : null,
      h('button.icon-btn', { title: 'Yukarı', disabled: i === 0, onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; render(); } }, icon('up', 13)),
      h('button.icon-btn', { title: 'Düzenle', onclick: () => { editing = s.id; name.value = s.name; cmd.value = s.command; run.checked = s.run !== false; saveBtn.lastChild.textContent = 'Güncelle'; cancelBtn.style.display = ''; render(); name.focus(); } }, icon('edit', 13)),
      h('button.icon-btn', { title: 'Sil', onclick: () => { list = list.filter((x) => x !== s); if (editing === s.id) resetForm(); render(); } }, icon('trash', 13))))
      : [h('p.muted', null, keyLabel('Sık kullandığınız komutları ekleyin; Ctrl+Shift+K ile hızlıca gönderin.'))]));
  };
  saveBtn.onclick = () => {
    const n = name.value.trim(); const c = cmd.value.replace(/\s+$/, '');
    if (!n || !c) { toast('Ad ve komut gerekli', 'err'); return; }
    if (editing) Object.assign(list.find((x) => x.id === editing), { name: n, command: c, run: run.checked });
    else list.push({ id: uid('sn'), name: n, command: c, run: run.checked });
    resetForm(); render();
  };
  cancelBtn.onclick = () => { resetForm(); render(); };
  render();
  const r = await modal({
    title: 'Hazır komutlar',
    width: 620,
    body: h('div', null, box,
      h('div.snip-form', { dataset: { noenter: '1' } },
        h('label.field', null, h('span', null, 'Ad'), name),
        h('label.field', null, h('span', null, 'Komut (birden çok satır olabilir)'), cmd),
        h('div.row', { style: { alignItems: 'center' } },
          h('label.check.inline', null, run, 'Gönderince çalıştır (sonuna Enter ekle)'), h('span.spacer'), cancelBtn, saveBtn))),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'Kaydet', value: 'ok', primary: true }],
  });
  if (r !== 'ok') return;
  if (name.value.trim() && cmd.value.trim()) saveBtn.onclick(); // formda kalan yazılmış komut kaybolmasın
  await app.saveSettings({ snippets: list });
  toast('Hazır komutlar kaydedildi', 'ok');
}

// ---------------------------------------------------------------- SSH anahtarları
export async function keysDialog(app) {
  const listEl = h('div.key-list');
  const refresh = async () => {
    let keys = [];
    try { keys = await app.api.keys.list(); } catch (e) { toast(cleanErr(e), 'err'); }
    listEl.replaceChildren(...(keys.length ? keys.map((k) => h('div.key-row', null,
      icon('key', 15),
      h('div.key-main', null,
        h('div', null, h('b', null, k.name), h('span.key-type', null, k.type.replace(/^ssh-/, '')), k.synced ? h('span.key-type', { title: 'Hesap eşitlemesiyle başka cihazdan geldi; SSHDeck içinde saklanır, ~/.ssh\'de dosyası yok' }, 'hesaptan') : null, k.comment ? h('span.muted', null, ' ' + k.comment) : null),
        h('div.mono.key-fp', null, k.fingerprint), k.privatePath || k.synced ? null : h('div.hint.warn', null, 'Özel anahtar dosyası yok')),
      h('button.btn.sm', { type: 'button', title: 'Açık anahtarı panoya kopyala', onclick: () => { app.api.clipboard.write(k.publicKey); toast('Açık anahtar kopyalandı', 'ok'); } }, 'Kopyala'),
      app.active && app.active.state === 'connected'
        ? h('button.btn.sm', { type: 'button', title: 'Etkin sekmedeki sunucuya yükle', onclick: () => installKey(app, app.active, k) }, icon('upload', 12), 'Sunucuya yükle') : null,
      k.synced ? h('button.btn.sm.danger', {
        type: 'button', title: 'Hesaptan ve eşitlenen tüm cihazlardan sil',
        onclick: async () => {
          if (!await confirmBox({ title: 'Anahtarı sil', message: `${k.name} hesaptan silinsin mi?`, detail: 'Anahtar eşitlemesi açık tüm cihazlardan kaldırılır (başka cihazın ~/.ssh klasöründeki dosyalara dokunulmaz).', ok: 'Sil', danger: true })) return;
          try { await app.api.keys.deleteSynced(k.fingerprint); await refresh(); } catch (e) { toast(cleanErr(e), 'err'); }
        },
      }, 'Sil') : null))
      : [h('p.muted', null, '~/.ssh içinde açık anahtar (.pub) bulunamadı.')]));
    return keys;
  };
  const keys = await refresh();
  const has = (n) => keys.some((k) => k.name === n);
  const f = {
    name: h('input.input', { value: has('id_ed25519') ? 'id_ed25519_sshdeck' : 'id_ed25519', spellcheck: false }),
    type: h('select.input', null, h('option', { value: 'ed25519' }, 'Ed25519 (önerilen)'), h('option', { value: 'rsa' }, 'RSA 4096'), h('option', { value: 'ecdsa' }, 'ECDSA 256')),
    comment: h('input.input', { value: 'sshdeck', spellcheck: false }),
    pass: h('input.input', { type: 'password', placeholder: 'boş bırakılabilir' }),
    pass2: h('input.input', { type: 'password' }),
  };
  f.type.onchange = () => { if (/^id_(ed25519|rsa|ecdsa)(_sshdeck)?$/.test(f.name.value)) f.name.value = `id_${f.type.value}` + (keys.some((k) => k.name === `id_${f.type.value}`) ? '_sshdeck' : ''); };
  const err = h('div.form-err');
  const generate = async () => {
    err.textContent = '';
    if (f.pass.value !== f.pass2.value) { err.textContent = 'Parolalar eşleşmiyor'; return; }
    try {
      const k = await app.api.keys.generate({ name: f.name.value.trim(), type: f.type.value, comment: f.comment.value.trim(), passphrase: f.pass.value || undefined });
      toast(`${k.name} oluşturuldu (${k.fingerprint})`, 'ok', 6000);
      f.pass.value = f.pass2.value = '';
      const now = await refresh();
      f.name.value = now.some((x) => x.name === f.name.value) ? f.name.value + '_2' : f.name.value;
    } catch (e) { err.textContent = cleanErr(e); }
  };
  await modal({
    title: 'SSH anahtarları',
    width: 640,
    body: h('div', null, listEl,
      h('div.settings-sep'),
      h('div.field-row', null, h('div', null, h('b', null, 'Yeni anahtar oluştur'), h('div.hint', null, '~/.ssh içine kaydedilir; mevcut dosyaların üzerine yazılmaz.'))),
      h('div.grid2', { dataset: { noenter: '1' } },
        h('label.field', null, h('span', null, 'Dosya adı'), f.name),
        h('label.field', null, h('span', null, 'Tür'), f.type),
        h('label.field', null, h('span', null, 'Anahtar parolası'), f.pass),
        h('label.field', null, h('span', null, 'Parola (tekrar)'), f.pass2),
        h('label.field', null, h('span', null, 'Açıklama'), f.comment),
        h('div.field', { style: { justifyContent: 'flex-end', alignItems: 'flex-end' } }, h('button.btn.primary', { type: 'button', onclick: generate }, icon('plus', 13), 'Oluştur'))),
      err),
    buttons: [{ label: 'Kapat', value: null, primary: true }],
  });
}

async function installKey(app, tab, k, updateSession) {
  try {
    const r = await app.api.ssh.installKey(tab.connId, k.pubPath || k.fingerprint);
    toast(r === 'exists' ? `${k.name} zaten sunucuda kayıtlı` : `${k.name} sunucuya eklendi (~/.ssh/authorized_keys)`, 'ok', 5000);
    if (updateSession && tab.sessionId && (k.privatePath || k.synced)) {
      await app.saveSession(k.privatePath ? { id: tab.sessionId, authType: 'key', keyPath: k.privatePath } : { id: tab.sessionId, authType: 'key', keyPath: '', keyFp: k.fingerprint });
      toast('Oturum artık bu anahtarla bağlanacak', 'ok', 5000);
    }
    return true;
  } catch (e) { toast(cleanErr(e), 'err', 6000); return false; }
}

// ssh-copy-id karşılığı: etkin sekmenin sunucusuna açık anahtar ekle
export async function installKeyDialog(app, tab) {
  if (!tab || tab.state !== 'connected') { toast('Önce bağlanın', 'err'); return; }
  let keys = [];
  try { keys = await app.api.keys.list(); } catch (e) { toast(cleanErr(e), 'err'); return; }
  keys = keys.filter((k) => k.privatePath || k.synced);
  if (!keys.length) {
    const ok = await confirmBox({ title: 'Anahtar yok', message: '~/.ssh içinde kullanılabilir bir anahtar bulunamadı.', detail: 'Şimdi yeni bir anahtar oluşturmak ister misiniz?', ok: 'Anahtar oluştur' });
    if (ok) await keysDialog(app);
    return;
  }
  const sel = h('select.input', null, keys.map((k) => h('option', { value: k.fingerprint }, `${k.name}  (${k.type.replace(/^ssh-/, '')}${k.comment ? ', ' + k.comment : ''}${k.synced ? ', hesaptan' : ''})`)));
  const upd = h('input', { type: 'checkbox', checked: !!tab.sessionId });
  const r = await modal({
    title: 'Açık anahtarı sunucuya yükle',
    width: 500,
    body: h('div', null,
      h('p', null, `Seçilen anahtar `, h('b', null, tab.statusText || tab.title), ' üzerindeki ', h('span.mono', null, '~/.ssh/authorized_keys'), ' dosyasına eklenir. Sonra parola sormadan bağlanabilirsiniz.'),
      h('label.field', null, h('span', null, 'Anahtar'), sel),
      tab.sessionId ? h('label.check', null, upd, 'Oturumu bu anahtarla bağlanacak şekilde güncelle') : null),
    buttons: [{ label: 'Vazgeç', value: null }, { label: 'Yükle', value: 'ok', primary: true }],
  });
  if (r !== 'ok') return;
  await installKey(app, tab, keys.find((k) => k.fingerprint === sel.value), upd.checked);
}
