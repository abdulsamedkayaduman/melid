package dev.sshdeck.core;

import org.bouncycastle.crypto.digests.SHA512Digest;
import org.bouncycastle.crypto.generators.PKCS5S2ParametersGenerator;
import org.bouncycastle.crypto.params.KeyParameter;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Hesap eşitlemesi istemcisi; masaüstü src/main/sync.js + store.js mergeVaults ile birebir aynı protokol
 * (sunucu: server/sync-server.js, ayrıntı: docs/senkron.md). Android'den bağımsız: coretest'te JVM'de,
 * gerçek sunucu ve masaüstü istemcisiyle birlikte test edilir.
 *
 * hesap parolası -> PBKDF2-SHA512 -> ana anahtar -> HKDF-SHA256: authKey (sunucuya) ve wrapKey (cihazda kalır).
 * Kasa anahtarı (VK) sunucuda wrapKey ile, kasa VK ile AES-256-GCM (Backup.encrypt ile aynı biçim) şifreli.
 */
public final class SyncCore {
    public static final int KDF_ITER = 600000;
    public static final int DEFAULT_PORT = 3150;
    static final long TOMBSTONE_TTL = 180L * 24 * 3600 * 1000;
    static final SecureRandom RNG = new SecureRandom();

    /** Hesap verisinin cihazdaki karşılığı (Store). Sırlar açık hâlde yalnız bu arayüzden geçer. */
    public interface Local {
        /** { server, user, version, lastSync } ya da giriş yapılmamışsa null */
        JSONObject account();
        String token();
        byte[] vk();
        /** acc null: çıkış (jeton ve VK silinir) */
        void setAccount(JSONObject acc, String token, byte[] vk);
        void setVersion(long version, long lastSync);
        /** Hesabı bu cihaz açtı: buradaki ayarlar hesabın ayarları olur */
        void firstDevice();
        /** { sessions: {id: {...}}, deleted: {id: zaman}, settings: { data, mtime } } — sırlar açık */
        JSONObject snapshot() throws Exception;
        void apply(JSONObject merged) throws Exception;
    }

    public static class SyncException extends Exception {
        public final int status;
        public final JSONObject current;

        SyncException(int status, String msg, JSONObject current) {
            super(msg);
            this.status = status;
            this.current = current;
        }
    }

    // ------------------------------------------------------------------ anahtarlar
    public static final class Keys {
        public final String authKey;
        public final byte[] wrapKey;

        Keys(String authKey, byte[] wrapKey) { this.authKey = authKey; this.wrapKey = wrapKey; }
    }

    public static Keys deriveKeys(String password, String saltB64, int iter) throws Exception {
        if (iter < 100000 || iter > 10000000) throw new Exception("Sunucudan geçersiz KDF ayarı");
        PKCS5S2ParametersGenerator g = new PKCS5S2ParametersGenerator(new SHA512Digest());
        g.init(password.getBytes(StandardCharsets.UTF_8), Base64.getDecoder().decode(saltB64), iter);
        byte[] mk = ((KeyParameter) g.generateDerivedParameters(256)).getKey();
        return new Keys(b64(hkdf(mk, "sshdeck-auth")), hkdf(mk, "sshdeck-wrap"));
    }

    /** HKDF-SHA256, tuz yok (= 32 sıfır bayt), 32 bayt çıktı (tek blok). Node hkdfSync ile aynı. */
    static byte[] hkdf(byte[] ikm, String info) throws Exception {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(new byte[32], "HmacSHA256"));
        byte[] prk = m.doFinal(ikm);
        m.init(new SecretKeySpec(prk, "HmacSHA256"));
        m.update(info.getBytes(StandardCharsets.UTF_8));
        m.update((byte) 1);
        return m.doFinal();
    }

    static String b64(byte[] b) { return Base64.getEncoder().encodeToString(b); }

    static byte[] random(int n) { byte[] b = new byte[n]; RNG.nextBytes(b); return b; }

    // ------------------------------------------------------------------ birleştirme (store.js mergeVaults)
    /** JS JSON.stringify ile aynı, anahtarları sıralı metin (eşit değişme zamanında tüm cihazlar aynı tarafı seçsin). */
    public static String canon(Object v) {
        StringBuilder sb = new StringBuilder();
        canon(v, sb);
        return sb.toString();
    }

    static void canon(Object v, StringBuilder sb) {
        if (v == null || v == JSONObject.NULL) { sb.append("null"); return; }
        if (v instanceof JSONObject) {
            JSONObject o = (JSONObject) v;
            List<String> keys = new ArrayList<>();
            for (Iterator<String> it = o.keys(); it.hasNext(); ) keys.add(it.next());
            Collections.sort(keys);
            sb.append('{');
            boolean first = true;
            for (String k : keys) {
                if (!first) sb.append(',');
                first = false;
                str(k, sb);
                sb.append(':');
                canon(o.opt(k), sb);
            }
            sb.append('}');
        } else if (v instanceof JSONArray) {
            JSONArray a = (JSONArray) v;
            sb.append('[');
            for (int i = 0; i < a.length(); i++) { if (i > 0) sb.append(','); canon(a.opt(i), sb); }
            sb.append(']');
        } else if (v instanceof String) {
            str((String) v, sb);
        } else if (v instanceof Boolean) {
            sb.append(v);
        } else if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) sb.append("null");
            else if (d == Math.rint(d) && Math.abs(d) < 1e21) sb.append(v instanceof Double || v instanceof Float ? String.valueOf((long) d) : v.toString());
            else sb.append(v);
        } else {
            str(v.toString(), sb);
        }
    }

    static void str(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    boolean lone = Character.isSurrogate(c) && !(Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1)))
                            && !(Character.isLowSurrogate(c) && i > 0 && Character.isHighSurrogate(s.charAt(i - 1)));
                    if (c < 0x20 || lone) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    static double num(Object v) { return v instanceof Number ? ((Number) v).doubleValue() : 0; }

    public static JSONObject mergeVaults(JSONObject a, JSONObject b, long now) throws JSONException {
        JSONObject sa = a == null ? null : a.optJSONObject("sessions"), sb = b == null ? null : b.optJSONObject("sessions");
        if (sa == null) sa = new JSONObject();
        if (sb == null) sb = new JSONObject();
        JSONObject sessions = new JSONObject();
        Set<String> ids = new LinkedHashSet<>();
        for (Iterator<String> it = sa.keys(); it.hasNext(); ) ids.add(it.next());
        for (Iterator<String> it = sb.keys(); it.hasNext(); ) ids.add(it.next());
        for (String id : ids) {
            JSONObject x = sa.optJSONObject(id), y = sb.optJSONObject(id);
            if (x == null || y == null) { sessions.put(id, x != null ? x : y); continue; }
            double tx = num(x.opt("mtime")), ty = num(y.opt("mtime"));
            sessions.put(id, tx != ty ? (tx > ty ? x : y) : (canon(x).compareTo(canon(y)) >= 0 ? x : y));
        }
        JSONObject deleted = new JSONObject();
        for (JSONObject src : new JSONObject[]{a == null ? null : a.optJSONObject("deleted"), b == null ? null : b.optJSONObject("deleted")}) {
            if (src == null) continue;
            for (Iterator<String> it = src.keys(); it.hasNext(); ) {
                String id = it.next();
                Object t = src.opt(id);
                if (!(deleted.has(id) && num(deleted.opt(id)) >= num(t))) deleted.put(id, t);
            }
        }
        List<String> dids = new ArrayList<>();
        for (Iterator<String> it = deleted.keys(); it.hasNext(); ) dids.add(it.next());
        for (String id : dids) {
            double t = num(deleted.opt(id));
            JSONObject s = sessions.optJSONObject(id);
            if (s != null && num(s.opt("mtime")) <= t) sessions.remove(id);
            else if (s != null || now - t > TOMBSTONE_TTL) deleted.remove(id);
        }
        JSONObject empty = new JSONObject().put("data", new JSONObject()).put("mtime", 0);
        JSONObject ea = a == null ? null : a.optJSONObject("settings"), eb = b == null ? null : b.optJSONObject("settings");
        if (ea == null) ea = empty;
        if (eb == null) eb = empty;
        double ma = num(ea.opt("mtime")), mb = num(eb.opt("mtime"));
        JSONObject settings = ma != mb ? (ma > mb ? ea : eb) : (canon(ea).compareTo(canon(eb)) >= 0 ? ea : eb);
        return new JSONObject().put("sessions", sessions).put("deleted", deleted).put("settings", settings);
    }

    // ------------------------------------------------------------------ adres
    static final Pattern PRIVATE_HOST = Pattern.compile(
            "^(localhost|127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.|\\[?::1\\]?$|[^.]+$|.*\\.(local|lan|home|ts\\.net)$)",
            Pattern.CASE_INSENSITIVE);

    /** Yerel ağ / Tailscale adresi mi (düz http yalnız bunlara izinli) */
    public static boolean privateHost(String host) { return PRIVATE_HOST.matcher(host).find(); }

    /** "192.168.1.50" -> "http://192.168.1.50:3150"; şema verilmişse portu dokunulmaz. Sonuç: origin. */
    public static String normServer(String s) throws Exception {
        String u = s == null ? "" : s.trim();
        if (u.isEmpty()) throw new Exception("Sunucu adresi gerekli");
        if (!u.matches("(?i)^https?://.*")) {
            Matcher m = Pattern.compile("^(\\[[^\\]]+\\]|[^:/\\[]+)(?=/|$)").matcher(u);
            if (m.find()) u = m.group(1) + ":" + DEFAULT_PORT + u.substring(m.end());
            u = "http://" + u;
        }
        try {
            URL url = new URL(u);
            if (url.getHost().isEmpty()) throw new Exception();
            return url.getProtocol().toLowerCase(Locale.ROOT) + "://" + url.getHost().toLowerCase(Locale.ROOT) + (url.getPort() > 0 && url.getPort() != url.getDefaultPort() ? ":" + url.getPort() : "");
        } catch (Exception e) {
            throw new Exception("Sunucu adresi geçersiz");
        }
    }

    // ------------------------------------------------------------------ yerel ağ taraması
    /** Taranacak adresler: her yerel IPv4 arabiriminin alt ağı (en fazla /24) + bu cihaz. */
    public static List<String> lanTargets() {
        Set<String> out = new LinkedHashSet<>();
        out.add("127.0.0.1");
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress ad = ia.getAddress();
                    if (!(ad instanceof Inet4Address) || !ad.isSiteLocalAddress()) continue;
                    int prefix = Math.max(24, ia.getNetworkPrefixLength());
                    byte[] b = ad.getAddress();
                    long ip = ((b[0] & 0xffL) << 24) | ((b[1] & 0xff) << 16) | ((b[2] & 0xff) << 8) | (b[3] & 0xff);
                    long mask = prefix >= 32 ? 0xffffffffL : (0xffffffffL << (32 - prefix)) & 0xffffffffL;
                    long base = ip & mask;
                    long size = 1L << (32 - prefix);
                    for (long i = 1; i < size - 1; i++) {
                        long n = base + i;
                        out.add(((n >> 24) & 255) + "." + ((n >> 16) & 255) + "." + ((n >> 8) & 255) + "." + (n & 255));
                    }
                }
            }
        } catch (Exception ignored) { }
        return new ArrayList<>(out);
    }

    /** Portu açık adreslere /api/info sorar. Sonuç: [{ server, host, register }] adrese göre sıralı. */
    public static JSONArray scan(List<String> targets, int port, int timeoutMs) throws InterruptedException {
        List<JSONObject> found = Collections.synchronizedList(new ArrayList<>());
        ExecutorService ex = Executors.newFixedThreadPool(Math.max(1, Math.min(64, targets.size())));
        for (String host : targets) {
            ex.execute(() -> {
                try (Socket s = new Socket()) {
                    s.connect(new InetSocketAddress(host, port), timeoutMs);
                } catch (Exception e) {
                    return;
                }
                try {
                    String server = "http://" + host + ":" + port;
                    JSONObject info = new JSONObject(http("GET", server + "/api/info", null, null, null, 3000).body);
                    if ("SSHDeck".equals(info.optString("app")))
                        found.add(new JSONObject().put("server", server).put("host", host).put("register", info.optBoolean("register")));
                } catch (Exception ignored) { }
            });
        }
        ex.shutdown();
        ex.awaitTermination(2, TimeUnit.MINUTES);
        TreeSet<String> order = new TreeSet<>();
        JSONArray out = new JSONArray();
        synchronized (found) {
            List<JSONObject> l = new ArrayList<>(found);
            l.sort((x, y) -> ipKey(x.optString("host")).compareTo(ipKey(y.optString("host"))));
            for (JSONObject o : l) if (order.add(o.optString("host"))) out.put(o);
        }
        return out;
    }

    static String ipKey(String ip) {
        StringBuilder sb = new StringBuilder();
        for (String p : ip.split("\\.")) sb.append(String.format("%3s", p).replace(' ', '0')).append('.');
        return sb.toString();
    }

    // ------------------------------------------------------------------ HTTP
    static final class Resp {
        final int status;
        final String body;

        Resp(int status, String body) { this.status = status; this.body = body; }
    }

    static Resp http(String method, String url, String body, String token, String client, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(Math.min(timeoutMs, 10000));
        c.setReadTimeout(timeoutMs);
        c.setUseCaches(false);
        c.setRequestProperty("Accept", "application/json");
        if (client != null && !client.isEmpty()) c.setRequestProperty("X-SSHDeck-Client", client);
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (body != null) {
                byte[] b = body.getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream o = c.getOutputStream()) { o.write(b); }
            }
            int st = c.getResponseCode();
            InputStream in = st >= 400 ? c.getErrorStream() : c.getInputStream();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            if (in != null) try (InputStream i = in) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = i.read(buf)) > 0) bo.write(buf, 0, n);
            }
            return new Resp(st, bo.toString("UTF-8"));
        } finally {
            c.disconnect();
        }
    }

    // ------------------------------------------------------------------ istemci
    public static class Client {
        final Local local;
        final String clientName;
        public volatile String state = "idle"; // idle | syncing | ok | error | auth
        public volatile String error;
        /** Durum değişince (arayüze bildirmek için) */
        public Runnable onStatus;

        public Client(Local local, String clientName) {
            this.local = local;
            this.clientName = clientName;
        }

        public JSONObject status() {
            try {
                JSONObject a = local.account();
                if (a == null) return new JSONObject().put("loggedIn", false).put("state", "idle");
                return new JSONObject().put("loggedIn", true).put("server", a.optString("server")).put("user", a.optString("user"))
                        .put("version", a.optLong("version")).put("lastSync", a.optLong("lastSync")).put("state", state)
                        .put("error", error == null ? JSONObject.NULL : error);
            } catch (JSONException e) {
                throw new RuntimeException(e);
            }
        }

        void set(String st, String err) {
            state = st;
            error = err;
            Runnable r = onStatus;
            if (r != null) try { r.run(); } catch (Exception ignored) { }
        }

        JSONObject req(String server, String method, String path, JSONObject body, String token) throws Exception {
            URL u = new URL(server);
            if (u.getProtocol().equals("http") && !privateHost(u.getHost()))
                throw new Exception("İnternetteki sunucu için https gerekli (şifresiz http yalnız yerel ağda kullanılabilir)");
            Resp r;
            try {
                r = http(method, server + path, body == null ? null : body.toString(), token, clientName, 20000);
            } catch (SocketTimeoutException e) {
                throw new Exception("Sunucu yanıt vermiyor");
            } catch (javax.net.ssl.SSLException e) {
                throw new Exception("Güvenli bağlantı kurulamadı (" + server + "): sertifika geçersiz olabilir");
            } catch (java.io.IOException e) {
                throw new Exception("Sunucuya ulaşılamadı (" + server + ")");
            }
            JSONObject data = null;
            try { data = new JSONObject(r.body); } catch (Exception ignored) { }
            if (r.status < 200 || r.status >= 300) {
                String msg = data != null && data.has("error") ? data.optString("error") : "Sunucu hatası (" + r.status + ")";
                throw new SyncException(r.status, msg, data == null ? null : data.optJSONObject("current"));
            }
            if (data == null) throw new Exception("Sunucudan geçersiz yanıt");
            return data;
        }

        String server() { JSONObject a = local.account(); return a == null ? null : a.optString("server"); }

        // ---- hesap
        public synchronized JSONObject register(String server, String user, String password, String invite) throws Exception {
            server = normServer(server);
            user = user == null ? "" : user.trim().toLowerCase(Locale.ROOT);
            JSONObject info = req(server, "GET", "/api/info", null, null);
            if (!"SSHDeck".equals(info.optString("app"))) throw new Exception("Bu bir SSHDeck eşitleme sunucusu değil");
            String salt = b64(random(16));
            Keys k = deriveKeys(password, salt, KDF_ITER);
            byte[] vk = random(32);
            String wrapped = Backup.encrypt(b64(vk), k.wrapKey);
            JSONObject r = req(server, "POST", "/api/register", new JSONObject().put("user", user).put("invite", invite).put("salt", salt)
                    .put("iter", KDF_ITER).put("authKey", k.authKey).put("wrappedKey", wrapped), null);
            local.firstDevice();
            local.setAccount(new JSONObject().put("server", server).put("user", user).put("version", 0).put("lastSync", 0), r.getString("token"), vk);
            syncNow();
            return status();
        }

        public synchronized JSONObject login(String server, String user, String password) throws Exception {
            server = normServer(server);
            user = user == null ? "" : user.trim().toLowerCase(Locale.ROOT);
            JSONObject pre = req(server, "GET", "/api/prelogin?user=" + URLEncoder.encode(user, "UTF-8"), null, null);
            Keys k = deriveKeys(password, pre.getString("salt"), pre.getInt("iter"));
            JSONObject r = req(server, "POST", "/api/login", new JSONObject().put("user", user).put("authKey", k.authKey), null);
            byte[] vk;
            try { vk = Base64.getDecoder().decode(Backup.decrypt(r.getString("wrappedKey"), k.wrapKey)); } catch (Exception e) { throw new Exception("Kasa anahtarı çözülemedi"); }
            local.setAccount(new JSONObject().put("server", server).put("user", user).put("version", 0).put("lastSync", 0), r.getString("token"), vk);
            syncNow();
            return status();
        }

        public synchronized JSONObject logout() {
            JSONObject a = local.account();
            if (a == null) return status();
            String token = local.token();
            local.setAccount(null, null, null);
            set("idle", null);
            if (token != null) try { req(a.optString("server"), "POST", "/api/logout", new JSONObject(), token); } catch (Exception ignored) { }
            return status();
        }

        public synchronized void changePassword(String oldPw, String newPw) throws Exception {
            JSONObject a = local.account();
            if (a == null) throw new Exception("Giriş yapılmamış");
            byte[] vk = local.vk();
            if (vk == null) throw new Exception("Kasa anahtarı okunamadı, tekrar giriş yapın");
            String server = a.optString("server");
            JSONObject pre = req(server, "GET", "/api/prelogin?user=" + URLEncoder.encode(a.optString("user"), "UTF-8"), null, null);
            Keys old = deriveKeys(oldPw, pre.getString("salt"), pre.getInt("iter"));
            String newSalt = b64(random(16));
            Keys nk = deriveKeys(newPw, newSalt, KDF_ITER);
            req(server, "POST", "/api/password", new JSONObject().put("authKey", old.authKey).put("newSalt", newSalt).put("iter", KDF_ITER)
                    .put("newAuthKey", nk.authKey).put("wrappedKey", Backup.encrypt(b64(vk), nk.wrapKey)), local.token());
        }

        // ---- eşitleme
        /** Tek seferde bir eşitleme (synchronized). Sonuç: yerel veri değişti mi. */
        public synchronized boolean syncNow() throws Exception {
            JSONObject a = local.account();
            if (a == null) return false;
            set("syncing", null);
            try {
                byte[] vk = local.vk();
                String token = local.token();
                if (vk == null || token == null) throw new SyncException(401, "Cihazdaki hesap anahtarı okunamadı, tekrar giriş yapın", null);
                String server = a.optString("server");
                boolean changed = false;
                JSONObject cur = req(server, "GET", "/api/vault", null, token);
                for (int attempt = 0; ; attempt++) {
                    String data = cur.isNull("data") ? null : cur.optString("data", null);
                    JSONObject remote = data == null ? null : new JSONObject(Backup.decrypt(data, vk));
                    JSONObject snap = local.snapshot();
                    JSONObject merged = mergeVaults(snap, remote, System.currentTimeMillis());
                    String mj = canon(merged);
                    if (!mj.equals(canon(snap))) { local.apply(merged); changed = true; }
                    if (remote != null && mj.equals(canon(remote))) { local.setVersion(cur.optLong("version"), System.currentTimeMillis()); break; }
                    try {
                        JSONObject r = req(server, "PUT", "/api/vault", new JSONObject().put("baseVersion", cur.optLong("version"))
                                .put("data", Backup.encrypt(mj, vk)), token);
                        local.setVersion(r.optLong("version"), System.currentTimeMillis());
                        break;
                    } catch (SyncException e) {
                        if (e.status != 409 || e.current == null || attempt >= 4) throw e;
                        cur = e.current; // başka cihaz araya girdi: güncel kasayla yeniden birleştir
                    }
                }
                set("ok", null);
                return changed;
            } catch (javax.crypto.AEADBadTagException e) {
                set("error", "Kasa çözülemedi (kasa anahtarı uyuşmuyor)");
                throw new Exception(error);
            } catch (SyncException e) {
                set(e.status == 401 ? "auth" : "error", e.getMessage());
                throw e;
            } catch (Exception e) {
                set("error", e.getMessage());
                throw e;
            }
        }
    }

    private SyncCore() { }
}
