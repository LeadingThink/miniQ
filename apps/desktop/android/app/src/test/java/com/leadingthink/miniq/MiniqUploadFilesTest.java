package com.leadingthink.miniq;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/** Offline behavior tests; run with javac/java and -Xmx32m, without Android or JUnit. */
public final class MiniqUploadFilesTest {
    private static final String URL = "https://test.qiniucs.com/bucket/remote-files/room/desktop/session/object?signature=fixture";
    private static int assertions;
    private static File base;

    public static void main(String[] args) throws Exception {
        base = new File(args[0]);
        check(base.isDirectory() || base.mkdirs(), "test directory");
        snapshotsPreserveBytes();
        selectionFailuresCleanEverything();
        sizeBoundaryStreams();
        cancellationStopsOnlyItsPick();
        uploadsUseSnapshotsAndHttpStatus();
        releaseWaitsForEveryReader();
        destroyCancelsAndCleans();
        staleCleanupIsScoped();
        validateUrls();
        System.out.println("MiniqUploadFilesTest passed: " + assertions + " assertions; synthetic fixtures, no network");
    }

    private static void snapshotsPreserveBytes() throws Exception {
        File cache = cache();
        byte[] bytes = fixture(180_001);
        try (MiniqUploadFiles store = new MiniqUploadFiles(cache)) {
            MiniqUploadFiles.Operation pick = store.beginPick(id());
            store.prepare(pick, Arrays.asList(source("原片 📷.HEIC", bytes), source("empty.bin", new byte[0])), 2);
            check(pick.prepared.size() == 2, "all selected sources prepared");
            expectFailure(() -> store.beginUpload(id(), pick.prepared.get(0).id, URL));
            List<MiniqUploadFiles.CachedFile> result = store.finishPick(pick, true);
            MiniqUploadFiles.CachedFile first = result.get(0);
            check(first.name.equals("原片 📷.HEIC"), "original filename");
            check(MiniqUploadFiles.isId(first.id) && !first.id.equals(pick.id), "opaque cache identity");
            check(first.size == bytes.length && first.sha256.equals(hash(bytes)), "byte count and SHA256");
            check(Arrays.equals(Files.readAllBytes(first.path.toPath()), bytes), "original binary bytes");
            check(first.path.getParentFile().getParentFile().getName().equals("remote-uploads"), "private upload root");
            check(result.get(1).size == 0 && result.get(1).sha256.equals(hash(new byte[0])), "empty file");
            MiniqUploadFiles.CachedFile secondPick = pick(store, "same-name.bin", bytes);
            check(!first.path.getParentFile().equals(secondPick.path.getParentFile()), "isolated operation directories");
            store.release(Arrays.asList(first.id, first.id, id()));
            check(!first.path.exists() && result.get(1).path.exists() && secondPick.path.exists(), "release scope and idempotence");
        }
        check(blobCount(cache) == 0, "close cleans unclaimed snapshots");
    }

    private static void selectionFailuresCleanEverything() throws Exception {
        File cache = cache();
        try (MiniqUploadFiles store = new MiniqUploadFiles(cache)) {
            for (String name : Arrays.asList("../secret", "a/b", "a\\b", "a\n", "a\u007f", ".", "..", "")) {
                MiniqUploadFiles.Operation op = store.beginPick(id());
                expectFailure(() -> store.prepare(op, Arrays.asList(source("first", fixture(7)), source(name, fixture(9))), 2));
                check(store.finishPick(op, false).isEmpty() && blobCount(cache) == 0, "invalid name rolls back whole selection");
            }
            MiniqUploadFiles.Operation excess = store.beginPick(id());
            expectFailure(() -> store.prepare(excess, Arrays.asList(source("a", fixture(1)), source("b", fixture(1))), 1));
            check(excess.directory == null, "over-limit selection is rejected before copying");
            store.finishPick(excess, false);
            MiniqUploadFiles.Operation failed = store.beginPick(id());
            MiniqUploadFiles.Source broken = source("broken", new InputStream() {
                @Override public int read() throws IOException { throw new IOException("private path should stay native"); }
            });
            expectFailure(() -> store.prepare(failed, Arrays.asList(source("first", fixture(65_537)), broken), 2));
            store.finishPick(failed, false);
            check(blobCount(cache) == 0, "provider failure removes earlier and partial cache files");
            List<MiniqUploadFiles.Source> ten = new ArrayList<>();
            for (int i = 0; i < 10; i++) ten.add(source("same.bin", fixture(i)));
            MiniqUploadFiles.Operation accepted = store.beginPick(id());
            store.prepare(accepted, ten, 10);
            check(store.finishPick(accepted, true).size() == 10, "ten selected files are preserved");
        }
    }

    private static void sizeBoundaryStreams() throws Exception {
        File cache = cache();
        FakeConnection response = new FakeConnection(URI.create(URL));
        try (MiniqUploadFiles store = new MiniqUploadFiles(cache, uri -> response)) {
            MiniqUploadFiles.Operation exact = store.beginPick(id());
            store.prepare(exact, Collections.singletonList(source("large.raw", generated(MiniqUploadFiles.MAX_BYTES))), 1);
            MiniqUploadFiles.CachedFile file = store.finishPick(exact, true).get(0);
            check(file.size == MiniqUploadFiles.MAX_BYTES, "200 MiB accepted under 32 MiB Java heap");
            MiniqUploadFiles.Operation upload = store.beginUpload(id(), file.id, URL);
            check(store.upload(upload, (received, total) -> { }).equals("uploaded"), "200 MiB upload under 32 MiB Java heap");
            check(response.count == file.size && hex(response.digest.digest()).equals(file.sha256), "large upload preserves hash");
            store.release(Collections.singletonList(file.id));
            MiniqUploadFiles.Operation excess = store.beginPick(id());
            expectFailure(() -> store.prepare(excess, Collections.singletonList(source("too-large", generated(MiniqUploadFiles.MAX_BYTES + 1))), 1));
            store.finishPick(excess, false);
            check(blobCount(cache) == 0, "200 MiB plus one byte rejected and removed");
        }
    }

    private static void cancellationStopsOnlyItsPick() throws Exception {
        File cache = cache();
        try (MiniqUploadFiles store = new MiniqUploadFiles(cache)) {
            MiniqUploadFiles.CachedFile keep = pick(store, "keep", fixture(5));
            MiniqUploadFiles.Operation operation = store.beginPick(id());
            BlockingInput input = new BlockingInput();
            FutureTask<Boolean> pending = run(() -> {
                try { store.prepare(operation, Collections.singletonList(source("blocked", input)), 1); return false; }
                catch (IOException expected) { return store.finishPick(operation, false).isEmpty(); }
            });
            await(input.started);
            store.cancel(id());
            check(!operation.cancelled, "unknown cancellation does not affect pick");
            store.cancel(operation.id);
            check(pending.get(5, TimeUnit.SECONDS) && input.closed, "cancel closes blocked source read");
            check(keep.path.exists() && blobCount(cache) == 1, "cancel preserves other selection");
            MiniqUploadFiles.Operation before = store.beginPick(id());
            store.cancel(before.id);
            expectFailure(() -> store.prepare(before, Collections.singletonList(source("unused", fixture(1))), 1));
            check(store.finishPick(before, false).isEmpty(), "cancel before provider read");
        }
    }

    private static void uploadsUseSnapshotsAndHttpStatus() throws Exception {
        File cache = cache();
        final FakeConnection[] current = new FakeConnection[1];
        try (MiniqUploadFiles store = new MiniqUploadFiles(cache, uri -> current[0] = new FakeConnection(uri))) {
            byte[] bytes = fixture(150_003);
            MiniqUploadFiles.CachedFile file = pick(store, "camera.heic", bytes);
            List<Long> progress = new ArrayList<>();
            MiniqUploadFiles.Operation upload = store.beginUpload(id(), file.id, URL);
            check(store.upload(upload, (received, total) -> { check(total == bytes.length, "progress total"); progress.add(received); }).equals("uploaded"), "upload success");
            FakeConnection connection = current[0];
            check(connection.getRequestMethod().equals("PUT") && connection.length() == file.size, "PUT fixed-length streaming");
            check(connection.getRequestProperty("Content-Type").equals("application/octet-stream"), "binary content type");
            check(!connection.getInstanceFollowRedirects(), "redirects disabled");
            check(connection.count == bytes.length && hex(connection.digest.digest()).equals(file.sha256), "uploaded original bytes and hash");
            check(progress.get(0) == 0 && progress.get(progress.size() - 1) == file.size, "progress starts and completes");
            check(connection.disconnected && file.path.exists(), "connection closed; retry source retained");
            MiniqUploadFiles.CachedFile empty = pick(store, "empty", new byte[0]);
            check(store.upload(store.beginUpload(id(), empty.id, URL), (received, total) -> check(received == 0 && total == 0, "empty progress"))
                .equals("uploaded") && current[0].length() == 0, "empty upload uses zero fixed length");
            byte[] changed = bytes.clone();
            changed[0] ^= 1;
            Files.write(file.path.toPath(), changed);
            expectFailure(() -> store.upload(store.beginUpload(id(), file.id, URL), (received, total) -> { }));
            check(current[0].disconnected, "same-length cache corruption fails integrity verification");
        }
        for (int status : new int[] { 401, 403, 302, 500 }) {
            FakeConnection response = new FakeConnection(URI.create(URL));
            response.status = status;
            response.failOpening = status == 403;
            try (MiniqUploadFiles store = new MiniqUploadFiles(cache, uri -> response)) {
                MiniqUploadFiles.CachedFile file = pick(store, "retry.bin", fixture(2));
                MiniqUploadFiles.Operation operation = store.beginUpload(id(), file.id, URL);
                String error = expectFailure(() -> store.upload(operation, (received, total) -> { }));
                check(error.contains("HTTP (" + status + ")") && !error.contains("signature"), "HTTP retry status preserved without URL");
                check(response.disconnected && file.path.exists(), "HTTP failure retains retry source");
            }
        }
    }

    private static void releaseWaitsForEveryReader() throws Exception {
        File cache = cache();
        FakeConnection blocked = new FakeConnection(URI.create(URL));
        blocked.block = true;
        FakeConnection other = new FakeConnection(URI.create(URL.replace("object?", "other?")));
        try (MiniqUploadFiles store = new MiniqUploadFiles(cache, uri -> uri.toString().equals(URL) ? blocked : other)) {
            MiniqUploadFiles.CachedFile file = pick(store, "shared.bin", fixture(140_001));
            MiniqUploadFiles.Operation first = store.beginUpload(id(), file.id, URL);
            MiniqUploadFiles.Operation second = store.beginUpload(id(), file.id, other.getURL().toString());
            FutureTask<String> pending = run(() -> store.upload(first, (received, total) -> { }));
            await(blocked.started);
            store.release(Collections.singletonList(file.id));
            check(file.path.exists(), "release does not delete active readers");
            expectFailure(() -> store.beginUpload(id(), file.id, URL));
            store.cancel(first.id);
            check(pending.get(5, TimeUnit.SECONDS).equals("cancelled") && !second.cancelled, "only matching upload cancelled");
            check(file.path.exists(), "queued second reader retains cache");
            check(store.upload(second, (received, total) -> { }).equals("uploaded"), "other target completes independently");
            check(other.count == file.size && !file.path.exists(), "release deletes after last reader");
            MiniqUploadFiles.CachedFile queuedFile = pick(store, "queued", fixture(1));
            MiniqUploadFiles.Operation queued = store.beginUpload(id(), queuedFile.id, URL);
            store.cancel(queued.id);
            store.release(Collections.singletonList(queuedFile.id));
            check(queuedFile.path.exists(), "queued operation reserves reader");
            check(store.upload(queued, (received, total) -> { }).equals("cancelled") && !queuedFile.path.exists(), "queued cancellation drains reservation");
        }
    }

    private static void destroyCancelsAndCleans() throws Exception {
        File cache = cache();
        FakeConnection blocked = new FakeConnection(URI.create(URL));
        blocked.block = true;
        MiniqUploadFiles store = new MiniqUploadFiles(cache, uri -> blocked);
        MiniqUploadFiles.CachedFile file = pick(store, "active", fixture(90_000));
        MiniqUploadFiles.Operation upload = store.beginUpload(id(), file.id, URL);
        FutureTask<String> pending = run(() -> store.upload(upload, (received, total) -> { }));
        await(blocked.started);
        store.close();
        check(pending.get(5, TimeUnit.SECONDS).equals("cancelled") && !file.path.exists(), "destroy aborts upload and cleans source");
        expectFailure(() -> store.beginPick(id()));
        MiniqUploadFiles preparing = new MiniqUploadFiles(cache);
        MiniqUploadFiles.Operation pick = preparing.beginPick(id());
        BlockingInput source = new BlockingInput();
        FutureTask<Boolean> copying = run(() -> {
            try { preparing.prepare(pick, Collections.singletonList(source("partial", source)), 1); return false; }
            catch (IOException expected) { preparing.finishPick(pick, false); return true; }
        });
        await(source.started);
        preparing.close();
        check(copying.get(5, TimeUnit.SECONDS) && blobCount(cache) == 0, "destroy stops copy and rolls back partial selection");
    }

    private static void staleCleanupIsScoped() throws Exception {
        File cache = cache();
        File download = new File(cache, "remote-files/user-file");
        check(download.getParentFile().mkdirs(), "download fixture directory");
        Files.write(download.toPath(), fixture(3));
        try (MiniqUploadFiles first = new MiniqUploadFiles(cache)) {
            MiniqUploadFiles.CachedFile live = pick(first, "live", fixture(4));
            File orphan = new File(cache, "remote-uploads/" + id());
            check(orphan.mkdir(), "orphan directory");
            File blob = new File(orphan, id() + ".blob");
            Files.write(blob.toPath(), fixture(3));
            File outside = new File(cache, "user-source");
            check(outside.mkdir(), "source fixture");
            File original = new File(outside, id() + ".blob");
            Files.write(original.toPath(), fixture(8));
            File link = new File(cache, "remote-uploads/" + id());
            Files.createSymbolicLink(link.toPath(), outside.toPath().toAbsolutePath());
            try (MiniqUploadFiles second = new MiniqUploadFiles(cache)) {
                check(!orphan.exists() && live.path.exists(), "startup cleans orphans and preserves active instance");
                check(download.exists() && original.exists(), "download and user source never deleted");
            }
            Files.delete(link.toPath());
        }
    }

    private static void validateUrls() throws Exception {
        check(MiniqUploadFiles.uploadUri(URL).toString().equals(URL), "signature remains unchanged");
        MiniqUploadFiles.uploadUri(URL.replace("test.qiniucs.com/", "test.qiniucs.com:443/"));
        for (String url : Arrays.asList(URL.replace("https:", "http:"), URL.replace(".qiniucs.com", ".qiniucs.com.evil"),
                URL.replace("test.qiniucs.com", "qiniucs.com"), URL.replace("test.qiniucs.com", "u:p@test.qiniucs.com"),
                URL.replace("test.qiniucs.com", "test.qiniucs.com:444"), URL + "#fragment",
                URL.replace("/remote-files/", "/not-remote-files/"), URL.replace("/room/", "/../"),
                URL.replace("/room/", "/%2e%2e/"), URL.replace("/room/", "/%252e%252e/"),
                URL.replace("/room/", "/a%2fb/"), URL.replace("/room/", "/a%5cb/"),
                URL.replace("/room/", "/a%00b/"), URL.replace("/room/", "//"),
                "https://test.qiniucs.com/a/b/remote-files/room/object")) expectFailure(() -> MiniqUploadFiles.uploadUri(url));
    }

    private static MiniqUploadFiles.CachedFile pick(MiniqUploadFiles store, String name, byte[] bytes) throws Exception {
        MiniqUploadFiles.Operation operation = store.beginPick(id());
        store.prepare(operation, Collections.singletonList(source(name, bytes)), 1);
        return store.finishPick(operation, true).get(0);
    }
    private static MiniqUploadFiles.Source source(String name, byte[] bytes) { return source(name, new ByteArrayInputStream(bytes)); }
    private static MiniqUploadFiles.Source source(String name, InputStream input) {
        return new MiniqUploadFiles.Source() {
            @Override public String name(MiniqUploadFiles.Operation operation) { return name; }
            @Override public InputStream open(MiniqUploadFiles.Operation operation) { return input; }
        };
    }
    private static InputStream generated(long length) {
        return new InputStream() {
            long remaining = length;
            @Override public int read() { throw new AssertionError("must use bounded bulk reads"); }
            @Override public int read(byte[] bytes, int offset, int count) {
                check(count <= 65_536, "read buffer never exceeds 64 KiB");
                if (remaining == 0) return -1;
                int next = (int) Math.min(count, remaining);
                Arrays.fill(bytes, offset, offset + next, (byte) 0x5a);
                remaining -= next;
                return next;
            }
        };
    }
    private static final class BlockingInput extends InputStream {
        final CountDownLatch started = new CountDownLatch(1), done = new CountDownLatch(1);
        volatile boolean closed;
        @Override public int read() throws IOException { throw new AssertionError("bulk read required"); }
        @Override public int read(byte[] bytes, int offset, int count) throws IOException {
            started.countDown();
            try { await(done); } catch (Exception error) { throw new IOException(error); }
            throw new IOException("closed");
        }
        @Override public void close() { closed = true; done.countDown(); }
    }
    private static final class FakeConnection extends HttpURLConnection {
        final MessageDigest digest;
        final CountDownLatch started = new CountDownLatch(1), done = new CountDownLatch(1);
        volatile boolean disconnected;
        boolean block, failOpening;
        int status = 200;
        long count;
        FakeConnection(URI uri) throws IOException {
            super(uri.toURL());
            try { digest = MessageDigest.getInstance("SHA-256"); } catch (Exception error) { throw new IOException(error); }
        }
        long length() { return fixedContentLengthLong; }
        @Override public OutputStream getOutputStream() throws IOException {
            if (failOpening) throw new IOException("server rejected signed fixture");
            return new OutputStream() {
                @Override public void write(int value) { throw new AssertionError("bulk writes required"); }
                @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                    check(length <= 65_536, "upload writes bounded chunks");
                    started.countDown();
                    if (block) try { await(done); } catch (Exception error) { throw new IOException(error); }
                    if (disconnected) throw new IOException("cancelled");
                    digest.update(bytes, offset, length);
                    count += length;
                }
            };
        }
        @Override public int getResponseCode() { return status; }
        @Override public void disconnect() { disconnected = true; done.countDown(); }
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() { }
    }
    private interface Checked { void run() throws Exception; }
    private static String expectFailure(Checked work) throws Exception {
        try { work.run(); } catch (IOException expected) { assertions++; return expected.getMessage(); }
        throw new AssertionError("expected IOException");
    }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        assertions++;
    }
    private static <T> FutureTask<T> run(java.util.concurrent.Callable<T> work) {
        FutureTask<T> future = new FutureTask<>(work);
        Thread thread = new Thread(future, "upload-fixture");
        thread.setDaemon(true);
        thread.start();
        return future;
    }
    private static void await(CountDownLatch latch) throws Exception { check(latch.await(5, TimeUnit.SECONDS), "I/O latch completes"); }
    private static File cache() throws IOException { return Files.createTempDirectory(base.toPath(), "cache-").toFile(); }
    private static String id() { return UUID.randomUUID().toString(); }
    private static byte[] fixture(int length) {
        byte[] bytes = new byte[length];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) (i * 31);
        return bytes;
    }
    private static String hash(byte[] bytes) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder();
        for (byte item : bytes) value.append(String.format("%02x", item & 255));
        return value.toString();
    }
    private static long blobCount(File cache) throws IOException {
        try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(cache.toPath())) {
            return paths.filter(path -> path.toString().endsWith(".blob") && Files.isRegularFile(path)).count();
        }
    }
}
