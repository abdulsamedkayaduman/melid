# CI/CD (Forgejo Actions)

İş akışı: `.forgejo/workflows/derle.yml` (Forgejo Actions). Açık kaynak kopya GitLab'da; derleme ve sürümler Forgejo'da.

## Ne yapar

| Job | Container | Çıktı |
|-----|-----------|-------|
| `test` | `node:22-bookworm` | birim testleri + `test/core.test.js` (Docker yerine `ci/test-sshd.sh` container içinde sshd açar) |
| `linux` | `node:22-bookworm` | `Melid-<sürüm>.AppImage`, `melid-<sürüm>.pacman` |
| `windows` | `electronuserland/builder:22-wine-05.26` | `Melid-<sürüm>-kurulum.exe`, `Melid-<sürüm>-tasinabilir.exe` (NSIS kaldırıcısı için wine gerekir) |
| `mac` | `node:22-bookworm` | `Melid-<sürüm>-mac-arm64.tar.gz`, `Melid-<sürüm>-mac-x64.tar.gz` (imzasız; ayrıntı aşağıda) |
| `android` | `node:22-bookworm` + JDK 17 | SSH çekirdeği testleri (`android/coretest`), lint, imzalı `Melid-<sürüm>.apk` |
| `yayinla` | `node:22-bookworm` | Forgejo sürümü (Releases) + `SHA256SUMS.txt` |

`linux`, `windows`, `mac`, `android` paralel çalışır; hepsi `test`'i bekler.

## Nasıl başlatılır

- **Elle:** Depo > **Actions** > `derle.yml` > **Run workflow** (dal seçilebilir). Çıktılar çalıştırma sayfasında
  *Artifacts* altında (14 gün). `yayinla` işaretliyse (varsayılan) **Sürümler** sayfasındaki `gelistirme`
  ön sürümü silinip bu derlemeyle yeniden oluşturulur — telefondan/Windows'tan indirmek için en kolay yer.
- **Kalıcı sürüm (cihazlara güncelleme olarak gider):**

  ```
  npm version patch      # 1.1.0 -> 1.1.1 (ya da minor / major); package.json + commit + v1.1.1 etiketi
  git push --follow-tags
  ```

  Etiket push'u pipeline'ı başlatır: `vX.Y.Z` sürümü + **güncelleme kaynağı** (aşağıda). Etiket `package.json`
  sürümüyle aynı değilse `yayinla` hata verir. Notlar önceki `v*` etiketinden bu yana commit başlıklarıdır.
  Elle başlatılan derlemeler (`gelistirme`) cihazlara güncelleme olarak **gitmez**.

Android `versionName`/`versionCode` da `package.json`'dan gelir (`versionCode = MAJOR*10000 + MINOR*100 + PATCH`),
yani tek yerden sürüm artırmak yeterli.

## Güncelleme kaynağı (uygulama içi güncelleme)

Etiketli her sürümde `ci/publish-update.sh` dosyaları Forgejo **generic paket deposuna** koyar:

```
<forgejo>/api/packages/<kullanıcı>/generic/sshdeck/<sürüm>/<dosya>
<forgejo>/api/packages/<kullanıcı>/generic/sshdeck/latest/latest.json
```

Forgejo yalnız ev ağında; dışarıya eşitleme sunucusu aktarır (`UPDATE_UPSTREAM`, docs/senkron.md):
`https://sshdeck.abdulsamed.net/guncelleme/latest.json` ve `https://sshdeck.abdulsamed.net/indir/<sürüm>/<dosya>`.
`latest.json`'daki indirme adresleri bu genel adreslerdir (`PUBLIC_DOWNLOAD_BASE`, derle.yml). 1.9.0 ve öncesi uygulamalar
hâlâ Forgejo'daki `latest.json`'a bakar; o dosya da her sürümde yenilenir, böylece yeni adrese geçerler.

`latest.json` = `{ payload: base64(JSON), sig: Ed25519 imzası }`; JSON'da sürüm, notlar ve her paket türü için
`url`, `sha256`, `size` var (`ci/update-feed.js`). Uygulamalar imzayı gömülü açık anahtarla
(`src/main/updater.js`, `Updater.java`), dosyayı sha256 ile doğrular; ayrıca Android APK imzasını kendisi denetler.

- Masaüstü: açılıştan 15 sn sonra ve 6 saatte bir denetler; yeni sürümde sistem bildirimi + durum çubuğunda rozet.
  "İndir ve kur": Windows kurulumu sessiz kurulup yeniden açılır; taşınabilir exe ve AppImage dosyanın yerine
  yazılır; pacman `pkexec pacman -U` ile (yönetici parolası sorulur). Geliştirme/tanınmayan kurulumda yalnız bildirim.
- Android: açılışta/geri dönüşte (6 saatte bir) ve arka planda 12 saatte bir (JobScheduler) denetler; bildirim +
  ana ekranda şerit. Kurulum PackageInstaller ile; ilk seferde "bilinmeyen uygulamaları yükle" izni istenir.
- Ayarlardan "Şimdi denetle" ve otomatik denetimi kapatma. "Bu sürümü atla" yalnız o sürümü susturur.
- Deneme için masaüstünde `MELID_UPDATE_URL`, Android'de `updateUrl` ayarı başka kaynak gösterebilir
  (imza yine aynı anahtarla doğrulanır).

## macOS paketi

Paket Linux'ta üretilir, Mac runner gerekmez. `.zip` kullanılmaz: Linux'ta sembolik bağlar kopyaya dönüşür, Electron çatısı
üç kez yer kaplar ve paket yapısı bozulur. `.dmg` için Mac gerekir.

İmza ve notarize yok (Apple Developer hesabı gerekir), bu yüzden tarayıcıyla indirilen paketi macOS ilk açılışta engeller.
İlk kurulum:

```
tar xzf Melid-<sürüm>-mac-arm64.tar.gz     # Intel Mac için -x64
mv Melid.app /Applications/
xattr -cr /Applications/Melid.app
codesign --force --deep --sign - /Applications/Melid.app
```

Uygulama içi güncelleme macOS'ta kurulum yapmaz: yeni sürüm bildirilir, "İndirme sayfasını aç" ile paket elle indirilir
(`installKind()` `null` döner). Mac paketleri `latest.json`'da `mac-arm64` / `mac-x64` olarak yalnız indirme sayfası için durur.

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
4. **Güncelleme secret'ları:**
   - `UPDATE_SIGNING_KEY` — `latest.json` imza anahtarı (Ed25519, PEM). Yerel kopyası `update-signing-key.pem`
     (git dışı): **yedekleyin**. Kaybolursa yeni anahtarla imzalanan güncellemeleri eski uygulamalar reddeder;
     herkesin yeni açık anahtarlı sürümü bir kez elle kurması gerekir.
   - `PACKAGE_TOKEN` — paket deposuna yazmak için Forgejo token'ı (izin: **package** okuma+yazma). Actions'ın
     otomatik token'ı paket deposuna yazamıyor.
5. `v*` etiketlerini koruyun (Ayarlar > Etiketler): secret'lar push edilen her iş akışına açıktır.

## Yerel karşılıkları

- `npm test` (Docker/Podman ile), `npx electron-builder --linux AppImage pacman`, `npx electron-builder --win`
  (Linux'ta wine gerekir), `npm run dist:mac`.
- `cd android && ./gradlew assembleRelease lintRelease`, `bash android/coretest/run.sh`.
