#if MINIQ_UPLOAD_CHECKS && os(macOS)
import CryptoKit
import Foundation

/// Standalone host checks; intentionally not registered in the iOS app's Sources phase.
/// swiftc -D MINIQ_UPLOAD_CHECKS MiniqUploadCache.swift MiniqFileUpload.swift MiniqUploadChecks.swift -o /tmp/miniq-upload-checks
@main
enum MiniqUploadChecks {
    private static var assertions = 0

    private static func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
        assertions += 1
        if !(try value()) { throw NSError(domain: "MiniqUploadChecks", code: assertions,
            userInfo: [NSLocalizedDescriptionKey: message]) }
    }

    private static func fails(_ action: () throws -> Void, _ message: String) throws {
        var failed = false
        do { try action() } catch { failed = true }
        try expect(failed, message)
    }

    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("miniq-upload-checks-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try validation()
        try cacheOwnership(root)
        try byteLimitsAndCancellation(root)
        try staleCleanup(root)
        try uploadResponses(root)
        print("PASS: \(assertions) native upload assertions (synthetic local files; no network requests)")
    }

    private static func validation() throws {
        let prefix = "https://objects.qiniucs.com"
        let path = "/bucket/remote-files/room/desktop/session/object"
        try expect(MiniqUploadValidation.endpoint(prefix + path + "?signature=test") != nil, "valid signed endpoint")
        try expect(MiniqUploadValidation.endpoint("https://objects.qiniucs.com:443" + path) != nil, "explicit HTTPS port")
        for path in ["/remote-files/room/object", "/bucket/remote-files/room/object"] {
            try expect(MiniqUploadValidation.endpoint(prefix + path) != nil, "room/object with optional bucket prefix")
        }
        for url in [
            "http://objects.qiniucs.com" + path, "https://qiniucs.com" + path,
            "https://objects.qiniucs.com.evil.test" + path, "https://objects.qiniucs.com:444" + path,
            "https://user:pass@objects.qiniucs.com" + path, prefix + path + "#fragment",
            prefix + "/bucket/not-remote-files/object", prefix + "/bucket/remote-files/../object",
            prefix + "/bucket/remote-files/%2e%2e/object", prefix + "/bucket/remote-files/%252e%252e/object",
            prefix + "/bucket/remote-files/room/a%2fb", prefix + "/bucket/remote-files/room/a%5cb",
            prefix + "/bucket/remote-files/room/a%00b", prefix + "/bucket/remote-files/", prefix + path + "\n",
            prefix + "/extra/bucket/remote-files/room/object", prefix + "/remote-files/object",
            prefix + "/bucket/remote-files/object", prefix + "/remote-files/room/"
        ] {
            try expect(MiniqUploadValidation.endpoint(url) == nil, "reject unsafe endpoint")
        }
        let uuid = UUID().uuidString
        try expect(MiniqUploadValidation.identifier(uuid) == uuid.lowercased(), "canonical UUID")
        try expect(MiniqUploadValidation.identifier("../outside") == nil, "reject non-UUID")
        for name in ["", ".", "..", "a/b", "a\\b", "a\u{0}b", "a\nb"] {
            try expect(!MiniqUploadValidation.filename(name), "reject unsafe filename")
        }
        try expect(MiniqUploadValidation.filename("原始 图片.HEIC"), "preserve Unicode filename")
    }

    private static func cacheOwnership(_ root: URL) throws {
        let source = root.appendingPathComponent("original.bin")
        let bytes = Data((0..<(64 * 1024 + 17)).map { UInt8(truncatingIfNeeded: $0 &* 31) })
        try bytes.write(to: source)
        let cache = try MiniqUploadCache(baseDirectory: root)
        let file = try cache.copy(source: source, name: "原始 图片.HEIC", cancellation: MiniqUploadCancellation())
        try expect(file.size == Int64(bytes.count), "chunk boundary preserves size")
        try expect(try Data(contentsOf: file.url) == bytes, "byte-identical cached source")
        let expectedHash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        try expect(file.sha256 == expectedHash, "SHA-256 matches original")
        try expect(Set(file.metadata.keys) == Set(["id", "name", "size", "sha256"]), "bridge exposes only metadata")
        try expect(file.name == "原始 图片.HEIC", "filename preserved")
        try expect(MiniqUploadValidation.identifier(file.id) != nil, "opaque UUID file ID")
        let foreign = try MiniqUploadCache(baseDirectory: root)
        try fails({ _ = try foreign.acquire(file.id) }, "another cache instance cannot acquire source")
        foreign.release([file.id])
        try expect(FileManager.default.fileExists(atPath: file.url.path), "foreign release has no effect")
        _ = try cache.acquire(file.id)
        _ = try cache.acquire(file.id)
        cache.release([file.id, "../original.bin", UUID().uuidString])
        try expect(FileManager.default.fileExists(atPath: file.url.path), "release defers while uploads read")
        try fails({ _ = try cache.acquire(file.id) }, "released file rejects new readers")
        cache.endRead(file.id)
        try expect(FileManager.default.fileExists(atPath: file.url.path), "first reader finishing does not delete")
        cache.endRead(file.id)
        try expect(!FileManager.default.fileExists(atPath: file.url.path), "last reader triggers release")
        cache.release([file.id])
        try expect(try Data(contentsOf: source) == bytes, "release never modifies original")
        let changed = try cache.copy(source: source, name: "changed", cancellation: MiniqUploadCancellation())
        let change = try FileHandle(forWritingTo: changed.url)
        try change.truncate(atOffset: 1)
        try change.close()
        try fails({ _ = try cache.acquire(changed.id) }, "acquire refreshes cached file size")
        cache.release([changed.id])
        let missing = try cache.copy(source: source, name: "missing", cancellation: MiniqUploadCancellation())
        _ = try cache.acquire(missing.id)
        cache.endRead(missing.id)
        try FileManager.default.removeItem(at: missing.url)
        try fails({ _ = try cache.acquire(missing.id) }, "acquire detects a purged file despite cached metadata")
        cache.release([missing.id])
        let empty = root.appendingPathComponent("empty")
        try Data().write(to: empty)
        let emptyFile = try cache.copy(source: empty, name: "empty", cancellation: MiniqUploadCancellation())
        try expect(emptyFile.size == 0 && emptyFile.sha256 ==
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "empty file hash")
        cache.release([emptyFile.id])
    }

    private static func byteLimitsAndCancellation(_ root: URL) throws {
        let source = root.appendingPathComponent("200MiB-synthetic")
        _ = FileManager.default.createFile(atPath: source.path, contents: nil)
        let writer = try FileHandle(forWritingTo: source)
        try writer.truncate(atOffset: UInt64(MiniqUploadCache.maximumBytes))
        try writer.close()
        let cache = try MiniqUploadCache(baseDirectory: root)
        let file = try cache.copy(source: source, name: "200MiB.bin", cancellation: MiniqUploadCancellation())
        try expect(file.size == MiniqUploadCache.maximumBytes, "exact 200MiB accepted")
        let reader = try FileHandle(forReadingFrom: file.url)
        var read: Int64 = 0
        var hash = SHA256()
        while let chunk = try reader.read(upToCount: 64 * 1024), !chunk.isEmpty {
            try expect(chunk.allSatisfy { $0 == 0 }, "200MiB copy preserves every byte")
            read += Int64(chunk.count)
            hash.update(data: chunk)
        }
        try reader.close()
        try expect(read == file.size && hash.finalize().map { String(format: "%02x", $0) }.joined() == file.sha256,
            "full cached 200MiB hash verified incrementally")
        cache.release([file.id])
        let grow = try FileHandle(forWritingTo: source)
        try grow.truncate(atOffset: UInt64(MiniqUploadCache.maximumBytes + 1))
        try grow.close()
        do {
            _ = try cache.copy(source: source, name: "too-big", cancellation: MiniqUploadCancellation())
            try expect(false, "200MiB+1 must reject")
        } catch MiniqUploadError.tooLarge { }
        let token = MiniqUploadCancellation()
        var calls = 0
        token.onCancel { calls += 1 }
        token.cancel(); token.cancel()
        token.onCancel { calls += 1 }
        try expect(calls == 2, "cancellation handlers execute once, including late registration")
        try fails({ _ = try cache.copy(source: source, name: "cancelled", cancellation: token) }, "cancelled copy rejects")
        try expect((try FileManager.default.contentsOfDirectory(at: file.url.deletingLastPathComponent(),
            includingPropertiesForKeys: nil)).isEmpty, "oversize and cancelled operations leave no cache files")
        try expect(FileManager.default.fileExists(atPath: source.path), "oversize rejection preserves source")
        try cancelDuringCopy(source: source, cache: cache, directory: file.url.deletingLastPathComponent())
    }

    private final class CopyOutcome {
        let lock = NSLock()
        var result: Result<MiniqCachedUpload, Error>?
    }

    private static func cancelDuringCopy(source: URL, cache: MiniqUploadCache, directory: URL) throws {
        let writer = try FileHandle(forWritingTo: source)
        try writer.truncate(atOffset: UInt64(MiniqUploadCache.maximumBytes))
        try writer.close()
        let token = MiniqUploadCancellation()
        let outcome = CopyOutcome()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try cache.copy(source: source, name: "cancel-mid-copy", cancellation: token) }
            outcome.lock.lock()
            outcome.result = result
            outcome.lock.unlock()
            done.signal()
        }
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if !(try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)).isEmpty { break }
            Thread.sleep(forTimeInterval: 0.0005)
        }
        token.cancel()
        try expect(done.wait(timeout: .now() + 5) == .success, "copy reacts to cancellation")
        outcome.lock.lock()
        let result = outcome.result
        outcome.lock.unlock()
        if case .failure(let error)? = result {
            if case .cancelled? = error as? MiniqUploadError {
                try expect(true, "copy cancellation returns typed failure")
            } else { try expect(false, "mid-copy cancellation must report cancelled") }
        } else {
            if case .success(let file)? = result { cache.release([file.id]) }
            try expect(false, "copy must cancel after opening destination")
        }
        try expect((try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)).isEmpty,
            "partial copy removed after stream closes")
        try expect(FileManager.default.fileExists(atPath: source.path), "mid-copy cancel preserves original")
    }

    private static func staleCleanup(_ root: URL) throws {
        let base = root.appendingPathComponent("stale-case")
        let uploads = base.appendingPathComponent("remote-uploads")
        let downloads = base.appendingPathComponent("remote-files")
        let old = uploads.appendingPathComponent(UUID().uuidString.lowercased())
        let unowned = uploads.appendingPathComponent("user-folder")
        for directory in [old, unowned, downloads] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try Data([1, 2, 3]).write(to: directory.appendingPathComponent("sentinel"))
            try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-172800)],
                ofItemAtPath: directory.path)
        }
        let link = uploads.appendingPathComponent(UUID().uuidString.lowercased())
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: downloads)
        let live = try MiniqUploadCache(baseDirectory: base)
        let active = try live.copy(source: downloads.appendingPathComponent("sentinel"), name: "live",
            cancellation: MiniqUploadCancellation())
        defer { live.release([active.id]) }
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-172800)],
            ofItemAtPath: active.url.deletingLastPathComponent().path)
        _ = try MiniqUploadCache(baseDirectory: base)
        try expect(FileManager.default.fileExists(atPath: active.url.path), "stale cleanup preserves current process files")
        try expect(!FileManager.default.fileExists(atPath: old.path), "old managed UUID directory removed")
        try expect(FileManager.default.fileExists(atPath: unowned.path), "unmanaged directory preserved")
        try expect(FileManager.default.fileExists(atPath: downloads.appendingPathComponent("sentinel").path),
            "download cache and symlink destination preserved")
        try expect((try link.resourceValues(forKeys: [.isSymbolicLinkKey])).isSymbolicLink == true,
            "stale cleanup does not traverse symlinks")
    }

    private static func uploadResponses(_ root: URL) throws {
        let source = root.appendingPathComponent("network-fixture")
        try Data([1, 2, 3]).write(to: source)
        let cache = try MiniqUploadCache(baseDirectory: root)
        let file = try cache.copy(source: source, name: "fixture", cancellation: MiniqUploadCancellation())
        defer { cache.release([file.id]) }
        let url = URL(string: "https://objects.qiniucs.com/bucket/remote-files/room/object")!
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: url) // Never resumed: no file or request leaves the machine.
        for status in [401, 403, 500] {
            var result: Result<String, Error>?
            let upload = MiniqFileUpload(id: UUID().uuidString, file: file, progress: { _ in }, completion: { result = $0 })
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
            var disposition: URLSession.ResponseDisposition?
            upload.urlSession(session, dataTask: task, didReceive: response) { disposition = $0 }
            upload.urlSession(session, task: task, didCompleteWithError: URLError(.cancelled))
            try expect(disposition == .cancel, "HTTP error response body rejected")
            if case .failure(let error)? = result {
                try expect(error.localizedDescription.contains("(\(status))"), "HTTP status preserved for retry policy")
                try expect(!error.localizedDescription.contains("https://"), "signed URLs excluded from errors")
            } else { try expect(false, "HTTP failure must reject") }
        }
        var results: [String: String] = [:]
        let first = MiniqFileUpload(id: "first", file: file, progress: { _ in }, completion: { results["first"] = try? $0.get() })
        let second = MiniqFileUpload(id: "second", file: file, progress: { _ in }, completion: { results["second"] = try? $0.get() })
        first.cancel()
        let ok = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        second.urlSession(session, dataTask: task, didReceive: ok) { _ in }
        first.urlSession(session, task: task, didCompleteWithError: URLError(.cancelled))
        second.urlSession(session, task: task, didCompleteWithError: nil)
        try expect(results["first"] == "cancelled" && results["second"] == "uploaded", "cancel isolates upload operations")
        let redirect = HTTPURLResponse(url: url, statusCode: 307, httpVersion: nil, headerFields: nil)!
        var redirected = true
        second.urlSession(session, task: task, willPerformHTTPRedirection: redirect,
            newRequest: URLRequest(url: URL(string: "https://example.com")!)) { redirected = $0 != nil }
        try expect(!redirected, "redirects are never followed")
        var cached = true
        second.urlSession(session, dataTask: task, willCacheResponse: CachedURLResponse(response: ok, data: Data())) {
            cached = $0 != nil
        }
        try expect(!cached, "responses are never cached")
        var sent: [Int64] = []
        let reporting = MiniqFileUpload(id: "progress", file: file, progress: { sent.append($0) }, completion: { _ in })
        reporting.urlSession(session, task: task, didSendBodyData: 100, totalBytesSent: 100, totalBytesExpectedToSend: 3)
        reporting.cancel()
        reporting.urlSession(session, task: task, didSendBodyData: 1, totalBytesSent: 101, totalBytesExpectedToSend: 3)
        try expect(sent == [3], "progress is bounded and stops after cancellation")
        try authentication(session: session, task: task, file: file, url: url)
    }

    private final class ChallengeSender: NSObject, URLAuthenticationChallengeSender {
        func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) { }
        func continueWithoutCredential(for challenge: URLAuthenticationChallenge) { }
        func cancel(_ challenge: URLAuthenticationChallenge) { }
    }

    private static func authentication(session: URLSession, task: URLSessionTask, file: MiniqCachedUpload, url: URL) throws {
        for method in [NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodServerTrust] {
            var result: Result<String, Error>?
            let upload = MiniqFileUpload(id: "auth", file: file, progress: { _ in }, completion: { result = $0 })
            let space = URLProtectionSpace(host: "objects.qiniucs.com", port: 443, protocol: "https",
                realm: nil, authenticationMethod: method)
            let response = HTTPURLResponse(url: url, statusCode: 401, httpVersion: nil, headerFields: nil)!
            let challenge = URLAuthenticationChallenge(protectionSpace: space, proposedCredential: nil,
                previousFailureCount: 0, failureResponse: response, error: nil, sender: ChallengeSender())
            var disposition: URLSession.AuthChallengeDisposition?
            var suppliedCredential = false
            upload.urlSession(session, didReceive: challenge) {
                disposition = $0
                suppliedCredential = $1 != nil
            }
            try expect(!suppliedCredential, "authentication never supplies credentials")
            if method == NSURLAuthenticationMethodServerTrust {
                try expect(disposition == .performDefaultHandling, "TLS keeps system trust validation")
            } else {
                try expect(disposition == .cancelAuthenticationChallenge, "password authentication rejected")
                upload.urlSession(session, task: task, didCompleteWithError: URLError(.userAuthenticationRequired))
                if case .failure(let error)? = result {
                    try expect(error.localizedDescription.contains("(401)"), "auth rejection preserves HTTP status")
                } else { try expect(false, "auth rejection must fail upload") }
            }
        }
    }
}
#endif
