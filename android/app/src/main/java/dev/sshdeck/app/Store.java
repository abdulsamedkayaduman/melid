package dev.sshdeck.app;

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

import dev.sshdeck.core.Backup;

/**
 * Kalıcı veri: sessions.json / settings.json / known_hosts.json / keys.json (uygulamanın özel klasöründe).
 * Sırlar (parola, anahtar parolası, özel anahtar) Android Keystore'daki AES anahtarıyla şifrelenir;
 * arayüze (WebView) asla gönderilmez, yalnızca has_password gibi bayraklar gider.
 */
public class Store {
    static final String[] SECRET_FIELDS = {"password", "passphrase"};
    static final String KS_ALIAS = "sshdeck-secrets";

    final File dir;
    JSONArray sessions;
    JSONObject settings;
    JSONObject known;
    JSONArray keys;

    public Store(Context ctx) {
        dir = ctx.getFilesDir();
        sessions = loadArr("sessions.json");
        settings = loadObj("settings.json");
        known = loadObj("known_hosts.json");
        keys = loadArr("keys.json");
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
        for (String f : SECRET_FIELDS) {
            if (!input.has(f)) continue;
            String v = input.isNull(f) ? "" : input.optString(f);
            if (v.isEmpty()) next.remove(f); else next.put(f, enc(v));
        }
        if (idx >= 0) sessions.put(idx, next); else sessions.put(next);
        save("sessions.json", sessions);
        return id;
    }

    public synchronized void deleteSession(String id) throws JSONException {
        int idx = indexOf(sessions, id);
        if (idx >= 0) sessions.remove(idx);
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject s = sessions.getJSONObject(i);
            if (id.equals(s.optString("jumpHostId"))) s.remove("jumpHostId");
        }
        save("sessions.json", sessions);
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
        for (Iterator<String> it = patch.keys(); it.hasNext(); ) {
            String k = it.next();
            settings.put(k, patch.get(k));
        }
        save("settings.json", settings);
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
        k.put("private", enc(prv));
        if (passphrase != null && !passphrase.isEmpty()) k.put("passphrase", enc(passphrase));
        keys.put(k);
        save("keys.json", keys);
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
        save("keys.json", keys);
    }

    public synchronized void deleteKey(String id) throws JSONException {
        int idx = indexOf(keys, id);
        if (idx >= 0) keys.remove(idx);
        save("keys.json", keys);
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
        bk.put("app", "SSHDeck");
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
