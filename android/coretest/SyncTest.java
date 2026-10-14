import dev.sshdeck.core.SyncCore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Iterator;

/**
 * Hesap eşitlemesi (core/SyncCore): gerçek server/sync-server.js'e karşı, masaüstü istemcisiyle (sync-desktop.js) birlikte.
 * Sıra (run.sh): masaüstü hesap açar -> bu test giriş yapar, değiştirir, kendi hesabını açar -> masaüstü doğrular.
 */
public class SyncTest {
    static int passed = 0;

    static void ok(boolean cond, String name) {
        if (!cond) throw new AssertionError("BAŞARISIZ: " + name);
        passed++;
        System.out.println("  ✓ " + name);
    }

    /** Android Store'un eşitleme davranışının bellek içi karşılığı (sırlar düz, keyId cihaza özgü, ayar bloğu) */
    static class MemLocal implements SyncCore.Local {
        static final String[] SYNC_SETTINGS = {"snippets", "theme", "savePrompted", "confirmClose", "autoReconnect", "cursorBlink"};
        JSONObject acc; String token; byte[] vk;
        JSONObject sessions = new JSONObject(), deleted = new JSONObject(), settings = new JSONObject();
        JSONObject blob;

        public JSONObject account() { return acc == null ? null : new JSONObject(acc.toString()); }
        public String token() { return token; }
        public byte[] vk() { return vk; }
        public void setAccount(JSONObject a, String t, byte[] v) { acc = a; token = t; vk = v; }
        public void setVersion(long version, long lastSync) { acc.put("version", version).put("lastSync", lastSync); }
        public void firstDevice() { JSONObject b = blob(); if (b.optLong("mtime") == 0) { b.put("mtime", System.currentTimeMillis()); blob = b; } }

        JSONObject blob() {
            if (blob != null) return new JSONObject(blob.toString());
            JSONObject d = new JSONObject();
            for (String k : SYNC_SETTINGS) if (settings.has(k)) d.put(k, settings.get(k));
            return new JSONObject().put("data", d).put("mtime", 0);
        }

        void saveSession(JSONObject s) {
            JSONObject prev = sessions.optJSONObject(s.getString("id"));
            JSONObject n = prev == null ? new JSONObject() : new JSONObject(prev.toString());
            for (String k : s.keySet()) n.put(k, s.get(k));
            n.put("mtime", System.currentTimeMillis());
            sessions.put(n.getString("id"), n);
        }

        void saveSetting(String k, Object v) {
            settings.put(k, v);
            if (Arrays.asList(SYNC_SETTINGS).contains(k)) { JSONObject b = blob(); b.getJSONObject("data").put(k, v); b.put("mtime", System.currentTimeMillis()); blob = b; }
        }

        public JSONObject snapshot() {
            JSONObject ss = new JSONObject();
            for (String id : sessions.keySet()) { JSONObject o = new JSONObject(sessions.getJSONObject(id).toString()); o.remove("keyId"); ss.put(id, o); }
            return new JSONObject().put("sessions", ss).put("deleted", new JSONObject(deleted.toString())).put("settings", blob());
        }

        public void apply(JSONObject v) {
            JSONObject next = new JSONObject();
            JSONObject vs = v.getJSONObject("sessions");
            for (Iterator<String> it = vs.keys(); it.hasNext(); ) {
                String id = it.next();
                JSONObject o = new JSONObject(vs.getJSONObject(id).toString());
                JSONObject old = sessions.optJSONObject(id);
                if (old != null && old.has("keyId")) o.put("keyId", old.get("keyId"));
                next.put(id, o);
            }
            sessions = next;
            JSONObject rs = v.getJSONObject("settings");
            if (!SyncCore.canon(rs).equals(SyncCore.canon(blob()))) {
                for (String k : SYNC_SETTINGS) if (rs.getJSONObject("data").has(k)) settings.put(k, rs.getJSONObject("data").get(k));
                blob = new JSONObject(rs.toString());
            }
            deleted = new JSONObject(v.getJSONObject("deleted").toString());
        }

        JSONObject byName(String n) {
            for (String id : sessions.keySet()) if (n.equals(sessions.getJSONObject(id).optString("name"))) return sessions.getJSONObject(id);
            return null;
        }
    }

    static String expectError(SyncTest.ThrowingRunnable r) {
        try { r.run(); } catch (Exception e) { return e.getMessage(); }
        throw new AssertionError("Hata bekleniyordu");
    }

    interface ThrowingRunnable { void run() throws Exception; }

    public static void main(String[] args) {
        try { run(args[0], args[1], Integer.parseInt(args[2])); } catch (Throwable e) { e.printStackTrace(); System.exit(1); }
    }

    static void run(String work, String server, int port) throws Exception {
        System.out.println("hesap eşitlemesi (masaüstü uyumu)");
        // canon + mergeVaults, JS ile birebir
        JSONObject mj = new JSONObject(Files.readString(new File(work, "merge.json").toPath()));
        ok(SyncCore.canon(mj.getJSONObject("a")).equals(mj.getString("canonA")), "sıralı JSON (canon) JS ile aynı");
        ok(SyncCore.canon(SyncCore.mergeVaults(mj.getJSONObject("a"), mj.getJSONObject("b"), 10)).equals(mj.getString("expected")), "mergeVaults JS ile aynı sonuç");

        ok(SyncCore.normServer("192.168.1.50").equals("http://192.168.1.50:3150"), "portsuz adrese 3150");
        ok(SyncCore.normServer("https://Senkron.Ornek.com/").equals("https://senkron.ornek.com"), "https adresi");

        MemLocal L = new MemLocal();
        L.settings.put("fontSize", 11).put("uiTheme", "mint");
        SyncCore.Client c = new SyncCore.Client(L, "SSHDeck test Android");
        ok(expectError(() -> c.login("http://8.8.8.8:3150", "samed", "x")).contains("https gerekli"), "internette düz http reddedilir");
        ok(expectError(() -> c.login(server, "samed", "yanlis")).contains("parola yanlış"), "yanlış hesap parolası");
        c.login(server, "Samed", "hesapParolası-ş");
        ok(c.status().optBoolean("loggedIn") && c.status().optString("state").equals("ok"), "giriş (PBKDF2 + HKDF masaüstüyle aynı)");
        JSONObject desk = L.byName("masaüstü");
        ok(desk != null && desk.optString("password").equals("gizli-ğ"), "masaüstü oturumu ve parolası geldi");
        ok(!desk.has("localDir"), "masaüstü localDir gelmez");
        ok(L.settings.getJSONArray("snippets").length() == 1 && L.settings.optInt("fontSize") == 11, "hazır komut geldi, yazı boyutu yerel kaldı");

        // Android değişiklikleri: yeni oturum (keyId cihaza özgü), masaüstü oturumunu düzenle, hazır komut ekle
        L.saveSession(new JSONObject().put("id", "and1").put("name", "android").put("host", "a.example").put("password", "tel-parola-ü").put("keyId", "k-yerel"));
        L.saveSession(new JSONObject().put("id", desk.getString("id")).put("name", "masaüstü-düzenlendi"));
        JSONArray sn = new JSONArray(L.settings.getJSONArray("snippets").toString()).put(new JSONObject().put("id", "s2").put("name", "bellek").put("command", "free -h"));
        L.saveSetting("snippets", sn);
        L.saveSetting("fontSize", 22);
        c.syncNow();
        ok(L.byName("android").optString("keyId").equals("k-yerel"), "keyId bu cihazda korunur");
        ok(c.status().optLong("version") >= 2, "kasa yüklendi (sürüm " + c.status().optLong("version") + ")");

        // Android'den yeni hesap
        MemLocal L2 = new MemLocal();
        L2.saveSession(new JSONObject().put("id", "t1").put("name", "telefondan").put("host", "t"));
        SyncCore.Client c2 = new SyncCore.Client(L2, "SSHDeck test Android");
        ok(expectError(() -> c2.register(server, "telefon", "telefonParola1", "yanlis")).contains("Davet kodu yanlış"), "yanlış davet kodu");
        c2.register(server, "telefon", "telefonParola1", "davet");
        ok(c2.status().optLong("version") == 1, "Android'den hesap açma");

        // Yerel ağ taraması: kapalı adres ve port atlanır, sunucu bulunur
        JSONArray found = SyncCore.scan(Arrays.asList("127.0.0.3", "127.0.0.1"), port, 500);
        ok(found.length() == 1 && found.getJSONObject(0).getString("server").equals("http://127.0.0.1:" + port) && found.getJSONObject(0).optBoolean("register"), "yerel ağ taraması sunucuyu buldu");
        ok(!SyncCore.lanTargets().isEmpty(), "taranacak adresler: " + SyncCore.lanTargets().size());

        // Çıkış: jeton sunucuda iptal
        String tok = L2.token;
        c2.logout();
        ok(!c2.status().optBoolean("loggedIn") && L2.byName("telefondan") != null, "çıkış (yerel oturumlar kalır)");
        L2.setAccount(new JSONObject().put("server", server).put("user", "telefon").put("version", 1), tok, new byte[32]);
        ok(expectError(c2::syncNow).contains("tekrar giriş") && c2.state.equals("auth"), "iptal edilen jeton: tekrar giriş istenir");

        System.out.println("\n" + passed + " eşitleme testi geçti");
        System.exit(0);
    }
}
