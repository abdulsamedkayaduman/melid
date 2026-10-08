package dev.sshdeck.core;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.Session;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import static dev.sshdeck.core.SshCore.obj;

/** Tüneller: -L (yerel), -R (uzak), -D (SOCKS5). */
public class Forwards {
    final SshCore core;

    public Forwards(SshCore core) { this.core = core; }

    static class Fwd {
        JSONObject fw;
        Session ssh;
        ServerSocket socks;
        final Set<Socket> sockets = Collections.newSetFromMap(new ConcurrentHashMap<>());
        int boundPort;

        void stop() {
            String type = fw.optString("type");
            String bh = fw.optString("bindHost", "127.0.0.1");
            try {
                if (type.equals("L")) ssh.delPortForwardingL(bh, boundPort);
                else if (type.equals("R")) ssh.delPortForwardingR(bh, fw.optInt("bindPort"));
            } catch (Exception ignored) { }
            if (socks != null) try { socks.close(); } catch (IOException ignored) { }
            for (Socket s : sockets) try { s.close(); } catch (IOException ignored) { }
            sockets.clear();
        }
    }

    public JSONObject start(String connId, JSONObject fw) throws Exception {
        SshCore.Conn c = core.get(connId);
        String id = fw.optString("id");
        if (c.fwds.containsKey(id)) return obj("port", c.fwds.get(id).boundPort);
        String type = fw.optString("type", "L");
        String bh = fw.optString("bindHost", "127.0.0.1");
        if (bh.isEmpty()) bh = "127.0.0.1";
        int bp = fw.optInt("bindPort");
        Fwd f = new Fwd();
        f.fw = fw;
        f.ssh = c.ssh;
        try {
            switch (type) {
                case "L":
                    f.boundPort = c.ssh.setPortForwardingL(bh, bp, fw.optString("dstHost"), fw.optInt("dstPort"));
                    break;
                case "R":
                    c.ssh.setPortForwardingR(bh, bp, fw.optString("dstHost", "127.0.0.1"), fw.optInt("dstPort"));
                    f.boundPort = bp;
                    break;
                case "D":
                    f.socks = new ServerSocket();
                    f.socks.setReuseAddress(true);
                    f.socks.bind(new InetSocketAddress(InetAddress.getByName(bh), bp));
                    f.boundPort = f.socks.getLocalPort();
                    Thread t = new Thread(() -> acceptLoop(c, f), "sshdeck-socks");
                    t.setDaemon(true);
                    t.start();
                    break;
                default:
                    throw new Exception("Bilinmeyen tünel türü");
            }
        } catch (Exception e) {
            String m = String.valueOf(e.getMessage());
            if (m.contains("Address already in use") || m.contains("EADDRINUSE")) throw new Exception("Port kullanımda: " + bp);
            if (m.contains("Permission denied") || m.contains("EACCES")) throw new Exception("Bu porta bağlanma izni yok: " + bp + " (1024 üstü bir port seçin)");
            if (type.equals("R")) throw new Exception("Sunucu uzak tüneli reddetti (" + bp + "): " + m);
            throw e;
        }
        c.fwds.put(id, f);
        core.host.emit("fwd", obj("c", connId, "id", id, "state", "on", "port", f.boundPort));
        return obj("port", f.boundPort);
    }

    public void stop(String connId, String id) {
        SshCore.Conn c = core.conns.get(connId);
        if (c == null) return;
        Fwd f = c.fwds.remove(id);
        if (f != null) f.stop();
        core.host.emit("fwd", obj("c", connId, "id", id, "state", "off"));
    }

    public JSONArray active(String connId) {
        JSONArray a = new JSONArray();
        SshCore.Conn c = core.conns.get(connId);
        if (c != null) for (Fwd f : c.fwds.values()) a.put(obj("id", f.fw.optString("id"), "port", f.boundPort));
        return a;
    }

    // ------------------------------------------------------------------ SOCKS5
    void acceptLoop(SshCore.Conn c, Fwd f) {
        while (!f.socks.isClosed()) {
            Socket s;
            try { s = f.socks.accept(); } catch (IOException e) { break; }
            f.sockets.add(s);
            core.pool.execute(() -> {
                try { socks(c, f, s); } catch (Exception ignored) { } finally {
                    f.sockets.remove(s);
                    try { s.close(); } catch (IOException ignored) { }
                }
            });
        }
    }

    static byte[] reply(int code) { return new byte[]{5, (byte) code, 0, 1, 0, 0, 0, 0, 0, 0}; }

    void socks(SshCore.Conn c, Fwd f, Socket s) throws Exception {
        s.setTcpNoDelay(true);
        DataInputStream in = new DataInputStream(s.getInputStream());
        OutputStream out = s.getOutputStream();
        if (in.readUnsignedByte() != 5) return;
        int n = in.readUnsignedByte();
        in.readFully(new byte[n]);
        out.write(new byte[]{5, 0});
        out.flush();
        int ver = in.readUnsignedByte(), cmd = in.readUnsignedByte();
        in.readUnsignedByte();
        int atyp = in.readUnsignedByte();
        if (ver != 5 || cmd != 1) { out.write(reply(7)); return; }
        String host;
        if (atyp == 1) {
            byte[] a = new byte[4];
            in.readFully(a);
            host = (a[0] & 255) + "." + (a[1] & 255) + "." + (a[2] & 255) + "." + (a[3] & 255);
        } else if (atyp == 3) {
            byte[] a = new byte[in.readUnsignedByte()];
            in.readFully(a);
            host = new String(a, StandardCharsets.US_ASCII);
        } else if (atyp == 4) {
            byte[] a = new byte[16];
            in.readFully(a);
            host = InetAddress.getByAddress(a).getHostAddress();
        } else { out.write(reply(8)); return; }
        int port = in.readUnsignedShort();
        Channel ch;
        InputStream chIn;
        OutputStream chOut;
        try {
            ch = c.ssh.getStreamForwarder(host, port);
            chIn = ch.getInputStream();
            chOut = ch.getOutputStream();
            ch.connect(15000);
        } catch (Exception e) {
            out.write(reply(5));
            return;
        }
        out.write(reply(0));
        out.flush();
        Thread up = new Thread(() -> pump(in, chOut), "sshdeck-socks-up");
        up.setDaemon(true);
        up.start();
        pump(chIn, out);
        ch.disconnect();
    }

    static void pump(InputStream in, OutputStream out) {
        byte[] b = new byte[16384];
        try {
            int n;
            while ((n = in.read(b)) > 0) { out.write(b, 0, n); out.flush(); }
        } catch (IOException ignored) { }
        try { out.close(); } catch (IOException ignored) { }
    }
}
