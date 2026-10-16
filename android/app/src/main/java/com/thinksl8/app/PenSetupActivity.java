package com.thinksl8.app;

import android.app.Activity;
import android.app.role.RoleManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

/** Opened by https://thinksl8.com/app/pen-setup: asks Android to make ThinkSL8 the notes app, then returns to the site with the outcome. */
public class PenSetupActivity extends Activity {
    private static final String NOTES = "android.app.role.NOTES"; // RoleManager.ROLE_NOTES, Android 14+

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT < 34) {
            back("unsupported");
            return;
        }
        RoleManager rm = getSystemService(RoleManager.class);
        if (!rm.isRoleAvailable(NOTES)) back("unsupported");
        else if (rm.isRoleHeld(NOTES)) back("held");
        else startActivityForResult(rm.createRequestRoleIntent(NOTES), 1);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        back(result == RESULT_OK ? "held" : "declined");
    }

    private void back(String state) {
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://thinksl8.com/canvases?pen=" + state)).setPackage(getPackageName()));
        finish();
    }
}
