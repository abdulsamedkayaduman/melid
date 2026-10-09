# SSHDeck — Yapılacaklar

İleride ele alınacak işler. Aciliyet sırasına göre değil, konu bazlı.

## Güncellemeler

Uygulama içi güncelleme var (bkz. `docs/ci.md` > Güncelleme kaynağı): `npm version patch && git push --follow-tags`.
Aşağıdakiler hâlâ geçerli ek seçenekler.

Durum: `build.publish = null`, `electron-updater` kurulu değil. Paketlenen kütüphaneler
(ssh2, electron, xterm, @noble/hashes) build anında dondurulur; kurulu uygulamada
kendiliğinden güncellenmez.

### 1. Bağımlılıkları güncel tutmak (elle, en basit yol)
```
npm outdated          # hangi kütüphanelerde güncelleme var
npm update            # veya tek tek: npm install ssh2@latest, electron@latest ...
npm test              # bozulan bir şey var mı
npm run dist          # yeni paketleri üret
sudo pacman -U dist/sshdeck-*.pacman   # yeniden kur
```
- **Electron özellikle önemli:** içinde Chromium var, güvenlik yamaları için arada bir
  yeni sürüme çekip yeniden paketle.
- Sürüm çıkarırken `package.json` içindeki `version` alanını yükseltmeyi unutma
  (paket adları da ona göre: `sshdeck-<version>.pacman`).

### 2. AUR paketi (Arch/CachyOS için otomatik güncelleme)
- Amaç: `pacman -Syu` ile SSHDeck de güncellensin.
- Yapılacak: bir `PKGBUILD` yaz (kaynaktan derleyen `sshdeck` ya da hazır paketi kuran
  `sshdeck-bin`), AUR'a `git push` et. Sonrası kullanıcı tarafında otomatik gelir.
- Not: AUR hesabı ve SSH anahtarı gerekir.

### 3. electron-updater ile otomatik güncelleme (AppImage kendini günceller)
- Amaç: AppImage yeni sürümü kendi indirip güncellesin.
- Yapılacak:
  - `npm i -D electron-updater`
  - `package.json > build.publish` → GitHub Releases (repo gerekir).
  - Ana süreçte `autoUpdater.checkForUpdatesAndNotify()` çağrısı + kullanıcıya Türkçe bildirim.
  - Her sürümde GitHub'a release + `latest-linux.yml` yayınla (electron-builder üretir).
- Not: Yalnızca AppImage için çalışır; pacman tarafı için (2) gerekir.

## Hesap eşitlemesi
- Android'de henüz yok: `Store.java` + yeni `Sync.java` (aynı KDF/kasa biçimi: docs/senkron.md; PBKDF2-SHA512 + HKDF-SHA256
  + AES-256-GCM, iv|tag|veri base64) ve WebView'da hesap penceresi.
- Kurtarma anahtarı yok: hesap parolası unutulursa kasa gider (yerel veriler kalır, yeni hesapla yüklenebilir).
- Anlık bildirim yok: diğer cihaz değişikliği en geç 5 dk'da / pencereye dönünce görür.

## Diğer küçük işler
- pacman paketinde `pkgdesc` boş görünüyor (`pacman -Qi sshdeck`). Kozmetik; electron-builder
  üst düzey `description`'ı pacman'e geçirmiyor. Gerekirse fpm/`linux` ayarıyla çözülebilir.
- `.desktop` pencere eşleşmesi `StartupWMClass=SSHDeck` ile zaten çalışıyor; electron-builder
  yine de `desktopName` uyarısı basıyor (bu sürümde `linux.desktopName`/`syncDesktopName`
  şema dışı — zararsız, görmezden gelinebilir).
