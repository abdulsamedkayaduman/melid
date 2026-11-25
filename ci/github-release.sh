#!/usr/bin/env bash
# <tag> için GitHub release'i oluşturur (yoksa) ve dosyaları ekler; aynı adlı eski dosya silinip yeniden yüklenir.
# İndirme sayfası ve uygulama güncellemeleri buradan dağıtılır (latest.json: releases/latest/download/latest.json).
# Kullanım: github-release.sh <tag> <başlık> <notlar-dosyası> <dosya>...
# Ortam: GH_RELEASE_TOKEN (yalnız bu repoya Contents: read and write izinli token), GH_REPO (kullanıcı/repo), GITHUB_SHA
set -euo pipefail
tag=$1 title=$2 notes=$3
shift 3
command -v jq > /dev/null || { apt-get update -qq && apt-get install -y -qq jq > /dev/null; }
api="https://api.github.com/repos/$GH_REPO"
auth=(-H "Authorization: Bearer $GH_RELEASE_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

rel=$(curl -sS "${auth[@]}" "$api/releases/tags/$tag")
id=$(jq -r '.id // empty' <<< "$rel")
if [ -z "$id" ]; then
    # Etiket GitHub'a henüz gelmediyse (aynalama gecikmesi) GitHub onu bu commit'te oluşturur
    body=$(jq -n --arg tag "$tag" --arg name "$title" --rawfile notes "$notes" --arg sha "$GITHUB_SHA" \
        '{tag_name: $tag, name: $name, body: $notes, target_commitish: $sha, make_latest: "true"}')
    rel=$(curl -sS --fail-with-body -X POST "${auth[@]}" -d "$body" "$api/releases")
    id=$(jq -r .id <<< "$rel")
fi
for file in "$@"; do
    name=$(basename "$file")
    old=$(jq -r --arg n "$name" '.assets[]? | select(.name == $n) | .id' <<< "$rel")
    [ -n "$old" ] && curl -sS -o /dev/null -X DELETE "${auth[@]}" "$api/releases/assets/$old"
    echo "GitHub'a yükleniyor: $name"
    curl -sS --fail-with-body -o /dev/null -X POST "${auth[@]}" -H "Content-Type: application/octet-stream" \
        --data-binary "@$file" "https://uploads.github.com/repos/$GH_REPO/releases/$id/assets?name=$(jq -rn --arg n "$name" '$n|@uri')"
done
echo "GitHub release: https://github.com/$GH_REPO/releases/tag/$tag"
