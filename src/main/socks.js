'use strict';
// Minimal SOCKS5 server (no auth, CONNECT only) used for dynamic (-D) forwarding.
const net = require('net');

function ipv6(buf) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
  return parts.join(':');
}

const REPLY = (code) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

/**
 * @param {(host:string, port:number, done:(err:Error|null, channel?:import('stream').Duplex)=>void)=>void} openChannel
 */
function createSocksServer(openChannel) {
  return net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 'greet';

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return sock.destroy();
        const n = buf[1];
        if (buf.length < 2 + n) return;
        buf = buf.subarray(2 + n);
        sock.write(Buffer.from([5, 0]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        if (buf[0] !== 5 || buf[1] !== 1) { sock.end(REPLY(7)); return; }
        const atyp = buf[3];
        let host; let off;
        if (atyp === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); off = 8; }
        else if (atyp === 3) { const l = buf[4]; if (buf.length < 7 + l) return; host = buf.subarray(5, 5 + l).toString(); off = 5 + l; }
        else if (atyp === 4) { if (buf.length < 22) return; host = ipv6(buf.subarray(4, 20)); off = 20; }
        else { sock.end(REPLY(8)); return; }
        const port = buf.readUInt16BE(off);
        const rest = buf.subarray(off + 2);
        stage = 'connecting';
        sock.removeListener('data', onData);
        sock.pause();
        openChannel(host, port, (err, ch) => {
          if (err || !ch) { sock.end(REPLY(5)); return; }
          sock.write(REPLY(0));
          if (rest.length) ch.write(rest);
          sock.pipe(ch).pipe(sock);
          ch.on('error', () => sock.destroy());
          ch.on('close', () => sock.destroy());
          sock.on('close', () => { try { ch.close ? ch.close() : ch.destroy(); } catch {} });
          sock.resume();
        });
      }
    };
    sock.on('data', onData);
  });
}

module.exports = { createSocksServer };
