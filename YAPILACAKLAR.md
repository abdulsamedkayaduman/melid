# Melid — Yapılacaklar

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
sudo pacman -U dist/melid-*.pacman   # yeniden kur
```
- **Electron özellikle önemli:** içinde Chromium var, güvenlik yamaları için arada bir
  yeni sürüme çekip yeniden paketle.
- Sürüm çıkarırken `package.json` içindeki `version` alanını yükseltmeyi unutma
  (paket adları da ona göre: `melid-<version>.pacman`).

### 2. AUR paketi (Arch/CachyOS için otomatik güncelleme)
- Amaç: `pacman -Syu` ile Melid de güncellensin.
- Yapılacak: bir `PKGBUILD` yaz (kaynaktan derleyen `melid` ya da hazır paketi kuran
  `melid-bin`), AUR'a `git push` et. Sonrası kullanıcı tarafında otomatik gelir.
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
- Anlık bildirim yok: diğer cihaz değişikliği en geç 5 dk'da / pencereye dönünce görür (SSE / uzun yoklama düşünülebilir).
- Bağlantı denetimi ve toplu işler yalnız masaüstünde; Android'e taşınabilir.

## Diğer küçük işler
- pacman paketinde `pkgdesc` boş görünüyor (`pacman -Qi melid`). Kozmetik; electron-builder
  üst düzey `description`'ı pacman'e geçirmiyor. Gerekirse fpm/`linux` ayarıyla çözülebilir.
- `.desktop` pencere eşleşmesi `StartupWMClass=Melid` ile zaten çalışıyor; electron-builder
  yine de `desktopName` uyarısı basıyor (bu sürümde `linux.desktopName`/`syncDesktopName`
  şema dışı — zararsız, görmezden gelinebilir).
