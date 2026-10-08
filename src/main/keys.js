'use strict';
// ~/.ssh altındaki anahtarları listeleme ve yeni anahtar üretme (ssh-keygen gerektirmez).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { utils } = require('ssh2');

function listKeys(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names.filter((x) => x.endsWith('.pub')).sort()) {
    try {
      const pub = fs.readFileSync(path.join(dir, n), 'utf8').trim().split('\n')[0];
      const [type, b64, ...rest] = pub.split(/\s+/);
      if (!type || !b64) continue;
      const priv = path.join(dir, n.slice(0, -4));
      out.push({
        name: n.slice(0, -4),
        type,
        comment: rest.join(' '),
        fingerprint: 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, ''),
        publicKey: pub,
        pubPath: path.join(dir, n),
        privatePath: fs.existsSync(priv) ? priv : null,
      });
    } catch {}
  }
  return out;
}

// opts: { name, type: 'ed25519'|'rsa'|'ecdsa', bits?, comment?, passphrase? }
function generateKey(dir, opts) {
  const name = String(opts.name || '').trim();
  if (!/^[\w.@-]+$/.test(name)) throw new Error('Geçersiz dosya adı (yalnızca harf, rakam, . _ - @)');
  const priv = path.join(dir, name);
  if (fs.existsSync(priv) || fs.existsSync(priv + '.pub')) throw new Error(`${priv} zaten var`);
  const type = opts.type || 'ed25519';
  const kopts = { comment: opts.comment || '' };
  if (type === 'rsa') kopts.bits = Number(opts.bits) || 4096;
  if (type === 'ecdsa') kopts.bits = Number(opts.bits) || 256;
  if (opts.passphrase) { kopts.passphrase = opts.passphrase; kopts.cipher = 'aes256-ctr'; }
  const k = utils.generateKeyPairSync(type, kopts);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(priv, k.private, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(priv + '.pub', k.public.trim() + '\n', { mode: 0o644, flag: 'wx' });
  return listKeys(dir).find((x) => x.name === name);
}

module.exports = { listKeys, generateKey };
