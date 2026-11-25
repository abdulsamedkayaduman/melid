package dev.melid.core;

import com.jcraft.jsch.JSch;
import com.jcraft.jsch.KeyPair;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;

import org.bouncycastle.crypto.AsymmetricCipherKeyPair;
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator;
import org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters;
import org.bouncycastle.crypto.util.OpenSSHPrivateKeyUtil;
import org.bouncycastle.crypto.util.OpenSSHPublicKeyUtil;

import static dev.melid.core.SshCore.obj;

/** SSH anahtarı üretme ve içe aktarılan özel anahtarı doğrulama (JSch). */
public final class Keys {
    private Keys() { }

    /** type: ed25519 | rsa | ecdsa. Dönüş: {private, public, type, fingerprint} */
    public static JSONObject generate(String type, String comment) throws Exception {
        if (!type.equals("rsa") && !type.equals("ecdsa")) return generateEd25519(comment);
        JSch jsch = new JSch();
        KeyPair kp;
        switch (type) {
            case "rsa": kp = KeyPair.genKeyPair(jsch, KeyPair.RSA, 4096); break;
            case "ecdsa": kp = KeyPair.genKeyPair(jsch, KeyPair.ECDSA, 256); break;
            default: kp = KeyPair.genKeyPair(jsch, KeyPair.ED25519); break;
        }
        ByteArrayOutputStream prv = new ByteArrayOutputStream();
        kp.writePrivateKey(prv);
        ByteArrayOutputStream pub = new ByteArrayOutputStream();
        kp.writePublicKey(pub, comment);
        JSONObject o = obj("private", prv.toString("UTF-8"), "public", pub.toString("UTF-8").trim(),
                "type", kp.getKeyTypeString(), "fingerprint", SshCore.fingerprint(kp.getPublicKeyBlob()));
        kp.dispose();
        return o;
    }

    /** JSch ed25519 özel anahtarı yazamıyor: BouncyCastle ile üret, OpenSSH biçiminde yaz. */
    static JSONObject generateEd25519(String comment) throws Exception {
        Ed25519KeyPairGenerator g = new Ed25519KeyPairGenerator();
        g.init(new Ed25519KeyGenerationParameters(new SecureRandom()));
        AsymmetricCipherKeyPair kp = g.generateKeyPair();
        byte[] prv = OpenSSHPrivateKeyUtil.encodePrivateKey(kp.getPrivate());
        byte[] blob = OpenSSHPublicKeyUtil.encodePublicKey(kp.getPublic());
        StringBuilder pem = new StringBuilder("-----BEGIN OPENSSH PRIVATE KEY-----\n");
        String b64 = Base64.getEncoder().encodeToString(prv);
        for (int i = 0; i < b64.length(); i += 70) pem.append(b64, i, Math.min(b64.length(), i + 70)).append('\n');
        pem.append("-----END OPENSSH PRIVATE KEY-----\n");
        String pub = "ssh-ed25519 " + Base64.getEncoder().encodeToString(blob) + (comment == null || comment.isEmpty() ? "" : " " + comment);
        return obj("private", pem.toString(), "public", pub, "type", "ssh-ed25519", "fingerprint", SshCore.fingerprint(blob));
    }

    /**
     * Özel anahtarı ayrıştır. Şifreliyse ve passphrase yoksa {encrypted:true} döner.
     * Dönüş: {public, type, fingerprint, encrypted}
     */
    public static JSONObject inspect(String privateText, String passphrase, String comment) throws Exception {
        JSch jsch = new JSch();
        KeyPair kp;
        try {
            kp = KeyPair.load(jsch, privateText.getBytes(StandardCharsets.UTF_8), null);
        } catch (Exception e) {
            throw new Exception("Özel anahtar okunamadı (OpenSSH / PEM biçiminde olmalı)");
        }
        try {
            if (kp.isEncrypted()) {
                if (passphrase == null || passphrase.isEmpty()) return obj("encrypted", true);
                if (!kp.decrypt(passphrase)) throw new Exception("Anahtar parolası yanlış");
            }
            byte[] blob = kp.getPublicKeyBlob();
            if (blob == null) throw new Exception("Açık anahtar türetilemedi");
            ByteArrayOutputStream pub = new ByteArrayOutputStream();
            kp.writePublicKey(pub, comment == null ? "" : comment);
            return obj("public", pub.toString("UTF-8").trim(), "type", kp.getKeyTypeString(),
                    "fingerprint", SshCore.fingerprint(blob), "encrypted", false);
        } finally {
            kp.dispose();
        }
    }
}
