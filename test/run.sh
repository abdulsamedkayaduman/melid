#!/usr/bin/env bash
# Çekirdek SSH/SFTP/tünel testlerini Docker'daki geçici bir sshd'ye karşı çalıştırır.
# Kullanım: npm test     (Docker veya Podman gerekir)
set -euo pipefail
cd "$(dirname "$0")"
node importers.test.js
node store.test.js
node termlog.test.js
node sync.test.js
node conncheck.test.js
node updater.test.js
DOCKER=${DOCKER:-$(command -v docker || command -v podman)}
mkdir -p .work
[ -f .work/userkey ] || ssh-keygen -q -t ed25519 -N kpass -f .work/userkey
"$DOCKER" build -q -t melid-test-sshd . >/dev/null
"$DOCKER" rm -f melid-test >/dev/null 2>&1 || true
"$DOCKER" run -d --name melid-test -p 127.0.0.1:2222:2222 melid-test-sshd >/dev/null
trap '"$DOCKER" rm -f melid-test >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/2222) 2>/dev/null && break; sleep 0.3; done
# agent'ı kapat ki "otomatik" kimlik doğrulama testi tutarlı olsun
env -u SSH_AUTH_SOCK node core.test.js
