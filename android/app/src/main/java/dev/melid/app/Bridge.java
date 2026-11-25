package dev.melid.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import dev.melid.core.Keys;
import dev.melid.core.Sftp;

import static dev.melid.core.SshCore.obj;

/**
 * WebView <-> Java köprüsü. JS: MelidNative.call(id, method, argsJson) -> window.__nreply(id, err, result).
 * Olaylar: window.__nevent([[type, data], ...]) (kare başına toplu gönderilir).
 */
public class Bridge {
    final MainActivity act;
    final App app;
    final ExecutorService exec = Executors.newCachedThreadPool();
    final List<String> queue = new ArrayList<>();
    boolean flushPosted;
    /** İndirme kimliği -> MediaStore'daki ilk dosya (bitince "Aç" için) */
    final Map<String, Uri> xferUris = new ConcurrentHashMap<>();

    Bridge(MainActivity act) {
        this.act = act;
        this.app = App.I;
    }

    // ------------------------------------------------------------------ events
    void emit(String type, JSONObject data) {
        String item = "[" + JSONObject.quote(type) + "," + data + "]";
        synchronized (queue) {
            queue.add(item);
            if (flushPosted) return;
            flushPosted = true;
        }
        app.main.postDelayed(this::flush, 4);
    }

    void flush() {
        String js;
        synchronized (queue) {
            flushPosted = false;
            if (queue.isEmpty()) return;
            js = "window.__nevent&&window.__nevent([" + String.join(",", queue) + "])";
            queue.clear();
        }
        act.js(js);
    }

    void reply(String id, String err, Object result) {
        String js = "window.__nreply(" + JSONObject.quote(id) + "," + (err == null ? "null" : JSONObject.quote(err)) + ","
                + (result == null ? "null" : result instanceof String ? JSONObject.quote((String) result) : result.toString()) + ")";
        app.main.post(() -> act.js(js));
    }

    // ------------------------------------------------------------------ fast paths (senkron)
    @JavascriptInterface public void write(String c, String s, String data) { app.core.write(c, s, data); }

    @JavascriptInterface public void resize(String c, String s, int cols, int rows) { app.core.resize(c, s, cols, rows); }

    @JavascriptInterface public void answer(String askId, String json) {
        JSONObject v = null;
        try { if (json != null && !json.equals("null")) v = new JSONObject(json); } catch (Exception ignored) { }
        app.answer(askId, v);
    }

    @JavascriptInterface public void termInput(boolean on) { app.main.post(() -> act.setTermInput(on)); }

    // ------------------------------------------------------------------ async calls
    @JavascriptInterface public void call(String id, String method, String argsJson) {
        exec.execute(() -> {
            try {
                JSONObject a = argsJson == null || argsJson.isEmpty() ? new JSONObject() : new JSONObject(argsJson);
                reply(id, null, dispatch(method, a));
            } catch (Throwable e) {
                String m = e.getMessage();
                reply(id, m == null || m.isEmpty() ? e.getClass().getSimpleName() : m, null);
            }
        });
    }

    /** Kilitliyken izin verilen çağrılar (kilit ekranı) */
    static boolean lockFree(String m) {
        return m.equals("lockStatus") || m.equals("lockUnlock") || m.equals("lockBiometric") || m.equals("appInfo")
                || m.equals("barColors"); // kilit ekranı temaya uygun sistem çubukları için
    }

    Object dispatch(String m, JSONObject a) throws Exception {
        String c = a.optString("c");
        if (app.lock.locked && !lockFree(m)) throw new Exception("MELID_LOCKED");
        switch (m) {
            // ---- uygulama kilidi (AppLock)
            case "lockStatus": return app.lock.status();
            case "lockUnlock": app.lock.unlock(a.optString("password")); return app.lock.status();
            case "lockBiometric": app.lock.unlockBiometric(act); return app.lock.status();
            case "lockSet": app.lock.setPassword(a.optString("old", null), a.optString("password")); app.main.post(act::applyLockWindow); return app.lock.status();
            case "lockDisable": app.lock.disable(a.optString("password")); app.main.post(act::applyLockWindow); return app.lock.status();
            case "lockSetBiometric": app.lock.setBiometric(act, a.optBoolean("on"), a.optString("password", null)); return app.lock.status();
            case "lockTimeout": app.lock.setTimeout(a.optInt("sec")); return app.lock.status();
            case "lockNow": app.lock.lockNow(); app.emit("lock", new JSONObject()); return app.lock.status();

            // ---- store
            case "state": return app.store.state();
            case "saveSession": return app.store.saveSession(a.getJSONObject("session"));
            case "deleteSession": app.store.deleteSession(a.getString("id")); return null;
            case "saveSettings":
                app.store.saveSettings(a.getJSONObject("patch"));
                if (a.getJSONObject("patch").has("wakeLock")) app.updateService();
                if (a.getJSONObject("patch").has("autoUpdate")) Updater.schedule(app);
                return null;
            case "removeKnownHost": app.store.removeKnownHost(a.getString("key")); return null;

            // ---- hesap eşitlemesi (AccountSync / core/SyncCore)
            case "accountStatus": return app.sync.status();
            case "accountScan": return dev.melid.core.SyncCore.scan(dev.melid.core.SyncCore.lanTargets(), dev.melid.core.SyncCore.DEFAULT_PORT, 900);
            // ilk eşitleme hata verse de hesap kaydedilmiştir: zamanlayıcı yine başlar
            case "accountRegister":
                try { app.sync.client.register(a.getString("server"), a.getString("user"), a.getString("password"), a.optString("email"), a.optString("invite")); return app.sync.status(); }
                finally { app.sync.afterLogin(); }
            case "accountLogin":
                try { app.sync.client.login(a.getString("server"), a.getString("user"), a.getString("password")); return app.sync.status(); }
                finally { app.sync.afterLogin(); }
            case "accountLogout": app.sync.stop(); app.sync.client.logout(); return app.sync.status();
            // SSH anahtarlarını eşitleme seçimi (bu cihaza özgü); açılınca hemen eşitlenir
            case "accountSetUsage": app.store.setUsageStats(a.optBoolean("on")); return app.sync.status();
            case "accountSetKeys": app.store.setSyncKeys(a.optBoolean("on")); app.sync.syncAsync(); return app.sync.status();
            case "accountSync": return app.sync.run();
            // kurtarma anahtarı: kod arayüze bir kez gider (gösterilip kaydedilsin diye)
            case "accountInfo": return app.sync.client.info();
            case "accountEmail": return app.sync.client.setEmail(a.getString("email"));
            case "accountDelete": { JSONObject r = app.sync.client.deleteAccount(a.getString("password")); app.sync.stop(); return r; }
            case "accountRecoveryCreate": return app.sync.client.createRecovery(a.getString("password"));
            case "accountRecoveryRemove": app.sync.client.removeRecovery(a.getString("password")); return null;
            case "accountRecover":
                try { app.sync.client.recover(a.getString("server"), a.getString("user"), a.getString("code"), a.getString("password")); return app.sync.status(); }
                finally { app.sync.afterLogin(); }
            case "saveTextDownload": return saveToDownloads(a.getString("name"), "text/plain", a.getString("text").getBytes(StandardCharsets.UTF_8));
            case "accountPassword": app.sync.client.changePassword(a.getString("old"), a.getString("new")); return app.sync.status();

            // ---- ssh
            case "connect": {
                JSONObject r;
                try { r = app.core.connect(c, a.getString("sessionId"), a.optJSONObject("overrides")); }
                catch (dev.melid.core.SshCore.CancelledException e) { throw e; }
                catch (Exception e) { app.usage.inc("connectionFailures", 1); throw e; }
                app.usage.inc("connections", 1);
                app.updateService();
                return r;
            }
            case "disconnect": app.core.disconnect(c); app.updateService(); return null;
            case "probe": app.core.probeAll(8000); return null;
            case "disconnectAll": app.core.disconnectAll(); app.updateService(); return null;
            case "openShell": app.core.openShell(c, a.getString("s"), a.optInt("cols", 80), a.optInt("rows", 24)); return null;
            case "closeShell": app.core.closeShell(c, a.getString("s")); return null;
            case "exec": return app.core.exec(c, a.getString("cmd"), a.optLong("timeout", 30000));
            case "stats": return app.core.exec(c, "sh -c '" + dev.melid.core.SshCore.STATS_SCRIPT + "'", 6000);
            case "installKey": {
                String pub = app.store.keyPublic(a.getString("keyId"));
                if (pub == null) throw new Exception("Anahtar bulunamadı");
                return app.core.installPublicKey(c, pub);
            }

            // ---- sftp
            case "sftpHome": return app.sftp.home(c);
            case "sftpList": return app.sftp.list(c, a.optString("path"));
            case "sftpStat": return app.sftp.stat(c, a.getString("path"));
            case "sftpMkdir": app.sftp.mkdir(c, a.getString("path")); return null;
            case "sftpRename": app.sftp.rename(c, a.getString("from"), a.getString("to")); return null;
            case "sftpRemove": app.sftp.remove(c, a.getString("path")); return null;
            case "sftpChmod": app.sftp.chmod(c, a.getString("path"), a.getInt("mode")); return null;
            case "sftpRead": return app.sftp.read(c, a.getString("path"), a.optInt("max", 2 << 20), a.optBoolean("base64"));
            case "sftpWrite": app.sftp.writeText(c, a.getString("path"), a.getString("text")); return null;
            case "download": app.usage.xferDir.put(a.getString("t"), "down"); app.sftp.download(a.getString("t"), c, a.getString("path"), downloadSink(a.getString("t"))); return null;
            case "upload": app.usage.xferDir.put(a.getString("t"), "up"); return upload(a.getString("t"), c, a.getString("dir"));
            case "cancelXfer": app.sftp.cancel(a.getString("t")); return null;
            case "openDownloaded": openDownloaded(a.getString("t"), a.optString("name")); return null;

            // ---- tunnels
            case "fwdStart": return app.fwd.start(c, a.getJSONObject("fw"));
            case "fwdStop": app.fwd.stop(c, a.getString("id")); return null;
            case "fwdActive": return app.fwd.active(c);

            // ---- keys
            case "keyGenerate": {
                JSONObject g = Keys.generate(a.optString("type", "ed25519"), a.optString("comment"));
                return app.store.addKey(a.optString("name"), g.getString("type"), g.getString("public"), g.getString("fingerprint"), g.getString("private"), null);
            }
            case "keyInspect": return Keys.inspect(a.getString("text"), a.optString("passphrase", null), "");
            case "keyImport": {
                String text = a.getString("text");
                String pp = a.optString("passphrase", null);
                JSONObject ins = Keys.inspect(text, pp, a.optString("comment"));
                if (ins.optBoolean("encrypted")) throw new Exception("Anahtar parolalı: parolayı girin");
                return app.store.addKey(a.optString("name"), ins.getString("type"), ins.getString("public"), ins.getString("fingerprint"), text, pp);
            }
            case "keyDelete": app.store.deleteKey(a.getString("id")); return null;
            case "keyRename": app.store.renameKey(a.getString("id"), a.getString("name")); return null;
            case "keyExportPrivate": {
                String prv = app.store.keyPrivate(a.getString("id"));
                if (prv == null) throw new Exception("Anahtar okunamadı");
                return saveToDownloads(a.getString("name"), "application/octet-stream", prv.getBytes(StandardCharsets.UTF_8));
            }

            // ---- backup
            case "pickTextFile": return pickTextFile(a.optInt("max", 4 << 20));
            // Xshell içe aktarma: dosya seç (.xts / .xsh) -> gerekirse parolaları çöz -> kaydet (core/XshellImport)
            case "xshellPick": {
                List<Uri> uris = act.pickFiles(false);
                if (uris == null || uris.isEmpty()) return null;
                String[] fm = meta(uris.get(0));
                if (Long.parseLong(fm[1]) > (32 << 20)) throw new Exception("Dosya çok büyük");
                byte[] data;
                try (InputStream in = act.getContentResolver().openInputStream(uris.get(0))) { data = readAll(in, 32 << 20); }
                try { xshellPending = dev.melid.core.XshellImport.parse(fm[0], data); }
                catch (Exception e) { throw new Exception("Xshell oturumları okunamadı: " + e.getMessage()); }
                int enc = 0;
                for (JSONObject x : xshellPending) if (x.has("_xsEnc")) enc++;
                return obj("found", xshellPending.size(), "encrypted", enc, "name", fm[0]);
            }
            case "xshellDecrypt": {
                if (xshellPending == null) throw new Exception("Önce dosya seçin");
                return dev.melid.core.XshellImport.applyPasswords(xshellPending, a.optString("user"), a.optString("sid"), a.optString("master"));
            }
            case "xshellSave": {
                if (xshellPending == null) throw new Exception("Önce dosya seçin");
                List<JSONObject> list = xshellPending;
                xshellPending = null;
                java.util.Set<String> existing = new java.util.HashSet<>();
                JSONArray cur = app.store.state().getJSONArray("sessions");
                for (int i = 0; i < cur.length(); i++) { JSONObject x = cur.getJSONObject(i); existing.add(x.optString("name") + "|" + x.optString("host") + "|" + x.optInt("port", 22) + "|" + x.optString("username")); }
                int added = 0, withPw = 0;
                for (JSONObject x : list) {
                    x.remove("_xsEnc"); x.remove("_xsVer");
                    String k = x.optString("name") + "|" + x.optString("host") + "|" + x.optInt("port", 22) + "|" + x.optString("username");
                    if (!existing.add(k)) continue;
                    app.store.saveSession(x);
                    added++;
                    if (x.has("password")) withPw++;
                }
                return obj("added", added, "found", list.size(), "withPassword", withPw);
            }
            case "importBackup": {
                JSONObject bk = new JSONObject(a.getString("text"));
                return app.store.importBackup(bk, a.optString("passphrase", null), a.optBoolean("withSettings", true));
            }
            case "exportBackup": {
                JSONObject bk = app.store.exportBackup(a.optString("passphrase", null));
                String name = "melid-yedek-" + new SimpleDateFormat("yyyy-MM-dd-HHmm", Locale.ROOT).format(new Date()) + ".json";
                return saveToDownloads(name, "application/json", bk.toString(2).getBytes(StandardCharsets.UTF_8));
            }

            // ---- system
            case "clipboardSet": {
                String t = a.getString("text");
                app.main.post(() -> {
                    ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("Melid", t));
                });
                return null;
            }
            case "clipboardGet": return act.clipboardText();
            case "keepScreenOn": app.main.post(() -> act.keepScreenOn(a.optBoolean("on"))); return null;
            case "showKeyboard": app.main.post(act::showKeyboard); return null;
            case "hideKeyboard": app.main.post(act::hideKeyboard); return null;
            case "barColors": app.main.post(() -> act.barColors(a.optString("bg"), a.optBoolean("light"))); return null;
            case "openUrl": { String url = a.getString("url"); app.main.post(() -> act.openUrl(url)); return null; }
            case "notifyPermission": app.main.post(act::askNotificationPermission); return null;
            case "appInfo": return obj("version", act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionName, "android", android.os.Build.VERSION.RELEASE,
                    "conns", app.core.count());
            // ---- güncelleme (Updater.java)
            case "updateState": {
                JSONObject st = Updater.state(act);
                st.put("show", act.showUpdate);
                act.showUpdate = false;
                return st;
            }
            case "updateCheck": Updater.lastCheck = System.currentTimeMillis(); return Updater.check(act);
            case "updateSkip": app.store.saveSettings(obj("updateSkip", a.optString("version"))); return Updater.state(act);
            case "updateCancel": Updater.cancel = true; return null;
            case "updateInstall": {
                java.io.File apk = Updater.download(act, (done, total) -> emit("updateProgress", obj("done", done, "total", total)));
                emit("updateProgress", obj("done", apk.length(), "total", apk.length(), "installing", true));
                if (!Updater.ensureInstallPermission(act))
                    throw new Exception("Melid'in uygulama yükleme izni yok. Açılan ekranda izni verin, sonra tekrar \"Kur\"a dokunun.");
                Updater.install(act, apk);
                return null;
            }
            case "moveToBack": app.main.post(() -> act.moveTaskToBack(true)); return null;
            case "exitApp": app.core.disconnectAll(); app.updateService(); app.main.post(act::finishAndRemoveTask); return null;
            default: throw new Exception("Bilinmeyen çağrı: " + m);
        }
    }

    // ------------------------------------------------------------------ files
    Sftp.Sink downloadSink(String tid) {
        ContentResolver cr = act.getContentResolver();
        Map<String, Uri> open = new ConcurrentHashMap<>();
        return new Sftp.Sink() {
            @Override public OutputStream open(String rel, long size) throws Exception {
                String name = rel.replaceAll("^.*/", "");
                String sub = rel.contains("/") ? "/" + rel.substring(0, rel.lastIndexOf('/')) : "";
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime(name));
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Melid" + sub);
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("İndirilenler klasörüne yazılamadı");
                open.put(rel, uri);
                xferUris.putIfAbsent(tid, uri);
                OutputStream o = cr.openOutputStream(uri);
                if (o == null) throw new Exception("İndirilenler klasörüne yazılamadı");
                return o;
            }

            @Override public void finish(String rel, boolean ok) {
                Uri uri = open.remove(rel);
                if (uri == null) return;
                if (ok) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.IS_PENDING, 0);
                    cr.update(uri, v, null, null);
                } else {
                    cr.delete(uri, null, null);
                    if (uri.equals(xferUris.get(tid))) xferUris.remove(tid);
                }
            }
        };
    }

    static String mime(String name) {
        int i = name.lastIndexOf('.');
        String ext = i < 0 ? "" : name.substring(i + 1).toLowerCase(Locale.ROOT);
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (m != null) return m;
        switch (ext) {
            case "log": case "conf": case "cfg": case "ini": case "sh": case "yml": case "yaml": case "md": case "env": return "text/plain";
            default: return "application/octet-stream";
        }
    }

    void openDownloaded(String tid, String name) throws Exception {
        Uri uri = xferUris.get(tid);
        if (uri == null) throw new Exception("Dosya bulunamadı");
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime(name == null ? "" : name))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            act.startActivity(Intent.createChooser(i, "Birlikte aç").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            throw new Exception("Bu dosyayı açabilecek uygulama yok");
        }
    }

    String saveToDownloads(String name, String mime, byte[] data) throws Exception {
        ContentResolver cr = act.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.DISPLAY_NAME, name);
        v.put(MediaStore.Downloads.MIME_TYPE, mime);
        v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Melid");
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new Exception("İndirilenler klasörüne yazılamadı");
        try (OutputStream o = cr.openOutputStream(uri)) { o.write(data); }
        String shown = name;
        try (Cursor cu = cr.query(uri, new String[]{MediaStore.Downloads.DISPLAY_NAME}, null, null, null)) {
            if (cu != null && cu.moveToFirst()) shown = cu.getString(0);
        }
        return "İndirilenler/Melid/" + shown;
    }

    /** Seçilip henüz kaydedilmemiş Xshell oturumları (parolaları çözülebilir) */
    volatile List<JSONObject> xshellPending;

    static byte[] readAll(InputStream in, int max) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[16384];
        int n;
        while ((n = in.read(b)) > 0) { bo.write(b, 0, n); if (bo.size() > max) throw new Exception("Dosya çok büyük"); }
        return bo.toByteArray();
    }

    JSONObject pickTextFile(int max) throws Exception {
        List<Uri> uris = act.pickFiles(false);
        if (uris == null || uris.isEmpty()) return null;
        Uri u = uris.get(0);
        String[] meta = meta(u);
        if (Long.parseLong(meta[1]) > max) throw new Exception("Dosya çok büyük");
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        try (InputStream in = act.getContentResolver().openInputStream(u)) {
            byte[] b = new byte[16384];
            int n;
            while ((n = in.read(b)) > 0) { bo.write(b, 0, n); if (bo.size() > max) throw new Exception("Dosya çok büyük"); }
        }
        return obj("name", meta[0], "text", bo.toString("UTF-8"));
    }

    String[] meta(Uri u) {
        String name = u.getLastPathSegment();
        long size = -1;
        try (Cursor cu = act.getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cu != null && cu.moveToFirst()) {
                if (!cu.isNull(0)) name = cu.getString(0);
                if (!cu.isNull(1)) size = cu.getLong(1);
            }
        } catch (Exception ignored) { }
        return new String[]{name == null ? "dosya" : name, String.valueOf(size)};
    }

    Object upload(String tid, String c, String dir) throws Exception {
        List<Uri> uris = act.pickFiles(true);
        if (uris == null || uris.isEmpty()) return null;
        List<Sftp.Source> src = new ArrayList<>();
        JSONArray names = new JSONArray();
        for (Uri u : uris) {
            String[] m = meta(u);
            names.put(m[0]);
            src.add(new Sftp.Source() {
                public String name() { return m[0]; }
                public long size() { return Long.parseLong(m[1]); }
                public InputStream open() throws Exception { return act.getContentResolver().openInputStream(u); }
            });
        }
        app.sftp.upload(tid, c, src, dir);
        return names;
    }
}
