package dev.melid.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * Güncellemeler: masaüstündeki src/main/updater.js ile aynı imzalı latest.json (Forgejo generic paket deposu).
 * Arka planda JobScheduler ile 12 saatte bir denetlenir, yeni sürüm bildirim olarak gelir; kurulum
 * PackageInstaller ile (Android onay ekranı gösterir). APK aynı anahtarla imzalı olmalı, yoksa Android reddeder.
 */
public final class Updater {
    static final String FEED_URL = "https://melid.abdulsamed.net/guncelleme/latest.json";
    static final String PUBLIC_KEY = "JZZUOZm0s+7S9kpAprN5IKx+6fMm07tbSeq5jkCy2Fo=";
    static final String CHANNEL = "updates";
    static final int NOTIF_ID = 2;
    static final int JOB_ID = 7;
    static final String ACTION_SHOW = "dev.melid.app.SHOW_UPDATE";
    static final String ACTION_INSTALLED = "dev.melid.app.UPDATE_STATUS";

    /** Son denetimin sonucu (imzası doğrulanmış içerik) */
    static volatile JSONObject info;
    static volatile boolean cancel;

    private Updater() { }

    static String feedUrl() {
        String u = App.I.store.settings.optString("updateUrl", "");
        return u.isEmpty() ? FEED_URL : u;
    }

    static String currentVersion(Context ctx) {
        try { return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName; } catch (Exception e) { return "0"; }
    }

    /** "1.2.10" > "1.2.9"; aynı çekirdekte eksiz (kararlı) sürüm, -beta gibi ekli olandan büyüktür. */
    static int compare(String a, String b) {
        String[] pa = a.replaceFirst("^v", "").split("-", 2), pb = b.replaceFirst("^v", "").split("-", 2);
        String[] x = pa[0].split("\\."), y = pb[0].split("\\.");
        for (int i = 0; i < 3; i++) {
            int d = Integer.compare(num(x, i), num(y, i));
            if (d != 0) return d;
        }
        String ea = pa.length > 1 ? pa[1] : "", eb = pb.length > 1 ? pb[1] : "";
        if (ea.equals(eb)) return 0;
        if (ea.isEmpty()) return 1;
        if (eb.isEmpty()) return -1;
        return Integer.signum(ea.compareTo(eb));
    }

    private static int num(String[] p, int i) {
        try { return i < p.length ? Integer.parseInt(p[i]) : 0; } catch (NumberFormatException e) { return 0; }
    }

    /** latest.json'ı doğrular; imza geçersizse hata. */
    static JSONObject parseFeed(String text, String pubKeyB64) throws Exception {
        JSONObject outer;
        try { outer = new JSONObject(text); } catch (Exception e) { throw new Exception("Güncelleme bilgisi okunamadı"); }
        byte[] payload = Base64.decode(outer.optString("payload"), Base64.DEFAULT);
        byte[] sig = Base64.decode(outer.optString("sig"), Base64.DEFAULT);
        Ed25519Signer v = new Ed25519Signer();
        v.init(false, new Ed25519PublicKeyParameters(Base64.decode(pubKeyB64, Base64.DEFAULT), 0));
        v.update(payload, 0, payload.length);
        if (sig.length != 64 || !v.verifySignature(sig)) throw new Exception("Güncelleme bilgisinin imzası geçersiz");
        JSONObject in = new JSONObject(new String(payload, StandardCharsets.UTF_8));
        if (!"melid".equals(in.optString("app")) || in.optString("version").isEmpty() || in.optJSONObject("files") == null)
            throw new Exception("Güncelleme bilgisi okunamadı");
        return in;
    }

    static HttpURLConnection open(String url, int timeout) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(timeout);
        c.setReadTimeout(timeout);
        c.setUseCaches(false);
        return c;
    }

    static String netError(Exception e) {
        if (e instanceof java.net.SocketTimeoutException) return "Güncelleme sunucusu yanıt vermedi";
        if (e instanceof java.net.ConnectException || e instanceof java.net.UnknownHostException || e instanceof java.net.NoRouteToHostException)
            return "Güncelleme sunucusuna ulaşılamadı (internet bağlantınızı denetleyin)";
        return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
    }

    /** Sunucuya sorar, Updater.info'yu günceller; durum nesnesini döndürür. */
    static synchronized JSONObject check(Context ctx) throws Exception {
        HttpURLConnection c = null;
        try {
            c = open(feedUrl(), 15000);
            int code = c.getResponseCode();
            if (code == 404) { info = null; }
            else if (code != 200) throw new Exception("Güncelleme sunucusu hata verdi (HTTP " + code + ")");
            else {
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                try (InputStream in = c.getInputStream()) { copy(in, bo); }
                info = parseFeed(bo.toString("UTF-8"), PUBLIC_KEY);
            }
        } catch (Exception e) {
            if (e.getMessage() != null && e.getMessage().startsWith("Güncelleme")) throw e;
            throw new Exception(netError(e));
        } finally {
            if (c != null) c.disconnect();
        }
        App.I.store.saveSettings(dev.melid.core.SshCore.obj("updateLastCheck", System.currentTimeMillis()));
        return state(ctx);
    }

    static JSONObject state(Context ctx) throws Exception {
        JSONObject i = info;
        String cur = currentVersion(ctx);
        JSONObject f = i == null ? null : i.getJSONObject("files").optJSONObject("android");
        boolean newer = i != null && compare(i.getString("version"), cur) > 0;
        JSONObject st = new JSONObject();
        st.put("current", cur);
        st.put("newer", newer);
        st.put("version", i == null ? JSONObject.NULL : i.getString("version"));
        st.put("notes", i == null ? "" : i.optString("notes"));
        st.put("date", i == null ? JSONObject.NULL : i.optString("date"));
        st.put("canInstall", newer && f != null);
        st.put("size", f == null ? 0 : f.optLong("size"));
        st.put("skipped", i != null && i.getString("version").equals(App.I.store.settings.optString("updateSkip")));
        return st;
    }

    interface Progress { void on(long done, long total); }

    /** APK'yı indirir ve boyut + sha256 doğrular. Aynı dosya daha önce tam indirildiyse yeniden indirmez. */
    static File download(Context ctx, Progress p) throws Exception {
        JSONObject i = info;
        JSONObject f = i == null ? null : i.getJSONObject("files").optJSONObject("android");
        if (f == null) throw new Exception("Bu sürümde Android paketi yok");
        File dir = new File(ctx.getCacheDir(), "guncelleme");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File dest = new File(dir, "Melid-" + i.getString("version") + ".apk");
        String want = f.getString("sha256").toLowerCase(Locale.ROOT);
        long size = f.optLong("size");
        if (dest.length() == size && want.equals(sha256(dest))) { p.on(size, size); return dest; }
        for (File old : dir.listFiles() == null ? new File[0] : dir.listFiles()) //noinspection ResultOfMethodCallIgnored
            old.delete();
        cancel = false;
        File part = new File(dir, dest.getName() + ".part");
        HttpURLConnection c = null;
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        long done = 0;
        try {
            c = open(f.getString("url"), 30000);
            if (c.getResponseCode() != 200) throw new Exception("İndirme başarısız (HTTP " + c.getResponseCode() + ")");
            long total = size > 0 ? size : c.getContentLengthLong();
            long last = 0;
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancel) throw new Exception("İptal edildi");
                    out.write(buf, 0, n);
                    md.update(buf, 0, n);
                    done += n;
                    long now = System.currentTimeMillis();
                    if (now - last > 200) { last = now; p.on(done, total); }
                }
            }
            p.on(done, total);
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            if ("İptal edildi".equals(e.getMessage()) || (e.getMessage() != null && e.getMessage().startsWith("İndirme"))) throw e;
            throw new Exception(netError(e));
        } finally {
            if (c != null) c.disconnect();
        }
        if ((size > 0 && done != size) || !want.equals(hex(md.digest()))) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            throw new Exception("İndirilen dosya doğrulanamadı (bozuk ya da değiştirilmiş)");
        }
        if (!part.renameTo(dest)) throw new Exception("İndirilen dosya kaydedilemedi");
        return dest;
    }

    /** Bilinmeyen kaynak izni yoksa ayar ekranını açar ve false döner. */
    static boolean ensureInstallPermission(Context ctx) {
        if (ctx.getPackageManager().canRequestPackageInstalls()) return true;
        Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
        return false;
    }

    /** PackageInstaller oturumu: Android onay penceresini InstallReceiver açar. */
    static void install(Context ctx, File apk) throws Exception {
        PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams sp = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        sp.setAppPackageName(ctx.getPackageName());
        if (Build.VERSION.SDK_INT >= 31) sp.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(sp);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = s.openWrite("base.apk", 0, apk.length())) {
                copy(in, out);
                s.fsync(out);
            }
            Intent cb = new Intent(ctx, InstallReceiver.class).setAction(ACTION_INSTALLED);
            int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getBroadcast(ctx, id, cb, fl).getIntentSender());
        }
    }

    static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        return hex(md.digest());
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02x", x));
        return sb.toString();
    }

    static void copy(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    // ------------------------------------------------------------------ arka plan denetimi + bildirim
    static void schedule(Context ctx) {
        JobScheduler js = ctx.getSystemService(JobScheduler.class);
        if (!App.I.store.settings.optBoolean("autoUpdate", true)) { js.cancel(JOB_ID); return; }
        if (js.getPendingJob(JOB_ID) != null) return;
        js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(ctx, CheckJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(12 * 3600_000L)
                .setPersisted(true)
                .build());
    }

    static volatile long lastCheck;

    /** Uygulama ön plandayken (açılışta ve geri dönüşte): bu süreçte 6 saattir denetlenmediyse denetle. */
    static void checkIfDue(Context ctx, Runnable onNewer) {
        if (!App.I.store.settings.optBoolean("autoUpdate", true)) return;
        if (System.currentTimeMillis() - lastCheck < 6 * 3600_000L) return;
        lastCheck = System.currentTimeMillis();
        new Thread(() -> {
            try {
                JSONObject st = check(ctx);
                if (st.optBoolean("newer") && !st.optBoolean("skipped")) onNewer.run();
            } catch (Exception ignored) { }
        }).start();
    }

    static void notifyNewer(Context ctx, String version) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Güncellemeler", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("Yeni Melid sürümü çıktığında gösterilir");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(ctx, MainActivity.class).setAction(ACTION_SHOW).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 3, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        nm.notify(NOTIF_ID, new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Melid " + version + " çıktı")
                .setContentText("Yeni sürümü görmek ve kurmak için dokunun")
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build());
    }

    /** JobScheduler: 12 saatte bir (ağ varken) denetler; her sürüm için bir kez bildirir. */
    public static class CheckJob extends JobService {
        @Override public boolean onStartJob(JobParameters params) {
            new Thread(() -> {
                try {
                    JSONObject st = check(this);
                    String v = st.optString("version");
                    if (st.optBoolean("newer") && !st.optBoolean("skipped") && !v.equals(App.I.store.settings.optString("updateNotified"))) {
                        notifyNewer(this, v);
                        App.I.store.saveSettings(dev.melid.core.SshCore.obj("updateNotified", v));
                    }
                } catch (Exception ignored) { }
                jobFinished(params, false);
            }).start();
            return true;
        }

        @Override public boolean onStopJob(JobParameters params) { return false; }
    }

    /** PackageInstaller sonucu: onay gerekiyorsa Android'in onay ekranını aç; hata olursa arayüze bildir. */
    public static class InstallReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context ctx, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) ctx.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return;
            }
            if (status == PackageInstaller.STATUS_SUCCESS) return; // süreç yeni sürümle değişir
            String msg = status == PackageInstaller.STATUS_FAILURE_ABORTED ? "Kurulum iptal edildi"
                    : status == PackageInstaller.STATUS_FAILURE_CONFLICT || status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE
                    ? "Kurulum reddedildi: paket farklı bir anahtarla imzalanmış olabilir"
                    : "Kurulum başarısız: " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            try { App.I.emit("updateProgress", dev.melid.core.SshCore.obj("error", msg)); } catch (Exception ignored) { }
        }
    }
}
