package com.leadingthink.miniq.background;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import com.leadingthink.miniq.MainActivity;
import com.leadingthink.miniq.R;
import java.util.ArrayList;
import java.util.List;

/** Foreground process support; the WebView still owns the relay connection. */
public class MiniqBackgroundService extends Service {
    public static final String CHANNEL_ID = "miniq-background";
    private static final int NOTIFICATION_ID = 0x6d71;
    private static final String TAG = "miniq-background";
    private static final String REQUEST_ID = "miniq.background.request";
    private static final long START_TIMEOUT_MS = 4000;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    // All state is confined to the main thread, including plugin requests.
    private static final List<Callback> pending = new ArrayList<>();
    private static boolean running;
    private static int requestId;
    private static String lastError;
    private static Runnable timeout;
    private int handledRequest = -1;

    public interface Callback {
        void complete(Status status);
    }

    public static final class Status {
        public final boolean running;
        public final boolean notificationsEnabled;
        public final String error;

        Status(boolean running, boolean notificationsEnabled, String error) {
            this.running = running;
            this.notificationsEnabled = notificationsEnabled;
            this.error = error;
        }
    }

    public static void status(Context context, Callback callback) {
        MAIN.post(() -> callback.complete(snapshot(context)));
    }

    public static void start(Context context, Callback callback) {
        MAIN.post(() -> {
            if (running) {
                callback.complete(snapshot(context));
                return;
            }
            pending.add(callback);
            if (pending.size() > 1) return;
            lastError = null;
            int id = ++requestId;
            timeout = () -> {
                if (id != requestId || pending.isEmpty()) return;
                ++requestId; // A delayed onStartCommand must not revive a timed-out request.
                lastError = "foreground_start_timeout";
                context.stopService(new Intent(context, MiniqBackgroundService.class));
                finish(context);
            };
            MAIN.postDelayed(timeout, START_TIMEOUT_MS);
            try {
                ContextCompat.startForegroundService(context,
                    new Intent(context, MiniqBackgroundService.class).putExtra(REQUEST_ID, id));
            } catch (RuntimeException refused) {
                Log.w(TAG, "foreground service start refused", refused);
                ++requestId;
                lastError = "foreground_start_refused: " + refused.getClass().getSimpleName();
                finish(context);
            }
        });
    }

    public static void stop(Context context, Runnable complete) {
        MAIN.post(() -> {
            ++requestId;
            running = false;
            lastError = pending.isEmpty() ? null : "foreground_start_cancelled";
            context.stopService(new Intent(context, MiniqBackgroundService.class));
            finish(context);
            lastError = null;
            complete.run();
        });
    }

    private static Status snapshot(Context context) {
        return new Status(running, notificationsEnabled(context), lastError);
    }

    private static void finish(Context context) {
        if (timeout != null) MAIN.removeCallbacks(timeout);
        timeout = null;
        List<Callback> callbacks = new ArrayList<>(pending);
        pending.clear();
        Status result = snapshot(context);
        for (Callback callback : callbacks) callback.complete(result);
    }

    static boolean notificationsEnabled(Context context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return false;
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        // Before first start there is no channel and therefore no channel-level restriction.
        if (channel == null) return true;
        if (channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        if (Build.VERSION.SDK_INT >= 28 && channel.getGroup() != null) {
            NotificationChannelGroup group = manager.getNotificationChannelGroup(channel.getGroup());
            if (group != null && group.isBlocked()) return false;
        }
        return true;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getIntExtra(REQUEST_ID, -1) != requestId || pending.isEmpty()) {
            if (!running) stopSelf(startId);
            return START_NOT_STICKY;
        }
        handledRequest = requestId;
        try {
            enterForeground();
            running = true;
            lastError = null;
        } catch (RuntimeException refused) {
            Log.w(TAG, "startForeground refused", refused);
            running = false;
            lastError = "foreground_promotion_failed: " + refused.getClass().getSimpleName();
            stopSelf();
        }
        finish(this);
        // A restarted process has no WebView to keep alive.
        return START_NOT_STICKY;
    }

    void enterForeground() {
        ensureChannel(this);
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(this), type);
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        running = false;
        if (!pending.isEmpty()) lastError = "foreground_start_cancelled";
        ++requestId;
        finish(this);
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        // A destroy callback for a stopped instance must not cancel a newer start.
        if (handledRequest == requestId) {
            running = false;
            if (!pending.isEmpty()) lastError = "foreground_service_destroyed";
            finish(this);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        // Android cannot raise an existing channel's importance programmatically. Preserve
        // legacy MIN and user-disabled channels; let the user change the same channel in Settings.
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "后台保持连接", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("miniQ 在后台与电脑保持连接时显示，不响铃不震动");
        channel.setShowBadge(false);
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private static Notification buildNotification(Context context) {
        Intent open = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(context, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_miniq)
            .setContentTitle("miniQ 正在后台保持连接")
            .setContentText("任务完成或需要你操作时会提醒你")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setShowWhen(false)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(content)
            .build();
    }
}
