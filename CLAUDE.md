# Melid — Claude Code notları

Linux, Windows ve macOS için Xshell + Xftp tarzı SSH terminali ve SFTP istemcisi. Electron 44, `ssh2`, `@xterm/xterm` 6.
Arayüz Türkçe ve İngilizce. Koddaki kullanıcı metinleri Türkçe yazılır; İngilizcesi `src/renderer/locales/en.js`'e
(Türkçe metin anahtarıyla; değişkenli metin `{0}` kalıbıyla) eklenmeli, yoksa İngilizce arayüzde Türkçe görünür. Çeviri
ekrana eklenen metinlere kendiliğinden uygulanır (`src/renderer/i18n.js`); terminale yazılan ve ana süreçteki yerel pencere
metinleri `t()` / `T()` ister. Kullanıcı içeriği gösteren yeni öğeye `translate="no"` ya da i18n.js `NO_TR` sınıfı verin.
Web sayfaları: `server/pages/*.html` (Türkçe) + `*.en.html`; ikisi birlikte güncellenmeli.

Bekleyen işler için `YAPILACAKLAR.md` (otomatik güncelleme, AUR paketi, electron-updater vb.).

## Komutlar

- `npm start` — uygulamayı çalıştır
- `npm run dev` — F12 ile DevTools açılabilir
- `npm test` — `test/run.sh`: Docker/Podman'da geçici sshd açar, `test/core.test.js` çekirdek testlerini çalıştırır
  (shell, bölünmüş kabuklar, exec/kaynak bilgisi, SFTP, aktarım/iptal/sürdürme, uzak ağaç tarama, anahtar üretip yükleme,
  -L/-R/-D tüneller, jump host, parolalı anahtar, parola tekrar deneme, hata mesajları, uzak->uzak ve doğrudan aktarım)
  Docker yoksa: root'la ayrı bir sshd (örn. 127.0.0.1:3161, `deck`/`deckpass`, test/.work/userkey.pub) açıp
  `env -u SSH_AUTH_SOCK MELID_TEST_PORT=3161 node test/core.test.js`. `ci/test-sshd.sh`'yi geliştirme makinesinde
  çalıştırmayın: çalışan tüm sshd'leri durdurur
  + sunucusuz: `test/importers.test.js` (WindTerm/Xshell), `test/store.test.js`, `test/termlog.test.js` (ANSI temizleme),
  `test/sync.test.js` (hesap eşitlemesi: gerçek eşitleme sunucusu + iki cihaz), `test/conncheck.test.js` (bellek içi ssh2 sunucusu)
- `npm run dist` — `dist/` içine `.pacman` ve `.AppImage` (pacman için `bsdtar` gerekir: `sudo pacman -S libarchive`).
  `npmRebuild:false` — ssh2'nin opsiyonel native `cpu-features` modülü derlenmez (ssh2 onsuz saf-JS çalışır)
- `npm run dist:win` — Windows 10/11 x64: `Melid-<sürüm>-kurulum.exe` (NSIS) + `Melid-<sürüm>-tasinabilir.exe`.
  Linux'ta NSIS kurulumu için `wine` gerekir; wine'sız yalnız `npx electron-builder --win portable zip` çalışır.
  İmzasız: SmartScreen ilk açılışta uyarır ("Ek bilgi" -> "Yine de çalıştır")

- `npm run dist:mac` — macOS arm64 + x64: `Melid-<sürüm>-mac-<mimari>.tar.gz`. Linux'ta üretilir; `.zip` sembolik bağları bozar,
  `.dmg` için Mac gerekir. İmzasız: ilk kurulum adımları `docs/ci.md`

Kod: https://github.com/abdulsamedkayaduman/melid. CI: `.github/workflows/derle.yml` (GitHub Actions; main'e push'ta testler,
elle başlatma veya `vX.Y.Z` etiketinde Linux + Windows + macOS + imzalı APK, GitHub Releases + imzalı latest.json).
Ayrıntılar ve gereken secret'lar: `docs/ci.md`. Sürüm tek yerde: `package.json`.

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
                         yarımı akışla sürdür; mkdirs: üst klasörleri oluştur; direction 'relay' + srcConnId: uzak -> uzak,
                         _relay() + sftpCopy() iki SFTP kanalı arasında paralel parça kopyası; t.direct = kullanıcının
                         seçtiği yöntem ('key' | 'agent', tab.askRelayMethod penceresi): _direct() kaynak `tar | ssh hedef
                         'tar x'` ile kendisi gönderir. 'key': hedefe restrict,command="mkdir+tar -x",expiry-time (30 dk)
                         satırı; GNU tar ve süre sınırı şart; bitince/iptalde silinip denetlenir (olay: keys {ok, detail}).
                         'agent': agent yalnız o komuta yönlendirilir. Hedef sunucu anahtarı kaynağa HostKeyAlias ile
                         verilir. Olmazsa bu bilgisayar üzerinden (olay: fallback)), startForward/stopForward (L: net.Server, D: socks.js, R: forwardIn)
                         shellCwd(): terminal dizini (/proc + $SSH_CONNECTION; aynı bağlantıdaki diğer kabukların pid'leri hariç)
src/main/updater.js      Güncelleme: imzalı latest.json (GitHub Releases, sunucu /guncelleme; Ed25519 açık anahtar gömülü),
                         check()/download() (sha256). Kurulum türü + kurulum main.js installUpdate(): NSIS sessiz,
                         taşınabilir exe (cmd betiği), AppImage (yerine yaz), pacman (pkexec). Akış: ci/update-feed.js
src/main/sync.js         Hesap eşitlemesi (AccountSync): giriş/kayıt/çıkış/parola değişimi, uçtan uca şifreli kasa,
                         syncNow() (al -> mergeVaults -> uygula -> 409'da yeniden dene). store.onChange ile tetiklenir.
                         scanLan(): yerel ağda 3150 portu açık sunucu arama. Kurtarma anahtarı: createRecovery/recover.
                         Hazır komutlar kasada komut başına (snippets haritası; store.js stampSnippets/snippetMap). İsteğe bağlı SSH anahtarı eşitlemesi
                         (settings.syncKeys, cihaza özgü; kasada keys, oturumda keyFp; gelen anahtarlar store.keys). Sunucu: server/sync-server.js (bağımsız,
                         bağımlılıksız; server/Dockerfile + docker-compose.yml, Dokploy). Kayıt herkese açık (MELID_REGISTER),
                         e-posta zorunlu; / tanıtım+indirme (server/pages/home.html), /admin yönetici (MELID_ADMIN_IPS +
                         MELID_ADMIN_KEY), /guncelleme: UPDATE_FEED_URL'deki latest.json. Genel sunucu melid.abdulsamed.net
                         (DEFAULT_SERVER; dokploy.abdulsamed.net, GitHub'dan; deploy elle). Ayrıntı: docs/senkron.md
src/main/conncheck.js    Toplu işler: ayrı, sormayan SshManager ile oturumlara bağlanır (runOne/runSessions), önce TCP yoklaması
                         + gerekirse ping ile erişim teşhisi (reach: dns/ip/port/ssh), sonra iş: denetim (sınıflandırma
                         ok/auth/input/unreachable/hostkey/error, need: düzeltmek için sorulacak alan), execTask (komut),
                         statsTask (kaynak özeti). IPC check:start {kind}/check:one. Arayüz: src/renderer/conncheck.js
                         (denetim, Düzelt, toplu sil) ve src/renderer/bulk.js (sunucularda komut, sunucu özeti).
                         Bilinmeyen sunucu anahtarına yalnız seçilirse güvenir.
src/main/usage.js        Kullanım sayıları (usage.json, günlük bağlantı/aktarım/tünel); sync.js eşitlemeden sonra saatte bir
                         gönderir (POST /api/usage), ayar usageStats kapatır. Android: app/UsageStats.java. Gizlilik: /kosullar
                         Yerel terminal: main.js localShells (@lydell/node-pty, hazır derlenmiş N-API; asarUnpack). Sekme SSH gibi:
                         ssh:connect {session:{local:true, shell}} + aynı ssh:shell/write/resize kanalları; tab.isLocal (SFTP/tünel yok).
                         Kabuklar localShells.list() (Windows: pwsh, powershell, cmd, Git Bash, WSL; Unix: $SHELL + /etc/shells),
                         ayar localShell; + düğmesine sağ tık hepsini listeler. SFTP yerel başlangıç dizini startLocalDir():
                         oturum localDir > groupLocalDirs (en yakın üst grup) > settings.localDir > ev (hepsi cihaza özgü)
                         Mac paketi Linux'ta derlendiği için CI darwin ikililerini ayrıca kurar (derle.yml mac).
src/main/termlog.js      Oturum kaydı: TermLogger (oturum adına göre klasör, dosya başına kabuk) + parçalı ANSI temizleyici
src/main/keys.js         ~/.ssh anahtarlarını listeleme, ssh2 utils ile anahtar üretme (OpenSSH biçimi)
src/main/socks.js        -D için minimal SOCKS5 (CONNECT, kimlik doğrulamasız)
src/main/store.js        sessions.json / settings.json / known_hosts.json (~/.config/Melid).
                         Parola alanları safeStorage ile şifreli; renderer'a sırlar gitmez, sadece has_password bayrağı.
                         Opsiyonel ana parola: setMasterPassword/unlock/lock (AES-256-GCM + PBKDF2-SHA512, açılışta unlock);
                         etkinken sırlar enc:'mpw' ile, master anahtarı yalnız bellekte. exportData/importData: yedek
                         (ayrı yedek parolasıyla şifreli sırlar). publicSettings() master doğrulayıcıyı renderer'a sızdırmaz
src/main/sshconfig.js    ~/.ssh/config ayrıştırıcı (OpenSSH ilk-eşleşen-kazanır kuralı)
src/main/importers.js    WindTerm (user.sessions JSON) ve Xshell (.xsh INI, klasör, .xts zip) içe aktarma.
                         WindTerm parolaları: AES-256-CBC, anahtar=PBKDF2-SHA3-512(ana parola, salt=user.config application.fingerprint, 100000).
                         İçe aktarmada ana parola sorulur (uiRequest password). Xshell parolaları: RC4, anahtar Windows kullanıcı adı + SID
                         ya da Xshell ana parolası (xshellKeys: olası biçimlerin hepsi, SHA-256 özetiyle doğrulanır); Windows'ta
                         windowsIdentity() kendiliğinden, değilse uiRequest xshellCreds. Tüneller FwdReq_* (yön _Incoming). MobaXterm: parseMobaXterm
                         ([Bookmarks_N], SSH alanları, geçit -> _jump, taşınabilir sürüm [Passwords] AES-256-CFB8). Yalnız masaüstü
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
                         süzgeç (Ctrl+F), önizleme (Boşluk), sütun boyutlandırma/gizleme (başlıkta sağ tık; layoutCols:
                         dar panelde sağdan gizler ya da autoHideCols kapalıysa yatay kaydırma)
                         Sürükle-bırak: uygulama içi HTML5 (inDrag; başka sekmenin paneline de) -> tab.dropFrom() yönlendirir
                         (yerel->uzak yükleme, uzak->yerel kaynak sekme indirir, uzak->uzak 'relay'). Alt+sürükle: OS'a
                         (webContents.startDrag; Wayland'de güvenilmez, bu yüzden varsayılan değil)
src/renderer/dialogs.js  modal(), prompt, host key, oturum düzenleyici, ayarlar, context menu, toast, terminal temaları
src/renderer/account.js  Hesap penceresi (giriş / hesap oluştur / durum, parola değişimi, çıkış)
src/renderer/util.js     h() DOM yardımcısı, biçimlendirme, SVG ikon seti
```

Renderer'da bundler yok: ES modülleri doğrudan yüklenir, xterm UMD dosyaları `index.html` içinde
`../../node_modules/...` yolundan gelir (paketli sürümde de asar içinde çalışır).

## Pano

Electron 44'te `clipboard` asenkrondur (`read()` -> `ClipboardItem[]`, `availableFormats`/`readBuffer` yok) ve bazı biçimlerin okunması
X11'de hiç dönmeyebilir: okumalar `clipLimit` süre sınırından geçmeli. Dosya panelinde Ctrl+C/V: `filepane.js` `copySelection`/`paste`.

## Windows notları

- Yerel panel yolları `C:\...`; renderer'da `tab.js` `win32` yardımcıları (`app.platform === 'win32'`). Sürücü kökünün
  üstü sanal `Bu Bilgisayar` listesi (`main.js` `DRIVES`, `listDrives()`).
- ssh-agent: `SSH_AUTH_SOCK` yoksa `\\.\pipe\openssh-ssh-agent`, o da yoksa Pageant (`findAgent()`);
  Pageant için `pagent.exe` `asarUnpack` ile asar dışında.

## macOS notları

- Uygulama kısayolları Ctrl yerine Cmd: kod `util.js` `modKey(e)` kullanmalı, Ctrl terminale kalır. Ctrl+Tab iki platformda aynı;
  sekme geçişi Cmd+1..9 (Option+rakam özel karakter yazar). Kısayol metinleri `keyLabel()` ile `⌘⇧N` olur (`h()` `title`'da kendisi uygular).
- Terminalde Cmd+C/V, `setMacMenu()` menü rolleriyle çalışır. Pencere kapanınca uygulama Dock'ta kalır; Cmd+W bilerek yok.
- Otomatik güncelleme kurulumu yok (`installKind()` null): yalnız bildirim.

## Android sürümü (`android/`)

Ayrıntılar: `android/README.md`. Arayüz WebView'da (`app/src/main/assets/www`, bundler yok, xterm dosyaları
derlemede `../node_modules`'tan kopyalanır); SSH Java'da: JSch (mwiede) + BouncyCastle.

- `android/app/src/main/java/dev/melid/core/` Android'den bağımsız (ssh-manager.js'in karşılığı) —
  `bash android/coretest/run.sh` ile JVM'de geçici sshd + ssh2 sunucusuna karşı test edilir.
- Dil: `www/i18n.js` (masaüstüyle aynı gözlemci) + `www/locales/en.js` (masaüstü sözlüğü + Android'e özgü metinler; yeni metin
  ikisine de eklenmeli). Ayar `language` cihaza özgü (localStorage'da da tutulur, kilit ekranı için). Java yerel metinleri `App.tr(tr, en)`.
- Köprü: JS `MelidNative.call(id, metot, json)` -> `window.__nreply`; olaylar `window.__nevent` (Bridge.java).
  Yeni çağrı: `Bridge.dispatch` içine `case` + JS'te `N.call('metot', {...})`.
- Güncelleme: `Updater.java` (masaüstüyle aynı imzalı latest.json; JobScheduler + bildirim, PackageInstaller).
- Uygulama kilidi: `app/AppLock.java` (ana parola PBKDF2 doğrulayıcısı `lock.json`, biyometrik = kullanıcı doğrulaması
  isteyen Keystore anahtarıyla BiometricPrompt CryptoObject). Kilitliyken `Bridge.dispatch` yalnız `lock*` çağrılarını
  kabul eder; arayüz `www/lock.js`. Bağlantılar ve eşitleme kilitliyken de sürer.
- Sırlar Android Keystore ile şifreli (`Store.java`), WebView'a gitmez. Yedek biçimi masaüstüyle aynı (`Backup.java`).
- Hesap eşitlemesi: `core/SyncCore.java` (sync.js + mergeVaults'un karşılığı, yerel ağ taraması), `app/AccountSync.java`
  (zamanlama), `Store` `SyncCore.Local`'ı uygular; arayüz `www/account.js`. Masaüstüyle uyumu coretest'teki
  `SyncTest.java` + `sync-desktop.js` gerçek sunucuya karşı sınar. Protokol değişirse ikisi birlikte değişmeli.
- Derleme: `cd android && ./gradlew assembleRelease` (JDK 17 + SDK; `local.properties`, imza için
  `keystore.properties` + `melid-release.jks` — git dışı, kaybolmamalı). Değişiklikten sonra `./gradlew lintDebug`.

## Ad: Melid (eski adı SSHDeck)

Uygulama 1.10'da SSHDeck'ten Melid'e geçti (marka dosyaları: `build/`, Android `res/mipmap-*`, `server/pages/static/`).
Protokol, şifreleme dizeleri ve yedek biçimi de `melid`: SSHDeck hesapları ve 1.9 sunucusuyla uyum bilerek bırakıldı.
Eski adın kaldığı yerler, değiştirmeyin:
- `app.setName('SSHDeck')` (main.js): anahtarlıktaki şifreleme anahtarı ("SSHDeck Safe Storage") uygulama adına bağlı;
  değişirse kayıtlı parolalar çözülemez. Veri klasörü yine de `Melid` (`migrateDataDir()` eski `SSHDeck` klasörünü taşır).
- `MASTER_CHECK_OLD` (store.js): SSHDeck'te belirlenmiş ana parolanın doğrulayıcısı.
- Yedek içe aktarma `app: 'SSHDeck'` yedeklerini de kabul eder.

## Kurallar

- Yeni main↔renderer çağrısı: `main.js`'te `h('kanal', fn)` + `preload.js`'te `api` altına ekle.
- Sırlar (parola, anahtar parolası) asla renderer'a gönderilmez.
- Bir sekmede yeniden bağlanınca yeni `connId` üretilir; eski connId'den gelen olaylar yok sayılır.
- Kabuk olayları (`ssh:data`, `ssh:exit`) `sid` taşır; terminale yazan kod `tab.writeActive()` kullanmalı (etkin bölme).
- `SessionTab.panes` terminal bölmeleridir; dosya panellerinin kapsayıcısı `paneBox`.
- `app.active` odaktaki sekmedir; bölünmüşken iki grubun görünen sekmesi `tabGroups[i].active`. Boyut değişiminde `app.fitAll()`.
- Sekme düğmeleri bir kez oluşturulup yerinde güncellenir (`tabButton`); tıklarken yeniden yaratmak çift tık/sürüklemeyi bozar.
- Eşitlenen veriyi değiştiren store metotları `mtime` koymalı ve `_changed()` çağırmalı (`_touchSessions`, `saveSettings`);
  silme `_removeSessions` ile (silme kaydı tutar). Cihaza özgü yeni ayar -> `LOCAL_SETTINGS`.
- Hata mesajları kullanıcıya Türkçe ve anlaşılır gitmeli (`friendlyError`, `cleanErr`).
