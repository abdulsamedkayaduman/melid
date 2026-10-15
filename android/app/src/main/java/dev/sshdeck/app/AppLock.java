package dev.sshdeck.app;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * Uygulama kilidi (ana parola + isteğe bağlı biyometrik). lock.json: { salt, hash (PBKDF2-SHA512), iter, biometric, timeout }.
 *
 * Sırlar zaten Android Keystore ile şifreli (Store); kilit, telefonu açık eline geçiren birinin oturumlara, parolalara
 * ve terminallere erişmesini engeller. Kilitliyken köprü yalnız kilit çağrılarını kabul eder (Bridge.dispatch);
 * eşitleme ve açık bağlantılar arka planda sürer. Biyometrik giriş Keystore'daki, kullanıcı doğrulaması isteyen
 * bir anahtarla (CryptoObject) yapılır: yeni parmak izi eklenince anahtar geçersizleşir, parola istenir.
 */
class AppLock {
    static final int MIN_ITER = 50000, MAX_ITER = 600000;
    static final String BIO_ALIAS = "sshdeck-lock-bio";

    final App app;
    JSONObject cfg;
    volatile boolean locked;
    long stoppedAt; // elapsedRealtime; uygulama arka plana geçince
    int fails;
    long blockedUntil;

    AppLock(App app) {
        this.app = app;
        cfg = app.store.loadObj("lock.json");
        locked = enabled();
    }

    boolean enabled() { return cfg.has("hash"); }

    synchronized JSONObject status() throws JSONException {
        return new JSONObject().put("enabled", enabled()).put("locked", locked)
                .put("biometric", enabled() && cfg.optBoolean("biometric")).put("bioAvailable", bioAvailable())
                .put("timeout", cfg.optInt("timeout", 60));
    }

    // ------------------------------------------------------------------ yaşam döngüsü
    void onStop() { stoppedAt = SystemClock.elapsedRealtime(); }

    /** Ön plana dönünce: süre dolduysa kilitle. Kilitlendiyse true. */
    boolean onStart() {
        if (!enabled() || locked || stoppedAt == 0) return false;
        long away = SystemClock.elapsedRealtime() - stoppedAt;
        stoppedAt = 0;
        if (away < cfg.optInt("timeout", 60) * 1000L) return false;
        locked = true;
        return true;
    }

    void lockNow() { if (enabled()) locked = true; }

    // ------------------------------------------------------------------ parola
    /** Platformun (Conscrypt, native) PBKDF2'si: saf Java'dan çok daha hızlı */
    static byte[] derive(String pw, byte[] salt, int iter) {
        try {
            PBEKeySpec spec = new PBEKeySpec(pw.toCharArray(), salt, iter, 256);
            try { return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA512").generateSecret(spec).getEncoded(); } finally { spec.clearPassword(); }
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** Bu cihazda doğrulama ~0,4 sn sürecek tur sayısı (telefonlar arasında hız farkı büyük) */
    static int calibrate() {
        byte[] salt = new byte[16];
        long t0 = System.nanoTime();
        derive("olcum", salt, 5000);
        double perIter = (System.nanoTime() - t0) / 5000.0;
        int n = (int) Math.min(MAX_ITER, Math.max(MIN_ITER, 400e6 / Math.max(1, perIter)));
        return n / 1000 * 1000;
    }

    synchronized boolean check(String pw) {
        if (!enabled() || pw == null) return false;
        byte[] salt = Base64.decode(cfg.optString("salt"), Base64.NO_WRAP);
        byte[] want = Base64.decode(cfg.optString("hash"), Base64.NO_WRAP);
        return MessageDigest.isEqual(derive(pw, salt, cfg.optInt("iter", MIN_ITER)), want);
    }

    /** Parolayla aç; art arda yanlışta giderek artan bekleme */
    synchronized void unlock(String pw) throws Exception {
        long now = SystemClock.elapsedRealtime();
        if (now < blockedUntil) throw new Exception("Çok fazla yanlış deneme. " + ((blockedUntil - now) / 1000 + 1) + " sn sonra tekrar deneyin");
        if (!check(pw)) {
            fails++;
            // Yanlış denemeler sayılır: 5'ten sonra 30 sn, sonra katlanarak (en çok 5 dk) beklenir
            if (fails >= 5) blockedUntil = now + Math.min(300, 30L << Math.min(4, fails - 5)) * 1000;
            throw new Exception("Parola yanlış");
        }
        fails = 0;
        locked = false;
    }

    /** Ana parolayı koy / değiştir (etkinse eski parola gerekir) */
    synchronized void setPassword(String oldPw, String pw) throws Exception {
        if (enabled() && !check(oldPw)) throw new Exception("Mevcut parola yanlış");
        if (pw == null || pw.length() < 4) throw new Exception("Parola en az 4 karakter olmalı");
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        int iter = calibrate();
        JSONObject n = new JSONObject(cfg.toString());
        n.put("salt", Base64.encodeToString(salt, Base64.NO_WRAP)).put("hash", Base64.encodeToString(derive(pw, salt, iter), Base64.NO_WRAP)).put("iter", iter);
        if (!n.has("timeout")) n.put("timeout", 60);
        save(n);
        locked = false;
    }

    synchronized void disable(String pw) throws Exception {
        if (!check(pw)) throw new Exception("Parola yanlış");
        save(new JSONObject());
        deleteBioKey();
        locked = false;
    }

    synchronized void setTimeout(int sec) throws Exception {
        if (!enabled()) return;
        JSONObject n = new JSONObject(cfg.toString());
        n.put("timeout", Math.max(0, sec));
        save(n);
    }

    void save(JSONObject n) {
        cfg = n;
        app.store.save("lock.json", n);
    }

    // ------------------------------------------------------------------ biyometrik
    @android.annotation.TargetApi(30) // yalnız SDK >= 30 dallarında çağrılır
    static int authenticators() { return BiometricManager.Authenticators.BIOMETRIC_STRONG; }

    boolean bioAvailable() {
        try {
            BiometricManager bm = app.getSystemService(BiometricManager.class);
            if (bm == null) return false;
            if (Build.VERSION.SDK_INT >= 30) return bm.canAuthenticate(authenticators()) == BiometricManager.BIOMETRIC_SUCCESS;
            return app.getPackageManager().hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)
                    && bm.canAuthenticate() == BiometricManager.BIOMETRIC_SUCCESS;
        } catch (Exception e) {
            return false;
        }
    }

    /** Biyometrik girişi aç/kapat; açarken parola sorulur ve parmak iziyle bir kez doğrulanır */
    void setBiometric(Activity act, boolean on, String pw) throws Exception {
        if (!enabled()) throw new Exception("Önce ana parola belirleyin");
        if (on) {
            if (!check(pw)) throw new Exception("Parola yanlış");
            if (!bioAvailable()) throw new Exception("Bu telefonda kayıtlı parmak izi / yüz tanıma yok (Android Ayarlar > Güvenlik)");
            deleteBioKey();
            createBioKey();
            prompt(act, "Biyometrik girişi aç", "Doğrulamak için parmağınızı okutun");
        } else deleteBioKey();
        synchronized (this) {
            JSONObject n = new JSONObject(cfg.toString());
            n.put("biometric", on);
            save(n);
        }
    }

    /** Biyometrikle aç (kilit ekranından) */
    void unlockBiometric(Activity act) throws Exception {
        if (!enabled() || !cfg.optBoolean("biometric")) throw new Exception("Biyometrik giriş kapalı");
        prompt(act, "SSHDeck kilidini aç", null);
        locked = false;
        synchronized (this) { fails = 0; }
    }

    static void createBioKey() throws Exception {
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(BIO_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= 30) b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        g.init(b.build());
        g.generateKey();
    }

    static void deleteBioKey() {
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            ks.deleteEntry(BIO_ALIAS);
        } catch (Exception ignored) { }
    }

    /**
     * BiometricPrompt'u ana iş parçacığında açar, sonucu bekler (köprü iş parçacığında çağrılır).
     * Doğrulama Keystore anahtarına bağlıdır: başarıdan sonra anahtarla şifreleme yapılabilmesi gerekir.
     */
    void prompt(Activity act, String title, String sub) throws Exception {
        if (act == null) throw new Exception("Uygulama ekranı açık değil");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            SecretKey key = (SecretKey) ks.getKey(BIO_ALIAS, null);
            if (key == null) throw new KeyPermanentlyInvalidatedException();
            cipher.init(Cipher.ENCRYPT_MODE, key);
        } catch (KeyPermanentlyInvalidatedException e) {
            synchronized (this) {
                JSONObject n = new JSONObject(cfg.toString());
                n.put("biometric", false);
                save(n);
            }
            deleteBioKey();
            throw new Exception("Telefona yeni parmak izi / yüz eklendiği için biyometrik giriş kapatıldı. Parolayla açıp Ayarlar > Uygulama kilidi'nden yeniden açın.");
        }
        BlockingQueue<Object> result = new ArrayBlockingQueue<>(1);
        CancellationSignal cancel = new CancellationSignal();
        app.main.post(() -> {
            BiometricPrompt.Builder b = new BiometricPrompt.Builder(act).setTitle(title)
                    .setNegativeButton("Parola kullan", act.getMainExecutor(), (d, w) -> result.offer(new Exception("")));
            if (sub != null) b.setSubtitle(sub);
            if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(authenticators());
            try {
                b.build().authenticate(new BiometricPrompt.CryptoObject(cipher), cancel, act.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                        try {
                            r.getCryptoObject().getCipher().doFinal(new byte[16]);
                            result.offer(Boolean.TRUE);
                        } catch (Exception e) {
                            result.offer(new Exception("Biyometrik doğrulama kullanılamadı"));
                        }
                    }

                    @Override public void onAuthenticationError(int code, CharSequence msg) {
                        boolean user = code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED || code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED;
                        result.offer(new Exception(user ? "" : String.valueOf(msg)));
                    }
                });
            } catch (Exception e) {
                result.offer(e);
            }
        });
        Object r = result.take();
        if (r instanceof Exception) throw (Exception) r;
    }
}
