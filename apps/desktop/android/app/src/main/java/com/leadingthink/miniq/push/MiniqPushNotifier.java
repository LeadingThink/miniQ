package com.leadingthink.miniq.push;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.leadingthink.miniq.MainActivity;
import com.leadingthink.miniq.R;
import javax.crypto.SecretKey;
import org.json.JSONObject;

/**
 * Turns an encrypted relay push into a local notification with the real
 * conversation text, approve/reject buttons and the same channels the web
 * layer creates (src/taskNotifications.ts).
 */
public final class MiniqPushNotifier {
    /** Broadcast sent by the optional :miniq-jpush module to this app. */
    public static final String ACTION_EVENT = "com.leadingthink.miniq.push.EVENT";
    public static final String EXTRA_EVENT = "miniq.event";
    public static final String EXTRA_EXTRAS = "miniq.extras";
    public static final String EXTRA_JPUSH_NOTIFICATION_ID = "miniq.jpushNotificationId";
    public static final String EXTRA_TOKEN = "miniq.token";

    /** Extras on the activity intent of a tapped notification. */
    public static final String EXTRA_OPENED = "miniq.opened";
    public static final String EXTRA_ACTION_ID = "miniq.actionId";
    public static final String EXTRA_NOTIFICATION_ID = "miniq.notificationId";
    public static final String EXTRA_SESSION_ID = "miniq.sessionId";
    public static final String EXTRA_APPROVAL_ID = "miniq.approvalId";
    public static final String EXTRA_DESKTOP_DEVICE_ID = "miniq.desktopDeviceId";
    public static final String EXTRA_ROOM_ID = "miniq.roomId";

    public static final String CHANNEL_ATTENTION = "miniq-attention";
    public static final String CHANNEL_RESULTS = "miniq-results";
    public static final String CHANNEL_QUIET = "miniq-quiet";
    private static final String TAG = "miniq-push";

    private MiniqPushNotifier() {}

    /** Creates channels if the web layer has not done so yet (same ids, same settings). */
    public static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        createChannel(manager, CHANNEL_ATTENTION, "需要你操作", "任务等待审批或回答时提醒", NotificationManager.IMPORTANCE_HIGH, true);
        createChannel(manager, CHANNEL_RESULTS, "任务结果", "任务完成或未完成时提醒", NotificationManager.IMPORTANCE_DEFAULT, true);
        createChannel(manager, CHANNEL_QUIET, "免打扰时段", "免打扰时段内静默送达", NotificationManager.IMPORTANCE_LOW, false);
    }

    private static void createChannel(NotificationManager manager, String id, String name, String description, int importance, boolean vibrate) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || manager.getNotificationChannel(id) != null) return;
        NotificationChannel channel = new NotificationChannel(id, name, importance);
        channel.setDescription(description);
        channel.enableVibration(vibrate);
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(channel);
    }

    /** Decrypts JPush extras ({miniqNonce, miniqCiphertext, ...}); null when not possible. */
    public static MiniqPushText decryptExtras(Context context, JSONObject extras) {
        if (extras == null) return null;
        SecretKey key = MiniqPushCrypto.loadKey(context);
        if (key == null) return null;
        MiniqPushText text = MiniqPushText.from(MiniqPushCrypto.decrypt(key, extras.optString("miniqNonce", ""), extras.optString("miniqCiphertext", "")));
        if (text != null && extras.has("miniqDesktopDeviceId")
            && !extras.optString("miniqDesktopDeviceId", "").equals(text.desktopDeviceId)) return null;
        return text;
    }

    /**
     * Replaces the generic vendor notification with the decrypted one.
     * {@code alreadyAlerted} keeps it silent when the SDK already played sound.
     */
    public static boolean show(Context context, JSONObject extras, int replacedNotificationId, boolean alreadyAlerted) {
        MiniqPushText text = decryptExtras(context, extras);
        if (text == null) return false;
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return false;
        ensureChannels(context);

        boolean quiet = "1".equals(extras.optString("miniqQuiet", ""));
        boolean attention = "attention".equals(text.kind);
        String channel = quiet ? CHANNEL_QUIET : attention ? CHANNEL_ATTENTION : CHANNEL_RESULTS;
        String collapse = text.sessionKey() + ":" + extras.optString("miniqNotificationId", text.kind);
        int id = collapse.hashCode() & 0x7fffffff;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_miniq)
            .setContentTitle(text.title)
            .setContentText(text.body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text.body))
            .setAutoCancel(true)
            .setNumber(MiniqBadge.mark(context, text.sessionKey()))
            .setBadgeIconType(NotificationCompat.BADGE_ICON_SMALL)
            .setGroup("session:" + text.sessionKey())
            .setCategory(attention ? NotificationCompat.CATEGORY_REMINDER : NotificationCompat.CATEGORY_STATUS)
            .setPriority(quiet ? NotificationCompat.PRIORITY_LOW : attention ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setSilent(alreadyAlerted || quiet)
            .setContentIntent(openIntent(context, id, "tap", text));
        if (attention && text.approvalId != null) {
            builder.addAction(0, "批准", openIntent(context, id, "approve", text));
            builder.addAction(0, "拒绝", openIntent(context, id, "reject", text));
        }
        try {
            if (replacedNotificationId != 0) manager.cancel(replacedNotificationId);
            manager.notify(TAG, id, builder.build());
            return true;
        } catch (SecurityException missingPermission) {
            return false;
        }
    }

    /** Opens MainActivity; MiniqPushPlugin forwards it as `notificationOpened`. */
    private static PendingIntent openIntent(Context context, int notificationId, String actionId, MiniqPushText text) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction("com.leadingthink.miniq.push.OPEN." + actionId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_OPENED, true)
            .putExtra(EXTRA_ACTION_ID, actionId)
            .putExtra(EXTRA_NOTIFICATION_ID, notificationId)
            .putExtra(EXTRA_DESKTOP_DEVICE_ID, text.desktopDeviceId)
            .putExtra(EXTRA_ROOM_ID, text.roomId)
            .putExtra(EXTRA_SESSION_ID, text.sessionId);
        if (text.approvalId != null) intent.putExtra(EXTRA_APPROVAL_ID, text.approvalId);
        int requestCode = (notificationId * 31 + actionId.hashCode()) & 0x7fffffff;
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    public static void cancel(Context context, int notificationId) {
        if (notificationId != 0) NotificationManagerCompat.from(context).cancel(TAG, notificationId);
    }
}
