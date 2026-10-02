package com.leadingthink.miniq.push;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.json.JSONObject;

/**
 * Native side of src/remotePush.ts on Android:
 *  - setKey / clearKey: relay push key for decrypting payloads natively
 *  - getToken: JPush registration id (only when the :miniq-jpush module is built in)
 *  - notificationOpened: taps and approve/reject buttons on push notifications
 */
@CapacitorPlugin(name = "MiniqPush")
public class MiniqPushPlugin extends Plugin {
    private static final String PREF_TOKEN = "jpush_token";
    private static final long TOKEN_TIMEOUT_MS = 20_000;
    private static final List<PluginCall> pendingTokenCalls = new ArrayList<>();
    private static final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        MiniqPushNotifier.ensureChannels(getContext());
        // Re-arm the SDK on cold start once the user has enabled remote push.
        if (MiniqPushCrypto.prefs(getContext()).contains(PREF_TOKEN)) initJPush(getContext());
        if (getActivity() != null) handleOpenIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleOpenIntent(intent);
    }

    @PluginMethod
    public void setKey(PluginCall call) {
        String key = call.getString("key");
        if (key == null || !MiniqPushCrypto.saveKey(getContext(), key)) {
            call.reject("invalid key");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void clearKey(PluginCall call) {
        MiniqPushCrypto.clearKey(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getToken(PluginCall call) {
        Context context = getContext();
        if (!initJPush(context)) {
            call.unavailable("JPush is not configured in this build");
            return;
        }
        String token = registrationId(context);
        if (token == null || token.isEmpty()) token = MiniqPushCrypto.prefs(context).getString(PREF_TOKEN, null);
        if (token != null && !token.isEmpty()) {
            resolveToken(call, token);
            return;
        }
        // First launch: the registration id arrives later through onRegister.
        call.setKeepAlive(true);
        synchronized (pendingTokenCalls) {
            pendingTokenCalls.add(call);
        }
        main.postDelayed(() -> {
            boolean removed;
            synchronized (pendingTokenCalls) {
                removed = pendingTokenCalls.remove(call);
            }
            if (removed) {
                call.setKeepAlive(false);
                call.reject("JPush registration timed out");
            }
        }, TOKEN_TIMEOUT_MS);
    }

    /** Local notification posted for {@code session}: count it on the launcher badge. */
    @PluginMethod
    public void markBadge(PluginCall call) {
        String session = call.getString("session");
        if (session == null || session.isEmpty()) {
            call.reject("missing session");
            return;
        }
        JSObject result = new JSObject();
        result.put("count", MiniqBadge.mark(getContext(), session));
        call.resolve(result);
    }

    /** The user is looking at miniQ: everything counted so far has been seen. */
    @PluginMethod
    public void clearBadge(PluginCall call) {
        MiniqBadge.clear(getContext());
        JSObject result = new JSObject();
        result.put("count", 0);
        call.resolve(result);
    }

    /** Called by MiniqPushEventReceiver when JPush reports a registration id. */
    static void onToken(Context context, String token) {
        MiniqPushCrypto.prefs(context).edit().putString(PREF_TOKEN, token).apply();
        List<PluginCall> calls;
        synchronized (pendingTokenCalls) {
            calls = new ArrayList<>(pendingTokenCalls);
            pendingTokenCalls.clear();
        }
        for (PluginCall call : calls) {
            call.setKeepAlive(false);
            resolveToken(call, token);
        }
    }

    private static void resolveToken(PluginCall call, String token) {
        JSObject result = new JSObject();
        result.put("platform", "jpush");
        result.put("token", token);
        call.resolve(result);
    }

    private void handleOpenIntent(Intent intent) {
        if (intent == null || !intent.getBooleanExtra(MiniqPushNotifier.EXTRA_OPENED, false)) return;
        JSObject data = new JSObject();
        String actionId = intent.getStringExtra(MiniqPushNotifier.EXTRA_ACTION_ID);
        data.put("actionId", actionId == null ? "tap" : actionId);

        String sessionId = intent.getStringExtra(MiniqPushNotifier.EXTRA_SESSION_ID);
        String approvalId = intent.getStringExtra(MiniqPushNotifier.EXTRA_APPROVAL_ID);
        JSONObject extras = MiniqPushEventReceiver.parse(intent.getStringExtra(MiniqPushNotifier.EXTRA_EXTRAS));
        if (extras != null) {
            // Tapped the SDK's generic notification: keep the raw envelope for JS
            // and decrypt here when the key is available.
            for (Iterator<String> keys = extras.keys(); keys.hasNext(); ) {
                String name = keys.next();
                data.put(name, extras.opt(name));
            }
            if (sessionId == null) {
                MiniqPushText text = MiniqPushNotifier.decryptExtras(getContext(), extras);
                if (text != null) {
                    sessionId = text.sessionId;
                    approvalId = text.approvalId;
                }
            }
        }
        if (sessionId != null) data.put("miniqSessionId", sessionId);
        if (approvalId != null) data.put("miniqApprovalId", approvalId);

        MiniqPushNotifier.cancel(getContext(), intent.getIntExtra(MiniqPushNotifier.EXTRA_NOTIFICATION_ID, 0));
        // Consume once so recreating the activity does not replay the tap.
        intent.removeExtra(MiniqPushNotifier.EXTRA_OPENED);
        notifyListeners("notificationOpened", data, true);
    }

    /** JPush is optional; reflection keeps this file compiling without the SDK. */
    private static boolean initJPush(Context context) {
        try {
            // Privacy consent: only reached after the user enabled remote push in miniQ.
            Class<?> auth = Class.forName("cn.jiguang.api.utils.JCollectionAuth");
            auth.getMethod("setAuth", Context.class, boolean.class).invoke(null, context.getApplicationContext(), true);
        } catch (Exception ignored) {
            // Older SDKs have no consent API.
        }
        try {
            Class<?> jpush = Class.forName("cn.jpush.android.api.JPushInterface");
            jpush.getMethod("init", Context.class).invoke(null, context.getApplicationContext());
            return true;
        } catch (ClassNotFoundException missing) {
            return false;
        } catch (Exception error) {
            return false;
        }
    }

    private static String registrationId(Context context) {
        try {
            Method method = Class.forName("cn.jpush.android.api.JPushInterface").getMethod("getRegistrationID", Context.class);
            Object value = method.invoke(null, context.getApplicationContext());
            return value instanceof String ? (String) value : null;
        } catch (Exception error) {
            return null;
        }
    }
}
