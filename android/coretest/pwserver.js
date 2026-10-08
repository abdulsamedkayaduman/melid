// Parola ve keyboard-interactive akışlarını test etmek için küçük ssh2 sunucusu (127.0.0.1:2298).
// Kullanıcı "pw" parola "secret" ile; "kbd" ise keyboard-interactive (iki soru: Password, OTP=123).
const path = require('path');
const { Server, utils } = require(path.join(__dirname, '../../node_modules/ssh2'));
const hostKey = utils.generateKeyPairSync('ed25519').private;
new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.username === 'pw' && ctx.method === 'password' && ctx.password === 'secret') return ctx.accept();
    if (ctx.username === 'kbd' && ctx.method === 'keyboard-interactive') {
      return ctx.prompt([{ prompt: 'Password: ', echo: false }, { prompt: 'OTP: ', echo: true }], (answers) => {
        if (answers[0] === 'secret' && answers[1] === '123') ctx.accept(); else ctx.reject();
      });
    }
    ctx.reject(ctx.username === 'kbd' ? ['keyboard-interactive'] : ['password']);
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (accept2, reject, info) => {
        const st = accept2();
        st.write('ran:' + info.command + '\n');
        st.exit(0);
        st.end();
      });
    });
  });
  client.on('error', () => {});
}).listen(2298, '127.0.0.1', () => console.log('ready'));
