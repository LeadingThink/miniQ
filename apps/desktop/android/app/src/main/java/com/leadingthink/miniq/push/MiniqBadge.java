package com.leadingthink.miniq.push;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.HashSet;
import java.util.Set;

/**
 * Launcher badge = number of sessions with an alert the user has not seen yet.
 * Native pushes (MiniqPushNotifier) and local notifications (via the plugin)
 * share this count; the app clears it when it comes to the foreground.
 *
 * Stock launchers derive dots from the visible notifications themselves; the
 * explicit number is applied through JPush's OEM badge API (Huawei, Honor,
 * vivo, OPPO) when the SDK is built in.
 */
final class MiniqBadge {
    private static final String PREFS = "miniq.badge";
    private static final String KEY_SESSIONS = "sessions";
    private static final int LIMIT = 99;

    private MiniqBadge() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized int count(Context context) {
        return prefs(context).getStringSet(KEY_SESSIONS, new HashSet<>()).size();
    }

    /** Records an unseen alert for {@code session} and returns the new count. */
    static synchronized int mark(Context context, String session) {
        Set<String> sessions = new HashSet<>(prefs(context).getStringSet(KEY_SESSIONS, new HashSet<>()));
        if (sessions.size() < LIMIT || sessions.contains(session)) sessions.add(session);
        prefs(context).edit().putStringSet(KEY_SESSIONS, sessions).apply();
        apply(context, sessions.size());
        return sessions.size();
    }

    static synchronized void clear(Context context) {
        prefs(context).edit().remove(KEY_SESSIONS).apply();
        apply(context, 0);
    }

    /** JPush is optional; reflection keeps this compiling without the SDK. */
    private static void apply(Context context, int count) {
        try {
            Class.forName("cn.jpush.android.api.JPushInterface")
                .getMethod("setBadgeNumber", Context.class, int.class)
                .invoke(null, context.getApplicationContext(), count);
        } catch (Exception ignored) {
            // No SDK or unsupported launcher: the notification dot still shows.
        }
    }
}
