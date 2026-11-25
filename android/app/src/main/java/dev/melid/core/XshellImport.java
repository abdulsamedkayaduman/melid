package dev.melid.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Xshell oturumlarını içe aktarma: .xts (dışa aktarma, zip) ya da tek .xsh. Masaüstündeki src/main/importers.js'in
 * (parseXsh, parseXshellForwards, decryptXshellPassword) karşılığı; Android'den bağımsız, coretest'te sınanır.
 * Parolalar 5.1+: base64(RC4(parola) + SHA256(parola)); anahtar sürüme göre Windows kullanıcı adı + SID ya da Xshell
 * ana parolasından türer. Olası bütün anahtarlar denenir, sonuç SHA-256 özetiyle doğrulanır.
 */
public final class XshellImport {
    private XshellImport() { }

    /** Dosya -> oturumlar. Şifreli parola "_xsEnc", sürüm "_xsVer" alanında (kaydetmeden önce silinir). */
    public static List<JSONObject> parse(String fileName, byte[] data) throws Exception {
        List<JSONObject> out = new ArrayList<>();
        String lower = fileName == null ? "" : fileName.toLowerCase(Locale.ROOT);
        boolean zip = data.length > 4 && data[0] == 'P' && data[1] == 'K';
        if (zip || lower.endsWith(".xts")) {
            try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(data), StandardCharsets.UTF_8)) {
                ZipEntry e;
                while ((e = z.getNextEntry()) != null) {
                    if (e.isDirectory() || !e.getName().toLowerCase(Locale.ROOT).endsWith(".xsh")) continue;
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] b = new byte[8192];
                    int n;
                    while ((n = z.read(b)) > 0) { bo.write(b, 0, n); if (bo.size() > (4 << 20)) throw new Exception("Oturum dosyası çok büyük"); }
                    // girişler genelde "Xshell/Sessions/..." ya da "Sessions/..." ile başlar
                    String rel = e.getName().replace('\\', '/').replaceFirst("(?i)^(?:.*/)?Sessions/", "");
                    JSONObject s = parseXsh(bo.toByteArray(), rel);
                    if (s != null) out.add(s);
                }
            }
            if (out.isEmpty() && !lower.endsWith(".xsh")) return out;
        } else {
            JSONObject s = parseXsh(data, fileName == null ? "oturum.xsh" : fileName);
            if (s != null) out.add(s);
        }
        return out;
    }

    static String decodeText(byte[] b) {
        if (b.length >= 2 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xfe) return new String(b, 2, b.length - 2, StandardCharsets.UTF_16LE);
        if (b.length >= 2 && (b[0] & 0xff) == 0xfe && (b[1] & 0xff) == 0xff) return new String(b, 2, b.length - 2, StandardCharsets.UTF_16BE);
        if (b.length > 3 && b[1] == 0 && b[3] == 0) return new String(b, StandardCharsets.UTF_16LE);
        String s = new String(b, StandardCharsets.UTF_8);
        if (s.indexOf('�') >= 0) return new String(b, Charset.forName("windows-1254"));
        return s.startsWith("﻿") ? s.substring(1) : s;
    }

    /** INI: bölüm adı büyük harf, anahtar küçük harf */
    static Map<String, Map<String, String>> parseIni(String text) {
        Map<String, Map<String, String>> out = new HashMap<>();
        Map<String, String> sec = new HashMap<>();
        out.put("", sec);
        for (String raw : text.split("\r?\n")) {
            String line = raw.trim();
            if (line.isEmpty() || line.charAt(0) == ';') continue;
            if (line.startsWith("[") && line.endsWith("]")) {
                String name = line.substring(1, line.length() - 1).toUpperCase(Locale.ROOT);
                sec = out.computeIfAbsent(name, k -> new HashMap<>());
                continue;
            }
            int i = line.indexOf('=');
            if (i > 0) sec.put(line.substring(0, i).trim().toLowerCase(Locale.ROOT), line.substring(i + 1).trim());
        }
        return out;
    }

    static String cleanGroup(String g) {
        StringBuilder sb = new StringBuilder();
        for (String p : g.replace('\\', '/').split("/")) {
            String t = p.trim();
            if (t.isEmpty()) continue;
            if (sb.length() > 0) sb.append('/');
            sb.append(t);
        }
        return sb.toString();
    }

    static String normHost(String h) { return h == null || h.isEmpty() || h.equals("localhost") ? "127.0.0.1" : h; }

    public static JSONObject parseXsh(byte[] buf, String rel) throws JSONException {
        Map<String, Map<String, String>> ini = parseIni(decodeText(buf));
        Map<String, String> c = ini.getOrDefault("CONNECTION", new HashMap<>());
        Map<String, String> a = ini.getOrDefault("CONNECTION:AUTHENTICATION", new HashMap<>());
        Map<String, String> info = ini.getOrDefault("SESSIONINFO", new HashMap<>());
        String proto = c.getOrDefault("protocol", "");
        if (!proto.isEmpty() && !proto.equalsIgnoreCase("SSH")) return null;
        String host = c.getOrDefault("host", "");
        if (host.isEmpty()) return null;
        List<String> parts = new ArrayList<>(Arrays.asList(rel.replace('\\', '/').split("/")));
        parts.removeIf(String::isEmpty);
        String name = parts.isEmpty() ? host : parts.remove(parts.size() - 1).replaceFirst("(?i)\\.xsh$", "");
        String group = cleanGroup(String.join("/", parts));
        int port;
        try { port = Integer.parseInt(c.getOrDefault("port", "22")); } catch (NumberFormatException e) { port = 22; }
        JSONObject s = new JSONObject().put("name", name).put("group", group.isEmpty() ? "Xshell" : group).put("host", host)
                .put("port", port > 0 ? port : 22).put("username", a.getOrDefault("username", "")).put("authType", "auto")
                .put("forwards", forwards(ini.getOrDefault("CONNECTION:SSH", new HashMap<>())));
        String notes = info.getOrDefault("description", c.getOrDefault("description", ""));
        if (!notes.isEmpty()) s.put("notes", notes.replace("\\n", "\n"));
        String enc = a.getOrDefault("password", "");
        if (!enc.isEmpty()) s.put("_xsEnc", enc).put("_xsVer", info.getOrDefault("version", ""));
        return s;
    }

    /** [CONNECTION:SSH] FwdReqCount + FwdReq_i_Port / _Host / _HostPort; yön FwdReq_i_Type (belgelenmemiş, importers.js ile aynı kural) */
    static JSONArray forwards(Map<String, String> sec) throws JSONException {
        JSONArray out = new JSONArray();
        int n;
        try { n = Math.min(Integer.parseInt(sec.getOrDefault("fwdreqcount", "0")), 100); } catch (NumberFormatException e) { n = 0; }
        for (int i = 0; i < n; i++) {
            String pre = "fwdreq_" + i + "_";
            int bindPort = num(sec.get(pre + "port"));
            if (bindPort <= 0) continue;
            String t = sec.getOrDefault(pre + "type", "").trim().toLowerCase(Locale.ROOT);
            String dstHost = sec.getOrDefault(pre + "host", "").trim();
            int dstPort = num(sec.get(pre + "hostport"));
            String type = t.matches("^(1|r|remote).*") ? "R" : t.matches("^(2|d|dynamic|socks).*") ? "D" : !t.isEmpty() ? "L" : (dstHost.isEmpty() && dstPort <= 0 ? "D" : "L");
            String bind = sec.getOrDefault(pre + "source", sec.getOrDefault(pre + "bindaddress", sec.getOrDefault(pre + "listenhost", "")));
            JSONObject fw = new JSONObject().put("id", "xs" + i).put("type", type).put("bindHost", normHost(bind.trim())).put("bindPort", bindPort).put("enabled", true);
            if (!type.equals("D")) {
                if (dstHost.isEmpty() || dstPort <= 0) continue;
                fw.put("dstHost", normHost(dstHost)).put("dstPort", dstPort);
            }
            out.put(fw);
        }
        return out;
    }

    static int num(String s) { try { return s == null ? 0 : Integer.parseInt(s.trim()); } catch (NumberFormatException e) { return 0; } }

    // ------------------------------------------------------------------ parolalar
    static byte[] rc4(byte[] key, byte[] data) {
        int[] S = new int[256];
        for (int i = 0; i < 256; i++) S[i] = i;
        for (int i = 0, j = 0; i < 256; i++) { j = (j + S[i] + (key[i % key.length] & 0xff)) & 255; int t = S[i]; S[i] = S[j]; S[j] = t; }
        byte[] out = new byte[data.length];
        for (int n = 0, i = 0, j = 0; n < data.length; n++) {
            i = (i + 1) & 255; j = (j + S[i]) & 255; int t = S[i]; S[i] = S[j]; S[j] = t;
            out[n] = (byte) (data[n] ^ S[(S[i] + S[j]) & 255]);
        }
        return out;
    }

    static byte[] sha256(byte[] b) throws Exception { return MessageDigest.getInstance("SHA-256").digest(b); }

    static List<byte[]> encodings(String s) {
        List<byte[]> out = new ArrayList<>();
        out.add(s.getBytes(StandardCharsets.UTF_8));
        boolean ascii = s.chars().allMatch(ch -> ch < 128);
        if (!ascii) { out.add(s.getBytes(Charset.forName("windows-1254"))); out.add(s.getBytes(StandardCharsets.ISO_8859_1)); }
        return out;
    }

    static String rev(String s) { return new StringBuilder(s).reverse().toString(); }

    static String cap(String s) { return s.isEmpty() ? s : s.substring(0, 1).toUpperCase(new Locale("tr")) + s.substring(1); }

    /** Denenecek RC4 anahtarları (importers.js xshellKeys ile aynı sıra) */
    public static List<byte[]> keys(String user, String sid, String master) throws Exception {
        List<byte[]> keys = new ArrayList<>();
        if (master != null && !master.isEmpty()) for (byte[] b : encodings(master)) keys.add(sha256(b));
        if (sid != null && !sid.trim().isEmpty()) {
            sid = sid.trim();
            String u0 = user == null ? "" : user.trim().replaceFirst("^.*\\\\", "");
            Set<String> users = new LinkedHashSet<>();
            if (!u0.isEmpty()) {
                String lo = u0.toLowerCase(Locale.ROOT);
                users.add(u0); users.add(lo); users.add(cap(lo)); users.add(u0.toUpperCase(Locale.ROOT));
            }
            for (String u : users) for (String str : new String[]{u + sid, rev(sid) + u}) for (byte[] b : encodings(str)) keys.add(sha256(b));
            keys.add(sha256(sid.getBytes(StandardCharsets.US_ASCII)));
        }
        return keys;
    }

    /** Şifreli parola -> düz parola ya da null */
    public static String decrypt(String enc, String version, List<byte[]> keys) throws Exception {
        byte[] data;
        try { data = Base64.getMimeDecoder().decode(enc.trim()); } catch (IllegalArgumentException e) { return null; }
        if (data.length == 0) return null;
        double v;
        try { v = Double.parseDouble(version); } catch (Exception e) { v = 0; }
        if (v > 0 && v < 5.1) { // eski sürüm: sabit anahtar, özet yok
            byte[] pt = rc4(MessageDigest.getInstance("MD5").digest("!X@s#h$e%l^l&".getBytes(StandardCharsets.US_ASCII)), data);
            String str = new String(pt, StandardCharsets.UTF_8);
            if (str.indexOf('�') >= 0) return null;
            for (char ch : str.toCharArray()) if (ch < 0x20 || ch == 0x7f) return null;
            return str;
        }
        if (data.length <= 32) return null;
        byte[] ct = Arrays.copyOfRange(data, 0, data.length - 32);
        byte[] sum = Arrays.copyOfRange(data, data.length - 32, data.length);
        for (byte[] k : keys) {
            byte[] pt = rc4(k, ct);
            if (MessageDigest.isEqual(sha256(pt), sum)) {
                String u = new String(pt, StandardCharsets.UTF_8);
                return u.indexOf('�') >= 0 ? new String(pt, Charset.forName("windows-1254")) : u;
            }
        }
        return null;
    }

    /** Çözülebilenleri "password" alanına koyar. Dönüş: { total, ok } */
    public static JSONObject applyPasswords(List<JSONObject> list, String user, String sid, String master) throws Exception {
        List<byte[]> keys = keys(user, sid, master);
        int total = 0, ok = 0;
        for (JSONObject s : list) {
            if (!s.has("_xsEnc")) continue;
            total++;
            if (s.has("password")) { ok++; continue; }
            String pw = decrypt(s.getString("_xsEnc"), s.optString("_xsVer"), keys);
            if (pw != null) { s.put("password", pw); ok++; }
        }
        return new JSONObject().put("total", total).put("ok", ok);
    }

    /** Test için: düz parola -> Xshell 5.1+ biçimi */
    public static String encrypt(String pw, byte[] key) throws Exception {
        byte[] pt = pw.getBytes(StandardCharsets.UTF_8);
        byte[] ct = rc4(key, pt);
        byte[] all = Arrays.copyOf(ct, ct.length + 32);
        System.arraycopy(sha256(pt), 0, all, ct.length, 32);
        return Base64.getEncoder().encodeToString(all);
    }
}
