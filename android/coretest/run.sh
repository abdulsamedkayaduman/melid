#!/usr/bin/env bash
# Android SSH çekirdeğini (dev.sshdeck.core) masaüstü JVM'de test eder:
#  - yetkisiz geçici bir OpenSSH sshd (anahtar, shell, exec, SFTP, tüneller, jump)
#  - parola / keyboard-interactive akışları için ssh2 (Node) sunucusu
# Kullanım: bash android/coretest/run.sh   (JDK 17 + /usr/sbin/sshd gerekir)
set -euo pipefail
cd "$(dirname "$0")"
W=.work; L=.lib
mkdir -p $W $L
M=https://repo1.maven.org/maven2
get() { [ -f "$L/$2" ] || curl -sfL -o "$L/$2" "$M/$1/$2"; }
get com/github/mwiede/jsch/2.28.7 jsch-2.28.7.jar
get org/bouncycastle/bcprov-jdk18on/1.83 bcprov-jdk18on-1.83.jar
get org/json/json/20240303 json-20240303.jar
CP="$L/jsch-2.28.7.jar:$L/bcprov-jdk18on-1.83.jar:$L/json-20240303.jar"

[ -f $W/hostkey ] || ssh-keygen -q -t ed25519 -N '' -f $W/hostkey
[ -f $W/userkey ] || ssh-keygen -q -t ed25519 -N '' -C test -f $W/userkey
[ -f $W/userkey_enc ] || ssh-keygen -q -t ed25519 -N kpass -C test-enc -f $W/userkey_enc
[ -f $W/userkey_rsa ] || ssh-keygen -q -t rsa -b 3072 -m PEM -N '' -C test-rsa -f $W/userkey_rsa
cat $W/userkey.pub $W/userkey_enc.pub $W/userkey_rsa.pub > $W/authorized_keys
chmod 600 $W/authorized_keys
ABS=$(pwd)/$W
cat > $W/sshd_config <<CFG
Port 2299
ListenAddress 127.0.0.1
HostKey $ABS/hostkey
PidFile $ABS/sshd.pid
AuthorizedKeysFile $ABS/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
AllowTcpForwarding yes
GatewayPorts no
Subsystem sftp /usr/lib/openssh/sftp-server
CFG
[ -f $W/sshd.pid ] && kill "$(cat $W/sshd.pid)" 2>/dev/null || true
/usr/sbin/sshd -f $W/sshd_config -E $ABS/sshd.log
node pwserver.js > $W/pwserver.log 2>&1 &
PW=$!
# hesap eşitlemesi: gerçek sunucu (SyncTest + sync-desktop.js)
SYNC_PORT=3157
rm -rf $W/syncdata
PORT=$SYNC_PORT HOST=127.0.0.1 DATA_DIR=$W/syncdata SSHDECK_SYNC_INVITE=davet node ../../server/sync-server.js > $W/sync.log 2>&1 &
SY=$!
trap 'kill $(cat $W/sshd.pid) 2>/dev/null; kill $PW $SY 2>/dev/null' EXIT
sleep 0.5

rm -rf $W/classes && mkdir -p $W/classes
javac -nowarn -encoding UTF-8 -d $W/classes -cp "$CP" ../app/src/main/java/dev/sshdeck/core/*.java CoreTest.java SyncTest.java
# masaüstü store.js ile şifreli yedek üret -> Java çözer; Java'nın şifrelediğini Node çözer
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const { Store } = require("../../src/main/store");
const st = new Store(fs.mkdtempSync(path.join(os.tmpdir(),"sshdeck-bk-")), { available:()=>false, encrypt:s=>s, decrypt:s=>s });
st.saveSession({ name:"yedek", host:"h", username:"u", password:"gizli-ğ" });
fs.writeFileSync(process.argv[1], JSON.stringify(st.exportData({ passphrase:"yedekP" })));
' "$W/backup.json"
java -cp "$W/classes:$CP" CoreTest "$ABS"
node -e '
const crypto=require("crypto"),fs=require("fs");
const bk=JSON.parse(fs.readFileSync(process.argv[1]+"/backup.json"));
const key=crypto.pbkdf2Sync(Buffer.from("yedekP"),Buffer.from(bk.secretsSalt,"base64"),200000,32,"sha512");
const buf=Buffer.from(fs.readFileSync(process.argv[1]+"/java-enc.txt","utf8"),"base64");
const d=crypto.createDecipheriv("aes-256-gcm",key,buf.subarray(0,12)); d.setAuthTag(buf.subarray(12,28));
const out=Buffer.concat([d.update(buf.subarray(28)),d.final()]).toString();
if(out!=="geri-dönüş") { console.error("Node, Java şifrelemesini çözemedi"); process.exit(1); }
console.log("  ✓ Java yedek şifrelemesi masaüstünde çözülüyor");
' "$W"

# hesap eşitlemesi: masaüstü hesap açar -> Android (Java) girer, değiştirir, kendi hesabını açar -> masaüstü doğrular
S=http://127.0.0.1:$SYNC_PORT
node sync-desktop.js pre "$ABS" $S
java -cp "$W/classes:$CP" SyncTest "$ABS" $S $SYNC_PORT
node sync-desktop.js post "$ABS" $S
