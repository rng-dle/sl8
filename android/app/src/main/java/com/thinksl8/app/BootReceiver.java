package com.thinksl8.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Brings the pen shortcut back after a restart, if it was on. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (!c.getSharedPreferences("pen", Context.MODE_PRIVATE).getBoolean("on", false)) return;
        try { c.startForegroundService(new Intent(c, PenWatchService.class)); } catch (Exception ignored) { }
    }
}
