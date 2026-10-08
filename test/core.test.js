'use strict';
const { SshManager } = require('../src/main/ssh-manager.js');
const net = require('net');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');
// Hedef sunucu: test/run.sh bir Docker konteyneri açar. Başka sunucu için ortam değişkenleri:
const H = process.env.SSHDECK_TEST_HOST || '127.0.0.1';
const P = Number(process.env.SSHDECK_TEST_PORT || 2222);
const U = process.env.SSHDECK_TEST_USER || 'deck';
const PASS = process.env.SSHDECK_TEST_PASS || 'deckpass';
const KEY = process.env.SSHDECK_TEST_KEY || path.join(__dirname, '.work', 'userkey');
const KEYPASS = process.env.SSHDECK_TEST_KEYPASS || 'kpass';

const sessions = {
  pw: { id: 'pw', host: H, port: P, username: U, authType: 'password', password: PASS },
  key: { id: 'key', host: H, port: P, username: U, authType: 'key', keyPath: KEY, jumpHostId: 'pw' },
};
const prompts = [];
let hostPrompts = 0;
const known = {};
const m = new SshManager({
  getSession: (id) => sessions[id],
  verifyHostKey: async (k) => { const kk = k.host + k.port; if (known[kk] === k.fingerprint) return true; hostPrompts++; known[kk] = k.fingerprint; return true; },
  prompt: async (kind, p) => { prompts.push([kind, p.label]); if (kind !== 'password') return null; if (p.title === 'Anahtar parolası') return KEYPASS; return global.nextPw; },
});
const statuses = [];
m.on('status', (id, s, msg) => statuses.push(`${id}:${s}:${msg}`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. password auth + shell
  await m.connect('t1', sessions.pw);
  assert.equal(hostPrompts, 1);
  let out = '';
  m.on('shell-data', (id, d, sid) => { if (id === 't1' && sid === 'main') out += d; });
  await m.openShell('t1', 120, 30);
  m.write('t1', 'echo MARK-$((6*7)); stty size\n');
  await wait(800);
  assert(out.includes('MARK-42'), 'shell echo');
  assert(out.includes('30 120'), 'pty size');
  m.resize('t1', 100, 20); m.write('t1', 'stty size\n'); await wait(500);
  assert(out.includes('20 100'), 'resize');
  console.log('OK shell');
  // terminal cwd tracking (/proc)
  assert.equal(await m.shellCwd('t1'), '/home/deck');
  m.write('t1', 'cd /etc\n'); await wait(400);
  assert.equal(await m.shellCwd('t1'), '/etc');
  m.write('t1', 'mkdir -p /tmp/x && cd /tmp/x && sh\n'); await wait(400);  // alt kabuk: ön plan süreç grubu
  assert.equal(await m.shellCwd('t1'), '/tmp/x');
  m.write('t1', 'exit\ncd\n'); await wait(400);
  console.log('OK terminal cwd');

  // 2. sftp
  const home = await m.home('t1');
  assert(home.startsWith('/'), 'home');
  await m.remove('t1', home + '/up').catch(() => {});
  const L = path.join(os.tmpdir(), 'sshdeck-test-local'); fs.rmSync(L, { recursive: true, force: true });
  fs.mkdirSync(L + '/src/sub', { recursive: true });
  fs.writeFileSync(L + '/src/a.txt', 'hello');
  fs.writeFileSync(L + '/src/sub/big.bin', Buffer.alloc(5 * 1024 * 1024, 7));
  const events = [];
  m.on('transfer', (id, e) => events.push(e));
  await m.transfer('t1', { tid: 'x1', direction: 'upload', items: [{ src: L + '/src', dst: home + '/up' }] });
  const last = events[events.length - 1];
  assert.equal(last.state, 'done', JSON.stringify(last));
  assert.equal(last.total, 5 * 1024 * 1024 + 5);
  const ls = await m.list('t1', home + '/up');
  assert.deepEqual(ls.map((e) => e.name + (e.isDir ? '/' : '')).sort(), ['a.txt', 'sub/']);
  await m.transfer('t1', { tid: 'x2', direction: 'download', items: [{ src: home + '/up', dst: L + '/down' }] });
  assert.equal(fs.readFileSync(L + '/down/a.txt', 'utf8'), 'hello');
  assert.equal(fs.statSync(L + '/down/sub/big.bin').size, 5 * 1024 * 1024);
  await m.mkdir('t1', home + '/up/nd'); await m.rename('t1', home + '/up/nd', home + '/up/nd2');
  await m.chmod('t1', home + '/up/a.txt', 0o600);
  const ls2 = await m.list('t1', home + '/up');
  assert(ls2.find((e) => e.name === 'nd2' && e.isDir));
  assert.equal(ls2.find((e) => e.name === 'a.txt').mode & 0o777, 0o600);
  // cancel
  fs.writeFileSync(L + '/huge.bin', Buffer.alloc(200 * 1024 * 1024, 1));
  const p = m.transfer('t1', { tid: 'x3', direction: 'upload', items: [{ src: L + '/huge.bin', dst: home + '/huge.bin' }] });
  await wait(150); m.cancelTransfer('t1', 'x3'); await p;
  assert.equal(events[events.length - 1].state, 'cancelled', JSON.stringify(events[events.length - 1]));
  await m.remove('t1', home + '/up'); await m.remove('t1', home + '/huge.bin').catch(() => {});
  // browsing still works after cancel
  await m.list('t1', home);
  console.log('OK sftp');

  // 2b. bölünmüş terminal: aynı bağlantıda ikinci kabuk; exec; kaynak bilgisi; önizleme okuma
  let out2 = '';
  m.on('shell-data', (id, d, sid) => { if (id === 't1' && sid === 's2') out2 += d; });
  await m.openShell('t1', 80, 24, '', 's2');
  out = ''; m.write('t1', 'echo ONLY-S2\n', 's2'); await wait(600);
  assert(out2.includes('ONLY-S2') && !out.includes('ONLY-S2'), 'ikinci kabuk ayrı');
  m.write('t1', 'cd /usr\n', 's2'); await wait(300);
  assert.equal(await m.shellCwd('t1', 's2'), '/usr');
  assert.equal(await m.shellCwd('t1'), '/home/deck');
  const exited = new Promise((r) => m.once('shell-exit', (id, sid) => r(sid)));
  m.closeShell('t1', 's2');
  assert.equal(await exited, 's2');
  m.write('t1', 'echo MAIN-ALIVE\n'); await wait(400);
  assert(out.includes('MAIN-ALIVE'), 'ana kabuk açık kalır');
  const ex = await m.exec('t1', 'echo hi; echo err >&2; exit 3');
  assert.deepEqual([ex.stdout, ex.stderr, ex.code], ['hi\n', 'err\n', 3]);
  const st1 = await m.stats('t1'); await wait(300); const st2 = await m.stats('t1');
  assert(st1.memTotal > 0 && st1.diskTotal > 0 && st1.uptime > 0 && st1.cores > 0, JSON.stringify(st1));
  assert(st1.cpu === null && typeof st2.cpu === 'number' && st2.rxRate >= 0, JSON.stringify(st2));
  // utmp tutmayan sunucuda (Alpine/musl) null; tutanda açık kabuk (pty) en az bir oturum
  assert(st2.sessions === null || st2.sessions.some((x) => x.user === U), JSON.stringify(st2.sessions));
  await m.exec('t1', 'printf "satir1\\nsatir2" > /tmp/pv.txt');
  const rf = await m.readFile('t1', '/tmp/pv.txt', 4);
  assert.deepEqual([rf.size, rf.data.toString(), rf.truncated], [13, 'sati', true]);
  console.log('OK split shells, exec, stats, readFile');

  // 2c. kaldığı yerden sürdürme + tamamlananları atlama + klasör oluşturma; uzak ağaç tarama
  fs.rmSync(L, { recursive: true, force: true }); fs.mkdirSync(L + '/r/deep', { recursive: true });
  const big = Buffer.alloc(3 * 1024 * 1024); for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
  fs.writeFileSync(L + '/r/deep/big.bin', big); fs.writeFileSync(L + '/r/small.txt', 'abc');
  await m.transfer('t1', { tid: 'r1', direction: 'upload', items: [{ src: L + '/r', dst: home + '/rs' }] });
  await m.exec('t1', `truncate -s 1000000 ${home}/rs/deep/big.bin`);
  await m.transfer('t1', { tid: 'r2', direction: 'upload', resume: true, items: [{ src: L + '/r', dst: home + '/rs' }] });
  let lastR = events[events.length - 1];
  assert.deepEqual([lastR.state, lastR.skipped, lastR.resumed], ['done', 1, 1], JSON.stringify(lastR));
  assert.equal((await m.exec('t1', `md5sum < ${home}/rs/deep/big.bin`)).stdout.split(' ')[0], require('crypto').createHash('md5').update(big).digest('hex'));
  fs.truncateSync(L + '/r/deep/big.bin', 12345);
  await m.transfer('t1', { tid: 'r3', direction: 'download', resume: true, items: [{ src: home + '/rs/deep/big.bin', dst: L + '/r/deep/big.bin' }] });
  assert(fs.readFileSync(L + '/r/deep/big.bin').equals(big), 'indirme sürdürme');
  await m.transfer('t1', { tid: 'r4', direction: 'upload', mkdirs: true, items: [{ src: L + '/r/small.txt', dst: home + '/rs/new/a/b/small.txt' }] });
  assert.equal(events[events.length - 1].state, 'done');
  const tree = await m.walkRemote('t1', home + '/rs', ['*.bin']);
  assert.deepEqual([...tree.keys()].sort(), ['deep', 'new', 'new/a', 'new/a/b', 'new/a/b/small.txt', 'small.txt']);
  assert.equal(tree.get('small.txt').size, 3);
  await m.remove('t1', home + '/rs');
  console.log('OK resume, skip, mkdirs, walkRemote');

  // 2d. anahtar üret + sunucuya yükle + o anahtarla bağlan
  const KD = path.join(os.tmpdir(), 'sshdeck-test-keys'); fs.rmSync(KD, { recursive: true, force: true });
  const nk = require('../src/main/keys.js').generateKey(KD, { name: 'yeni', comment: 'test@deck' });
  assert.equal(await m.installPublicKey('t1', nk.publicKey), 'added');
  assert.equal(await m.installPublicKey('t1', nk.publicKey), 'exists');
  await assert.rejects(m.installPublicKey('t1', "ssh-ed25519 AAAA'; rm -rf ~"), /Geçersiz/);
  await m.connect('tk', { host: H, port: P, username: U, authType: 'key', keyPath: nk.privatePath });
  m.disconnect('tk');
  console.log('OK keygen + install key');

  // 3. forwards on t1: L to sshd itself, R back to a local echo server, D socks
  const echo = net.createServer((s) => s.pipe(s)).listen(39001, '127.0.0.1');
  await m.startForward('t1', { id: 'fL', type: 'L', bindHost: '127.0.0.1', bindPort: 39002, dstHost: '127.0.0.1', dstPort: 22 });  // sunucunun kendi sshd'si
  const banner = await new Promise((res, rej) => { const s = net.connect(39002, '127.0.0.1'); s.once('data', (d) => { res(d.toString()); s.destroy(); }); s.on('error', rej); });
  assert(banner.startsWith('SSH-2.0'), 'L forward: ' + banner);
  await m.startForward('t1', { id: 'fR', type: 'R', bindHost: '127.0.0.1', bindPort: 39003, dstHost: '127.0.0.1', dstPort: 39001 });
  out = ''; m.write('t1', 'echo ping-R | timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/39003; cat >&3; head -c 7 <&3; echo"\n'); await wait(1500);
  assert(/ping-R\s*\n/.test(out.split('\n').slice(1).join('\n')), 'R forward output: ' + JSON.stringify(out));
  await m.startForward('t1', { id: 'fD', type: 'D', bindHost: '127.0.0.1', bindPort: 39004 });  // SOCKS hedefi: sunucudaki localhost:39003 (R tüneli -> yerel echo)
  const viaSocks = await new Promise((res, rej) => {
    const s = net.connect(39004, '127.0.0.1', () => s.write(Buffer.from([5, 1, 0])));
    let st = 0; let acc = Buffer.alloc(0);
    s.on('data', (d) => {
      acc = Buffer.concat([acc, d]);
      if (st === 0 && acc.length >= 2) { acc = acc.subarray(2); st = 1; const h = Buffer.from('localhost'); s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([0x98, 0x5b])])); }
      else if (st === 1 && acc.length >= 10) { assert.equal(acc[1], 0); acc = acc.subarray(10); st = 2; s.write('via-socks'); }
      if (st === 2 && acc.toString().includes('via-socks')) { res(acc.toString()); s.destroy(); }
    });
    s.on('error', rej);
  });
  assert.equal(viaSocks, 'via-socks');
  // port conflict
  await assert.rejects(m.startForward('t1', { id: 'fX', type: 'L', bindPort: 39002, dstHost: 'x', dstPort: 1 }), /Port kullanımda/);
  m.stopForward('t1', 'fL');
  await assert.rejects(new Promise((res, rej) => { const s = net.connect(39002, '127.0.0.1', res); s.on('error', rej); }));
  console.log('OK forwards (L, R, D, conflict, stop)');

  // 4. key auth with passphrase prompt through jump host
  await m.connect('t2', sessions.key);
  assert.deepEqual(prompts, [['password', 'userkey']]);
  assert.equal(hostPrompts, 1, 'host key reused');
  m.on('shell-data', (id, d) => { if (id === 't2') out += d; }); out = ''; await m.openShell('t2', 80, 24, 'echo STARTUP-OK'); await wait(1200);
  assert(out.includes('STARTUP-OK'), 'startup command via jump');
  console.log('OK key+passphrase via jump host, startup command');

  // 5. errors
  global.nextPw = 'bad'; await assert.rejects(m.connect('t3', { host: H, port: P, username: U, authType: 'password', password: 'wrong' }), /Kimlik doğrulama başarısız/);
  await assert.rejects(m.connect('t4', { host: '127.0.0.1', port: 1, username: 'deck', authType: 'password', password: 'x' }), /Bağlantı reddedildi/);
  assert(!m.conns.has('t3') && !m.conns.has('t4'));
  console.log('OK error messages');

  // 5b. wrong saved password -> prompt retry succeeds; auto mode with no keys -> password prompt
  prompts.length = 0; global.nextPw = PASS;
  await m.connect('t5', { host: H, port: P, username: U, authType: 'password', password: 'wrong' });
  assert.deepEqual(prompts.map((p) => p[1]), ['Parola hatalı, tekrar deneyin'], JSON.stringify(prompts));
  m.disconnect('t5');
  // tekrar sorulurken kullanıcı adı gösterilir; değiştirilirse yeni adla baştan bağlanılır
  {
    const seen = [];
    const mu = new SshManager({ verifyHostKey: async () => true, prompt: async (k, p) => { seen.push(p.username); return { value: PASS, username: U }; } });
    const st = [];
    mu.on('status', (id, state, msg) => st.push(state + ':' + msg));
    await mu.connect('u1', { host: H, port: P, username: 'yanlisuser', authType: 'password', password: 'wrong' });
    assert.deepEqual(seen, ['yanlisuser']);
    assert(st.some((x) => x.startsWith('connected:' + U + '@')), JSON.stringify(st));
    mu.disconnect('u1');
  }
  prompts.length = 0;
  await m.connect('t6', { host: H, port: P, username: U, authType: 'auto' });
  assert(prompts.length <= 1, JSON.stringify(prompts));
  // cancel at prompt -> closed, not error
  global.nextPw = null;
  await assert.rejects(m.connect('t7', { host: H, port: P, username: U, authType: 'password' }), (e) => e.cancelled);
  m.disconnect('t6');
  console.log('OK password retry, auto, cancel');

  // 5c. sorulan kullanıcı adı/parola "Kaydet" işaretliyse yalnız başarılı bağlantıdan sonra kaydedilir
  {
    const saved = [];
    let pwAnswers = [];
    const m2 = new SshManager({
      getSession: (id) => sessions[id],
      verifyHostKey: async () => true,
      prompt: async (kind, p) => {
        assert.equal(p.canSave, true);
        if (kind === 'text') return { value: U, save: true };
        return pwAnswers.shift() ?? null;
      },
      saveCredentials: (id, c) => saved.push([id, c]),
    });
    pwAnswers = [{ value: 'bad', save: true }, { value: PASS, save: true }];
    await m2.connect('s1', { id: 'sv', host: H, port: P, authType: 'password' });
    assert.deepEqual(saved, [['sv', { username: U, password: PASS }]]);
    m2.disconnect('s1');
    saved.length = 0;
    pwAnswers = [{ value: PASS, save: false }];
    await m2.connect('s2', { id: 'sv', host: H, port: P, username: U, authType: 'password' });
    assert.deepEqual(saved, []);
    m2.disconnect('s2');
    pwAnswers = [{ value: 'bad', save: true }, { value: 'bad', save: true }, { value: 'bad', save: true }];
    await assert.rejects(m2.connect('s3', { id: 'sv', host: H, port: P, username: U, authType: 'password' }));
    assert.deepEqual(saved, []);
    // kayıtsız (hızlı) bağlantıda kutu sunulmaz
    const m3 = new SshManager({ verifyHostKey: async () => true, prompt: async (k, p) => { assert(!p.canSave); return PASS; }, saveCredentials: () => saved.push(1) });
    await m3.connect('s4', { host: H, port: P, username: U, authType: 'password' });
    assert.deepEqual(saved, []);
    m3.disconnect('s4');
    await wait(300);
    console.log('OK save prompted credentials');
  }

  // 6. disconnect
  m.disconnect('t1'); m.disconnect('t2'); await wait(600);
  assert.equal(m.conns.size, 0);
  assert(statuses.includes('t1:closed:Bağlantı kapatıldı'), statuses.join('\n'));
  echo.close();
  console.log('ALL OK');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); console.error(statuses.join('\n')); process.exit(1); });
