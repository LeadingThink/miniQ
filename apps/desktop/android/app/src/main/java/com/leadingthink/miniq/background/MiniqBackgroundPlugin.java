package com.leadingthink.miniq.background;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
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
        JSObject result = new JSObject();
        result.put("running", MiniqBackgroundService.start(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        MiniqBackgroundService.stop(getContext());
        call.resolve();
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
