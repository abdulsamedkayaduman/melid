#!/usr/bin/env bash
# CI'da (root, Debian container) test/Dockerfile'daki test sunucusunun aynısını yerelde açar:
# deck/deckpass kullanıcısı, 22 + 2222 portları, parola + anahtar, tünellere izinli.
# Sonra `node test/core.test.js` bu sunucuya bağlanır (Docker gerekmez).
set -euo pipefail
# runner container'ı umask 000 ile başlayabiliyor; sshd geniş izinli dizin/dosyaları reddeder
umask 022
cd "$(dirname "$0")/.."
if ! command -v sshd > /dev/null; then
    # paket kurulumu sistemin sshd'sini 22'de başlatmasın (policy-rc.d), yoksa bizimki portu alamaz
    printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d
    apt-get update -qq && apt-get install -y -qq openssh-server > /dev/null
    rm -f /usr/sbin/policy-rc.d
fi
# yine de çalışan bir sshd varsa (önceden kurulu imaj) durdur
pkill -x sshd 2> /dev/null || true
mkdir -p test/.work
install -d -m 755 -o root -g root /run/sshd
[ -f test/.work/userkey ] || ssh-keygen -q -t ed25519 -N kpass -f test/.work/userkey
id deck > /dev/null 2>&1 || useradd -m -s /bin/bash deck
echo 'deck:deckpass' | chpasswd
install -d -m 700 -o deck -g deck /home/deck/.ssh
install -m 600 -o deck -g deck test/.work/userkey.pub /home/deck/.ssh/authorized_keys
ssh-keygen -A > /dev/null
printf 'Port 22\nPort 2222\nPasswordAuthentication yes\nPubkeyAuthentication yes\nKbdInteractiveAuthentication no\nUsePAM no\nAllowTcpForwarding yes\nMaxAuthTries 20\nSubsystem sftp internal-sftp\n' > /tmp/sshd_test_config
/usr/sbin/sshd -t -f /tmp/sshd_test_config
/usr/sbin/sshd -f /tmp/sshd_test_config -E /tmp/sshd_test.log || { cat /tmp/sshd_test.log; exit 1; }
for _ in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/2222) 2> /dev/null && exit 0; sleep 0.3; done
cat /tmp/sshd_test.log; exit 1
