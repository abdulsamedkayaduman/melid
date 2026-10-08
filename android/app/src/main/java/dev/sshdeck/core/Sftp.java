package dev.sshdeck.core;

import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.SftpATTRS;
import com.jcraft.jsch.SftpException;
import com.jcraft.jsch.SftpProgressMonitor;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Vector;
import java.util.concurrent.ConcurrentHashMap;

import static dev.sshdeck.core.SshCore.obj;

/** SFTP: gezinme (bağlantı başına tek paylaşılan kanal) ve aktarımlar (her aktarım kendi kanalında). */
public class Sftp {
    final SshCore core;
    final Map<String, Xfer> xfers = new ConcurrentHashMap<>();

    public Sftp(SshCore core) { this.core = core; }

    /** İndirilen dosyaların yazılacağı yer (Android: İndirilenler/SSHDeck). */
    public interface Sink {
        OutputStream open(String relPath, long size) throws Exception;
        /** Dosya bitti (ok=false: yarım kaldı, silinmeli). */
        void finish(String relPath, boolean ok);
    }

    /** Yüklenecek dosya. */
    public interface Source {
        String name();
        long size();
        InputStream open() throws Exception;
    }

    static class Xfer {
        final String id;
        volatile boolean cancelled;
        volatile ChannelSftp ch;
        Xfer(String id) { this.id = id; }
    }

    // ------------------------------------------------------------------ shared channel
    interface SftpOp<T> { T run(ChannelSftp s) throws Exception; }

    <T> T with(String connId, SftpOp<T> op) throws Exception {
        SshCore.Conn c = core.get(connId);
        synchronized (c.sftpLock) {
            for (int attempt = 0; ; attempt++) {
                if (c.sftp == null || !c.sftp.isConnected()) {
                    ChannelSftp ch = (ChannelSftp) c.ssh.openChannel("sftp");
                    ch.connect(15000);
                    try { ch.setFilenameEncoding(StandardCharsets.UTF_8); } catch (Exception ignored) { }
                    c.sftp = ch;
                }
                try {
                    return op.run(c.sftp);
                } catch (SftpException e) {
                    throw friendly(e);
                } catch (Exception e) {
                    // kanal kapanmış olabilir: bir kez yeniden aç
                    if (attempt == 0 && c.sftp != null && !c.sftp.isConnected() && c.ssh.isConnected()) { c.sftp = null; continue; }
                    throw e;
                }
            }
        }
    }

    static Exception friendly(SftpException e) {
        switch (e.id) {
            case ChannelSftp.SSH_FX_NO_SUCH_FILE: return new Exception("Dosya ya da klasör bulunamadı");
            case ChannelSftp.SSH_FX_PERMISSION_DENIED: return new Exception("İzin reddedildi");
            case ChannelSftp.SSH_FX_FAILURE: return new Exception("İşlem başarısız" + (e.getMessage() != null && !e.getMessage().equals("Failure") ? ": " + e.getMessage() : ""));
            default: return new Exception(e.getMessage() == null ? "SFTP hatası" : e.getMessage());
        }
    }

    public String home(String connId) throws Exception {
        return with(connId, s -> s.getHome());
    }

    public String realpath(String connId, String p) throws Exception {
        return with(connId, s -> s.realpath(p));
    }

    static String join(String dir, String name) {
        return dir.endsWith("/") ? dir + name : dir + "/" + name;
    }

    static JSONObject entry(String name, SftpATTRS a) {
        String type = a.isDir() ? "d" : a.isLink() ? "l" : "f";
        return obj("name", name, "type", type, "size", a.getSize(), "mtime", (long) a.getMTime() * 1000L,
                "perm", a.getPermissionsString(), "mode", a.getPermissions() & 07777, "uid", a.getUId(), "gid", a.getGId());
    }

    public JSONObject list(String connId, String path) throws Exception {
        return with(connId, s -> {
            String p = path == null || path.isEmpty() ? s.getHome() : s.realpath(path);
            @SuppressWarnings("unchecked")
            Vector<ChannelSftp.LsEntry> v = s.ls(p);
            JSONArray arr = new JSONArray();
            for (ChannelSftp.LsEntry e : v) {
                String n = e.getFilename();
                if (n.equals(".") || n.equals("..")) continue;
                JSONObject o = entry(n, e.getAttrs());
                if (e.getAttrs().isLink()) {
                    try {
                        SftpATTRS t = s.stat(join(p, n));
                        o.put("linkDir", t.isDir());
                        if (!t.isDir()) o.put("size", t.getSize());
                    } catch (Exception ignored) { o.put("broken", true); }
                }
                arr.put(o);
            }
            return obj("path", p, "entries", arr);
        });
    }

    public JSONObject stat(String connId, String path) throws Exception {
        return with(connId, s -> entry(path.replaceAll("^.*/", ""), s.stat(path)));
    }

    public void mkdir(String connId, String path) throws Exception {
        with(connId, s -> { s.mkdir(path); return null; });
    }

    public void rename(String connId, String from, String to) throws Exception {
        with(connId, s -> { s.rename(from, to); return null; });
    }

    public void chmod(String connId, String path, int mode) throws Exception {
        with(connId, s -> { s.chmod(mode, path); return null; });
    }

    public void remove(String connId, String path) throws Exception {
        with(connId, s -> { rmrf(s, path); return null; });
    }

    static void rmrf(ChannelSftp s, String path) throws SftpException {
        SftpATTRS a = s.lstat(path);
        if (a.isDir()) {
            @SuppressWarnings("unchecked")
            Vector<ChannelSftp.LsEntry> v = s.ls(path);
            for (ChannelSftp.LsEntry e : v) {
                String n = e.getFilename();
                if (n.equals(".") || n.equals("..")) continue;
                rmrf(s, join(path, n));
            }
            s.rmdir(path);
        } else {
            s.rm(path);
        }
    }

    /** Küçük dosyayı oku: metinse {text}, değilse {binary:true, base64?}. */
    public JSONObject read(String connId, String path, int maxBytes, boolean wantBase64) throws Exception {
        return with(connId, s -> {
            SftpATTRS a = s.stat(path);
            if (a.getSize() > maxBytes) return obj("tooLarge", true, "size", a.getSize());
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            try (InputStream in = s.get(path)) {
                byte[] b = new byte[32768];
                int n;
                while ((n = in.read(b)) > 0) {
                    bo.write(b, 0, n);
                    if (bo.size() > maxBytes) return obj("tooLarge", true, "size", (long) bo.size());
                }
            }
            byte[] data = bo.toByteArray();
            boolean bin = false;
            for (int i = 0; i < Math.min(data.length, 8000); i++) if (data[i] == 0) { bin = true; break; }
            JSONObject o = obj("size", (long) data.length, "binary", bin);
            if (!bin) o.put("text", new String(data, StandardCharsets.UTF_8));
            if (wantBase64) o.put("base64", Base64.getEncoder().encodeToString(data));
            return o;
        });
    }

    public void writeText(String connId, String path, String text) throws Exception {
        byte[] b = text.getBytes(StandardCharsets.UTF_8);
        with(connId, s -> {
            try (OutputStream o = s.put(path, ChannelSftp.OVERWRITE)) { o.write(b); }
            return null;
        });
    }

    // ------------------------------------------------------------------ transfers
    public void cancel(String tid) {
        Xfer x = xfers.get(tid);
        if (x == null) return;
        x.cancelled = true;
        ChannelSftp ch = x.ch;
        if (ch != null) ch.disconnect();
    }

    ChannelSftp openXferChannel(SshCore.Conn c) throws Exception {
        ChannelSftp ch = (ChannelSftp) c.ssh.openChannel("sftp");
        ch.connect(15000);
        try { ch.setFilenameEncoding(StandardCharsets.UTF_8); } catch (Exception ignored) { }
        return ch;
    }

    class Progress implements SftpProgressMonitor {
        final Xfer x;
        final long total;
        long base;
        long done;
        long lastEmit;
        String file;

        Progress(Xfer x, long total) { this.x = x; this.total = total; }

        @Override public void init(int op, String src, String dest, long max) { }

        @Override public boolean count(long n) {
            done += n;
            long now = System.currentTimeMillis();
            if (now - lastEmit > 250) { lastEmit = now; emit("run", null); }
            return !x.cancelled;
        }

        @Override public void end() { }

        void emit(String state, String message) {
            JSONObject o = obj("id", x.id, "state", state, "done", base + done, "total", total, "file", file);
            if (message != null) try { o.put("message", message); } catch (Exception ignored) { }
            core.host.emit("xfer", o);
        }
    }

    static class Item {
        final String remote, rel;
        final long size;
        Item(String remote, String rel, long size) { this.remote = remote; this.rel = rel; this.size = size; }
    }

    void walk(ChannelSftp s, String remote, String rel, List<Item> out, Xfer x) throws Exception {
        if (x.cancelled) throw new SshCore.CancelledException();
        @SuppressWarnings("unchecked")
        Vector<ChannelSftp.LsEntry> v = s.ls(remote);
        for (ChannelSftp.LsEntry e : v) {
            String n = e.getFilename();
            if (n.equals(".") || n.equals("..")) continue;
            SftpATTRS a = e.getAttrs();
            String r = join(remote, n);
            if (a.isLink()) { try { a = s.stat(r); } catch (Exception ignored) { continue; } }
            if (a.isDir()) walk(s, r, rel + "/" + n, out, x);
            else out.add(new Item(r, rel + "/" + n, a.getSize()));
        }
    }

    /** Uzak dosya/klasörü sink'e indir. Arka planda çalışır, ilerleme "xfer" olaylarıyla gelir. */
    public void download(String tid, String connId, String remotePath, Sink sink) throws Exception {
        SshCore.Conn c = core.get(connId);
        Xfer x = new Xfer(tid);
        xfers.put(tid, x);
        core.pool.execute(() -> {
            Progress pr = null;
            String curRel = null;
            boolean curOpen = false;
            try {
                x.ch = openXferChannel(c);
                if (x.cancelled) throw new SshCore.CancelledException();
                ChannelSftp s = x.ch;
                SftpATTRS a = s.stat(remotePath);
                String name = remotePath.replaceAll("/+$", "").replaceAll("^.*/", "");
                List<Item> items = new ArrayList<>();
                if (a.isDir()) walk(s, remotePath, name, items, x);
                else items.add(new Item(remotePath, name, a.getSize()));
                long total = 0;
                for (Item it : items) total += it.size;
                pr = new Progress(x, total);
                for (Item it : items) {
                    if (x.cancelled) throw new SshCore.CancelledException();
                    pr.file = it.rel;
                    curRel = it.rel;
                    try (OutputStream o = sink.open(it.rel, it.size)) {
                        curOpen = true;
                        s.get(it.remote, o, pr);
                    }
                    if (x.cancelled) throw new SshCore.CancelledException();
                    sink.finish(it.rel, true);
                    curOpen = false;
                    pr.base += pr.done;
                    pr.done = 0;
                }
                pr.emit("done", items.size() + " dosya");
            } catch (Exception e) {
                if (curOpen && curRel != null) sink.finish(curRel, false);
                failed(x, pr, e);
            } finally {
                xfers.remove(tid);
                if (x.ch != null) x.ch.disconnect();
            }
        });
    }

    /** Dosyaları uzak klasöre yükle. */
    public void upload(String tid, String connId, List<Source> sources, String remoteDir) throws Exception {
        SshCore.Conn c = core.get(connId);
        Xfer x = new Xfer(tid);
        xfers.put(tid, x);
        core.pool.execute(() -> {
            Progress pr = null;
            try {
                x.ch = openXferChannel(c);
                ChannelSftp s = x.ch;
                long total = 0;
                for (Source src : sources) total += Math.max(0, src.size());
                pr = new Progress(x, total);
                for (Source src : sources) {
                    if (x.cancelled) throw new SshCore.CancelledException();
                    pr.file = src.name();
                    try (InputStream in = src.open()) {
                        s.put(in, join(remoteDir, src.name()), pr, ChannelSftp.OVERWRITE);
                    }
                    if (x.cancelled) throw new SshCore.CancelledException();
                    pr.base += pr.done;
                    pr.done = 0;
                }
                pr.emit("done", sources.size() + " dosya");
            } catch (Exception e) {
                failed(x, pr, e);
            } finally {
                xfers.remove(tid);
                if (x.ch != null) x.ch.disconnect();
            }
        });
    }

    void failed(Xfer x, Progress pr, Exception e) {
        Progress p = pr != null ? pr : new Progress(x, 0);
        if (x.cancelled || e instanceof SshCore.CancelledException) p.emit("cancelled", "İptal edildi");
        else if (e instanceof SftpException) p.emit("error", friendly((SftpException) e).getMessage());
        else p.emit("error", e.getMessage() == null ? e.toString() : e.getMessage());
    }
}
