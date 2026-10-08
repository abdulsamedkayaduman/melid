# SSHDeck — Claude Code notları

Linux için Xshell + Xftp tarzı SSH terminali ve SFTP istemcisi. Electron 44, `ssh2`, `@xterm/xterm` 6.
Arayüz dili Türkçe; kullanıcıya görünen tüm metinler Türkçe kalmalı.

Bekleyen işler için `YAPILACAKLAR.md` (otomatik güncelleme, AUR paketi, electron-updater vb.).

## Komutlar

- `npm start` — uygulamayı çalıştır
- `npm run dev` — F12 ile DevTools açılabilir
- `npm test` — `test/run.sh`: Docker/Podman'da geçici sshd açar, `test/core.test.js` çekirdek testlerini çalıştırır
  (shell, bölünmüş kabuklar, exec/kaynak bilgisi, SFTP, aktarım/iptal/sürdürme, uzak ağaç tarama, anahtar üretip yükleme,
  -L/-R/-D tüneller, jump host, parolalı anahtar, parola tekrar deneme, hata mesajları)
  + sunucusuz: `test/importers.test.js` (WindTerm/Xshell), `test/store.test.js`, `test/termlog.test.js` (ANSI temizleme)
- `npm run dist` — `dist/` içine `.pacman` ve `.AppImage` (pacman için `bsdtar` gerekir: `sudo pacman -S libarchive`).
  `npmRebuild:false` — ssh2'nin opsiyonel native `cpu-features` modülü derlenmez (ssh2 onsuz saf-JS çalışır)

Değişiklikten sonra en az `npm test` çalıştır. Arayüz değişikliklerini uygulamayı açıp elle kontrol et.

## Mimari

```
src/main/main.js         Ana süreç: pencere, tüm IPC handler'ları, uiRequest() ile renderer'a soru sorma
                         (parola, host key, keyboard-interactive), uzak dosyayı yerel editörde açıp izleme,
                         dosya önizleme (preview), klasör karşılaştırma (compareDirs), oturum kaydı, uykudan uyanma olayı
src/main/ssh-manager.js  Electron'dan bağımsız (düz Node ile test edilir). Bağlantılar connId ile tutulur.
                         connect(): jump zinciri -> _connectOne() (authHandler ile agent/anahtar/parola sırası)
                         Bağlantı başına birden çok kabuk (conn.shells, sid ile; varsayılan 'main') — bölünmüş terminal.
                         openShell/write/resize/closeShell, exec(), stats() (/proc'tan CPU/RAM/disk/ağ),
                         installPublicKey() (ssh-copy-id), readFile() (önizleme), walkRemote() (eşitleme),
                         transfer() (her aktarım kendi SFTP kanalında; iptal = kanalı kapatmak; resume: aynı dosyayı atla,
                         yarımı akışla sürdür; mkdirs: üst klasörleri oluştur), startForward/stopForward (L: net.Server, D: socks.js, R: forwardIn)
                         shellCwd(): terminal dizini (/proc + $SSH_CONNECTION; aynı bağlantıdaki diğer kabukların pid'leri hariç)
src/main/termlog.js      Oturum kaydı: TermLogger (oturum adına göre klasör, dosya başına kabuk) + parçalı ANSI temizleyici
src/main/keys.js         ~/.ssh anahtarlarını listeleme, ssh2 utils ile anahtar üretme (OpenSSH biçimi)
src/main/socks.js        -D için minimal SOCKS5 (CONNECT, kimlik doğrulamasız)
src/main/store.js        sessions.json / settings.json / known_hosts.json (~/.config/SSHDeck).
                         Parola alanları safeStorage ile şifreli; renderer'a sırlar gitmez, sadece has_password bayrağı.
                         Opsiyonel ana parola: setMasterPassword/unlock/lock (AES-256-GCM + PBKDF2-SHA512, açılışta unlock);
                         etkinken sırlar enc:'mpw' ile, master anahtarı yalnız bellekte. exportData/importData: yedek
                         (ayrı yedek parolasıyla şifreli sırlar). publicSettings() master doğrulayıcıyı renderer'a sızdırmaz
src/main/sshconfig.js    ~/.ssh/config ayrıştırıcı (OpenSSH ilk-eşleşen-kazanır kuralı)
src/main/importers.js    WindTerm (user.sessions JSON) ve Xshell (.xsh INI, klasör, .xts zip) içe aktarma.
                         WindTerm parolaları: AES-256-CBC, anahtar=PBKDF2-SHA3-512(ana parola, salt=user.config application.fingerprint, 100000).
                         İçe aktarmada ana parola sorulur (uiRequest password); Xshell parolaları alınamaz (Windows DPAPI).
                         SHA3 için @noble/hashes kullanılır (Electron BoringSSL sha3-512 desteklemez); anahtar bir kez türetilir
src/preload.js           contextBridge ile window.api (contextIsolation + sandbox açık, nodeIntegration kapalı)
src/renderer/app.js      App: kenar çubuğu ağacı, sekmeler, kısayollar, broadcast, durum çubuğu, IPC olay yönlendirme
                         Sekme grupları: ekran yan yana 2 gruba bölünür (tabGroups[0|1], tab.group); her grubun kendi
                         tabbar'ı var. moveTab/Ctrl+Shift+M, sekme/oturum sürükle-bırak; sol grup boşalınca sağdaki sola geçer
src/renderer/tab.js      SessionTab: terminal bölmeleri (layout ağacı) + yerel/uzak FilePane + aktarım kuyruğu (maxTransfers,
                         yeniden dene) + klasör eşitleme + tünel penceresi + otomatik yeniden bağlanma + kaynak sorgusu
src/renderer/termpane.js TermPane: tek terminal bölmesi (xterm, arama çubuğu); kendi kabuğu sid ile
src/renderer/tools.js    Hazır komutlar (Ctrl+Shift+K seçici + düzenleyici), SSH anahtarları, açık anahtarı sunucuya yükleme
src/renderer/filepane.js FilePane: tek bir dosya paneli (adapter ile yerel/uzak), sürükle-bırak, klavye, bağlam menüsü,
                         süzgeç (Ctrl+F), önizleme (Boşluk), sütun boyutlandırma
src/renderer/dialogs.js  modal(), prompt, host key, oturum düzenleyici, ayarlar, context menu, toast, terminal temaları
src/renderer/util.js     h() DOM yardımcısı, biçimlendirme, SVG ikon seti
```

Renderer'da bundler yok: ES modülleri doğrudan yüklenir, xterm UMD dosyaları `index.html` içinde
`../../node_modules/...` yolundan gelir (paketli sürümde de asar içinde çalışır).

## Kurallar

- Yeni main↔renderer çağrısı: `main.js`'te `h('kanal', fn)` + `preload.js`'te `api` altına ekle.
- Sırlar (parola, anahtar parolası) asla renderer'a gönderilmez.
- Bir sekmede yeniden bağlanınca yeni `connId` üretilir; eski connId'den gelen olaylar yok sayılır.
- Kabuk olayları (`ssh:data`, `ssh:exit`) `sid` taşır; terminale yazan kod `tab.writeActive()` kullanmalı (etkin bölme).
- `SessionTab.panes` terminal bölmeleridir; dosya panellerinin kapsayıcısı `paneBox`.
- `app.active` odaktaki sekmedir; bölünmüşken iki grubun görünen sekmesi `tabGroups[i].active`. Boyut değişiminde `app.fitAll()`.
- Sekme düğmeleri bir kez oluşturulup yerinde güncellenir (`tabButton`); tıklarken yeniden yaratmak çift tık/sürüklemeyi bozar.
- Hata mesajları kullanıcıya Türkçe ve anlaşılır gitmeli (`friendlyError`, `cleanErr`).
