#!/usr/bin/env bash
# <tag> için Forgejo release'i oluşturur (aynı etiketli eski release silinir) ve dosyaları ekler.
# ROLLING=1: etiketin kendisi de silinip güncel commit'te yeniden oluşturulur ("gelistirme" ön sürümü).
# Kullanım: forgejo-release.sh <tag> <başlık> <notlar-dosyası> <ön-sürüm: true|false> <dosya>...
# Ortam: FORGEJO_TOKEN, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA (Forgejo Actions verir)
set -euo pipefail
tag=$1 title=$2 notes=$3 prerelease=$4
shift 4
command -v jq > /dev/null || { apt-get update -qq && apt-get install -y -qq jq > /dev/null; }

api="$GITHUB_SERVER_URL/api/v1/repos/$GITHUB_REPOSITORY"
auth=(-H "Authorization: token $FORGEJO_TOKEN")

curl -sS -o /dev/null -X DELETE "${auth[@]}" "$api/releases/tags/$tag" || true
if [ "${ROLLING:-0}" = 1 ]; then
    curl -sS -o /dev/null -X DELETE "${auth[@]}" "$api/tags/$tag" || true
fi
body=$(jq -n --arg tag "$tag" --arg name "$title" --rawfile notes "$notes" \
    --arg sha "$GITHUB_SHA" --argjson pre "$prerelease" \
    '{tag_name: $tag, name: $name, body: $notes, target_commitish: $sha, prerelease: $pre}')
id=$(curl -sS --fail-with-body -X POST "${auth[@]}" -H 'Content-Type: application/json' \
    -d "$body" "$api/releases" | jq -r .id)

for file in "$@"; do
    echo "Yükleniyor: $(basename "$file")"
    curl -sS --fail-with-body -o /dev/null -X POST "${auth[@]}" \
        -F "attachment=@$file" "$api/releases/$id/assets?name=$(basename "$file")"
done
echo "Release: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/releases/tag/$tag"
