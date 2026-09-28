# SSHDeck

Xshell + Xftp tarzı, Linux için SSH terminali ve SFTP dosya yöneticisi (Electron + xterm.js + ssh2).

## Kurulum (CachyOS / Arch)

Hazır paket:

```bash
sudo pacman -U sshdeck-1.0.0.pacman
sshdeck          # veya uygulama menüsünden "SSHDeck"
```

Kaynaktan çalıştırma:

```bash
tar xzf sshdeck-src.tar.gz && cd sshdeck
npm install
npm start
```

Kendi paketini üretmek için: `sudo pacman -S libarchive` (bsdtar) sonra `npm run dist` → `dist/` içinde `.pacman` ve `.AppImage`.

## Özellikler

- **Oturum yöneticisi**: gruplar (`Prod/DB` gibi iç içe), arama, sürükle-bırak ile gruba taşıma, `~/.ssh/config` içe aktarma (ProxyJump ve *Forward satırları dahil).
- **Kimlik doğrulama**: parola, özel anahtar (parolalı anahtar sorulur), ssh-agent, otomatik (agent → `~/.ssh` anahtarları → parola), klavye etkileşimli / 2FA. Yanlış parolada tekrar sorar.
- **Güvenlik**: sunucu anahtarı parmak izi doğrulaması (ilk bağlantıda sorar, değişirse MITM uyarısı). Parolalar KWallet / GNOME Keyring üzerinden şifrelenir (Electron safeStorage).
- **Terminal**: sekmeler, 256 renk, arama, seçince kopyala, sağ tık yapıştır, başlangıç komutu, kopunca Enter ile yeniden bağlanma, tüm sekmelere komut gönderme (broadcast).
- **SFTP (Xftp tarzı)**: yerel ↔ uzak çift panel, sürükle-bırak, dosya yöneticisinden sürükleyip yükleme, çift tık ile karşı tarafa aktarma, klasör aktarımı, hız/ETA, iptal, üzerine yazma sorusu, chmod, uzak dosyayı yerel editörde açıp kaydedince otomatik yükleme, “terminalde bu dizine git”.
- **Tüneller**: yerel (-L), uzak (-R), dinamik SOCKS5 (-D); oturuma kaydedilebilir veya anlık açılabilir.
- **Jump host**: başka bir oturumu bastion olarak seç, zincirleme (bastion → bastion → hedef) desteklenir.

## Kısayollar

| Tuş | İş |
|---|---|
| Ctrl+Shift+N | Yeni oturum |
| Ctrl+Shift+T | Sekmeyi çoğalt |
| Ctrl+Shift+W | Sekmeyi kapat |
| Ctrl+Tab / Alt+1..9 | Sekmeler arası geçiş |
| Ctrl+Shift+E | SFTP panelini aç/kapat |
| Ctrl+Shift+B | Oturum listesini aç/kapat |
| Ctrl+Shift+F | Terminalde ara |
| Ctrl+Shift+C / V | Kopyala / yapıştır |
| Ctrl+Shift+R | Yeniden bağlan |
| Ctrl + / − / 0 | Yazı boyutu |
| Dosya panelinde: Enter, Backspace, F2, F5, Del, Ctrl+A | Aç/aktar, üst dizin, yeniden adlandır, yenile, sil, tümünü seç |

## Testler

`npm test` — Docker/Podman'da geçici bir SSH sunucusu açıp bağlantı, SFTP, aktarım ve tünel testlerini çalıştırır.

## Veriler

`~/.config/SSHDeck/` altında: `sessions.json`, `settings.json`, `known_hosts.json`.

## Proje yapısı

```
src/main/main.js          Electron ana süreç, IPC
src/main/ssh-manager.js   Bağlantı, jump host, shell, SFTP, aktarımlar, tüneller
src/main/socks.js         -D için SOCKS5 sunucusu
src/main/store.js         Oturum/ayar/known_hosts kaydı, parola şifreleme
src/main/sshconfig.js     ~/.ssh/config ayrıştırıcı
src/preload.js            Güvenli köprü (contextIsolation + sandbox)
src/renderer/             Arayüz (app, tab, filepane, dialogs, styles)
```
