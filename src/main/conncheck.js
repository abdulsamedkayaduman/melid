'use strict';
// Kayıtlı oturumlarda toplu işler: hiçbir şey sormadan bağlanır, istenen işi yapar (denetim, komut, kaynak ölçümü),
// sonra hemen kopar. Electron'dan bağımsız (test/conncheck.test.js).
const net = require('net');
const { spawn } = require('child_process');
const { SshManager } = require('./ssh-manager');

/**
 * Sonuç durumları:
 *   ok          bağlandı ve kimlik doğrulandı (iş verildiyse onun sonucu: data)
 *   auth        sunucuya ulaşıldı ama kayıtlı bilgiler kabul edilmedi (parola değişmiş, kullanıcı yok, anahtar yetkisiz)
 *   input       kayıtlı bilgi eksik (parola / kullanıcı adı / anahtar parolası yok, 2FA): elle bağlanınca sorulur
 *   unreachable sunucuya ulaşılamadı; reach: 'dns' (ad çözülemedi) | 'ip' (IP'ye erişim yok) | 'port' (port kapalı /
 *               yanıtsız ama sunucu ayakta) | 'ssh' (port açık ama SSH yanıt vermiyor)
 *   hostkey     sunucu anahtarı değişmiş (changed: true) ya da henüz onaylanmamış
 *   error       diğer
 * need: düzeltmek için sorulacak alan ('username' | 'password' | 'passphrase')
 */

/** ping ile IP'ye erişim (ICMP kapalı sunucularda yanıltıcı olabilir; yalnız TCP yanıt vermeyince ek bilgi) */
function ping(host, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sec = String(Math.ceil(timeoutMs / 1000));
    // macOS: -W milisaniye, saniye sınırı -t
    const args = process.platform === 'win32' ? ['-n', '1', '-w', String(timeoutMs), host] : process.platform === 'darwin' ? ['-c', '1', '-t', sec, host] : ['-c', '1', '-W', sec, host];
    let p;
    try { p = spawn('ping', args, { stdio: 'ignore', windowsHide: true }); } catch { resolve(null); return; }
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, timeoutMs + 1500);
    p.on('error', () => { clearTimeout(t); resolve(null); }); // ping komutu yok
    p.on('exit', (code) => { clearTimeout(t); resolve(code === 0); });
  });
}

/** TCP yoklaması: 'open' | 'refused' | 'dns' | 'noroute' | 'timeout' */
function probe(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => { clearTimeout(t); s.destroy(); resolve(r); };
    const t = setTimeout(() => done('timeout'), timeoutMs);
    s.once('connect', () => done('open'));
    s.once('error', (e) => {
      const c = e.code || '';
      done(c === 'ECONNREFUSED' ? 'refused' : /ENOTFOUND|EAI_AGAIN|EAI_NONAME/.test(c) ? 'dns' : /EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|EADDRNOTAVAIL/.test(c) ? 'noroute' : /ETIMEDOUT/.test(c) ? 'timeout' : 'noroute');
    });
  });
}

/** Erişim teşhisi: ulaşılamıyorsa açık ve net bir sonuç, ulaşılabiliyorsa null */
async function diagnose(host, port) {
  const r = await probe(host, port);
  if (r === 'open') return null;
  if (r === 'refused') return { state: 'unreachable', reach: 'port', message: `Port kapalı: ${host} ayakta ama ${port} portunda SSH dinlemiyor (bağlantı reddedildi). Port değişmiş ya da SSH kapalı olabilir.` };
  if (r === 'dns') return { state: 'unreachable', reach: 'dns', message: `Ad çözülemedi: "${host}" bulunamadı (DNS kaydı yok ya da yalnız VPN içinde çözülüyor).` };
  if (r === 'noroute') return { state: 'unreachable', reach: 'ip', message: `IP'ye erişim yok: ${host} adresine ağ yolu yok (VPN bağlı mı? Adres değişmiş olabilir).` };
  const up = await ping(host);
  if (up) return { state: 'unreachable', reach: 'port', message: `Port yanıt vermiyor: ${host} ayakta (ping yanıt veriyor) ama ${port} portu yanıt vermiyor (güvenlik duvarı ya da yanlış port).` };
  return { state: 'unreachable', reach: 'ip', message: `IP'ye erişim yok: ${host} ne ${port} portuna ne ping'e yanıt veriyor (kapalı, adresi değişmiş ya da VPN gerekiyor).` };
}

/**
 * Sessiz bağlan + iş. task(mgr, connId) -> data (bağlantı açıkken çalışır). Sonuç: { state, message, data?, ... }
 * opts: getSession, hostKey(host, port), trustHostKey(...), acceptNew, timeout, taskTimeout
 */
async function runOne(session, opts, task) {
  const { getSession, hostKey, trustHostKey, acceptNew = false, timeout = 25000 } = opts;
  // Doğrudan bağlanılan sunucuda önce TCP: "IP'ye erişim yok" ile "port kapalı" ayrımı net olsun
  if (!session.jumpHostId) {
    const d = await diagnose(session.host, Number(session.port) || 22);
    if (d) return d;
  }
  let note = null; // bağlantı sırasında neden durduğumuzu (soru / anahtar) yakalar
  const mgr = new SshManager({
    getSession,
    verifyHostKey: ({ host, port, type, fingerprint }) => {
      const known = hostKey(host, port);
      if (known && known.fingerprint === fingerprint) return true;
      if (known) { note = { state: 'hostkey', changed: true, message: `Sunucu anahtarı DEĞİŞTİ (${host}:${port}). Sunucu yeniden kurulmuş olabilir ya da araya giren biri var; elle bağlanıp kontrol edin.` }; return false; }
      if (acceptNew) { trustHostKey(host, port, type, fingerprint); return true; }
      note = { state: 'hostkey', changed: false, message: `Sunucu anahtarı henüz onaylanmadı (${host}:${port}). Bir kez elle bağlanın ya da anahtarı kabul edip yeniden deneyin.` };
      return false;
    },
    prompt: (kind, p) => {
      if (kind === 'text') note = { state: 'input', need: 'username', message: 'Kullanıcı adı kayıtlı değil' };
      else if (kind === 'kbd') note = { state: 'input', message: 'Etkileşimli doğrulama gerekiyor (ör. 2FA kodu); elle bağlanın' };
      else if (p && p.title === 'Anahtar parolası') note = { state: 'input', need: 'passphrase', message: 'Anahtar parolası kayıtlı değil' };
      else if (p && (p.username !== undefined || /hatalı/.test(p.label || ''))) note = { state: 'auth', need: 'password', message: 'Kayıtlı parola kabul edilmedi (değişmiş ya da kullanıcı yok)' };
      else note = { state: session.authType === 'key' ? 'auth' : 'input', need: 'password', message: session.authType === 'key' ? 'Anahtar kabul edilmedi ve kayıtlı parola yok' : 'Parola kayıtlı değil' };
      return null;
    },
  });
  const id = 'job';
  let timer;
  const t0 = Date.now();
  let connected = false;
  try {
    await Promise.race([
      mgr.connect(id, session).then(() => { connected = true; }),
      new Promise((_, rej) => { timer = setTimeout(() => { rej(new Error('SSH_TIMEOUT')); mgr.disconnect(id); }, timeout); }),
    ]);
    clearTimeout(timer);
    const c = mgr.conns.get(id);
    const who = c && c.target ? `${c.target.username}@${c.target.host}` : '';
    const out = { state: 'ok', message: `Bağlanıldı${who ? ' (' + who + ')' : ''}`, ms: Date.now() - t0 };
    if (task) {
      try { out.data = await task(mgr, id); } catch (e) { return { state: 'error', message: `Bağlanıldı ama iş başarısız: ${e.message}` }; }
    }
    return out;
  } catch (e) {
    if (note) return note;
    const m = e.message || String(e);
    if (m === 'SSH_TIMEOUT' && !connected) return { state: 'unreachable', reach: 'ssh', message: `Port açık ama SSH yanıt vermiyor: ${session.host}:${session.port || 22} el sıkışmayı tamamlamadı (başka bir hizmet ya da aşırı yük).` };
    if (/Kimlik doğrulama başarısız/.test(m)) return { state: 'auth', need: 'password', message: m };
    if (/reddedildi|çözülemedi|Zaman aşımı|ulaşılamıyor|ECONNRESET|EHOSTDOWN|socket hang up/i.test(m)) return { state: 'unreachable', reach: 'ip', message: m };
    if (/Anahtar dosyası okunamadı|anahtarı bu bilgisayarda yok/.test(m)) return { state: 'auth', message: m };
    return { state: 'error', message: m };
  } finally {
    clearTimeout(timer);
    try { mgr.disconnect(id); } catch {}
  }
}

const checkOne = (session, opts) => runOne(session, opts, null);

/**
 * Oturumları sırayla (en fazla `concurrency` aynı anda) işler. onResult(id, sonuç) her biri bitince çağrılır.
 * isCancelled() true olunca yeni iş başlatılmaz. task verilmezse yalnız denetim.
 */
async function runSessions(ids, opts) {
  const { resolve, onStart = () => {}, onResult, isCancelled = () => false, concurrency = 6, task = null } = opts;
  const queue = [...ids];
  const worker = async () => {
    for (let id; (id = queue.shift()) !== undefined;) {
      if (isCancelled()) return;
      onStart(id);
      let r;
      try {
        const s = resolve(id);
        r = s ? await runOne(s, opts, task) : { state: 'error', message: 'Oturum bulunamadı' };
      } catch (e) { r = { state: /anahtarı bu bilgisayarda yok/.test(e.message) ? 'auth' : 'error', message: e.message }; }
      onResult(id, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}
const checkSessions = runSessions;

// ---------------------------------------------------------------- işler
/** Komut çalıştır: { code, stdout, stderr } (çıktı en çok 256 KB) */
const execTask = (cmd, timeout = 60000) => async (mgr, id) => {
  const r = await mgr.exec(id, cmd, { timeout });
  const cut = (s) => (s.length > 262144 ? s.slice(0, 262144) + '\n… (çıktı kısaltıldı)' : s);
  return { code: r.code, stdout: cut(r.stdout), stderr: cut(r.stderr) };
};

/** Kaynak özeti: stats() iki kez (CPU yüzdesi farktan), en dolu disk, işletim sistemi */
const statsTask = async (mgr, id) => {
  await mgr.stats(id);
  await new Promise((r) => setTimeout(r, 1000));
  const st = await mgr.stats(id);
  if (!st) throw new Error('Kaynak bilgisi alınamadı (Linux değil?)');
  const extra = await mgr.exec(id, `sh -c 'df -Pk -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null | tail -n +2; echo @@os; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"'`, { timeout: 8000 });
  const [dfPart, osPart = ''] = extra.stdout.split('@@os');
  const disks = dfPart.trim().split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 6 && /^\d+$/.test(f[1]))
    .map((f) => ({ mount: f[5], total: Number(f[1]) * 1024, used: Number(f[2]) * 1024 }));
  const fullest = disks.filter((d) => d.total > 0).sort((a, b) => b.used / b.total - a.used / a.total)[0] || null;
  return { ...st, sessions: undefined, disks, fullest, os: osPart.trim() };
};

module.exports = { runOne, checkOne, runSessions, checkSessions, execTask, statsTask, diagnose, probe };
