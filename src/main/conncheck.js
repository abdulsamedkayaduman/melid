'use strict';
// Bağlantı denetimi: kayıtlı oturumlara hiçbir şey sormadan bağlanıp kimlik doğrulamayı dener, sonucu sınıflandırır,
// sonra hemen kopar (kabuk açılmaz). Electron'dan bağımsız (test/conncheck.test.js).
const { SshManager } = require('./ssh-manager');

/**
 * Sonuç durumları:
 *   ok          bağlandı ve kimlik doğrulandı
 *   auth        sunucuya ulaşıldı ama kayıtlı bilgiler kabul edilmedi (parola değişmiş, kullanıcı yok, anahtar yetkisiz)
 *   input       kayıtlı bilgi eksik (parola / kullanıcı adı / anahtar parolası yok, 2FA): elle bağlanınca sorulur
 *   unreachable sunucuya ulaşılamadı (kapalı, ad çözülemedi, zaman aşımı, bağlantı reddedildi)
 *   hostkey     sunucu anahtarı değişmiş ya da henüz onaylanmamış
 *   error       diğer
 */
async function checkOne(session, { getSession, hostKey, trustHostKey, acceptNew = false, timeout = 25000 }) {
  let note = null; // bağlantı sırasında neden durduğumuzu (soru / anahtar) yakalar
  const mgr = new SshManager({
    getSession,
    verifyHostKey: ({ host, port, type, fingerprint }) => {
      const known = hostKey(host, port);
      if (known && known.fingerprint === fingerprint) return true;
      if (known) { note = { state: 'hostkey', message: `Sunucu anahtarı DEĞİŞTİ (${host}:${port}). Sunucu yeniden kurulmuş olabilir ya da araya giren biri var; elle bağlanıp kontrol edin.` }; return false; }
      if (acceptNew) { trustHostKey(host, port, type, fingerprint); return true; }
      note = { state: 'hostkey', message: `Sunucu anahtarı henüz onaylanmadı (${host}:${port}). Bir kez elle bağlanın ya da "yeni sunucu anahtarlarını kabul et"i seçin.` };
      return false;
    },
    prompt: (kind, p) => {
      if (kind === 'text') note = { state: 'input', message: 'Kullanıcı adı kayıtlı değil' };
      else if (kind === 'kbd') note = { state: 'input', message: 'Etkileşimli doğrulama gerekiyor (ör. 2FA kodu)' };
      else if (p && p.title === 'Anahtar parolası') note = { state: 'input', message: 'Anahtar parolası kayıtlı değil' };
      else if (p && (p.username !== undefined || /hatalı/.test(p.label || ''))) note = { state: 'auth', message: 'Kayıtlı parola kabul edilmedi (değişmiş ya da kullanıcı yok)' };
      else note = { state: session.authType === 'key' ? 'auth' : 'input', message: session.authType === 'key' ? 'Anahtar kabul edilmedi ve kayıtlı parola yok' : 'Parola kayıtlı değil' };
      return null;
    },
  });
  const id = 'check';
  let timer;
  const t0 = Date.now();
  try {
    await Promise.race([
      mgr.connect(id, session),
      new Promise((_, rej) => { timer = setTimeout(() => { rej(new Error('Zaman aşımı')); mgr.disconnect(id); }, timeout); }),
    ]);
    const c = mgr.conns.get(id);
    const who = c && c.target ? `${c.target.username}@${c.target.host}` : '';
    return { state: 'ok', message: `Bağlanıldı${who ? ' (' + who + ')' : ''}`, ms: Date.now() - t0 };
  } catch (e) {
    if (note) return note;
    const m = e.message || String(e);
    if (/Kimlik doğrulama başarısız/.test(m)) return { state: 'auth', message: m };
    if (/reddedildi|çözülemedi|Zaman aşımı|ulaşılamıyor|ECONNRESET|EHOSTDOWN|socket hang up/i.test(m)) return { state: 'unreachable', message: m };
    if (/Anahtar dosyası okunamadı|anahtarı bu bilgisayarda yok/.test(m)) return { state: 'auth', message: m };
    return { state: 'error', message: m };
  } finally {
    clearTimeout(timer);
    try { mgr.disconnect(id); } catch {}
  }
}

/**
 * Oturumları sırayla (en fazla `concurrency` aynı anda) dener. onResult(id, sonuç) her biri bitince çağrılır.
 * isCancelled() true olunca yeni deneme başlatılmaz.
 */
async function checkSessions(ids, opts) {
  const { resolve, onStart = () => {}, onResult, isCancelled = () => false, concurrency = 6 } = opts;
  const queue = [...ids];
  const worker = async () => {
    for (let id; (id = queue.shift()) !== undefined;) {
      if (isCancelled()) return;
      onStart(id);
      let r;
      try {
        const s = resolve(id);
        r = s ? await checkOne(s, opts) : { state: 'error', message: 'Oturum bulunamadı' };
      } catch (e) { r = { state: /anahtarı bu bilgisayarda yok/.test(e.message) ? 'auth' : 'error', message: e.message }; }
      onResult(id, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

module.exports = { checkOne, checkSessions };
