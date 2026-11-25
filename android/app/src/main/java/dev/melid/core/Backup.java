package dev.melid.core;

import org.bouncycastle.crypto.digests.SHA512Digest;
import org.bouncycastle.crypto.generators.PKCS5S2ParametersGenerator;
import org.bouncycastle.crypto.params.KeyParameter;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Masaüstü Melid yedek dosyasının (Ayarlar > Yedekle) sır şifrelemesi; store.js ile birebir aynı:
 * anahtar = PBKDF2-SHA512(parola, salt, 200000, 32), değer = base64(iv(12) | tag(16) | şifreli metin), AES-256-GCM.
 */
public final class Backup {
    private Backup() { }

    public static final int KDF_ITER = 200000;

    public static byte[] deriveKey(String passphrase, byte[] salt) {
        PKCS5S2ParametersGenerator g = new PKCS5S2ParametersGenerator(new SHA512Digest());
        g.init(passphrase.getBytes(StandardCharsets.UTF_8), salt, KDF_ITER);
        return ((KeyParameter) g.generateDerivedParameters(256)).getKey();
    }

    public static byte[] randomSalt() {
        byte[] s = new byte[16];
        new SecureRandom().nextBytes(s);
        return s;
    }

    public static String encrypt(String plain, byte[] key) throws Exception {
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8)); // şifreli metin | tag
        int n = ct.length - 16;
        byte[] out = new byte[12 + 16 + n];
        System.arraycopy(iv, 0, out, 0, 12);
        System.arraycopy(ct, n, out, 12, 16);
        System.arraycopy(ct, 0, out, 28, n);
        return Base64.getEncoder().encodeToString(out);
    }

    /** Yanlış anahtar / bozuk veri -> istisna. */
    public static String decrypt(String b64, byte[] key) throws Exception {
        byte[] buf = Base64.getDecoder().decode(b64);
        if (buf.length < 28) throw new Exception("Bozuk veri");
        int n = buf.length - 28;
        byte[] ct = new byte[n + 16];
        System.arraycopy(buf, 28, ct, 0, n);
        System.arraycopy(buf, 12, ct, n, 16);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, buf, 0, 12));
        return new String(c.doFinal(ct), StandardCharsets.UTF_8);
    }
}
