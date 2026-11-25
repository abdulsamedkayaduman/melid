import dev.melid.core.Backup;
import dev.melid.core.Forwards;
import dev.melid.core.Host;
import dev.melid.core.Keys;
import dev.melid.core.Sftp;
import dev.melid.core.SshCore;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;

/** Android SSH çekirdeğinin JVM testleri (coretest/run.sh çalıştırır). */
public class CoreTest {
    static String W;
    static int passed = 0;

    static class TestHost implements Host {
        final Map<String, JSONObject> sessions = new HashMap<>();
        final Map<String, JSONObject> known = new ConcurrentHashMap<>();
        final List<JSONObject> keys = new ArrayList<>();
        final List<JSONObject> events = new CopyOnWriteArrayList<>();
        final List<String> asked = new CopyOnWriteArrayList<>();
        final Map<String, JSONObject> saved = new HashMap<>();
        final LinkedList<Function<JSONObject, JSONObject>> answers = new LinkedList<>();
        boolean acceptHostKeys = true;

        public void emit(String type, JSONObject d) {
            try { d.put("_type", type); } catch (Exception ignored) { }
            events.add(d);
        }

        public JSONObject ask(String kind, JSONObject p) {
            asked.add(kind);
            if (kind.equals("hostkey")) return SshCore.obj("accept", acceptHostKeys, "save", true);
            synchronized (answers) {
                if (answers.isEmpty()) return null;
                return answers.removeFirst().apply(p);
            }
        }

        public JSONObject resolveSession(String id) {
            JSONObject s = sessions.get(id);
            return s == null ? null : new JSONObject(s.toString());
        }

        public JSONObject getKnownHost(String hp) { return known.get(hp); }
        public void putKnownHost(String hp, JSONObject e) { known.put(hp, e); }
        public void saveCredentials(String id, JSONObject c) { saved.put(id, c); }
        public List<JSONObject> privateKeys() { return keys; }

        String eventText(String c, String s) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            for (JSONObject e : events)
                if (e.optString("_type").equals("data") && e.optString("c").equals(c) && e.optString("s").equals(s))
                    bo.writeBytes(Base64.getDecoder().decode(e.optString("d")));
            return bo.toString(StandardCharsets.UTF_8);
        }

        JSONObject lastEvent(String type, String key, String val) {
            for (int i = events.size() - 1; i >= 0; i--) {
                JSONObject e = events.get(i);
                if (e.optString("_type").equals(type) && e.optString(key).equals(val)) return e;
            }
            return null;
        }
    }

    static void ok(boolean cond, String name) {
        if (!cond) throw new AssertionError("BAŞARISIZ: " + name);
        passed++;
        System.out.println("  ✓ " + name);
    }

    static void waitFor(java.util.function.BooleanSupplier f, long ms, String what) throws Exception {
        long end = System.currentTimeMillis() + ms;
        while (!f.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("Zaman aşımı: " + what);
            Thread.sleep(20);
        }
    }

    static String read(String f) throws Exception { return Files.readString(new File(W, f).toPath()); }

    static JSONObject key(String id, String file, String passphrase) throws Exception {
        JSONObject k = SshCore.obj("id", id, "name", file, "private", read(file));
        if (passphrase != null) k.put("passphrase", passphrase);
        return k;
    }

    static String expectError(ThrowingRunnable r) {
        try { r.run(); } catch (Exception e) { return e.getMessage(); }
        throw new AssertionError("Hata bekleniyordu");
    }

    interface ThrowingRunnable { void run() throws Exception; }

    static String banner(int port) throws Exception {
        try (Socket s = new Socket("127.0.0.1", port)) {
            s.setSoTimeout(5000);
            byte[] b = new byte[7];
            new java.io.DataInputStream(s.getInputStream()).readFully(b);
            return new String(b, StandardCharsets.US_ASCII);
        }
    }

    public static void main(String[] args) {
        try { run(args); } catch (Throwable e) { e.printStackTrace(); System.exit(1); }
    }

    static void run(String[] args) throws Exception {
        W = args[0];
        String user = System.getProperty("user.name");
        TestHost h = new TestHost();
        SshCore core = new SshCore(h);
        Sftp sftp = new Sftp(core);
        Forwards fwd = new Forwards(core);

        h.sessions.put("k", SshCore.obj("id", "k", "host", "127.0.0.1", "port", 2299, "username", user, "authType", "key", "keyId", "uk"));
        h.keys.add(key("uk", "userkey", null));

        System.out.println("bağlantı / anahtar");
        core.connect("c1", "k", null);
        ok(h.asked.contains("hostkey"), "bilinmeyen sunucu anahtarı soruldu");
        ok(h.known.containsKey("[127.0.0.1]:2299"), "sunucu anahtarı kaydedildi");
        ok(h.known.get("[127.0.0.1]:2299").optString("fingerprint").startsWith("SHA256:"), "parmak izi SHA256");
        h.asked.clear();
        core.connect("c2", "k", null);
        ok(!h.asked.contains("hostkey"), "kayıtlı anahtar tekrar sorulmadı");
        core.disconnect("c2");
        ok(h.lastEvent("closed", "c", "c2") != null, "disconnect closed olayı");

        System.out.println("exec / shell");
        JSONObject r = core.exec("c1", "echo merhaba; echo hata >&2; exit 3", 10000);
        ok(r.optString("stdout").equals("merhaba\n") && r.optString("stderr").equals("hata\n") && r.optInt("code") == 3, "exec stdout/stderr/kod");
        core.openShell("c1", "main", 100, 30);
        core.write("c1", "main", "echo sonuc-$((40+2)) ğüşİ\n");
        waitFor(() -> h.eventText("c1", "main").contains("sonuc-42 ğüşİ"), 8000, "shell çıktısı");
        ok(true, "shell yaz/oku (UTF-8)");
        core.resize("c1", "main", 120, 40);
        core.write("c1", "main", "stty size\n");
        waitFor(() -> h.eventText("c1", "main").contains("40 120"), 8000, "pty boyutu");
        ok(true, "pty yeniden boyutlandırma");
        core.openShell("c1", "s2", 80, 24);
        core.write("c1", "s2", "echo ikinci-kabuk\n");
        waitFor(() -> h.eventText("c1", "s2").contains("ikinci-kabuk"), 8000, "ikinci kabuk");
        ok(!h.eventText("c1", "main").contains("ikinci-kabuk"), "kabuklar ayrı");
        core.write("c1", "s2", "exit 0\n");
        waitFor(() -> h.lastEvent("exit", "s", "s2") != null, 8000, "kabuk çıkışı");
        ok(true, "kabuk exit olayı");

        System.out.println("sftp");
        String home = sftp.home("c1");
        ok(home.startsWith("/"), "ev dizini: " + home);
        String dir = home + "/.melid-coretest";
        try { sftp.remove("c1", dir); } catch (Exception ignored) { }
        sftp.mkdir("c1", dir);
        sftp.writeText("c1", dir + "/a.txt", "selam dünya\n");
        JSONObject rd = sftp.read("c1", dir + "/a.txt", 1 << 20, false);
        ok(rd.optString("text").equals("selam dünya\n"), "yaz/oku metin");
        sftp.rename("c1", dir + "/a.txt", dir + "/b.txt");
        JSONObject ls = sftp.list("c1", dir);
        JSONArray en = ls.getJSONArray("entries");
        ok(en.length() == 1 && en.getJSONObject(0).optString("name").equals("b.txt") && en.getJSONObject(0).optLong("size") == 13, "listele + yeniden adlandır");
        sftp.chmod("c1", dir + "/b.txt", 0600);
        ok((sftp.stat("c1", dir + "/b.txt").optInt("mode") & 0777) == 0600, "chmod");
        String msg = expectError(() -> sftp.list("c1", dir + "/yok"));
        ok(msg.contains("bulunamadı"), "Türkçe SFTP hatası: " + msg);

        System.out.println("aktarım");
        byte[] big = new byte[3_000_000];
        new java.util.Random(1).nextBytes(big);
        List<Sftp.Source> src = new ArrayList<>();
        src.add(new Sftp.Source() {
            public String name() { return "big.bin"; }
            public long size() { return big.length; }
            public InputStream open() { return new ByteArrayInputStream(big); }
        });
        sftp.upload("u1", "c1", src, dir);
        waitFor(() -> h.lastEvent("xfer", "id", "u1") != null && h.lastEvent("xfer", "id", "u1").optString("state").equals("done"), 20000, "yükleme");
        ok(sftp.stat("c1", dir + "/big.bin").optLong("size") == big.length, "yükleme boyutu");
        sftp.mkdir("c1", dir + "/alt");
        sftp.writeText("c1", dir + "/alt/c.txt", "ccc");
        Map<String, ByteArrayOutputStream> got = new ConcurrentHashMap<>();
        List<String> finished = new CopyOnWriteArrayList<>();
        Sftp.Sink sink = new Sftp.Sink() {
            public OutputStream open(String rel, long size) { ByteArrayOutputStream b = new ByteArrayOutputStream(); got.put(rel, b); return b; }
            public void finish(String rel, boolean okk) { finished.add(rel + ":" + okk); }
        };
        sftp.download("d1", "c1", dir, sink);
        waitFor(() -> h.lastEvent("xfer", "id", "d1") != null && !h.lastEvent("xfer", "id", "d1").optString("state").equals("run"), 20000, "klasör indirme");
        ok(h.lastEvent("xfer", "id", "d1").optString("state").equals("done"), "klasör indirme bitti");
        String base = dir.replaceAll("^.*/", "");
        ok(java.util.Arrays.equals(got.get(base + "/big.bin").toByteArray(), big), "indirilen içerik aynı");
        ok(got.get(base + "/alt/c.txt").toString().equals("ccc") && finished.size() == 3, "alt klasör indirildi");
        // iptal
        Sftp.Sink slow = new Sftp.Sink() {
            public OutputStream open(String rel, long size) {
                return new OutputStream() {
                    public void write(int b) { }
                    public void write(byte[] b, int o, int l) { try { Thread.sleep(30); } catch (InterruptedException ignored) { } }
                };
            }
            public void finish(String rel, boolean okk) { finished.add("slow:" + okk); }
        };
        sftp.download("d2", "c1", dir + "/big.bin", slow);
        Thread.sleep(300);
        sftp.cancel("d2");
        waitFor(() -> h.lastEvent("xfer", "id", "d2") != null && !h.lastEvent("xfer", "id", "d2").optString("state").equals("run"), 10000, "iptal");
        ok(h.lastEvent("xfer", "id", "d2").optString("state").equals("cancelled") && finished.contains("slow:false"), "aktarım iptali");
        ok(sftp.list("c1", dir).getJSONArray("entries").length() == 3, "iptal sonrası paylaşılan kanal çalışıyor");
        sftp.remove("c1", dir);
        ok(expectError(() -> sftp.stat("c1", dir)).contains("bulunamadı"), "klasör özyinelemeli silindi");

        System.out.println("tüneller");
        int freeL;
        try (ServerSocket ss = new ServerSocket(0)) { freeL = ss.getLocalPort(); }
        JSONObject fl = fwd.start("c1", SshCore.obj("id", "L1", "type", "L", "bindHost", "127.0.0.1", "bindPort", freeL, "dstHost", "127.0.0.1", "dstPort", 2299));
        ok(banner(fl.getInt("port")).equals("SSH-2.0"), "-L yerel tünel");
        fwd.stop("c1", "L1");
        ok(expectError(() -> banner(freeL)) != null, "-L durdurulunca port kapandı");
        JSONObject fd = fwd.start("c1", SshCore.obj("id", "D1", "type", "D", "bindHost", "127.0.0.1", "bindPort", 0));
        try (Socket s = new Socket("127.0.0.1", fd.getInt("port"))) {
            s.setSoTimeout(5000);
            OutputStream o = s.getOutputStream();
            java.io.DataInputStream in = new java.io.DataInputStream(s.getInputStream());
            o.write(new byte[]{5, 1, 0});
            byte[] g = new byte[2]; in.readFully(g);
            byte[] hn = "localhost".getBytes();
            ByteArrayOutputStream req = new ByteArrayOutputStream();
            req.write(new byte[]{5, 1, 0, 3, (byte) hn.length}); req.write(hn); req.write(new byte[]{(byte) (2299 >> 8), (byte) (2299 & 255)});
            o.write(req.toByteArray());
            byte[] rep = new byte[10]; in.readFully(rep);
            byte[] b = new byte[7]; in.readFully(b);
            ok(rep[1] == 0 && new String(b).equals("SSH-2.0"), "-D SOCKS5 (alan adıyla)");
        }
        fwd.stop("c1", "D1");
        int freeR;
        try (ServerSocket ss = new ServerSocket(0)) { freeR = ss.getLocalPort(); }
        fwd.start("c1", SshCore.obj("id", "R1", "type", "R", "bindHost", "127.0.0.1", "bindPort", freeR, "dstHost", "127.0.0.1", "dstPort", 2299));
        JSONObject rr = core.exec("c1", "bash -c 'exec 3<>/dev/tcp/127.0.0.1/" + freeR + "; head -c 7 <&3'", 10000);
        ok(rr.optString("stdout").equals("SSH-2.0"), "-R uzak tünel");
        ok(fwd.active("c1").length() == 1, "etkin tünel listesi");

        System.out.println("jump host / anahtar türleri");
        h.sessions.put("j", SshCore.obj("id", "j", "host", "localhost", "port", 2299, "username", user, "authType", "key", "keyId", "uk", "jumpHostId", "k"));
        h.asked.clear();
        core.connect("cj", "j", null);
        ok(core.exec("cj", "echo jump-ok", 10000).optString("stdout").equals("jump-ok\n"), "jump host üzerinden bağlantı");
        ok(h.asked.contains("hostkey"), "jump hedefinin anahtarı ayrı soruldu");
        core.disconnect("cj");

        h.keys.add(key("ue", "userkey_enc", null));
        h.sessions.put("e", SshCore.obj("id", "e", "host", "127.0.0.1", "port", 2299, "username", user, "authType", "key", "keyId", "ue", "passphrase", "kpass"));
        core.connect("ce", "e", null);
        ok(true, "parolalı anahtar (kayıtlı parola)");
        core.disconnect("ce");
        h.sessions.get("e").remove("passphrase");
        h.answers.add(p -> SshCore.obj("value", "kpass", "save", true));
        core.connect("ce", "e", null);
        ok(h.saved.containsKey("e") && h.saved.get("e").optString("passphrase").equals("kpass"), "anahtar parolası soruldu ve kaydedildi");
        core.disconnect("ce");
        h.answers.add(p -> null);
        String cancelMsg = expectError(() -> core.connect("ce", "e", null));
        ok(cancelMsg.contains("İptal"), "parola sorusu iptal: " + cancelMsg);

        h.keys.add(key("ur", "userkey_rsa", null));
        h.sessions.put("r", SshCore.obj("id", "r", "host", "127.0.0.1", "port", 2299, "username", user, "authType", "key", "keyPath", "~/.ssh/userkey_rsa"));
        core.connect("cr", "r", null);
        ok(true, "RSA PEM anahtar + keyPath dosya adıyla eşleme");
        core.disconnect("cr");

        h.sessions.put("a", SshCore.obj("id", "a", "host", "127.0.0.1", "port", 2299, "username", user, "authType", "auto"));
        core.connect("ca", "a", null);
        ok(true, "otomatik: kayıtlı anahtarları dener");
        core.disconnect("ca");

        System.out.println("anahtar üretme");
        for (String t : new String[]{"ed25519", "ecdsa", "rsa"}) {
            JSONObject g = Keys.generate(t, "melid-test");
            JSONObject ins = Keys.inspect(g.getString("private"), null, "x");
            ok(ins.optString("fingerprint").equals(g.optString("fingerprint")), t + " üret + oku (" + g.optString("type") + ")");
            Files.writeString(new File(W, "authorized_keys").toPath(), g.getString("public") + "\n", java.nio.file.StandardOpenOption.APPEND);
            h.keys.add(SshCore.obj("id", "g" + t, "name", "gen_" + t, "private", g.getString("private")));
            h.sessions.put("g" + t, SshCore.obj("id", "g" + t, "host", "127.0.0.1", "port", 2299, "username", user, "authType", "key", "keyId", "g" + t));
            core.connect("cg" + t, "g" + t, null);
            ok(true, t + " anahtarı OpenSSH sunucusunda çalışıyor");
            core.disconnect("cg" + t);
        }
        ok(Keys.inspect(read("userkey_enc"), null, "").optBoolean("encrypted"), "şifreli anahtar algılandı");
        ok(Keys.inspect(read("userkey_enc"), "kpass", "").optString("type").contains("ed25519"), "şifreli anahtar parolayla çözüldü");
        ok(expectError(() -> Keys.inspect(read("userkey_enc"), "yanlis", "")).contains("yanlış"), "yanlış anahtar parolası");
        ok(expectError(() -> Keys.inspect("çöp", null, "")).contains("okunamadı"), "geçersiz anahtar");

        System.out.println("parola / keyboard-interactive (ssh2 sunucusu)");
        h.sessions.put("p", SshCore.obj("id", "p", "host", "127.0.0.1", "port", 2298, "username", "pw", "authType", "password"));
        List<JSONObject> prompts = new CopyOnWriteArrayList<>();
        h.answers.add(p -> { prompts.add(p); return SshCore.obj("value", "yanlis"); });
        h.answers.add(p -> { prompts.add(p); return SshCore.obj("value", "secret", "save", true); });
        core.connect("cp", "p", null);
        ok(prompts.size() == 2 && !prompts.get(0).optBoolean("retry") && prompts.get(1).optBoolean("retry"), "yanlış parola sonrası yeniden soruldu");
        ok(h.saved.get("p").optString("password").equals("secret"), "parola kaydedildi");
        ok(core.exec("cp", "x", 5000).optString("stdout").equals("ran:x\n"), "parolalı oturumda exec");
        core.disconnect("cp");
        h.sessions.get("p").put("password", "secret");
        h.asked.clear();
        core.connect("cp", "p", null);
        ok(!h.asked.contains("password"), "kayıtlı parola sorulmadan kullanıldı");
        core.disconnect("cp");
        h.sessions.get("p").put("password", "eski");
        h.answers.add(p -> SshCore.obj("value", "secret"));
        core.connect("cp", "p", null);
        ok(h.asked.contains("password"), "kayıtlı parola yanlışsa soruldu");
        core.disconnect("cp");
        h.sessions.put("u", SshCore.obj("id", "u", "host", "127.0.0.1", "port", 2298, "username", "", "authType", "password", "password", "secret"));
        h.answers.add(p -> SshCore.obj("value", "pw", "save", true));
        core.connect("cu", "u", null);
        ok(h.saved.get("u").optString("username").equals("pw"), "boş kullanıcı adı soruldu ve kaydedildi");
        core.disconnect("cu");
        h.sessions.put("kb", SshCore.obj("id", "kb", "host", "127.0.0.1", "port", 2298, "username", "kbd", "authType", "password"));
        List<JSONObject> kq = new CopyOnWriteArrayList<>();
        h.answers.add(p -> { kq.add(p); return SshCore.obj("value", new JSONArray().put("secret").put("123")); });
        core.connect("ck", "kb", null);
        ok(kq.size() == 1 && kq.get(0).getJSONArray("prompts").length() == 2, "keyboard-interactive iki soru");
        core.disconnect("ck");
        h.sessions.get("p").put("password", "yanlis");
        for (int i = 0; i < 5; i++) h.answers.add(p -> SshCore.obj("value", "hep-yanlis"));
        String af = expectError(() -> core.connect("cp", "p", null));
        ok(af.contains("Kimlik doğrulama başarısız"), "Türkçe kimlik hatası: " + af);
        h.answers.clear();

        System.out.println("hatalar");
        h.sessions.put("x", SshCore.obj("id", "x", "host", "127.0.0.1", "port", 2297, "username", "a", "authType", "password", "password", "a"));
        String m1 = expectError(() -> core.connect("cx", "x", null));
        ok(m1.contains("Bağlantı reddedildi"), m1);
        h.sessions.put("y", SshCore.obj("id", "y", "host", "olmayan-sunucu.invalid", "port", 22, "username", "a", "authType", "password", "password", "a"));
        String m2 = expectError(() -> core.connect("cy", "y", null));
        ok(m2.contains("çözülemedi"), m2);
        h.known.clear();
        h.acceptHostKeys = false;
        String m3 = expectError(() -> core.connect("cz", "k", null));
        ok(m3.contains("Sunucu anahtarı reddedildi"), m3);
        h.acceptHostKeys = true;
        h.known.put("[127.0.0.1]:2299", SshCore.obj("type", "ssh-ed25519", "key", "AAAA", "fingerprint", "SHA256:eski"));
        List<String> before = new ArrayList<>(h.asked);
        core.connect("cz", "k", null);
        ok(h.asked.size() > before.size(), "değişen sunucu anahtarı soruldu");
        core.disconnect("cz");
        ok(core.count() == 1, "yalnızca c1 açık kaldı");

        System.out.println("kopma algılama");
        try { core.exec("c1", "kill -9 $PPID", 3000); } catch (Exception ignored) { }
        waitFor(() -> h.lastEvent("closed", "c", "c1") != null, 10000, "kopma olayı");
        ok(h.lastEvent("closed", "c", "c1").optString("reason").equals("lost"), "beklenmedik kopma 'lost' olarak bildirildi");

        System.out.println("yedek (masaüstü uyumu)");
        String js = new String(Files.readAllBytes(new File(W, "backup.json").toPath()), StandardCharsets.UTF_8);
        JSONObject bk = new JSONObject(js);
        byte[] bkey = Backup.deriveKey("yedekP", Base64.getDecoder().decode(bk.getString("secretsSalt")));
        String pw = Backup.decrypt(bk.getJSONArray("sessions").getJSONObject(0).getJSONObject("secrets").getString("password"), bkey);
        ok(pw.equals("gizli-ğ"), "masaüstü yedeğindeki parola çözüldü");
        String enc = Backup.encrypt("geri-dönüş", bkey);
        Files.writeString(new File(W, "java-enc.txt").toPath(), enc);
        ok(Backup.decrypt(enc, bkey).equals("geri-dönüş"), "Java şifrele/çöz");
        ok(expectError(() -> Backup.decrypt(enc, Backup.deriveKey("yanlis", new byte[16]))) != null, "yanlış yedek parolası");

        System.out.println("\n" + passed + " test geçti");
        System.exit(0);
    }
}
