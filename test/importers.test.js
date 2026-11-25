'use strict';
// WindTerm / Xshell içe aktarma ayrıştırıcıları (sunucu gerektirmez).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const im = require('../src/main/importers');

// WindTerm
const wt = im.parseWindTerm(JSON.stringify([
  { 'session.group': 'Prod/DB', 'session.label': 'db1', 'session.port': 2222, 'session.protocol': 'SSH', 'session.target': 'root@10.0.0.5', 'session.description': 'ana db',
    'ssh.tunnels': 'web:8080:Local(localhost),8080,10.0.0.9:80;socks:Dynamic(0.0.0.0),1080,;bos:Local(localhost),0,:0;harbor:Local,5000,:5000;' },
  { 'session.group': '', 'session.label': '', 'session.port': 22, 'session.protocol': 'SSH', 'session.target': 'web.example.com' },
  { 'session.label': 'seri', 'session.protocol': 'Serial', 'session.target': '/dev/ttyUSB0' },
]));
assert.equal(wt.length, 2);
assert.deepEqual({ ...wt[0], forwards: undefined }, { name: 'db1', group: 'Prod/DB', host: '10.0.0.5', port: 2222, username: 'root', authType: 'auto', notes: 'ana db', forwards: undefined });
assert.deepEqual(wt[0].forwards.map((f) => [f.type, f.bindHost, f.bindPort, f.dstHost, f.dstPort]), [
  ['L', '127.0.0.1', 8080, '10.0.0.9', 80], ['D', '0.0.0.0', 1080, undefined, undefined], ['L', '127.0.0.1', 5000, '127.0.0.1', 5000]]);
assert.deepEqual([wt[1].name, wt[1].group, wt[1].host, wt[1].username], ['web.example.com', 'WindTerm', 'web.example.com', '']);
console.log('OK windterm');

// WindTerm parola çözme (sentetik): kendi algoritmasıyla şifreleyip geri çözüyoruz
const master = 'gizliParola!';
const fingerprint = crypto.createHash('sha512').update('rastgele').digest('base64'); // salt() gibi 88 char base64
const wtKey = crypto.pbkdf2Sync(Buffer.from(master, 'utf8'), Buffer.from(fingerprint, 'utf8'), 100000, 48, 'sha3-512');
const enc = (obj) => { const c = crypto.createCipheriv('aes-256-cbc', wtKey.subarray(0, 32), wtKey.subarray(32, 48)); return Buffer.concat([c.update(JSON.stringify(obj)), c.final()]).toString('base64'); };
const wtSessions = JSON.stringify([
  { 'session.label': 'kripto', 'session.group': 'Sec', 'session.protocol': 'SSH', 'session.target': 'ops@10.9.9.9', 'session.port': 22, 'session.autoLogin': enc({ Password: 'S3cr3t#', PasswordEnabled: true }) },
  { 'session.label': 'nopw', 'session.protocol': 'SSH', 'session.target': 'x@host2' },
]);
assert.equal(im.wtPassword(JSON.parse(wtSessions)[0]['session.autoLogin'], fingerprint, master), 'S3cr3t#');
assert.equal(im.wtPassword(JSON.parse(wtSessions)[0]['session.autoLogin'], fingerprint, 'yanlis'), null);
assert.equal(im.verifyWindTermMaster(wtSessions, fingerprint, master), true);
assert.equal(im.verifyWindTermMaster(wtSessions, fingerprint, 'yanlis'), false);
assert.equal(im.windTermHasSecrets(wtSessions), true);
const dec = im.parseWindTerm(wtSessions, { fingerprint, master });
assert.deepEqual([dec[0].password, dec[0].authType, dec[1].password], ['S3cr3t#', 'password', undefined]);
// parola verilmezse alan boş kalır
assert.equal(im.parseWindTerm(wtSessions)[0].password, undefined);
console.log('OK windterm parola çözme');

// Xshell: UTF-16LE .xsh in nested folders
const xsh = (host, user, port = 22, proto = 'SSH') => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(
  `[CONNECTION]\r\nHost=${host}\r\nPort=${port}\r\nProtocol=${proto}\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=${user}\r\nPassword=abc==\r\n[SessionInfo]\r\nDescription=not\r\n`, 'utf16le')]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melid-imp-'));
fs.mkdirSync(path.join(dir, 'Müşteri', 'Test'), { recursive: true });
fs.writeFileSync(path.join(dir, 'Müşteri', 'Test', 'app01.xsh'), xsh('192.168.1.10', 'deploy', 2200));
fs.writeFileSync(path.join(dir, 'kök.xsh'), xsh('h1', 'u1'));
fs.writeFileSync(path.join(dir, 'telnet.xsh'), xsh('h2', 'u2', 23, 'TELNET'));
const xs = im.parseXshellPaths([dir]).sort((a, b) => a.name.localeCompare(b.name));
assert.deepEqual(xs.map((s) => [s.name, s.group, s.host, s.port, s.username, s.notes]), [
  ['app01', 'Müşteri/Test', '192.168.1.10', 2200, 'deploy', 'not'], ['kök', 'Xshell', 'h1', 22, 'u1', 'not']]);
assert(!JSON.stringify(xs).includes('abc=='), 'parola aktarılmamalı');

// Xshell .xts (zip, deflate)
const zip = (entries) => {
  const locals = []; const central = []; let off = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name); const c = zlib.deflateRawSync(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(c.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(c.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, c); central.push(ch, n); off += 30 + n.length + c.length;
  }
  const cd = Buffer.concat(central); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
};
fs.writeFileSync(path.join(dir, 'export.xts'), zip([['Xshell/Sessions/Grup A/sv1.xsh', xsh('10.1.1.1', 'admin')], ['Xshell/Sessions/sv2.xsh', xsh('10.1.1.2', 'root')], ['Xshell/readme.txt', Buffer.from('x')]]));
const xt = im.parseXshellPaths([path.join(dir, 'export.xts')]);
assert.deepEqual(xt.map((s) => [s.name, s.group, s.host, s.username]), [['sv1', 'Grup A', '10.1.1.1', 'admin'], ['sv2', 'Xshell', '10.1.1.2', 'root']]);
fs.rmSync(dir, { recursive: true, force: true });
console.log('OK xshell (.xsh klasörü, UTF-16, .xts)');
