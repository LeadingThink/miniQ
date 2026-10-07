package com.leadingthink.miniq.background;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.os.Build;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.leadingthink.miniq.MainActivity;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class MiniqBackgroundServiceTest {
    private Context context;
    private SubmissionContext submission;

    private static class Result implements MiniqBackgroundService.Callback {
        final CountDownLatch ready = new CountDownLatch(1);
        final AtomicInteger count = new AtomicInteger();
        MiniqBackgroundService.Status status;
        public void complete(MiniqBackgroundService.Status value) {
            status = value;
            count.incrementAndGet();
            ready.countDown();
        }
        MiniqBackgroundService.Status await() throws Exception {
            assertTrue("callback timed out", ready.await(6, TimeUnit.SECONDS));
            return status;
        }
    }

    private static class SubmissionContext extends ContextWrapper {
        Intent submitted;
        boolean refuse;
        int submissions;
        SubmissionContext(Context base) { super(base); }
        @Override public ComponentName startForegroundService(Intent intent) { return submit(intent); }
        @Override public ComponentName startService(Intent intent) { return submit(intent); }
        ComponentName submit(Intent intent) {
            submissions++;
            if (refuse) throw new SecurityException("test rejection");
            submitted = intent;
            return intent.getComponent();
        }
        @Override public boolean stopService(Intent intent) { return true; }
    }

    private static class PromotionService extends MiniqBackgroundService {
        boolean fail;
        int promotions;
        PromotionService(Context context, boolean fail) {
            attachBaseContext(context);
            this.fail = fail;
        }
        @Override void enterForeground() {
            promotions++;
            if (fail) throw new SecurityException("test promotion rejection");
        }
    }

    private void flush() {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    }

    private void stop(Context target) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        MiniqBackgroundService.stop(target, done::countDown);
        assertTrue(done.await(2, TimeUnit.SECONDS));
        flush();
    }

    @Before public void prepare() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        stop(context);
        submission = new SubmissionContext(context);
    }

    @After public void cleanUp() throws Exception { stop(context); }

    @Test public void submittedIntentIsNotRunningUntilPromotionCompletes() throws Exception {
        Result first = new Result();
        Result second = new Result();
        MiniqBackgroundService.start(submission, first);
        MiniqBackgroundService.start(submission, second);
        flush();
        assertEquals(1, submission.submissions);
        assertEquals(1, first.ready.getCount());
        Result before = new Result();
        MiniqBackgroundService.status(context, before);
        assertFalse(before.await().running);
        PromotionService service = new PromotionService(context, false);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            service.onStartCommand(submission.submitted, 0, 1));
        assertTrue(first.await().running);
        assertTrue(second.await().running);
        assertNull(first.status.error);
        Result repeat = new Result();
        MiniqBackgroundService.start(submission, repeat);
        assertTrue(repeat.await().running);
        assertEquals(1, submission.submissions);
        assertEquals(1, service.promotions);
        assertEquals(1, first.count.get());
        InstrumentationRegistry.getInstrumentation().runOnMainSync(service::onDestroy);
        Result destroyed = new Result();
        MiniqBackgroundService.status(context, destroyed);
        assertFalse(destroyed.await().running);
    }

    @Test public void submissionFailureReturnsError() throws Exception {
        submission.refuse = true;
        Result result = new Result();
        MiniqBackgroundService.start(submission, result);
        assertFalse(result.await().running);
        assertTrue(result.status.error.startsWith("foreground_start_refused"));
    }

    @Test public void promotionFailureReturnsErrorRatherThanSuccessfulSubmission() throws Exception {
        Result result = new Result();
        MiniqBackgroundService.start(submission, result);
        flush();
        PromotionService service = new PromotionService(context, true);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            service.onStartCommand(submission.submitted, 0, 1));
        assertFalse(result.await().running);
        assertTrue(result.status.error.startsWith("foreground_promotion_failed"));
    }

    @Test public void timeoutRejectsLateStartAndCompletesOnce() throws Exception {
        Result result = new Result();
        MiniqBackgroundService.start(submission, result);
        assertFalse(result.await().running);
        assertEquals("foreground_start_timeout", result.status.error);
        PromotionService late = new PromotionService(context, false);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() ->
            late.onStartCommand(submission.submitted, 0, 1));
        assertEquals(0, late.promotions);
        assertEquals(1, result.count.get());
    }

    @Test public void stopCancelsPendingStartAndAllowsRetry() throws Exception {
        Result cancelled = new Result();
        MiniqBackgroundService.start(submission, cancelled);
        flush();
        Intent oldIntent = submission.submitted;
        stop(submission);
        assertFalse(cancelled.await().running);
        assertEquals("foreground_start_cancelled", cancelled.status.error);
        Result retry = new Result();
        MiniqBackgroundService.start(submission, retry);
        flush();
        PromotionService stale = new PromotionService(context, false);
        PromotionService current = new PromotionService(context, false);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            stale.onStartCommand(oldIntent, 0, 1);
            stale.onDestroy();
            current.onStartCommand(submission.submitted, 0, 2);
        });
        assertEquals(0, stale.promotions);
        assertTrue(retry.await().running);
    }

    @Test public void existingChannelSettingsArePreserved() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel before = manager.getNotificationChannel(MiniqBackgroundService.CHANNEL_ID);
        MiniqBackgroundService.ensureChannel(context);
        NotificationChannel after = manager.getNotificationChannel(MiniqBackgroundService.CHANNEL_ID);
        assertNotNull(after);
        assertEquals(before == null ? NotificationManager.IMPORTANCE_LOW : before.getImportance(), after.getImportance());
        MiniqBackgroundService.ensureChannel(context);
        assertEquals(after.getImportance(), manager.getNotificationChannel(MiniqBackgroundService.CHANNEL_ID).getImportance());
    }

    @Test public void actualForegroundServiceReportsStatusAndStops() throws Exception {
        Activity activity = InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            Result result = new Result();
            MiniqBackgroundService.start(context, result);
            assertTrue("actual foreground promotion failed: " + result.await().error, result.status.running);
            Result status = new Result();
            MiniqBackgroundService.status(context, status);
            assertTrue(status.await().running);
            assertEquals(MiniqBackgroundService.notificationsEnabled(context), status.status.notificationsEnabled);
            String expected = InstrumentationRegistry.getArguments().getString("expectedNotificationsEnabled");
            if (expected != null) assertEquals(Boolean.parseBoolean(expected), status.status.notificationsEnabled);
            stop(context);
            Result stopped = new Result();
            MiniqBackgroundService.status(context, stopped);
            assertFalse(stopped.await().running);
        } finally {
            InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish);
        }
    }
}
