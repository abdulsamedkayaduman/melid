'use strict';
// Bağlantı denetimi (src/main/conncheck.js): bellek içi ssh2 sunucusuna karşı; sunucu/Docker gerektirmez.
const assert = require('assert');
const net = require('net');
const { Server, utils } = require('ssh2');
const { checkOne, checkSessions, runOne, execTask } = require('../src/main/conncheck');
const { fingerprint } = require('../src/main/ssh-manager');

(async () => {
  const hostKey = utils.generateKeyPairSync('ed25519');
  const srv = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'deck' && ctx.password === 'dogru') return ctx.accept();
      ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const ses = accept();
        ses.on('exec', (acc, _rej, info) => {
          const ch = acc();
          if (info.command === 'echo merhaba') { ch.write('merhaba\n'); ch.exit(0); } else { ch.stderr.write('yok\n'); ch.exit(127); }
          ch.end();
        });
      });
    });
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const fp = fingerprint(utils.parseKey(hostKey.public).getPublicSSH());
  // kapalı port
  const tmp = net.createServer(); await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const closedPort = tmp.address().port; tmp.close();

  const known = {};
  const opts = (extra) => ({
    getSession: () => null,
    hostKey: (h, p) => known[`${h}:${p}`],
    trustHostKey: (h, p, type, f) => { known[`${h}:${p}`] = { type, fingerprint: f }; },
    timeout: 5000,
    ...extra,
  });
  const s = (o) => ({ id: 'x', host: '127.0.0.1', port, username: 'deck', authType: 'password', ...o });

  let r = await checkOne(s({ password: 'dogru' }), opts());
  assert.equal(r.state, 'hostkey', 'onaylanmamış sunucu anahtarı: bağlanılmaz');
  assert(!known[`127.0.0.1:${port}`]);
  r = await checkOne(s({ password: 'dogru' }), opts({ acceptNew: true }));
  assert.equal(r.state, 'ok', r.message);
  assert.equal(known[`127.0.0.1:${port}`].fingerprint, fp, 'kabul edilen anahtar kaydedildi');
  r = await checkOne(s({ password: 'yanlis' }), opts());
  assert.equal(r.state, 'auth', r.message);
  r = await checkOne(s({}), opts());
  assert.equal(r.state, 'input', r.message);
  r = await checkOne(s({ username: undefined, password: 'dogru' }), opts());
  assert.equal(r.state, 'input', r.message);
  r = await checkOne(s({ port: closedPort, password: 'x' }), opts());
  assert.equal(r.state, 'unreachable', r.message);
  assert.equal(r.reach, 'port', 'kapalı port: IP ayakta, port kapalı');
  assert.match(r.message, /Port kapalı/);
  r = await checkOne(s({ host: 'yok.invalid', password: 'x' }), opts());
  assert.equal(r.state, 'unreachable', r.message);
  assert.equal(r.reach, 'dns');
  // TCP açık ama SSH konuşmayan hizmet
  const mute = net.createServer(() => {}); await new Promise((res) => mute.listen(0, '127.0.0.1', res));
  r = await checkOne(s({ port: mute.address().port, password: 'x' }), opts({ timeout: 1500 }));
  assert.equal(r.reach, 'ssh', r.message);
  mute.close();
  r = await checkOne(s({ password: 'yanlis' }), opts());
  assert.equal(r.need, 'password', 'düzeltmek için parola sorulur');
  known[`127.0.0.1:${port}`] = { fingerprint: 'SHA256:baska' };
  r = await checkOne(s({ password: 'dogru' }), opts());
  assert.equal(r.state, 'hostkey', r.message);
  assert.match(r.message, /DEĞİŞTİ/);
  known[`127.0.0.1:${port}`] = { fingerprint: fp };
  console.log('OK tek oturum sınıflandırma ve erişim teşhisi');
  r = await runOne(s({ password: 'dogru' }), opts(), execTask('echo merhaba'));
  assert.deepEqual(r.data, { code: 0, stdout: 'merhaba\n', stderr: '' });
  r = await runOne(s({ password: 'dogru' }), opts(), execTask('olmayan'));
  assert.equal(r.data.code, 127);
  console.log('OK komut çalıştırma');

  const sessions = { a: s({ id: 'a', password: 'dogru' }), b: s({ id: 'b', password: 'eski' }), c: s({ id: 'c', port: closedPort }) };
  const out = {};
  await checkSessions(['a', 'b', 'c', 'd'], opts({ resolve: (id) => sessions[id], onResult: (id, x) => { out[id] = x.state; } }));
  assert.deepEqual(out, { a: 'ok', b: 'auth', c: 'unreachable', d: 'error' });
  console.log('OK toplu denetim');
  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
