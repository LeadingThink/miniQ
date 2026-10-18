package com.leadingthink.miniq;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** No file bytes cross the JavaScript bridge. URLs and network errors are never logged. */
@CapacitorPlugin(name = "MiniqFiles")
public class MiniqFilesPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile Transfer active;
    private volatile Transfer picker;
    private static final long MAX_BYTES = 200L * 1024 * 1024;

    private static final class Transfer {
        final String id;
        final PluginCall call;
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
        File file;
        Transfer(String id, PluginCall call) { this.id = id; this.call = call; }
    }

    @PluginMethod
    public synchronized void save(PluginCall call) {
        if (active != null || picker != null) { call.reject("请先关闭当前文件保存窗口"); return; }
        String id = call.getString("id", "");
        String name = call.getString("filename", "");
        String hash = call.getString("sha256", "");
        Integer size = call.getInt("size");
        URI uri;
        try {
            uri = new URI(call.getString("url", ""));
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null
                || !uri.getHost().endsWith(".qiniucs.com") || uri.getUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443)
                || !uri.getPath().contains("/remote-files/") || uri.getFragment() != null)
                throw new IllegalArgumentException();
        } catch (Exception ignored) { call.reject("文件下载地址无效"); return; }
        if (!id.matches("[A-Za-z0-9-]{8,80}") || name.isEmpty() || name.length() > 240
            || name.contains("/") || name.contains("\\") || name.equals(".") || name.equals("..")
            || name.chars().anyMatch(c -> c < 32) || !hash.matches("[a-f0-9]{64}")
            || size == null || size < 0 || size > MAX_BYTES) {
            call.reject("文件下载信息无效"); return;
        }
        Transfer transfer = new Transfer(id, call);
        active = transfer;
        worker.execute(() -> download(transfer, uri, name, size, hash));
    }

    private void download(Transfer transfer, URI uri, String name, long size, String hash) {
        try {
            File directory = new File(getContext().getCacheDir(), "remote-files");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException();
            File[] stale = directory.listFiles();
            if (stale != null) for (File file : stale) if (file.isFile()) file.delete();
            transfer.file = File.createTempFile("download-", ".tmp", directory);
            HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
            transfer.connection = connection;
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(30000);
            connection.setRequestProperty("Accept-Encoding", "identity");
            if (transfer.cancelled) throw new InterruptedException();
            if (connection.getResponseCode() != 200) throw new IllegalStateException();
            long declared = connection.getContentLengthLong();
            if (declared >= 0 && declared != size) throw new IllegalStateException();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long received = 0, lastEvent = 0;
            long deadline = android.os.SystemClock.elapsedRealtime() + 900_000;
            try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(transfer.file)) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (transfer.cancelled) throw new InterruptedException();
                    if (android.os.SystemClock.elapsedRealtime() > deadline) throw new IllegalStateException();
                    received += count;
                    if (received > size) throw new IllegalStateException();
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                    long now = android.os.SystemClock.elapsedRealtime();
                    if (now - lastEvent >= 100 || received == size) {
                        notifyListeners("progress", new JSObject().put("id", transfer.id).put("received", received).put("total", size));
                        lastEvent = now;
                    }
                }
            } finally { connection.disconnect(); transfer.connection = null; }
            StringBuilder actual = new StringBuilder();
            for (byte value : digest.digest()) actual.append(String.format("%02x", value & 255));
            if (received != size || !actual.toString().equals(hash)) throw new IllegalStateException();
            getActivity().runOnUiThread(() -> {
                synchronized (MiniqFilesPlugin.this) {
                if (transfer.cancelled || active != transfer) { finish(transfer, "cancelled", null); return; }
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(transfer.call.getString("mimeType", "application/octet-stream"));
                intent.putExtra(Intent.EXTRA_TITLE, name);
                picker = transfer;
                try { startActivityForResult(transfer.call, intent, "destinationSelected"); }
                catch (Exception ignored) { picker = null; finish(transfer, null, "无法打开系统文件保存窗口"); }
                }
            });
        } catch (Exception ignored) {
            finish(transfer, transfer.cancelled ? "cancelled" : null, "文件下载失败或完整性校验失败，请重试");
        }
    }

    @ActivityCallback
    private synchronized void destinationSelected(PluginCall call, ActivityResult result) {
        Transfer transfer = picker;
        // A cancelled promise may already have been released by the bridge.
        // There is only one outstanding picker; its retained identity is authoritative.
        if (transfer == null || (call != null && transfer.call != call)) return;
        picker = null;
        Uri destination = result.getData() == null ? null : result.getData().getData();
        if (transfer.cancelled || active != transfer || result.getResultCode() != Activity.RESULT_OK || destination == null) {
            if (result.getResultCode() == Activity.RESULT_OK && destination != null) deleteDestination(destination);
            finish(transfer, "cancelled", null); return;
        }
        worker.execute(() -> {
            boolean saved = false;
            try (InputStream input = new FileInputStream(transfer.file);
                 OutputStream output = getContext().getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IllegalStateException();
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (transfer.cancelled) throw new InterruptedException();
                    output.write(buffer, 0, count);
                }
                output.flush();
                saved = true;
            } catch (Exception ignored) { saved = false; }
            synchronized (MiniqFilesPlugin.this) {
                // Cancellation and successful publication have one terminal decision.
                if (transfer.cancelled || active != transfer) saved = false;
                if (!saved) deleteDestination(destination);
                finish(transfer, saved ? "saved" : transfer.cancelled ? "cancelled" : null, "文件未能保存，请重试");
            }
        });
    }

    @PluginMethod
    public synchronized void cancel(PluginCall call) {
        Transfer transfer = active;
        if (transfer != null && transfer.id.equals(call.getString("id"))) {
            transfer.cancelled = true;
            HttpURLConnection connection = transfer.connection;
            if (connection != null) connection.disconnect();
            // Android's external picker cannot be dismissed by this app. Settle
            // cancellation now and retain its identity only to clean a late URI.
            if (picker == transfer) finish(transfer, "cancelled", null);
        }
        call.resolve();
    }

    private void deleteDestination(Uri destination) {
        try { android.provider.DocumentsContract.deleteDocument(getContext().getContentResolver(), destination); }
        catch (Exception ignored) { /* Some providers cannot delete incomplete documents. */ }
    }

    private synchronized void finish(Transfer transfer, String status, String error) {
        if (active != transfer) return;
        active = null;
        if (transfer.connection != null) transfer.connection.disconnect();
        if (transfer.file != null) transfer.file.delete();
        if (status != null) transfer.call.resolve(new JSObject().put("status", status));
        else transfer.call.reject(error);
    }

    @Override protected void handleOnDestroy() {
        Transfer transfer = active;
        if (transfer != null) {
            transfer.cancelled = true;
            finish(transfer, "cancelled", null);
        }
        worker.shutdownNow();
    }
}
