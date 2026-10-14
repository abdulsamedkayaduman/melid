package dev.sshdeck.app;

import android.app.Application;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import dev.sshdeck.core.Forwards;
import dev.sshdeck.core.Host;
import dev.sshdeck.core.Sftp;
import dev.sshdeck.core.SshCore;

/**
 * Süreç boyunca yaşayan nesneler: veri deposu ve SSH çekirdeği. Bağlantılar Activity'den bağımsızdır;
 * SshService (ön plan servisi) açık bağlantı varken sürecin öldürülmesini engeller.
 */
public class App extends Application implements Host {
    static App I;

    Store store;
    SshCore core;
    Sftp sftp;
    Forwards fwd;
    AccountSync sync;
    volatile Bridge bridge;
    final Handler main = new Handler(Looper.getMainLooper());

    final AtomicLong askSeq = new AtomicLong();
    final Map<String, ArrayBlockingQueue<JSONObject>> asks = new ConcurrentHashMap<>();
    static final JSONObject CANCEL = new JSONObject();

    @Override public void onCreate() {
        super.onCreate();
        I = this;
        store = new Store(this);
        core = new SshCore(this);
        sftp = new Sftp(core);
        fwd = new Forwards(core);
        String ver = "?";
        try { ver = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) { }
        sync = new AccountSync(this, ver);
        sync.start();
        watchNetwork();
        try { Updater.schedule(this); } catch (Exception ignored) { }
    }

    /** Varsayılan ağ değişince açık bağlantıları yokla (ölü TCP'yi keepalive'ı beklemeden yakala). */
    void watchNetwork() {
        try {
            android.net.ConnectivityManager cm = getSystemService(android.net.ConnectivityManager.class);
            cm.registerDefaultNetworkCallback(new android.net.ConnectivityManager.NetworkCallback() {
                android.net.Network last;

                @Override public void onAvailable(android.net.Network n) {
                    if (last != null && !n.equals(last)) core.probeAll(8000);
                    last = n;
                    main.postDelayed(sync::maybeSync, 3000);
                }
            });
        } catch (Exception ignored) { }
    }

    // ------------------------------------------------------------------ Host
    @Override public void emit(String type, JSONObject data) {
        Bridge b = bridge;
        if (b != null) b.emit(type, data);
        if (type.equals("closed")) updateService();
    }

    @Override public JSONObject ask(String kind, JSONObject payload) throws InterruptedException {
        Bridge b = bridge;
        if (b == null) return null;
        String id = "a" + askSeq.incrementAndGet();
        ArrayBlockingQueue<JSONObject> q = new ArrayBlockingQueue<>(1);
        asks.put(id, q);
        try {
            payload.put("askId", id);
            payload.put("kind", kind);
            b.emit("ask", payload);
            // kullanıcı uzun süre yanıt vermezse (10 dk) vazgeçilmiş say
            JSONObject r = q.poll(10, TimeUnit.MINUTES);
            return r == null || r == CANCEL ? null : r;
        } catch (org.json.JSONException e) {
            return null;
        } finally {
            asks.remove(id);
        }
    }

    void answer(String askId, JSONObject value) {
        ArrayBlockingQueue<JSONObject> q = asks.get(askId);
        if (q != null) q.offer(value == null ? CANCEL : value);
    }

    /** Arayüz yeniden yüklendiğinde bekleyen soruları iptal et. */
    void cancelAsks() {
        for (ArrayBlockingQueue<JSONObject> q : asks.values()) q.offer(CANCEL);
    }

    @Override public JSONObject resolveSession(String id) { return store.resolveSession(id); }
    @Override public JSONObject getKnownHost(String hp) { return store.getKnownHost(hp); }
    @Override public void putKnownHost(String hp, JSONObject e) { store.putKnownHost(hp, e); }
    @Override public void saveCredentials(String id, JSONObject c) {
        store.saveCredentials(id, c);
        Bridge b = bridge;
        if (b != null) b.emit("stateChanged", new JSONObject());
    }
    @Override public List<JSONObject> privateKeys() { return store.privateKeys(); }

    // ------------------------------------------------------------------ service
    void updateService() {
        main.post(() -> {
            int n = core.count();
            Intent i = new Intent(this, SshService.class);
            SshService svc = SshService.instance;
            if (n > 0 && svc != null) {
                svc.refresh(n);
            } else if (n > 0) {
                i.putExtra("count", n);
                try { startForegroundService(i); } catch (Exception ignored) { }
            } else if (SshService.running) {
                stopService(i);
            }
        });
    }
}
