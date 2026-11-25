package dev.melid.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Uygulama kullanım sayıları (usage.json, cihaza özgü): günlük bağlantı / aktarım / tünel sayıları. Masaüstündeki
 * src/main/usage.js'in karşılığı. Yalnız sayılar; sunucu adresi, dosya adı tutulmaz. Hesap açıksa ve ayarlardan
 * kapatılmadıysa SyncCore eşitlemeden sonra sunucuya gönderir (POST /api/usage).
 */
class UsageStats {
    static final String[] KEYS = {"connections", "connectionFailures", "transfers", "transferFailures", "bytesUp", "bytesDown", "tunnels"};
    private final File file;
    private JSONObject days;
    private long dirtyAt = 0;
    /** Aktarım kimliği -> yön ("down" / "up"), bitince sayılır */
    final Map<String, String> xferDir = new ConcurrentHashMap<>();

    UsageStats(Context ctx) {
        file = new File(ctx.getFilesDir(), "usage.json");
        try { days = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)).getJSONObject("days"); }
        catch (Exception e) { days = new JSONObject(); }
    }

    static String dayKey(long t) { return new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(new Date(t)); }

    synchronized void inc(String key, long n) {
        if (n <= 0) return;
        try {
            String k = dayKey(System.currentTimeMillis());
            JSONObject d = days.optJSONObject(k);
            if (d == null) { d = new JSONObject(); days.put(k, d); }
            d.put(key, d.optLong(key) + n);
            // diske en fazla 10 saniyede bir
            if (System.currentTimeMillis() - dirtyAt > 10000) save();
        } catch (Exception ignored) { }
    }

    synchronized void save() {
        try {
            String cut = dayKey(System.currentTimeMillis() - 40L * 86400000);
            for (Iterator<String> it = days.keys(); it.hasNext(); ) if (it.next().compareTo(cut) < 0) it.remove();
            File tmp = new File(file.getPath() + ".tmp");
            Files.write(tmp.toPath(), new JSONObject().put("days", days).toString().getBytes(StandardCharsets.UTF_8));
            if (!tmp.renameTo(file)) Files.write(file.toPath(), Files.readAllBytes(tmp.toPath()));
            dirtyAt = System.currentTimeMillis();
        } catch (Exception ignored) { }
    }

    /** Son 14 günün sayaçları (gün başına tam değer; tekrar gönderim üstüne yazar) */
    synchronized JSONObject recent() {
        JSONObject out = new JSONObject();
        String cut = dayKey(System.currentTimeMillis() - 14L * 86400000);
        try { for (Iterator<String> it = days.keys(); it.hasNext(); ) { String k = it.next(); if (k.compareTo(cut) > 0) out.put(k, days.get(k)); } }
        catch (Exception ignored) { }
        return out;
    }

    /** App.emit'ten: aktarım bitti / tünel açıldı */
    void onEvent(String type, JSONObject d) {
        if ("xfer".equals(type)) {
            String st = d.optString("state");
            if (!st.equals("done") && !st.equals("error") && !st.equals("cancelled")) return;
            String dir = xferDir.remove(d.optString("id"));
            if (dir == null) return;
            if (st.equals("done")) { inc("transfers", 1); inc(dir.equals("down") ? "bytesDown" : "bytesUp", d.optLong("total")); }
            else if (st.equals("error")) inc("transferFailures", 1);
        } else if ("fwd".equals(type) && "on".equals(d.optString("state"))) inc("tunnels", 1);
    }
}
