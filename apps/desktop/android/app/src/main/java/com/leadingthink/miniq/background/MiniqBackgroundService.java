package com.leadingthink.miniq.background;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import com.leadingthink.miniq.MainActivity;
import com.leadingthink.miniq.R;

/**
 * Optional "后台保持连接" mode without any third-party push provider: a
 * low-importance foreground service keeps the app process (and therefore the
 * WebView's relay WebSocket) alive while miniQ is in the background, so the
 * web layer's local notifications (src/taskNotifications.ts) still fire.
 *
 * When the user swipes the task away the WebView is destroyed, so the
 * service stops itself instead of lingering without a connection.
 */
public class MiniqBackgroundService extends Service {
    public static final String CHANNEL_ID = "miniq-background";
    private static final int NOTIFICATION_ID = 0x6d71; // "mq"
    private static final String TAG = "miniq-background";

    public static boolean start(Context context) {
        try {
            ContextCompat.startForegroundService(context, new Intent(context, MiniqBackgroundService.class));
            return true;
        } catch (RuntimeException notAllowed) {
            // e.g. ForegroundServiceStartNotAllowedException when started from the background.
            Log.w(TAG, "foreground service start refused", notAllowed);
            return false;
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, MiniqBackgroundService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannel(this);
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING : 0;
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(this), type);
        } catch (RuntimeException refused) {
            Log.w(TAG, "startForeground refused", refused);
            stopSelf();
            return START_NOT_STICKY;
        }
        // Not sticky: a restarted process has no WebView, so there is nothing to keep alive.
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "后台保持连接", NotificationManager.IMPORTANCE_MIN);
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
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setShowWhen(false)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(content)
            .build();
    }
}
