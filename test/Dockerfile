# Melid testleri için tek kullanımlık SSH sunucusu (parola + anahtar, tünellere izinli)
FROM alpine:3.20
RUN apk add --no-cache openssh bash coreutils \
 && ssh-keygen -A \
 && adduser -D -s /bin/bash deck && echo 'deck:deckpass' | chpasswd \
 && mkdir -p /home/deck/.ssh && chmod 700 /home/deck/.ssh \
 && printf 'Port 22\nPort 2222\nPasswordAuthentication yes\nPubkeyAuthentication yes\nKbdInteractiveAuthentication no\nAllowTcpForwarding yes\nMaxAuthTries 20\nSubsystem sftp internal-sftp\n' > /etc/ssh/sshd_config
COPY .work/userkey.pub /home/deck/.ssh/authorized_keys
RUN chown -R deck:deck /home/deck/.ssh && chmod 600 /home/deck/.ssh/authorized_keys
CMD ["/usr/sbin/sshd", "-D", "-e"]
