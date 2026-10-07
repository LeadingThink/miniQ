package com.leadingthink.miniq.background;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** JS bridge for MiniqBackgroundService (src/backgroundConnection.ts). */
@CapacitorPlugin(name = "MiniqBackground")
public class MiniqBackgroundPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        MiniqBackgroundService.start(getContext(), result -> resolveStatus(call, result));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        MiniqBackgroundService.stop(getContext(), () -> call.resolve());
    }

    @PluginMethod
    public void status(PluginCall call) {
        MiniqBackgroundService.status(getContext(), result -> resolveStatus(call, result));
    }

    private static void resolveStatus(PluginCall call, MiniqBackgroundService.Status status) {
        JSObject result = new JSObject();
        result.put("running", status.running);
        result.put("notificationsEnabled", status.notificationsEnabled);
        if (status.error != null) result.put("error", status.error);
        call.resolve(result);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Context context = getContext();
        getActivity().runOnUiThread(() -> {
            Intent settings;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                MiniqBackgroundService.ensureChannel(context);
                if (androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()) {
                    settings = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName())
                        .putExtra(Settings.EXTRA_CHANNEL_ID, MiniqBackgroundService.CHANNEL_ID);
                } else {
                    settings = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
                }
            } else {
                settings = new Intent("android.settings.APP_NOTIFICATION_SETTINGS")
                    .putExtra("app_package", context.getPackageName())
                    .putExtra("app_uid", context.getApplicationInfo().uid);
            }
            try {
                getActivity().startActivity(settings);
                call.resolve();
            } catch (ActivityNotFoundException | SecurityException unavailable) {
                try {
                    getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + context.getPackageName())));
                    call.resolve();
                } catch (ActivityNotFoundException | SecurityException refused) {
                    call.reject("无法打开通知设置");
                }
            }
        });
    }

    @PluginMethod
    public void batteryStatus(PluginCall call) {
        Context context = getContext();
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        JSObject result = new JSObject();
        result.put("unrestricted", power == null || power.isIgnoringBatteryOptimizations(context.getPackageName()));
        call.resolve(result);
    }

    /** Opens the system screen where the user can exempt miniQ from battery optimization. */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        Context context = getContext();
        Intent app = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
        Intent[] candidates = {
            new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            app,
        };
        for (Intent intent : candidates) {
            try {
                getActivity().startActivity(intent);
                call.resolve();
                return;
            } catch (ActivityNotFoundException | SecurityException ignored) {
                // try the next screen
            }
        }
        call.reject("无法打开系统设置");
    }
}
