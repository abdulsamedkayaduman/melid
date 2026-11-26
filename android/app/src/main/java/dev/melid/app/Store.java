package dev.melid.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import dev.melid.core.Backup;
import dev.melid.core.SyncCore;

/**
 * Kalıcı veri: sessions.json / settings.json / known_hosts.json / keys.json (uygulamanın özel klasöründe).
 * Sırlar (parola, anahtar parolası, özel anahtar) Android Keystore'daki AES anahtarıyla şifrelenir;
 * arayüze (WebView) asla gönderilmez, yalnızca has_password gibi bayraklar gider.
 */
public class Store implements SyncCore.Local {
    static final String[] SECRET_FIELDS = {"password", "passphrase"};
    static final String KS_ALIAS = "melid-secrets";
    /** Hesapla eşitlenen ayarlar (masaüstüyle ortak anlamı olanlar). Gerisi (arayüz teması, yazı boyutu…) cihaza özgü. */
    static final String[] SYNC_SETTINGS = {"snippets", "theme", "savePrompted", "confirmClose", "autoReconnect", "cursorBlink"};
    /** Oturumda cihaza özgü alanlar: keyId bu cihazın keys.json'una işaret eder; localDir masaüstünün yerel klasörü */
    static final String[] LOCAL_SESSION_FIELDS = {"keyId", "localDir"};

    final File dir;
    JSONArray sessions;
    JSONObject settings;
    JSONObject known;
    JSONArray keys;
    /**
     * Eşitleme durumu (sync.json): deleted (id -> silme zamanı), settings (hesaptaki ayar bloğu: {data, mtime};
     * masaüstünün ayarları da içinde, burada yalnız SYNC_SETTINGS değişir), account (jeton ve VK Keystore ile şifreli).
     */
    JSONObject sync;
    /** Eşitlenen bir veri değişince (AccountSync.schedule) */
    volatile Runnable onChange;

    public Store(Context ctx) {
        dir = ctx.getFilesDir();
        sessions = loadArr("sessions.json");
        settings = loadObj("settings.json");
        known = loadObj("known_hosts.json");
        keys = loadArr("keys.json");
        sync = loadObj("sync.json");
        try {
            if (!sync.has("deleted")) sync.put("deleted", new JSONObject());
        } catch (JSONException ignored) { }
    }

    void changed() {
        Runnable r = onChange;
        if (r != null) try { r.run(); } catch (Exception ignored) { }
    }

    // ------------------------------------------------------------------ files
    JSONArray loadArr(String name) {
        try { return new JSONArray(read(name)); } catch (Exception e) { return new JSONArray(); }
    }

    JSONObject loadObj(String name) {
        try { return new JSONObject(read(name)); } catch (Exception e) { return new JSONObject(); }
    }

    String read(String name) throws Exception {
        return new String(Files.readAllBytes(new File(dir, name).toPath()), StandardCharsets.UTF_8);
    }

    synchronized void save(String name, Object json) {
        File tmp = new File(dir, name + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) {
            o.write(json.toString().getBytes(StandardCharsets.UTF_8));
            o.getFD().sync();
        } catch (Exception e) {
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        tmp.renameTo(new File(dir, name));
    }

    // ------------------------------------------------------------------ keystore
    SecretKey ksKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(KS_ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(KS_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return g.generateKey();
    }

    JSONObject enc(String plain) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, ksKey());
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            JSONObject o = new JSONObject();
            o.put("ks", Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP));
            return o;
        } catch (Exception e) {
            throw new RuntimeException("Sır şifrelenemedi: " + e.getMessage());
        }
    }

    String dec(Object v) {
        if (!(v instanceof JSONObject)) return null;
        String s = ((JSONObject) v).optString("ks", "");
        int i = s.indexOf(':');
        if (i < 0) return null;
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, ksKey(), new GCMParameterSpec(128, Base64.decode(s.substring(0, i), Base64.NO_WRAP)));
            return new String(c.doFinal(Base64.decode(s.substring(i + 1), Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    // ------------------------------------------------------------------ state for UI
    public synchronized JSONObject state() throws JSONException {
        JSONObject o = new JSONObject();
        JSONArray ss = new JSONArray();
        for (int i = 0; i < sessions.length(); i++) ss.put(publicSession(sessions.getJSONObject(i)));
        o.put("sessions", ss);
        o.put("settings", settings);
        o.put("keys", publicKeys());
        o.put("knownHosts", known);
        return o;
    }

    static JSONObject publicSession(JSONObject s) throws JSONException {
        JSONObject p = new JSONObject(s.toString());
        for (String f : SECRET_FIELDS) {
            p.put("has_" + f, s.has(f) && !s.isNull(f));
            p.remove(f);
        }
        return p;
    }

    synchronized JSONArray publicKeys() throws JSONException {
        JSONArray a = new JSONArray();
        for (int i = 0; i < keys.length(); i++) {
            JSONObject k = new JSONObject(keys.getJSONObject(i).toString());
            k.put("has_passphrase", k.has("passphrase"));
            k.remove("private");
            k.remove("passphrase");
            a.put(k);
        }
        return a;
    }

    int indexOf(JSONArray arr, String id) {
        for (int i = 0; i < arr.length(); i++) if (id.equals(arr.optJSONObject(i).optString("id"))) return i;
        return -1;
    }

    // ------------------------------------------------------------------ sessions
    /** Masaüstü store.saveSession ile aynı kural: sır alanı yoksa korunur, "" ise silinir. */
    public synchronized String saveSession(JSONObject input) throws JSONException {
        String id = input.optString("id", "");
        if (id.isEmpty()) id = UUID.randomUUID().toString();
        int idx = indexOf(sessions, id);
        JSONObject prev = idx >= 0 ? sessions.getJSONObject(idx) : new JSONObject();
        JSONObject next = new JSONObject(prev.toString());
        for (Iterator<String> it = input.keys(); it.hasNext(); ) {
            String k = it.next();
            boolean secret = false;
            for (String f : SECRET_FIELDS) if (f.equals(k)) secret = true;
            if (secret || k.startsWith("has_")) continue;
            if (input.isNull(k)) next.remove(k); else next.put(k, input.get(k));
        }
        next.put("id", id);
        // Anahtarın parmak izi eşitlenir (keyId bu cihaza özgü): diğer cihaz aynı anahtarı bununla bulur
        String keyId = input.has("keyId") && !input.isNull("keyId") ? input.optString("keyId") : "";
        if (!keyId.isEmpty() && !keyId.equals(prev.optString("keyId"))) {
            String fp = keyFingerprint(keyId);
            if (fp != null) next.put("keyFp", fp); else next.remove("keyFp");
        } else if (input.has("keyId") && keyId.isEmpty() && !prev.optString("keyId").isEmpty()) next.remove("keyFp");
        for (String f : SECRET_FIELDS) {
            if (!input.has(f)) continue;
            String v = input.isNull(f) ? "" : input.optString(f);
            if (v.isEmpty()) next.remove(f); else next.put(f, enc(v));
        }
        next.put("mtime", System.currentTimeMillis());
        if (idx >= 0) sessions.put(idx, next); else sessions.put(next);
        save("sessions.json", sessions);
        if (!next.optBoolean("temporary")) changed();
        return id;
    }

    public synchronized void deleteSession(String id) throws JSONException {
        int idx = indexOf(sessions, id);
        long now = System.currentTimeMillis();
        boolean temp = idx >= 0 && sessions.getJSONObject(idx).optBoolean("temporary");
        if (idx >= 0) sessions.remove(idx);
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject s = sessions.getJSONObject(i);
            if (id.equals(s.optString("jumpHostId"))) { s.remove("jumpHostId"); s.put("mtime", now); }
        }
        save("sessions.json", sessions);
        if (idx < 0 || temp) return; // geçici (hızlı bağlan) oturumlar eşitlenmez
        sync.getJSONObject("deleted").put(id, now);
        save("sync.json", sync);
        changed();
    }

    /** Sırları çözülmüş oturum (yalnızca native tarafta kullanılır). */
    public synchronized JSONObject resolveSession(String id) {
        int idx = indexOf(sessions, id);
        if (idx < 0) return null;
        try {
            JSONObject s = new JSONObject(sessions.getJSONObject(idx).toString());
            for (String f : SECRET_FIELDS) {
                if (!s.has(f)) continue;
                String v = dec(s.get(f));
                if (v == null) s.remove(f); else s.put(f, v);
            }
            return s;
        } catch (JSONException e) {
            return null;
        }
    }

    public synchronized void saveCredentials(String id, JSONObject creds) {
        try {
            if (indexOf(sessions, id) < 0) return;
            JSONObject in = new JSONObject(creds.toString());
            in.put("id", id);
            saveSession(in);
        } catch (JSONException ignored) { }
    }

    // ------------------------------------------------------------------ settings
    public synchronized void saveSettings(JSONObject patch) throws JSONException {
        boolean synced = false, snipChanged = false;
        JSONObject blob = settingsBlob();
        // Hazır komutlar komut başına eşitlenir (mtime + silme kaydı); ayar bloğunun zamanını değiştirmez
        if (patch.optJSONArray("snippets") != null) {
            patch = new JSONObject(patch.toString());
            snipChanged = stampSnippets(patch.getJSONArray("snippets"), blob.optLong("mtime"));
        }
        for (Iterator<String> it = patch.keys(); it.hasNext(); ) {
            String k = it.next();
            Object v = patch.get(k);
            if (isSyncSetting(k) && !SyncCore.canon(v).equals(SyncCore.canon(settings.opt(k)))) {
                blob.getJSONObject("data").put(k, v);
                if (!k.equals("snippets")) synced = true;
            }
            settings.put(k, v);
        }
        save("settings.json", settings);
        if (synced) blob.put("mtime", System.currentTimeMillis());
        if (synced || snipChanged) {
            sync.put("settings", blob);
            save("sync.json", sync);
            changed();
        }
    }

    /** store.js stampSnippets: değişen/yeni komuta şimdiki zaman, silinene silme kaydı. Değişiklik oldu mu */
    boolean stampSnippets(JSONArray list, long fallback) throws JSONException {
        long now = System.currentTimeMillis();
        JSONArray old = settings.optJSONArray("snippets");
        java.util.Map<String, JSONObject> byId = new java.util.HashMap<>();
        if (old != null) for (int i = 0; i < old.length(); i++) { JSONObject o = old.optJSONObject(i); if (o != null && !o.optString("id").isEmpty()) byId.put(o.optString("id"), o); }
        boolean changed = false;
        java.util.Set<String> keep = new java.util.HashSet<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject x = list.optJSONObject(i);
            if (x == null || x.optString("id").isEmpty()) continue;
            keep.add(x.optString("id"));
            JSONObject o = byId.get(x.optString("id"));
            if (o != null && snipBody(o).equals(snipBody(x))) {
                long mt = o.optLong("mtime", 0);
                if (mt == 0) mt = x.optLong("mtime", 0);
                if (mt == 0) mt = fallback;
                x.put("mtime", mt);
            } else { x.put("mtime", now); changed = true; }
        }
        for (String id : byId.keySet()) if (!keep.contains(id)) { sync.getJSONObject("deleted").put(id, now); changed = true; }
        return changed;
    }

    static String snipBody(JSONObject x) throws JSONException {
        JSONObject c = new JSONObject(x.toString());
        c.remove("mtime");
        return SyncCore.canon(c);
    }

    static boolean isSyncSetting(String k) {
        for (String f : SYNC_SETTINGS) if (f.equals(k)) return true;
        return false;
    }

    /** Hesaptaki ayar bloğu; henüz yoksa bu cihazın eşitlenen ayarlarından (mtime 0: hesaptaki her ayar kazanır) */
    JSONObject settingsBlob() throws JSONException {
        JSONObject b = sync.optJSONObject("settings");
        if (b != null && b.optJSONObject("data") != null) return new JSONObject(b.toString());
        JSONObject data = new JSONObject();
        for (String k : SYNC_SETTINGS) if (settings.has(k)) data.put(k, settings.get(k));
        return new JSONObject().put("data", data).put("mtime", 0);
    }

    // ------------------------------------------------------------------ hesap eşitlemesi (SyncCore.Local)
    @Override public synchronized JSONObject account() {
        JSONObject a = sync.optJSONObject("account");
        if (a == null) return null;
        try {
            return new JSONObject().put("server", a.optString("server")).put("user", a.optString("user"))
                    .put("version", a.optLong("version")).put("lastSync", a.optLong("lastSync"));
        } catch (JSONException e) {
            return null;
        }
    }

    @Override public synchronized String token() {
        JSONObject a = sync.optJSONObject("account");
        return a == null ? null : dec(a.opt("token"));
    }

    @Override public synchronized byte[] vk() {
        JSONObject a = sync.optJSONObject("account");
        String v = a == null ? null : dec(a.opt("vk"));
        return v == null ? null : Base64.decode(v, Base64.NO_WRAP);
    }

    @Override public synchronized void setAccount(JSONObject acc, String token, byte[] vk) {
        try {
            if (acc == null) sync.remove("account");
            else sync.put("account", new JSONObject(acc.toString()).put("token", enc(token)).put("vk", enc(Base64.encodeToString(vk, Base64.NO_WRAP))));
        } catch (JSONException ignored) { }
        save("sync.json", sync);
    }

    @Override public synchronized void setVersion(long version, long lastSync) {
        JSONObject a = sync.optJSONObject("account");
        if (a == null) return;
        try { a.put("version", version).put("lastSync", lastSync); } catch (JSONException ignored) { }
        save("sync.json", sync);
    }

    @Override public synchronized void firstDevice() {
        try {
            JSONObject b = settingsBlob();
            if (b.optLong("mtime") == 0) { b.put("mtime", System.currentTimeMillis()); sync.put("settings", b); save("sync.json", sync); }
        } catch (JSONException ignored) { }
    }

    @Override public synchronized JSONObject snapshot() throws Exception {
        JSONObject ss = new JSONObject();
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject s = sessions.getJSONObject(i);
            if (s.optBoolean("temporary")) continue;
            JSONObject o = new JSONObject(s.toString());
            for (String f : LOCAL_SESSION_FIELDS) o.remove(f);
            for (String f : SECRET_FIELDS) {
                o.remove(f);
                String v = dec(s.opt(f));
                if (v != null && !v.isEmpty()) o.put(f, v);
            }
            o.put("mtime", s.optLong("mtime"));
            ss.put(s.getString("id"), o);
        }
        JSONObject blob = settingsBlob();
        JSONObject out = new JSONObject().put("sessions", ss).put("deleted", new JSONObject(sync.getJSONObject("deleted").toString())).put("settings", blob)
                .put("snippets", SyncCore.snippetMap(settings.optJSONArray("snippets"), blob.optLong("mtime")));
        if (syncKeys()) {
            JSONObject ks = new JSONObject();
            for (int i = 0; i < keys.length(); i++) {
                JSONObject k = keys.getJSONObject(i);
                String fp = k.optString("fingerprint"), prv = dec(k.opt("private"));
                if (fp.isEmpty() || prv == null || ks.has(fp)) continue;
                JSONObject o = new JSONObject().put("name", k.optString("name")).put("type", k.optString("type"))
                        .put("public", k.optString("public")).put("private", prv).put("mtime", keyMtime(k));
                String pp = dec(k.opt("passphrase"));
                if (pp != null && !pp.isEmpty()) o.put("passphrase", pp);
                ks.put(fp, o);
            }
            out.put("keys", ks);
        }
        return out;
    }

    static long keyMtime(JSONObject k) { return k.optLong("mtime", k.optLong("created")); }

    /** Kullanım sayıları gönderilsin mi (bu cihaza özgü; varsayılan açık). Ayrıntı: UsageStats, server/pages/kosullar.html */
    public synchronized boolean usageStats() { return settings.optBoolean("usageStats", true); }
    public synchronized String language() { return settings.optString("language", "auto"); }

    public synchronized void setUsageStats(boolean on) throws JSONException {
        settings.put("usageStats", on);
        save("settings.json", settings);
    }

    /** Kuruluma özgü rastgele kimlik (kurulum sayımı; eşitlenmez) */
    public synchronized String deviceId() throws JSONException {
        String id = settings.optString("deviceId");
        if (!id.matches("[\\w-]{16,64}")) { id = java.util.UUID.randomUUID().toString(); settings.put("deviceId", id); save("settings.json", settings); }
        return id;
    }

    /** Sunucuya gidecek kullanım raporu: yalnız sayılar; kapalıysa null */
    @Override public synchronized JSONObject usageReport() throws JSONException {
        if (!usageStats() || App.I == null || App.I.usage == null) return null;
        java.util.Set<String> groups = new java.util.HashSet<>();
        int tunnels = 0;
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject s = sessions.getJSONObject(i);
            if (!s.optString("group").isEmpty()) groups.add(s.optString("group"));
            JSONArray f = s.optJSONArray("forwards");
            if (f != null) tunnels += f.length();
        }
        JSONArray snips = settings.optJSONArray("snippets");
        JSONObject snap = new JSONObject().put("sessions", sessions.length()).put("groups", groups.size())
                .put("keys", keys.length()).put("snippets", snips == null ? 0 : snips.length()).put("savedTunnels", tunnels);
        return new JSONObject().put("snapshot", snap).put("days", App.I.usage.recent());
    }

    /** Hesap eşitlemesinde SSH anahtarları da gönderilsin/alınsın mı (bu cihaza özgü seçim) */
    public synchronized boolean syncKeys() { return settings.optBoolean("syncKeys"); }

    /** Açılınca anahtarlı oturumlara parmak izi eklenir (diğer cihaz anahtarı bulsun) */
    public synchronized void setSyncKeys(boolean on) throws JSONException {
        settings.put("syncKeys", on);
        save("settings.json", settings);
        if (on) {
            boolean touched = false;
            for (int i = 0; i < sessions.length(); i++) {
                JSONObject s = sessions.getJSONObject(i);
                if (s.optString("keyId").isEmpty() || s.has("keyFp")) continue;
                String fp = keyFingerprint(s.optString("keyId"));
                if (fp != null) { s.put("keyFp", fp).put("mtime", System.currentTimeMillis()); touched = true; }
            }
            if (touched) save("sessions.json", sessions);
        }
        changed();
    }

    synchronized String keyFingerprint(String keyId) {
        int idx = indexOf(keys, keyId);
        String fp = idx < 0 ? "" : keys.optJSONObject(idx).optString("fingerprint");
        return fp.isEmpty() ? null : fp;
    }

    /** Kasadaki anahtarları uygular (parmak izine göre; yerel kimlik korunur, silineni kaldırır) */
    void applyKeys(JSONObject vk) throws JSONException {
        JSONArray next = new JSONArray();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (int i = 0; i < keys.length(); i++) {
            JSONObject k = keys.getJSONObject(i);
            String fp = k.optString("fingerprint");
            JSONObject r = vk.optJSONObject(fp);
            if (r == null || seen.contains(fp)) continue; // hesaptan silindi (ya da aynı anahtarın ikinci kopyası)
            seen.add(fp);
            if (!r.optString("name").equals(k.optString("name"))) k.put("name", r.optString("name"));
            String prv = r.optString("private"), pp = r.optString("passphrase", "");
            if (!prv.equals(dec(k.opt("private")))) k.put("private", enc(prv));
            String oldPp = dec(k.opt("passphrase"));
            if (!pp.equals(oldPp == null ? "" : oldPp)) { if (pp.isEmpty()) k.remove("passphrase"); else k.put("passphrase", enc(pp)); }
            k.put("mtime", r.optLong("mtime"));
            next.put(k);
        }
        for (Iterator<String> it = vk.keys(); it.hasNext(); ) {
            String fp = it.next();
            if (seen.contains(fp)) continue;
            JSONObject r = vk.getJSONObject(fp);
            JSONObject k = new JSONObject().put("id", UUID.randomUUID().toString()).put("name", r.optString("name", "anahtar"))
                    .put("type", r.optString("type")).put("public", r.optString("public")).put("fingerprint", fp)
                    .put("created", System.currentTimeMillis()).put("mtime", r.optLong("mtime")).put("private", enc(r.optString("private")));
            String pp = r.optString("passphrase", "");
            if (!pp.isEmpty()) k.put("passphrase", enc(pp));
            next.put(k);
        }
        keys = next;
        save("keys.json", keys);
    }

    /** Birleştirilmiş kasayı uygular; onChange tetiklenmez (eşitlemenin kendi yazması). */
    @Override public synchronized void apply(JSONObject v) throws Exception {
        JSONArray next = new JSONArray();
        JSONObject vs = v.getJSONObject("sessions");
        for (Iterator<String> it = vs.keys(); it.hasNext(); ) {
            String id = it.next();
            JSONObject o = new JSONObject(vs.getJSONObject(id).toString());
            o.put("id", id);
            for (String f : SECRET_FIELDS) {
                String sec = o.has(f) && !o.isNull(f) ? o.optString(f) : "";
                o.remove(f);
                if (!sec.isEmpty()) o.put(f, enc(sec));
            }
            int old = indexOf(sessions, id);
            if (old >= 0) for (String f : LOCAL_SESSION_FIELDS) {
                JSONObject prev = sessions.getJSONObject(old);
                if (prev.has(f)) o.put(f, prev.get(f));
            }
            next.put(o);
        }
        // hızlı bağlan oturumları kasada yok; bu cihazda kalır
        for (int i = 0; i < sessions.length(); i++) if (sessions.getJSONObject(i).optBoolean("temporary")) next.put(sessions.getJSONObject(i));
        sessions = next;
        save("sessions.json", sessions);
        JSONObject rs = v.optJSONObject("settings");
        JSONObject mine = settingsBlob();
        // birleştirmenin seçtiği blok bu cihazınkinden farklıysa (daha yeni ya da eşit zamanda seçilen) benimsenir
        if (rs != null && rs.optJSONObject("data") != null && !SyncCore.canon(rs).equals(SyncCore.canon(mine))) {
            JSONObject data = rs.getJSONObject("data");
            for (String k : SYNC_SETTINGS) if (data.has(k)) settings.put(k, data.get(k));
            save("settings.json", settings);
            sync.put("settings", new JSONObject(rs.toString()));
        }
        if (syncKeys() && v.optJSONObject("keys") != null) applyKeys(v.getJSONObject("keys"));
        sync.put("deleted", new JSONObject(v.getJSONObject("deleted").toString()));
        save("sync.json", sync);
    }

    // ------------------------------------------------------------------ known hosts
    public synchronized JSONObject getKnownHost(String hp) { return known.optJSONObject(hp); }

    public synchronized void putKnownHost(String hp, JSONObject e) {
        try { known.put(hp, e); } catch (JSONException ignored) { }
        save("known_hosts.json", known);
    }

    public synchronized void removeKnownHost(String hp) {
        known.remove(hp);
        save("known_hosts.json", known);
    }

    // ------------------------------------------------------------------ keys
    public synchronized String addKey(String name, String type, String pub, String fp, String prv, String passphrase) throws JSONException {
        String id = UUID.randomUUID().toString();
        JSONObject k = new JSONObject();
        k.put("id", id);
        k.put("name", uniqueKeyName(name));
        k.put("type", type);
        k.put("public", pub);
        k.put("fingerprint", fp);
        k.put("created", System.currentTimeMillis());
        k.put("mtime", System.currentTimeMillis());
        k.put("private", enc(prv));
        if (passphrase != null && !passphrase.isEmpty()) k.put("passphrase", enc(passphrase));
        keys.put(k);
        save("keys.json", keys);
        if (syncKeys()) changed();
        return id;
    }

    String uniqueKeyName(String name) {
        String base = name == null || name.trim().isEmpty() ? "anahtar" : name.trim().replaceAll("[/\\\\]", "_");
        String n = base;
        for (int i = 2; ; i++) {
            boolean taken = false;
            for (int j = 0; j < keys.length(); j++) if (n.equals(keys.optJSONObject(j).optString("name"))) taken = true;
            if (!taken) return n;
            n = base + "-" + i;
        }
    }

    public synchronized void renameKey(String id, String name) throws JSONException {
        int idx = indexOf(keys, id);
        if (idx < 0) return;
        JSONObject k = keys.getJSONObject(idx);
        if (name.trim().equals(k.optString("name"))) return;
        k.put("name", uniqueKeyName(name));
        k.put("mtime", System.currentTimeMillis());
        save("keys.json", keys);
        if (syncKeys()) changed();
    }

    /** Silinen anahtar hesaptan da silinir (eşitleme açık diğer cihazlardan kalkar) */
    public synchronized void deleteKey(String id) throws JSONException {
        int idx = indexOf(keys, id);
        if (idx < 0) return;
        String fp = keys.getJSONObject(idx).optString("fingerprint");
        keys.remove(idx);
        save("keys.json", keys);
        boolean other = false; // aynı anahtarın başka kopyası kaldıysa hesaptan silinmez
        for (int i = 0; i < keys.length(); i++) if (fp.equals(keys.optJSONObject(i).optString("fingerprint"))) other = true;
        if (fp.isEmpty() || other || !syncKeys()) return;
        sync.getJSONObject("deleted").put(fp, System.currentTimeMillis());
        save("sync.json", sync);
        changed();
    }

    public synchronized String keyPublic(String id) {
        int idx = indexOf(keys, id);
        return idx < 0 ? null : keys.optJSONObject(idx).optString("public");
    }

    public synchronized String keyPrivate(String id) {
        int idx = indexOf(keys, id);
        return idx < 0 ? null : dec(keys.optJSONObject(idx).opt("private"));
    }

    public synchronized List<JSONObject> privateKeys() {
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; i < keys.length(); i++) {
            JSONObject k = keys.optJSONObject(i);
            String prv = dec(k.opt("private"));
            if (prv == null) continue;
            try {
                JSONObject o = new JSONObject();
                o.put("id", k.optString("id"));
                o.put("name", k.optString("name"));
                o.put("fingerprint", k.optString("fingerprint"));
                o.put("private", prv);
                String pp = dec(k.opt("passphrase"));
                if (pp != null) o.put("passphrase", pp);
                out.add(o);
            } catch (JSONException ignored) { }
        }
        return out;
    }

    // ------------------------------------------------------------------ backup (masaüstü ile aynı biçim)
    static final String[] IMPORT_SETTINGS = {"theme", "uiTheme", "fontSize", "snippets", "autoReconnect", "cursorBlink"};

    /** Yedek dosyasında şifreli sır varsa, ilk sır parolayla çözülebiliyor mu? */
    public static boolean backupNeedsPassphrase(JSONObject bk) {
        return bk.optBoolean("encrypted") && bk.has("secretsSalt");
    }

    public synchronized JSONObject importBackup(JSONObject bk, String passphrase, boolean withSettings) throws Exception {
        JSONArray arr = bk.optJSONArray("sessions");
        if (arr == null) throw new Exception("Geçersiz yedek dosyası");
        byte[] key = null;
        if (bk.optBoolean("encrypted") && bk.has("secretsSalt") && passphrase != null && !passphrase.isEmpty())
            key = Backup.deriveKey(passphrase, Base64.decode(bk.getString("secretsSalt"), Base64.DEFAULT));
        // yanlış parola kontrolü (ilk sır)
        if (key != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject sec = arr.getJSONObject(i).optJSONObject("secrets");
                if (sec == null) continue;
                String first = sec.optString("password", sec.optString("passphrase", ""));
                if (first.isEmpty()) continue;
                try { Backup.decrypt(first, key); } catch (Exception e) { throw new Exception("Yedek parolası yanlış"); }
                break;
            }
        }
        int added = 0, updated = 0, withPassword = 0;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject es = arr.getJSONObject(i);
            JSONObject in = new JSONObject(es.toString());
            in.remove("secrets");
            for (String f : SECRET_FIELDS) { in.remove("has_" + f); in.remove(f); }
            JSONObject sec = es.optJSONObject("secrets");
            if (sec != null && key != null) {
                for (String f : SECRET_FIELDS) {
                    if (!sec.has(f)) continue;
                    try {
                        in.put(f, Backup.decrypt(sec.getString(f), key));
                        if (f.equals("password")) withPassword++;
                    } catch (Exception ignored) { }
                }
            }
            boolean existed = !in.optString("id").isEmpty() && indexOf(sessions, in.optString("id")) >= 0;
            saveSession(in);
            if (existed) updated++; else added++;
        }
        JSONObject st = bk.optJSONObject("settings");
        if (withSettings && st != null) {
            JSONObject patch = new JSONObject();
            for (String k : IMPORT_SETTINGS) if (st.has(k)) patch.put(k, st.get(k));
            saveSettings(patch);
        }
        JSONObject r = new JSONObject();
        r.put("added", added);
        r.put("updated", updated);
        r.put("withPassword", withPassword);
        r.put("found", arr.length());
        return r;
    }

    public synchronized JSONObject exportBackup(String passphrase) throws Exception {
        byte[] salt = null, key = null;
        if (passphrase != null && !passphrase.isEmpty()) {
            salt = Backup.randomSalt();
            key = Backup.deriveKey(passphrase, salt);
        }
        JSONArray out = new JSONArray();
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject s = sessions.getJSONObject(i);
            JSONObject o = new JSONObject(s.toString());
            JSONObject sec = new JSONObject();
            for (String f : SECRET_FIELDS) {
                o.remove(f);
                if (key == null) continue;
                String v = dec(s.opt(f));
                if (v != null) sec.put(f, Backup.encrypt(v, key));
            }
            if (sec.length() > 0) o.put("secrets", sec);
            out.put(o);
        }
        JSONObject bk = new JSONObject();
        bk.put("app", "Melid");
        bk.put("format", 1);
        bk.put("exportedAt", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.ROOT) {{
            setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        }}.format(new java.util.Date()));
        bk.put("encrypted", key != null);
        if (salt != null) bk.put("secretsSalt", Base64.encodeToString(salt, Base64.NO_WRAP));
        JSONObject st = new JSONObject();
        for (String k : IMPORT_SETTINGS) if (settings.has(k)) st.put(k, settings.get(k));
        bk.put("settings", st);
        bk.put("sessions", out);
        return bk;
    }
}
