#!/usr/bin/env bash
# APK imza anahtarını Forgejo repo secret'larına yükler (bir kez çalıştırılır; geliştirme makinesinde).
# Kullanım: FORGEJO_TOKEN=<token> bash ci/set-android-secrets.sh
#   Token: Forgejo > Ayarlar > Uygulamalar > Erişim token'ı oluştur (yetki: repository okuma+yazma).
# android/keystore.properties ve içindeki storeFile (melid-release.jks) okunur; değerler ekrana yazılmaz.
set -euo pipefail
cd "$(dirname "$0")/../android"
: "${FORGEJO_TOKEN:?FORGEJO_TOKEN gerekli}"
SERVER=${FORGEJO_URL:-http://192.168.1.50:3001}
REPO=${FORGEJO_REPO:-abdulsamed.kayaduman/ssh-deck}
prop() { sed -n "s/^$1=//p" keystore.properties | tr -d '\r'; }
jks="app/$(prop storeFile)"
[ -f "$jks" ] || { echo "Keystore bulunamadı: $jks"; exit 1; }
put() {
    code=$(jq -n --arg d "$2" '{data: $d}' | curl -sS -o /dev/null -w '%{http_code}' -X PUT \
        -H "Authorization: token $FORGEJO_TOKEN" -H 'Content-Type: application/json' -d @- \
        "$SERVER/api/v1/repos/$REPO/actions/secrets/$1")
    case $code in 201|204) echo "✓ $1" ;; *) echo "✗ $1 (HTTP $code)"; exit 1 ;; esac
}
put ANDROID_KEYSTORE_BASE64 "$(base64 -w0 "$jks")"
put ANDROID_KEYSTORE_PASSWORD "$(prop storePassword)"
put ANDROID_KEY_ALIAS "$(prop keyAlias)"
put ANDROID_KEY_PASSWORD "$(prop keyPassword)"
