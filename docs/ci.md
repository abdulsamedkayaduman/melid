# CI/CD (GitHub Actions)

İş akışı: `.github/workflows/derle.yml`. Kod: https://github.com/abdulsamedkayaduman/melid

## Ne yapar

| Job | Runner | Çıktı |
|-----|--------|-------|
| `test` | ubuntu | birim testleri + `test/core.test.js` (`sudo ci/test-sshd.sh` geçici sshd açar) |
| `linux` | ubuntu | `Melid-<sürüm>.AppImage`, `melid-<sürüm>.pacman` |
| `windows` | windows | `Melid-<sürüm>-kurulum.exe`, `Melid-<sürüm>-tasinabilir.exe` |
| `mac` | ubuntu | `Melid-<sürüm>-mac-arm64.tar.gz`, `Melid-<sürüm>-mac-x64.tar.gz` (imzasız; ayrıntı aşağıda) |
| `android` | ubuntu + JDK 17 | SSH çekirdeği testleri (`android/coretest`), lint, imzalı `Melid-<sürüm>.apk` |
| `yayinla` | ubuntu | GitHub sürümü (Releases) + `SHA256SUMS.txt` + imzalı `latest.json` |

`main`'e push ve pull request'te yalnız `test` çalışır. Derleme job'ları elle başlatmada ve `v*` etiketinde çalışır.

## Nasıl başlatılır

- **Elle:** Actions > `derle` > **Run workflow** (dal seçilebilir). Çıktılar çalıştırma sayfasında *Artifacts* altında
  (14 gün). `yayinla` işaretliyse (varsayılan) Releases'taki `gelistirme` ön sürümü silinip bu derlemeyle yeniden
  oluşturulur. Uygulamalara güncelleme olarak **gitmez**.
- **Kalıcı sürüm (cihazlara güncelleme olarak gider):**

  ```
  npm version patch      # 1.10.0 -> 1.10.1 (ya da minor / major); package.json + commit + v1.10.1 etiketi
  git push --follow-tags
  ```

  Etiket `package.json` sürümüyle aynı değilse `yayinla` hata verir. Notlar önceki `v*` etiketinden bu yana commit başlıklarıdır.

Android `versionName`/`versionCode` da `package.json`'dan gelir (`versionCode = MAJOR*10000 + MINOR*100 + PATCH`).

## Güncellemeler ve indirme sayfası

Etiketli her sürümde `yayinla`, `ci/update-feed.js` ile imzalı `latest.json` üretip sürüme ekler:

```
https://github.com/abdulsamedkayaduman/melid/releases/latest/download/latest.json
```

`latest.json` = `{ payload: base64(JSON), sig: Ed25519 imzası }`; JSON'da sürüm, notlar ve her paket türü için GitHub'daki
`url`, `sha256`, `size`. Eşitleme sunucusu bunu `https://melid.abdulsamed.net/guncelleme/latest.json` olarak sunar
(`UPDATE_FEED_URL`, 5 dk önbellek); uygulamalar ve indirme sayfası oraya bakar, dosyaları GitHub'dan indirir.
Uygulamalar imzayı gömülü açık anahtarla (`src/main/updater.js`, `Updater.java`), dosyayı sha256 ile doğrular; Android
ayrıca APK imzasını denetler.

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

## Secret'lar

Repo > Settings > Secrets and variables > Actions:

- **APK imzası:** `ANDROID_KEYSTORE_BASE64` (`base64 -w0 android/melid-release.jks`), `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (`android/keystore.properties`). Secret yoksa `android` job'u bilerek hata
  verir: farklı anahtarla imzalı APK telefondaki uygulamanın üzerine kurulamaz.
- **`UPDATE_SIGNING_KEY`:** `latest.json` imza anahtarı (Ed25519, PEM). Yerel kopyası `update-signing-key.pem` (git dışı).

`gh` ile: `gh secret set ANDROID_KEYSTORE_BASE64 < <(base64 -w0 android/melid-release.jks)`,
`gh secret set UPDATE_SIGNING_KEY < update-signing-key.pem` vb.

**`android/melid-release.jks`, `android/keystore.properties` ve `update-signing-key.pem`'i yedekleyin.** Kaybolursa yeni
APK'lar telefondaki uygulamanın üzerine kurulamaz ve yeni anahtarla imzalanan güncellemeleri eski uygulamalar reddeder.

GitHub'ın kendi token'ı (`github.token`) sürüm oluşturmaya yeter; ayrıca token gerekmez. Secret'lar etiket push'larıyla
çalışan iş akışına açık olduğu için `v*` etiketlerini koruyun (Settings > Rules > Rulesets).

## Yerel karşılıkları

- `npm test` (Docker/Podman ile), `npx electron-builder --linux AppImage pacman`, `npx electron-builder --win`
  (Linux'ta wine gerekir), `npm run dist:mac`.
- `cd android && ./gradlew assembleRelease lintRelease`, `bash android/coretest/run.sh`.
