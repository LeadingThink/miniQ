package com.leadingthink.miniq.push;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;

/**
 * Receives events forwarded by the optional :miniq-jpush module (which is
 * only compiled when a JPush app key is configured), so this app compiles and
 * runs without the vendor SDK.
 */
public class MiniqPushEventReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !MiniqPushNotifier.ACTION_EVENT.equals(intent.getAction())) return;
        String event = intent.getStringExtra(MiniqPushNotifier.EXTRA_EVENT);
        if ("register".equals(event)) {
            String token = intent.getStringExtra(MiniqPushNotifier.EXTRA_TOKEN);
            if (token != null && !token.isEmpty()) MiniqPushPlugin.onToken(context, token);
            return;
        }
        if ("arrived".equals(event)) {
            JSONObject extras = parse(intent.getStringExtra(MiniqPushNotifier.EXTRA_EXTRAS));
            int replaced = intent.getIntExtra(MiniqPushNotifier.EXTRA_JPUSH_NOTIFICATION_ID, 0);
            // The SDK already alerted with the generic text; swap in the real text silently.
            MiniqPushNotifier.show(context, extras, replaced, true);
        }
    }

    static JSONObject parse(String json) {
        if (json == null || json.isEmpty()) return null;
        try {
            return new JSONObject(json);
        } catch (Exception error) {
            return null;
        }
    }
}
