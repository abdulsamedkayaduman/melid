package dev.sshdeck.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/** Açık SSH bağlantısı varken uygulama arka plandayken de yaşasın diye ön plan servisi. */
public class SshService extends Service {
    static volatile boolean running;
    static volatile SshService instance;
    static final String CHANNEL = "conns";
    static final int ID = 1;
    static final String ACTION_STOP = "dev.sshdeck.app.STOP_ALL";

    PowerManager.WakeLock wake;
    WifiManager.WifiLock wifi;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            App.I.core.disconnectAll();
            App.I.emit("allClosed", new org.json.JSONObject());
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        instance = this;
        int n = intent == null ? App.I.core.count() : intent.getIntExtra("count", App.I.core.count());
        Notification nf = build(n);
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID, nf, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(ID, nf);
        applyLocks(App.I.store.settings.optBoolean("wakeLock", false));
        return START_NOT_STICKY;
    }

    void applyLocks(boolean on) {
        if (on && wake == null) {
            wake = ((PowerManager) getSystemService(Context.POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sshdeck:conns");
            wake.acquire();
            wifi = ((WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE))
                    .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "sshdeck:conns");
            wifi.acquire();
        } else if (!on) releaseLocks();
    }

    void releaseLocks() {
        if (wake != null && wake.isHeld()) wake.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        wake = null;
        wifi = null;
    }

    Notification build(int n) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Açık bağlantılar", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("SSH bağlantıları açıkken gösterilir");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pOpen = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, SshService.class).setAction(ACTION_STOP);
        PendingIntent pStop = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("SSHDeck")
                .setContentText(n == 1 ? "1 bağlantı açık" : n + " bağlantı açık")
                .setContentIntent(pOpen)
                .setOngoing(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(null, "Tümünü kapat", pStop).build())
                .build();
    }

    /** Servis zaten ön plandayken bildirimi güncelle (arka plandan startForegroundService çağırmadan). */
    void refresh(int n) {
        getSystemService(NotificationManager.class).notify(ID, build(n));
        applyLocks(App.I.store.settings.optBoolean("wakeLock", false));
    }

    /** Kullanıcı uygulamayı son uygulamalardan kaydırdı: arayüz gitti, bağlantıları kapat. */
    @Override public void onTaskRemoved(Intent rootIntent) {
        App.I.core.disconnectAll();
        stopSelf();
    }

    @Override public void onDestroy() {
        running = false;
        instance = null;
        releaseLocks();
        super.onDestroy();
    }

    @Override public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }
}
