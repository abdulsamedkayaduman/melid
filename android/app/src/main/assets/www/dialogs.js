// Alt sayfalar (bottom sheet), sorular, bildirimler ve temalar.
import { h, icon } from './util.js';

// ---------------------------------------------------------------- modal yığını
const stack = [];
export const modalOpen = () => stack.length > 0;

/** Geri tuşu: en üstteki pencereyi kapat. Kapattıysa true. */
export function closeTop() {
  const m = stack[stack.length - 1];
  if (!m) return false;
  if (m.dismiss !== false) m.close(null);
  return true;
}

/**
 * sheet({ title, sub, body, buttons:[{label, value, primary, danger}], center, onButton(v)->bool|Promise, dismiss, cls })
 * -> Promise<value | null>
 */
export function sheet(opts) {
  return new Promise((resolve) => {
    const root = document.getElementById('modals');
    const box = h('div.sheet' + (opts.cls ? '.' + opts.cls : ''));
    const ov = h('div.ov' + (opts.center ? '.center' : ''), null, box);
    let closed = false;
    const m = {
      dismiss: opts.dismiss,
      close(v) {
        if (closed) return;
        closed = true;
        stack.splice(stack.indexOf(m), 1);
        ov.remove();
        opts.onClose?.(v);
        resolve(v);
      },
    };
    if (!opts.center) box.append(h('div.grip'));
    if (opts.title) box.append(h('h2', null, opts.title));
    if (opts.sub) box.append(h('div.sub', null, opts.sub));
    if (opts.body) box.append(h('div.body', null, opts.body));
    if (opts.buttons?.length) {
      box.append(h('div.foot', null, opts.buttons.map((b) => h('button.btn' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''), {
        type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget;
          if (opts.onButton) {
            btn.disabled = true;
            let ok;
            try { ok = await opts.onButton(b.value); } finally { btn.disabled = false; }
            if (ok === false) return;
          }
          m.close(b.value);
        },
      }, b.label))));
    }
    ov.addEventListener('click', (e) => { if (e.target === ov && opts.dismiss !== false) m.close(null); });
    // Enter -> birincil düğme (tek satırlık girişlerde)
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        const p = box.querySelector('.foot .btn.primary');
        if (p) { e.preventDefault(); p.click(); }
      }
    });
    stack.push(m);
    root.append(ov);
    opts.onOpen?.(box, m);
    const af = box.querySelector('[autofocus]');
    if (af) setTimeout(() => { af.focus(); if (af.select && af.type !== 'password') af.select(); }, 60);
  });
}

/** items: [{ icon, label, value, danger, hint } | '-'] */
export function actionSheet(title, items, sub) {
  let m;
  const body = h('div', { style: { margin: '0 -20px' } }, items.filter(Boolean).map((it) => it === '-' ? h('div.menu-sep') :
    h('button.menu-item' + (it.danger ? '.danger' : ''), { type: 'button', onclick: () => m.close(it.value) },
      it.icon ? icon(it.icon, 20) : null, h('span.grow.ellip', null, it.label), it.hint ? h('small', null, it.hint) : null)));
  return sheet({ title, sub, body, onOpen: (_, mm) => { m = mm; } });
}

export async function promptText({ title, sub, label, value = '', placeholder = '', type = 'text', ok = 'Tamam', check, mono, multiline, validate }) {
  const inp = multiline
    ? h('textarea.input' + (mono ? '.mono' : ''), { rows: 6, placeholder, spellcheck: false, autocapitalize: 'off', autocomplete: 'off' }, value)
    : h('input.input' + (mono ? '.mono' : ''), { type, value, placeholder, autofocus: true, spellcheck: false, autocapitalize: 'off', autocomplete: 'off' });
  if (multiline) inp.value = value;
  const chk = check ? h('input', { type: 'checkbox', checked: !!check.checked }) : null;
  const err = h('div.form-err');
  let out = null;
  const r = await sheet({
    title, sub,
    body: h('div', null, label ? h('label.field', null, h('span', null, label), inp) : inp,
      chk ? h('label.check', null, chk, check.label) : null, err),
    buttons: [{ label: 'Vazgeç', value: null }, { label: ok, value: 'ok', primary: true }],
    onButton: (v) => {
      if (!v) return true;
      const e = validate?.(inp.value);
      if (e) { err.textContent = e; return false; }
      out = check ? { value: inp.value, checked: chk.checked } : inp.value;
      return true;
    },
  });
  return r ? out : null;
}

export async function confirm({ title, message, ok = 'Tamam', danger, cancel = 'Vazgeç' }) {
  const r = await sheet({
    title, center: true,
    body: message ? h('p', { style: { margin: '0 0 6px', color: 'var(--text2)', wordBreak: 'break-word' } }, message) : null,
    buttons: [{ label: cancel, value: null }, { label: ok, value: 'ok', primary: !danger, danger }],
  });
  return r === 'ok';
}

// ---------------------------------------------------------------- toast
export function toast(msg, opts = {}) {
  const t = h('div.toast' + (opts.type ? '.' + opts.type : ''), null, h('span.grow', null, msg),
    opts.action ? h('button', { onclick: () => { opts.action.fn(); t.remove(); } }, opts.action.label) : null);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), opts.ms || (opts.action ? 6000 : 3000));
  return t;
}

// ---------------------------------------------------------------- SSH soruları (native "ask")
export async function handleAsk(a, settings) {
  switch (a.kind) {
    case 'hostkey': {
      const r = await sheet({
        title: a.changed ? 'Sunucu anahtarı DEĞİŞTİ!' : 'Bilinmeyen sunucu',
        sub: `${a.host}${a.port !== 22 ? ':' + a.port : ''}`,
        dismiss: false,
        body: h('div', null,
          a.changed ? h('div.warnbox', null, 'Bu sunucunun anahtarı daha önce kaydedilenden farklı. Sunucu yeniden kurulmadıysa bu bir saldırı (ortadaki adam) olabilir.') : null,
          h('p', { style: { margin: '0 0 8px', color: 'var(--text2)' } }, a.changed ? 'Yeni anahtar:' : 'Bu sunucuya ilk kez bağlanıyorsunuz. Parmak izini doğrulayın:'),
          h('div.fp', null, a.type, h('br'), a.fingerprint),
          a.changed && a.oldFingerprint ? h('div', null, h('p', { style: { margin: '10px 0 8px', color: 'var(--text2)' } }, 'Kayıtlı anahtar:'), h('div.fp', null, a.oldFingerprint)) : null),
        buttons: [
          { label: 'Reddet', value: 'no' },
          { label: 'Bir kez', value: 'once' },
          { label: a.changed ? 'Güncelle ve bağlan' : 'Kabul et', value: 'save', primary: !a.changed, danger: a.changed },
        ],
      });
      return r === 'no' || !r ? { accept: false } : { accept: true, save: r === 'save' };
    }
    case 'password':
    case 'text': {
      const pw = a.kind === 'password';
      const inp = h('input.input', { type: pw ? 'password' : 'text', autofocus: true, placeholder: a.placeholder || '', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
      const show = pw ? h('button.tb', { type: 'button', style: { position: 'absolute', right: '2px', top: '1px' }, onclick: () => { inp.type = inp.type === 'password' ? 'text' : 'password'; } }, icon('eye', 18)) : null;
      const save = a.canSave ? h('input', { type: 'checkbox', checked: settings.savePrompted !== false }) : null;
      const r = await sheet({
        title: a.title || (pw ? 'Parola' : 'Giriş'),
        sub: a.message,
        dismiss: false,
        body: h('div', null,
          a.retry ? h('div.warnbox', null, 'Parola kabul edilmedi, tekrar deneyin.') : null,
          h('div', { style: { position: 'relative' } }, inp, show),
          save ? h('label.check', null, save, 'Kaydet') : null),
        buttons: [{ label: 'Vazgeç', value: null }, { label: 'Tamam', value: 'ok', primary: true }],
      });
      return r ? { value: inp.value, save: !!save?.checked } : null;
    }
    case 'kbd': {
      const inputs = (a.prompts || []).map((p, i) => h('label.field', null, h('span', null, p.prompt),
        h('input.input', { type: p.echo ? 'text' : 'password', autofocus: i === 0, autocapitalize: 'off', autocomplete: 'off' })));
      const r = await sheet({
        title: a.title || 'Kimlik doğrulama', sub: a.message, dismiss: false,
        body: h('div', null, inputs),
        buttons: [{ label: 'Vazgeç', value: null }, { label: 'Tamam', value: 'ok', primary: true }],
      });
      return r ? { value: inputs.map((l) => l.querySelector('input').value) } : null;
    }
    case 'confirm':
      return { value: await confirm({ title: a.title || 'Onay', message: a.message, ok: 'Evet', cancel: 'Hayır' }) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- temalar (masaüstü dialogs.js ile aynı)
export const THEMES = {
  'deck-dark': { name: 'Deck Koyu', background: '#101217', foreground: '#d7dae0', cursor: '#4f9dff', selectionBackground: '#2b4a78', black: '#1b1e25', red: '#e5534b', green: '#57c785', yellow: '#e0b44a', blue: '#4f9dff', magenta: '#c678dd', cyan: '#46c1c9', white: '#c9ccd3', brightBlack: '#5c6370', brightRed: '#ff6b63', brightGreen: '#72de9e', brightYellow: '#f5cd6b', brightBlue: '#79b5ff', brightMagenta: '#dd9af0', brightCyan: '#6fdde3', brightWhite: '#ffffff' },
  xshell: { name: 'Klasik (Xshell)', background: '#000000', foreground: '#c0c0c0', cursor: '#c0c0c0', selectionBackground: '#3a3a70', black: '#000000', red: '#cd0000', green: '#00cd00', yellow: '#cdcd00', blue: '#1e90ff', magenta: '#cd00cd', cyan: '#00cdcd', white: '#e5e5e5', brightBlack: '#7f7f7f', brightRed: '#ff0000', brightGreen: '#00ff00', brightYellow: '#ffff00', brightBlue: '#5c5cff', brightMagenta: '#ff00ff', brightCyan: '#00ffff', brightWhite: '#ffffff' },
  dracula: { name: 'Dracula', background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' },
  solarized: { name: 'Solarized Dark', background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: '#274642', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496', brightBlue: '#657b83', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
  light: { name: 'Açık', background: '#fafafa', foreground: '#383a42', cursor: '#526eff', selectionBackground: '#cfe0ff', black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#a0a1a7', brightBlack: '#696c77', brightRed: '#e45649', brightGreen: '#50a14f', brightYellow: '#c18401', brightBlue: '#4078f2', brightMagenta: '#a626a4', brightCyan: '#0184bc', brightWhite: '#ffffff' },
};

export const UI_THEMES = {
  dark: { name: 'Koyu', swatch: ['#0f1115', '#1e222a', '#4f9dff'] },
  light: { name: 'Açık', swatch: ['#f4f5f7', '#e3e6eb', '#2f7de0'], light: true },
  orange: { name: 'Turuncu', swatch: ['#15110d', '#292018', '#ff8f3f'] },
  red: { name: 'Kırmızı', swatch: ['#140e10', '#2b1d22', '#ff5c70'] },
  pink: { name: 'Pembe', swatch: ['#fdf1f6', '#f5d8e5', '#df5390'], light: true },
  peach: { name: 'Şeftali', swatch: ['#fdf4ee', '#f4ddcd', '#e46f35'], light: true },
  lavender: { name: 'Lavanta', swatch: ['#f5f3fc', '#e1daf4', '#7a58d4'], light: true },
  mint: { name: 'Nane', swatch: ['#f0faf5', '#d5ece1', '#2a9a6d'], light: true },
};
