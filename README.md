# Melid

Linux, Windows, macOS ve Android için açık kaynak SSH terminali ve SFTP dosya yöneticisi. Terminal, dosya aktarımı,
tüneller ve toplu sunucu işleri tek pencerede; oturumlar cihazlar arasında uçtan uca şifreli eşitlenir.
Arayüz Türkçe. Electron + xterm.js + ssh2; Android'de WebView + JSch.

**İndir:** https://melid.abdulsamed.net

## Özellikler

- **Terminal**: sekmeler, bölünmüş ekran, iki sekme grubu yan yana, arama, tüm sekmelere komut gönderme, hazır komutlar,
  oturum kaydı, bağlantı koparsa otomatik yeniden bağlanma.
- **SFTP**: yerel ↔ uzak çift panel, sürükle-bırak ve kopyala-yapıştır, yarım kalan aktarımı sürdürme, klasör eşitleme ve
  karşılaştırma, uzak dosyayı yerel editörde açıp kaydedince otomatik yükleme, önizleme.
- **Sunucudan sunucuya**: iki sunucu arasında dosyalar bilgisayara inmeden doğrudan kopyalanır.
- **Bağlantı**: parola, anahtar, ssh-agent / Pageant, klavye etkileşimli / 2FA, jump host zinciri, -L / -R / -D tünelleri,
  `~/.ssh/config` içe aktarma, sunucu anahtarı doğrulaması.
- **Toplu işler**: tüm oturumları denetleme (erişim, kimlik doğrulama), çok sunucuda komut, kaynak özeti (CPU, RAM, disk).
- **Hesap ve eşitleme**: oturumlar, kayıtlı parolalar, ayarlar, hazır komutlar ve isteğe bağlı SSH anahtarları cihazlar
  arasında uçtan uca şifreli eşitlenir. Genel sunucu hazır gelir; isteyen kendi sunucusunu kurar ([docs/senkron.md](docs/senkron.md)).
- **Güvenlik**: parolalar işletim sisteminin anahtarlığıyla şifreli, isteğe bağlı ana parola, şifreli yedek.
- **Geçiş**: WindTerm ve Xshell oturumlarını parolaları ve tünelleriyle içe aktarma (Xshell `.xts` dışa aktarması; masaüstü uygulamada).

## Kurulum

Hazır paketler indirme sayfasında: https://melid.abdulsamed.net

| Platform | Paket | Not |
|---|---|---|
| Windows 10/11 | kurulum veya taşınabilir `.exe` | İmzasız: SmartScreen'de "Ek bilgi" → "Yine de çalıştır" |
| macOS | `-mac-arm64.tar.gz` (Apple Silicon), `-mac-x64.tar.gz` (Intel) | İmzasız: ilk kurulum aşağıda |
| Linux | `.AppImage`, Arch için `.pacman` | |
| Android 8+ | `.apk` | |

macOS ilk kurulum:

```bash
tar xzf Melid-<sürüm>-mac-arm64.tar.gz
mv Melid.app /Applications/
xattr -cr /Applications/Melid.app
codesign --force --deep --sign - /Applications/Melid.app
```

Uygulamalar yeni sürümü kendileri bildirir; Windows, Linux ve Android'de tek tıkla kurulur.

## Kaynaktan çalıştırma

```bash
npm install
npm start          # npm run dev: F12 ile DevTools
```

Paket üretmek: `npm run dist` (Linux), `npm run dist:win`, `npm run dist:mac`. Android: [android/README.md](android/README.md).

## Kısayollar

macOS'ta Ctrl yerine Cmd.

| Tuş | İş |
|---|---|
| Ctrl+Shift+N | Yeni oturum |
| Ctrl+Shift+T | Sekmeyi çoğalt |
| Ctrl+Shift+W | Sekmeyi kapat |
| Ctrl+Tab / Alt+1..9 | Sekmeler arası geçiş |
| Ctrl+Shift+D / S | Terminali sağa / aşağı böl |
| Ctrl+Shift+E | SFTP panelini aç/kapat |
| Ctrl+Shift+B | Oturum listesini aç/kapat |
| Ctrl+Shift+F | Terminalde ara |
| Ctrl+Shift+K | Hazır komutlar |
| Ctrl+Shift+C / V | Kopyala / yapıştır |
| Ctrl+Shift+R | Yeniden bağlan |
| Ctrl + / − / 0 | Yazı boyutu |
| Dosya panelinde: Enter, Backspace, F2, F5, Del, Ctrl+A, Ctrl+C / V, Ctrl+F, Boşluk | Aç/aktar, üst dizin, yeniden adlandır, yenile, sil, tümünü seç, kopyala/yapıştır, süz, önizle |

## Eşitleme sunucusu

`server/` bağımlılıksız bir Node uygulaması (Docker / Dokploy dosyaları içinde). Genel sunucu `melid.abdulsamed.net`;
kendi sunucunuzu kurmak ve güvenlik modeli için [docs/senkron.md](docs/senkron.md). Sunucu kasaların içeriğini göremez:
yalnız kullanıcı adı, e-posta ve şifreli kasayı saklar.

## Geliştirme

- `npm test`: Docker/Podman'da geçici sshd açıp bağlantı, SFTP, aktarım, tünel testleri + sunucusuz birim testleri.
- Android çekirdeği: `bash android/coretest/run.sh` (JDK 17 + sshd).
- Mimari ve kurallar: [CLAUDE.md](CLAUDE.md). CI ve sürüm yayını: [docs/ci.md](docs/ci.md).

## Lisans

[MIT](LICENSE)
