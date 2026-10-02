package com.leadingthink.miniq.jpush;

import android.content.Context;
import android.content.Intent;
import cn.jpush.android.api.CustomMessage;
import cn.jpush.android.api.NotificationMessage;
import cn.jpush.android.service.JPushMessageReceiver;

/**
 * Bridges JPush callbacks to the app module through an explicit,
 * package-scoped broadcast handled by
 * com.leadingthink.miniq.push.MiniqPushEventReceiver. This module cannot
 * depend on the app module, so the contract is a set of string constants that
 * must match MiniqPushNotifier.
 */
public class MiniqJPushReceiver extends JPushMessageReceiver {
    private static final String ACTION_EVENT = "com.leadingthink.miniq.push.EVENT";
    private static final String EVENT_RECEIVER = "com.leadingthink.miniq.push.MiniqPushEventReceiver";
    private static final String EXTRA_EVENT = "miniq.event";
    private static final String EXTRA_EXTRAS = "miniq.extras";
    private static final String EXTRA_JPUSH_NOTIFICATION_ID = "miniq.jpushNotificationId";
    private static final String EXTRA_TOKEN = "miniq.token";
    private static final String EXTRA_OPENED = "miniq.opened";
    private static final String EXTRA_ACTION_ID = "miniq.actionId";

    @Override
    public void onRegister(Context context, String registrationId) {
        if (registrationId == null || registrationId.isEmpty()) return;
        context.sendBroadcast(event(context, "register").putExtra(EXTRA_TOKEN, registrationId));
    }

    /**
     * The SDK just showed the relay's generic notification (fallback text).
     * The app replaces it with the decrypted conversation text when the key
     * is available; otherwise the generic one stays.
     */
    @Override
    public void onNotifyMessageArrived(Context context, NotificationMessage message) {
        if (message == null) return;
        context.sendBroadcast(event(context, "arrived")
            .putExtra(EXTRA_EXTRAS, message.notificationExtras)
            .putExtra(EXTRA_JPUSH_NOTIFICATION_ID, message.notificationId));
    }

    /** Tapped the generic notification (decryption was not possible). */
    @Override
    public void onNotifyMessageOpened(Context context, NotificationMessage message) {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) return;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_OPENED, true)
            .putExtra(EXTRA_ACTION_ID, "tap");
        if (message != null) launch.putExtra(EXTRA_EXTRAS, message.notificationExtras);
        context.startActivity(launch);
    }

    /**
     * Custom (pass-through) messages carry the same encrypted extras but are
     * intentionally not displayed: the notification part of the same push
     * already alerts, and showing both would ring twice.
     */
    @Override
    public void onMessage(Context context, CustomMessage message) {}

    private static Intent event(Context context, String name) {
        return new Intent(ACTION_EVENT)
            .setClassName(context.getPackageName(), EVENT_RECEIVER)
            .putExtra(EXTRA_EVENT, name);
    }
}
