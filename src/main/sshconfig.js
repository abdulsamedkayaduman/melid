'use strict';
// Parses ~/.ssh/config into session objects (Host blocks without wildcards).
const fs = require('fs');
const os = require('os');
const path = require('path');

function parseSshConfig(text) {
  const blocks = [];
  let globalOpts = {};
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s*(?:=\s*|\s+)(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      cur = { patterns: val.split(/\s+/), opts: {} };
      blocks.push(cur);
    } else if (key === 'match') {
      cur = { patterns: [], opts: {} }; // ignore Match blocks
    } else {
      const target = cur ? cur.opts : globalOpts;
      if (!(key in target)) target[key] = val; // first value wins, like OpenSSH
    }
  }
  const globRe = (p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  const matches = (b, alias) => {
    let hit = false;
    for (const p of b.patterns) {
      if (p.startsWith('!')) { if (globRe(p.slice(1)).test(alias)) return false; } else if (globRe(p).test(alias)) hit = true;
    }
    return hit;
  };
  const out = [];
  for (const b of blocks) {
    for (const alias of b.patterns) {
      if (/[*?!]/.test(alias)) continue;
      // OpenSSH semantics: blocks are applied in file order, first value for a key wins.
      const o = { ...globalOpts };
      for (const blk of blocks) {
        if (!matches(blk, alias)) continue;
        for (const [k, v] of Object.entries(blk.opts)) if (!(k in o)) o[k] = v;
      }
      const s = {
        name: alias,
        group: 'ssh config',
        host: o.hostname || alias,
        port: Number(o.port) || 22,
        username: o.user || os.userInfo().username,
        authType: o.identityfile ? 'key' : 'auto',
        keyPath: o.identityfile ? o.identityfile.replace(/^~(?=\/)/, os.homedir()) : undefined,
        forwards: [],
        _proxyJump: o.proxyjump && o.proxyjump.toLowerCase() !== 'none' ? o.proxyjump.split(',')[0].trim() : undefined,
      };
      let fi = 0;
      for (const [k, t] of [['localforward', 'L'], ['remoteforward', 'R'], ['dynamicforward', 'D']]) {
        if (!o[k]) continue;
        const parts = o[k].split(/\s+/);
        const bind = parts[0].split(':');
        const bindPort = Number(bind.pop()); const bindHost = bind.join(':') || '127.0.0.1';
        const fw = { id: `cfg${fi++}`, type: t, bindHost, bindPort, enabled: true };
        if (t !== 'D' && parts[1]) { const d = parts[1].split(':'); fw.dstPort = Number(d.pop()); fw.dstHost = d.join(':'); }
        s.forwards.push(fw);
      }
      out.push(s);
    }
  }
  return out;
}

function readSshConfig() {
  const f = path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(f)) return [];
  return parseSshConfig(fs.readFileSync(f, 'utf8'));
}

module.exports = { parseSshConfig, readSshConfig };
