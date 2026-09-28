#!/usr/bin/env bash
# Çekirdek SSH/SFTP/tünel testlerini Docker'daki geçici bir sshd'ye karşı çalıştırır.
# Kullanım: npm test     (Docker veya Podman gerekir)
set -euo pipefail
cd "$(dirname "$0")"
DOCKER=${DOCKER:-$(command -v docker || command -v podman)}
mkdir -p .work
[ -f .work/userkey ] || ssh-keygen -q -t ed25519 -N kpass -f .work/userkey
"$DOCKER" build -q -t sshdeck-test-sshd . >/dev/null
"$DOCKER" rm -f sshdeck-test >/dev/null 2>&1 || true
"$DOCKER" run -d --name sshdeck-test -p 127.0.0.1:2222:2222 sshdeck-test-sshd >/dev/null
trap '"$DOCKER" rm -f sshdeck-test >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/2222) 2>/dev/null && break; sleep 0.3; done
# agent'ı kapat ki "otomatik" kimlik doğrulama testi tutarlı olsun
env -u SSH_AUTH_SOCK node core.test.js
