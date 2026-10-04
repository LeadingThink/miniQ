package com.leadingthink.miniq;

import android.content.Context;
import android.os.PowerManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MiniqPower")
public class MiniqPowerPlugin extends Plugin {
    @PluginMethod
    public void getState(PluginCall call) {
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        if (power == null) {
            call.unavailable("PowerManager unavailable");
            return;
        }
        JSObject result = new JSObject();
        result.put("lowPower", power.isPowerSaveMode());
        call.resolve(result);
    }
}
