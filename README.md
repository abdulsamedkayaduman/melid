# Melid

Linux, Windows, macOS ve Android için açık kaynak SSH terminali ve SFTP dosya yöneticisi. Terminal, dosya aktarımı,
tüneller ve toplu sunucu işleri tek pencerede; oturumlar cihazlar arasında uçtan uca şifreli eşitlenir.
Arayüz Türkçe ve İngilizce (masaüstü). Electron + xterm.js + ssh2; Android'de WebView + JSch.

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
- **Yerel terminal**: bu bilgisayarın kabuğu (Linux/macOS: `$SHELL`, Windows: PowerShell) ayrı sekmede; bölme, arama, yayın aynı (Ctrl+Shift+O).
- **Geçiş**: Xshell (parolalar ve tünellerle, `.xts`), MobaXterm (`.mxtsessions` / `MobaXterm.ini`, klasörler, atlama sunucusu,
  anahtar dosyası) ve WindTerm oturumlarını içe aktarma; masaüstü uygulamada.

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

Linux:

```bash
# AppImage (her dağıtım): çalıştırılabilir yapıp açın
chmod +x Melid-<sürüm>.AppImage
./Melid-<sürüm>.AppImage
# Ubuntu 22.04+ "FUSE" hatası verirse: sudo apt install libfuse2   (24.04: libfuse2t64)

# Arch / CachyOS / Manjaro: pacman paketi (menüye "Melid" ve "melid" komutu eklenir)
sudo pacman -U melid-<sürüm>.pacman
```

Kayıtlı parolalar sistemin anahtarlığında (GNOME Keyring / KWallet) şifrelenir. Anahtarlık yoksa Ayarlar'dan bir ana parola
belirleyin.

Uygulamalar yeni sürümü kendileri bildirir; Windows, Linux ve Android'de tek tıkla kurulur.

## Xshell'den geçiş

Masaüstü uygulamada, oturumlar klasörleri, parolaları ve tünelleriyle birlikte gelir.

1. **Xshell'de** oturumları dışa aktarın (Export): bir `.xts` dosyası oluşur. Ya da doğrudan Xshell'in `Sessions` klasörünü kullanın
   (`Belgeler\NetSarang Computer\<sürüm>\Xshell\Sessions`).
2. **Melid'de** araç çubuğundaki **İçe aktar** düğmesi → **Xshell** → `.xts` dosyasını (ya da `.xsh` dosyalarını / klasörü) seçin.
3. **Parolalar:** Xshell parolaları, onları kaydeden Windows kullanıcısına bağlı bir anahtarla ya da Xshell ana parolasıyla şifreler.
   - Aynı Windows bilgisayarında, aynı kullanıcıyla içe aktarıyorsanız parolalar kendiliğinden çözülür.
   - Xshell'de ana parola (Master Password) ayarladıysanız Melid onu sorar.
   - Başka bir bilgisayarda (Linux, macOS ya da başka bir Windows) içe aktarıyorsanız, Xshell'in kurulu olduğu Windows'ta komut
     istemine `whoami /user` yazın; çıkan **kullanıcı adını** ve `S-1-5-21-…` ile başlayan **SID**'i Melid'in sorduğu pencereye girin.
4. Bazı parolalar çözülemezse (ör. "133 parolanın 91'i çözüldü"), bu bir hata değildir: kalan oturumlar başka bir bilgisayarda,
   başka bir kullanıcıyla ya da eski bir ana parolayla kaydedilmiştir. Başka bir ana parola / kullanıcı deneyebilir ya da
   **Kalanlar parolasız, devam et** diyebilirsiniz; parolası olmayan oturumda parola ilk bağlantıda sorulur ve kaydedilebilir.
   **İptal** (ya da pencereyi kapatmak) içe aktarmayı tamamen iptal eder.

Gelenler: klasörler, ad, adres, port, kullanıcı adı, açıklama, parola, tüneller (yerel `-L`, uzak `-R`, SOCKS `-D`).
Gelmeyenler: Xshell'in kendi anahtar deposundaki özel anahtarlar (Xshell'den dışa aktarıp `~/.ssh`'ye koyun) ve görünüm ayarları.
WindTerm oturumları da aynı düğmeden, WindTerm ana parolasıyla parolalarıyla birlikte aktarılır.

## MobaXterm'den geçiş

1. **MobaXterm'de** soldaki oturum listesinde en üstteki **User sessions**'a sağ tıklayın → **Export sessions**: bir `.mxtsessions`
   dosyası oluşur. Ya da doğrudan `MobaXterm.ini`'yi seçin (kurulu sürüm: `%APPDATA%\MobaXterm\MobaXterm.ini`; taşınabilir
   sürüm: programın yanındaki `MobaXterm.ini`).
2. **Melid'de** **İçe aktar** → **MobaXterm oturumları** ile dosyayı seçin. SSH oturumları; klasörleri, kullanıcı adı, port,
   özel anahtar dosyası, giriş komutu, açıklama ve **SSH gateway** (atlama sunucusu) ile gelir. RDP, VNC gibi oturumlar atlanır.
3. **Parolalar:** kurulu MobaXterm parolaları Windows kayıt defterinde tutar, dışa aktarılan dosyaya koymaz; bunlar ilk bağlantıda
   sorulur. Taşınabilir sürümün `MobaXterm.ini` dosyasında parolalar varsa Melid MobaXterm ana parolasını sorar.

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
