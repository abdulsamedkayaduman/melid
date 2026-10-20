# Hesap ve eşitleme

Giriş yapılan her cihazda oturumlar, kayıtlı parolalar, ayarlar ve hazır komutlar eşitlenir.
Uçtan uca şifrelidir: sunucu verileri çözemez.

## Sunucuyu çalıştırmak

`server/sync-server.js` bağımlılıksızdır (yalnız Node 18+). Tek dosya; başka bir makineye kopyalamak yeter.

```
PORT=3150 HOST=0.0.0.0 DATA_DIR=/var/lib/sshdeck-sync SSHDECK_SYNC_INVITE='uzun-rastgele-kod' node server/sync-server.js
```

- `SSHDECK_SYNC_INVITE`: hesap açmak için gereken davet kodu. Boşsa yeni hesap açılamaz (mevcutlar çalışır).
  Ana sayfadaki istatistiklere de bu kodla girilir; boşsa istatistik sayfası da kapanır.
  Herkese açık sunucuda hesaplarınızı açtıktan sonra boşaltmak iyi bir fikir.
- `TRUST_PROXY=1`: ters vekil arkasında istemci IP'si `X-Forwarded-For`'un en sağındaki girdiden alınır.
- 1.8 ile kurtarma anahtarı uçları (`/api/account`, `/api/recovery`, `/api/recover/*`) eklendi: sunucuyu güncelleyin.
- `TLS_CERT` / `TLS_KEY`: verilirse HTTPS dinler. Alternatif: Caddy/nginx ters vekil ya da Tailscale.
- Sürekli çalışması için örnek systemd birimi: `server/sshdeck-sync.service`.
- Yedek: `DATA_DIR` klasörünü yedeklemek yeter (`users.json`, `tokens.json`, `vaults/`, `secret.json`).

Uygulamada: araç çubuğundaki bulut düğmesi → **Hesap oluştur** (ilk cihaz, davet kodu ile) → diğer cihazlarda **Giriş yap**.
Android: Ayarlar → **Hesap ve eşitleme** (aynı hesap, aynı kasa).

Sunucu adresinde port yazılmazsa 3150 kabul edilir (`192.168.1.50` → `http://192.168.1.50:3150`; `https://…` adreslerinde
olduğu gibi kalır). **Yerel ağda ara** düğmesi, bu cihazın yerel IPv4 ağlarındaki (en fazla /24) adreslerde 3150 portunu
tarar ve `/api/info` yanıtı SSHDeck olanları listeler (masaüstü: `scanLan()` sync.js, Android: `SyncCore.scan()`).

## Ana sayfa / istatistikler

Sunucunun kök adresi (`http://<sunucu>:3150/`) davet koduyla (`SSHDECK_SYNC_INVITE`) girilen bir istatistik paneli açar:
hesap ve cihaz sayısı, son 7 günde etkin olanlar, toplam kasa boyutu, sunucu açıldığından beri eşitleme/giriş/hatalı giriş
sayıları ve hesap başına son görülme, son değişiklik, kasa sürümü/boyutu, oturum açık cihazlar (istemci adı ve son görülme;
istemciler kendini `X-SSHDeck-Client` başlığıyla tanıtır, ör. `SSHDeck 1.5.0 Android 14`). Kasa içerikleri şifreli
olduğundan oturum adı, adres ya da parola burada hiçbir zaman görünmez. API: `POST /api/stats {invite}`; hatalı kod
denemeleri giriş denemeleriyle aynı IP sınırına tabidir. Davet kodunu bilen herkes kullanıcı adlarını görebilir.

## Docker / Dokploy

`server/` içinde `Dockerfile` (node:22-alpine, root olmayan kullanıcı, sağlık kontrolü) ve `docker-compose.yml` var.
Veriler `sshdeck-sync-data` adlı birimde (`/data`) durur; yeniden dağıtımda kaybolmaz.

**Dokploy:**
1. Create Service > **Compose** (Docker Compose). Kaynak: bu Forgejo deposu (Git sağlayıcısı veya SSH anahtarıyla Git),
   dal `main`, **Compose Path** `./server/docker-compose.yml`.
2. **Environment**: `SSHDECK_SYNC_INVITE=<uzun rastgele kod>` (ör. `openssl rand -base64 24`).
3. **Domains**: alan adı, servis `sync`, container port `3150`, HTTPS açık (Let's Encrypt).
4. **Deploy**. Kontrol: `https://<alan-adı>/api/info` -> `{"app":"SSHDeck","api":1,"register":true}`.
5. Uygulamada sunucu olarak `https://<alan-adı>` girilir.

`TRUST_PROXY=1` compose'ta varsayılan: Traefik arkasında deneme sınırı gerçek istemci IP'siyle çalışır.
Ters vekil olmadan doğrudan açacaksanız `TRUST_PROXY=0` yapın (yoksa istemci başlığı taklit ederek sınırı aşabilir)
ve compose'taki `ports` satırını açın.

Düz Docker: `cd server && SSHDECK_SYNC_INVITE=... docker compose up -d --build`.

Yedek: `docker run --rm -v <proje>_sshdeck-sync-data:/d -v $PWD:/b alpine tar czf /b/sshdeck-sync.tgz -C /d .`
(birim adı `docker volume ls` ile görülür; Dokploy proje adını önek yapar).

## Güvenlik modeli

```
hesap parolası ──PBKDF2-SHA512 (600 000, kullanıcı tuzu)──► ana anahtar
    ana anahtar ──HKDF "sshdeck-auth"──► authKey  ──► sunucu (scrypt özeti saklanır)
    ana anahtar ──HKDF "sshdeck-wrap"──► wrapKey  (cihazdan çıkmaz)
kasa anahtarı VK (rastgele 32 bayt) ──AES-256-GCM(wrapKey)──► wrappedKey (sunucuda)
kasa JSON'u ──AES-256-GCM(VK)──► sunucuda yalnız bu şifreli blob
```

- Sunucunun gördüğü: kullanıcı adı, tuz, authKey'in scrypt özeti, wrappedKey, şifreli kasa, sürüm numarası.
  Oturum adları, adresler, parolalar ve hesap parolası sunucuya hiç düz gitmez (test: `test/sync.test.js`).
- Hesap parolası unutulursa kasa kurtarılamaz (bilerek; sunucu da açamaz).
- Parola değişimi: VK aynı kalır, yalnız yeniden sarılır; diğer cihazların jetonları iptal edilir.
- Cihazda jeton ve VK, oturum parolalarıyla aynı yöntemle saklanır (anahtarlık / ana parola; `sync.json`).
  Ana parola kilitliyken eşitleme bekler.
- Sunucu: başarısız giriş sınırı (kullanıcı ve IP başına 15 dakikada 10), olmayan kullanıcıya sahte tuz
  (hesap var mı sızmaz), sabit zamanlı karşılaştırmalar, 16 MB istek sınırı.
- Yerel ağ dışında düz `http://` kullanılırsa giriş penceresi uyarır: kasa yine şifreli olsa da authKey ağda açık gider.
  Android düz `http://`'yi yalnız yerel ağ / Tailscale adreslerine izin verir; internetteki sunucu için https şarttır.

## SSH anahtarları (isteğe bağlı)

Her cihazda ayrı seçilir: masaüstünde hesap penceresindeki **SSH anahtarlarını da eşitle** kutusu, Android'de
Hesap ve eşitleme menüsü (giriş ekranında da sorulur). Varsayılan kapalı; seçim eşitlenmez (`syncKeys`, cihaza özgü).

- Açık cihaz, anahtarlarını kasanın `keys` bölümüne koyar (parmak izine göre: `{ "SHA256:…": { name, type, public, private,
  passphrase?, mtime } }`) ve diğer cihazların anahtarlarını alır. Özel anahtarlar da kasayla birlikte uçtan uca şifrelidir.
- Masaüstü: `~/.ssh`'deki çiftler (`.pub` + özel dosya) ve hesaptan gelenler gönderilir. Gelen anahtarlar `~/.ssh`'ye
  **yazılmaz**; `keys.json`'da (oturum parolaları gibi şifreli) durur, anahtar listesinde "hesaptan" etiketiyle görünür,
  bağlanırken bellekten kullanılır (`resolveKey`, main.js). Silme yalnız hesaptan gelenler için; `~/.ssh` dosyalarına dokunulmaz.
- Android: Ayarlar > SSH anahtarları'ndaki anahtarlar. Eşitleme açıkken silinen anahtar hesaptan da silinir.
- Oturumlar anahtarı `keyFp` (parmak izi) ile taşır: masaüstündeki `keyPath` ya da telefondaki `keyId` başka cihazda
  geçersiz olsa da aynı anahtar bulunur (Android `SshCore.pickKey`, masaüstü `resolveKey`).
- Kapalı cihaz kasadaki anahtarlara dokunmaz (gönderdiği kasaya olduğu gibi geri koyar). 1.6 öncesi sürümler `keys`
  bölümünü tanımaz ve silebilir; anahtar eşitlemesi açık bir cihaz eşitlenince geri yüklenir. Tüm cihazları güncelleyin.

## Kurtarma anahtarı

Hesap penceresi > Kurtarma anahtarı (Android: Hesap ve eşitleme > Kurtarma anahtarı). Hesap parolası sorulur; 20 rastgele
bayttan oluşan kod `ABCD-EFGH-…` (base32, 32 harf) bir kez gösterilir, kopyalanabilir ya da metin dosyasına kaydedilebilir.

```
kod ──HKDF "sshdeck-recovery-auth"──► recAuth  ──► sunucu (scrypt özeti saklanır)
kod ──HKDF "sshdeck-recovery-wrap"──► recWrap  ──► VK'yı sarar (recWrapped sunucuda)
```

- Oluşturma/kaldırma hesap parolasıyla doğrulanır (`POST /api/recovery`); yalnız jetonla olmaz, çalınan jeton yetmesin.
- Parola unutulunca: giriş penceresinde "Hesap parolamı unuttum" -> sunucu, kullanıcı, kod (ya da dosya), yeni parola.
  `POST /api/recover/begin` recWrapped'ı verir, istemci VK'yı çözüp yeni parolayla sarar, `POST /api/recover/finish` kaydeder.
  Tüm oturumlar kapanır; kasa aynı kalır. Kod geçerli kalır (VK değişmez); yenisi oluşturulunca eskisi geçersizdir.
- Deneme sınırı girişle aynı (kullanıcı ve IP başına 15 dakikada 10). Sunucu kodun kendisini hiç görmez.
- Dosya biçimi (iki platform aynı): `Sunucu:`, `Kullanıcı:`, `Anahtar:` satırları olan düz metin.

## Birleştirme

Kasa: `{ sessions: {id: {..., mtime}}, deleted: {id: zaman}, settings: {data, mtime}, keys: {parmak izi: {..., mtime}} }`.
Anahtarlar oturumlarla aynı kuralla (yeni olan kazanır, silme kaydı `deleted`'da) birleşir.

Hazır komutlar (1.8+) komut başına birleşir: kasada `snippets: {id: {..., mtime}}`, silinen komut `deleted`'a girer.
Komut düzenlemesi ayar bloğunun zamanını değiştirmez. Eski sürümler için blokta `data.snippets` listesi de durur ve
birleşmiş haritadan yeniden kurulur (sıra: kazanan bloğun sırası, sonra yeniler). Komut haritası olmayan eski kasada
liste, bloğun zamanıyla haritaya çevrilir (`snippetMap`, Java'da `SyncCore.snippetMap`).
`mergeVaults()` (store.js): her oturumda değişme zamanı yeni olan kazanır; silme kaydı kendinden sonra
düzenlenmemiş oturumu siler; ayarlar bütün olarak yeni olan kazanır. Silme kayıtları 180 gün tutulur.
Sunucu iyimser kilit kullanır (`baseVersion`); çakışırsa (409) istemci güncel kasayla yeniden birleştirir.

Eşitlenmeyenler (cihaza özgü): `logDir`, `logEnabled`, panel/sütun boyutları, güncelleme durumu, ana parola,
oturumların `localDir` alanı. Liste: `LOCAL_SETTINGS`, `LOCAL_SESSION_FIELDS` (store.js).

Android (`core/SyncCore.java` protokol, `app/Store.java` yerel veri, `app/AccountSync.java` zamanlama):
- Ayarlardan yalnız `SYNC_SETTINGS` (hazır komutlar, terminal teması, `savePrompted`, `confirmClose`, `autoReconnect`,
  `cursorBlink`) alınır/değiştirilir; hesaptaki ayar bloğu `sync.json`'da tutulur, masaüstünün diğer ayarları korunur.
  Arayüz teması ve yazı boyutu telefona özgü kalır.
- Oturumlarda `keyId` (telefondaki anahtar) cihaza özgüdür; masaüstünün `keyPath`'i telefonda düzenlenince silinmez.
  Hızlı bağlan (geçici) oturumları eşitlenmez.
- Jeton ve kasa anahtarı Android Keystore ile şifreli `sync.json`'da.
- Uyumluluk testi: `bash android/coretest/run.sh` (masaüstü hesap açar → Java girer, değiştirir → masaüstü doğrular).

Ne zaman eşitlenir: açılışta, yerel bir değişiklikten 2 sn sonra, 5 dakikada bir, pencereye dönünce
(en fazla 30 sn'de bir), uykudan uyanınca, ana parola açılınca.
