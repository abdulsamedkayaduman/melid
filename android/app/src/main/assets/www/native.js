// Java köprüsü (MainActivity'deki SSHDeckNative). Tarayıcıda (geliştirme) mock.js devreye girer.
import mock from './mock.js';

const N = window.SSHDeckNative || mock;

let seq = 0;
const pending = new Map();
window.__nreply = (id, err, res) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (err != null) p.reject(new Error(err === 'SSHDECK_LOCKED' ? 'Uygulama kilitli' : err)); else p.resolve(res);
};

const listeners = new Map();
window.__nevent = (list) => {
  for (const [type, data] of list) {
    for (const fn of listeners.get(type) || []) {
      try { fn(data); } catch (e) { console.error(type, e); }
    }
  }
};

/** Asenkron çağrı: Java tarafında ayrı iş parçacığında çalışır. */
export function call(method, args = {}) {
  return new Promise((resolve, reject) => {
    const id = 'r' + (++seq);
    pending.set(id, { resolve, reject });
    N.call(id, method, JSON.stringify(args));
  });
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}

// Hızlı (senkron) yollar
export const write = (c, s, data) => N.write(c, s, data);
export const resize = (c, s, cols, rows) => N.resize(c, s, cols, rows);
export const answer = (askId, value) => N.answer(askId, value == null ? 'null' : JSON.stringify(value));
export const termInput = (on) => N.termInput(!!on);
export const isMock = !window.SSHDeckNative;
