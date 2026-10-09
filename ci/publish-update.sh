#!/usr/bin/env bash
# Sürüm dosyalarını Forgejo generic paket deposuna (sshdeck/<sürüm>/) yükler ve imzalı
# sshdeck/latest/latest.json'ı yeniler. Uygulamalar bunu anonim okur (depo özel olsa da paketler açık).
# Kullanım: publish-update.sh <sürüm> <notlar-dosyası>
# Ortam: PACKAGE_TOKEN (package yazma yetkili token), UPDATE_SIGNING_KEY, GITHUB_SERVER_URL, GITHUB_REPOSITORY
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

node ci/update-feed.js "$version" "$notes" "$base/$version" dist > latest.json
for f in "SSHDeck-$version-kurulum.exe" "SSHDeck-$version-tasinabilir.exe" "SSHDeck-$version.AppImage" "sshdeck-$version.pacman" "SSHDeck-$version.apk"; do
    put "dist/$f" "$version" "$f"
done
put latest.json latest latest.json
curl -sS --fail-with-body -o /dev/null "$base/latest/latest.json"
echo "Güncelleme yayında: $base/latest/latest.json"
