package com.carecall.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createAlertChannel();
    }

    private void createAlertChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager mgr = getSystemService(NotificationManager.class);
        if (mgr == null) return;

        NotificationChannel alerts = new NotificationChannel(
                "carecall_alerts",
                "Care Alerts",
                NotificationManager.IMPORTANCE_HIGH
        );
        alerts.setDescription("Incoming patient calls and emergencies");
        alerts.enableVibration(true);
        alerts.setVibrationPattern(new long[]{0, 500, 150, 500, 150, 800});
        alerts.enableLights(true);
        alerts.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        mgr.createNotificationChannel(alerts);

        NotificationChannel reminders = new NotificationChannel(
                "carecall_reminders",
                "Reminders",
                NotificationManager.IMPORTANCE_DEFAULT
        );
        reminders.setDescription("Medication reminders and scheduled check-ins");
        reminders.enableVibration(true);
        mgr.createNotificationChannel(reminders);
    }
}
