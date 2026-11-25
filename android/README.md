# Melid Android

Masaüstü Melid'in Android sürümü: SSH terminali + SFTP dosya yöneticisi + tüneller.
Arayüz WebView içinde (xterm.js, masaüstüyle aynı paket), SSH işleri Java'da (JSch + BouncyCastle).

## Telefona kurulum

1. `Melid-<sürüm>-release.apk` dosyasını telefona aktarın (USB kablo, Telegram/Drive, ya da aynı Wi-Fi'da
   bilgisayarda `python3 -m http.server -d android/app/build/outputs/apk/release 8000` çalıştırıp telefondaki
   tarayıcıdan `http://<bilgisayar-ip>:8000` adresine girin).
2. Dosyaya dokunun. Android "bilinmeyen uygulama" uyarısı verirse o uygulamaya (Dosyalar / Chrome) izin verin.
3. Play Protect "tanınmayan geliştirici" derse **Yine de yükle**.
4. İlk bağlantıda bildirim izni sorulur: izin verirseniz açık bağlantılar bildirimde görünür ve uygulama
   arka plandayken bağlantılar kopmaz.

Android 10 (API 29) ve üzeri desteklenir.

## Özellikler

- Oturum listesi (gruplar, arama), hızlı bağlan (`kullanıcı@sunucu:port`), panodan oturum oluşturma
- Kimlik doğrulama: parola, SSH anahtarı (Ed25519/ECDSA/RSA; OpenSSH ve PEM), otomatik, keyboard-interactive (2FA)
- Sunucu anahtarı doğrulama (SHA256 parmak izi, değişince uyarı), jump host (bastion) zinciri
- Terminal: xterm.js, ek tuş satırı (Esc, Tab, Ctrl, Alt, oklar, Home/End, PgUp/PgDn, F1-F12),
  Ctrl/Alt tek dokunuş = bir sonraki tuş, çift dokunuş = kilit; kaydırma (ataletli), iki parmakla yazı boyutu,
  basılı tutma menüsü (metin seç/kopyala, yapıştır, bağlantıyı aç), htop/mc gibi uygulamalarda dokunma = fare
- Birden çok sekme, kopunca otomatik yeniden bağlanma, ağ değişince (Wi-Fi ↔ mobil) ölü bağlantıyı hızlı algılama
- Arka planda bağlantıyı canlı tutan ön plan servisi (bildirimden "Tümünü kapat")
- SFTP: gezinme, indirme (İndirilenler/Melid, klasör dahil), yükleme (çoklu), metin düzenleyici, resim önizleme,
  yeniden adlandır/taşı, izinler (chmod), sil, çoklu seçim, "terminalin dizinine git"
- Tüneller: -L, -R, -D (SOCKS5), bağlanınca otomatik başlatma
- Sunucu durumu (CPU, bellek, disk, ağ, yük)
- Hazır komutlar, SSH anahtarı üretme/içe aktarma, açık anahtarı sunucuya yükleme (ssh-copy-id)
- Masaüstü yedeği (Ayarlar > Yedekle) içe aktarma ve masaüstüyle uyumlu yedek dışa aktarma
- Hesap ve eşitleme (Ayarlar > Hesap ve eşitleme): masaüstüyle aynı uçtan uca şifreli hesap; oturumlar, parolalar,
  hazır komutlar iki yönlü eşitlenir. **Yerel ağda ara** Wi-Fi'deki 3150 portlu sunucuları bulur (`docs/senkron.md`)
  İsteğe bağlı olarak SSH anahtarları da eşitlenir (cihaz başına seçim)
- Ana ekranda son bağlantılar (tek dokunuşla bağlan)
- Uygulama kilidi (Ayarlar > Uygulama kilidi): ana parola, isteğe bağlı parmak izi / yüz tanıma, arka planda
  seçilen süre sonra kilitlenir. Kilitliyken bağlantılar ve eşitleme sürer; Android 13+'ta son uygulamalarda içerik gizlenir
- 8 arayüz teması + 5 terminal teması (masaüstüyle aynı)

Sırlar (parolalar, anahtar parolaları, özel anahtarlar) Android Keystore'daki AES anahtarıyla şifrelenir
ve WebView'a hiç gönderilmez.

Masaüstünden aktarılan oturumlarda anahtar dosyası (`keyPath`) yedekte yoktur: özel anahtarı Ayarlar >
SSH anahtarları'ndan içe aktarın; dosya adı aynıysa (`id_ed25519` gibi) oturumla otomatik eşleşir.

## Geliştirme

Gerekenler: JDK 17, Android SDK (platform 35, build-tools 35), kök dizinde `npm install` (xterm dosyaları
`../node_modules`'tan kopyalanır).

```
cd android
./gradlew assembleDebug        # app/build/outputs/apk/debug/
./gradlew assembleRelease      # imzalı: keystore.properties + melid-release.jks gerekir
./gradlew lintDebug
bash coretest/run.sh           # SSH çekirdeği testleri (JVM; geçici sshd + ssh2 sunucusu)
```

`local.properties` içinde `sdk.dir=...` olmalı. İmzalama: `keystore.properties` (git'e girmez):

```
storeFile=../melid-release.jks
storePassword=...
keyAlias=melid
keyPassword=...
```

**`melid-release.jks` ve `keystore.properties` dosyalarını yedekleyin.** Kaybolursa yeni sürümler telefondaki
uygulamanın üzerine kurulamaz (önce kaldırmak, yani verileri silmek gerekir). Sürüm (`versionName`/`versionCode`)
kök `package.json`'dan gelir. CI'da imza ortam değişkenlerinden okunur (`ANDROID_KEYSTORE_FILE` vb., bkz. `docs/ci.md`).

### Mimari

```
app/src/main/java/dev/melid/core/   Android'den bağımsız SSH çekirdeği (JVM'de test edilir)
  SshCore.java    bağlantılar (connId), jump zinciri, kimlik doğrulama/sorular, kabuklar (sid), exec, kopma algılama
  Sftp.java       paylaşılan gezinme kanalı + aktarımlar (her aktarım kendi kanalında; iptal = kanalı kapat)
  Forwards.java   -L / -R / -D (SOCKS5)
  Keys.java       anahtar üretme (Ed25519: BouncyCastle, OpenSSH biçimi) ve içe aktarılan anahtarı doğrulama
  Backup.java     masaüstü yedeği şifrelemesi (PBKDF2-SHA512 + AES-256-GCM, store.js ile aynı)
  SyncCore.java   hesap eşitlemesi istemcisi (sync.js + mergeVaults ile aynı protokol), yerel ağ taraması
  Host.java       platform kancaları (olay, soru, oturum, bilinen sunucular, anahtarlar)
app/src/main/java/dev/melid/app/
  App.java        süreç ömürlü nesneler, Host uygulaması, ağ değişimi izleme
  MainActivity    WebView (https://appassets.androidplatform.net/ -> assets/www), kenar boşlukları/klavye,
                  terminal odaktayken klavyeyi "görünür parola" kipine alma (öneri/otomatik düzeltme yok)
  Bridge.java     JS köprüsü: MelidNative.call(id, metot, json) -> window.__nreply; olaylar window.__nevent
  Store.java      sessions/settings/known_hosts/keys/sync .json; sırlar Android Keystore ile şifreli; SyncCore.Local
  AccountSync     eşitleme zamanlaması (değişiklikten 2 sn sonra, 5 dk'da bir, uygulamaya dönünce, ağ değişince)
  SshService      ön plan servisi (açık bağlantı varken)
app/src/main/assets/www/   arayüz (bundler yok, ES modülleri)
  app.js      ana ekran, sekmeler, gezinme, olay yönlendirme      tab.js     SessionTab (bağlantı yaşam döngüsü)
  term.js     dokunmatik terminal (giriş, ek tuşlar, hareketler)  files.js   SFTP
  screens.js  oturum düzenleyici, ayarlar, anahtarlar, …          dialogs.js alt sayfalar, sorular, temalar
  native.js   köprü sarmalayıcısı                                 mock.js    tarayıcıda geliştirme için sahte köprü
  account.js  hesap: giriş / hesap oluştur / yerel ağda ara / durum
```

Arayüzü tarayıcıda denemek: `assets/www` klasörünü herhangi bir statik sunucuyla açın
(ör. `npx http-server android/app/src/main/assets/www`); `MelidNative` yoksa `mock.js` devreye girer
(xterm dosyaları için önce bir kez `./gradlew copyXterm`).
