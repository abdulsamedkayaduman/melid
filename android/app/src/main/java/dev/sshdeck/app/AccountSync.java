package dev.sshdeck.app;

import android.os.Build;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import dev.sshdeck.core.SyncCore;

/**
 * Hesap eşitlemesinin zamanlaması (masaüstü sync.js ile aynı kurallar): açılışta, yerel bir değişiklikten 2 sn sonra,
 * 5 dakikada bir, uygulamaya dönünce (en fazla 30 sn'de bir) ve ağ değişince. Protokol: core/SyncCore.
 * Olaylar: "account" (durum), eşitleme yerel veriyi değiştirince "stateChanged".
 */
class AccountSync {
    static final long INTERVAL = 5 * 60000, DEBOUNCE = 2000;

    final App app;
    final SyncCore.Client client;
    final ExecutorService exec = Executors.newSingleThreadExecutor();
    final Runnable tick = this::periodic;
    final Runnable debounced = () -> syncAsync();

    AccountSync(App app, String version) {
        this.app = app;
        client = new SyncCore.Client(app.store, "SSHDeck " + version + " Android " + Build.VERSION.RELEASE);
        client.onStatus = () -> app.emit("account", status());
        app.store.onChange = this::schedule;
    }

    /** Hesap durumu + bu cihazda anahtar eşitlemesi açık mı */
    JSONObject status() {
        JSONObject st = client.status();
        try { st.put("syncKeys", app.store.syncKeys()); } catch (Exception ignored) { }
        return st;
    }

    boolean loggedIn() { return app.store.account() != null; }

    void start() {
        app.main.removeCallbacks(tick);
        if (!loggedIn()) return;
        app.main.postDelayed(tick, INTERVAL);
        syncAsync();
    }

    void periodic() {
        if (!loggedIn()) return;
        syncAsync();
        app.main.postDelayed(tick, INTERVAL);
    }

    void schedule() {
        if (!loggedIn()) return;
        app.main.removeCallbacks(debounced);
        app.main.postDelayed(debounced, DEBOUNCE);
    }

    /** Uygulamaya dönünce / ağ değişince: son eşitleme 30 sn'den eskiyse */
    void maybeSync() {
        JSONObject a = app.store.account();
        if (a != null && System.currentTimeMillis() - a.optLong("lastSync") > 30000) syncAsync();
    }

    void syncAsync() {
        exec.execute(() -> {
            try { run(); } catch (Exception ignored) { /* durum client.state/error'da, arayüze "account" olayıyla gider */ }
        });
    }

    /** Eşitler; yerel veri değiştiyse arayüze bildirir. Hata fırlatır (elle "Şimdi eşitle" için). */
    JSONObject run() throws Exception {
        if (client.syncNow()) app.emit("stateChanged", new JSONObject());
        return status();
    }

    /** Giriş/hesap açma ilk eşitlemeyi kendisi yapar; burada yalnız arayüz tazelenir ve zamanlayıcı kurulur */
    void afterLogin() {
        if (!loggedIn()) return;
        app.emit("stateChanged", new JSONObject());
        app.main.removeCallbacks(tick);
        app.main.postDelayed(tick, INTERVAL);
    }

    void stop() {
        app.main.removeCallbacks(tick);
        app.main.removeCallbacks(debounced);
    }
}
