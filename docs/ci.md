# CI/CD (Forgejo Actions)

Forgejo: `http://192.168.1.50:3001/abdulsamed.kayaduman/ssh-deck`. İş akışı: `.forgejo/workflows/derle.yml`.

## Ne yapar

| Job | Container | Çıktı |
|-----|-----------|-------|
| `test` | `node:22-bookworm` | birim testleri + `test/core.test.js` (Docker yerine `ci/test-sshd.sh` container içinde sshd açar) |
| `linux` | `node:22-bookworm` | `SSHDeck-<sürüm>.AppImage`, `sshdeck-<sürüm>.pacman` |
| `windows` | `electronuserland/builder:22-wine-05.26` | `SSHDeck-<sürüm>-kurulum.exe`, `SSHDeck-<sürüm>-tasinabilir.exe` (NSIS kaldırıcısı için wine gerekir) |
| `android` | `node:22-bookworm` + JDK 17 | SSH çekirdeği testleri (`android/coretest`), lint, imzalı `SSHDeck-<sürüm>.apk` |
| `yayinla` | `node:22-bookworm` | Forgejo sürümü (Releases) + `SHA256SUMS.txt` |

`linux`, `windows`, `android` paralel çalışır; hepsi `test`'i bekler.

## Nasıl başlatılır

- **Elle:** Depo > **Actions** > `derle.yml` > **Run workflow** (dal seçilebilir). Çıktılar çalıştırma sayfasında
  *Artifacts* altında (14 gün). `yayinla` işaretliyse (varsayılan) **Sürümler** sayfasındaki `gelistirme`
  ön sürümü silinip bu derlemeyle yeniden oluşturulur — telefondan/Windows'tan indirmek için en kolay yer.
- **Kalıcı sürüm:** `package.json`'daki `version`'ı artırın, commit'leyin, `git tag v1.0.1 && git push origin v1.0.1`.
  Etiket sürümle aynı değilse `yayinla` hata verir. Notlar önceki `v*` etiketinden bu yana commit başlıklarıdır.

Android `versionName`/`versionCode` da `package.json`'dan gelir (`versionCode = MAJOR*10000 + MINOR*100 + PATCH`),
yani tek yerden sürüm artırmak yeterli.

## Bir kez yapılacak kurulum

1. Depo ayarlarında **Actions** açık olmalı (Ayarlar > Birimler).
2. `docker` etiketli runner (obd-logger ile aynı runner). İlk Windows derlemesinde ~1,5 GB'lık wine imajı
   indirilir; sonrakiler önbellekten gelir. Android job'u ~4 GB RAM ister.
3. **APK imza secret'ları** (Ayarlar > Actions > Secrets): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Elle girmek yerine geliştirme makinesinde:

   ```
   FORGEJO_TOKEN=<erişim token'ı> bash ci/set-android-secrets.sh
   ```

   (`android/keystore.properties` + `sshdeck-release.jks`'i okur, değerleri ekrana yazmaz.) Secret yoksa `android`
   job'u bilerek hata verir: farklı anahtarla imzalı APK telefondaki uygulamanın üzerine kurulamaz.
4. `v*` etiketlerini koruyun (Ayarlar > Etiketler): secret'lar push edilen her iş akışına açıktır.

## Yerel karşılıkları

- `npm test` (Docker/Podman ile), `npx electron-builder --linux AppImage pacman`, `npx electron-builder --win`
  (Linux'ta wine gerekir).
- `cd android && ./gradlew assembleRelease lintRelease`, `bash android/coretest/run.sh`.
