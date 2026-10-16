package com.thinksl8.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Toast;

/**
 * Opened by thinksl8://pen-setup (from the site's pen prompt): asks for the two permissions the pen shortcut needs,
 * starts it, then returns to the site with the outcome (?pen=on or ?pen=declined).
 */
public class PenSetupActivity extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        } else {
            overlay();
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) { overlay(); } // the service still runs if notifications are refused

    private void overlay() {
        if (Settings.canDrawOverlays(this)) done();
        else startActivityForResult(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())), 2);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) { done(); }

    private void done() {
        boolean on = Settings.canDrawOverlays(this);
        if (on) {
            try {
                getSharedPreferences("pen", MODE_PRIVATE).edit().putBoolean("on", true).apply();
                startForegroundService(new Intent(this, PenWatchService.class));
            } catch (Exception e) {
                on = false;
                Toast.makeText(this, "Pen shortcut failed: " + e, Toast.LENGTH_LONG).show(); // so a crash is visible, not silent
            }
        }
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://thinksl8.com/canvases?pen=" + (on ? "on" : "declined"))).setPackage(getPackageName()));
        finish();
    }
}
