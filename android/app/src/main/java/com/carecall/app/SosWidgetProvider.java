package com.carecall.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

/**
 * 1×1 home-screen widget that launches CareCall with carecall://sos
 * deep link. The web app detects this and immediately fires a call
 * to the patient's carer — one tap from any screen.
 *
 * onUpdate runs on periodic refresh (every 30 min) and after boot,
 * re-establishing the PendingIntent so the widget stays clickable.
 */
public class SosWidgetProvider extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            updateWidget(context, manager, id);
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        // Re-bind on boot or package replaced — keeps the widget alive
        // after reboot or app update.
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) ||
            Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            AppWidgetManager mgr = AppWidgetManager.getInstance(context);
            int[] ids = mgr.getAppWidgetIds(
                new ComponentName(context, SosWidgetProvider.class));
            if (ids != null && ids.length > 0) {
                onUpdate(context, mgr, ids);
            }
        }
    }

    private void updateWidget(Context context, AppWidgetManager manager, int id) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_sos);

        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("carecall://sos"));
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent pending = PendingIntent.getActivity(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // Make the entire widget tappable
        views.setOnClickPendingIntent(R.id.widget_icon, pending);
        views.setOnClickPendingIntent(R.id.widget_label, pending);

        manager.updateAppWidget(id, views);
    }
}
