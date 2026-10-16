package com.thinksl8.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.PixelFormat;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.text.format.DateFormat;
import android.view.View;
import android.view.WindowManager;

/**
 * Runs in the background while the pen shortcut is on: when Samsung announces the S Pen came out, opens ThinkSL8.
 * The notification doubles as a diagnostic (last removal seen, and whether the launch worked) and has a Turn off button.
 */
public class PenWatchService extends Service {
    static final String PEN_INSERT = "com.samsung.pen.INSERT"; // extra "penInsert": true = pen is in its slot
    static final String STOP = "com.thinksl8.app.STOP";
    private View dot; // Android 15+ only lets a background app open screens while it has a window showing: a 1px invisible one

    private final BroadcastReceiver pen = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            if (i.getBooleanExtra("penInsert", true)) return;
            String result = "opened ThinkSL8";
            try {
                startActivity(getPackageManager().getLaunchIntentForPackage(getPackageName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception e) {
                result = "could not open (" + e.getClass().getSimpleName() + ")";
            }
            show("Pen removed at " + DateFormat.format("HH:mm:ss", System.currentTimeMillis()) + ": " + result);
        }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            getSharedPreferences("pen", MODE_PRIVATE).edit().putBoolean("on", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("pen", "Pen shortcut", NotificationManager.IMPORTANCE_LOW));
        Notification n = build("Waiting for the pen to come out");
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, n);
        IntentFilter f = new IntentFilter(PEN_INSERT);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(pen, f, Context.RECEIVER_EXPORTED);
        else registerReceiver(pen, f);
        if (dot == null && Settings.canDrawOverlays(this)) {
            try {
                dot = new View(this);
                getSystemService(WindowManager.class).addView(dot, new WindowManager.LayoutParams(1, 1,
                        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
                        PixelFormat.TRANSLUCENT));
            } catch (Exception e) {
                dot = null;
            }
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        try { unregisterReceiver(pen); } catch (Exception ignored) { }
        if (dot != null) try { getSystemService(WindowManager.class).removeView(dot); } catch (Exception ignored) { }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void show(String text) { getSystemService(NotificationManager.class).notify(1, build(text)); }

    private Notification build(String text) {
        PendingIntent off = PendingIntent.getService(this, 0, new Intent(this, PenWatchService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, "pen")
                .setSmallIcon(android.R.drawable.ic_menu_edit)
                .setContentTitle("ThinkSL8 pen shortcut is on")
                .setContentText(text)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel), "Turn off", off).build())
                .build();
    }
}
