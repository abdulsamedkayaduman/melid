import dev.melid.core.XshellImport;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** core/XshellImport: .xts / .xsh ayrıştırma, parola çözme (masaüstü importers.js ile uyum), tüneller */
public class XshellTest {
    static int passed = 0;

    static void ok(boolean c, String msg) {
        if (!c) { System.err.println("  ✗ " + msg); System.exit(1); }
        passed++; System.out.println("  ✓ " + msg);
    }

    static byte[] sha(String s) throws Exception { return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)); }

    static byte[] xsh(String ver, String host, String enc, String ssh) {
        String t = "[SessionInfo]\r\nVersion=" + ver + "\r\nDescription=not\r\n[CONNECTION]\r\nHost=" + host + "\r\nPort=2200\r\nProtocol=SSH\r\n"
                + "[CONNECTION:AUTHENTICATION]\r\nUserName=root\r\nPassword=" + enc + "\r\n[CONNECTION:SSH]\r\n" + ssh;
        byte[] body = t.getBytes(StandardCharsets.UTF_16LE);
        byte[] out = new byte[body.length + 2];
        out[0] = (byte) 0xff; out[1] = (byte) 0xfe;
        System.arraycopy(body, 0, out, 2, body.length);
        return out;
    }

    public static void main(String[] args) throws Exception {
        String sid = "S-1-5-21-3623811015-3361044348-30300820-1013";
        String revSid = new StringBuilder(sid).reverse().toString();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(bo)) {
            Object[][] entries = {
                {"Xshell/Sessions/Müşteri/web.xsh", xsh("6.0", "10.0.0.1", XshellImport.encrypt("altı-ŞİFRE", sha("Samed" + sid)), "FwdReqCount=2\r\nFwdReq_0_Port=8080\r\nFwdReq_0_Host=localhost\r\nFwdReq_0_HostPort=80\r\nFwdReq_1_Port=1080\r\n")},
                {"Xshell/Sessions/db.xsh", xsh("7.3", "10.0.0.2", XshellImport.encrypt("yedi", sha(revSid + "Samed")), "")},
                {"Xshell/Sessions/ana.xsh", xsh("7.0", "10.0.0.3", XshellImport.encrypt("ana", sha("xshellAna")), "")},
                {"Xshell/Sessions/telnet.xsh", "[CONNECTION]\r\nHost=h\r\nProtocol=TELNET\r\n".getBytes(StandardCharsets.UTF_8)},
                {"Xshell/readme.txt", "x".getBytes(StandardCharsets.UTF_8)},
            };
            for (Object[] e : entries) { z.putNextEntry(new ZipEntry((String) e[0])); z.write((byte[]) e[1]); z.closeEntry(); }
        }
        List<JSONObject> list = XshellImport.parse("export.xts", bo.toByteArray());
        ok(list.size() == 3, ".xts: 3 SSH oturumu (telnet ve diğer dosyalar atlanır)");
        JSONObject web = list.get(0);
        ok(web.getString("name").equals("web") && web.getString("group").equals("Müşteri") && web.getInt("port") == 2200
                && web.getString("username").equals("root") && web.getString("notes").equals("not") && !web.has("password"), "alanlar, UTF-16, klasör");
        JSONArray fw = web.getJSONArray("forwards");
        ok(fw.length() == 2 && fw.getJSONObject(0).getString("type").equals("L") && fw.getJSONObject(0).getString("dstHost").equals("127.0.0.1")
                && fw.getJSONObject(1).getString("type").equals("D") && fw.getJSONObject(1).getInt("bindPort") == 1080, "tüneller (yerel + SOCKS)");

        JSONObject r = XshellImport.applyPasswords(list, "", "", "");
        ok(r.getInt("total") == 3 && r.getInt("ok") == 0, "bilgi yoksa çözülmez");
        r = XshellImport.applyPasswords(list, "DESKTOP-1\\samed", " " + sid + " ", "");
        ok(r.getInt("ok") == 2 && list.get(0).getString("password").equals("altı-ŞİFRE") && list.get(1).getString("password").equals("yedi"),
                "kullanıcı + SID (6.x ve 7.1+ biçimleri, küçük harfli ad)");
        r = XshellImport.applyPasswords(list, null, null, "yanlis");
        ok(r.getInt("ok") == 2 && !list.get(2).has("password"), "yanlış ana parola kabul edilmez");
        r = XshellImport.applyPasswords(list, null, null, "xshellAna");
        ok(r.getInt("ok") == 3 && list.get(2).getString("password").equals("ana"), "Xshell ana parolası");

        // Masaüstünün (importers.js) şifrelediği .xsh: aynı anahtarlar, aynı sonuç
        if (args.length > 0) {
            byte[] desk = Files.readAllBytes(Paths.get(args[0], "desktop.xsh"));
            List<JSONObject> d = XshellImport.parse("Sunucu.xsh", desk);
            XshellImport.applyPasswords(d, "Şükrü", sid, "");
            ok(d.size() == 1 && "masaüstü-ğ".equals(d.get(0).optString("password")), "masaüstünün şifrelediği parola (Türkçe kullanıcı adı, cp1254)");
        }
        System.out.println("\n" + passed + " Xshell testi geçti");
    }
}
