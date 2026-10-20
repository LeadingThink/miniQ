package com.leadingthink.miniq;

import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Owns only private upload snapshots. No URI, local path, or bytes reach JavaScript. */
final class MiniqUploadFiles implements AutoCloseable {
    static final long MAX_BYTES = 200L * 1024 * 1024;
    private static final int BUFFER_BYTES = 64 * 1024;
    private static final Set<String> LIVE_DIRECTORIES = new HashSet<>();
    private final File root;
    private final Map<String, Operation> operations = new HashMap<>();
    private final Map<String, CachedFile> files = new HashMap<>();
    private final Connections connections;
    private boolean closed;

    interface Source {
        String name(Operation operation) throws Exception;
        InputStream open(Operation operation) throws Exception;
    }
    interface Progress { void update(long received, long total); }
    interface Connections { HttpURLConnection open(URI uri) throws IOException; }

    static final class CachedFile {
        final String id = UUID.randomUUID().toString();
        final String name;
        final File path;
        long size;
        String sha256;
        int readers;
        boolean released;
        CachedFile(String name, File directory) {
            this.name = name;
            this.path = new File(directory, id + ".blob");
        }
    }

    static final class Operation {
        final String id;
        volatile boolean cancelled;
        final List<CachedFile> prepared = new ArrayList<>();
        File directory;
        CachedFile source;
        URI uri;
        private InputStream input;
        private OutputStream output;
        private HttpURLConnection connection;
        private Runnable cancellation;
        Operation(String id) { this.id = id; }

        void check() throws InterruptedIOException {
            if (cancelled) throw new InterruptedIOException("文件操作已取消");
        }
        synchronized void cancellation(Runnable action) {
            cancellation = action;
            if (cancelled && action != null) action.run();
        }
        synchronized void watch(InputStream stream) throws IOException {
            if (cancelled) { closeQuietly(stream); check(); }
            input = stream;
        }
        synchronized void watch(OutputStream stream) throws IOException {
            if (cancelled) { closeQuietly(stream); check(); }
            output = stream;
        }
        synchronized void watch(HttpURLConnection value) throws IOException {
            if (cancelled) { value.disconnect(); check(); }
            connection = value;
        }
        synchronized void clear() { input = null; output = null; connection = null; cancellation = null; }
        void abortIo() {
            InputStream in;
            OutputStream out;
            HttpURLConnection network;
            Runnable signal;
            synchronized (this) { in = input; out = output; network = connection; signal = cancellation; }
            if (signal != null) signal.run();
            if (network != null) network.disconnect();
            closeQuietly(in);
            closeQuietly(out);
        }
    }

    MiniqUploadFiles(File cacheDirectory) throws IOException {
        this(cacheDirectory, uri -> (HttpURLConnection) uri.toURL().openConnection());
    }

    MiniqUploadFiles(File cacheDirectory, Connections connections) throws IOException {
        this.connections = connections;
        root = new File(cacheDirectory.getCanonicalFile(), "remote-uploads");
        if (!root.getCanonicalFile().equals(root.getAbsoluteFile())) throw new IOException("上传缓存目录无效");
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法创建上传缓存");
        // Other live plugin instances keep their directories registered until their I/O finishes.
        // After process death no registrations remain, so the next instance removes orphaned snapshots.
        synchronized (LIVE_DIRECTORIES) {
            File[] stale = root.listFiles();
            if (stale != null) for (File directory : stale) {
                if (ownedDirectory(directory) && !LIVE_DIRECTORIES.contains(directory.getPath()))
                    deleteDirectory(directory);
            }
        }
    }

    synchronized Operation beginPick(String id) throws IOException { return begin(id); }
    synchronized boolean hasOperation(String id) { return operations.containsKey(id); }

    private Operation begin(String id) throws IOException {
        if (closed) throw new IOException("文件上传组件已关闭");
        if (!isId(id) || operations.containsKey(id)) throw new IOException("文件操作标识无效或正在使用");
        Operation operation = new Operation(id);
        operations.put(id, operation);
        return operation;
    }

    void prepare(Operation operation, List<Source> sources, int limit) throws Exception {
        if (limit < 1 || limit > 10 || sources.isEmpty() || sources.size() > limit)
            throw new IOException("所选文件数量超过限制或无效");
        synchronized (this) {
            operation.check();
            if (closed || operations.get(operation.id) != operation) throw new IOException("文件操作已结束");
            synchronized (LIVE_DIRECTORIES) {
                operation.directory = new File(root, UUID.randomUUID().toString());
                if (!operation.directory.mkdir()) throw new IOException("无法创建上传缓存");
                LIVE_DIRECTORIES.add(operation.directory.getPath());
            }
        }
        for (Source source : sources) {
            operation.check();
            String name = source.name(operation);
            if (!validName(name)) throw new IOException("文件名包含路径或控制字符");
            CachedFile file = new CachedFile(name, operation.directory);
            operation.prepared.add(file);
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = source.open(operation);
                 OutputStream output = new FileOutputStream(file.path)) {
                if (input == null) throw new IOException("无法读取所选文件");
                operation.watch(input);
                operation.watch(output);
                file.size = copy(operation, input, output, digest, MAX_BYTES, null);
                output.flush();
                file.sha256 = hex(digest.digest());
            } finally { operation.clear(); }
        }
        operation.check();
    }

    synchronized List<CachedFile> finishPick(Operation operation, boolean publish) {
        if (operations.get(operation.id) != operation) return Collections.emptyList();
        operations.remove(operation.id);
        if (!publish || operation.cancelled || closed) {
            if (operation.directory != null) {
                synchronized (LIVE_DIRECTORIES) {
                    deleteDirectory(operation.directory);
                    LIVE_DIRECTORIES.remove(operation.directory.getPath());
                }
            }
            return Collections.emptyList();
        }
        for (CachedFile file : operation.prepared) files.put(file.id, file);
        return new ArrayList<>(operation.prepared);
    }

    synchronized Operation beginUpload(String id, String fileId, String url) throws IOException {
        URI uri = uploadUri(url);
        CachedFile file = files.get(fileId);
        if (file == null || file.released) throw new IOException("上传缓存不存在或已释放");
        Operation operation = begin(id);
        operation.source = file;
        operation.uri = uri;
        file.readers++;
        return operation;
    }

    String upload(Operation operation, Progress progress) throws IOException {
        IOException failure = null;
        HttpURLConnection connection = null;
        CachedFile file = operation.source;
        try {
            operation.check();
            if (file.path.length() != file.size) throw new IOException("上传缓存完整性校验失败");
            connection = connections.open(operation.uri);
            operation.watch(connection);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("PUT");
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(30_000);
            connection.setDoOutput(true);
            connection.setUseCaches(false);
            connection.setFixedLengthStreamingMode(file.size);
            connection.setRequestProperty("Content-Type", "application/octet-stream");
            connection.setRequestProperty("Accept-Encoding", "identity");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = new FileInputStream(file.path)) {
                operation.watch(input);
                try (OutputStream output = connection.getOutputStream()) {
                    operation.watch(output);
                    progress.update(0, file.size);
                    long sent = copy(operation, input, output, digest, file.size, progress);
                    if (sent != file.size || !hex(digest.digest()).equals(file.sha256))
                        throw new IOException("上传缓存完整性校验失败");
                    output.flush();
                }
            }
            operation.check();
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException("文件上传失败 HTTP (" + status + ")");
        } catch (Exception error) {
            // Transport/provider messages can contain signed URLs or device paths.
            String message = error.getMessage();
            failure = new IOException(message != null && message.matches("文件上传失败 HTTP \\([0-9]{3}\\)")
                ? message : "文件上传失败，请重试");
            if (!operation.cancelled && connection != null) {
                try {
                    int status = connection.getResponseCode();
                    if (status >= 300) failure = new IOException("文件上传失败 HTTP (" + status + ")");
                } catch (IOException ignored) { /* Keep the safe transport error. */ }
            }
        } finally {
            if (connection != null) connection.disconnect();
            operation.clear();
        }
        synchronized (this) {
            operations.remove(operation.id);
            file.readers--;
            if (file.released) deleteReleased(file);
            if (operation.cancelled) return "cancelled";
            if (failure != null) throw failure;
            return "uploaded";
        }
    }

    private static long copy(Operation operation, InputStream input, OutputStream output,
                             MessageDigest digest, long maximum, Progress progress) throws IOException {
        byte[] buffer = new byte[BUFFER_BYTES];
        long received = 0, lastEvent = 0;
        while (true) {
            operation.check();
            int count = input.read(buffer);
            operation.check();
            if (count == -1) break;
            received += count;
            if (received > maximum) throw new IOException("文件超过 200 MiB 或缓存长度不一致");
            digest.update(buffer, 0, count);
            output.write(buffer, 0, count);
            long now = System.nanoTime();
            if (progress != null && (now - lastEvent >= 100_000_000L || received == maximum)) {
                progress.update(received, maximum);
                lastEvent = now;
            }
        }
        return received;
    }

    void cancel(String id) {
        Operation operation;
        synchronized (this) {
            operation = operations.get(id);
            if (operation != null) operation.cancelled = true;
        }
        if (operation != null) operation.abortIo();
    }

    synchronized void release(List<String> ids) {
        for (String id : ids) {
            CachedFile file = files.get(id);
            if (file != null) { file.released = true; deleteReleased(file); }
        }
    }

    private void deleteReleased(CachedFile file) {
        if (file.readers > 0) return;
        if (!file.path.exists() || file.path.delete()) files.remove(file.id);
        File directory = file.path.getParentFile();
        synchronized (LIVE_DIRECTORIES) {
            for (CachedFile remaining : files.values()) {
                if (remaining.path.getParentFile().equals(directory) && (!remaining.released || remaining.readers > 0)) return;
            }
            String[] remaining = directory.list();
            if (remaining != null && remaining.length == 0) directory.delete();
            LIVE_DIRECTORIES.remove(directory.getPath());
        }
    }

    @Override public void close() {
        List<Operation> pending;
        synchronized (this) {
            closed = true;
            pending = new ArrayList<>(operations.values());
            for (Operation operation : pending) operation.cancelled = true;
            for (CachedFile file : new ArrayList<>(files.values())) {
                file.released = true;
                deleteReleased(file);
            }
        }
        for (Operation operation : pending) operation.abortIo();
    }

    static boolean isId(String id) {
        return id != null && id.matches("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}");
    }

    private static boolean validName(String name) {
        if (name == null || name.isEmpty() || name.equals(".") || name.equals("..")
            || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) return false;
        for (int i = 0; i < name.length(); i++) if (Character.isISOControl(name.charAt(i))) return false;
        return true;
    }

    static URI uploadUri(String url) throws IOException {
        try {
            URI uri = new URI(url);
            String host = uri.getHost();
            String path = uri.getPath();
            String raw = uri.getRawPath().toLowerCase(Locale.ROOT);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null
                || !host.toLowerCase(Locale.ROOT).endsWith(".qiniucs.com") || uri.getUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443) || uri.getFragment() != null
                || !path.matches("/(?:[^/]+/)?remote-files/[^/]+/[^/]+(?:/[^/]+)*")
                || raw.contains("%2f") || raw.contains("%5c") || raw.contains("%25")) throw new IllegalArgumentException();
            for (String segment : path.substring(1).split("/")) if (!validName(segment)) throw new IllegalArgumentException();
            return uri;
        } catch (Exception ignored) { throw new IOException("文件上传地址无效"); }
    }

    private boolean ownedDirectory(File directory) throws IOException {
        return isId(directory.getName()) && directory.isDirectory()
            && directory.getCanonicalFile().equals(directory.getAbsoluteFile())
            && directory.getParentFile().equals(root);
    }

    private void deleteDirectory(File directory) {
        try {
            if (!ownedDirectory(directory)) return;
            File[] contents = directory.listFiles();
            if (contents != null) for (File file : contents) {
                String name = file.getName();
                if (name.endsWith(".blob") && isId(name.substring(0, name.length() - 5))
                    && file.getCanonicalFile().equals(file.getAbsoluteFile()) && file.isFile()) file.delete();
            }
            directory.delete();
        } catch (IOException ignored) { /* A later startup retries orphan cleanup. */ }
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(64);
        for (byte item : bytes) value.append(String.format(Locale.ROOT, "%02x", item & 255));
        return value.toString();
    }

    private static void closeQuietly(Closeable value) {
        if (value != null) try { value.close(); } catch (IOException ignored) { }
    }
}
