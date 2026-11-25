#!/usr/bin/env bash
# Sürüm dosyalarını Forgejo generic paket deposuna (sshdeck/<sürüm>/; eski sürümler bu yola baktığı için ad değişmedi) yükler ve imzalı
# sshdeck/latest/latest.json'ı yeniler. Uygulamalar bunu anonim okur (depo özel olsa da paketler açık).
# Kullanım: publish-update.sh <sürüm> <notlar-dosyası>
# Ortam: PACKAGE_TOKEN (package yazma yetkili token), UPDATE_SIGNING_KEY, GITHUB_SERVER_URL, GITHUB_REPOSITORY
#       PUBLIC_DOWNLOAD_BASE (isteğe bağlı): latest.json'daki indirme adreslerinin tabanı, ör. https://melid.ornek.com/indir
#       (eşitleme sunucusu UPDATE_UPSTREAM ile bu depoyu dışarıya aktarır). Yoksa doğrudan paket deposu adresleri.
set -euo pipefail
version=$1 notes=$2
[ -n "${PACKAGE_TOKEN:-}" ] || { echo "::error::PACKAGE_TOKEN secret'ı yok (package yazma yetkili Forgejo token'ı; bkz. docs/ci.md)"; exit 1; }
[ -n "${UPDATE_SIGNING_KEY:-}" ] || { echo "::error::UPDATE_SIGNING_KEY secret'ı yok (bkz. docs/ci.md)"; exit 1; }
base="$GITHUB_SERVER_URL/api/packages/${GITHUB_REPOSITORY%%/*}/generic/sshdeck"
auth=(-H "Authorization: token $PACKAGE_TOKEN")

put() { # <yerel dosya> <paket sürümü> <dosya adı>; aynı adla varsa önce silinir (generic paketler değiştirilemez)
    curl -sS -o /dev/null -X DELETE "${auth[@]}" "$base/$2/$3" || true
    echo "Yükleniyor: $2/$3"
    curl -sS --fail-with-body -o /dev/null -X PUT "${auth[@]}" --upload-file "$1" "$base/$2/$3"
}

pub=${PUBLIC_DOWNLOAD_BASE:-$base}
node ci/update-feed.js "$version" "$notes" "${pub%/}/$version" dist > latest.json
for f in "Melid-$version-kurulum.exe" "Melid-$version-tasinabilir.exe" "Melid-$version.AppImage" "melid-$version.pacman" "Melid-$version.apk" \
         "Melid-$version-mac-arm64.tar.gz" "Melid-$version-mac-x64.tar.gz"; do
    [ -f "dist/$f" ] || continue
    put "dist/$f" "$version" "$f"
done
# İki sürümün derlemesi üst üste binerse geç biten eski sürüm latest'i geri almasın
current=$(curl -sS "$base/latest/latest.json" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(Buffer.from(JSON.parse(s).payload,'base64')).version)}catch{}})" || true)
if [ -n "$current" ] && node -e "process.exit(require('./src/main/updater.js').compareVersions(process.argv[1], process.argv[2]) > 0 ? 0 : 1)" "$current" "$version"; then
    echo "latest daha yeni ($current), $version için latest.json yenilenmedi"
    exit 0
fi
put latest.json latest latest.json
curl -sS --fail-with-body -o /dev/null "$base/latest/latest.json"
echo "Güncelleme yayında: $base/latest/latest.json"
