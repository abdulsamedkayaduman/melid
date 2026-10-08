package dev.sshdeck.core;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Proxy;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.SocketFactory;
import com.jcraft.jsch.UIKeyboardInteractive;
import com.jcraft.jsch.UserInfo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * SSH bağlantıları (masaüstündeki ssh-manager.js'in karşılığı). Platformdan bağımsızdır;
 * Android'e ait her şey Host üzerinden gelir. Metotlar bloklar: çağıran kendi iş parçacığında çağırır.
 */
public class SshCore {
    static {
        // Android'in JCE'sinde Ed25519/X25519/ML-KEM yok: BouncyCastle sürümlerini kullan
        JSch.setConfig("xdh", "com.jcraft.jsch.bc.XDH");
        JSch.setConfig("keypairgen.eddsa", "com.jcraft.jsch.bc.KeyPairGenEdDSA");
        JSch.setConfig("keypairgen_fromprivate.eddsa", "com.jcraft.jsch.bc.KeyPairGenEdDSA");
        JSch.setConfig("ssh-ed25519", "com.jcraft.jsch.bc.SignatureEd25519");
        JSch.setConfig("ssh-ed448", "com.jcraft.jsch.bc.SignatureEd448");
        JSch.setConfig("mlkem768", "com.jcraft.jsch.bc.MLKEM768");
        JSch.setConfig("mlkem1024", "com.jcraft.jsch.bc.MLKEM1024");
        // Eski sunucular için ssh-rsa (SHA1) imzasını da kabul et
        JSch.setConfig("server_host_key", JSch.getConfig("server_host_key") + ",ssh-rsa");
        JSch.setConfig("PubkeyAcceptedAlgorithms", JSch.getConfig("PubkeyAcceptedAlgorithms") + ",ssh-rsa");
    }

    public static final String STATS_SCRIPT = String.join("; ",
            "echo @@cpu; head -1 /proc/stat",
            "echo @@mem; grep -E \"^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):\" /proc/meminfo",
            "echo @@net; tail -n +3 /proc/net/dev",
            "echo @@disk; df -Pk / 2>/dev/null | tail -1",
            "echo @@up; cat /proc/uptime",
            "echo @@load; cat /proc/loadavg",
            "echo @@nproc; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo",
            "command -v who >/dev/null 2>&1 && { echo @@who; who; }");

    final Host host;
    final Map<String, Conn> conns = new ConcurrentHashMap<>();
    final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "sshdeck-io");
        t.setDaemon(true);
        return t;
    });
    final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "sshdeck-timer");
        t.setDaemon(true);
        return t;
    });

    public SshCore(Host host) {
        this.host = host;
        timer.scheduleWithFixedDelay(this::watch, 1, 1, TimeUnit.SECONDS);
    }

    // ------------------------------------------------------------------ types
    static class Shell {
        String sid;
        ChannelShell ch;
        OutputStream out;
        final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        boolean flushQueued;
        volatile boolean closed;
    }

    public static class Conn {
        public final String id;
        JSONObject session;
        final List<Session> chain = new ArrayList<>();
        Session ssh;
        final Map<String, Shell> shells = new ConcurrentHashMap<>();
        final Object sftpLock = new Object();
        com.jcraft.jsch.ChannelSftp sftp;
        final Map<String, Forwards.Fwd> fwds = new ConcurrentHashMap<>();
        final ExecutorService writer = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "sshdeck-write");
            t.setDaemon(true);
            return t;
        });
        volatile boolean closing;
        volatile boolean closedEmitted;

        Conn(String id) { this.id = id; }

        public Session session() { return ssh; }
    }

    public static class CancelledException extends Exception {
        public CancelledException() { super("İptal edildi"); }
    }

    // ------------------------------------------------------------------ connect
    /** Bağlanır; prompt'lar host.ask ile sorulur. overrides: {username?, password?} (kaydedilmeyen geçici bilgiler). */
    public JSONObject connect(String connId, String sessionId, JSONObject overrides) throws Exception {
        JSONObject target = host.resolveSession(sessionId);
        if (target == null) throw new Exception("Oturum bulunamadı");
        if (overrides != null) for (String k : iter(overrides)) target.put(k, overrides.get(k));
        List<JSONObject> chainS = resolveChain(target);

        Conn conn = new Conn(connId);
        conn.session = target;
        conns.put(connId, conn);
        try {
            Session prev = null;
            for (int i = 0; i < chainS.size(); i++) {
                JSONObject s = chainS.get(i);
                host.emit("status", obj("c", connId, "state", "connecting",
                        "message", (chainS.size() > 1 ? "(" + (i + 1) + "/" + chainS.size() + ") " : "") + s.optString("host") + " bağlanılıyor…"));
                Session ss = connectOne(conn, s, prev);
                conn.chain.add(ss);
                prev = ss;
            }
            conn.ssh = prev;
            if (conn.closing) throw new CancelledException();
            String banner = "";
            try { banner = conn.ssh.getServerVersion(); } catch (Exception ignored) { }
            return obj("ok", true, "serverVersion", banner);
        } catch (Exception e) {
            closeConn(conn, false);
            conns.remove(connId);
            throw friendly(e, target);
        }
    }

    List<JSONObject> resolveChain(JSONObject target) throws Exception {
        List<JSONObject> chain = new ArrayList<>();
        chain.add(target);
        Set<String> seen = new HashSet<>();
        seen.add(target.optString("id"));
        JSONObject cur = target;
        while (!cur.optString("jumpHostId").isEmpty()) {
            String jid = cur.optString("jumpHostId");
            if (seen.contains(jid)) throw new Exception("Jump host zinciri döngü içeriyor");
            seen.add(jid);
            JSONObject j = host.resolveSession(jid);
            if (j == null) throw new Exception("Jump host oturumu bulunamadı");
            chain.add(0, j);
            cur = j;
        }
        return chain;
    }

    Session connectOne(Conn conn, JSONObject s, Session via) throws Exception {
        JSch jsch = new JSch();
        String hostName = s.optString("host").trim();
        int port = s.optInt("port", 22);
        if (port <= 0) port = 22;
        String user = s.optString("username").trim();
        boolean saved = !s.optString("id").isEmpty() && !s.optBoolean("temporary");
        Creds creds = new Creds();
        if (user.isEmpty()) {
            JSONObject a = host.ask("text", obj("title", "Kullanıcı adı", "message", hostName + ":" + port + " için kullanıcı adı",
                    "placeholder", "root", "canSave", saved));
            if (a == null || a.optString("value").trim().isEmpty()) throw new CancelledException();
            user = a.optString("value").trim();
            if (a.optBoolean("save")) creds.saveUser = user;
        }

        String auth = s.optString("authType", "password");
        if (auth.equals("agent")) auth = "auto"; // masaüstünden gelen: telefonda agent yok, kayıtlı anahtarları dene
        String passphrase = s.optString("passphrase", null);
        List<JSONObject> keys = host.privateKeys();
        List<String> keyNames = new ArrayList<>();
        if (auth.equals("key")) {
            JSONObject k = pickKey(keys, s);
            if (k == null) {
                String kp = s.optString("keyPath");
                throw new Exception("SSH anahtarı bulunamadı" + (kp.isEmpty() ? "" : " (" + kp + ")")
                        + ". Ayarlar > SSH anahtarları bölümünden anahtarı içe aktarıp oturumda seçin.");
            }
            String pp = passphrase != null ? passphrase : k.optString("passphrase", null);
            addIdentity(jsch, k, pp);
            keyNames.add(k.optString("name"));
        } else if (auth.equals("auto")) {
            for (JSONObject k : keys) {
                try { addIdentity(jsch, k, k.optString("passphrase", null)); keyNames.add(k.optString("name")); } catch (Exception ignored) { }
            }
        }

        Session ss = jsch.getSession(user, hostName, port);
        ss.setHostKeyRepository(new KnownHosts(hostName, port));
        ss.setConfig("StrictHostKeyChecking", "yes");
        ss.setConfig("PreferredAuthentications", auth.equals("password")
                ? "password,keyboard-interactive"
                : "publickey,keyboard-interactive,password");
        ss.setConfig("MaxAuthTries", "6");
        String pw = s.optString("password", null);
        if (pw != null && !pw.isEmpty()) ss.setPassword(pw);
        int keepalive = s.optInt("keepalive", 30);
        if (keepalive > 0) {
            ss.setServerAliveInterval(keepalive * 1000);
            ss.setServerAliveCountMax(3);
        }
        ss.setUserInfo(new Prompter(conn, s, user, hostName, port, saved, creds, pw != null && !pw.isEmpty()));
        if (via != null) ss.setProxy(new JumpProxy(via, hostName, port));
        try {
            ss.connect(20000);
        } catch (JSchException e) {
            if (conn.closing) throw new CancelledException();
            if (creds.cancelled) throw new CancelledException();
            throw e;
        }
        if (saved) {
            JSONObject c = new JSONObject();
            if (creds.saveUser != null) c.put("username", creds.saveUser);
            if (creds.savePassword != null) c.put("password", creds.savePassword);
            if (creds.savePassphrase != null) c.put("passphrase", creds.savePassphrase);
            if (c.length() > 0) host.saveCredentials(s.optString("id"), c);
        }
        return ss;
    }

    static JSONObject pickKey(List<JSONObject> keys, JSONObject s) {
        String keyId = s.optString("keyId");
        if (!keyId.isEmpty()) for (JSONObject k : keys) if (k.optString("id").equals(keyId)) return k;
        // Masaüstünden gelen oturum: keyPath'in dosya adı ile eşleştir (~/.ssh/id_ed25519 -> id_ed25519)
        String kp = s.optString("keyPath");
        if (!kp.isEmpty()) {
            String base = kp.replaceAll("^.*/", "");
            for (JSONObject k : keys) if (k.optString("name").equals(base)) return k;
        }
        if (keyId.isEmpty() && kp.isEmpty() && keys.size() == 1) return keys.get(0);
        return null;
    }

    static void addIdentity(JSch jsch, JSONObject k, String passphrase) throws JSchException {
        byte[] prv = k.optString("private").getBytes(StandardCharsets.UTF_8);
        byte[] pp = passphrase == null || passphrase.isEmpty() ? null : passphrase.getBytes(StandardCharsets.UTF_8);
        jsch.addIdentity(k.optString("name", "anahtar"), prv, null, pp);
    }

    static class Creds {
        String saveUser, savePassword, savePassphrase;
        boolean cancelled;
    }

    /** Parola / anahtar parolası / keyboard-interactive soruları. */
    class Prompter implements UserInfo, UIKeyboardInteractive {
        final Conn conn;
        final JSONObject s;
        final String user, hostName;
        final int port;
        final boolean saved;
        final Creds creds;
        String password, passphrase;
        int pwAsked;
        boolean hadStored;

        Prompter(Conn conn, JSONObject s, String user, String hostName, int port, boolean saved, Creds creds, boolean hadStored) {
            this.conn = conn; this.s = s; this.user = user; this.hostName = hostName; this.port = port;
            this.saved = saved; this.creds = creds; this.hadStored = hadStored;
        }

        @Override public String getPassphrase() { return passphrase; }
        @Override public String getPassword() { return password; }

        @Override public boolean promptPassword(String message) {
            if (conn.closing) { creds.cancelled = true; return false; }
            boolean retry = hadStored || pwAsked > 0;
            pwAsked++;
            if (pwAsked > 4) return false;
            JSONObject a = askQuiet("password", obj("title", "Parola", "message", user + "@" + hostName + (port != 22 ? ":" + port : "") + " parolası",
                    "retry", retry, "canSave", saved));
            if (a == null) { creds.cancelled = true; return false; }
            password = a.optString("value");
            creds.savePassword = a.optBoolean("save") ? password : null;
            return true;
        }

        @Override public boolean promptPassphrase(String message) {
            if (conn.closing) { creds.cancelled = true; return false; }
            JSONObject a = askQuiet("password", obj("title", "Anahtar parolası", "message", message, "canSave", saved));
            if (a == null) { creds.cancelled = true; return false; }
            passphrase = a.optString("value");
            creds.savePassphrase = a.optBoolean("save") ? passphrase : null;
            return true;
        }

        @Override public boolean promptYesNo(String message) {
            JSONObject a = askQuiet("confirm", obj("title", "Onay", "message", message));
            return a != null && a.optBoolean("value");
        }

        @Override public void showMessage(String message) {
            if (message != null && !message.trim().isEmpty())
                host.emit("banner", obj("c", conn.id, "message", message));
        }

        @Override public String[] promptKeyboardInteractive(String dest, String name, String instruction, String[] prompt, boolean[] echo) {
            if (conn.closing) { creds.cancelled = true; return null; }
            if (prompt.length == 0) return new String[0];
            if (prompt.length == 1 && !echo[0] && prompt[0].toLowerCase(java.util.Locale.ROOT).contains("password")) {
                if (!promptPassword(prompt[0])) return null;
                return new String[]{password};
            }
            JSONArray ps = new JSONArray();
            for (int i = 0; i < prompt.length; i++) ps.put(obj("prompt", prompt[i], "echo", echo[i]));
            JSONObject a = askQuiet("kbd", obj("title", name == null || name.isEmpty() ? "Kimlik doğrulama" : name,
                    "message", instruction == null ? "" : instruction, "prompts", ps));
            if (a == null) { creds.cancelled = true; return null; }
            JSONArray v = a.optJSONArray("value");
            String[] out = new String[prompt.length];
            for (int i = 0; i < out.length; i++) out[i] = v == null ? "" : v.optString(i, "");
            return out;
        }

        JSONObject askQuiet(String kind, JSONObject p) {
            try { return host.ask(kind, p); } catch (InterruptedException e) { return null; }
        }
    }

    /** Sunucu anahtarı doğrulama: kayıtlı değilse / değiştiyse kullanıcıya sorar. */
    class KnownHosts implements HostKeyRepository {
        final String hostName;
        final int port;

        KnownHosts(String hostName, int port) { this.hostName = hostName; this.port = port; }

        @Override public int check(String h, byte[] key) {
            String hp = "[" + hostName + "]:" + port;
            String b64 = Base64.getEncoder().encodeToString(key);
            String type;
            try { type = new HostKey(h, key).getType(); } catch (JSchException e) { type = "?"; }
            String fp = fingerprint(key);
            JSONObject known = host.getKnownHost(hp);
            if (known != null && b64.equals(known.optString("key"))) return OK;
            JSONObject p = obj("host", hostName, "port", port, "type", type, "fingerprint", fp, "changed", known != null);
            if (known != null) p = obj("host", hostName, "port", port, "type", type, "fingerprint", fp, "changed", true,
                    "oldFingerprint", known.optString("fingerprint"));
            JSONObject a;
            try { a = host.ask("hostkey", p); } catch (InterruptedException e) { a = null; }
            if (a == null || !a.optBoolean("accept")) return known != null ? CHANGED : NOT_INCLUDED;
            if (a.optBoolean("save", true))
                host.putKnownHost(hp, obj("type", type, "key", b64, "fingerprint", fp, "added", System.currentTimeMillis()));
            return OK;
        }

        @Override public void add(HostKey hostkey, UserInfo ui) { }
        @Override public void remove(String host, String type) { }
        @Override public void remove(String host, String type, byte[] key) { }
        @Override public String getKnownHostsRepositoryID() { return "sshdeck"; }
        @Override public HostKey[] getHostKey() { return new HostKey[0]; }
        @Override public HostKey[] getHostKey(String host, String type) { return new HostKey[0]; }
    }

    public static String fingerprint(byte[] key) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(key);
            return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(d);
        } catch (Exception e) { return "?"; }
    }

    /** Jump host üzerinden direct-tcpip kanalı ile bağlanma. */
    static class JumpProxy implements Proxy {
        final Session gw;
        final String host;
        final int port;
        Channel ch;
        InputStream in;
        OutputStream out;

        JumpProxy(Session gw, String host, int port) { this.gw = gw; this.host = host; this.port = port; }

        @Override public void connect(SocketFactory sf, String h, int p, int timeout) throws Exception {
            ch = gw.getStreamForwarder(host, port);
            in = ch.getInputStream();
            out = ch.getOutputStream();
            ch.connect(timeout > 0 ? timeout : 20000);
        }
        @Override public InputStream getInputStream() { return in; }
        @Override public OutputStream getOutputStream() { return out; }
        @Override public Socket getSocket() { return null; }
        @Override public void close() { if (ch != null) ch.disconnect(); }
    }

    // ------------------------------------------------------------------ disconnect / watch
    public void disconnect(String connId) {
        Conn c = conns.remove(connId);
        if (c != null) closeConn(c, true);
    }

    public void disconnectAll() {
        for (String id : new ArrayList<>(conns.keySet())) disconnect(id);
    }

    public int count() { return conns.size(); }

    void closeConn(Conn c, boolean emit) {
        c.closing = true;
        for (Forwards.Fwd f : c.fwds.values()) f.stop();
        c.fwds.clear();
        for (Shell sh : c.shells.values()) { sh.closed = true; try { sh.ch.disconnect(); } catch (Exception ignored) { } }
        c.shells.clear();
        synchronized (c.sftpLock) { if (c.sftp != null) c.sftp.disconnect(); c.sftp = null; }
        for (int i = c.chain.size() - 1; i >= 0; i--) try { c.chain.get(i).disconnect(); } catch (Exception ignored) { }
        c.writer.shutdownNow();
        if (emit && !c.closedEmitted) {
            c.closedEmitted = true;
            host.emit("closed", obj("c", c.id, "reason", "user"));
        }
    }

    /** Kopan bağlantıları yakala (JSch'in kopma bildirimi yok). */
    void watch() {
        for (Conn c : conns.values()) {
            if (c.ssh == null || c.closing) continue;
            if (!c.ssh.isConnected()) {
                conns.remove(c.id);
                closeConn(c, false);
                c.closedEmitted = true;
                host.emit("closed", obj("c", c.id, "reason", "lost", "message", "Bağlantı koptu"));
            }
        }
    }

    /**
     * Ağ değişti (Wi-Fi <-> mobil veri) ya da uygulama uzun uykudan döndü: eski TCP bağlantısı ölmüş olabilir.
     * Her bağlantıda bir kanal açmayı dener; yanıt gelmezse bağlantıyı kapatır (watch "lost" bildirir).
     */
    public void probeAll(int timeoutMs) {
        for (Conn c : conns.values()) {
            if (c.ssh == null || c.closing) continue;
            pool.execute(() -> {
                Channel ch = null;
                try {
                    ch = c.ssh.openChannel("session");
                    ch.connect(timeoutMs);
                } catch (Exception e) {
                    if (!c.closing) c.ssh.disconnect();
                } finally {
                    if (ch != null) ch.disconnect();
                }
            });
        }
    }

    public Conn get(String connId) throws Exception {
        Conn c = conns.get(connId);
        if (c == null || c.ssh == null) throw new Exception("Bağlantı yok");
        return c;
    }

    // ------------------------------------------------------------------ shells
    public void openShell(String connId, String sid, int cols, int rows) throws Exception {
        Conn c = get(connId);
        ChannelShell ch = (ChannelShell) c.ssh.openChannel("shell");
        ch.setPtyType("xterm-256color", Math.max(cols, 10), Math.max(rows, 4), 0, 0);
        Shell sh = new Shell();
        sh.sid = sid;
        sh.ch = ch;
        ch.setOutputStream(new OutputStream() {
            @Override public void write(int b) { write(new byte[]{(byte) b}, 0, 1); }
            @Override public void write(byte[] b, int off, int len) { shellData(c, sh, b, off, len); }
            @Override public void close() { shellClosed(c, sh); }
        }, false);
        sh.out = ch.getOutputStream();
        ch.connect(15000);
        c.shells.put(sid, sh);
    }

    void shellData(Conn c, Shell sh, byte[] b, int off, int len) {
        synchronized (sh.buf) {
            sh.buf.write(b, off, len);
            if (sh.flushQueued) return;
            sh.flushQueued = true;
        }
        timer.schedule(() -> flushShell(c, sh), 8, TimeUnit.MILLISECONDS);
    }

    void flushShell(Conn c, Shell sh) {
        byte[] data;
        synchronized (sh.buf) {
            data = sh.buf.toByteArray();
            sh.buf.reset();
            sh.flushQueued = false;
        }
        if (data.length > 0)
            host.emit("data", obj("c", c.id, "s", sh.sid, "d", Base64.getEncoder().encodeToString(data)));
    }

    void shellClosed(Conn c, Shell sh) {
        if (sh.closed) return;
        sh.closed = true;
        timer.schedule(() -> {
            flushShell(c, sh);
            c.shells.remove(sh.sid);
            if (!c.closing) host.emit("exit", obj("c", c.id, "s", sh.sid, "code", sh.ch.getExitStatus()));
        }, 30, TimeUnit.MILLISECONDS);
    }

    public void write(String connId, String sid, String data) {
        Conn c = conns.get(connId);
        if (c == null) return;
        Shell sh = c.shells.get(sid);
        if (sh == null) return;
        byte[] b = data.getBytes(StandardCharsets.UTF_8);
        try {
            c.writer.execute(() -> {
                try { sh.out.write(b); sh.out.flush(); } catch (IOException ignored) { }
            });
        } catch (Exception ignored) { }
    }

    public void resize(String connId, String sid, int cols, int rows) {
        Conn c = conns.get(connId);
        if (c == null) return;
        Shell sh = c.shells.get(sid);
        if (sh != null && cols > 0 && rows > 0) sh.ch.setPtySize(cols, rows, 0, 0);
    }

    public void closeShell(String connId, String sid) {
        Conn c = conns.get(connId);
        if (c == null) return;
        Shell sh = c.shells.remove(sid);
        if (sh != null) { sh.closed = true; sh.ch.disconnect(); }
    }

    // ------------------------------------------------------------------ exec
    public JSONObject exec(String connId, String cmd, long timeoutMs) throws Exception {
        Conn c = get(connId);
        ChannelExec ch = (ChannelExec) c.ssh.openChannel("exec");
        ch.setCommand(cmd);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteArrayOutputStream err = new ByteArrayOutputStream();
        ch.setOutputStream(out);
        ch.setErrStream(err);
        ch.setInputStream(null);
        ch.connect(15000);
        long end = System.currentTimeMillis() + (timeoutMs > 0 ? timeoutMs : 30000);
        while (!ch.isClosed()) {
            if (System.currentTimeMillis() > end) { ch.disconnect(); throw new Exception("Komut zaman aşımına uğradı"); }
            Thread.sleep(15);
        }
        int code = ch.getExitStatus();
        ch.disconnect();
        return obj("code", code, "stdout", out.toString("UTF-8"), "stderr", err.toString("UTF-8"));
    }

    public String installPublicKey(String connId, String pubKey) throws Exception {
        String key = pubKey == null ? "" : pubKey.trim();
        if (!key.matches("^(ssh-|ecdsa-|sk-)\\S+ [A-Za-z0-9+/=]+( .*)?$") || key.contains("\n"))
            throw new Exception("Geçersiz açık anahtar");
        String q = "'" + key.replace("'", "'\\''") + "'";
        String cmd = "sh -c 'umask 077; mkdir -p \"$HOME/.ssh\" && touch \"$HOME/.ssh/authorized_keys\" && chmod 700 \"$HOME/.ssh\" && chmod 600 \"$HOME/.ssh/authorized_keys\" && "
                + "if grep -qxF \"$1\" \"$HOME/.ssh/authorized_keys\"; then echo EXISTS; else printf \"%s\\n\" \"$1\" >> \"$HOME/.ssh/authorized_keys\" && echo ADDED; fi' sh " + q;
        JSONObject r = exec(connId, cmd, 20000);
        String so = r.optString("stdout");
        if (so.contains("ADDED")) return "added";
        if (so.contains("EXISTS")) return "exists";
        String msg = (r.optString("stderr") + so).trim();
        throw new Exception("Anahtar eklenemedi: " + (msg.isEmpty() ? "çıkış kodu " + r.optInt("code") : msg));
    }

    // ------------------------------------------------------------------ errors
    public static Exception friendly(Exception e, JSONObject s) {
        if (e instanceof CancelledException) return e;
        String where = s.optString("host") + ":" + s.optInt("port", 22);
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        String m = String.valueOf(e.getMessage());
        if (root instanceof UnknownHostException) return new Exception("Sunucu adı çözülemedi: " + s.optString("host"));
        if (root instanceof ConnectException) return new Exception("Bağlantı reddedildi: " + where);
        if (root instanceof NoRouteToHostException) return new Exception("Sunucuya ulaşılamıyor: " + where);
        if (root instanceof SocketTimeoutException || m.toLowerCase(java.util.Locale.ROOT).contains("timeout")) return new Exception("Zaman aşımı: " + where);
        if (m.contains("Auth cancel") || m.contains("Auth fail") || m.contains("USERAUTH fail")) return new Exception("Kimlik doğrulama başarısız (" + s.optString("username", "?") + "@" + where + ")");
        if (m.contains("reject HostKey") || m.contains("HostKey has been changed")) return new Exception("Sunucu anahtarı reddedildi: " + where);
        if (m.contains("invalid privatekey")) return new Exception("Özel anahtar okunamadı (desteklenmeyen biçim ya da yanlış parola)");
        if (m.contains("Algorithm negotiation fail")) return new Exception("Sunucu ile ortak şifreleme algoritması bulunamadı: " + where);
        if (m.contains("Network is unreachable") || m.contains("ENETUNREACH")) return new Exception("Ağ yok: " + where);
        if (m.contains("Connection refused")) return new Exception("Bağlantı reddedildi: " + where);
        if (m.contains("Connection reset") || m.contains("Broken pipe") || m.contains("End of IO Stream")) return new Exception("Bağlantı sunucu tarafından kapatıldı: " + where);
        return e;
    }

    // ------------------------------------------------------------------ helpers
    public static JSONObject obj(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1] == null ? JSONObject.NULL : kv[i + 1]);
        } catch (JSONException ignored) { }
        return o;
    }

    static Iterable<String> iter(JSONObject o) {
        List<String> l = new ArrayList<>();
        o.keys().forEachRemaining(l::add);
        return l;
    }
}
