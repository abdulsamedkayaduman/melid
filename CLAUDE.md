# SSHDeck — Claude Code notları

Linux için Xshell + Xftp tarzı SSH terminali ve SFTP istemcisi. Electron 44, `ssh2`, `@xterm/xterm` 6.
Arayüz dili Türkçe; kullanıcıya görünen tüm metinler Türkçe kalmalı.

## Komutlar

- `npm start` — uygulamayı çalıştır
- `npm run dev` — F12 ile DevTools açılabilir
- `npm test` — `test/run.sh`: Docker/Podman'da geçici sshd açar, `test/core.test.js` çekirdek testlerini çalıştırır
  (shell, SFTP, aktarım/iptal, -L/-R/-D tüneller, jump host, parolalı anahtar, parola tekrar deneme, hata mesajları)
- `npm run dist` — `dist/` içine `.pacman` ve `.AppImage` (pacman için `bsdtar` gerekir: `sudo pacman -S libarchive`)

Değişiklikten sonra en az `npm test` çalıştır. Arayüz değişikliklerini uygulamayı açıp elle kontrol et.

## Mimari

```
src/main/main.js         Ana süreç: pencere, tüm IPC handler'ları, uiRequest() ile renderer'a soru sorma
                         (parola, host key, keyboard-interactive), uzak dosyayı yerel editörde açıp izleme
src/main/ssh-manager.js  Electron'dan bağımsız (düz Node ile test edilir). Bağlantılar connId ile tutulur.
                         connect(): jump zinciri -> _connectOne() (authHandler ile agent/anahtar/parola sırası)
                         openShell/write/resize, SFTP işlemleri, transfer() (her aktarım kendi SFTP kanalında;
                         iptal = kanalı kapatmak), startForward/stopForward (L: net.Server, D: socks.js, R: forwardIn)
src/main/socks.js        -D için minimal SOCKS5 (CONNECT, kimlik doğrulamasız)
src/main/store.js        sessions.json / settings.json / known_hosts.json (~/.config/SSHDeck).
                         Parola alanları safeStorage ile şifreli; renderer'a sırlar gitmez, sadece has_password bayrağı
src/main/sshconfig.js    ~/.ssh/config ayrıştırıcı (OpenSSH ilk-eşleşen-kazanır kuralı)
src/preload.js           contextBridge ile window.api (contextIsolation + sandbox açık, nodeIntegration kapalı)
src/renderer/app.js      App: kenar çubuğu ağacı, sekmeler, kısayollar, broadcast, durum çubuğu, IPC olay yönlendirme
src/renderer/tab.js      SessionTab: xterm + yerel/uzak FilePane + aktarım listesi + tünel penceresi
src/renderer/filepane.js FilePane: tek bir dosya paneli (adapter ile yerel/uzak), sürükle-bırak, klavye, bağlam menüsü
src/renderer/dialogs.js  modal(), prompt, host key, oturum düzenleyici, ayarlar, context menu, toast, terminal temaları
src/renderer/util.js     h() DOM yardımcısı, biçimlendirme, SVG ikon seti
```

Renderer'da bundler yok: ES modülleri doğrudan yüklenir, xterm UMD dosyaları `index.html` içinde
`../../node_modules/...` yolundan gelir (paketli sürümde de asar içinde çalışır).

## Kurallar

- Yeni main↔renderer çağrısı: `main.js`'te `h('kanal', fn)` + `preload.js`'te `api` altına ekle.
- Sırlar (parola, anahtar parolası) asla renderer'a gönderilmez.
- Bir sekmede yeniden bağlanınca yeni `connId` üretilir; eski connId'den gelen olaylar yok sayılır.
- Hata mesajları kullanıcıya Türkçe ve anlaşılır gitmeli (`friendlyError`, `cleanErr`).
