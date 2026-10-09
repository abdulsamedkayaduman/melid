# Hesap ve eşitleme

Giriş yapılan her cihazda oturumlar, kayıtlı parolalar, ayarlar ve hazır komutlar eşitlenir.
Uçtan uca şifrelidir: sunucu verileri çözemez.

## Sunucuyu çalıştırmak

`server/sync-server.js` bağımlılıksızdır (yalnız Node 18+). Tek dosya; başka bir makineye kopyalamak yeter.

```
PORT=3150 HOST=0.0.0.0 DATA_DIR=/var/lib/sshdeck-sync SSHDECK_SYNC_INVITE='uzun-rastgele-kod' node server/sync-server.js
```

- `SSHDECK_SYNC_INVITE`: hesap açmak için gereken davet kodu. Boşsa yeni hesap açılamaz (mevcutlar çalışır).
  Herkese açık sunucuda hesaplarınızı açtıktan sonra boşaltmak iyi bir fikir.
- `TLS_CERT` / `TLS_KEY`: verilirse HTTPS dinler. Alternatif: Caddy/nginx ters vekil ya da Tailscale.
- Sürekli çalışması için örnek systemd birimi: `server/sshdeck-sync.service`.
- Yedek: `DATA_DIR` klasörünü yedeklemek yeter (`users.json`, `tokens.json`, `vaults/`, `secret.json`).

Uygulamada: araç çubuğundaki bulut düğmesi → **Hesap oluştur** (ilk cihaz, davet kodu ile) → diğer cihazlarda **Giriş yap**.

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

## Birleştirme

Kasa: `{ sessions: {id: {..., mtime}}, deleted: {id: zaman}, settings: {data, mtime} }`.
`mergeVaults()` (store.js): her oturumda değişme zamanı yeni olan kazanır; silme kaydı kendinden sonra
düzenlenmemiş oturumu siler; ayarlar bütün olarak yeni olan kazanır. Silme kayıtları 180 gün tutulur.
Sunucu iyimser kilit kullanır (`baseVersion`); çakışırsa (409) istemci güncel kasayla yeniden birleştirir.

Eşitlenmeyenler (cihaza özgü): `logDir`, `logEnabled`, panel/sütun boyutları, güncelleme durumu, ana parola,
oturumların `localDir` alanı. Liste: `LOCAL_SETTINGS`, `LOCAL_SESSION_FIELDS` (store.js).

Ne zaman eşitlenir: açılışta, yerel bir değişiklikten 2 sn sonra, 5 dakikada bir, pencereye dönünce
(en fazla 30 sn'de bir), uykudan uyanınca, ana parola açılınca.
