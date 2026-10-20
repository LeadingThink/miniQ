import CryptoKit
import Foundation

enum MiniqUploadError: LocalizedError {
    case cancelled, invalidName, tooLarge, unreadable, cacheUnavailable, missingFile

    var errorDescription: String? {
        switch self {
        case .cancelled: return "文件选择已取消"
        case .invalidName: return "文件名无效，不能包含路径或控制字符"
        case .tooLarge: return "每份文件不能超过 200 MiB"
        case .unreadable: return "无法读取所选文件的原始内容，请重试"
        case .cacheUnavailable: return "无法创建文件上传缓存"
        case .missingFile: return "上传缓存已释放或不可用，请重新选择文件"
        }
    }
}

/// Shared by the picker/copy worker and URLSession; cancellation handlers never run under the lock.
final class MiniqUploadCancellation {
    private let lock = NSLock()
    private var stopped = false
    private var handlers: [() -> Void] = []

    var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return stopped
    }

    func check() throws {
        if isCancelled { throw MiniqUploadError.cancelled }
    }

    func onCancel(_ handler: @escaping () -> Void) {
        lock.lock()
        let runNow = stopped
        if !runNow { handlers.append(handler) }
        lock.unlock()
        if runNow { handler() }
    }

    func cancel() {
        lock.lock()
        stopped = true
        let pending = handlers
        handlers.removeAll()
        lock.unlock()
        pending.forEach { $0() }
    }

    func clearHandlers() {
        lock.lock(); defer { lock.unlock() }
        handlers.removeAll()
    }
}

enum MiniqUploadValidation {
    static func identifier(_ value: String?) -> String? {
        guard let value, value.count == 36, let uuid = UUID(uuidString: value),
            uuid.uuidString.caseInsensitiveCompare(value) == .orderedSame
        else { return nil }
        return uuid.uuidString.lowercased()
    }

    static func filename(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".."
            && !name.contains("/") && !name.contains("\\")
            && !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }

    static func endpoint(_ raw: String?) -> URL? {
        guard let raw, !raw.contains("\\"),
            !raw.unicodeScalars.contains(where: {
                CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0)
            }),
            let parts = URLComponents(string: raw), parts.scheme?.lowercased() == "https",
            let host = parts.host?.lowercased(), host.hasSuffix(".qiniucs.com"),
            parts.user == nil, parts.password == nil, parts.fragment == nil,
            parts.port == nil || parts.port == 443
        else { return nil }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.allSatisfy({ label in
            !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-"
                && label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
        }) else { return nil }
        let segments = parts.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
        guard segments.first == "", segments.count > 2 else { return nil }
        var decoded: [String] = []
        for segment in segments.dropFirst() {
            guard let name = String(segment).removingPercentEncoding, filename(name), !name.contains("%")
            else { return nil }
            decoded.append(name)
        }
        // Match JS storage paths: /[bucket/]remote-files/<room>/<object...>.
        guard let index = decoded.firstIndex(of: "remote-files"), index <= 1,
            decoded.count >= index + 3
        else { return nil }
        return parts.url
    }
}

struct MiniqCachedUpload {
    let id: String
    let name: String
    let size: Int64
    let sha256: String
    let url: URL

    var metadata: [String: Any] { ["id": id, "name": name, "size": size, "sha256": sha256] }
}

/// Only opaque IDs in this instance's registry can acquire or delete a cached file.
final class MiniqUploadCache {
    static let maximumBytes: Int64 = 200 * 1024 * 1024
    private static let processDirectory = UUID().uuidString.lowercased()
    private struct Entry {
        let file: MiniqCachedUpload
        var readers = 0
        var released = false
    }
    private let directory: URL
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    init(baseDirectory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]) throws {
        let manager = FileManager.default
        let root = baseDirectory.appendingPathComponent("remote-uploads", isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        let values = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else {
            throw MiniqUploadError.cacheUnavailable
        }
        directory = root.appendingPathComponent(Self.processDirectory, isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        // Previous app runs only: UUID directories older than a day, never arbitrary paths/symlinks.
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey]
        for stale in (try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: Array(keys))) ?? [] {
            guard stale.lastPathComponent.lowercased() != Self.processDirectory,
                MiniqUploadValidation.identifier(stale.lastPathComponent) != nil,
                let info = try? stale.resourceValues(forKeys: keys), info.isDirectory == true,
                info.isSymbolicLink != true, let modified = info.contentModificationDate,
                modified < Date().addingTimeInterval(-24 * 60 * 60)
            else { continue }
            try? manager.removeItem(at: stale)
        }
    }

    func copy(source: URL, name: String, cancellation: MiniqUploadCancellation) throws -> MiniqCachedUpload {
        try cancellation.check()
        guard MiniqUploadValidation.filename(name) else { throw MiniqUploadError.invalidName }
        var source = source
        source.removeAllCachedResourceValues()
        let info = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard info.isRegularFile == true else { throw MiniqUploadError.unreadable }
        if let size = info.fileSize, Int64(size) > Self.maximumBytes { throw MiniqUploadError.tooLarge }
        let id = UUID().uuidString.lowercased()
        let destination = directory.appendingPathComponent(id)
        var retained = false
        defer { if !retained { try? FileManager.default.removeItem(at: destination) } }
        let (size, hash) = try streamCopy(source: source, destination: destination, cancellation: cancellation)
        guard info.fileSize.map({ Int64($0) == size }) ?? true,
            (try destination.resourceValues(forKeys: [.fileSizeKey])).fileSize.map({ Int64($0) == size }) == true
        else { throw MiniqUploadError.unreadable }
        try cancellation.check()
        let file = MiniqCachedUpload(id: id, name: name, size: size, sha256: hash, url: destination)
        lock.lock()
        entries[id] = Entry(file: file)
        lock.unlock()
        retained = true
        return file
    }

    private func streamCopy(source: URL, destination: URL, cancellation: MiniqUploadCancellation) throws -> (Int64, String) {
        guard let input = InputStream(url: source), let output = OutputStream(url: destination, append: false)
        else { throw MiniqUploadError.unreadable }
        input.open(); output.open()
        defer { input.close(); output.close() }
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 64 * 1024)
        defer { buffer.deallocate() }
        var size: Int64 = 0
        var digest = SHA256()
        while true {
            try cancellation.check()
            let count = input.read(buffer, maxLength: 64 * 1024)
            guard count >= 0 else { throw MiniqUploadError.unreadable }
            if count == 0 { break }
            guard Int64(count) <= Self.maximumBytes - size else { throw MiniqUploadError.tooLarge }
            var offset = 0
            while offset < count {
                try cancellation.check()
                let written = output.write(buffer.advanced(by: offset), maxLength: count - offset)
                guard written > 0 else { throw MiniqUploadError.cacheUnavailable }
                offset += written
            }
            digest.update(bufferPointer: UnsafeRawBufferPointer(start: buffer, count: count))
            size += Int64(count)
        }
        return (size, digest.finalize().map { String(format: "%02x", $0) }.joined())
    }

    func acquire(_ id: String) throws -> MiniqCachedUpload {
        lock.lock(); defer { lock.unlock() }
        guard var entry = entries[id], !entry.released else { throw MiniqUploadError.missingFile }
        var currentURL = entry.file.url
        currentURL.removeAllCachedResourceValues()
        guard let info = try? currentURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .isSymbolicLinkKey]),
            info.isRegularFile == true, info.isSymbolicLink != true,
            info.fileSize.map({ Int64($0) == entry.file.size }) == true
        else { throw MiniqUploadError.missingFile }
        entry.readers += 1
        entries[id] = entry
        return entry.file
    }

    func endRead(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        guard var entry = entries[id], entry.readers > 0 else { return }
        entry.readers -= 1
        entries[id] = entry
        removeIfUnused(id)
    }

    func release(_ ids: [String]) {
        lock.lock(); defer { lock.unlock() }
        for id in ids {
            guard var entry = entries[id] else { continue }
            entry.released = true
            entries[id] = entry
            removeIfUnused(id)
        }
    }

    private func removeIfUnused(_ id: String) {
        guard let entry = entries[id], entry.released, entry.readers == 0 else { return }
        // Keep a failed removal registered so a repeated release can retry it.
        do {
            if FileManager.default.fileExists(atPath: entry.file.url.path) {
                try FileManager.default.removeItem(at: entry.file.url)
            }
            entries.removeValue(forKey: id)
        } catch { }
    }
}
